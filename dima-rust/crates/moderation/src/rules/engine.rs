//! A channel's rules compiled once, and the check of one chat message against them (reference
//! `utils/moderation/rules/index.ts`, plus the rule loop of `handlers/moderation.handler.ts`
//! without its side effects: the receipts, decisions, reviews, offenses and actions stay with
//! the handler, P4-MOD-RUN).
//!
//! # What the handler gets
//!
//! [`CompiledSettings::compile`] turns a stored settings document into compiled rules: the
//! literal blacklist, every stored pattern and the combined variation pattern (all through
//! `dima_commands::patterns`), the exemption, the lowercased allowlist. [`CompiledRule::check`]
//! then answers, for one message and one chatter, what the reference's loop body decides
//! before it writes anything:
//!
//! - [`RuleOutcome::Disabled`] and [`RuleOutcome::Exempt`]: `continue`;
//! - [`RuleOutcome::Clear`]: the rule did not fire, `continue`;
//! - [`RuleOutcome::Hit`]: the rule fired, with the evidence (`evaluateRule`'s result, the
//!   blacklist matches with UTF-16 positions), the decision mode (`semantic`, `regex`,
//!   `literal`) and whether it is an advanced (paid) rule; the handler creates the decision
//!   and goes on as the reference does;
//! - [`RuleOutcome::Failed`]: where the reference throws (a pattern RE2 refuses, a recompiled
//!   variation over its length limit, a null domain): the reference's `catch` logs it and lets
//!   the message through, so the handler stops checking this message.
//!
//! [`CompiledSettings::check_all`] runs the whole loop without stopping at a hit (for tests and
//! the corpus).
//!
//! # Cost
//!
//! Compilation is the expensive part (a worst-case rule: 200 words with variations) and happens
//! once per settings revision ([`CompiledSettingsCache`]). A check folds the message once per
//! blocked-word rule and runs each compiled pattern once over it: linear in the message length
//! for every rule. Measured figures are in the package report and `tests/cost.rs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bson::Bson;
use dima_commands::patterns::{CompiledAlternation, PatternError};
use dima_commands::permissions::{CompiledPermission, UserIdentity};
use dima_model::channel_moderation_settings::{
    ChannelModerationSettings, ChannelModerationSettingsRules,
};

use super::advanced::{Matcher, ModerationMatch, ModerationPattern, find_blacklist_matches};
use super::blacklist::{BlacklistPattern, evaluate_blacklist};
use super::caps::{CapsSettings, CapsThresholdMode, evaluate_caps};
use super::emote_spam::evaluate_emote_spam;
use super::links::{evaluate_links, lowercase_allowlist};
use super::offenses::OffenseStep;
use super::variations::{
    CombinedVariations, ModerationVariations, VariationError, combined_variations,
    compile_rule_variations,
};

/// One chat message as the rules read it (`ModerationRuleInput`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageInput {
    /// `message.text`.
    pub text: String,
    /// The texts of the message's `emote` fragments (fragments without text are skipped, as the
    /// reference filters them).
    pub emote_texts: Vec<String>,
    /// How many `emote` fragments it has.
    pub emote_count: usize,
}

impl MessageInput {
    /// From the message text and its fragments as `(type, text)` pairs.
    pub fn from_fragments<'a>(
        text: &str,
        fragments: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
    ) -> Self {
        let mut emote_texts = Vec::new();
        let mut emote_count = 0;
        for (kind, fragment_text) in fragments {
            if kind == "emote" {
                emote_count += 1;
                if let Some(fragment_text) = fragment_text {
                    emote_texts.push(fragment_text.to_owned());
                }
            }
        }
        Self {
            text: text.to_owned(),
            emote_texts,
            emote_count,
        }
    }
}

/// `rule.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    /// `caps`.
    Caps,
    /// `links`.
    Links,
    /// `emote_spam`.
    EmoteSpam,
    /// `blacklist`.
    Blacklist,
    /// Anything else: never fires (`unknown rule type`).
    Unknown,
}

impl RuleKind {
    fn of(text: &str) -> Self {
        match text {
            "caps" => Self::Caps,
            "links" => Self::Links,
            "emote_spam" => Self::EmoteSpam,
            "blacklist" => Self::Blacklist,
            _ => Self::Unknown,
        }
    }
}

/// The `mode` of the decision a hit creates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionMode {
    /// The rule has contextual review on: the model decides.
    Semantic,
    /// The rule has stored patterns or variations.
    Regex,
    /// Words only (and every other rule type).
    Literal,
}

impl DecisionMode {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Semantic => "semantic",
            Self::Regex => "regex",
            Self::Literal => "literal",
        }
    }
}

