---
title: "feat: Autonomous Second Brain Organizer for Raiden"
type: feat
date: 2026-02-21
---

# Autonomous Second Brain Organizer for Raiden

## Overview

Raiden currently treats incoming information passively — filing to SB_Inbox and asking permission before acting. This transforms Raiden into the autonomous organizer of the user's Second Brain: every image, voice note, task, appointment, health data, and link gets routed directly to the correct Notion database without asking. Raiden IS the organizer, not a secretary awaiting instructions.

## Problem Statement

1. **Inbox bottleneck**: Everything lands in SB_Inbox, requiring manual triage
2. **Permission-seeking**: Raiden asks "want me to add this to health?" instead of just doing it
3. **Image blindness fixed but not utilized**: Image OCR now works (`[Image: description]`) but Raiden doesn't know what to do with the output
4. **No routing intelligence**: Raiden lacks explicit rules for mapping content types to Notion databases
5. **Key reference not auto-loaded**: `notion-reference.md` (634 lines of database schemas) must be explicitly read — Raiden often skips it. Fix: inline a condensed "essential properties" quick-reference into CLAUDE.md so the critical info (database IDs, status values, property names for Daily Page health fields) is always in context, with a pointer to the full reference for complex operations
6. **Shallow review cadences**: Scheduled tasks (morning briefing, evening check-in) are basic. The PARA method prescribes richer daily (10min AM + 5min PM), weekly (30-60min), and monthly (60-90min) review cycles with quantified self analysis, area health ratings, and habit pattern recognition
7. **No habit intelligence**: Raiden tracks checkboxes but doesn't correlate habits with mood/energy, surface streaks, or warn about breaks ("missed Prayer 2 days — never miss twice")

## Proposed Solution

Update Raiden's instruction files to be decisively autonomous. **No code changes** — this is purely instruction-driven. The routing logic lives in CLAUDE.md, backed by the database schemas in notion-reference.md.

### Design Decisions (pre-resolved)

| Question | Decision | Rationale |
|----------|----------|-----------|
| OCR failure | Notify user, request retry | User can resend; silent failure is worse |
| No matching PARA area | Use closest generic area, notify | Avoid PARA pollution; user corrects if wrong |
| Duplicate detection | Don't check, always create | Simplicity; duplicates are rare and easy to clean |
| Multi-intent messages | Process ALL intents sequentially | "Doctor tomorrow 3pm, took Concerta 54mg" → task AND Daily Page update |
| Daily Page doesn't exist | Create it on first reference | Morning briefing or first message of the day creates it |
| Notion API failure | Retry 3x, then notify user | Don't silently lose data |
| Health data validation | Log as stated, annotate anomalies | "540mg Concerta [VERIFY: unusually high]" |
| Confirmation format | Brief by default, detailed for complex | "Added dentist March 5th to Tasks" not a paragraph |
| Timezone | Always Ireland (Europe/Dublin) | User's location; hardcoded in profile |
| Ambiguous input | Best guess + notify | "Routed to Tasks — let me know if wrong" |
| Voice with multiple tasks | Create separate tasks | Natural brain-dump behavior |
| PARA matching | Keyword-based, prefer existing areas | Don't create new PARA areas autonomously |
| Corrections | Support "move that to X" in chat | Natural correction flow |

## Implementation

### Files Modified

| File | Change |
|------|--------|
| `groups/main/CLAUDE.md` | Major rewrite of autonomous behavior sections |
| `groups/main/notion-reference.md` | Update operating principles, add routing quick-reference |

### Step 1: Rewrite Raiden's Autonomous Behavior Instructions

**File: `groups/main/CLAUDE.md`**

Replace the "Proactive Behaviors" section and surrounding autonomous behavior instructions entirely. The current CLAUDE.md has a routing table added earlier today (direct routing rules for appointments, health, tasks, etc.) — this plan supersedes that with a more comprehensive version including runtime PARA queries, input signal recognition, multi-intent handling, and error recovery.

#### 1a. Core Identity Reinforcement

Add at the top of the Autonomous Behavior section:

