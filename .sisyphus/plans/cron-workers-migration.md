# Cron Workers Migration (JS → TS) + dima-cron Compose Service

## TL;DR
> **Summary**: Port the cron supervisor + 5 worker entrypoints from `olddimabot`’s compiled JS into `dimabot` TypeScript (NodeNext/ESM, `.js` import specifiers), and wire a new `dima-cron` container in `dimabot/docker-compose.yaml` to run them.
> **Deliverables**:
> - `dimabot/src/workers/cron.index.ts` + 5 worker entrypoints
> - Required missing `src/utils/**` + `src/schemas/**` dependencies so the workers compile and run
> - `dimabot/docker-compose.yaml` updated to include `dima-cron` (and base compose contains only `api-server`, `chat-bot`, `dima-cron`)
> - Dev compose override that restores the old `dev-bot` convenience service
> **Effort**: XL
> **Parallel**: YES - 4 waves
> **Critical Path**: Buildable TS deps → workers → cron supervisor → docker-compose wiring → verification

## Context
### Original Request
- “Do first the cron jobs… detailed plan to migrate JS to TS with correct types following project structure.”
- “Add missing dima-cron to docker-compose; docker compose should have chat-bot (dima-bot), api-server (dima-server), dima-cron.”

### Interview Summary
- Parity-first migration: preserve env var names, lock semantics, queue keys, and job payload shapes from `olddimabot`.
- NodeNext ESM: all TS relative imports keep `.js` specifiers (matches current `dimabot/src/**`).
- Production cron runtime runs built JS (`node dist/workers/cron.index.js`); dev cron runs TS via `tsx src/workers/cron.index.ts`.

### Metis Review (gaps addressed)
- Avoid duplicate stream analytics work: gate/remove `startStreamAnalyticsWorker()` in `dimabot/src/server/index.ts` when using `dima-cron`.
- “Cron jobs” requires porting large missing dependency graph (cron queue utils, follow ledger system, stream memory system, observability metrics, temp role announcements, schemas).
- Compose base file must contain exactly the 3 services; keep dev workflow via override file.

## Work Objectives
### Core Objective
- Restore the cron host architecture as TypeScript in `dimabot`, with a dedicated `dima-cron` container that supervises worker processes.

### Deliverables
- `dimabot/src/workers/cron.index.ts`
- `dimabot/src/workers/follow_ledger.worker.ts`
- `dimabot/src/workers/stream_analytics.worker.ts`
- `dimabot/src/workers/stream_memory.worker.ts`
- `dimabot/src/workers/temporary_roles.worker.ts`
- `dimabot/src/workers/timer.worker.ts`
- Missing worker dependencies under:
  - `dimabot/src/utils/cron_jobs_queue.ts`
  - `dimabot/src/utils/follow_ledger.ts`
  - `dimabot/src/utils/follow_ledger_queue.ts`
  - `dimabot/src/utils/temporary_roles_announcements.ts`
  - `dimabot/src/utils/observability/bot_runtime_metrics.ts`
  - `dimabot/src/utils/ai/threading/*`
  - `dimabot/src/utils/ai/memory/*`
  - `dimabot/src/utils/qdrant/collections/twitch/memory.qdrant.collection.ts`
  - `dimabot/src/utils/qdrant/functions/memory/*`
  - `dimabot/src/schemas/channel_ai_memory.schema.ts`
  - `dimabot/src/schemas/follow_relationship_ledger.schema.ts`
  - `dimabot/src/schemas/site_analytics.schema.ts`
  - `dimabot/src/schemas/temporary_moderator.schema.ts`
- docker compose:
  - Update `dimabot/docker-compose.yaml` to include `dima-cron` and remove/move `dev-bot`.
  - Add `dimabot/docker-compose.dev.yaml` to hold `dev-bot` and (optional) `dima-cron` dev watch.

### Definition of Done (verifiable)
- `npm -C dimabot run build` exits 0.
- These files exist after build:
  - `dimabot/dist/workers/cron.index.js`
  - `dimabot/dist/workers/follow_ledger.worker.js`
  - `dimabot/dist/workers/stream_analytics.worker.js`
  - `dimabot/dist/workers/stream_memory.worker.js`
  - `dimabot/dist/workers/temporary_roles.worker.js`
  - `dimabot/dist/workers/timer.worker.js`
- `docker compose -f dimabot/docker-compose.yaml config` exits 0.
- `docker compose -f dimabot/docker-compose.yaml config` shows services exactly: `api-server`, `chat-bot`, `dima-cron`.

### Must Have
- Parity-first: keep env vars / locks / queue keys consistent with reference JS.
- NodeNext/ESM correctness: `.js` specifiers in TS imports; no `require`.
- Cron supervisor spawns and restarts workers (self-healing) like reference.
- Compose adds `dima-cron` running `node dist/workers/cron.index.js`.
- CI-safe smoke mode: cron supervisor + each worker supports `--dry-run` (NO external I/O: no DB/cache/Twitch/Qdrant connections or writes).

### Must NOT Have
- No renaming of Redis keys / job names / env vars during this port.
- No running worker logic inside `api-server` (except explicitly gated).
- Do not move clip/speech queue processing out of `api-server` (tightly coupled to Socket.IO in `dimabot/src/server/websocket.ts`).
- No path aliases requiring runtime loaders.
- No additional compose services in base file besides the required three.

