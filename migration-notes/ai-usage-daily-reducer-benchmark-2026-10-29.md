# AI usage daily reducer benchmark

Date: 2026-10-29
Scope: prepared finite-number ASCII daily reduction only
Status: three verified paired timing rounds; Rust was slower than TypeScript in every workload and round

## Result

The paired benchmark does not show a speedup for the Rust reducer. TypeScript's median was lower in all 15 workload-round comparisons. The third round is the candidate result associated with the final source snapshot; its Rust median remained about 1.56–2.88 times TypeScript's median depending on workload. Earlier rounds show that Rust was slower by a larger margin, especially before the later candidate revisions. These observations are limited to this prepared reducer benchmark and do not establish that the optimization meets its goal or predict application-level performance.

Each cell below gives the median as **microseconds/op (nanoseconds/op)**, then the raw minimum–maximum nanoseconds/op across seven paired trials. Each trial's operation count is shown separately because it varies with input size. Exact per-trial observations, hashes, and independent readback receipts are linked under [evidence](#evidence).

| Source revision / round | Days / groups | Ops per trial | TypeScript median µs (ns) [min–max ns] | Rust median µs (ns) [min–max ns] |
|---|---:|---:|---:|---:|
| `6830b3f5` / 1 | 1 / 4 | 1,000 | 1.197 (1,197.383) [1,061.177–1,485.553] | 7.058 (7,058.240) [6,656.268–7,291.157] |
| `6830b3f5` / 1 | 30 / 120 | 417 | 46.881 (46,880.954) [37,554.372–57,314.962] | 243.149 (243,148.851) [229,588.269–264,718.197] |
| `6830b3f5` / 1 | 90 / 360 | 139 | 108.134 (108,134.058) [72,537.022–152,836.576] | 903.077 (903,076.806) [882,446.957–926,073.554] |
| `6830b3f5` / 1 | 366 / 1,464 | 35 | 483.470 (483,469.886) [412,330.600–599,257.343] | 6,407.438 (6,407,437.571) [5,667,428.314–6,897,162.057] |
| `6830b3f5` / 1 | 3,660 / 14,640 | 4 | 4,529.700 (4,529,699.750) [3,483,231.750–4,992,146.000] | 291,209.120 (291,209,120.250) [285,559,087.000–303,952,950.750] |
| `a3743640` / 2 | 1 / 4 | 1,000 | 0.949 (948.868) [813.624–1,324.722] | 2.208 (2,207.997) [2,155.878–2,331.157] |
| `a3743640` / 2 | 30 / 120 | 417 | 38.298 (38,298.235) [24,117.429–54,186.894] | 68.322 (68,321.643) [63,056.578–93,676.978] |
| `a3743640` / 2 | 90 / 360 | 139 | 77.172 (77,172.101) [72,978.417–138,373.504] | 191.490 (191,489.691) [181,800.317–263,519.561] |
| `a3743640` / 2 | 366 / 1,464 | 35 | 487.494 (487,493.971) [320,236.971–676,087.800] | 853.247 (853,247.371) [839,096.886–994,184.200] |
| `a3743640` / 2 | 3,660 / 14,640 | 4 | 4,048.438 (4,048,438.250) [3,738,427.500–4,643,562.500] | 11,353.173 (11,353,173.250) [10,788,090.000–11,934,083.750] |
| `a87d9ee7` / 3 | 1 / 4 | 1,000 | 0.862 (862.065) [832.270–1,149.834] | 2.484 (2,483.752) [2,075.638–3,032.320] |
| `a87d9ee7` / 3 | 30 / 120 | 417 | 34.537 (34,537.281) [29,356.547–44,013.568] | 53.850 (53,850.341) [48,167.561–63,718.918] |
| `a87d9ee7` / 3 | 90 / 360 | 139 | 80.926 (80,926.036) [76,225.511–108,221.338] | 143.121 (143,120.525) [132,461.273–182,832.316] |
| `a87d9ee7` / 3 | 366 / 1,464 | 35 | 411.922 (411,921.857) [388,251.229–479,241.343] | 732.731 (732,731.057) [633,363.171–981,843.657] |
| `a87d9ee7` / 3 | 3,660 / 14,640 | 4 | 4,196.258 (4,196,257.500) [4,076,700.750–5,306,770.000] | 11,087.824 (11,087,823.500) [9,708,675.250–13,689,426.750] |

The input file hash is identical across all rounds: `a65715ff6e119fe68be6f89a096e397e20018ea022ea4f9f035816a530ae71c5`. The final round's independent readback verified all 35 samples, each sample's counts and checksum, and recomputed nanoseconds/op. Prepared outputs are compared outside timing using source-derived equivalent-field summaries with integer/float normalization; each runtime also records its own prepared-output hash. Seven paired trials alternate which runtime runs first. Warmup and timed operation counts follow the benchmark fixture's group-count formula; the raw JSON receipts record those counts and each trial's measurements.

