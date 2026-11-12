//! Replays the tables of `corpus/rules_corpus.json.gz` (recorded from the reference by
//! `corpus/generate.mjs`): spelling variations (built entries, recompiled sources, keys and
//! validators), permit arguments, the offense ladder and spam protection.
//!
//! One intended difference: limits on what a streamer types (a word or spelling of at most 100)
//! count characters here and UTF-16 units in the reference (charter text rule 1), so a word of
//! more than 50 astral characters (emoji) that the reference refuses is accepted. Only ever more
//! permissive for the streamer saving settings; counted below. And an edited source using `\C`
//! is refused when saved (the translation cannot run it; see the verdict corpus).
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::HashMap;
use std::io::Read;

use bson::Bson;
use dima_commands::permissions::{RoleTag, UserIdentity};
use dima_model::channel_moderation_settings::{
    ChannelModerationSettings, ChannelModerationSettingsRules,
    ChannelModerationSettingsSpamProtection,
};
use dima_moderation::rules::permit::parse_permit_args;
use dima_moderation::rules::spam::{
    ContextMessage, SpamProtection, broadcaster_invited_promotion, chatter_marker_id,
    default_spam_moderation_settings, spam_review_source, spam_rule, spam_rule_for_context,
};
use dima_moderation::rules::spam_categories::category_questions;
use dima_moderation::rules::variations::{
    GeneratedVariation, VariationMode, build_variation, muse_variation_request,
    validate_variations, variation_allow_spaces, variation_key, variation_mode,
    variation_overrides, variation_term, variation_terms, with_variation_spacing,
};
use dima_moderation::rules::{ModerationAction, resolve_offense_step};
use serde_json::{Value, json};

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/corpus/rules_corpus.json.gz"
    );
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn mode(text: &str) -> VariationMode {
    match text {
        "off" => VariationMode::Off,
        "common" => VariationMode::Common,
        "broad" => VariationMode::Broad,
        other => panic!("mode {other}"),
    }
}

