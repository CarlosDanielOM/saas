#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use dima_ai::qdrant::*;
use serde_json::{Value, json};
#[test]
fn public_helpers_match_independent_typescript_folder_oracle() {
    let fixture: Value =
        serde_json::from_str(include_str!("qdrant_folder_reference.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 90);
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let actual = match case["operation"].as_str().unwrap() {
            "point_id" => json!(generate_qdrant_point_id(
                input[0].as_str().unwrap(),
                input[1].as_str().unwrap(),
                input[2].as_f64().unwrap()
            )),
            "memory_owner" => json!(qdrant_point_belongs_to_memory(
                Some(&input["payload"]),
                input["memoryID"].as_str().unwrap(),
                input["channelID"].as_str().unwrap()
            )),
            "passive_relevant" => json!(is_passive_memory_relevant(
                input["query"].as_str().unwrap(),
                input["summary"].as_str().unwrap(),
                input["score"].as_f64().unwrap()
            )),
            "semantic_limit" => json!(get_semantic_memory_limit_for_tier(
                input["tier"].as_str().unwrap()
            )),
            "semantic_select" => serde_json::to_value(select_semantic_chat_items(
                input["channelID"].as_str().unwrap(),
                input["points"].as_array().unwrap(),
                input["threshold"].as_f64().unwrap(),
                input["limit"].as_u64().unwrap() as usize,
            ))
            .unwrap(),
            "memory_parse" => serde_json::to_value(parse_memory_point(&input["point"])).unwrap(),
            "window_parse" => {
                serde_json::to_value(parse_chat_window_point(&input["point"])).unwrap()
            }
            "embedding_input" => json!(build_memory_embedding_input(
                input["summary"].as_str().unwrap(),
                input["content"].as_str().unwrap()
            )),
            "collection" => serde_json::to_value(if input["kind"] == "chat" {
                twitch_chat_logs_collection()
            } else {
                twitch_channel_memories_collection()
            })
            .unwrap(),
            operation => panic!("unknown oracle operation {operation}"),
        };
        // Our minimum counts scalars: the JS oracle reruns after filtering messages
        // shorter than three scalars, so later matches still fill the requested limit.
        let expected = if case["operation"] == "semantic_select" {
            &case["expected_scalar"]
        } else {
            &case["expected"]
        };
        assert_json_parity(
            &actual,
            expected,
            &format!("case {index}: {}", case["operation"]),
        );
    }
}
fn assert_json_parity(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json_parity(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: {actual} != {expected}");
            for (key, b) in b {
                assert_json_parity(
                    a.get(key).unwrap_or_else(|| panic!("{path}.{key} missing")),
                    b,
                    &format!("{path}.{key}"),
                );
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