The three rounds are not a stable cross-revision microbenchmark baseline. Their medians move substantially between rounds, including changes in both runtimes; the source revision and system load may differ. The paired order, common input, and independent receipts improve traceability but do not remove runtime noise or establish causal attribution for the differences. Do not select only the fastest trial or infer a production speedup from the change between rounds.

## What is measured

The fixture extracts the actual TypeScript `rows` declaration and reducer loop from the source using the TypeScript AST, including the complete `VALID_CATEGORIES`/`safeCategory` helper closure. Rust invokes the public production `reduce_daily_groups` with prebuilt BSON group documents. Inputs contain ordinary finite exactly representable numbers, dates, ASCII date/category strings, repeated categories, and two unknown categories that normalize to the same fallback. Group arrays are prepared before warmup. Both sides preallocate the output container before timing, retain results through timer end, then checksum and consume/drop results outside the timer. One persistent process per runtime alternates first position each trial; each trial uses one IPC request per batch.

This excludes work outside the reducer. In particular, BSON materialization happens later in `prepare_daily_inserts` and is not timed. There is no database, lock, queue, transport, input parsing, aggregation pipeline, Mongoose, or schema-construction timing. Output equivalence checks run outside the timer. Allocation remains timed and garbage collection can occur, with no guarantee of identical collection schedules.

The inputs do not cover BSON Long/Decimal wrapper coercion, non-finite numbers, UTF-16 edge cases, or malformed groups. The benchmark does not replace the daily persistence parity suite. These results make no memory, CPU, throughput, end-to-end, production-performance, or migration-completeness claim.

## Verification and release context

Final source snapshot `1001d651b1396c2bf99d4491bfbd9c95a61cc822c20e68296e6561b9ea9c6836` has 1,291 source inputs. The scoped compiler run used the task-owned compiler image under 6 CPUs, 4 GiB memory with equal swap limit, 256 PIDs, and two Cargo jobs; formatting, scoped Clippy, release compilation, and binary provenance checks passed. The final runtime used a separate task-owned Node image under 6 CPUs, 4 GiB memory with equal swap limit, and 256 PIDs. Readbacks state production was unchanged.

The final exact-source runtime receipt passed 11 ordinary cases, 204 actual-source cases, and 35 paired timing samples. A private fixture runtime receipt separately passed MongoDB and Dragonfly protocol checks. The Rust binary was a verified static x86-64 ELF. A prior runtime attempt (`node-1793297812780734880`) stopped before timing because the persistence reference fixture attempted to resolve missing path `/artifacts/ledger-persistence/attempt3/lock`. The fixture path was corrected, retained, and the later exact-source runtime plus private-fixture protocol checks passed. Do not count that failed harness start as a timing attempt.

The benchmark source history was recorded as `6830b3f5`, `a3743640`, and `a87d9ee7`; final candidate snapshot hash is above. Production remained at baseline `api-ee0635765a02`. This work did not mutate production, deploy, adopt callers, or push changes. The broader AI usage ledger migration remains partial because the malformed legacy expiry boundary and backfill path have not yet been validated; this benchmark does not satisfy the repository's 100% migration definition.

## Evidence

Evidence is retained in [the indexed repository archive](evidence/2026-10-29-ai-daily-reducer/README.md), including raw trials, source snapshots, successful and failed run logs, and reproduction tools. Compressed files have independent raw hashes.

- [Round 1 independent readback](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt1/independent-report-readback.json), [paired raw trials](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt1/prepared/rust-node-trials.json), [binary provenance](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt1/binary-provenance.json).
- [Round 2 independent readback](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt2/independent-report-readback.json), [paired raw trials](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt2/prepared/rust-node-trials.json), [binary provenance](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt2/binary-provenance.json).
- [Round 3 independent readback](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt3/independent-report-readback.json), [paired raw trials](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt3/prepared/rust-node-trials.json), [binary provenance](evidence/2026-10-29-ai-daily-reducer/artifacts/attempt3/binary-provenance.json).
- [Final compiler receipt](evidence/2026-10-29-ai-daily-reducer/runs/compiler-1793297040655785471-receipt.json.gz), [final exact-source runtime receipt](evidence/2026-10-29-ai-daily-reducer/runs/node-1793297958690919782-receipt.json.gz), and [private MongoDB/Dragonfly fixture receipt](evidence/2026-10-29-ai-daily-reducer/runs/node-fixtures-1793298262170959463-receipt.json.gz).
- [Failed pre-timing runtime receipt](evidence/2026-10-29-ai-daily-reducer/runs/node-1793297812780734880-receipt.json.gz) and [its harness error log](evidence/2026-10-29-ai-daily-reducer/runs/node-1793297812780734880.log.gz).
- [Acknowledged production baseline receipt](evidence/2026-10-29-ai-daily-reducer/production-acknowledgement/production-ack-api-ee0635765a02.json).
