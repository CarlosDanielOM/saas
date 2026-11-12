//! Bits rules: parsing, matching a cheer to a rule, the chat text, and their storage on the
//! EventSub configuration. Package **P4-FEAT-GAMES** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `bits_rules/model.ts` (97 lines): `BitsRuleError`, `MAX_BITS_AMOUNT`, `MAX_BITS_RULES`,
//!   `MAX_RULE_MESSAGE`, `MAX_RULE_NAME`, `bitsChatMessage`, `matchBitsRule`, `parseRule`,
//!   `rulesFromLegacyTiers`, `validRuleId`
//! - `bits_rules/store.ts` (48 lines): `changeBitsRules`, `findBitsEventsub`, `loadBitsRules`
