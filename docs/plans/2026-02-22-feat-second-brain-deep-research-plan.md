---
title: "feat: Second Brain Deep Research for Raiden"
type: feat
date: 2026-02-22
---

# Second Brain Deep Research for Raiden

## Overview

Give Raiden four interconnected research capabilities that transform the Second Brain from a passive filing system into an active knowledge engine. All four capabilities are implemented as **CLAUDE.md instructions + supporting files only** — no code changes to the host process, container, or IPC system.

## Problem Statement / Motivation

Raiden currently manages the Second Brain reactively: capture input, route to PARA, run scheduled maintenance. But the BASB methodology's real power is in the **Distill** and **Express** stages — finding connections, surfacing insights, and turning raw material into polished output. The user has 50 PARA items, 28+ notes, and growing Daily Page data that sits largely unconnected. Raiden should be the agent that makes this knowledge compound.

From the `digital-cognition-guide.md`: "Connections emerge when diverse inputs live in one place... Your notes should help you see things you wouldn't otherwise notice."

## Proposed Solution

Four capabilities, ordered by dependency:

### Capability 1: Cross-Database Research ("What do I know about X?")

**Trigger:** User asks a question like "what do I know about Bitcoin?", "find connections to health", "search my second brain for..."

**Behaviour (add to CLAUDE.md under Proactive Behaviors):**

```
### Deep Research (On-Demand)

When the user asks to search their Second Brain, research a topic, or find connections:

1. **Build the search space** — query across all 5 databases:
   - SB_PARA: `curl` the Notion API directly for complete enumeration (MCP semantic search misses ~50% of items — see notion-reference.md Section 4.3)
   - SB_Tasks: search for tasks linked to matching PARA items
   - SB_Notes: search by AI keywords and title
   - SB_Content: search by title and type
   - SB_Daily Pages: search for relevant habit/mood data if health/wellness topic

2. **Use hybrid search strategy:**
   - Phase 1: Direct Notion API query with filter (deterministic, complete)
   - Phase 2: MCP semantic search for content/body matches (probabilistic, complementary)
   - Phase 3: Deduplicate and rank by relevance

3. **Synthesize findings:**
   - Group by database source
   - Identify cross-database connections (e.g., a Note linked to a Project that has related Tasks)
   - Surface items that SHOULD be linked but aren't (relation-building opportunity)
   - Follow relation chains: PARA → Tasks → Notes → Content

4. **Report concisely via WhatsApp:**
   - Lead with the most actionable finding
   - List connected items with their status
   - Suggest missing links to create
   - Keep under 500 words — link to Notion pages for detail

5. **Create connections:** If obvious PARA relations are missing, create them immediately and report what was linked.
```

**Direct Notion API pattern for the agent:**

```bash
# Query a database with filter (inside container, NOTION_TOKEN is available)
curl -s -X POST "https://api.notion.com/v1/databases/${DB_ID}/query" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"property":"Category","select":{"equals":"Project"}},"page_size":100}'
```

Database IDs (from `notion-reference.md`):
- SB_Tasks: `202327f4955881b1a00aca5d9300f666`
- SB_PARA: `202327f4955881d7bcbcf751c52783f9`
- SB_Notes: `202327f495588106a2eee5d2ebd7704c`
- SB_Content: `202327f49558819ca92ee4e6bff6ef76`
- SB_Daily Pages: `202327f4955881f3bb30cfdc96313d96`

### Capability 2: Web Research → Second Brain

**Trigger:** User says "research topic X", "find out about Y", "look up Z and save it"

**Behaviour (add to CLAUDE.md under Proactive Behaviors):**

```
### Web Research (On-Demand)

When the user asks to research a topic externally:

1. **Search the web** using WebSearch and WebFetch tools
   - Run 2-3 search queries with different angles
   - Fetch and read the top 3-5 results
   - For paywalled/complex sites, use `agent-browser` for full page rendering

2. **Distill findings** into structured output:
   - Key facts and insights (not raw copy-paste)
   - Source URLs for verification
   - Relevance to user's existing PARA items

3. **Create Second Brain entries:**
   - Create SB_Content entry for each source (Type=Article/YouTube video/etc., Link=URL, Status=Done)
   - Create ONE SB_Notes entry summarising the research (Status=Raw, with 3-7 AI keywords)
   - Link both to the most relevant PARA item
   - Link both to today's Daily Page

4. **Report findings** via WhatsApp:
   - 3-5 bullet summary of what was found
   - Which PARA item it was linked to
   - Suggest follow-up actions if applicable (e.g., "This relates to your Bitcoin Career area — want me to create a task?")

5. **Cross-reference with existing knowledge:**
   - Before creating entries, check if the topic already exists in SB_Content or SB_Notes
   - If related items exist, link them and note the connection
   - Follow the "slow burn" principle from digital-cognition-guide.md — not everything needs immediate action
```

