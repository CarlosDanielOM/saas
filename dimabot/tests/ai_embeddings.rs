#![cfg(feature = "ai-embeddings")]
#[path = "../src/utils/test_http.rs"]
mod test_http;
use dima_rust::utils::{
    ai_embedding_language::LanguageDetector,
    ai_embeddings::{ApiKey, DEFAULT_EMBEDDING_MODEL, EmbeddingConfig, EmbeddingService},
    ai_fetch_retry::RetryOptions,
    js_string::JsString,
};
use std::time::Duration;
use test_http::{CannedResponse, Recorder};
fn make_service(url: &str) -> EmbeddingService {
    EmbeddingService::new(EmbeddingConfig {
        endpoint: url.into(),
        api_key: ApiKey::Fixed("fixture-key".into()),
        retry: RetryOptions {
            retries: 0,
            timeout: Duration::from_secs(1),
            ..Default::default()
        },
    })
    .unwrap()
}
#[tokio::test]
async fn source_attribution_single_and_batch_requests() {
    let recorder = Recorder::start(|_| {
        CannedResponse::json(
            200,
            r#"{"data":[{"embedding":[0.1,0.2],"index":1},{"embedding":[0.3],"index":0}],"usage":{"total_tokens":10}}"#,
        )
    });
    let service = make_service(&recorder.base_url);
    let single = service
        .generate_embedding("hello", None, Some("  channel  "))
        .await;
    assert!(!single.error);
    assert_eq!(single.embedding.unwrap(), vec![0.1, 0.2]);
    assert_eq!(single.model.as_deref(), Some(DEFAULT_EMBEDDING_MODEL));
    let req = recorder.next(Duration::from_secs(1));
    assert_eq!(req.header("authorization"), Some("Bearer fixture-key"));
    assert_eq!(req.header("http-referer"), Some("https://domdimabot.com"));
    assert_eq!(req.header("x-openrouter-title"), Some("DomDimaBot"));
    assert_eq!(
        req.header("x-openrouter-description"),
        Some("DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.")
    );
    assert_eq!(
        req.header("x-openrouter-categories"),
        Some("general-chat, roleplay")
    );
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["user"], "  channel  ");
    assert!(body.get("dimensions").is_none());
    let one = service
        .generate_embeddings(&["hello".into()], None, Some("channel"))
        .await;
    assert_eq!(one.embeddings.unwrap(), vec![Some(vec![0.1, 0.2])]);
    let req = recorder.next(Duration::from_secs(1));
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["input"], "hello");
    let many = service
        .generate_embeddings(
            &["a".into(), "b".into()],
            Some("lfm2.5-embedding-350m"),
            Some("channel"),
        )
        .await;
    assert_eq!(
        many.embeddings.unwrap(),
        vec![Some(vec![0.1, 0.2]), Some(vec![0.3])]
    );
    let req = recorder.next(Duration::from_secs(1));
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["input"], serde_json::json!(["a", "b"]));
    assert_eq!(body["dimensions"], 1024);
}
#[tokio::test]
async fn context_and_empty_batch_short_circuit() {
    let service = make_service("http://127.0.0.1:1");
    assert_eq!(
        service
            .generate_embedding("x", None, None)
            .await
            .message
            .as_deref(),
        Some("Channel context required for OpenRouter embeddings")
    );
    assert_eq!(
        service
            .generate_embeddings(&[], None, None)
            .await
            .message
            .as_deref(),
        Some("Channel context required for OpenRouter embeddings")
    );
    assert_eq!(
        service
            .generate_embeddings(&[], None, Some("c"))
            .await
            .message
            .as_deref(),
        Some("No texts provided")
    );
}
#[tokio::test]
async fn error_and_missing_response_fields() {
    let recorder =
        Recorder::start(|_| CannedResponse::json(200, r#"{"error":{"message":"fixture denial"}}"#));
    let service = make_service(&recorder.base_url);
    assert_eq!(
        service
            .generate_embedding("x", None, Some("c"))
            .await
            .message
            .as_deref(),
        Some("fixture denial")
    );
    let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"data":[]}"#));
    let service = make_service(&recorder.base_url);
    assert_eq!(
        service
            .generate_embedding("x", None, Some("c"))
            .await
            .message
            .as_deref(),
        Some("Failed to generate embedding")
    );
    let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"data":[{}]}"#));
    let service = make_service(&recorder.base_url);
    let result = service.generate_embedding("x", None, Some("c")).await;
    assert!(!result.error && result.embedding.is_none());
}
#[test]
fn detector_preserves_global_regex_state() {
    let mut detector = LanguageDetector::default();
    assert_eq!(detector.detect(&JsString::from("the"), 0.1), "english");
    assert_eq!(detector.detect(&JsString::from("the"), 0.1), "unknown");
    assert_eq!(detector.detect(&JsString::from("the"), 0.1), "english");
    assert_eq!(detector.detect(&JsString::from(""), 0.1), "unknown");
}
#[tokio::test]
async fn pooled_client_reuses_one_keep_alive_connection() {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        for _ in 0..2 {
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse::<usize>().unwrap()
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let payload = r#"{"data":[{"embedding":[1]}]}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{}",
                payload.len(),
                payload
            )
            .unwrap();
            socket.flush().unwrap();
        }
    });
    let service = make_service(&url);
    assert!(
        !service
            .generate_embedding("one", None, Some("c"))
            .await
            .error
    );
    assert!(
        !service
            .generate_embedding("two", None, Some("c"))
            .await
            .error
    );
    server.join().unwrap();
}
#[path = "support/sha256.rs"]
mod digest;
fn equal_json(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Number(x), serde_json::Value::Number(y)) => x.as_f64() == y.as_f64(),
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| equal_json(x, y))
        }
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|b| equal_json(v, b)))
        }
        _ => a == b,
    }
}
#[tokio::test]
#[ignore = "requires independently generated actual TypeScript oracle"]
async fn replay_source_language_and_request_cases() {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let file = PathBuf::from(std::env::var("AI_EMBEDDINGS_ORACLE").unwrap());
    assert!(
        file.is_absolute()
            && fs::canonicalize(&file).unwrap() == file
            && !file.starts_with(root.parent().unwrap())
    );
    assert!(fs::symlink_metadata(&file).unwrap().is_file());
    let bytes = fs::read(file).unwrap();
    assert_eq!(
        digest::sha256_hex(&bytes),
        std::env::var("AI_EMBEDDINGS_ORACLE_SHA256").unwrap()
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["schema"], 1);
    assert_eq!(
        fixture["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(fixture["typescript"], "5.9.3");
    let files = [
        "src/utils/ai/openrouter/embeddings.ai.ts",
        "src/utils/ai/fetch.utils.ts",
        "src/utils/ai/constants.ts",
        "src/utils/ai/openrouter/embeddings.ai.rs",
        "src/utils/ai/openrouter/language_detection.rs",
        "src/utils/ai/fetch.utils.rs",
        "src/utils/ai/constants.rs",
        "src/utils/ai/openrouter/app_attribution.util.rs",
        "src/utils/js_unicode.rs",
        "src/utils/js_unicode_data.rs",
        "src/utils/js_string.rs",
        "src/utils/js_compat.rs",
        "src/utils/logger.rs",
        "src/utils/test_http.rs",
        "tests/ai_embeddings.rs",
        "tests/ai_fetch_retry.rs",
        "tests/fixtures/ai_embeddings_reference.cjs",
        "tests/fixtures/openrouter_attribution_source.cjs",
        "tests/support/sha256.rs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
    ];
    assert_eq!(fixture["hashes"].as_object().unwrap().len(), files.len());
    for f in files {
        assert_eq!(
            fixture["hashes"][f].as_str().unwrap(),
            digest::sha256_hex(&fs::read(root.join(f)).unwrap())
        );
    }
    let header = "src/utils/ai/openrouter/app_attribution.util.ts";
    let archived = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28")
        .join(header);
    assert!(fs::symlink_metadata(&archived).unwrap().is_file());
    assert!(
        matches!(fs::symlink_metadata(root.join(header)),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
    );
    assert_eq!(
        fixture["attribution"]["sha256"],
        digest::sha256_hex(&fs::read(archived).unwrap())
    );
    let manifest_path = root
        .parent()
        .unwrap()
        .join("archives/dimabot-typescript/2026-10-28/manifest.json");
    assert!(fs::symlink_metadata(&manifest_path).unwrap().is_file());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let entries = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["source"] == header)
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["sha256"], fixture["attribution"]["sha256"]);
    assert_eq!(
        fixture["exports"],
        serde_json::json!(["detectLanguage", "generateEmbedding", "generateEmbeddings"])
    );
    let interfaces = fixture["interfaces"].as_array().unwrap();
    assert_eq!(
        interfaces
            .iter()
            .map(|v| v["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "IOpenRouterEmbeddingRequest",
            "IOpenRouterEmbeddingResponse",
            "IOpenRouterEmbeddingError",
            "IEmbeddingResult",
            "IBatchEmbeddingResult"
        ]
    );
    assert_eq!(
        fixture["retryDefaults"],
        serde_json::json!({"retries":3,"delays":[1000,3000,5000],"timeout":30000,"retryOn":[429,500,502,503,504]})
    );
    let mut detector = LanguageDetector::default();
    for sequence in fixture["languages"].as_array().unwrap() {
        let input = sequence["input"].as_array().unwrap();
        let output = sequence["output"].as_array().unwrap();
        for (text, expected) in input.iter().zip(output) {
            assert_eq!(
                detector.detect(&JsString::from(text.as_str().unwrap()), 0.1),
                expected.as_str().unwrap()
            );
        }
    }
    let mut detector = LanguageDetector::default();
    let threshold_cases = fixture["thresholdCases"].as_array().unwrap();
    assert_eq!(threshold_cases.len(), 9);
    for case in threshold_cases {
        assert_eq!(
            detector.detect(
                &JsString::from(case["text"].as_str().unwrap()),
                case["threshold"].as_f64().unwrap()
            ),
            case["output"].as_str().unwrap()
        );
    }
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let name = case["name"].as_str().unwrap().to_owned();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let name_for_server = name.clone();
        let recorder = Recorder::start(move |_| {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            let (status, body) = match name_for_server.as_str() {
                "retry" if n == 0 => (500, "fail"),
                "terminal" => (400, "bad"),
                "api-error" => (200, r#"{"error":{"message":"denied"}}"#),
                "missing-data" => (200, r#"{"data":[]}"#),
                "missing-embedding" => (200, r#"{"data":[{}]}"#),
                "rate-exhausted" => (429, "rate"),
                "bad-json" => (200, "{invalid"),
                _ => (
                    200,
                    r#"{"data":[{"embedding":[0.1,0.2],"index":1},{"embedding":[0.3],"index":0}],"usage":{"total_tokens":10}}"#,
                ),
            };
            CannedResponse::json(status, body)
        });
        let service = EmbeddingService::new(EmbeddingConfig {
            endpoint: recorder.base_url.clone(),
            api_key: ApiKey::Fixed("fixture-key".into()),
            retry: RetryOptions {
                retries: 3,
                delays: vec![Duration::ZERO],
                timeout: Duration::from_secs(1),
                ..Default::default()
            },
        })
        .unwrap();
        let value = match name.as_str() {
            "empty" => {
                serde_json::to_value(service.generate_embeddings(&[], None, Some("c")).await)
                    .unwrap()
            }
            "one" => serde_json::to_value(
                service
                    .generate_embeddings(&["x".into()], None, Some("c"))
                    .await,
            )
            .unwrap(),
            "batch" => serde_json::to_value(
                service
                    .generate_embeddings(
                        &["x".into(), "y".into()],
                        Some("lfm2.5-embedding-350m"),
                        Some("c"),
                    )
                    .await,
            )
            .unwrap(),
            _ => serde_json::to_value(
                service
                    .generate_embedding(
                        "x",
                        None,
                        if name == "missing" {
                            None
                        } else if name == "single" {
                            Some(" c ")
                        } else {
                            Some("c")
                        },
                    )
                    .await,
            )
            .unwrap(),
        };
        assert!(
            equal_json(&value, &case["result"]),
            "{name}: native={value} source={}",
            case["result"]
        );
        if name == "retry" {
            assert_eq!(case["sleeps"], serde_json::json!([1000]));
        }
        if name == "rate-exhausted" {
            assert_eq!(case["sleeps"], serde_json::json!([1000, 3000, 5000]));
        }
        let calls = case["calls"].as_array().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), calls.len(), "{name}");
        for expected in calls {
            let req = recorder.next(Duration::from_secs(1));
            let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            assert!(equal_json(&body, &expected["body"]), "{name}");
            assert_eq!(
                req.header("authorization"),
                expected["headers"]["Authorization"].as_str()
            );
            for (header, field) in [
                ("content-type", "Content-Type"),
                ("http-referer", "HTTP-Referer"),
                ("x-openrouter-title", "X-OpenRouter-Title"),
                ("x-openrouter-description", "X-OpenRouter-Description"),
                ("x-openrouter-categories", "X-OpenRouter-Categories"),
            ] {
                assert_eq!(
                    req.header(header),
                    expected["headers"][field].as_str(),
                    "{name}: {header}"
                );
            }
        }
    }
}
#[tokio::test]
async fn terminal_http_error_reads_body_and_logs_once() {
    use dima_rust::utils::logger::{
        ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
        UuidSource,
    };
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Records(Mutex<Vec<String>>);
    impl ConsoleSink for Records {
        fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
            Box::pin(async move {
                self.0.lock().unwrap().push(record.json.to_string());
                Ok(())
            })
        }
    }
    let records = Arc::new(Records::default());
    let logger = Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(records.clone()),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    );
    let recorder = Recorder::start(|_| CannedResponse::json(400, "fixture denial"));
    let service = make_service(&recorder.base_url).with_logger(logger);
    let result = service.generate_embedding("x", None, Some("c")).await;
    assert_eq!(
        result.message.as_deref(),
        Some("OpenRouter API error: 400 Bad Request")
    );
    for _ in 0..100 {
        if !records.0.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let logs = records.0.lock().unwrap();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("OpenRouter embedding API error"));
    assert!(logs[0].contains("fixture denial"));
}
