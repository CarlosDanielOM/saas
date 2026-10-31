#![cfg(feature = "polar-batch-usage")]
//! Batch `events.ingest` over the shared durable prefix.
//!
//! Pure checks cover queue classification and the SDK body rules. The ignored
//! test runs the flush against a task-private Dragonfly and a loopback peer.
//! It never calls a real Polar provider. The receipt list is global, so this
//! file is run with `--test-threads=1`.

use dima_rust::utils::{
    ai_credit_projection::{AiCreditProjection, record_command_at},
    ai_usage_producer::{AI_USAGE_RECEIPT_QUEUE_KEY, AiUsageProducer},
    js_string::JsString,
    logger::{Logger, LoggerConfig, SinkHandles, StdConsole, SystemClock, UuidSource},
    lossless_json::{JsonValue, parse_json},
    polar::{PolarClient, PolarConfig, PolarConfigError, PolarError, PolarPolicy},
    polar_cache_usage::{CacheUsageOptions, CacheUsageResponse, PolarCacheUsage, prepare_event},
    polar_usage::{
        ClassifiedPending, POLAR_EVENTS_INGEST_PATH, POLAR_EVENTS_USER_AGENT, PolarUsage,
        classify_pending, events_ingest_body, source_polar_config,
    },
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::PosthogTracking,
};
use redis::aio::ConnectionManager;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

#[path = "support/polar_batch_http.rs"]
mod polar_http;

const REDIS_URL: &str = "redis://keyword-redis:6379/";
const SNAPSHOT: &str = r#"{"version":3,"available":true,"balance":5000,"used":0,"limit":5000}"#;
const USER_AGENT: &str = POLAR_EVENTS_USER_AGENT;

#[test]
fn lazy_source_config_uses_sdk_default_endpoint() {
    let config = source_polar_config(|key| match key {
        "POLARSH_OAT" => Some("fixture-oat".into()),
        "POLARSH_ENVIRONMENT" => Some("sandbox".into()),
        "POLARSH_API_BASE_URL" => Some("http://127.0.0.1:9".into()),
        _ => None,
    })
    .unwrap();
    assert_eq!(config.base_url().as_str(), "https://api.polar.sh/");
    assert!(matches!(
        source_polar_config(|_| None),
        Err(PolarConfigError::MissingToken)
    ));
}

fn parse(text: &str) -> JsonValue {
    parse_json(text).expect("json")
}

fn text(value: &JsonValue) -> &str {
    let JsonValue::String(text) = value else {
        panic!("fixture text")
    };
    text.as_str().expect("fixture text is ASCII")
}

#[test]
fn classify_pending_skips_malformed_and_keeps_parsed_non_objects() {
    let pending = classify_pending(&["not-json".into(), "1".into(), "{".into(), "\"kept\"".into()]);
    assert_eq!(
        pending,
        ClassifiedPending {
            parsed: vec![JsonValue::Number(1.0), JsonValue::String("kept".into())],
            raw_len: 4,
        }
    );
    assert_eq!(
        events_ingest_body(&pending.parsed).expect_err("non-objects"),
        "Input validation failed"
    );
}

#[test]
fn classify_pending_all_invalid_keeps_the_raw_length() {
    let pending = classify_pending(&["nope".into(), "".into()]);
    assert!(pending.parsed.is_empty());
    assert_eq!(pending.raw_len, 2);
}

#[test]
fn events_ingest_body_rejects_values_the_sdk_rejects() {
    for wire in [
        "1",
        r#"{"name":"ai_usage","customerId":"c","metadata":{"reason":null}}"#,
        r#"{"name":"ai_usage","customerId":"c","metadata":{"nested":{}}}"#,
        r#"{"name":"ai_usage","customerId":"c","timestamp":null}"#,
        r#"{"name":"ai_usage"}"#,
    ] {
        let error = events_ingest_body(&[parse(wire)]).expect_err(wire);
        assert_eq!(error, "Input validation failed", "{wire}");
    }
}

#[test]
fn events_ingest_body_prefers_customer_id_and_keeps_empty_metadata() {
    let body = events_ingest_body(&[parse(
        r#"{"name":"ai_usage","externalCustomerId":"e","customerId":"c","externalId":null,"metadata":{}}"#,
    )])
    .expect("empty metadata is valid");
    assert_eq!(
        body,
        r#"{"events":[{"name":"ai_usage","external_id":null,"metadata":{},"customer_id":"c"}]}"#
    );
}

