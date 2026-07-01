# Notion-Codeman Integration — Design Spec

**Date:** 2026-05-12
**Status:** Draft
**Scope:** Private feature (no upstream PR)

## Goal

Bridge the user's Notion "Codeman Board" database with Codeman's work item system, creating an automated pipeline from loose notes to dispatched coding sessions with full lifecycle tracking.

## Notion Database

- **Database ID:** `35e779a1-ce24-806d-b809-f5c4726e3dd0`
- **Data Source ID:** `35e779a1-ce24-8066-bceb-000bb0ae46e9`
- **Name:** Codeman Board

### Properties

| Property | Type | Purpose |
|----------|------|---------|
| Name | title | Record name / task title |
| Status | select | Pipeline stage (see flow below) |
| Project | select | Maps to Codeman case + Gitea repo |
| Issue(s) | rich_text | Gitea issue numbers/URLs |
| PR | rich_text | PR references (populated on Done) |
| Ease | select | ICE scoring input |
| Priority | select | ICE scoring input |
| Impact | select | ICE scoring input |
| ICE Score | formula | Computed from Ease/Priority/Impact |

### Page Body

Contains loose notes (unstructured text) that describe what the user wants done. These are the primary input for the "Spec Issue" step.

## Status Flow

```
Spec Issue → Review Issue → Send to Codeman → In Progress → Review PR → Done
```

| Status | Trigger | Action | Actor |
|--------|---------|--------|-------|
| Spec Issue | User creates/updates record | Notion webhook → Codeman dispatches AI session → creates Gitea issue(s) → updates Issue(s) field → advances to Review Issue | Automated |
| Review Issue | Status set by Spec Issue handler | User reviews the Gitea issue(s) | Manual |
| Send to Codeman | User moves record manually | Notion webhook → Codeman creates work item → advances to In Progress | Automated |
| In Progress | Status set by Send to Codeman handler | Orchestrator dispatches coding session | Automated |
| Review PR | Work item reaches `review` status (merge-prep passed) | Codeman updates Notion status | Automated |
| Done | User marks work item as `done` in Codeman | Codeman updates Notion: status → Done, populates PR field, adds summary comment | Automated |

## Architecture

### Project Mapping

Stored in `~/.codeman/notion-config.json`:

```json
{
  "apiKey": "ntn_...",
  "databaseId": "35e779a1-ce24-806d-b809-f5c4726e3dd0",
  "dataSourceId": "35e779a1-ce24-8066-bceb-000bb0ae46e9",
  "webhookSecret": "...",
  "projectMapping": {
    "Website": { "giteaRepo": "mauri/presshero-website", "caseId": "presshero-website" },
    "PressHERO App": { "giteaRepo": "PressHERO/presshero-app", "caseId": "presshero-app" },
    "SportNetwork": { "giteaRepo": "mauri/SportNetwork-CMS", "caseId": "SportNetwork-CMS" },
    "CRM": { "giteaRepo": "mauri/presshero-crm", "caseId": "presshero-crm" },
    "Finance": { "giteaRepo": "mauri/presshero-finance", "caseId": "presshero-finance" }
  }
}
```

The `webhookSecret` is checked against incoming webhook requests (via a custom header) to prevent unauthorized triggers.

### Notion Client (`src/integrations/notion.ts`)

Thin wrapper around the Notion API using native `fetch()` with 5s timeouts, following the same pattern as existing Sentry/Slack/Asana clients.

Functions:
- `fetchNotionPage(pageId, apiKey)` — read page properties
- `fetchPageBlocks(pageId, apiKey)` — read body content (loose notes)
- `updateNotionStatus(pageId, status, apiKey)` — update the Status select
- `updateNotionField(pageId, field, value, apiKey)` — update Issue(s), PR, etc.
- `addNotionComment(pageId, text, apiKey)` — add a comment to the page
- `loadNotionConfig()` — read and validate `~/.codeman/notion-config.json`

### Webhook Endpoint (`POST /api/webhooks/notion`)

New route file: `src/web/routes/notion-webhook-routes.ts`

- Validates the webhook secret from a custom header
- Reads the page ID from the payload
- Fetches the full page state from Notion API (properties + body blocks)
- Routes based on Status:
  - "Spec Issue" → `handleSpecIssue()`
  - "Send to Codeman" → `handleSendToCodeman()`
- Returns 200 immediately, processes asynchronously

### Handler: `handleSpecIssue(pageId)`

