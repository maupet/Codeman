# Notion-Codeman Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge Notion's "Codeman Board" database with Codeman's work item system via webhooks, enabling an automated pipeline from loose notes → Gitea issues → dispatched coding sessions → completion tracking back to Notion.

**Architecture:** A new Notion integration module (`src/integrations/notion.ts`) handles all Notion API calls. A webhook route (`src/web/routes/notion-webhook-routes.ts`) receives Notion automation events and creates work items. The orchestrator's existing completion flow is extended to update Notion when work items with `source: 'notion'` transition to `review` or `done`.

**Tech Stack:** TypeScript, Fastify 5, Notion REST API (2022-06-28), native `fetch()`, better-sqlite3 (existing work-items store), Vitest

**Spec:** `docs/superpowers/specs/2026-05-12-notion-codeman-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/integrations/notion.ts` | Create | Notion API client: fetch pages/blocks, update status/fields, add comments, load config |
| `src/integrations/types.ts` | Modify | Add `NotionConfig` and `NotionProjectMapping` interfaces |
| `src/work-items/types.ts` | Modify | Add `'notion'` to `WorkItemSource` union |
| `src/web/routes/notion-webhook-routes.ts` | Create | Webhook endpoint + `handleSpecIssue()` and `handleSendToCodeman()` handlers |
| `src/web/routes/index.ts` | Modify | Export the new route registration function |
| `src/web/server.ts` | Modify | Import and register the Notion webhook routes |
| `src/orchestrator.ts` | Modify | Add Notion callbacks in `handleCompletionFlow()` and `handleSessionCompletion()` |
| `test/integrations/notion.test.ts` | Create | Unit tests for Notion client |
| `test/routes/notion-webhook-routes.test.ts` | Create | Unit tests for webhook handlers |
| `test/notion-completion-callbacks.test.ts` | Create | Unit tests for orchestrator Notion callbacks |

---

### Task 1: Add `'notion'` to WorkItemSource

**Files:**
- Modify: `src/work-items/types.ts:10`

- [ ] **Step 1: Update the WorkItemSource type**

In `src/work-items/types.ts`, change line 10:

```typescript
export type WorkItemSource = 'manual' | 'asana' | 'github' | 'clockwork' | 'sentry' | 'slack' | 'notion';
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors (the new union member is additive and doesn't break existing code)

- [ ] **Step 3: Commit**

```bash
git add src/work-items/types.ts
git commit -m "feat: add 'notion' to WorkItemSource type"
```

---

### Task 2: Add NotionConfig types

**Files:**
- Modify: `src/integrations/types.ts`

- [ ] **Step 1: Add NotionConfig interfaces**

Append to `src/integrations/types.ts` (after the existing `ExternalContext` type at the end of the file):

```typescript
/** Mapping from a Notion Project select value to Gitea repo and Codeman case. */
export interface NotionProjectMapping {
  giteaRepo: string;
  caseId: string;
}

/** Configuration for the Notion integration, stored in ~/.codeman/notion-config.json. */
export interface NotionConfig {
  apiKey: string;
  databaseId: string;
  dataSourceId: string;
  webhookSecret: string;
  projectMapping: Record<string, NotionProjectMapping>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/integrations/types.ts
git commit -m "feat: add NotionConfig type definitions"
```

---

### Task 3: Create Notion API client — config loader + fetchNotionPage

**Files:**
- Create: `src/integrations/notion.ts`
- Create: `test/integrations/notion.test.ts`

- [ ] **Step 1: Write failing tests for loadNotionConfig and fetchNotionPage**

Create `test/integrations/notion.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadNotionConfig, fetchNotionPage } from '../../src/integrations/notion.js';

// Mock fs for config loading
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('loadNotionConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadNotionConfig()).toBeNull();
  });

  it('returns parsed config when file exists and is valid', () => {
    const config = {
      apiKey: 'ntn_test',
      databaseId: 'db-123',
      dataSourceId: 'ds-456',
      webhookSecret: 'secret',
      projectMapping: { Website: { giteaRepo: 'mauri/website', caseId: 'website' } },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    const result = loadNotionConfig();
    expect(result).toEqual(config);
  });

  it('returns null when config file has invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(loadNotionConfig()).toBeNull();
  });
});

