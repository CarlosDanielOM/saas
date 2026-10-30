# Moderation chatter schema: focused model and first-seen verification handoff

**Status: isolated parent verification passed.** The authored tests and fixture
are recorded in source commit `81f2d07ce7adc09fb27b59199c9715f83ed3bbde`.
The author did not run Cargo, rustfmt, Node, application, tests, containers,
network, deployment, or Git commit/push commands. The parent ran the capped,
isolated verification summarized below. Production was not touched; final
readback found all 18 production records unchanged and no task-owned resources.

## Scope and owned files

New files only:

- `dimabot/tests/moderation_chatter_schema.rs`
- `dimabot/tests/fixtures/moderation_chatter_schema_reference.cjs`
- `migration-notes/moderation-chatter-schema-handoff.md` (this file)

No native production source, central wiring, archive, shared resolver,
ORCHESTRATOR matrix, or other contributor's files were edited. No new Cargo
crates were added.

## Confirmed source facts

Read directly from the current checkout:

- `src/schemas/moderation_chatter.schema.ts` exports exactly one value,
  `ModerationChatter = model('moderation_chatter', schema)`. The descriptor is
  `_id: { type: String, required: true }`, `firstSeenAt: { type: Date,
  required: true }`, with `{ versionKey: false }`. It declares no custom index,
  default, hook, TTL, or collection option.
- `src/schemas/moderation_chatter.schema.rs` mirrors that descriptor:
  collection `moderation_chatters`, `string_id: true`, `version_key: false`,
  no indexes, no timestamps/save clock, both fields required.
- `src/utils/moderation/spam.ts` `claimFirstObservedMessage` computes
  `chatterMarkerID(channelID, userID)` (SHA-256 of `JSON.stringify([channel,
  user])`), consults the cache, then performs the atomic
  `ModerationChatter.updateOne({_id}, {$setOnInsert:{firstSeenAt:new Date()}},
  {upsert:true})`. Only `upsertedCount === 1` is a first observation; duplicate
  key 11000 is treated as not-first.
- `src/utils/moderation/spam.rs` `SpamService::claim_first_observed_message`
  is the native production primitive for the same behavior against the real
  `moderation_chatters` collection, with `upserted_id.is_some()` as the
  first-seen result and the same duplicate-key handling.
- Existing coverage: `tests/moderation_spam_source.rs` replays one valid
  disconnected chatter document and the full claim protocol through private
  Redis/Mongo fixtures. `tests/fixtures/moderation_spam_reference.cjs` covers a
  single valid constructor shape only. The missing gap was a focused actual
  model constructor/cast/validation oracle plus concrete repository CRUD and a
  real-Mongo atomic first-seen proof, which this handoff adds.

## Pinned actual-source oracle

`tests/fixtures/moderation_chatter_schema_reference.cjs`:

- Pins Node `24.22.1` (binary SHA-256
  `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`), V8
  `13.6.233.17-node.58`, ICU `78.3`, Unicode `17.0`, TypeScript `5.9.3`,
  Mongoose `8.24.2`, BSON `6.10.4`. `DIMA_SCHEMA_NODE_SHA256` must equal the
  Node pin and the executing binary is hashed.
- Resolves the live source at
  `src/schemas/moderation_chatter.schema.ts` only (regular file, pinned SHA-256
  `71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e`, the same
  pin already used by `moderation_spam_source.cjs`), and rejects a shadowing
  archive copy.
- Records the actual AST import/export/declaration metadata and type-checks the
  complete module with the pinned Mongoose types (`getPreEmitDiagnostics` must
  be empty).
- Compiles with pinned TypeScript and executes the complete module in a
  restricted CommonJS boundary whose only import is a disconnected, pinned
  `Mongoose` instance (`readyState === 0`); it never connects, creates indexes,
  queries, or writes.
- Records `modelMetadata` (model name, derived collection, `versionKey`,
  `indexes()`, schema paths, per-path instance/required/default), plus
  `constants`, per-case expectations, and a typed BSON wire sample.
- Focused cases cover missing/`null`/empty required fields, String casts
  (numbers, booleans, zero, fractional, wide `1e21`), Date casts and JS Date
  extremes (`0`, fractional, ISO string, `±8640000000000000`, out-of-range and
  invalid strings, empty string), and unknown-field/`__v` dropping.
- `--write` requires an external canonical empty directory and creates exactly
  one file with `flag:'wx'`; `--check` requires exactly that file and compares
  the bytes. The directory must be outside the source root, the workspace root,
  and the workspace subtree.

Output name: `moderation-chatter-schema-reference.json`.

## Rust test

`tests/moderation_chatter_schema.rs` is gated on `moderation-spam`.

Ordinary, no-environment tests:

- `descriptor_matches_the_single_source_model` checks the native descriptor,
  field order, required flags, absent defaults/indexes/timestamps/hooks.
- `constructor_required_string_and_date_casts` checks missing/null/empty
  required errors, String/Date casting, unknown-field and `__v` removal, and
  `prepare_insert` without a version key.