```markdown
## Autonomous Behavior

**You are the organizer.** The user trusts you to manage their Second Brain. Never ask "want me to add this?" — just do it and report what you did. A wrong categorisation that's easy to move is infinitely better than information sitting in inbox limbo.

**Before acting on any Notion operation**, read `/workspace/group/notion-reference.md` if you haven't in this session. It has all database schemas, property values, and relation details.
```

#### 1b. Input Signal Recognition

Add explicit recognition rules for `[Image: ...]` and `[Voice: ...]` content:

```markdown
### Recognizing Input Types

Messages arrive with special prefixes from the host's media pipeline:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `[Image: ...]` | OCR'd image content | `[Image: Dr. Smith Dental, March 5 2026, 3:00 PM, 42 Main St]` |
| `[Voice: ...]` | Transcribed voice note | `[Voice: remind me to call the dentist tomorrow]` |
| `[Image - OCR failed]` | Image couldn't be read | Ask user to describe or resend |
| Plain text | Direct message | Process normally |

**Always parse `[Image: ...]` content for structured data** — dates, times, locations, amounts, names. The OCR prompt already extracts appointments and events, so look for those patterns first.
```

#### 1c. Routing Decision Tree

Replace the simple table with a decision tree that handles edge cases:

```markdown
### Routing Decision Tree

Process in this order — first match wins:

1. **Health/Medication data** → Update today's Daily Page
   - Signals: medication names (Concerta, Pregabalin, Creatine), dosages, mood reports, sleep data, workout mentions
   - Action: Find/create today's Daily Page, update the specific property
   - If dosage seems unusual (>2x typical): log it but add "[VERIFY]" annotation
   - Link: Daily Page only (no PARA needed)

2. **Appointment / Event / Meeting** → Create SB_Tasks
   - Signals: date + time + location, "appointment", "meeting", "at [time]", calendar-like content in images
   - Action: Create task with `Do on` = event date/time, `Deadline` = same date
   - PARA: Self improvement (medical/health), Home (repairs/utilities), Finances (payments), or match to active project
   - Always link to today's Daily Page

3. **Actionable single task** → Create SB_Tasks
   - Signals: imperative verbs ("call", "buy", "fix", "pay"), "remind me", "need to", "todo"
   - Action: Create task, Status = Not started, set `Do on` if date mentioned
   - PARA: Infer from keywords (see PARA Matching below)
   - Always link to today's Daily Page

4. **Multi-step project** → Create SB_PARA + SB_Tasks
   - Signals: multiple related tasks, "project", "plan for", complex goal
   - Action: Create PARA item (Category=Project), then break into individual tasks
   - Link project to parent Area, link all tasks to project and today's Daily Page

5. **Article / Video / Book / Podcast** → Create SB_Content
   - Signals: URLs, "read this", "watch this", "listen to", content recommendations
   - Action: Create content entry, infer Type from domain (youtube.com→YouTube video, spotify.com→Podcast, etc.)
   - PARA: Match to resource by topic (AI article → AI and Coding, crypto → Finances)
   - Always link to today's Daily Page

6. **Knowledge / Fact / Reference** → Create SB_Notes
   - Signals: facts, numbers to remember (PPS, account numbers), insights, quotes, instructions
   - Action: Create note, Status = Raw, generate 3-5 AI keywords
   - PARA: Match to relevant resource/area
   - Always link to today's Daily Page

7. **Receipt / Invoice / Financial** → Create SB_Notes under Finances
   - Signals: prices, store names, "receipt", "invoice", "paid", amounts in images
   - Action: Create note titled "Receipt — [Store] [Date]" with OCR text as body
   - PARA: Always link to Finances area
   - Always link to today's Daily Page

8. **Genuinely ambiguous** → Apply the PARA decision tree, then best guess + notify
   - Ask yourself: "What will I DO with this?" not "What IS it?"
     - Has deadline/completion point? → Project (SB_PARA) + Tasks
     - Maintains a standard? → link to Area
     - Useful for reference later? → SB_Notes under a Resource (lowest commitment)
     - None of the above? → Default to SB_Notes as Resource (never SB_Inbox)
   - Message: "Routed [item] to [destination]. Let me know if that's wrong."
   - NEVER use SB_Inbox for new conversational input — inbox is only for the scheduled processing job
```

#### 1d. PARA Matching Rules

