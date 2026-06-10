import type { SessionState } from '../types/session.js';

/**
 * Decides whether a restored session should be automatically resumed
 * (claude process re-spawned) when the server restarts.
 *
 * Returning false leaves the session restored (visible in the UI) but
 * inactive until the user clicks into it.
 */
export function shouldAutoResumeSession(state: Pick<SessionState, 'status' | 'mode' | 'claudeResumeId'>): boolean {
  if (!state.claudeResumeId) return false;
  if (state.mode === 'opencode') return false;
  return state.status === 'busy';
}
