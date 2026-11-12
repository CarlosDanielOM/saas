use dima_ai::minimax::*;
use dima_core::{ManualClock, Shutdown};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
struct NoTools;
impl Tools for NoTools {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: Value,
        _: &'a Shutdown,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async { Ok(json!({"ok":true})) })
    }
}
#[derive(Default)]
struct Capture(Mutex<Vec<String>>);
impl Handlers for Capture {
    fn text(&self, t: &str) {
        if let Ok(mut v) = self.0.lock() {
            v.push(t.into());
        }
    }
}
#[tokio::test]
async fn recorded_minimax_streams() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("minimax_reference.json"))?;
    for c in cases {
        let server = MockServer::start().await?;
        let config = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: dima_core::SecretString::from("test-only"),
        };
        let provider = server.provider(config.builder())?;
        for attempt in 0..3 {
            server.push(if c["mode"] == "timeout" {
                MockResponse::new(200).delay(Duration::from_secs(1))
            } else {
                MockResponse::new(c["status"].as_u64().unwrap() as u16)
                    .header(
                        "content-type",
                        if c["status"] == 200 {
                            "text/event-stream"
                        } else {
                            "application/json"
                        },
                    )
                    .header("retry-after-ms", "1")
                    .body(if c["mode"] == "tools" && attempt == 0 {
                        c["toolBody"].as_str().unwrap().to_string()
                    } else {
                        c["body"].as_str().unwrap().to_string()
                    })
            });
        }
        let client = Client {
            http: HttpClient::builder().build()?,
            provider,
            clock: Arc::new(ManualClock::new(1)),
        };
        let handlers = Capture::default();
        let p = Params {
            messages: serde_json::from_value(c["params"]["messages"].clone())?,
            system: Some(c["params"]["system"].clone()),
            effort: Some(Effort::High),
            idle_timeout: Some(if c["mode"] == "timeout" {
                Duration::from_millis(30)
            } else {
                Duration::from_secs(120)
            }),
            tools: c["params"]["tools"]
                .as_array()
                .map(|a| a.iter().map(|t| t["definition"].clone()).collect())
                .unwrap_or_default(),
            max_tool_rounds: c["params"]["maxToolRounds"].as_u64().map(|n| n as usize),
            ..Default::default()
        };
        let result = client.chat(p, &NoTools, &handlers, &Shutdown::new()).await;
        if c.get("error").is_some() {
            assert_eq!(json!(result.unwrap_err().kind), c["error"]["kind"]);
        } else {
            let mut v = json!(result?);
            v.as_object_mut().unwrap().shift_remove("durationMs");
            assert_eq!(
                dima_text::to_js_json(&v),
                dima_text::to_js_json(&c["expected"])
            );
        }
        assert_eq!(
            server.requests().len(),
            c["requests"].as_array().unwrap().len()
        );
        for (r, expected) in server
            .requests()
            .into_iter()
            .zip(c["requests"].as_array().unwrap())
        {
            assert_eq!(r.target, expected["target"].as_str().unwrap());
            assert_eq!(r.body_text(), expected["body"].as_str().unwrap());
            for (k, v) in expected["headers"].as_object().unwrap() {
                assert_eq!(r.header(k), v.as_str());
            }
        }
    }
    Ok(())
}