### Capability 3: Second Brain Analytics (Scheduled)

**Trigger:** Weekly scheduled task (e.g., Sunday evening, after the maintenance sweep)

**Behaviour (add to CLAUDE.md under Autonomous Behavior):**

```
### Second Brain Analytics (Weekly)

Run after the SB Maintenance Sweep. Analyze the health and utilisation of the Second Brain.

**Part 1: Knowledge Gap Analysis**
1. Query all Active PARA items via direct Notion API
2. For each item, count linked Tasks, Notes, Content via relations
3. Flag "knowledge deserts" — Active Areas/Projects with:
   - 0 linked Notes (no captured knowledge)
   - 0 linked Content (no inputs)
   - 0 linked Tasks in last 30 days (no action)
4. Flag "information overload" — items with 10+ Notes but no Polished notes (lots of input, no distillation)

**Part 2: Productivity Analytics (from Daily Pages)**
5. Query last 30 Daily Pages via direct Notion API
6. Compute and report:
   - Task completion rate: (Done tasks / total tasks with Do on in period)
   - Habit consistency: per-habit completion % (Prayer, Rosary, Piano, etc.)
   - Mood correlation matrix: which habits correlate with higher mood?
   - Sleep-productivity link: sleep quality vs. next-day task completion
   - Energy patterns: which days of the week have highest mood/wakefulness?
7. Compare to previous period (if analytics file exists)

**Part 3: Content Pipeline**
8. Count SB_Content by status: Not started / In progress / Done
9. Flag content items "Not started" for 30+ days
10. Surface content items that match active Projects (recommend what to read next)

**Part 4: Relation Health**
11. Count total relations across all databases
12. Compare to previous week — are relations growing? (Target: +5-10/week from normal usage)
13. Flag the top 3 items that would benefit most from linking

**Output:**
- Store full analytics in `/workspace/group/analytics/weekly-{date}.md`
- Send concise WhatsApp summary (top 3 insights + 1 recommended action)
- If a trend is concerning (e.g., habit streak breaking, mood declining), lead with that
```

### Capability 4: Progressive Summarisation (Scheduled)

**Trigger:** Weekly scheduled task (e.g., Wednesday, mid-week processing)

**Behaviour (add to CLAUDE.md under Autonomous Behavior):**

```
### Progressive Summarisation (Weekly)

Process Raw notes toward Polished status. Follow the BASB Progressive Summarisation layers from notion-reference.md and para-method/digital-cognition-guide.md.

1. Query SB_Notes where Status = Raw, ordered by Date Created (oldest first)
2. Process up to 5 notes per run (stay within 30-min container timeout):

   For each Raw note:
   a. Read the full page content via notion-fetch
   b. If the note is empty or trivial (< 50 words), skip — flag for deletion review
   c. **Layer 2 (Bold key passages):** Identify the 2-3 most important sentences/facts
   d. **Layer 3 (Executive summary):** Write a 1-2 sentence summary at the top of the note
   e. **Layer 4 (Extract actionable insights):**
      - Any task hiding in this note? → Create SB_Tasks entry
      - Any content to consume? → Create SB_Content entry
      - Any connection to an active Project? → Link via PARA relation
   f. **Generate AI keywords:** Add 3-7 descriptive keywords to the AI keywords property
   g. **Update status** to Polished
   h. **Link to PARA** if not already linked (use PARA matching from CLAUDE.md)

3. **Report via WhatsApp:**
   - "Processed X notes this week"
   - List each note title and what was extracted
   - Any tasks or content items created as a result

4. **Don't over-process:**
   - If a note is clearly just a quick reference (phone number, address), just add keywords and mark Polished — don't write a summary
   - Respect the user's voice — summaries should capture their meaning, not rewrite it
   - Follow the "never miss twice" principle: if a note was skipped last week, prioritise it this week
```

## Technical Considerations

### Notion API Access (Critical)

The documented MCP semantic search limitation means the agent MUST use the direct Notion API (via curl in Bash) for any operation requiring complete enumeration. Key rules:

1. **Complete enumeration** → Direct API with `databases/{id}/query` and filters
2. **Content/body search** → MCP `notion-search` (good for finding text within pages)
3. **Single page read/write** → MCP `notion-fetch` / `notion-update-page` / `notion-create-pages`
4. **Always paginate** — use `has_more` + `start_cursor` for datasets >100 items

The agent already has `NOTION_TOKEN` in the environment and `api.notion.com` in `NO_PROXY` — no networking changes needed.

### Container Timeout

Each scheduled task runs in a fresh container with a 30-minute timeout. Design tasks to complete within this window:
- Analytics: ~15 minutes for 30 Daily Pages + all PARA items
- Progressive Summarisation: limit to 5 notes per run
- Cross-database research: typically 2-5 minutes for a single topic

### Para Method Guides as Methodology Context

The `para-method/` directory contains 12 supplementary guides that inform agent behaviour. Key guides for this feature:

| Guide | Relevance |
|-------|-----------|
| `digital-cognition-guide.md` | "Promote unusual associations" — foundation for cross-database research |
| `daily-weekly-monthly-reviews.md` | Review checklists that analytics should mirror |
| `atomic-habits-integration.md` | Habit tracking patterns, "never miss twice", streak analysis |
| `time-blocking-guide.md` | 1-3-5 rule, energy matching — for productivity analytics |
| `planning-projects-guide.md` | Intermediate packets concept — notes as building blocks |
| `mindsweep-and-priorities-guide.md` | Brain dump and priority ordering — for knowledge gap analysis |
| `para-decision-guide.md` | Routing decision trees — for categorising research findings |

Reference in CLAUDE.md: "Read `/workspace/group/para-method/README.md` for deeper methodology context when running analytics, summarisation, or research tasks."

### Analytics Storage

Store weekly analytics in `/workspace/group/analytics/` so they persist across sessions and can be compared period-over-period. File pattern: `weekly-YYYY-MM-DD.md`.

## Acceptance Criteria

### Capability 1: Cross-Database Research
- [ ] User can ask "what do I know about X?" and get a synthesized answer
- [ ] Response includes items from all relevant databases (not just one)
- [ ] Missing PARA relations are created automatically
- [ ] Uses direct Notion API for enumeration (not just MCP semantic search)

### Capability 2: Web Research → Second Brain
- [ ] User can ask "research topic X" and Raiden searches the web
- [ ] Creates SB_Content entry for each source with URL and Type
- [ ] Creates SB_Notes entry with research summary, AI keywords
- [ ] Both entries linked to PARA item and Daily Page
- [ ] Cross-references existing Second Brain content before creating duplicates

### Capability 3: Analytics
- [ ] Weekly scheduled task runs after maintenance sweep
- [ ] Reports knowledge gaps (Active PARA items with no notes/content)
- [ ] Reports habit consistency % and mood correlations
- [ ] Compares to previous week when analytics file exists
- [ ] Stores full analytics in `/workspace/group/analytics/`
- [ ] Sends concise WhatsApp summary (not the full report)

### Capability 4: Progressive Summarisation
- [ ] Weekly scheduled task processes up to 5 Raw notes
- [ ] Adds executive summary and AI keywords to each note
- [ ] Extracts tasks/content items from notes and creates them
- [ ] Updates note status from Raw to Polished
- [ ] Links to PARA if not already linked
- [ ] Reports what was processed via WhatsApp

## Implementation Plan

### Phase 1: Foundation (CLAUDE.md + supporting files)

**Files modified:**

| File | Change |
|------|--------|
| `groups/main/CLAUDE.md` | Add 2 sections under Proactive Behaviors (Capabilities 1-2) + 2 sections under Autonomous Behavior (Capabilities 3-4) + routing tree entry #0 |
| `groups/main/notion-reference.md` | Add Section 9: "Direct API Query Patterns" with curl examples and database IDs |

**No code changes.** No container rebuild. No Dockerfile changes.

### Phase 2: Scheduled Tasks

Create 2 new scheduled tasks via Raiden's `schedule_task` MCP tool:
1. **Analytics** — cron: `0 19 * * 0` (Sunday 7pm, after weekly sweep)
2. **Progressive Summarisation** — cron: `0 14 * * 3` (Wednesday 2pm, mid-week)

Both use `context_mode: 'isolated'` with prompts referencing their CLAUDE.md section.

### Phase 3: Verify

