# Spam actual-source oracle authoring handoff — 2026-10-30

Status: oracle implementation and borrowed-view stress expansion are complete. Final Node source check, Rust correctness/strict phase, borrowed seven-pair benchmark, independent actor readback, and production/resource readback passed. The final evidence bundle retains both rounds and all failed attempts. Nothing here authorizes deployment, a push, or TypeScript retirement.

## Parent oracle result

The original Node oracle run `node-1793338563535107136` passed both `--write` and `--check`, covering 1,267 pure and 37 async records. The borrowed-view source check `node-1793340868529956618` passed `--write` and `--check` with fixture SHA-256 `f6f59d6c0a021ce609ac507ed88af22960eb2cf683c31d19ec3c146a2aebc222`; it covers 1,636 pure and 37 async records, including 369 added stress cases. All 14 runtime exports remain represented. Nine async cases use explicit synthetic boundary adapters and are not counted as native wire replays.

The final Node byte check `node-1793339590139731945` passed on the same frozen source tree and confirmed no generated fixture changes. The loader, reference reader, and benchmark reader SHA-256 values are respectively `24173a6f2eb5979c89aa27cf5804c4c2c9f92df02daf7a66d9479e5e52cb7b8a`, `ac89d58eeac529bb47f84a233342243c025c1701a6a47f16cf0a489ab35ae5de`, and `c006b946d59d3b994181cd7d4907c5cdf79a7c1874d5a4663ee0ac20a9ecd4a5`. The complete actual Mongoose package manifest is 707 files, digest `63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722`. Real disconnected Mongoose schemas and default policies are used, while advanced moderation calls the actual `paidModeration` implementation through the existing private Node 24 RE2 loader. These pins and raw reports must remain in the final evidence bundle.

The original correctness/strict phase `compiler-fixtures-1793339305113026630` passed seven units and all 1,267 pure/37 async records on tree `af844965a21ab0dc59c0d84fd6ebc950737f5399de537e795d69c7260f275fc8`, commit `4de832378acd341f415f59f99150b8d556f54f66`. The final borrowed-view phase `compiler-fixtures-1793340894915777003` passed all eight feature units and all 1,636 pure/37 async records on tree `1628f8c23147e68073ca16eb33683452fba0532e544662348fee381ccffe2694`, commit `16159856fd21044d42658c9a02eb56be1f313e89`, with 1,424 inputs. The final source check was `node-1793340868529956618`. Preserve the earlier `compiler-fixtures-1793339134095509298` as failed overall due to the extracted proxy's unused `Read` import. Borrowed benchmark `node-1793341268777902038` passed all 70 actor records; final readback confirms all 18 production records unchanged and zero task-owned containers, networks, or volumes. See the [native handoff](moderation-spam-native-handoff.md).

## Ownership and reuse

The bounded scope is the complete `dimabot/src/utils/moderation/spam.ts`, with the native implementation owned by the separate native author. The oracle reuses `moderation_advanced_source.cjs` for the pinned Node/TypeScript environment, real private RE2 SDK and the actual `advanced.ts` `paidModeration` implementation. `moderation_spam_source.cjs` is the one loader used by both source oracle and benchmark. It transpiles and executes the unchanged complete `spam_categories.ts`, `channel_moderation_settings.schema.ts`, `moderation_chatter.schema.ts`, and `spam.ts`. The actual schemas run through a new disconnected Mongoose instance with buffering disabled; source `buildDefaultModerationRules` and `MODERATION_SETTINGS_DEFAULTS` produce policy defaults. There is no copied JavaScript spam policy. Only ORM `updateOne`, Redis acquisition/commands and the deterministic Date clock are test seams.

The Rust replay reuses `tests/support/sha256.rs`, existing `JsonValue`/`JsString`, and the private bounded RESP endpoint from `tests/ai_credit_projection_support/mod.rs`. Concrete async calls use native `SpamService`, real private Mongo writes and appName-scoped once-only `failCommand`. They do not replace the production service with a fake business implementation. The native author's independent storage suite covers actual Dragonfly Lua quotas and TTL effects; this source suite separately checks exact source command contracts and result coercion through a scripted RESP endpoint.

## Exact source surface

Static inspection finds exactly 14 runtime exports and no own type exports. The loader asserts the full names, rather than relying on a guessed count.

