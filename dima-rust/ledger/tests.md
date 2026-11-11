# Tests and behaviour checks inventory (Rust migration)

Generated 2026-11-11 from branch `rust-v2` by `node dima-rust/tools/ledger/tests_inventory.mjs`
(read-only; TypeScript compiler API, syntax only). Per-file records are in `tests.json`
(`dimabot_tests`, `dimabot_uncovered_sources`, `checks`, `backend_target_checks`, `check_fixture_dirs`, `ops_tests`).
Re-run the script after source changes; the numbers below are its output.

## Three things the lead needs to know

1. **Almost no backend check is black-box today.** Of the checks that target `api` (130), `bot` (43) and `cron` (62),
   only 2, 0 and 1 talk to the candidate purely over the network. 170 checks import compiled application code from
   `/app/dist` inside the candidate image, and 129 load a `NODE_OPTIONS=--import=/tmp/saas-fixtures/*.mjs` preload
   into the **application process** that replaces `globalThis.fetch` (Twitch, Polar, OpenRouter, Qdrant, PostHog,
   Fish, Piper…) or hooks `child_process.spawn`. A Rust binary ignores `NODE_OPTIONS`, so moving the check scripts into
   a separate checker container is necessary but not sufficient: the Rust services also need a provider-mock path.
   The precedent already exists: `dashboard-activity-rust` mocks Twitch for the native worker through `HTTPS_PROXY`
   + a fixture CA (`ops/checks/dashboard-activity-rust-fixtures/README.md:40`), with production URLs unchanged.
2. **Only 25 of the 170 IMPORTS-APP checks become black-box by swapping seeding helpers for raw driver calls**
   (bucket A 23 + B 2). 123 drive internals in-process (AST evaluator, bot message/command/TTS handlers, pets
   admission, overlay store, domain-event appliers…), 8 just execute compiled `node:test` files, 12 use internals only
   inside boot/preload hooks, 2 spawn TS worker/scripts. The `bot` target has **no** black-box entry point at all:
   all 43 bot checks call handlers in-process, so the Rust bot needs a chat-ingress seam (fake EventSub/IRC endpoint
   by URL) before its checks can be black-box. The `*-rust.mjs` cron parity checks use the TypeScript functions as
   their reference oracle: their expected outputs must be frozen as golden fixtures before the TypeScript is deleted.
3. **The unit tests are a usable spec but have no runner.** 256 test files, 1,918 `test()` calls: 111 PURE files
   (687 tests), 142 MOCKED (1,224), 3 SERVICE (7, all opt-in/skipped by default). `npm test` is a placeholder
   (`dimabot/package.json:8`); there is no CI. MOCKED tests rely mostly on `mock.module` (97 files) and
   `mock.method` on Mongoose models (56 files), so Rust ports need trait/DI seams, not module patching. About 10
   tests assert UTF-16 semantics (emoji `.length`, UTF-16 match offsets, surrogate-safe truncation); they are listed
   below for one-by-one review.

---

## A. Unit/integration tests in `dimabot/src`

### Totals

| | files | `test()`/`it()` calls |
|---|---:|---:|
| PURE | 111 | 687 |
| MOCKED | 142 | 1,224 |
| SERVICE | 3 | 7 |
| **total test files** | **256** | **1,918** |
| helper files (no cases) | 6 | – |

Also: 10 `t.test` subtests, 4 `describe` groups, 115 `test()` calls generated inside loops/helper functions (the real
case count is higher than 1,918 for those files; see `cases.generated_in_loops_or_helpers`), 0 static skips,
4 conditional skips (the SERVICE gates).

Test files = 254 `*.test.ts` + `utils/ai/memory/stream_summary_schema.specs.ts` (excluded from `tsc`, see
`dimabot/tsconfig.json` `exclude`) + `utils/ai/memory/stream_summary_decider.simulate.ts`. Helpers:
`server/services/route_harness.test_util.ts`, `site_agent/tools/write/fake_store.testutil.ts`,
`site_agent/tools/write/settings/test_context.test_util.ts`, `utils/domain_event_execution.fixture.ts`,
`utils/eventsub.test-data.ts`, `utils/follow_defense_state.test-helper.ts` (+ `scripts/run_test_lua.script.mjs`,
spawned by the latter).

Per top-level directory (files / tests / PURE / MOCKED / SERVICE):