#[test]
fn sdk_events_ingest_wire_matches_the_captured_fixture() {
    use sha2::{Digest, Sha256};
    let path = std::env::var("POLAR_EVENTS_INGEST_FIXTURE").expect("pinned SDK fixture path");
    let pin = std::env::var("POLAR_EVENTS_INGEST_FIXTURE_SHA256").expect("independent SHA-256");
    let bytes = std::fs::read(&path).expect("read SDK fixture");
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), pin);
    let fixture = parse(std::str::from_utf8(&bytes).expect("UTF-8 fixture"));
    assert_eq!(text(fixture.get("version").expect("version")), "0.42.5");
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/polar_events_ingest_reference.cjs");
    let source_pin =
        std::env::var("POLAR_EVENTS_ORACLE_SOURCE_SHA256").expect("independent source hash");
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(source).unwrap())),
        source_pin
    );
    let sdk_hashes = fixture.get("sdkHashes").expect("SDK code hashes");
    for (key, pin) in [
        (
            "package",
            "0742172127e5952a0df7277b244c00280f777fe4d9a7816b27c6482d19f125ab",
        ),
        (
            "ingest",
            "375a684df2fcf680394bca04df3721d8649011a13fa7a2bb730e39763a622096",
        ),
        (
            "schema",
            "0b1c349193f9f1503f8cae99b701e41b58a8135bfe61f1a80b72760bb0f884f8",
        ),
    ] {
        assert_eq!(text(sdk_hashes.get(key).expect("SDK hash")), pin, "{key}");
    }
    assert_eq!(
        text(fixture.get("userAgent").expect("user agent")),
        USER_AGENT
    );
    let JsonValue::Array(cases) = fixture.get("cases").expect("cases") else {
        panic!("case array")
    };
    assert_eq!(cases.len(), 3);
    for case in cases {
        let id = text(case.get("id").expect("id"));
        let JsonValue::Array(events) = case.get("events").expect("events") else {
            panic!("{id}: events")
        };
        let body = events_ingest_body(events).unwrap_or_else(|error| panic!("{id}: {error}"));
        assert_eq!(body, text(case.get("body").expect("body")), "{id}");
        assert_eq!(text(case.get("method").expect("method")), "POST", "{id}");
        assert_eq!(
            text(case.get("path").expect("path")),
            POLAR_EVENTS_INGEST_PATH,
            "{id}"
        );
        assert_eq!(
            text(case.get("authorization").expect("authorization")),
            "Bearer fixture-oat",
            "{id}"
        );
        assert_eq!(
            text(case.get("accept").expect("accept")),
            "application/json",
            "{id}"
        );
        assert_eq!(
            text(case.get("userAgent").expect("agent")),
            USER_AGENT,
            "{id}"
        );
        assert_eq!(
            text(case.get("contentType").expect("content type"))
                .split(';')
                .next()
                .unwrap()
                .trim(),
            "application/json",
            "{id}"
        );
    }
    let JsonValue::Array(boundaries) = fixture.get("boundaries").expect("SDK boundary cases")
    else {
        panic!("boundary array")
    };
    assert_eq!(boundaries.len(), 8);
    for case in boundaries {
        let id = text(case.get("id").expect("id"));
        let JsonValue::Array(events) = case.get("events").expect("events") else {
            panic!("{id}: events")
        };
        let JsonValue::Bool(accepted) = case.get("accepted").expect("accepted") else {
            panic!("{id}: accepted")
        };
        let result = events_ingest_body(events);
        if *accepted {
            assert_eq!(
                result.unwrap(),
                text(case.get("body").expect("body")),
                "{id}"
            );
        } else {
            assert_eq!(result.unwrap_err(), "Input validation failed", "{id}");
        }
    }
}

