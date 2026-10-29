# AI usage ledger reads: author handoff and parent validation

GPT-6.1 Sol at xhigh via Codex authored this bounded slice on 2026-10-29 after the earlier source-trace handoff. That authoring phase was static-only and did not compile or run behavior. The parent subsequently wired, committed, and validated the slice; see the [dated validation note](ai-usage-ledger-reads-2026-10-29.md) and [evidence package](evidence/2026-10-29-ai-usage-ledger-reads/README.md). This file preserves the original handoff contract and commands as historical context; those commands are no longer pending.

Parent acceptance is limited to the three ledger-state read exports and their declared input/BSON boundary. It does not retire TypeScript, adopt callers, complete ledger persistence/history/retention/backfill, deploy, push, or establish a performance result.

## Authored files and wiring

- `dimabot/src/utils/ai_usage_ledger_reads.rs`: concrete cloneable `MongoAiUsageLedgerReads`, typed identity/window inputs, status DTO/readiness enum, raw-BSON state DTO, pure query builders/decoders, and driver/JS-boundary errors.
- `dimabot/tests/ai_usage_ledger_reads.rs`: six self-contained unit tests plus ignored `actual_source_replay` and `private_mongo_adapter_behavior_pooling_errors_and_cancellation` tests. Ordinary tests require no fixture environment.
- `dimabot/tests/fixtures/ai_usage_ledger_reads_reference.cjs`: offline actual-source AST oracle with strict external exclusive `--write DIR` and byte-exact `--check DIR` modes. The generator requires more than 150 scenarios; no generated count is reported before execution.
- This handoff replaces the earlier discovery-only note.

No existing Rust module, Cargo manifest/lock, worker/profile, TypeScript source, benchmark, or another contributor's file was edited. The parent must add this proposed feature and module gate before compiling:

```toml
ai-usage-ledger-reads = ["application-schemas", "credit-policy", "tts-utilities"]
```

```rust
#[cfg(feature = "ai-usage-ledger-reads")]
pub mod ai_usage_ledger_reads;
```

This graph composes existing features/packages only. `application-schemas` supplies Mongo, schema metadata, and existing date dependencies; `credit-policy` supplies `JsDate` and serde; `tts-utilities` supplies `JsString`, lossless JSON values, and the existing JS coercion core. Mongo already supplies SHA-256 and futures utilities used by the tests. This is a static proposal, not a compiled result. Keep the feature outside defaults and deployed worker profiles.

## Reuse and source behavior

The source is the complete three declarations in `dimabot/src/utils/ai_usage_ledger.ts`: `hasAiUsageLedgerCoverage`, `getAiUsageLedgerStatus`, and `getAiUsageLedgerState`, plus report version 3 and `AiUsageLedgerStatus`. Their only runtime application dependency is `AiUsageLedgerStateSchema`. The lock, other models, classification, writers, dashboards, retention, and rollups belong to other functions.

The adapter derives its `Collection<Document>` from `schemas::ai_usage_ledger_state::schema().native_collection(database)`, cloning existing driver handles without connecting or installing indexes. It uses the public collection because `SchemaRepository::find_one` applies the schema default projection rather than the source's explicit select. Construction, cloning, and pure query/decode helpers perform no I/O. There are no locks, writes, clock reads, scheduler waits, new deadlines, or adapter retries. Supplied client settings remain authoritative; dropping a read future is caller cancellation.

Coverage executes the actual Mongo query with both identifiers, `coverageStart: {$lte: startsAt}`, and `reportVersion: {$gte: 3}`, projected to `_id`. Type bracketing and array matching remain Mongo behavior, distinct from status's JS comparison. An invalid input `JsDate` maps to the pre-I/O Mongoose `CastError` category at `coverageStart`.

State/status use `{coverageStart: 1, backfilledAt: 1, reportVersion: 1}`; Mongo also includes `_id` by default. Identifiers cross the existing `JsString` UTF-16-to-BSON replacement boundary without trimming. `LedgerField::Undefined` represents a missing property or BSON Undefined; explicit null and other original BSON values are retained. State applies only `reportVersion || 0`. Node's inclusive ±2^53 Long promotion is checked through the existing BSON normalization core, but truthy original values remain raw carriers. No global schema casting or repair is applied to lean results.

Status preserves evaluation order: coverage `getTime`, requested-date comparison, version coercion only if that comparison passes, coverage ISO, sync ISO, requested ISO. Missing/null/non-Date coverage raises `TypeError` before optional ISO expressions. Missing/null sync becomes null; other non-Date sync values raise `TypeError`. Invalid/out-of-TimeClip Date ISO raises `RangeError` through existing `JsDate`. State still returns those original date values. Driver errors retain the original `mongodb::error::Error` and its error source; native method errors expose JS category and field/method without claiming byte-identical engine-specific messages.

Ordinary BSON scalar/array/document versions reuse `tts::settings::{truthy, js_number}` and `json_number::string_number`, avoiding a parallel number/whitespace policy. Native adapters cover Long promotion, Decimal128/Long/Timestamp numeric strings, ObjectId, Binary/UUID, Symbol, Date, and other built-in BSON prototypes. For Number(array), Date/RegExp/UUID string forms become guaranteed nonnumeric markers only in the temporary numeric-coercion view; the shared array core still visits later items and preserves method-shadowing TypeErrors. Returned BSON is unchanged. Node's DBRef document upgrade is recognized for numeric coercion, including extra fields that do not shadow the wrapper methods.