1. Read Notion page properties (Project, Issue(s), Name) and body blocks (loose notes)
2. Look up project mapping → get Gitea repo and case ID
3. Create a short-lived work item:
   - `source: 'notion'`
   - `caseId` from mapping
   - `title`: `"Spec: {record name}"`
   - `description`: structured prompt with the loose notes, Gitea repo, and any existing issue numbers
   - `metadata`: `{ notionPageId, notionAction: 'spec-issue', giteaRepo, existingIssues }`
4. Orchestrator dispatches as a Claude Code session with a prompt that:
   - Reads the notes and relevant codebase context
   - Creates or updates Gitea issue(s)
   - Exits when done (auto-close)
5. On session completion (detected by orchestrator):
   - `metadata.notionAction === 'spec-issue'` triggers the Notion update path instead of merge-prep
   - Updates the Notion Issue(s) field with created/updated issue URLs
   - Updates Notion Status to "Review Issue"
   - Marks the work item as `done`

### Handler: `handleSendToCodeman(pageId)`

1. Read Notion page properties (Project, Name, Issue(s))
2. Look up project mapping → get case ID
3. Create a regular work item:
   - `source: 'notion'`
   - `caseId` from mapping
   - `title`: the Notion record Name
   - `description`: references the issue URLs from Issue(s) field
   - `metadata`: `{ notionPageId }`
   - `externalRef`: Notion page ID
   - `externalUrl`: Notion page URL
4. Update Notion Status to "In Progress"
5. Orchestrator picks up and dispatches normally

### Completion Callbacks (in `orchestrator.ts`)

Hooked into the existing `handleCompletionFlow()`. When a work item with `source === 'notion'` transitions:

**→ `review` (merge-prep passed):**
- Update Notion Status to "Review PR"

**→ `done` (user marks manually):**
- Update Notion Status to "Done"
- Populate Notion PR field with branch/PR references from `branchName` and `metadata.mergePrepResult`
- Add a Notion comment with:
  - Summary of what was done
  - Key decisions made and why
  - PR/branch references
  - Merge-prep status (pass/fail, commit count)
  - Notable outcomes (test results, audit status, etc.)

The comment content comes from:
1. `compactSummary` on the work item (already set by existing completion flow)
2. `metadata.sessionSummary` — the orchestrator captures the last N lines of session output when detecting completion, and stores them in metadata. This is best-effort: if the session output is unavailable or empty, the comment falls back to `compactSummary` and merge-prep data only.
3. `metadata.mergePrepResult` — merge-prep details (commits ahead, tsc/lint pass/fail)
4. `branchName` — branch reference

### Auto-Close for Spec Sessions

No new mechanism needed. The spec session prompt instructs Claude to exit after filing issues. The orchestrator detects session exit and runs the completion flow. The `notionAction` flag in metadata routes to the Notion update logic instead of merge-prep.

## Files Changed

### New Files
- `src/integrations/notion.ts` — Notion API client
- `src/web/routes/notion-webhook-routes.ts` — webhook endpoint + handlers

### Modified Files
- `src/work-items/types.ts` — add `'notion'` to `WorkItemSource`
- `src/integrations/types.ts` — add `NotionConfig` interface
- `src/orchestrator.ts` — add Notion completion callbacks in `handleCompletionFlow()`
- `src/web/server.ts` — register webhook routes

### Config (manual setup, not code)
- `~/.codeman/notion-config.json` — API key, database/data source IDs, webhook secret, project mapping
- Notion automations configured in Notion UI to send webhooks on status changes to "Spec Issue" and "Send to Codeman"
- Project repos linked as Codeman cases (via `linked-cases.json` or the Codeman UI)

## Testing

- Unit tests for Notion client (mock fetch, verify API calls and response parsing)
- Unit tests for webhook handlers (mock Notion client + work item store, verify correct work items created and Notion status updates called)
- Unit tests for completion callbacks (verify Notion updates when `source: 'notion'` items transition to `review` and `done`)
- Integration test: end-to-end webhook → work item creation → status update (using mocked Notion API)

## Setup Steps (Post-Implementation)

1. Create `~/.codeman/notion-config.json` with API key and project mapping
2. Link project repos as Codeman cases (if not already linked)
3. Enable orchestration on each case
4. Configure Notion automations:
   - When Status changes to "Spec Issue" → send webhook to `https://localhost:3000/api/webhooks/notion` (or the public Codeman URL if exposed)
   - When Status changes to "Send to Codeman" → send webhook to same URL
   - Include the webhook secret in a custom header (e.g., `X-Codeman-Secret`)

### Notion Webhook Payload

Notion automation webhooks send the page ID and triggering event. The webhook endpoint does NOT rely on the payload for the current status — it always fetches the full page state from the Notion API after receiving the webhook, ensuring consistency even if multiple webhooks arrive out of order.