| dir | files | tests | PURE | MOCKED | SERVICE |
|---|---:|---:|---:|---:|---:|
| utils | 112 | 911 | 55 | 56 | 1 |
| domain_events | 14 | 195 | 9 | 5 | 0 |
| site_agent | 27 | 180 | 5 | 22 | 0 |
| handlers | 15 | 133 | 5 | 10 | 0 |
| pets | 17 | 117 | 5 | 11 | 1 |
| server | 15 | 70 | 4 | 10 | 1 |
| goals | 6 | 39 | 3 | 3 | 0 |
| widget_feed | 10 | 38 | 3 | 7 | 0 |
| overlays | 7 | 33 | 6 | 1 | 0 |
| workers | 2 | 32 | 0 | 2 | 0 |
| widgets | 3 | 31 | 2 | 1 | 0 |
| desktop_ai | 5 | 30 | 1 | 4 | 0 |
| functions | 6 | 24 | 1 | 5 | 0 |
| commands | 4 | 23 | 3 | 1 | 0 |
| custom_widgets | 4 | 19 | 4 | 0 | 0 |
| middleware | 2 | 13 | 2 | 0 | 0 |
| roulette | 1 | 12 | 1 | 0 | 0 |
| bot | 1 | 6 | 0 | 1 | 0 |
| assets | 2 | 5 | 0 | 2 | 0 |
| bits_rules | 1 | 4 | 1 | 0 | 0 |
| schemas | 1 | 2 | 0 | 1 | 0 |
| scripts | 1 | 1 | 1 | 0 | 0 |

`utils` split (files/tests): `utils/*` 40/329, `utils/ast_parser` 29/215, `utils/ai` 23/164, `utils/moderation` 8/68,
`utils/permissions` 4/64, `utils/observability` 2/35, `utils/tts` 4/22, `utils/ast_blocks` 1/12, `utils/twitch` 1/2.
`tests.json → totals.by_dir` has the two-level breakdown.

### Mocking mechanisms (files using each; a file can use several)

| mechanism | files | Rust porting note |
|---|---:|---|
| `mock.module` (node `--experimental-test-module-mocks`) | 97 | replace with trait objects / injected ports; 110 files also use `await import()` after mocking |
| `mock.method` (mostly on Mongoose models/schemas, e.g. `t.mock.method(DomainEventSchema, 'findById', …)` in `utils/domain_event_prerequisite.test.ts:33`) | 56 | repository trait fakes |
| fake/stub objects (heuristic) | 34 | |
| `globalThis.fetch` override | 24 | HTTP client trait or local mock server |
| dependency-injection fakes (heuristic: `deps:`, `now:`, `store:` … arrow functions) | 19 | port as-is |
| `mock.fn` | 18 | |
| `process.env` mutation | 16 | config struct |
| `mock.timers` | 15 | injectable clock / `tokio::time::pause` |
| in-process HTTP server on loopback (`listen(0)`) | 10 | axum test server |
| site-agent `test_context.test_util` fakes | 8 | |
| temp-dir filesystem | 6 | `tempfile` |
| `fake_store.testutil` (in-memory Mongoose model fake) | 6 | |
| `route_harness.test_util` (express + fake auth on loopback) | 5 | |
| `lua-redis-wasm` via `follow_defense_state.test-helper.ts` → `scripts/run_test_lua.script.mjs` (real Lua scripts, Redis commands mocked) | 5 | keep the Lua scripts; run them against a disposable Dragonfly or `mlua` |
| child process | 5 | |
| `Date.now` override | 2 | |

Primary mechanism per MOCKED file: `mock.module` 97, `mock.method` 18, DI/fakes only 11, fetch override 6,
`mock.timers` 4, loopback HTTP 2, other 4.

### SERVICE tests (need a real dependency; skipped unless configured)

| file | needs | gate |
|---|---|---|
| `server/services/command_defaults.service.test.ts` | real MongoDB (`mongoose.connect`, lines 14, 65) | `COMMAND_DEFAULTS_TEST_MONGO_URI` (lines 8, 11, 62) |
| `utils/tts/tts_session.test.ts` | real Redis/Dragonfly Lua (`createClient`, line 17) | `DIMA032_TEST_REDIS_URL` (lines 10–11); run compiled inside the candidate per `dimabot/PET_RUNTIME.md:332` |
| `pets/tts_envelope.test.ts` | host `ffmpeg`/`ffprobe` (lines 34–36) | skips when the decoder is missing ("run in exact API candidate") |

### How tests are executed today

- No aggregate runner: `dimabot/package.json:8` is `"test": "echo \"Error: no test specified\" && exit 1"`.
  No CI configuration exists in the repository (no `.github/`, no other CI files at the root).
- Documented ad-hoc invocations: `node --experimental-test-module-mocks --import tsx --test <files>`
  (`dimabot/SITE_AGENT.md:222`, `dimabot/CLIP_RECOMMENDATION_RECOVERY.md:53`,
  `migration-notes/cache-logger-pre-port-review.md:24`); `node --import tsx --test src/custom_widgets/*.test.ts`
  (`dimabot/CUSTOM_WIDGETS.md:119`); `tsx --test src/roulette/model.test.ts` (`dimabot/ROULETTE.md:229`).
  `--experimental-test-module-mocks` is required by the 97 `mock.module` files.
