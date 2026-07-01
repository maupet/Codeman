# Auth Expiry Circuit Breaker

**Date**: 2026-05-05
**Status**: Approved

## Problem

When the Codeman session cookie expires (24h TTL), the PWA continues polling the server. Every failed request increments the per-IP auth failure counter. The 2-second system stats poller alone burns through the 10-failure limit in ~20 seconds, triggering a 15-minute IP ban (429). During that ban, even legitimate login attempts are blocked.

**Cascade**: Cookie expires → 2s poller hits 401 → 10 failures in 20s → IP rate-limited for 15 minutes → user locked out.

## Root Cause

Two compounding issues:

1. **Server**: `auth.ts` increments `authFailures` on every failed request, including requests with no credentials at all (expired cookie, no `Authorization` header). It doesn't distinguish "expired session" from "wrong password."

2. **Client**: No poller detects 401 responses. System stats (2s), transcript sync (30s), SSE reconnect (exponential, 10 attempts), and ActionDashboard (30s) all keep firing into the void.

## Design

### Server: Smart failure counting

In `auth.ts`, only increment `authFailures` when an `Authorization` header was actually present (someone sent wrong credentials). Requests with no credentials (expired cookie, no auth header) return 401 but do not count as a failure.

This is a ~3-line change: move the `authFailures.set()` call inside a conditional that checks `auth` is truthy.

### Client: Auth-expired circuit breaker

**Detection**: In `_api()` (`api-client.js`), check for 401 responses. Set `this.authExpired = true` and call `_onAuthExpired()`. All subsequent `_api()` calls short-circuit to `null` while the flag is set.

**Stop all pollers** via `_onAuthExpired()`:
- System stats interval (2s) — `stopSystemStatsPolling()`
- Transcript periodic sync (30s) — clear the interval
- SSE connection — `eventSource.close()` + clear reconnect timeout
- ActionDashboard poll (30s) — `stopPolling()`

**Overlay**: Full-screen overlay with "Session expired" message and a "Re-authenticate" button. Button calls `location.reload()`, triggering the browser's native Basic Auth dialog. On successful auth, the page loads fresh with a new session cookie and all pollers restart naturally.

**No resume logic needed**: `location.reload()` resets all state. No need to track which pollers to restart or clear the `authExpired` flag.

## Files to modify

- `src/web/middleware/auth.ts` — conditional failure counting
- `src/web/public/api-client.js` — 401 detection, short-circuit
- `src/web/public/app.js` — `_onAuthExpired()` method, overlay rendering, poller teardown

## Testing

- Unit test: auth middleware does NOT increment failures when no `Authorization` header is present
- Unit test: auth middleware DOES increment failures when wrong `Authorization` header is present
- Manual: let session expire, verify overlay appears, no request storm, re-auth works