1. Test cross-database research: ask Raiden "what do I know about Bitcoin?"
2. Test web research: ask Raiden "research progressive summarisation techniques"
3. Wait for analytics scheduled task to run
4. Wait for summarisation scheduled task to run
5. Check `/workspace/group/analytics/` for output files

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| Notion API rate limits (3 requests/second) | 350ms delay between calls + exponential backoff on 429 (see Deepened Analysis §5) |
| 30-min timeout for analytics on large datasets | Limit to 30 Daily Pages + cap PARA items at 100 |
| **Idle timer kills long analytics** | Agent MUST send_message progress every 5-10 min (see Deepened Analysis §1) |
| MCP semantic search incompleteness | Always use direct API for enumeration; MCP only for body search |
| Progressive summarisation quality | Process 5 notes/week max; user can review and adjust |
| Analytics storage bloat | Keep only last 8 weekly reports; archive older ones |
| **Analytics/Sweep overlap** | Analytics subsumes Sweep Part 3 "Reflect" — update Sweep to reference analytics file (see §3) |
| **Prog. Summarisation/Sweep overlap** | Sweep Part 1 Step 2 defers full processing to Wednesday task — Sweep only links PARA (see §3) |

## References & Research

### Internal References
- `groups/main/notion-reference.md` — Complete database schemas, property types, relation architecture
- `groups/main/CLAUDE.md:360-466` — Existing scheduled task patterns to follow
- `groups/main/para-method/` — 12 supplementary methodology guides
- `groups/main/para-inventory.md` — Cached PARA snapshot with page IDs
- `docs/solutions/integration-issues/notion-mcp-semantic-search-filtering-limitation.md` — Critical: MCP search only finds ~30-50% of items
- `docs/solutions/integration-issues/notion-mcp-https-proxy-api-access.md` — Notion MCP networking setup checklist

### Methodology References
- `para-method/digital-cognition-guide.md` — "Promote unusual associations", slow burn approach
- `para-method/daily-weekly-monthly-reviews.md` — Review cadence patterns
- `para-method/atomic-habits-integration.md` — Habit analytics framework
- `para-method/planning-projects-guide.md` — Intermediate packets concept

---

## Deepened Analysis (from parallel review agents)

### §1 CRITICAL: Idle Timer Will Kill Long Analytics

The container's idle timer (`IDLE_TIMEOUT = 30min` in `src/config.ts:37`) closes stdin when no output is produced. The `resetIdleTimer` in `task-scheduler.ts:127` only fires on actual `streamedOutput.result` — internal tool calls (curl, bash) do NOT reset it.

**Fix:** Add to the Analytics CLAUDE.md section:
```
IMPORTANT: Send a brief progress update via send_message every 5-10 minutes
during long analytics runs (e.g., "Analyzing Daily Pages... 15/30 complete").
This prevents the container from being terminated for inactivity.
```

### §2 Section Placement & Routing Tree Integration

**On-demand capabilities go under Proactive Behaviors, not Autonomous Behavior.** The existing CLAUDE.md structure is:
- `## Autonomous Behavior` → scheduled tasks (Morning Briefing, Inbox Processing, etc.)
- `### Proactive Behaviors (During Normal Conversations)` → `#### Routing Decision Tree` (first-match-wins)

Capabilities 1-2 are on-demand and must be placed as `####` subsections under Proactive Behaviors. Capabilities 3-4 are scheduled and go under Autonomous Behavior.

**Routing tree needs entry #0** (before "Health/Medication data") to intercept research triggers:
```
0. **Research / Knowledge query** → See "Deep Research" or "Web Research" section below
   - Signals: "what do I know about", "search my second brain", "research", "find out about", "look up"
   - These are NOT routed to a database — see dedicated sections
```

### §3 Overlap Resolution with Existing Tasks

Three overlaps identified. Resolutions:

**A) Analytics vs Weekly Sweep Part 3 "Reflect"**
The Sweep already computes mood trends, habit rates, and correlations over 7 days. Analytics does the same over 30 days.
→ **Resolution:** Analytics subsumes Sweep Part 3. Update the Weekly Sweep section to remove Part 3 "Reflect" and replace with: "See weekly analytics report for mood/habit/sleep analysis." The Analytics task (running immediately after the Sweep) covers this with deeper 30-day data.

**B) Analytics vs Monthly Review**
The Monthly Review (lines 441-455) also computes sleep, mood, habit rates, and medication adherence over 30 days.
→ **Resolution:** Monthly Review should consume the latest analytics file (`/workspace/group/analytics/weekly-{date}.md`) instead of re-computing. Update Monthly Review to: "Read the most recent weekly analytics report. Add PARA audit, project review, and content pruning on top."

