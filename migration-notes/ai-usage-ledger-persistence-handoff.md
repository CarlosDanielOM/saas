# AI usage receipt persistence — integration and verification handoff

2026-10-29. Historical authoring status: this handoff was originally author-only
and unverified for its then-current guard revision; that status applied only
to that earlier snapshot. The parent has since integrated and verified the
bounded adapter at code commit
`a872419d87d7a43672efb7fc9024c4d4963a7f97`, source tree SHA-256
`390eb3029166aa393ba3d863997faa14a67cae5fc4bcd0309fffa91d9c1f1dda` with
1,289 inputs. See the [dated verification note](ai-usage-ledger-persistence-2026-10-29.md)
for the exact runs, accepted boundary, and remaining gaps. The independent
readback confirmed the package at
`migration-notes/evidence/2026-10-29-ai-ledger-persistence/`: 204 files total,
203 indexed file hashes, 94 compressed raw-payload hashes/sizes, 10 reconstructed
failed-source bindings, and 29 run receipt/log pairs. This update does not claim
final readback also confirmed 19 acknowledged production records unchanged
and zero owned containers, networks or volumes. Full ledger parity, migration
completion, caller adoption, deployment and push are not claimed.

## Files and source scope

| New file | Responsibility |
| --- | --- |
| `dimabot/src/utils/ai_usage_ledger_persistence.rs` | Explicit Mongo database/shared Redis adapter, receipt upsert policy, daily query/reducer/insert preparation |
| `dimabot/src/utils/ai_usage_aggregate_policy.rs` | Only the existing pure Mongo `usage()` and `group_fields(id, dashboard)` expression builders |
| `dimabot/tests/ai_usage_ledger_persistence.rs` | Independent policy cases, ignored complete source replay, guarded real Mongo/Redis checks |
| `dimabot/tests/fixtures/ai_usage_ledger_persistence_reference.cjs` | Offline actual-source AST/Mongoose oracle with strict external `--write`/`--check` |
| This file | Integration/verification handoff |

Source is `dimabot/src/utils/ai_usage_ledger.ts`: private `receiptDocument`,
exported `persistAiUsageReceipt`, and private `rebuildUtcDailyAggregates`, plus
their complete retention/category/classification/type dependencies. Backfill,
state writes, API adoption, telemetry bootstrap, and TypeScript retirement are
outside this task. `rebuild_utc_daily_aggregates` is reusable by future backfill,
but does not implement backfill or acquire its caller's account lock.

The exported source signature is
`persistAiUsageReceipt(receipt: QueuedAiUsageReceipt, planTierInput: unknown):
Promise<'inserted' | 'duplicate' | 'expired'>`. The native `persist_ai_usage_receipt`
borrows the existing producer DTO directly; `persist_parsed_receipt` accepts an
already normalized parser DTO, and `persist_value` accepts lossless plain data.
No producer receipt is serialized and reparsed through the normalizing parser.
String fields permit absent/null/string, numeric fields permit absent/null/all
binary64 values, and itemized permits absent/null/bool; identity channel/customer
and occurredAt use their declared string types. Arbitrary UTF-16 remains intact
through the lock identity. Hooks, accessors, functions, custom prototypes and
undeclared runtime field-type substitutions are outside that plain-data API.

## Reuse inventory and actual remaining gap

* `ai_usage_producer.rs`: reuse `QueuedAiUsageReceipt::as_value/get` and
  `ReceiptClock`, `SystemReceiptClock`, `FixedReceiptClock`. A borrowed producer
  quantity can contain NaN; its direct persist must expose the Mongoose cast
  error rather than turn JSON NaN into null.
* `ai_usage::normalize_receipt_category`: use the parent-assigned shared enum
  table policy for receipt construction and group category normalization.
  This delegate does not edit the category policy or other consumers. Parent
  verification must include its affected producer/parser/query parity cases.
* `ai_usage_receipt_parser.rs`: reuse `RetentionTier` and the normalized DTO.
  Its `to_bson_document` cannot replace raw producer mapping: it assumes parser
  normalization and finite values, and omits update middleware/default policy.
* `ai_usage_lock.rs`: use the real `AiUsageLock` over the supplied manager, with
  its existing UUID ownership, Lua fences, contention/renewal, callback-error
  precedence and finally release. Do not replace it with the worker lease.
