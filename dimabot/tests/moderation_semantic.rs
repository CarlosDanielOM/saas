#![cfg(feature = "moderation-semantic")]
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    moderation::{
        semantic::{
            SemanticDecision, moderation_model_for_account, parse_semantic_response,
            parse_spam_response, semantic_price, semantic_request,
        },
        spam_categories::SpamCategory,
    },
};

#[test]
fn pricing_model_and_response_edges() {
    assert_eq!(
        moderation_model_for_account(Some(&JsonValue::String("premium".into())), true),
        "typesafe/jev-1.13"
    );
    assert_eq!(moderation_model_for_account(None, true), "respan/span-01");
    assert_eq!(semantic_price(1_000_000.0).billable_cost_usd, 0.042);
    let raw = parse_json(r#"{"answers":{"violation":{"type":"noul","noul":0.85}},"usage":{"input_tokens":-0,"cost":-0},"model":"m","provider":"p","id":"x"}"#).unwrap();
    let r = parse_semantic_response(&raw, 85.0);
    assert_eq!(
        (r.verdict, r.status.as_str().unwrap()),
        ("violation", "completed")
    );
    assert_eq!(r.input_tokens.to_bits(), (-0.0_f64).to_bits());
    assert_eq!(r.cost.to_bits(), (-0.0_f64).to_bits());
    assert_eq!(
        parse_semantic_response(&JsonValue::Null, f64::NAN)
            .status
            .as_str(),
        Some("invalid_configuration")
    );
    assert_eq!(
        parse_spam_response(&JsonValue::Null, &[SpamCategory::Spam], f64::NAN)
            .status
            .as_str(),
        Some("invalid_response")
    );
    let bad = parse_json(r#"{"answers":{"violation":{"type":"noul","noul":1}},"usage":{"input_tokens":9007199254740992,"cost":0}}"#).unwrap();
    assert_eq!(
        parse_semantic_response(&bad, 85.0).status.as_str(),
        Some("invalid_response")
    );
}
#[test]
fn spam_safe_veto_ties_and_utf16_truncation() {
    let raw = parse_json(r#"{"answers":{"spam":{"type":"noul","noul":0.9},"unsafe":{"type":"noul","noul":0.1}},"usage":{"input_tokens":1,"cost":0},"model":"m"}"#).unwrap();
    let tie = parse_spam_response(&raw, &[SpamCategory::Spam], 85.0);
    assert_eq!(tie.verdict, "uncertain");
    assert_eq!(
        tie.scores
            .unwrap()
            .iter()
            .map(|(k, _)| k.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["spam", "safe", "violation"]
    );
    let model = format!("{}😀", "x".repeat(149));
    let raw = parse_json(&format!(r#"{{"answers":{{"violation":{{"type":"noul","noul":0}}}},"usage":{{"input_tokens":1,"cost":0}},"model":{}}}"#, JsonValue::String(model.into()).to_json_string())).unwrap();
    assert_eq!(
        parse_semantic_response(&raw, 85.0).model.units().last(),
        Some(&0xd83d)
    );
}
#[test]
fn request_preserves_context_examples_and_empty_category_branch() {
    let sem =
        parse_json(r#"{"policy":"p","examples":[{"message":"\ud800","label":"allow"}]}"#).unwrap();
    let id: JsString = "rule".into();
    let text: JsString = "target".into();
    let user: JsString = "author".into();
    let context = vec![parse_json(r#"{"extra":"\udc00","text":"x"}"#).unwrap()];
    let matches = vec![parse_json(r#"{"z":1,"a":2}"#).unwrap()];
    let mut decision = SemanticDecision {
        rule_id: &id,
        semantic: Some(&sem),
        message_text: &text,
        username: &user,
        context: &context,
        matches: &matches,
        channel_id: None,
        deadline_ms: 0.0,
    };
    let request = semantic_request(&decision, None).unwrap();
    let wire = request.to_json_string();
    assert!(wire.contains(r#"Policy examples: [{\"message\":\"\\ud800\""#));
    assert!(wire.contains(r#"\\udc00"#));
    let spam_id: JsString = "builtin-spam-protection".into();
    let spam = parse_json(r#"{"categories":[]}"#).unwrap();
    decision.rule_id = &spam_id;
    decision.semantic = Some(&spam);
    let request = semantic_request(&decision, None).unwrap();
    assert_eq!(
        request.get("model"),
        Some(&JsonValue::String("typesafe/jev-1.13".into()))
    );
    assert!(matches!(request.get("state"), Some(JsonValue::Object(_))));
    assert_eq!(
        parse_spam_response(&JsonValue::Null, &[], 85.0)
            .status
            .as_str(),
        Some("invalid_response")
    );
}
