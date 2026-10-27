//! Source-backed expectations from cron_queue_parity.mjs. No service access.
#![cfg(feature = "cron-queue")]

use dima_rust::utils::cron_queue::{
    self, CronQueueClock, CronQueueConfig, CronQueueUuidSource, ENQUEUE_DEDUPLICATED_JOB,
    EnqueueCronJobInput,
};
use serde_json::{Value, json};

struct Clock {
    value: String,
    calls: usize,
}

impl CronQueueClock for Clock {
    fn now_iso(&mut self) -> String {
        self.calls += 1;
        self.value.clone()
    }
}

struct Uuids {
    value: String,
    calls: usize,
}

impl CronQueueUuidSource for Uuids {
    fn random_uuid(&mut self) -> String {
        self.calls += 1;
        self.value.clone()
    }
}

// JSON interoperability is structural. Compare numbers as the JS doubles the
// source actually uses, without changing serde_json's features for any worker.
fn structurally_equal(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => actual.as_f64() == expected.as_f64(),
        (Value::Array(actual), Value::Array(expected)) => {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| structurally_equal(a, b))
        }
        (Value::Object(actual), Value::Object(expected)) => {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .all(|(key, a)| expected.get(key).is_some_and(|b| structurally_equal(a, b)))
        }
        _ => actual == expected,
    }
}

#[test]
fn public_cron_queue_api_matches_typescript_fixtures() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/cron_queue_parity.json")).unwrap();
    assert_eq!(
        ENQUEUE_DEDUPLICATED_JOB,
        fixture["enqueueScript"].as_str().unwrap()
    );
    let mut exercised = 0;
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let mut clock = Clock {
            value: fixture["fixedTime"].as_str().unwrap().into(),
            calls: 0,
        };
        let mut uuids = Uuids {
            value: fixture["fixedUuid"].as_str().unwrap().into(),
            calls: 0,
        };
        let mut expected = case["expected"].clone();
        let actual = match case["operation"].as_str().unwrap() {
            "parse" => {
                let job = cron_queue::parse_cron_queue_job(
                    input["payload"].as_str().unwrap(),
                    &mut clock,
                    &mut uuids,
                )
                .expect("ordinary source parity fixture must fit the explicit depth budget");
                json!({ "job": job, "uuidCalls": uuids.calls, "clockCalls": clock.calls })
            }
            "dedupe_key" => json!(cron_queue::get_cron_job_dedupe_key(
                input["token"].as_str().unwrap()
            )),
            "dedupe_default" => {
                let value = CronQueueConfig::from_dedupe_seconds_env(input["env"].as_str())
                    .default_dedupe_seconds;
                json!({ "value": value, "category": if value.is_nan() { "nan" } else if value.is_infinite() { "infinity" } else { "finite" } })
            }
            "serialize" => {
                let job = serde_json::from_value(input["job"].clone()).unwrap();
                let payload = cron_queue::serialize_cron_queue_job(&job).unwrap();
                expected = serde_json::from_str(expected.as_str().unwrap()).unwrap();
                serde_json::from_str(&payload).unwrap()
            }
            "enqueue" => {
                let enqueue: EnqueueCronJobInput =
                    serde_json::from_value(input["input"].clone()).unwrap();
                let config = CronQueueConfig::from_dedupe_seconds_env(input["env"].as_str());
                let prepared =
                    cron_queue::prepare_enqueue_cron_job(&enqueue, config, &mut clock, &mut uuids)
                        .unwrap();
                let commands = prepared.command.into_iter().map(|command| {
                    json!({ "operation": "eval", "keys": command.keys, "arguments": command.arguments })
                }).collect::<Vec<_>>();
                let mut actual = json!({
                    "result": prepared.result,
                    "uuidCalls": uuids.calls,
                    "clockCalls": clock.calls,
                    "clientCalls": commands.len(),
                    "commands": commands,
                });
                for value in [&mut actual, &mut expected] {
                    for command in value["commands"].as_array_mut().unwrap() {
                        let payload = command["arguments"][1].as_str().unwrap();
                        command["arguments"][1] = serde_json::from_str(payload).unwrap();
                    }
                }
                actual
            }
            "attempt" => {
                let job: Option<cron_queue::CronQueueJob> =
                    serde_json::from_value(input["job"].clone()).unwrap();
                json!({
                    "attempt": cron_queue::get_job_attempt(job.as_ref()),
                    "next": cron_queue::with_next_attempt(job.as_ref()),
                })
            }
            // These source clear fixtures run through the real adapter in the
            // ignored Redis suite; a mock would not validate its DEL behavior.
            "clear" => continue,
            // Source acceptance and deliberate Rust rejection are verified by
            // the dedicated depth-boundary test, not labeled source parity.
            "parse_depth_boundary" => continue,
            other => panic!("unknown fixture operation: {other}"),
        };
        assert!(
            structurally_equal(&actual, &expected),
            "case {index}: {}\nactual: {actual}\nexpected: {expected}",
            case["operation"]
        );
        exercised += 1;
    }
    assert!(
        exercised >= 130,
        "unexpectedly reduced source parity coverage"
    );
}

#[test]
fn source_accepted_deep_jobs_have_an_explicit_resource_error() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/cron_queue_parity.json")).unwrap();
    let mut exercised = 0;
    for case in fixture["cases"].as_array().unwrap() {
        if case["operation"] != "parse_depth_boundary" {
            continue;
        }
        assert_eq!(case["expected"]["sourceAccepted"], true);
        let mut clock = Clock {
            value: fixture["fixedTime"].as_str().unwrap().into(),
            calls: 0,
        };
        let mut uuids = Uuids {
            value: fixture["fixedUuid"].as_str().unwrap().into(),
            calls: 0,
        };
        let payload = case["input"]["payload"].as_str().unwrap();
        let parsed = cron_queue::parse_cron_queue_job(payload, &mut clock, &mut uuids);
        if case["input"]["nestedArrays"].as_u64().unwrap() >= 126 {
            assert_eq!(
                parsed.unwrap_err(),
                cron_queue::CronQueueParseError::DepthLimitExceeded {
                    maximum_depth: cron_queue::CRON_QUEUE_JSON_MAX_DEPTH,
                },
                "source-accepted job must not be silently discarded as None"
            );
        } else {
            let job = parsed
                .unwrap()
                .expect("job below the depth budget must parse");
            let expected: Value =
                serde_json::from_str(case["expected"]["serialized"].as_str().unwrap()).unwrap();
            assert!(structurally_equal(
                &serde_json::to_value(job).unwrap(),
                &expected
            ));
        }
        assert_eq!(clock.calls, 0);
        assert_eq!(uuids.calls, 0);
        exercised += 1;
    }
    assert_eq!(
        exercised, 3,
        "source depth-boundary fixtures must remain present"
    );
}

#[test]
fn nonfinite_captured_defaults_are_not_silently_repaired() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/cron_queue_parity.json")).unwrap();
    let mut clock = Clock {
        value: fixture["fixedTime"].as_str().unwrap().into(),
        calls: 0,
    };
    let mut uuids = Uuids {
        value: fixture["fixedUuid"].as_str().unwrap().into(),
        calls: 0,
    };
    let input: EnqueueCronJobInput = serde_json::from_value(json!({ "job": "summary" })).unwrap();
    for (value, expected) in [
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "60"),
    ] {
        let prepared = cron_queue::prepare_enqueue_cron_job(
            &input,
            CronQueueConfig {
                default_dedupe_seconds: value,
            },
            &mut clock,
            &mut uuids,
        )
        .unwrap();
        assert_eq!(prepared.command.unwrap().arguments[0], expected);
    }
}
