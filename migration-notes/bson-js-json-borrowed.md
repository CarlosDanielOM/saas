# Borrowed BSON JSON serializer — 2026-10-30

## Scope and verified implementation

Accepted code commit `9d4971e70831e98a5e135dee96b0d3866d8a6787` adds `bson_js_json_string(&Bson) -> Result<String, _>` and `append_bson_js_json(&Bson, &mut String) -> Result<(), _>` to the existing BSON-to-JavaScript-JSON projection. Ordinary values stream directly from borrowed BSON values, without first building an owned JSON tree. DBRefs and special BSON representations reuse the existing owned projector and its error behavior. The append API restores the caller's original string if projection fails. The original owned API remains unchanged.

This is a library optimization only. The semantic worker still calls the owned API; there is no caller adoption, end-to-end result, or production performance claim. No new crate was added.

The frozen source tree SHA-256 is `1eb7124e14ac30149213b98485793be3e50985f60782f2643e1723ba39e788b5` (1,464 inputs: 1,454 Git inputs plus ten SDK inputs reused from the archive-verified `cache-and-types` mapping in the [moderation-variations evidence](evidence/2026-10-30-moderation-variations/source-bindings.json)). The SDK replay fixture SHA-256 is `b7a88bd77c3d2f78cd4787962d32e7b1264f9ccd06ccca66c6f3410ad74e5aac` and contains 54 replay records: 48 successful projections, five matching `TypeError`s, and one explicitly labeled invalid-RegExp decoder boundary. Five normal tests and one ignored dual-API replay passed. All strict feature profiles and formatting passed in the capped compiler run. The compiler step took 242.326 seconds (252.016 seconds total), with six CPUs, 4 GiB memory, no swap, 256 PIDs, and two Cargo jobs; minimum available memory was 9,039,851,520 bytes and peak private cache use was 7,754,387,456 bytes.

## Prepared-operation measurements

Two repeated-process rounds use four pools of 32 predecoded real SDK BSON inputs each. Every pool was checked against the wire output from both Rust APIs before timing. Each actor had one full-pass warmup followed by seven sequential samples. Node ran first; owned and borrowed Rust ran sequentially within one Rust process. Decode, setup, parsing, and I/O were excluded. The identical input SHA-256 before and after both rounds is `b719d74652c2104c1a2126b4757d70d3f5df094ba34ac07595bca01871dae89c`.

Medians are nanoseconds per operation; percentages use `(Node − Rust) / Node`, so positive means lower time than Node. Both round reports and all samples are retained in the [evidence package](evidence/2026-10-30-bson-json-borrowed/README.md).

| Workload | Round | Node median | Rust owned | Rust borrowed | Borrowed lower than Node / owned | Node and borrowed ranges overlap |
|---|---:|---:|---:|---:|---:|---|
| Ordinary numeric | 2 | 2,136.76 | 2,619.93 | 2,094.91 | 1.96% / 20.04% | Yes |
| Ordinary numeric | 3 | 2,208.46 | 2,528.07 | 2,140.74 | 3.07% / 15.32% | Yes |
| Nested mixed | 2 | 5,037.68 | 3,191.34 | 1,884.02 | 62.60% / 40.96% | No |
| Nested mixed | 3 | 5,395.49 | 3,152.37 | 1,806.07 | 66.53% / 42.71% | No |
| BSON specials | 2 | 9,882.25 | 6,211.01 | 5,182.32 | 47.56% / 16.56% | No |
| BSON specials | 3 | 10,776.03 | 5,760.21 | 5,055.40 | 53.09% / 12.24% | No |
| Large context arrays | 2 | 62,177.90 | 118,110.94 | 34,263.95 | 44.89% / 70.99% | No |
| Large context arrays | 3 | 74,215.47 | 117,851.31 | 32,513.05 | 56.19% / 72.41% | No |

Ordinary Node and borrowed sample ranges overlap in both rounds, so the repeated observations do not establish a clear gain for that workload. The other three workloads are faster descriptively in these synthetic measurements. The original owned baseline's regressions remain visible: ordinary numeric was 18.34% slower than Node and large context arrays were 73.59% slower; see the [owned baseline](bson-js-json-benchmark.md) and its [raw evidence](evidence/2026-10-30-bson-json-owned-baseline/README.md). The borrowed results improve both owned medians in this fixture but do not justify a universal Rust speed claim. These are not formal statistical runs: each actor has one process block per round, there are no fresh-process samples, and the benchmark does not measure decoding, application latency, production throughput, CPU, RSS, or application binary size. The retained executable is a benchmark test binary only.

## Isolation and evidence

The capped quality/benchmark run used source-tree SHA-256 `1eb7124e14ac30149213b98485793be3e50985f60782f2643e1723ba39e788b5`. The final production readback records all 18 production records unchanged. No production deployment, caller cutover, or push occurred.

The [borrowed evidence index](evidence/2026-10-30-bson-json-borrowed/README.md) contains the exact five implementation/test paths captured with `git show` from commit `9d4971e7`, all 14 immutable benchmark source pins, the SDK replay fixture, benchmark inputs and reports for both rounds, compressed raw receipts/logs and benchmark executable with raw and stored hashes, and static copies of the recorded tools. It is a bounded source capture, not a full source-tree clone.

The [interactive comparison](../artifacts/bson-json-benchmarks.html) preserves the initial regressions and both measured follow-up rounds.
