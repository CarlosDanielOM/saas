#![cfg(feature = "moderation-rules")]
use dima_rust::utils::{
    js_string::JsString,
    moderation::{
        blacklist::{BlacklistRule, compile_blacklist_pattern},
        caps::{CapsRule, CapsThresholdMode},
        emote_spam::EmoteSpamRule,
        links_rule::LinksRule,
        rule_dispatcher::{ModerationRule, ModerationRuleInput, evaluate_rule},
    },
};
#[path = "support/sha256.rs"]
mod digest;

fn input<'a>(
    text: Option<&'a JsString>,
    count: Option<f64>,
    emotes: Option<&'a [JsString]>,
) -> ModerationRuleInput<'a> {
    ModerationRuleInput {
        text,
        emote_count: count,
        emote_texts: emotes,
    }
}
fn caps() -> CapsRule {
    CapsRule {
        caps_threshold_mode: CapsThresholdMode::Count,
        min_caps_count: 2.0,
        max_caps_percentage: 50.0,
        min_message_length: 1.0,
    }
}
#[test]
fn native_branches_and_utf16_detail() {
    let text = JsString::from("AAa");
    let out = evaluate_rule(
        ModerationRule::Caps(caps()),
        input(Some(&text), None, None),
        None,
    );
    assert!(out.triggered);
    assert_eq!(out.detail, JsString::from("caps=2/3 (67%)"));
    let text = JsString::from(format!("A{}", "a".repeat(199)));
    let out = evaluate_rule(
        ModerationRule::Caps(caps()),
        input(Some(&text), None, None),
        None,
    );
    assert_eq!(out.detail, JsString::from("caps=1/200 (1%)"));
    let text = JsString::from_units(
        [
            "https://".encode_utf16().collect::<Vec<_>>(),
            vec![0xd800],
            ".EXAMPLE".encode_utf16().collect(),
        ]
        .concat(),
    );
    let out = evaluate_rule(
        ModerationRule::Links(LinksRule {
            allowlist_domains: None,
        }),
        input(Some(&text), None, None),
        None,
    );
    assert!(out.triggered);
    assert_eq!(
        out.detail.units(),
        [
            "blocked url: ".encode_utf16().collect::<Vec<_>>(),
            vec![0xd800],
            ".example".encode_utf16().collect()
        ]
        .concat()
    );
    let out = evaluate_rule(
        ModerationRule::EmoteSpam(EmoteSpamRule {
            max_emote_count: -0.0,
        }),
        input(None, Some(f64::INFINITY), None),
        None,
    );
    assert!(out.triggered);
    assert_eq!(out.detail, JsString::from("emotes=Infinity/0"));
    let rule = BlacklistRule::default();
    let pattern = compile_blacklist_pattern(Some(&[JsString::from("cafe")])).unwrap();
    let text = JsString::from("CAFÉ");
    let out = evaluate_rule(
        ModerationRule::Blacklist(&rule),
        input(Some(&text), None, None),
        Some(&pattern),
    );
    assert!(out.triggered);
    assert_eq!(out.detail, JsString::from("matched blacklisted term"));
    let out = evaluate_rule(
        ModerationRule::Blacklist(&rule),
        input(Some(&text), None, None),
        None,
    );
    assert!(!out.triggered);
    assert_eq!(out.detail, JsString::from("no match"));
    let out = evaluate_rule(ModerationRule::Unknown, input(None, None, None), None);
    assert!(!out.triggered);
    assert_eq!(out.detail, JsString::from("unknown rule type"));
}
fn units(value: &serde_json::Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
fn strings(value: &serde_json::Value) -> Vec<JsString> {
    value.as_array().unwrap().iter().map(units).collect()
}
fn number(value: &serde_json::Value) -> f64 {
    f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
}
#[test]
#[ignore = "requires independently hash-pinned actual TypeScript fixture"]
fn replay_actual_dispatcher() {
    use std::path::PathBuf;
    let dir = PathBuf::from(
        std::env::var_os("DIMA_RULE_DISPATCHER_FIXTURE_DIR").expect("external fixture directory"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    assert!(!dir.starts_with(workspace));
    let expected =
        std::env::var("DIMA_RULE_DISPATCHER_FIXTURE_SHA256").expect("independent fixture SHA-256");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join("moderation-rule-dispatcher-reference.json")).unwrap();
    assert_eq!(digest::sha256_hex(&bytes), expected);
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let meta = &fixture["metadata"];
    assert_eq!(meta["format"], 1);
    assert_eq!(
        meta["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, value) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(meta["versions"][key], value);
    }
    for (key, bytes, pin) in [
        ("dimabot/src/utils/moderation/rules/index.ts", include_bytes!("../src/utils/moderation/rules/index.ts").as_slice(), "39e93288c898eaa68826ec2f011d2ea3fc326d5993293815c3df588552a65d08"),
        ("dimabot/src/utils/moderation/rules/links.rule.ts", include_bytes!("../src/utils/moderation/rules/links.rule.ts").as_slice(), "802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0"),
        ("dimabot/src/utils/moderation/rules/blacklist.rule.ts", include_bytes!("../src/utils/moderation/rules/blacklist.rule.ts").as_slice(), "8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff"),
        ("dimabot/src/utils/moderation/normalize.ts", include_bytes!("../src/utils/moderation/normalize.ts").as_slice(), "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab"),
        ("dimabot/src/schemas/channel_moderation_settings.schema.ts", include_bytes!("../src/schemas/channel_moderation_settings.schema.ts").as_slice(), "e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653"),
        ("archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/caps.rule.ts", include_bytes!("../../archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/caps.rule.ts").as_slice(), "62f7fe37760cbf5640544cab646a639d06b42883532657634a00e25488888797"),
        ("archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/emote_spam.rule.ts", include_bytes!("../../archives/dimabot-typescript/2026-10-28/src/utils/moderation/rules/emote_spam.rule.ts").as_slice(), "24e7c603569d1063642575372de1066e4f5d5d5de46c88e15e450a549c17f12f"),
    ] { assert_eq!(digest::sha256_hex(bytes), pin); assert_eq!(meta["pins"][key], pin); }
    for (key, bytes) in [
        (
            "dimabot/src/utils/moderation/rule_dispatcher.rs",
            include_bytes!("../src/utils/moderation/rule_dispatcher.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/moderation/caps.rs",
            include_bytes!("../src/utils/moderation/caps.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/moderation/links_rule.rs",
            include_bytes!("../src/utils/moderation/links_rule.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/moderation/emote_spam.rs",
            include_bytes!("../src/utils/moderation/emote_spam.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/moderation/blacklist.rs",
            include_bytes!("../src/utils/moderation/blacklist.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/moderation/normalize.rs",
            include_bytes!("../src/utils/moderation/normalize.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/json_number.rs",
            include_bytes!("../src/utils/json_number.rs").as_slice(),
        ),
        (
            "dimabot/src/utils/js_string.rs",
            include_bytes!("../src/utils/js_string.rs").as_slice(),
        ),
        (
            "dimabot/tests/moderation_rule_dispatcher.rs",
            include_bytes!("moderation_rule_dispatcher.rs").as_slice(),
        ),
        (
            "dimabot/tests/fixtures/moderation_rule_dispatcher_reference.cjs",
            include_bytes!("fixtures/moderation_rule_dispatcher_reference.cjs").as_slice(),
        ),
    ] {
        assert_eq!(meta["hashes"][key], digest::sha256_hex(bytes));
    }
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let text = (!c["text"].is_null()).then(|| units(&c["text"]));
        let emotes = strings(&c["emotes"]);
        let domains = strings(&c["allowlist"]);
        let terms = strings(&c["terms"]);
        let blacklist = BlacklistRule {
            terms: terms.clone(),
        };
        let pattern = if c["pattern"] == "compiled" {
            compile_blacklist_pattern(Some(&terms))
        } else {
            None
        };
        let rule = match c["type"].as_str().unwrap() {
            "caps" => ModerationRule::Caps(CapsRule {
                caps_threshold_mode: if c["mode"] == "percentage" {
                    CapsThresholdMode::Percentage
                } else {
                    CapsThresholdMode::Count
                },
                min_caps_count: number(&c["minCaps"]),
                max_caps_percentage: number(&c["maxCaps"]),
                min_message_length: number(&c["minLength"]),
            }),
            "links" => ModerationRule::Links(LinksRule {
                allowlist_domains: Some(&domains),
            }),
            "emote_spam" => ModerationRule::EmoteSpam(EmoteSpamRule {
                max_emote_count: number(&c["maxEmotes"]),
            }),
            "blacklist" => ModerationRule::Blacklist(&blacklist),
            _ => ModerationRule::Unknown,
        };
        let result = evaluate_rule(
            rule,
            input(text.as_ref(), Some(number(&c["count"])), Some(&emotes)),
            pattern.as_ref(),
        );
        assert_eq!(
            result.triggered,
            c["triggered"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
        assert_eq!(result.detail, units(&c["detail"]), "{}", c["name"]);
    }
}
