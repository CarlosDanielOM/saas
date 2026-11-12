//! The four seams: inbound HTTP (`dima_web`), outbound HTTP (`dima_http`, loopback mock),
//! MongoDB command events, and Dragonfly commands and connection errors (local Dragonfly,
//! logical database 13).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_core::SecretString;
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{HttpClient, Provider};
use dima_store::mongo::connection::{CommandFailed, CommandSucceeded};
use dima_telemetry::trace::{self, SIGNATURE, TRACEPARENT};
use dima_telemetry::{ConsoleTarget, Telemetry, TelemetryConfig};
use dima_web::{App, Body, Req, Response, Router};
use http_body_util::BodyExt as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt as _;

const SECRET: &str = "trace-test-secret";

fn telemetry(sample_rate: f64) -> Telemetry {
    let mut config = TelemetryConfig::new("api", "index");
    config.dragonfly = Some(support::local_store(1));
    config.secret_key = Some(SecretString::new(SECRET.to_owned()));
    config.sample_rate = sample_rate;
    config.console = ConsoleTarget::Off;
    Telemetry::new(config).unwrap()
}

#[derive(Default)]
struct Seen {
    ids: Mutex<Vec<Option<trace::SpanIds>>>,
}

async fn unavailable(_req: &mut Req<Arc<Seen>>) -> Response {
    Response::status(503).json(&serde_json::json!({ "error": true }))
}

async fn channel_route(req: &mut Req<Arc<Seen>>) -> Response {
    // The auth middleware's `bindChannel(req.params.channelID)`.
    trace::bind_channel(req.param("channelID").unwrap_or_default());
    req.state().ids.lock().unwrap().push(trace::current_ids());
    Response::new().json(&serde_json::json!({ "ok": true }))
}

async fn session(_req: &mut Req<Arc<Seen>>) -> Response {
    Response::new().json(&serde_json::json!({}))
}

async fn call<S>(service: S, uri: &str, headers: &[(&str, &str)]) -> u16
where
    S: tower::Service<
            http::Request<Body>,
            Response = http::Response<Body>,
            Error = std::convert::Infallible,
        >,
{
    let mut builder = http::Request::builder().method("GET").uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = service
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let _ = response.into_body().collect().await;
    status
}

/// Port of `telemetry.test.ts`: "HTTP templates, errors and self-observation exclusion", plus the
/// signed trace header and the bound channel.
#[tokio::test]
async fn http_templates_errors_and_self_observation_exclusion() {
    let telemetry = telemetry(0.0);
    let seen = Arc::new(Seen::default());
    let mut speech = Router::new();
    speech.get("/:channelID", unavailable);
    let mut widgets = Router::new();
    widgets.get("/:channelID/state", channel_route);
    let mut duel = Router::new();
    duel.get("/state", session);
    let mut root = Router::new();
    root.mount("/speech", speech);
    root.mount("/duels/:channelID/duel", duel);
    root.mount("/widgets", widgets);
    root.get("/observability/api/session", session);
    let app = App::new(root, seen.clone())
        .unwrap()
        .observe(telemetry.web_observer());
    let queue = app.observer_queue().unwrap();
    let service = telemetry.traced_service(app);

    assert_eq!(
        call(service.clone(), "/speech/123456?token=secret", &[]).await,
        503
    );
    assert_eq!(
        call(service.clone(), "/observability/api/session", &[]).await,
        200
    );
    assert_eq!(call(service.clone(), "/nowhere", &[]).await, 404);
    assert_eq!(
        call(service.clone(), "/duels/1234567/duel/state", &[]).await,
        200
    );
    // A login in the same mount: the reference kept it in the name (one series per login).
    assert_eq!(
        call(service.clone(), "/duels/some_login/duel/state", &[]).await,
        200
    );
    // An extension method is not a name of its own either.
    let brew = http::Request::builder()
        .method(http::Method::from_bytes(b"BREW").unwrap())
        .uri("/nowhere")
        .body(Body::empty())
        .unwrap();
    let response = service.clone().oneshot(brew).await.unwrap();
    assert_eq!(response.status().as_u16(), 404);
    let _ = response.into_body().collect().await;
    queue.idle().await;
    let snapshot = telemetry.take_snapshot();
    let rows: Vec<_> = snapshot
        .metrics
        .iter()
        .filter(|m| m.kind == "http")
        .collect();
    let mut names: Vec<_> = rows
        .iter()
        .map(|r| (r.name.as_str(), r.outcome.as_str(), r.count))
        .collect();
    names.sort_unstable();
    // Names come from the registered patterns only: a mount parameter is `:id` whatever the
    // request held (the reference's name for a numeric id); route templates are kept.
    assert_eq!(
        names,
        [
            ("GET /duels/:id/duel/state", "200", 2),
            ("GET /speech/:channelID", "error", 1),
            ("GET /unmatched", "404", 1),
            ("OTHER /unmatched", "404", 1)
        ]
    );
    assert!(
        !serde_json::to_string(&snapshot.metrics)
            .unwrap()
            .contains("some_login")
    );
    assert!(
        !serde_json::to_string(&snapshot.metrics)
            .unwrap()
            .contains("secret")
    );
    // The 5xx span is kept; the 404 is not (not sampled, fast, not an error).
    assert_eq!(snapshot.spans.len(), 1);

    // A signed header from one of our services joins its trace; an unsigned one does not.
    let remote = trace::SpanIds {
        trace_id: trace::TraceId::parse(&"ab".repeat(16)).unwrap(),
        span_id: trace::SpanId::parse(&"cd".repeat(8)).unwrap(),
        sampled: true,
    };
    let (parent, signature) = trace::sign(&SecretString::new(SECRET.to_owned()), &remote).unwrap();
    let headers = [
        (TRACEPARENT, parent.as_str()),
        (SIGNATURE, signature.as_str()),
    ];
    assert_eq!(
        call(service.clone(), "/widgets/777888/state", &headers).await,
        200
    );
    let forged = [(TRACEPARENT, parent.as_str()), (SIGNATURE, "00")];
    assert_eq!(
        call(service.clone(), "/widgets/777888/state", &forged).await,
        200
    );
    let ids = seen.ids.lock().unwrap().clone();
    let (signed, unsigned) = (ids[0].unwrap(), ids[1].unwrap());
    assert_eq!(signed.trace_id, remote.trace_id);
    assert!(signed.sampled);
    assert_ne!(unsigned.trace_id, remote.trace_id);
    queue.idle().await;
    let snapshot = telemetry.take_snapshot();
    let span = &snapshot.spans[0];
    // The mount's pattern and the route's template.
    assert_eq!(span.name, "GET /widgets/:channelID/state");
    assert_eq!(span.parent_id, Some("cd".repeat(8)));
    assert_eq!(span.span_id, signed.span_id.hex().as_str());
    assert_eq!(span.channel, "777888");
    let row = snapshot.metrics.iter().find(|m| m.kind == "http").unwrap();
    assert_eq!(
        (row.channel.as_str(), row.outcome.as_str(), row.count),
        ("777888", "200", 2)
    );
}