fn fixture_namespace() -> String {
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_OWNER").as_deref(),
        Ok("polar-batch-usage")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok(REDIS_URL)
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

fn tracking() -> PosthogTracking {
    let mut config = PosthogLosslessConfig::new("fixture", "http://127.0.0.1:9/batch/");
    config.flush_interval = Duration::from_secs(3600);
    config.flush_at = 1000;
    PosthogTracking::from_lossless_config(config).expect("loopback analytics")
}

fn logger() -> Logger {
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            console: Some(Arc::new(StdConsole)),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("fixture logger")
}

fn make_options(channel: &str, external_id: &str) -> CacheUsageOptions {
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

fn client(base_url: &str) -> PolarClient {
    PolarClient::new(
        PolarConfig::new(base_url, "fixture-oat").expect("loopback config"),
        PolarPolicy::Billing,
    )
    .expect("loopback client")
}

fn durable(
    cache: &ConnectionManager,
    log: &Logger,
    analytics: &PosthogTracking,
) -> PolarCacheUsage {
    PolarCacheUsage::with_logger(
        cache.clone(),
        AiCreditProjection::new(cache.clone(), Duration::from_secs(2)),
        AiUsageProducer::new(cache.clone()),
        analytics.clone(),
        log.clone(),
    )
}

fn usage(
    cache: &ConnectionManager,
    base_url: &str,
    log: &Logger,
    analytics: &PosthogTracking,
) -> PolarUsage {
    PolarUsage::shared(
        durable(cache, log, analytics),
        client(base_url),
        log.clone(),
    )
}

struct Residue {
    channel: String,
    external_id: String,
    credits: f64,
}

fn residue(options: &CacheUsageOptions) -> Residue {
    let event = prepare_event(options).expect("event");
    Residue {
        channel: options.channel_id.to_utf8_lossy(),
        external_id: event.external_id.to_utf8_lossy(),
        credits: event.credits,
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
        if let Some(record) =
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
            let value = parse(&row);
            if matches!(
                value.get("id"),
                Some(JsonValue::String(id)) if id.as_str() == Some(item.external_id.as_str())
            ) {
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
}

fn assert_wire(request: &polar_http::RecordedRequest, wire: &str) {
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
    let body = events_ingest_body(std::slice::from_ref(&parse(wire))).expect("sdk body");
    assert_eq!(request.body_str(), body);
}

async fn assert_queue(cache: &ConnectionManager, channel: &str, rows: &[&str]) {
    let actual = strings(cache, &queue_key(channel)).await;
    let expected: Vec<String> = rows.iter().map(|row| (*row).to_owned()).collect();
    assert_eq!(actual, expected, "{channel}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh private keyword Redis and exact owner"]
async fn batch_flush_against_private_dragonfly() {
    use polar_support_catch::Catch;
    let namespace = fixture_namespace();
    let cache = ConnectionManager::new(redis::Client::open(REDIS_URL).expect("fixture URI"))
        .await
        .expect("private Dragonfly");
    assert!(
        strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await.is_empty(),
        "receipt queue must start empty in the owned fixture"
    );
    let log = logger();
    let analytics = tracking();
    let mut residue_list = Vec::new();
    let outcome = Catch(Box::pin(async {
        let channel = |name: &str| format!("{namespace}{name}");

        let missing_customer = CacheUsageOptions {
            customer_id: String::new().into(),
            ..make_options("unused", "unused")
        };
        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let response = polar.ingest(&missing_customer).await;
        assert_eq!(response.message.as_deref(), Some("customerId is required"));
        assert!(response.error);
        let missing_channel = CacheUsageOptions {
            channel_id: String::new().into(),
            ..make_options("unused", "unused")
        };
        let response = polar.ingest(&missing_channel).await;
        assert_eq!(
            response.message.as_deref(),
            Some("channelID is required for batch/cache modes")
        );
        assert!(http.requests().is_empty(), "validation does not call Polar");
        drop(http);

        let http = polar_http::PolarHttp::inserted(2, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("legacy-array");
        let options = make_options(&name, "legacy-array");
        residue_list.push(residue(&options));
        let legacy = r#"{"name":"ai_usage","customerId":"fixture-customer","externalId":"legacy"}"#;
        let _: () = query(&cache, redis::cmd("SET").arg(queue_key(&name)).arg(format!("[{legacy}]") )).await;
        let response = polar.ingest(&options).await;
        assert!(!response.error);
        assert_queue(&cache, &name, &[]).await;
        let rows = [parse(legacy), parse(&prepare_event(&options).unwrap().wire)];
        assert_eq!(http.requests().len(), 1);
        assert_eq!(http.requests()[0].body_str(), events_ingest_body(&rows).unwrap());
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        let pooled = client(&http.base_url);
        let polar = PolarUsage::from_factory(durable(&cache, &log, &analytics), log.clone(), move || {
            seen.fetch_add(1, Ordering::SeqCst);
            Ok(pooled.clone())
        });
        let left = make_options(&channel("lazy-a"), "lazy-a");
        let right = make_options(&channel("lazy-b"), "lazy-b");
        residue_list.push(residue(&left));
        residue_list.push(residue(&right));
        let other = polar.clone();
        let (left_result, right_result) = tokio::join!(polar.ingest(&left), other.ingest(&right));
        assert!(!left_result.error && !right_result.error);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "clones initialize one shared pool");
        assert_eq!(polar.client_creations(), 1);
        assert_eq!(http.requests().len(), 2);
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let other = polar.clone();
        for (caller, name) in [(&polar, "shared-a"), (&other, "shared-b")] {
            let options = make_options(&channel(name), name);
            residue_list.push(residue(&options));
            let response = caller.ingest(&options).await;
            assert_eq!(response, CacheUsageResponse { error: false, message: None }, "{name}");
            assert_queue(&cache, &channel(name), &[]).await;
        }
        assert_eq!(polar.client_creations(), 0, "an injected client is not a creation");
        let requests = http.requests();
        assert_eq!(requests.len(), 2);
        for (request, name) in requests.iter().zip(["shared-a", "shared-b"]) {
            let wire = prepare_event(&make_options(&channel(name), name))
                .expect("wire")
                .wire;
            assert_wire(request, &wire);
        }
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("busy");
        let options = make_options(&name, "busy-entry");
        residue_list.push(residue(&options));
        let _: String = query(
            &cache,
            redis::cmd("SET")
                .arg(lock_key(&name))
                .arg("other-owner")
                .arg("NX")
                .arg("PX")
                .arg(30_000),
        )
        .await;
        let response = polar.ingest(&options).await;
        assert_eq!(
            response,
            CacheUsageResponse {
                error: false,
                message: Some("queued (flush in progress)".into()),
            }
        );
        assert!(http.requests().is_empty(), "a busy lock does not call Polar");
        let queued = strings(&cache, &queue_key(&name)).await;
        assert_eq!(queued.len(), 1);
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        let polar = PolarUsage::from_factory(durable(&cache, &log, &analytics), log.clone(), move || {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(PolarError::Configuration {
                policy: PolarPolicy::Billing,
                kind: PolarConfigError::MissingToken,
            })
        });
        let name = channel("missing-token");
        let options = make_options(&name, "missing-token");
        residue_list.push(residue(&options));
        for expected_calls in [1, 2] {
            let response = polar.ingest(&options).await;
            assert!(response.error);
            assert_eq!(response.message.as_deref(), Some("POLARSH_OAT is not set"));
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
            assert_eq!(polar.client_creations(), 0);
        }
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 2);
        assert!(http.requests().is_empty());
        let invalid_name = channel("missing-token-invalid-row");
        let invalid = make_options(&invalid_name, "missing-token-invalid-row");
        residue_list.push(residue(&invalid));
        let _: i64 = query(&cache, redis::cmd("RPUSH").arg(queue_key(&invalid_name)).arg("1")).await;
        let response = polar.ingest(&invalid).await;
        assert_eq!(response.message.as_deref(), Some("POLARSH_OAT is not set"));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(strings(&cache, &queue_key(&invalid_name)).await.len(), 2);
        assert!(http.requests().is_empty());
        drop(http);

        assert!(
            std::env::var_os("POLARSH_OAT").is_none(),
            "the from_env case must not replace or call with a real token"
        );
        let lazy = PolarUsage::lazy(durable(&cache, &log, &analytics), log.clone());
        let name = channel("from-env");
        let options = make_options(&name, "from-env");
        residue_list.push(residue(&options));
        let response = lazy.ingest(&options).await;
        assert_eq!(response.message.as_deref(), Some("POLARSH_OAT is not set"));
        assert_eq!(lazy.client_creations(), 0);
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);

        for (label, peer, message, remaining) in [
            (
                "incomplete",
                polar_http::PolarHttp::respond(200, r#"{"inserted":0,"duplicates":0}"#),
                "PolarSH ingest incomplete",
                1,
            ),
            (
                "non-number",
                polar_http::PolarHttp::respond(200, r#"{"inserted":"x","duplicates":null}"#),
                "Polar provider returned invalid response",
                1,
            ),
            (
                "http-error",
                polar_http::PolarHttp::respond(500, "nope"),
                "Polar API error 500: nope",
                1,
            ),
            (
                "invalid-json",
                polar_http::PolarHttp::respond(200, "not-json"),
                "Polar provider returned invalid JSON",
                1,
            ),
            (
                "duplicates",
                polar_http::PolarHttp::inserted(0, 1),
                "",
                0,
            ),
        ] {
            let polar = usage(&cache, &peer.base_url, &log, &analytics);
            let name = channel(label);
            let options = make_options(&name, label);
            residue_list.push(residue(&options));
            let response = polar.ingest(&options).await;
            if remaining == 0 {
                assert_eq!(response, CacheUsageResponse { error: false, message: None }, "{label}");
                assert_eq!(peer.requests().len(), 1, "{label}");
            } else {
                assert!(response.error, "{label}");
                assert_eq!(response.message.as_deref(), Some(message), "{label}");
                assert_eq!(peer.requests().len(), 1, "{label}");
            }
            assert_eq!(strings(&cache, &queue_key(&name)).await.len(), remaining, "{label}");
            assert_eq!(query::<i64>(&cache, redis::cmd("EXISTS").arg(lock_key(&name))).await, 0, "{label}");
        }

        // The HTTP status and response schemas below come from the actual SDK
        // oracle, not a native reconstruction of what should be accepted.
        let fixture_bytes = std::fs::read(std::env::var("POLAR_EVENTS_INGEST_FIXTURE").unwrap()).unwrap();
        use sha2::{Digest, Sha256};
        assert_eq!(format!("{:x}", Sha256::digest(&fixture_bytes)), std::env::var("POLAR_EVENTS_INGEST_FIXTURE_SHA256").unwrap());
        let sdk = parse(std::str::from_utf8(&fixture_bytes).unwrap());
        let JsonValue::Array(replies) = sdk.get("replies").expect("SDK reply cases") else { panic!("SDK replies") };
        assert_eq!(replies.len(), 11);
        for reply in replies {
            let id = text(reply.get("id").unwrap());
            let JsonValue::Number(status) = reply.get("status").unwrap() else { panic!("{id}: status") };
            let JsonValue::Bool(accepted) = reply.get("accepted").unwrap() else { panic!("{id}: accepted") };
            let content_type = match reply.get("contentType").unwrap() {
                JsonValue::Null => None,
                value => Some(text(value)),
            };
            let peer = polar_http::PolarHttp::respond_with_type(*status as u16, &reply.get("reply").unwrap().to_json_string(), content_type);
            let polar = usage(&cache, &peer.base_url, &log, &analytics);
            let name = channel(&format!("sdk-response-{id}"));
            let options = make_options(&name, id);
            residue_list.push(residue(&options));
            let outcome = polar.ingest(&options).await;
            assert_eq!(!outcome.error, *accepted, "{id}");
            assert_eq!(strings(&cache, &queue_key(&name)).await.len(), usize::from(!*accepted), "{id}");
            assert_eq!(peer.requests().len(), 1, "{id}: no retry");
        }

        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("malformed");
        let options = make_options(&name, "malformed");
        residue_list.push(residue(&options));
        let _: i64 = query(&cache, redis::cmd("RPUSH").arg(queue_key(&name)).arg("not-json")).await;
        let response = polar.ingest(&options).await;
        assert_eq!(response, CacheUsageResponse { error: false, message: None });
        assert_queue(&cache, &name, &[]).await;
        let requests = http.requests();
        let wire = prepare_event(&options).expect("wire").wire;
        assert_wire(&requests[0], &wire);
        assert!(!requests[0].body_str().contains("not-json"));
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("sdk-reject");
        let options = make_options(&name, "sdk-reject");
        residue_list.push(residue(&options));
        let _: i64 = query(&cache, redis::cmd("RPUSH").arg(queue_key(&name)).arg("1")).await;
        let response = polar.ingest(&options).await;
        assert_eq!(response.message.as_deref(), Some("Input validation failed"));
        assert!(http.requests().is_empty(), "SDK rejection sends no HTTP");
        let rows = strings(&cache, &queue_key(&name)).await;
        assert_eq!(rows.len(), 2, "the new row stays with the rejected row");
        assert_eq!(rows[0], "1");
        assert_eq!(rows[1], prepare_event(&options).expect("wire").wire);
        drop(http);

        let http = polar_http::PolarHttp::hold(200, r#"{"inserted":1,"duplicates":0}"#);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("cancel");
        let options = make_options(&name, "cancel");
        residue_list.push(residue(&options));
        let task = tokio::spawn({
            let polar = polar.clone();
            let options = options.clone();
            async move { polar.ingest(&options).await }
        });
        tokio::task::block_in_place(|| http.wait_for_request());
        task.abort();
        assert!(task.await.expect_err("aborted flush").is_cancelled());
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);
        assert_eq!(
            query::<i64>(&cache, redis::cmd("EXISTS").arg(lock_key(&name))).await,
            1,
            "cancellation leaves the lock until its TTL"
        );
        assert!(query::<i64>(&cache, redis::cmd("TTL").arg(lock_key(&name))).await > 0);
        http.release();
        drop(http);

        let http = polar_http::PolarHttp::hold_body(200, r#"{"inserted":1,"duplicates":0}"#);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("cancel-body");
        let options = make_options(&name, "cancel-body");
        residue_list.push(residue(&options));
        let mut task = tokio::spawn({
            let polar = polar.clone();
            let options = options.clone();
            async move { polar.ingest(&options).await }
        });
        tokio::task::block_in_place(|| http.wait_for_headers());
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut task).await.is_err(), "response body is still pending");
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);
        task.abort();
        assert!(task.await.expect_err("aborted response body").is_cancelled());
        assert_eq!(strings(&cache, &queue_key(&name)).await.len(), 1);
        assert!(query::<i64>(&cache, redis::cmd("TTL").arg(lock_key(&name))).await > 0);
        http.release();
        drop(http);

        let http = polar_http::PolarHttp::hold(200, r#"{"inserted":1,"duplicates":0}"#);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("tail");
        let options = make_options(&name, "tail-head");
        residue_list.push(residue(&options));
        let task = tokio::spawn({
            let polar = polar.clone();
            let options = options.clone();
            async move { polar.ingest(&options).await }
        });
        tokio::task::block_in_place(|| http.wait_for_request());
        let tail = r#"{"name":"ai_usage","customerId":"fixture-customer","externalId":"tail"}"#;
        let _: i64 = query(&cache, redis::cmd("RPUSH").arg(queue_key(&name)).arg(tail)).await;
        http.release();
        let response = task.await.expect("flush task");
        assert_eq!(response, CacheUsageResponse { error: false, message: None });
        assert_queue(&cache, &name, &[tail]).await;
        assert_eq!(query::<i64>(&cache, redis::cmd("EXISTS").arg(lock_key(&name))).await, 0);
        drop(http);

        let http = polar_http::PolarHttp::inserted(1, 0);
        let polar = usage(&cache, &http.base_url, &log, &analytics);
        let name = channel("stable");
        let options = make_options(&name, "stable-entry");
        let event = prepare_event(&options).expect("event");
        residue_list.push(residue(&options));
        let keys = record_command_at(
            &options.channel_id,
            event.credits,
            options.external_id.as_ref(),
            SystemTime::now(),
        )
        .expect("projection")
        .expect("billable")
        .keys;
        let _: () = query(&cache, redis::cmd("SET").arg(&keys[0]).arg(SNAPSHOT)).await;
        for _ in 0..2 {
            let response = polar.ingest(&options).await;
            assert_eq!(response, CacheUsageResponse { error: false, message: None });
        }
        assert_queue(&cache, &name, &[]).await;
        let requests = http.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].body_str(), requests[1].body_str());
        assert_wire(&requests[0], &event.wire);
        let snapshot: String = query(&cache, redis::cmd("GET").arg(&keys[0])).await;
        let snapshot = parse(&snapshot);
        assert_eq!(
            snapshot.get("balance"),
            Some(&JsonValue::Number(5000.0 - event.credits)),
            "the stable id debits once"
        );
        let receipts = strings(&cache, AI_USAGE_RECEIPT_QUEUE_KEY).await;
        let matching = receipts
            .iter()
            .filter(|row| {
                matches!(parse(row).get("id"), Some(JsonValue::String(id)) if id.as_str() == Some("stable-entry"))
            })
            .count();
        assert_eq!(matching, 2, "each call still enqueues a receipt");
        drop(http);
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

/// Local name so this file does not depend on the cache-usage support module.
mod polar_support_catch {
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
