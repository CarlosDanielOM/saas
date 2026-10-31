#![cfg(feature = "tts-usage-tracking")]
//! Verification for the `utils/tts_usage.rs` port.
//!
//! The oracle is `tests/fixtures/tts_usage_tracking_reference.cjs`, which runs
//! the complete non-import body of the actual `src/utils/tts_usage.ts` with
//! only its four import boundaries stubbed. Pricing comparison therefore never
//! re-implements the source policy:
//!
//! * [`source_oracle_pricing_and_expiry_contract`] checks the pure pricing
//!   re-export and the local-time expiry formula against the recorded source
//!   results, including days 30 and 31.
//! * [`source_oracle_replay_against_private_dragonfly`] replays every case
//!   through the concrete tracker against a task-private Dragonfly, comparing
//!   the exact command sequence, counter/expiry outcome, durable Polar queue
//!   wire, batch HTTP flush, receipt, projection, analytics identity, and
//!   cache-failure logging.
//! * [`durable_projection_and_receipt_idempotency`],
//!   [`cancellation_stops_later_operations_without_replay`], and
//!   [`concrete_bootstrap_acquisition_and_isolation`] cover the remaining
//!   contract edges on the same private fixture.
//!
//! The fixture SHA-256 is supplied out of band by the parent workflow, so the
//! Rust replay never trusts a value the Node script wrote about itself.

use dima_rust::utils::{
    ai_credit_projection::{AiCreditProjection, record_command_at},
    ai_usage_producer::{
        AI_USAGE_RECEIPT_QUEUE_KEY, AiUsageProducer, build_queued_ai_usage_receipt_json,
    },
    js_string::JsString,
    logger::{
        Clock, ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles,
        SystemClock, UuidSource, redis::RedisCacheSink,
    },
    lossless_json::{JsonValue, parse_json},
    polar::{PolarClient, PolarConfig, PolarConfigError, PolarError, PolarPolicy},
    polar_cache_usage::{CacheUsageOptions, PolarCacheUsage, prepare_event},
    polar_usage::{
        POLAR_EVENTS_INGEST_PATH, POLAR_EVENTS_USER_AGENT, PolarUsage, events_ingest_body,
    },
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::PosthogTracking,
    tts_usage::{
        DEFAULT_USAGE_DEADLINE, TtsUsageContext, TtsUsageResult, TtsUsageStreamer,
        TtsUsageTrackError, TtsUsageTrackOptions, TtsUsageTracker, calculate_tts_usage,
        generate_time_left_to_next_month_in_seconds, track_tts_usage,
    },
};
use redis::aio::ConnectionManager;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

const RECORDING_UNAVAILABLE: &str = "TTS usage recording unavailable";
const SNAPSHOT: &str = r#"{"version":3,"available":true,"balance":5000,"used":0,"limit":5000}"#;

#[path = "support/polar_cache_usage.rs"]
#[allow(dead_code)] // Shared fixture proxy surface; this test uses a subset.
mod polar_support;

#[path = "support/polar_batch_http.rs"]
#[allow(dead_code)] // The batch matrix uses hold/respond; this replay uses inserted only.
mod polar_batch_http;

// ---------------------------------------------------------------------------
// Fixture decoding. The oracle encodes values as {u}, {nul}, {f:bits},
// {s:utf16}, {b}, {a}, and {o:[[key, value]]} so binary64 and UTF-16 survive
// JSON.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Enc {
    Undefined,
    Null,
    Float(f64),
    Text(JsString),
    Bool(bool),
    Array(Vec<Enc>),
    Object(Vec<(String, Enc)>),
}

impl Enc {
    fn of(value: &JsonValue) -> Self {
        let fields = match value {
            JsonValue::Object(fields) => fields,
            JsonValue::Array(items) => return Self::Array(items.iter().map(Self::of).collect()),
            JsonValue::String(text) => return Self::Text(text.clone()),
            JsonValue::Number(number) => return Self::Float(*number),
            JsonValue::Bool(flag) => return Self::Bool(*flag),
            JsonValue::Null => return Self::Null,
        };
        if let Some((key, inner)) = single_field(fields) {
            match key {
                "u" => return Self::Undefined,
                "nul" => return Self::Null,
                "f" => return Self::Float(f64::from_bits(hex(inner))),
                "s" => {
                    return Self::Text(JsString::from_units(
                        as_array(inner)
                            .iter()
                            .map(|unit| as_float(unit) as u16)
                            .collect(),
                    ));
                }
                "b" => {
                    let JsonValue::Bool(flag) = inner else {
                        panic!("boolean wrapper")
                    };
                    return Self::Bool(*flag);
                }
                "a" => return Self::Array(as_array(inner).iter().map(Self::of).collect()),
                "o" => {
                    return Self::Object(
                        as_array(inner)
                            .iter()
                            .map(|pair| {
                                let pair = as_array(pair);
                                assert_eq!(pair.len(), 2, "encoded object entry");
                                (as_text(&pair[0]).to_utf8_lossy(), Self::of(&pair[1]))
                            })
                            .collect(),
                    );
                }
                _ => {}
            }
        }
        Self::Object(
            fields
                .iter()
                .map(|(key, value)| (key.as_str().unwrap_or_default().to_owned(), Self::of(value)))
                .collect(),
        )
    }

    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    fn to_json(&self) -> JsonValue {
        match self {
            Self::Undefined | Self::Null => JsonValue::Null,
            Self::Float(value) => JsonValue::Number(*value),
            Self::Text(text) => JsonValue::String(text.clone()),
            Self::Bool(flag) => JsonValue::Bool(*flag),
            Self::Array(items) => JsonValue::Array(items.iter().map(Self::to_json).collect()),
            Self::Object(fields) => JsonValue::Object(
                fields
                    .iter()
                    .map(|(key, value)| (JsString::from(key.as_str()), value.to_json()))
                    .collect(),
            ),
        }
    }
}

fn single_field(fields: &[(JsString, JsonValue)]) -> Option<(&str, &JsonValue)> {
    if fields.len() != 1 {
        return None;
    }
    let (key, value) = &fields[0];
    Some((key.as_str()?, value))
}

fn as_array(value: &JsonValue) -> &[JsonValue] {
    let JsonValue::Array(items) = value else {
        panic!("encoded array")
    };
    items
}

fn as_float(value: &JsonValue) -> f64 {
    let JsonValue::Number(number) = value else {
        panic!("encoded number")
    };
    *number
}

fn as_text(value: &JsonValue) -> &JsString {
    let JsonValue::String(text) = value else {
        panic!("encoded string")
    };
    text
}

fn hex(value: &JsonValue) -> u64 {
    u64::from_str_radix(as_text(value).as_str().expect("hex text"), 16).expect("hex bits")
}

