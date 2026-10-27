# AST syntax core (Rust)

## Scope and status

`dima_rust::utils::ast_syntax` is a pure Rust syntax layer behind the existing TypeScript AST parser, gated by the independent opt-in Cargo feature `ast-syntax`. It covers whole-program parsing, chat-template scanning and compilation, diagnostics, and serialization of the existing AST shape. TypeScript remains unchanged and has no callers wired to this module. There is no evaluation, `ast_blocks` conversion, function implementation or registration, runtime context, IO, live cache, worker integration, or deployment.

The persisted timer contract remains `AstTimerJob` version 1 with the existing JSON fields `version`, `id`, `dueAt`, `expiresAt`, `body`, and `context`; `body` is the `RootNode` AST. Optional AST fields stay omitted when absent. Parser spans and diagnostics are separate metadata and never enter `body`. This port does not change the timer payload version or runtime.

The source/API/scope contract is documented below. Final source verification passed against the frozen source receipts and tracked benchmark artifact. No runtime caller or deployment is included.

## Source mapping and reuse

The existing TypeScript behavior is defined by these source modules:

- [`tokenizer.ts`](../dimabot/src/utils/ast_parser/tokenizer.ts): operators, literals, strings, arrays, escaping, and delimiters.
- [`registry.ts`](../dimabot/src/utils/ast_parser/registry.ts): syntax handlers, AST construction, variable names, templates, and nested syntax.
- [`parser.ts`](../dimabot/src/utils/ast_parser/parser.ts): whole-program AST parsing.
- [`types.ts`](../dimabot/src/utils/ast_parser/types.ts): serialized node and accessor shapes.
- [`render.ts`](../dimabot/src/utils/ast_parser/render.ts): text/expression segmentation and final rendered-text escape passes.
- [`ast_timer_runtime.ts`](../dimabot/src/utils/ast_timer_runtime.ts): version 1 timer persistence and later evaluation in the bot.

These are behavioral and data-shape references only. `ast_blocks`, evaluation and handlers, function registration, runtime/caller wiring, and the existing TypeScript parser path remain outside this change.

## Approved source/API contract

The approved design has nine items. Items 4 and 5 cover the intentional syntax corrections; their five AC fixture categories are subcases of those two approvals, not additional approvals. Resource bounds and safe handling of source exceptions also limit compatibility. Items 6–9 optimize the approved behavior.

1. A pure reusable syntax core with no evaluator, runtime, caller, cache, or IO dependency.
2. Structured diagnostic codes and half-open UTF-16 source spans, including absolute spans for compiled-template segments and expression diagnostics.
3. Bounded source, token, node, and nesting work: defaults are 10,000 UTF-16 units, 20,000 tokens, 4,000 nodes, and nesting 128; configured nesting is clamped to the hard ceiling of 128.
4. Improved template scanning handles intra-word apostrophes as text, tracks array bracket depth inside expressions, keeps escaped array closers in their item, and shares quote handling with array indexing for nested interpolation quotes.
5. Improved nested parsing propagates tokenizer failures and rejects unconsumed tokens in interpolation expressions and array items with diagnostics.
6. Immutable compile-once plans are reusable only for the exact source and matching grammar identity, profile, and effective limits.
7. Nested arrays use shared indexing/token arenas rather than repeated tokenization; plan work statistics are aggregate, and scanner and lexer indexing passes are counted separately.
8. Tokens and parser ranges refer to owned source text rather than copied token strings.
9. Prepared immutable grammar dispatch and fast literal scanning use built-in syntax-handler kinds. Aliases can introduce built-in handlers; this is not arbitrary callback, evaluator, or function registration. Grammar preparation rejects aliases colliding with reserved `%[` syntax using `INVALID_GRAMMAR`. The scanner uses direct first-byte buckets and plain-byte chunk scanning.

### Profiles and source quirks

