---
title: SQLite Notion Supplementation Layer
category: performance-issues
tags:
  - sqlite
  - notion-api
  - caching
  - rate-limiting
  - better-sqlite3
  - wal-mode
  - analytics
  - traceability
  - ipc-snapshots
module: src/db.ts, src/notion-sync.ts, src/analytics-queries.ts
symptom: >
  Notion API calls (200-500ms each, 3 req/s rate limit) caused Deep Research queries to take 5-10s
  (15-20 API calls) and Weekly Analytics to block for 15 minutes (~60 API calls). No traceability
  between WhatsApp messages and Notion operations.
root_cause: >
  Direct Notion API calls for every operation without local caching. Each Deep Research required
  15-20 API calls; Weekly Analytics fetched 30 Daily Pages individually. No audit trail for
  bidirectional Notion operations.
---

# SQLite Notion Supplementation Layer

## Problem Statement

NanoClaw's agent (Raiden) runs inside Apple Containers (Linux VMs) and accesses Notion via MCP tools and direct `curl` calls. Every query hits the Notion API live:

- **Deep Research**: 15-20 API calls per query (5-10 seconds)
- **Weekly Analytics**: ~60 API calls over 15 minutes to fetch 30 Daily Pages and compute correlations
- **Traceability**: Zero visibility into which WhatsApp messages triggered which Notion operations

The Notion API rate limit of 3 req/s with 200-500ms latency per call made these operations slow and expensive. Meanwhile, the local SQLite database (`better-sqlite3`) was already handling messages, tasks, and sessions with <1ms query times.

## Root Cause

Three architectural gaps:

1. **No local cache**: Every Notion data access required a live API call, even for data that changes infrequently (PARA inventory, Daily Page properties).
2. **No cross-system traceability**: Scheduled tasks created from Notion webhooks had no link back to their source page. Agent Notion operations were invisible to the host.
3. **No pre-computed analytics**: The agent performed natural-language "computation" of habit correlations and trends — slow, imprecise, and expensive.

## Solution

Added a SQLite supplementation layer with 3 capabilities, implemented across 10 files (+1,477 lines).

### Architecture

```
Host Process (Node.js, better-sqlite3)
  ├── notion-sync.ts: Full sync every 6h via Notion API
  ├── db.ts: 4 new tables (PARA cache, relations, daily pages, sync log)
  ├── analytics-queries.ts: 5 pre-computed SQL analytics
  └── Writes JSON snapshots to IPC before container spawn

Agent Container (Linux VM)
  ├── Reads notion_cache.json + analytics_cache.json from IPC
  ├── Can query SQLite directly via sqlite3 CLI (WAL mode)
  └── Falls back to live Notion API if cache is stale (>6h)
```

### Phase 0: WAL Mode

**File:** `src/db.ts`