fn text_of(enc: &Enc) -> JsString {
    match enc {
        Enc::Text(text) => text.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

fn float_of(enc: &Enc) -> f64 {
    match enc {
        Enc::Float(value) => *value,
        other => panic!("expected number, got {other:?}"),
    }
}

fn optional_text(enc: Option<&Enc>) -> Option<JsString> {
    match enc {
        None | Some(Enc::Undefined) | Some(Enc::Null) => None,
        Some(Enc::Text(text)) => Some(text.clone()),
        Some(other) => panic!("expected optional text, got {other:?}"),
    }
}

fn optional_float(enc: Option<&Enc>) -> Option<f64> {
    match enc {
        None | Some(Enc::Undefined) | Some(Enc::Null) => None,
        Some(Enc::Float(value)) => Some(*value),
        Some(other) => panic!("expected optional number, got {other:?}"),
    }
}

#[derive(Debug)]
struct Case {
    id: String,
    input: TtsUsageTrackOptions,
    text_marker: JsString,
    now_millis: i64,
    cache_calls: Vec<Vec<String>>,
    failed_step: Option<usize>,
    billing_calls: usize,
    billing_failed: bool,
    billing: Option<Enc>,
    logs: Vec<Enc>,
    usage: Option<TtsUsageResult>,
    thrown: Option<String>,
}

fn case_from_enc(case: &Enc) -> Case {
    let input = case.get("input").expect("input");
    let streamer = input.get("streamer").expect("streamer");
    let usage = input.get("usage").and_then(|usage| {
        if matches!(usage, Enc::Undefined | Enc::Null) {
            return None;
        }
        Some(TtsUsageContext {
            entry_id: optional_text(usage.get("entryId")),
            request_id: optional_text(usage.get("requestId")),
            source: optional_text(usage.get("source")),
            resource_type: optional_text(usage.get("resourceType")),
            resource_id: optional_text(usage.get("resourceId")),
        })
    });
    let clock = case.get("clock").expect("clock");
    let cache = case.get("cache").expect("cache");
    let billing = case.get("billing").expect("billing");
    let result = case.get("result").expect("result");
    let (value, thrown) = match result.get("usage") {
        Some(usage) => (
            Some(TtsUsageResult {
                characters: float_of(usage.get("characters").expect("characters")),
                credits_consumed: float_of(usage.get("creditsConsumed").expect("creditsConsumed")),
                polarsh_cost: float_of(usage.get("polarshCost").expect("polarshCost")),
                cost_usd: float_of(usage.get("costUsd").expect("costUsd")),
            }),
            None,
        ),
        None => (
            None,
            Some(text_of(result.get("thrown").expect("thrown")).to_utf8_lossy()),
        ),
    };
    Case {
        id: text_of(case.get("id").expect("id")).to_utf8_lossy(),
        input: TtsUsageTrackOptions {
            channel_id: text_of(input.get("channelID").expect("channelID")),
            streamer: TtsUsageStreamer {
                polar_sh_customer_id: optional_text(streamer.get("polar_sh_customer_id")),
                plan_tier: optional_text(streamer.get("plan_tier")),
            },
            provider: text_of(input.get("provider").expect("provider")),
            characters: float_of(input.get("characters").expect("characters")),
            text: text_of(input.get("text").expect("text")),
            require_durable_usage: matches!(
                input.get("requireDurableUsage"),
                Some(Enc::Bool(true))
            ),
            usage,
        },
        text_marker: text_of(case.get("text").expect("text")),
        now_millis: match clock.get("nowMillis") {
            Some(Enc::Float(value)) => *value as i64,
            other => panic!("clock: {other:?}"),
        },
        cache_calls: match cache.get("calls") {
            Some(Enc::Array(calls)) => calls
                .iter()
                .map(|call| match call {
                    Enc::Array(parts) => parts
                        .iter()
                        .map(|part| text_of(part).to_utf8_lossy())
                        .collect(),
                    other => panic!("cache call: {other:?}"),
                })
                .collect(),
            other => panic!("cache calls: {other:?}"),
        },
        failed_step: match cache.get("failedStep") {
            None | Some(Enc::Undefined) | Some(Enc::Null) => None,
            Some(Enc::Float(value)) => Some(*value as usize),
            other => panic!("failed step: {other:?}"),
        },
        billing_calls: match billing.get("calls") {
            Some(Enc::Float(value)) => *value as usize,
            other => panic!("billing calls: {other:?}"),
        },
        billing_failed: matches!(billing.get("failed"), Some(Enc::Bool(true))),
        billing: billing
            .get("options")
            .filter(|options| !matches!(options, Enc::Undefined | Enc::Null))
            .cloned(),
        logs: match case.get("logs") {
            Some(Enc::Array(logs)) => logs.clone(),
            other => panic!("logs: {other:?}"),
        },
        usage: value,
        thrown,
    }
}

fn cache_options(enc: &Enc) -> CacheUsageOptions {
    CacheUsageOptions {
        customer_id: text_of(enc.get("customerId").expect("customerId")),
        channel_id: text_of(enc.get("channelID").expect("channelID")),
        external_id: optional_text(enc.get("externalId")),
        cost: float_of(enc.get("cost").expect("cost")),
        reason: text_of(enc.get("reason").expect("reason")),
        llm: None,
        polar_cost: optional_float(enc.get("_cost")),
        characters: optional_float(enc.get("characters")),
        usage: enc.get("usage").expect("usage").to_json(),
    }
}

fn read_fixture() -> Vec<Case> {
    let path = std::env::var("TTS_USAGE_TRACKING_FIXTURE")
        .expect("supplied pinned tts_usage_tracking_reference.json path");
    let pin = std::env::var("TTS_USAGE_TRACKING_FIXTURE_SHA256")
        .expect("independently supplied fixture SHA-256");
    let bytes = std::fs::read(&path).expect("read pinned source oracle fixture");
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        pin,
        "fixture does not match the externally supplied SHA-256"
    );
    let fixture = parse_json(std::str::from_utf8(&bytes).expect("UTF-8 fixture"))
        .expect("valid fixture JSON");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let source_hashes = fixture
        .get("metadata")
        .and_then(|meta| meta.get("hashes"))
        .expect("source hashes");
    for (key, path, pin) in [
        (
            "source",
            "src/utils/tts_usage.ts",
            "a92eb3d6135d1ba1564112fbb720ac1ac0b9279c7dc465d1677e3281fc08dae7",
        ),
        (
            "polarsh",
            "src/utils/polarsh.ts",
            "5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec",
        ),
        (
            "dragonflyBootstrap",
            "src/utils/databases/dragonfly.database.ts",
            "0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c",
        ),
        (
            "package",
            "package.json",
            "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef",
        ),
        (
            "lock",
            "package-lock.json",
            "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7",
        ),
    ] {
        let actual = format!(
            "{:x}",
            Sha256::digest(std::fs::read(root.join(path)).expect("source file"))
        );
        assert_eq!(actual, pin, "{path}");
        assert_eq!(
            source_hashes.get(key),
            Some(&JsonValue::String(pin.into())),
            "{key}"
        );
    }
    let Some(JsonValue::Object(files)) = fixture
        .get("metadata")
        .and_then(|meta| meta.get("nativeHashes"))
    else {
        panic!("native file hashes")
    };
    assert_eq!(files.len(), 3);
    for (name, hash) in files {
        let JsonValue::String(hash) = hash else {
            panic!("native hash")
        };
        let path = std::path::Path::new(name.as_str().expect("hash key"));
        assert!(
            path.components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        );
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(path)).expect("owned native file"))
            ),
            hash.as_str().expect("hash text"),
            "{path:?}"
        );
    }
    let JsonValue::Array(cases) = fixture.get("cases").expect("cases") else {
        panic!("case array")
    };
    cases
        .iter()
        .map(|value| case_from_enc(&Enc::of(value)))
        .collect()
}

fn cases() -> Vec<Case> {
    read_fixture()
}