`SyntaxEngine::default()` uses `SyntaxProfile::Improved`; `SyntaxEngine::typescript_compatible()` uses `SyntaxProfile::TypeScriptCompatible`. The compatibility profile preserves the source's permissive nested-parse behavior, legacy error-literal channel, and scanner quote/array policies, subject to the Rust resource limits. For example, legacy scanning treats the apostrophe in `don't` as opening a quoted region, and legacy array scanning does not treat an escaped `]` as array text. Improved mode treats that apostrophe as ordinary intra-word text, recognizes array context while scanning expressions, aligns array item boundaries with escapes, and shares nested-quote handling between expression scanning and array indexing. Improved nested parsing reports inner errors and trailing interpolation/array-item tokens rather than accepting truncated results. Exact parity is not claimed for these approved differences.

The two public grammars serve different jobs. `parse` consumes a whole program according to the parser/tokenizer grammar; ordinary words are parsed as program tokens/nodes. `scan_template` preserves ordinary chat text byte-for-byte and extracts expression and unclosed segments. `compile_template` scans that chat grammar and compiles each expression segment. A malformed expression is kept with its diagnostic in source order; only a source/token/node/nesting resource-limit failure aborts the complete plan.

### Public API

- `SyntaxEngine::{default,typescript_compatible,new,with_limits,grammar,parse,scan_template,compile_template}` selects grammar, profile, and limits and parses source.
- `CompiledProgram::{root,to_value,source,stats}` exposes the AST, source slice, and local parse work counts.
- `CompiledTemplate::{source,segments,stats,matches_source,is_compatible_with}` exposes immutable segment plans. `SegmentPlan::{source_segment,program,diagnostic}` retains each expression result or diagnostic; unclosed segments retain their source and diagnostic.
- `SourceSegment` serializes as text `{kind:"text",text,span}`, expression `{kind:"expr",source,span}`, or unclosed `{kind:"unclosed",source,span}`. `SourceSpan` is a half-open UTF-16 range and is not part of AST JSON.
- `Diagnostic` contains a typed serializable code, message, and source span. `unescape_literal` and `unescape_rendered_text` provide the source's ordered unescape passes.
- `PreparedGrammar::default()` and `GrammarBuilder::default().register(start,end,handler).build()` prepare immutable grammar. `SyntaxHandler` is a built-in handler kind; the prepared identity includes the full definitions and core version.

Template substitutions such as `&pN` and `&t` must be expanded before matching or compiling a plan. Reuse is limited to an exact-source match with identical grammar identity, profile, and limits. The syntax core has no context, values, output cache, or result cache.

### Aggregate and persisted-JSON limits

The four parser budgets are aggregate across nested arrays, interpolations, and every expression in one compiled chat template. Nesting is clamped to 128. Resource-limit diagnostics abort the plan; ordinary syntax errors remain ordered per-segment results.

Persisted JSON has a separate strict boundary: AST JSON container nesting must stay below 128 (maximum depth 127) so it fits the standard `serde_json::from_str` reader. This boundary is distinct from parser nesting. Sixty-two nested array expressions fit at JSON depth 127; 63 nested arrays are rejected by the AST JSON guard. No source span is persisted.

## Source-oracle classification

The TypeScript oracle result is retained raw and is never rewritten. The final corpus contains 1,200 cases (hash `3fdfdbf906c2da81420757aa075811c0b41b50b789773b0434a5edd3364914c2`): 1,137 source-parity cases, 59 cases implementing the approved corrections, and four hardened source-throw cases. Its operations are 945 parse, 144 scan, 39 compiled-template, and 72 unescape cases. The five AC categories below are explicitly grouped under approved items 4 and 5:

| AC category | Approved item | Behavior |
|---|---:|---|
| AC-1 | 4 | Intra-word apostrophes stay text; interpolation quotes do not end the enclosing template quote. |
| AC-2 | 5 | Nested tokenizer failures propagate instead of becoming truncated nodes/text. |
| AC-3 | 5 | Unconsumed interpolation tokens produce `UNEXPECTED_TOKEN`. |
| AC-4 | 5 | Unconsumed array-item tokens produce `UNEXPECTED_TOKEN`. |
| AC-5 | 4 | Array bracket depth is honored while scanning an expression. |

The raw TypeScript source values remain exact facts; normalized API expectations and approved Rust improvements are classified separately. The four source-throw hardening cases are not labeled as source parity or as additional user approvals.

## Final source verification

Final validation covers reserved-prefix rejection, shared nested-quote handling, four added quote-oracle cases, and targeted grammar regressions. The generator checks the corpus against five hashed TypeScript sources without loading runtime services.

The frozen-source quality run passed 28 library tests (27 AST syntax and one JavaScript-compatibility test), 10 AST integration tests, and two doc tests. The combined profile passed 59 library and 10 AST integration test executions; the no-feature profile ran zero tests. Across profiles this is 109 test executions, including repeated tests, not 109 unique tests. Both JavaScript scripts passed `node --check`, and the corpus generator passed `--check`. The four worker dependency graphs (`mongo`, `mongo-redis`, `dashboard`, and `supervisor`) matched the baseline after path normalization; `Cargo.lock` was unchanged. Receipts are in `/root/.local/state/rust-ast-syntax-20261025-w_dpigi0/artifacts/`.

Tests ran unoptimized with debug info and incremental compilation disabled, in a compiler capped at 3 CPUs, 4 GiB memory with no swap, 256 PIDs, two Cargo jobs, and an 8 GiB private cache. Quality, benchmark, and cleanup receipts passed. Task-owned compiler containers and Cargo/target/format-copy directories have been removed; snapshots, logs, and receipts are retained. There are no live callers and no deployment was performed for this AST task. The earlier comparison found all 19 production containers unchanged before a separate API release. After that, `/dima-server` was replaced at `2026-10-25T21:20:40.943485895Z` by `saas-ops` run `api-042333322404`, as confirmed by Docker labels; this API release was unrelated to AST. The other 18 original containers, including bot and cron, retained IDs, images, start/restart counts, mounts, and Compose ownership.

## Compilation microbenchmark

The tracked artifact [`ast-syntax-2026-10-25.json`](../dimabot/benchmarks/ast-syntax-2026-10-25.json) records exact Rust and TypeScript source hashes, semantic checksums, all three paired raw runs, requests, medians, dependency graph hashes, test counts, and caps. The benchmark compiled syntax and included AST construction/destruction and runtime GC, but did not run evaluation or time JSON serialization/checksums. It used identical inputs, 100 warmups, 500 iterations, seven batches, and three serial rounds in fixed Rust-then-TypeScript order. Reported values are medians of 21 batch per-operation means. Plan-reuse traversal was disabled.

| Input | Rust median (µs/op) | TypeScript median (µs/op) | TypeScript / Rust |
|---|---:|---:|---:|
| `short-hi` | 1.63 | 6.74 | 4.13× |
| `mixed` | 12.57 | 24.83 | 1.98× |
| `loop` | 10.35 | 24.32 | 2.35× |
| `plain8000` | 66.37 | 275.17 | 4.15× |
| `dense100` | 215.51 | 186.62 | 0.87× |
| `dense500` | 865.33 | 948.26 | 1.10× |
| `nested-arrays-8` | 4.87 | 26.57 | 5.46× |
| `nested-arrays-16` | 8.81 | 57.12 | 6.48× |
| `nested-arrays-32` | 21.14 | 170.31 | 8.06× |
| `nested-compute-32` | 8.53 | 16.78 | 1.97× |
| `nested-compute-64` | 15.60 | 28.18 | 1.81× |

Ten of eleven measured medians are lower for Rust; `dense100` is about 15% slower in Rust. These are local synthetic microbenchmarks on a shared production host, with fixed runner order, different allocators/GC, and identical semantic checks. They do not show evaluation speed, production end-to-end latency, or how much any individual optimization contributes. Of 14 input definitions, 11 were measured; array depths 64 and 128 and compute depth 128 were guarded and excluded identically from both runners.

The persistence guard's 128-container ceiling guarantees only a standalone AST fits standard `serde_json::from_str`: 62 nested array expressions yield JSON depth 127; 63 are rejected. A future timer or caller envelope adds its own nesting and needs an aggregate budget when that reader is ported; this change does not port the timer reader. No production caller adoption or deployment is in scope.