**C) Progressive Summarisation vs Weekly Sweep Part 1 Step 2**
The Sweep Step 2 says: "Process SB_Notes with Status = Raw — link to PARA, suggest Polished status." This overlaps with the Wednesday Progressive Summarisation task.
→ **Resolution:** Sweep Part 1 Step 2 should only do PARA linking for Raw notes, not status changes. Full processing (summary, keywords, status → Polished) deferred to Wednesday's Progressive Summarisation task. Update Sweep to: "Link Raw SB_Notes to PARA if unlinked. Do NOT change status — Progressive Summarisation handles that Wednesday."

### §4 Zero-Result Handling (All 4 Capabilities)

No capability specifies what happens when results are empty. Add to each CLAUDE.md section:

**Cross-Database Research (0 results):**
```
If no items match across any database, report: "I searched all 5 databases for [topic]
but found no matches. Would you like me to research this topic on the web instead?"
```

**Web Research (0 useful results):**
```
If web search returns nothing useful: "I searched for [topic] but didn't find
substantive results. Try rephrasing, or I can search with different keywords."
```

**Analytics (0 Daily Pages in 30 days):**
```
If fewer than 7 Daily Pages exist, note: "Only [N] Daily Pages in the last 30 days —
analytics may not be representative. Consider logging daily for richer insights."
Skip mood/habit correlation analysis if fewer than 7 data points.
```

**Progressive Summarisation (0 Raw notes):**
```
If no Raw notes exist: send_message "No Raw notes to process this week —
all caught up!" and exit. Do not send a report for zero work.
```

### §5 Notion API Best Practices (from research)

**Relation traversal optimization — filter by relation, not N+1 page fetches:**
Instead of fetching a PARA page → extracting task IDs → fetching each task:
```bash
# Query Tasks DB WHERE PARA relation contains the PARA page ID — 1 request, up to 100 results
curl -s -X POST "https://api.notion.com/v1/databases/${DB_TASKS}/query" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"property":"PARA","relation":{"contains":"'"${PARA_PAGE_ID}"'"}},"page_size":100}'
```
Apply same pattern for Notes, Content. 3 requests per PARA item instead of dozens.

**25-reference truncation:** Page responses truncate relation properties at 25 items. For complete lists, use the property item endpoint: `GET /v1/pages/{id}/properties/{property_id}`.

**Cross-database search:** Run all 5 database queries with 350ms stagger (background jobs + sleep 0.35). Use `jq` for local aggregation.

**Date range filter for 30-day analytics:**
```bash
THIRTY_DAYS_AGO=$(date -d '30 days ago' '+%Y-%m-%d')
# Filter: {"property":"Date","date":{"on_or_after":"${THIRTY_DAYS_AGO}"}}
```

**Rate limiting:** 350ms between sequential requests. On 429: read `Retry-After` header, exponential backoff (1s → 2s → 4s → ..., cap 60s).

**Progressive Summarisation — summary placement:**
The Notion API has no "prepend" for blocks. Two options:
1. **Recommended:** Add a "Summary" rich_text property to SB_Notes database, update via page PATCH (simplest, queryable, no block manipulation)
2. **Alternative:** Append a callout block at the bottom of the note body (visually distinct, no delete-and-recreate needed)

Avoid the delete-all-blocks-and-recreate approach — it's fragile with nested content.

### §6 Scheduling: No Dependency Mechanism

The plan says Analytics runs "after the maintenance sweep" but cron has no dependency chaining. The `GroupQueue` processes tasks sequentially per group, so if both are for the same `chat_jid`, the second will wait for the first. But the cron times must be staggered enough.

**Current maintenance sweep time:** Need to verify. If the sweep runs at e.g., 5pm Sunday, then Analytics at 7pm gives 2 hours of buffer. If the sweep runs closer to 7pm, they could overlap.

**Recommendation:** Set Analytics cron at least 2 hours after the maintenance sweep. Since both are for the main group's `chat_jid`, the GroupQueue will serialize them — but the second task won't start until the first finishes, potentially delaying the analytics report.

### §7 Architecture Verdict

The prompt-only approach passes all SOLID principles and preserves all architectural boundaries:
- Host/container isolation: PASS (no code changes)
- IPC protocol: PASS (no new message types)
- Security perimeter: PASS (NOTION_TOKEN already in env, api.notion.com already in NO_PROXY)
- Group isolation: PASS (analytics files in `/workspace/group/analytics/`)

The infrastructure already supports all four capabilities. No plumbing is missing.
