//! Explicitly invoked worker ports; no automatic registration or startup.

#[cfg(feature = "mongo")]
#[path = "../utils/stream_activity.rs"]
pub mod stream_activity;

#[cfg(feature = "mongo")]
#[path = "../utils/raid_analytics.rs"]
pub mod raid_analytics;

#[cfg(all(feature = "mongo", feature = "redis"))]
#[path = "../utils/follow_defense_baseline.rs"]
pub mod follow_defense_baseline;

#[cfg(feature = "mongo")]
#[path = "../utils/roulette_completion.rs"]
pub mod roulette_completion;

#[cfg(all(feature = "mongo", feature = "redis"))]
#[path = "../utils/ai_usage_receipts.rs"]
pub mod ai_usage_receipts;

#[cfg(all(feature = "mongo", feature = "redis"))]
#[path = "../utils/raid_sessions.rs"]
pub mod raid_sessions;

#[cfg(all(feature = "mongo", feature = "unicode-collation"))]
#[path = "../utils/dashboard_insights.rs"]
pub mod dashboard_insights;

#[cfg(all(
    feature = "mongo",
    feature = "redis",
    feature = "http-client",
    feature = "unicode-collation"
))]
#[path = "../utils/dashboard_activity.rs"]
pub mod dashboard_activity;