| Source export | Replay |
| --- | --- |
| `SPAM_RULE_ID`, `SPAM_CHANNEL_REVIEWS_PER_MINUTE`, `SPAM_GLOBAL_REVIEWS_PER_MINUTE` | Exact tagged constants |
| `spamRule` | Native `spam_rule_template_value`, all ordered fields |
| `broadcasterInvitedPromotion` | Native value API, EN/ES acceptance and negatives, strict broadcaster boolean, sparse context, whitespace/newlines, Kelvin/long-s, combining characters, astral and lone UTF-16 units |
| `spamRuleForContext` | Native value API, invitation policy, categories, thresholds and exemptions |
| `spamProtectionSettings` | Native value API, nullish protection/fields, explicit booleans, empty/unknown/duplicate categories, string spreads and IEEE-754 thresholds |
| `defaultSpamModerationSettings` | Actual native returned settings, tagged Dates and field order |
| `spamReviewSource` | First/subsequent message, disabled/empty categories, opt-in, free/paid/unknown tiers |
| `isSpamDecision` | Rule ID and review-source combinations |
| `semanticPolicyActive` | Missing/null settings, zero/default/saved/nonfinite versions, spam/custom branches and enabled rules |
| `chatterMarkerID` | Pair order, JSON delimiter/escape distinctions, empty/Unicode/unpaired strings |
| `claimFirstObservedMessage` | Full ordered cache/ORM call transcript, upsert query/update/options, fixed source Date, truthiness, duplicate/error/cache behavior and real durable write |
| `claimSpamReviewBudget` | Exact Lua bytes, ordered key/arguments, Number coercion and error paths |

Every pure source record is crosschecked between normal CommonJS and a VM before emission, and every emitted pure record is visited by native replay. Every async record is visited; explicit synthetic-boundary adapters are reported separately rather than counted as native wire passes. Source identity evidence records fresh outer/semantic/settings objects and shared nested offenses, arrays and examples. Native replay checks available shared Arc identities; owned JSON does not expose JavaScript reference identity.

All imports, mixed type/value bindings and exported declarations are recorded from the actual TypeScript AST. Type-only `PermissionExpression`, `IModerationDecision`, `ModerationContextMessage`, and `IChannelModerationSettings` views are audited without loading their application modules. The native views needed by spam are the existing permission/settings types plus `DecisionView` and `ContextMessage`; the generic JSON APIs retain ordinary malformed/unknown JSON where the typed API cannot. Complete original declarations and exact source hashes remain in the fixture's evidence.

## Pins

Required environment/SDK:

- Node `24.22.1`, V8 `13.6.233.17-node.58`, ICU `78.3`, Unicode `17.0`, ABI `137`.
- Node executable SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`.
- TypeScript `5.9.3`; Mongoose `8.24.2`.
- RE2 private binary `94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`.
- RE2 source manifest `e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664`.
- RE2 build provenance `4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c`.
- Canonical complete 707-file Mongoose manifest: `63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722` (full-path lexical ordering, compact JSON).
- `spam.ts`: `eaa35698ebd7f7e2351e522ca4ece5a3d96b58a96acc41b162b6f22eb2adaaa8`.

The loader pins the complete source inputs, tsconfig/package/lockfile and SDK entrypoints through its shared loader. Reports include transpiled hashes, the full Mongoose file manifest, actually loaded SDK module hashes, source-reader hashes and private RE2 provenance. `DIMA_SPAM_LOADER_SHA256`, `DIMA_SPAM_READER_SHA256` and `DIMA_SPAM_BENCH_READER_SHA256` must be independently supplied from the frozen source receipt; do not derive a fixture's trusted hash from the fixture itself during replay.

## Parent commands inside isolated candidates

Use the established capped compiler/read-only source snapshot and private Node 24 environment. These commands are **inside** the parent's isolated containers, from `/source/dimabot`; they are not host-run instructions. Preserve all production-identity checks, CPU/memory/no-swap/build-lock rules from the root/Rust guides.

Set the existing `DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot`, `DIMA_ADVANCED_RE2_FIXTURE_ROOT=/artifacts/moderation-advanced/re2-node24/re2`, and the three exact RE2 SHA variables above. Supply the three reader/loader digests from the frozen source receipt. Prepare separate empty external directories for the two writers.

```sh
node --check tests/fixtures/moderation_spam_source.cjs
node --check tests/fixtures/moderation_spam_reference.cjs
node --check tests/fixtures/moderation_spam_benchmark.cjs
node tests/fixtures/moderation_spam_reference.cjs --write /artifacts/moderation-spam/reference
node tests/fixtures/moderation_spam_reference.cjs --check /artifacts/moderation-spam/reference
node tests/fixtures/moderation_spam_benchmark.cjs --write /artifacts/moderation-spam/benchmark
node tests/fixtures/moderation_spam_benchmark.cjs --check /artifacts/moderation-spam/benchmark
```

`--write` requires an absolute, external, already empty directory and uses exclusive file creation. Reference `--check` requires exactly its emitted file. Benchmark `--check` permits exactly its two input/report files and named seven-pair sample files, then compares regenerated source inputs/reports and verifies sample checksums.

After parent feature wiring, compile in the capped compiler:

```sh
cargo test --locked --no-default-features --features moderation-spam --test moderation_spam_source --no-run
cargo test --locked --release --no-default-features --features moderation-spam --test moderation_spam_benchmark --no-run --message-format=json
```

Run the compiled source test binary in the private runtime fixture, after independently pinning `DIMA_SPAM_REFERENCE` and `DIMA_SPAM_REFERENCE_SHA256`. Set `DIMA_SPAM_READER_SHA256` and `DIMA_SPAM_LOADER_SHA256` there as well. The concrete async test requires `DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`, `KEYWORD_FIXTURE_MONGO_URI=mongodb://keyword-mongo:27017`, `KEYWORD_FIXTURE_REDIS_URL=redis://keyword-redis:6379/`, a unique `KEYWORD_FIXTURE_NAMESPACE` matching the existing fixture format, and `DIMA_SPAM_FAILPOINT_OWNER` equal to that namespace. Mongo must be task-owned, private and started with `enableTestCommands=1`.

