//! Chat moderation rules: settings defaults, text folding, the blacklist, caps, emote-spam and link
//! rules, spam categories and their semantic policy, permits, offense steps, decisions and pattern
//! variations. Package **P4-MOD-RULES**.
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
//! module never compiles a regex from user text itself. The literal blacklist and the links
//! expression are built here from escaped text only.
//!
//! Also ported, because the handler's verdict depends on it: the matching half of
//! `utils/moderation/advanced.ts` (`findBlacklistMatches`, `compilePattern`, the constants),
//! which the plan's inventory does not list ([`advanced`]).
//!
//! # Map
//!
//! - [`engine`]: [`CompiledSettings`] (a settings document compiled once), the per-message
//!   [`CompiledRule::check`] with its [`RuleOutcome`], and the bounded [`CompiledSettingsCache`].
//! - The rules: [`caps`], [`links`], [`emote_spam`], [`blacklist`], [`advanced`] (patterns and
//!   the stored match list), [`variations`], [`normalize`].
//! - State: [`offenses`] (escalation), [`permit`], [`spam`] (first-message marker, review
//!   budget), all methods of [`RulesStore`].
//! - [`spam_categories`]: the classifier's categories and questions.
//!
//! What the handler (P4-MOD-RUN) still owns: loading and caching the settings document, the
//! message receipt, the per-chatter serialisation, decisions and their semantic review,
//! executing actions, logging.

pub mod advanced;
pub mod blacklist;
pub mod caps;
pub mod decisions;
pub mod defaults;
pub mod emote_spam;
pub mod engine;
pub mod links;
pub mod normalize;
pub mod offenses;
pub mod permit;
pub mod spam;
pub mod spam_categories;
pub mod store;
mod unicode;
pub mod variations;

pub use engine::{
    CacheLimits, CompiledRule, CompiledSettings, CompiledSettingsCache, DecisionMode, MessageInput,
    RuleError, RuleHit, RuleKind, RuleOutcome,
};
pub use offenses::{ModerationAction, OffenseStep, resolve_offense_step};
pub use store::{RulesConfig, RulesStore, StoreError};