- `dimabot/tsconfig.json` includes `./**/*.ts` and excludes only `**/*.specs.ts`, so every `*.test.ts` is compiled into
  `/app/dist/**/*.test.js` in the production image. 27 behaviour checks execute 56 distinct compiled test files
  inside the candidate with `node --test` (list under bucket D below and in `tests.json → checks[].runs_compiled_tests`).
  These disappear from a Rust image and must become `cargo test` cases.
- `ops/README.md:377-385` runs only the ops helper tests (`python3 -m unittest discover -s ops/tests`).

### Assertions that depend on JavaScript (UTF-16) string semantics

The scanner flags every test line with non-ASCII text (or `\u` escapes) near length/slice/sort/case/normalize
operations (60 hits in 20 files, all in `tests.json → dimabot_tests[].unicode_semantics`; many are only labels
ending in `…`). Reviewed high-signal cases:

**Depends on UTF-16 code units (will differ with Rust `chars()`/byte indices):**
- `dimabot/src/desktop_ai/input.test.ts:12-14` — `'😀'.repeat(1000)` is accepted and `.text.length === 2000`;
  1001 emoji are rejected: the limit is 2000 UTF-16 units ("UTF-16 transport boundary").
- `dimabot/src/desktop_ai/input.test.ts:34-38` — `truncateReply('😀'.repeat(300), 279)`: `bounded.length <= 279`
  and must not end on a high surrogate.
- `dimabot/src/utils/moderation/advanced.test.ts:15-16` — `'🎉 Rinn!'` match `{start: 3, end: 7}` (UTF-16 offsets;
  scalar offsets would be 2..6, byte offsets 5..9).
- `dimabot/src/utils/moderation/advanced.test.ts:22-23` — `'🎉 CAFÉ scam'` literal match `{start: 3, end: 7}`.
- `dimabot/src/utils/moderation/variations.test.ts:72-74` and `:107-109` — `text.slice(match.start, match.end)` on
  emoji-prefixed text; offsets are UTF-16 indices.
- `ops/checks/dashboard-activity-rust.mjs:255` — emote name `'N'.repeat(63)+'😀'` must come back with
  `name.length === 64` (UTF-16); already passes against the native dashboard worker, so the Rust code there
  already counts UTF-16 units.
- `ops/checks/kokoro.mjs:111` — `'😀'.repeat(15)` (30 UTF-16 units) as the "unicode" speech scenario.

**Unicode classes / folding / collation (behaviour, not length):**
- `dimabot/src/utils/ast_parser/functions/user.functions.test.ts:154-157` — `ignore symbols/numbers` keeps letters
  and the combining mark U+0301, drops emoji (`'Ünïcode_💩'` → `'Ünïcode'`).
- `dimabot/src/utils/moderation/rules/caps.rule.test.ts:58,64` — caps ratio over accented letters.
- `dimabot/src/utils/moderation/rules/emote_spam_blacklist.rule.test.ts:31-35` — `café`/`CAFÉ` accent folding.
- `dimabot/src/functions/search/search_categories.test.ts:92-93` — accent and curly-apostrophe folding in fuzzy
  category matching.
- `dimabot/src/server/services/media_library.service.test.ts:13-15` — accent-insensitive regex built for MongoDB.
- `dimabot/src/site_agent/docs/search.test.ts:41-43,67-69,92` — `fold()`/`tokenize()` diacritic folding; snippet
  window delimited by `…`.
- `dimabot/src/site_agent/docs/sections.test.ts:35-36` — heading slugs keep non-ASCII letters.
- `dimabot/src/utils/ast_parser/tts_settings.test.ts:93-96` — emote filtering leaves `'… al baño'`.
- `dimabot/src/site_agent/tools/write/commands.test.ts:335` — `'señal'` rejected by the `[a-z0-9_]` name rule.
- `dimabot/src/utils/follow_defense.test.ts:96` — test oracle sorts with `localeCompare` (ASCII ids; low risk).

**UTF-8 byte budgets (same in Rust if JSON serialization matches):**
`dimabot/src/site_agent/docs/read.test.ts:79-89`, `dimabot/src/site_agent/tools/knowledge.test.ts:128`
(`Buffer.byteLength(JSON.stringify(…))` limits).

### Source files with no test

249 non-test source files in `dimabot/src` have more than 150 lines. **124 are not imported by any test**
(statically or via `await import()`, excluding modules a test replaces with `mock.module`); 51 of those are not even
loaded transitively by any test (20,232 of 43,908 lines). 34 of the 124 are at least imported in-process by a
behaviour check. Largest by area: `server/routes` 10,988 lines, `utils/ai` 4,928, `utils/ast_parser` 2,045,
`server/services` 1,989, `utils/qdrant` 1,160. Largest files:

| file | lines | loaded transitively by N tests |
|---|---:|---:|
| `server/routes/trigger.route.ts` | 1,712 | 0 |
| `server/routes/auth.route.ts` | 1,647 | 0 |
| `server/routes/dimafx.route.ts` | 1,338 | 3 |
| `server/routes/admin_site.route.ts` | 1,117 | 0 |
| `utils/ast_parser/registry.ts` | 1,028 | 70 |
| `utils/ai/memory/memory.service.ts` | 992 | 60 |
| `site_agent/runner.ts` | 984 | 0 |
| `utils/follow_ledger.ts` | 918 | 0 |
| `handlers/message.handler.ts` | 839 | 3 |
| `server/routes/billing.route.ts` | 678 | 0 |
| `server/routes/admin.route.ts` | 653 | 0 |
| `utils/eventsub.ts` | 633 | 70 |
| `utils/siteanalytics.ts` | 614 | 56 |
| `workers/stream_memory.worker.ts` | 500 | 0 |
| `server/routes/user.route.ts` | 470 | 0 |

Full list with `imported_by_checks`: `tests.json → dimabot_uncovered_sources`.

---

## B. Behaviour checks in `ops/checks/`

393 top-level scripts (369 `.mjs`, 22 `.py`, 2 `.sh`), 78 directories (77 `*-fixtures` + `ast_global/`, 244 files),
plus `analytics-channel-names-env.json`, `dimafx-server.test-env.json`, `DUEL.md`, `FISH.md`.
Roles: 374 checks, 16 suite runners (spawn/import other checks to stay under the 300 s limit, e.g.
`overlay-studio-suite.mjs`, `pet-page-suite.mjs`), 3 shared helpers (`native-cron-fixture.mjs`,
`overlay-studio-ui-helpers.mjs`, `overlay-studio-live-fixture.mjs`).

| kind | scripts |
|---|---:|
| IMPORTS-APP | 170 |
| BROWSER | 160 |
| BLACK-BOX | 42 |
| OTHER | 21 |

Targets (multi-target checks branch on `SAAS_TARGET`): site 166, api 87, cron 28, docs 20, admin 14, bot 12,
api+bot+cron 16, api+cron 12, api+bot 9, api+site 7, bot+cron 6, analytics 4, hoststats 2, repo-source 2,
admin+site 1, api+cron+site 1, dimadb 1, dimafx-server 1, embeddings 1, piper 1, helpers 2.
Evidence per check is in `target_evidence` (docs command blocks naming `verify <target>-<run>` with
`--check ops/checks/X`: 38 checks; `SAAS_TARGET` branches; header comments; content). 15 api assignments are
marked `weak:` (the check only imports `/app/dist`; api/bot/cron are the same `dimabot/dockerfile` image).

**BROWSER (160):** 154 intercept every API call with Playwright `page.route` (110 also route WebSockets); 6 need no
API (static bundle). None needs a live backend. They run on the host against `SAAS_PREVIEW_URL`; `saas_ops.py:783`
forbids fixtures/test-env/dependencies for website targets. **Unaffected by the Rust migration** except where their
mocked API payloads encode contracts (they are a secondary source for response shapes).

**BLACK-BOX (42):** mostly docs `.py` checks and site HTML checks. Backend ones: `analytics-access-api.mjs` (api),
`trigger-overlay-images.mjs` (api), `pet-cron-startup.mjs` (cron), plus `dimafx-server.mjs`, `hoststats.mjs`,
`dimadb.mjs`, `piper.py`, `embeddings-batch32.py`, `analytics-channel-names.mjs`, `analytics-overview-aggregation.mjs`.

**OTHER (21):** the 16 suite runners and 3 helpers above, `alert-keyframes-source.mjs` and
`observability-telemetry-dropped.test.mjs` (host-side contract checks that read repository source, no candidate),
`duel-quality.sh`.

Dependencies (`--dependency`): mongo+redis 150, mongo+postgres+redis 8, mongo 7, redis 3, none 225.
136 checks use a fixtures directory (56 of those matched by name only: `fixtures_inferred_from_name`);
`pet-mood-failure-fixtures` (preload `moods-fail.mjs`) is not referenced by any check script and was not matched. Preload hooks set by `test-env.json → NODE_OPTIONS`:
`providers.mjs` 115 checks, `cron-boot.mjs` 27, `bootstrap.mjs` 6, `boot.mjs` 4, `attribution-boot.mjs` 2,
`interop-boot.mjs` 1. Hosts mocked by preloads (checks): `qdrant.test` 113, `api.twitch.tv` 85, `id.twitch.tv` 42,
`api.polar.sh` 38, `openrouter.ai` 30, `us.i.posthog.com` 29, `pet-piper.test` 19, `pet-embeddings.test` 11,
`api.resend.com` 3, `api.fish.audio` 3 (full list per check in `mocks.hosts`).
Packages the checks load from the image's `node_modules` (`createRequire('/app/package.json')` or
`/app/node_modules/...`): mongoose 28, mongodb 21, redis 19, ws 11, socket.io(-client) 8, express 8, pg, bson,
jsonwebtoken, standardwebhooks.

