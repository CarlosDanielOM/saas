//! What a streamer has paid for: plan tiers and entitlements, credit packs, the free monthly
//! credit reset, where AI credits come from, how an AI usage event is described, and the client
//! for Polar, the billing provider.
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
