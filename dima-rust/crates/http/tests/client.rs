//! The provider client against the loopback mock: bodies, limits, timeouts, retries (including
//! the ported Helix cases), redirects, redaction, telemetry, concurrency and shutdown.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bytes::Bytes;
use dima_core::{SecretString, Shutdown};
use dima_http::guard::{BoxFuture, Resolver};
use dima_http::observe::{Observer, RequestEnd, RequestStart, TraceInjector};
use dima_http::retry::{ServerDelay, StatusSet};
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{
    Credential, Error, FailureClass, HeaderMap, HeaderValue, HttpClient, Method, Path, Provider,
    Redirects, Refresh, RetryPolicy, TimeoutKind, header,
};
use std::io::Write as _;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

fn client() -> HttpClient {
    HttpClient::builder().build().unwrap()
}

fn provider(server: &MockServer) -> Provider {
    Provider::builder("mock", "https://api.example.invalid/base")
        .base_url(&format!("{}/base", server.url()))
        .build()
        .unwrap()
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[tokio::test]
async fn json_round_trip_with_paths_queries_and_headers() {
    let server = MockServer::start().await.unwrap();
    server.push(MockResponse::json(
        200,
        r#"{"data":[{"id":"1","name":"\ud800x"}]}"#,
    ));
    let provider = Provider::builder("twitch", "https://api.twitch.tv/helix")
        .base_url(&format!("{}/helix", server.url()))
        .header("client-id", "abc")
        .header("content-type", "application/json")
        .build()
        .unwrap();
    let client = client();
    #[derive(serde::Deserialize)]
    struct Users {
        data: Vec<serde_json::Value>,
    }
    let users: Users = client
        .get(&provider, Path::template("/users/{}", &["a b"]).unwrap())
        .query(&[("login", "dóm&x"), ("first", "1 0")])
        .bearer(&SecretString::from("tok"))
        .send_json()
        .await
        .unwrap();
    // A lone surrogate escape from the server becomes U+FFFD.
    assert_eq!(users.data[0]["name"], "\u{fffd}x");
    let request = server.next_request().await.unwrap();
    assert_eq!(request.method, "GET");
    assert_eq!(
        request.target,
        "/helix/users/a%20b?login=d%C3%B3m%26x&first=1+0"
    );
    assert_eq!(request.header("client-id"), Some("abc"));
    assert_eq!(request.header("authorization"), Some("Bearer tok"));
    assert!(request.header("accept-encoding").unwrap().contains("gzip"));
}

#[tokio::test]
async fn bodies_json_js_form_and_exact_bytes() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(204));
    let provider = provider(&server);
    let client = client();
    client
        .post(&provider, "/json")
        .json(&serde_json::json!({"b": 1.0, "a": "é"}))
        .send()
        .await
        .unwrap();
    client
        .post(&provider, "/js")
        .json_js(&serde_json::json!({"n": 1e21, "f": 1.0}))
        .send()
        .await
        .unwrap();
    client
        .post(&provider, "/form")
        .form(&[("grant_type", "refresh_token"), ("refresh_token", "a+b c")])
        .send()
        .await
        .unwrap();
    client
        .request(&provider, Method::PUT, "/raw")
        .header("content-type", "application/msgpack")
        .body(Bytes::from_static(b"\x83\xa4text"))
        .send()
        .await
        .unwrap();
    let requests = server.wait_for(4).await;
    assert_eq!(requests[0].body_text(), r#"{"b":1.0,"a":"é"}"#);
    assert_eq!(requests[0].header("content-type"), Some("application/json"));
    assert_eq!(requests[1].body_text(), r#"{"n":1e+21,"f":1}"#);
    assert_eq!(
        requests[2].body_text(),
        "grant_type=refresh_token&refresh_token=a%2Bb+c"
    );
    assert_eq!(
        requests[2].header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(requests[3].method, "PUT");
    assert_eq!(requests[3].body, b"\x83\xa4text");
    assert_eq!(
        requests[3].header("content-type"),
        Some("application/msgpack")
    );
}

#[tokio::test]
async fn body_limit_is_exact_and_an_error() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    // Exactly at the limit: fine. One byte over: an error, declared or streamed.
    server.push(MockResponse::new(200).body(vec![b'a'; 10]));
    let body = client
        .get(&provider, "/")
        .max_bytes(10)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.len(), 10);
    server.push(MockResponse::new(200).body(vec![b'a'; 11]));
    let error = client
        .get(&provider, "/")
        .max_bytes(10)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::BodyTooLarge { limit: 10, .. }),
        "{error:?}"
    );
    server.push(MockResponse::new(200).chunks(vec![
        (Duration::ZERO, Bytes::from_static(b"12345")),
        (Duration::ZERO, Bytes::from_static(b"678901")),
    ]));
    let error = client
        .get(&provider, "/")
        .max_bytes(10)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap_err();
    assert_eq!(error.class(), FailureClass::TooLarge);
}