// ---------------------------------------------------------------------------
// Pure contract: pricing re-export and the source local-time expiry formula.
// ---------------------------------------------------------------------------

#[test]
fn source_oracle_pricing_and_expiry_contract() {
    let cases = cases();
    assert_eq!(cases.len(), 14);
    let mut providers = std::collections::BTreeSet::new();
    for case in &cases {
        let actual = calculate_tts_usage(
            case.input.provider.as_str().expect("ASCII provider"),
            case.input.characters,
        );
        match case.usage {
            Some(expected) => {
                for (label, actual, expected) in [
                    ("characters", actual.characters, expected.characters),
                    (
                        "creditsConsumed",
                        actual.credits_consumed,
                        expected.credits_consumed,
                    ),
                    ("polarshCost", actual.polarsh_cost, expected.polarsh_cost),
                    ("costUsd", actual.cost_usd, expected.cost_usd),
                ] {
                    assert_eq!(actual.to_bits(), expected.to_bits(), "{}: {label}", case.id);
                }
            }
            None => assert_eq!(
                case.thrown.as_deref(),
                Some(RECORDING_UNAVAILABLE),
                "{}: only the durable guard throws",
                case.id
            ),
        }
        providers.insert(case.input.provider.to_utf8_lossy());

        // The source always dispatches TTS through `mode: "batch"`. The native
        // adapter is `PolarUsage::ingest`: queue, project, then flush.
        if let Some(options) = &case.billing {
            assert_eq!(
                options.get("mode"),
                Some(&Enc::Text("batch".into())),
                "{}: source mode dispatch",
                case.id
            );
        }

        // The recorded calls are the source's own cache-boundary arguments.
        assert_eq!(
            case.cache_calls.first().map(Vec::as_slice),
            Some(["acquire".to_owned(), "Messages".to_owned()].as_slice()),
            "{}: source caller label",
            case.id
        );
        let commands = &case.cache_calls[1..];
        assert!(!commands.is_empty(), "{}", case.id);
        if case.failed_step != Some(1) {
            let expire = commands
                .iter()
                .find(|call| call[0] == "expire")
                .expect("source expiry call");
            assert_eq!(
                expire[2],
                generate_time_left_to_next_month_in_seconds(case.now_millis)
                    .expect("local wall clock")
                    .to_string(),
                "{}: source expiry",
                case.id
            );
        }
        if case.failed_step.is_none() {
            let shape: Vec<&str> = commands.iter().map(|call| call[0].as_str()).collect();
            assert_eq!(
                shape,
                [
                    "hincrby", "hincrby", "hincrby", "expire", "hincrby", "hincrby"
                ],
                "{}: source cache order",
                case.id
            );
            let provider = case.input.provider.to_utf8_lossy();
            for (index, suffix) in [
                "characters",
                "credits",
                "cost",
                "total_characters",
                "total_credits",
            ]
            .iter()
            .enumerate()
            {
                let call = &commands[if index < 3 { index } else { index + 1 }];
                let field = if index < 3 {
                    format!("{provider}_{suffix}")
                } else {
                    (*suffix).to_owned()
                };
                assert_eq!(call[2], field, "{}: field {}", case.id, index);
            }
        }
        let marker = case.text_marker.to_utf8_lossy();
        assert!(!marker.is_empty());
        for log in &case.logs {
            assert!(
                !format!("{log:?}").contains(&marker),
                "{}: text leak",
                case.id
            );
        }
    }
    assert_eq!(
        providers.into_iter().collect::<Vec<_>>(),
        ["fish", "kokoro", "piper"]
    );
    // Source local-time boundary: day 30 is non-positive, day 31 is negative.
    let day30 = cases.iter().find(|case| case.id == "piper-day-30").unwrap();
    assert_eq!(
        generate_time_left_to_next_month_in_seconds(day30.now_millis).unwrap(),
        -43_200
    );
    let day31 = cases
        .iter()
        .find(|case| case.id == "kokoro-day-31")
        .unwrap();
    assert_eq!(
        generate_time_left_to_next_month_in_seconds(day31.now_millis).unwrap(),
        -86_400
    );
}

// ---------------------------------------------------------------------------
// Concrete replay helpers.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ConsoleCapture {
    records: Mutex<Vec<serde_json::Value>>,
}

impl ConsoleSink for ConsoleCapture {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.records
                .lock()
                .unwrap()
                .push(serde_json::from_str(&record.json).unwrap());
            Ok(())
        })
    }
}

fn logged(capture: &ConsoleCapture, function: &str) -> Vec<serde_json::Value> {
    capture
        .records
        .lock()
        .unwrap()
        .iter()
        .filter(|record| record["data"]["function"] == function)
        .cloned()
        .collect()
}

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_millis(&self) -> i64 {
        self.0
    }
}

fn fixture_logger(control: &ConnectionManager, capture: Arc<ConsoleCapture>) -> Logger {
    let sink = RedisCacheSink::new(control.clone(), Duration::from_secs(2)).expect("logger sink");
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(Arc::new(sink)),
            console: Some(capture),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("fixture logger")
}

fn fixture_tracking(peer: &polar_support::HttpPeer) -> PosthogTracking {
    let mut config = PosthogLosslessConfig::new("fixture", peer.endpoint());
    config.flush_interval = Duration::from_secs(3600);
    config.flush_at = 1000;
    PosthogTracking::from_lossless_config(config).expect("loopback analytics")
}

