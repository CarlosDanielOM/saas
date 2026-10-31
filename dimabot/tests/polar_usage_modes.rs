#![cfg(feature = "polar-batch-usage")]
//! Immediate ingest, credit grants, and the process Polar factory.
//!
//! Pure cases replay the Node oracle's event JSON. The ignored test uses a
//! private Dragonfly and loopback HTTP. It never calls Polar, PostHog, or
//! Twitch. The receipt list is global, so run this file with `--test-threads=1`.

use dima_rust::utils::{
    ai_credit_projection::{AiCreditProjection, record_command_at},
    ai_usage_producer::AI_USAGE_RECEIPT_QUEUE_KEY,
    js_string::JsString,
    logger::{
        ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
        UuidSource,
    },
    lossless_json::{JsonValue, parse_json},
    polar::{PolarClient, PolarConfig, PolarPolicy},
    polar_cache_usage::{CacheUsageOptions, LlmMetadata, LlmUsage, PolarCacheUsage, prepare_event},
    polar_usage::{
        GrantPolarAiCreditsOptions, IngestMode, POLAR_EVENTS_INGEST_PATH, POLAR_EVENTS_USER_AGENT,
        PolarRuntime, PolarUsage, events_ingest_body, get_polar_sh_client, grant_credit_count,
        grant_source_name, install_process_console, prepare_grant,
    },
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::PosthogTracking,
};
use redis::aio::ConnectionManager;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

#[allow(dead_code)]
#[path = "support/polar_batch_http.rs"]
mod polar_http;
#[allow(dead_code)]
#[path = "support/polar_cache_usage.rs"]
mod redis_fault;