#[tokio::test]
async fn decompression_counts_decoded_bytes() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    let text = "hola ".repeat(1000);
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(text.as_bytes()).unwrap();
    let gzip = gzip.finish().unwrap();
    let mut deflate = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    deflate.write_all(text.as_bytes()).unwrap();
    let deflate = deflate.finish().unwrap();
    server.push(
        MockResponse::new(200)
            .header("content-encoding", "gzip")
            .body(gzip.clone()),
    );
    server.push(
        MockResponse::new(200)
            .header("content-encoding", "deflate")
            .body(deflate),
    );
    assert_eq!(
        client
            .get(&provider, "/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        text
    );
    assert_eq!(
        client
            .get(&provider, "/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        text
    );
    // A small compressed body that inflates past the limit is refused.
    server.push(
        MockResponse::new(200)
            .header("content-encoding", "gzip")
            .body(gzip),
    );
    let error = client
        .get(&provider, "/")
        .max_bytes(1000)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert_eq!(error.class(), FailureClass::TooLarge);
}

#[tokio::test]
async fn write_to_and_chunks() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(MockResponse::new(200).chunks(vec![
        (Duration::ZERO, Bytes::from_static(b"ab")),
        (ms(20), Bytes::from_static(b"cd")),
    ]));
    let mut out = Vec::new();
    let n = client
        .get(&provider, "/")
        .send()
        .await
        .unwrap()
        .write_to(&mut out)
        .await
        .unwrap();
    assert_eq!((n, out.as_slice()), (4, &b"abcd"[..]));
}

#[tokio::test]
async fn timeouts_total_headers_idle() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(MockResponse::new(200).delay(ms(2000)));
    let error = client
        .get(&provider, "/")
        .timeout(ms(200))
        .send()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Total,
                ..
            }
        ),
        "{error:?}"
    );

    server.push(MockResponse::new(200).delay(ms(2000)));
    let error = client
        .get(&provider, "/")
        .headers_timeout(ms(200))
        .send()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Headers,
                ..
            }
        ),
        "{error:?}"
    );

    // A stalled stream: headers arrive, the body never does.
    server.push(
        MockResponse::new(200)
            .body(vec![0u8; 100])
            .stall_after_headers(),
    );
    let started = Instant::now();
    let error = client
        .get(&provider, "/")
        .idle_timeout(ms(200))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Idle,
                ..
            }
        ),
        "{error:?}"
    );
    assert!(started.elapsed() < ms(1500));

    // Chunks that keep coming but past the total deadline.
    server.push(
        MockResponse::new(200).chunks(
            (0..20)
                .map(|_| (ms(50), Bytes::from_static(b"x")))
                .collect(),
        ),
    );
    let error = client
        .get(&provider, "/")
        .timeout(ms(300))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Total,
                ..
            }
        ),
        "{error:?}"
    );
}

/// A resolver that never answers, so the connect phase hangs on loopback.
#[derive(Debug)]
struct Hanging;

impl Resolver for Hanging {
    fn resolve<'a>(&'a self, _host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn slow_connect_is_a_connect_timeout() {
    let client = HttpClient::builder()
        .connect_timeout(ms(200))
        .resolver(Arc::new(Hanging))
        .build()
        .unwrap();
    let provider = Provider::builder("slow", "http://slow.invalid")
        .build()
        .unwrap();
    let started = Instant::now();
    let error = client.get(&provider, "/").send().await.unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Connect,
                ..
            }
        ),
        "{error:?}"
    );
    assert!(started.elapsed() < ms(1500));
}

