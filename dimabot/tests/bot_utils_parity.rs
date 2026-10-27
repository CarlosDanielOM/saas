//! Golden outputs generated from the actual TypeScript helpers. This suite
//! deliberately calls the public library API, as a future consumer would.
#![cfg(feature = "bot-utils")]

use dima_rust::utils::{
    ai_usage, chat_events, command_cooldown, domain_events, eventsub, keywords,
};
use serde_json::{Value, json};

fn evaluate(case: &Value) -> Result<Value, String> {
    let input = &case["input"];
    let text = |field: &str| input[field].as_str().expect("fixture string");
    let operation = case["operation"].as_str().expect("operation");
    Ok(match operation {
        "minimum_cooldown" => json!(command_cooldown::minimum_command_cooldown(
            input["plan"].as_str()
        )),
        "normalize_keyword" => json!(keywords::normalize_keyword(text("text"))),
        "validate_keyword" => {
            let mode = keywords::validate_keyword(&input["text"], &input["settings"])
                .map_err(|error| error.to_string())?;
            json!({ "matchMode": mode })
        }
        "match_keywords" => {
            let entries: Vec<keywords::KeywordEntry> =
                serde_json::from_value(input["entries"].clone()).unwrap();
            let index = keywords::compile_keyword_index(entries);
            json!(keywords::match_keywords(&index, text("message")))
        }
        "chat_message" => json!(chat_events::resolve_chat_notification_message(
            &input["notice"],
            &input["config"],
            if text("language") == "es" {
                chat_events::Language::Es
            } else {
                chat_events::Language::En
            },
        )),
        "chat_catalog" => json!(chat_events::with_builtin_chat_events(
            input["existing"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )),
        "usage_context" | "usage_metadata" => {
            let context = ai_usage::create_ai_usage_context(
                text("reason"),
                serde_json::from_value(input["input"].clone()).unwrap(),
            );
            if operation == "usage_context" {
                json!(context)
            } else {
                json!(ai_usage::to_polar_usage_metadata(&context))
            }
        }
        "classify_adjustment" => json!(ai_usage::classify_adjustment(input)),
        other => return evaluate_event_case(other, input),
    })
}

fn evaluate_event_case(operation: &str, input: &Value) -> Result<Value, String> {
    fn condition(value: &Value) -> eventsub::Condition {
        eventsub::Condition::from_pairs(value.as_object().unwrap().iter().filter_map(
            |(key, value)| {
                if value.is_null() {
                    None
                } else {
                    Some((
                        key.clone(),
                        value.as_str().expect("legal flat condition").to_owned(),
                    ))
                }
            },
        ))
    }
    Ok(match operation {
        "expected_condition" => {
            let result = eventsub::build_expected_condition(
                input["subscription"]["type"].as_str().unwrap(),
                &condition(&input["subscription"]["condition"]),
                input["channelID"].as_str().unwrap(),
            );
            Value::Object(
                result
                    .iter()
                    .map(|(key, value)| (key.to_owned(), json!(value)))
                    .collect(),
            )
        }
        "circuit_breaker" => json!(eventsub::should_trip_circuit_breaker_with(
            input["total"].as_u64().unwrap() as usize,
            input["unhealthy"].as_u64().unwrap() as usize,
            input["ratio"].as_f64().unwrap(),
            input["minimum"].as_u64().unwrap() as usize,
        )),
        "raid_direction" => json!(eventsub::raid_direction(&condition(input)).as_str()),
        "serialize_condition" | "stable_condition" => {
            json!(eventsub::canonical_condition_json(&condition(input)))
        }
        "domain_envelope" => json!(domain_events::project_envelope(input.as_object().unwrap())),
        "domain_event_key" => json!(
            domain_events::build_domain_event_key(
                input["source"].as_str().unwrap(),
                input["sourceEventId"].as_str().unwrap(),
                input["type"].as_str().unwrap(),
            )
            .map_err(|error| error.to_string())?
        ),
        other => return Err(format!("Unmapped event operation: {other}")),
    })
}

#[test]
fn public_utilities_match_typescript_golden_outputs() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/bot_utils_parity.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        130,
        "regenerate and review the entire parity corpus"
    );
    for (index, case) in cases.iter().enumerate() {
        let actual = evaluate(case);
        let expected = if let Some(error) = case.get("error") {
            Err(error.as_str().unwrap().to_owned())
        } else {
            Ok(case["expected"].clone())
        };
        assert_eq!(
            actual, expected,
            "parity case {index}: {} with {}",
            case["operation"], case["input"]
        );
    }
}
