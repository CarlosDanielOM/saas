# Moderation blacklist matcher — 2026-10-30

## Scope and source reuse

The opt-in Rust port maps `src/utils/moderation/rules/blacklist.rule.ts` to the typed local evaluator in `dimabot/src/utils/moderation/blacklist.rs`. It reuses the existing Rust normalization and UTF-16 string behavior, Unicode 17 simple folding, and the existing `regex` 1.13.1 crate. Its opt-in `moderation-blacklist` feature adds no crate, `Cargo.lock` change, default-feature change, or worker-profile change. The source's type-only `Pick<IModerationRule, 'terms'>` dependency is represented by a local Rust type. Existing caps L/Lu property tables are unchanged and are not the new `/iu` canonicalization table.

The matcher preserves compiled literal-term behavior: term folding, trimming and ordering, escaped `RegExp.source`, whitespace runs, `/iu` matching, UTF-16 strings and offsets, and Unicode letter/number boundaries. The concrete interface boundary is that Rust accepts only patterns made by its term compiler; it does not accept arbitrary externally constructed JavaScript `RegExp` values. The reviewed application callers compile patterns from terms, but the source export accepts any `RegExp`, so this remains a **partial local feature mapping**. The TypeScript handler, rule dispatcher, advanced moderation path, persistence, and enforcement are still active and unadopted.

## Final verification

The final frozen source snapshot was `edf8fdd9496cd676dcf74730a9a4018a0448143fffbab309698171272a7baa02`, with code commit `0aea6a84b16a059aee11624895599800ece41b01`. It passed the 1,816-case actual-TypeScript replay, exhaustive comparison of all 1,114,112 code-point values (including 2,048 surrogate values), the 5,348-case caps replay, 12 ordinary tests, feature-profile checks, all-feature strict Clippy, and release verification. The 12 ordinary tests comprise one Unicode core test, seven blacklist groups, and four caps tests; the previously verified emote-spam suite covers two related source-test groups. The final static benchmark ELF SHA-256 is `f738319035b090a5dfdf75b7828611502ac01c5d9a6f51490f21545d3fd85d99`.

The final seven-pair, 40,000-iteration benchmark reported median ns/op:

| Workload | TypeScript | Rust | Result |
| --- | ---: | ---: | --- |
| Short | 317.0336125 | 263.6205625 | Rust median 16.85% lower |
| Long | 16,497.2455 | 4,158.89595 | Rust median 74.79% lower |
| Many terms | 297.6083375 | 308.836375 | Rust median 3.77% higher |
| Unicode | 1,040.9541125 | 720.243125 | Rust median 30.81% lower |

The many-term sample ranges overlap (TypeScript 278.04–339.38 ns/op; Rust 303.12–339.54 ns/op). Treat this as mixed synthetic evidence: it does not show every Rust workload faster or establish statistical significance, production latency, CPU, RSS, or end-to-end throughput. Earlier candidates and all prior benchmark rounds, including regressions, remain recorded in the [evidence package](evidence/2026-10-30-moderation-blacklist/README.md).

The final source-matched inputs had SHA-256 `21414b376066cbd415c32344e2c6843a864f91c4fff753445aedf3a2fce7cc3a`. All 56 actor exits, input hashes, scalar checksums, full outputs, and pre/post source and binary hashes passed; an independent Python readback verified the fixture checksums, medians, and sample order. Benchmark timing includes fold, evaluation, and retaining results, but excludes parse/preparation/compilation, checksum, serialization, IPC, and destruction. Node warmup results are released with explicit GC outside the timer; Rust drops its results. These timings are prepared evaluator microbenchmarks.

Final verification ran through isolated compiler run `compiler-1793324226916895770`, Node replay `node-1793324198554386413`, and benchmark `node-1793324344061879850`. Compiler resources were capped at 6 CPUs, 4 GiB memory with no swap, two Cargo jobs, and 256 PIDs; private cache peaked at 5,493,420,032 bytes. Node benchmark minimum available memory was 10,396,471,296 bytes. The 18 inspected production records remained unchanged and no task-owned resources remained. No deployment or push occurred.

The source rule's original tests are tracked as test evidence, not as another feature. Their seven blacklist behavior groups and two emote-spam groups are covered by `dimabot/tests/moderation_blacklist.rs` and `dimabot/tests/moderation_emote_spam.rs`. The native test files exist and have recorded verification; an earlier source-audit note incorrectly said otherwise.

## Migration status

This utility is a partial local feature port because of the narrower regex interface, even though its current application callers use the supported compiler. The TypeScript evaluator and callers remain live, with no caller adoption or retirement. The broader moderation application path remains open. This evidence does not establish total migration completion, and it authorizes no deployment or push. See the [dependency matrix summary](dimabot-dependency-matrix-2026-10-28.md) for the bounded source-row classification.