#[tokio::test]
async fn refused_connection_is_a_connect_error_and_retried_when_allowed() {
    // A port nothing listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let provider = Provider::builder("down", &format!("http://127.0.0.1:{port}"))
        .build()
        .unwrap();
    let client = client();
    let error = client.post(&provider, "/").send().await.unwrap_err();
    assert_eq!(error.class(), FailureClass::Connect);
    let error = client
        .post(&provider, "/")
        .retry(RetryPolicy::fixed(&[ms(1), ms(1)]).retry_failures(true, false, false))
        .send()
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::RetriesExhausted { attempts: 3, .. }),
        "{error:?}"
    );
    assert_eq!(error.class(), FailureClass::Connect);
}

#[tokio::test]
async fn retries_statuses_and_returns_the_last_response() {
    let server = MockServer::start().await.unwrap();
    let provider = Provider::builder("ai", "https://openrouter.ai/api/v1")
        .base_url(&server.url())
        .retry(RetryPolicy::fetch_with_retry(&[ms(10), ms(10)]))
        .build()
        .unwrap();
    let client = client();
    server.push(MockResponse::new(503));
    server.push(MockResponse::new(429));
    server.push(MockResponse::json(200, "{}"));
    let response = client
        .post(&provider, "/chat")
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!((response.status().as_u16(), response.attempts()), (200, 3));
    let requests = server.wait_for(3).await;
    assert!(requests.iter().all(|r| r.body_text() == "{}"));

    // Every attempt fails: the last response comes back, and turns into RetriesExhausted.
    for _ in 0..3 {
        server.push(MockResponse::new(502).body("upstream down"));
    }
    let response = client.post(&provider, "/chat").send().await.unwrap();
    assert_eq!((response.status().as_u16(), response.attempts()), (502, 3));
    let error = response.error_for_status().await.unwrap_err();
    assert!(matches!(error, Error::RetriesExhausted { attempts: 3, .. }));
    let status = error.as_status().unwrap();
    assert_eq!(status.body_text(), "upstream down");

    // A dropped connection is a transport failure and retried by this policy.
    server.push(MockResponse::drop_connection());
    server.push(MockResponse::json(200, "{}"));
    let response = client.post(&provider, "/chat").send().await.unwrap();
    assert_eq!(response.attempts(), 2);

    // A POST is not retried on 503 by a policy that keeps idempotency.
    let strict = RetryPolicy::fixed(&[ms(1)]).retry_statuses(StatusSet::new().with(503));
    server.push(MockResponse::new(503));
    let response = client
        .post(&provider, "/x")
        .retry(strict.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.attempts(), 1);
    // ...unless the caller declares it idempotent.
    server.push(MockResponse::new(503));
    server.push(MockResponse::new(200));
    let response = client
        .post(&provider, "/x")
        .retry(strict)
        .idempotent(true)
        .send()
        .await
        .unwrap();
    assert_eq!(response.attempts(), 2);
}

#[tokio::test]
async fn retry_after_is_waited_in_real_time() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(MockResponse::new(429).header("retry-after", "0.3"));
    server.push(MockResponse::new(200));
    let policy = RetryPolicy::fixed(&[ms(1)])
        .retry_statuses(StatusSet::new().with(429))
        .server_delay(ServerDelay::retry_after(Duration::from_secs(5)));
    let started = Instant::now();
    let response = client
        .get(&provider, "/")
        .retry(policy)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(started.elapsed() >= ms(300), "{:?}", started.elapsed());
}

#[tokio::test]
async fn streamed_bodies_are_never_resent() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(MockResponse::new(503));
    server.push(MockResponse::new(200));
    let body = dima_http::StreamBody::from(Bytes::from_static(b"stream"));
    // `reqwest::Body::from(Bytes)` is replayable inside reqwest, but this crate treats every
    // body given as a stream as one-shot.
    let response = client
        .request(&provider, Method::PUT, "/")
        .body_stream(body)
        .retry(RetryPolicy::fixed(&[ms(1)]).retry_statuses(StatusSet::new().with(503)))
        .send()
        .await
        .unwrap();
    assert_eq!((response.status().as_u16(), response.attempts()), (503, 1));
}