describe('fetchNotionPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches page properties from Notion API', async () => {
    const mockPage = {
      id: 'page-123',
      properties: {
        Name: { title: [{ plain_text: 'Test Task' }] },
        Status: { select: { name: 'Spec Issue' } },
        Project: { select: { name: 'Website' } },
        'Issue(s)': { rich_text: [{ plain_text: '42' }] },
      },
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => mockPage });

    const result = await fetchNotionPage('page-123', 'ntn_test');
    expect(result).toEqual(mockPage);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ntn_test',
          'Notion-Version': '2022-06-28',
        }),
      }),
    );
  });

  it('throws on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchNotionPage('bad-id', 'ntn_test')).rejects.toThrow('Notion API 404');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: FAIL — module `../../src/integrations/notion.js` does not exist

- [ ] **Step 3: Implement loadNotionConfig and fetchNotionPage**

Create `src/integrations/notion.ts`:

```typescript
/**
 * @fileoverview Notion API client for the Codeman integration.
 *
 * Thin wrapper around the Notion REST API using native fetch() with 5s timeouts.
 * Follows the same pattern as existing Sentry/Slack/Asana clients in this directory.
 *
 * Config is loaded from ~/.codeman/notion-config.json.
 *
 * @module integrations/notion
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { NotionConfig } from './types.js';

const FETCH_TIMEOUT = 5000;
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function notionHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Load Notion config from ~/.codeman/notion-config.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadNotionConfig(): NotionConfig | null {
  const configPath = join(homedir(), '.codeman', 'notion-config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as NotionConfig;
  } catch {
    console.warn('[notion] Failed to parse notion-config.json');
    return null;
  }
}

/**
 * Fetch a Notion page by ID (properties only).
 */
export async function fetchNotionPage(pageId: string, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${NOTION_API_BASE}/pages/${encodeURIComponent(pageId)}`, {
    headers: notionHeaders(apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${res.statusText}`);
  return (await res.json()) as Record<string, unknown>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrations/notion.ts test/integrations/notion.test.ts
git commit -m "feat: add Notion client — config loader + fetchNotionPage"
```

---

### Task 4: Notion client — fetchPageBlocks, updateNotionStatus, updateNotionField, addNotionComment

**Files:**
- Modify: `src/integrations/notion.ts`
- Modify: `test/integrations/notion.test.ts`

- [ ] **Step 1: Write failing tests for the remaining functions**

Append to `test/integrations/notion.test.ts`:

```typescript
describe('fetchPageBlocks', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches block children and extracts plain text', async () => {
    const { fetchPageBlocks } = await import('../../src/integrations/notion.js');
    const mockBlocks = {
      results: [
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Line one.' }] } },
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Line two.' }] } },
        { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'A heading' }] } },
      ],
      has_more: false,
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => mockBlocks });

    const text = await fetchPageBlocks('page-123', 'ntn_test');
    expect(text).toBe('Line one.\nLine two.\nA heading');
  });
});

describe('updateNotionStatus', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends PATCH with Status select property', async () => {
    const { updateNotionStatus } = await import('../../src/integrations/notion.js');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await updateNotionStatus('page-123', 'Review Issue', 'ntn_test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          properties: { Status: { select: { name: 'Review Issue' } } },
        }),
      }),
    );
  });
});

describe('updateNotionField', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends PATCH with rich_text property', async () => {
    const { updateNotionField } = await import('../../src/integrations/notion.js');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await updateNotionField('page-123', 'Issue(s)', '#42, #43', 'ntn_test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            'Issue(s)': { rich_text: [{ type: 'text', text: { content: '#42, #43' } }] },
          },
        }),
      }),
    );
  });
});

describe('addNotionComment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends POST to comments endpoint', async () => {
    const { addNotionComment } = await import('../../src/integrations/notion.js');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await addNotionComment('page-123', 'Work completed successfully.', 'ntn_test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parent: { page_id: 'page-123' },
          rich_text: [{ type: 'text', text: { content: 'Work completed successfully.' } }],
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: FAIL — `fetchPageBlocks`, `updateNotionStatus`, `updateNotionField`, `addNotionComment` are not exported

- [ ] **Step 3: Implement the remaining functions**

Append to `src/integrations/notion.ts`:

```typescript
/**
 * Fetch page body blocks and return as plain text (one line per block).
 */
export async function fetchPageBlocks(pageId: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `${NOTION_API_BASE}/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
    {
      headers: notionHeaders(apiKey),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    },
  );
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as {
    results: Array<Record<string, { rich_text?: Array<{ plain_text: string }> }>>;
  };

  const lines: string[] = [];
  for (const block of data.results) {
    const type = (block as unknown as { type: string }).type;
    const content = block[type];
    if (content?.rich_text) {
      const text = content.rich_text.map((rt) => rt.plain_text).join('');
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

/**
 * Update the Status select property on a Notion page.
 */
export async function updateNotionStatus(pageId: string, status: string, apiKey: string): Promise<void> {
  const res = await fetch(`${NOTION_API_BASE}/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    headers: notionHeaders(apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    body: JSON.stringify({
      properties: { Status: { select: { name: status } } },
    }),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${res.statusText}`);
}

/**
 * Update a rich_text property on a Notion page (e.g., Issue(s), PR).
 */
export async function updateNotionField(
  pageId: string,
  field: string,
  value: string,
  apiKey: string,
): Promise<void> {
  const res = await fetch(`${NOTION_API_BASE}/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    headers: notionHeaders(apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    body: JSON.stringify({
      properties: {
        [field]: { rich_text: [{ type: 'text', text: { content: value } }] },
      },
    }),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${res.statusText}`);
}

/**
 * Add a comment to a Notion page.
 */
export async function addNotionComment(pageId: string, text: string, apiKey: string): Promise<void> {
  const res = await fetch(`${NOTION_API_BASE}/comments`, {
    method: 'POST',
    headers: notionHeaders(apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: 'text', text: { content: text } }],
    }),
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${res.statusText}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrations/notion.ts test/integrations/notion.test.ts
git commit -m "feat: add Notion client — blocks, status update, field update, comments"
```

---

### Task 5: Notion client — helper to parse page properties

**Files:**
- Modify: `src/integrations/notion.ts`
- Modify: `test/integrations/notion.test.ts`

The webhook handlers need to extract typed values from Notion's verbose property format. Add a helper.

- [ ] **Step 1: Write failing test**

Append to `test/integrations/notion.test.ts`:

```typescript
describe('parseNotionPageProperties', () => {
  it('extracts title, status, project, issues, and PR from page properties', async () => {
    const { parseNotionPageProperties } = await import('../../src/integrations/notion.js');
    const properties = {
      Name: { type: 'title', title: [{ plain_text: 'Fix login bug' }] },
      Status: { type: 'select', select: { name: 'Spec Issue' } },
      Project: { type: 'select', select: { name: 'CRM' } },
      'Issue(s)': { type: 'rich_text', rich_text: [{ plain_text: '42, 43' }] },
      PR: { type: 'rich_text', rich_text: [] },
    };
    const parsed = parseNotionPageProperties(properties);
    expect(parsed).toEqual({
      name: 'Fix login bug',
      status: 'Spec Issue',
      project: 'CRM',
      issues: '42, 43',
      pr: '',
    });
  });

  it('handles missing/null select values', async () => {
    const { parseNotionPageProperties } = await import('../../src/integrations/notion.js');
    const properties = {
      Name: { type: 'title', title: [] },
      Status: { type: 'select', select: null },
      Project: { type: 'select', select: null },
      'Issue(s)': { type: 'rich_text', rich_text: [] },
      PR: { type: 'rich_text', rich_text: [] },
    };
    const parsed = parseNotionPageProperties(properties);
    expect(parsed).toEqual({ name: '', status: '', project: '', issues: '', pr: '' });
  });
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: FAIL — `parseNotionPageProperties` is not exported

- [ ] **Step 3: Implement parseNotionPageProperties**

Append to `src/integrations/notion.ts`:

```typescript
/** Parsed properties from a Notion "Codeman Board" page. */
export interface NotionBoardPageProps {
  name: string;
  status: string;
  project: string;
  issues: string;
  pr: string;
}

/**
 * Extract typed values from Notion's verbose property format.
 */
export function parseNotionPageProperties(properties: Record<string, unknown>): NotionBoardPageProps {
  const p = properties as Record<string, {
    type: string;
    title?: Array<{ plain_text: string }>;
    select?: { name: string } | null;
    rich_text?: Array<{ plain_text: string }>;
  }>;

  const titleArr = p.Name?.title ?? [];
  const issuesArr = p['Issue(s)']?.rich_text ?? [];
  const prArr = p.PR?.rich_text ?? [];

  return {
    name: titleArr.map((t) => t.plain_text).join('') || '',
    status: p.Status?.select?.name ?? '',
    project: p.Project?.select?.name ?? '',
    issues: issuesArr.map((t) => t.plain_text).join('') || '',
    pr: prArr.map((t) => t.plain_text).join('') || '',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integrations/notion.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrations/notion.ts test/integrations/notion.test.ts
git commit -m "feat: add parseNotionPageProperties helper"
```

---

### Task 6: Webhook route — endpoint + handleSendToCodeman

**Files:**
- Create: `src/web/routes/notion-webhook-routes.ts`
- Create: `test/routes/notion-webhook-routes.test.ts`

Start with `handleSendToCodeman` since it's simpler (no AI session needed).

- [ ] **Step 1: Write failing tests**

Create `test/routes/notion-webhook-routes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the work-items store
vi.mock('../../src/work-items/store.js', () => ({
  createWorkItem: vi.fn(() => ({
    id: 'wi-test123',
    title: 'Test Task',
    status: 'queued',
    source: 'notion',
  })),
}));

// Mock the notion client
vi.mock('../../src/integrations/notion.js', () => ({
  loadNotionConfig: vi.fn(),
  fetchNotionPage: vi.fn(),
  fetchPageBlocks: vi.fn(),
  updateNotionStatus: vi.fn(),
  updateNotionField: vi.fn(),
  parseNotionPageProperties: vi.fn(),
}));

import { createWorkItem } from '../../src/work-items/store.js';
import {
  loadNotionConfig,
  fetchNotionPage,
  fetchPageBlocks,
  updateNotionStatus,
  parseNotionPageProperties,
} from '../../src/integrations/notion.js';
import { handleSendToCodeman } from '../../src/web/routes/notion-webhook-routes.js';

const mockLoadNotionConfig = vi.mocked(loadNotionConfig);
const mockFetchNotionPage = vi.mocked(fetchNotionPage);
const mockUpdateNotionStatus = vi.mocked(updateNotionStatus);
const mockParseNotionPageProperties = vi.mocked(parseNotionPageProperties);
const mockCreateWorkItem = vi.mocked(createWorkItem);

describe('handleSendToCodeman', () => {
  beforeEach(() => {
    mockLoadNotionConfig.mockReturnValue({
      apiKey: 'ntn_test',
      databaseId: 'db-123',
      dataSourceId: 'ds-456',
      webhookSecret: 'secret',
      projectMapping: {
        CRM: { giteaRepo: 'mauri/presshero-crm', caseId: 'presshero-crm' },
      },
    });
    mockFetchNotionPage.mockResolvedValue({
      id: 'page-abc',
      url: 'https://www.notion.so/page-abc',
      properties: {},
    });
    mockParseNotionPageProperties.mockReturnValue({
      name: 'Fix login bug',
      status: 'Send to Codeman',
      project: 'CRM',
      issues: '42, 43',
      pr: '',
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a work item with correct fields', async () => {
    await handleSendToCodeman('page-abc');

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Fix login bug',
        source: 'notion',
        caseId: 'presshero-crm',
        externalRef: 'page-abc',
        externalUrl: 'https://www.notion.so/page-abc',
      }),
    );
  });

  it('updates Notion status to In Progress', async () => {
    await handleSendToCodeman('page-abc');

    expect(mockUpdateNotionStatus).toHaveBeenCalledWith('page-abc', 'In Progress', 'ntn_test');
  });

  it('throws when project mapping is not found', async () => {
    mockParseNotionPageProperties.mockReturnValue({
      name: 'Unknown project task',
      status: 'Send to Codeman',
      project: 'UnknownProject',
      issues: '',
      pr: '',
    });

    await expect(handleSendToCodeman('page-abc')).rejects.toThrow('No project mapping');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/notion-webhook-routes.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the webhook route and handleSendToCodeman**

Create `src/web/routes/notion-webhook-routes.ts`:

```typescript
/**
 * @fileoverview Notion webhook routes for Codeman integration.
 *
 * Routes:
 *   POST /api/webhooks/notion — receive Notion automation webhooks
 *
 * Handlers:
 *   handleSpecIssue(pageId) — create a spec-writing work item
 *   handleSendToCodeman(pageId) — create a coding work item
 */

import { FastifyInstance } from 'fastify';
import {
  loadNotionConfig,
  fetchNotionPage,
  fetchPageBlocks,
  updateNotionStatus,
  updateNotionField,
  parseNotionPageProperties,
} from '../../integrations/notion.js';
import { createWorkItem, updateWorkItem } from '../../work-items/store.js';
import type { NotionConfig } from '../../integrations/types.js';

/**
 * Handle "Send to Codeman" status — create a regular work item for the orchestrator.
 */
export async function handleSendToCodeman(pageId: string): Promise<void> {
  const config = loadNotionConfig();
  if (!config) throw new Error('Notion config not found');

  const page = await fetchNotionPage(pageId, config.apiKey);
  const props = parseNotionPageProperties(
    (page as { properties: Record<string, unknown> }).properties,
  );

  const mapping = config.projectMapping[props.project];
  if (!mapping) throw new Error(`No project mapping found for "${props.project}"`);

  const pageUrl = (page as { url?: string }).url ?? '';

  createWorkItem({
    title: props.name,
    description: `Notion task: ${props.name}\n\nIssue(s): ${props.issues || 'none'}\nProject: ${props.project}\nNotion: ${pageUrl}`,
    source: 'notion',
    caseId: mapping.caseId,
    externalRef: pageId,
    externalUrl: pageUrl,
    metadata: { notionPageId: pageId },
  });

  await updateNotionStatus(pageId, 'In Progress', config.apiKey);
  console.log(`[notion-webhook] Send to Codeman: created work item for "${props.name}"`);
}

/**
 * Handle "Spec Issue" status — create a short-lived AI work item to spec issues.
 * (Implemented in Task 7)
 */
export async function handleSpecIssue(pageId: string): Promise<void> {
  throw new Error('handleSpecIssue not yet implemented');
}

/**
 * Register the Notion webhook route.
 */
export function registerNotionWebhookRoutes(app: FastifyInstance): void {
  app.post('/api/webhooks/notion', async (req, reply) => {
    const config = loadNotionConfig();
    if (!config) {
      reply.code(503);
      return { success: false, error: 'Notion integration not configured' };
    }

    // Validate webhook secret
    const secret = req.headers['x-codeman-secret'] as string | undefined;
    if (secret !== config.webhookSecret) {
      reply.code(401);
      return { success: false, error: 'Invalid webhook secret' };
    }

    const body = req.body as { pageId?: string };
    if (!body.pageId) {
      reply.code(400);
      return { success: false, error: 'pageId is required' };
    }

    // Fetch the page to determine current status
    let page: Record<string, unknown>;
    try {
      page = await fetchNotionPage(body.pageId, config.apiKey);
    } catch (err) {
      reply.code(502);
      return { success: false, error: `Failed to fetch Notion page: ${err}` };
    }

    const props = parseNotionPageProperties(
      (page as { properties: Record<string, unknown> }).properties,
    );

    // Return 200 immediately, process async
    reply.code(200);
    const response = { success: true, status: props.status, pageId: body.pageId };

    // Fire-and-forget async processing
    (async () => {
      try {
        switch (props.status) {
          case 'Spec Issue':
            await handleSpecIssue(body.pageId!);
            break;
          case 'Send to Codeman':
            await handleSendToCodeman(body.pageId!);
            break;
          default:
            console.log(`[notion-webhook] Ignoring status "${props.status}" for ${body.pageId}`);
        }
      } catch (err) {
        console.error(`[notion-webhook] Handler failed for ${body.pageId}:`, err);
      }
    })();

    return response;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/notion-webhook-routes.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/notion-webhook-routes.ts test/routes/notion-webhook-routes.test.ts
git commit -m "feat: add Notion webhook route + handleSendToCodeman handler"
```

---

### Task 7: Implement handleSpecIssue

**Files:**
- Modify: `src/web/routes/notion-webhook-routes.ts`
- Modify: `test/routes/notion-webhook-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/routes/notion-webhook-routes.test.ts`:

```typescript
import { handleSpecIssue } from '../../src/web/routes/notion-webhook-routes.js';

const mockFetchPageBlocks = vi.mocked(fetchPageBlocks);

describe('handleSpecIssue', () => {
  beforeEach(() => {
    mockLoadNotionConfig.mockReturnValue({
      apiKey: 'ntn_test',
      databaseId: 'db-123',
      dataSourceId: 'ds-456',
      webhookSecret: 'secret',
      projectMapping: {
        CRM: { giteaRepo: 'mauri/presshero-crm', caseId: 'presshero-crm' },
      },
    });
    mockFetchNotionPage.mockResolvedValue({
      id: 'page-spec',
      url: 'https://www.notion.so/page-spec',
      properties: {},
    });
    mockParseNotionPageProperties.mockReturnValue({
      name: 'Add user search',
      status: 'Spec Issue',
      project: 'CRM',
      issues: '10',
      pr: '',
    });
    mockFetchPageBlocks.mockResolvedValue('We need a search bar that filters users by name.');
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a spec work item with notionAction in metadata', async () => {
    await handleSpecIssue('page-spec');

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Spec: Add user search',
        source: 'notion',
        caseId: 'presshero-crm',
        metadata: expect.objectContaining({
          notionPageId: 'page-spec',
          notionAction: 'spec-issue',
          giteaRepo: 'mauri/presshero-crm',
          existingIssues: '10',
        }),
      }),
    );
  });

  it('includes loose notes in the work item description', async () => {
    await handleSpecIssue('page-spec');

    const callArgs = mockCreateWorkItem.mock.calls[0][0];
    expect(callArgs.description).toContain('We need a search bar that filters users by name.');
  });

  it('does NOT update Notion status (that happens on session completion)', async () => {
    await handleSpecIssue('page-spec');

    expect(mockUpdateNotionStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/notion-webhook-routes.test.ts`
Expected: FAIL — `handleSpecIssue` throws "not yet implemented"

- [ ] **Step 3: Implement handleSpecIssue**

In `src/web/routes/notion-webhook-routes.ts`, replace the placeholder `handleSpecIssue`:

```typescript
/**
 * Handle "Spec Issue" status — create a short-lived AI work item.
 *
 * The orchestrator dispatches this as a Claude Code session whose prompt
 * instructs it to read the notes, create/update Gitea issues, then exit.
 * The completion callback (in orchestrator.ts) updates Notion afterward.
 */
export async function handleSpecIssue(pageId: string): Promise<void> {
  const config = loadNotionConfig();
  if (!config) throw new Error('Notion config not found');

  const page = await fetchNotionPage(pageId, config.apiKey);
  const props = parseNotionPageProperties(
    (page as { properties: Record<string, unknown> }).properties,
  );

  const mapping = config.projectMapping[props.project];
  if (!mapping) throw new Error(`No project mapping found for "${props.project}"`);

  const looseNotes = await fetchPageBlocks(pageId, config.apiKey);

  const description = [
    `## Spec Issue Task`,
    ``,
    `Read the following notes and create or update Gitea issue(s) in the repo \`${mapping.giteaRepo}\`.`,
    `Use the Gitea MCP tools (mcp__gitea__issue_write) to create/update issues.`,
    ``,
    `### Notion Record: ${props.name}`,
    ``,
    `**Existing issue(s):** ${props.issues || 'none'}`,
    `**Project:** ${props.project}`,
    `**Gitea repo:** ${mapping.giteaRepo}`,
    ``,
    `### Notes`,
    ``,
    looseNotes || '(no notes provided)',
    ``,
    `### Instructions`,
    ``,
    `1. Read the notes above and any referenced issues in the Gitea repo`,
    `2. Read relevant parts of the codebase to understand the context`,
    `3. Create a well-structured Gitea issue (or update existing ones if issue numbers are provided)`,
    `4. The issue should have: clear title, description, acceptance criteria, and relevant labels`,
    `5. After creating/updating the issue(s), update this work item's metadata with the issue numbers by running:`,
    '   ```',
    `   curl -s -X PATCH http://localhost:3000/api/work-items/WORK_ITEM_ID \\`,
    `     -H "Content-Type: application/json" \\`,
    `     -d '{"metadata": {"createdIssues": "COMMA_SEPARATED_ISSUE_NUMBERS"}}'`,
    '   ```',
    `   Replace WORK_ITEM_ID with the ID shown above and COMMA_SEPARATED_ISSUE_NUMBERS with the created issue numbers (e.g., "42, 43").`,
    `6. Output a summary of what you created and exit`,
  ].join('\n');

  const workItem = createWorkItem({
    title: `Spec: ${props.name}`,
    description: '', // placeholder — replaced below with work item ID injected
    source: 'notion',
    caseId: mapping.caseId,
    externalRef: pageId,
    externalUrl: (page as { url?: string }).url ?? '',
    metadata: {
      notionPageId: pageId,
      notionAction: 'spec-issue',
      giteaRepo: mapping.giteaRepo,
      existingIssues: props.issues,
    },
  });

  // Now inject the work item ID into the description so the session can update metadata
  const fullDescription = description.replace('WORK_ITEM_ID', workItem.id);
  updateWorkItem(workItem.id, { description: fullDescription });

  console.log(`[notion-webhook] Spec Issue: created spec work item ${workItem.id} for "${props.name}"`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/notion-webhook-routes.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/notion-webhook-routes.ts test/routes/notion-webhook-routes.test.ts
git commit -m "feat: implement handleSpecIssue — creates spec work item from Notion notes"
```

---

### Task 8: Register webhook routes in server

**Files:**
- Modify: `src/web/routes/index.ts:32`
- Modify: `src/web/server.ts:100-129` (imports) and `src/web/server.ts:783-786` (registration)

- [ ] **Step 1: Add export to routes/index.ts**

In `src/web/routes/index.ts`, add after line 32 (after the last existing export):

```typescript
export { registerNotionWebhookRoutes } from './notion-webhook-routes.js';
```

- [ ] **Step 2: Add import in server.ts**

In `src/web/server.ts`, add `registerNotionWebhookRoutes` to the import block from `'./routes/index.js'` (around line 100-129). Add it after `registerFeatureUsageRoutes`:

```typescript
  registerFeatureUsageRoutes,
  registerNotionWebhookRoutes,
} from './routes/index.js';
```

- [ ] **Step 3: Register routes in server.ts**

In `src/web/server.ts`, add after `registerFeatureUsageRoutes(this.app);` (around line 786):

```typescript
    registerNotionWebhookRoutes(this.app);
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (including the new Notion tests)

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/index.ts src/web/server.ts
git commit -m "feat: register Notion webhook routes in server"
```

---

### Task 9: Orchestrator completion callbacks for Notion

**Files:**
- Modify: `src/orchestrator.ts:804-870` (handleCompletionFlow)
- Modify: `src/orchestrator.ts:710-743` (handleSessionCompletion)
- Create: `test/notion-completion-callbacks.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/notion-completion-callbacks.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock notion client
vi.mock('../src/integrations/notion.js', () => ({
  loadNotionConfig: vi.fn(),
  updateNotionStatus: vi.fn(),
  updateNotionField: vi.fn(),
  addNotionComment: vi.fn(),
}));

import {
  loadNotionConfig,
  updateNotionStatus,
  updateNotionField,
  addNotionComment,
} from '../src/integrations/notion.js';
import { notionCompletionCallback } from '../src/orchestrator.js';

const mockLoadConfig = vi.mocked(loadNotionConfig);
const mockUpdateStatus = vi.mocked(updateNotionStatus);
const mockUpdateField = vi.mocked(updateNotionField);
const mockAddComment = vi.mocked(addNotionComment);

describe('notionCompletionCallback', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      apiKey: 'ntn_test',
      databaseId: 'db-123',
      dataSourceId: 'ds-456',
      webhookSecret: 'secret',
      projectMapping: {},
    });
    mockUpdateStatus.mockResolvedValue(undefined);
    mockUpdateField.mockResolvedValue(undefined);
    mockAddComment.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('does nothing for non-notion work items', async () => {
    await notionCompletionCallback({
      id: 'wi-test',
      source: 'manual',
      status: 'review',
      metadata: {},
    } as any);

    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('updates Notion to Review PR when status is review', async () => {
    await notionCompletionCallback({
      id: 'wi-test',
      source: 'notion',
      status: 'review',
      metadata: { notionPageId: 'page-abc' },
    } as any);

    expect(mockUpdateStatus).toHaveBeenCalledWith('page-abc', 'Review PR', 'ntn_test');
  });

  it('updates Notion to Done with PR and comment when status is done', async () => {
    await notionCompletionCallback({
      id: 'wi-test',
      source: 'notion',
      status: 'done',
      branchName: 'feat/fix-login',
      compactSummary: 'Fixed the login flow by adding session validation.',
      metadata: {
        notionPageId: 'page-abc',
        mergePrepResult: { passed: true, commitsAhead: 3 },
      },
    } as any);

    expect(mockUpdateStatus).toHaveBeenCalledWith('page-abc', 'Done', 'ntn_test');
    expect(mockUpdateField).toHaveBeenCalledWith(
      'page-abc', 'PR', expect.stringContaining('feat/fix-login'), 'ntn_test',
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      'page-abc', expect.stringContaining('Fixed the login flow'), 'ntn_test',
    );
  });

  it('updates Notion to Review Issue for spec-issue actions on review', async () => {
    await notionCompletionCallback({
      id: 'wi-test',
      source: 'notion',
      status: 'review',
      metadata: { notionPageId: 'page-abc', notionAction: 'spec-issue' },
    } as any);

    expect(mockUpdateStatus).toHaveBeenCalledWith('page-abc', 'Review Issue', 'ntn_test');
  });

  it('updates Notion Issue(s) field when spec-issue has createdIssues in metadata', async () => {
    await notionCompletionCallback({
      id: 'wi-test',
      source: 'notion',
      status: 'review',
      metadata: { notionPageId: 'page-abc', notionAction: 'spec-issue', createdIssues: '#55, #56' },
    } as any);

    expect(mockUpdateField).toHaveBeenCalledWith('page-abc', 'Issue(s)', '#55, #56', 'ntn_test');
    expect(mockUpdateStatus).toHaveBeenCalledWith('page-abc', 'Review Issue', 'ntn_test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/notion-completion-callbacks.test.ts`
Expected: FAIL — `notionCompletionCallback` is not exported from `orchestrator.js`

- [ ] **Step 3: Implement notionCompletionCallback**

In `src/orchestrator.ts`, add the following import near the top (with the other imports):

```typescript
import {
  loadNotionConfig,
  updateNotionStatus,
  updateNotionField,
  addNotionComment,
} from './integrations/notion.js';
```

Then add this exported function before the `Orchestrator` class (or after the class — it's a standalone function):

```typescript
/**
 * Handle Notion status updates when a work item with source 'notion' transitions.
 * Called from handleCompletionFlow() and from the PATCH /api/work-items/:id route.
 */
export async function notionCompletionCallback(item: WorkItem): Promise<void> {
  if (item.source !== 'notion') return;

  const notionPageId = (item.metadata as Record<string, unknown>)?.notionPageId as string | undefined;
  if (!notionPageId) return;

  const config = loadNotionConfig();
  if (!config) {
    console.warn('[orchestrator] Notion config not found — skipping Notion callback');
    return;
  }

  const notionAction = (item.metadata as Record<string, unknown>)?.notionAction as string | undefined;

  if (item.status === 'review') {
    if (notionAction === 'spec-issue') {
      // Spec session completed — update Issue(s) field if the session stored created issues
      const createdIssues = (item.metadata as Record<string, unknown>)?.createdIssues as string | undefined;
      if (createdIssues) {
        await updateNotionField(notionPageId, 'Issue(s)', createdIssues, config.apiKey);
      }
      // Advance to Review Issue
      await updateNotionStatus(notionPageId, 'Review Issue', config.apiKey);
      console.log(`[orchestrator] Notion: ${notionPageId} → Review Issue (spec-issue completed)`);
    } else {
      // Normal coding session completed — advance to Review PR
      await updateNotionStatus(notionPageId, 'Review PR', config.apiKey);
      console.log(`[orchestrator] Notion: ${notionPageId} → Review PR`);
    }
  } else if (item.status === 'done') {
    // Final completion — update Notion with PR refs and summary comment
    await updateNotionStatus(notionPageId, 'Done', config.apiKey);

    // Populate PR field
    const prInfo = item.branchName || '';
    if (prInfo) {
      await updateNotionField(notionPageId, 'PR', prInfo, config.apiKey);
    }

    // Build and post completion comment
    const commentParts: string[] = [];
    if (item.compactSummary) commentParts.push(item.compactSummary);

    const meta = item.metadata as Record<string, unknown>;
    const sessionSummary = meta?.sessionSummary as string | undefined;
    if (sessionSummary) commentParts.push(sessionSummary);

    const mergePrepResult = meta?.mergePrepResult as {
      passed?: boolean;
      commitsAhead?: number;
      failures?: string[];
    } | undefined;
    if (mergePrepResult) {
      const status = mergePrepResult.passed ? 'PASSED' : `FAILED (${(mergePrepResult.failures ?? []).join(', ')})`;
      commentParts.push(`Merge-prep: ${status}, ${mergePrepResult.commitsAhead ?? 0} commits`);
    }

    if (item.branchName) commentParts.push(`Branch: ${item.branchName}`);

    if (commentParts.length > 0) {
      await addNotionComment(notionPageId, commentParts.join('\n\n'), config.apiKey);
    }

    console.log(`[orchestrator] Notion: ${notionPageId} → Done`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/notion-completion-callbacks.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/notion-completion-callbacks.test.ts
git commit -m "feat: add notionCompletionCallback for work item status transitions"
```

---

### Task 10: Wire notionCompletionCallback into orchestrator and work-item routes

**Files:**
- Modify: `src/orchestrator.ts:804-870` (handleCompletionFlow)
- Modify: `src/orchestrator.ts:710-743` (handleSessionCompletion — for spec-issue auto-done)
- Modify: `src/web/routes/work-item-routes.ts:143-156` (PATCH done handler)

- [ ] **Step 1: Add Notion callback to handleCompletionFlow**

In `src/orchestrator.ts`, in the `handleCompletionFlow` method, add the Notion callback after the push notification (after line 867, before the final console.log):

```typescript
    // Notify Notion if this is a Notion-sourced work item
    const freshItem = getWorkItem(workItemId);
    if (freshItem) {
      notionCompletionCallback(freshItem).catch((err) => {
        console.error(`[orchestrator] Notion callback failed for ${workItemId}:`, getErrorMessage(err));
      });
    }
```

- [ ] **Step 2: Handle spec-issue auto-done in handleSessionCompletion**

In `src/orchestrator.ts`, in `handleSessionCompletion`, after the `if (hasCommits)` block and the `else` block (around line 742), add a new block to handle spec-issue sessions that complete without commits:

```typescript
    // Spec-issue sessions don't produce commits — auto-complete them
    const notionAction = (item.metadata as Record<string, unknown>)?.notionAction;
    if (!hasCommits && notionAction === 'spec-issue') {
      updateWorkItem(item.id, { status: 'done' });
      this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'done' });
      console.log(`[orchestrator] ${item.id} → done (spec-issue session completed)`);
      notionCompletionCallback(getWorkItem(item.id)!).catch((err) => {
        console.error(`[orchestrator] Notion callback failed for ${item.id}:`, getErrorMessage(err));
      });
      return;
    }
```

Place this inside `handleSessionCompletion`, just before the existing `if (hasCommits)` check (after the commit detection logic), wrapping the existing logic:

```typescript
    // The full handleSessionCompletion should now look like:
    // ...commit detection...

    // Spec-issue sessions don't produce commits — auto-complete them
    const notionAction = (item.metadata as Record<string, unknown>)?.notionAction;
    if (!hasCommits && notionAction === 'spec-issue') {
      updateWorkItem(item.id, { status: 'done' });
      this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'done' });
      console.log(`[orchestrator] ${item.id} → done (spec-issue session completed)`);
      notionCompletionCallback(getWorkItem(item.id)!).catch((err) => {
        console.error(`[orchestrator] Notion callback failed for ${item.id}:`, getErrorMessage(err));
      });
      return;
    }

    if (hasCommits) {
      // ...existing code...
    }
```

- [ ] **Step 3: Add Notion callback to PATCH work-items done handler**

In `src/web/routes/work-item-routes.ts`, add the Notion callback import at the top:

```typescript
import { notionCompletionCallback } from '../../orchestrator.js';
```

Then in the `PATCH /api/work-items/:id` handler, after the existing `if (body.status === 'done')` block (around line 156), add:

```typescript
    // Trigger Notion callback for done transitions
    if (body.status === 'done' && updated.source === 'notion') {
      notionCompletionCallback(updated).catch((err: unknown) => {
        console.error('[work-item-routes] Notion callback failed:', err);
      });
    }
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts src/web/routes/work-item-routes.ts
git commit -m "feat: wire Notion callbacks into orchestrator completion flow and work-item routes"
```

---

### Task 11: Build, test on dev instance, and create config

**Files:**
- None (runtime setup)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Run typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 4: Create the Notion config file**

Create `~/.codeman/notion-config.json`:

```json
{
  "apiKey": "<REDACTED_NOTION_TOKEN>",
  "databaseId": "35e779a1-ce24-806d-b809-f5c4726e3dd0",
  "dataSourceId": "35e779a1-ce24-8066-bceb-000bb0ae46e9",
  "webhookSecret": "GENERATE_A_RANDOM_SECRET_HERE",
  "projectMapping": {
    "Website": { "giteaRepo": "mauri/presshero-website", "caseId": "presshero-website" },
    "PressHERO App": { "giteaRepo": "PressHERO/presshero-app", "caseId": "presshero-app" },
    "SportNetwork": { "giteaRepo": "mauri/SportNetwork-CMS", "caseId": "SportNetwork-CMS" },
    "CRM": { "giteaRepo": "mauri/presshero-crm", "caseId": "presshero-crm" },
    "Finance": { "giteaRepo": "mauri/presshero-finance", "caseId": "presshero-finance" }
  }
}
```

Replace `GENERATE_A_RANDOM_SECRET_HERE` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

- [ ] **Step 5: Deploy to dev instance and smoke test**

```bash
npm run build
rsync -a --delete dist/ ~/.codeman/app/dist/
```

Restart the dev instance on port 3001, then test the webhook endpoint:

```bash
curl -X POST http://localhost:3001/api/webhooks/notion \
  -H 'Content-Type: application/json' \
  -H 'X-Codeman-Secret: YOUR_SECRET' \
  -d '{"pageId": "35e779a1-ce24-8043-8b38-c5a208cfaab3"}'
```

Expected: 200 response. Check logs for the handler processing.

- [ ] **Step 6: Commit config documentation**

Add a note about the config file to the spec or CLAUDE.md. No config file itself committed (contains API key).

```bash
git add -A
git commit -m "docs: add Notion integration setup instructions"
```
