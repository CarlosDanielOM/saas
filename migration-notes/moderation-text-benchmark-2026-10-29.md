# Moderation text benchmark: initial paired baseline

This report records the first paired prepared benchmark of the verified Rust moderation text helpers. It shows mixed results: Rust was slower for common links and text folding, and faster for long links and regex escaping. Treat these as per-helper timings on one isolated host over prepared synthetic inputs. They do not establish production latency, a broad Rust performance advantage, or CPU or memory improvement.

## Results

Eight equally weighted prepared cases were used per workload. Each timed trial evaluated the eight cases 1,000 times each (8,000 operations per actor/workload). Each actor/workload had three warmup passes followed by seven alternating paired trials. Across four workloads this produced 56 timed actor-trials, or 224,000 timed operations per actor. Warmups are separate from those timed samples.

| Workload | TypeScript median (ns/op) | Rust median (ns/op) | Rust vs. TypeScript | Observed seven-trial range, TypeScript / Rust (ns/op) |
|---|---:|---:|---:|---:|
| Common links | 967.84775 | 2,452.192 | 153.365% higher | 819.9445–1,378.358125 / 2,375.270375–2,660.440875 |
| Long links | 327,477.8345 | 27,472.622125 | 91.611% lower | 324,331.07775–349,459.455 / 25,573.22425–37,299.483875 |
| Text folding | 469.380375 | 1,073.271625 | 128.657% higher | 437.807625–661.530375 / 1,013.16275–1,106.290875 |
| Regex escaping | 655.71075 | 288.789625 | 55.958% lower | 610.306875–681.62175 / 235.010125–345.897875 |

The percentage is the Rust median relative to the TypeScript median. The min/max ranges describe only these seven samples, not confidence intervals. Matching per-workload checksums were `3247409029` (common links), `1082847493` (long links), `2319121653` (folding), and `1891937349` (regex escaping). Raw samples, min/max, and independently read-back values are retained in the [paired report](evidence/2026-10-29-moderation-text-benchmark-baseline/artifacts/attempt1/paired1/independent-readback.json).

## What was timed

The source side called the complete `links.rule.ts` and `normalize.ts` TypeScript exports in a normal Node CommonJS realm; the native side called the production `evaluate_links_rule`, `fold_text`, and `escape_reg_exp` APIs in an exact static release ELF. The four pools covered short common-link chats with zero to three links; longer link cases with dotted failures, greed, URLs and Unicode; folding cases with ASCII, Unicode, marks, contextual casing, astral characters and lone surrogates; and regex escaping cases with metacharacters, clean text, astral characters and lone surrogates.

Both actors received the same prepared cases. Inputs were constructed and output slots allocated before timing. The timed region included function calls and storage of their results, with all outputs held until timing ended. Parsing, preparation, hashing, IPC, JSON encoding, checksums and destruction happened outside timing. The benchmark mixed each result's complete JSON wire into a 32-bit consistency checksum after timing. All checksums and outputs matched; the source artifact passed write/check, both processes exited successfully, and all before/after hashes for the 1,329 inputs, SDK, ELF and prepared input matched.

## Source and verification record

The frozen source was code commit `f2c16a330289a0b44867a5368cd017019a58d72d`, 1,329 inputs, tree SHA-256 `44551c83e5d859ad10dc92f75db5550c694eb7e6db450d14168938cf83c6278b`. The pinned Node runtime was 24.22.1 (V8 13.6.233.17-node.58, ICU 78.3, Unicode 17.0) with TypeScript 5.9.3. The prepared-input SHA-256 was `2a5721276df1bec019b063d11b68678af10d2ab68d2364eba1f1b3e9e3507181`; the exact static release ELF SHA-256 was `62490949d4e79efa81590066d3d528b177ee02941585b4025b2baa39bd7ce483`. The report SHA-256 is `4a321e284a6bf88a0ae718dfe6a63720a27cc30d9c30f7c50f9ad604e0400445`.

Pinned Node preparation and source write/check passed in run `1793307573090460748`. The release compiler run `1793307573088025938` passed formatting, scoped strict Clippy and release `--no-run`. Paired measurements passed in run `1793307663869458394`. The compiler step took 15.46 seconds (22.32 seconds total workflow); paired Node took 33.013 seconds (34.291 seconds total). Under the recorded 6-CPU, 4-GiB memory, no-swap, 256-pid and two-Cargo-job limits, minimum available memory was 9,670,266,880 bytes for compilation and 9,760,722,944 bytes for pairing; peak build cache was 3,875,733,504 bytes. These are resource records, not a CPU/RSS comparison.

Independent readback verified the paired report, input, ELF and source bindings. Final production inspection found 19 production records unchanged and zero task-owned resources remaining. The [evidence package](evidence/2026-10-29-moderation-text-benchmark-baseline/README.md) retains the source snapshot, artifacts, commands, raw runs, checksums and readback.

## Interpretation and next work

The regressions are retained. Candidate changes to common-link allocations and folding buffers/context lookups are being authored separately and remain unverified; those are structural hypotheses, not profiler-derived causes. Any follow-up must use a separate source snapshot, input artifact, result report and evidence attempt, with actual source-output parity checked against the prepared baseline. Do not overwrite or merge results into this initial record.

Correctness verification for the text ports is separate and remains valid. This benchmark did not retire TypeScript source, switch callers, deploy, push, add a crate, or validate a migration cutover. TypeScript sources and callers remain live, and wider moderation migration remains incomplete.
