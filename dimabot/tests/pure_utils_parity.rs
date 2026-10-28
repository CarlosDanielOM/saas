#![cfg(all(
    feature = "eventsub",
    feature = "chat-message",
    feature = "reward-body"
))]

#[allow(dead_code)]
#[path = "fixtures/pure_utils_harness.rs"]
mod harness;

#[test]
fn all_pure_utility_exports_match_frozen_typescript() {
    let fixture = harness::fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(
        cases.len() > 2000,
        "source corpus must cover every public helper"
    );
    for (index, case) in cases.iter().enumerate() {
        let actual = harness::evaluate(case);
        assert!(
            harness::json_equal(&actual, &case["expected"]),
            "parity case {index}: {} input {}: actual {actual}, expected {}",
            case["operation"],
            case["input"],
            case["expected"],
        );
    }
}

#[test]
fn owned_reward_mapping_matches_borrowed_and_preserves_input() {
    use dima_rust::utils::twitch_reward_body::{
        TwitchRewardBodyMode, to_twitch_reward_body, to_twitch_reward_body_owned,
    };
    let body = serde_json::json!({"cooldown":"0x10", "maxPerStream":3.5, "userInput":null, "unknown":{"nested":[1,2,3]}}).as_object().unwrap().clone();
    let original = body.clone();
    let borrowed = to_twitch_reward_body(&body, TwitchRewardBodyMode::Update);
    let owned = to_twitch_reward_body_owned(body.clone(), TwitchRewardBodyMode::Update);
    assert_eq!(body, original);
    assert_eq!(owned, borrowed);
}
