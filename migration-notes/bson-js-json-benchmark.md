# BSON to JavaScript JSON prepared-operation baseline

**Date:** 2026-10-30
**Status:** Exploratory baseline, verified inputs and checksums, mixed performance results. This record preserves the initial measurements; the [borrowed serialization follow-up](bson-js-json-borrowed.md) is now verified separately.

This note records the owned benchmark baseline at code commit `65d600dc5b6b27ee62d4747caa80b7ea9e1d93b7` (tree `1b1ec2dee8d17ebd6e104c09003e2f7a4dceea0d`). It measures a prepared BSON-to-JSON operation, not application latency or production throughput. The [evidence bundle index](evidence/2026-10-30-bson-json-owned-baseline/README.md) documents the frozen source and run records.

## Results

Each value is the median nanoseconds per operation across seven sequential samples from one process block per runtime. The ranges show the minimum and maximum of those seven sample means. The percent column is `(Node − Rust) / Node`; a negative number means Rust took longer.

| Workload | Node median (ns/op) | Rust median (ns/op) | Rust lower than Node | Node sample range (ns/op) | Rust sample range (ns/op) |
|---|---:|---:|---:|---:|---:|
| Ordinary numeric | 2,141.79 | 2,534.51 | −18.34% (slower) | 2,009.25–2,246.24 | 2,349.45–2,720.45 |
| Nested mixed | 4,909.44 | 3,001.26 | 38.87% | 4,560.11–6,150.07 | 2,960.10–3,140.04 |
| BSON specials | 9,951.39 | 5,741.19 | 42.31% | 9,421.44–10,637.79 | 5,547.85–6,116.70 |
| Large context arrays | 63,102.12 | 109,537.39 | −73.59% (slower) | 61,155.56–67,418.47 | 101,549.38–138,389.48 |

All four workload checksums match between Node and Rust, including every sample checksum. The 128 predecoded SDK BSON inputs matched their expected wire strings and checksums before timing. The frozen input SHA-256 is `65c16f8fbd2545584bef7c8a23a684e890bc465e7c23872b7c72310e06cf38f5`; it is recorded before and after in the run facts.

## What was timed

The fixture uses four pools of 32 distinct, predecoded real SDK BSON documents (128 values total), with one full-pass warmup followed by seven sequential samples per actor. The timed operation includes the BSON projection, JSON construction/serialization, and summing the UTF-8 length of the complete JSON output.

The Node path uses the pinned SDK's actual values, `JSON.stringify`, and a UTF-8 `Buffer` for the full-byte sum. The Rust path includes BSON projection, materializing the owned `JsonValue`, serializing to UTF-8, and the full-byte sum. BSON decoding, input parsing, fixture preparation, and I/O are outside the timed interval. Thus the results capture this prepared operation with its stated allocations; they do not measure end-to-end BSON decoding or an application request path.

The Node benchmark used Node 24.22.1 / V8 13.6.233.17-node.58 and pinned Mongoose 8.24.2, MongoDB driver 6.20.0, and BSON 6.10.4 inputs. Full versions, SDK hashes, decoder options, 128 wire fixtures, and source pins are in the [captured benchmark input](evidence/2026-10-30-bson-json-owned-baseline/artifacts/bson-js-json-input.json). The complete Node and Rust sample records are retained alongside it.

## Source and run identity

The benchmark code was committed at `65d600dc` (full commit object recorded in Git). Its two direct benchmark files are preserved under [`source/dimabot/tests`](evidence/2026-10-30-bson-json-owned-baseline/source/dimabot/tests/bson_js_json_benchmark.rs). The evidence bundle also captures the other seven direct implementation/fixture files and seven relevant dependency/build inputs from that commit: all 14 SHA-256 pins match the frozen input manifest. These bytes were read with `git show 65d600dc:<path>`; the current working tree was not used for this snapshot.

The Node timing run was `node-1793353414300906233`, with source tree SHA-256 `5cb3c5a8e5994449080942138a6fe56ae67ac7190f5e6a85b700894ee16d8039`. The Rust release benchmark came from compiler run `compiler-1793354095104743193`, source tree SHA-256 `6c199f40fefd469346533f57182204a8ee1aedce66dde9ace6e00a9b8c7971bb`. Those full trees differ because the Node timing preceded later unrelated worker edits. The all-14 benchmark input pins were independently checked unchanged, and final Node check run `node-1793354263387812460` reconstructed the same input SHA and ran against the `6c199f40…` source tree. Therefore the benchmark inputs are matched, but the complete timing source trees are not identical; do not describe these as same-full-tree or alternated comparisons.

The compiler receipt records 6 CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. The Rust compiler step took 115.608 seconds (125.637 seconds total for that run); the reported benchmark execution itself took 9.66 seconds. Minimum available memory was 10,606,145,536 bytes and peak private Cargo cache use was 7,753,998,336 bytes. The baseline executable is retained with SHA-256 `5b82ac1ceaf3150d72461eed62c10f8503aea89a2df3e25d1e7addcc30eb542d` and size 1,748,328 bytes. This is a test executable, not an application-size measurement.

The final readback records 18 production containers unchanged and zero remaining task-owned resources. This note reports that recorded isolation result; no production data was used as a benchmark input.

## Limits and interpretation

- One process block per actor, one warmup pass, and seven sequential samples; no fresh-process repetitions or alternating Node/Rust rounds.
- Two regressions are retained: ordinary numeric and large context arrays. The other two workloads favor Rust in this fixture. The mixed result does not support a general speedup claim.
- This is a synthetic prepared-operation microbenchmark. It supplies no production latency, throughput, CPU, or RSS conclusion.
- Rust currently materializes an owned JSON value in the measured path; Node creates a UTF-8 buffer for byte counting. Those are measured implementation costs, not normalized away.
- A separate optimization follow-up is under way; until its exact candidate is benchmarked and accepted, it has no result in this baseline.

## Evidence bundle

The [owned-baseline evidence index](evidence/2026-10-30-bson-json-owned-baseline/README.md) lists every retained payload with raw and stored SHA-256 and byte length. It includes the original facts and production readback, input and actor reports, frozen executable, the 14-file Git snapshot, and retained run receipts/logs. Tool copies are explicitly marked as static current copies, not executed historical evidence. No compressed logs were present among the retained run artifacts.
