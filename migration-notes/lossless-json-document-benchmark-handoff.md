# Flat JSON document matched benchmark handoff

The baseline `JsonDocument` parse/select/serialize benchmark is **source-bound and verified**. See the [baseline report](lossless-json-document-benchmark.md) and [indexed evidence package](evidence/2026-10-30-json-document-benchmark/README.md). Candidate 1 is preserved as an unaccepted first revision. Candidate 2 has its own accepted source binding and two separate benchmark rounds; neither candidate is folded into the baseline epoch.

The baseline source is commit `ac54f24a5def1db0c928e7a06e32def38cbd42a2`, tree SHA-256 `5fcf0145e5a67b8b0d7942016923e824e5ddc2e8b7a5d7dfbdbf6e95f8c5032d`, with 1,495 inputs (1,485 Git plus ten reused SDK inputs). Benchmark input and provenance hashes were independently pinned, Node and Rust reports checked, then a Node checker revalidated all four artifact hashes and both reports without retiming.

The benchmark covers five 32-case pools, 20 full warmup passes, and seven samples with 500 passes per sample (100 for the large payload). It measures parsing, root own `error` lookup, truthiness, and selected canonical JSON output. It excludes Arc-owned copy and network costs. The baseline medians are mixed: Node was lower on small strings, wide objects, large ignored payload, and escaped strings; Rust was lower on deep-selected values. See the report for all medians, ranges, and Node/Rust median ratios. This is not formal statistical evidence or a whole-application/memory/production claim.

Formatting, scoped strict Clippy, release build, Node preparation, Node benchmark, Rust benchmark, and final no-retiming check passed. Two earlier compiler attempts failed on the constant release assertion and then its formatting; both attempt logs and their source maps are preserved. Final readback found 18 production records unchanged and zero task-owned resources. No benchmark or test was rerun as part of this documentation task.


## Candidate 1 epoch

The first revision is measured and source-bound to Git base `af54d3a3c6ba256012d5254edd140f1b748065b5` plus two preserved file overrides; it has no single Git source commit. The 1,495-input binding (1,483 Git, ten reused SDK, two overrides) has source-tree SHA-256 `c14213d652809da3666cc0a8c7c74e7a3bdf1bc7e9ed1c7ee528c743253a780e`. All benchmark input hashes match baseline; candidate provenance and report pins are retained in `candidate1/`.

Semantic checks and final benchmark checks passed after an operational private-cache guard interruption and same-source resume. Candidate 1 improves the large ignored-payload Rust median by 59.7%, but is slower than baseline on small strings (+17.3%), wide objects (+20.7%), deep selected values (+24.2%), and escaped strings (+9.2%). It is therefore **not accepted as a performance improvement**. The main report contains every candidate Node/Rust median, seven-sample range, Node/Rust ratio, and the comparison method. Candidate 2 is accepted as a local allocation improvement based on its independently pinned round 3 and round 4 reports.

Candidate evidence is losslessly gzip-preserved and indexed with original path, raw/stored SHA-256 and sizes. The original 36 baseline index entries remain intact; candidate 1 is appended under `candidate1/`. The package contains the two source overrides, the full relevant oracle outputs without the 445 copied public package files, pins, run logs/receipts, cache audits, production readback, and reproduction tools. No mutable snapshot or duplicated Node/SDK binary is included.


## Candidate 2 acceptance and handoff

Candidate 2 is bound to source commit `b4b22630222b3ffd24a9c6f35c234e57eccf2279`, source-tree SHA-256 `5753a16fe447d7a8e5c1e005e4dd83265c350ffa482a5f2fdc7c98a862972213`, and 1,495 verified inputs (1,485 Git plus ten reused SDK). It uses the same input SHA-256 as baseline and candidate 1. Formatting, Node source-oracle checks, full quality/compiler checks, and both benchmark rounds passed. Correctness replays included the 31 document, 1,362 parser, 333 query, and 126 deletion cases. Final readback was 18 production records unchanged and zero task-owned resources.

Round 3 measured Node then Rust; round 4 reversed the order. Both complete median/range tables and Node/Rust ratios are in the [report](lossless-json-document-benchmark.md). Rust consistently wins on large ignored payload (1.9–2.2×) and deep selected values (4.7–4.8×); Node is about 3× faster on wide objects. Small ranges overlap and the median winner changes. Escaped ranges overlap in round 3; Node is faster with non-overlapping ranges in round 4. This supports acceptance as a **local allocation improvement**, not an all-workload, whole-application, RSS, or production-latency claim. Allocation counts were not instrumented. No TypeScript source was retired; total migration remains incomplete.

The separately indexed candidate 2 package preserves source bindings, excluded-working-draft isolation, oracle results, both rounds' exact inputs/provenance/reports and independent pins, all run logs/receipts, cache maintenance, production readback, and reproduction tools. The baseline's 36 records and candidate 1's 51 records remain unchanged; candidate 2 appends 65 records. The root [benchmark chart](../artifacts/json-document-benchmarks.html) is linked but not regenerated as part of this documentation update.