### IMPORTS-APP checks by what they need from the application

| bucket | checks | what it takes to run against a Rust-only image |
|---|---:|---|
| A seed/connect only (`getMongoDBConnection`, `getDragonflyClient`, Mongoose schemas/models, constants/key builders) | 23 | replace with raw `mongodb`/`redis` driver calls in a checker container; watch for checks that rely on `Model.init()` to create indexes (e.g. `account-deletion.mjs:63-65`) |
| B seed + setup helpers (`encrypt`, `journalDomainEvent`/`ingestDomainEvent`, cache-key builders) | 2 | as A plus a test-only crypto helper with the production key format |
| C drives internals in-process | 123 | split: logic assertions → Rust tests; flows → black-box entry points (HTTP, EventSub webhook, chat ingress); small debug CLI only where no entry point exists |
| D runs compiled `node:test` files from `/app/dist` | 8 (27 checks run 56 compiled test files in total) | port those test files to Rust (`cargo test`) |
| E spawns a TS worker/script (`/app/dist/workers/*.js`, `dist/scripts/*`) | 2 | spawn the Rust binary / subcommand instead |
| F internals only inside preload/boot hooks | 12 | replace the boot hook with configuration (provider URLs/proxy, fake child commands) |

The 23 bucket-A checks: access-batch-api, account-deletion, admin-credit-chat, ai-usage-receipts,
alert-image-cache-api, alert-journal-dedupe-api, billing-subscription-checkout, channel-admin-permissions,
channel-admin-ui-api, channel-tts-permissions-api, clip-designs-api, credit-gift-search, credit-packs,
custom-widgets-bot, desktop-ai-studio, dimafx-queue, eventsub-reconciliation-switch, redemption-limits-api,
referral_ledger, shoutout-received-api, site-agent-api, spam-protection-provider, trigger-public-assets.
Bucket B: auth-first-activation, desktop-ai. Bucket D: ast-channel-actions, bot-poll-prediction, docs-assistant-api,
game-search, moderator-restore, openrouter-attribution, pro-referral, tts-paid-exhaustion. Bucket E:
desktop-ai-regressions, pet-moods-regressions. Bucket F: ai-usage-receipts-rust, ast_global, dima032-compiled,
dima032-r4-api, dima052-follow, mp3-upload, oauth-beta, pet-provider-regressions, pet-rust-interop, pet-triggers,
raid-sessions-rust, tts-queue-burst.

The modules used in-process by bucket C (number of checks per module family): handlers 37, domain_events 22,
utils/ast_parser 19, server/services 15, overlays 15, pets 12, utils/permissions 12, utils/timer_runtime 9,
server/routes 8, commands 7, functions 7, roulette 6, utils/ai 5, bot 5, utils/tts 5, utils/follow_defense_queue 5,
utils/moderation 5, plus ~45 families with 1–4 checks each. Most shared entry points:

| internal function | checks |
|---|---:|
| `handlers/special_parser.handler#parseSpecialCommands` | 18 |
| `utils/ast_parser/parser#parse` | 12 |
| `utils/ast_parser/evaluator#createExecutionContext` / `#evaluate` | 12 / 11 |
| `pets/peers#petPeers`, `pets/admission#admitPetAction` | 9 / 9 |
| `utils/timer_runtime#renderTimerMessage` | 9 |
| `overlays/store#Studio` | 8 |
| `domain_events/twitch_eventsub_events#normalizeTwitchEventsubDomainEvent` | 7 |
| `handlers/message.handler#messageHandler`, `handlers/commands.handler#commandHandler`, `handlers/tts_queue.handler#ttsQueueHandler` | 6 / 6 / 6 |
| `domain_events/chat_announcement_events#applyChatAnnouncementDomainEvent` | 6 |
| `bot/eventsub.twitch#createTwitchEventsubApp` | 5 |

So one AST evaluation entry point (CLI `ast eval --channel … --json` or Rust tests) covers ~20 checks, and one bot
chat-ingress seam covers the handler-driven ones. Per-check internal calls: `tests.json → checks[].internal_calls`;
110 of the 170 IMPORTS-APP checks also talk to the running candidate over loopback (`talks_to_candidate_network`).

**Parity/oracle checks** (cron, bucket C/F): `dashboard-activity-rust`, `follow-defense-baseline-rust`,
`raid-analytics-rust`, `raid-analytics-change-driven`, `roulette-completion-rust`, `stream-activity-rust`,
`rust-only-cron`, `cron-supervisors`, `ai-usage-receipts-rust`, `raid-sessions-rust`. They compare the native binary
with TypeScript reference functions (`*-fixtures/reference.mjs`, `dima-rust/tests/fixtures/stream_activity.mjs`) and
use `native-cron-fixture.mjs` spawn interception (`registerHooks`, `createFixtureSpawn`) inside the Node supervisor.
Record the reference outputs as golden JSON before the TypeScript is removed, and give `cron_index` a test registry
(fake child commands by configuration) instead of Node spawn hooks.