/// Port of `telemetry.test.ts`: "fetch preserves response body and removes URL secrets", plus
/// the trace header to internal providers only and the excluded PostHog provider.
#[tokio::test]
async fn outbound_calls_are_spans_and_only_internal_calls_carry_the_trace() {
    let telemetry = telemetry(0.0);
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200).body("body"));
    let twitch = Provider::builder("twitch", &server.url()).build().unwrap();
    let internal = Provider::builder("internal-api", &server.url())
        .internal(true)
        .build()
        .unwrap();
    let posthog = Provider::builder("posthog", &server.url()).build().unwrap();
    let client = HttpClient::builder()
        .observer(telemetry.http_observer())
        .trace_injector(telemetry.trace_injector())
        .build()
        .unwrap();
    let mut span = telemetry.span("chat", "test");
    let ids = span.ids();
    let body = span
        .run(async {
            let body = client
                .get(&twitch, "/helix/users")
                .query(&[("secret", "hidden")])
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            client
                .get(&internal, "/internal")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            client
                .post(&posthog, "/i/v1/logs")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            body
        })
        .await;
    span.end("ok");
    assert_eq!(body, "body");
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].header(TRACEPARENT).is_none());
    let parent = requests[1].header(TRACEPARENT).unwrap();
    let signature = requests[1].header(SIGNATURE).unwrap();
    let secret = SecretString::new(SECRET.to_owned());
    let joined = trace::verify(Some(&secret), parent, signature).unwrap();
    assert_eq!(joined.trace_id, ids.trace_id);
    assert_eq!(joined.span_id, ids.span_id);

    let snapshot = telemetry.take_snapshot();
    let rows: Vec<_> = snapshot
        .metrics
        .iter()
        .filter(|m| m.kind == "http_client")
        .collect();
    let names: Vec<_> = rows
        .iter()
        .map(|r| (r.name.as_str(), r.outcome.as_str()))
        .collect();
    assert_eq!(names, [("internal-api GET", "200"), ("twitch GET", "200")]);
    assert!(!serde_json::to_string(&rows).unwrap().contains("hidden"));

    // Failures and 4xx are errors, and error spans are kept as children of the current span.
    server.push(MockResponse::new(404));
    let mut span = telemetry.span("chat", "failing");
    span.run(async {
        let _ = client.get(&twitch, "/helix/missing").send().await;
    })
    .await;
    let parent = span.ids().span_id;
    span.end("ok");
    let snapshot = telemetry.take_snapshot();
    let error = snapshot
        .spans
        .iter()
        .find(|s| s.kind == "http_client")
        .unwrap();
    assert_eq!(
        (error.name.as_str(), error.outcome.as_str()),
        ("twitch GET", "error")
    );
    assert_eq!(error.parent_id, Some(parent.hex().as_str().to_owned()));
}

