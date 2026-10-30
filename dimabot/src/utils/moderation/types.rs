//! Shared, transport-independent moderation configuration types.
use crate::utils::{js_string::JsString, moderation::spam_categories::SpamCategory};

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum PatternBoundary {
    WholeWord,
    Anywhere,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ModerationPattern {
    pub id: JsString,
    pub source: JsString,
    pub boundary: PatternBoundary,
    pub ignore_case: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SemanticLabel {
    Allow,
    Violation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticExample {
    pub message: JsString,
    pub label: SemanticLabel,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticPolicy {
    pub categories: Option<Vec<SpamCategory>>,
    pub broadcaster_invitation: Option<bool>,
    pub enabled: bool,
    pub threshold_percent: Option<f64>,
    pub policy: JsString,
    pub examples: Vec<SemanticExample>,
    // The TypeScript union has exactly one member: 'allow_and_log'.
    pub on_uncertain: OnUncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnUncertain {
    AllowAndLog,
}
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum VariationMode {
    Off,
    Common,
    Broad,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct GeneratedVariation {
    pub term: JsString,
    pub spellings: Vec<JsString>,
    pub pattern: ModerationPattern,
    pub version: JsString,
    pub allow_spaces: Option<bool>,
    pub symbol_version: Option<JsString>,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct VariationOverride {
    pub term: JsString,
    pub source: JsString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationVariations {
    pub mode: VariationMode,
    pub entries: Vec<GeneratedVariation>,
    pub overrides: Option<Vec<VariationOverride>>,
    pub allow_spaces: Option<bool>,
}
