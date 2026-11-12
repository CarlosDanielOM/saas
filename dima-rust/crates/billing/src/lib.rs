//! What a streamer has paid for: plan tiers and entitlements, credit packs, the free monthly
//! credit reset, where AI credits come from, how an AI usage event is described, and the client
//! for Polar, the billing provider. This is money: every decision follows the frozen TypeScript
//! reference (`dimabot/src` at `0c71108e`), checked by a corpus recorded from it.
//!
//! | Module | Reference |
//! |---|---|
//! | [`plans`] | `utils/billing.ts`, `utils/plan_cache_fence.ts`, `domain_events/polar_entitlements.ts`, the projections of `domain_events/polar_billing_events.ts` |
//! | [`credit_packs`] | `utils/credit_packs.ts` |
//! | [`free_credit_reset`] | `utils/free_credit_reset.ts` |
//! | [`credit_sources`] | `utils/ai_credit_sources.ts` |
//! | [`usage`] | `utils/ai_usage_event.ts`, `utils/ai_usage_classification.ts` |
//! | [`polar`] | `utils/polarsh.ts` and every Polar call of the files above |
//! | [`config`] | the `POLARSH_*` and `BILLING_*` variables (a binary fills it) |
//! | [`usage_ledger`] | `utils/ai_usage_ledger.ts`, `ai_usage_lock.ts`, `ai_usage_dashboard.ts`, `ai_usage_queries.ts`, `ai_credit_display.ts`, the read functions of `ai_usage_receipts.ts`, and the native receipts worker's ledger and dashboards |
//! | [`usage_receipts`] | `enqueueAiUsageReceipt` and the native receipts worker's queue handling |
//! | [`usage_queue`] | `claimUsageJob`, `completeUsageJob`, `failUsageJob` (`utils/ai_usage_queue_health.ts`), fenced |
//! | [`usage_backfill`] | `utils/ai_usage_backfill_queue.ts`, `ai_usage_backfill.ts`, the job handling of `workers/ai_usage_backfill.worker.ts` |
//! | [`usage_health`] | `monitorAiUsageQueues`; the flush's dead-letter report and the flush of quiet channels |
//!
//! The usage side (P2-BILLING-02a) plugs into the first half through [`polar::UsageSink`]
//! ([`usage_receipts::ReceiptSink`]) and [`plans::projection::PlanEffects`]
//! ([`usage_ledger::retention::UsageRetention`]); gifts, referrals, paid-order rewards and
//! account cancellation follow in P2-BILLING-02b.
//!
//! # Rules
//!
//! - **Numbers** are JavaScript numbers (`f64`) with the reference's `Math.round`, `Math.ceil`,
//!   `Math.max` ([`js`]); money values are never rounded or widened beyond what it does. JSON that
//!   leaves the crate is written with `dima_text::to_js_json` (`25000`, not `25000.0`); callers
//!   that serialise a type of this crate with serde must use that writer too.
//! - **Time** is epoch milliseconds from an injected [`dima_core::Clock`]. Every month and day
//!   boundary is UTC, as the reference computes it (`getUTCMonth`, `toISOString`); no other time
//!   zone is involved. Date text is read with `dima_text::parse_date` (ISO 8601 and HTTP dates).
//! - **Randomness** (usage entry ids, lock values) comes from an injected [`dima_core::Random`].
//! - **Text**: no limit of this crate counts user text; the grant source label keeps
//!   `slice(0, 96)`'s UTF-16 budget, cut on a character boundary ([`polar::grant_source`]); ids are
//!   compared as the reference compares them (`<` on plan versions in UTF-16 order, byte order
//!   inside Lua).
//! - **No environment reads, no globals.** Configuration is [`config::BillingConfig`]; stores and
//!   clients are passed in.
//!
//! # Dragonfly key families at cutover
//!
//! Rebuilt (cleared, refilled from Polar and MongoDB): `twitch:{id}:ai:credits`, the exhaustion
//! flags `twitch:{id}:ai:exhaust` and `{id}:ai:exhaust`, `twitch:{id}:ai:credits:plan-version`,
//! `twitch:{id}:ai:credits:polar-version`, `twitch:{id}:ai:credits:revision` (the generation and
//! the debits held against Polar's figures, [`plans::balance`]), `twitch:{id}:ai:usage-local:*`,
//! `billing:credit-packs:context:v1:*`, `locks:polar-ingest:{id}`, `locks:plan-effects:{owner}`
//! (one plan change's write and effects at a time, [`plans::projection`]). Drained (money):
//! `twitch:{id}:ai:polarshevent`, flushed by the TypeScript processes before they stop; its
//! Rust-only companions `twitch:{id}:ai:polarshevent:processing` and `…:dead` are new after
//! cutover (an operator reviews `…:dead`, which is never trimmed: [`polar::flush`]). The
//! exhaustion flags rebuild lazily (on the next credit read or usage), so the cutover step should
//! copy them or warm them for active channels.
//!
//! # Intended differences
//!
//! - One Polar provider for every call: its host follows `POLARSH_ENVIRONMENT`, or
//!   `POLARSH_API_BASE_URL` when that is one of Polar's own hosts over https; any other value is
//!   honoured only as a test-mode override ([`config`]).
//! - Redirect targets must be `https` (or `http` to a loopback host) without credentials, and
//!   configured fallbacks are checked at start-up ([`plans::checkout::is_safe_redirect`]).
//! - Redirects from Polar are errors (the reference's `polarRequest` followed them); calls with
//!   no timeout in the reference get `dima-http`'s 60 s.
//! - Polar error bodies are never kept (the reference put them in messages and logs; Polar echoes
//!   request fields, a customer's e-mail among them).
//! - A tier text that `Object.prototype` holds (`constructor`...) is `free`, where the reference
//!   computed `NaN` credits that never exhaust ([`plans::tier_of`]).
//! - An unset TTS `characters` is left out of the ingest metadata instead of being sent as
//!   `undefined`, which the SDK refuses in immediate mode ([`polar::accounting_metadata`]).
//! - Immediate ingest does not read Dragonfly before sending (the reference failed the whole call
//!   when Dragonfly was down at its start).
//! - The usage queue is flushed in bounded batches under a fenced lease, acknowledged by the
//!   items claimed; an event Polar refuses for good moves to a dead-letter list instead of
//!   blocking its channel ([`polar::flush`]).
//! - A balance published from Polar has every local debit its figure may not cover yet held
//!   against it, so spent credit never comes back; a balance whose revision was lost is read
//!   again from Polar ([`plans::balance`]).
//! - A grant's identity is the caller's operation id ([`polar::OperationId`]), never drawn per
//!   call; a write whose outcome is unknown is reported as such ([`polar::IngestOutcome`]).
//! - Lists are read to the end within a bound ([`polar::MAX_LIST_PAGES`]).
//! - A product whose `name` is truthy but not text is malformed ([`credit_packs`]).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod config;
pub mod credit_packs;
pub mod credit_sources;
pub mod free_credit_reset;
pub mod gifts;
pub mod js;
pub mod mongo_ops;
pub mod plans;
pub mod polar;
pub mod products;
pub mod referrals;
pub mod usage;
pub mod usage_backfill;
pub mod usage_health;
pub mod usage_ledger;
pub mod usage_queue;
pub mod usage_receipts;

/// Where this crate reports what the reference logs and swallows (a failed best-effort write,
/// a provider fallback). The binary wires it to telemetry. Messages never hold a token, an
/// e-mail or a customer id.
pub trait Observer: Send + Sync {
    /// An error the operation recovered from, with the reference's function name.
    fn error(&self, operation: &'static str, message: &str);
}

/// An observer that drops everything.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopObserver;

impl Observer for NoopObserver {
    fn error(&self, _operation: &'static str, _message: &str) {}
}
