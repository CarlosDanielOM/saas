//! Fault inventory is in the crate docs; all endpoints here are loopback mocks.
use dima_ai::embeddings::{self, Kind, Service};
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use std::time::{Duration, Instant};
const VALID: &str = r#"{"data":[{"embedding":[1],"index":0}]}"#;

#[tokio::test]
async fn embeddings_retry_statuses_waits_and_exhaustion() -> anyhow::Result<()> {
    for service in [Service::Lfm2, Service::OpenRouter] {
        for status in [429, 500, 502, 503, 504, 400, 401, 403, 408, 409, 501, 529] {
            let server = MockServer::start().await?;
            let cfg = match service {
                Service::Lfm2 => embeddings::Config::lfm2(),
                Service::OpenRouter => embeddings::Config::openrouter("test-only".into()),
            };
            let provider = server.provider(cfg.builder(service))?;
            server.push(MockResponse::json(status, "{}"));
            server.push(MockResponse::json(200, VALID));
            let client = embeddings::Client {
                http: HttpClient::builder().build()?,
                provider,
                service,
            };
            let start = Instant::now();
            let result = client
                .generate_embedding("x", "m", Kind::Query, Some("c"))
                .await;
            let retry = [429, 500, 502, 503, 504].contains(&status);
            assert_eq!(result.error, !retry, "status {status}");
            if !retry {
                let name = match service {
                    Service::Lfm2 => "LFM2",
                    Service::OpenRouter => "OpenRouter",
                };
                assert!(
                    result
                        .message
                        .as_deref()
                        .unwrap()
                        .starts_with(&format!("{name} API error: {status} "))
                );
            }
            assert_eq!(server.requests().len(), if retry { 2 } else { 1 });
            if retry {
                assert!(start.elapsed() >= Duration::from_secs(1));
            }
        }
        let server = MockServer::start().await?;
        let cfg = match service {
            Service::Lfm2 => embeddings::Config::lfm2(),
            Service::OpenRouter => embeddings::Config::openrouter("test-only".into()),
        };
        let attempts = cfg.retries + 1;
        for _ in 0..attempts {
            server.push(MockResponse::json(429, "{}"));
        }
        let provider = server.provider(cfg.builder(service))?;
        let client = embeddings::Client {
            http: HttpClient::builder().build()?,
            provider,
            service,
        };
        let start = Instant::now();
        let result = client
            .generate_embedding("x", "m", Kind::Query, Some("c"))
            .await;
        assert!(result.error);
        assert!(result.message.unwrap().contains("429"));
        assert_eq!(server.requests().len(), attempts);
        assert!(start.elapsed() >= Duration::from_secs(if attempts == 3 { 4 } else { 9 }));
    }
    Ok(())
}

