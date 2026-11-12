//! Trace context: concurrent contexts, parents and children, the sampling rule, propagation
//! into spawned tasks and through queue payloads, and the signed trace header.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_core::SecretString;
use dima_telemetry::SavedTrace;
use dima_telemetry::trace::{self, SpanId, TraceId};
use std::time::Duration;

/// Port of `telemetry.test.ts`: "concurrent channel contexts, children and failures remain
/// distinct".
#[tokio::test]
async fn concurrent_channel_contexts_children_and_failures_remain_distinct() {
    let telemetry = support::in_memory(0.0);
    let run = |channel: &'static str| {
        let telemetry = telemetry.clone();
        async move {
            let saved = SavedTrace {
                trace_id: channel.repeat(32),
                span_id: "1".repeat(16),
                sampled: true,
            };
            let context = telemetry.restore(Some(&saved), channel);
            context
                .scope(async {
                    telemetry
                        .traced("chat", "message", async {
                            tokio::time::sleep(Duration::from_millis(2)).await;
                            telemetry
                                .traced("command", "test", async {
                                    telemetry.observe("event", "message", 0.0);
                                    assert_eq!(trace::current_channel().as_str(), channel);
                                    Ok::<_, ()>(())
                                })
                                .await
                        })
                        .await
                })
                .await
        }
    };
    let (a, b) = tokio::join!(run("a"), run("b"));
    assert!(a.is_ok() && b.is_ok());
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.spans.len(), 4);
    for channel in ["a", "b"] {
        let spans: Vec<_> = snapshot
            .spans
            .iter()
            .filter(|s| s.channel == channel)
            .collect();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].trace_id, spans[1].trace_id);
        assert_eq!(spans[0].trace_id, channel.repeat(32));
        // The inner span ends first; its parent is the outer one, whose parent is the saved span.
        assert_eq!(
            spans[0].parent_id.as_deref(),
            Some(spans[1].span_id.as_str())
        );
        assert_eq!(spans[1].parent_id, Some("1".repeat(16)));
        assert!(!spans[0].partial);
    }
    let event = snapshot.metric("message");
    assert!(
        event
            .iter()
            .any(|row| row.kind == "event" && row.channel == "a")
    );

    let failed: Result<(), &str> = telemetry
        .traced("command", "failure", async { Err("secret") })
        .await;
    assert!(failed.is_err());
    let snapshot = telemetry.take_snapshot();
    let span = snapshot.spans.last().unwrap();
    assert_eq!((span.outcome.as_str(), span.partial), ("error", true));
    assert!(
        !serde_json::to_string(&snapshot.spans)
            .unwrap()
            .contains("secret")
    );

    let _ = telemetry
        .traced("chat", "moderated", async {
            trace::set_outcome("moderated");
            Ok::<_, ()>(())
        })
        .await;
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.metric("moderated")[0].outcome, "moderated");
}

#[tokio::test(start_paused = true)]
async fn spans_are_kept_when_sampled_slow_or_failed() {
    let telemetry = support::in_memory(0.0);
    telemetry.span("cache", "get").end("ok");
    let slow = telemetry.span("http", "GET /slow");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    slow.end("200");
    telemetry.span("http", "GET /x").end("error");
    let snapshot = telemetry.take_snapshot();
    let names: Vec<_> = snapshot.spans.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["GET /slow", "GET /x"]);
    assert!(snapshot.spans.iter().all(|s| s.partial && !s.sampled));
    assert!((snapshot.spans[0].duration - 1000.0).abs() < 1.0);
    // Every span still counts in its metric.
    assert_eq!(snapshot.metric("get")[0].count, 1);

    let sampled = support::in_memory(1.0);
    sampled.span("cache", "get").end("ok");
    let snapshot = sampled.take_snapshot();
    assert_eq!(snapshot.spans.len(), 1);
    assert!(snapshot.spans[0].sampled && !snapshot.spans[0].partial);

    // A dropped span (its future was cancelled) ends as aborted.
    drop(sampled.span("queue_run", "cancelled"));
    assert_eq!(sampled.take_snapshot().spans[0].outcome, "aborted");
}

