//! Not executed in the authoring turn.
//! Oracle cases fail when the fixture or TypeScript source is missing or empty.
//! Redis cases are ignored and panic, rather than return, when their owner or URL is absent.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const PINS: &[&str] = &[
    "oldestAgeSeconds > Number(process.env.AI_USAGE_QUEUE_MAX_AGE_SECONDS || 900)",
    "reasons.push('queue_age')",
    "processingAgeSeconds > Number(process.env.AI_USAGE_PROCESSING_MAX_AGE_SECONDS || 900)",
    "reasons.push('processing_stalled')",
    "if (dead) reasons.push('dead_letters')",
    "failures - Number(previous.observedFailures || 0) >= Number(process.env.AI_USAGE_QUEUE_FAILURE_THRESHOLD || 3)",
    "reasons.push('repeated_failures')",
    "const pendingSince = pending ? Number(previous.pendingSince) || now : 0;",
    "const processingAgeSeconds = processing ? Math.max(0, (now - (Number(previous.processingSince) || now)) / 1000) : 0;",
    "const failures = Number(previous.failures || 0);",
    "await warn({ worker: 'ai_usage_receipts', message: 'AI usage queue requires attention', ...status }, { destination: 'both' });",
];

const FIXTURE: &str = r#####"
{
  "pins": [
    "oldestAgeSeconds > Number(process.env.AI_USAGE_QUEUE_MAX_AGE_SECONDS || 900)",
    "reasons.push('queue_age')",
    "processingAgeSeconds > Number(process.env.AI_USAGE_PROCESSING_MAX_AGE_SECONDS || 900)",
    "reasons.push('processing_stalled')",
    "if (dead) reasons.push('dead_letters')",
    "failures - Number(previous.observedFailures || 0) >= Number(process.env.AI_USAGE_QUEUE_FAILURE_THRESHOLD || 3)",
    "reasons.push('repeated_failures')",
    "const pendingSince = pending ? Number(previous.pendingSince) || now : 0;",
    "const processingAgeSeconds = processing ? Math.max(0, (now - (Number(previous.processingSince) || now)) / 1000) : 0;",
    "const failures = Number(previous.failures || 0);",
    "await warn({ worker: 'ai_usage_receipts', message: 'AI usage queue requires attention', ...status }, { destination: 'both' });"
  ],
  "cases": [
    {"op":"limit","id":"limit-null","raw":null,"default":900,"expect":"900"},
    {"op":"limit","id":"limit-empty","raw":"","default":900,"expect":"900"},
    {"op":"limit","id":"limit-space","raw":" ","default":900,"expect":"0"},
    {"op":"limit","id":"limit-zero","raw":"0","default":900,"expect":"0"},
    {"op":"limit","id":"limit-900","raw":"900","default":900,"expect":"900"},
    {"op":"limit","id":"limit-padded","raw":" 900 ","default":900,"expect":"900"},
    {"op":"limit","id":"limit-abc","raw":"abc","default":900,"expect":"NaN"},
    {"op":"limit","id":"limit-infinity","raw":"Infinity","default":900,"expect":"Infinity"},
    {"op":"limit","id":"limit-negative","raw":"-1","default":900,"expect":"-1"},
    {"op":"limit","id":"limit-hex","raw":"0x10","default":900,"expect":"16"},
    {"op":"assess","id":"numeric-enqueued","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":1000},"previous":{},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"10000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":1,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":9,\"processingAgeSeconds\":0,\"failures\":0,\"reasons\":[\"queue_age\"],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}","alert":"{\"worker\":\"ai_usage_receipts\",\"message\":\"AI usage queue requires attention\",\"queue\":\"receipts\",\"pending\":1,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":9,\"processingAgeSeconds\":0,\"failures\":0,\"reasons\":[\"queue_age\"],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"zero-enqueued-falls-through","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":0,"requestedAt":1000},"previous":{},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"10000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"object-enqueued-ignores-requested","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":{},"requestedAt":1000},"previous":{},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"10000","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"invalid-json-uses-pending-since","name":"receipts","pending":1,"processing":0,"dead":0,"oldestRaw":"{","previous":{"pendingSince":"1000"},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"1000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"null-oldest-uses-pending-since","name":"receipts","pending":1,"processing":0,"dead":0,"oldestRaw":"null","previous":{"pendingSince":"1000"},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"1000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"pending-since-nan","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{},"previous":{"pendingSince":"NaN"},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"10000","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"pending-since-infinity","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{},"previous":{"pendingSince":"Infinity"},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"Infinity","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"pending-zero-stores-zero","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":{"enqueuedAt":1000},"previous":{},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"processing-stalled","name":"receipts","pending":0,"processing":1,"dead":0,"oldest":null,"previous":{"processingSince":"1000"},"now":10000,"maxAge":"900","processingMaxAge":"8","failure":"3","reasons":["processing_stalled"],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"9","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"processing-since-missing","name":"receipts","pending":0,"processing":1,"dead":0,"oldest":null,"previous":{},"now":10000,"maxAge":"900","processingMaxAge":"8","failure":"3","reasons":[],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"processing-since-abc","name":"receipts","pending":0,"processing":1,"dead":0,"oldest":null,"previous":{"processingSince":"abc"},"now":10000,"maxAge":"900","processingMaxAge":"8","failure":"3","reasons":[],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"dead-letters","name":"receipts","pending":0,"processing":0,"dead":1,"oldest":null,"previous":{},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":["dead_letters"],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"dead-zero","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"repeated-delta-4","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"5","observedFailures":"1"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":["repeated_failures"],"pendingSince":"0","observed":"5","oldestAge":"0","processingAge":"0","failures":"5","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"repeated-delta-equal","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"5","observedFailures":"2"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":["repeated_failures"],"pendingSince":"0","observed":"5","oldestAge":"0","processingAge":"0","failures":"5","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"repeated-delta-below","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"5","observedFailures":"3"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"0","observed":"5","oldestAge":"0","processingAge":"0","failures":"5","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"failures-nan","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"NaN"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"0","observed":"NaN","oldestAge":"0","processingAge":"0","failures":"NaN","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":0,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":0,\"processingAgeSeconds\":0,\"failures\":null,\"reasons\":[],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"observed-abc","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"5","observedFailures":"abc"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"0","observed":"5","oldestAge":"0","processingAge":"0","failures":"5","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"zero-threshold","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"0","observedFailures":"0"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"0","reasons":["repeated_failures"],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"failures-infinity","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":"Infinity","observedFailures":"0"},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":["repeated_failures"],"pendingSince":"0","observed":"Infinity","oldestAge":"0","processingAge":"0","failures":"Infinity","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":0,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":0,\"processingAgeSeconds\":0,\"failures\":null,\"reasons\":[\"repeated_failures\"],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"age-equal-threshold","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":1000},"previous":{},"now":10000,"maxAge":"9","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"10000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":1,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":9,\"processingAgeSeconds\":0,\"failures\":0,\"reasons\":[],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"pending-since-padded","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{},"previous":{"pendingSince":" 1000 "},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"1000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"failures-padded","name":"receipts","pending":0,"processing":0,"dead":0,"oldest":null,"previous":{"failures":" 4 ","observedFailures":" 1 "},"now":10000,"maxAge":"900","processingMaxAge":"900","failure":"3","reasons":["repeated_failures"],"pendingSince":"0","observed":"4","oldestAge":"0","processingAge":"0","failures":"4","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"processing-negative-infinity","name":"receipts","pending":0,"processing":1,"dead":0,"oldest":null,"previous":{"processingSince":"-Infinity"},"now":10000,"maxAge":"900","processingMaxAge":"8","failure":"3","reasons":["processing_stalled"],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"Infinity","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":0,\"processing\":1,\"dead\":0,\"oldestAgeSeconds\":0,\"processingAgeSeconds\":null,\"failures\":0,\"reasons\":[\"processing_stalled\"],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"infinity-threshold-does-not-stall","name":"receipts","pending":0,"processing":1,"dead":0,"oldest":null,"previous":{"processingSince":"-Infinity","failures":"0","observedFailures":"0"},"now":10000,"maxAge":"Infinity","processingMaxAge":"Infinity","failure":"Infinity","reasons":[],"pendingSince":"0","observed":"0","oldestAge":"0","processingAge":"Infinity","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":0,\"processing\":1,\"dead\":0,\"oldestAgeSeconds\":0,\"processingAgeSeconds\":null,\"failures\":0,\"reasons\":[],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"enqueued-true","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":true},"previous":{},"now":1001,"maxAge":"0","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"1001","observed":"0","oldestAge":"1","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:01.001Z"},
    {"op":"assess","id":"enqueued-array","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":[1000]},"previous":{},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":["queue_age"],"pendingSince":"10000","observed":"0","oldestAge":"9","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"pending-since-string-zero","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{},"previous":{"pendingSince":"0"},"now":10000,"maxAge":"8","processingMaxAge":"900","failure":"3","reasons":[],"pendingSince":"10000","observed":"0","oldestAge":"0","processingAge":"0","failures":"0","checkedAt":"1970-01-01T00:00:10.000Z"},
    {"op":"assess","id":"condition-age-and-repeated","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":{"enqueuedAt":1000},"previous":{"failures":" 4 ","observedFailures":" 1 "},"now":10000,"maxAge":" 8 ","processingMaxAge":"","failure":" 3 ","reasons":["queue_age","repeated_failures"],"pendingSince":"10000","observed":"4","oldestAge":"9","processingAge":"0","failures":"4","checkedAt":"1970-01-01T00:00:10.000Z","snapshot":"{\"queue\":\"receipts\",\"pending\":1,\"processing\":0,\"dead\":0,\"oldestAgeSeconds\":9,\"processingAgeSeconds\":0,\"failures\":4,\"reasons\":[\"queue_age\",\"repeated_failures\"],\"checkedAt\":\"1970-01-01T00:00:10.000Z\"}"},
    {"op":"assess","id":"invalid-time","name":"receipts","pending":1,"processing":0,"dead":0,"oldest":null,"previous":{},"now":"max","maxAge":"900","processingMaxAge":"900","failure":"3","error":"Invalid time value"},
    {"op":"truthy-string-zero","id":"enqueued-string-zero"},
    {"op":"alert","id":"alert-empty-ok","reasons":0,"reply":"OK","expect":false},
    {"op":"alert","id":"alert-missing-reply","reasons":1,"reply":null,"expect":false},
    {"op":"alert","id":"alert-ok","reasons":2,"reply":"OK","expect":true},
    {"op":"alert","id":"alert-lower-ok","reasons":1,"reply":"ok","expect":false},
    {"op":"alert","id":"alert-one","reasons":1,"reply":"1","expect":false},
    {"op":"retry","id":"retry-job","queue":"cron:ai-usage-receipts:queue","raw":"job","expect":"cron:ai-usage-receipts:queue:attempts:5e8c9902207afaeb7120430c585a445f21e92932081d64bc99f80e4925bcb002"},
    {"op":"queues","id":"usage-queues","receiptsDead":"cron:ai-usage-receipts:queue:dead","backfillsDead":"cron:ai-usage-backfills:dead"},
    {"op":"script","id":"claim-script","name":"claim","source":"\nlocal item = redis.call('LPOP', KEYS[1])\nif item then\n redis.call('RPUSH', KEYS[2], item)\n redis.call('HSET', KEYS[3], 'processingSince', ARGV[1])\nend\nreturn item"},
    {"op":"script","id":"complete-script","name":"complete","source":"redis.call('LREM', KEYS[1], 1, ARGV[1]); redis.call('DEL', KEYS[2]); return 1"},
    {"op":"script","id":"fail-script","name":"fail","source":"\nlocal attempts = redis.call('INCR', KEYS[4])\nredis.call('EXPIRE', KEYS[4], 604800)\nredis.call('HINCRBY', KEYS[5], 'failures', 1)\nif redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return 0 end\nif attempts >= tonumber(ARGV[2]) then\n redis.call('RPUSH', KEYS[3], ARGV[1]); redis.call('DEL', KEYS[4]); return 2\nend\nredis.call('RPUSH', KEYS[2], ARGV[1]); return 1"}
  ]
}
"#####;

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_required(relative: &str) -> String {
    let path = manifest_path(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing required source {}: {error}", path.display()))
}

fn load_fixture(raw: &str) -> Value {
    assert!(!raw.trim().is_empty(), "oracle fixture is empty");
    let fixture: Value = serde_json::from_str(raw).expect("oracle fixture is not valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("oracle fixture has no cases");
    assert!(!cases.is_empty(), "oracle fixture has no cases");
    assert!(cases.len() >= 40, "oracle fixture is incomplete");
    fixture
}

#[test]
fn oracle_fixture_is_nonempty_and_pinned_to_typescript() {
    let fixture = load_fixture(FIXTURE);
    let pins = fixture["pins"].as_array().expect("pins");
    assert_eq!(pins.len(), PINS.len());
    let typescript = read_required("src/utils/ai_usage_queue_health.ts");
    let rust = read_required("src/utils/ai_usage_queue_health.rs");
    assert!(!typescript.trim().is_empty(), "typescript source is empty");
    assert!(!rust.trim().is_empty(), "rust port is empty");
    for (index, pin) in PINS.iter().enumerate() {
        assert!(!pin.is_empty());
        assert_eq!(pins[index].as_str(), Some(*pin), "{pin}");
        assert!(typescript.contains(pin), "typescript missing {pin}");
        assert!(FIXTURE.contains(pin), "fixture missing {pin}");
    }
    let mut ops = std::collections::BTreeSet::new();
    for case in fixture["cases"].as_array().unwrap() {
        let op = case["op"].as_str().unwrap_or_else(|| panic!("case missing op: {case}"));
        assert!(!op.is_empty());
        ops.insert(op);
        if op == "script" {
            let source = case["source"].as_str().unwrap_or_else(|| panic!("script missing source"));
            assert!(!source.is_empty(), "script source is empty");
            assert!(typescript.contains(source), "typescript missing script {}", case["id"]);
            assert!(rust.contains(source), "rust port missing script {}", case["id"]);
        }
    }
    for op in ["limit", "assess", "alert", "script", "retry", "queues", "truthy-string-zero"] {
        assert!(ops.contains(op), "fixture missing {op}");
    }
    for banned in ["filter(|v| *v != 0.0 && !v.is_nan())", "s.parse::<f64>()"] {
        assert!(!rust.contains(banned), "old coercion remains: {banned}");
    }
    for required in ["Destination::Both", "queue_alert_acquired", "Invalid time value", "repeated_failures", "Some(\"OK\")"] {
        assert!(rust.contains(required), "rust port missing {required}");
    }
}

#[test]
fn empty_oracle_fixture_panics() {
    assert!(std::panic::catch_unwind(|| load_fixture("")).is_err());
    assert!(std::panic::catch_unwind(|| load_fixture("   ")).is_err());
    assert!(std::panic::catch_unwind(|| load_fixture(r#"{"cases":[]}"#)).is_err());
}

#[allow(unexpected_cfgs)]
#[cfg(feature = "ai-usage-queues")]
mod parity {
    use super::{FIXTURE, load_fixture};
    use dima_rust::utils::ai_usage_queue_health::{
        ALERT_TTL_SECONDS, CLAIM_SCRIPT, COMPLETE_SCRIPT, DEFAULT_MAX_ATTEMPTS, FAIL_SCRIPT,
        HEALTH_KEY_PREFIX, RETRY_TTL_SECONDS, SNAPSHOT_TTL_SECONDS, USAGE_QUEUES, QueueLimits,
        assess_usage_queue, queue_alert_acquired, usage_retry_key,
    };
    use dima_rust::utils::json_number::number_string;
    use serde_json::Value;
    use std::collections::HashMap;

    fn id_of(case: &Value) -> &str {
        case["id"].as_str().unwrap_or("missing-id")
    }

    fn limit_raw(value: &Value) -> Option<&str> {
        match value {
            Value::Null => None,
            Value::String(text) => Some(text.as_str()),
            other => panic!("limit raw must be a string or null, got {other}"),
        }
    }

    fn previous_of(value: &Value) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for (key, item) in value.as_object().unwrap_or_else(|| panic!("previous object")) {
            let text = item.as_str().unwrap_or_else(|| panic!("previous {key} must be a string"));
            map.insert(key.clone(), text.to_owned());
        }
        map
    }

    fn now_of(value: &Value) -> i64 {
        match value {
            Value::Number(number) => number.as_i64().unwrap_or_else(|| panic!("now {number}")),
            Value::String("max") => i64::MAX,
            other => panic!("now {other}"),
        }
    }

    fn oldest_of(case: &Value) -> Option<String> {
        if let Some(raw) = case.get("oldestRaw") {
            return match raw {
                Value::Null => None,
                Value::String(text) => Some(text.clone()),
                other => panic!("oldestRaw {other}"),
            };
        }
        match case.get("oldest") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::to_string(value).expect("oldest json")),
        }
    }

    fn limits_of(case: &Value) -> QueueLimits {
        QueueLimits {
            max_age_seconds: dima_rust::utils::ai_usage_queue_health::queue_limit_from(
                limit_raw(&case["maxAge"]),
                900.0,
            ),
            processing_max_age_seconds: dima_rust::utils::ai_usage_queue_health::queue_limit_from(
                limit_raw(&case["processingMaxAge"]),
                900.0,
            ),
            failure_threshold: dima_rust::utils::ai_usage_queue_health::queue_limit_from(
                limit_raw(&case["failure"]),
                3.0,
            ),
        }
    }

    fn reasons_of(case: &Value) -> Vec<String> {
        case["reasons"]
            .as_array()
            .unwrap_or_else(|| panic!("{} reasons", id_of(case)))
            .iter()
            .map(|reason| reason.as_str().unwrap_or_else(|| panic!("reason")).to_owned())
            .collect()
    }

    fn dispatch(case: &Value) {
        match case["op"].as_str().unwrap_or_else(|| panic!("missing op in {case}")) {
            "limit" => {
                let actual = dima_rust::utils::ai_usage_queue_health::queue_limit_from(
                    limit_raw(&case["raw"]),
                    case["default"].as_f64().unwrap_or_else(|| panic!("{} default", id_of(case))),
                );
                assert_eq!(number_string(actual), case["expect"].as_str().unwrap(), "{}", id_of(case));
            }
            "assess" => {
                let previous = previous_of(&case["previous"]);
                let result = assess_usage_queue(
                    case["name"].as_str().unwrap(),
                    case["pending"].as_i64().unwrap(),
                    case["processing"].as_i64().unwrap(),
                    case["dead"].as_i64().unwrap(),
                    oldest_of(case).as_deref(),
                    &previous,
                    now_of(&case["now"]),
                    limits_of(case),
                );
                if let Some(error) = case.get("error").and_then(Value::as_str) {
                    assert_eq!(result.expect_err(id_of(case)).to_string(), error, "{}", id_of(case));
                    return;
                }
                let assessment = result.unwrap_or_else(|error| panic!("{}: {error}", id_of(case)));
                assert_eq!(assessment.status.reasons, reasons_of(case), "{}", id_of(case));
                assert_eq!(assessment.pending_since_text, case["pendingSince"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(assessment.observed_failures_text, case["observed"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(number_string(assessment.status.oldest_age_seconds), case["oldestAge"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(number_string(assessment.status.processing_age_seconds), case["processingAge"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(number_string(assessment.status.failures), case["failures"].as_str().unwrap(), "{}", id_of(case));
                assert_eq!(assessment.status.checked_at, case["checkedAt"].as_str().unwrap(), "{}", id_of(case));
                if let Some(snapshot) = case.get("snapshot").and_then(Value::as_str) {
                    assert_eq!(assessment.snapshot_json, snapshot, "{}", id_of(case));
                }
                if let Some(alert) = case.get("alert").and_then(Value::as_str) {
                    assert_eq!(assessment.alert_json, alert, "{}", id_of(case));
                    assert!(alert.starts_with("{\"worker\":\"ai_usage_receipts\",\"message\":\"AI usage queue requires attention\",\"queue\":"), "{}", id_of(case));
                }
            }
            "truthy-string-zero" => {
                let limits = QueueLimits {
                    max_age_seconds: 8.0,
                    processing_max_age_seconds: 900.0,
                    failure_threshold: 3.0,
                };
                let previous = HashMap::new();
                let requested = assess_usage_queue(
                    "receipts",
                    1,
                    0,
                    0,
                    Some(r#"{"enqueuedAt":0,"requestedAt":1000}"#),
                    &previous,
                    10_000,
                    limits,
                )
                .expect("requested");
                let textual = assess_usage_queue(
                    "receipts",
                    1,
                    0,
                    0,
                    Some(r#"{"enqueuedAt":"0","requestedAt":1000}"#),
                    &previous,
                    10_000,
                    limits,
                )
                .expect("textual");
                assert_eq!(number_string(requested.status.oldest_age_seconds), "9");
                assert_ne!(
                    number_string(textual.status.oldest_age_seconds),
                    number_string(requested.status.oldest_age_seconds)
                );
                assert_eq!(textual.pending_since_text, "10000");
            }
            "alert" => {
                let reply = match &case["reply"] {
                    Value::Null => None,
                    Value::String(text) => Some(text.as_str()),
                    other => panic!("{} reply {other}", id_of(case)),
                };
                let reasons = case["reasons"].as_u64().unwrap() as usize;
                assert_eq!(queue_alert_acquired(reasons, reply), case["expect"].as_bool().unwrap(), "{}", id_of(case));
            }
            "retry" => {
                let actual = usage_retry_key(case["queue"].as_str().unwrap(), case["raw"].as_str().unwrap());
                assert_eq!(actual, case["expect"].as_str().unwrap(), "{}", id_of(case));
            }
            "queues" => {
                assert_eq!(USAGE_QUEUES.len(), 2);
                assert_eq!(USAGE_QUEUES[0].name, "receipts");
                assert_eq!(USAGE_QUEUES[0].queue, "cron:ai-usage-receipts:queue");
                assert_eq!(USAGE_QUEUES[0].processing, "cron:ai-usage-receipts:processing");
                assert_eq!(USAGE_QUEUES[0].dead, "cron:ai-usage-receipts:queue:dead");
                assert_eq!(USAGE_QUEUES[1].name, "backfills");
                assert_eq!(USAGE_QUEUES[1].queue, "cron:ai-usage-backfills:queue");
                assert_eq!(USAGE_QUEUES[1].processing, "cron:ai-usage-backfills:processing");
                assert_eq!(USAGE_QUEUES[1].dead, "cron:ai-usage-backfills:dead");
                assert_eq!(USAGE_QUEUES[0].dead, case["receiptsDead"].as_str().unwrap());
                assert_eq!(USAGE_QUEUES[1].dead, case["backfillsDead"].as_str().unwrap());
                assert!(!USAGE_QUEUES[1].dead.contains(":queue:dead"));
                assert_eq!(HEALTH_KEY_PREFIX, "ai-usage:queue-health");
                assert_eq!(RETRY_TTL_SECONDS, 604_800);
                assert_eq!(SNAPSHOT_TTL_SECONDS, 300);
                assert_eq!(ALERT_TTL_SECONDS, 300);
                assert_eq!(DEFAULT_MAX_ATTEMPTS, 3);
            }
            "script" => {
                let actual = match case["name"].as_str().unwrap() {
                    "claim" => CLAIM_SCRIPT,
                    "complete" => COMPLETE_SCRIPT,
                    "fail" => FAIL_SCRIPT,
                    other => panic!("unknown script {other}"),
                };
                assert_eq!(actual, case["source"].as_str().unwrap(), "{}", id_of(case));
            }
            other => panic!("unknown oracle op {other}"),
        }
    }

    #[test]
    fn fixture_cases_match_the_rust_port() {
        let fixture = load_fixture(FIXTURE);
        let cases = fixture["cases"].as_array().expect("cases");
        let mut ran = 0usize;
        for case in cases {
            dispatch(case);
            ran += 1;
        }
        assert_eq!(ran, cases.len());
    }

    #[test]
    fn unknown_fixture_op_panics() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            dispatch(&serde_json::json!({"op":"not-a-real-op","id":"unknown"}));
        }));
        assert!(result.is_err());
    }

    fn sha256_hex(relative: &str) -> String {
        use sha2::{Digest, Sha256};
        let path = super::manifest_path(relative);
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("missing required source {}: {error}", path.display()));
        assert!(!bytes.is_empty(), "{} is empty", path.display());
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn typescript_sources_match_pinned_hashes() {
        assert_eq!(
            sha256_hex("src/utils/ai_usage_queue_health.ts"),
            "70fa5349e56115b75ef26ae761709de72f5f3fe96a68431e5bca6f2f949ee6a9"
        );
        assert_eq!(
            sha256_hex("src/utils/ai_usage_backfill_queue.ts"),
            "3b8a3f7a55c0b5410de2edcffc892255d25357fa972c84ec0dc8cc5424b89dde"
        );
    }

    struct FixedClock;
    impl dima_rust::utils::logger::Clock for FixedClock {
        fn now_millis(&self) -> i64 {
            10_000
        }
    }
    struct FixedId;
    impl dima_rust::utils::logger::IdSource for FixedId {
        fn next_id(&self) -> String {
            "alert-test".to_owned()
        }
    }
    struct MemorySink {
        kind: &'static str,
        rows: std::sync::Arc<std::sync::Mutex<Vec<(&'static str, String)>>>,
    }
    impl dima_rust::utils::logger::CacheSink for MemorySink {
        fn store(&self, record: dima_rust::utils::logger::CacheRecord) -> dima_rust::utils::logger::SinkFuture<'_> {
            let kind = self.kind;
            let rows = self.rows.clone();
            let json = record.json.to_string();
            let key = record.key.clone();
            Box::pin(async move {
                rows.lock().expect("log rows").push((kind, format!("{key}\n{json}")));
                Ok(())
            })
        }
    }
    impl dima_rust::utils::logger::ConsoleSink for MemorySink {
        fn write(&self, record: dima_rust::utils::logger::ConsoleRecord) -> dima_rust::utils::logger::SinkFuture<'_> {
            let kind = self.kind;
            let rows = self.rows.clone();
            let json = record.json.to_string();
            let stream = match record.stream {
                dima_rust::utils::logger::ConsoleStream::Stderr => "stderr",
                dima_rust::utils::logger::ConsoleStream::Stdout => "stdout",
            };
            Box::pin(async move {
                rows.lock().expect("log rows").push((kind, format!("{stream}\n{json}")));
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn warn_reaches_both_sinks_with_the_source_body() {
        use dima_rust::utils::ai_usage_queue_health::{emit_queue_alert, queue_alert_json};
        use dima_rust::utils::logger::{
            Disposition, Logger, LoggerConfig, SinkHandles, SinkStatus,
        };
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        let previous = HashMap::new();
        let assessment = assess_usage_queue(
            "receipts",
            1,
            0,
            0,
            Some(r#"{"enqueuedAt":1000}"#),
            &previous,
            10_000,
            QueueLimits {
                max_age_seconds: 8.0,
                processing_max_age_seconds: 900.0,
                failure_threshold: 3.0,
            },
        )
        .expect("assessment");
        let alert = queue_alert_json(&assessment.status);
        assert!(alert.starts_with(
            "{\"worker\":\"ai_usage_receipts\",\"message\":\"AI usage queue requires attention\",\"queue\":"
        ));
        assert_eq!(alert, assessment.alert_json);
        let rows = Arc::new(Mutex::new(Vec::new()));
        let logger = Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(Arc::new(MemorySink { kind: "cache", rows: rows.clone() })),
                console: Some(Arc::new(MemorySink { kind: "console", rows: rows.clone() })),
                ..SinkHandles::default()
            },
            Arc::new(FixedClock),
            Arc::new(FixedId),
        )
        .expect("logger");
        let report = emit_queue_alert(&logger, &assessment.status).await;
        assert!(report.success(), "{report:?}");
        assert_eq!(report.disposition, Disposition::Emitted);
        assert_eq!(report.cache, SinkStatus::Succeeded);
        assert_eq!(report.console, SinkStatus::Succeeded);
        let rows = rows.lock().expect("log rows");
        assert_eq!(rows.len(), 2);
        let cache_row = rows.iter().find(|row| row.0 == "cache").expect("cache row");
        let console_row = rows.iter().find(|row| row.0 == "console").expect("console row");
        let (cache_key, cache_json) = cache_row.1.split_once('\n').expect("cache row");
        let (stream, console_json) = console_row.1.split_once('\n').expect("console row");
        assert_eq!(cache_key, "logger:twitch:global:warn:10000-alert-test");
        assert_eq!(stream, "stderr");
        assert_eq!(cache_json, console_json);
        let logged: Value = serde_json::from_str(console_json).expect("log json");
        assert_eq!(logged["level"], "warn");
        assert_eq!(logged["data"], serde_json::from_str::<Value>(&alert).unwrap());
        assert_eq!(logged["data"]["worker"], "ai_usage_receipts");
        assert_eq!(logged["data"]["message"], "AI usage queue requires attention");
    }
}

#[allow(unexpected_cfgs)]
#[cfg(feature = "ai-usage-queues")]
mod redis_fixture {
    use dima_rust::utils::ai_usage_queue_health::{
        HEALTH_KEY_PREFIX, USAGE_QUEUES, UsageQueue, assess_usage_queue, claim_usage_job_in,
        complete_usage_job, fail_usage_job_in, monitor_ai_usage_queues_in, queue_alert_key,
        queue_health_key, queue_snapshot_key, usage_retry_key, QueueLimits,
    };
    use dima_rust::utils::logger::{
        CacheRecord, CacheSink, Clock, ConsoleRecord, ConsoleSink, IdSource, Logger, LoggerConfig,
        SinkFuture, SinkHandles,
    };
    use redis::aio::ConnectionManager;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn require_owned_redis() -> String {
        let url = std::env::var("DIMA_TEST_REDIS_URL")
            .expect("explicit disposable DIMA_TEST_REDIS_URL required");
        assert!(!url.trim().is_empty(), "DIMA_TEST_REDIS_URL is empty");
        assert_eq!(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
            Ok("dimabot-migration")
        );
        url
    }

    fn namespace(label: &str) -> String {
        static SEQUENCE: AtomicU64 = AtomicU64::new(1);
        format!(
            "dima:test:ai-usage:{label}:{}:{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
    }

    struct Owned {
        url: String,
        claim: String,
        token: String,
        keys: Vec<String>,
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            let result = (|| -> redis::RedisResult<()> {
                let client = redis::Client::open(self.url.as_str())?;
                let mut connection = client.get_connection_with_timeout(Duration::from_secs(2))?;
                connection.set_read_timeout(Some(Duration::from_secs(2)))?;
                connection.set_write_timeout(Some(Duration::from_secs(2)))?;
                let owner: Option<String> = redis::cmd("GET").arg(&self.claim).query(&mut connection)?;
                if owner.as_deref() != Some(self.token.as_str()) {
                    return Ok(());
                }
                for key in &self.keys {
                    let _: i64 = redis::cmd("DEL").arg(key).query(&mut connection)?;
                }
                let _: i64 = redis::cmd("DEL").arg(&self.claim).query(&mut connection)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("ai usage queue cleanup failed: {error}");
            }
        }
    }

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_millis(&self) -> i64 {
            10_000
        }
    }
    struct FixedId;
    impl IdSource for FixedId {
        fn next_id(&self) -> String {
            "redis-alert".to_owned()
        }
    }
    struct MemoryConsole {
        rows: Arc<Mutex<Vec<String>>>,
    }
    impl CacheSink for MemoryConsole {
        fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
            let rows = self.rows.clone();
            let json = record.json.to_string();
            Box::pin(async move {
                rows.lock().expect("rows").push(json);
                Ok(())
            })
        }
    }
    impl ConsoleSink for MemoryConsole {
        fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
            let rows = self.rows.clone();
            let json = record.json.to_string();
            Box::pin(async move {
                rows.lock().expect("rows").push(json);
                Ok(())
            })
        }
    }

    #[tokio::test]
    #[ignore = "requires an explicitly provided isolated Redis fixture"]
    async fn claim_complete_fail_and_dead_use_the_injected_prefix() {
        let url = require_owned_redis();
        let mut cache: ConnectionManager = redis::Client::open(url.as_str())
            .expect("redis url")
            .get_connection_manager()
            .await
            .expect("redis connection");
        let ns = namespace("lifecycle");
        let token = ns.clone();
        let claim = format!("{ns}:owner");
        let acquired: Option<String> = redis::cmd("SET")
            .arg(&claim)
            .arg(&token)
            .arg("NX")
            .arg("EX")
            .arg(600)
            .query_async(&mut cache)
            .await
            .expect("owner claim");
        assert_eq!(acquired.as_deref(), Some("OK"));
        let queue_key = format!("{ns}:queue");
        let processing = format!("{ns}:processing");
        let dead = format!("{ns}:dead");
        let prefix = format!("{ns}:health");
        let queue = UsageQueue {
            name: "receipts",
            queue: &queue_key,
            processing: &processing,
            dead: &dead,
        };
        assert_ne!(queue.queue, USAGE_QUEUES[0].queue);
        assert_ne!(queue_health_key(&prefix, queue.name), format!("{HEALTH_KEY_PREFIX}:receipts"));
        let absent = "absent-job";
        let payload = "payload";
        let done = "done";
        let invalid = "bad";
        let keys = vec![
            queue_key.clone(),
            processing.clone(),
            dead.clone(),
            queue_health_key(&prefix, queue.name),
            usage_retry_key(queue.queue, absent),
            usage_retry_key(queue.queue, payload),
            usage_retry_key(queue.queue, done),
            usage_retry_key(queue.queue, invalid),
        ];
        for key in &keys {
            assert!(key.starts_with("dima:test:ai-usage:"), "{key}");
        }
        let _owned = Owned { url, claim, token, keys };
        let missed = fail_usage_job_in(&mut cache, queue, absent, false, 3, &prefix)
            .await
            .expect("fail without claim");
        assert_eq!(missed, 0);
        let attempts: String = redis::cmd("GET")
            .arg(usage_retry_key(queue.queue, absent))
            .query_async(&mut cache)
            .await
            .expect("retry read");
        assert_eq!(attempts, "1");
        let _: i64 = redis::cmd("RPUSH")
            .arg(queue.queue)
            .arg(payload)
            .query_async(&mut cache)
            .await
            .expect("seed");
        let claimed = claim_usage_job_in(&mut cache, queue, 1_000, &prefix)
            .await
            .expect("claim");
        assert_eq!(claimed.as_deref(), Some(payload));
        let since: String = redis::cmd("HGET")
            .arg(queue_health_key(&prefix, queue.name))
            .arg("processingSince")
            .query_async(&mut cache)
            .await
            .expect("processingSince");
        assert_eq!(since, "1000");
        assert_eq!(fail_usage_job_in(&mut cache, queue, payload, false, 3, &prefix).await.expect("fail 1"), 1);
        assert_eq!(claim_usage_job_in(&mut cache, queue, 1_001, &prefix).await.expect("claim 2").as_deref(), Some(payload));
        assert_eq!(fail_usage_job_in(&mut cache, queue, payload, false, 3, &prefix).await.expect("fail 2"), 1);
        assert_eq!(claim_usage_job_in(&mut cache, queue, 1_002, &prefix).await.expect("claim 3").as_deref(), Some(payload));
        assert_eq!(fail_usage_job_in(&mut cache, queue, payload, false, 3, &prefix).await.expect("fail dead"), 2);
        let dead_item: String = redis::cmd("LINDEX").arg(queue.dead).arg(0).query_async(&mut cache).await.expect("dead");
        assert_eq!(dead_item, payload);
        let retry_gone: Option<String> = redis::cmd("GET")
            .arg(usage_retry_key(queue.queue, payload))
            .query_async(&mut cache)
            .await
            .expect("retry deleted");
        assert_eq!(retry_gone, None);
        let _: i64 = redis::cmd("RPUSH").arg(queue.queue).arg(done).query_async(&mut cache).await.expect("seed done");
        assert_eq!(claim_usage_job_in(&mut cache, queue, 2_000, &prefix).await.expect("claim done").as_deref(), Some(done));
        complete_usage_job(&mut cache, queue, done).await.expect("complete");
        let pending: i64 = redis::cmd("LLEN").arg(queue.processing).query_async(&mut cache).await.expect("processing len");
        assert_eq!(pending, 0);
        let _: i64 = redis::cmd("RPUSH").arg(queue.queue).arg(invalid).query_async(&mut cache).await.expect("seed bad");
        assert_eq!(claim_usage_job_in(&mut cache, queue, 3_000, &prefix).await.expect("claim bad").as_deref(), Some(invalid));
        assert_eq!(fail_usage_job_in(&mut cache, queue, invalid, true, 99, &prefix).await.expect("invalid fail"), 2);
    }

    #[tokio::test]
    #[ignore = "requires an explicitly provided isolated Redis fixture"]
    async fn monitor_writes_snapshot_hash_and_one_alert() {
        let url = require_owned_redis();
        let mut cache: ConnectionManager = redis::Client::open(url.as_str())
            .expect("redis url")
            .get_connection_manager()
            .await
            .expect("redis connection");
        let ns = namespace("monitor");
        let token = ns.clone();
        let claim = format!("{ns}:owner");
        let acquired: Option<String> = redis::cmd("SET")
            .arg(&claim)
            .arg(&token)
            .arg("NX")
            .arg("EX")
            .arg(600)
            .query_async(&mut cache)
            .await
            .expect("owner claim");
        assert_eq!(acquired.as_deref(), Some("OK"));
        let prefix = format!("{ns}:health");
        assert_ne!(prefix, HEALTH_KEY_PREFIX);
        let receipts_queue = format!("{ns}:receipts:queue");
        let receipts_processing = format!("{ns}:receipts:processing");
        let receipts_dead = format!("{ns}:receipts:dead");
        let backfills_queue = format!("{ns}:backfills:queue");
        let backfills_processing = format!("{ns}:backfills:processing");
        let backfills_dead = format!("{ns}:backfills:dead");
        let receipts = UsageQueue {
            name: "receipts",
            queue: &receipts_queue,
            processing: &receipts_processing,
            dead: &receipts_dead,
        };
        let backfills = UsageQueue {
            name: "backfills",
            queue: &backfills_queue,
            processing: &backfills_processing,
            dead: &backfills_dead,
        };
        let queues = [receipts, backfills];
        let mut keys = Vec::new();
        for queue in queues {
            keys.push(queue.queue.to_owned());
            keys.push(queue.processing.to_owned());
            keys.push(queue.dead.to_owned());
            keys.push(queue_health_key(&prefix, queue.name));
            keys.push(queue_snapshot_key(&prefix, queue.name));
            keys.push(queue_alert_key(&prefix, queue.name));
            assert_ne!(queue.queue, USAGE_QUEUES[0].queue);
            assert_ne!(queue.dead, USAGE_QUEUES[0].dead);
            assert_ne!(queue.dead, USAGE_QUEUES[1].dead);
        }
        let _owned = Owned { url, claim, token, keys };
        let _: i64 = redis::cmd("RPUSH")
            .arg(receipts.queue)
            .arg(r#"{"enqueuedAt":1000}"#)
            .query_async(&mut cache)
            .await
            .expect("seed oldest");
        let _: i64 = redis::cmd("HSET")
            .arg(queue_health_key(&prefix, receipts.name))
            .arg("failures")
            .arg(" 4 ")
            .arg("observedFailures")
            .arg(" 1 ")
            .query_async(&mut cache)
            .await
            .expect("seed hash");
        let rows = Arc::new(Mutex::new(Vec::new()));
        let logger = Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(Arc::new(MemoryConsole { rows: rows.clone() })),
                cache: Some(Arc::new(MemoryConsole { rows: rows.clone() })),
                ..SinkHandles::default()
            },
            Arc::new(FixedClock),
            Arc::new(FixedId),
        )
        .expect("logger");
        let limits = QueueLimits {
            max_age_seconds: 8.0,
            processing_max_age_seconds: 900.0,
            failure_threshold: 3.0,
        };
        let statuses = monitor_ai_usage_queues_in(&mut cache, &logger, 10_000, &queues, &prefix, limits)
            .await
            .expect("monitor");
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].reasons, ["queue_age".to_owned(), "repeated_failures".to_owned()]);
        assert!(statuses[1].reasons.is_empty());
        let snapshot: String = redis::cmd("GET")
            .arg(queue_snapshot_key(&prefix, receipts.name))
            .query_async(&mut cache)
            .await
            .expect("snapshot");
        let previous = [("failures".to_owned(), " 4 ".to_owned()), ("observedFailures".to_owned(), " 1 ".to_owned())]
            .into_iter()
            .collect();
        let expected = assess_usage_queue(
            "receipts",
            1,
            0,
            0,
            Some(r#"{"enqueuedAt":1000}"#),
            &previous,
            10_000,
            limits,
        )
        .expect("expected");
        assert_eq!(snapshot, expected.snapshot_json);
        let pending_since: String = redis::cmd("HGET")
            .arg(queue_health_key(&prefix, receipts.name))
            .arg("pendingSince")
            .query_async(&mut cache)
            .await
            .expect("pendingSince");
        let observed: String = redis::cmd("HGET")
            .arg(queue_health_key(&prefix, receipts.name))
            .arg("observedFailures")
            .query_async(&mut cache)
            .await
            .expect("observed");
        assert_eq!(pending_since, "10000");
        assert_eq!(observed, "4");
        let alert: String = redis::cmd("GET")
            .arg(queue_alert_key(&prefix, receipts.name))
            .query_async(&mut cache)
            .await
            .expect("alert");
        assert_eq!(alert, "1");
        let ttl: i64 = redis::cmd("TTL")
            .arg(queue_alert_key(&prefix, receipts.name))
            .query_async(&mut cache)
            .await
            .expect("alert ttl");
        assert!(ttl > 0 && ttl <= 300, "{ttl}");
        let quiet: Option<String> = redis::cmd("GET")
            .arg(queue_alert_key(&prefix, backfills.name))
            .query_async(&mut cache)
            .await
            .expect("quiet alert");
        assert_eq!(quiet, None);
        assert_eq!(rows.lock().expect("rows").len(), 2, "cache and console each receive one warn");
        monitor_ai_usage_queues_in(&mut cache, &logger, 10_000, &queues, &prefix, limits)
            .await
            .expect("second monitor");
        assert_eq!(rows.lock().expect("rows").len(), 2, "NX alert suppresses the second warn");
    }
}
