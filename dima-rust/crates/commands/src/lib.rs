//! Who may run a chat command and when.
//!
//! - [`permissions`]: role tags, user identities, tag permission expressions, the command and
//!   moderation-exemption gates, channel-admin permission lists, and the role cache.
//! - [`keywords`]: keyword validation, normalisation and matching, and the keyword index cache.
//! - [`patterns`]: streamer-written moderation patterns (RE2 syntax) on the `regex` crate.
//! - [`cooldown`]: plan minimums, cooldown gates, and the serialized zero-cooldown write.
//! - [`timer_policy`]: timer interval rules per plan.
//!
//! Everything here is pure logic. Reads and writes of a store go through a small trait defined
//! next to the logic that needs it ([`permissions::RoleCache`], [`keywords::KeywordStorage`],
//! [`keywords::KeywordLoader`], [`cooldown::CooldownStore`]); the MongoDB and Dragonfly
//! implementations belong to the packages that call them.
//!
//! These functions run on every chat message. What a caller should build once and keep is said
//! on each type: a [`permissions::CompiledPermission`] per command configuration, a
//! [`keywords::KeywordIndex`] per channel (the [`keywords::KeywordIndexCache`] does this), and a
//! [`patterns::CompiledPattern`] per moderation pattern.
//!
//! Text follows `dima-rust/MIGRATION.md` section 4. Lengths that are this system's own limits
//! count characters; match offsets leave the crate in UTF-16 units through one named converter,
//! [`patterns::PatternMatch::utf16_range`]. The differences from the reference that this
//! causes are listed in the module that causes them.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod cooldown;
pub mod keywords;
pub mod patterns;
pub mod permissions;
pub mod timer_policy;
pub mod value;
