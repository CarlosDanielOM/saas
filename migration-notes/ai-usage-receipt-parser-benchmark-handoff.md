# Prepared receipt parser benchmark handoff

Status: **verified baseline harness; four Rust time regressions remain open;
lookup optimization is pending verification**. Baseline harness commit
`0389561e6004d3a8f7bc10ca73b3bc49a9016e5e` has completed the source-bound
benchmark and strict checks. A separate bounded lookup candidate is being
checked; it has no measured candidate timing or acceptance result yet.

The original authoring state on 2026-10-29 was an unexecuted handoff: the author
ran no benchmark, application, compiler, test or container. The parent’s later
baseline verification and current optimization status follow.

## Parent baseline verification update — 2026-10-29

The verified baseline uses source-tree SHA-256
`8dbce36238ca2323d795782d1dc7032f66a372df9053a9e6a56d11df4d7f428a`, 1,275
bound source inputs, input SHA-256
`2342386c3dde9f63206402cd7e82d83b88360f9cbab7d90ef69ee5a52e0e287e`, and 192
prevalidated source wires. It has six 32-input pools and seven trials per
pool. All checksums matched. The TypeScript trials come from the actual
transpiled CommonJS source and the isolated VM realm matched every prepared
wire before timing.

| Pool | Node median µs/op (range) | Rust median µs/op (range) | Rust/Node median ratio |
|---|---:|---:|---:|
| ascii | 6.4754 (6.2281–7.0369) | 58.8629 (57.2925–63.5998) | 9.09x |
| unicode | 8.8659 (8.6150–13.2711) | 70.0094 (67.6673–71.3212) | 7.90x |
| coercion-duplicates | 8.8327 (8.7014–10.2306) | 88.3840 (86.4125–102.1838) | 10.01x |
| rejected | 12.2683 (11.2813–13.5841) | 5.5008 (5.3075–6.3887) | 0.448x |
| deep-ignored | 21.1810 (20.8195–22.9414) | 57.7481 (53.6163–61.1509) | 2.73x |
| deep-coerced | 76.1945 (74.5679–78.9801) | 56.8779 (53.6262–62.6905) | 0.746x |

Four baseline pools have higher Rust median time (ascii, unicode,
coercion-duplicates and deep-ignored); Rust median time is lower for rejected
and deep-coerced. These are prepared-parser measurements, not whole-application
performance acceptance.

Parent verification receipts: strict checks passed as
`compiler-1793274083369420275`; Node source/benchmark check passed as
`node-1793274189948131358`; release plus all-feature and no-default strict
checks passed as `compiler-1793274264064252684`; final Node `--check` passed as
`node-1793274460403768280`. The final compiler phase took 149.233 seconds for
the script and 156.805 seconds total, including a 41.21-second timed test.
Under 6 CPU, 4 GiB memory/equal swap, 256 PID and two-job caps, peak cache was
8,169,611,264 bytes and minimum available memory was 10,518,982,656 bytes.

The first lint attempt `compiler-1793274004764681420` failed on a constant
profile assertion in the benchmark harness; the equivalent `if` guard fixed
the harness assertion only. Parser behavior and prepared data did not change.
The harness was committed as `0389561e6004d3a8f7bc10ca73b3bc49a9016e5e`.

The exact-release diagnostic `compiler-1793274681760889459` profiled one ASCII
input over seven trials of 3,200 operations: validation/index 0.958 µs/pass,
20 field lookups 57.442, complete normalized DTO parsing 57.498, prepared DTO
wire 7.742, and parse-plus-wire 64.780. These are separate stages, not
additive production timings or a Node comparison. The lookup profile suggests
repeated key decoding in the current parser `get` path; it is a diagnostic,
not a candidate benchmark.

