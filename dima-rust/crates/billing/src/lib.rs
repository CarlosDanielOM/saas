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
//!
//! The second half (usage ledger and receipts, gifts, referrals, paid-order rewards, account
//! cancellation) builds on this one through [`polar::UsageSink`] (receipts),
//! [`plans::projection::PlanEffects`] (usage retention) and [`polar::PolarClient`].
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
//! `twitch:{id}:ai:credits:polar-version`, `twitch:{id}:ai:usage-local:*`,
//! `billing:credit-packs:context:v1:*`, `locks:polar-ingest:{id}`. Drained (money):
//! `twitch:{id}:ai:polarshevent`, flushed by the TypeScript processes before they stop. The
//! exhaustion flags rebuild lazily (on the next credit read or usage), so the cutover step should
//! copy them or warm them for active channels.
//!
//! # Intended differences
//!
//! - One Polar provider for every call: its host follows `POLARSH_ENVIRONMENT`;
//!   `POLARSH_API_BASE_URL` is honoured only as a test-mode override ([`config`]).
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
//! - A product whose `name` is truthy but not text is malformed ([`credit_packs`]).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod config;
pub mod credit_packs;
pub mod credit_sources;
pub mod free_credit_reset;
pub mod js;
pub mod plans;
pub mod polar;
pub mod products;
pub mod usage;

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