fn fixture_namespace() -> String {
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_OWNER").as_deref(),
        Ok("tts-usage-tracking")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("task namespace");
    let suffix = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("fixture namespace shape");
    assert_eq!(suffix.len(), 12);
    assert!(
        suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    namespace
}

fn scoped_cases() -> Vec<Case> {
    fn replace(value: &mut Enc, old: &JsString, new: &JsString) {
        match value {
            Enc::Text(text) if text == old => *text = new.clone(),
            Enc::Array(values) => values.iter_mut().for_each(|value| replace(value, old, new)),
            Enc::Object(fields) => fields
                .iter_mut()
                .for_each(|(_, value)| replace(value, old, new)),
            _ => {}
        }
    }
    let prefix = fixture_namespace().replace(':', "-");
    let mut cases = cases();
    for case in &mut cases {
        let old = case.input.channel_id.clone();
        let new = JsString::from(format!("{prefix}{}", old.to_utf8_lossy()));
        for call in &mut case.cache_calls {
            for part in call {
                *part = part.replace(&old.to_utf8_lossy(), &new.to_utf8_lossy());
            }
        }
        if let Some(billing) = &mut case.billing {
            replace(billing, &old, &new);
        }
        for log in &mut case.logs {
            replace(log, &old, &new);
        }
        case.input.channel_id = new;
        if let Some(old) = case
            .input
            .usage
            .as_ref()
            .and_then(|usage| usage.entry_id.clone())
        {
            let new = JsString::from(format!("{prefix}{}", old.to_utf8_lossy()));
            if let Some(billing) = &mut case.billing {
                replace(billing, &old, &new);
            }
            if let Some(usage) = &mut case.input.usage {
                usage.entry_id = Some(new);
            }
        }
    }
    cases
}

async fn command<T: redis::FromRedisValue>(
    cache: &ConnectionManager,
    command: &mut redis::Cmd,
) -> T {
    let mut cache = cache.clone();
    polar_support::bounded(command.query_async(&mut cache))
        .await
        .expect("private Dragonfly command")
}

async fn exists(cache: &ConnectionManager, keys: &[&str]) -> i64 {
    command(cache, redis::cmd("EXISTS").arg(keys)).await
}

async fn string_list(cache: &ConnectionManager, key: &str) -> Vec<String> {
    command(cache, redis::cmd("LRANGE").arg(key).arg(0).arg(-1)).await
}

async fn hash(cache: &ConnectionManager, key: &str) -> BTreeMap<String, i64> {
    let entries: Vec<(String, String)> = command(cache, redis::cmd("HGETALL").arg(key)).await;
    entries
        .into_iter()
        .map(|(field, value)| (field, value.parse().expect("numeric counter")))
        .collect()
}

async fn ttl(cache: &ConnectionManager, key: &str) -> i64 {
    command(cache, redis::cmd("TTL").arg(key)).await
}

async fn logger_keys(cache: &ConnectionManager, channel: &str) -> Vec<String> {
    let pattern = format!("logger:twitch:{channel}:*");
    let mut cursor = 0_u64;
    let mut keys = Vec::new();
    loop {
        let (next, page): (u64, Vec<String>) = command(
            cache,
            redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(100),
        )
        .await;
        keys.extend(page);
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    keys
}

struct Owned {
    key: String,
    queue: String,
    lock: String,
    channel: String,
    credits: Option<f64>,
    receipt_id: Option<String>,
}

impl Owned {
    fn of(
        options: &TtsUsageTrackOptions,
        credits: Option<f64>,
        external_id: Option<&JsString>,
    ) -> Self {
        let channel = options.channel_id.to_utf8_lossy();
        Self {
            key: format!("{channel}:tts:usage"),
            queue: format!("twitch:{channel}:ai:polarshevent"),
            lock: format!("locks:polar-ingest:{channel}"),
            channel,
            credits,
            receipt_id: external_id.map(JsString::to_utf8_lossy),
        }
    }

    async fn clean(&self, cache: &ConnectionManager) {
        if let Some(id) = &self.receipt_id {
            for row in string_list(cache, AI_USAGE_RECEIPT_QUEUE_KEY).await {
                let value = parse_json(&row).expect("receipt JSON");
                if matches!(value.get("id"), Some(JsonValue::String(value)) if value.as_str() == Some(id))
                {
                    let _: i64 = command(
                        cache,
                        redis::cmd("LREM")
                            .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                            .arg(0)
                            .arg(row),
                    )
                    .await;
                }
            }
        }
        let mut keys = vec![self.key.clone(), self.queue.clone(), self.lock.clone()];
        if let (Some(credits), Some(id)) = (self.credits, &self.receipt_id)
            && let Some(record) = record_command_at(
                &JsString::from(self.channel.as_str()),
                credits,
                Some(&JsString::from(id.as_str())),
                SystemTime::now(),
            )
            .expect("projection keys")
        {
            keys.extend(record.keys);
        }
        let _: i64 = command(
            cache,
            redis::cmd("DEL").arg(keys.iter().map(String::as_str).collect::<Vec<_>>()),
        )
        .await;
        for key in logger_keys(cache, &self.channel).await {
            let _: i64 = command(cache, redis::cmd("DEL").arg(key)).await;
        }
    }
}

fn strip_dates(wire: &str) -> JsonValue {
    let JsonValue::Object(mut fields) = parse_json(wire).expect("receipt object") else {
        panic!("receipt object")
    };
    fields.retain(|(key, _)| !matches!(key.as_str(), Some("occurredAt" | "enqueuedAt")));
    JsonValue::Object(fields)
}

fn lowered_command(command: &[u8]) -> String {
    String::from_utf8_lossy(command).to_ascii_lowercase()
}

fn rpush_values(proxy: &polar_support::Proxy, key: &str) -> Vec<String> {
    proxy
        .attempts()
        .into_iter()
        .filter(|args| {
            args.first()
                .is_some_and(|command| lowered_command(command) == "rpush")
                && args
                    .get(1)
                    .is_some_and(|value| value.as_slice() == key.as_bytes())
        })
        .map(|args| String::from_utf8_lossy(args.get(2).expect("RPUSH value")).into_owned())
        .collect()
}

fn saw_queue_command(proxy: &polar_support::Proxy, command: &str, key: &str) -> bool {
    proxy.attempts().iter().any(|args| {
        args.first()
            .is_some_and(|name| lowered_command(name) == command)
            && args
                .get(1)
                .is_some_and(|value| value.as_slice() == key.as_bytes())
    })
}

fn assert_batch_request(request: &polar_batch_http::RecordedRequest, wire: &str) {
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, POLAR_EVENTS_INGEST_PATH);
    assert_eq!(request.header("authorization"), Some("Bearer fixture-oat"));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.header("user-agent"), Some(POLAR_EVENTS_USER_AGENT));
    let content_type = request.header("content-type").expect("content-type");
    assert_eq!(
        content_type.split(';').next().unwrap().trim(),
        "application/json"
    );
    let event = parse_json(wire).expect("queued event wire");
    let body = events_ingest_body(std::slice::from_ref(&event)).expect("sdk body");
    assert_eq!(request.body_str(), body);
}

fn batch_tracker(
    cache: ConnectionManager,
    tracking: PosthogTracking,
    logger: Logger,
    clock: Arc<dyn Clock>,
    base_url: &str,
) -> TtsUsageTracker {
    let client = PolarClient::new(
        PolarConfig::new(base_url, "fixture-oat").expect("loopback polar config"),
        PolarPolicy::Billing,
    )
    .expect("loopback polar client");
    let durable = PolarCacheUsage::with_logger(
        cache.clone(),
        AiCreditProjection::new(cache.clone(), DEFAULT_USAGE_DEADLINE),
        AiUsageProducer::new(cache.clone()),
        tracking,
        logger.clone(),
    );
    TtsUsageTracker::with_batch_clock(
        cache,
        PolarUsage::shared(durable, client, logger.clone()),
        logger,
        clock,
    )
}

