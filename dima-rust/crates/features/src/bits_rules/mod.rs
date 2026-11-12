//! Bits rules: parsing, matching a cheer to a rule, the chat text, and their storage. Package
//! **P4-FEAT-GAMES**.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `bits_rules/model.ts` (97 lines) → [`model`]: `BitsRuleError` ([`BitsRuleError`]),
//!   `MAX_BITS_AMOUNT`, `MAX_BITS_RULES`, `MAX_RULE_MESSAGE`, `MAX_RULE_NAME`, `bitsChatMessage`
//!   ([`bits_chat_message`]), `matchBitsRule` ([`match_bits_rule`], [`match_bits_value`]),
//!   `parseRule` ([`parse_rule`]), `rulesFromLegacyTiers` ([`rules_from_legacy_tiers`]),
//!   `validRuleId` ([`valid_rule_id`]).
//! - `bits_rules/store.ts` (48 lines) → [`store`]: `changeBitsRules`, `findBitsEventsub`,
//!   `loadBitsRules` ([`BitsRulesStore`]).
//!
//! Callers (later packages): the bits rules route (P4-API-CHANNEL: load, change with
//! [`parse_rule`], [`valid_rule_id`]); the cheer handler and the chat announcement consumer
//! (P4-CHAT-EVENTS, P4-EVH: [`BitsRulesStore::load_bits_rules`] with [`LegacyTiers::Given`],
//! then [`bits_chat_message`]); Overlay Studio's live loop (P4-RT-OVERLAY-LIVE:
//! [`match_bits_value`] on `raw.bits`); the site assistant (P4-SA-WRITE-B, P4-SA-TOOLS).
//!
//! # Bounds on what a streamer supplies
//!
//! All the reference's own (`model.ts`): at most [`MAX_BITS_RULES`] rules (the route checks it
//! before adding), names up to [`MAX_RULE_NAME`] characters, messages up to
//! [`MAX_RULE_MESSAGE`], amounts whole numbers from 1 to [`MAX_BITS_AMOUNT`], rule ids
//! `^[a-zA-Z0-9_-]{1,64}$`, only the six known fields. Lengths count characters, not UTF-16
//! units (`MIGRATION.md` section 4, first row): an emoji counts 1.
//!
//! # Differences from the reference, on purpose
//!
//! - A stored rule that does not have the shape every reference writer stores is skipped by
//!   matching (with the rest of the list still used) and makes a change fail with
//!   [`BitsRulesError::Malformed`] instead of being rewritten. The reference would read it as
//!   whatever JavaScript makes of it. The local copy's two channels hold only well-formed rules.
//! - Every store call has a deadline ([`BitsRulesConfig`]).
//! - Lengths and cuts count characters: a legacy tier's message is cut at 1000 characters and
//!   its name at 60, where the reference cut UTF-16 units (600 emoji stay 600, not 500).

pub mod model;
pub mod store;

pub use model::{
    BitsChat, BitsChatMode, BitsRule, BitsRuleError, MAX_BITS_AMOUNT, MAX_BITS_RULES,
    MAX_RULE_MESSAGE, MAX_RULE_NAME, bits_chat_message, match_bits_rule, match_bits_value,
    parse_rule, rules_from_legacy_tiers, valid_rule_id,
};
pub use store::{BitsRulesConfig, BitsRulesError, BitsRulesState, BitsRulesStore, LegacyTiers};
