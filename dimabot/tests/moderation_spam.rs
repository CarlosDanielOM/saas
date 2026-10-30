#![cfg(feature = "moderation-spam")]
use dima_rust::utils::{js_string::JsString, lossless_json::JsonValue, moderation::spam::*};

#[test]
fn invitation_boundaries_and_javascript_whitespace() {
    fn check(s: JsString) -> bool {
        broadcaster_invited_promotion(&[ContextMessage {
            is_broadcaster: true,
            message: s,
        }])
    }
    assert!(check("Share\u{a0}your channel links".into()));
    assert!(check("compartan sus canales".into()));
    assert!(!check("never share your channel".into()));
    assert!(!check("ſshare your channel".into()));
    assert!(!check("share your channelK".into()));
    assert!(!check("share\u{85}your channel".into()));
    assert!(check("share\u{feff}your channel".into()));
    assert!(check("don’t share channel".into()));
    assert!(!check("don't share channel".into()));
    assert!(check("😀 share channel 😀".into()));
    assert!(check(JsString::from_units(vec![
        0xd800, 0x20, 0x73, 0x68, 0x61, 0x72, 0x65, 0x20, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c
    ])));
    assert!(!broadcaster_invited_promotion(&[ContextMessage {
        is_broadcaster: false,
        message: "share channel".into()
    }]));
}
#[test]
fn strict_boolean_and_nullish_settings() {
    let settings = JsonValue::Object(vec![(
        "spamProtection".into(),
        JsonValue::Object(vec![
            ("enabled".into(), JsonValue::Number(0.0)),
            ("categories".into(), JsonValue::Array(vec![])),
            ("thresholdPercent".into(), JsonValue::Null),
        ]),
    )]);
    let p = spam_protection_settings_value(&settings).unwrap();
    assert_eq!(p.get("enabled"), Some(&JsonValue::Bool(true)));
    assert_eq!(p.get("thresholdPercent"), Some(&JsonValue::Number(85.0)));
    assert_eq!(
        spam_review_source_value(true, &settings, None).unwrap(),
        None
    );
}
#[test]
fn version_and_default_review_policy() {
    let settings = default_spam_moderation_settings("c".into());
    let mut d = DecisionView {
        rule_id: SPAM_RULE_ID.into(),
        review_source: Some("first_message".into()),
        settings_version: 0.0,
    };
    assert!(semantic_policy_active(Some(&settings), &d));
    d.settings_version = 1.0;
    assert!(!semantic_policy_active(Some(&settings), &d));
    assert_eq!(
        spam_review_source(true, &settings, None),
        Some("first_message")
    );
}

