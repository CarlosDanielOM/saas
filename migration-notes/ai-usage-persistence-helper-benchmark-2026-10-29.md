# AI usage persistence helper benchmark — 2026-10-29

Status: **verified bounded helper benchmark**. Candidate code is commit
`22cb791f` (`test(dimabot): benchmark real receipt persistence with matched
private services`). The prepared source tree identity is SHA-256
`c4d921cf976d383daf7840efda2ea9bd843351dabb235da1cd9e6caaa79986af`, covering
1,296 source inputs. An independent readback verified all 28 actor samples,
trial pairing/order, complete BSON snapshots, counts, input/source/native hashes,
and recomputed timings. This is one isolated host run; sample ranges overlap.

## Scope and method

The comparison timed prebuilt receipt DTOs through the actual persistence helper
on each side: account lease acquisition/release, dashboard dirty marking, receipt
casting/serialization/upsert, Mongo aggregation, reduction, and daily-row
replacement. The TypeScript side used AST-extracted actual helper declarations
and the actual Mongoose schemas; the Rust side used
`MongoAiUsageLedgerPersistence::with_clocks` and its real `persist_value` path.
Both used the same 32 DTO values and shared Mongo/Redis clients (one pool/socket
per actor). Both ran against the same private MongoDB 8 and Redis services,
with two warmup batches per actor and workload, then seven matched pairs per
workload, alternating which actor ran first. Each timed sample performed 32
sequential helper calls. Complete BSON values/types and independent receipt and
daily counts were checked after every pair. The independent readback confirmed
parity for every sample.

| Workload | TypeScript median (ms/receipt) | Rust median (ms/receipt) | Rust median time reduction | TypeScript range | Rust range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Insert | 5.38785315625 | 3.96147925 | 26.473882% | 4.9729034375–6.343015375 | 3.73483596875–4.800972 |
| Duplicate repair | 5.068453 | 3.8027581875 | 24.972014% | 4.464905625–5.3777783125 | 3.68812503125–4.39774578125 |

All seven raw timings per actor and workload, plus the independent pair/sample
readback, are retained in `independent-helper-report-readback.json` under the
artifact directory below. Warmups are also recorded in `prepared/report.json`.

The result describes only this bounded helper-latency comparison. It does not
show a whole-application, worker, CPU, RSS, throughput, or production-latency
gain. Producer construction/classification, parsing, app bootstrap, client/model/
index initialization, reset/seed, readback/checksum, IPC, contention, error and
provider paths, and application connection telemetry wrappers were excluded.
The two sides both used pooled/shared connections, so the measured difference
cannot be attributed solely to pooling. Explicit native field/schema/coercion
code avoids Mongoose framework work; that is a plausible explanation, not a
profiled attribution. This single run has overlapping sample ranges and does
not establish statistical significance or production impact.

The earlier prepared reducer-only benchmark remains valid: it measures the
reducer in isolation and found Rust slower across its cases. This helper
benchmark measures a wider path where reducer work is one part of persistence.
The different outcomes are not contradictory, but neither supports an overall
migration-goal or end-to-end application claim.

## Provenance, checks, and corrections

- Rust compiler receipt `compiler-1793299376013082945` passed formatting,
  scoped Clippy, and static musl release compilation. The compiler script took
  223.057 seconds; the full phase including bootstrap and cleanup took 232.411 seconds. The compiler cache
  was 2,484,514,816 bytes; minimum available host memory recorded was
  9,156,956,160 bytes.
- Node source preparation receipt `node-1793299376008552028` passed.
- Native fixture receipt `node-fixtures-1793299654020839804` passed runtime
  parity and untimed checking: 11.81 seconds for the native benchmark test, 22.008 seconds script
  time, 26.53 seconds total.
- The compiler ran with six CPUs, 4 GiB memory and equal memory-swap, 256 PIDs,
  and two compiler jobs. The 19-record production comparison was unchanged;
  acknowledged baseline was `api-ee0635765a02`.
- The independent validator initially expected the prepared-pool byte hash to
  be identical across runtimes. Node DTO property order and serde's sorted
  object keys produce different byte hashes; both were independently
  recomputed, and the input values matched. This was a validator expectation
  correction, not an application or benchmark mismatch.
- Attempt 1 stopped at strict Clippy findings (constant guard and collapsible
  `if`) and Node package provenance: package discovery found a duplicate
  `@redis/client/dist/package.json`. The code guard/style findings were fixed;
  package-root traversal was corrected to retain all package-scope manifests.
  The accepted source and measurements are from the verified candidate above.

Temporary test data cleanup reported the owned database dropped and Redis marker
deleted. No retirement, caller adoption, deployment, or push occurred. This
benchmark does not complete the AI usage persistence migration or establish
migration completeness.

## Evidence location

The [indexed repository archive](evidence/2026-10-29-ai-persistence-helper-benchmark/README.md) retains raw trials, all BSON snapshots, prepared inputs/source metadata, failed and successful run logs, static binary provenance, exact source bindings and reproduction tools. Independent readback verified 58 indexed file hashes and compressed raw payloads. Final readback found 19 unchanged production records and zero task-owned containers, networks or volumes.

- [Independent paired readback](evidence/2026-10-29-ai-persistence-helper-benchmark/artifacts/attempt2/independent-helper-report-readback.json).
- [Complete raw report](evidence/2026-10-29-ai-persistence-helper-benchmark/artifacts/attempt2/prepared/report.json.gz).
- [All actor samples](evidence/2026-10-29-ai-persistence-helper-benchmark/artifacts/attempt2/prepared/samples.ndjson.gz).
- [Exact binary provenance](evidence/2026-10-29-ai-persistence-helper-benchmark/artifacts/attempt2/binary-provenance.json).