The contract covers declared String/Date inputs and ordinary lean BSON under Node's default promotion settings. It excludes executable accessors/functions, custom prototypes, Symbols/BigInts supplied outside BSON, nondefault `promoteLongs`/`promoteValues`, JS engine resource exhaustion, and malformed-wire decoder equivalence. State carriers preserve wire BSON rather than rebuilding JS class identity. Current BSON variants have defined numeric adapters; an unsupported error remains defensive for an unrecognized boundary. These are authored contracts, not verified parity claims.

## Authored oracle and checks

The oracle pins Node 24.22.1 / V8 13.6.233.17-node.58, TypeScript 5.9.3, Mongoose 8.24.2, BSON 6.10.4, complete source/schema/package-lock hashes, and the Rust toolchain file. It AST-extracts the complete actual functions, report constant, status interface, and source state interface. It records inline types, declaration text/byte spans/hashes, and all source imports. A strict synthetic typecheck uses actual interfaces with a model signature stub. Runtime execution uses the complete extracted function bodies and the actual source Mongoose schema. No handwritten control-flow replacement is used.

Networking and Mongoose connections are blocked before source evaluation. Only `Model.collection.findOne` is replaced: it records actual cast filters/projections, returns explicit fixture BSON bytes decoded by installed Node BSON, or throws a fixture driver error. It does not emulate Mongo matching. Native replay compares queries, raw state outputs, status results, and JS exception categories. Source driver-error records document rejection propagation; real-Mongo checks cover native errors. Byte-patched Date fixtures retain out-of-TimeClip wire values that a JS Date could not reserialize faithfully. Metadata hashes include all native implementation/tests/wiring/Cargo inputs, installed dependency entries/packages, exact Node executable, extraction, typecheck, and compiled source artifacts.

The authored matrix covers absent/ready/old/missing states; before/equal/after dates; threshold 3; missing/null/false/zero/-0/NaN/falsy and truthy versions; numeric strings/JS whitespace/arrays/method shadowing; primitive and large Longs, Decimal128, nested wrappers, ObjectId, Binary/UUID, Symbol, Timestamp, MinKey/MaxKey, Code, and DBRef numeric coercion; nullish/malformed fields; invalid requested dates/evaluation order; extended years/TimeClip; UTF-16 replacement, embedded NUL and literal identifiers; and read failure.

The private-Mongo test additionally checks Mongo type bracketing and array matching, projection, unchanged index/document counts, serial pool reuse across clones, failures from all three reads, invalid-date rejection before I/O, unpolled future drop, in-flight cancellation, and subsequent pool usability. It requires all of:

```text
DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
DIMA_TEST_MONGO_URI=mongodb://ai-ledger-reads-mongo-fixture:27017
DIMA_AI_LEDGER_READS_RESOURCE_TOKEN=<unique 8..32 lowercase ASCII letters/digits>
DIMA_AI_LEDGER_READS_TEST_DATABASE=ai_ledger_reads_test_<same token>
```

The parent must provide that exact host on a private task-owned network, with uniquely named/labeled disposable resources and Mongo `enableTestCommands=1`. The test rejects other URIs, requires a fresh database, creates an ownership marker, catches panics, disables only its fixture's failCommand point, checks ownership before dropping the task database, and closes its client. Its failpoint and bounded observation waits are test instrumentation, not adapter policy. Never use a shared server: failCommand is server-scoped. The parent owns label inspection, production before/after identity checks, capped execution, and task-owned container/network/image cleanup.

## Exact parent commands, unexecuted

After feature wiring, run these from `dimabot/` only inside the parent's existing isolated source-copy/capped-toolchain workflow. Preserve 6 CPU, selected 4/6 GiB memory with equal memory-swap/no-swap, 256 PIDs, two Cargo jobs, 8 GiB cache, and the 4 GiB host reserve in `RUST_AGENTS.md`. Do not run host Cargo or start another compiler. Apply any needed formatting before freezing the snapshot and generating provenance; native/tests/Cargo/module files are hashed.

```bash
rustfmt --edition 2024 --check src/utils/ai_usage_ledger_reads.rs tests/ai_usage_ledger_reads.rs
cargo check --locked --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads
cargo clippy --locked --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads -- -D warnings
cargo test --locked --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads
```

Inside the parent's isolated pinned Node environment, set `DIMA_AI_LEDGER_READS_NODE_BINARY` to the exact executable and `DIMA_AI_LEDGER_READS_REFERENCE_DIR` to a fresh pre-created external task directory. Use offline installed dependencies matching the lockfile; this oracle does not install/download anything.

```bash
"$DIMA_AI_LEDGER_READS_NODE_BINARY" tests/fixtures/ai_usage_ledger_reads_reference.cjs --write "$DIMA_AI_LEDGER_READS_REFERENCE_DIR"
"$DIMA_AI_LEDGER_READS_NODE_BINARY" tests/fixtures/ai_usage_ledger_reads_reference.cjs --check "$DIMA_AI_LEDGER_READS_REFERENCE_DIR"
```

For Rust replay, keep that directory and exact Node executable mounted read-only. Set `DIMA_AI_LEDGER_READS_NODE_DEPENDENCY_ROOT` to a read-only root containing the oracle's `node_modules/`. Missing/empty/stale fixtures or required environment fail. Then run inside the capped compiler/runtime:

```bash
cargo test --locked --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads actual_source_replay -- --ignored --exact
cargo test --locked --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads private_mongo_adapter_behavior_pooling_errors_and_cancellation -- --ignored --exact
```

The final command also needs the private-Mongo ownership environment above. No fixtures or executable results exist from the delegate task. The parent must record formatting, compilation, lint, oracle generation/check/replay, native behavior, and cleanup before acceptance or a verified local commit. Remaining writers/rollups in `ai_usage_ledger.ts` and their dependencies/callers remain outside this slice. Authored local helper coverage does not establish total ledger/repository migration completion.
