# DIMA-032 candidate verification fixtures

Final application source freeze: `af33f93889bc7dfcd168c1365f9dfc22305bda44`. Reported source verification is187 passes, zero failures and one explicit actual-Lua skip, plus TypeScript no-emit. Independent source review is accepted; all four final exact-API checks plus bot/cron consumer checks remain required. Prior candidate checks/failures stay archived; source/mock passes do not establish final runtime acceptance or authorize deployment.

Source implementation: initial `535508bc`, corrected/frozen `667a7d62` after independent review. Source `tsc --noEmit` passed; the baseline/feature command passed39 tests and the final focused command passed25 tests (overlapping coverage). The review-fix run passed52 tests and the final focused run passed39 tests after revision/post-ACK safeguards; final `tsc --noEmit` passed. These are source/mock results, not Docker runtime acceptance. Candidate scripts are authored and syntax-checked; the manager must run them against each exact candidate before release. No script here calls production accounts/providers or modifies application configuration/Compose.

Materialize a private fixture directory. No symlinks; do not pass this repository directory directly because the referenced shared mocks must be present:

```bash
DIMA032_FIXTURES=$(mktemp -d /tmp/dima032-fixtures.XXXXXX)
cp ops/checks/dima032-fixtures/providers.mjs "$DIMA032_FIXTURES/"
cp ops/checks/dima032-fixtures/producer.mjs "$DIMA032_FIXTURES/"
cp ops/checks/dima032-fixtures/startup.mjs "$DIMA032_FIXTURES/"
cp ops/checks/pet-runtime-fixtures/providers.mjs "$DIMA032_FIXTURES/runtime-providers.mjs"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$DIMA032_FIXTURES/oauth-providers.mjs"
```

The new preload imports the established pet-runtime and OAuth provider mocks. It refuses any Mongo URI outside the disposable `mongo` alias/test database pattern and requires `PIPER_HTTP_URL=http://pet-piper.test`. Only when running the actual packaged API entrypoint does it poll a disposable Redis mailbox, which invokes the real API `ttsQueueHandler` singleton. The mailbox has no production route, feature flag or production code hook. The check process cannot accidentally substitute its own queue singleton. Mock provider calls, TTS usage counters and private media are checked through the real API/Redis/Mongo paths.

The owner approved the limited DIMA-032 existing-daemon build exception; the manager owns its recorded resource boundary and all candidate execution. Use the executable workflow, retaining the actual returned run ID. Do not run broad Docker commands, a second compilation, or a manual deployment:

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
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/dima032-fixtures/session-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-session-api.mjs
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --test-env ops/checks/dima032-fixtures/session-env.json --fixtures "$DIMA032_FIXTURES" \
  --check ops/checks/dima032-r4-api.mjs
```

`dima032-api.mjs` creates disposable owner/image records, then exercises HTTP settings v3, actual Socket.IO pet-only readiness/lease, the API normal queue, dummy synthesis and one usage increment, authorized private WAV retrieval, playback completion, lost start ACK with and without ticket fetch followed by disconnect, no fallback/reconnect replay, true pre-delivery same-file legacy fallback, a pending TTS turn while independent work is active, real Mongo concurrent admissions, skip, and Studio-only elected timing/media delivery. Two Studio scenes deliberately reuse a client ID. Exact scene/client/socket epochs fence media and event reads; generic ACK ordering, wrong-recipient reports, monotonic follow, mandatory-generation end and stale URLs after reconnect are checked. Provider mocks return the same500ms WAV, making same-file assertions deterministic. Source Studio mocks separately cover unknown-duration60000 hints and media progress beyond60seconds; actual long-media/browser checks belong to the site suite and can be extended by the manager if candidate integration identifies a gap.

`dima032-compiled.mjs` runs packaged source/mock suites and the actual `utils/tts/tts_session.test.js` Lua suite from the exact image, serially with `NODE_OPTIONS` cleared in test children. It validates `DRAGONFLY_HOST=redis` and `DRAGONFLY_PORT=6379`, derives the credential-free private dependency URL, and sets `DIMA032_TEST_REDIS_URL=redis://redis:6379` only in the spawned test child environment. The API process environment is unchanged. The Lua suite must execute (not skip) against actual disposable Dragonfly with normal declared-key enforcement, a random fixture-owned namespace and scoped key cleanup. Credit fallback/control and AST trigger tests remain included. This mandatory actual-Lua acceptance does not replace the separate real API integration checks.

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

