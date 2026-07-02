/**
 * @fileoverview Tests for CLI info parsing — model detection specifically.
 *
 * Bugs in src/session.ts parseClaudeCodeInfo() (as of writing):
 *  (a) The Fable model is not in the pattern list, so banners like "Fable 5 · Claude Max"
 *      are never detected.
 *  (b) Once parsed successfully (any pattern), the parser locks itself via `_cliInfoParsed`
 *      and refuses to update the model. Since `/model X` in Claude Code redraws the banner,
 *      subsequent switches never propagate to Codeman's UI.
 *
 * Pattern: mirrors context-model-redesign.test.ts — a standalone mini-implementation
 * of parseClaudeCodeInfo() so tests can run without PTY/tmux. Keep in sync with
 * src/session.ts parseClaudeCodeInfo().
 */

import { describe, it, expect } from 'vitest';

interface CliInfoState {
  cliVersion: string;
  cliModel: string;
  cliAccountType: string;
  cliLatestVersion: string;
}

interface CliInfoUpdate {
  version: string | null;
  model: string | null;
  accountType: string | null;
  latestVersion: string | null;
}

interface ParseResult {
  changed: boolean;
  emitted?: CliInfoUpdate;
}

/**
 * Mirror of src/session.ts parseClaudeCodeInfo() — MUST stay in sync with the real impl.
 */
function parseClaudeCodeInfo(state: CliInfoState, cleanData: string): ParseResult {
  if (
    !cleanData.includes('Claude') &&
    !cleanData.includes('current:') &&
    !cleanData.includes('Fable') &&
    !cleanData.includes('Opus') &&
    !cleanData.includes('Sonnet') &&
    !cleanData.includes('Haiku')
  ) {
    return { changed: false };
  }

  let changed = false;

  if (!state.cliVersion) {
    const m = cleanData.match(/Claude Code v(\d+\.\d+\.\d+)/);
    if (m) {
      state.cliVersion = m[1];
      changed = true;
    }
  }

  // Model + account. Model updates live on change (so `/model X` propagates to the UI);
  // account is one-time (doesn't change at runtime).
  const modelPatterns = [
    /(Fable \d+(?:\.\d+)?)[^·•\n]*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
    /(Opus \d+(?:\.\d+)?)[^·•\n]*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
    /(Sonnet \d+(?:\.\d+)?)[^·•\n]*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
    /(Haiku \d+(?:\.\d+)?)[^·•\n]*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
  ];

  for (const pattern of modelPatterns) {
    const m = cleanData.match(pattern);
    if (m) {
      const detectedModel = m[1].trim();
      const detectedAccount = m[2].trim();
      if (state.cliModel !== detectedModel) {
        state.cliModel = detectedModel;
        changed = true;
      }
      if (!state.cliAccountType) {
        state.cliAccountType = detectedAccount;
        changed = true;
      }
      break;
    }
  }

  if (!state.cliLatestVersion) {
    const m = cleanData.match(/latest:\s*(\d+\.\d+\.\d+)/);
    if (m) {
      state.cliLatestVersion = m[1];
      changed = true;
    }
  }

  if (changed) {
    return {
      changed: true,
      emitted: {
        version: state.cliVersion || null,
        model: state.cliModel || null,
        accountType: state.cliAccountType || null,
        latestVersion: state.cliLatestVersion || null,
      },
    };
  }
  return { changed: false };
}

function fresh(): CliInfoState {
  return {
    cliVersion: '',
    cliModel: '',
    cliAccountType: '',
    cliLatestVersion: '',
  };
}

describe('parseClaudeCodeInfo — banner detection', () => {
  it('detects Fable from banner', () => {
    const state = fresh();
    const r = parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nFable 5 · Claude Max\n~/some-dir');
    expect(r.changed).toBe(true);
    expect(state.cliModel).toBe('Fable 5');
    expect(state.cliAccountType).toBe('Claude Max');
    expect(state.cliVersion).toBe('2.1.170');
  });

  it('detects Opus from banner', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nOpus 4.8 · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Opus 4.8');
  });

  it('detects Sonnet from banner', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nSonnet 5 · API\n~/dir');
    expect(state.cliModel).toBe('Sonnet 5');
    expect(state.cliAccountType).toBe('API');
  });

  it('detects Haiku from banner', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nHaiku 4.5 · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Haiku 4.5');
  });
});

describe('parseClaudeCodeInfo — /model switches after initial parse', () => {
  it('updates cliModel when banner switches Fable → Opus', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nFable 5 · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Fable 5');
    const r = parseClaudeCodeInfo(state, 'Opus 4.8 · Claude Max\n~/dir');
    expect(r.changed).toBe(true);
    expect(state.cliModel).toBe('Opus 4.8');
  });

  it('updates cliModel when banner switches Haiku → Fable (reproduces the Codeman UI bug)', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nHaiku 4.5 · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Haiku 4.5');
    const r = parseClaudeCodeInfo(state, 'Fable 5 · Claude Max\n~/dir');
    expect(r.changed).toBe(true);
    expect(state.cliModel).toBe('Fable 5');
  });

  it('does not emit on unchanged model (idempotent when banner re-renders identically)', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nOpus 4.8 · Claude Max\n~/dir');
    const r2 = parseClaudeCodeInfo(state, 'Opus 4.8 · Claude Max\n~/dir');
    expect(r2.changed).toBe(false);
  });

  it('keeps version and accountType stable across switches (they parse once)', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nOpus 4.8 · Claude Max\n~/dir');
    parseClaudeCodeInfo(state, 'Fable 5 · Claude Max\n~/dir');
    expect(state.cliVersion).toBe('2.1.170');
    expect(state.cliAccountType).toBe('Claude Max');
  });
});

describe('parseClaudeCodeInfo — banner suffixes like "with high effort"', () => {
  it('detects Fable when banner has "with high effort" between version and separator', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nFable 5 with high effort · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Fable 5');
    expect(state.cliAccountType).toBe('Claude Max');
  });

  it('detects Opus with effort suffix', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nOpus 4.8 with high effort · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Opus 4.8');
  });

  it('detects Sonnet with effort suffix', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Claude Code v2.1.170\nSonnet 5 with medium effort · API\n~/dir');
    expect(state.cliModel).toBe('Sonnet 5');
    expect(state.cliAccountType).toBe('API');
  });

  it('captures just the model+version, discarding the effort suffix', () => {
    const state = fresh();
    parseClaudeCodeInfo(state, 'Haiku 4.5 with low effort · Claude Max\n~/dir');
    expect(state.cliModel).toBe('Haiku 4.5');
    // and NOT 'Haiku 4.5 with low effort'
  });
});

describe('parseClaudeCodeInfo — non-matching input', () => {
  it('returns unchanged for data with no CLI info hints', () => {
    const state = fresh();
    const r = parseClaudeCodeInfo(state, 'just some regular output without banners');
    expect(r.changed).toBe(false);
    expect(state.cliModel).toBe('');
    expect(state.cliVersion).toBe('');
  });
});
