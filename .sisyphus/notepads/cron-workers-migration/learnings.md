
- `docker compose config` fails if `env_file: .env` missing; created empty `dimabot/.env` locally to satisfy verification.
- `python` is not installed in this environment; prefer `node -e` or shell tools for quick YAML inspection.
- TypeScript supervisor port: Use `node:*` prefixed imports for ESM compatibility. Use `import path from 'node:path'` and `import { spawn } from 'node:child_process'` pattern.
- dotenv loading must happen before any other imports (same pattern as `dimabot/src/server/index.ts`): load `.env.local` in dev mode first, then always load `.env`.
- Build produces output even with pre-existing errors in other files (missing @types/express, @types/multer). Use `npx tsc --skipLibCheck` to isolate file-specific errors.
- `cross-env` and `tsx` are already available as devDependencies in dimabot; no new packages needed for cron scripts.
- Script placement: Group dev/production scripts together for maintainability (placed `cron:dev` and `cron:prod` after `test-bot`, before `build`).

- Import-smoke tests can fail due to module import side-effects:
  - `dimabot/src/utils/crypto.ts` throws at import time if `SECRET_KEY` is unset.
  - Some imports transitively call `getDragonflyClient()` at module load, which attempts to connect to `redis://$DRAGONFLY_HOST:$DRAGONFLY_PORT` and will fail if env/services aren’t set.

- Redis v5 client.set() with { NX: true, EX: seconds } options works in TypeScript - returns "OK" string on success.
- When porting JS to TS: Use `node:*` prefixed imports for built-in modules (e.g., `node:crypto`) for ESM compatibility.
- CronQueueJob.data typed as `Record<string, unknown>` to preserve object-only constraint while allowing any shape.
- Mongoose schema porting pattern: Define TypeScript interface extending document shape, use `new Schema<Interface>({...})`, export `model<Interface>('collection_name', schema)`. Compound indexes defined on schema instance after constructor.

- Porting bot_runtime_metrics.ts: Use `node:perf_hooks` for `monitorEventLoopDelay`. Event loop histogram methods (min, max, mean, percentile, etc.) return nanoseconds and need conversion to millis.
- TypeScript interface pattern: Define input interfaces with optional properties and use `Math.max(0, Math.round(input.field || 0))` pattern for numeric sanitization.
- Node.js internal methods: `_getActiveHandles` and `_getActiveRequests` are not on the standard NodeJS.Process type - need to cast to extended interface for type safety.

- Qdrant collection porting pattern: Use `IQdrantCollectionOptions` interface from `interfaces/qdrant/collections.interface.js`, preserve all payload_indexes and vector config exactly from olddimabot reference. Register in `config/qdrant/collections.ts` array.

- Qdrant function modules should NOT connect at import time - only call `getQdrantConnection()` inside exported async functions. This prevents import-smoke failures when env/services aren't available.

- Qdrant client compatibility: The retrieve function handles multiple client API styles (`query`, `search`, `queryPoints`) for cross-version compatibility. TypeScript interfaces for Qdrant points should be minimal and handle optional fields defensively.

## Runtime Smoke QA Results (2026-03-04)

All workers pass dry-run mode without DB/cache connections. Commands used:

```bash
# Build
npm -C dimabot run build

# Supervisor (spawns all workers)
node dimabot/dist/workers/cron.index.js --dry-run --once
# Result: PASS - all 5 workers started and exited with code 0

# Individual workers
node dimabot/dist/workers/follow_ledger.worker.js --dry-run --once    # PASS
node dimabot/dist/workers/stream_analytics.worker.js --dry-run --once # PASS
node dimabot/dist/workers/temporary_roles.worker.js --dry-run --once  # PASS
node dimabot/dist/workers/timer.worker.js --dry-run --once            # PASS
node dimabot/dist/workers/stream_memory.worker.js --dry-run --once    # PASS
```

Each worker outputs resolved configuration JSON and exits cleanly. No external services required in dry-run mode.
