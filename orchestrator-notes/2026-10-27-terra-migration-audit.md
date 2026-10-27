# Terra migration audit — 2026-10-27

Three GPT-6.1 Terra high-reasoning agents independently reviewed non-overlapping sets of 12, 13 and 16 TypeScript/Rust pairs, covering 41 unique pairs. A fourth Terra high agent challenged the previous 11 fully complete ratings. GPT-6.1 Sol led reconciliation. The user specifically preferred Terra for this bounded audit after earlier completeness audits overstated results.

The challenge identified missing standalone raw AST conversion, source-writing and canonical-shape string operations, and an undocumented `iat` verification restriction. Lead reconciliation corrected proposed false blockers involving OpenTelemetry bootstrap, upstream callers of pure utilities and arbitrary future block versions. The [resulting source audit](../migration-notes/rust-migration-completeness.md) records the evidence, two isolated Node counterexamples, dependencies and limits.

This is one audit, not a controlled model comparison. Confidence in any broader routing conclusion is low; it establishes no throughput, cost or general capability ranking. Work stayed within the authorized repository scope; production was untouched and no push occurred.
