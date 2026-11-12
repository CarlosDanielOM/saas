//! The timer policy against the TypeScript reference (`fixtures/timer_policy_cases.json`,
//! written by `fixtures/timer_policy_reference.mjs` from today's `timer_policy.ts` under Node
//! 24). Every case matches as recorded: no text rule changes a timer outcome. Also the
//! reference's own `timer_policy.test.ts`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_commands::timer_policy::{self as timer, TimerFrequencyValue};
use serde_json::{Value, json};

const CORPUS: &str = include_str!("fixtures/timer_policy_cases.json");

/// A corpus number: plain, or tagged (`$number`); `None` for anything that is not a number.
fn number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    Some(match value.get("$number")?.as_str()? {
        "NaN" => f64::NAN,
        "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        "-0" => -0.0,
        other => panic!("unknown tag {other}"),
    })
}

/// A number result, tagged the way the generator tags it.
fn tagged(number: f64) -> Value {
    if number.is_nan() {
        json!({ "$number": "NaN" })
    } else if number == f64::INFINITY {
        json!({ "$number": "+Infinity" })
    } else if number == f64::NEG_INFINITY {
        json!({ "$number": "-Infinity" })
    } else if number == 0.0 && number.is_sign_negative() {
        json!({ "$number": "-0" })
    } else {
        json!(number)
    }
}

fn same(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| same(v, w)))
        }
        _ => actual == expected,
    }
}

fn timer_value(input: &Value) -> TimerFrequencyValue<'_> {
    TimerFrequencyValue {
        frequency: number(&input["frequency"]).unwrap(),
        frequency_unit: input["frequencyUnit"].as_str(),
    }
}

fn validation(result: timer::TimerIntervalValidation) -> Value {
    let mut value = json!({ "valid": result.valid });
    if let Some(error) = result.error {
        value["error"] = json!(error);
    }
    value
}

fn run(case: &Value) -> Value {
    let input = &case["input"];
    match case["operation"].as_str().unwrap() {
        "legacy_frequency" => timer::convert_legacy_timer_frequency(number(&input["frequency"]))
            .map_or(Value::Null, tagged),
        "parse_frequency" => {
            timer::parse_timer_frequency_input(input["raw"].as_str()).map_or(Value::Null, tagged)
        }
        "interval_minutes" => tagged(timer::get_timer_interval_minutes(timer_value(input))),
        "heartbeat_minutes" => tagged(timer::get_timer_heartbeat_minutes(
            timer_value(input),
            number(&input["storedHeartbeat"]).unwrap(),
            input["heartbeatUnit"].as_str(),
        )),
        "validate_interval" => validation(timer::validate_timer_interval(
            number(&input["minutes"]).unwrap(),
            input["tier"].as_str().unwrap(),
        )),
        "validate_edit" => {
            let result = timer::validate_timer_edit_interval(
                timer_value(input),
                number(&input["requested"]),
                input["tier"].as_str().unwrap(),
            );
            let mut value = validation(result.validation);
            value["minutes"] = tagged(result.minutes);
            value
        }
        "constants" => json!({
            "unit": timer::TIMER_FREQUENCY_UNIT,
            "grandfathered": timer::MAX_GRANDFATHERED_TIMER_MINUTES,
        }),
        other => panic!("unmapped {other}"),
    }
}

#[test]
fn timer_policy_matches_the_reference() {
    let fixture: Value = serde_json::from_str(CORPUS).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(fixture["node"].as_str().unwrap().starts_with("v24."));
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let actual = run(case);
            (!same(&actual, &case["expected"])).then(|| {
                format!(
                    "{} {}: {actual} vs {}",
                    case["operation"], case["input"], case["expected"]
                )
            })
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(cases.len() >= 1_000);
}

// timer_policy.test.ts
fn minutes(frequency: f64, unit: Option<&str>) -> TimerFrequencyValue<'_> {
    TimerFrequencyValue {
        frequency,
        frequency_unit: unit,
    }
}

#[test]
fn parses_bare_numbers_minute_suffixes_and_hour_suffixes_as_minutes() {
    assert_eq!(timer::parse_timer_frequency_input(Some("7")), Some(7.0));
    assert_eq!(timer::parse_timer_frequency_input(Some("7m")), Some(7.0));
    assert_eq!(timer::parse_timer_frequency_input(Some("2h")), Some(120.0));
    assert_eq!(timer::parse_timer_frequency_input(Some("0")), None);
    assert_eq!(timer::parse_timer_frequency_input(Some("1.5h")), None);
}

