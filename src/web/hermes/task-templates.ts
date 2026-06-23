export interface TaskSpec {
  title: string;
  description: string;
  acceptance?: string;
}

export const WORKTREE_CLAUDE_MD =
  'You are working autonomously in a Codeman worktree.\n' +
  'Before doing ANYTHING else, re-read `TASK.md` in this directory\n' +
  'and resume from the phase in `status`.\n' +
  'Do not rely on conversation history.\n' +
  'Then invoke the codeman-task-runner skill.\n';

export function renderTaskMd(kind: 'feature' | 'fix', spec: TaskSpec): string {
  const heading = kind === 'fix' ? 'Bug fix' : 'Feature';
  const acceptance = spec.acceptance?.trim() || 'See description.';
  return [
    `# ${spec.title}`,
    '',
    '## status',
    'phase: analysis',
    '',
    `## Type`,
    heading,
    '',
    '## Description',
    spec.description.trim(),
    '',
    '## Acceptance Criteria',
    acceptance,
    '',
    '## Workflow',
    'Invoke the codeman-task-runner skill and proceed through its phases.',
    '',
  ].join('\n');
}
