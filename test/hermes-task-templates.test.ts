import { describe, it, expect } from 'vitest';
import { renderTaskMd, WORKTREE_CLAUDE_MD } from '../src/web/hermes/task-templates.js';

describe('renderTaskMd', () => {
  it('includes title, phase, description, and the runner instruction', () => {
    const md = renderTaskMd('feature', { title: 'Dark mode', description: 'Add a toggle.' });
    expect(md).toContain('# Dark mode');
    expect(md).toMatch(/## status\nphase: analysis/);
    expect(md).toContain('Add a toggle.');
    expect(md).toContain('codeman-task-runner');
  });
  it('renders acceptance when provided, else a placeholder line', () => {
    expect(renderTaskMd('feature', { title: 'T', description: 'D', acceptance: 'Must do X' })).toContain('Must do X');
    expect(renderTaskMd('fix', { title: 'T', description: 'D' })).toContain('See description.');
  });
  it('labels fixes as a bug fix', () => {
    expect(renderTaskMd('fix', { title: 'T', description: 'D' }).toLowerCase()).toContain('fix');
  });
});

describe('WORKTREE_CLAUDE_MD', () => {
  it('tells the worktree Claude to read TASK.md and run the task-runner skill', () => {
    expect(WORKTREE_CLAUDE_MD).toContain('TASK.md');
    expect(WORKTREE_CLAUDE_MD).toContain('codeman-task-runner');
  });
});