const REDIS_URL: &str = "redis://keyword-redis:6379/";
const SOURCE_SHA: &str = "5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec";
const USER_AGENT: &str = POLAR_EVENTS_USER_AGENT;

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fixture() -> Value {
    let path = std::env::var("POLAR_USAGE_MODES_FIXTURE").expect("oracle fixture path");
    let pin = std::env::var("POLAR_USAGE_MODES_FIXTURE_SHA256").expect("independent fixture SHA");
    let bytes = fs::read(&path).expect("oracle fixture");
    assert_eq!(sha256(&bytes), pin);
    let reader = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/polar_usage_modes_reference.cjs");
    let reader_bytes = fs::read(&reader).expect("oracle reader");
    let reader_pin =
        std::env::var("POLAR_USAGE_MODES_READER_SHA256").expect("independent reader SHA");
    assert_eq!(sha256(&reader_bytes), reader_pin);
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/utils/polarsh.ts");
    assert_eq!(sha256(&fs::read(source).expect("polarsh.ts")), SOURCE_SHA);
    let fixture: Value = serde_json::from_slice(&bytes).expect("fixture json");
    assert_eq!(fixture["sourceHash"], SOURCE_SHA);
    assert_eq!(fixture["readerHash"], reader_pin);
    assert_eq!(fixture["node"], "v24.22.1");
    assert_eq!(fixture["v8"], "13.6.233.17-node.58");
    assert_eq!(fixture["typescript"], "5.9.3");
    assert_eq!(
        fixture["runtimeHashes"]["node"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    fixture
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key}"))
}

fn js_field(input: &Value, key: &str) -> JsString {
    input.get(key).and_then(Value::as_str).unwrap_or("").into()
}

fn optional_js(input: &Value, key: &str) -> Option<JsString> {
    input.get(key).and_then(Value::as_str).map(JsString::from)
}

fn optional_f64(input: &Value, key: &str) -> Option<f64> {
    input.get(key).and_then(Value::as_f64)
}

fn llm(input: &Value) -> Option<LlmMetadata> {
    let llm = input.get("llm")?.as_object()?;
    let usage = llm
        .get("usage")
        .and_then(Value::as_object)
        .expect("llm usage");
    Some(LlmMetadata {
        model: llm
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        usage: LlmUsage {
            prompt_tokens: usage
                .get("prompt_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            completion_tokens: usage
                .get("completion_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            total_tokens: usage
                .get("total_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        },
    })
}

fn cache_options(input: &Value) -> CacheUsageOptions {
    CacheUsageOptions {
        customer_id: js_field(input, "customerId"),
        channel_id: js_field(input, "channelID"),
        external_id: optional_js(input, "externalId").filter(|value| !value.is_empty()),
        cost: input.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
        reason: js_field(input, "reason"),
        llm: llm(input),
        polar_cost: optional_f64(input, "_cost"),
        characters: optional_f64(input, "characters"),
        usage: JsonValue::Object(vec![]),
    }
}

fn grant_credits(input: &Value) -> f64 {
    match &input["credits"] {
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) if text == "Infinity" => f64::INFINITY,
        Value::String(text) if text == "-Infinity" => f64::NEG_INFINITY,
        Value::Number(number) => number.as_f64().expect("credits"),
        other => panic!("credits {other}"),
    }
}

fn grant_options(input: &Value) -> GrantPolarAiCreditsOptions {
    GrantPolarAiCreditsOptions {
        customer_id: js_field(input, "customerId"),
        channel_id: js_field(input, "channelID"),
        credits: grant_credits(input),
        reason: js_field(input, "reason"),
        admin_login: optional_js(input, "adminLogin"),
        external_id: optional_js(input, "externalId"),
        source: match input.get("source") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(JsString::from(value.as_str())),
            other => panic!("source {other:?}"),
        },
    }
}

#[test]
fn mode_default_is_batch_and_grant_floor_matches_math_floor() {
    assert_eq!(IngestMode::default(), IngestMode::Batch);
    assert_eq!(grant_credit_count(1.9), Ok(1.0));
    assert_eq!(grant_credit_count(2.0), Ok(2.0));
    assert_eq!(
        grant_credit_count(0.9),
        Err("credits must be a positive number")
    );
    assert_eq!(
        grant_credit_count(0.0),
        Err("credits must be a positive number")
    );
    assert_eq!(
        grant_credit_count(-0.0),
        Err("credits must be a positive number")
    );
    assert_eq!(
        grant_credit_count(-1.2),
        Err("credits must be a positive number")
    );
    assert_eq!(
        grant_credit_count(f64::NAN),
        Err("credits must be a positive number")
    );
    assert_eq!(
        grant_credit_count(f64::INFINITY),
        Err("credits must be a positive number")
    );
    assert_eq!(grant_source_name(None).as_str(), Some("admin_credit_grant"));
    assert_eq!(
        grant_source_name(Some(&JsString::from("   "))).as_str(),
        Some("admin_credit_grant")
    );
}

#[test]
fn oracle_cases_match_the_source_event_and_validation_rules() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 29);
    let mut ids = Vec::new();
    for case in cases {
        let id = text(case, "id");
        ids.push(id.to_owned());
        match text(case, "compare") {
            "event" if case["kind"] == "grant" => {
                let prepared = prepare_grant(&grant_options(&case["input"])).expect(id);
                assert_eq!(
                    prepared.event.to_json_string(),
                    text(case, "eventJson"),
                    "{id}"
                );
                let body = events_ingest_body(std::slice::from_ref(&prepared.event)).expect(id);
                assert_eq!(body, text(case, "sdkBody"), "{id}");
                assert!(!prepared.credits.is_sign_negative());
            }
            "event" => {
                let prepared = prepare_event(&cache_options(&case["input"])).expect(id);
                assert_eq!(prepared.wire, text(case, "eventJson"), "{id}");
                let parsed = parse_json(&prepared.wire).expect(id);
                let body = events_ingest_body(std::slice::from_ref(&parsed)).expect(id);
                assert_eq!(body, text(case, "sdkBody"), "{id}");
            }
            "reject" if case["kind"] == "grant" => {
                let error = prepare_grant(&grant_options(&case["input"])).expect_err(id);
                assert_eq!(error, text(&case["result"], "message"), "{id}");
            }
            "reject" => {
                assert_eq!(
                    text(&case["result"], "message"),
                    "customerId is required",
                    "{id}"
                );
                assert!(cache_options(&case["input"]).customer_id.is_empty(), "{id}");
            }
            "source" => {
                assert!(case.get("result").is_some(), "{id}");
                if case["adapter"] == "sdk-invalid" {
                    assert!(case["result"]["details"].is_object(), "{id}");
                }
            }
            other => panic!("{id}: {other}"),
        }
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), cases.len());
}

struct Capture {
    lines: Mutex<Vec<String>>,
}

impl ConsoleSink for Capture {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        self.lines
            .lock()
            .expect("log lines")
            .push(record.json.to_string());
        Box::pin(async { Ok(()) })
    }
}

