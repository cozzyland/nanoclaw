---
title: "Notion MCP Semantic Search Cannot Filter by Database Property"
date: 2026-02-21
tags:
  - notion-mcp
  - semantic-search
  - para-inventory
  - data-discovery
  - raiden-agent
module: "groups/main/para-inventory.md"
severity: medium
symptom: >
  Notion MCP notion-search tool failed to reliably enumerate items filtered by
  Category = "Resource" in SB_PARA database. Initial inventory discovered only
  4 of 12 resources; after ~20 rounds of varied keyword searches, only 10 were
  found. Multiple Areas were similarly undiscovered (6+ missed).
root_cause: >
  Notion MCP tools provide semantic search only — no structured query capability
  like WHERE Category = 'Resource'. Views cannot be fetched directly. The only
  reliable way to verify an item's Category is to fetch each page individually.
---

# Notion MCP Semantic Search Cannot Filter by Database Property

## Problem

When building a PARA inventory for Raiden (the NanoClaw agent), the Notion MCP `notion-search` tool could not reliably enumerate all items in the SB_PARA database filtered by a specific property value (e.g., `Category = "Resource"`).

**Observable symptoms:**
- Initial inventory found only 4 of 12 resources
- After ~20 rounds of semantic search with varied keywords, only 10 of 12 found
- 6+ Areas were also missed entirely (Life and AI, Fun & Games, Fatherhood, Bitcoin and AI, Cozzy Health, Sleep Related)
- The same popular items kept appearing across different keyword searches
- Items with non-descriptive names (e.g., "Miscellaneous [R]", "Ideas [General][R]") were never surfaced by semantic search

## Root Cause

The `mcp__claude_ai_Notion__notion-search` tool performs **semantic/keyword-based matching**, not structured database queries with property filters. This means:

1. **No property-based filtering**: You cannot query `Category = 'Resource'` and get all matching items. Results are ranked by semantic relevance to keywords, not by exact property values.

2. **View URLs are not fetchable**: Attempting to fetch a database view via `notion-fetch` with a `view://...` URL fails with "URL type webpage not currently supported for fetch tool". The SB_PARA database has a dedicated "Resources" view with the correct filter, but it's inaccessible.

3. **Results are probabilistic, not deterministic**: Semantic search may return different subsets depending on query wording. Items with generic names or sparse content rank lower and may never surface.

4. **No "list all" operation**: There is no equivalent to `SELECT * FROM para WHERE category = 'Resource'`.

## Investigation Steps

| Step | Approach | Result |
|------|----------|--------|
| 1 | Searched SB_PARA with `data_source_url` parameter | Returns semantic matches, not filtered results |
| 2 | Fetched the "Resources" view directly (`view://...`) | Error: "URL type webpage not currently supported" |
| 3 | ~20 keyword searches ("health", "finance", "cooking", "DIY", etc.) | Hit-or-miss; same popular items returned repeatedly |
| 4 | Fetched individual pages to check Category property | Accurate but requires knowing the ID upfront |
| 5 | **Searched for `[R]` naming pattern** | Found 4 additional resources in one query |

## Solution

### Hybrid Enumeration Strategy

Use a three-phase approach: **Pattern search + Multi-vector semantic search + Per-page verification**.

#### Phase 1: Naming Convention Search (Highest Signal)

Search for the user's naming convention. The `[R]` suffix on resource names is deterministic and searchable:

```
notion-search query="[R]" data_source_url="collection://SB_PARA_DATA_SOURCE_ID"
```

This single query found Health [R], Miscellaneous [R], Ideas [General][R], Lightning [R] — items that dozens of keyword searches missed.

#### Phase 2: Multi-Vector Semantic Search

Run 5-10 diverse keyword searches to catch items without the naming convention:

- Search by topic clusters: "health finance home kids car"
- Search by PARA concepts: "resource reference material guide"
- Search by activity types: "education learning programming music"
- Deduplicate results into a candidate set