/// The reference Helix credential: records what was sent, refreshes as scripted.
#[derive(Debug)]
struct ScriptedCredential {
    refreshes: Mutex<Vec<u32>>,
    behaviour: fn(u32) -> Refresh,
}

impl Credential for ScriptedCredential {
    fn refresh<'a>(&'a self, attempt: u32, _rejected: &'a HeaderValue) -> BoxFuture<'a, Refresh> {
        Box::pin(async move {
            self.refreshes.lock().unwrap().push(attempt);
            (self.behaviour)(attempt)
        })
    }
}

async fn helix_run(
    statuses: &[u16],
    delays: &[Duration],
    behaviour: fn(u32) -> Refresh,
) -> (dima_http::Response, Vec<String>, Vec<u32>) {
    let server = MockServer::start().await.unwrap();
    for status in statuses {
        server.push(MockResponse::new(*status));
    }
    let provider = Provider::builder("twitch", "https://api.twitch.tv/helix")
        .base_url(&server.url())
        .retry(RetryPolicy::twitch_helix_with(delays))
        .build()
        .unwrap();
    let credential = Arc::new(ScriptedCredential {
        refreshes: Mutex::new(Vec::new()),
        behaviour,
    });
    let response = client()
        .get(&provider, "/channels/followers")
        .credential(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer rejected"),
            credential.clone(),
        )
        .send()
        .await
        .unwrap();
    let sent = server
        .requests()
        .iter()
        .map(|r| r.header("authorization").unwrap().to_owned())
        .collect();
    let refreshes = credential.refreshes.lock().unwrap().clone();
    (response, sent, refreshes)
}

// Ported from dimabot/src/utils/twitch_streamer_refresh.test.ts.
#[tokio::test]
async fn helix_401_refreshes_the_rejected_token_and_sends_the_rotated_token() {
    let (response, sent, refreshes) = helix_run(&[401, 200], &[ms(1)], |_| {
        Refresh::Rotated(HeaderValue::from_static("Bearer rotated"))
    })
    .await;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(sent, ["Bearer rejected", "Bearer rotated"]);
    assert_eq!(refreshes, [1]);
    assert!(!response.auth_refresh_unavailable());
}

#[tokio::test]
async fn helix_a_failed_refresh_does_not_resend_the_rejected_credential() {
    let (response, sent, refreshes) = helix_run(&[401, 200], &[ms(1)], |_| Refresh::Stop).await;
    assert_eq!(response.status().as_u16(), 401);
    assert!(response.auth_refresh_unavailable());
    assert_eq!(sent, ["Bearer rejected"]);
    assert_eq!(refreshes, [1]);
}

#[tokio::test]
async fn helix_persistent_401s_stop_after_the_configured_retries() {
    fn rotate(attempt: u32) -> Refresh {
        Refresh::Rotated(HeaderValue::try_from(format!("Bearer rotated-{attempt}")).unwrap())
    }
    let (response, sent, refreshes) =
        helix_run(&[401, 401, 401, 200], &[ms(1), ms(1)], rotate).await;
    assert_eq!(response.status().as_u16(), 401);
    assert!(!response.auth_refresh_unavailable());
    assert_eq!(
        sent,
        ["Bearer rejected", "Bearer rotated-1", "Bearer rotated-2"]
    );
    assert_eq!(refreshes, [1, 2]);
}

#[tokio::test]
async fn helix_app_path_retries_with_the_same_header_when_refresh_gives_nothing_new() {
    let (response, sent, _) = helix_run(&[401, 200], &[ms(1)], |_| Refresh::Retry).await;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(sent, ["Bearer rejected", "Bearer rejected"]);
}

#[tokio::test]
async fn helix_default_delays_are_waited() {
    // Paused time is not usable with real sockets, so the default 1 s first delay is measured.
    let started = Instant::now();
    let (response, _, _) = helix_run(&[401, 200], &[], |_| {
        Refresh::Rotated(HeaderValue::from_static("Bearer rotated"))
    })
    .await;
    assert_eq!(response.status().as_u16(), 200);
    assert!(started.elapsed() >= ms(1000));
}

