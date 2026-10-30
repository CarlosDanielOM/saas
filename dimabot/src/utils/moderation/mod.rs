//! Native moderation rule evaluation.

#[cfg(feature = "moderation-types")]
pub mod types;

#[cfg(feature = "moderation-advanced")]
pub mod advanced;

#[cfg(feature = "moderation-advanced-policy")]
pub mod advanced_policy;

#[cfg(feature = "moderation-variations")]
pub mod variations;

#[cfg(feature = "moderation-variations-provider")]
pub mod variations_provider;

#[cfg(feature = "moderation-variation-jobs")]
pub mod variation_jobs;

#[cfg(feature = "moderation-emote-spam")]
pub mod emote_spam;

#[cfg(feature = "moderation-caps")]
pub mod caps;

#[cfg(feature = "moderation-links")]
pub mod links_rule;
#[cfg(feature = "moderation-normalize")]
pub mod normalize;

#[cfg(feature = "moderation-spam-categories")]
pub mod spam_categories;

#[cfg(feature = "moderation-spam")]
pub mod spam;

#[cfg(feature = "moderation-semantic")]
pub mod semantic;

#[cfg(feature = "moderation-semantic-worker")]
pub mod semantic_worker;

#[cfg(feature = "moderation-decisions")]
pub mod decisions;

#[cfg(feature = "moderation-permit")]
pub mod permit;

#[cfg(feature = "moderation-offenses")]
pub mod offenses;

#[cfg(feature = "moderation-seed-plan")]
pub mod seed_plan;

#[cfg(feature = "moderation-blacklist")]
pub mod blacklist;

#[cfg(feature = "moderation-rules")]
pub mod rule_dispatcher;