## Verification Strategy
> Primary: build + artifact presence + compose config validation.
> Secondary (optional, mutating): run `dima-cron` against a dev database after explicit user approval.

- Test decision: tests-after (no existing automated tests assumed).
- Evidence files written by executor:
  - `.sisyphus/evidence/task-*-build.txt`
  - `.sisyphus/evidence/task-*-compose-config.txt`
  - `.sisyphus/evidence/task-*-cron-smoke.txt`

## Execution Strategy
### Parallel Execution Waves
Wave 1: Compose + supervisor scaffolding + common utilities boundaries
Wave 2: Follow ledger + timer + temp roles dependencies + workers
Wave 3: Stream analytics worker + remove/gate inline analytics
Wave 4: Stream memory system + worker (largest dependency surface)

### Dependency Matrix
- Compose wiring depends on: cron supervisor entrypoint exists in dist.
- cron supervisor depends on: worker entrypoints exist and are buildable.
- Each worker depends on: its specific utils/schemas.

## TODOs
> Implementation + verification is one task.

- [x] 1. Update docker-compose base + create dev override

  **What to do**:
  - Edit `dimabot/docker-compose.yaml` so it contains exactly `api-server`, `chat-bot`, `dima-cron` under `services:`.
  - Under each `build:` block, add `dockerfile: dockerfile` (the repo uses lowercase `dimabot/dockerfile`).
  - Add `dima-cron` service:
    - `container_name: dima-cron`
    - `command: node dist/workers/cron.index.js`
    - `restart: always`
    - `env_file: .env`
    - `build.args` should follow the existing pattern (Decision): `SERVICE_NAME=cron`, `NODE_ENV=production`
    - attach to existing external networks `web-proxy` and `databases`
  - Remove `dev-bot` from the base file.
  - Add new file `dimabot/docker-compose.dev.yaml` containing the old `dev-bot` block (and optionally a dev `dima-cron` that runs `npm run cron:dev` with volumes).
  - Add `stop_grace_period` for `dima-cron` (recommended 30s) so workers can shutdown.

  **Must NOT do**:
  - Do not change `api-server` and `chat-bot` production commands.
  - Do not introduce additional required base services.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: focused YAML edits.
  - Skills: [`git-master`] — commit splitting + safe diffs.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [9] | Blocked By: [2]

  **References**:
  - Existing compose: `dimabot/docker-compose.yaml`
  - Dockerfile path: `dimabot/dockerfile`

  **Acceptance Criteria**:
  - [ ] `docker compose -f dimabot/docker-compose.yaml config` exits 0
  - [ ] Output includes only services: `api-server`, `chat-bot`, `dima-cron`

  **QA Scenarios**:
  ```
  Scenario: Compose validates
    Tool: Bash
    Steps: docker compose -f dimabot/docker-compose.yaml config
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-1-compose-config.txt
  
  Scenario: Dev override validates
    Tool: Bash
    Steps: docker compose -f dimabot/docker-compose.yaml -f dimabot/docker-compose.dev.yaml config
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-1-compose-dev-config.txt
  ```

  **Commit**: YES | Message: `chore(cron): add dima-cron service and dev override` | Files: [`dimabot/docker-compose.yaml`, `dimabot/docker-compose.dev.yaml`]

- [x] 2. Port cron supervisor entrypoint to TypeScript

  **What to do**:
  - Create `dimabot/src/workers/cron.index.ts` as a parity port of `olddimabot/dist/workers/cron.index.js`.
  - At the very top (before any other imports), load env files exactly like `dimabot/src/server/index.ts`:
    - if `process.env.NODE_ENV !== 'production'`, load `.env.local`
    - always load `.env`
  - Keep env vars:
    - `CRON_WORKER_RESTART_DELAY_MS`
    - `CRON_WORKER_RUNTIME` (tsx|node)
  - Keep WORKERS list exactly: follow-ledger, stream-analytics, stream-memory, temporary-roles, timer.
  - For `CRON_WORKER_RUNTIME=tsx`, document/ensure supervisor is started via `npm run cron:dev` so `tsx` is on PATH.
  - On SIGINT/SIGTERM: mark shutting down, SIGTERM children, wait (up to ~5s), then exit.
  - Keep restart behavior parity:
    - default restart delay is 5000ms
    - enforce minimum restart delay of 1000ms

  **Must NOT do**:
  - Do not change child env injection keys: `CRON_SUPERVISOR`, `CRON_WORKER_NAME`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: NodeNext/ESM + child_process correctness.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [9] | Blocked By: []

  **References**:
  - Reference supervisor: `olddimabot/dist/workers/cron.index.js`
  - TS module style: `dimabot/tsconfig.json`, `dimabot/src/server/index.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/cron.index.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Supervisor compiles to dist
    Tool: Bash
    Steps: npm -C dimabot run build; test -f dimabot/dist/workers/cron.index.js
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-2-build.txt
  ```

  **Commit**: YES | Message: `feat(cron): add cron supervisor entrypoint` | Files: [`dimabot/src/workers/cron.index.ts`]


