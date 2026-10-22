#![cfg(feature = "eventsub")]

//! Source-backed fixtures for [`dima_rust::utils::eventsub`].
//!
//! The condition expectations are ported from
//! `dimabot/src/utils/eventsub_reconciliation.test.ts`; the raid-direction and
//! canonical-serialization cases come from `raid_direction.ts`,
//! `eventsub.ts` `serializeCondition`, and `eventsub_reconciliation.ts`
//! `stableCondition` / `subscriptionKey`.

use dima_rust::utils::eventsub::{
    Condition, OUTGOING_RAID_EVENT, RAID_EVENT_TYPE, RaidDirection, build_expected_condition,
    canonical_condition_json, conditions_equal, is_raid_event, raid_condition, raid_config_type,
    raid_direction, should_trip_circuit_breaker, should_trip_circuit_breaker_with,
    subscription_key,
};

#[test]
fn builds_channel_specific_conditions_without_replacing_bot_identities() {
    let chat = Condition::from([
        ("broadcaster_user_id", "template"),
        ("user_id", "698614112"),
    ]);
    let follow = Condition::from([
        ("broadcaster_user_id", "template"),
        ("moderator_user_id", "698614112"),
    ]);
    let raid = Condition::from([("to_broadcaster_user_id", "template")]);
    let user_update = Condition::from([("user_id", "template")]);

    assert_eq!(
        build_expected_condition("channel.chat.message", &chat, "channel-1"),
        Condition::from([
            ("broadcaster_user_id", "channel-1"),
            ("user_id", "698614112"),
        ])
    );
    assert_eq!(
        build_expected_condition("channel.follow", &follow, "channel-1"),
        Condition::from([
            ("broadcaster_user_id", "channel-1"),
            ("moderator_user_id", "698614112"),
        ])
    );
    assert_eq!(
        build_expected_condition(RAID_EVENT_TYPE, &raid, "channel-1"),
        Condition::from([("to_broadcaster_user_id", "channel-1")])
    );
    let expected_update = build_expected_condition("user.update", &user_update, "channel-1");
    assert_eq!(expected_update, Condition::from([("user_id", "channel-1")]));
    assert!(
        expected_update.get("broadcaster_user_id").is_none(),
        "user.update must not gain a broadcaster field"
    );
}

#[test]
fn keeps_raid_direction_from_the_template() {
    let outgoing_template = Condition::from([("from_broadcaster_user_id", "template")]);
    assert_eq!(
        build_expected_condition(RAID_EVENT_TYPE, &outgoing_template, "channel-1"),
        Condition::from([("from_broadcaster_user_id", "channel-1")])
    );

    let both = Condition::from([
        ("from_broadcaster_user_id", "template"),
        ("to_broadcaster_user_id", "template"),
    ]);
    assert_eq!(
        build_expected_condition(RAID_EVENT_TYPE, &both, "channel-1"),
        Condition::from([("from_broadcaster_user_id", "channel-1")])
    );

    let empty_from = Condition::from([
        ("from_broadcaster_user_id", ""),
        ("to_broadcaster_user_id", "template"),
    ]);
    assert_eq!(
        build_expected_condition(RAID_EVENT_TYPE, &empty_from, "channel-1"),
        Condition::from([("to_broadcaster_user_id", "channel-1")])
    );
}

#[test]
fn derives_raid_direction_with_empty_strings_as_unset() {
    assert_eq!(
        raid_direction(&Condition::from([("from_broadcaster_user_id", "x")])),
        RaidDirection::Outgoing
    );
    assert_eq!(
        raid_direction(&Condition::from([("to_broadcaster_user_id", "x")])),
        RaidDirection::Incoming
    );
    assert_eq!(
        raid_direction(&Condition::from([
            ("from_broadcaster_user_id", "x"),
            ("to_broadcaster_user_id", "y"),
        ])),
        RaidDirection::Incoming
    );
    assert_eq!(
        raid_direction(&Condition::from([
            ("from_broadcaster_user_id", "x"),
            ("to_broadcaster_user_id", ""),
        ])),
        RaidDirection::Outgoing
    );
    assert_eq!(
        raid_direction(&Condition::from([
            ("from_broadcaster_user_id", ""),
            ("to_broadcaster_user_id", "y"),
        ])),
        RaidDirection::Incoming
    );
    assert_eq!(raid_direction(&Condition::new()), RaidDirection::Incoming);
}

