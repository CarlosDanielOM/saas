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
- **Desktop AI ingress:** turn routes, durable execution, and speech delivery live in `src/server/oauth/routes.ts` and `src/desktop_ai/`; cross-source playback coordination is registered from `src/server/websocket.ts`. See the [v1 wire contract](./DESKTOP_AI_CONTRACT.md) and [release evidence](../migration-notes/desktop-ai-turns.md).
- `src/bot/index.ts` – Twitch chat bot entrypoint
- `src/workers/cron.index.ts` – Cron supervisor (self-healing workers)

## Architecture Notes

- All HTTP routes live in `src/server/routes/*.route.ts`.
- Bot commands are in `src/commands/`.
- Reusable functions (Helix calls, chat actions, moderation) live in `src/functions/`.
- Handlers for EventSub, chat messages, redemptions, etc. are in `src/handlers/`.
- Heavy or scheduled work belongs in `src/workers/` (see root AGENTS.md for worker criteria).
- All 26 cron worker definitions are TypeScript, supervised by `src/workers/cron.index.ts` in `dima-cron`. The seven returned workers use `worker_loop.ts`; see the [return record](../migration-notes/typescript-workers-return.md).
- `cron:dev` uses `tsx`. Verify changed workers and affected shared behavior in isolation; check all worker startup and health after replacement. See [`ops/README.md`](../ops/README.md).
- **Account records have distinct roles.** The `accounts` array embedded in `src/schemas/users.schema.ts` stores a user's streaming-platform identities and credentials, such as Twitch or Kick. The separate model in `src/schemas/accounts.schema.ts` stores external non-streaming account records; a Riot account is a possible future example, not an implemented integration. Neither model represents an application authorized to access DomDimaBot. Dima OAuth uses a separate public-client registry and per-user grants, sessions, and refresh-token records; grants and sessions link to `users._id`. See [`OAUTH_BETA.md`](./OAUTH_BETA.md) for the current desktop beta contract.
- **Moderation actions are always executed by the bot account** (`TWITCH_BOT_ACCOUNT_ID` in `src/utils/header.ts`), whether triggered by the streamer, a mod, a `!`command, or the AI via AST. Helix moderation endpoints require `moderator_id` to match the token owner — always pair the bot token with `moderator_id=TWITCH_BOT_ACCOUNT_ID` via `getTwitchModeratorHeader()`. Never pass a chatter/streamer ID as `moderator_id`.
- **Pet AI integration:** `pet.ask` uses the normal `chat()` path, including channel personality context, recent chat history, semantic memory, and user-thread context, while applying the configured pet persona, name, language, reply length, and TTS voice. Verified Twitch chat provenance is carried from EventSub in an opaque, non-serializable AST effect; only chat-command requests with valid provenance can receive caller-scoped tools. The pet's tool identity is rebuilt from the originating viewer, with moderator status refreshed before use; never grant the pet the authority of the authored command/configuration. Event-triggered and legacy requests have no verified caller and run without tools. `code_execution` is always excluded for pet invocations because its credentials are channel-scoped. Pet AST calls remain subject to normal permission checks and reject recursive pet/TTS actions, nested or dynamic AST syntax, and repeated actions; `ban.self` may only target the verified triggering message. The current accepted release evidence is in [`migration-notes/pet-chat-context.md`](../migration-notes/pet-chat-context.md).
- Pet conversation continuity is stored separately from bot threads: Mongo `pet_requests` rows count only after playback starts and completion, and are scoped to the same viewer, last 24 hours, and the normal tier prompt-turn limit. If no completed pet replies qualify, the runtime may read matching existing user-thread context without appending the pet turn to that bot thread. See [`src/pets/runtime.ts`](src/pets/runtime.ts), [`src/utils/ai/openrouter/ai.ts`](src/utils/ai/openrouter/ai.ts), [`src/utils/ast_parser/effects.ts`](src/utils/ast_parser/effects.ts), and [`src/bot/eventsub.twitch.ts`](src/bot/eventsub.twitch.ts).
- **Speech pages (normal TTS output):** a channel can have `/speech/<channel>/` open several times (OBS sources, browser tabs). Pages send `speech-state` (visible, OBS, silent audio probe) and a stable `pageId`; `src/handlers/tts_outputs.ts` ranks them and the queue sends each message to the best one, or to every page when `playback.allOutputs` is on (snapshot per message at enqueue). A failure before anything was heard moves the same payload to the next untried page (max 3; never after playback started; inferred failures stop the page first via an acknowledged `speech-cancel`). Pages already loaded in OBS keep the old script until the source reloads, so changes must stay compatible with pages that send no state, `ready` or `pageId`. A hidden OBS source never starts audio it has not played before. Checks: `ops/checks/tts-output-selection-{api,browser}.mjs`, `tts-outputs-web.mjs`, `tts-outputs-docs.py`.
- **Pet mood decoration is best effort:** mood data/images are optional and must never fail, delay, cancel, or disconnect their parent Pet request, speech, billing, normal Read-TTS, desktop session, settings page, or browser playback. Keep core settings/protocol validation strict; sanitize malformed mood-only settings to disabled defaults with a bounded warning. Invalid extraction resolves to neutral, failed instructions are omitted, malformed optional wire mood data is ignored/defaulted, and failed mood assets fall back to ordinary assets. Preserve or restore the previous mood image mapping for invalid/foreign or over-quota edits; missing previously saved references do not block core settings saves. Prefetch optional ask cue settings without awaiting/retrying; on late/failure preserve existing speech text. See the DIMA-046 resilience contract in [`PET_RUNTIME.md`](./PET_RUNTIME.md#pet-decoration-resilience).

- **MiniMax and the docs assistant:** `src/utils/ai/minimax/minimax_client.ts` is the MiniMax client (Anthropic-compatible API, key `MINI_TOKEN_PLAN_API_KEY` from the environment only). Use `MiniMax-M3.1-Flash` at `high`/`xhigh` effort. Calls always stream; `max_tokens` defaults to the model ceiling (no artificial cap). Errors are typed (`MiniMaxError.kind`), and cancel/idle aborts settle immediately. The public docs assistant (`src/server/routes/docs-assistant.route.ts`, `src/utils/ai/docs_assistant/`) puts its prompt (`src/utils/ai/docs_assistant/docs_assistant.prompt.ts`, edit it there) and the docs container's `llms-full.txt` (fetched from `http://dimadocs`, 5-minute cache, last good copy kept) in a byte-stable system prompt. It has a CORS allowlist (docs site + local previews), per-IP limits (8/min, 80/day via `src/utils/rate_limit.ts`), a 5000/day total, and 16 simultaneous answers per process. The assistant has two tools (`docs_assistant.tools.ts`), run by the MiniMax client's tool loop (thinking blocks passed back unchanged, short preambles held back, last round forced to answer). `search_ast_functions` reuses the chat AI's `searchAstCatalog` (authoring surface, every level). `test_command` runs bodies through the real engine via `src/utils/ast_parser/simulate.ts`: pure functions run, everything else is recorded or sampled, and variables stay in memory, through the opt-in `ExecutionContext.simulation` hook. Never set that hook for real commands. In the API, functions are registered with `registerAllFunctions({ startWorkers: false })` so the bot's moderator-restore loop never starts there. Catalog vectors are embedded in batches of 32 and cached in Dragonfly (`ast_catalog:vectors:v1:<hash>`, 30 days); the shared embeddings service has 4 GiB of memory. Usage and feedback live in Dragonfly: `docs_assistant:stats:<day>` (120 days) and `docs_assistant:answer:<id>` + `docs_assistant:recent` (30 days). Check: `ops/checks/docs-assistant-api.mjs` (see its fixtures README).

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

See the root [cron architecture](../AGENTS.md#cron-workers-architecture-important). Create a TypeScript entrypoint that calls `runWorker` in `src/workers/worker_loop.ts`, and register its name, source entry, and compiled entry in `WORKERS` in `cron.index.ts`. Choose appropriate pacing, failure handling, health probes, and watchdogs for its work.

## Event Pipeline

Producer/consumer contracts, account ownership, recovery, Polar behavior, and extension/rollout guidance live in [`DOMAIN_EVENTS.md`](./DOMAIN_EVENTS.md). Read it before adding an event provider or consumer; backend module consumers are distinct from browser WebSocket clients.

Overlay Studio's portable widget contract, frontend module registry, state source adapters, compatibility envelope, and extension recipe are documented in [`OVERLAY_WIDGET_MODULES.md`](./OVERLAY_WIDGET_MODULES.md).

For releases touching overlays, TTS delivery, custom widgets or Studio routes, run the overlay API suite and fix failing checks in the same release; see [Verification](./OVERLAY_WIDGET_MODULES.md#verification).

Overlay live delivery uses [`src/overlays/live/index.ts`](./src/overlays/live/index.ts) as its public entry (`overlays/live/index.js` in imports). `connections.live.ts` owns OBS sockets, reconnect leases, published overlay reloads, the one-second loop and producer bridge. `delivery.live.ts` owns pending events, durable reconnect copies, retained media, event details and queue controls. `alerts.live.ts` handles domain-log Twitch alerts and Bits rules; `tts.live.ts` handles speech ownership, reports, controls and status; `widget_feeds.live.ts` handles poll and prediction state and custom widget feeds.

Page version tracking and compatibility removal are documented in [Overlay Studio widget modules](./OVERLAY_WIDGET_MODULES.md#page-versions-and-compatibility-code).

## Owner Admin Console

See [ADMIN_CONSOLE.md](./ADMIN_CONSOLE.md) for the owner console, activity trail and checks. Record activity through `recordActivity` and its guarded wrappers only; row construction and recording must never throw into the caller. Register new owner-only routes with the wrappers in `src/server/routes/admin_site/shared.ts`. Usage receipt enrichment is receipt-only: keep Polar and PostHog billing events unchanged.

## Polar Usage Events

Units on every `ai_usage` event (see the root guide for the full rule): `_cost.amount` = the provider's real charge in **cents**; `cost` = the same charge in **USD**, as the provider reports it; `credits` = what the streamer pays (1 credit = $0.00001). LLM credits follow the real cost (cents × 1000); voice credits are a fixed price per character and never follow the provider's price.

- `ingestPolarSHEvent` (`src/utils/polarsh.ts`): pass `cost` in USD as the provider reports it plus `llm` (credits derived) or `credits` (fixed price, voice). It stores the USD in `cost` and the cents in `_cost`, debits the local balance once per entry, writes the receipt, and queues the event durably.
- Voice lines go through `trackTtsUsage` → `sendTtsUsageEvent` (`src/utils/tts_usage.ts`). OpenRouter lines (Drama 3, Kokoro) carry an `x-generation-id`; they are parked in `tts_usage_pending` with their credits already taken locally, and the `tts-usage` worker looks up `GET /api/v1/generation?id=` (ready ~20–60 s after the call), then sends the event. After 15 minutes without an answer it uses the list price in `src/utils/tts/tts_provider_cost.ts`; Fish's own API always uses it. Keep those list prices current.
- Polar events are immutable. Test event shapes in `src/utils/polarsh_accounting.test.ts` and `src/utils/tts_usage.test.ts` before shipping.

## API Contracts

All contracts are defined in the `.route.ts` files. Read the source for the latest shapes. The common envelope is `{ error, message, status, data }`.

---

**This file is intentionally lightweight.** Add project-specific architecture notes, command patterns, or worker guidelines here as the codebase evolves. Root rules always take precedence.