fn success_stream() -> MockResponse {
    MockResponse::sse(
        &[
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{}}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ],
        Duration::ZERO,
    )
}
#[tokio::test]
async fn retry_status_matrix_and_server_wait() -> anyhow::Result<()> {
    for status in [400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504, 529] {
        for exhaust in [false, true] {
            let server = MockServer::start().await?;
            let cfg = Config {
                base_url: "https://api.minimax.io/anthropic".into(),
                key: "test-only".into(),
            };
            let provider = server.provider(cfg.builder())?;
            let retry = status == 408 || status == 409 || status == 429 || status >= 500;
            for _ in 0..if exhaust { 3 } else { 1 } {
                server.push(MockResponse::new(status).header("retry-after-ms", "20"));
            }
            server.push(success_stream());
            let client = Client {
                http: HttpClient::builder().build()?,
                provider,
                clock: Arc::new(ManualClock::new(0)),
            };
            let start = std::time::Instant::now();
            let result = client
                .chat(Params::default(), &NoTools, &(), &Shutdown::new())
                .await;
            assert_eq!(
                server.requests().len(),
                if retry {
                    if exhaust { 3 } else { 2 }
                } else {
                    1
                }
            );
            if retry {
                assert!(start.elapsed() >= Duration::from_millis(if exhaust { 40 } else { 20 }));
            }
            if retry && !exhaust {
                assert!(result.is_ok());
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.status, Some(status));
                assert_eq!(
                    error.kind,
                    if status == 429 {
                        ErrorKind::RateLimited
                    } else if status >= 500 {
                        ErrorKind::Overloaded
                    } else {
                        ErrorKind::BadRequest
                    }
                );
                // Unlike the SDK message, our diagnostic cannot echo response secrets.
                assert!(!error.to_string().contains("test-only"));
            }
        }
    }
    Ok(())
}
#[tokio::test]
async fn stream_faults_never_retry_after_headers() -> anyhow::Result<()> {
    for (response, kind) in [
        // Bytes without a complete event must not keep the event watchdog alive.
        (
            MockResponse::sse(
                &["data: ", "{", " ", " ", " ", " ", " "],
                Duration::from_millis(20),
            ),
            ErrorKind::Timeout,
        ),
        (
            MockResponse::sse(&["data: {broken\n\n"], Duration::ZERO),
            ErrorKind::Upstream,
        ),
        (
            MockResponse::sse(
                &[
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"half\"}}\n\n",
                ],
                Duration::ZERO,
            ),
            ErrorKind::Upstream,
        ),
        (
            MockResponse::new(200).body("data: ").stall_after_headers(),
            ErrorKind::Timeout,
        ),
        (
            MockResponse::sse(
                &["data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n"],
                Duration::ZERO,
            ),
            ErrorKind::Overloaded,
        ),
        (
            MockResponse::sse(
                &["data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n\n"],
                Duration::ZERO,
            ),
            ErrorKind::RateLimited,
        ),
        (
            MockResponse::sse(
                &["data: {\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}\n\n"],
                Duration::ZERO,
            ),
            ErrorKind::Upstream,
        ),
    ] {
        let server = MockServer::start().await?;
        server.push(response);
        let cfg = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: "test-only".into(),
        };
        let client = Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder())?,
            clock: Arc::new(ManualClock::new(0)),
        };
        let error = client
            .chat(
                Params {
                    idle_timeout: Some(Duration::from_millis(50)),
                    ..Default::default()
                },
                &NoTools,
                &(),
                &Shutdown::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(server.requests().len(), 1);
    }
    Ok(())
}
#[tokio::test]
async fn caller_cancel_before_headers_and_during_stream() -> anyhow::Result<()> {
    for during in [false, true] {
        let server = MockServer::start().await?;
        server.push(if during {
            MockResponse::new(200).body("data: ").stall_after_headers()
        } else {
            MockResponse::new(200).delay(Duration::from_secs(30))
        });
        let cfg = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: "test-only".into(),
        };
        let client = Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder())?,
            clock: Arc::new(ManualClock::new(0)),
        };
        let cancel = Shutdown::new();
        let owned = cancel.clone();
        let work =
            tokio::spawn(
                async move { client.chat(Params::default(), &NoTools, &(), &owned).await },
            );
        server.wait_for(1).await;
        cancel.trigger();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), work)
                .await??
                .unwrap_err()
                .kind,
            ErrorKind::Aborted
        );
        assert_eq!(server.requests().len(), 1);
    }
    Ok(())
}

mod support;
#[tokio::test]
async fn header_timeouts_connection_recovery_and_overall_bound() -> anyhow::Result<()> {
    for mode in [
        "connect-recover",
        "connect-exhaust",
        "header-recover",
        "header-exhaust",
        "overall",
    ] {
        let server = MockServer::start().await?;
        for _ in 0..if mode.ends_with("recover") { 1 } else { 3 } {
            server.push(if mode.starts_with("connect") {
                MockResponse::drop_connection()
            } else {
                MockResponse::new(200).delay(Duration::from_secs(3600))
            });
        }
        server.push(success_stream());
        let cfg = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: "test-only".into(),
        };
        let builder = if mode == "overall" {
            cfg.builder().headers_timeout(Duration::from_secs(3600))
        } else {
            cfg.builder().headers_timeout(Duration::from_secs(60))
        };
        let client = Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(builder)?,
            clock: Arc::new(ManualClock::new(0)),
        };
        // Raise idle only to isolate per-attempt and whole-call deadlines.
        let result = support::virtual_time(client.chat(
            Params {
                idle_timeout: Some(Duration::from_secs(4000)),
                ..Default::default()
            },
            &NoTools,
            &(),
            &Shutdown::new(),
        ))
        .await;
        if mode.ends_with("recover") {
            assert!(result.is_ok(), "{mode}: {result:?}");
        } else {
            assert_eq!(
                result.unwrap_err().kind,
                if mode.starts_with("connect") {
                    ErrorKind::Upstream
                } else {
                    ErrorKind::Timeout
                },
                "{mode}"
            );
        }
        assert_eq!(
            server.requests().len(),
            if mode == "overall" {
                1
            } else if mode.ends_with("recover") {
                2
            } else {
                3
            },
            "{mode}"
        );
    }
    Ok(())
}

#[test]
fn missing_key_fails_at_configuration_boundary() {
    // Reference throws MiniMaxError(config) in getClient. Typed Rust configuration
    // rejects the absent key before there can be a client or any HTTP request.
    for key in ["", "  "] {
        assert!(
            Config {
                base_url: "https://api.minimax.io/anthropic".into(),
                key: key.into()
            }
            .provider()
            .is_err()
        );
    }
}