#[tokio::test]
async fn mongo_commands_are_database_spans() {
    let telemetry = telemetry(0.0);
    let hook = telemetry.mongo_hook();
    let context = telemetry.root("4242");
    let root = context.ids();
    context
        .scope(async {
            hook.succeeded(&CommandSucceeded {
                request_id: 1,
                command_name: "find",
                collection: Some("users"),
                duration: Duration::from_millis(3),
            });
            hook.failed(&CommandFailed {
                request_id: 2,
                command_name: "listCollections",
                collection: None,
                duration: Duration::from_millis(1500),
                code: Some(11600),
            });
            // A command name this backend does not send makes no series of its own.
            hook.succeeded(&CommandSucceeded {
                request_id: 3,
                command_name: "someNewCommand",
                collection: None,
                duration: Duration::from_millis(1),
            });
        })
        .await;
    let snapshot = telemetry.take_snapshot();
    let find = &snapshot.metric("mongo.find")[0];
    assert_eq!(
        (
            find.kind.as_str(),
            find.outcome.as_str(),
            find.channel.as_str()
        ),
        ("database", "ok", "4242")
    );
    assert_eq!(snapshot.metric("mongo.listCollections")[0].outcome, "error");
    assert_eq!(snapshot.metric("mongo.other")[0].count, 1);
    assert!(
        !serde_json::to_string(&snapshot.metrics)
            .unwrap()
            .contains("someNewCommand")
    );
    let span = &snapshot.spans[0];
    assert_eq!(span.name, "mongo.listCollections");
    assert_eq!(span.parent_id, Some(root.span_id.hex().as_str().to_owned()));
    assert!((span.duration - 1500.0).abs() < 1.0);
}

#[tokio::test]
async fn dragonfly_commands_lookups_and_suppressed_connection_errors() {
    let Some(store) = support::config(13) else {
        return;
    };
    let console = Arc::new(Mutex::new(Vec::new()));
    let mut config = TelemetryConfig::new("bot", "index");
    config.dragonfly = Some(support::local_store(1));
    config.console = ConsoleTarget::Memory(console.clone());
    let telemetry = Telemetry::new(config).unwrap();
    let running = telemetry.start();
    let dragonfly =
        dima_store::dragonfly::Dragonfly::connect(store.clone(), telemetry.dragonfly_hooks())
            .await
            .unwrap();
    let key = support::unique("dima-test-telemetry-hook");
    support::with_cleanup(&store, std::slice::from_ref(&key), async {
        assert_eq!(dragonfly.get(&key).await.unwrap(), None);
        dragonfly
            .set(&key, b"v", dima_store::dragonfly::SetOptions::ex(60))
            .await
            .unwrap();
        assert!(dragonfly.get(&key).await.unwrap().is_some());
        let _: i64 = dragonfly.query(redis::cmd("DEL").arg(&key)).await.unwrap();
        let snapshot = telemetry.take_snapshot();
        let count = |kind: &str, name: &str, outcome: &str| {
            snapshot
                .metrics
                .iter()
                .filter(|m| m.kind == kind && m.name == name && m.outcome == outcome)
                .map(|m| m.count)
                .sum::<u64>()
        };
        assert_eq!(count("cache", "get", "ok"), 2);
        assert_eq!(count("cache", "set", "ok"), 1);
        assert_eq!(count("cache", "del", "ok"), 1);
        assert_eq!(count("cache_lookup", "get", "miss"), 1);
        assert_eq!(count("cache_lookup", "get", "hit"), 1);

        // Connection errors: one line, then suppressed within 30 seconds.
        let hooks = telemetry.dragonfly_hooks();
        let mut dead = support::local_store(support::closed_port());
        dead.connect_timeout = Duration::from_millis(300);
        dead.reconnect_retries = 0;
        for _ in 0..3 {
            assert!(
                dima_store::dragonfly::Dragonfly::connect(dead.clone(), hooks.clone())
                    .await
                    .is_err()
            );
        }
        running.shutdown(Duration::from_secs(2)).await;
        let lines = support::lines(&console);
        let errors: Vec<_> = lines
            .iter()
            .filter(|line| {
                line["data"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("Error connecting to DragonFlyDB from hung")
            })
            .collect();
        assert_eq!(errors.len(), 1, "{lines:?}");
    })
    .await;
}