#[test]
fn the_sampling_rate_is_about_one_percent() {
    let telemetry = support::in_memory(dima_telemetry::trace::DEFAULT_SAMPLE_RATE);
    let sampled = (0..100_000)
        .filter(|_| telemetry.root("").ids().sampled)
        .count();
    assert!((700..1300).contains(&sampled), "{sampled} of 100000");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn context_crosses_spawned_tasks_only_when_propagated() {
    let telemetry = support::in_memory(0.0);
    let context = telemetry.root("chan");
    let ids = context.ids();
    let (carried, plain, nested) = context
        .scope(async {
            let carried = trace::spawn(async { trace::current_ids() }).await.unwrap();
            let plain = tokio::spawn(async { trace::current_ids() }).await.unwrap();
            // A span inside the spawned task is a child of the propagated context.
            let telemetry = telemetry.clone();
            let nested = trace::spawn(async move {
                let span = telemetry.span("queue_run", "child");
                let child = span.ids();
                span.end("error");
                (child, trace::current_channel().as_str().to_owned())
            })
            .await
            .unwrap();
            (carried, plain, nested)
        })
        .await;
    assert_eq!(carried, Some(ids));
    assert_eq!(plain, None);
    assert_eq!(nested.0.trace_id, ids.trace_id);
    assert_eq!(nested.1, "chan");
    let span = &telemetry.take_snapshot().spans[0];
    assert_eq!(span.parent_id.as_deref(), Some(ids.span_id.hex().as_str()));
    assert_eq!(span.channel, "chan");
    assert_eq!(trace::current_ids(), None);
}

#[tokio::test]
async fn queue_payloads_carry_the_trace() {
    let telemetry = support::in_memory(0.0);
    let span = telemetry.span("queue_wait", "tts");
    let mut span = span;
    let payload = span
        .run(async {
            serde_json::json!({ "text": "hola", "observability": SavedTrace::current() })
        })
        .await;
    let ids = span.ids();
    span.end("ok");
    let text = serde_json::to_string(&payload).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    let restored = trace::restore_json(parsed.get("observability"), "555", 0.0);
    assert_eq!(restored.ids(), ids);
    assert_eq!(restored.channel().as_str(), "555");
    // Invalid or missing ids start a fresh trace.
    for bad in [
        serde_json::json!({"traceId": "XYZ", "spanId": "1".repeat(16)}),
        serde_json::json!({"traceId": "a".repeat(32)}),
        serde_json::json!(null),
    ] {
        assert_ne!(
            trace::restore_json(Some(&bad), "", 0.0).ids().trace_id,
            ids.trace_id
        );
    }
    assert!(
        trace::restore_json(None, "bad:channel", 0.0)
            .channel()
            .is_empty()
    );
}

#[test]
fn trace_headers_are_signed_and_verified() {
    let secret = SecretString::new("test-secret-key".to_owned());
    let ids = trace::SpanIds {
        trace_id: TraceId::parse(&"ab".repeat(16)).unwrap(),
        span_id: SpanId::parse(&"cd".repeat(8)).unwrap(),
        sampled: true,
    };
    let (parent, signature) = trace::sign(&secret, &ids).unwrap();
    assert_eq!(
        parent.as_str(),
        format!("00-{}-{}-01", "ab".repeat(16), "cd".repeat(8))
    );
    // Node: createHmac('sha256', 'test-secret-key').update(traceparent).digest('hex')
    assert_eq!(
        signature,
        "9f251b1edd8bd78c4d6eaef1f630f117a272c0300ee856c12037f681dbe9a27a"
    );
    assert_eq!(
        trace::verify(Some(&secret), parent.as_str(), &signature),
        Some(ids)
    );
    let mut forged = signature.clone();
    forged.replace_range(0..1, "0");
    assert_eq!(trace::verify(Some(&secret), parent.as_str(), &forged), None);
    assert_eq!(trace::verify(None, parent.as_str(), &signature), None);
    let other = SecretString::new("other".to_owned());
    assert_eq!(
        trace::verify(Some(&other), parent.as_str(), &signature),
        None
    );
    let unsampled = format!("00-{}-{}-00", "ab".repeat(16), "cd".repeat(8));
    let signature = trace::sign(
        &secret,
        &trace::SpanIds {
            sampled: false,
            ..ids
        },
    )
    .unwrap()
    .1;
    assert!(
        !trace::verify(Some(&secret), &unsampled, &signature)
            .unwrap()
            .sampled
    );
    for bad in [
        "01-abababababababababababababababab-cdcdcdcdcdcdcdcd-01",
        "00-ABABABABABABABABABABABABABABABAB-cdcdcdcdcdcdcdcd-01",
        "00-abab-cdcdcdcdcdcdcdcd-01",
        "00-abababababababababababababababab-cdcdcdcdcdcdcdcd-02",
    ] {
        assert_eq!(trace::parse_traceparent(bad), None, "{bad}");
    }
    assert!(trace::sign(&SecretString::new(String::new()), &ids).is_none());
}

#[tokio::test]
async fn a_bound_channel_reaches_the_span_metric() {
    let telemetry = support::in_memory(1.0);
    let mut span = telemetry.span("http", "POST /eventsub");
    span.run(async { trace::bind_channel("98765") }).await;
    span.end("200");
    let snapshot = telemetry.take_snapshot();
    assert_eq!(snapshot.metric("POST /eventsub")[0].channel, "98765");
    assert_eq!(snapshot.spans[0].channel, "98765");
}