#[derive(Debug)]
struct ZeroRandom;
impl dima_core::Random for ZeroRandom {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), dima_core::RandomError> {
        bytes.fill(0);
        Ok(())
    }
}
#[tokio::test]
async fn sdk_backoff_and_retry_control_headers() -> anyhow::Result<()> {
    for mode in ["backoff", "force", "deny", "retry-after"] {
        let server = MockServer::start().await?;
        let times = Arc::new(Mutex::new(Vec::new()));
        let capture = times.clone();
        let owned = mode.to_string();
        server.fallback(move |_| {
            let mut times = capture.lock().unwrap();
            times.push(tokio::time::Instant::now());
            if times.len() == 3 || owned != "backoff" && times.len() == 2 {
                return success_stream();
            }
            match owned.as_str() {
                "force" => MockResponse::new(400)
                    .header("x-should-retry", "true")
                    .header("retry-after-ms", "20"),
                "deny" => MockResponse::new(429).header("x-should-retry", "false"),
                "retry-after" => MockResponse::new(429).header("retry-after", "2"),
                _ => MockResponse::new(503),
            }
        });
        let cfg = Config {
            base_url: "https://api.minimax.io/anthropic".into(),
            key: "test-only".into(),
        };
        let client = Client {
            http: HttpClient::builder().random(Arc::new(ZeroRandom)).build()?,
            provider: server.provider(cfg.builder())?,
            clock: Arc::new(ManualClock::new(0)),
        };
        let result =
            support::virtual_time(client.chat(Params::default(), &NoTools, &(), &Shutdown::new()))
                .await;
        assert_eq!(result.is_err(), mode == "deny");
        let times = times.lock().unwrap();
        assert_eq!(
            times.len(),
            if mode == "deny" {
                1
            } else if mode == "backoff" {
                3
            } else {
                2
            }
        );
        let delays: Vec<u64> = match mode {
            "backoff" => vec![375, 750],
            "force" => vec![20],
            "retry-after" => vec![2000],
            _ => vec![],
        };
        for (pair, millis) in times.windows(2).zip(delays) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(millis));
            assert!(pair[1] - pair[0] < Duration::from_millis(millis + 200));
        }
    }
    Ok(())
}

struct FailingTools;
impl Tools for FailingTools {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: Value,
        _: &'a Shutdown,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async { Err("lookup failed".into()) })
    }
}
#[tokio::test]
async fn tool_failure_is_returned_to_model_and_empty_final_answer_fails() -> anyhow::Result<()> {
    let fixture: Vec<Value> = serde_json::from_str(include_str!("minimax_reference.json"))?;
    let tool = fixture.iter().find(|v| v["mode"] == "tools").unwrap();
    let server = MockServer::start().await?;
    server.push(MockResponse::new(200).body(tool["toolBody"].as_str().unwrap().to_owned()));
    server.push(MockResponse::new(200).body(tool["body"].as_str().unwrap().to_owned()));
    let cfg = Config {
        base_url: "https://api.minimax.io/anthropic".into(),
        key: "test-only".into(),
    };
    let client = Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder())?,
        clock: Arc::new(ManualClock::new(0)),
    };
    let params = || Params {
        tools: vec![json!({"name":"lookup","input_schema":{"type":"object"}})],
        max_tool_rounds: Some(2),
        ..Default::default()
    };
    assert!(
        client
            .chat(params(), &FailingTools, &(), &Shutdown::new())
            .await
            .is_ok()
    );
    assert_eq!(server.requests().len(), 2);
    let request: Value = serde_json::from_slice(&server.requests()[1].body)?;
    let block = &request["messages"][1]["content"][0];
    assert_eq!(block["is_error"], true);
    assert_eq!(block["content"], "lookup failed");
    server.push(success_stream());
    server.push(success_stream());
    assert_eq!(
        client
            .chat(params(), &NoTools, &(), &Shutdown::new())
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Upstream
    );
    assert_eq!(server.requests().len(), 4);
    Ok(())
}

#[tokio::test]
async fn interrupted_stream_preserves_emitted_text_and_never_replays_it() -> anyhow::Result<()> {
    let server = MockServer::start().await?;
    let fixture: Vec<Value> = serde_json::from_str(include_str!("minimax_reference.json"))?;
    let body = fixture[0]["body"].as_str().unwrap();
    let prefix = body.split("event: content_block_stop").next().unwrap();
    server.push(MockResponse::new(200).body(prefix.to_owned()));
    server.push(success_stream());
    let cfg = Config {
        base_url: "https://api.minimax.io/anthropic".into(),
        key: "test-only".into(),
    };
    let client = Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder())?,
        clock: Arc::new(ManualClock::new(0)),
    };
    let capture = Capture::default();
    assert_eq!(
        client
            .chat(Params::default(), &NoTools, &capture, &Shutdown::new())
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Upstream
    );
    assert_eq!(capture.0.lock().unwrap().concat(), "Hello 😀");
    assert_eq!(server.requests().len(), 1);
    Ok(())
}