Do not reuse this directory for the API after replacing its preload; create a fresh staged copy if returning to API verification. `dima032-consumers.mjs` runs real packaged AST→admission in separate Node producer processes using an empty local peer map and actual disposable Mongo. Both chat-command and Twitch-event authorities are blocked by the pending normal-TTS reservation. Concurrent independent producers race the real Mongo CAS after release; exactly one wins. Disabling the independent source returns `pet_source_disabled`. The same check now invokes the separate compiled `stream.ended` consumer with real `clearSpeechFiles`, actual enqueue/pop/reset Lua, and old/new files in one random fixture-owned numeric channel under the candidate's actual per-channel speech directory. A delayed post-cleanup hint lets it prove old queue/payload/processing/files are gone and a new enqueue/file survives that boundary. It removes only that channel's Redis namespace and directory. No provider is invoked; compiled AST mocks supplement these actual paths.

The parent owns candidate execution, release and production startup/readiness for API/bot/cron. Cron replacement restarts its complete process tree: check all existing worker health after deployment, without expanding isolated behavior retesting to unchanged Rust workers. Preserve each run's rollback artifacts and use helper cleanup on every candidate. Remove only this task's staged directory when no longer needed. No push or deployment was performed by the API worker.


## Independent review regression extensions

The API fixture seeds one separate disposable owner with a possibly heard old private request, an orphan reservation, an existing45-second lease and an unheard Redis backlog before application imports. Startup must cancel only the old identity, preserve `notBefore`, and leave providers idle until the conservative barrier passes. Connecting its legacy source then drains the existing backlog without replay of the old request. The main PNG-only test also queues unheard backlog, disconnects, and reconnects without another enqueue/control; wire capture requires acquire ACK before the resumed play, and unchanged-ready remains responsive during held dummy synthesis.

Fixture-only wrappers delay **responses of completed real Mongo operations**, retaining actual result/data semantics: the pet reservation `findOneAndUpdate` lean response, GridFS overlay upload metadata insertion, and retained delivery replacement. Redis barrier keys are confined to disposable fixtures. Skip across a delayed claim must charge/synthesize only the next item. A watchdog end across retain/persist must suppress the old overlay emission, release retained files and deliver the next item. Unavailable VTS and missing PNG images both retain one legacy audio owner with Studio captions; restoring valid settings while overlay speech is active must still reject independent admission as busy. These additions supplement the source deferred-interleaving mocks; syntax validation alone does not establish candidate acceptance.

## Round-three source freeze and candidate additions

Corrected source freeze: `584540af`. Final source verification passed71 scoped and existing TTS billing/control/admission/readiness tests plus `tsc --noEmit`. The manager's earlier exact API diagnostic passed on superseded source667/fixture8c7a and was cleaned; that result does not establish acceptance of584540af or these additions.

The fixture now holds the real private request's attempted-delivery update response and invalidates that identity before emission. Normal TTS must remain active, send the same file to legacy exactly once, and emit no private play. Studio-only disconnect with a queued item must leave the unheard backlog unsynthesized despite reconnect grace, then resume on reconnect without another enqueue. A separate held dummy-provider response loses all output while in flight; reconnect must publish the retained normal file with exactly one provider call. Fixture barriers only delay real disposable dependency results and never add a production endpoint.

A generated300-second mono WAV is9,600,044bytes, larger than pet limits but within normal overlay limits. The actual normal pipeline must preserve all bytes, use the bounded60000ms caption hint, retain a Mongo turn proof at least510seconds ahead of its330-second playback watchdog, and remain busy to a separate real Mongo admission producer whose fixture clock is241seconds ahead. This avoids waiting240seconds while checking the relevant expiry boundary. The API itself keeps its real clock; pause/resume and media retrieval use the real Socket.IO/HTTP path. This is protocol/file acceptance, not a claim of300seconds of hardware playback.

Materialization and commands above are unchanged. Allow at least240seconds for the API check because startup and lease handovers deliberately preserve conservative barriers. Candidate execution, independent review, resource enforcement, cleanup and any release remain the manager's responsibility.


## Session-only generated-head acceptance (separate check)

The owner selected **retention only within the current API session; loss at stream end or API restart is allowed**. There is no durable generated artifact guarantee or database migration. `dima032-session-api.mjs` is a separate exact-image verification to keep each helper check within its existing300-second limit. Its `session-env.json` uses the same disposable dependency/provider configuration but disables only the fixture's45-second startup seed; the original API check still verifies that startup barrier. Do not increase helper limits or combine all runtime cases into one process.