/// Where the reference would throw while checking a message (it then logs and lets the message
/// through).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuleError {
    /// A stored pattern that RE2 or its translation refuses (`compilePattern` throws).
    #[error("pattern {id} cannot be compiled: {error}")]
    Pattern {
        /// The pattern's id (`auto-all-...` for the combined variations).
        id: String,
        /// Why.
        error: PatternError,
    },
    /// A variation entry that cannot be recompiled (`withVariationSpacing` throws).
    #[error(transparent)]
    Variation(#[from] VariationError),
    /// Stored data the reference's code would crash on (named).
    #[error("malformed rule: {0}")]
    Malformed(&'static str),
    /// The literal blacklist is beyond the compile limit (the reference has none).
    #[error("blocked-word list is too large to compile")]
    BlacklistTooLarge,
}

/// What [`CompiledRule::check`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum RuleOutcome {
    /// The rule is off.
    Disabled,
    /// The chatter is exempt from it.
    Exempt,
    /// It did not fire.
    Clear,
    /// It fired.
    Hit(RuleHit),
    /// The reference throws here; stop checking this message.
    Failed(RuleError),
}

/// A rule that fired, with its evidence.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleHit {
    /// The rule's position in `settings.rules`.
    pub index: usize,
    /// `evaluateRule(...).triggered` (for a blocked-word rule the literal search on the whole
    /// folded message; the rule also fires when only [`Self::matches`] is non-empty).
    pub triggered: bool,
    /// `evaluateRule(...).detail`.
    pub detail: String,
    /// `findBlacklistMatches(...)`: what is stored in the decision (blocked-word rules only).
    pub matches: Vec<ModerationMatch>,
    /// The decision's mode.
    pub mode: DecisionMode,
    /// A blocked-word rule with patterns, variations or contextual review: it acts only for a
    /// paid plan (`plan_required` otherwise).
    pub advanced: bool,
}

/// One rule, compiled.
#[derive(Debug)]
pub struct CompiledRule {
    index: usize,
    kind: RuleKind,
    enabled: bool,
    exemption: CompiledPermission,
    caps: CapsSettings,
    allowlist: Result<Vec<String>, RuleError>,
    max_emote_count: f64,
    literal: Result<Option<BlacklistPattern>, RuleError>,
    /// `rulePatterns(rule)` compiled; its length decides the mode.
    matchers: Result<Vec<Matcher>, RuleError>,
    pattern_count: Result<usize, RuleError>,
    /// `compileRuleVariations(rule)`, which the decision stores: fails on a hit.
    decision_variations: Result<(), RuleError>,
    semantic: bool,
    mode_selected: bool,
    memory: usize,
}

fn number(value: &dima_store::mongo::number::JsNumber) -> f64 {
    value.0
}

/// The stored `variations` as typed, or the reason it cannot be read.
pub fn rule_variations(
    rule: &ChannelModerationSettingsRules,
) -> Result<Option<ModerationVariations>, RuleError> {
    match &rule.variations.expose().0 {
        Bson::Null | Bson::Undefined => Ok(None),
        raw => bson::deserialize_from_bson::<ModerationVariations>(raw.clone())
            .map(Some)
            .map_err(|_| RuleError::Malformed("variations")),
    }
}

/// The stored patterns as typed (`rules.$.patterns`).
pub fn rule_stored_patterns(
    rule: &ChannelModerationSettingsRules,
) -> Result<Vec<ModerationPattern>, RuleError> {
    rule.patterns
        .iter()
        .map(|pattern| {
            let (Some(id), Some(source)) = (&pattern.id, &pattern.source) else {
                return Err(RuleError::Malformed("pattern without id or source"));
            };
            Ok(ModerationPattern {
                id: id.clone(),
                source: source.expose().clone(),
                boundary: pattern.boundary.clone().unwrap_or_default(),
                ignore_case: pattern.ignore_case == Some(true),
            })
        })
        .collect()
}

fn compile_matchers(
    stored: &[ModerationPattern],
    combined: Option<&CombinedVariations>,
) -> Result<(Vec<Matcher>, usize), RuleError> {
    let mut matchers = Vec::with_capacity(stored.len() + 1);
    for pattern in stored {
        let compiled = pattern.compile().map_err(|error| RuleError::Pattern {
            id: pattern.id.clone(),
            error,
        })?;
        matchers.push(Matcher::Pattern {
            id: pattern.id.clone(),
            compiled,
        });
    }
    let mut memory = 0;
    if let Some(combined) = combined {
        let compiled = CompiledAlternation::new(combined.components.iter().map(String::as_str))
            .map_err(|error| RuleError::Pattern {
                id: combined.id.clone(),
                error,
            })?;
        memory = compiled.memory_usage();
        matchers.push(Matcher::Variations {
            id: combined.id.clone(),
            compiled,
        });
    }
    Ok((matchers, memory))
}