### Checks per backend target, ordered by behaviour covered

Order: PASS groups printed, then assert count, then size. Letter = bucket (A–F) or BL/BR/OT; P = uses an in-process
preload; `+x` = also runs for target x. Full ordered lists with counts: `tests.json → backend_target_checks`.

- **api — 130 checks** (IMPORTS-APP: C 83, A 21, F 8, D 7, B 2, E 1; BROWSER 5, BLACK-BOX 2, OTHER 1; 90 use preloads;
  119 need mongo+redis). Top 25: custom-widgets-engine-api C, polar-entitlements C (+bot+cron), bot-chat-access-api C,
  roulette-import-api C, raid-sessions C (+bot), twitch-goals C (+bot+cron), billing-subscription-checkout A,
  downstream-queue-durability C (+cron), redemption-limits-api A, custom-widgets-api C, pet-runtime C (+site),
  credit-gifts C (+cron), desktop-reauth-api C, account-deletion A, dynamic-defense C (+cron), overlay-interactions C
  (+bot+cron), follow-defense C (+bot), currency-goals C (+bot+cron), goals C (+cron), overlay-widget-modules-api C,
  moderation C, raid-directions C (+bot+cron), dashboard-insights C (+cron), stream-timeline C (+bot),
  follow-defense-summary C (+bot). Largest by assert count among the rest: desktop-ai B (258), duel-backend C (193),
  spam-protection C (154), site-agent-api A (146), semantic-moderation C (143), dima032-r4-api F (135),
  widgets-backend C (131), fish-api C (128).
- **bot — 43 checks** (IMPORTS-APP: C 36, D 4, F 2, A 1; 36 use preloads; 41 need mongo+redis). Top: custom-widgets-bot A,
  polar-entitlements C, raid-sessions C, shoutout-ast C (+cron), twitch-goals C, overlay-interactions C,
  follow-defense C, currency-goals C, raid-directions C, stream-timeline C, dashboard-emotes C (+cron),
  follow-defense-summary C, bot-chat-only-moderation C, tts-controls C, overlay-links C, overlay-controls-api C,
  widgets-backend C (131 asserts), pet-configured-triggers C (107), roulette-backend C (75).
- **cron — 62 checks** (IMPORTS-APP: C 56, F 4, A 1; BLACK-BOX 1; 49 use preloads; 59 need mongo+redis). Top:
  dashboard-activity-rust C (34 groups/249 asserts), ai-usage-receipts-rust F (23/302), raid-sessions-rust F (20/266),
  raid-analytics-change-driven C (20/126), roulette-completion-rust C (19/194), polar-entitlements C,
  follow-defense-baseline-rust C (11/89), raid-analytics-rust C (historical), shoutout-ast C, twitch-goals C,
  cron-supervisors C (8/92), downstream-queue-durability C, event-pipeline-recovery C, credit-gifts C,
  stream-activity-rust C (6/69), rust-only-cron C, dynamic-defense C, overlay-interactions C, currency-goals C, goals C.
  Only `pet-cron-startup.mjs` is black-box.

---

## C. Verify mechanics and what changes for Rust-only images

### How a candidate is built and checked today (`ops/saas_ops.py`)

- Targets `api`/`bot`/`cron` are one image from `dimabot/dockerfile` (`node:24-alpine`, `WORKDIR /app`,
  `npm install --include=dev` line 41, `npm run build` line 68, no `USER`, so root) with different commands:
  `node dist/server/index.js` (port 3000, health `/config/site/analytics`), `node dist/bot/index.js`,
  `node dist/workers/cron.index.js` (`saas_ops.py:112-114`).
- `build` snapshots Git-visible files (`snapshot`, `saas_ops.py:299-325`), then `docker build` with run labels
  (`build`, `saas_ops.py:614-665`).
- `verify` → `verify_container` (`saas_ops.py:806-870`):
  - Dependencies: with any `--dependency`, a new `--internal` network (`:812`) and `mongo:8.2.6`,
    `dragonfly:latest`, `pgvector:0.8.1-pg17` containers with aliases `mongo`/`redis`/`postgres`, 1 GiB / 1 CPU /
    256 PIDs each (`:124-128`, `:817-820`); local images only (`--pull=never`). Otherwise `--network none`.
  - Environment: `NODE_ENV=production` plus the `--test-env` JSON (uppercase keys, string values, `:821-829`).
    `NODE_OPTIONS` from that JSON is how preloads get into the app process — and, because `docker exec` inherits
    container env, into the check process as well.
  - App container: 3 GiB, 2 CPUs, 512 PIDs, `--cap-drop ALL`, `no-new-privileges`; cron alone gets
    `SETUID/SETGID/KILL` to drop privileges for native children (`:847-853`).
  - Fixtures: `docker cp <dir> app:/tmp/saas-fixtures` after a symlink check (`:843`, `:858`); the check:
    `docker cp check app:/tmp/saas-check.<ext>` (`:859`).
  - Readiness: container running and not restarted; for HTTP targets `docker exec app node -e "fetch(…)"`
    (`:709-737`, node command at `:725`); five stable seconds for port-less targets.
  - Check run: `docker exec --env SAAS_TARGET=<t> app node|python3|sh /tmp/saas-check.<ext>`, 300 s timeout
    (`:863-865`), then readiness again (15 s) and the last 150 log lines saved (`:868`). Cleanup removes owned
    containers/networks.
