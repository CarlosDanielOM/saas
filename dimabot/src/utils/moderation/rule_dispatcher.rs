//! Pure rule dispatcher. Blacklist patterns must come from the native compiler;
//! arbitrary JavaScript RegExp objects are outside this API's contract.
use crate::utils::{
    js_string::JsString,
    json_number::number_string,
    moderation::{
        blacklist::{BlacklistPattern, BlacklistRule, evaluate_blacklist_rule},
        caps::{CapsEvaluationInput, CapsRule, evaluate_caps_rule},
        emote_spam::{EmoteSpamInput, EmoteSpamRule, evaluate_emote_spam_rule},
        links_rule::{LinksEvaluationInput, LinksRule, evaluate_links_rule},
    },
};

/// The fields selected by each branch of the type-only `IModerationRule`.
/// Unknown preserves the source switch's default for future or invalid types.
pub enum ModerationRule<'a> {
    Caps(CapsRule),
    Links(LinksRule<'a>),
    EmoteSpam(EmoteSpamRule),
    Blacklist(&'a BlacklistRule),
    Unknown,
}

pub struct ModerationRuleInput<'a> {
    pub text: Option<&'a JsString>,
    pub emote_count: Option<f64>,
    pub emote_texts: Option<&'a [JsString]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModerationRuleResult {
    pub triggered: bool,
    pub detail: JsString,
}

pub fn evaluate_rule(
    rule: ModerationRule<'_>,
    input: ModerationRuleInput<'_>,
    blacklist_pattern: Option<&BlacklistPattern>,
) -> ModerationRuleResult {
    let (triggered, detail) = match rule {
        ModerationRule::Caps(rule) => {
            let result = evaluate_caps_rule(
                rule,
                CapsEvaluationInput {
                    text: input.text,
                    emote_texts: input.emote_texts,
                },
            );
            // Percentage is finite and in 0..=100. JS toFixed(0) rounds
            // exact half values toward the larger integer in this domain.
            (
                result.triggered,
                JsString::from(format!(
                    "caps={}/{} ({}%)",
                    result.caps_count,
                    result.letter_count,
                    result.caps_percentage.round() as u32
                )),
            )
        }
        ModerationRule::Links(rule) => {
            let result = evaluate_links_rule(rule, LinksEvaluationInput { text: input.text });
            let detail = match result.blocked_url {
                Some(host) => {
                    let mut units: Vec<u16> = "blocked url: ".encode_utf16().collect();
                    units.extend(host.units());
                    JsString::from_units(units)
                }
                None => JsString::from_static("no blocked urls"),
            };
            (result.triggered, detail)
        }
        ModerationRule::EmoteSpam(rule) => {
            let result = evaluate_emote_spam_rule(
                rule,
                EmoteSpamInput {
                    emote_count: input.emote_count,
                },
            );
            (
                result.triggered,
                JsString::from(format!(
                    "emotes={}/{}",
                    number_string(result.emote_count),
                    number_string(rule.max_emote_count)
                )),
            )
        }
        ModerationRule::Blacklist(rule) => {
            let result = evaluate_blacklist_rule(rule, input.text, blacklist_pattern);
            (
                result.triggered,
                JsString::from_static(
                    if result.matched_text.as_ref().is_some_and(|s| !s.is_empty()) {
                        "matched blacklisted term"
                    } else {
                        "no match"
                    },
                ),
            )
        }
        ModerationRule::Unknown => (false, JsString::from_static("unknown rule type")),
    };
    ModerationRuleResult { triggered, detail }
}
