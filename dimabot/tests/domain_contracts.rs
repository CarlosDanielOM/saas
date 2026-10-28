#![cfg(feature = "domain-events")]

use dima_rust::domain_event_contracts::{
    self as native, ContractMode, DomainEventDeliveryPolicy, DomainEventPolicyEvent,
    NativeRetainedContract,
};
use serde_json::{Value, json};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/domain_contracts_cases.json")).unwrap()
}

fn case_input(case: &Value) -> Value {
    let mut input = case["input"].clone();
    if let Some(repeat) = case.get("repeat") {
        input[repeat["field"].as_str().unwrap()] = Value::String(
            repeat["character"]
                .as_str()
                .unwrap()
                .repeat(repeat["count"].as_u64().unwrap() as usize),
        );
    }
    input
}

fn native_record(value: &Value) -> NativeRetainedContract {
    let id: Vec<u8> = value["objectId"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u8)
        .collect();
    NativeRetainedContract {
        object_id: id.try_into().unwrap(),
        occurred_at_millis: value["occurredAtMillis"].as_i64().unwrap(),
        journaled_at_millis: value["journaledAtMillis"].as_i64().unwrap(),
        expires_at_millis: value["expiresAtMillis"].as_i64().unwrap(),
    }
}

fn time(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_str)
        .and_then(native::time::parse_contract_time)
}

fn policy_event(value: &Value) -> DomainEventPolicyEvent {
    DomainEventPolicyEvent {
        schema_version: value["schemaVersion"].as_f64().unwrap(),
        occurred_at_millis: time(value.get("occurredAt")),
        journaled_at_millis: value.get("journaledAt").map(|value| time(Some(value))),
        expires_at_millis: time(value.get("expiresAt")),
    }
}

fn execute(case: &Value, input: &Value) -> Value {
    match case["operation"].as_str().unwrap() {
        "contract" => {
            let result = if let Some(record) = case.get("native") {
                native::validate_native_retained_contract(input, &native_record(record))
            } else {
                native::validate_domain_event_contract(
                    input,
                    if case["mode"] == "ingest" {
                        ContractMode::Ingest
                    } else {
                        ContractMode::Retained
                    },
                )
            };
            match result {
                Ok(()) => json!({"ok":true}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            }
        }
        "serialize" => match native::serialize_domain_event_provider_data(input) {
            Ok(result) if case["expected"]["resultEqualsInput"] == true => {
                json!({"ok":true,"resultEqualsInput": result == *input})
            }
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        },
        "interaction" => match native::interaction::parse_interaction(
            case["type"].as_str().unwrap(),
            input.as_object().unwrap(),
            case.get("occurredAt")
                .and_then(Value::as_str)
                .unwrap_or("2026-09-05T12:00:00.000Z"),
            case.get("receipt")
                .and_then(Value::as_str)
                .unwrap_or("receipt"),
        ) {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => json!({"ok":false,"error":error.message}),
        },
        "reduce" => {
            let current = if input["current"].is_null() {
                None
            } else {
                Some(serde_json::from_value(input["current"].clone()).unwrap())
            };
            let next = serde_json::from_value(input["next"].clone()).unwrap();
            json!({"ok":true,"result":native::interaction::reduce_interaction(current.as_ref(),next)})
        }
        "policy" => {
            let policy: DomainEventDeliveryPolicy =
                serde_json::from_value(input["policy"].clone()).unwrap();
            json!({"ok":true,"result":native::evaluate_domain_event_delivery_policy(&policy,&policy_event(&input["event"]),input["now"].as_i64().unwrap())})
        }
        "replay" => {
            let policy: Option<DomainEventDeliveryPolicy> = input
                .get("policy")
                .map(|p| serde_json::from_value(p.clone()).unwrap());
            let event = input
                .get("event")
                .filter(|e| !e.is_null())
                .map(policy_event);
            json!({"ok":true,"result":native::can_admin_replay_domain_event(policy.as_ref(),event.as_ref(),input["now"].as_i64().unwrap())})
        }
        other => panic!("Unknown corpus operation {other}"),
    }
}

fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|right| json_equal(value, right))
                })
        }
        _ => left == right,
    }
}