impl CompiledRule {
    fn compile(index: usize, rule: &ChannelModerationSettingsRules) -> Self {
        let kind = RuleKind::of(rule.r#type.as_str());
        let exemption = CompiledPermission::compile(
            rule.exempt_expression.as_ref().map(|raw| &raw.0),
            Some(&Bson::Double(rule.exempt_user_level.0)),
        );
        let caps = CapsSettings {
            mode: if rule.caps_threshold_mode.as_str() == "percentage" {
                CapsThresholdMode::Percentage
            } else {
                CapsThresholdMode::Count
            },
            min_caps_count: number(&rule.min_caps_count),
            max_caps_percentage: number(&rule.max_caps_percentage),
            min_message_length: number(&rule.min_message_length),
        };
        let allowlist = rule
            .allowlist_domains
            .iter()
            .map(|domain| domain.as_deref().ok_or(RuleError::Malformed("null domain")))
            .collect::<Result<Vec<_>, _>>()
            .map(lowercase_allowlist);
        let variations = rule_variations(rule);
        let stored = rule_stored_patterns(rule);
        // `rulePatterns(rule)`: the stored patterns and the combined variation pattern.
        let combined = variations.clone().and_then(|variations| {
            combined_variations(variations.as_ref()).map_err(RuleError::from)
        });
        let pattern_count = match (&stored, &combined) {
            (Ok(stored), Ok(combined)) => Ok(stored.len() + usize::from(combined.is_some())),
            (Err(error), _) | (_, Err(error)) => Err(error.clone()),
        };
        let mut memory = 0;
        let (literal, matchers) = if kind == RuleKind::Blacklist {
            let terms = rule.terms.expose().iter().map(Option::as_deref);
            let literal =
                BlacklistPattern::compile(terms).map_err(|_| RuleError::BlacklistTooLarge);
            let matchers = match (&stored, &combined) {
                (Ok(stored), Ok(combined)) => {
                    compile_matchers(stored, combined.as_ref()).map(|(matchers, used)| {
                        memory = used;
                        matchers
                    })
                }
                (Err(error), _) | (_, Err(error)) => Err(error.clone()),
            };
            (literal, matchers)
        } else {
            (Ok(None), Ok(Vec::new()))
        };
        let decision_variations = variations.clone().and_then(|variations| {
            compile_rule_variations(variations.as_ref())
                .map(|_| ())
                .map_err(RuleError::from)
        });
        let mode_selected = variations
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .is_some_and(ModerationVariations::mode_selected);
        Self {
            index,
            kind,
            enabled: rule.enabled,
            exemption,
            caps,
            allowlist,
            max_emote_count: number(&rule.max_emote_count),
            literal,
            matchers,
            pattern_count,
            decision_variations,
            semantic: rule.semantic.enabled,
            mode_selected,
            memory,
        }
    }

    /// The rule's position in `settings.rules`.
    pub fn index(&self) -> usize {
        self.index
    }

    /// The rule's type.
    pub fn kind(&self) -> RuleKind {
        self.kind
    }

    /// The compiled exemption (its [`CompiledPermission::validation_error`] is what the handler
    /// logs, rate-limited, for an invalid stored expression).
    pub fn exemption(&self) -> &CompiledPermission {
        &self.exemption
    }

    /// The loop body for one message and one chatter, up to (not including) the decision.
    pub fn check(&self, input: &MessageInput, identity: &UserIdentity) -> RuleOutcome {
        if !self.enabled {
            return RuleOutcome::Disabled;
        }
        if self.exemption.allowed(identity) {
            return RuleOutcome::Exempt;
        }
        match self.evaluate(input) {
            Ok(Some(hit)) => RuleOutcome::Hit(hit),
            Ok(None) => RuleOutcome::Clear,
            Err(error) => RuleOutcome::Failed(error),
        }
    }

    fn evaluate(&self, input: &MessageInput) -> Result<Option<RuleHit>, RuleError> {
        let (triggered, detail, matches) = match self.kind {
            RuleKind::Caps => {
                let result = evaluate_caps(&self.caps, &input.text, &input.emote_texts);
                let detail = format!(
                    "caps={}/{} ({}%)",
                    result.caps_count,
                    result.letter_count,
                    dima_text::to_fixed(result.caps_percentage, 0)
                );
                (result.triggered, detail, Vec::new())
            }
            RuleKind::Links => {
                let allowlist = self.allowlist.as_ref().map_err(Clone::clone)?;
                let result = evaluate_links(allowlist, &input.text);
                let detail = match &result.blocked_url {
                    Some(url) => format!("blocked url: {url}"),
                    None => "no blocked urls".to_owned(),
                };
                (result.triggered, detail, Vec::new())
            }
            RuleKind::EmoteSpam => {
                let triggered = evaluate_emote_spam(self.max_emote_count, input.emote_count);
                let detail = format!(
                    "emotes={}/{}",
                    input.emote_count,
                    dima_text::number_to_string(self.max_emote_count)
                );
                (triggered, detail, Vec::new())
            }
            RuleKind::Blacklist => {
                // `advanced` (computed first in the loop) reads `rulePatterns(rule)`.
                self.pattern_count.as_ref().map_err(Clone::clone)?;
                let literal = self.literal.as_ref().map_err(Clone::clone)?;
                let matchers = self.matchers.as_ref().map_err(Clone::clone)?;
                let result = evaluate_blacklist(literal.as_ref(), &input.text);
                let detail = if result.matched_text.is_some() {
                    "matched blacklisted term"
                } else {
                    "no match"
                };
                let matches = find_blacklist_matches(&input.text, literal.as_ref(), matchers);
                (result.triggered, detail.to_owned(), matches)
            }
            RuleKind::Unknown => return Ok(None),
        };
        if !triggered && matches.is_empty() {
            return Ok(None);
        }
        // On a hit the reference computes the mode from `rulePatterns(rule)` and stores
        // `compileRuleVariations(rule)` in the decision; either can throw for any rule type.
        let pattern_count = *self.pattern_count.as_ref().map_err(Clone::clone)?;
        self.decision_variations.as_ref().map_err(Clone::clone)?;
        let mode = if self.semantic {
            DecisionMode::Semantic
        } else if pattern_count > 0 {
            DecisionMode::Regex
        } else {
            DecisionMode::Literal
        };
        let advanced = self.kind == RuleKind::Blacklist
            && (pattern_count > 0 || self.mode_selected || self.semantic);
        Ok(Some(RuleHit {
            index: self.index,
            triggered,
            detail,
            matches,
            mode,
            advanced,
        }))
    }
}

/// A channel's settings with every rule compiled. `Send + Sync`; share it through an [`Arc`].
#[derive(Debug)]
pub struct CompiledSettings {
    settings: Arc<ChannelModerationSettings>,
    rules: Vec<CompiledRule>,
    memory: usize,
}

impl CompiledSettings {
    /// Compiles every rule. CPU-bound (worst case in `tests/cost.rs`): an async caller that misses
    /// the cache runs it on the blocking pool.
    pub fn compile(settings: Arc<ChannelModerationSettings>) -> Self {
        let rules: Vec<CompiledRule> = settings
            .rules
            .iter()
            .enumerate()
            .map(|(index, rule)| CompiledRule::compile(index, rule))
            .collect();
        let memory = rules.iter().map(|rule| rule.memory).sum();
        Self {
            settings,
            rules,
            memory,
        }
    }

