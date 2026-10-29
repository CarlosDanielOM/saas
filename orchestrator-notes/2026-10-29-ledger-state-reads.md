# Ledger-state read slice routing record — 2026-10-29

## Verified outcome

The earlier GPT-6.1 Terra high pass produced a static source-trace/author handoff only; it did not implement or validate the feature. GPT-6.1 Sol at xhigh then implemented the three-export read module, source oracle and focused tests. The parent corrected the BSON test API usage and two test-only Clippy style issues, then completed strict, source-oracle, private-Mongo runtime and final hash checks. The verified source tree is bound to commit `ba91a15b8041a894ecf1d017ec5708af8ba0e66e`; receipts are in [the evidence package](../migration-notes/evidence/2026-10-29-ai-usage-ledger-reads/README.md).

This is evidence for routing on this bounded task only. The final result followed parent integration and corrections; it does not establish a general model ranking, attribute runtime gains to the coding model, or support a broad routing reorder. No benchmark or performance claim was made for the read adapter.

## Related slices

The combined history/transaction query work was routed to GPT-6.1 Sol xhigh. Retention was first attempted at GPT-6.1 Terra high, which produced an incomplete draft, then completed at Terra xhigh. Both slices have passed parent-owned isolated source/native checks, and the targeted query release-profile ordinary/replay gate has also passed. Combined evidence packaging and source readback are complete. The bounded outcomes and their limits are recorded below.

## Related slice outcomes — 2026-10-29

The combined history/transaction query slice (GPT-6.1 Sol xhigh) and retention slice (GPT-6.1 Terra xhigh after an incomplete Terra high draft) passed parent-owned isolated source/native verification. This is a bounded routing observation, not a model ranking: query work required a source-verified NaN sign-bit correction followed by targeted release-profile replay; retention completed its source oracle and private-Mongo behavior checks at xhigh. Parent integration and readback remain distinct from authoring. No performance benchmark or model-attributed runtime-gain claim applies.

Evidence: [query note](../migration-notes/ai-usage-ledger-queries-2026-10-29.md), [retention note](../migration-notes/ai-usage-retention-2026-10-29.md), [query handoff](../migration-notes/ai-usage-ledger-queries-handoff.md), and [retention handoff](../migration-notes/ai-usage-retention-handoff.md). The related eight code/wiring/test/oracle files were committed as `4896f1187db57e9c551214c2e51524096dd9c33a`. Query release-profile run `compiler-1793284759267735157` passed eight ordinary tests and all 333 source scenarios. Final pinned Node checks passed both oracles (`node-1793285417559374117`), and parent readback found all 19 production records unchanged. Evidence packaging/source readback is complete at `migration-notes/evidence/2026-10-29-ai-ledger-queries-retention/`. Retention source replay and private Mongo checks passed. No source retirement, caller adoption, deployment, or push is represented by these notes.
