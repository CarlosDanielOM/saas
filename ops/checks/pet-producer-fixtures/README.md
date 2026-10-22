# DIMA-030 configured pet producer acceptance

The bot producer checks passed on 2026-10-22 against **one unchanged image**, with no deployment or live credentials/provider usage. Cron acceptance remains held; these results do not establish actual cron-supervisor execution or complete the shared pet milestone.

## Accepted artifact and results

- Run: `bot-d3f31c3ea2b9`.
- Application source: generated-catalog commit `63e99b5c`, including adapter correction `336b0190` and its evidence `15ce1e85`; clean source checkout `/tmp/dima-pet-producer-11c4a73c`.
- Image: `sha256:9e3be00a7f82221f149cb2f2daaae806e666d4e78112e390de4ea1bb976c5e41`.
- Helper source snapshot digest: `aa2b6d8f7d85b22b90d1007e5c1fb6cd1986eb3988cbb4bcaefefbaba925bbdd`.
- Generated catalog `d2bd1b95bef8`: 115 canonical / 129 registered functions. `pet.talk` and `pet.ask` are category `pet`, Premium, authoring-only. Generation and metadata checks passed; generated diff adds just these functions plus version/count/time updates.
- `pet-triggers.mjs`: **97/97 assertions**, seven serial compiled files, final run 3.851 seconds, natural test-runner exit. This used the supplemental raid-only preload described below; it is not a claim that pristine in-image test source passed unaided.
- `pet-configured-triggers.mjs`: **PASS** real signed/default command handlers, actual Mongo pet admission, browser ready/election, signed bits/follow journaling and registered durable dispatch/drain. An explicitly started API child performs all mocked provider/Polar work. Five requests produced five TTS calls, two LLM calls and seven unique usage IDs. Direct and bits `talk` skip the LLM; configured `ask` uses no tools. Literal user/generated tags, permission denial, disabled events and empty-output nested references are covered. Signed duplicates and durable retry after chat failure retain full identity, request ID, provider counts and local credit debit. The check does not mock admission or event authorization gates.

Every helper execution acquired `flock --close -w 60 /tmp/sam-host-slot.lock`. Host catalog generation/check ran serially in the existing `dima-dev.slice/dima-build.scope`; both kernel scope/parent readbacks were CPU `400000 100000`, memory.high `5368709120`, memory.max `6442450944`, memory.swap.max `0`. Bot build used the ordinary helper. Verification used its standard app/check allocation (2 CPUs/3 GiB/512 PIDs) with disposable Mongo and Redis (each 1 CPU/1 GiB/256 PIDs) on an internal network. This does not claim that an instruction scope contains Docker/BuildKit daemon work.

Final helper receipt was `verified`, `resources: []`; scoped container/network filters were empty. The exact image was retained, with no serving candidate/API child/test watcher retained. The latest receipt/check/log are private under `/root/.local/state/saas-ops/649a957c15888e53/bot-d3f31c3ea2b9/`; each verification overwrites the prior check/log, so both check identities are recorded here.

## Fixture corrections and limitations

The first compiled-suite attempt stalled in the existing raid transport fixture because its configuration eligibility boundary reached an unconnected Mongoose model. Only the task-owned check was terminated; helper cleanup removed its disposable resources. The parent approved a test-only preload on the same image instead of rebuilding. `unit-preload.mjs` supplies an already-eligible raid configuration **only when** argv names `bot/eventsub.twitch.test.js`; no admission, trigger or other suite boundary is replaced. It skips the supplemental mock for future images whose test source contains the checked-in five-line correction. All packaged production module bytes remain unchanged. The wrapper bounds each test to 20 seconds and the child process to 120 seconds. The equivalent source-test correction is committed for future builds, but was not compiled into this accepted image.

The first real-path attempt completed command playback/billing but correctly skipped bits because API startup refreshed the seeded account's omitted Mongo `chat_enabled` flag to false. The fixture now persists the actual enabled booleans and asserts the cache gate. A subsequent attempt completed all assertions but remained alive because the unchanged full AST registry starts a legacy moderator-restore interval without a shutdown export. The final check explicitly exits only after assertions and API/socket/PostHog/database cleanup succeed; it does not claim natural process exit. Neither correction changed product behavior or weakened assertions.

The generated JSON and authoring text are also API-packaged artifacts. The separately accepted `api-ae3fc72dfb9f` predates this generated catalog, so publishing the new authoring reference requires an API rebuild. No pet runtime, socket adapter or other backend production source changed during this acceptance turn; prior API/Rust behavioral evidence remains applicable to that unchanged code. The bot's five-line test-source correction alone does not require a product-code rebuild.

Cron remains **HELD**. Do not infer approval to run it, import cached binaries or change the helper. Its stricter option and complete aggregate builder accounting need separate verification/coordination, and the 4 GiB compiler mode still needs at least 12 GiB available at startup with 8 GiB retained headroom.

## Exact check identities (SHA-256)

| Artifact | Hash |
| --- | --- |
| Compiled-suite wrapper | `68bc31bd9c7e38c1d1bf63a2d88699b6b626d6c98548b967da2a2bd02eef42f8` |
| Final raid-only unit preload | `153d2218b2ce5ec04b277943c6e9f2bc5d28b06737121215c3e91d560a863c11` |
| Real configured-trigger check | `5e37aeb602f737b7b0ed4a9cd90772b2f7a71d2e644158b38edbaaf74ce51e68` |
| Producer provider wrapper | `cbc349a062174e900d7f641e5e344b536a054fc8550605054476122f829f897e` |
| Bot test environment | `23634aaffc2c2eaf06275b5b0016db5f1df878c981b273f626395870bbdd6ba5` |
| Reused backend provider mock | `f6f0a0a33e76dddb4818870fae9ff65f9a81b17875193575d3b2ffc15ba8c214` |
| Reused OAuth/Twitch mock | `097c0a629a1e018691200e19f4e7ea6fdae6957db0adae57d43756223cad5761` |