    /// The settings this was compiled from.
    pub fn settings(&self) -> &Arc<ChannelModerationSettings> {
        &self.settings
    }

    /// The compiled rules, in order.
    pub fn rules(&self) -> &[CompiledRule] {
        &self.rules
    }

    /// The stored rule a compiled rule or a hit refers to.
    pub fn rule(&self, index: usize) -> Option<&ChannelModerationSettingsRules> {
        self.settings.rules.get(index)
    }

    /// The offense ladder step of rule `index` for offense number `offense`
    /// ([`super::offenses::resolve_offense_step`]).
    pub fn offense_step(&self, index: usize, offense: i64) -> Option<OffenseStep> {
        self.rule(index)
            .map(|rule| super::offenses::resolve_offense_step(rule, offense))
    }

    /// Heap of the compiled variation patterns, in bytes (the dominant part).
    pub fn memory_usage(&self) -> usize {
        self.memory
    }

    /// Every rule's outcome for one message, in order, through the first
    /// [`RuleOutcome::Failed`] (the reference stops there). Disabled rules are left out.
    pub fn check_all(&self, input: &MessageInput, identity: &UserIdentity) -> Vec<RuleOutcome> {
        let mut outcomes = Vec::new();
        for rule in &self.rules {
            let outcome = rule.check(input, identity);
            match outcome {
                RuleOutcome::Disabled => {}
                RuleOutcome::Failed(_) => {
                    outcomes.push(outcome);
                    break;
                }
                _ => outcomes.push(outcome),
            }
        }
        outcomes
    }
}

/// What identifies a settings revision for the cache: `settingsVersion` (every save bumps it)
/// and `updatedAt` (every Mongoose write moves it, including the first-activation seed that
/// replaces a stub without bumping the version), plus the rule count.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Revision {
    version: f64,
    updated_at: Option<i64>,
    rules: usize,
}

