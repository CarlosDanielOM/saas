# JavaScript Unicode 17 string core handoff

**Status: verified shared pure-string core; no JavaScript caller adoption.** The native core implements default locale-independent lowercase and `normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()` over JavaScript UTF-16 strings. Its source-backed exhaustive verification is summarized in [the dated Unicode note](js-unicode17-2026-10-29.md). It does not implement JavaScript input coercion, `escapeRegExp`, the complete `normalize.ts` adapter, or any AST/application caller path.

The pinned data came from Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3 and Unicode 17.0. The required generated Rust data SHA-256 is `6c9529a54bd192de38852f31421383d3295dc9010ca463037b6383e361040aeb`; the accepted reference SHA-256 is `aba3756c8cacc9a25432c282f15141dc5d34da317c13618cfcfa43253c0e3246`. The source-bound generator SHA-256 is `7c464ae4144db4a082a56593ddabf7c804a21503489a2db5abf446eb8e942f2f`. See [the reference-data handoff](js-unicode17-handoff.md) for pinned inputs and Unicode data sources.

## Core behavior

`dimabot/src/utils/js_unicode.rs` exports `lowercase(&JsString) -> Cow<JsString>` and `fold_text(&JsString) -> Cow<JsString>`. `JsString` retains arbitrary UTF-16, including lone surrogates. Unchanged output, including ASCII lowercase text, can be borrowed. These are typed string functions: they do not model JavaScript value coercion such as `String(text ?? '')`.

The core uses the existing `unicode-normalization` 0.1.26 NFD implementation, which carries Unicode 18 data. It applies NFD only to runs of Unicode 17 assigned scalars, placing barriers at Unicode 17-unassigned code points and surrogate code units; Unicode 17 Mark classification is then applied to the normalized output. For jointly assigned code points, NFD stability is specified by [UAX #15](https://www.unicode.org/reports/tr15/). This is the version boundary that lets the newer NFD implementation serve the pinned older source without using post-17 assignments as normalization input. No Rust standard-library Unicode version is assumed, and this work did not reproduce a standard-library mismatch.

Lowercase uses pinned mappings plus the locale-independent contextual Final Sigma rule. Its forward and reverse context scans check `Case_Ignorable` before `Cased`, since the properties overlap. Folding decodes the output UTF-16 again after Mark removal: removing a Mark can bring two surrogate units together into a valid supplementary scalar before lowercase. The Unicode 17 table is generated from the actual pinned runtime and is not a transcription of a Rust standard-library table.

The generated data has 1,488 lowercase mappings; `Cased`: 4,632 code points/158 ranges; `Case_Ignorable`: 2,794/464; `Mark`: 2,543/327; and `Assigned`: 299,382/735. `Cased` and `Case_Ignorable` overlap at 268 code points. The accepted reference additionally records 6,432 contextual cases and 13,253 single-code-point NFD facts. The latter are reference evidence, not a runtime NFD lookup.

## Verification

The TypeScript source oracle (`node-1793306075185472154`) passed write/check against the actual `normalize.ts` source and emitted 16,842 non-identity scalar folds and 20 mixed-context cases. It checked the full source structure and invoked its actual exports in a VM. This establishes the oracle and its binding, not Rust adapter parity.

Ordinary compiler run `1793306075185634397` passed formatting, scoped Clippy and one ordinary Rust test. Final run `1793306144515399315` compared lowercase and fold results for all 1,114,112 code point values (including 2,048 lone surrogates), 6,432 contextual cases and 20 mixed cases; exhaustive replay took 8.25 seconds. It also passed no-feature checks, Mongo/Redis profile checks, all-feature/all-target checks and strict Clippy.

The final compiler step used 6 CPUs, 4 GiB memory with memory-swap equal to memory (no swap), 256 PIDs and two Cargo jobs. It took 114.562 seconds; the full script took 121.38 seconds. Minimum available host memory was 8,281,657,344 bytes and the cache was 3,774,877,696 bytes. The production and cleanup readback is still pending with the parent; checks recorded so far show all 19 production records unchanged. No benchmark, CPU/RSS or speed claim was made.

Generation and correction history is preserved with the parent-owned evidence package at `migration-notes/evidence/2026-10-29-js-unicode17/`: the first AST printer comparison failed before data generation; the source comparison was corrected to exclude `SourceFile.text`, fixture metadata wording was corrected, and a fresh generation was byte-identical to the first data and facts. Another Node attempt lacked the required pre-created empty output directory; creating it resolved that environment issue. All attempts remain in run history, and no fixture was silently overwritten.

## Adapter boundary

The separately authored `dimabot/src/utils/moderation/normalize.rs` adapter has not been verified by this core work. In particular, this note does not establish `foldText` nullish coercion, `escapeRegExp` behavior, the source file's full API parity, or any caller migration. Existing TypeScript sources and callers remain in place, and no new dependency-ledger row is warranted for this reusable core alone.
