# Lossless JSON document matched benchmark — 2026-10-30

**Status: verified source-bound benchmark and local allocation improvement.** This record preserves the baseline, an unaccepted first revision, and the accepted second revision. Both confirmation orders and all earlier results are retained.

The baseline source snapshot is commit `ac54f24a5def1db0c928e7a06e32def38cbd42a2`, source tree SHA-256 `5fcf0145e5a67b8b0d7942016923e824e5ddc2e8b7a5d7dfbdbf6e95f8c5032d`, with 1,495 inputs (1,485 Git plus ten reused SDK inputs); all hashes match. The benchmark input SHA-256 is `0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c`; provenance SHA-256 is `17bdce824857127e76ab56d31451ac8a3a2903936436fa33522017ec9e5af280`. Independent input/provenance pins and report hashes are recorded in the evidence package.

## Measured operation and method

Both runtimes parse each complete JSON string, look up the root's own `error` property, test JSON-data truthiness, then serialize the selected value or return `null` when absent/falsy. Rust uses `JsonDocument::parse`, `get`, `truthy`, and `to_json_string`; Node uses built-in `JSON.parse`, `Object.hasOwn`, and `JSON.stringify`.

Five pools each contain 32 cases: small/falsy/missing values; wide objects with duplicate and index-like keys; an 8 KiB ignored payload; selected arrays nested 256 levels; and escaped control/lone-surrogate strings. All outputs were checked against the expected ASCII wires before timing. Each runtime ran 20 complete warmup passes and seven measured samples per workload, with 500 complete pool passes per sample (100 for the large payload). Checksums were checked after each timed sample and the input/provenance bytes were rechecked after both measurements.

