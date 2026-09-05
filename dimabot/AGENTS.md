# dimabot Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

## Project Purpose

`dimabot/` is the backend API + Twitch bot + background workers. It handles:

- Twitch EventSub, chat, PubSub, Helix API interactions
- User authentication (Twitch OAuth + email)
- Billing, rewards, commands, triggers, clips, analytics
- AI personality, memory, embeddings, TTS
- Cron workers for follow ledger, stream analytics, raid defense, timers, etc.

## Key Entry Points

- `src/server/index.ts` – HTTP server bootstrap
- `src/server/server.ts` – Route registration and middleware
- `src/server/websocket.ts` – WebSocket event contracts
- `src/bot/index.ts` – Twitch chat bot entrypoint
- `src/workers/cron.index.ts` – Cron supervisor (self-healing workers)

## Architecture Notes

- All HTTP routes live in `src/server/routes/*.route.ts`.
- Bot commands are in `src/commands/`.
- Reusable functions (Helix calls, chat actions, moderation) live in `src/functions/`.
- Handlers for EventSub, chat messages, redemptions, etc. are in `src/handlers/`.
- Heavy or scheduled work belongs in `src/workers/` (see root AGENTS.md for worker criteria).
- **Moderation actions are always executed by the bot account** (`TWITCH_BOT_ACCOUNT_ID` in `src/utils/header.ts`), whether triggered by the streamer, a mod, a `!`command, or the AI via AST. Helix moderation endpoints require `moderator_id` to match the token owner — always pair the bot token with `moderator_id=TWITCH_BOT_ACCOUNT_ID` via `getTwitchModeratorHeader()`. Never pass a chatter/streamer ID as `moderator_id`.

## Development Commands

Typical workflow (run from `saas/` root or inside `dimabot/`):

```bash
npm install
npm run build
npm run dev          # or the containerized dev command
```

Refer to `docker-compose*.yaml` files for local container setup.

## Production Deployment (Container Rebuilds)

`dimabot/docker-compose.yaml` defines five services: `api-server`, `chat-bot`, `dima-cron`, `piper-tts`, and `lfm2.5-embeddings`. The first three are the ones that change when you edit `src/` — they share the same Dockerfile and build from the same `dist/` output. `piper-tts` and `lfm2.5-embeddings` are separate images that change rarely.

**Always run compose commands from `dimabot/`** (the directory that owns `docker-compose.yaml`):

```bash
cd dimabot
```

### Rebuild only the services that changed

Prefer targeted rebuilds over `docker compose up -d --build` (which rebuilds everything). A change to `src/server/**` only needs `api-server`; a change to `src/bot/**` only needs `chat-bot`; a change to `src/workers/**` or `src/utils/**` used by workers only needs `dima-cron`. A change to shared code (`src/utils/**`, `src/schemas/**`) typically needs all three.

```bash
# Single service
docker compose up -d --build api-server

# Two services
docker compose up -d --build api-server chat-bot

# All three code-bearing services (most common for cross-cutting fixes)
docker compose up -d --build api-server chat-bot dima-cron
```

This is significantly faster than rebuilding the full stack and avoids restarting `piper-tts` / `lfm2.5-embeddings` unnecessarily (which restarts the embedding model load and the piper voice cache).

### Rebuild everything (rare)

Only when you change `docker-compose.yaml` itself, the `dockerfile`, `dockerfile.piper`, or `dockerfile.lfm2-embeddings`:

```bash
docker compose up -d --build
```

### After the rebuild

1. Verify with `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'` — the three services should show new uptimes and the new image tag.
2. Check `docker logs dima-server --since=20s` for boot errors. The expected last line is `Server listening on port 3000`.
3. For `dima-cron`, expect a `worker:stream-memory:lock` info log on first boot — only one cron instance may run `stream-memory` at a time. This is normal.
4. Smoke-test the API: `curl -fsS https://api.domdimabot.com/config/site/analytics | jq .data` should return real counts (not all zeros).

### Frontend bundle (dimasite)

The `dimabot-site` nginx container is **not** part of `dimabot/docker-compose.yaml`; it is managed by `nginx-proxy-manager`. Its content is bind-mounted directly from `dimasite/dist/dimasite/browser/` (Angular build output) into the container at `/usr/share/nginx/html` (read-only).

**There is no separate deploy step.** After editing `dimasite/src/**`, just rebuild:

```bash
# From saas/ root
npm run build --prefix dimasite
```

No container restart is needed — nginx reads files on each request and the bind-mount reflects host changes immediately. The `/home/cdom/var/www/dima-site/` path mentioned in older revisions of this document is **unused** — do not copy files there.

See `dimasite/AGENTS.md` → "Production Build & Deployment" for full details.

## Worker Guidelines

See the expanded Cron Workers section in root `saas/AGENTS.md`. When adding a worker:

1. Create `src/workers/your-feature.worker.ts`
2. Export `{ name, schedule, run }`
3. Register in `cron.index.ts`

## Event Pipeline

Producer/consumer contracts, account ownership, recovery, Polar behavior, and extension/rollout guidance live in [`DOMAIN_EVENTS.md`](./DOMAIN_EVENTS.md). Read it before adding an event provider or consumer; backend module consumers are distinct from browser WebSocket clients.

## API Contracts

All contracts are defined in the `.route.ts` files. Read the source for the latest shapes. The common envelope is `{ error, message, status, data }`.

---

**This file is intentionally lightweight.** Add project-specific architecture notes, command patterns, or worker guidelines here as the codebase evolves. Root rules always take precedence.
