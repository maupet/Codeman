import { describe, it, expect } from 'vitest';
import { shouldAutoResumeSession } from '../src/server/should-auto-resume.js';

describe('shouldAutoResumeSession', () => {
  it('resumes a busy claude session with a resume id', () => {
    expect(
      shouldAutoResumeSession({
        status: 'busy',
        mode: 'claude',
        claudeResumeId: 'abc',
      })
    ).toBe(true);
  });

  it('does NOT resume an idle session (lazy-resume on user click)', () => {
    expect(
      shouldAutoResumeSession({
        status: 'idle',
        mode: 'claude',
        claudeResumeId: 'abc',
      })
    ).toBe(false);
  });

  it('does not resume stopped sessions', () => {
    expect(
      shouldAutoResumeSession({
        status: 'stopped',
        mode: 'claude',
        claudeResumeId: 'abc',
      })
    ).toBe(false);
  });

  it('does not resume when claudeResumeId is missing', () => {
    expect(shouldAutoResumeSession({ status: 'busy', mode: 'claude' })).toBe(false);
  });

  it('does not resume opencode sessions', () => {
    expect(
      shouldAutoResumeSession({
        status: 'busy',
        mode: 'opencode',
        claudeResumeId: 'abc',
      })
    ).toBe(false);
  });
});
