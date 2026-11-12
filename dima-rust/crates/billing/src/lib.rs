//! What a streamer has paid for: plan tiers and entitlements, credit packs, the free monthly
//! credit reset, where AI credits come from, how an AI usage event is described, and the client
//! for Polar, the billing provider.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod config;
pub mod credit_packs;
pub mod free_credit_reset;
pub mod js;
pub mod polar;
pub mod products;
pub mod usage;
