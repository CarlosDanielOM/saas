//! Explicitly invoked worker ports; no automatic registration or startup.

#[cfg(feature = "mongo")]
pub mod stream_activity;

#[cfg(feature = "mongo")]
pub mod raid_analytics;

#[cfg(all(feature = "mongo", feature = "redis"))]
pub mod follow_defense_baseline;

#[cfg(feature = "mongo")]
pub mod roulette_completion;
