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
- The scheduled stream-activity, raid-analytics, follow-defense baseline, roulette-completion, AI-usage-receipts, and raid-sessions TypeScript worker entrypoints are retired from the application source tree and preserved in [`archives/typescript-workers/2026-10-21`](../archives/typescript-workers/2026-10-21/README.md). The first five scheduled responsibilities were accepted as native Rust children under both Node and `tsx`; raid sessions is the sixth source integration; all eight exact-image suites (102 groups) and production acceptance passed on candidate `cron-7a8ca7924412`. Former TypeScript runtime selectors are retired where they historically existed; no `RAID_SESSIONS_RUNTIME` selector existed. A missing or failed native child restarts that Rust child with no TypeScript fallback. See the [retirement record](../migration-notes/typescript-worker-retirement.md) for prior acceptance and restoration limits, and the [raid sessions record](../migration-notes/raid-sessions.md) for release evidence.
- `cron:dev` with `CRON_WORKER_RUNTIME=tsx` requires all six native executables at the paths defined by native worker metadata under `/usr/local/bin/`; missing binaries are reported/retried as Rust children, without substituting a TypeScript worker. Use the current candidate checks and workflow documented in [`ops/README.md`](../ops/README.md) when validating the Rust-only contract.
- The native migrations are limited to their scheduled entrypoints. Shared TypeScript helpers and parity references remain valid; APIs, request-time behavior, producers, and action execution remain on their existing TypeScript paths. In particular, the `follow-defense-actions` worker continues to execute Twitch bans, and `roulette-actions` continues to execute winner-action ASTs. Source-backed rollout details remain in the [stream](../dima-rust/STREAM_ACTIVITY.md), [raid analytics](../migration-notes/raid-change-driven.md), [raid sessions](../migration-notes/raid-sessions.md), [baseline](../migration-notes/follow-defense-baseline.md), [roulette](../migration-notes/roulette-completion.md), and [AI receipts](../migration-notes/ai-usage-receipts.md) records.
- **Account records have distinct roles.** The `accounts` array embedded in `src/schemas/users.schema.ts` stores a user's streaming-platform identities and credentials, such as Twitch or Kick. The separate model in `src/schemas/accounts.schema.ts` stores external non-streaming account records; a Riot account is a possible future example, not an implemented integration. Neither model represents an application authorized to access DomDimaBot. Dima OAuth uses a separate public-client registry and per-user grants, sessions, and refresh-token records; grants and sessions link to `users._id`. See [`OAUTH_BETA.md`](./OAUTH_BETA.md) for the current desktop beta contract.
- **Moderation actions are always executed by the bot account** (`TWITCH_BOT_ACCOUNT_ID` in `src/utils/header.ts`), whether triggered by the streamer, a mod, a `!`command, or the AI via AST. Helix moderation endpoints require `moderator_id` to match the token owner — always pair the bot token with `moderator_id=TWITCH_BOT_ACCOUNT_ID` via `getTwitchModeratorHeader()`. Never pass a chatter/streamer ID as `moderator_id`.

## Verification & Production Deployment

Use the root production workflow and [`../ops/README.md`](../ops/README.md). Agents use `scripts/saas-ops`; `scripts/dima-update` is the human operator's tool and must not be invoked or modified by agents.

From the repository root:

```bash
scripts/saas-ops plan piper
scripts/saas-ops build piper
# Use the exact run ID printed above; extend the check for the changed behavior.
scripts/saas-ops verify piper-<run-id> --seed-models --check ops/checks/piper.py
scripts/saas-ops deploy piper-<run-id>
scripts/saas-ops cleanup piper-<run-id>
```

Target mapping: `api` → `api-server`, `bot` → `chat-bot`, `cron` → `dima-cron`, `piper` → `piper-tts`, `embeddings` → `lfm2.5-embeddings`. Select affected services by actual imports and runtime consumers. Shared code may require separate verified runs for multiple targets. The helper does not provide a bulk deployment command.

- Builds run from source snapshots outside the live checkout. The API/bot/cron images compile `src/` inside their Dockerfile; TTS and embeddings have separate Dockerfiles.
- Verification runs the actual candidate command in a disposable container with test data/settings. Use `--test-env`, `--fixtures`, and the allowlisted `--dependency mongo|redis` as needed. API/bot/cron initialization may need provider mocks or additional task-specific test setup; do not point tests at production services to make them pass.
- `server:dev`, `bot:dev`, and `cron:dev` start real application processes. Running them with production credentials can duplicate live actions. The existing development Compose file is not proof of isolation.
- The package has no `dev` script, and its default `npm test` is a failing placeholder. Inspect source and use the relevant existing suites and behavior checks.
- The Piper baseline check verifies voice listing, default/explicit synthesis, WAV output, and empty-input rejection. Add cases for a custom-ID or other feature change. `--seed-models` copies production voice files read-only into disposable storage; it does not mount production volumes into tests.
- After tests pass, deployment promotes the exact tested image with dependencies untouched and preserves rollback. Use `scripts/saas-ops rollback <run-id>` if task-specific production checks reveal a regression. Check the relevant service's readiness, logs, and behavior; a general API health endpoint does not verify a TTS change.
- Compose/Dockerfile changes do not justify a blanket stack rebuild. Dockerfile changes use the relevant target. The helper refuses Compose/environment drift; review configuration changes separately rather than bypassing the check.

### Frontend bundle (dimasite)

The `dimabot-site` container belongs to `dimasite/docker-compose.yaml`. Use helper target `site` for preview, isolated production build, verification, and publication. Its output is mounted directly from `dimasite/dist/dimasite/browser/`; agents must not run an in-place production build as a validation command. See `dimasite/AGENTS.md` and `ops/README.md`.

## Worker Guidelines

See the expanded Cron Workers section in root `saas/AGENTS.md`. When adding a worker:

1. Create `src/workers/your-feature.worker.ts`
2. Export `{ name, schedule, run }`
3. Register in `cron.index.ts`

## Event Pipeline

Producer/consumer contracts, account ownership, recovery, Polar behavior, and extension/rollout guidance live in [`DOMAIN_EVENTS.md`](./DOMAIN_EVENTS.md). Read it before adding an event provider or consumer; backend module consumers are distinct from browser WebSocket clients.

Overlay Studio's portable widget contract, frontend module registry, state source adapters, compatibility envelope, and extension recipe are documented in [`OVERLAY_WIDGET_MODULES.md`](./OVERLAY_WIDGET_MODULES.md).

## API Contracts

All contracts are defined in the `.route.ts` files. Read the source for the latest shapes. The common envelope is `{ error, message, status, data }`.

---

**This file is intentionally lightweight.** Add project-specific architecture notes, command patterns, or worker guidelines here as the codebase evolves. Root rules always take precedence.