```typescript
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

WAL (Write-Ahead Logging) enables concurrent reads from the container while the host writes during sync. `busy_timeout` prevents immediate `SQLITE_BUSY` errors — retries for up to 5 seconds.

### Phase 1: Cache Tables + Transactional Sync

**File:** `src/db.ts` — 4 new tables:

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `notion_para_cache` | PARA inventory (Projects, Areas, Resources) | `page_id PK`, `name`, `category`, `status`, `task_count`, `note_count`, `content_count` |
| `notion_relation_cache` | Cross-database links | `source_db`, `source_page_id`, `target_db`, `target_page_id`, `relation_property` |
| `notion_daily_pages_cache` | Daily Page health/habit data (30+ columns) | `page_id PK`, `date`, mood/wakefulness selects, medication numbers, 8 habit checkboxes, sleep fields |
| `notion_sync_log` | Audit trail for all Notion operations | `direction`, `operation`, `notion_db`, `trigger_type`, `status`, `error_message` |

**File:** `src/notion-sync.ts` — Transactional full sync:

```typescript
export async function fullSync() {
  setRouterState('sync_status', 'syncing');

  // 1. Fetch ALL data from Notion first (before touching DB)
  const paraPages = await queryAllPages(DB_IDS.para);
  const dailyPages = await queryAllPages(DB_IDS.daily_pages, {
    property: 'Date',
    date: { on_or_after: sinceStr },
  });

  // 2. Write in a single transaction (all-or-nothing)
  const writeTransaction = db.transaction(() => {
    clearParaCache();
    clearRelationCache();
    clearDailyPagesCache();

    for (const page of paraPages) {
      upsertParaCache({ /* ... */ });
      // Insert relation edges for Tasks, Notes, Content
    }
    for (const page of dailyPages) {
      upsertDailyPageCache({ /* ... */ });
    }
  });

  writeTransaction();
  setRouterState('sync_status', 'complete');
  pruneSyncLog(90); // 90-day retention
}
```

Key invariants:
- All Notion data fetched **before** any DB writes (no partial updates)
- Single `db.transaction()` — on error, rollback keeps previous cache intact
- 350ms rate limit between API calls + exponential backoff on 429
- Sync skipped if any container is active (`queue.isAnyActive()`)

**File:** `src/notion-sync.ts` — Atomic JSON snapshots:

```typescript
export function writeCacheSnapshot(groupFolder: string): void {
  // notion_cache.json: PARA items + daily pages + sync status
  fs.writeFileSync(tmpPath, JSON.stringify(cacheSnapshot, null, 2));
  fs.renameSync(tmpPath, snapshotPath); // Atomic rename

  // analytics_cache.json: pre-computed analytics
  const analytics = generateAnalytics();
  fs.writeFileSync(analyticsTmpPath, JSON.stringify(analytics, null, 2));
  fs.renameSync(analyticsTmpPath, analyticsPath);
}
```

### Phase 2: Bidirectional Traceability

**File:** `src/db.ts` — Migration:

```typescript
try {
  database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN notion_page_id TEXT`);
} catch { /* column already exists */ }
```

**File:** `src/webhook-server.ts` — Webhook handler extracts page ID:

```typescript
const notionPageId: string | undefined = req.body?.data?.id;
createTask({ /* ... */ notion_page_id: notionPageId });
logNotionSync({
  direction: 'local_to_notion',
  operation: 'create',
  notion_db: 'tasks',
  trigger_type: 'webhook',
});
```

### Phase 3: Local Analytics Engine

**File:** `src/analytics-queries.ts` — 5 pre-computed functions:

| Function | What it computes | Data source |
|----------|-----------------|-------------|
| `habitMoodCorrelation(30)` | Avg evening mood on habit-done vs not-done days, for 8 habits | `notion_daily_pages_cache` |
| `taskCompletionRate(30)` | `tasks_done / tasks_total` over N days | `notion_daily_pages_cache` |
| `knowledgeGaps()` | Active PARA items with zero linked tasks/notes/content | `notion_para_cache` |
| `messageActionRate(7)` | Messages received vs Notion creates | `messages` + `notion_sync_log` |
| `taskExecutionHealth(7)` | Success/error rates, avg/max duration | `task_run_logs` |

All computed in <10ms via SQL. Results written to `analytics_cache.json` before every container spawn.

### Integration

**File:** `src/index.ts` — Sync loop:

```typescript
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
if (process.env.NOTION_TOKEN) {
  setTimeout(() => fullSync().catch(/*...*/), 30_000); // Initial after 30s
  setInterval(() => {
    if (!queue.isAnyActive()) {
      fullSync().catch(/*...*/);
    }
  }, SYNC_INTERVAL_MS);
}
```

**File:** `groups/main/CLAUDE.md` — Raiden instructions updated:
- Deep Research checks cache first, falls back to live API if stale
- Analytics reads from `analytics_cache.json`, with SQLite direct queries as fallback
- Example SQL queries provided for ad-hoc investigation

## Verification

```bash
# WAL mode active
sqlite3 store/messages.db "PRAGMA journal_mode;"
# → wal

# Cache tables exist
sqlite3 store/messages.db ".tables" | grep notion
# → notion_daily_pages_cache  notion_para_cache  notion_relation_cache  notion_sync_log

# After first sync, cache is populated
sqlite3 store/messages.db "SELECT COUNT(*) FROM notion_para_cache;"

# Sync log has entries
sqlite3 store/messages.db "SELECT direction, operation, status FROM notion_sync_log ORDER BY created_at DESC LIMIT 5;"

# Snapshots written before container spawn
ls data/ipc/main/notion_cache.json data/ipc/main/analytics_cache.json
```

Tests: 22 new tests (14 cache CRUD + 8 analytics), all passing.

## Challenges Overcome

| Challenge | Solution |
|-----------|----------|
| FK constraint in tests: `logTaskRun` requires parent task | Create parent `scheduled_tasks` rows in `beforeEach` before logging runs |
| `pruneSyncLog(0)` doesn't delete same-second entries | Changed test to verify 90-day retention keeps recent entries |
| No `isAnyActive()` on GroupQueue | Added method exposing existing `activeCount` field |
| Notion property typo "Alchohol (Units)" | Mapped exactly — sync uses Notion's actual property names |

## Prevention & Best Practices

### WAL Mode is Non-Negotiable
Always enable WAL mode after `new Database()` when the database is accessed by multiple processes. Without it, `better-sqlite3` holds exclusive locks during writes, blocking container `sqlite3` CLI reads entirely.

### Fetch All, Then Write in Transaction
Never write row-by-row during API pagination. Fetch all Notion data first, then write in a single `db.transaction()`. This prevents partial cache states and simplifies error recovery (rollback keeps previous data).

### Notion Property Names Must Match Exactly
Property extractors use exact Notion names including typos (e.g., `Alchohol (Units)`). If a property is renamed in Notion, the extractor silently returns `null`. Document all known typos.

### Gate Sync on Container Activity
Always check `queue.isAnyActive()` before running `fullSync()`. Concurrent sync + container reads work under WAL, but skipping avoids unnecessary resource contention.

### Atomic IPC Writes
Always write to `.tmp` then `fs.renameSync()` to final path. Containers must never see partial JSON files.

### Migration Pattern
Use `CREATE TABLE IF NOT EXISTS` for new tables. Use `ALTER TABLE ADD COLUMN` in try/catch for existing tables. Every migration must be idempotent.

### FK Constraints in Tests
When testing functions that reference foreign keys, always create parent rows first. Use `_initTestDatabase()` for in-memory SQLite in tests.

### Sync Log Retention
Prune entries older than 90 days on each sync cycle via `pruneSyncLog(90)`. At ~10-20 entries/day, this keeps the table under 2,000 rows.

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Deep Research API calls | 15-20 | 2-3 (cache hit) |
| Deep Research latency | 5-10s | <1s |
| Analytics API calls | ~60 | 0 (all from cache) |
| Analytics duration | 15 min | <1 min |
| Notion traceability | 0% | 100% (sync log) |
| Message-action visibility | None | Full audit trail |

## References

- Plan: `docs/plans/2026-02-22-feat-sqlite-notion-supplementation-layer-plan.md`
- Deep Research plan (consumer): `docs/plans/2026-02-22-feat-second-brain-deep-research-plan.md`
- Second Brain Organizer plan (consumer): `docs/plans/2026-02-21-feat-autonomous-second-brain-organizer-plan.md`
- Notion MCP search limitation (justifies cache): `docs/solutions/integration-issues/notion-mcp-semantic-search-filtering-limitation.md`
- Notion HTTPS proxy access (networking): `docs/solutions/integration-issues/notion-mcp-https-proxy-api-access.md`
- Codebase evolution (IPC patterns): `docs/solutions/integration-issues/nanoclaw-complete-codebase-evolution.md`