- Frontend targets run the check on the host with `SAAS_PREVIEW_URL`/`SAAS_TARGET` against the bundle served from
  loopback (`:781-788`).

### Existing Rust cron path

- `build cron` additionally runs `build_rust` (`saas_ops.py:500-612`): snapshot of `dima-rust` (only manifests,
  `src`, `tests`, `examples`), pinned `rust@sha256:557a94…` Alpine/musl compiler container with hard caps (6 CPU
  default or 1–6 via `--rust-cpus`, 6 or 4 GiB, no swap, 256 PIDs, 2 Cargo jobs, private 8 GiB cache, global lock,
  2 h limit), recipe `ops/rust_build.sh`.
- `ops/rust_build.sh` builds four feature profiles in sequence, each with `fmt --check`, `cargo tree` dependency
  guard, `check`, `clippy -D warnings`, `test`, release build: `mongo` → `stream_activity`, `raid_analytics`,
  `roulette_completion`; `mongo,redis` → `follow_defense_baseline`, `ai_usage_receipts`, `raid_sessions`;
  `mongo,redis,http-client,unicode-collation` → `dashboard_activity`; `cron-supervisor` → `cron_index`; then
  `--dry-run` of every binary. Forbidden-dependency lists per profile: `saas_ops.py:57-62`; binary list `:32-33`;
  profiles `:72-89`.
- The eight ELF binaries are staged in `source/.saas-native` (`:591-596`) and installed to `/usr/local/bin` by
  `dimabot/dockerfile:52-63`. The TypeScript supervisor (`node dist/workers/cron.index.js`) launches
  `/usr/local/bin/cron_index` (`dimabot/src/workers/cron_native_bridge.ts:3`), which supervises the seven native
  workers; TS workers stay under the TS supervisor.
- Cron checks reach the native children through `cron-boot.mjs` preloads + `native-cron-fixture.mjs` (spawn hooks,
  `/proc` identity reads) and stage `dima-analytics/src/store.mjs` as a validator (`ops/README.md:96-127`).

### What must change for candidates containing only Rust binaries

1. **Target commands** (`saas_ops.py:112-114`) → Rust binaries; `dimabot/dockerfile` → a Node-free runtime image.
2. **Readiness** (`saas_ops.py:725`) uses `node` inside the candidate → probe from the checker (below) or a
   `--healthcheck` subcommand in each binary (python3 is not available either).
3. **Check execution** (`:859-865`) copies the script into the candidate and runs its `node` → run it in a separate
   checker container.
4. **`NODE_OPTIONS` preloads** (129 checks) do nothing in a Rust process → provider mocking by configuration:
   base-URL env overrides where they exist (`QDRANT_HOST`, `PUBLIC_API_URL`…) and, for fixed production URLs, the
   `HTTPS_PROXY` + fixture CA (`SSL_CERT_FILE`) pattern already proven by `dashboard-activity-rust-fixtures`. The
   existing `providers.mjs` files are written as `fetch(url, options) → Response` handlers, so they can be mounted
   unchanged behind a small HTTP/CONNECT server.