#[test]
fn validates_the_free_interval_allow_list() {
    for minutes in [10.0, 20.0, 30.0, 40.0, 50.0, 60.0] {
        assert!(timer::validate_timer_interval(minutes, "free").valid);
    }
    for minutes in [0.0, 5.0, 15.0, 25.0, 45.0, 55.0, 61.0, 70.0, 10.5] {
        assert!(!timer::validate_timer_interval(minutes, "free").valid);
    }
}

#[test]
fn validates_premium_five_minute_intervals_up_to_three_hours() {
    for (minutes, valid) in [
        (5.0, true),
        (175.0, true),
        (180.0, true),
        (7.0, false),
        (185.0, false),
    ] {
        assert_eq!(
            timer::validate_timer_interval(minutes, "premium").valid,
            valid,
            "{minutes}"
        );
    }
}

#[test]
fn validates_pro_whole_minute_intervals_up_to_three_hours() {
    for (minutes, valid) in [
        (1.0, true),
        (7.0, true),
        (180.0, true),
        (181.0, false),
        (7.5, false),
    ] {
        assert_eq!(
            timer::validate_timer_interval(minutes, "pro").valid,
            valid,
            "{minutes}"
        );
    }
}

#[test]
fn normalizes_legacy_five_minute_tick_values_without_changing_minute_values() {
    assert_eq!(timer::get_timer_interval_minutes(minutes(7.0, None)), 35.0);
    assert_eq!(
        timer::get_timer_interval_minutes(minutes(7.0, Some(timer::TIMER_FREQUENCY_UNIT))),
        7.0
    );
}

#[test]
fn converts_only_valid_legacy_tick_values_during_migration() {
    assert_eq!(timer::convert_legacy_timer_frequency(Some(1.0)), Some(5.0));
    assert_eq!(
        timer::convert_legacy_timer_frequency(Some(288.0)),
        Some(1440.0)
    );
    assert_eq!(timer::convert_legacy_timer_frequency(Some(0.0)), None);
    assert_eq!(timer::convert_legacy_timer_frequency(Some(289.0)), None);
    assert_eq!(timer::convert_legacy_timer_frequency(Some(1.5)), None);
    // '12' is not a number.
    assert_eq!(timer::convert_legacy_timer_frequency(None), None);
}

#[test]
fn normalizes_legacy_heartbeat_ticks_once_while_preserving_minute_heartbeats() {
    let unit = Some(timer::TIMER_FREQUENCY_UNIT);
    assert_eq!(
        timer::get_timer_heartbeat_minutes(minutes(12.0, None), 2.0, None),
        10.0
    );
    assert_eq!(
        timer::get_timer_heartbeat_minutes(minutes(12.0, None), 2.0, unit),
        2.0
    );
    assert_eq!(
        timer::get_timer_heartbeat_minutes(minutes(60.0, unit), 2.0, None),
        2.0
    );
    assert_eq!(
        timer::get_timer_heartbeat_minutes(minutes(60.0, unit), f64::NAN, None),
        0.0
    );
}

#[test]
fn grandfathers_running_intervals_but_requires_a_valid_interval_for_edits() {
    let legacy_five_minute_timer = minutes(1.0, None);
    assert!(
        !timer::validate_timer_edit_interval(legacy_five_minute_timer, None, "free")
            .validation
            .valid
    );
    assert!(
        timer::validate_timer_edit_interval(legacy_five_minute_timer, Some(10.0), "free")
            .validation
            .valid
    );
    let downgraded_pro_timer = minutes(7.0, Some(timer::TIMER_FREQUENCY_UNIT));
    assert!(
        !timer::validate_timer_edit_interval(downgraded_pro_timer, None, "free")
            .validation
            .valid
    );
    assert!(
        timer::validate_timer_edit_interval(downgraded_pro_timer, Some(30.0), "free")
            .validation
            .valid
    );
    assert!(
        timer::validate_timer_edit_interval(minutes(2.0, None), None, "free")
            .validation
            .valid
    );
}
