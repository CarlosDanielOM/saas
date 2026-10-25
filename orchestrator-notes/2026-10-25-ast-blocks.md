# 2026-10-25 AST blocks routing and rework

## Task and routing

Pure Rust library implementation and source-oracle integration for the
TypeScript command-block boundary. Scope excluded caller/API/UI/runtime
integration, deployment, and production effects. The routing used GPT-6.1 Sol
at xhigh for core implementation, Sol at high for integration and
read-only/review work, DeepSeek V4.1 Flash at high via OpenCode for the
source-backed oracle, and GPT-6 Luna at high for documentation. This is a
task-specific record; the user-provided ascending model tier remains
unchanged.

## Concrete corrections and rework

- Core counters were changed to `usize`; three Clippy corrections were made
  during implementation.
- Initial assumptions about the 6,000-backslash raw case and 1,100 ternary
  cases were corrected against source and actual test cases. Rust fixture
  expectations were not fitted to observed Rust results. Duplicate and invalid
  stored-case classifications in the oracle were corrected before
  verification.
- Review found three edge cases, then a further root-template depth case. The
  final import plan applies node/depth eligibility only after root-context
  normalization, so a transient template wrapper does not consume a final
  block depth. Ordinary untrusted block input still validates before
  normalization; syntax nesting and parser-node caps remain separate.
- The implementation added root-context output expansion fallback, source
  attribution for a backslash-derived literal before a neighboring function,
  final-depth handling for a transient quoted leaf, and actual-child
  provenance for merged output overflow with astral UTF-16 text. These
  scenarios are present in source regressions and passed in final capped
  verification, including the root-template depth regression that was
  confirmed red before its correction and green afterward.
- An integration fixture initially encoded one backslash where the source
  case required two; the fixture was corrected. The lead also corrected a
  cross-realm JavaScript array `deepStrictEqual` issue by converting the value
  with `Array.from` outside the timed region.

## Evidence and limits

The source inventory, final oracle identity, verification results, full paired
medians, and benchmark limitations are recorded in the [AST blocks migration
note](../migration-notes/ast-blocks.md) and [tracked benchmark
artifact](../dima-rust/benchmarks/ast-blocks-2026-10-25.json). Capped quality
and benchmark receipts succeeded. Across repeated profiles there were 163
test executions, not 163 unique tests; the same 467-case oracle passed in both
profiles. The release benchmark found lower Rust medians for 19 of 21
operations, but it is a synthetic shared-host comparison, does not establish
production latency, and does not isolate the lazy writer allocation change.
No deployment or caller integration occurred.

This outcome supports the task-specific routes used here: Sol xhigh for the
core implementation, Sol high for integration/review, DeepSeek V4.1 Flash
high via OpenCode for the source oracle, and Luna high for final source-backed
documentation. Rework was material and resolved before acceptance; the
regressions and their corrections are listed above. One task does not support
a broad model ranking, model latency/cost comparison, or tier reorder. No
agent completion-time or cost comparison was measured. The Rust/TypeScript
benchmark measures generated-code runtime and cannot be attributed to the
models. The user-provided ascending tier remains unchanged.
