# AI usage persistence helper benchmark handoff — 2026-10-29

Status: **the benchmark design below is superseded by verified execution**. The
accepted benchmark result, provenance, corrections, and limits are recorded in
the [dated results note](ai-usage-persistence-helper-benchmark-2026-10-29.md).
This handoff remains as design and setup context for the bounded helper trial;
its original author-only execution caveat describes the draft stage and is not a
statement about the later verified run. The source candidate is commit
`22cb791f`.

Files owned by this handoff:

- `dimabot/tests/ai_usage_persistence_e2e_benchmark.rs`
- `dimabot/tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs`
- This handoff note.

The benchmark supplements the existing pure reducer measurements. It measures
prebuilt valid receipt DTOs through the actual persistence helper: acquire and
release the real account lease, dirty the dashboard, cast and serialize/upsert
the receipt, aggregate real Mongo data, reduce groups, and replace daily rows.
It covers initial inserts and duplicate repair separately. It cannot support a
whole-application, worker, provider, total-migration, memory-efficiency, or live
deployment performance claim.

## Reuse and measurement contract

The Node helper extracts complete actual-source AST declarations for
`persistAiUsageReceipt`, `receiptDocument`, `rebuildUtcDailyAggregates`, their
helpers and type closure, and `withAiUsageLock`. It imports no app bootstrap,
`.env` loader, application Redis singleton, queue, telemetry, or logger. The
actual four Mongoose schema files execute with only their real Mongoose import.
The source lock receives a real connected test-only Redis client; its Date and
timers remain real. Only the ledger VM uses a fixed application Date, named
`Date` to preserve Mongoose clone behavior. `mongoose.now` has a separate fixed
timestamp. This excludes the application's connection telemetry wrappers.

Rust calls `MongoAiUsageLedgerPersistence::with_clocks` and its real
`persist_value` path. Explicit Mongo client handles share one pool, and the
explicit Redis `ConnectionManager` shares its socket. The production schema,
coercion, lock, aggregate, and BSON implementations remain the measured code;
there is no second handwritten JavaScript interpreter or reducer. Both actors
receive the same prebuilt valid DTO pool. Producer construction, JSON parsing,
connection/model/index initialization, IPC, reset/seed, readback, checksum, and
result counting are outside the timed intervals.

The pool contains 32 receipts over eight UTC days and four valid categories,
with positive integral credits and ordinary token-scoped IDs. No legacy
category collisions can make Mongo group ordering affect last-wins values.
Both actors use the exact same run-unique account and receipt IDs, strictly
sequentially. Account data resets occur outside each timer. Insert resets leave
no receipts or daily rows. Duplicate-repair resets preseed valid receipts
through the actual model, leave no daily rows, and mark the dashboard clean.
Both sides therefore repair the same prior-crash state.

All four real schema collections and indexes are installed once before warmup.
Mongo URI policies match: direct connection, primary/default reads, `w=1`, pool
size 10/minimum 0/maxConnecting 2, five-second connection/server-selection
timeouts, and no retryable reads/writes. Redis uses DB 0/RESP2 and no command
response timeout. Node reconnect is disabled; the native manager keeps its
driver reconnect behavior. Any failure aborts the run without application call
replay. These are happy-path latency trials, not failure/reconnect benchmarks.

There are two warmup batches per actor per workload, followed by seven matched
trial pairs per workload. First actor alternates by trial. Each interval awaits
32 sequential helper calls. Raw measured samples are flushed to exclusive
`samples.ndjson`; `report.json` is created exclusively only after all parity
checks and cleanup pass. Readbacks retain every BSON value/type and array;
comparison sorts object keys/documents and strips only generated top-level
`_id` values. Fixed timestamps, account IDs, receipt IDs, nulls, defaults,
categories, and version fields remain. Each pair compares the complete
canonical BSON snapshots, plus independent receipt/daily totals and Date guards.

## Isolated setup and execution contract

This section preserves the original setup contract for the accepted benchmark;
the exact candidate was executed under this isolated workflow, with results in
the linked dated note. Follow root `AGENTS.md` and `dimabot/RUST_AGENTS.md`. Do
not run host Cargo,
test code in production containers, or deploy. Use a read-only source snapshot,
installed read-only `dimabot/node_modules`, one capped Rust compiler, a separate
capped pinned Node runtime, and fresh uniquely named/labeled disposable Mongo
and Redis servers on a private internal task network. Inspect host headroom and
production container identities/configuration before and after. Compiler limits
remain six CPUs, four or six GiB with memory-swap equal to memory, 256 PIDs,
two Cargo jobs, the required four-GiB host reserve, and eight-GiB task cache.
The accepted run reused installed dependencies and did not pull or install them.

The source snapshot must be mounted at the same absolute path in compiler and
runtime because the Rust test uses `CARGO_MANIFEST_DIR`. `node_modules` must be
available under that package path; loaded dependency realpaths outside that
mount are refused. Node is unavailable in the compiler image, so compile with
`--no-run` there and execute the resulting static-musl release test ELF in the
Node runtime. Give that runtime an external writable artifact directory; it must
already exist and be empty before `--write`. The native ELF itself must live
outside the artifact directory.

Set these explicit values in the isolated runtime (never reuse app credentials):