#[tokio::test]
async fn redirects_error_manual_and_same_origin() {
    let server = MockServer::start().await.unwrap();
    let client = client();
    let refuse = provider(&server);
    server.push(MockResponse::new(307).header("location", "/elsewhere"));
    let error = client.get(&refuse, "/").send().await.unwrap_err();
    assert!(
        matches!(error, Error::Redirect { status: 307, .. }),
        "{error:?}"
    );

    let manual = Provider::builder("m", &server.url())
        .redirects(Redirects::Manual)
        .build()
        .unwrap();
    server.push(MockResponse::new(302).header("location", "/elsewhere"));
    let response = client.get(&manual, "/").send().await.unwrap();
    assert_eq!(response.status().as_u16(), 302);

    let follow = Provider::builder("f", &server.url())
        .redirects(Redirects::SameOrigin { max: 2 })
        .build()
        .unwrap();
    server.push(MockResponse::new(308).header("location", "/two"));
    server.push(MockResponse::new(303).header("location", "/three"));
    server.push(MockResponse::json(200, "{}"));
    let response = client
        .post(&follow, "/one")
        .bearer(&SecretString::from("tok"))
        .json(&serde_json::json!({"a": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let requests = server.requests();
    let tail = &requests[requests.len() - 3..];
    assert_eq!(
        tail.iter()
            .map(|r| (r.method.as_str(), r.target.as_str()))
            .collect::<Vec<_>>(),
        [("POST", "/one"), ("POST", "/two"), ("GET", "/three")]
    );
    assert_eq!(tail[1].body_text(), r#"{"a":1}"#);
    assert!(tail[2].body.is_empty());

    // Too many hops, or another origin: an error, and nothing is sent there.
    for _ in 0..3 {
        server.push(MockResponse::new(302).header("location", "/again"));
    }
    let error = client.get(&follow, "/").send().await.unwrap_err();
    assert!(matches!(error, Error::Redirect { .. }));
    server.push(MockResponse::new(302).header("location", "http://127.0.0.2:1/steal"));
    let error = client.get(&follow, "/").send().await.unwrap_err();
    assert!(matches!(error, Error::Redirect { .. }));
}

#[tokio::test]
async fn nothing_secret_is_printed() {
    let server = MockServer::start().await.unwrap();
    let provider = Provider::builder("polar", "https://api.polar.sh/v1")
        .base_url(&format!("{}/v1", server.url()))
        .secret_header(
            "authorization",
            &SecretString::from("Bearer polar_oat_SECRET1"),
        )
        .secret_query_params(&["sig"])
        .build()
        .unwrap();
    let client = client();
    server.push(
        MockResponse::new(403)
            .header("set-cookie", "session=SECRET2")
            .header("x-api-key", "SECRET3")
            .header("ratelimit-remaining", "0")
            .body("denied for SECRET4"),
    );
    let path = Path::template("/checkouts/client/{}/confirm", &["cs_SECRET5"]).unwrap();
    let error = client
        .post(&provider, path)
        .query(&[("sig", "SECRET6"), ("key", "SECRET7"), ("page", "2")])
        .header("x-api-key", "SECRET8")
        .header("cookie", "a=SECRET9")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .await
        .unwrap_err();
    let printed = format!("{error} | {error:?} | {:?}", error.info());
    assert!(!printed.contains("SECRET"), "{printed}");
    assert!(
        printed.contains("/checkouts/client/{}/confirm"),
        "{printed}"
    );
    assert!(printed.contains("page=2"), "{printed}");
    let status = error.as_status().unwrap();
    assert_eq!(status.status.as_u16(), 403);
    assert_eq!(status.headers.get("ratelimit-remaining").unwrap(), "0");
    assert!(status.headers.get("set-cookie").is_none());
    // The body slice is available to the caller, never printed.
    assert!(status.body_text().contains("SECRET4"));
    let request = server.next_request().await.unwrap();
    assert_eq!(
        request.header("authorization"),
        Some("Bearer polar_oat_SECRET1")
    );

    // Transport errors never carry the URL.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let down = Provider::builder("down", &format!("http://127.0.0.1:{port}"))
        .build()
        .unwrap();
    let error = client
        .get(&down, "/x")
        .query(&[("token", "SECRET10")])
        .send()
        .await
        .unwrap_err();
    let printed = format!("{error} | {error:?}");
    assert!(!printed.contains("SECRET"), "{printed}");
    assert!(!printed.contains(&format!("127.0.0.1:{port}")), "{printed}");
}

#[derive(Debug, Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
}

impl Observer for Recorder {
    fn request_start(&self, start: &RequestStart<'_>) {
        self.events.lock().unwrap().push(format!(
            "start {} {} {} #{}",
            start.provider, start.method, start.template, start.attempt
        ));
    }
    fn request_end(&self, end: &RequestEnd<'_>) {
        self.events.lock().unwrap().push(format!(
            "end {} #{} status={:?} failure={:?} complete={} sent={:?} received={}",
            end.template,
            end.attempt,
            end.status,
            end.failure.map(FailureClass::as_str),
            end.body_complete,
            end.bytes_sent,
            end.bytes_received
        ));
    }
}

#[derive(Debug)]
struct Trace;

impl TraceInjector for Trace {
    fn inject(&self, provider: &'static str, headers: &mut HeaderMap) {
        headers.insert("traceparent", HeaderValue::from_static("00-abc-def-01"));
        headers.insert("x-trace-provider", HeaderValue::from_static(provider));
    }
}

#[tokio::test]
async fn observer_sees_attempts_and_trace_headers_go_to_internal_providers_only() {
    let server = MockServer::start().await.unwrap();
    let recorder = Arc::new(Recorder::default());
    let client = HttpClient::builder()
        .observer(recorder.clone())
        .trace_injector(Arc::new(Trace))
        .build()
        .unwrap();
    let internal = Provider::builder("internal-api", "http://dima-server:3000")
        .base_url(&server.url())
        .internal(true)
        .retry(RetryPolicy::fixed(&[ms(1)]).retry_statuses(StatusSet::new().with(503)))
        .build()
        .unwrap();
    let external = provider(&server);
    server.push(MockResponse::new(503));
    server.push(MockResponse::new(200).body("hello"));
    let path = Path::template("/speech/{}/status", &["123456"]).unwrap();
    let text = client
        .get(&internal, path)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(text, "hello");
    server.push(MockResponse::new(200));
    client.get(&external, "/x").send().await.unwrap();
    let requests = server.wait_for(3).await;
    assert_eq!(requests[0].header("traceparent"), Some("00-abc-def-01"));
    assert_eq!(requests[1].header("x-trace-provider"), Some("internal-api"));
    assert_eq!(requests[2].header("traceparent"), None);
    let events = recorder.events.lock().unwrap().clone();
    assert_eq!(
        &events[..4],
        [
            "start internal-api GET /speech/{}/status #1",
            "end /speech/{}/status #1 status=Some(503) failure=None complete=false sent=Some(0) received=0",
            "start internal-api GET /speech/{}/status #2",
            "end /speech/{}/status #2 status=Some(200) failure=None complete=true sent=Some(0) received=5",
        ]
    );
    assert!(events.iter().all(|e| !e.contains("123456")));
}

#[tokio::test]
async fn concurrency_cap_holds_slots_until_the_body_is_done() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200).body("ok").delay(ms(150)));
    let provider = Provider::builder("capped", &server.url())
        .max_concurrency(1)
        .build()
        .unwrap();
    let client = client();
    let started = Instant::now();
    let (a, b) = tokio::join!(
        async {
            client
                .get(&provider, "/a")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        },
        async {
            client
                .get(&provider, "/b")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        },
    );
    assert_eq!((a.as_str(), b.as_str()), ("ok", "ok"));
    assert!(started.elapsed() >= ms(300), "{:?}", started.elapsed());
    // Waiting for a slot counts against the deadline.
    let held = client.get(&provider, "/held").send().await.unwrap();
    let error = client
        .get(&provider, "/c")
        .timeout(ms(100))
        .send()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Queue,
                ..
            }
        ),
        "{error:?}"
    );
    drop(held);
    client.get(&provider, "/d").send().await.unwrap();
}

