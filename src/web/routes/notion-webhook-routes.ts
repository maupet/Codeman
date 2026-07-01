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
  parseNotionPageProperties,
} from '../../integrations/notion.js';
import { createWorkItem, updateWorkItem } from '../../work-items/store.js';

/**
 * Handle "Send to Codeman" status — create a regular work item for the orchestrator.
 */
export async function handleSendToCodeman(pageId: string): Promise<void> {
  const config = loadNotionConfig();
  if (!config) throw new Error('Notion config not found');

  const page = await fetchNotionPage(pageId, config.apiKey);
  const props = parseNotionPageProperties((page as { properties: Record<string, unknown> }).properties);

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
  const props = parseNotionPageProperties((page as { properties: Record<string, unknown> }).properties);

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

    const props = parseNotionPageProperties((page as { properties: Record<string, unknown> }).properties);

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