```sh
/path/to/exact/moderation_spam_source all_pure_source_records --ignored --exact --nocapture
/path/to/exact/moderation_spam_source all_async_source_records_through_private_protocols --ignored --exact --nocapture
```

Source-marker Dates are fixed at `1700000000123`; concrete native marker Dates are checked within the test's before/after wall-clock interval. Only timestamp value receives this explicit clock adapter. Source async exception names/text remain captured, while native driver errors are compared by success/failure and command boundary because SDK diagnostic wording differs.

## Matched benchmark and coordinator adaptation

Workloads are `invitation`, `settings`, `rule_context`, `review_policy`, `marker`. Each has 32 unique prepared inputs. `review_policy` exercises both source review-scope and semantic-policy functions. Both actors validate all workload outputs before timing, run three complete full-size warmups, retain outputs through the end of timing, and compute scalar checksums afterwards. Decoding, source transpilation/module initialization, pool construction, output validation, checksum traversal, reporting and temporary-result drops remain outside the timed interval. The Rust timed calls and results use `black_box`. Source CommonJS/VM correctness is checked during fixture construction; timings use normal CommonJS.

The existing parent `variations_paired_coordinator.cjs` protocol is retained: Node `--expose-gc ... --actor WORKLOAD`; Rust `benchmark_sample --ignored --exact --nocapture`; identical metric fields (`actor`, `workload`, `rounds`, `operations`, `warmups`, `warmupOperations`, `nanoseconds`, `checksum`, `inputSha256`). Rename its env prefix/path/feature/required-input declarations to spam. Use `DIMA_SPAM_BENCHMARK_FIXTURE`, `DIMA_SPAM_BENCHMARK_SHA256`, `DIMA_SPAM_BENCH_ROUNDS`, `DIMA_SPAM_BENCH_WORKLOAD`, `DIMA_SPAM_LOADER_SHA256`, `DIMA_SPAM_BENCH_READER_SHA256`. Run seven fresh process pairs per workload, alternating actor order, after compilation has stopped.

One deliberate fixture-format adaptation is needed: each case result is `{ok:true,value:<tagged value>}`. Copy the small `checksum` visitor from the spam benchmark to replace the coordinator's `resultChecksum`; apply it to repeated `case.result.value` values. It hashes primitive tags, raw number bits, UTF-16 units and ordered entries/arrays, avoiding host JSON serializer key-order differences. Both actors use the same visitor. Preserve the parent's exact source/binary/input/SDK pin checks, immutable before/after hashes, bounded subprocess cleanup, receipts and static ELF/build provenance checks. No performance result is claimed until the parent runs and packages that evidence.

## Remaining limits and required verification

- All runtime, syntax, compile, formatting and performance checks are unexecuted by this author. Parent must inspect and run them before any completion claim or commit.
- The existing generic JSON type has no native JavaScript `undefined`, holes or Date identity. Object properties with undefined are omitted at the ordinary JSON adapter; sparse `.some` context holes are compacted because the function observes neither indices nor array length. Tagged source fixtures preserve every original distinction. Default native Dates are compared explicitly as tagged milliseconds.
- Acquisition-error mocks run before there is a Redis handle. Their source transcript is audited and explicitly reported as an application-boundary adapter, not a native wire pass. The concrete service's application acquisition path needs its own runtime-owner/error proof if required for full adoption.
- Non-string GET mock values are mapped to RESP null/string with identical source truthiness; ordinary source SDK GET is string/null. A mock string `upsertedCount` cannot come from real Mongo's numeric UpdateResult and is mapped to an existing durable record, with the same false result and full operation order. Boolean/object EVAL mocks use explicit Number-equivalent RESP representations. Native protocol errors retain SDK messages rather than synthetic JS exception text.
- JavaScript nested object/reference identity, notably shared semantic `examples`, is not exposed by owned JSON. Source identity observations are retained; native Arc-sharing checks cover offenses, terms and allowlist arrays. Do not infer unrestricted JS mutation/reference parity from value replay.
- Real Dragonfly budget execution, server-clock windows, quotas, TTL readbacks and durable races belong to the native author's separate concrete storage suite; run it as well. This source replay's scripted RESP EVAL replies test exact command bytes and coercion, not Lua evaluation.
- Complete production caller adoption, deployment and the rest of the dependency graph are separate from these oracle/benchmark authoring files. This handoff does not establish 100% migration completion.
