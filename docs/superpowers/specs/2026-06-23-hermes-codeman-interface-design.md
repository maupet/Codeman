# Hermes ↔ Codeman Interface — Design

**Date:** 2026-06-23
**Status:** Revised after adversarial review (codex + line-level verification), pending implementation plan

## Problem

Hermes (an external OpenClaw-style agent) needs to interact with Codeman: see
the status of running sessions, spin up new work in any project, and nudge
running sessions. Hermes knows nothing about Claude, Codeman's skills, or the
internal `TASK.md`/worktree workflow — and it should not have to. The interface
must keep Codeman's "how" (skills, worktree orchestration) hidden behind a small
catalog of "what" operations.

## Key finding that shapes the design

Codeman already exposes the needed substrate:

- A REST API (~150 endpoints) covering sessions, worktrees, subagents, input,
  and an SSE event stream (`/api/events`).
- A stdio MCP server (`src/mcp-server.ts`) that today wraps two of those
  endpoints as MCP tools (`list_sessions`, `send_message`).

So this is not a greenfield "build an interface" project. It is: **add a thin
high-level layer on top of the existing REST API, and expose it through the
existing MCP server.**

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Connection model | MCP as the agent-facing layer, REST as the substrate (future-proofs raw-HTTP callers too) |
| Where Hermes runs | Same machine, same trust boundary → no new transport (stdio MCP, `localhost:3001`). **But not "no auth"** — see Auth below; the facade forwards Basic Auth from env so it keeps working once `CODEMAN_PASSWORD` is set |
| Tool altitude | **High-level** — tools encapsulate workflows; Hermes never touches `TASK.md`/branch/worktree mechanics |
| Where workflow logic lives | **In new REST endpoints** (TypeScript), not in `mcp-server.ts` and not in skill-markdown only |
| Intake intelligence | **Template-fill** — endpoints render `TASK.md` from structured fields; no LLM in the intake path |
| Lifecycle (merge/close) | **Out of scope for v1** — spin up + monitor + nudge only; merge stays human |

## Architecture

```
Hermes ──MCP(stdio)──▶ codeman-mcp ──HTTP──▶ Codeman REST API ──▶ sessions/worktrees
         (typed tools)   (thin facade)        (localhost:3001)
```

Three layers:

1. **REST API** — existing; remains the single source of truth.
2. **New high-level REST endpoints** — `POST /api/feature`, `POST /api/fix`,
   `GET /api/sessions/:id/digest`. Each encapsulates a multi-step workflow
   server-side in TypeScript. Callable by *anything* that does HTTP, which is
   the "future-proof / both" requirement satisfied for free.
3. **`src/mcp-server.ts`** — stays a thin facade. Each MCP tool is one HTTP call
   to layer 2 or to an existing endpoint.

**Why the logic goes in REST endpoints, not the MCP server:** keeping it in REST
means raw-HTTP consumers get the same capability, the logic is unit-testable
without an MCP client, and the existing skills can later be slimmed to call these
same endpoints — so the feature/fix orchestration is maintained in exactly one
place instead of duplicated between skill-markdown and the MCP facade.

## Tool catalog (the MCP surface Hermes sees)

### Read / monitor

| Tool | Returns | Backed by |
|---|---|---|
| `list_projects` | Repos Hermes can start work in: name, path, idle parent session id | `GET /api/sessions`, filtered to main sessions (no `worktreeBranch`) |
| `list_sessions` | All active work: id, name, project, branch, status (`working`/`idle`/`stopped`) | `GET /api/sessions` (exists) |
| `get_session_digest(id)` | The "is it done?" answer (see below) | new `GET /api/sessions/:id/digest` |