#### Phase 3: Property Verification

For every candidate page, fetch it individually and check the actual `Category` property:

```
notion-fetch id="<page_id>"
→ Check properties.Category === "Resource"
```

This is the only way to guarantee correctness. Slow, but deterministic.

#### Phase 4: Count Reconciliation

Always compare found count against user's expected count:

```
Found: 10 resources
Expected: 12 resources
Gap: 2 — investigate further or ask user
```

### Phase 5: Direct Notion API (The Definitive Solution)

When MCP semantic search cannot provide completeness guarantees, bypass it entirely with the Notion API:

```bash
curl -s -X POST 'https://api.notion.com/v1/databases/{database_id}/query' \
  -H 'Authorization: Bearer {NOTION_TOKEN}' \
  -H 'Notion-Version: 2022-06-28' \
  -H 'Content-Type: application/json' \
  -d '{"page_size": 100}'
```

This returned **all 50 items** in one call with exact Category, Status, and Name properties. The 2 resources MCP search never found (Koinly Useful Filters, Ray Peat) appeared immediately. Use `has_more` + `start_cursor` for pagination if >100 items.

**Result**: MCP found 10/12 resources after ~20 searches. Direct API found 12/12 in one call.

### For Raiden (Agent-Side)

Since Raiden has `mcp__notion__*` tools in the container, it should build a live inventory at session start:

1. Read `/workspace/group/para-inventory.md` as a cached baseline
2. On first Notion operation, query SB_PARA for all items
3. Filter locally by Category and Status
4. Cache the result in session memory for routing decisions

## Prevention Strategies

### 1. Formalize Naming Conventions

The `[R]` suffix breakthrough should be standardized:
- All Resources should have `[R]` suffix (e.g., "Bitcoin [R]", "Health [R]")
- Add to Raiden's CLAUDE.md: "When creating Resources, append [R] to the name"
- When the user doesn't use the suffix, Raiden should suggest adding it

### 2. Count Validation Before Committing

Before publishing any inventory:
- Ask the user: "How many active Areas/Projects/Resources?"
- Compare against enumerated count
- If mismatch: halt and investigate, don't assume completeness

### 3. Automated Weekly Sync

The "User Context Sync" scheduled task should rebuild the inventory:
- Query all SB_PARA items (all statuses)
- Verify each item's Category via property check
- Write to `para-inventory.md` with verified count metadata
- If count differs from previous: warn user

### 4. Cache IDs for Direct Lookup

Once an item is discovered, store its Notion page ID. Future queries can use `notion-fetch` with the ID directly — no search needed. The `para-inventory.md` file serves this purpose.

### 5. Fallback to User Confirmation

When semantic search fails and count doesn't reconcile:
- Present what was found
- Ask: "I found 10 of 12 resources. What am I missing?"
- This is faster and more reliable than guessing more search terms

## Related Documentation

- `groups/main/notion-reference.md` — Complete database schemas, Section 3.3 has SB_PARA reference
- `groups/main/para-inventory.md` — Cached PARA snapshot with IDs and routing cheat sheet
- `groups/main/CLAUDE.md` — Raiden's autonomous routing instructions (lines 317-640)
- `docs/plans/2026-02-21-feat-autonomous-second-brain-organizer-plan.md` — Plan requiring reliable PARA enumeration
- `docs/solutions/integration-issues/notion-mcp-https-proxy-api-access.md` — Related Notion MCP networking issues

## Key Takeaways

| Approach | Reliability | Speed |
|----------|-------------|-------|
| Semantic search alone | ~30-50% | Fast |
| `[R]` pattern + semantic + verify | ~95% | Medium |
| Full enumeration + per-page fetch | ~100% | Slow |
| User-provided count validation | 100% | Depends on user |

**Bottom line**: Never trust semantic search for complete enumeration. Always verify with per-page fetches and reconcile against a known count.