- [x] 3. Add npm scripts for cron supervisor (dev + prod)

  **What to do**:
  - Edit `dimabot/package.json` scripts:
    - Add `cron:dev`: `cross-env NODE_ENV=development CRON_WORKER_RUNTIME=tsx tsx src/workers/cron.index.ts`
    - Add `cron:prod`: `cross-env NODE_ENV=production CRON_WORKER_RUNTIME=node node dist/workers/cron.index.js`
  - Do not remove existing scripts.
  - Ensure scripts work with NodeNext ESM (no `ts-node`).

  **Must NOT do**:
  - Do not add new dependencies.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: small JSON edit.
  - Skills: [`git-master`] — atomic commits.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [1] | Blocked By: [2]

  **References**:
  - Existing scripts: `dimabot/package.json`

  **Acceptance Criteria**:
  - [ ] `node -e "const p=require('./dimabot/package.json'); console.log(Boolean(p.scripts['cron:dev']&&p.scripts['cron:prod']))"` prints `true`

  **QA Scenarios**:
  ```
  Scenario: Scripts present
    Tool: Bash
    Steps: node -e "const p=require('./dimabot/package.json'); if(!p.scripts['cron:dev']||!p.scripts['cron:prod']) process.exit(1);"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-3-scripts.txt
  ```

  **Commit**: YES | Message: `chore(cron): add cron supervisor scripts` | Files: [`dimabot/package.json`]

- [x] 4. Port cron queue utilities (dedupe + serialization)

  **What to do**:
  - Create `dimabot/src/utils/cron_jobs_queue.ts` as a parity port of `olddimabot/dist/utils/cron_jobs_queue.js`.
  - Preserve constants and env var:
    - `CRON_JOBS_QUEUE_KEY`, `CRON_JOBS_DEAD_LETTER_KEY`, `CRON_JOBS_DEDUPE_PREFIX`
    - `CRON_JOBS_DEDUPE_SECONDS`
  - Export typed functions:
    - `getCronJobDedupeKey(token: string): string`
    - `serializeCronQueueJob(job: CronQueueJob): string`
    - `parseCronQueueJob(payload: string): CronQueueJob | null`
    - `enqueueCronJob(input: EnqueueCronJobInput): Promise<EnqueueCronJobResult>`
    - `clearCronJobDedupeByKey(dedupeKey?: string): Promise<void>`
  - Define `CronQueueJob`, `EnqueueCronJobInput`, `EnqueueCronJobResult` interfaces in the same file (no path aliases).

  **Must NOT do**:
  - Do not change queue key strings.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: TS typing + parity.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [5, 10] | Blocked By: []

  **References**:
  - Reference: `olddimabot/dist/utils/cron_jobs_queue.js`
  - Cache client: `dimabot/src/utils/databases/dragonfly.database.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/cron_jobs_queue.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Build produces cron queue util
    Tool: Bash
    Steps: npm -C dimabot run build; test -f dimabot/dist/utils/cron_jobs_queue.js
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-4-build.txt

  Scenario: parse/serialize round-trip
    Tool: Bash
    Steps: node - <<'NODE'
      import { serializeCronQueueJob, parseCronQueueJob } from './dimabot/dist/utils/cron_jobs_queue.js';
      const job={id:'1',job:'x',requestedAt:new Date().toISOString(),channelID:'123',data:{a:1}};
      const p=parseCronQueueJob(serializeCronQueueJob(job));
      if(!p||p.job!=='x'||p.channelID!=='123') process.exit(1);
    NODE
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-4-roundtrip.txt
  ```

  **Commit**: YES | Message: `feat(cron): add cron queue utilities with types` | Files: [`dimabot/src/utils/cron_jobs_queue.ts`]

- [x] 5. Port Twitch Helix 401-retry helper (worker dependency)

  **What to do**:
  - Create `dimabot/src/utils/twitch_helix_retry.ts` as a parity port of `olddimabot/dist/utils/twitch_helix_retry.js`.
  - Preserve function names/exports:
    - `executeHelixRequestWith401Retry`
    - `executeHelixAppRequestWith401Retry`
    - `executeHelixBotRequestWith401Retry`
    - `executeHelixStreamerRequestWith401Retry`
  - Type headers as `Record<string, string>` (or a narrow interface), matching existing `dimabot/src/utils/header.ts` outputs.

  **Must NOT do**:
  - Do not change retry delays default `[1000, 3000, 5000]`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: correct typing and error handling.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6] | Blocked By: []

  **References**:
  - Reference: `olddimabot/dist/utils/twitch_helix_retry.js`
  - Headers: `dimabot/src/utils/header.ts`
  - Logger: `dimabot/src/utils/logger.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/twitch_helix_retry.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/twitch_helix_retry.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-5-load.txt
  
  Scenario: Does not crash without env
    Tool: Bash
    Steps: node - <<'NODE'
      import { executeHelixRequestWith401Retry } from './dimabot/dist/utils/twitch_helix_retry.js';
      const res = await executeHelixRequestWith401Retry({
        worker:'test', operation:'noop',
        executeRequest: async()=> new Response(null,{status:200}),
        onUnauthorized: async()=>{},
      });
      if(res.status!==200) process.exit(1);
    NODE
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-5-noop.txt
  ```

  **Commit**: YES | Message: `feat(cron): add Helix 401 retry helper` | Files: [`dimabot/src/utils/twitch_helix_retry.ts`]