#[tokio::test]
async fn embeddings_transport_timeout_malformed_and_partial_batch() -> anyhow::Result<()> {
    for service in [Service::Lfm2, Service::OpenRouter] {
        for mode in [
            "timeout-success",
            "timeout-exhausted",
            "connection-success",
            "connection-exhausted",
            "malformed",
            "truncated",
            "body-stall",
            "provider-error",
            "batch-item",
        ] {
            let server = MockServer::start().await?;
            let mut cfg = embeddings::Config::lfm2();
            cfg.timeout = Duration::from_millis(50);
            cfg.retries = 1;
            let provider = server.provider(cfg.builder(service))?;
            let response = || match mode {
                "timeout-success" | "timeout-exhausted" => {
                    MockResponse::new(200).delay(Duration::from_secs(2))
                }
                "connection-success" | "connection-exhausted" => MockResponse::drop_connection(),
                "malformed" => MockResponse::json(200, "{broken"),
                "truncated" => MockResponse::json(200, VALID).drop_after(5),
                "body-stall" => MockResponse::json(200, VALID).stall_after_headers(),
                "provider-error" => {
                    MockResponse::json(200, r#"{"error":{"message":"secret-test-sentinel"}}"#)
                }
                _ => MockResponse::json(200, r#"{"data":[{"embedding":[1],"index":0}]}"#),
            };
            server.push(response());
            server.push(if mode.ends_with("success") {
                MockResponse::json(200, VALID)
            } else {
                response()
            });
            let client = embeddings::Client {
                http: HttpClient::builder().build()?,
                provider,
                service,
            };
            let start = Instant::now();
            let result = if mode == "batch-item" {
                client
                    .generate_embeddings(&["a".into(), "b".into()], "m", Kind::Query, Some("c"))
                    .await
            } else {
                client
                    .generate_embedding("x", "m", Kind::Query, Some("c"))
                    .await
            };
            // OpenRouter trusts batch length; LFM2 rejects a missing item.
            assert_eq!(
                result.error,
                !(mode.ends_with("success")
                    || mode == "batch-item" && matches!(service, Service::OpenRouter)),
                "{mode}"
            );
            let retried = mode.starts_with("timeout") || mode.starts_with("connection");
            assert_eq!(
                server.requests().len(),
                if retried { 2 } else { 1 },
                "{mode}"
            );
            if retried {
                assert!(start.elapsed() >= Duration::from_secs(1));
            }
            if mode == "provider-error" {
                // Deliberate security difference: upstream diagnostics can echo credentials.
                assert_eq!(
                    result.message.as_deref(),
                    Some("Embedding service returned an error")
                );
            }
        }
    }
    Ok(())
}

// Deliberate security difference: the reference returns raw fetch/JSON exception
// messages. Fixed Rust errors avoid echoing a credential in an upstream URL/body.
#[tokio::test]
async fn search_status_errors_malformed_timeout_and_caller_drop() -> anyhow::Result<()> {
    for (response, success, error) in [
        (MockResponse::json(429, r#"{"results":[]}"#), true, None),
        (MockResponse::json(500, r#"{"results":[]}"#), true, None),
        (
            MockResponse::json(200, r#"{"error":"unavailable"}"#),
            false,
            Some("Search failed: unavailable"),
        ),
        (
            MockResponse::json(200, "{broken"),
            false,
            Some("Invalid search response"),
        ),
        (
            MockResponse::json(200, VALID).drop_after(2),
            false,
            Some("Invalid search response"),
        ),
        (
            MockResponse::drop_connection(),
            false,
            Some("Search request failed"),
        ),
        (
            MockResponse::new(200).delay(Duration::from_secs(1)),
            false,
            Some("Search request failed"),
        ),
    ] {
        let server = MockServer::start().await?;
        server.push(response);
        let provider = server.provider(
            dima_http::Provider::builder("search", "https://search.myhomelab.wtf")
                .timeout(Duration::from_millis(50)),
        )?;
        let client = dima_ai::search::Client {
            http: HttpClient::builder().build()?,
            provider,
        };
        let result = client.execute("x").await;
        assert_eq!(result.success, success);
        assert_eq!(result.error.as_deref(), error);
        assert_eq!(server.requests().len(), 1);
    }
    // Reference search and embeddings expose no caller signal. Rust futures may be
    // dropped by their owner; cancellation must not initiate a retry afterwards.
    let server = MockServer::start().await?;
    server.push(MockResponse::new(200).delay(Duration::from_secs(10)));
    let provider = server.provider(dima_http::Provider::builder(
        "search",
        "https://search.myhomelab.wtf",
    ))?;
    let client = dima_ai::search::Client {
        http: HttpClient::builder().build()?,
        provider,
    };
    let work = tokio::spawn(async move { client.execute("x").await });
    server.wait_for(1).await;
    work.abort();
    assert!(work.await.unwrap_err().is_cancelled());
    assert_eq!(server.requests().len(), 1);
    Ok(())
}

mod support;
#[tokio::test]
async fn controlled_embedding_retry_schedule_and_caller_drop() -> anyhow::Result<()> {
    for service in [Service::Lfm2, Service::OpenRouter] {
        let server = MockServer::start().await?;
        let times = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture = times.clone();
        server.fallback(move |_| {
            capture.lock().unwrap().push(tokio::time::Instant::now());
            MockResponse::json(429, "{}").header("retry-after", "999")
        });
        let cfg = match service {
            Service::Lfm2 => embeddings::Config::lfm2(),
            Service::OpenRouter => embeddings::Config::openrouter("test-only".into()),
        };
        let attempts = cfg.retries + 1;
        let client = embeddings::Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder(service))?,
            service,
        };
        let result =
            support::virtual_time(client.generate_embedding("x", "m", Kind::Query, Some("c")))
                .await;
        assert!(result.error);
        assert_eq!(server.requests().len(), attempts);
        let times = times.lock().unwrap();
        for (pair, seconds) in times.windows(2).zip([1, 3, 5]) {
            let elapsed = pair[1] - pair[0];
            assert!(elapsed >= Duration::from_secs(seconds));
            assert!(elapsed < Duration::from_millis(seconds * 1000 + 200));
        }
    }
    let server = MockServer::start().await?;
    server.push(MockResponse::new(200).delay(Duration::from_secs(30)));
    let cfg = embeddings::Config::lfm2();
    let client = embeddings::Client {
        http: HttpClient::builder().build()?,
        provider: server.provider(cfg.builder(Service::Lfm2))?,
        service: Service::Lfm2,
    };
    let work =
        tokio::spawn(async move { client.generate_embedding("x", "m", Kind::Query, None).await });
    server.wait_for(1).await;
    work.abort();
    assert!(work.await.unwrap_err().is_cancelled());
    assert_eq!(server.requests().len(), 1);
    Ok(())
}

#[tokio::test]
async fn lfm2_missing_empty_and_invalid_single_vector() -> anyhow::Result<()> {
    for (body, message) in [
        (
            r#"{"data":[]}"#,
            "Empty embedding returned from LFM2 service",
        ),
        (
            r#"{"data":[{}]}"#,
            "Empty embedding returned from LFM2 service",
        ),
        (
            r#"{"data":[{"embedding":null}]}"#,
            "Empty embedding returned from LFM2 service",
        ),
        (r#"{"data":[{"embedding":[]}]}"#, "Invalid embedding shape"),
        (
            r#"{"data":[{"embedding":"bad"}]}"#,
            "Invalid embedding shape",
        ),
    ] {
        let server = MockServer::start().await?;
        server.push(MockResponse::json(200, body));
        let cfg = embeddings::Config::lfm2();
        let client = embeddings::Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder(Service::Lfm2))?,
            service: Service::Lfm2,
        };
        let result = client.generate_embedding("x", "m", Kind::Query, None).await;
        assert!(result.error);
        assert_eq!(result.message.as_deref(), Some(message));
        assert_eq!(result.model.as_deref(), Some("m"));
        assert_eq!(server.requests().len(), 1);
    }
    Ok(())
}

#[tokio::test]
async fn default_embedding_attempt_timeouts_have_no_shared_overall_cutoff() -> anyhow::Result<()> {
    for service in [Service::Lfm2, Service::OpenRouter] {
        let server = MockServer::start().await?;
        let times = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture = times.clone();
        server.fallback(move |_| {
            capture.lock().unwrap().push(tokio::time::Instant::now());
            MockResponse::new(200).delay(Duration::from_secs(1000))
        });
        let cfg = match service {
            Service::Lfm2 => embeddings::Config::lfm2(),
            Service::OpenRouter => embeddings::Config::openrouter("test-only".into()),
        };
        let attempts = cfg.retries + 1;
        let timeout = cfg.timeout;
        let client = embeddings::Client {
            http: HttpClient::builder().build()?,
            provider: server.provider(cfg.builder(service))?,
            service,
        };
        let result =
            support::virtual_time(client.generate_embedding("x", "m", Kind::Query, Some("c")))
                .await;
        assert_eq!(
            result.message.as_deref(),
            Some("Failed to generate embedding")
        );
        assert_eq!(server.requests().len(), attempts);
        for (pair, seconds) in times.lock().unwrap().windows(2).zip([1, 3, 5]) {
            let elapsed = pair[1] - pair[0];
            assert!(elapsed >= timeout + Duration::from_secs(seconds));
            assert!(elapsed < timeout + Duration::from_millis(seconds * 1000 + 200));
        }
    }
    Ok(())
}