Materialization is unchanged: the extended `producer.mjs`, `providers.mjs` and `startup.mjs` are copied by the recipe above. The compiled exact-image check now explicitly includes `handlers/dima032_session.test.js`, plus the changed stream consumer, owner wakeups and existing credit/AST checks. No new application endpoint is added.

The session check exercises the actual API queue singleton and Mongo/Redis through fixture-only mailbox commands. A wrapper delays completion of its real final processing-key deletion, allowing skip to cross exactly the R3 final-DEL boundary. Mailbox state observations inspect the real session head, file hash/bytes, execution/pump/timer state and full pet-settings read count; they are not mocks of queue decisions. Dummy synthesis and normal usage counters must increase once. Parking releases the execution/reservation and holds the same complete bytes, later items stay unsynthesized, and an absent-output idle interval must make no new full-settings reads. Actual Studio reconnect and PNG ready/acquire resume the original file; acquire ACK must precede play.

Disabling read-TTS/master while parked must still elect one normal overlay fallback with no pet request or extra usage. A private attempted-update response is suspended before the sole emission, its player disconnects, and a subsequent selected-player acquisition must use a fresh request/action attempt identity under the same speech origin and original bytes. Possibly emitted audio is never rerouted.

The separate packaged `producer.mjs` can invoke the **actual compiled `applyStreamOperationsDomainEvent` with actual `clearSpeechFiles`**. Only unrelated Twitch/roles/timer/history effects are inert. The changed consumer updates/deletes real disposable Redis state and publishes through actual `PubSubManager` from the separate process to the API listener. Both parked cleanup and possibly-heard private stop are asserted. One fixture-only variant drops that publication, then deterministically invokes the API's existing bounded session reconciliation once; it must invalidate the old head and never replay. File cleanup must use the existing terminal grace. This does not promise session or generated-file recovery after restart.

These fixtures are authored/syntax-checked; the four exact API checks and bot/cron consumer checks remain to be run against the final candidate. Original-source three-case red evidence remains `/tmp/dima032-r3-reproduction.log`. The API-worker final source evidence is `/tmp/dima032-r4-final-targeted.log` (13/0), `/tmp/dima032-r4-final-scoped.log` (135/0) and `/tmp/dima032-r4-final-tsc.log` (exit0); mocked Redis script handlers do not establish Dragonfly compatibility. Those earlier results predate the current freeze and are historical, not results on `af33f93889bc7dfcd168c1365f9dfc22305bda44`. The current source results and pending candidate status are recorded at the top. The manager owns exact candidates, resource/cleanup and release receipts.


## Earlier exact-image diagnostic history

The earlier `5b105f89` source candidate image `api-f60dbffee0ed` passed184 packaged tests including actual Lua. Its main API check failed once on the first ready/playing request timeout. The same image with the same preload then passed the diagnostic check `59e71d53`; diagnostic check SHA-256: `028c92ae9f9af372be2253cb674b20d719d7817b47820bbda941029a15987f72`. The original failure cause remains unproven. Preserve the original failure in the record and keep the diagnostic in the final `ops/checks/dima032-api.mjs` unchanged; the diagnostic retry does not erase or explain the initial failure. This is historical evidence, not final acceptance of the current source or candidate.


## Boundary/control review regressions (separate check)

`dima032-r4-api.mjs` uses fresh disposable dependencies and `session-env.json` so it does not repeat the45-second startup seed or lengthen any helper limit. It invokes the actual queue/adapter, actual Dragonfly commands/scripts and the separate compiled stream consumer. The fixture delays the response of a completed nonempty dequeue, advances the real stream boundary before head creation, and asserts zero provider/usage work for the old item. For atomic reset it admits old work while Studio is live under the actual Mongo CAS response barrier, removes output, then waits for the unsynthesized requeue. It never tries admission with no eligible output. Reset removes that old membership/payload before its later PubSub hint is delayed. A new item is admitted with live Studio under another CAS barrier, carries the new marker and survives the old hint before delivery. Atomic enqueue/dequeue/reset compatibility must pass on actual Dragonfly with its normal declared-key enforcement; no daemon flag override is allowed.

