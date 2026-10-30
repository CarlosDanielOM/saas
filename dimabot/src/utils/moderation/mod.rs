//! Native moderation rule evaluation.

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
