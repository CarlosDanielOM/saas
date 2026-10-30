# Lossless JSON document matched benchmark — baseline — 2026-10-30

**Status: verified source-bound baseline benchmark.** This record covers the baseline `JsonDocument` parse/select/serialize implementation only. A separate optimization is being authored and is not represented or credited in this result.

The tested source snapshot is commit `ac54f24a5def1db0c928e7a06e32def38cbd42a2`, source tree SHA-256 `5fcf0145e5a67b8b0d7942016923e824e5ddc2e8b7a5d7dfbdbf6e95f8c5032d`, with 1,495 inputs (1,485 Git plus ten reused SDK inputs); all hashes match. The benchmark input SHA-256 is `0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c`; provenance SHA-256 is `17bdce824857127e76ab56d31451ac8a3a2903936436fa33522017ec9e5af280`. Independent input/provenance pins and report hashes are recorded in the evidence package.

## Measured operation and method

Both runtimes parse each complete JSON string, look up the root's own `error` property, test JSON-data truthiness, then serialize the selected value or return `null` when absent/falsy. Rust uses `JsonDocument::parse`, `get`, `truthy`, and `to_json_string`; Node uses built-in `JSON.parse`, `Object.hasOwn`, and `JSON.stringify`.

Five pools each contain 32 cases: small/falsy/missing values; wide objects with duplicate and index-like keys; an 8 KiB ignored payload; selected arrays nested 256 levels; and escaped control/lone-surrogate strings. All outputs were checked against the expected ASCII wires before timing. Each runtime ran 20 complete warmup passes and seven measured samples per workload, with 500 complete pool passes per sample (100 for the large payload). Checksums were checked after each timed sample and the input/provenance bytes were rechecked after both measurements.

The measured operation covers parse, own-property lookup, truthiness and selected canonical JSON output. It does not include Arc-owned copy costs or network work. The separate 31-case document correctness oracle is not a benchmark workload. The run used Node v24.22.1 / V8 13.6.233.17-node.58, binary SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`. Rust compilation and benchmark execution used six CPUs, 4 GiB memory with no swap, two Cargo jobs, and a 256 PID cap.

## Results

Values are nanoseconds per operation. Each range is the minimum–maximum of seven measured samples. The ratio is Node median divided by Rust median: a value above 1 means the Rust median was lower in this pool; a value below 1 means it was higher.

| Workload | Node median (range) | Rust median (range) | Node/Rust median ratio |
|---|---:|---:|---:|
| Small strings | 346.229 (311.007–463.200) | 472.292 (400.431–487.685) | 0.733 |
| Wide object | 6,102.388 (5,722.630–8,189.455) | 26,835.378 (25,539.484–28,140.581) | 0.227 |
| Large ignored payload | 4,954.548 (4,897.774–5,300.541) | 6,329.728 (5,958.000–6,449.734) | 0.783 |
| Deep selected value | 53,319.491 (50,864.464–54,741.108) | 34,479.931 (25,447.183–36,636.070) | 1.546 |
| Escaped strings | 896.687 (877.500–983.470) | 1,287.577 (1,249.756–1,339.391) | 0.696 |

The medians are mixed: Node's median was lower in four pools; Rust's was lower for the deep-selected pool. These seven samples per pool do not establish formal statistical significance, a whole-application effect, memory/RSS behavior, or production latency. This is a narrow prepared-input microbenchmark with no network or Arc-owned copy cost.

## Validation history and readback

Formatting run `1793367623335843496` passed. Compiler run `1793367645817467273` failed Clippy's constant-assertion lint for the release-profile guard. Compiler run `1793367681862868082` then reported rustfmt's formatting for that guard. Compiler run `1793367719218480854` passed formatting, scoped strict Clippy, and release build. These failed attempt logs and source maps are retained as historical evidence, not counted as final passes.

Node preparation run `1793367747282655631` passed. Node benchmark run `1793367766770861259` and Rust benchmark compiler/run `1793367777919017771` passed. Final Node check `1793367852328348358` passed without retiming; it revalidated input, provenance, report hashes, output shape, per-sample checksums and medians. The independent report SHA-256 values are `574cdae7eaa0d9a1cbbbfebaeebea5d1165e7252f994220ec168bac040400d31` (Node) and `057d8a06128e658e52d862911ca025fedb87d99a5d87400869d28666ea8238b8` (Rust).

Final readback found all 18 production records unchanged and zero task-owned resources. No new whole-application claim or optimization result is included. The full source bindings, failed-source snapshots, report JSON, pins, raw run logs/receipts, scripts and readback are preserved in the [indexed evidence package](evidence/2026-10-30-json-document-benchmark/README.md).
