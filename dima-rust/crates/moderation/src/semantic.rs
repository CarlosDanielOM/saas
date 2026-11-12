//! Model-driven review: semantic decisions with their claims and maintenance, and the variation
//! jobs, including the cron loop (250 ms, up to four reviews at once, maintenance and one variation
//! job every second). Package **P4-MOD-RUN** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/moderation/semantic.ts` (125 lines)
//! - `utils/moderation/semantic_worker.ts` (85 lines)
//! - `utils/moderation/variation_jobs.ts` (103 lines): `VariationError`, `requestVariationJob`,
//!   `resolveVariations`, `variationJobView`
//! - `workers/semantic_moderation.worker.ts` (41 lines)
//!
//! The loop is a library function the cron binary supervises (plan section 5.4); `dima-cron`
//! registers it.