The final unit rerun used the final preload above. The successful real-path check does not import it; its NODE_OPTIONS loads only provider fixtures.

## Reproduction after an explicit execution grant

From `/root/saas`, use a clean same-repository source worktree containing the desired committed source. Generate/check metadata in the agreed capped host scope; do not run these commands from an environment containing production dotenv files. Build the bot only through `scripts/saas-ops build bot --source-dir <isolated-source>` with the outer lock, then substitute its exact run ID below.

```sh
PET_PRODUCER_FIXTURES=$(mktemp -d /tmp/pet-producer-acceptance.XXXXXX)
cp ops/checks/pet-producer-fixtures/providers.mjs "$PET_PRODUCER_FIXTURES/"
cp ops/checks/pet-producer-fixtures/cron-boot.mjs "$PET_PRODUCER_FIXTURES/"
cp ops/checks/pet-producer-fixtures/unit-preload.mjs "$PET_PRODUCER_FIXTURES/"
cp ops/checks/pet-runtime-fixtures/providers.mjs "$PET_PRODUCER_FIXTURES/runtime-providers.mjs"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$PET_PRODUCER_FIXTURES/oauth-providers.mjs"
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify bot-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/bot-env.json --fixtures "$PET_PRODUCER_FIXTURES" \
  --check ops/checks/pet-triggers.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify bot-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/bot-env.json --fixtures "$PET_PRODUCER_FIXTURES" \
  --check ops/checks/pet-configured-triggers.mjs
rm -rf -- "$PET_PRODUCER_FIXTURES"
```

The bot acceptance above used explicit registered dispatch/drain. It does not establish cron scheduling. The following cron preparation supersedes the old cron bootstrap that replaced every supervised child.

## Cron supervisor fixture checkpoint (not runtime verified)

The updated `cron-boot.mjs` preserves the exact packaged `cron.index.js` command at PID 1, its real `domain_events.worker.js` dispatcher, and the dispatcher's real IPC-forked `--consumer=chat-announcements-v1` child. The test preload forwards all other child-process exports and substitutes inert OS children only for unrelated TypeScript workers, the native index and unrelated durable consumers. It records actual spawn/fork edges, process startup and observed lease-claim IPC in a bounded per-run JSONL file. No admission, event handler, registry, event gate or production module is replaced.

In explicit cron mode, `pet-configured-triggers.mjs` does not import/call manual dispatch, drain or consumer handlers. It verifies the recorded chain against kernel PID/PPid/command-line data, waits for scheduled deliveries and the real dispatch-pending journal marker to clear, and requires a distinct real lease token on each attempt. Signed configured bits cause a chat-transport failure after pet admission, followed by the normal five-second durable retry. The configured follow succeeds without an app token; resetting only its disposable delivery row simulates a lost acknowledgement, and the real scheduled consumer must reclaim it. Full request identity (including canonical occurredAt and payload hash), request count, provider calls, usage IDs and local debit must remain unchanged on retry.

The browser is elected through the actual Socket.IO/API lease path, retrieves the private 500 ms fixture audio, and acknowledges playback. All paid outbound calls must belong to the separately started API PID. Normal TTS queue/data keys remain absent. Existing permission, enabled-event, signature, stale-timestamp, literal argument/LLM injection, direct-talk-zero-LLM and nested-reference assertions remain.

This is an **UNVERIFIED CHECKPOINT**: static diff review only at checkpoint time; no claim of actual cron scheduling, native startup, compilation or runtime pass. The native index/unrelated children are inert in this behavior fixture, so it cannot prove their actual startup or health. Native identity/startup readback is a separate acceptance step; unchanged native behavior suites are not expanded solely because the shared image is rebuilt.

The parent subsequently granted one serial cron build/check turn after API release. The explicit Docker-daemon exception covers this build only; the helper's compiler limits and all load/disk/cache/headroom guards remain mandatory. Start only with at least 12 GiB available, retain 8 GiB throughout, and do not wait automatically or bypass refusal. At actual compiler startup capture kernel `cpu.max=300000 100000`, `memory.max=4294967296`, `memory.swap.max=0`, `pids.max=256`, Docker HostConfig and `CARGO_BUILD_JOBS=2`. The existing Docker daemon is outside that compiler cgroup; do not describe its build work as contained by these limits.

After the explicit handoff, from `/root/saas` with a separate clean same-repository committed worktree (never the API worker's snapshot):

```sh
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops build cron \
  --source-dir /tmp/dima-pet-cron-producer-source --rust-cpus 3 --rust-memory-gib 4
```

Stage fixtures with the copy recipe above. Against the one resulting exact run, execute serially with normal helper limits:

```sh
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/cron-env.json --fixtures "$PET_PRODUCER_FIXTURES" \
  --check ops/checks/pet-triggers.mjs
flock --close -w 60 /tmp/sam-host-slot.lock scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/pet-producer-fixtures/cron-env.json --fixtures "$PET_PRODUCER_FIXTURES" \
  --check ops/checks/pet-configured-triggers.mjs
```

The compiled seven-file check uses the future five-line raid eligibility fixture correction already in source, so its preload must detect and skip that supplemental mock. The real cron check has no unit preload. Each helper invocation has a 300-second bound; API child lifetime is bounded to 240 seconds and explicit cleanup to five seconds. The legacy full-registry interval still requires the documented final test-process exit after assertions and cleanup. No deployment is part of this worker's authorization.