- [x] 6. Port follow ledger data model (schema) for worker parity

  **What to do**:
  - Create `dimabot/src/schemas/follow_relationship_ledger.schema.ts` parity port of `olddimabot/dist/schemas/follow_relationship_ledger.schema.js`.
  - Include a TypeScript interface for the document shape (at minimum fields used by `follow_ledger.ts`).
  - Keep indexes and unique partial index.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: mongoose typing + indexes.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [7] | Blocked By: []

  **References**:
  - Reference schema: `olddimabot/dist/schemas/follow_relationship_ledger.schema.js`
  - Existing schema style: `dimabot/src/schemas/vip.schema.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/schemas/follow_relationship_ledger.schema.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Schema module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/schemas/follow_relationship_ledger.schema.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-6-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): add follow relationship ledger schema` | Files: [`dimabot/src/schemas/follow_relationship_ledger.schema.ts`]


- [x] 7. Port follow ledger utilities + enqueue API

  **What to do**:
  - Create `dimabot/src/utils/follow_ledger.ts` parity port of `olddimabot/dist/utils/follow_ledger.js`.
  - Ensure all imports use `.js` specifiers.
  - Preserve exported functions:
    - `recordFollowLedgerStart(input)`
    - `getFollowLedgerSyncChannelIDs()`
    - `syncFollowLedgerForChannel(channelID, options?)`
  - Preserve behavioral contracts:
    - bulk writes in chunks (`DEFAULT_BATCH_SIZE=250`)
    - transaction fallback when replica set not available
    - mutual reconciliation
  - Define TS interfaces for:
    - Helix follower/followed payload items used (`user_id`, `user_login`, `user_name`, `followed_at`, etc.)
    - `FollowLedgerSyncOptions` (`beforeFollowersRequest`, `beforeFollowingRequest`, `writeBatchSize`)
    - `FollowLedgerSyncResult` (fields returned at end of `syncFollowLedgerForChannel`)
  - Create `dimabot/src/utils/follow_ledger_queue.ts` parity port of `olddimabot/dist/utils/follow_ledger_queue.js`.
    - Preserve constants: `FOLLOW_LEDGER_JOB_NAME`, `FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX`, env `FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS`.
    - Export: `getFollowLedgerDedupeKey(channelID)`, `enqueueFollowLedgerSyncJob(channelID, reason?, requestedBy?)`.

  **Must NOT do**:
  - Do not change job name `follow-ledger-sync`.
  - Do not change dedupe token format.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: large port + types.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [4, 5, 6]

  **References**:
  - Reference util: `olddimabot/dist/utils/follow_ledger.js`
  - Reference queue: `olddimabot/dist/utils/follow_ledger_queue.js`
  - Schema: `olddimabot/dist/schemas/follow_relationship_ledger.schema.js`
  - Retry helper: `olddimabot/dist/utils/twitch_helix_retry.js`
  - Users: `dimabot/src/schemas/users.schema.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/follow_ledger.js` exits 0
  - [ ] `test -f dimabot/dist/utils/follow_ledger_queue.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Modules load
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "Promise.all([import('./dimabot/dist/utils/follow_ledger.js'), import('./dimabot/dist/utils/follow_ledger_queue.js')]).then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-7-load.txt

  Scenario: enqueueFollowLedgerSyncJob builds payload
    Tool: Bash
    Steps: node - <<'NODE'
      import { enqueueFollowLedgerSyncJob } from './dimabot/dist/utils/follow_ledger_queue.js';
      // This will attempt to connect to Dragonfly; run only if Dragonfly reachable.
      // If not reachable, treat failure as infrastructure, not module issue.
      console.log(typeof enqueueFollowLedgerSyncJob);
    NODE
    Expected: prints 'function'
    Evidence: .sisyphus/evidence/task-7-enqueue-shape.txt
  ```

  **Commit**: YES | Message: `feat(cron): port follow ledger utils and queue API` | Files: [`dimabot/src/utils/follow_ledger.ts`, `dimabot/src/utils/follow_ledger_queue.ts`]

- [x] 8. Port follow ledger worker entrypoint

  **What to do**:
  - Create `dimabot/src/workers/follow_ledger.worker.ts` parity port of `olddimabot/dist/workers/follow_ledger.worker.js`.
  - At the very top (before any other imports), load env files exactly like `dimabot/src/server/index.ts`.
  - Preserve env vars/keys:
    - `FOLLOW_LEDGER_LOCK_TTL_SECONDS`, `FOLLOW_LEDGER_REQUEST_DELAY_MS`, `FOLLOW_LEDGER_WRITE_BATCH_SIZE`, `FOLLOW_LEDGER_CHANNEL_LOCK_SECONDS`, `FOLLOW_LEDGER_QUEUE_BLOCK_TIMEOUT_SECONDS`, `FOLLOW_LEDGER_RUN_ON_START`
    - lock keys: `worker:follow-ledger:daily:lock`, `cron:follow-ledger:running`
    - queue keys from cron queue util: `CRON_JOBS_QUEUE_KEY`, `CRON_JOBS_DEAD_LETTER_KEY`
  - Preserve behavior:
    - daily UTC midnight sweep scheduling
    - queue consumer loop with BLPOP and requeue on contention
  - Add CLI flags (Decision):
    - `--once` (existing semantics)
    - `--dry-run` (new): NO external I/O (no DB/cache/Twitch calls, no queue consumption). Only parse config, log, and exit 0.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: worker lifecycle + locking.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [2, 19] | Blocked By: [4, 7]

  **References**:
  - Reference worker: `olddimabot/dist/workers/follow_ledger.worker.js`
  - Logger: `dimabot/src/utils/logger.ts`
  - Dragonfly: `dimabot/src/utils/databases/dragonfly.database.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/follow_ledger.worker.js` exits 0
  - [ ] `node dimabot/dist/workers/follow_ledger.worker.js --dry-run --once` exits 0 (no external I/O by design)

  **QA Scenarios**:
  ```
  Scenario: Worker compiles
    Tool: Bash
    Steps: npm -C dimabot run build; test -f dimabot/dist/workers/follow_ledger.worker.js
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-8-build.txt

  Scenario: Dry-run once exits clean
    Tool: Bash
    Steps: node dimabot/dist/workers/follow_ledger.worker.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-8-dryrun.txt
  ```

  **Commit**: YES | Message: `feat(cron): add follow ledger worker` | Files: [`dimabot/src/workers/follow_ledger.worker.ts`]

