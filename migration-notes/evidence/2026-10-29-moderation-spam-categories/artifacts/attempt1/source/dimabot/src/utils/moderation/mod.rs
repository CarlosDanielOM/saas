//! Native moderation rule evaluation.

#[cfg(feature = "moderation-emote-spam")]
pub mod emote_spam;

#[cfg(feature = "moderation-caps")]
pub mod caps;
#[cfg(feature = "moderation-caps")]
mod caps_unicode_data;

#[cfg(feature = "moderation-links")]
pub mod links_rule;
#[cfg(feature = "moderation-normalize")]
pub mod normalize;

#[cfg(feature = "moderation-spam-categories")]
pub mod spam_categories;
