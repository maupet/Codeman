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
      'page-abc',
      'PR',
      expect.stringContaining('feat/fix-login'),
      'ntn_test'
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      'page-abc',
      expect.stringContaining('Fixed the login flow'),
      'ntn_test'
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