- [x] 9. Port stream analytics worker + disable inline analytics in API server

  **What to do**:
  - Create `dimabot/src/workers/stream_analytics.worker.ts` parity port of `olddimabot/dist/workers/stream_analytics.worker.js`.
    - At the very top (before any other imports), load env files exactly like `dimabot/src/server/index.ts`.
    - Preserve env vars: `STREAM_ANALYTICS_INTERVAL_MS`, `STREAM_ANALYTICS_RUN_ON_START`, `STREAM_ANALYTICS_WORKER_LOCK_KEY`, `STREAM_ANALYTICS_WORKER_LOCK_TTL_SECONDS`, `STREAM_ANALYTICS_WORKER_LOCK_RETRY_MS`.
    - Keep `--once` and add `--dry-run` (new): NO external I/O; do not connect to DB/cache; do not call `collectLiveViewerSnapshots` / `reconcileLiveSessionsOnStartup`.
  - Update `dimabot/src/server/index.ts` to avoid duplicate analytics:
    - Replace the unconditional `reconcileLiveSessionsOnStartup()` + `startStreamAnalyticsWorker()` with an env guard.
    - Decision: new env flag `STREAM_ANALYTICS_INLINE=true` enables inline mode; default is off.
  - Ensure the cron worker remains the source of truth in production.

  **Must NOT do**:
  - Do not change logic inside `dimabot/src/utils/stream_analytics.ts` besides import usage if needed.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: lifecycle + coordination with server startup.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [2] | Blocked By: []

  **References**:
  - Reference worker: `olddimabot/dist/workers/stream_analytics.worker.js`
  - Existing util: `dimabot/src/utils/stream_analytics.ts`
  - API startup: `dimabot/src/server/index.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/stream_analytics.worker.js` exits 0
  - [ ] `node dimabot/dist/workers/stream_analytics.worker.js --dry-run --once` exits 0 (no external I/O)
  - [ ] Built server no longer starts inline analytics by default:
    - `node -e "const fs=require('fs'); const s=fs.readFileSync('dimabot/dist/server/index.js','utf8'); process.exit(s.includes('startStreamAnalyticsWorker(')&&!s.includes('STREAM_ANALYTICS_INLINE')?1:0)"` exits 0

  **QA Scenarios**:
  ```
  Scenario: Worker dry-run once
    Tool: Bash
    Steps: npm -C dimabot run build; node dimabot/dist/workers/stream_analytics.worker.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-9-dryrun.txt

  Scenario: Inline analytics guarded
    Tool: Bash
    Steps: node -e "const fs=require('fs'); const s=fs.readFileSync('dimabot/dist/server/index.js','utf8'); if(s.includes('startStreamAnalyticsWorker(') && !s.includes('STREAM_ANALYTICS_INLINE')) process.exit(1);"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-9-guard.txt
  ```

  **Commit**: YES | Message: `feat(cron): add stream analytics worker and gate inline runner` | Files: [`dimabot/src/workers/stream_analytics.worker.ts`, `dimabot/src/server/index.ts`]

