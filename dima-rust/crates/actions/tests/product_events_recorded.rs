//! Product events against what posthog-node sent for the same calls
//! (`tests/reference/record_product_events.mts`), through a loopback mock of PostHog: the
//! request (path, gzip JSON, `api_key`, `batch`, `sent_at`) and every event (name,
//! `distinct_id`, properties with `null`s where the reference sends them) must match; `$lib` and
//! `$lib_version` name this program instead (counted below).

use anyhow::{Context, Result, ensure};
use dima_actions::product_events::{
    AiOperationEvent, AiUsageRecordedEvent, CommandEvent, ProductEvents, ProductEventsConfig,
    TtsEvent,
};
use dima_billing::usage::{AiUsageContext, Category, EntryKind, ResourceType, Unit};
use dima_core::{ManualClock, SeededRandom, Shutdown};
use dima_http::testing::{MockResponse, MockServer};
use serde_json::Value;
use std::io::Read as _;
use std::sync::Arc;
use std::time::Duration;

fn fixture() -> Result<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/product_events_recorded.json"
    );
    Ok(serde_json::from_str(
        &std::fs::read_to_string(path).with_context(|| path.to_owned())?,
    )?)
}

fn context(entry: &str, request: &str, kind: EntryKind, category: Category) -> AiUsageContext {
    AiUsageContext {
        schema_version: dima_billing::usage::AI_USAGE_SCHEMA_VERSION,
        pricing_version: dima_billing::usage::AI_USAGE_PRICING_VERSION,
        entry_id: entry.into(),
        request_id: request.into(),
        parent_request_id: None,
        entry_kind: kind,
        category,
        operation: String::new(),
        source: String::new(),
        provider: String::new(),
        model: None,
        channel_id: None,
        quantity: None,
        unit: None,
        resource_type: None,
        resource_id: None,
    }
}

/// The same calls as the recorder.
fn calls(events: &ProductEvents) {
    events.identify_streamer("1001", "firstuser");
    events.identify_streamer("1001", "firstuser");
    events.identify_streamer("1001", "renamed_user");
    events.identify_streamer("", "nobody");
    events.track_command(&CommandEvent {
        channel_id: "1001".into(),
        channel_name: "firstuser".into(),
        command: "!hola".into(),
        status: "success",
        user_id: "5001".into(),
        username: "viewer".into(),
        arguments: Some("mundo 🌍".into()),
        error_message: None,
    });
    events.track_command(&CommandEvent {
        channel_id: "1001".into(),
        channel_name: "firstuser".into(),
        command: "!roto".into(),
        status: "error",
        error_message: Some("boom".into()),
        ..CommandEvent::default()
    });
    events.track_tts(&TtsEvent {
        channel_id: "1001".into(),
        channel_name: "firstuser".into(),
        source: "chat-command",
        tts_type: "fish".into(),
        characters: 12.0,
        message: "hola مرحبا 👋🏽".into(),
        status: "success",
        mode: Some("queue".into()),
        provider: Some("fish".into()),
        user_id: "5001".into(),
        username: "viewer".into(),
        error_message: None,
    });
    events.track_tts(&TtsEvent {
        channel_id: "1001".into(),
        channel_name: "firstuser".into(),
        source: "ast",
        tts_type: "gtts".into(),
        characters: 0.0,
        status: "error",
        error_message: Some("no voice".into()),
        ..TtsEvent::default()
    });
    let mut usage = context("entry-1", "request-1", EntryKind::Usage, Category::AiChat);
    usage.parent_request_id = Some("parent-1".into());
    usage.operation = "chat.reply".into();
    usage.source = "chat".into();
    usage.provider = "openrouter".into();
    usage.model = Some("model-x".into());
    usage.channel_id = Some("1001".into());
    usage.quantity = Some(1234.0);
    usage.unit = Some(Unit::Tokens);
    usage.resource_type = Some(ResourceType::LlmGeneration);
    usage.resource_id = Some("gen-1".into());
    events.track_ai_usage_recorded(&AiUsageRecordedEvent {
        context: usage,
        credits: 2.5,
        reason: "ai_chat".into(),
        polar_cost_amount: Some(3.0),
        input_tokens: Some(1000.0),
        output_tokens: Some(234.0),
        total_tokens: Some(1234.0),
    });
    let mut grant = context(
        "entry-2",
        "request-2",
        EntryKind::Adjustment,
        Category::CreditAdjustment,
    );
    grant.operation = "grant".into();
    grant.source = "admin".into();
    grant.provider = "internal".into();
    events.track_ai_usage_recorded(&AiUsageRecordedEvent {
        context: grant,
        credits: -5.0,
        reason: "grant".into(),
        polar_cost_amount: None,
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
    });
    events.track_ai_operation(&AiOperationEvent {
        request_id: "request-1".into(),
        channel_id: "1001".into(),
        category: "tts".into(),
        operation: "speech".into(),
        source: "chat".into(),
        lifecycle: "completed",
        requested_provider: Some("fish".into()),
        actual_provider: Some("gtts".into()),
        fallback_reason: Some("quota".into()),
        error_code: Some("E1".into()),
        resource_type: Some("speech".into()),
        resource_id: Some("sp-1".into()),
        latency_ms: Some(812.0),
    });
    events.track_ai_operation(&AiOperationEvent {
        request_id: "request-3".into(),
        channel_id: "1001".into(),
        category: "memory".into(),
        operation: "embed".into(),
        source: "cron".into(),
        lifecycle: "queued",
        ..AiOperationEvent::default()
    });
}

