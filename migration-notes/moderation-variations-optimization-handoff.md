# Moderation variations optimization handoff

The UTF-8 normalization and typed-cache refinements were checked as part of the final source-bound run and three-round matched benchmark. Full receipts and input/output bindings are retained in [the evidence package](evidence/2026-10-30-moderation-variations/index.json); benchmark interpretation and compatibility limits are in [the migration note](moderation-variations.md).

The term path preserves source ordering: pinned NFC, ECMAScript trim/collapse, then pinned lowercase. Valid UTF-8 uses a UTF-8 buffer; ASCII lowercases directly, non-ASCII uses the shared pinned helper, and ill-formed UTF-16 uses the existing path. Focused cases include mixed whitespace, Final Sigma, and unpaired surrogates.

The typed cache uses four maps selected by spacing/symbol flags for borrowed lookups. One insertion-order queue preserves the global FIFO capacity of 1,000, with no hit refresh, synchronized compilation, shared clone entries, and Arc result identity. Failed compilation does not insert or evict. Pattern combination reuses cached results and writes into one combined UTF-16 buffer. The value cache remains an independent 1,000-entry cache and its source-object identity is covered. No benchmark-specific memoization was added.

All 210 benchmark actors across three rounds completed and matched independently checked outputs. Final medians are mixed by workload; term and build ranges overlap. The first round and middle term regression remain in the evidence. This synthetic benchmark supports no production latency or statistical-significance claim.