The measured operation covers parse, own-property lookup, truthiness and selected canonical JSON output. It does not include Arc-owned copy costs or network work. The separate 31-case document correctness oracle is not a benchmark workload. The run used Node v24.22.1 / V8 13.6.233.17-node.58, binary SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`. Rust compilation and benchmark execution used six CPUs, 4 GiB memory with no swap, two Cargo jobs, and a 256 PID cap.

## Baseline results

Values are nanoseconds per operation. Each range is the minimum–maximum of seven measured samples. The ratio is Node median divided by Rust median: a value above 1 means the Rust median was lower in this pool; a value below 1 means it was higher.

| Workload | Node median (range) | Rust median (range) | Node/Rust median ratio |
|---|---:|---:|---:|
| Small strings | 346.229 (311.007–463.200) | 472.292 (400.431–487.685) | 0.733 |
| Wide object | 6,102.388 (5,722.630–8,189.455) | 26,835.378 (25,539.484–28,140.581) | 0.227 |
| Large ignored payload | 4,954.548 (4,897.774–5,300.541) | 6,329.728 (5,958.000–6,449.734) | 0.783 |
| Deep selected value | 53,319.491 (50,864.464–54,741.108) | 34,479.931 (25,447.183–36,636.070) | 1.546 |
| Escaped strings | 896.687 (877.500–983.470) | 1,287.577 (1,249.756–1,339.391) | 0.696 |

The medians are mixed: Node's median was lower in four pools; Rust's was lower for the deep-selected pool. These seven samples per pool do not establish formal statistical significance, a whole-application effect, memory/RSS behavior, or production latency. This is a narrow prepared-input microbenchmark with no network or Arc-owned copy cost.

## Baseline validation history and readback

Formatting run `1793367623335843496` passed. Compiler run `1793367645817467273` failed Clippy's constant-assertion lint for the release-profile guard. Compiler run `1793367681862868082` then reported rustfmt's formatting for that guard. Compiler run `1793367719218480854` passed formatting, scoped strict Clippy, and release build. These failed attempt logs and source maps are retained as historical evidence, not counted as final passes.

Node preparation run `1793367747282655631` passed. Node benchmark run `1793367766770861259` and Rust benchmark compiler/run `1793367777919017771` passed. Final Node check `1793367852328348358` passed without retiming; it revalidated input, provenance, report hashes, output shape, per-sample checksums and medians. The independent report SHA-256 values are `574cdae7eaa0d9a1cbbbfebaeebea5d1165e7252f994220ec168bac040400d31` (Node) and `057d8a06128e658e52d862911ca025fedb87d99a5d87400869d28666ea8238b8` (Rust).

Final readback found all 18 production records unchanged and zero task-owned resources. This baseline epoch makes no whole-application or optimization claim. The full source bindings, failed-source snapshots, report JSON, pins, raw run logs/receipts, scripts and readback are preserved in the [indexed evidence package](evidence/2026-10-30-json-document-benchmark/README.md).


## First revision (candidate 1) — measured, not accepted

Candidate 1 is a preserved first revision of the same matched operation. Its source binding is **not a Git commit**: it uses Git base `af54d3a3c6ba256012d5254edd140f1b748065b5` plus two explicitly preserved candidate overrides, `dimabot/src/utils/lossless_json_document.rs` and `dimabot/tests/lossless_json_document.rs`. The complete 1,495-input binding is 1,483 Git inputs, ten reused SDK inputs, and two overrides; all input hashes matched. Candidate source-tree SHA-256 is `c14213d652809da3666cc0a8c7c74e7a3bdf1bc7e9ed1c7ee528c743253a780e`. The workload input bytes are unchanged from baseline (`0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c`); candidate provenance SHA-256 is `d2964b511231c32e9d6b193e0052118036ac0e22db5658646f0b1a9504ba3646`.

The candidate retained semantic parity with the baseline document, parser, and query oracles. Formatting, Node fixture/oracle checks, resumed compiler checks, Node and Rust benchmark runs, and the final no-retiming verification passed. An earlier compiler attempt stopped operationally when a private cache guard reached 8,590,852,096 bytes after 436.456 seconds (minimum available memory was 13,733,658,624 bytes); it did not produce a source/test failure. The unchanged candidate was resumed and passed in 439.921 seconds total / 430.230 seconds in the build step, with 13,187,305,472 bytes minimum available and 8,552,398,848 bytes cache. The final benchmark compiler reported 3.17 seconds release build and 8.60 seconds for the benchmark test. All checks used the same six CPU, 4 GiB/no-swap, two Cargo job, 256 PID budget as the baseline where applicable.

The same five 32-case pools, 20 warmups, seven samples, and 500 passes per sample (100 for large payload) were used. The table shows candidate medians and seven-sample ranges beside baseline Rust medians. Ratios are Node median / Rust median for candidate 1. The last column compares candidate 1's Rust median with the baseline Rust median; positive values are slower. Values are ns/op.

| Workload | Baseline Rust median | Candidate Node median (range) | Candidate Rust median (range) | Node/Rust ratio | Candidate Rust vs baseline |
|---|---:|---:|---:|---:|---:|
| Small strings | 472.292 | 333.936 (309.457–681.582) | 554.070 (441.354–715.866) | 0.603 | +17.3% slower |
| Wide object | 26,835.378 | 6,188.405 (5,976.984–6,992.930) | 32,378.728 (29,910.058–38,535.579) | 0.191 | +20.7% slower |
| Large ignored payload | 6,329.728 | 5,980.258 (5,310.184–6,738.308) | 2,551.651 (2,355.471–2,730.051) | 2.344 | −59.7% faster |
| Deep selected value | 34,479.931 | 56,963.155 (55,480.917–59,194.224) | 42,819.936 (32,949.106–47,911.575) | 1.330 | +24.2% slower |
| Escaped strings | 1,287.577 | 1,091.246 (895.065–1,410.682) | 1,406.089 (1,301.082–1,441.352) | 0.776 | +9.2% slower |

Candidate 1 improves the large ignored-payload pool, while its Rust median is slower on the other four pools. This is a mixed result and is **not accepted as a performance improvement**. The seven samples do not establish formal significance; no aggregate, memory, whole-application, or production-latency conclusion is made. Candidate 2 is evaluated separately below on its own verified source binding and two independent benchmark orders.

The candidate's pre-stop checks covered the six core lossless JSON tests, 31 document oracle cases, query and parser replays (including 1,362 receipt cases across five time zones), and deletion/Twitch function behavior. After the cache-guard stop, the exact same source passed the resumed strict checks, including Twitch replay, scoped strict Clippy and all-feature strict Clippy. Two cache cleanup audits document only completed task-owned private debug executables; no shared caches, source, release artifacts, or production resources were removed. Final readback reported 18 production records unchanged and zero task-owned resources. Full payloads, pins, receipts, and scripts are in the [candidate 1 evidence package](evidence/2026-10-30-json-document-benchmark/README.md#candidate-1-first-revision-not-accepted).


## Candidate 2 — accepted local allocation improvement

Candidate 2 is source-bound to commit `b4b22630222b3ffd24a9c6f35c234e57eccf2279`, tree SHA-256 `5753a16fe447d7a8e5c1e005e4dd83265c350ffa482a5f2fdc7c98a862972213`, with 1,495 verified inputs (1,485 Git and ten reused SDK inputs). The benchmark input is byte-identical to baseline and candidate 1 (`0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c`); the candidate provenance SHA-256 is `28f8ef20e0cacd381c4fadf174818c0c1748b829cdfef3eeaf72ed912c8f0a25`.

The implementation removes pending allocation for scalar roots, uses array continuation frames instead of collecting a vector of child indices for every array, borrows unescaped keys, compares raw and escaped UTF-8 keys while keeping lone surrogates distinct from replacement characters, and caps the initial output reservation at 4,096 bytes. It adds no dependencies or public API. These are the source-level allocation changes; allocation counts and RSS were not instrumented.

Formatting, Node source-oracle checks, and the full compiler quality run passed. The compiler run completed in 381.490 seconds total / 371.252 seconds in the build step, with 12,841,123,840 bytes minimum available and 8,161,243,136 bytes peak cache. There was no cache-guard stop in candidate 2. Correctness checks replayed the 31-case document oracle, all 1,362 receipt parser cases across five time zones, 333 ledger query cases, and 126 deletion cases. The quality profile also covered shared-core tests, ordinary and exact-source Twitch checks, scoped and minimal-feature checks, Mongo/Redis feature checks, and all-feature strict Clippy. The accepted frozen source excludes three unverified Fish draft files and the working-only Fish Cargo/schema-module wiring; those drafts were preserved and not included in this source binding.

Both benchmark rounds used the same five pools, 32 cases per pool, 20 complete warmup passes, seven samples, 500 pool passes per sample (100 for the large ignored-payload pool), checksums, and pinned input/provenance bytes. Round 3 ran Node then Rust; round 4 reversed the order and ran Rust then Node. They are kept separate rather than merged or cherry-picked. Values are ns/op; ranges are the full seven-sample minimum–maximum. The ratio is Node median / Rust median.

### Round 3 — Node then Rust

| Workload | Node median (range) | Rust median (range) | Node/Rust ratio |
|---|---:|---:|---:|
| Small strings | 489.695 (316.766–654.145) | 451.180 (375.497–615.725) | 1.085 |
| Wide object | 5,765.257 (5,444.378–6,644.100) | 17,370.643 (16,321.912–19,734.416) | 0.332 |
| Large ignored payload | 5,005.888 (4,707.229–5,282.381) | 2,308.421 (2,277.976–2,343.179) | 2.169 |
| Deep selected value | 55,102.107 (52,872.398–59,223.513) | 11,519.088 (10,742.365–12,573.150) | 4.784 |
| Escaped strings | 973.612 (882.262–1,146.802) | 1,079.788 (927.724–1,623.848) | 0.902 |

### Round 4 — Rust then Node

| Workload | Node median (range) | Rust median (range) | Node/Rust ratio |
|---|---:|---:|---:|
| Small strings | 367.043 (314.273–499.353) | 431.445 (380.681–705.625) | 0.851 |
| Wide object | 5,774.429 (5,491.252–6,225.840) | 17,627.032 (16,661.348–20,446.186) | 0.328 |
| Large ignored payload | 4,621.663 (4,507.355–4,813.721) | 2,415.399 (2,311.398–2,504.472) | 1.913 |
| Deep selected value | 52,659.850 (50,583.260–57,627.208) | 11,207.255 (10,412.698–11,983.572) | 4.699 |
| Escaped strings | 899.395 (866.416–912.298) | 1,062.422 (943.004–1,159.534) | 0.847 |

Across both orders, Rust recorded lower median times on the large ignored-payload and deep-selected pools, with Node/Rust median-time ratios of about 1.9–2.2 and 4.7–4.8, respectively. Node is about 3× faster on wide objects. Small-string ranges overlap in both orders and the median winner switches. Escaped-string ranges overlap in round 3; in round 4 Node's range is lower and does not overlap Rust's. These results support the **local allocation improvement** in the measured `JsonDocument` operation, not a claim that Rust is faster across all Node cases, the whole application, memory/RSS, or production latency. No formal statistical inference is made.

The accepted source commit contains this local utility improvement only. It does not retire TypeScript files or complete total migration; total migration remains incomplete. Final production readback recorded all 18 records unchanged and zero task-owned resources. The full indexed evidence is in the [candidate 2 package](evidence/2026-10-30-json-document-benchmark/README.md#candidate-2-accepted-local-allocation-improvement). The [rendered benchmark chart](../artifacts/json-document-benchmarks.html) shows the final confirmation round beside the original Rust baseline; both confirmation rounds are tabulated above.