#[test]
fn maps_only_outgoing_raids_to_the_synthetic_config_type() {
    let outgoing = raid_condition("channel-1", RaidDirection::Outgoing);
    let incoming = raid_condition("channel-1", RaidDirection::Incoming);
    assert_eq!(
        raid_config_type(RAID_EVENT_TYPE, &outgoing),
        OUTGOING_RAID_EVENT
    );
    assert_eq!(
        raid_config_type(RAID_EVENT_TYPE, &incoming),
        RAID_EVENT_TYPE
    );
    assert_eq!(
        raid_config_type("channel.follow", &outgoing),
        "channel.follow"
    );
    assert!(is_raid_event(RAID_EVENT_TYPE));
    assert!(is_raid_event(OUTGOING_RAID_EVENT));
    assert!(!is_raid_event("channel.follow"));
}

#[test]
fn trips_the_circuit_breaker_only_for_bulk_unhealthy_subscriptions() {
    assert!(should_trip_circuit_breaker(20, 6));
    assert!(!should_trip_circuit_breaker(20, 4));
    assert!(!should_trip_circuit_breaker(100, 10));
    assert!(!should_trip_circuit_breaker(0, 0));

    // Strict `>`: exactly at the ratio does not trip.
    assert!(!should_trip_circuit_breaker_with(20, 5, 0.25, 5));
    // Minimum count is raised to at least one.
    assert!(!should_trip_circuit_breaker_with(4, 4, 0.25, 5));
    assert!(should_trip_circuit_breaker_with(2, 1, 0.25, 0));
    // Ratio is clamped to 0..=1; NaN never trips.
    assert!(should_trip_circuit_breaker_with(10, 5, 0.0, 5));
    assert!(!should_trip_circuit_breaker_with(10, 5, 5.0, 5));
    assert!(!should_trip_circuit_breaker_with(10, 5, f64::NAN, 5));
}

#[test]
fn canonical_serialization_filters_empty_fields_and_sorts_keys() {
    assert_eq!(canonical_condition_json(&Condition::new()), "{}");
    assert_eq!(
        canonical_condition_json(&Condition::from([
            ("user_id", ""),
            ("broadcaster_user_id", "channel-1"),
        ])),
        r#"{"broadcaster_user_id":"channel-1"}"#
    );
    assert_eq!(
        canonical_condition_json(&Condition::from([
            ("user_id", "698614112"),
            ("broadcaster_user_id", "channel-1"),
        ])),
        r#"{"broadcaster_user_id":"channel-1","user_id":"698614112"}"#
    );
    assert_eq!(
        canonical_condition_json(&Condition::from([
            ("broadcaster_user_id", "channel-1"),
            ("user_id", "698614112"),
        ])),
        r#"{"broadcaster_user_id":"channel-1","user_id":"698614112"}"#
    );
}

#[test]
fn condition_equality_ignores_field_order_and_empty_fields() {
    let left = Condition::from([
        ("broadcaster_user_id", "channel-1"),
        ("to_broadcaster_user_id", ""),
    ]);
    let right = Condition::from([("broadcaster_user_id", "channel-1")]);
    assert!(conditions_equal(&left, &right));
    assert!(!conditions_equal(
        &left,
        &Condition::from([("broadcaster_user_id", "channel-2")])
    ));
}

#[test]
fn subscription_keys_match_the_reconciliation_shape() {
    assert_eq!(
        subscription_key(
            RAID_EVENT_TYPE,
            "1",
            &Condition::from([("to_broadcaster_user_id", "channel-1")])
        ),
        r#"channel.raid:1:{"to_broadcaster_user_id":"channel-1"}"#
    );
    assert_eq!(
        subscription_key("user.update", "1", &Condition::new()),
        "user.update:1:{}"
    );
}