- [x] 10. Port temporary role announcements utility + live-status helper

  **What to do**:
  - Create `dimabot/src/utils/temporary_roles_announcements.ts` parity port of `olddimabot/dist/utils/temporary_roles_announcements.js`.
    - Preserve key prefix `twitch:temporary-roles:pending-announcements` and TTL.
    - Export `enqueueTemporaryRoleRemovalAnnouncement()` and `flushTemporaryRoleRemovalAnnouncements()`.
  - Do NOT implement `getCachedLiveStatus` here; it is handled in Task 12 as part of the full `siteanalytics.ts` parity port.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: parity with cache keys.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: []

  **References**:
  - Reference util: `olddimabot/dist/utils/temporary_roles_announcements.js`
  - Live-status reference (used later): `olddimabot/dist/utils/siteanalytics.js`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/temporary_roles_announcements.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/temporary_roles_announcements.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-10-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): add temporary role announcement queue` | Files: [`dimabot/src/utils/temporary_roles_announcements.ts`]

- [x] 11. Add temporary moderator schema + port temporary roles worker

  **What to do**:
  - Create `dimabot/src/schemas/temporary_moderator.schema.ts` parity port of `olddimabot/dist/schemas/temporary_moderator.schema.js`.
  - Create `dimabot/src/workers/temporary_roles.worker.ts` parity port of `olddimabot/dist/workers/temporary_roles.worker.js`.
  - At the very top of `temporary_roles.worker.ts` (before any other imports), load env files exactly like `dimabot/src/server/index.ts`.
  - Preserve env vars: `TEMPORARY_ROLES_INTERVAL_MS`, `TEMPORARY_ROLES_BATCH_SIZE`, `TEMPORARY_ROLES_WORKER_LOCK_KEY`, `TEMPORARY_ROLES_WORKER_LOCK_TTL_SECONDS`, `TEMPORARY_ROLES_WORKER_LOCK_RETRY_MS`, `TEMPORARY_ROLES_RUN_ON_START`.
  - Add `--dry-run` support:
    - NO external I/O: do not connect to DB/cache
    - do not call `removeChannelVIP` / `removeChannelModerator`
    - do not delete DB documents
    - do not send chat announcements
    - log only and exit 0

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [2] | Blocked By: [10, 12]

  **References**:
  - Reference worker: `olddimabot/dist/workers/temporary_roles.worker.js`
  - Reference schema: `olddimabot/dist/schemas/temporary_moderator.schema.js`
  - Existing VIP schema: `dimabot/src/schemas/vip.schema.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/temporary_roles.worker.js` exits 0
  - [ ] `node dimabot/dist/workers/temporary_roles.worker.js --dry-run --once` exits 0

  **QA Scenarios**:
  ```
  Scenario: Dry-run once exits
    Tool: Bash
    Steps: npm -C dimabot run build; node dimabot/dist/workers/temporary_roles.worker.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-11-dryrun.txt
  ```

  **Commit**: YES | Message: `feat(cron): add temporary roles worker` | Files: [`dimabot/src/schemas/temporary_moderator.schema.ts`, `dimabot/src/workers/temporary_roles.worker.ts`]


- [x] 12. Port site analytics persistence + live channels board (dependency for getCachedLiveStatus)

  **What to do**:
  - Create `dimabot/src/schemas/site_analytics.schema.ts` parity port of `olddimabot/dist/schemas/site_analytics.schema.js`.
  - Refactor/upgrade `dimabot/src/utils/siteanalytics.ts` to parity port of `olddimabot/dist/utils/siteanalytics.js`:
    - Preserve cache keys: `site:analytics:channels`, `site:analytics:live:channels`, `site:analytics:profile:*`
    - Preserve functions: `startSiteAnalytics()`, `getSiteAnalytics()`, `incrementSiteAnalytics()`, `decrementSiteAnalytics()`, `getCachedLiveStatus()`.
    - Include: persistence worker (hourly) + live channels refresh worker (15s) using `executeHelixAppRequestWith401Retry`.
  - If TS already has a simplified `startSiteAnalytics`, keep backward compatibility by re-exporting it or preserving function name.
  - Update `dimabot/src/server/index.ts` to call `await startSiteAnalytics();` during startup (parity with `olddimabot/dist/server/index.js`). Place it after `TwitchStreamers.getTwitchAccountsFromDB()` and after DB/cache clients are initialized.

  **Must NOT do**:
  - Do not change cache key names.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: larger port with DB+cache interactions.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11, 19] | Blocked By: [5]

  **References**:
  - Reference util: `olddimabot/dist/utils/siteanalytics.js`
  - Reference schema: `olddimabot/dist/schemas/site_analytics.schema.js`
  - Existing header/links: `dimabot/src/utils/header.ts`, `dimabot/src/utils/links.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/siteanalytics.js` exits 0
  - [ ] `node -e "import('./dimabot/dist/utils/siteanalytics.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"` exits 0

  **QA Scenarios**:
  ```
  Scenario: Module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/siteanalytics.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-12-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): port site analytics cache + persistence` | Files: [`dimabot/src/schemas/site_analytics.schema.ts`, `dimabot/src/utils/siteanalytics.ts`, `dimabot/src/server/index.ts`]

- [x] 13. Port timer worker entrypoint

  **What to do**:
  - Create `dimabot/src/workers/timer.worker.ts` parity port of `olddimabot/dist/workers/timer.worker.js`.
  - At the very top (before any other imports), load env files exactly like `dimabot/src/server/index.ts`.
  - Preserve env vars: `TIMER_WORKER_INTERVAL_MS`, `TIMER_WORKER_RUN_ON_START`, `TIMER_WORKER_LOCK_KEY`, `TIMER_WORKER_LOCK_TTL_SECONDS`, `TIMER_WORKER_LOCK_RETRY_MS`.
  - Preserve Redis key contracts:
    - `timer:active` (set of channel IDs)
    - `timer:channel:${channelID}:timers` (hash of timer JSON by timer ID)
    - `timer:channel:${channelID}:heartbeat:${timerID}` (string counter)
  - Add `--dry-run` support:
    - NO external I/O: do not connect to DB/cache
    - do not call `sendTwitchChatMessage`
    - do not write heartbeats
    - (optional) still exercise pure parsing paths then exit 0

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: parity + recursion safety.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [2] | Blocked By: []

  **References**:
  - Reference worker: `olddimabot/dist/workers/timer.worker.js`
  - Command handler: `dimabot/src/handlers/commands.handler.ts`
  - Chat send: `dimabot/src/functions/chats/send_message.chat.ts`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/timer.worker.js` exits 0
  - [ ] `node dimabot/dist/workers/timer.worker.js --dry-run --once` exits 0

  **QA Scenarios**:
  ```
  Scenario: Dry-run once starts
    Tool: Bash
    Steps: npm -C dimabot run build; node dimabot/dist/workers/timer.worker.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-13-dryrun.txt
  ```

  **Commit**: YES | Message: `feat(cron): add timer worker` | Files: [`dimabot/src/workers/timer.worker.ts`]

