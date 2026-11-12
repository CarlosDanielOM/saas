//! The bot runtime metrics and product events, re-exported from `dima-actions`, where they live
//! because the cron and the API load them too (lead's decision at the P4-SKEL merge):
//! [`dima_actions::metrics`] (`bot_runtime_metrics.ts`) and [`product_events`]
//! (`posthog_events.ts`). Kept so the bot's modules can name them from their own crate.

pub use dima_actions::metrics::*;
pub use dima_actions::product_events;
