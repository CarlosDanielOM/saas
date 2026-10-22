//! Each check is compiled with its individual Cargo feature, so an umbrella
//! build cannot conceal a missing public API or an accidental sibling import.

#[cfg(feature = "command-utils")]
#[test]
fn cooldown_api_is_available_independently() {
    assert_eq!(
        dima_rust::utils::command_cooldown::minimum_command_cooldown(Some("pro")),
        1
    );
}

#[cfg(feature = "keywords")]
#[test]
fn keyword_api_is_available_independently() {
    assert_eq!(
        dima_rust::utils::keywords::normalize_keyword("  CAFÉ "),
        "café"
    );
}

#[cfg(feature = "chat-events")]
#[test]
fn chat_api_is_available_independently() {
    assert_eq!(
        dima_rust::utils::chat_events::builtin_chat_events().len(),
        8
    );
}

#[cfg(feature = "ai-usage")]
#[test]
fn usage_api_is_available_independently() {
    use dima_rust::utils::ai_usage::{AiUsageContextInput, create_ai_usage_context};
    let context = create_ai_usage_context(
        "messages",
        AiUsageContextInput {
            entry_id: Some("fixed".into()),
            ..Default::default()
        },
    );
    assert_eq!(context.request_id, "fixed");
}

#[cfg(feature = "eventsub")]
#[test]
fn eventsub_api_is_available_independently() {
    use dima_rust::utils::eventsub::{Condition, canonical_condition_json};
    assert_eq!(
        canonical_condition_json(&Condition::from([("user_id", "123")])),
        r#"{"user_id":"123"}"#
    );
}

#[cfg(feature = "domain-events")]
#[test]
fn domain_event_api_is_available_independently() {
    assert_eq!(
        dima_rust::utils::domain_events::build_domain_event_key("a", "b:c", "d").unwrap(),
        "a:b%3Ac:d"
    );
}

#[cfg(feature = "twitch-client")]
#[test]
fn twitch_api_is_available_independently() {
    use dima_rust::utils::twitch::TwitchEndpoints;
    assert_eq!(
        TwitchEndpoints::default()
            .helix_url("users", None)
            .unwrap()
            .as_str(),
        "https://api.twitch.tv/helix/users"
    );
}

#[cfg(feature = "polar-client")]
#[test]
fn polar_api_is_available_independently() {
    use dima_rust::utils::polar::{PRODUCTION_BASE_URL, PolarConfig};
    assert!(PolarConfig::new(PRODUCTION_BASE_URL, "fixture-token").is_ok());
}
