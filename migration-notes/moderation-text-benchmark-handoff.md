# Prepared moderation text benchmark handoff (2026-10-29)

## Initial measured baseline

The first paired prepared benchmark is complete and has mixed results. Preserve it as the baseline; do not overwrite its report, input, source snapshot, or ELF. The actual TypeScript exports ran in a normal Node CommonJS realm against a static release Rust ELF. Results are reported separately for each of four synthetic pools. Rust was slower on common links and text folding, and faster on long links and regex escaping. These are bounded helper results, not production latency claims. See the [dated baseline report](moderation-text-benchmark-2026-10-29.md) and [indexed evidence](evidence/2026-10-29-moderation-text-benchmark-baseline/README.md).

## Benchmark contract

The TypeScript side uses the complete source `links.rule.ts` and `normalize.ts` exports compiled into a normal Node CommonJS realm; the native side uses the production `evaluate_links_rule`, `fold_text`, and `escape_reg_exp` APIs. The source oracle pins source, TypeScript SDK, Node and runtime exports, checks strict TypeScript diagnostics and the type-only schema field, and blocks runtime `require`. It writes UTF-16 inputs, rules, source output units, and exact JSON wires to an external artifact. Rust validates the artifact SHA and its source/native dependency pins. Surrogate code units remain intact.

Each pool has eight equally weighted prepared items: short common-link chats with zero to three links; longer link cases with dotted failures, greed, URLs and Unicode; folding cases covering ASCII, Unicode, marks, contextual casing, astral characters and lone surrogates; and regex escaping cases with metacharacters, clean text, astral characters and lone surrogates. Every timed trial evaluates each item 1,000 times (8,000 calls per actor/workload trial). Each actor/workload had three full-pass warmups and seven alternating paired trials. There are 56 timed actor-trials and 224,000 timed calls per actor across the four pools.

Inputs are prepared and output slots allocated before timing; the timed region includes production function calls and storing their results, with all results held until timing ends. JSON encoding, validation, checksums, IPC, preparation and destruction are outside timing. Every complete JSON result wire is mixed into a 32-bit checksum after timing. All prepared source outputs, checksums and totals matched. The pinned source artifact passed write/check before and after measurement; hashes of the 1,329 source inputs, SDK, exact ELF and benchmark input were equal before and after. Both processes exited successfully.

## Baseline provenance and limits

This is source commit `f2c16a330289a0b44867a5368cd017019a58d72d`, with 1,329 frozen source inputs and source-tree SHA-256 `44551c83e5d859ad10dc92f75db5550c694eb7e6db450d14168938cf83c6278b`. The benchmark-input SHA-256 is `2a5721276df1bec019b063d11b68678af10d2ab68d2364eba1f1b3e9e3507181`; the exact static release ELF SHA-256 is `62490949d4e79efa81590066d3d528b177ee02941585b4025b2baa39bd7ce483`. The release compiler run was `1793307573088025938`; source preparation was `1793307573090460748`; paired measurement was `1793307663869458394`. The paired report SHA-256 is `4a321e284a6bf88a0ae718dfe6a63720a27cc30d9c30f7c50f9ad604e0400445`.

The benchmark build's scoped formatting/strict Clippy and release `--no-run` checks passed. The full source oracle passed write/check, and the paired run's checksums, pre/post hashes, and clean exits passed. Under the 6-CPU, 4-GiB memory, no-swap, 256-pid, two-Cargo-job cap, the compiler step took 15.46 seconds / 22.32 seconds for the workflow, with 9,670,266,880 bytes minimum available and 3,875,733,504 bytes peak cache. The paired Node step took 33.013 seconds / 34.291 seconds total, with 9,760,722,944 bytes minimum available. No CPU or RSS comparison was made.

This one-host run uses prepared synthetic cases and 7 pairs per pool. The timings do not include parsing, input preparation, hashing, serialization, communication, checksum or destruction. Do not aggregate across workloads or extrapolate to application traffic. The results establish neither a general Rust advantage nor a statistical or production-performance claim. The existing correctness evidence for the two text ports is separate and remains valid; the timing regressions do not imply a correctness failure.

## Follow-up work

Two candidate optimizations are being authored separately and are not verified: reducing allocations in common links and avoiding unnecessary buffers/context lookups in folding. These are structural hypotheses, not profiler-supported causal findings. Keep this baseline immutable. Any comparison must use a separate source snapshot, prepared-input artifact, report and evidence attempt; verify source-output parity against the same prepared inputs before interpreting timing. Do not replace or merge this baseline with a follow-up result.

No source retirement, caller adoption, deployment, push or new crate occurred. The TypeScript source and callers remain live. The full moderation migration remains incomplete.
