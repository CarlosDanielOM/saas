# Moderation blacklist verification evidence

This package retains the source bindings, frozen fixture inputs, benchmark artifacts, independent readbacks, verification receipts, and reproduction tools for the 2026-10-30 native blacklist matcher review. `verification-summary.json` is the detailed run index; `artifact-sha256.json` inventories retained artifacts. The final source snapshot is `edf8fdd9496cd676dcf74730a9a4018a0448143fffbab309698171272a7baa02` at commit `0aea6a84b16a059aee11624895599800ece41b01`.

## Source and behavior scope

The Rust port covers the typed term-compiled evaluator in `dimabot/src/utils/moderation/blacklist.rs`, reusing existing normalization, UTF-16 string helpers, and Unicode support. `moderation-blacklist` uses the pre-existing `regex` 1.13.1 dependency and is opt-in; it adds no crate, lockfile change, default-feature change, or worker-profile change. The local type replaces the source's type-only `Pick<IModerationRule, 'terms'>`. The raw Unicode L/Lu tables used by caps are byte-identical to their earlier version and are separate from the blacklist `/iu` canonicalization table.

The supported Rust input is a compiled literal-term pattern produced by the term compiler. Arbitrary externally constructed JavaScript `RegExp` values are unsupported; the TypeScript export accepts them. The reviewed application callers compile their patterns from terms, but this API difference keeps the local feature row **partial**. TypeScript caller adoption, retirement, persistence, and enforcement remain open.

## Final correctness and runtime checks

The final run set is recorded in `configuration.json` and `verification-summary.json`:

- Frozen source snapshot: `edf8fdd9496cd676dcf74730a9a4018a0448143fffbab309698171272a7baa02`.
- Prepared benchmark input file: SHA-256 `21414b376066cbd415c32344e2c6843a864f91c4fff753445aedf3a2fce7cc3a`.
- Actual-source differential replay: 1,816 cases passed; complete code-point replay: 1,114,112 values, including 2,048 surrogate values; caps regression replay: 5,348 cases.
- Ordinary Rust tests: one Unicode-core test, seven blacklist groups, and four caps tests passed. The previously verified emote-spam suite covers the two related source-test groups.
- Formatting, feature-profile checks, all-feature strict Clippy, and release verification passed. The final static benchmark ELF SHA-256 is `f738319035b090a5dfdf75b7828611502ac01c5d9a6f51490f21545d3fd85d99`.
- All 56 paired benchmark actors exited successfully. Input hashes, scalar checksums, full outputs, and before/after source and binary hashes matched. The independent readback at `artifacts/attempt4/paired1/independent-timing-readback.json` independently verified fixture checksums, medians, and sample order.

The Unicode 17 `/iu` simple-fold table contains 1,512 C/S pairs, including U+0345. The CaseFolding input and license are pinned and recorded in the source manifest. Full simple-fold and L/Lu property checks used pinned Node 24.22.1 / V8, ICU 78.3, and Unicode 17.0. The caps evaluator continues using its existing raw L/Lu tables; it does not use the new canonicalization table.

## Paired benchmark history

Each row lists median ns/op as TypeScript / Rust. Each workload column records the two actor medians. The early results exposed real regressions and remain part of the record; later results do not erase them.

| Candidate and evidence | Iterations | Short | Long | 97-term hit / 96-term miss | Unicode |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial baseline, `attempt1` | 4,000 | 395.85275 / 406.509 | 19,478.5585 / 52,866.5735 | 346.824625 / 779.792 | 1,093.132625 / 725.644375 |
| Corrective attempt 2, `attempt2` | 4,000 | 353.84925 / 300.813375 | 19,584.42175 / 21,155.169 | 374.142 / 318.50275 | 1,124.991 / 664.459625 |
| 512-byte prefilter candidate, `attempt3` | 4,000 | 372.40875 / 272.599375 | 17,514.66725 / 4,051.54425 | 366.336125 / 414.600375 | 1,375.949875 / 813.73925 |
| Same candidate, stability run | 40,000 | 274.8314125 / 248.2050625 | 16,395.310175 / 3,995.34885 | 305.8281 / 362.0786 | 982.8072 / 674.80325 |
| Final all-ASCII-length prefilter, `attempt4` | 40,000 | 317.0336125 / 263.6205625 | 16,497.2455 / 4,158.89595 | 297.6083375 / 308.836375 | 1,040.9541125 / 720.243125 |

The 512-byte candidate's 40,000-iteration many-term median was 18.4% slower in Rust. The final all-length prefilter's many-term Rust median was 3.77% higher than Node's, with overlapping sample ranges: TypeScript 278.04–339.38 ns/op and Rust 303.12–339.54 ns/op. The final other three Rust medians were lower: short by 16.85%, long by 74.79%, and Unicode by 30.81%. These are seven alternating pairs per workload. The workloads contain two short cases, one long case, two many-term cases, and two Unicode cases. The many-term fixture is specifically a 97-term hit and a 96-term miss; it is not a late-alternative hit.

The 4,000-iteration rounds used 8,000 operations per actor trial for three workload pools and 4,000 for the long pool. The 40,000-iteration rounds used 80,000 operations per actor trial for three pools and 40,000 for the long pool. Every actor performs three full same-process warmups. Patterns are prepared and compiled before the timer. Timers include fold, evaluation, and retaining results; parsing, preparation, compilation, checksums, serialization, IPC, and destruction are excluded. Node explicitly collects warmup results before timing; Rust drops its results. Sample ranges overlap in the final many-term workload. No round establishes statistical significance, production latency, CPU, RSS, or end-to-end throughput.

Run artifacts and provenance are grouped by candidate under `artifacts/attempt1` through `artifacts/attempt4`; `attempt4/paired1` includes the final report and independent timing readback. `baseline-binding.json`, `intermediate-binding.json`, `long-prefilter-binding.json`, and `source-binding.json` retain source-to-candidate manifests. `reproduction-tools/` contains the frozen-input, build, replay, benchmark, and readback helpers used for these recorded runs.

## Isolated execution and production state

Final verification used `node-1793324198554386413`, `compiler-1793324198556056020`, `compiler-1793324226916895770`, and `node-1793324344061879850`. Compiler caps were 6 CPUs, 4 GiB memory with no swap, two Cargo jobs, and 256 PIDs. The private build cache peaked at 5,493,420,032 bytes. Compiler minimum available memory was 9,933,545,472 bytes; the final Node benchmark minimum was 10,396,471,296 bytes. Rust and benchmark work used isolated task-owned resources and a read-only source snapshot.

Before/after readbacks found all 18 production records unchanged and zero remaining task-owned resources. No production service was deployed or modified. This evidence authorizes no deployment or push.