- [x] 14. Port bot runtime metrics (observability) utility

  **What to do**:
  - Create `dimabot/src/utils/observability/bot_runtime_metrics.ts` parity port of `olddimabot/dist/utils/observability/bot_runtime_metrics.js`.
  - Preserve env vars and key naming:
    - `BOT_METRICS_HISTORY_LIMIT`, `BOT_METRICS_INTERVAL_MS`, `BOT_METRICS_PREFIX`, `BOT_METRICS_TTL_SECONDS`
  - Export the same functions used by workers:
    - `recordStreamMemoryJobMetric`, `recordStreamMemoryActionMetric`, `recordSemanticMemoryMetric`, `recordThreadRoutingMetric`
    - plus runtime-loop helpers used by bot/server if present.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: large TS port + perf_hooks typing.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [18, 19] | Blocked By: []

  **References**:
  - Reference: `olddimabot/dist/utils/observability/bot_runtime_metrics.js`

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/observability/bot_runtime_metrics.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/observability/bot_runtime_metrics.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-14-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): port bot runtime metrics` | Files: [`dimabot/src/utils/observability/bot_runtime_metrics.ts`]

- [x] 15. Port AI threading utilities

  **What to do**:
  - Create directory `dimabot/src/utils/ai/threading/` and port files from:
    - `olddimabot/dist/utils/ai/threading/thread_limits.js`
    - `olddimabot/dist/utils/ai/threading/thread_router.js`
    - `olddimabot/dist/utils/ai/threading/thread_store.js`
    - `olddimabot/dist/utils/ai/threading/thread_types.js`
  - Keep exported APIs identical; add TS types for thread entities and routing result.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [18] | Blocked By: []

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/ai/threading/thread_router.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Threading modules load
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "Promise.all([import('./dimabot/dist/utils/ai/threading/thread_router.js'),import('./dimabot/dist/utils/ai/threading/thread_store.js')]).then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-15-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): port AI threading utilities` | Files: [`dimabot/src/utils/ai/threading/thread_limits.ts`, `dimabot/src/utils/ai/threading/thread_router.ts`, `dimabot/src/utils/ai/threading/thread_store.ts`, `dimabot/src/utils/ai/threading/thread_types.ts`]