Current optimization status: a bounded candidate uses borrowed UTF-8 key
matching with an escaped-UTF-16 fallback. Formatting has been applied and its
checks are running. No candidate measurement is available, so all four baseline
regressions remain open. The machine-readable results and readback are in the
[baseline evidence package](evidence/2026-10-29-receipt-parser-baseline/README.md),
including the [comparison](evidence/2026-10-29-receipt-parser-baseline/artifacts/initial-benchmark-comparison.json)
and [lookup diagnostic](evidence/2026-10-29-receipt-parser-baseline/artifacts/lookup-diagnostic/report.jsonl).
Final readback verified 19 production records unchanged and no owned resources
remaining. No TypeScript source retirement, caller adoption, deployment or
push occurred; the broader migration remains incomplete.

The source loader extracts the actual parser, category and conversion helpers and the classification helper/constants from TypeScript AST declarations, records full-file and declaration hashes, export contracts, imports and parser signature, transpiles them, and executes the timing copy in the normal CommonJS realm. A second isolated realm must agree on every prepared wire before any Node trial. The source audit restricts imports and call targets; changed source should fail closed and be reviewed. The fixture hashes the loader, benchmark scripts, TypeScript package lock and actual application source, Node executable, TypeScript package and implementation, and the named native dependency and build-wiring files. Native verification compares each named native file against compile-time `include_bytes!` and current snapshot hashes before and after timing. These checks bind named sources and Cargo lock/toolchain configuration; they do not independently attest dependency binaries or the compiler executable. This is a narrow parser-only fixture and does not replace existing source-parity tests.

Six pools each contain 32 prepared input strings: ASCII, Unicode including lone UTF-16 surrogates encoded in JSON text, coercion/duplicate keys, malformed/rejected, deep ignored, and deep coerced arrays at depths 129 and 256. Every timed operation parses its prepared string and serializes the source's ordered 18 fields or null, then adds every UTF-8 byte to a wrapping 32-bit checksum. Both runtimes use fixture-bound warmups of 32,000 operations for each regular pool and 2,048 for each deep pool (all complete passes) and record seven trials, all checksums and min/median/max total nanoseconds per pool. Native timing calls the production parser and its receipt `json()` method. The native test validates every wire and every Node trial before timing, verifies the independently supplied fixture SHA and source hashes before and after, and exclusively creates the native report. Inputs and source wire outputs are prepared outside timing. This measures pure parse plus wire encoding and checksum, excluding Redis/Mongo and all other persistence/I/O; it establishes no whole-application, RSS, or CPU gain.

Parent execution protocol, after review, in the pinned offline task-owned capped environment and immutable source snapshot: start Node with `TZ=UTC` and versions Node 24.22.1, V8 13.6.233.17-node.58, TypeScript 5.9.3; invoke `node tests/fixtures/ai_usage_receipt_parser_benchmark.cjs --write NEWDIR` where NEWDIR does not exist. Independently calculate SHA-256 of `NEWDIR/inputs.json` and pass that hash as `AI_RECEIPT_BENCH_INPUT_SHA256` along with `AI_RECEIPT_BENCH_DIR` and `AI_RECEIPT_BENCH_RUSTC_VERSION` (the independently observed `rustc --version` output, retained with the evidence) to the explicitly selected ignored release test using `cargo test --release --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser_benchmark prepared_receipt_parser_benchmark -- --ignored --exact`. The test is ignored during ordinary suites and rejects debug-profile execution. Set `DIMA_AI_RECEIPT_NODE_BINARY`, `DIMA_AI_RECEIPT_TYPESCRIPT_IMPLEMENTATION`, and `DIMA_AI_RECEIPT_TYPESCRIPT_PACKAGE` to the corresponding separately mounted read-only runtime artifact files in the compiler container. The fixture retains their original Node-container paths and hashes; the Rust test matches their logical names and independently hashes these supplied paths before and after timing. The version environment value is an operator-supplied observation, not compiler attestation. Finally run the Node script with `--check DIR`; it regenerates and compares inputs and provenance and validates both reports without repeating timings. A missing fixture or report is a failure, not a skip. Preserve all reports and source identities together; treat any failed assertion, version mismatch, or changed hash as invalid evidence. No dependency additions, source retirement, deployment, push, or commit is authorized by this handoff.