/// `{ok}` / `{error}` of the recorder, from a Rust result.
fn outcome<T, E: std::fmt::Display>(result: Result<T, E>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

/// Over 100 UTF-16 units but at most 100 characters: the reference refuses, Rust accepts.
fn character_limit_case(text: &str) -> bool {
    text.chars().count() <= 100 && dima_text::utf16_len(text) > 100
}

#[test]
fn variations_match_the_reference() {
    let corpus = corpus();
    let mut character_limit = 0;
    let mut refused_pattern = 0;
    let mut compared = 0;
    for row in corpus["tables"]["variations"].as_array().unwrap() {
        let term = row["term"].as_str().unwrap();
        let built = build_variation(term, &row["suggestions"]);
        let rust = outcome(built.clone(), |entry| serde_json::to_value(entry).unwrap());
        compared += 1;
        if rust != row["built"] {
            assert!(
                character_limit_case(&variation_term(term)) && row["built"]["error"].is_string(),
                "buildVariation({term:?}, {}): rust {rust} reference {}",
                row["suggestions"],
                row["built"]
            );
            character_limit += 1;
            continue;
        }
        let Ok(entry) = built else { continue };
        for spacing in row["spacing"].as_array().unwrap() {
            let allow = spacing[0].as_bool().unwrap();
            let recompiled =
                with_variation_spacing(&entry, allow, mode(spacing[1].as_str().unwrap()));
            let rust = match recompiled {
                Ok(cow) => json!({
                    "source": cow.pattern.source,
                    "same": matches!(cow, std::borrow::Cow::Borrowed(_)),
                    "symbolVersion": cow.symbol_version,
                }),
                Err(error) => json!({ "error": error.to_string() }),
            };
            compared += 1;
            assert_eq!(
                rust, spacing[2],
                "withVariationSpacing({term:?}, {allow}, {})",
                spacing[1]
            );
        }
    }
    for row in corpus["tables"]["termKeys"].as_array().unwrap() {
        let text = row[0].as_str().unwrap();
        assert_eq!(
            variation_term(text),
            row[1].as_str().unwrap(),
            "variationTerm({text:?})"
        );
        assert_eq!(variation_key("chan-1", text), row[2].as_str().unwrap());
        assert_eq!(variation_key("", text), row[3].as_str().unwrap());
        compared += 3;
    }
    let raw = |value: &Value| (value != "__undefined").then(|| value.clone());
    let validators = &corpus["tables"]["validators"];
    for row in validators["mode"].as_array().unwrap() {
        let rust = outcome(variation_mode(raw(&row[0]).as_ref()), |mode| {
            json!(match mode {
                VariationMode::Off => "off",
                VariationMode::Common => "common",
                VariationMode::Broad => "broad",
            })
        });
        assert_eq!(rust, row[1], "variationMode({})", row[0]);
        compared += 1;
    }
    for row in validators["allowSpaces"].as_array().unwrap() {
        let rust = outcome(variation_allow_spaces(raw(&row[0]).as_ref()), |v| json!(v));
        assert_eq!(rust, row[1], "variationAllowSpaces({})", row[0]);
        compared += 1;
    }
    for row in validators["terms"].as_array().unwrap() {
        let rust = outcome(variation_terms(&row[0]), |terms| json!(terms));
        compared += 1;
        if rust != row[1] {
            let words: Vec<&str> = row[0]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(
                words.iter().any(|w| character_limit_case(w)) && row[1]["error"].is_string(),
                "variationTerms({}): rust {rust} reference {}",
                row[0],
                row[1]
            );
            character_limit += 1;
        }
    }
    for row in validators["overrides"].as_array().unwrap() {
        let terms: Vec<String> = row[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_owned())
            .collect();
        let rust = outcome(
            variation_overrides(Some(&row[0]), &terms, mode(row[2].as_str().unwrap())),
            |list| serde_json::to_value(list).unwrap(),
        );
        compared += 1;
        if rust != row[3] && row[0].to_string().contains(r"\\C") && rust["error"].is_string() {
            // `\C` (one byte) is refused by the translation: a streamer cannot save a pattern
            // the bot could not run (the same kind as in the verdict corpus).
            refused_pattern += 1;
            continue;
        }
        assert_eq!(rust, row[3], "variationOverrides({}, {})", row[0], row[2]);
    }
    for row in validators["validate"].as_array().unwrap() {
        let entries: Vec<GeneratedVariation> = serde_json::from_value(row[0].clone()).unwrap();
        let rust = validate_variations(
            &entries,
            row[1].as_bool().unwrap(),
            mode(row[2].as_str().unwrap()),
        );
        assert_eq!(
            rust.is_ok(),
            row[3].get("ok").is_some() || row[3] == json!({}),
            "validateVariations: {}",
            row[3]
        );
        if let Err(error) = rust {
            assert_eq!(json!(error.to_string()), row[3]["error"]);
        }
        compared += 1;
    }
    let request = muse_variation_request(&["fuzz".into(), "rinn".into(), "café".into()]);
    assert_eq!(request, corpus["tables"]["museRequest"]);
    println!(
        "variations: {compared} compared; intended: {character_limit} character limits, {refused_pattern} refused pattern"
    );
    assert!(character_limit > 0 && refused_pattern == 1);
}

#[test]
fn permits_match_the_reference() {
    let corpus = corpus();
    for row in corpus["tables"]["permits"].as_array().unwrap() {
        let args: Vec<&str> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let rust = match parse_permit_args(&args) {
            Ok(target) => json!({ "login": target.login, "seconds": target.seconds }),
            Err(error) => json!({ "error": error }),
        };
        assert_eq!(rust, row[1], "parsePermitArgs({args:?})");
    }
}

#[test]
fn offense_ladder_matches_the_reference() {
    let corpus = corpus();
    let mut rules: HashMap<String, ChannelModerationSettingsRules> = HashMap::new();
    for entry in corpus["synthetic"].as_array().unwrap() {
        let Bson::Document(document) = Bson::try_from(entry["settings"].clone()).unwrap() else {
            panic!()
        };
        let settings: ChannelModerationSettings =
            bson::deserialize_from_document(document).unwrap();
        for rule in settings.rules {
            rules.insert(rule.id.clone(), rule);
        }
    }
    let ladder = corpus["tables"]["ladder"].as_array().unwrap();
    for row in ladder {
        let rule = &rules[row[0].as_str().unwrap()];
        let step = resolve_offense_step(rule, row[1].as_i64().unwrap());
        assert_eq!(step.action.as_str(), row[2]["action"].as_str().unwrap());
        assert_eq!(
            Some(step.timeout_seconds),
            row[2]["timeoutSeconds"].as_f64()
        );
    }
    assert!(ladder.iter().any(|row| row[2]["action"] == "kick"));
    assert_eq!(
        ModerationAction::parse("kick"),
        ModerationAction::Other("kick".into())
    );
}

fn protection(raw: &Value) -> SpamProtection {
    let stored = raw.get("spamProtection").map_or_else(
        || {
            // A document without the field reads the schema default.
            let empty = bson::doc! {};
            bson::deserialize_from_document::<ChannelModerationSettingsSpamProtection>(empty)
                .unwrap()
        },
        |value| {
            let Bson::Document(document) = Bson::try_from(value.clone()).unwrap() else {
                panic!()
            };
            bson::deserialize_from_document(document).unwrap()
        },
    );
    SpamProtection::from_model(&stored)
}

fn context(raw: &Value) -> Vec<ContextMessage> {
    raw.as_array()
        .unwrap()
        .iter()
        .map(|m| ContextMessage {
            message: m["message"].as_str().unwrap().to_owned(),
            is_broadcaster: m["isBroadcaster"] == true,
        })
        .collect()
}

#[test]
fn spam_protection_matches_the_reference() {
    let corpus = corpus();
    let spam = &corpus["tables"]["spam"];
    let mut kelvin_or_long_s = 0;
    for row in spam["invitation"].as_array().unwrap() {
        let rust = broadcaster_invited_promotion(&context(&row[0]));
        if json!(rust) != row[1] {
            // `\b` with `iu` counts `ſ` and the Kelvin sign as word characters in JavaScript.
            assert!(
                row[0].to_string().contains('ſ'),
                "invitation {}: rust {rust}",
                row[0]
            );
            kelvin_or_long_s += 1;
        }
    }
    for row in spam["ruleForContext"].as_array().unwrap() {
        let ctx = context(&row[0]);
        let rust = dima_text::to_js_json(&spam_rule_for_context(&ctx, &protection(&row[1])));
        if broadcaster_invited_promotion(&ctx)
            != (row[2]
                .as_str()
                .unwrap()
                .contains("\"broadcasterInvitation\":true"))
        {
            kelvin_or_long_s += 1;
            continue;
        }
        assert_eq!(
            rust,
            row[2].as_str().unwrap(),
            "spamRuleForContext({}, {})",
            row[0],
            row[1]
        );
    }
    for row in spam["protection"].as_array().unwrap() {
        assert_eq!(
            dima_text::to_js_json(&protection(&row[0]).to_json()),
            row[1].as_str().unwrap()
        );
    }
    for row in spam["reviewSource"].as_array().unwrap() {
        let source = spam_review_source(
            row[1].as_bool().unwrap(),
            &protection(&row[0]),
            row[2].as_str(),
        );
        assert_eq!(
            json!(source.map(|s| s.as_str())),
            row[3],
            "spamReviewSource {row}"
        );
    }
    let identities: Vec<UserIdentity> = corpus["identities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            let name = value["name"].as_str().unwrap();
            let tags = value["tags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| RoleTag::parse(t.as_str().unwrap()).unwrap());
            UserIdentity::new(
                value["level"].as_f64().unwrap(),
                tags,
                Some(&format!("id-{name}")),
                Some(name),
            )
        })
        .collect();
    for row in spam["exempt"].as_array().unwrap() {
        let identity = &identities[row[1].as_u64().unwrap() as usize];
        assert_eq!(
            json!(protection(&row[0]).exempt(identity)),
            row[2],
            "spam exemption {row}"
        );
    }
    for row in spam["markers"].as_array().unwrap() {
        assert_eq!(
            chatter_marker_id(row[0].as_str().unwrap(), row[1].as_str().unwrap()),
            row[2].as_str().unwrap()
        );
    }
    for row in spam["questions"].as_array().unwrap() {
        let categories: Vec<&str> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap())
            .collect();
        let rust =
            dima_text::to_js_json(&category_questions(&categories, row[1].as_bool().unwrap()));
        assert_eq!(
            rust,
            row[2].as_str().unwrap(),
            "categoryQuestions({categories:?})"
        );
    }
    assert_eq!(
        dima_text::to_js_json(&default_spam_moderation_settings("chan-1")),
        spam["defaults"].as_str().unwrap()
    );
    assert_eq!(
        dima_text::to_js_json(&spam_rule()),
        spam["spamRule"].as_str().unwrap()
    );
    println!("spam: intended differences (ſ / Kelvin sign as word characters): {kelvin_or_long_s}");
}