impl Capture {
    fn contains(&self, needle: &str) -> bool {
        self.lines
            .lock()
            .expect("log lines")
            .iter()
            .any(|line| line.contains(needle))
    }

    fn len(&self) -> usize {
        self.lines.lock().expect("log lines").len()
    }
}

fn logger(console: Arc<dyn ConsoleSink>) -> Logger {
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            console: Some(console),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("fixture logger")
}

fn tracking() -> PosthogTracking {
    let mut config = PosthogLosslessConfig::new("fixture", "http://127.0.0.1:9/batch/");
    config.flush_interval = Duration::from_secs(3600);
    config.flush_at = 1000;
    PosthogTracking::from_lossless_config(config).expect("loopback analytics")
}

fn client(base_url: &str) -> PolarClient {
    PolarClient::new(
        PolarConfig::new(base_url, "fixture-oat").expect("loopback config"),
        PolarPolicy::Billing,
    )
    .expect("loopback client")
}

fn audio(channel: &str, external_id: &str) -> CacheUsageOptions {
    CacheUsageOptions {
        customer_id: "fixture-customer".into(),
        channel_id: channel.into(),
        external_id: Some(external_id.into()),
        cost: 0.5,
        reason: "tts_piper".into(),
        llm: None,
        polar_cost: Some(1.0),
        characters: Some(100.0),
        usage: JsonValue::Object(vec![]),
    }
}

fn grant_input(channel: &str, external_id: &str, credits: f64) -> GrantPolarAiCreditsOptions {
    GrantPolarAiCreditsOptions {
        customer_id: "fixture-customer".into(),
        channel_id: channel.into(),
        credits,
        reason: "manual".into(),
        admin_login: None,
        external_id: Some(external_id.into()),
        source: None,
    }
}

struct Residue {
    channel: String,
    external_id: String,
    credits: f64,
}

fn residue(channel: &str, external_id: &str, credits: f64) -> Residue {
    Residue {
        channel: channel.to_owned(),
        external_id: external_id.to_owned(),
        credits,
    }
}

async fn query<T: redis::FromRedisValue>(cache: &ConnectionManager, command: &mut redis::Cmd) -> T {
    let mut cache = cache.clone();
    command
        .query_async(&mut cache)
        .await
        .expect("private Dragonfly command")
}

async fn strings(cache: &ConnectionManager, key: &str) -> Vec<String> {
    query(cache, redis::cmd("LRANGE").arg(key).arg(0).arg(-1)).await
}

fn queue_key(channel: &str) -> String {
    format!("twitch:{channel}:ai:polarshevent")
}

fn lock_key(channel: &str) -> String {
    format!("locks:polar-ingest:{channel}")
}

async fn clean(cache: &ConnectionManager, items: &[Residue]) {
    for item in items {
        let event_id = JsString::from(item.external_id.as_str());
        let channel = JsString::from(item.channel.as_str());
        if item.credits > 0.0
            && let Some(record) =
                record_command_at(&channel, item.credits, Some(&event_id), SystemTime::now())
                    .expect("projection keys")
        {
            let _: i64 = query(
                cache,
                redis::cmd("DEL").arg(record.keys.iter().map(String::as_str).collect::<Vec<_>>()),
            )
            .await;
        }
        let _: i64 = query(
            cache,
            redis::cmd("DEL").arg(&[queue_key(&item.channel), lock_key(&item.channel)]),
        )
        .await;
        for row in strings(cache, AI_USAGE_RECEIPT_QUEUE_KEY).await {
            let value = parse_json(&row).expect("receipt");
            if matches!(value.get("id"), Some(JsonValue::String(id)) if id.as_str() == Some(item.external_id.as_str()))
            {
                let _: i64 = query(
                    cache,
                    redis::cmd("LREM")
                        .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                        .arg(0)
                        .arg(&row),
                )
                .await;
            }
        }
    }
    let _: i64 = query(cache, redis::cmd("DEL").arg(AI_USAGE_RECEIPT_QUEUE_KEY)).await;
}

fn assert_wire(request: &polar_http::RecordedRequest, body: &str) {
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, POLAR_EVENTS_INGEST_PATH);
    assert_eq!(request.header("authorization"), Some("Bearer fixture-oat"));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.header("user-agent"), Some(USER_AGENT));
    assert_eq!(
        request
            .header("content-type")
            .expect("content-type")
            .split(';')
            .next()
            .unwrap()
            .trim(),
        "application/json"
    );
    assert_eq!(request.body_str(), body);
}