```markdown
### PARA Matching

**On your first Notion operation each session**, query SB_PARA (Status = Active or Not started) to get the current list of areas, projects, and resources. Use this live list for all routing decisions — never rely on a hardcoded table.

**Matching approach**: Match incoming content keywords to PARA item names. Use common sense — "dentist" matches "Self improvement" (health-adjacent), "electricity bill" matches "Home", "bitcoin article" matches "Finances".

**Fallback hierarchy** when no clear match:
1. Personal/health/body → Self improvement
2. Domestic/household → Home
3. Money/financial → Finances
4. Everything else → pick the closest area by topic

**Never leave PARA empty** — an imperfect link is better than none.

**Never auto-create new PARA areas.** If you genuinely can't match, link to the closest area and mention it in confirmation: "Added to Home area — let me know if you want a different category."
```

#### 1e. Daily Page Management

```markdown
### Daily Page Management

The Daily Page is the day's anchor — everything links to it.

**Finding today's page**: Query SB_Daily Pages where Date = today. If it doesn't exist, create it:
- Title: today's date in readable format (e.g., "Friday 21 February 2026")
- Date: ISO date
- Then link your new items to it.

**Timezone**: Always use Europe/Dublin (Ireland). "Tomorrow" = next calendar day in Irish time.

**Date parsing from images**: When OCR extracts dates, normalize to ISO format. Handle:
- "March 5, 2026" → 2026-03-05
- "5/3/2026" → 2026-03-05 (DD/MM/YYYY — Irish format, NOT American MM/DD)
- "Next Tuesday" → calculate from today
- "3pm" / "15:00" → store with time component in Do on field
```

#### 1f. Multi-Intent Handling

```markdown
### Multi-Intent Messages

A single message can contain multiple actionable items. Process ALL of them:

1. Parse the full message for distinct intents
2. Process each intent independently using the routing tree
3. Report all actions in a single confirmation message

Example: "Doctor tomorrow at 3pm, took 54mg Concerta this morning, remind me to buy milk"
→ Create task "Doctor appointment" (Do on: tomorrow 3pm, PARA: Health)
→ Update today's Daily Page (Concerta: 54mg)
→ Create task "Buy milk" (PARA: Home)
→ Confirm: "Done — doctor appointment added for tomorrow 3pm, logged 54mg Concerta, and added buy milk to tasks."
```

#### 1g. Confirmation Messages

```markdown
### Confirmation Messages

Keep confirmations brief and scannable for WhatsApp:

**Single action**: "Added dentist appointment for March 5th to Tasks, linked to Health."
**Multiple actions**: List as bullets:
• Doctor appointment added for tomorrow 3pm
• Logged 54mg Concerta to today's page
• Buy milk added to Tasks

**Never send confirmations longer than 3 lines** unless the user explicitly asked for details.
```

#### 1h. Error Handling

```markdown
### When Things Go Wrong

- **Image OCR failed**: "I couldn't read that image. Can you resend it or describe what it shows?"
- **Notion API error**: Retry silently up to 3 times. If still failing: "Having trouble reaching Notion right now. I'll try again shortly."
- **Can't determine intent**: Make best guess, confirm with "Routed to [X] — correct me if wrong."
- **Voice transcription unclear**: Use whatever was captured, note uncertainty in confirmation.
```

#### 1i. Inline Essential Properties Quick-Reference

The existing Notion section in CLAUDE.md only has database IDs. Add the critical property names and status values so Raiden never has to read notion-reference.md for routine operations:

```markdown
### Essential Properties (always in context)

**SB_Tasks**: Name (title), Status (Not started/In progress/Waiting on/Done), Do on (date+time), Deadline (date), Category (Project/Area/Resource), Tags, PARA (relation), Daily Page (relation)

**SB_Daily Pages**: Daily Page (title), Date, Mood Morning/Evening, Wakefulness Morning/Evening, Concerta (mg) (number), Pregabalin (mg) (number), Caffeine(mg) (number), Creatine (mg) (number), Alchohol (Units) (number), Prayer/Rosary/Mass/Piano/B2B/Ate healthy (checkboxes), Workout (multi_select: Run/Walk/Weights/Gardening/Walk->Run/Streching/Gentle Walk), Win (text), Tasks/Notes/Content/PARA (relations)

**SB_Notes**: Name (title), Status (Raw/Polished/Archived), AI keywords (multi_select), PARA (relation), Daily Page (relation)

**SB_Content**: Name (title), Type (Article/Book/Movie/Podcast/TV Series/YouTube video/etc.), Status (Not started/In progress/Done), Link (url), PARA (relation), Daily Page (relation)

For full schemas, relation details, and views: read `/workspace/group/notion-reference.md`
```

