# Auth Expiry Circuit Breaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the PWA from hammering the server when the auth session expires, and prevent expired sessions from triggering the brute-force rate limiter.

**Architecture:** Two independent fixes. Server-side: only count auth failures when credentials are actually provided. Client-side: detect 401, stop all pollers, show a "session expired" overlay with re-auth button.

**Tech Stack:** TypeScript (Fastify middleware), vanilla JS (frontend)

**Spec:** `docs/superpowers/specs/2026-05-05-auth-expiry-circuit-breaker-design.md`

---

### Task 1: Server — Only count failures when credentials are provided

**Files:**
- Modify: `src/web/middleware/auth.ts:148-152`
- Test: `test/auth-security.test.ts`

- [ ] **Step 1: Write failing test — expired session without credentials does NOT count as failure**

Add this test to the `Rate Limiting` describe block in `test/auth-security.test.ts`. It needs its own server instance to avoid interference from the existing rate limit tests (which already burned through the failure counter).

```typescript
describe('Rate Limiting — credential-less requests', () => {
  let rlServer: WebServer;
  let rlBaseUrl: string;
  const RL_PORT = 3162;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    rlServer = new WebServer(RL_PORT, false, true);
    await rlServer.start();
    rlBaseUrl = `http://localhost:${RL_PORT}`;
  });

  afterAll(async () => {
    await rlServer.stop();
  });

  it('should NOT count requests without credentials toward rate limit', async () => {
    // Send 15 requests with no credentials (expired session scenario)
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${rlBaseUrl}/api/status`);
      // Should always be 401, never 429
      expect(res.status).toBe(401);
    }

    // After 15 credential-less failures, valid credentials should still work
    const res = await fetch(`${rlBaseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
  });

  it('should still count requests WITH wrong credentials toward rate limit', async () => {
    // Send 10 requests with wrong credentials
    for (let i = 0; i < 10; i++) {
      await fetch(`${rlBaseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-' + i) },
      });
    }

    // 11th attempt should be rate-limited
    const res = await fetch(`${rlBaseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-again') },
    });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/auth-security.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: The first new test FAILs — after 15 credential-less requests, the 16th gets 429 instead of 401.

- [ ] **Step 3: Fix auth middleware — only count failures when Authorization header is present**

In `src/web/middleware/auth.ts`, change lines 148-152 from:

```typescript
    // Auth failed — track failure count
    authFailures.set(clientIp, failures + 1);

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
```

to:

```typescript
    // Auth failed — only count toward rate limit when credentials were actually
    // provided (brute-force attempt). Expired-session requests (no Authorization
    // header) should not trigger rate limiting.
    if (auth) {
      authFailures.set(clientIp, failures + 1);
    }

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/auth-security.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS, including the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/auth.ts test/auth-security.test.ts
git commit -m "fix(auth): only count rate-limit failures when credentials are provided

Expired session cookies (no Authorization header) no longer increment
the per-IP failure counter. This prevents the 2s system-stats poller
from triggering a 15-minute IP ban when the session expires."
```

---

### Task 2: Client — Detect 401 and stop all pollers

**Files:**
- Modify: `src/web/public/api-client.js:23-36`
- Modify: `src/web/public/app.js` (add `_onAuthExpired()` method, guard in `_periodicSync`)

- [ ] **Step 1: Add 401 detection to `_api()` in api-client.js**

In `src/web/public/api-client.js`, replace the `_api` method (lines 23-36):

```javascript
  async _api(path, opts = {}) {
    const { method = 'GET', body, signal } = opts;
    // Short-circuit all API calls while auth is expired — no point
    // hitting the server when we know the session is gone.
    if (this.authExpired) return null;
    const fetchOpts = { method, signal };
    if (body !== undefined) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(path, fetchOpts);
      if (res.status === 401 && !this.authExpired) {
        this.authExpired = true;
        this._onAuthExpired();
      }
      return res;
    } catch {
      return null;
    }
  },
```

- [ ] **Step 2: Add auth-expired guard to `_periodicSync` in app.js**

The transcript sync `setInterval` at line 3099 doesn't store its interval ID, so we can't clear it. Instead, add an early return. In `src/web/public/app.js`, at the top of `_periodicSync()` (line 3104), add a guard:

Change:
```javascript
  _periodicSync() {
    if (!this._sessionId || !this._container) return;
```

to:
```javascript
  _periodicSync() {
    if (this.authExpired) return;
    if (!this._sessionId || !this._container) return;
```

- [ ] **Step 3: Add `_onAuthExpired()` method to CodemanApp in app.js**

Add this method after the `connectSSE()` method (after line 6576):

```javascript
  /**
   * Called when a 401 response is detected — session cookie has expired.
   * Stops all pollers to prevent request storms and shows a re-auth overlay.
   */
  _onAuthExpired() {
    // Stop SSE connection and prevent reconnect
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }

    // Stop system stats polling (2s interval)
    this.stopSystemStatsPolling();

    // Stop ActionDashboard polling (30s interval)
    if (typeof ActionDashboard !== 'undefined') ActionDashboard.stopPolling();

    this.setConnectionStatus('disconnected');

    // Show session-expired overlay
    this._showAuthExpiredOverlay();
  }

  _showAuthExpiredOverlay() {
    // Prevent duplicate overlays
    if (document.getElementById('authExpiredOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'authExpiredOverlay';
    overlay.className = 'auth-expired-overlay';
    overlay.innerHTML = `
      <div class="auth-expired-content">
        <div class="auth-expired-icon">&#x1f512;</div>
        <h2>Session Expired</h2>
        <p>Your authentication session has timed out.</p>
        <button class="auth-expired-btn" onclick="location.reload()">Re-authenticate</button>
      </div>
    `;
    document.body.appendChild(overlay);
  }
```

- [ ] **Step 4: Add CSS for the overlay in styles.css**

Add at the end of `src/web/public/styles.css`:

```css
/* Auth expired overlay — shown when session cookie times out */
.auth-expired-overlay {
  position: fixed;
  inset: 0;
  z-index: 100000;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.auth-expired-content {
  text-align: center;
  color: var(--text-primary);
  max-width: 320px;
  padding: 32px;
}

.auth-expired-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.auth-expired-content h2 {
  margin: 0 0 8px;
  font-size: 20px;
}

.auth-expired-content p {
  margin: 0 0 24px;
  color: var(--text-secondary);
  font-size: 14px;
}

.auth-expired-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px 24px;
  font-size: 14px;
  cursor: pointer;
  font-weight: 500;
}

.auth-expired-btn:hover {
  filter: brightness(1.1);
}
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/api-client.js src/web/public/app.js src/web/public/styles.css
git commit -m "fix(pwa): stop request storm on auth expiry — circuit breaker + overlay

When a 401 is detected, _api() sets authExpired flag and short-circuits
all subsequent calls. _onAuthExpired() stops SSE, system stats (2s),
transcript sync (30s), and ActionDashboard (30s) pollers. A full-screen
overlay prompts the user to re-authenticate via page reload."
```

---

### Task 3: Build, deploy to dev, manual verification

**Files:** None (deployment + manual test)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build with no errors.

- [ ] **Step 2: Deploy to dev instance**

Run: `rsync -a --delete dist/ ~/.codeman/app/dist/`
Then restart the dev process on port 3001.

- [ ] **Step 3: Manual test — verify overlay appears on auth expiry**

1. Open dev instance (port 3001) in browser
2. Log in with credentials
3. Open browser DevTools → Application → Cookies → delete the `codeman_session` cookie
4. Wait a few seconds (system stats poller will fire)
5. Verify: "Session Expired" overlay appears
6. Verify: Network tab shows requests STOP after the first 401
7. Click "Re-authenticate" → browser shows Basic Auth dialog → log in → page reloads fresh

- [ ] **Step 4: Manual test — verify rate limit not triggered**

1. Repeat step 3 but check server logs: no 429 responses should appear
2. After re-authenticating, verify all functionality works normally