#[test]
fn frozen_typescript_domain_contracts_match_native_results() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 200);
    for case in cases {
        let input = case_input(case);
        let actual = execute(case, &input);
        assert!(
            json_equal(&actual, &case["expected"]),
            "case {}\nactual: {}\nexpected: {}",
            case["name"],
            actual,
            case["expected"]
        );
    }
}

#[test]
fn native_sdk_dates_and_omitted_properties_preserve_serialization_contract() {
    use native::DomainEventSdkValue as Sdk;
    let input = Sdk::Object(vec![
        ("createdAt".into(), Sdk::Date(0)),
        ("omitted".into(), Sdk::Undefined),
        (
            "nested".into(),
            Sdk::Array(vec![Sdk::Date(-1), Sdk::Json(json!(true))]),
        ),
    ]);
    assert_eq!(
        native::serialize_domain_event_sdk_data(&input).unwrap(),
        json!({"createdAt":"1970-01-01T00:00:00.000Z","nested":["1969-12-31T23:59:59.999Z",true]})
    );
    assert!(
        native::serialize_domain_event_sdk_data(&Sdk::Object(vec![(
            "array".into(),
            Sdk::Array(vec![Sdk::Undefined])
        )]))
        .is_err()
    );
    assert!(
        native::serialize_domain_event_sdk_data(&Sdk::Object(vec![(
            "date".into(),
            Sdk::Date(8_640_000_000_000_001)
        )]))
        .is_err()
    );
    assert!(
        native::serialize_domain_event_sdk_data(&Sdk::Object(vec![(
            "constructor".into(),
            Sdk::Undefined
        )]))
        .is_err()
    );
    for (timestamp, iso) in [
        (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
        (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
    ] {
        assert_eq!(native::time::native_date_iso(timestamp), iso);
    }
}

#[test]
fn payload_getters_validate_before_exposing_borrowed_provider_data() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    let twitch = cases
        .iter()
        .find(|c| c["name"] == "all-twitch/channel.follow")
        .unwrap();
    let payload = native::get_twitch_eventsub_payload(&twitch["input"]).unwrap();
    assert_eq!(
        payload.subscription.get("type").and_then(Value::as_str),
        Some("channel.follow")
    );
    assert!(native::get_polar_billing_payload(&twitch["input"]).is_err());
    let polar = cases
        .iter()
        .find(|c| c["name"] == "polar/order.paid")
        .unwrap();
    assert_eq!(
        native::get_polar_billing_payload(&polar["input"])
            .unwrap()
            .get("paid"),
        Some(&Value::Bool(true))
    );
    assert!(native::get_twitch_eventsub_payload(&polar["input"]).is_err());
}

/// Execute only in the lead's capped compiler/test container. The matching
/// TypeScript oracle uses --bench with the same iteration environment value.
#[test]
#[ignore = "explicit isolated performance run"]
fn domain_contracts_prepared_benchmark() {
    let corpus = corpus();
    let names = corpus["benchmarkCaseNames"].as_array().unwrap();
    let all = corpus["cases"].as_array().unwrap();
    let cases: Vec<_> = names
        .iter()
        .map(|name| all.iter().find(|case| &case["name"] == name).unwrap())
        .collect();
    let iterations = std::env::var("DOMAIN_CONTRACT_BENCH_ITERATIONS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1000);
    assert!(iterations > 0);
    let run = || {
        let (mut accepted, mut rejected) = (0_u64, 0_u64);
        for case in &cases {
            let mode = if case["mode"] == "ingest" {
                ContractMode::Ingest
            } else {
                ContractMode::Retained
            };
            match native::validate_domain_event_contract(std::hint::black_box(&case["input"]), mode)
            {
                Ok(()) => accepted += 1,
                Err(_) => rejected += 1,
            }
        }
        (accepted, rejected)
    };
    for _ in 0..100 {
        std::hint::black_box(run());
    }
    let (mut accepted, mut rejected) = (0_u64, 0_u64);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let (a, r) = std::hint::black_box(run());
        accepted += a;
        rejected += r;
    }
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({"implementation":"rust","workload":"domain-contracts-prepared","iterations":iterations,"casesPerPass":cases.len(),"accepted":accepted,"rejected":rejected,"elapsedMs":elapsed_ms,"nsPerOperation":elapsed_ms*1e6/(iterations*cases.len()) as f64})
    );
}