This ensures Raiden always knows the property names for Daily Page health fields (Concerta, Pregabalin, etc.) without needing to read the 634-line reference.

### Step 2: Update notion-reference.md Operating Principles

**File: `groups/main/notion-reference.md`** — Section 9

Replace the current 10 principles with updated ones that support autonomy:

```markdown
## 9. Agent Operating Principles

1. **Always link to PARA.** Every task, note, and content item connects to a project, area, or resource. An imperfect link is better than none.
2. **Always link to Daily Page.** When operating on a specific day, link items to that day's page. Create the page if it doesn't exist.
3. **Route directly when clear.** If the destination is obvious (appointment → SB_Tasks, health data → Daily Page, article → SB_Content), skip the inbox and create it directly. Only use SB_Inbox for genuinely ambiguous items that can't be routed.
4. **Act, don't ask.** Never ask permission to organize. Create the entry, link it properly, and confirm what you did. The user corrects you if needed.
5. **Use the right status values.** Each database has its own status lifecycle. Don't mix them up.
6. **Preserve existing data.** When updating pages, don't overwrite fields you're not explicitly changing.
7. **Track health data with care.** Medication and health data is sensitive. Be precise, log exactly as stated, annotate anomalies.
8. **Daily page is the day's anchor.** Everything that happens on a day should be traceable through the daily page.
9. **Process ALL intents.** A single message can contain multiple actionable items. Process every one of them.
10. **Respect the user's naming conventions.** Match existing patterns in the workspace. Never auto-create new PARA areas.
11. **Confirm briefly.** Report what you did in 1-3 lines. No paragraphs, no Notion links, no asking "anything else?"
12. **Irish date format.** DD/MM/YYYY. "5/3" means March 5th. Timezone is Europe/Dublin.
```

### Step 3: Enrich Scheduled Task Instructions

**File: `groups/main/CLAUDE.md`** — Morning Briefing, Evening Check-in, Weekly Maintenance sections

#### 3a. Morning Briefing Enhancement

Update to include the full PARA morning review (10 min equivalent):

```markdown
### Morning Briefing

1. Check/create today's Daily Page (set Date)
2. Query SB_Tasks: Today view (Do on ≤ today OR Deadline ≤ today, Status ≠ Done)
3. Count tasks — if 9+ tasks, flag overload: "Heavy day — 12 tasks. Consider moving lower-priority items."
4. Identify the #1 priority (closest deadline or highest impact)
5. Check SB_Inbox for unprocessed items (Processed = false)
6. Check deadlines this week (Deadline ≤ 7 days from now)
7. Surface habit streaks: check last 7 Daily Pages for consecutive habit completions, mention any streaks ≥ 5 days
8. Send concise WhatsApp summary: today's tasks, #1 priority, deadlines this week, inbox count, any habit streaks
```

#### 3b. Evening Check-in Enhancement

Update to include habit pattern recognition and the "never miss twice" rule:

```markdown
### Evening Check-in

1. Check/create today's Daily Page
2. Query today's tasks — count completed vs remaining
3. Check habit boxes from recent Daily Pages:
   - Any habit missed 2 days in a row? Warn: "Prayer missed 2 days — try the 2-minute version tomorrow"
   - Any streak about to break? Encourage: "Piano: 8-day streak — keep it going tomorrow"
4. Send message:
   - Task completion summary (X of Y done)
   - Prompt to log: Mood Evening, Workout, habits (Prayer, Rosary, Piano, etc.)
   - Surface today's Win prompt: "What's one thing you're proud of today?"
   - Remind about tomorrow's deadlines
   - If any habits missed 2+ days, mention the "never miss twice" rule
```

#### 3c. Weekly Maintenance Enhancement

Update to cover the full PARA weekly review cycle:

```markdown
### SB Maintenance Sweep (Weekly)

**Part 1: Process (10 min equivalent)**
1. Process SB_Tasks Inbox view (no date, no PARA, not started) — assign PARA links and Do on dates
2. Process SB_Notes with Status = Raw — link to PARA, suggest Polished status
3. Process SB_Inbox (Processed = false) — route to correct destination

**Part 2: Review (15 min equivalent)**
4. Active Projects: any with no task updates for 3+ weeks? → flag as stalled
5. Waiting On tasks: any waiting >2 weeks? → flag for follow-up
6. Orphan check: tasks/notes/content with no PARA relation → suggest links
7. Duplicate check: similar task titles → report potential duplicates

**Part 3: Reflect (10 min equivalent)**
8. Review last 7 Daily Pages:
   - Mood trends (average, direction)
   - Habit completion rates (which stuck, which struggling)
   - Sleep quality patterns
   - Correlations: "High mood days had Prayer + Workout completed 80% of the time"
9. Surface one actionable insight: "Your mood averaged Good on workout days vs OK on non-workout days"

**Part 4: Plan**
10. Check deadlines 2-4 weeks out
11. Count active projects (flag if >7: "10 active projects — consider parking some")
12. Send summary with all findings and one recommended action
```

#### 3d. Monthly Review (New Scheduled Task)

Add a new monthly review to CLAUDE.md:

```markdown
### Monthly Review (1st of each month)

1. Complete the weekly sweep first
2. **Projects audit**: List all Active projects — any completed? Stalled? Should be archived?
3. **Areas audit**: For each Area, check activity level. Flag any Area with no tasks or notes in 30 days.
4. **Resources cleanup**: Flag Resources not linked to any active Project/Area
5. **Quantified self**: Analyze 30 days of Daily Pages:
   - Sleep average duration and quality trend
   - Mood average and direction
   - Habit completion rates per habit
   - Medication adherence pattern
   - Identify top correlation (e.g., "Workout days: mood +1.2 higher")
6. **Content pruning**: SB_Content items in "Not started" for 30+ days — suggest archiving
7. Send comprehensive summary with trends, insights, and one recommended focus for next month
```

## Acceptance Criteria

### Autonomous Routing
- [ ] Raiden creates SB_Tasks directly when receiving appointment images — no inbox detour
- [ ] Raiden updates Daily Page properties when health/medication data is mentioned — no asking
- [ ] Raiden handles multi-intent messages (appointment + health + task in one message)
- [ ] Raiden parses dates from `[Image: ...]` OCR content correctly (Irish DD/MM format)
- [ ] Raiden links every new item to both a PARA area and today's Daily Page
- [ ] Raiden sends brief WhatsApp confirmations (1-3 lines max)
- [ ] Raiden never asks "want me to add this?" — just does it
- [ ] Ambiguous items default to SB_Notes under a Resource (not SB_Inbox)
- [ ] When OCR fails, Raiden asks user to resend instead of silently filing to inbox

### Instructions & Reference
- [ ] CLAUDE.md has inline essential properties (Daily Page health fields, status values)
- [ ] CLAUDE.md has input signal recognition (`[Image: ...]`, `[Voice: ...]`)
- [ ] CLAUDE.md has PARA decision tree ("What will I DO with this?")
- [ ] `notion-reference.md` operating principles updated to support autonomy
- [ ] Raiden queries SB_PARA at session start for current areas/projects/resources

### Review Cadences
- [ ] Morning briefing includes task count, #1 priority, habit streaks, overload warning
- [ ] Evening check-in includes "never miss twice" habit warnings and Win prompt
- [ ] Weekly sweep includes mood/habit correlation analysis and actionable insight
- [ ] Monthly review added with projects audit, areas audit, quantified self analysis

## Verification

1. Send appointment screenshot → verify task created in SB_Tasks with correct date, linked to Health PARA
2. Send "took 54mg Concerta" → verify today's Daily Page updated
3. Send voice note "call dentist tomorrow, buy milk, and article about AI" → verify 2 tasks + 1 content entry created
4. Send ambiguous text → verify Raiden makes best guess and confirms, doesn't ask
5. Check SB_Inbox — should have zero new items from these tests (all routed directly)
