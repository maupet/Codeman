import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the work-items store
vi.mock('../../src/work-items/store.js', () => ({
  createWorkItem: vi.fn(() => ({
    id: 'wi-test123',
    title: 'Test Task',
    status: 'queued',
    source: 'notion',
  })),
  updateWorkItem: vi.fn(),
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

import { createWorkItem, updateWorkItem } from '../../src/work-items/store.js';
import {
  loadNotionConfig,
  fetchNotionPage,
  fetchPageBlocks,
  updateNotionStatus,
  parseNotionPageProperties,
} from '../../src/integrations/notion.js';
import { handleSendToCodeman, handleSpecIssue } from '../../src/web/routes/notion-webhook-routes.js';

const mockLoadNotionConfig = vi.mocked(loadNotionConfig);
const mockFetchNotionPage = vi.mocked(fetchNotionPage);
const mockFetchPageBlocks = vi.mocked(fetchPageBlocks);
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
      })
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
      })
    );
  });

  it('includes loose notes in the work item description', async () => {
    await handleSpecIssue('page-spec');

    // The description is set via updateWorkItem (second call after createWorkItem)
    const updateCalls = vi.mocked(updateWorkItem).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const descriptionUpdate = updateCalls[0][1];
    expect((descriptionUpdate as any).description).toContain('We need a search bar that filters users by name.');
  });

  it('does NOT update Notion status (that happens on session completion)', async () => {
    await handleSpecIssue('page-spec');

    expect(mockUpdateNotionStatus).not.toHaveBeenCalled();
  });
});
