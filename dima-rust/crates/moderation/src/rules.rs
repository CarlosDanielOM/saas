//! Chat moderation rules: settings defaults, text folding, the blacklist, caps, emote-spam and link
//! rules, spam categories and their semantic policy, permits, offense steps, decisions and pattern
//! variations. Package **P4-MOD-RULES** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/moderation/decisions.ts` (33 lines): `awaitSemanticDecision`,
//!   `createModerationDecision`
//! - `utils/moderation/defaults.ts` (81 lines): `seedDefaultModerationSettings`
//! - `utils/moderation/normalize.ts` (13 lines): `foldText`
//! - `utils/moderation/offenses.ts` (39 lines): `recordOffense`, `resolveOffenseStep`
//! - `utils/moderation/permit.ts` (89 lines): `PERMIT_USAGE`, `grantPermit`, `hasActivePermit`,
//!   `parsePermitArgs`
//! - `utils/moderation/rules/blacklist.rule.ts` (37 lines): `compileBlacklistPattern`
//! - `utils/moderation/rules/caps.rule.ts` (53 lines)
//! - `utils/moderation/rules/emote_spam.rule.ts` (20 lines)
//! - `utils/moderation/rules/index.ts` (57 lines): `evaluateRule`
//! - `utils/moderation/rules/links.rule.ts` (44 lines)
//! - `utils/moderation/seed_plan.ts` (35 lines): `existingChannelModerationView`
//! - `utils/moderation/spam.ts` (119 lines): `SPAM_RULE_ID`, `claimFirstObservedMessage`,
//!   `claimSpamReviewBudget`, `defaultSpamModerationSettings`, `isSpamDecision`,
//!   `semanticPolicyActive`, `spamProtectionSettings`, `spamReviewSource`, `spamRule`,
//!   `spamRuleForContext`
//! - `utils/moderation/spam_categories.ts` (39 lines): `DEFAULT_SPAM_CATEGORIES`,
//!   `DEFAULT_SPAM_EXEMPT_TAGS`, `DEFAULT_SPAM_THRESHOLD`, `SPAM_CATEGORIES`,
//!   `SPAM_CLASSIFIER_MODEL`, `SPAM_EXEMPT_TAGS`, `categoryQuestions`
//! - `utils/moderation/variations.ts` (210 lines): `VARIATION_MODEL`, `VARIATION_VERSION`,
//!   `buildVariation`, `compileRuleVariations`, `generateMuseVariations`, `rulePatterns`,
//!   `validateVariations`, `variationAllowSpaces`, `variationKey`, `variationMode`,
//!   `variationOverrides`, `variationTerm`, `variationTerms`, `withVariationSpacing`
//!
//! User patterns are compiled once through `dima-commands` (its bounded pattern engine); this
//! module never compiles a regex from user text itself.