- [x] 16. Port Channel AI Memory schema

  **What to do**:
  - Create `dimabot/src/schemas/channel_ai_memory.schema.ts` parity port of `olddimabot/dist/schemas/channel_ai_memory.schema.js`.
  - Include TS union types for:
    - `type`: `preference|running_joke|known_user_fact|channel_lore|boundary`
    - `status`: `candidate|pending_review|confirmed|rejected|archived`
    - `risk`: `low|medium|high`
  - Ensure indexes match.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [17] | Blocked By: []

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/schemas/channel_ai_memory.schema.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Schema module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/schemas/channel_ai_memory.schema.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-16-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): add channel AI memory schema` | Files: [`dimabot/src/schemas/channel_ai_memory.schema.ts`]

- [ ] 17. Port Qdrant memory collection + sync functions

  **What to do**:
  - Create:
    - `dimabot/src/utils/qdrant/collections/twitch/memory.qdrant.collection.ts`
    - `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts`
    - `dimabot/src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts`
  - Parity port from `olddimabot/dist/utils/qdrant/collections/twitch/memory.qdrant.collection.js` and `olddimabot/dist/utils/qdrant/functions/memory/*.js`.
  - Keep vector field names + payload shape; add TS interfaces for Qdrant points.
  - Register new collection in `dimabot/src/config/qdrant/collections.ts` by adding `TwitchMemoryQdrantCollection` (name must match reference) alongside existing `TwitchChatLogsQdrantCollection`.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [18] | Blocked By: []

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/qdrant/functions/memory/sync_memory.qdrant.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Qdrant memory sync module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/qdrant/functions/memory/sync_memory.qdrant.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-17-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): port qdrant memory collection + sync` | Files: [`dimabot/src/utils/qdrant/collections/twitch/memory.qdrant.collection.ts`, `dimabot/src/utils/qdrant/functions/memory/sync_memory.qdrant.ts`, `dimabot/src/utils/qdrant/functions/memory/retrieve_memory_context.qdrant.ts`, `dimabot/src/config/qdrant/collections.ts`]

- [ ] 18. Port AI memory utilities (service + runner + queue)

  **What to do**:
  - Create directory `dimabot/src/utils/ai/memory/` and port the following from `olddimabot/dist/utils/ai/memory/`:
    - `index.js`
    - `memory.service.js`
    - `memory_extractor.js`
    - `stream_memory_apply.js`
    - `stream_memory_queue.js`
    - `stream_memory_runner.js`
    - `stream_summary_context.js`
    - `stream_summary_decider.js`
  - Keep exported functions and job constants used by the worker:
    - `STREAM_MEMORY_QUEUE_KEY`, `STREAM_MEMORY_DEAD_LETTER_KEY`
    - `STREAM_MEMORY_SUMMARY_JOB`, `STREAM_MEMORY_WEEKLY_JOB`, `STREAM_MEMORY_MONTHLY_JOB`
    - `enqueueMemoryMaintenanceJob`, `getWeeklyMaintenancePeriodToken`, `getMonthlyMaintenancePeriodToken`
    - `runStreamMemoryWorkflow`
  - Add TypeScript interfaces for all public function inputs/outputs; no `any`.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [19] | Blocked By: [14, 15, 16, 17]

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/utils/ai/memory/stream_memory_runner.js` exits 0

  **QA Scenarios**:
  ```
  Scenario: Memory runner module loads
    Tool: Bash
    Steps: npm -C dimabot run build; node -e "import('./dimabot/dist/utils/ai/memory/stream_memory_runner.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-18-load.txt
  ```

  **Commit**: YES | Message: `feat(cron): port AI memory utilities` | Files: [`dimabot/src/utils/ai/memory/*`]

- [ ] 19. Port stream memory worker entrypoint

  **What to do**:
  - Create `dimabot/src/workers/stream_memory.worker.ts` parity port of `olddimabot/dist/workers/stream_memory.worker.js`.
  - At the very top (before any other imports), load env files exactly like `dimabot/src/server/index.ts`.
  - Preserve env vars and schedule behavior:
    - `STREAM_MEMORY_WORKER_LOCK_KEY`, `STREAM_MEMORY_WORKER_LOCK_TTL_SECONDS`, `STREAM_MEMORY_WORKER_LOCK_RETRY_MS`
    - `STREAM_MEMORY_CHANNEL_LOCK_PREFIX`, `STREAM_MEMORY_CHANNEL_LOCK_SECONDS`
    - `STREAM_MEMORY_QUEUE_BLOCK_TIMEOUT_SECONDS`, `STREAM_MEMORY_RUN_ON_START`
    - `STREAM_MEMORY_JOB_MAX_ATTEMPTS`, `STREAM_MEMORY_REQUEUE_DELAY_MS`
    - weekly/monthly UTC schedule env vars
  - Add `--dry-run`:
    - NO external I/O: do not connect to DB/cache
    - do not enqueue jobs and do not call `runStreamMemoryWorkflow`
    - validate scheduling calculations then exit 0

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [2] | Blocked By: [4, 18]

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `test -f dimabot/dist/workers/stream_memory.worker.js` exits 0
  - [ ] `node dimabot/dist/workers/stream_memory.worker.js --dry-run --once` exits 0

  **QA Scenarios**:
  ```
  Scenario: Worker dry-run once
    Tool: Bash
    Steps: npm -C dimabot run build; node dimabot/dist/workers/stream_memory.worker.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-19-dryrun.txt
  
  Scenario: Worker artifact exists
    Tool: Bash
    Steps: test -f dimabot/dist/workers/stream_memory.worker.js
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-19-artifact.txt
  ```

  **Commit**: YES | Message: `feat(cron): add stream memory worker` | Files: [`dimabot/src/workers/stream_memory.worker.ts`]

- [ ] 20. Add supervisor dry-run/once orchestration for CI-safe smoke testing

  **What to do**:
  - Extend `dimabot/src/workers/cron.index.ts`:
    - If supervisor argv includes `--dry-run`, append `--dry-run` to worker child args.
    - If supervisor argv includes `--once`, append `--once` to worker child args and DO NOT restart workers on exit; exit 0 after all workers exit (exit 1 if any worker exit code != 0).
  - Document these flags in `dimabot/README.md` (cron section).
  - Ensure `--dry-run` implies NO external I/O in workers (see Must Have).

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [1] | Blocked By: [2, 8, 9, 11, 13, 19]

  **Acceptance Criteria**:
  - [ ] `npm -C dimabot run build` exits 0
  - [ ] `node dimabot/dist/workers/cron.index.js --dry-run --once` exits 0 (no external I/O)

  **QA Scenarios**:
  ```
  Scenario: Supervisor dry-run once completes
    Tool: Bash
    Steps: npm -C dimabot run build; node dimabot/dist/workers/cron.index.js --dry-run --once
    Expected: exit code 0
    Evidence: .sisyphus/evidence/task-20-supervisor-once.txt
  ```

  **Commit**: YES | Message: `test(cron): add supervisor --once/--dry-run smoke mode` | Files: [`dimabot/src/workers/cron.index.ts`, `dimabot/README.md`]


## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Runtime Smoke QA (non-destructive) — unspecified-high
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Split commits by subsystem (compose, supervisor, each worker+deps, memory system).
- No pushing to remote without explicit permission.

## Success Criteria
- Base compose has exactly 3 services and validates.
- `npm run build` passes and produces `dist/workers/*.js` for supervisor + 5 workers.
- Cron supervisor can start in container (at minimum, module-load smoke without crashes).
