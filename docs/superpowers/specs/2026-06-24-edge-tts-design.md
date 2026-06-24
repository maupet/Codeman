# Edge TTS for transcript read-aloud

**Date:** 2026-06-24

## Goal

Replace the browser `speechSynthesis` engine behind the transcript speaker button
with the local Edge TTS engine (better voice), keeping the web engine as an
automatic fallback.

## Context

- Existing feature: `TranscriptTTS` singleton in `src/web/public/app.js` adds a
  speaker button to each assistant message and reads it via the Web Speech API.
- A running OpenAI-compatible Edge TTS shim listens on `127.0.0.1:8091`
  (`POST /v1/audio/speech` → `audio/mpeg`, API key `local-edge-tts`, default
  voice `en-US-AriaNeural`).
- The Edge server binds to localhost, so remote browsers (Tailscale/Cloudflare)
  cannot reach it directly — audio must be proxied through the Codeman backend
  (port 3001).

## Backend — `POST /api/tts`

Added inline in `src/web/server.ts` next to the `/api/crash-diag` routes.

- Body: `{ text: string, voice?: string }`.
- Forwards to `CODEMAN_TTS_URL` with `Authorization: Bearer <CODEMAN_TTS_KEY>`
  and JSON `{ model: "edge-tts", input: text, voice: voice ?? CODEMAN_TTS_VOICE }`.
- Pipes the upstream `audio/mpeg` body back to the client with the same content type.
- On upstream failure / non-2xx / fetch throw, responds `502` so the frontend
  falls back.
- Config (env, with defaults):
  - `CODEMAN_TTS_URL` = `http://127.0.0.1:8091/v1/audio/speech`
  - `CODEMAN_TTS_KEY` = `local-edge-tts`
  - `CODEMAN_TTS_VOICE` = `en-US-AriaNeural`

## Frontend — `TranscriptTTS.speak()` rework

- Edge-first: `fetch('/api/tts', { text })` → `blob()` → `new Audio(objectURL)` → `play()`.
- Same button UX: toggle speaker↔stop icon, `--speaking` class, click-again-to-stop,
  only one playing at a time.
- `_stop()` pauses/clears the active `Audio` element AND cancels any `speechSynthesis`.
- On any failure (fetch error, non-2xx, `play()` rejection), fall back to the
  existing `speechSynthesis` path, which is preserved unchanged.
- `_stripMarkdown` runs before sending text to the backend (unchanged).
- Revoke the object URL on end/stop/error to avoid leaks.

## Delivery

Generate-then-play: backend fetches the full MP3, returns it; browser plays once
received (~1-2s for a few paragraphs). No streaming, no caching for v1.

## Out of scope

Voice-picker UI, per-message caching, autoplay. Voice is env-configurable only.