fn is_iso(value: &Value) -> bool {
    value.as_str().and_then(dima_text::parse_date).is_some()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_recorded_product_events_match() -> Result<()> {
    let fixture = fixture()?;
    let reference = &fixture["requests"][0];
    let server = MockServer::start().await?;
    server.fallback(|_| MockResponse::json(200, "{}"));
    let mut config = ProductEventsConfig::reference();
    config.flush_interval = Duration::from_millis(50);
    let provider = server.provider(ProductEvents::provider(&config))?;
    let events = ProductEvents::new(
        config.clone(),
        Arc::new(ManualClock::new(1_794_475_800_123)),
        Arc::new(SeededRandom::new(1)),
    );
    calls(&events);
    let stop = Shutdown::new();
    let task = events.start(
        dima_http::HttpClient::builder().build()?,
        provider,
        stop.clone(),
        Duration::from_secs(10),
    );
    stop.trigger();
    task.await?;
    ensure!(
        events.stats().sent == 10 && events.stats().queued == 0,
        "{:?}",
        events.stats()
    );

    let mut sent = Vec::new();
    for request in server.requests() {
        ensure!(
            request.method == "POST" && request.path() == "/batch/",
            "{request:?}"
        );
        ensure!(request.header("content-encoding") == Some("gzip"));
        ensure!(request.header("content-type") == Some("application/json"));
        let mut text = String::new();
        flate2::read::GzDecoder::new(request.body.as_slice()).read_to_string(&mut text)?;
        let body: Value = serde_json::from_str(&text)?;
        let keys: Vec<&String> = body.as_object().context("body")?.keys().collect();
        ensure!(keys == ["api_key", "batch", "sent_at"], "{keys:?}");
        ensure!(body["api_key"] == reference["body"]["api_key"]);
        ensure!(is_iso(&body["sent_at"]));
        sent.extend(body["batch"].as_array().cloned().unwrap_or_default());
    }
    let expected = reference["body"]["batch"].as_array().context("batch")?;
    ensure!(
        sent.len() == expected.len(),
        "{} events, the reference {}",
        sent.len(),
        expected.len()
    );
    let mut differences = 0;
    for (index, (expected, actual)) in expected.iter().zip(&sent).enumerate() {
        let keys: Vec<&String> = actual.as_object().context("event")?.keys().collect();
        ensure!(
            keys == expected
                .as_object()
                .context("event")?
                .keys()
                .collect::<Vec<_>>(),
            "{index}: {keys:?}"
        );
        ensure!(
            actual["event"] == expected["event"]
                && actual["distinct_id"] == expected["distinct_id"],
            "{index}"
        );
        ensure!(is_iso(&actual["timestamp"]));
        let uuid = actual["uuid"].as_str().unwrap_or_default();
        ensure!(
            uuid.len() == 36 && uuid.chars().nth(14) == Some('7'),
            "{index}: uuid {uuid}"
        );
        let mut expected_properties = expected["properties"].clone();
        let mut properties = actual["properties"].clone();
        ensure!(properties["$lib"] == "dima-bot" && expected_properties["$lib"] == "posthog-node");
        for map in [&mut expected_properties, &mut properties] {
            if let Value::Object(map) = map {
                map.remove("$lib");
                map.remove("$lib_version");
            }
        }
        differences += 1;
        ensure!(
            properties == expected_properties,
            "{index}: {properties} instead of {expected_properties}"
        );
        let order: Vec<&String> = properties
            .as_object()
            .context("properties")?
            .keys()
            .collect();
        let expected_order: Vec<&String> = expected_properties
            .as_object()
            .context("properties")?
            .keys()
            .collect();
        ensure!(order == expected_order, "{index}: property order {order:?}");
    }
    // `$lib`/`$lib_version` name this program on every event.
    ensure!(differences == sent.len());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_posthog_never_blocks_the_caller() -> Result<()> {
    let server = MockServer::start().await?;
    server.fallback(|_| MockResponse::new(503));
    let mut config = ProductEventsConfig::reference();
    config.flush_interval = Duration::from_millis(20);
    config.retry_delays = vec![Duration::from_millis(10)];
    config.max_queue = 50;
    let provider = server.provider(ProductEvents::provider(&config))?;
    let events = ProductEvents::new(
        config,
        Arc::new(ManualClock::new(0)),
        Arc::new(SeededRandom::new(2)),
    );
    let stop = Shutdown::new();
    let task = events.start(
        dima_http::HttpClient::builder().build()?,
        provider,
        stop.clone(),
        Duration::from_secs(5),
    );
    let started = std::time::Instant::now();
    for n in 0..10_000 {
        events.identify_streamer(&n.to_string(), "name");
    }
    ensure!(
        started.elapsed() < Duration::from_secs(2),
        "queueing is cheap"
    );
    ensure!(events.stats().queued <= 50);
    stop.trigger();
    task.await?;
    let stats = events.stats();
    ensure!(
        stats.sent == 0 && stats.dropped_full + stats.dropped_failed + stats.queued == 10_000,
        "{stats:?}"
    );
    Ok(())
}
