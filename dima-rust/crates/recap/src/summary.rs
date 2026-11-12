//! Stream summaries: the context text of a finished stream and the decision whether and what to
//! summarise. Package **P4-RECAP-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/memory/stream_summary_context.ts` (519 lines): `buildStreamSummaryContext`
//! - `utils/ai/memory/stream_summary_decider.ts` (597 lines): `generateStreamSummaryDecision`