- `string_casts_cover_numbers_booleans_and_wide_values` checks the cast matrix.
- `date_casts_cover_extremes_and_reject_out_of_range_values` checks truncation,
  ISO parsing, the inclusive JS Date range, and out-of-range/invalid rejection.
- `flat_set_on_insert_preparation_is_bounded_and_typed` checks the production
  `SchemaDefinition::cast_flat_set_on_insert` preparation used for bounded
  `$setOnInsert` upserts, including unsupported filter/update shapes.

Ignored tests:

- `replay_actual_mongoose_source` requires
  `DIMA_CHATTER_SCHEMA_FIXTURE_DIR` and an independently supplied
  `DIMA_CHATTER_SCHEMA_FIXTURE_SHA256`. It re-hashes the fixture, verifies the
  pins/versions, source provenance `live`, every embedded repository/native/
  build file hash, the recorded npm digest shape (the independent fixture hash
  covers those bytes), source/model metadata, replays every constructor case
  through the native constructor, and checks the typed BSON wire bytes.
- `mongo_crud_and_atomic_first_seen` requires an ownership-guarded disposable
  MongoDB fixture. It creates a unique `<namespace>_chatter_<8hex>` database,
  asserts it is empty, writes an `_owner` record, exercises the real native
  repository (insert/find/save/required-ID validation/duplicate-key/delete), then exercises
  the production `SpamService::claim_first_observed_message` against real Mongo
  with a loopback RESP cache. It verifies first-claim `true`, durable
  `moderation_chatters` shape, a fresh service/cache instance with a cache miss receiving `false`
  without overwriting `firstSeenAt`, a warm cache hit skipping Mongo, and a
  distinct chatter claiming its own marker. The body runs in a spawned task so
  the test always verifies `_owner` and drops the unique database before
  reporting a body panic.

The loopback RESP endpoint (`tests/ai_credit_projection_support/mod.rs`,
reused unmodified) is the only test seam; production `SpamService` code runs
unchanged, and no external Redis is needed. Mongo is real and strictly the
task-owned fixture endpoint.

## Parent verification outcome

The source-bound Node fixture run passed write and check modes, each reporting 25 actual-Mongoose cases and SHA-256 `42a11d1ed626b0be9fac05e8afce671dce33b442da69f5a53905e4e201394358`. An earlier Node attempt failed before fixtures because TypeScript's reverse enum alias was `FirstStatement`, not `VariableStatement`; the harness was corrected to use the structural predicate `ts.isVariableStatement` and then passed. The generated fixture pins the live TypeScript module and a disconnected Mongoose instance; it performs no database operation.

The capped compiler-fixture run passed all seven tests: five ordinary tests, the 25-case actual-Mongoose replay, and the real-Mongo CRUD/atomic-first-seen test. The compiler log records `7 passed; 0 failed` and 0.08 seconds of test execution. The same job passed formatting, scoped Clippy, the minimal-feature check, and all-feature Clippy with warnings denied. It used the existing task-owned Cargo/target cache through canonical symlinks under a global compiler lock, with no overlapping phases or duplicate cache. Limits were six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs; the receipt records 70.023 seconds total, 57.891 seconds for the compiler step, 12,473,569,280 minimum available bytes, and 8,186,486,784 peak cache bytes.

Before that run, parent static review corrected the authored required-ID expectation: `insert` returns `PersistenceError::Validation` before reaching the missing-ID guard. This changed a test expectation only; production logic was not changed. The initial failed attempt and its 16 source overrides remain preserved separately from the final source binding.

Run receipts, full logs, exact source/oracle bindings, the failed attempt, production readback, and inert reproduction scripts are indexed in [`evidence/2026-10-30-moderation-chatter-schema/`](evidence/2026-10-30-moderation-chatter-schema/README.md). No deployment, caller adoption, TypeScript retirement, new Cargo dependency, or benchmark was part of this verification.

## Deliberate limits

- This is a focused single-model contract, not a port of the arbitrary Mongoose
  npm API. The typed ordinary BSON boundary is explicit; accessors, symbols,
  proxies, functions, BigInt, cycles, and executable coercion hooks are out of
  scope.
- Boolean/array/object Date inputs are excluded here because the separate
  `tests/mongoose_date.rs` oracle already owns that full matrix; including a
  subset here would duplicate it without adding model-specific value.
- The duplicate-key (`11000`) fallback inside `claim_first_observed_message`
  is not directly forced here; the atomic test exercises the matched-upsert
  path (`upserted_id == None`). The existing protocol fixtures own fault
  injection for the duplicate branch.
- Caller adoption, the wider spam feature surface, and any decision to retire
  `src/schemas/moderation_chatter.schema.ts` remain separate. The TypeScript
  source is intentionally still live and is **not** declared retired.
- Deployment is out of scope. Passing these checks does not authorize a
  production release.

## Authorship and release boundary

The test and fixture author did not execute builds, tests, or runtime checks;
the parent results above are the verification record. No deployment, caller
adoption, push, or production release was performed or authorized by these
tests. The TypeScript schema remains active, and this focused evidence does not
complete the broader spam migration.
