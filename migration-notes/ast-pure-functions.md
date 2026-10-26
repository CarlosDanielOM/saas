# Opt-in Rust AST pure functions

Status: accepted as an opt-in library-only implementation. Final quality, source parity, selected release measurements, independent review, and cleanup are complete. No TypeScript caller, API route, worker profile, or production service is wired or deployed. The measurements below are synthetic and do not claim production performance.

## Scope and source reuse

The independent `ast-pure-functions` feature composes `ast-evaluator` with the already locked optional `regex` dependency. Cargo defaults and the existing `ast-evaluator` feature remain unchanged; no lockfile or worker-profile change is intended. `FunctionRegistry::with_pure_builtins()` installs exactly 27 names. `register_pure_builtins()` adds those names to an existing registry, including one alias, and leaves the five context builtins independent. The existing `register` API remains the host override path, including metadata inheritance and insertion order. Pure dispatch runs synchronously only after the evaluator has evaluated arguments and applied the existing permission gate. `random` continues through the evaluator host's existing RNG.

The source oracle lifts the existing helpers from `string.functions.ts`, `random.functions.ts`, `eventsub.functions.ts`, and the pure portions of `user.functions.ts`; it excludes only `randomuserHandler` and its registration, which depend on chat context. The 27 registrations are eight string functions (`upper`, `lower`, `title`, `capitalize`, `trim`, `length`, `slice`, `replace`), `user` and `touser`, `random`, and 16 EventSub names including `redemption.input` as an alias of `reward.input`. The existing evaluator already owns AST argument evaluation, permissions, typed JavaScript values, UTF-16 strings, contexts, and the injected host. The gap was native synchronous implementations for these source-backed names; no second source-handler or runtime adapter is added.

The six approved migration improvements and their current disposition are:

1. Add native synchronous dispatch for the pure functions after existing argument evaluation and permission checks.
2. Avoid building joined text for `length` and `slice`, while coercing each required argument once and preserving source coercion order and early returns.
3. Use a one-pass literal replacement implementation, and preserve the source escaping behavior for `touser`.
4. Stream `user` filtering flags and filter the name in one pass. Cached boolean regex classifiers and the Unicode 17 L/M/N table additions are implementation details supporting source-compatible category checks, not separate approved improvements.
5. The ASCII casing experiment required at least 5% aggregate gain across the eight ASCII casing cases and no more than 5% regression on each of the eight representative Unicode casing cases. The valid ablation failed the Unicode guard, so this improvement was rejected and all private ASCII casing shortcut machinery was removed. The other five approved improvements remain in the final source.
6. Make `JsValue::get` compare UTF-16 keys without allocating a converted key string, preserving JavaScript property lookup for UTF-16 input.

The rejected fast-path ablation showed 28.572% geometric-mean time reduction across the eight ASCII cases, but `unicode-lower` regressed 50.907% and `unicode-tail-lower` regressed 8.414%; both exceed the per-case 5% limit. Results are from the valid distinct-binary experiment recorded in `/root/.local/state/rust-ast-pure-20261026-task-2qqga4oi/ablation-analysis.json`. That experiment cleaned the project between variants and verified distinct binaries and embedded source hashes. The first experiment reused identical Cargo binaries and is invalid; all its numbers are excluded. A prior generic debug probe also lacked established variant identity and is excluded. Neither excluded run contributes to the final-source benchmark below.

## Compatibility and fixture boundary

The frozen source-parity corpus contains 4,694 cases and 30 benchmark definitions. It covers source calls and actual evaluator paths, typed values, exact returned/thrown outcomes, context, and ordered host traces. The existing 3,563-case AST evaluator corpus and its 16 benchmark definitions remain byte-identical. The pure corpus exercises both pure and context registry flags independently and in combination without broadening context-builtin scope. It includes ordinary own-`toString` coercion cases, malformed UTF-16 through typed fixture transport, alias metadata, `random` draw ordering, argument evaluation before permission checks, and source-specific early returns.

Frozen fixture identities:

- Corpus file SHA-256: `aa23a7547c376e48b728bbc1cca8601dba2a4d824b15c2ac30e0a3ea7df7da44`.
- Structural manifest SHA-256 (cases and benchmark definitions): `6dbf7b09d25934af9364b995323ef871e7887350ad23d7d7934bdd81a036bda5`.
- Source-oracle SHA-256: `af715d7ef599a8db16d04e890fda086564f16fa6c1243a9396d848bfb109887d`.
- Shared prior oracle with its additive prepared-source bridge SHA-256: `81ea07d52b8249a6c28ec76be4d72d6113e86df9fee251fd3bdb65e9e3962655`.
- Prior corpus file SHA-256: `bd740c545bb9d220bab003130f4955dc58d9db1cce2832b45bc503fd0b569bf5`.

Fixture checks report deterministic generation, successful offline replay of all 4,694 source cases, two fresh-state calls for each workload, and unchanged replay of all 3,563 prior source facts and 16 workloads. Final native parity passed. The final frozen source contains 162 Rust-project files and 30 TypeScript source/test files; every artifact hash matches the current checkout, including `pure/casing.rs` SHA-256 `0f3b7a74e840d24ed07b1be05b697b5dbf40c872afe2a6e883119f4099033182`. No new pure-corpus exclusions were recorded. Benchmark definitions cover short/long ASCII, mixed Unicode, and ASCII-prefix/Unicode-tail inputs for all four casing functions; the final frozen requests and release runs are recorded in the accepted artifact below.

## Final verification and benchmark

