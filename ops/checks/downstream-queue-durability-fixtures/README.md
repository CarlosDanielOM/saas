# Downstream Queue Durability Candidate Check

`ops/checks/downstream-queue-durability.mjs` exercises the exact API or cron candidate with disposable MongoDB and Dragonfly dependencies. Run it only through `scripts/saas-ops verify`; do not invoke the script directly or point it at a live service. The check retains an optional bot environment branch for a future bot producer, but no bot caller is changed or covered for the current release.

## Exact candidate workflow

From the repository root, create, verify, deploy, and clean up a separate run for each current release target. Use the run ID printed for that target and its matching environment file:

```bash
scripts/saas-ops list

scripts/saas-ops plan cron
scripts/saas-ops build cron
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/downstream-queue-durability-fixtures/cron-env.json \
  --fixtures ops/checks/downstream-queue-durability-fixtures \
  --check ops/checks/downstream-queue-durability.mjs
scripts/saas-ops deploy cron-<run-id>
scripts/saas-ops cleanup cron-<run-id>

scripts/saas-ops plan api
scripts/saas-ops build api
scripts/saas-ops verify api-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/downstream-queue-durability-fixtures/api-env.json \
  --fixtures ops/checks/downstream-queue-durability-fixtures \
  --check ops/checks/downstream-queue-durability.mjs
scripts/saas-ops deploy api-<run-id>
scripts/saas-ops cleanup api-<run-id>
```

Follow the current rollout order: cron consumers first, then the API producer. Use each candidate's exact run ID through verify, deploy, rollback, and cleanup. Do not run the new API producer with an old cron consumer. The bot retains its current image and is not built, verified, deployed, or rolled back for this release. If future code adds bot callers for these queues, `bot-env.json` remains available for a separately scoped candidate check; that future branch is not current release evidence.

## Isolation and environment safeguards

- `--dependency mongo --dependency redis` starts the helper's disposable database and Dragonfly on an isolated internal network with `mongo` and `redis` aliases. The helper does not connect them to production networks or volumes.
- The JSON env files use only the disposable Mongo URI (`saas_ops_downstream_durability_test`), `DRAGONFLY_HOST=redis`, dummy credentials, and `SAAS_DISPOSABLE_DOWNSTREAM_CHECK=yes`. The check refuses another Mongo database, a non-disposable flag, or a target mismatch. It does not load production `.env` files.
- `providers.mjs` is copied by `--fixtures` to `/tmp/saas-fixtures`. It supplies fixture responses, blocks non-local external requests, and permits only the check's loopback readiness requests. No real Twitch, Qdrant, Polar, email, or AI provider calls are intended.
- **Only the API check and the optional future bot branch call `FLUSHDB`, and only after validating the helper's disposable `redis` alias and disposable-check flag. Never point those checks at any other Redis/Dragonfly.** The cron check does not call `FLUSHDB`: its actual workers share their disposable test Redis, so it seeds narrow queue/intent fixtures and relies on ordinary bounded pending-intent recovery.
- Do not manually run the check outside `saas-ops verify`; its environment assertions are defense in depth, not a substitute for the helper's isolated network and storage.

## Coverage and limits

The API and cron checks cover actual Mongo intent writes and Redis Lua publication, duplicate acceptance, permanent automatic acceptance, queue-only loss recovery, lost replies before and after Redis accepted a publish, a separate-process recovery pass, retry scheduling, legacy marker preservation and payload adoption, one-winner claim fencing, expired processing becoming terminal `uncertain`, dead/completed work not replaying, and bounded recovery past future-due or blocked rows.

The API fixture performs full Redis loss only on its disposable Dragonfly dependency and proves that Mongo retains the two pending intent payloads and republishes them after they become due. The exact API candidate also passed this full-loss check with its marker-guarded `FLUSHDB`. Cron fixtures do not flush Redis. They run the actual candidate supervisor with only the stream-memory and clip-recommendation workers enabled for the behavior check. Coverage includes default startup/periodic pending recovery of a Mongo-only memory intent, a memory job disabled by channel settings (which completes without provider work), a fully completed clip job that is duplicate-suppressed without reanalysis, and a stale clip job dead-lettered without creating a recommendation. The exact cron candidate passed these fixtures, the supplemental lifecycle/offline handoff check, and a separate concurrency check: 32 simultaneous acceptances, publications, and claims yielded one Mongo intent, one queue payload, and one owner, with no completed replay. The lifecycle check also covered snapshot/offline behavior, durable acceptance receipts, duplicate suppression, and explicit legacy repair; it is documented with its own fixtures at [`event-pipeline-recovery-fixtures`](../event-pipeline-recovery-fixtures/README.md). Post-deployment startup and health checks for the workers passed; see the [release record](../../../migration-notes/downstream-queue-durability.md).

For the concurrency fixture, use a separate verification on the same exact cron candidate with the same isolated Mongo/Dragonfly dependencies and cron environment:

```bash
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/downstream-queue-durability-fixtures/cron-env.json \
  --fixtures ops/checks/downstream-queue-durability-fixtures \
  --check ops/checks/downstream-queue-concurrency.mjs
```

The offline-event and lifecycle handoff uses its separately named disposable database and fixtures. Follow its [candidate-check README](../event-pipeline-recovery-fixtures/README.md) and run `ops/checks/event-pipeline-recovery.mjs` against the exact cron candidate. The API and cron candidates passed their isolated checks and were then deployed and production-checked; see the [release record](../../../migration-notes/downstream-queue-durability.md) for image IDs, readbacks, and cleanup evidence. No bot candidate check was needed or performed for this release.

The fixture is finite and synthetic. It does not establish production queue volume/performance, provider behavior, exactly-once external effects, or recovery for every cron queue. An expired `processing` claim remains uncertain because the external effect may already have happened; the check must not requeue it automatically.

## Lua test tooling

The source regression fixtures use the pinned dev dependency `lua-redis-wasm@1.5.0`, executing Redis Lua 5.1 in WASM. Node.js 22 or newer and development dependencies are required. From the repository root, install with `npm ci --include=dev --prefix dimabot`; the service-free suite then runs with:

```bash
node dimabot/src/scripts/test_domain_pipeline.script.mjs
```

The WASM fixture mocks Redis commands. It does not replace the candidate check's disposable Dragonfly verification.
