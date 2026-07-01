import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  loadNotionConfig,
  fetchNotionPage,
  fetchPageBlocks,
  updateNotionStatus,
  updateNotionField,
  addNotionComment,
  parseNotionPageProperties,
} from '../../src/integrations/notion.js';

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
      })
    );
  });

  it('throws on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchNotionPage('bad-id', 'ntn_test')).rejects.toThrow('Notion API 404');
  });
});

describe('fetchPageBlocks', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches block children and extracts plain text', async () => {
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
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await updateNotionStatus('page-123', 'Review Issue', 'ntn_test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          properties: { Status: { select: { name: 'Review Issue' } } },
        }),
      })
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
      })
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
      })
    );
  });
});

describe('parseNotionPageProperties', () => {
  it('extracts title, status, project, issues, and PR from page properties', () => {
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

  it('handles missing/null select values', () => {
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
