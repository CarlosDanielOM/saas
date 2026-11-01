# Event pipeline recovery candidate checks

These fixtures replace external Twitch/Qdrant/PostHog boundaries and unrelated cron launches. The real runtime entrypoint, lifecycle and analytics consumers, Mongo writes, Redis scripts, token refresh manager, OAuth callback, and repair script run from the exact candidate. The cron fixture runs the actual domain-event supervisor and the changed stream-analytics worker; unrelated native/TypeScript workers are excluded from this functional check and must still have production startup checked after deployment.

Run from the repository root, replacing the run ID and target with the corresponding helper result:

```bash
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/event-pipeline-recovery-fixtures/cron-env.json \
  --fixtures ops/checks/event-pipeline-recovery-fixtures \
  --check ops/checks/event-pipeline-recovery.mjs
```

Use the matching `api-env.json` or `bot-env.json` for those targets. Disposable database name is fixed to `saas_ops_pipeline_recovery_test`; the check refuses any other name. External network requests are blocked. No live environment, queue, data mount, or credentials are reused.

The check exercises disabled authorization, independent admin refresh, partial retry progress, real encrypted-token refresh against successful/transient/revoked provider responses, reauthorization revision fencing, the actual API OAuth callback, snapshot/offline finalization, downstream deduplication, and dry-run/execute/repeat/refusal behavior for the guarded historical repair. It also runs source-compiled mock regression suites for lifecycle effects, token races, session recovery and the speech stream-end boundary. Lua-dependent mock coverage may be skipped where no interpreter is installed; real enqueue behavior is exercised against disposable Dragonfly.

The broad service-free runner currently has three unrelated fixture failures that reproduce on unchanged HEAD: interaction timestamps in `domain_event_contracts.test.ts`, raid fixture type mapping in that file, and obsolete registry expectations in `domain_event_producers.test.ts`. Other broad failures require the absent standalone Lua interpreter. Those are separate from this change's targeted checks; do not describe the broad suite as passing.