* `ai_usage_ledger_reads.rs`: reuse crate-visible `ordinary_json` and
  `array_coercion_value` for BSON default promotion and wrapper adaptation.
  Number/String/array coercion uses the existing `tts::settings` and
  `json_number` helpers, not a second language interpreter.
* `js_string`, `credit_policy::JsDate`, `js_date` and `mongoose_date`: reuse
  UTF-16 slicing, TimeClip/ISO, actual V8 date parsing and Mongoose date casting.
  Local dates retain the existing fixed-process-TZ/tzdata limitations.
* Four actual native schemas and `SchemaDefinition::native_collection`: reuse
  application collection ownership. Daily `construct` supplies selected known
  defaults, required/enum validation, Number casting and minimize. It is not an
  all-purpose Mongoose update/insertMany adapter.
* `ai_usage_receipts/{ledger,values,queue}.rs`: only the pure expression builders
  can be shared directly. The private worker Receipt/parser, numerical reducer,
  mathematical midnight floor and worker lease differ from the source request
  contract. No worker parser/lease/reducer is declared complete by this task.

The gap filled here is a concrete request-time native Mongo/Redis write adapter,
including the selected Mongoose update and insertMany policies. It performs real
driver calls; the oracle collection double is only source evidence. Parent
verification covers the declared adapter behavior, while whole-file source
parity and total migration completion remain unclaimed. Legacy expiry arrays
containing Date/RegExp values, including nested arrays, and a top-level RegExp
expiry are explicitly unsupported. The reducer rejects them with native
`UnsupportedLegacy` before daily deletion. Source Mongoose may accept a `[Date]`
expiry and insert a valid daily row, so this remains an intentional partial-
parity boundary. Normal top-level Date, supported scalar/array values and
ordinary object coercion retain their existing behavior. No document-field
traversal is added: ordinary `Object.toString` does not inspect stored
Date/RegExp fields. Nested-array checking uses an explicit stack over the finite
owned BSON tree, with no recursive call stack or new application waits. The
existing 204 source scenarios and full wire assertions remain; no source case
was removed to conceal this boundary.

## Integrated implementation shape

Integrated opt-in feature, using only existing dependencies:

```toml
ai-usage-ledger-persistence = ["ai-usage-lock", "ai-usage-producer", "ai-usage-receipt-parser", "ai-usage-ledger-reads", "application-schemas"]
```

`src/utils/mod.rs` declares the public persistence module only under that
feature. `pub(crate) mod ai_usage_aggregate_policy` is declared under
`all(feature = "mongo", feature = "redis")`. The shared expression module has
only Mongo BSON imports; it does not add application schemas or TTS dependencies
to the worker graph. The extra reads feature is required for its existing
crate-visible BSON compatibility helpers; no visibility edit is necessary.

Mechanically remove only `usage` and `group_fields` from
`src/utils/ai_usage_receipts/ledger.rs` and add
`use crate::utils::ai_usage_aggregate_policy::group_fields;`. The new function
bodies are copied exactly, apart from `pub(super)` becoming `pub(crate)`.
The original worker tests continue to reach the imported `group_fields` through
their `super::*`. Its `aggregate` function, private persistence/rebuild, queue,
dashboard caller, loops, I/O, waits, worker registration and profiles are untouched.
No existing file was edited by this delegate.

This extraction affects the AI-receipt worker's UTC grouping and dashboard
grouping expressions. The parent passed the affected worker grouping test and
worker-profile check. This is a real shared implementation impact, but does not
establish impact on unrelated cron workers.

## Selected behavior that must be checked

Dashboard dirtying precedes receipt construction and expiry rejection. Expired
means `expiresAt.getTime() <= Date.now()`, including equality. Upsert uses only
`$setOnInsert`, aside from Mongoose's `$set.updated_at`; duplicates still rebuild
daily data to repair a receipt-only prior crash. Required/enum validation does
not run for the source updateOne. Source `__v`, null defaults, created/updated
timestamps, reverse cast-path precedence and missing versus explicit null are
represented explicitly; no `_id` default is installed in an update.