`get_session_digest` is the heart of the integration — one call answers the three
questions named in the request ("what's the latest message", "is it done
working", "does it have subagents"). It returns:

- `status` — `working` / `idle` / `stopped` (mapped from internal
  `SessionStatus`: `busy`→`working`, `idle`→`idle`, `stopped`/`error`/`archived`→`stopped`)
- `done` — the reliable completion signal (see below), NOT raw `status`. True only
  when the transcript watcher reports `isComplete && !toolExecuting` and `status`
  is `idle` (and, for task-workflow sessions, `TASK.md` phase indicates done).
- `lastAssistantMessage` — sourced from `TranscriptWatcher.state.lastAssistantMessage`
  (`transcript-watcher.ts:404`, already length-capped at `MAX_MESSAGE_LENGTH`).
  **Returns null when no transcript watcher is attached** (session not yet started,
  or transcript just rotated by `/clear`). It is NOT in the sessions list — the
  light state strips `textOutput`.
- `toolExecuting` — from the transcript watcher (`transcript-watcher.ts:56`); lets
  Hermes distinguish "thinking/idle between tool calls" from "truly finished".
- `subagents` — count and a short list of `{ name, doing }` for currently active
  subagents (sourced from `subagentWatcher.getRecentSubagents`)
- `phase` — current task/phase string if the session is running a task workflow
  (from `TASK.md` `status` line), else null
- `lastActivityAt` — timestamp of last output, so Hermes can detect stalls

**Why `done` is not raw `status`:** a `busy`→`idle` flip happens transiently and
status alone produces false "it's finished" signals mid-task. The transcript
watcher's `isComplete`/`toolExecuting` plus the `TASK.md` phase are the durable
truth. Hermes should gate "is the work finished?" on `done`, not `status`.

Status mapping note: the internal enum has five values
(`idle|busy|stopped|error|archived`); the digest collapses them into the
three-state model above so Hermes deals with a simple vocabulary.

### Act

| Tool | Does | Backed by |
|---|---|---|
| `start_feature(project, title, description, acceptance?, parentSessionId?)` | Full feature intake → returns new session id | new `POST /api/feature` |
| `start_fix(project, title, description, parentSessionId?)` | Full fix intake → returns new session id | new `POST /api/fix` |
| `send_message(target, message)` | Nudge / answer a running session | `POST /api/sessions/:id/input` with `{ input, submit:true }` — `submit:true` makes the server append `\r` (`session-routes.ts:699`), cleaner than passing a literal `\r` |

`parentSessionId` is an optional escape hatch: when supplied it skips workingDir
resolution entirely (see Parent resolution below), letting Hermes disambiguate when
a project has several sessions.

## Workflow endpoints — behaviour (template-fill)

`POST /api/feature` and `POST /api/fix` perform, server-side and
deterministically (no LLM):

1. **Resolve parent session** — if `parentSessionId` is supplied, use it directly
   (validate it is a main session, else `INVALID_INPUT`). Otherwise match `project`
   against main sessions' **realpath'd `workingDir`** (resolve symlinks; normalize
   trailing slash/case) at the repo root; prefer `idle` over `busy`. If zero or
   more-than-one candidate remains, return `NO_PROJECT_MATCH` with the candidate
   list so the caller can re-issue with an explicit `parentSessionId`. Never guess
   among ambiguous candidates.
2. **Derive branch name** — slug the title (lowercase, hyphenate, ≤37 chars),
   prefix `feat/` or `fix/`. On "branch already exists", append `-2`, `-3`, … This
   retry happens **server-side** (the skill does it today; the endpoint must own it
   so concurrent callers don't both pick the same slug).
3. **Render `TASK.md`** — from a fixed template using `title`, `description`,
   `acceptance`; render `CLAUDE.md` from the standard worktree bootstrap string.
4. **Create the worktree** — `POST /api/sessions/:parentId/worktree` with
   `isNew:true`, `autoStart:false`, and `taskMd`/`claudeMd` passed inline (atomic
   write before return — avoids the known race).
5. **Register a work item** — best-effort (`POST /api/work-items`); never blocks.
6. **Start Claude** — `POST /api/sessions/:newId/interactive`.
7. **Return** `{ sessionId, branch, worktreePath, started }`. `started:false` is
   returned (not an error, not a rollback) when step 4 succeeded but step 6 failed,
   so the caller knows a worktree exists and can retry the start or escalate to a
   human. We deliberately do NOT auto-delete a half-created worktree.

**Concurrency:** the endpoint serializes per resolved parent session (an in-process
async lock keyed by `parentSessionId`) so two near-simultaneous `start_feature`
calls against the same parent can't race on branch reservation or derive children
from inconsistent parent state. Calls against *different* parents run in parallel.

These steps are exactly what the `codeman-feature` / `codeman-fix` skills do
today; this ports the mechanical parts into TypeScript. The *implementing* Claude
inside the worktree still does all real reasoning via `codeman-task-runner` — only
the intake step is de-LLM'd.

`TASK.md` template (feature) — fields interpolated, no model involved:

```
# <title>

## status
phase: analysis

## Description
<description>

## Acceptance Criteria
<acceptance, or "See description.">

## Workflow
Invoke the codeman-task-runner skill and proceed through its phases.
```

## Auth (revised — was originally "none")

Codeman's REST API has Basic-Auth middleware that is **active only when
`CODEMAN_PASSWORD` is set** (`src/web/middleware/auth.ts:46`). The only
unauthenticated bypasses are `POST /api/hook-event` from localhost and `/q/`
short-links (`auth.ts:73-86`). Today `CODEMAN_PASSWORD` is empty in the running
unit, so the API is open — but this box is reachable over Tailscale and a
Cloudflare tunnel, and the unit file already carries the (empty) knob, so enabling
the password is a when-not-if.

Therefore the MCP facade MUST forward credentials: read `CODEMAN_USERNAME`
(default `admin`) and `CODEMAN_PASSWORD` from its environment and, when a password
is present, send the `Authorization: Basic …` header on every REST call. When no
password is set it sends nothing and behaves exactly as today. This is a few lines
in `mcp-server.ts`, costs nothing while auth is off, and means the integration
does not silently 401 the moment the user secures the server.

Consequence for the new control-plane endpoints (`/api/feature`, `/api/fix`,
`/api/sessions/:id/digest`): they are normal authenticated routes — they inherit
the global middleware and need no special-casing. We do **not** add a localhost
bypass for them (spinning up worktrees is exactly the kind of action that should
sit behind auth when auth is on).

## Error handling

- Endpoints return structured JSON errors with a `code`
  (`NO_PROJECT_MATCH`, `BRANCH_EXISTS`, `INVALID_INPUT`, `OPERATION_FAILED`) and
  a human-readable `message`. MCP tools surface `message` to Hermes verbatim.
- Work-item registration failure is logged and swallowed — it must never fail the
  spin-up.
- `get_session_digest` on an unknown id → `404` → MCP tool returns a clear
  "no such session" error rather than throwing.

## Testing

- **Unit (template-fill):** branch slugging (length cap, collision suffix,
  invalid chars), parent-session resolution (idle-preference, shortest-path
  tie-break, no-match), `TASK.md` rendering with/without `acceptance`. Pure
  functions, no server needed.
- **Unit (digest):** status collapse mapping (all five enum values), subagent
  list shaping, empty/stopped sessions.
- **Integration:** against a running `localhost:3001` — `start_feature` returns a
  real session id whose worktree contains the expected `TASK.md`; `send_message`
  reaches the session; `get_session_digest` reflects a working vs idle session.
- **MCP smoke:** drive `mcp-server.ts` over stdio with an `initialize` +
  `tools/call` for each tool, assert shapes.

## Adversarial review — findings folded in (2026-06-23)

Reviewed by codex plus line-level verification against the source. All seven
code-level assumptions were checked; the design *shape* (architecture + tool
catalog) survived unchanged. Revisions made:

1. **Auth (was CRITICAL):** "no auth" was wrong — the facade now forwards Basic
   Auth from env so it survives `CODEMAN_PASSWORD` being set. See Auth section.
2. **Completion semantics (was MAJOR):** digest now exposes `done` +
   `toolExecuting` from the transcript watcher and the `TASK.md` phase, instead of
   letting Hermes infer "finished" from raw `status` (which false-positives).
3. **`lastAssistantMessage` source (was MAJOR):** pinned to
   `TranscriptWatcher.state.lastAssistantMessage`, null when no watcher; documented
   that the sessions list does not carry it.
4. **Parent resolution (was MAJOR):** realpath-based match, no guessing among
   ambiguous candidates, plus an explicit `parentSessionId` override.
5. **Concurrency + partial failure (was MINOR):** per-parent serialization,
   server-side branch-collision retry, and a `started` flag instead of auto-rollback.

Verified-true claims (no change needed): worktree POST inline `taskMd`/`claudeMd`/
`autoStart`; `getRecentSubagents`; the five-value status enum; sessions list fields.
One refinement: use `submit:true` rather than a literal `\r` on the input route.

## Explicitly out of scope (v1, YAGNI)

- HTTP/SSE MCP transport (only needed if Hermes goes remote). Auth itself is now
  **in** scope — the facade forwards it — but a dedicated token/remote auth scheme
  stays out until Hermes leaves the machine.
- Lifecycle tools (`merge_worktree`, `close_session`) — merge stays human.
- Push/streaming digest as an MCP resource — Hermes polls `get_session_digest`
  for now; revisit if polling proves insufficient.
- Low-level escape-hatch tools (`create_session`, raw `get_output`) — add only if
  a concrete need appears.
```