fn fixture_namespace() -> String {
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_OWNER").as_deref(),
        Ok("polar-usage-modes")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok(REDIS_URL)
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("DIMA_TEST_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("task namespace");
    let suffix = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("namespace shape");
    assert_eq!(suffix.len(), 12);
    assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
    namespace
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and exact owner"]
async fn immediate_grant_and_factory_against_private_dragonfly() {
    use mode_catch::Catch;
    let namespace = fixture_namespace();
    let cache = ConnectionManager::new(redis::Client::open(REDIS_URL).expect("fixture URI"))
        .await
        .expect("private Dragonfly");
    assert!(
        strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await.is_empty(),
        "receipt queue must start empty"
    );
    let capture = Arc::new(Capture {
        lines: Mutex::new(Vec::new()),
    });
    let console: Arc<dyn ConsoleSink> = capture.clone();
    assert!(
        install_process_console(console.clone()),
        "process console installs once"
    );
    let log = logger(console);
    let analytics = tracking();
    let mut residue_list = Vec::new();
    let channel = |name: &str| format!("{namespace}{name}");
    let outcome = Catch(Box::pin(async {
        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_process_redis(
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("process-redis");
        let options = audio(&name, "process-redis");
        residue_list.push(residue(&name, "process-redis", 1000.0));
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert!(!response.error, "{:?}", response.message);
        assert_eq!(http.requests().len(), 1);
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(queue_key(&name))).await,
            0
        );
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("immediate-ok");
        let options = audio(&name, "immediate-ok");
        residue_list.push(residue(&name, "immediate-ok", 1000.0));
        let event = prepare_event(&options).expect("event");
        let keys = record_command_at(
            &options.channel_id,
            event.credits,
            options.external_id.as_ref(),
            SystemTime::now(),
        )
        .expect("keys")
        .expect("billable")
        .keys;
        let _: () = query(
            &cache,
            redis::cmd("SET")
                .arg(&keys[0])
                .arg(r#"{"version":3,"available":true,"balance":5000,"used":0,"limit":5000}"#),
        )
        .await;
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert_eq!(response.to_source_json()["error"], Value::Bool(false));
        assert!(response.to_source_json().get("details").is_none());
        assert_wire(
            &http.requests()[0],
            &events_ingest_body(std::slice::from_ref(&parse_json(&event.wire).unwrap())).unwrap(),
        );
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(queue_key(&name))).await,
            0
        );
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(lock_key(&name))).await,
            0
        );
        let snapshot: String = query(&cache, redis::cmd("GET").arg(&keys[0])).await;
        assert!(snapshot.contains("4000"), "{snapshot}");
        let receipts = strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await;
        assert!(receipts.iter().any(|row| row.contains("immediate-ok")));
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let options = audio("", "immediate-empty");
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert!(!response.error, "{:?}", response.message);
        assert_eq!(http.requests().len(), 1);
        assert!(
            !strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY)
                .await
                .iter()
                .any(|row| row.contains("immediate-empty"))
        );
        drop(http);

        let http = polar_http::PolarHttp::respond(200, r#"{"inserted":0,"duplicates":0}"#);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("incomplete");
        let options = audio(&name, "incomplete");
        residue_list.push(residue(&name, "incomplete", 1000.0));
        let before = capture.len();
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert!(response.error);
        assert_eq!(
            response.message.as_deref(),
            Some("PolarSH ingest incomplete")
        );
        assert_eq!(
            response
                .details
                .as_ref()
                .and_then(|value| value.get("inserted"))
                .and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(capture.len(), before, "incomplete immediate does not log");
        assert_eq!(
            query::<i64>(
                &cache,
                redis::cmd("EXISTS").arg(
                    &record_command_at(
                        &options.channel_id,
                        1000.0,
                        options.external_id.as_ref(),
                        SystemTime::now()
                    )
                    .unwrap()
                    .unwrap()
                    .keys[0]
                )
            )
            .await,
            0
        );
        drop(http);

        let http = polar_http::PolarHttp::respond(200, r#"{"inserted":"x","duplicates":null}"#);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("invalid");
        let options = audio(&name, "invalid");
        residue_list.push(residue(&name, "invalid", 0.0));
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert_eq!(
            response.message.as_deref(),
            Some("Polar provider returned invalid response")
        );
        assert!(response.details.is_none());
        assert!(capture.contains("Polar provider returned invalid response"));
        drop(http);

        let http = polar_http::PolarHttp::respond(500, "nope");
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("http");
        let options = audio(&name, "http");
        residue_list.push(residue(&name, "http", 0.0));
        let response = runtime.ingest_mode(&options, IngestMode::Immediate).await;
        assert_eq!(
            response.message.as_deref(),
            Some("Polar API error 500: nope")
        );
        assert!(response.details.is_none());
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let missing = CacheUsageOptions {
            customer_id: String::new().into(),
            ..audio("unused", "unused")
        };
        let response = runtime.ingest_mode(&missing, IngestMode::Immediate).await;
        assert_eq!(response.message.as_deref(), Some("customerId is required"));
        assert!(http.requests().is_empty());
        drop(http);

        let http = polar_http::PolarHttp::hold(200, r#"{"inserted":1,"duplicates":0}"#);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("cancel");
        let options = audio(&name, "cancel");
        residue_list.push(residue(&name, "cancel", 0.0));
        let task = tokio::spawn({
            let runtime = runtime.clone();
            let options = options.clone();
            async move { runtime.ingest_mode(&options, IngestMode::Immediate).await }
        });
        tokio::task::block_in_place(|| http.wait_for_request());
        task.abort();
        assert!(task.await.expect_err("aborted immediate").is_cancelled());
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(queue_key(&name))).await,
            0
        );
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(lock_key(&name))).await,
            0
        );
        http.release();
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("batch");
        let options = audio(&name, "batch");
        residue_list.push(residue(&name, "batch", 1000.0));
        let response = runtime.ingest(&options).await;
        assert!(!response.error, "{:?}", response.message);
        assert!(response.details.is_none());
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(queue_key(&name))).await,
            0
        );
        assert_eq!(http.requests().len(), 1);
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("cache");
        let options = audio(&name, "cache-only");
        residue_list.push(residue(&name, "cache-only", 1000.0));
        let response = runtime.ingest_mode(&options, IngestMode::Cache).await;
        assert!(!response.error, "{:?}", response.message);
        assert!(http.requests().is_empty(), "cache mode does not call Polar");
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);
        drop(http);

        let http = polar_http::PolarHttp::respond(200, r#"{"inserted":0,"duplicates":0}"#);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("batch-short");
        let options = audio(&name, "batch-short");
        residue_list.push(residue(&name, "batch-short", 1000.0));
        let response = runtime.ingest_mode(&options, IngestMode::Batch).await;
        assert_eq!(
            response.message.as_deref(),
            Some("PolarSH ingest incomplete")
        );
        assert!(response.details.is_some());
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("grant-ok");
        let grant = grant_input(&name, "grant-ok", 1.9);
        residue_list.push(residue(&name, "grant-ok", 0.0));
        let prepared = prepare_grant(&grant).expect("grant");
        assert_eq!(prepared.credits, 1.0);
        let response = runtime.grant(&grant).await;
        assert!(!response.error, "{:?}", response.message);
        assert_wire(
            &http.requests()[0],
            &events_ingest_body(std::slice::from_ref(&prepared.event)).unwrap(),
        );
        assert!(http.requests()[0].body_str().contains("admin_credit_grant"));
        let receipts = strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await;
        let receipt = receipts
            .iter()
            .find(|row| row.contains("grant-ok"))
            .expect("negative receipt");
        assert!(
            receipt.contains("\"credits\":-1") || receipt.contains("\"credits\":-1.0"),
            "{receipt}"
        );
        let positive = record_command_at(
            &grant.channel_id,
            1.0,
            grant.external_id.as_ref(),
            SystemTime::now(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(&positive.keys[0])).await,
            0,
            "grant does not debit projection"
        );
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let response = runtime.grant(&grant_input("", "grant-empty", 2.0)).await;
        assert!(!response.error, "{:?}", response.message);
        assert!(
            !strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY)
                .await
                .iter()
                .any(|row| row.contains("grant-empty"))
        );
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let response = runtime
            .grant(&grant_input("unused", "grant-zero", 0.0))
            .await;
        assert_eq!(
            response.message.as_deref(),
            Some("credits must be a positive number")
        );
        assert!(http.requests().is_empty());
        drop(http);

        let closed = tracking();
        closed.shutdown_posthog().await.expect("close analytics");
        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(closed),
        );
        let name = channel("grant-analytics");
        let response = runtime
            .grant(&grant_input(&name, "grant-analytics", 2.0))
            .await;
        residue_list.push(residue(&name, "grant-analytics", 0.0));
        assert!(!response.error, "{:?}", response.message);
        assert!(
            strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY)
                .await
                .iter()
                .any(|row| row.contains("grant-analytics"))
        );
        drop(http);

        let _: () = query(
            &cache,
            redis::cmd("SET")
                .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                .arg("blocked"),
        )
        .await;
        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            log.clone(),
            Some(analytics.clone()),
        );
        let name = channel("grant-wrongtype");
        let before = capture.len();
        let response = runtime
            .grant(&grant_input(&name, "grant-wrongtype", 2.0))
            .await;
        assert!(
            !response.error,
            "provider success survives receipt failure: {:?}",
            response.message
        );
        assert!(capture.len() > before);
        assert!(capture.contains("grantPolarAiCredits.receipt"));
        assert_eq!(http.requests().len(), 1);
        drop(http);
        let _: i64 = query(&cache, redis::cmd("DEL").arg(AI_USAGE_RECEIPT_QUEUE_KEY)).await;

        let quiet = logger(Arc::new(Capture {
            lines: Mutex::new(Vec::new()),
        }));
        quiet.shutdown(Duration::from_millis(50)).await;
        let _: () = query(
            &cache,
            redis::cmd("SET")
                .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                .arg("blocked"),
        )
        .await;
        let http = polar_http::PolarHttp::inserted(1, 0);
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            quiet,
            Some(analytics.clone()),
        );
        let response = runtime
            .grant(&grant_input(&channel("grant-log"), "grant-log", 2.0))
            .await;
        assert!(
            !response.error,
            "logger failure does not undo the grant: {:?}",
            response.message
        );
        drop(http);
        let _: i64 = query(&cache, redis::cmd("DEL").arg(AI_USAGE_RECEIPT_QUEUE_KEY)).await;
    }))
    .await;
    let cleanup = Catch(Box::pin(async {
        clean(&cache, &residue_list).await;
        assert!(
            strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await.is_empty(),
            "owned receipts removed"
        );
    }))
    .await;
    if let Err(panic) = cleanup {
        std::panic::resume_unwind(panic);
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

fn durable_stub(
    cache: &ConnectionManager,
    log: &Logger,
    analytics: &PosthogTracking,
) -> PolarCacheUsage {
    PolarCacheUsage::with_optional_tracking(
        cache.clone(),
        AiCreditProjection::new(cache.clone(), Duration::from_secs(2)),
        dima_rust::utils::ai_usage_producer::AiUsageProducer::new(cache.clone()),
        Some(analytics.clone()),
        log.clone(),
    )
}

mod mode_catch {
    pub struct Catch<F: std::future::Future>(pub std::pin::Pin<Box<F>>);
    impl<F: std::future::Future> std::future::Future for Catch<F> {
        type Output = std::thread::Result<F::Output>;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.get_mut().0.as_mut().poll(cx)
            })) {
                Ok(std::task::Poll::Ready(value)) => std::task::Poll::Ready(Ok(value)),
                Ok(std::task::Poll::Pending) => std::task::Poll::Pending,
                Err(panic) => std::task::Poll::Ready(Err(panic)),
            }
        }
    }
}