Four real legacy cases cover skip/clear followed by read-TTS/master disable. The next ordinary speech must accept an actual socket progress report and terminal report, retiring its real queue lock without a direct fixture terminal call. Six cancellation cases hold a real separately admitted independent request in playing state. Only that disposable request's phase deadline is extended to120seconds to make the wait boundary explicit. The fixture observes the actual head cancellation signal's abort listener, proving reserve/prepare is waiting before cancellation. Skip/clear/the real stream-end consumer must release that head and all pumps within1.5seconds, while the independent request, generation and lease identity remain active. Reserve-stage cases synthesize/charge nothing; prepare-stage cases synthesize/record normal usage once. No120-second sleep is used.

The preload exposes fixture-mailbox observations of matching elected owner, playback position and pending abort listener, plus the existing runtime observation hook after a disposable timestamp reset. It delays completed dependency **responses**, preserving actual Lua/Mongo operations. The one explicitly armed private-read fault below discards one real query reply only in its exact control context. The producer can delay only the stream-end hint after actual cleanup, or drop it for the existing lost-hint case. API application code has no test endpoint.

The final compiled check enables the actual Lua suite only in its spawned child using the validated disposable alias, as described above; the current source freeze includes its strict URL/namespace cleanup guards. The preload holds only successful three-element `DIMA032_POP` results `[id,payload,session]`; its one-element `["retry"]` CAS result must continue without a barrier. `DIMA032_RESET` now returns the old marker/membership internally, while the public `resetTtsSession` function still returns void. These API fixtures call the real stream consumer and do not assume the old Lua return string. Never point the Lua opt-in at host/live Redis. The current source full run explicitly skipped actual Lua; actual-Lua and all exact-candidate checks remain pending manager verification.


The fourth API check also covers both round7 fixes. It holds the real initial processing-write response while read-TTS is off, inserts exactly128 fixture-owned capacity claims, enables read-TTS, selects a PNG player and removes Studio. It arms the existing final processing-DEL response barrier before releasing the initial write, then frees those exact claims while the old dispatch still owns execution. The fixture allows the scheduled capacity callback an event-loop turn before releasing DEL. No provider/usage work is allowed while held; releasing DEL must preserve the wake and deliver the original speech identity once, then its already-queued FIFO follower after the original terminal, with no further enqueue/ready/control. A `finally` block removes only the claims owned by this fixture.

For private cleanup it scopes one lost `PetRequest.findById(...).lean()` reply to the exact request and skip control using `AsyncLocalStorage`; later reads and repair execute real Mongo normally. The exact-generation stop and old reservation must precede completion of that held read. A second barrier holds the automatic retry before its actual terminal Mongo write: successor normal synthesis/usage may finish, but its private creation, attempted delivery and audio must remain absent while the old identity is nonterminal. Non-mutating observations before the original actual `PetRequest.create` and attempted-delivery operations require the old identity terminal at both private boundaries. Provider-time status remains printed diagnostic data with exact request/count checks; it is not a terminal-before-synthesis rule. The superseded provider-time failure remains archived; its assertion exceeded the approved synthesis-before-handoff contract.

The check then requires automatic terminal repair, exact stop/play order, successor lease/runtime/private-file safety, old private-directory removal, stale-old report rejection and no reconnect replay, preserving once-only provider/usage counts. These corrected cases require actual execution against the final candidate; assertions reached before earlier failures do not establish reconnect acceptance. Materialize the five-file preload directory afresh after this fixture commit; the four API commands and300-second helper limits are unchanged.

The same fourth check now covers accepted backlog outside the128-entry local waiter cache. It reuses one disposable owner with one real Studio source, then one real legacy source with read-TTS disabled. Both FIFO items are legitimately admitted while read-TTS is off before the fixture installs128 owned capacity claims,128 busy waiter placeholders and80 disconnected empty pet-registry entries. Releasing the owned claims requests the real capacity-retirement discovery path; one explicit call to the existing `recoverQueuedTts` covers a missed hint deterministically. This is not a wall-clock15-second timer test. Original speech IDs, actual Redis membership, provider/usage increments and one audio delivery per item are checked; an unmembered owned payload must remain silent. A counter of actual recovery invocations checks for recursive idle rescheduling while allowing one ordinary timer tick. It does not assert64-step/eight-probe budgets from mixed queue calls; those bounds are covered by the compiled source suite. All registry/cache entries, claims and orphan payloads have owned `finally` cleanup. This extension is syntax-checked only until the manager runs the final exact candidate; no extra check or helper limit is introduced.