The application clock and Mongoose middleware clock are separate, sampled on
execution rather than construction. Daily timestamps are sampled only for rows
that pass prevalidation. The source's string-prefix day calculation is preserved
even for explicit timezone offsets and extended ISO years. The parent's actual
source cases `occurred-117` and `rebuild-boundary-199` disprove the original
blanket invalidity assumption: `+010000-01-01` slices to an extended year/month
that Node accepts with the time suffix. Its exact range is
253402300800000 through 253402387199999 milliseconds. The tested negative
extended-year case is valid too. An ISO prefix can therefore select a month's
first day rather than the original day; do not replace slicing with a UTC floor.
The ordinary and runtime expectations now follow that source evidence. Genuine
downstream partial-write checks use injected aggregate failures instead.
Where re-parsing actually yields an invalid Date, uncast aggregate BSON encoding
still uses epoch zero and any subsequent ISO error retains its source order.

The pipeline reuses shared `group_fields`. The reducer preserves Mongo group
encounter order, first-seen Map day order, per-category overwrite and first
expiry initialization. Promoted numbers add numerically; unpromoted Long and
Decimal128 use their string-valued default primitive for JavaScript `+=`.
Mixed categories retain BSON wrappers while daily Number fields are cast.
`netConsumedCredits` follows the source addition before subtraction. The parent's
first actual-source replay (`tier-0`) also disproved the manual default-first
BSON field reorder. Daily preparation now retains the native schema core's
schema field order, then appends selected version/timestamp middleware fields;
all exact BSON assertions remain. The behavior-equivalent Clippy correction
uses `ordinary_json(...).is_none_or(...)` in the truthiness adapter.
Unsupported expiry projection fails during reduction before daily deletion;
dashboard dirtying and a preceding receipt upsert may already be visible and
are deliberately not rolled back. For supported data, daily delete still
occurs before insertMany validation. With `{ ordered: false }`, default
`throwOnValidationError: false` silently omits invalid documents, including
all-invalid success; valid siblings are still sent. Duplicate-key/server errors
remain observable and can leave partial insertion.

Source evidence was read directly from installed Mongoose 8.24.2:
`lib/model.js` insertMany/default validation branch,
`lib/query.js` `_updateThunk`, `helpers/query/castUpdate.js`,
`helpers/setDefaultsOnInsert.js`, `helpers/update/decorateUpdateWithVersionKey.js`,
`helpers/update/applyTimestampsToUpdate.js`,
`helpers/timestamps/setupTimestamps.js`, `helpers/document/applyDefaults.js`,
`helpers/schema/getKeysInSchemaOrder.js`, and `cast/{date,number,string}.js`.
The oracle executes those installed mechanisms via the actual four TS models.

There are no new application retries, transactions, deadline wrappers, polls,
batch cooldowns or worker pacing changes. Existing lock waits remain 50 ms
contention, 10 s acquisition limit, 120 s TTL and 30 s owner-fenced renewal. Each
protects ownership rather than creating an artificial ready-work cadence.
The integration test's 5 ms command-event observation poll and bounded 1.5 s
blocked-command settlement wait are fixture-only safeguards. Cancellation or
panic drops renewal but preserves the TTL because an in-flight write may commit.
Disconnects/errors after writes are honest uncertain/partial outcomes; no blind
retry or automatic rollback is added.

## Reproduction commands, fixture and private-resource limits

Run all commands in the parent's approved read-only snapshot/capped compiler or
separate approved offline Node environment, never on the production host. Apply
the root/Rust guide's 4/6 GiB cap, six CPUs, two Cargo jobs, no swap, 4 GiB host
reserve, owned cache/target <=8 GiB, and production before/after read-only snapshot.
No production configuration, credentials, volume, queue or network is a fixture.

For a later re-freeze or regenerated candidate, regenerate the existing lock oracle first (its native
hashes include Cargo/module wiring), then persistence fixtures in a distinct
new empty external directory:

```sh
node dimabot/tests/fixtures/ai_usage_lock_reference.cjs --write "$LOCK_REFERENCE_DIR"
node dimabot/tests/fixtures/ai_usage_lock_reference.cjs --check "$LOCK_REFERENCE_DIR"
DIMA_AI_LOCK_REFERENCE_DIR="$LOCK_REFERENCE_DIR" node dimabot/tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$PERSISTENCE_REFERENCE_DIR"
DIMA_AI_LOCK_REFERENCE_DIR="$LOCK_REFERENCE_DIR" node dimabot/tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$PERSISTENCE_REFERENCE_DIR"
```

