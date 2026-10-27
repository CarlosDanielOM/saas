# dimabot Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

Rust is part of this project. `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml` live at this directory's root, and Rust modules live beside TypeScript sources under `src/`. Read [`RUST_AGENTS.md`](RUST_AGENTS.md) before Rust changes; the library overview is in [`RUST.md`](RUST.md).

Rust test requests authorize isolated testing only. Never run tests in or mutate production containers or use live production resources; a production release requires a separate explicit user instruction. Follow the [Rust testing isolation rules](RUST_AGENTS.md#production-isolation-for-rust-tests).

For migration completion scoring, distinguish local feature coverage from total dependency-complete migration, and report caller adoption/deployment separately. See [Migration completeness](RUST_AGENTS.md#migration-completeness).

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
- `src/workers/cron.index.rs` – Native Rust cron index, colocated with the TypeScript supervisor

## Architecture Notes

- All HTTP routes live in `src/server/routes/*.route.ts`.
- Bot commands are in `src/commands/`.
- Reusable functions (Helix calls, chat actions, moderation) live in `src/functions/`.
- Handlers for EventSub, chat messages, redemptions, etc. are in `src/handlers/`.
- Heavy or scheduled work belongs in `src/workers/` (see root AGENTS.md for worker criteria).
- Seven scheduled TypeScript worker entrypoints are retired from the application source tree and preserved in [`archives/typescript-workers/2026-10-21`](../archives/typescript-workers/2026-10-21/README.md). Their accepted native replacements remain active; prior shared-utility run `cron-2056ce9d790c` is the rollback target for the accepted dual-supervisor release. Former TypeScript runtime selectors are retired where they existed; no `RAID_SESSIONS_RUNTIME` selector existed. Failed native children restart without a TypeScript fallback. See the [shared utility record](../migration-notes/worker-shared-utils.md) and [retirement record](../migration-notes/typescript-worker-retirement.md).
- **Dual-supervisor accepted release:** `cron-7629f95f5dfd` / image `sha256:f848743bc0f0817656d2399dd00a4e08e5828d2a0261096c551bb48302ae000f` is live in the existing `dima-cron` container: Node PID 1 owns TypeScript workers and one detached Rust index owns seven native workers. Build, exact-image suites, 32-sample production watch, final readbacks, and cleanup passed. The accepted rollback target is `cron-2056ce9d790c` / `sha256:adac7d8de9b5c5cfb138f8051a05123ac02a6c3467cc85784873ee85370d892f`. The TypeScript index sunset remains future work after the final TypeScript responsibility migrates. See [dual-cron-supervisors.md](../migration-notes/dual-cron-supervisors.md).
- The current source declares seven native executables for `cron:dev` with `CRON_WORKER_RUNTIME=tsx`. Prior accepted shared-utility run `cron-2056ce9d790c` rebuilt all seven; all three dependency graphs matched their previous accepted versions byte-for-byte and its candidate checks and production acceptance passed. Candidate results do not define a standing suite count. Future cron checks verify each new or changed worker, retest existing workers only for concrete impact from their code, relevant dependencies, or shared runtime behavior, and check startup and health for all existing workers after replacement. Use [`ops/README.md`](../ops/README.md) for the workflow.
- Native migrations replace scheduled entrypoints only. Shared TypeScript helpers, parity references, APIs, request-time behavior, producers, and action execution remain on existing TypeScript paths. In particular, `follow-defense-actions` continues Twitch bans and `roulette-actions` continues winner-action ASTs. See the [stream](RUST_STREAM_ACTIVITY.md), [raid analytics](../migration-notes/raid-change-driven.md), [raid sessions](../migration-notes/raid-sessions.md), [baseline](../migration-notes/follow-defense-baseline.md), [roulette](../migration-notes/roulette-completion.md), [AI receipts](../migration-notes/ai-usage-receipts.md), and [dashboard](../migration-notes/dashboard-activity.md) records.
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