| Variable | Value |
| --- | --- |
| `DIMA_RUST_TEST_RESOURCE_OWNER` | `dimabot-migration` |
| `DIMA_TEST_MONGO_URI` | `mongodb://ai-usage-persistence-bench-mongo-fixture:27017` |
| `DIMA_TEST_REDIS_URI` | `redis://ai-usage-persistence-bench-redis-fixture:6379/` |
| `DIMA_AI_PERSISTENCE_BENCH_TOKEN` | New 8–32 lowercase alphanumeric token |
| `DIMA_AI_PERSISTENCE_BENCH_DATABASE` | `ai_usage_persistence_bench_<token>` |
| `DIMA_AI_PERSISTENCE_BENCH_DIR` | Absolute external artifact directory |
| `DIMA_AI_PERSISTENCE_BENCH_NODE` | Absolute Node executable path |
| `DIMA_AI_PERSISTENCE_BENCH_NODE_SHA256` | Independently hash the actual pinned Node executable |
| `DIMA_AI_PERSISTENCE_BENCH_INPUT_SHA256` | Independently hash prepared `inputs.json` after `--write` |
| `DIMA_AI_PERSISTENCE_BENCH_SOURCE_SHA256` | Independently hash prepared `source.json` after `--write` |
| `DIMA_AI_PERSISTENCE_BENCH_NATIVE_SHA256` | Independently hash the exact compiled release test ELF |

Expected installed versions are Node 24.22.1, V8 13.6.233.17-node.58,
TypeScript 5.9.3, Mongoose 8.24.2, its Mongo driver 6.20.0, BSON 6.10.4,
redis/@redis/client 5.12.1, native Mongo 3.9.1, and redis-rs 1.7.1. Package and
lockfile hashes plus loaded module hashes are captured. All Rust source files,
the Cargo manifests/lockfile, the toolchain pin, harness, actual TS declarations,
schemas, and npm lockfile are bound by the prepared source evidence. Final
runtime-loaded dependencies and the actual Node/native ELF SHA-256 digests are
retained. Preserve the compiler image/command/resource inspection and source
snapshot manifest alongside the report: hashing source and ELF at runtime does
not itself prove which compiler invocation produced that ELF.

Within the authorized capped environments, the intended command sequence is:

```text
<absolute-node> dimabot/tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --write <external-empty-dir>
# Independently hash inputs.json and source.json; provide the digest variables.
<absolute-node> dimabot/tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --check <external-dir>
# In the capped compiler, build only; no Node dependency in that image:
cargo test --manifest-path dimabot/Cargo.toml --locked --release --target x86_64-unknown-linux-musl --no-default-features --features ai-usage-ledger-persistence --test ai_usage_persistence_e2e_benchmark --no-run
# Independently hash the exact emitted test ELF; mount it in the Node runtime.
<absolute-test-elf> --ignored --exact real_persistence_helpers_matched_trials --nocapture --test-threads=1
<absolute-node> dimabot/tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --check <external-dir>
```

These commands document the intended isolated sequence; the accepted candidate
passed the corresponding formatting, compilation, runtime, and fixture checks
recorded in the dated note. Any changed candidate needs fresh source evidence in
a new empty directory because the source guards refuse evidence prepared before
a native source or harness edit.

`--write` and `--check` do not connect. `--check` reconstructs/binds source
artifacts and, when present, validates the completed report and retained samples
without retiming. Partial samples without a completed report are refused as
evidence. `--serve` connects actual clients and exposes serial reset, trial,
readback, and finish IPC. The Rust driver owns ordering and timing orchestration.

## Ownership, disposal, and remaining limits

Both helpers reject every URI other than the exact aliases above. The Node
server requires an empty owned Mongo database and Redis `DBSIZE == 0` before
claiming ownership. Markers bind the owner/token/database; every reset/readback
checks ownership and the source-derived lease is absent before switching actors.
Resets delete only this account's documents and refuse unrelated data. No global
queue key, FLUSH, prune, provider, billing, or Twitch path is reachable.

Normal finish verifies ownership, drops only the owned database, deletes only
the fenced Redis marker, and checks Redis is empty. On Rust unwind the child is
killed and waited before ownership-fenced native fallback disposal of only the
owned database, exact derived lease, and marker. Node EOF/error also attempts
owned cleanup. SIGKILL/runtime failure may prevent cleanup; the parent must
still dispose of its uniquely labeled containers/network. Unknown ownership
refuses mutation. No uncertain write or cancelled helper is replayed.

The fixed fixture expiry window is checked against the real wall clock to avoid
TTL races; the fixture refuses obsolete inputs. It does not establish
contention, lease-loss, cancellation, malformed legacy BSON, or database failure
correctness; retain the existing 204-case persistence oracle and isolated error
suites for those claims. The verified private-server run remains sensitive to host pressure and server
caches; its seven raw pairs, medians, and spread are recorded in the dated
results note. Interpret its ratios only within this matched helper scope; it
supports no application-wide speedup or migration-completion claim.


## Verified execution addendum

The exact benchmark candidate described here was built and run against isolated
private services. All matched samples passed independent parity/readback, and
owned fixture cleanup completed. See the [dated results note](ai-usage-persistence-helper-benchmark-2026-10-29.md)
for the measurements, receipts, corrections, and evidence location. The benchmark
remains bounded helper latency only; it grants no production release, caller
adoption, or migration-completeness claim.
