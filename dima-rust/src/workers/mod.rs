//! Explicitly invoked worker ports; no automatic registration or startup.

#[cfg(feature = "mongo")]
pub mod stream_activity;

#[cfg(feature = "mongo")]
pub mod raid_analytics;

#[cfg(all(feature = "mongo", feature = "redis"))]
pub mod follow_defense_baseline;

#[cfg(feature = "mongo")]
pub mod roulette_completion;

#[cfg(all(feature = "mongo", feature = "redis"))]
pub mod ai_usage_receipts;

#[cfg(all(feature = "mongo", feature = "redis"))]
pub mod raid_sessions;

#[cfg(all(feature = "mongo", feature = "unicode-collation"))]
pub mod dashboard_insights;

#[cfg(all(
    feature = "mongo",
    feature = "redis",
    feature = "http-client",
    feature = "unicode-collation"
))]
pub mod dashboard_activity;