5. **`/app/dist` imports** (170 checks) → buckets above.
6. **Cron spawn interception** (`native-cron-fixture.mjs`, 27 `cron-boot.mjs` preloads) → `cron_index` test
   registry/config file that substitutes child commands, plus `/proc` reads done from the cron container (the
   checker cannot see another container's `/proc` unless it shares the PID namespace: `--pid container:<app>`).
7. **`/tmp/saas-fixtures` as a shared channel**: many checks write state files there that the in-app preload reads
   (e.g. `account-deletion-fixtures/providers.mjs`: `polar-state.json`, `polar-calls.jsonl`) → mount one
   task-owned volume/tmpfs into both the mock-provider/checker container and the app.

### Recommended checker-container design

- **Image:** a pinned `node:24-alpine` digest with a lockfile under `ops/` (`mongodb`, `mongoose` only while
  bucket-A checks still use schemas, `redis`, `ws`, `socket.io-client`, `express`, `bson`, `pg`, `jsonwebtoken`,
  `standardwebhooks`, `lua-redis-wasm` if kept). No application code; built and labelled by the helper like the
  dependency containers, `--pull=never`.
- **Network:** start it with `--network container:<app>` (and `--pid container:<app>` for cron). Sharing the app's
  network namespace keeps every hard-coded `127.0.0.1:3000` URL working unchanged and still resolves the `mongo` /
  `redis` / `postgres` aliases of the internal network; the app keeps `--cap-drop ALL`. The checker gets the same
  resource caps as other test containers and no Docker socket.
- **Provider mocks:** a mock-provider process (in the checker image) listening on loopback inside the shared
  namespace, serving the existing `providers.mjs` handlers over HTTP and as a CONNECT proxy with the fixture CA; the
  app gets `HTTPS_PROXY`/`SSL_CERT_FILE`/base-URL overrides through `--test-env`. Rust services must honour those
  variables for every outbound client (reqwest does by default).
- **Execution:** `docker cp` check + fixtures into the checker (or one shared volume at `/tmp/saas-fixtures`),
  `docker exec checker node /tmp/saas-check.mjs` with `SAAS_TARGET` and the 300 s limit; readiness via
  `docker exec checker node -e fetch(…)`; logs and cleanup unchanged. `.py` checks need `python3` in the checker.
- **Migration order:** convert bucket A/B first (25 checks, mechanical: replace `getMongoDBConnection`/
  `getDragonflyClient`/schemas with raw drivers and literal key names); move bucket D's 56 compiled test files into
  the Rust test suite with the rest of part A; give the bot a chat-ingress seam and the AST evaluator a test entry
  point before rewriting bucket C; freeze parity oracles as golden files before deleting TypeScript.
- Keep the Rust compiler path as is (no network, caps, cache); `cargo test` stays inside it, so tests that need
  Mongo/Redis (the 3 SERVICE tests, Lua scripts) should run as checker-side checks against disposable dependencies,
  not in the compiler.

### `ops/tests/**`

| file | cases | covers |
|---|---:|---|
| `ops/tests/test_ops.py` (1,509 lines) | 76 | `FakeOps` unit tests of `saas_ops.py`: target allowlist, run-id traversal, deploy gating on verification, cleanup ownership/labels, rollback/receipt state, bundle publish (inode, tamper, symlink), source snapshot exclusions, env override stripping, test DB settings, Rust snapshot/recipe/profiles/graph guards, Dockerfile staging of every native binary (`:405-417`), compiler caps (CPU/memory/PIDs/swap, headroom), cache identity/eviction/ownership, cron-only capabilities for native children (`:1423`), frontend publish/rollback/verify |
| `ops/tests/docker_smoke.py` (102 lines) | script | opt-in real Docker smoke: builds a fixture on the local dimadb image, passing/failing verification and cleanup, confirms production containers unchanged |
| `ops/tests/native_fixture_hooks.test.mjs` (242 lines) | 13 | `node:test` for `ops/checks/native-cron-fixture.mjs` and `cron-supervisors-fixtures/telemetry-assertions.mjs`: env allowlists, diagnostic parsing, ENOENT/nonzero translation, preload rejection of production aliases, once-mode doubles |

---

## How the numbers were verified

- File discovery: `find dimabot/src -name '*.test.ts'` = 254; plus 2 non-`.test.ts` files that import `node:test`
  and contain cases; 6 helpers by name (`*.test-data.ts`, `*.test-helper.ts`, `*.fixture.ts`, `*.test_util.ts`,
  `*.testutil.ts`). `grep -rl node:test dimabot/src` = 258 = 256 test files + 2 helpers that import `mock`.
- Case count: the AST count of `test`/`it` calls (1,918) equals an independent regex count of
  `(test|it)(.skip|.only|.todo)?(` followed by a string literal over the same files (1,918); `describe`/`suite` = 4
  both ways.
- Checks: `ls ops/checks` — 369 `.mjs`, 22 `.py`, 2 `.sh` files and 78 directories.
- IMPORTS-APP detection: static `import`, `await import()` (template literals resolved through same-file string
  constants), `require`, `spawn/execFile` arguments and file reads of `/app/(dist|src|test)/…` or `dist/…` paths,
  in the check and in the code files of its fixtures directory. 1,035 `'/app/dist/` import specifiers exist across
  the `.mjs` checks.
- Heuristic limits: PURE/MOCKED is a static classification (mocks, fakes, DI parameters, loopback servers, temp
  files); a PURE file may still pass hand-written fake objects the detector does not name. Targets for 15 api checks
  are `weak` (see `target_evidence`); 56 fixture-directory matches are by name; frontend site/admin split uses
  admin-only routes and names. Module "purpose" for schema files treats exported helpers (e.g.
  `upsertChannelTtsSettings`) as schema use. PASS-group counts parse `console.log('PASS…')`-style lines only.