fn attempted_for(proxy: &polar_support::Proxy, key: &str) -> Vec<Vec<String>> {
    proxy
        .attempts()
        .into_iter()
        .filter(|args| {
            args.get(1)
                .is_some_and(|value| value.as_slice() == key.as_bytes())
        })
        .map(|args| {
            let mut parts = Vec::with_capacity(args.len());
            parts.push(lowered_command(&args[0]));
            parts.extend(
                args[1..]
                    .iter()
                    .map(|part| String::from_utf8_lossy(part).into_owned()),
            );
            parts
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Concrete replay against the task-private Dragonfly.
// ---------------------------------------------------------------------------

async fn replay_case(
    control: &ConnectionManager,
    tracking: &PosthogTracking,
    case: &Case,
    delivered: &mut Vec<String>,
) {
    use polar_support::{Catch, Fault, Proxy, bounded};

    let billing = case.billing.as_ref().map(cache_options);
    let mut owned = Owned::of(
        &case.input,
        billing
            .as_ref()
            .map(|options| options.polar_cost.unwrap_or(0.0) * 1000.0),
        billing
            .as_ref()
            .and_then(|options| options.external_id.as_ref()),
    );
    assert_eq!(
        exists(control, &[&owned.key, &owned.queue, &owned.lock]).await,
        0,
        "{}: fixture keys must be fresh",
        case.id
    );
    let seeded = billing.as_ref().map(|options| {
        let event = prepare_event(options).expect("native Polar event");
        let record = record_command_at(
            &options.channel_id,
            event.credits,
            options.external_id.as_ref(),
            SystemTime::now(),
        )
        .expect("projection command")
        .expect("billable projection");
        (record.keys, event.credits)
    });
    if let Some((keys, _)) = &seeded {
        let _: () = command(control, redis::cmd("SET").arg(&keys[0]).arg(SNAPSHOT)).await;
        owned.credits = Some(seeded.as_ref().unwrap().1);
    }

    let capture = Arc::new(ConsoleCapture::default());
    let logger = fixture_logger(control, capture.clone());
    let proxy = Proxy::new();
    let through = bounded(ConnectionManager::new(
        redis::Client::open(proxy.url()).expect("proxy URI"),
    ))
    .await
    .expect("proxy manager");
    match case.failed_step {
        Some(4) => proxy.arm("EXPIRE", &owned.key, Fault::Reject),
        Some(1) | None => {}
        other => panic!("{}: unexpected source failure step {other:?}", case.id),
    }
    if case.billing_failed {
        proxy.arm("RPUSH", &owned.queue, Fault::Reject);
    }
    let http = polar_batch_http::PolarHttp::inserted(1, 0);
    let tracker = batch_tracker(
        through,
        tracking.clone(),
        logger,
        Arc::new(FixedClock(case.now_millis)),
        &http.base_url,
    );

    let outcome = Catch(Box::pin(async {
        let result = tracker.track(&case.input).await;
        match (&case.thrown, result) {
            (Some(expected), Err(error)) => {
                assert_eq!(
                    error,
                    TtsUsageTrackError::RecordingUnavailable,
                    "{}",
                    case.id
                );
                assert_eq!(
                    error.to_string(),
                    expected.as_str(),
                    "{}: thrown message",
                    case.id
                );
                assert_eq!(error.to_string(), RECORDING_UNAVAILABLE);
            }
            (None, Ok(usage)) => {
                let expected = case.usage.expect("source usage");
                for (label, actual, expected) in [
                    ("characters", usage.characters, expected.characters),
                    ("credits", usage.credits_consumed, expected.credits_consumed),
                    ("polarshCost", usage.polarsh_cost, expected.polarsh_cost),
                    ("costUsd", usage.cost_usd, expected.cost_usd),
                ] {
                    assert_eq!(actual.to_bits(), expected.to_bits(), "{}: {label}", case.id);
                }
            }
            (expected, actual) => {
                panic!("{}: unexpected outcome {expected:?} / {actual:?}", case.id)
            }
        }

        // The cache command sequence is exactly the source's recorded calls.
        let expected_calls: Vec<Vec<String>> = case.cache_calls[1..].to_vec();
        assert_eq!(
            attempted_for(&proxy, &owned.key),
            expected_calls,
            "{}: cache command sequence",
            case.id
        );

        // Counter and expiry state implied by those recorded calls.
        let mut expected_hash: BTreeMap<String, i64> = BTreeMap::new();
        let mut expected_ttl = -1_i64;
        if case.failed_step != Some(1) {
            for call in &expected_calls {
                match call[0].as_str() {
                    "hincrby" => {
                        let value: i64 = call[3]
                            .parse()
                            .expect("integral source increment reaches Redis");
                        *expected_hash.entry(call[2].clone()).or_insert(0) += value;
                    }
                    "expire" => {
                        let seconds: i64 = call[2].parse().expect("source expiry seconds");
                        if seconds > 0 {
                            expected_ttl = seconds;
                        } else {
                            // Dragonfly deletes on a non-positive EXPIRE; the
                            // totals then recreate the hash without a TTL.
                            expected_hash.clear();
                        }
                    }
                    other => panic!("{}: unexpected cache call {other}", case.id),
                }
            }
        }
        if case.failed_step == Some(4) {
            // The rejected EXPIRE never reached Dragonfly.
            expected_ttl = -1;
        }
        assert_eq!(
            hash(control, &owned.key).await,
            expected_hash,
            "{}: counters",
            case.id
        );
        let observed_ttl = ttl(control, &owned.key).await;
        if expected_hash.is_empty() {
            assert_eq!(observed_ttl, -2, "{}: missing key", case.id);
        } else if expected_ttl > 0 {
            assert!(
                (expected_ttl - 5..=expected_ttl).contains(&observed_ttl),
                "{}: TTL {observed_ttl} vs {expected_ttl}",
                case.id
            );
        } else {
            assert_eq!(observed_ttl, -1, "{}: no expiry retained", case.id);
        }

        // Durable Polar queue wire, receipt, projection, and analytics identity.
        match &billing {
            Some(options) if !case.billing_failed => {
                let wires = rpush_values(&proxy, &owned.queue);
                assert_eq!(wires.len(), case.billing_calls, "{}: queued rows", case.id);
                assert!(
                    string_list(control, &owned.queue).await.is_empty(),
                    "{}: successful flush trims the queue",
                    case.id
                );
                assert!(
                    saw_queue_command(&proxy, "lrange", &owned.queue),
                    "{}",
                    case.id
                );
                assert!(
                    saw_queue_command(&proxy, "ltrim", &owned.queue),
                    "{}",
                    case.id
                );
                let requests = http.requests();
                assert_eq!(
                    requests.len(),
                    case.billing_calls,
                    "{}: polar http",
                    case.id
                );
                for (request, wire) in requests.iter().zip(&wires) {
                    assert_batch_request(request, wire);
                }
                let mut expected = options.clone();
                if expected.external_id.is_none() {
                    let JsonValue::Object(fields) = parse_json(&wires[0]).expect("wire JSON")
                    else {
                        panic!("wire object")
                    };
                    let id = fields
                        .iter()
                        .find(|(key, _)| key.as_str() == Some("externalId"))
                        .map(|(_, value)| value.clone())
                        .expect("generated external id");
                    let JsonValue::String(id) = id else {
                        panic!("external id")
                    };
                    let text = id.as_str().expect("generated id is ASCII");
                    assert!(text.starts_with("aiu_"), "{}: generated id {text}", case.id);
                    expected.external_id = Some(id);
                }
                owned.receipt_id = expected.external_id.as_ref().map(JsString::to_utf8_lossy);
                let prepared = prepare_event(&expected).expect("native Polar event");
                for row in &wires {
                    assert_eq!(*row, prepared.wire, "{}: queue wire", case.id);
                    assert!(
                        !row.contains(&case.text_marker.to_utf8_lossy()),
                        "{}: text leaked into the billing wire",
                        case.id
                    );
                }
                let expected_receipt = build_queued_ai_usage_receipt_json(
                    expected.channel_id.clone(),
                    expected.customer_id.clone(),
                    None,
                    &prepared.context,
                    prepared.credits,
                )
                .expect("native receipt");
                let id = expected.external_id.clone().unwrap();
                let receipts: Vec<JsonValue> = string_list(control, AI_USAGE_RECEIPT_QUEUE_KEY)
                    .await
                    .iter()
                    .map(|row| parse_json(row).expect("receipt JSON"))
                    .collect();
                let matching: Vec<&JsonValue> = receipts
                    .iter()
                    .filter(|receipt| {
                        matches!(receipt.get("id"), Some(JsonValue::String(value)) if value == &id)
                    })
                    .collect();
                assert_eq!(
                    matching.len(),
                    case.billing_calls,
                    "{}: receipt rows",
                    case.id
                );
                assert_eq!(
                    strip_dates(&matching[0].to_json_string()),
                    strip_dates(&expected_receipt.json()),
                    "{}: receipt wire",
                    case.id
                );
                if let Some((keys, credits)) = &seeded {
                    let snapshot: String = command(control, redis::cmd("GET").arg(&keys[0])).await;
                    let snapshot = parse_json(&snapshot).expect("snapshot JSON");
                    assert_eq!(
                        snapshot.get("balance"),
                        Some(&JsonValue::Number(5000.0 - credits)),
                        "{}: projected balance",
                        case.id
                    );
                    assert_eq!(
                        snapshot.get("used"),
                        Some(&JsonValue::Number(*credits)),
                        "{}: projected usage",
                        case.id
                    );
                }
                delivered.push(id.to_utf8_lossy());
            }
            Some(_) => {
                // The durable hand-off failed before HTTP: nothing is queued or projected.
                assert_eq!(case.billing_calls, 1);
                assert!(
                    http.requests().is_empty(),
                    "{}: rejected ingestion sends no HTTP",
                    case.id
                );
                assert!(
                    saw_queue_command(&proxy, "rpush", &owned.queue),
                    "{}",
                    case.id
                );
                assert!(
                    !saw_queue_command(&proxy, "ltrim", &owned.queue),
                    "{}",
                    case.id
                );
                assert_eq!(
                    exists(control, &[&owned.queue]).await,
                    0,
                    "{}: rejected ingestion leaves no queue",
                    case.id
                );
                if let Some(id) = &owned.receipt_id {
                    let receipts = string_list(control, AI_USAGE_RECEIPT_QUEUE_KEY).await;
                    assert!(
                        !receipts.iter().any(|row| {
                            matches!(parse_json(row).unwrap().get("id"),
                                Some(JsonValue::String(value)) if value.as_str() == Some(id))
                        }),
                        "{}: no receipt for a rejected hand-off",
                        case.id
                    );
                }
            }
            None => {
                assert_eq!(case.billing_calls, 0);
                assert!(
                    http.requests().is_empty(),
                    "{}: no HTTP without billing",
                    case.id
                );
                assert_eq!(
                    exists(control, &[&owned.queue]).await,
                    0,
                    "{}: no Polar queue without a billable customer",
                    case.id
                );
            }
        }

        // Cache-failure logging: exact source fields at both destinations.
        let records = logged(&capture, "trackTtsUsage");
        assert_eq!(
            records.len(),
            case.logs.len(),
            "{}: cache log count",
            case.id
        );
        for (record, expected) in records.iter().zip(case.logs.iter()) {
            let Enc::Array(parts) = expected else {
                panic!("log record")
            };
            let payload = &parts[0];
            assert_eq!(
                payload.get("function"),
                Some(&Enc::Text("trackTtsUsage".into())),
                "{}: log function",
                case.id
            );
            assert_eq!(
                payload.get("channelID"),
                Some(&Enc::Text(case.input.channel_id.clone())),
                "{}: log channel",
                case.id
            );
            assert_eq!(
                payload.get("provider"),
                Some(&Enc::Text(case.input.provider.clone())),
                "{}: log provider",
                case.id
            );
            assert_eq!(
                payload.get("characters"),
                Some(&Enc::Float(case.input.characters)),
                "{}: log characters",
                case.id
            );
            let error = record["data"]["error"].as_str().expect("logged error text");
            assert!(!error.is_empty(), "{}: logged error message", case.id);
            assert!(
                record["data"]
                    .as_object()
                    .map(|fields| !fields.contains_key("text"))
                    .unwrap_or(false),
                "{}: text is never logged",
                case.id
            );
            let options = &parts[1];
            assert_eq!(
                options.get("channelId"),
                Some(&Enc::Text(case.input.channel_id.clone())),
                "{}: log channel option",
                case.id
            );
            assert_eq!(
                options.get("destination"),
                Some(&Enc::Text("both".into())),
                "{}: log destination",
                case.id
            );
            assert!(
                !record
                    .to_string()
                    .contains(&case.text_marker.to_utf8_lossy()),
                "{}: text leaked into a console record",
                case.id
            );
        }
        let mut cached_tracking = 0;
        for key in logger_keys(control, &owned.channel).await {
            let stored: String = command(control, redis::cmd("GET").arg(&key)).await;
            let entry = parse_json(&stored).expect("cached log JSON");
            assert_eq!(entry.get("level"), Some(&JsonValue::String("error".into())));
            assert_eq!(
                entry.get("platform"),
                Some(&JsonValue::String("twitch".into()))
            );
            assert_eq!(
                entry.get("channelId"),
                Some(&JsonValue::String(case.input.channel_id.clone()))
            );
            assert!(ttl(control, &key).await > 0, "{}: cache log TTL", case.id);
            if entry.get("data").and_then(|data| data.get("function"))
                == Some(&JsonValue::String("trackTtsUsage".into()))
            {
                cached_tracking += 1;
            }
        }
        assert_eq!(
            cached_tracking,
            case.logs.len(),
            "{}: source log reached the cache destination",
            case.id
        );
        assert_eq!(
            exists(control, &[&owned.key]).await,
            if expected_hash.is_empty() { 0 } else { 1 },
            "{}: counter key presence before cleanup",
            case.id
        );
        assert_eq!(
            exists(control, &[&owned.lock]).await,
            0,
            "{}: ingest lock released",
            case.id
        );
    }))
    .await;

    let cleanup = Catch(Box::pin(async {
        owned.clean(control).await;
        assert_eq!(
            exists(control, &[&owned.key, &owned.queue, &owned.lock]).await,
            0,
            "{}: owned keys removed",
            case.id
        );
        assert_eq!(logger_keys(control, &owned.channel).await.len(), 0);
    }))
    .await;
    drop(proxy);
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis, exact owner, and pinned source oracle"]
async fn source_oracle_replay_against_private_dragonfly() {
    use polar_support::{HttpPeer, bounded};
    let cases = scoped_cases();
    assert_eq!(cases.len(), 14, "pinned oracle inventory");
    let control = bounded(ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").expect("fixture URI"),
    ))
    .await
    .expect("private Dragonfly");
    assert_eq!(
        string_list(&control, AI_USAGE_RECEIPT_QUEUE_KEY)
            .await
            .len(),
        0,
        "receipt queue must start empty in the owned fixture"
    );
    let peer = HttpPeer::new();
    let tracking = fixture_tracking(&peer);
    let mut delivered = Vec::new();
    for case in &cases {
        replay_case(&control, &tracking, case, &mut delivered).await;
    }
    assert_eq!(
        delivered.len(),
        10,
        "successful durable hand-offs delivered analytics"
    );
    tracking.flush().await.expect("loopback analytics flush");
    let batch = parse_json(&peer.body()).expect("PostHog batch JSON");
    let JsonValue::Array(events) = batch.get("batch").expect("batch") else {
        panic!("batch array")
    };
    assert_eq!(events.len(), delivered.len(), "analytics event count");
    for event in events {
        assert_eq!(
            event.get("event"),
            Some(&JsonValue::String("ai_usage_recorded".into()))
        );
        let Some(JsonValue::String(insert_id)) = event
            .get("properties")
            .and_then(|properties| properties.get("$insert_id"))
        else {
            panic!("analytics insert id")
        };
        assert!(
            delivered
                .iter()
                .any(|id| id == insert_id.as_str().unwrap_or_default()),
            "analytics identity must be a delivered durable entry"
        );
    }
    assert_eq!(
        string_list(&control, AI_USAGE_RECEIPT_QUEUE_KEY)
            .await
            .len(),
        0,
        "owned receipts removed"
    );
}

// ---------------------------------------------------------------------------
// Durable projection and receipt idempotency for a repeated stable entry ID.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and exact owner"]
async fn durable_projection_and_receipt_idempotency() {
    use polar_support::{Catch, HttpPeer, bounded};
    let case = scoped_cases()
        .into_iter()
        .find(|case| case.id == "piper-customer")
        .expect("stable entry-id case");
    let billing = case.billing.as_ref().map(cache_options).expect("billable");
    let event = prepare_event(&billing).expect("native Polar event");
    let mut owned = Owned::of(
        &case.input,
        Some(event.credits),
        billing.external_id.as_ref(),
    );
    let control = bounded(ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").expect("fixture URI"),
    ))
    .await
    .expect("private Dragonfly");
    assert_eq!(
        exists(&control, &[&owned.key, &owned.queue, &owned.lock]).await,
        0
    );
    let keys = record_command_at(
        &case.input.channel_id,
        event.credits,
        billing.external_id.as_ref(),
        SystemTime::now(),
    )
    .expect("projection command")
    .expect("billable projection")
    .keys;
    owned.credits = Some(event.credits);
    let _: () = command(&control, redis::cmd("SET").arg(&keys[0]).arg(SNAPSHOT)).await;
    let peer = HttpPeer::new();
    let tracking = fixture_tracking(&peer);
    let capture = Arc::new(ConsoleCapture::default());
    let logger = fixture_logger(&control, capture.clone());
    let http = polar_batch_http::PolarHttp::inserted(1, 0);
    let tracker = batch_tracker(
        control.clone(),
        tracking.clone(),
        logger,
        Arc::new(FixedClock(case.now_millis)),
        &http.base_url,
    );
    let outcome = Catch(Box::pin(async {
        for _ in 0..2 {
            let usage = tracker.track(&case.input).await.expect("durable usage");
            assert_eq!(usage.credits_consumed, event.credits);
        }
        assert!(
            string_list(&control, &owned.queue).await.is_empty(),
            "each flush trims the sent row"
        );
        let requests = http.requests();
        assert_eq!(requests.len(), 2, "each call posts the queued event");
        assert_eq!(requests[0].body_str(), requests[1].body_str());
        let queued = parse_json(&event.wire).expect("stable event wire");
        assert_eq!(
            requests[0].body_str(),
            events_ingest_body(std::slice::from_ref(&queued)).expect("sdk body")
        );
        let snapshot: String = command(&control, redis::cmd("GET").arg(&keys[0])).await;
        let snapshot = parse_json(&snapshot).expect("snapshot JSON");
        assert_eq!(
            snapshot.get("balance"),
            Some(&JsonValue::Number(5000.0 - event.credits)),
            "the stable entry ID debits once"
        );
        assert_eq!(
            snapshot.get("used"),
            Some(&JsonValue::Number(event.credits))
        );
        assert_eq!(
            exists(&control, &[&keys[3]]).await,
            1,
            "the projection marker is set once and reused"
        );
        let receipts = string_list(&control, AI_USAGE_RECEIPT_QUEUE_KEY).await;
        let expected = build_queued_ai_usage_receipt_json(
            billing.channel_id.clone(),
            billing.customer_id.clone(),
            None,
            &event.context,
            event.credits,
        )
        .expect("native receipt");
        assert_eq!(receipts.len(), 2);
        for row in &receipts {
            assert_eq!(
                strip_dates(&parse_json(row).unwrap().to_json_string()),
                strip_dates(&expected.json())
            );
        }
        assert!(logged(&capture, "trackTtsUsage").is_empty());
    }))
    .await;
    let cleanup = Catch(Box::pin(async {
        owned.clean(&control).await;
        assert_eq!(exists(&control, &[&owned.key, &owned.queue]).await, 0);
    }))
    .await;
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    assert_eq!(
        string_list(&control, AI_USAGE_RECEIPT_QUEUE_KEY)
            .await
            .len(),
        0
    );
    tracking.flush().await.expect("loopback analytics flush");
    let _ = peer.body();
}

// ---------------------------------------------------------------------------
// Cancellation: dropping stops later cache operations and replays nothing.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and exact owner"]
async fn cancellation_stops_later_operations_without_replay() {
    use polar_support::{Catch, Fault, HttpPeer, Proxy, bounded};
    let case = scoped_cases()
        .into_iter()
        .find(|case| case.id == "piper-customer")
        .expect("source case");
    let billing = case.billing.as_ref().map(cache_options).expect("billable");
    let event = prepare_event(&billing).expect("native Polar event");
    let owned = Owned::of(
        &case.input,
        Some(event.credits),
        billing.external_id.as_ref(),
    );
    let control = bounded(ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").expect("fixture URI"),
    ))
    .await
    .expect("private Dragonfly");
    assert_eq!(
        exists(&control, &[&owned.key, &owned.queue, &owned.lock]).await,
        0
    );
    let projection = record_command_at(
        &case.input.channel_id,
        event.credits,
        billing.external_id.as_ref(),
        SystemTime::now(),
    )
    .expect("projection command")
    .expect("billable projection")
    .keys;
    let peer = HttpPeer::new();
    let tracking = fixture_tracking(&peer);
    let capture = Arc::new(ConsoleCapture::default());
    let logger = fixture_logger(&control, capture.clone());
    let proxy = Proxy::new();
    let through = bounded(ConnectionManager::new(
        redis::Client::open(proxy.url()).expect("proxy URI"),
    ))
    .await
    .expect("proxy manager");
    let http = polar_batch_http::PolarHttp::inserted(1, 0);
    let tracker = batch_tracker(
        through,
        tracking,
        logger,
        Arc::new(FixedClock(case.now_millis)),
        &http.base_url,
    );
    let outcome = Catch(Box::pin(async {
        proxy.arm("EXPIRE", &owned.key, Fault::Hold);
        let task = tokio::spawn({
            let tracker = tracker.clone();
            let input = case.input.clone();
            async move { tracker.track(&input).await }
        });
        proxy.applied().await;
        // Upstream acknowledged EXPIRE; the reply is still gated, so the write
        // outcome stays uncertain while the caller is gone.
        assert_eq!(
            attempted_for(&proxy, &owned.key).len(),
            4,
            "three counters and one EXPIRE"
        );
        task.abort();
        let _ = task.await;
        proxy.release();
        assert_eq!(
            attempted_for(&proxy, &owned.key).len(),
            4,
            "no totals after cancellation"
        );
        assert_eq!(
            exists(&control, &[&owned.queue]).await,
            0,
            "cancellation happened before the durable hand-off"
        );
        assert!(
            http.requests().is_empty(),
            "cancellation before billing sends no Polar HTTP"
        );
        let counters = hash(&control, &owned.key).await;
        assert_eq!(
            counters.len(),
            3,
            "only the applied provider counters remain"
        );
        assert!(ttl(&control, &owned.key).await > 0, "EXPIRE applied");
        let markers = projection.iter().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(
            exists(&control, &markers).await,
            0,
            "the cancelled tracker never projected or queued a receipt"
        );
        assert!(logged(&capture, "trackTtsUsage").is_empty());
    }))
    .await;
    let cleanup = Catch(Box::pin(async {
        owned.clean(&control).await;
        assert_eq!(exists(&control, &[&owned.key, &owned.queue]).await, 0);
    }))
    .await;
    proxy.release();
    drop(proxy);
    drop(peer);
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

// ---------------------------------------------------------------------------
// Lazy bootstrap: acquisition failure escapes, success uses the concrete path.
// ---------------------------------------------------------------------------

const PROBE_ENV: &str = "TTS_USAGE_TRACKING_ACQUISITION_PROBE";

#[test]
fn acquisition_failure_probe() {
    if std::env::var_os(PROBE_ENV).is_none() {
        return;
    }
    assert!(
        std::env::var_os("DRAGONFLY_HOST").is_none(),
        "probe runs without cache configuration"
    );
    let options = TtsUsageTrackOptions {
        channel_id: "tts-usage-probe".into(),
        streamer: TtsUsageStreamer::default(),
        provider: "piper".into(),
        characters: 1.0,
        text: "unused".into(),
        require_durable_usage: false,
        usage: None,
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("probe runtime");
    let error = runtime
        .block_on(track_tts_usage(&options))
        .expect_err("missing cache configuration must escape");
    match error {
        TtsUsageTrackError::Acquisition(message) => {
            assert!(message.contains("DRAGONFLY_HOST"), "{message}");
        }
        other => panic!("unexpected error {other:?}"),
    }
}

#[test]
fn acquisition_failure_runs_isolated_from_the_fixture() {
    let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "acquisition_failure_probe",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(PROBE_ENV, "1")
        .env_remove("DRAGONFLY_HOST")
        .env_remove("DRAGONFLY_PORT")
        .output()
        .expect("spawn isolated probe");
    assert!(
        status.status.success(),
        "isolated acquisition probe failed: {}{}",
        String::from_utf8_lossy(&status.stdout),
        String::from_utf8_lossy(&status.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and DRAGONFLY_HOST/PORT"]
async fn concrete_bootstrap_acquisition_and_isolation() {
    use polar_support::{Catch, bounded};
    assert_eq!(
        std::env::var("DRAGONFLY_HOST").as_deref(),
        Ok("keyword-redis")
    );
    assert_eq!(std::env::var("DRAGONFLY_PORT").as_deref(), Ok("6379"));
    let case = scoped_cases()
        .into_iter()
        .find(|case| case.id == "piper-no-customer")
        .expect("unbilled source case");
    assert_eq!(case.billing_calls, 0);
    let owned = Owned::of(&case.input, None, None);
    let control = bounded(ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").expect("fixture URI"),
    ))
    .await
    .expect("private Dragonfly");
    assert_eq!(exists(&control, &[&owned.key]).await, 0);
    let outcome = Catch(Box::pin(async {
        let usage = track_tts_usage(&case.input)
            .await
            .expect("concrete bootstrap tracking");
        let expected = case.usage.expect("source usage");
        assert_eq!(usage.credits_consumed, expected.credits_consumed);
        assert_eq!(exists(&control, &[&owned.key]).await, 1);
        assert_eq!(
            exists(&control, &[&owned.queue]).await,
            0,
            "no billing without a customer"
        );
    }))
    .await;
    let cleanup = Catch(Box::pin(async { owned.clean(&control).await })).await;
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Unbilled calls do not construct a Polar client. A missing token is reported
/// only after the durable queue exists, and that failure is not cached.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and exact owner"]
async fn batch_factory_stays_idle_until_a_flush_needs_a_client() {
    use polar_support::{Catch, HttpPeer, bounded};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let cases = scoped_cases();
    let unbilled = ["piper-no-customer", "fish-zero-characters"];
    let billed = cases
        .iter()
        .find(|case| case.id == "piper-customer")
        .expect("billable source case");
    let control = bounded(ConnectionManager::new(
        redis::Client::open("redis://keyword-redis:6379/").expect("fixture URI"),
    ))
    .await
    .expect("private Dragonfly");
    let peer = HttpPeer::new();
    let tracking = fixture_tracking(&peer);
    let capture = Arc::new(ConsoleCapture::default());
    let logger = fixture_logger(&control, capture);
    let calls = Arc::new(AtomicUsize::new(0));
    let factory_calls = Arc::clone(&calls);
    let durable = PolarCacheUsage::with_logger(
        control.clone(),
        AiCreditProjection::new(control.clone(), DEFAULT_USAGE_DEADLINE),
        AiUsageProducer::new(control.clone()),
        tracking,
        logger.clone(),
    );
    let polar = PolarUsage::from_factory(durable, logger.clone(), move || {
        factory_calls.fetch_add(1, Ordering::SeqCst);
        Err(PolarError::Configuration {
            policy: PolarPolicy::Billing,
            kind: PolarConfigError::MissingToken,
        })
    });
    let tracker = TtsUsageTracker::with_batch_clock(
        control.clone(),
        polar.clone(),
        logger,
        Arc::new(SystemClock),
    );
    let mut owned = Vec::new();
    for id in unbilled {
        let case = cases.iter().find(|case| case.id == id).expect(id);
        owned.push(Owned::of(&case.input, None, None));
    }
    let mut durable_input = billed.input.clone();
    durable_input.require_durable_usage = true;
    let billing = billed
        .billing
        .as_ref()
        .map(cache_options)
        .expect("billable");
    let event = prepare_event(&billing).expect("native Polar event");
    owned.push(Owned::of(
        &durable_input,
        Some(event.credits),
        billing.external_id.as_ref(),
    ));
    let outcome = Catch(Box::pin(async {
        for id in unbilled {
            let case = cases.iter().find(|case| case.id == id).expect(id);
            assert_eq!(case.billing_calls, 0, "{id}");
            let usage = tracker.track(&case.input).await.expect(id);
            let expected = case.usage.expect("priced usage");
            assert_eq!(
                usage.polarsh_cost.to_bits(),
                expected.polarsh_cost.to_bits(),
                "{id}"
            );
            let key = Owned::of(&case.input, None, None);
            assert_eq!(exists(&control, &[&key.queue]).await, 0, "{id}: no queue");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "unbilled calls skip the client factory"
        );
        assert_eq!(polar.client_creations(), 0);
        let error = tracker
            .track(&durable_input)
            .await
            .expect_err("durable token");
        assert_eq!(error, TtsUsageTrackError::RecordingUnavailable);
        assert_eq!(error.to_string(), RECORDING_UNAVAILABLE);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the flush asks for a client once"
        );
        assert_eq!(polar.client_creations(), 0, "a missing token is not cached");
        let queue = string_list(&control, &owned.last().expect("durable").queue).await;
        assert_eq!(queue.len(), 1, "the queued row survives the missing token");
        assert_eq!(queue[0], event.wire);
    }))
    .await;
    let cleanup = Catch(Box::pin(async {
        for item in &owned {
            item.clean(&control).await;
        }
    }))
    .await;
    drop(peer);
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