impl Revision {
    fn of(settings: &ChannelModerationSettings) -> Self {
        Self {
            version: settings.settings_version.0,
            updated_at: settings.updated_at.map(|date| date.0),
            rules: settings.rules.len(),
        }
    }
}

/// The bounds of [`CompiledSettingsCache`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheLimits {
    /// The most channels kept.
    pub channels: usize,
    /// The most compiled-pattern heap kept, in bytes (each entry counts at least 64 KiB).
    pub bytes: usize,
}

impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            channels: 10_000,
            bytes: 256 * 1024 * 1024,
        }
    }
}

const MIN_ENTRY_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct CacheEntry {
    revision: Revision,
    compiled: Arc<CompiledSettings>,
    used: u64,
}

#[derive(Debug, Default)]
struct CacheState {
    entries: HashMap<String, CacheEntry>,
    bytes: usize,
    tick: u64,
}

/// Compiled settings per channel, recompiled when the revision changes (the reference keeps its
/// compiled literal blacklists per channel and settings version, unbounded, and its compiled
/// patterns in a process-wide map cleared at 1,000). Bounded by channels and by compiled
/// heap; at either bound the least recently used channel is dropped (it recompiles on its next
/// message).
#[derive(Debug, Default)]
pub struct CompiledSettingsCache {
    limits: CacheLimits,
    state: Mutex<CacheState>,
}

impl CompiledSettingsCache {
    /// A cache with these bounds.
    pub fn new(limits: CacheLimits) -> Self {
        Self {
            limits,
            state: Mutex::new(CacheState::default()),
        }
    }

    /// The compiled form of `settings`, compiling (outside the lock) when the channel has none
    /// for this revision.
    pub fn get_or_compile(
        &self,
        settings: Arc<ChannelModerationSettings>,
    ) -> Arc<CompiledSettings> {
        let revision = Revision::of(&settings);
        let channel = settings.channel_id.clone();
        if let Some(found) = self.lookup(&channel, revision) {
            return found;
        }
        let compiled = Arc::new(CompiledSettings::compile(settings));
        self.insert(channel, revision, Arc::clone(&compiled));
        compiled
    }

    fn lookup(&self, channel: &str, revision: Revision) -> Option<Arc<CompiledSettings>> {
        let mut state = self.state.lock().ok()?;
        state.tick += 1;
        let tick = state.tick;
        let entry = state.entries.get_mut(channel)?;
        if entry.revision != revision {
            return None;
        }
        entry.used = tick;
        Some(Arc::clone(&entry.compiled))
    }

    fn insert(&self, channel: String, revision: Revision, compiled: Arc<CompiledSettings>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let size = compiled.memory_usage().max(MIN_ENTRY_BYTES);
        if let Some(old) = state.entries.remove(&channel) {
            state.bytes = state
                .bytes
                .saturating_sub(old.compiled.memory_usage().max(MIN_ENTRY_BYTES));
        }
        while !state.entries.is_empty()
            && (state.entries.len() >= self.limits.channels
                || state.bytes.saturating_add(size) > self.limits.bytes)
        {
            let Some(oldest) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(old) = state.entries.remove(&oldest) {
                state.bytes = state
                    .bytes
                    .saturating_sub(old.compiled.memory_usage().max(MIN_ENTRY_BYTES));
            }
        }
        if self.limits.channels == 0 || size > self.limits.bytes {
            return;
        }
        state.tick += 1;
        let used = state.tick;
        state.bytes += size;
        state.entries.insert(
            channel,
            CacheEntry {
                revision,
                compiled,
                used,
            },
        );
    }

    /// Drops a channel (`invalidateModerationSettingsCache` / `primeModerationSettingsCache`).
    pub fn invalidate(&self, channel_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(old) = state.entries.remove(channel_id)
        {
            state.bytes = state
                .bytes
                .saturating_sub(old.compiled.memory_usage().max(MIN_ENTRY_BYTES));
        }
    }

    /// How many channels are cached.
    pub fn len(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.entries.len())
            .unwrap_or(0)
    }

    /// Whether nothing is cached.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The compiled heap counted against [`CacheLimits::bytes`].
    pub fn bytes(&self) -> usize {
        self.state.lock().map(|state| state.bytes).unwrap_or(0)
    }
}