The accepted artifact is [ast-pure-functions-2026-10-26.json](../dima-rust/benchmarks/ast-pure-functions-2026-10-26.json) (`acceptanceComplete: true`). Formatting, feature-profile checks, Clippy, and exact source checks passed. All 4,694 pure cases passed in two profiles. The prior evaluator corpus passed across three profiles with 3,554 supported cases plus the same nine named boundaries. The receipt records 339 passing test executions across invocations and profiles, not 339 unique tests; 28 local tests were added relative to baseline. Invocation counts are in the artifact. Four worker dependency graphs were identical and `Cargo.lock` was unchanged.

Three serial final release pairs compared the final generic-casing Rust source with the source oracle. Each row is the median of three per-process medians, each per-process median over seven batches of 50 operations after 20 warmups. Fresh context, host, and RNG setup is included; parsing, source loading, decoding, normalization, fingerprints, assertions, and serialization are outside timing. All 30 preflight and postflight observations and fingerprints matched exactly. Medians are microseconds per operation (`µs/op`); the ratio is TypeScript median divided by Rust median, so a ratio below 1 means Rust took longer. Rust had lower medians in 19 of 30 workloads and higher medians in 11. These prepared synthetic measurements do not establish production latency or throughput.

| Workload | TypeScript median (µs/op) | Rust median (µs/op) | TS/Rust |
| --- | ---: | ---: | ---: |
| `utf16-length-short` | 16.534 | 2.744 | 6.03× |
| `utf16-slice-short` | 22.834 | 3.191 | 7.16× |
| `utf16-length-long` | 8.689 | 24.298 | 0.36× |
| `utf16-slice-long` | 14.435 | 25.811 | 0.56× |
| `ascii-upper-short` | 6.134 | 2.428 | 2.53× |
| `ascii-upper-long` | 8.039 | 71.833 | 0.11× |
| `unicode-upper` | 11.548 | 10.477 | 1.10× |
| `unicode-tail-upper` | 43.250 | 71.270 | 0.61× |
| `ascii-lower-short` | 6.199 | 2.528 | 2.45× |
| `ascii-lower-long` | 7.626 | 55.742 | 0.14× |
| `unicode-lower` | 10.453 | 10.629 | 0.98× |
| `unicode-tail-lower` | 38.241 | 62.845 | 0.61× |
| `ascii-title-short` | 10.248 | 3.201 | 3.20× |
| `ascii-title-long` | 254.602 | 177.166 | 1.44× |
| `unicode-title` | 40.012 | 22.287 | 1.80× |
| `unicode-tail-title` | 275.370 | 176.419 | 1.56× |
| `ascii-capitalize-short` | 4.823 | 2.307 | 2.09× |
| `ascii-capitalize-long` | 4.996 | 40.962 | 0.12× |
| `unicode-capitalize` | 4.527 | 3.146 | 1.44× |
| `unicode-tail-capitalize` | 4.794 | 40.364 | 0.12× |
| `replace-hit` | 67.559 | 53.521 | 1.26× |
| `replace-nohit` | 16.214 | 49.352 | 0.33× |
| `replace-prefix-adversarial` | 24.957 | 65.785 | 0.38× |
| `touser-escaping` | 44.427 | 13.137 | 3.38× |
| `user-filters-ascii` | 163.148 | 38.423 | 4.25× |
| `user-filters-unicode` | 106.755 | 71.455 | 1.49× |
| `eventsub-normal` | 7.883 | 3.415 | 2.31× |
| `eventsub-fallback-wide` | 97.972 | 19.235 | 5.09× |
| `rng-default` | 6.819 | 3.291 | 2.07× |
| `rng-negative` | 7.326 | 3.782 | 1.94× |

## Acceptance and adoption limits

An initial native parity probe reported 159 mismatches (120 coercion and 39 context-representation cases); the corrected final source passed the complete pure corpus. The earlier 339 test executions were subsequently repeated as part of final-source quality verification, so the accepted total does apply to the final generic-casing source. R1 reported no actionable finding. Its literal-`for-of` residual concern came from testing literals rather than the source helper; the actual source oracle returned `TypeError: name is not iterable` for all five raw display probes. R2 also reported no actionable findings and confirmed the final source hashes. Its review note predates the final acceptance receipt; that receipt subsequently confirms the same 162-file freeze and casing hash.

The RED fix adds `ExecutionContext.argument_override: Option<JsValue>` and `user_display_name_override: Option<JsValue>`, both defaulting to `None`, plus `effective_argument()` and `effective_user_display_name()` accessors. An explicit `Some`, including `Null` or `Undefined`, wins over the legacy typed field. Accessors preserve raw value types and sharing without coercion; `None` follows the existing typed path. Snapshot construction, pure handlers, count fallback, and command-reference display use these accessors. The legacy count fallback intentionally retains its existing infallible coercer.

Cleanup completed: 49 compiler, cache, target, format-copy, and binary paths were removed; no task-owned containers or temporary images remain. All 19 original containers were unchanged, with zero additional containers. No service deployment was performed. The feature remains opt-in and has no live callers, API integration, worker registration, or user-facing availability. See the [Rust project guide](../dima-rust/README.md#opt-in-ast-pure-functions), [migration index](README.md), and [task-specific routing observation](../orchestrator-notes/2026-10-26-ast-pure-functions.md).

## Routing observation

This was bounded source-backed documentation work under the user's starting preference `GPT-6 Luna → MiniMax M3.1 Flash → DeepSeek V4.1 Flash → Grok 4.7 → GPT-6.1 Sol → GPT-6 Astra`. The baseline is retained. This single documentation task does not support a tier reorder or a model-capability claim. Native correctness and runtime measurements belong to the lead's separate verification record.