#[tokio::test]
async fn shutdown_cancels_sends_bodies_and_retry_waits() {
    let server = MockServer::start().await.unwrap();
    let shutdown = Shutdown::new();
    let client = HttpClient::builder()
        .shutdown(shutdown.clone())
        .build()
        .unwrap();
    let provider = provider(&server);
    server.push(MockResponse::new(200).delay(ms(5000)));
    let trigger = {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ms(100)).await;
            shutdown.trigger();
        })
    };
    let started = Instant::now();
    let error = client.get(&provider, "/").send().await.unwrap_err();
    assert!(matches!(error, Error::Cancelled { .. }), "{error:?}");
    assert!(started.elapsed() < ms(2000));
    trigger.await.unwrap();

    // A request's own token cancels its retry wait.
    let client = client_with_fresh_shutdown();
    let own = Shutdown::new();
    server.push(MockResponse::new(503));
    let policy =
        RetryPolicy::fixed(&[Duration::from_secs(30)]).retry_statuses(StatusSet::new().with(503));
    let cancel = own.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ms(100)).await;
        cancel.trigger();
    });
    let error = client
        .get(&provider, "/")
        .retry(policy)
        .cancel_on(&own)
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Cancelled { .. }), "{error:?}");
}

fn client_with_fresh_shutdown() -> HttpClient {
    HttpClient::builder()
        .shutdown(Shutdown::new())
        .build()
        .unwrap()
}

