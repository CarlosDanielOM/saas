//! Native moderation rule evaluation.

#[cfg(feature = "moderation-emote-spam")]
pub mod emote_spam;

#[cfg(feature = "moderation-caps")]
pub mod caps;
#[cfg(feature = "moderation-caps")]
mod caps_unicode_data;
