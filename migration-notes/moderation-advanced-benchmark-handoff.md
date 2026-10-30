# Advanced moderation hot-match benchmark handoff

Two complete paired rounds passed: 70 fresh-process samples per round (seven
Node/Rust pairs for each of five workloads). Each actor used 32 prepared pool
entries, 250 rounds, and 8,000 operations per sample, with three full-pool
warmups (24,000 warmup operations). Pair order alternated. Both rounds retained
matching checksums and exact source/binary provenance. The independent
readback for round two verified source identity and all 70 samples. See the
[paired report](evidence/2026-10-30-moderation-advanced/artifacts/paired-attempt2/advanced-paired-report.json.gz),
[independent readback](evidence/2026-10-30-moderation-advanced/artifacts/paired-attempt2/independent-readback.json),
and [standalone benchmark report](evidence/2026-10-30-moderation-advanced/artifacts/advanced-benchmarks.html).

The hot public matcher call includes matching, folding/cache work, and output
assembly for prepared text, terms, and patterns. It excludes preparation,
initial compilation, serialization, checksums, and destruction of retained
outputs; temporary destruction inside the call is included. These figures are
not whole-request measurements. They do not measure CPU, RSS, startup, database
or network work, or production throughput.

Median nanoseconds per operation for the final optimized source:

| Workload | Node | Rust |
| --- | ---: | ---: |
| ASCII | 12,583.771375 | 1,470.04225 |
| Long mixed UTF-16 | 107,164.998875 | 33,176.764125 |
| Unicode | 20,432.9065 | 3,505.389875 |
| Regex only | 11,898.85725 | 979.48975 |
| Many terms | 51,513.320375 | 4,098.377 |

Each round used its own Node baseline source. The baseline's severe Rust
regressions in ASCII, long text, and many terms are preserved in the first
round's evidence; they were not dropped or folded into the final comparison.
The second round measures the optimized source tree pinned by its report. These
microbenchmarks do not establish application-level or production latency.