#[tokio::test]
async fn dropping_a_response_closes_the_stream() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(
        MockResponse::new(200).chunks(
            (0..100)
                .map(|_| (ms(20), Bytes::from_static(b"x")))
                .collect(),
        ),
    );
    let mut response = client.get(&provider, "/").send().await.unwrap();
    assert!(response.chunk().await.unwrap().is_some());
    drop(response);
    // The next request still works (on a new connection).
    server.push(MockResponse::new(200).body("next"));
    let text = client
        .get(&provider, "/")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(text, "next");
}

#[tokio::test]
async fn invalid_requests_fail_before_sending() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    let error = client
        .get(&provider, "/")
        .header("bad header", "v")
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Invalid { .. }));
    let error = client
        .get(&provider, "/")
        .header("x-ok", "bad\nvalue")
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Invalid { .. }));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn connection_dropped_mid_body_is_a_transport_error() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(MockResponse::new(200).body(vec![b'a'; 100]).drop_after(10));
    let error = client
        .get(&provider, "/")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert_eq!(error.class(), FailureClass::Transport, "{error:?}");
}

#[tokio::test]
async fn corrupt_compressed_body_is_a_decode_error() {
    let server = MockServer::start().await.unwrap();
    let provider = provider(&server);
    let client = client();
    server.push(
        MockResponse::new(200)
            .header("content-encoding", "gzip")
            .body(&b"\x1f\x8b\x08\x00garbage-not-gzip"[..]),
    );
    let error = client
        .get(&provider, "/")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert_eq!(error.class(), FailureClass::Decode, "{error:?}");
    // Invalid JSON too.
    server.push(MockResponse::json(200, "{nope"));
    let error = client
        .get(&provider, "/")
        .send_json::<serde_json::Value>()
        .await
        .unwrap_err();
    assert_eq!(error.class(), FailureClass::Decode, "{error:?}");
}

#[tokio::test]
async fn a_streamed_body_is_not_resent_through_a_redirect() {
    let server = MockServer::start().await.unwrap();
    let follow = Provider::builder("f", &server.url())
        .redirects(Redirects::SameOrigin { max: 3 })
        .build()
        .unwrap();
    let client = client();
    for status in [301, 307] {
        server.push(MockResponse::new(status).header("location", "/next"));
        let error = client
            .request(&follow, Method::PUT, "/upload")
            .body_stream(dima_http::StreamBody::from(Bytes::from_static(b"data")))
            .send()
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Redirect { .. }),
            "{status}: {error:?}"
        );
    }
    // A 303 needs no body: it is followed as a GET.
    server.push(MockResponse::new(303).header("location", "/next"));
    server.push(MockResponse::new(200));
    let response = client
        .request(&follow, Method::PUT, "/upload")
        .body_stream(dima_http::StreamBody::from(Bytes::from_static(b"data")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let last = server.requests().pop().unwrap();
    assert_eq!((last.method.as_str(), last.body.len()), ("GET", 0));
}