#[test]
fn ordinary_json_context_coercion_and_short_circuit() {
    use dima_rust::utils::lossless_json::parse_json;
    let check = |text: &str| broadcaster_invited_promotion_value(&parse_json(text).unwrap());
    assert_eq!(
        check(r#"[{"isBroadcaster":true,"message":["share channel"]}]"#),
        Ok(true)
    );
    assert_eq!(
        check(r#"[{"isBroadcaster":true,"message":null}]"#),
        Ok(false)
    );
    assert_eq!(
        check(r#"[{"isBroadcaster":true,"message":{"toString":null}}]"#),
        Err("Cannot convert object to primitive value")
    );
    assert_eq!(
        check(r#"[{"isBroadcaster":false,"message":{"toString":null}}]"#),
        Ok(false)
    );
    assert_eq!(
        check(r#"[{"isBroadcaster":true,"message":"share channel"},null]"#),
        Ok(true)
    );
    assert_eq!(check(r#"[null]"#), Err("cannot read isBroadcaster of null"));
}
#[test]
fn borrowed_views_reuse_template_and_base_fields() {
    let a = spam_rule_view(&[], None);
    let b = spam_rule_view(&[], None);
    assert!(std::ptr::eq(a.template, b.template));
    assert!(std::ptr::eq(a.examples().as_ptr(), b.examples().as_ptr()));
    let first = spam_rule();
    let second = spam_rule();
    assert!(std::sync::Arc::ptr_eq(&first.terms, &second.terms));
    assert!(std::sync::Arc::ptr_eq(
        &first.first_offense,
        &second.first_offense
    ));
}
#[test]
fn budget_lua_matches_exact_source() {
    let ts = include_str!("../src/utils/moderation/spam.ts");
    let source = ts
        .split("cache.eval(`")
        .nth(1)
        .unwrap()
        .split('`')
        .next()
        .unwrap();
    assert_eq!(BUDGET_LUA, source);
}

#[test]
fn template_value_uses_typed_base_and_context_overrides_only() {
    use dima_rust::schemas::channel_moderation_settings::MODERATION_RULE_DEFAULTS;
    use dima_rust::utils::lossless_json::parse_json;
    let template = spam_rule_template();
    let base = spam_rule_template_value();
    assert_eq!(
        base.get("enabled"),
        Some(&JsonValue::Bool(template.enabled))
    );
    assert_eq!(
        base.get("reason"),
        Some(&JsonValue::String(template.reason.clone()))
    );
    for (key, actual, default) in [
        (
            "exemptUserLevel",
            template.exempt_user_level,
            MODERATION_RULE_DEFAULTS.exempt_user_level,
        ),
        (
            "minCapsCount",
            template.min_caps_count,
            MODERATION_RULE_DEFAULTS.min_caps_count,
        ),
        (
            "maxCapsPercentage",
            template.max_caps_percentage,
            MODERATION_RULE_DEFAULTS.max_caps_percentage,
        ),
        (
            "minMessageLength",
            template.min_message_length,
            MODERATION_RULE_DEFAULTS.min_message_length,
        ),
        (
            "maxEmoteCount",
            template.max_emote_count,
            MODERATION_RULE_DEFAULTS.max_emote_count,
        ),
    ] {
        assert_eq!(base.get(key), Some(&JsonValue::Number(actual)));
        assert_eq!(actual, default);
    }
    for (key, step) in [
        ("firstOffense", &template.first_offense),
        ("secondOffense", &template.second_offense),
        ("thirdOffense", &template.third_offense),
    ] {
        let step = step.lock().unwrap_or_else(|e| e.into_inner());
        let value = base.get(key).unwrap();
        assert_eq!(
            value.get("timeoutSeconds"),
            Some(&JsonValue::Number(step.timeout_seconds))
        );
        assert_eq!(value.get("action"), Some(&JsonValue::String("ban".into())));
    }
    for (key, items) in [
        ("terms", &template.terms),
        ("allowlistDomains", &template.allowlist_domains),
    ] {
        let expected = JsonValue::Array(
            items
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .cloned()
                .map(JsonValue::String)
                .collect(),
        );
        assert_eq!(base.get(key), Some(&expected));
    }
    let semantic = base.get("semantic").unwrap();
    assert!(semantic.get("broadcasterInvitation").is_none());
    assert!(base.get("exemptExpression").is_none());
    let settings = parse_json(r#"{"spamProtection":{"categories":["insults","unknown"],"thresholdPercent":91,"exemptTags":[]}}"#).unwrap();
    let context = [ContextMessage {
        is_broadcaster: true,
        message: "share your channel".into(),
    }];
    let contextual = spam_rule_for_context_value(&context, &settings).unwrap();
    for key in [
        "enabled",
        "firstOffense",
        "secondOffense",
        "thirdOffense",
        "reason",
        "exemptUserLevel",
        "capsThresholdMode",
        "minCapsCount",
        "maxCapsPercentage",
        "minMessageLength",
        "allowlistDomains",
        "maxEmoteCount",
        "terms",
        "id",
        "type",
    ] {
        assert_eq!(contextual.get(key), base.get(key), "{key}");
    }
    let result = contextual.get("semantic").unwrap();
    assert_eq!(result.get("examples"), semantic.get("examples"));
    assert_eq!(result.get("enabled"), semantic.get("enabled"));
    assert_eq!(
        result.get("categories"),
        Some(&parse_json(r#"["insults","unknown"]"#).unwrap())
    );
    assert_eq!(
        result.get("thresholdPercent"),
        Some(&JsonValue::Number(91.0))
    );
    assert_eq!(
        result.get("broadcasterInvitation"),
        Some(&JsonValue::Bool(true))
    );
    assert_eq!(
        result.get("policy"),
        Some(&JsonValue::String(INVITED_POLICY.into()))
    );
    assert_eq!(
        contextual.get("exemptExpression"),
        Some(&parse_json(r#"{"not":{"role":"everyone"}}"#).unwrap())
    );
}
