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

/**
 * Fetch page body blocks and return as plain text (one line per block).
 */
export async function fetchPageBlocks(pageId: string, apiKey: string): Promise<string> {
  const res = await fetch(`${NOTION_API_BASE}/blocks/${encodeURIComponent(pageId)}/children?page_size=100`, {
    headers: notionHeaders(apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
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
export async function updateNotionField(pageId: string, field: string, value: string, apiKey: string): Promise<void> {
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
  const p = properties as Record<
    string,
    {
      type: string;
      title?: Array<{ plain_text: string }>;
      select?: { name: string } | null;
      rich_text?: Array<{ plain_text: string }>;
    }
  >;

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