// Process environments are established by Command before any child threads or
// runtime exist. No test calls unsafe set_var/remove_var in a running process.
#[test]
#[ignore = "requires private fixtures; spawns only this test executable"]
fn factory_and_redis_acquisition_child_processes() {
    fixture_namespace();
    for mode in ["missing", "ready"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "process_environment_child",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("POLAR_MODES_CHILD", mode)
            .env_remove("DRAGONFLY_HOST")
            .env_remove("DRAGONFLY_PORT");
        if mode == "missing" {
            command.env_remove("POLARSH_OAT");
        } else {
            command.env("POLARSH_OAT", "fixture-oat");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "child-only environment fixture"]
async fn process_environment_child() {
    let Ok(mode) = std::env::var("POLAR_MODES_CHILD") else {
        return;
    };
    fixture_namespace();
    let capture = Arc::new(Capture {
        lines: Mutex::new(Vec::new()),
    });
    assert!(install_process_console(capture.clone()));
    let cache = ConnectionManager::new(redis::Client::open(REDIS_URL).unwrap())
        .await
        .unwrap();
    let log = logger(capture.clone());
    let analytics = tracking();
    let idle = PolarUsage::lazy(durable_stub(&cache, &log, &analytics), log.clone());
    assert!(idle.uses_process_transport());
    if mode == "missing" {
        for caller in ["missing-a", "missing-b"] {
            let error = tokio::time::timeout(Duration::from_secs(1), get_polar_sh_client(caller))
                .await
                .unwrap()
                .err()
                .expect("missing token");
            assert_eq!(error.to_string(), "POLARSH_OAT is not set");
        }
        assert_eq!(idle.client_creations(), 0);
        assert_eq!(capture.len(), 0);
        return;
    }
    assert_eq!(mode, "ready");
    let (left, right) = tokio::join!(
        get_polar_sh_client("caller-a"),
        get_polar_sh_client("caller-b")
    );
    assert!(left.is_ok() && right.is_ok());
    assert_eq!(idle.client_creations(), 1);
    assert!(
        capture.contains("PolarSH client initialized for caller-a")
            || capture.contains("PolarSH client initialized for caller-b")
    );
    let count = capture.len();
    assert!(get_polar_sh_client("later").await.is_ok());
    assert_eq!(capture.len(), count);
    // Redis configuration is absent throughout this child. Factory success
    // proves it never acquires Redis; immediate usage must acquire it first.
    let http = polar_http::PolarHttp::inserted(1, 0);
    let runtime =
        PolarRuntime::with_process_redis(client(&http.base_url), log.clone(), Some(analytics));
    let response = runtime
        .ingest_mode(&audio("unused", "redis-first"), IngestMode::Immediate)
        .await;
    assert!(response.error);
    assert!(response.message.unwrap().contains("DRAGONFLY_HOST"));
    assert!(http.requests().is_empty());
    let response = runtime
        .grant(&grant_input("unused", "grant-redis", 1.9))
        .await;
    assert!(!response.error);
    assert_eq!(http.requests().len(), 1);
    assert!(capture.contains("grantPolarAiCredits.receipt"));
    assert!(capture.contains("DRAGONFLY_HOST"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "private Dragonfly receipt failures and uncertain writes"]
async fn immediate_and_grant_receipt_mutations_are_not_replayed() {
    let namespace = fixture_namespace();
    let cache = ConnectionManager::new(redis::Client::open(REDIS_URL).unwrap())
        .await
        .unwrap();
    assert!(strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await.is_empty());
    for grant in [false, true] {
        for fault in [
            redis_fault::Fault::Reject,
            redis_fault::Fault::LoseReply,
            redis_fault::Fault::Hold,
        ] {
            let proxy = redis_fault::Proxy::new();
            let proxied = ConnectionManager::new(redis::Client::open(proxy.url()).unwrap())
                .await
                .unwrap();
            proxy.arm("RPUSH", AI_USAGE_RECEIPT_QUEUE_KEY, fault);
            let http = polar_http::PolarHttp::inserted(1, 0);
            let capture = Arc::new(Capture {
                lines: Mutex::new(Vec::new()),
            });
            let runtime = PolarRuntime::with_ready(
                proxied,
                client(&http.base_url),
                logger(capture.clone()),
                Some(tracking()),
            );
            let channel = format!("{namespace}receipt-{grant}-{fault:?}");
            let id = format!("receipt-{grant}-{fault:?}");
            let work = tokio::spawn({
                let channel = channel.clone();
                let id = id.clone();
                async move {
                    if grant {
                        runtime.grant(&grant_input(&channel, &id, 2.9)).await
                    } else {
                        runtime
                            .ingest_mode(&audio(&channel, &id), IngestMode::Immediate)
                            .await
                    }
                }
            });
            if fault == redis_fault::Fault::Hold {
                redis_fault::bounded(proxy.applied()).await;
                work.abort();
                assert!(work.await.unwrap_err().is_cancelled());
                proxy.release();
            } else {
                let response = redis_fault::bounded(work).await.unwrap();
                assert!(
                    !response.error,
                    "accepted provider success survives receipt errors"
                );
                assert!(capture.contains(if grant {
                    "grantPolarAiCredits.receipt"
                } else {
                    "projectAcceptedUsage"
                }));
            }
            assert_eq!(http.requests().len(), 1);
            assert_eq!(
                proxy
                    .attempts()
                    .iter()
                    .filter(|args| args.first().is_some_and(|v| v == b"RPUSH")
                        && args
                            .get(1)
                            .is_some_and(|v| v == AI_USAGE_RECEIPT_QUEUE_KEY.as_bytes()))
                    .count(),
                1
            );
            let receipts = strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await;
            assert_eq!(
                receipts.len(),
                usize::from(fault != redis_fault::Fault::Reject)
            );
            if let Some(receipt) = receipts.first() {
                assert!(receipt.contains(&id));
            }
            assert_eq!(
                query::<i64>(&cache, redis::cmd("EXISTS").arg(queue_key(&channel))).await,
                0
            );
            clean(
                &cache,
                &[residue(&channel, &id, if grant { 0.0 } else { 1000.0 })],
            )
            .await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "actual source cases through private Redis and loopback provider"]
async fn oracle_results_through_concrete_mode_dispatch() {
    fixture_namespace();
    let reference = fixture();
    let cache = ConnectionManager::new(redis::Client::open(REDIS_URL).unwrap())
        .await
        .unwrap();
    assert!(strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await.is_empty());
    let mut exercised = 0;
    for case in reference["cases"].as_array().unwrap() {
        let id = text(case, "id");
        if case["kind"] == "factory" || id == "grant-redis-failure" {
            continue;
        }
        let grant = case["kind"] == "grant";
        let input = &case["input"];
        let options = cache_options(input);
        let channel = js_field(input, "channelID").to_utf8_lossy();
        let entry = optional_js(input, "externalId")
            .unwrap_or_else(|| JsString::from(id))
            .to_utf8_lossy();
        let credits = if grant {
            0.0
        } else {
            prepare_event(&options).map_or(0.0, |event| event.credits)
        };
        let owned = residue(&channel, &entry, credits);
        clean(&cache, std::slice::from_ref(&owned)).await;
        if id == "grant-receipt-failure" {
            let _: () = query(
                &cache,
                redis::cmd("SET")
                    .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
                    .arg("wrongtype"),
            )
            .await;
        }
        let http = if id == "immediate-http" {
            polar_http::PolarHttp::respond(500, "nope")
        } else if id == "immediate-loose-invalid" {
            polar_http::PolarHttp::respond(200, r#"{"inserted":"x","duplicates":null}"#)
        } else if id.ends_with("incomplete") {
            polar_http::PolarHttp::inserted(0, 0)
        } else {
            polar_http::PolarHttp::inserted(1, 0)
        };
        let analytics = tracking();
        if id == "grant-track-failure" {
            analytics.shutdown_posthog().await.unwrap();
        }
        let capture = Arc::new(Capture {
            lines: Mutex::new(Vec::new()),
        });
        let runtime = PolarRuntime::with_ready(
            cache.clone(),
            client(&http.base_url),
            logger(capture),
            Some(analytics),
        );
        let actual = if grant {
            runtime.grant(&grant_options(input)).await
        } else if input.get("mode").is_none() {
            runtime.ingest(&options).await
        } else {
            runtime.ingest_mode(&options, IngestMode::Immediate).await
        };
        if id == "immediate-loose-invalid" {
            // The source oracle stubs the SDK at this boundary; real SDK schema
            // rejection is independently bound by the accepted SDK fixture.
            assert_eq!(
                actual.message.as_deref(),
                Some("Polar provider returned invalid response")
            );
            assert!(actual.details.is_none());
        } else {
            assert_eq!(actual.to_source_json(), case["result"], "{id}");
        }
        if let Some(body) = case.get("sdkBody").and_then(Value::as_str) {
            assert_eq!(http.requests().len(), 1, "{id}");
            assert_wire(&http.requests()[0], body);
        } else {
            assert!(http.requests().is_empty(), "{id}");
        }
        if id == "grant-receipt-failure" {
            // This case deliberately replaced the list with a string. Prove the
            // failed receipt did not replace it, then remove that fixture before
            // the normal list-aware cleanup runs.
            assert_eq!(
                query::<String>(&cache, redis::cmd("GET").arg(AI_USAGE_RECEIPT_QUEUE_KEY)).await,
                "wrongtype"
            );
            let _: i64 = query(&cache, redis::cmd("DEL").arg(AI_USAGE_RECEIPT_QUEUE_KEY)).await;
        }
        clean(&cache, &[owned]).await;
        exercised += 1;
    }
    assert_eq!(exercised, 26);
}
