# DIMA-032 candidate verification fixtures

Source implementation commit: `535508bc`. Source `tsc --noEmit` passed; the baseline/feature command passed39 tests and the final focused command passed25 tests (overlapping coverage). These are source/mock results, not Docker runtime acceptance. Candidate scripts are authored and syntax-checked; the manager must run them against each exact candidate before release. No script here calls production accounts/providers or modifies application configuration/Compose.

Materialize a private fixture directory. No symlinks; do not pass this repository directory directly because the referenced shared mocks must be present:

```bash
DIMA032_FIXTURES=$(mktemp -d /tmp/dima032-fixtures.XXXXXX)
cp ops/checks/dima032-fixtures/providers.mjs "$DIMA032_FIXTURES/"
cp ops/checks/dima032-fixtures/producer.mjs "$DIMA032_FIXTURES/"
cp ops/checks/pet-runtime-fixtures/providers.mjs "$DIMA032_FIXTURES/runtime-providers.mjs"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$DIMA032_FIXTURES/oauth-providers.mjs"
```

The new preload imports the established pet-runtime and OAuth provider mocks. It refuses any Mongo URI outside the disposable `mongo` alias/test database pattern and requires `PIPER_HTTP_URL=http://pet-piper.test`. Only when running the actual packaged API entrypoint does it poll a disposable Redis mailbox, which invokes the real API `ttsQueueHandler` singleton. The mailbox has no production route, feature flag or production code hook. The check process cannot accidentally substitute its own queue singleton. Mock provider calls, TTS usage counters and private media are checked through the real API/Redis/Mongo paths.

After the manager resolves the documented Docker resource boundary and receives any required owner exception, use the executable workflow, retaining the actual returned run ID. Do not run broad Docker commands, a second compilation, or a manual deployment:

```bash
scripts/saas-ops list
scripts/saas-ops plan api
scripts/saas-ops build api
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/dima032-fixtures/api-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-api.mjs
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/dima032-fixtures/api-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-compiled.mjs
```

`dima032-api.mjs` creates disposable owner/image records, then exercises HTTP settings v3, actual Socket.IO pet-only readiness/lease, the API normal queue, dummy synthesis and one usage increment, authorized private WAV retrieval, playback completion, lost start ACK with and without ticket fetch followed by disconnect, no fallback/reconnect replay, true pre-delivery same-file legacy fallback, a pending TTS turn while independent work is active, real Mongo concurrent admissions, skip, and Studio-only elected timing/media delivery. Two Studio scenes deliberately reuse a client ID. Exact scene/client/socket epochs fence media and event reads; generic ACK ordering, wrong-recipient reports, monotonic follow, mandatory-generation end and stale URLs after reconnect are checked. Provider mocks return the same500ms WAV, making same-file assertions deterministic. Source Studio mocks separately cover unknown-duration60000 hints and media progress beyond60seconds; actual long-media/browser checks belong to the site suite and can be extended by the manager if candidate integration identifies a gap.

`dima032-compiled.mjs` runs the packaged source/mock suites from the exact image, serially with no provider preload inherited by test children. It includes credit fallback/control regressions and AST trigger tests. It does not replace the real API integration check.

## Bot and cron admission consumers

`admission.ts` is imported by `utils/ast_parser/functions/pet.functions.ts`. Bot authored command evaluation reaches it through `handlers/commands.handler.ts`; cron event actions reach it through `domain_events/chat_announcement_events.ts` and `workers/domain_events.worker.ts`. These producer targets must receive the schema/settings/reservation gate. The runtime queue, private-audio adapter and Studio executor remain API-owned; no native worker implementation, dependency or scheduling behavior changed.

Use the established pet producer startup mocks for bot/cron, including the narrowly scoped cron boot hook which keeps unrelated workers inert in isolation (the native workers are unchanged). Stage their extra files, retain their original test environment, and select the DIMA-032 behavior check:

```bash
cp ops/checks/pet-producer-fixtures/providers.mjs "$DIMA032_FIXTURES/providers.mjs"
cp ops/checks/pet-producer-fixtures/cron-boot.mjs "$DIMA032_FIXTURES/cron-boot.mjs"
cp ops/checks/pet-producer-fixtures/unit-preload.mjs "$DIMA032_FIXTURES/unit-preload.mjs"
scripts/saas-ops plan bot
scripts/saas-ops build bot
scripts/saas-ops verify bot-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/bot-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-consumers.mjs
scripts/saas-ops plan cron
scripts/saas-ops build cron --rust-cpus 3 --rust-memory-gib 4
scripts/saas-ops verify cron-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/cron-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-consumers.mjs
```

Do not reuse this directory for the API after replacing its preload; create a fresh staged copy if returning to API verification. `dima032-consumers.mjs` runs real packaged AST→admission in separate Node producer processes using an empty local peer map and actual disposable Mongo. Both chat-command and Twitch-event authorities are blocked by the pending normal-TTS reservation. Concurrent independent producers race the real Mongo CAS after release; exactly one wins. Disabling the independent source returns `pet_source_disabled`. No runtime/provider is started by these producers. Compiled AST mocks supplement this actual path.

The parent owns candidate execution, release and production startup/readiness for API/bot/cron. Cron replacement restarts its complete process tree: check all existing worker health after deployment, without expanding isolated behavior retesting to unchanged Rust workers. Preserve each run's rollback artifacts and use helper cleanup on every candidate. Remove only this task's staged directory when no longer needed. No push or deployment was performed by the API worker.
