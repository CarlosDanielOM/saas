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

## Isolated Verification on the Production Host

Follow the root production workflow. A requested implementation includes isolated validation and targeted production deployment after checks pass, unless the user limits the scope.

- From the appropriate checkout, `npm run build --prefix dimabot` compiles TypeScript. The package has no `dev` script; inspect `package.json` for actual commands.
- Build the affected Dockerfile with a unique candidate tag, then start a disposable container with an isolated configuration and the appropriate runtime command. Check readiness and the changed behavior before touching production containers.
- `server:dev`, `bot:dev`, and `cron:dev` start real application processes. Do not start them with production credentials/dependencies for verification; bot and cron processes can duplicate live actions. The existing development Compose file is not proof of isolation.
- For TTS/embedding changes, test the relevant service image and its API using temporary model/voice data as needed. Do not attach writable production cache volumes to test containers. Limit test resources so production retains capacity.
- Inspect test scripts before execution. The default `npm test` is a placeholder that fails; use relevant existing suites and behavior checks rather than treating that placeholder as coverage.
- Remove task-owned test resources after verification. Preserve the previous production image before rebuilding the affected service.

## Production Deployment (Container Rebuilds)

`dimabot/docker-compose.yaml` defines five services: `api-server`, `chat-bot`, `dima-cron`, `piper-tts`, and `lfm2.5-embeddings`. The first three share a Dockerfile that compiles `src/` inside each image. `piper-tts` and `lfm2.5-embeddings` use separate Dockerfiles. Deploy only after isolated validation passes.

**Always run compose commands from `dimabot/`** (the directory that owns `docker-compose.yaml`):

```bash
cd dimabot
```

### Rebuild only the services that changed

Select services by their actual imports and runtime consumers, not directory names alone. Server-only code usually affects `api-server`, bot-only code `chat-bot`, and worker-only code `dima-cron`; shared utilities/schemas may affect all three. A TTS change may require `piper-tts` plus callers if its contract changes. Use targeted rebuilds and `--no-deps` when dependencies are unchanged.

```bash
# Single service
docker compose up -d --build --no-deps api-server

# Two services
docker compose up -d --build --no-deps api-server chat-bot

# All three code-bearing services (most common for cross-cutting fixes)
docker compose up -d --build --no-deps api-server chat-bot dima-cron
```

This is significantly faster than rebuilding the full stack and avoids restarting `piper-tts` / `lfm2.5-embeddings` unnecessarily (which restarts the embedding model load and the piper voice cache).

### Dockerfile and Compose changes

Changes to a Dockerfile or Compose file do not automatically require rebuilding the entire stack. Rebuild/recreate the services affected by that change and any required dependent changes. For a validated TTS-only change, use `docker compose up -d --build --no-deps piper-tts`. Preserve production volumes; never run `down -v` as part of deployment.

### After the rebuild

1. Check the affected containers' image IDs, status, readiness/health, and recent logs. Image tags may stay the same after rebuilding; compare IDs with the new images. Leave unrelated services running.
2. For API changes, verify startup and the relevant endpoint. For TTS changes, verify readiness and a scoped synthesis request using the supported contract. For workers/bots, confirm the expected single production instance and healthy startup without injecting real user actions.
3. Existing endpoints such as `https://api.domdimabot.com/config/site/analytics` may be used for read-only smoke checks, but do not prove a different changed feature works. Do not infer failure just from zero counts.
4. Restore the previous image/configuration if the release introduces a regression, then report the failed check. Never run overlapping production bot/cron instances as a rollout strategy.

### Frontend bundle (dimasite)

The `dimabot-site` nginx container belongs to `dimasite/docker-compose.yaml`, with Nginx Proxy Manager in front of it. Its content is bind-mounted directly from `dimasite/dist/dimasite/browser/` (Angular build output) into the container at `/usr/share/nginx/html` (read-only).

**The production build is the deploy step.** After preview/behavior checks pass and the previous bundle is preserved, rebuild:

```bash
# From saas/ root
npm run build --prefix dimasite
```

No container restart is needed — nginx reads files on each request and the bind-mount reflects host changes immediately, including partial build output. Verify the live result and restore the previous bundle if the build or deployment check fails.

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