Oracle pins: Node 24.22.1, V8 13.6.233.17-node.58, TypeScript 5.9.3,
Mongoose 8.24.2, installed Mongo-driver BSON 6.10.4. It blocks network before
schema evaluation, extracts complete real AST declarations with numeric
`node.kind === ts.SyntaxKind[kind]` checks (avoiding reverse enum aliases),
records imports/signatures/type diagnostics/extracted/compiled text, hashes the
Node binary, loaded dependencies, source/schema/native files and toolchain, and
binds the separate 291-case actual-source lock corpus by all four artifact hashes.
Only Mongo collection calls and that independently tested lock boundary are
replaced. Every recorded call contains exact BSON bytes/options; insertMany
strips only random `_id` entropy. `--check` requires the exclusive exact four-file
set and byte equality. No generated fixture is checked into this worktree.

Set `DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR`,
`DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY`,
`DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT`, and
`DIMA_AI_LOCK_REFERENCE_DIR` in the Rust test environment. The dependency root
contains public read-only `node_modules`, independently from the Rust snapshot;
the Node binary is read for hashing only. Rust tests never execute Node or assume
Node/node_modules exists in the compiler image. Missing, empty or stale artifacts
fail; all records are iterated without selecting a passing subset. BSON wrappers
use actual `Document::to_vec` bytes, not optional canonical-extjson APIs.

Inside the capped compiler from the `dimabot` crate directory:

```sh
cargo fmt --all -- --check
cargo check --locked --no-default-features --features ai-usage-ledger-persistence --all-targets
cargo test --locked --no-default-features --features ai-usage-ledger-persistence --test ai_usage_ledger_persistence
cargo test --locked --no-default-features --features ai-usage-ledger-persistence --test ai_usage_ledger_persistence complete_actual_source_replay -- --ignored --exact
cargo test --locked --no-default-features --features ai-usage-ledger-persistence --test ai_usage_ledger_persistence private_mongo_and_real_redis_persistence_protocol -- --ignored --exact
cargo clippy --locked --no-default-features --features ai-usage-ledger-persistence --all-targets -- -D warnings
```

The integrated `[[test]]` entry is feature-gated. Ordinary tests have no server
calls. The ignored
runtime suite requires `DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration`, exact
Mongo URI `mongodb://ai-ledger-persistence-mongo-fixture:27017`, exact Redis URI
`redis://ai-ledger-persistence-redis-fixture:6379/`, a unique lower-alphanumeric
8–32 character `DIMA_AI_LEDGER_PERSISTENCE_RESOURCE_TOKEN`, and
`DIMA_AI_LEDGER_PERSISTENCE_TEST_DATABASE=ai_ledger_persistence_test_<token>`.
Use fresh private Mongo with `enableTestCommands=1`; the suite refuses other
existing databases before server-wide failCommand. Redis must have physical
DBSIZE zero before marker creation. It owns exactly the derived account and
panic keys; no source fixed queue/health key is used. Cleanup checks the Mongo
marker, disables only that fresh server's failpoint, deletes only exact owned
Redis keys, verifies DBSIZE restored, and drops only the marked owned database,
including after assertion panic. Container cleanup remains parent-owned.

Runtime cases author inserted/duplicate/expired equality, dashboard dirtying,
duplicate repair after prior crash, offset/extended-year behavior, real lease
contention with siblings, cast callback cleanup, server failures at each phase,
disconnect/no retry, partial writes, cancellation TTL, panic TTL, shared Mongo
pools, defaults/timestamps, unchanged indexes and scoped cleanup. Added guard
unit cases cover `[Date]`, 64 nested arrays, RegExp/Date mixtures, top-level
RegExp, preserved Date/scalar-array/object handling and own-toString TypeError.
Added private-resource sentinel cases insert raw receipt `[Date]`, nested-array
and both RegExp/Date orderings directly, bypassing schema casts. The nested case
also has a top-level future Date, so the test does not assume recursive Mongo
query matching. Each case asserts the actual aggregate returns the raw expiry,
then requires native unsupported rejection with no daily delete/insert, exact
daily sentinel bytes retained, preceding dirty/upsert writes visible and the
real Redis lease released. The same assertions cover direct rebuild under its
real caller-owned lock. Cleanup removes only exact test entry IDs; outer marker
and unwind cleanup remain unchanged. The final parent run passed the private
Mongo/Redis suite, including these sentinel cases. The existing native lock
suites retain renewal/Lua owner-replacement/release-error-precedence coverage;
this host oracle does not substitute for their evidence. The parent also passed
the affected worker grouping test and worker-profile check.

No TypeScript retirement, caller adoption, deployment, performance improvement,
or full-migration claim follows from authoring or passing these checks.
