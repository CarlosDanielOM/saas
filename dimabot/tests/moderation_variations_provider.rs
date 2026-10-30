#![cfg(feature = "moderation-variations-provider")]
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    moderation::variations_provider::{MuseError, MuseVariationsProvider, muse_variation_request},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Duration,
};
use tokio::sync::watch;

fn source_fixture() -> serde_json::Value {
    use sha2::{Digest, Sha256};
    let path = std::env::var("DIMA_VARIATIONS_REFERENCE").expect("external source fixture");
    let expected = std::env::var("DIMA_VARIATIONS_REFERENCE_SHA256").expect("independent SHA-256");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["transport"].as_array().unwrap().len(), 15);
    fixture
}

fn terms() -> Vec<JsString> {
    vec!["cat".into()]
}
fn response(content: &str) -> String {
    format!(
        "{{\"choices\":[{{\"finish_reason\":\"stop\",\"message\":{{\"content\":{}}}}}],\"model\":[],\"usage\":{{\"extra\":\"\\ud800\"}}}}",
        JsonValue::String(content.into()).to_json_string()
    )
}
type FixtureServer = (
    String,
    mpsc::Receiver<Vec<(String, String)>>,
    thread::JoinHandle<()>,
);
fn server(replies: Vec<(u16, String)>) -> FixtureServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let task = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut requests = Vec::new();
        for (status, body) in replies {
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                headers.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .map(|(_, v)| v.trim().parse().unwrap())
                })
                .unwrap();
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            requests.push((headers, String::from_utf8(bytes).unwrap()));
            write!(socket, "HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n{body}", body.len()).unwrap();
            socket.flush().unwrap();
        }
        tx.send(requests).unwrap();
    });
    (format!("http://{address}/completions"), rx, task)
}
#[tokio::test]
async fn wire_pool_headers_lossless_and_preconditions() {
    let body = response(r#"{"entries":[{"term":"cat","spellings":["ct"]}]}"#);
    let (endpoint, rx, task) = server(vec![(200, body.clone()), (200, body)]);
    let provider =
        MuseVariationsProvider::new(reqwest::Client::new(), endpoint, Some("fixture-key".into()));
    let (_stop, cancel) = watch::channel(false);
    for _ in 0..2 {
        let result = provider
            .generate(&terms(), &"chan".into(), cancel.clone())
            .await
            .unwrap();
        assert_eq!(result.entries[0].term, JsString::from("cat"));
        assert_eq!(result.model, JsonValue::Array(vec![]));
        assert_eq!(
            result.usage.get("extra"),
            Some(&JsonValue::String(JsString::from_units(vec![0xd800])))
        );
    }
    let captures = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    task.join().unwrap();
    assert_eq!(captures.len(), 2);
    for (headers, body) in captures {
        let headers = headers.to_ascii_lowercase();
        assert!(headers.contains("authorization: bearer fixture-key\r\n"));
        assert!(headers.contains("http-referer: https://domdimabot.com\r\n"));
        assert!(headers.contains("x-openrouter-title: domdimabot\r\n"));
        assert!(headers.contains("content-type: application/json\r\n"));
        let parsed = parse_json(&body).unwrap();
        assert_eq!(parsed.get("user"), Some(&JsonValue::String("chan".into())));
        let mut expected = muse_variation_request(&terms());
        if let JsonValue::Object(ref mut fields) = expected {
            fields.push(("user".into(), JsonValue::String("chan".into())));
        }
        assert_eq!(body, expected.to_json_string());
    }
    let missing = MuseVariationsProvider::new(reqwest::Client::new(), "http://127.0.0.1:1", None);
    assert!(matches!(
        missing
            .generate(&terms(), &" ".into(), cancel.clone())
            .await,
        Err(MuseError::ChannelContextRequired)
    ));
    assert!(matches!(
        missing.generate(&terms(), &"chan".into(), cancel).await,
        Err(MuseError::GenerationUnavailable)
    ));
}
#[tokio::test]
async fn errors_and_cancellation() {
    for (status, body, expected) in [
        (500, "oops".to_string(), "generation_unavailable"),
        (200, "{".to_string(), "json"),
        (200, response("{"), "json"),
        (200, response(r#"{"entries":[]}"#), "invalid_generation"),
        (
            200,
            response(r#"{"entries":[{"term":"cat","spellings":["dog"]}]}"#),
            "Generated spelling is too far from its blocked word",
        ),
    ] {
        let (endpoint, rx, task) = server(vec![(status, body)]);
        let provider =
            MuseVariationsProvider::new(reqwest::Client::new(), endpoint, Some("x".into()));
        let (_tx, cancel) = watch::channel(false);
        let err = provider
            .generate(&terms(), &"chan".into(), cancel)
            .await
            .unwrap_err();
        if expected == "json" {
            assert!(matches!(err, MuseError::Json(_)));
        } else {
            assert_eq!(err.to_string(), expected);
        }
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        task.join().unwrap();
    }
    let (_tx, cancelled) = watch::channel(true);
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        "http://127.0.0.1:1",
        Some("x".into()),
    );
    assert!(matches!(
        provider.generate(&terms(), &"chan".into(), cancelled).await,
        Err(MuseError::Cancelled)
    ));
    // Signal while waiting for response headers; no external traffic.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let peer = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        ready_tx.send(()).unwrap();
        let mut rest = [0; 4096];
        while stream.read(&mut rest).unwrap_or(0) != 0 {}
    });
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        format!("http://{address}"),
        Some("x".into()),
    );
    let (stop, cancel) = watch::channel(false);
    let handle =
        tokio::spawn(async move { provider.generate(&terms(), &"chan".into(), cancel).await });
    tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(10)).unwrap())
        .await
        .unwrap();
    stop.send(true).unwrap();
    assert!(matches!(handle.await.unwrap(), Err(MuseError::Cancelled)));
    peer.join().unwrap();
}

// The parent produces this independently pinned oracle in an isolated container.
#[test]
#[ignore = "requires independently generated actual TypeScript oracle"]
fn request_replays_source_fixture() {
    let fixture = source_fixture();
    for (id, terms) in [
        ("request-empty", vec![]),
        (
            "request-terms",
            vec![
                JsString::from("cat"),
                JsString::from("é"),
                JsString::from_units(vec![0xd800]),
            ],
        ),
    ] {
        let case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        let units: Vec<u16> = case["result"]["wire"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();
        assert_eq!(
            muse_variation_request(&terms)
                .to_json_string()
                .encode_utf16()
                .collect::<Vec<_>>(),
            units
        );
    }
}

// Replay the source transport cases through a real loopback HTTP connection.
#[tokio::test]
#[ignore = "requires independently generated actual TypeScript oracle"]
async fn transport_replays_source_fixture() {
    let fixture = source_fixture();
    let cases = [
        (
            "success",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"entries\":[{\"term\":\"cat\",\"spellings\":[\"ct\"]}]}"}}],"model":"mock-model","usage":{"prompt_tokens":3,"completion_tokens":4,"cost":0.25}}"#,
        ),
        (
            "default-model-usage",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"entries\":[{\"term\":\"cat\",\"spellings\":[]}]}"}}]}"#,
        ),
        (
            "nonstop",
            r#"{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}"#,
        ),
        (
            "missing-content",
            r#"{"choices":[{"finish_reason":"stop","message":{}}]}"#,
        ),
        (
            "missing-entries",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}"#,
        ),
        (
            "missing-term",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"entries\":[{\"term\":\"dog\",\"spellings\":[]}]}"}}]}"#,
        ),
        (
            "invalid-spelling",
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"entries\":[{\"term\":\"cat\",\"spellings\":[\"dog\"]}]}"}}]}"#,
        ),
    ];
    for (id, raw) in cases {
        let source = fixture["transport"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        let (endpoint, rx, task) = server(vec![(200, raw.to_owned())]);
        let provider = MuseVariationsProvider::new(
            reqwest::Client::new(),
            endpoint,
            Some("fixture-key".into()),
        );
        let (_tx, cancel) = watch::channel(false);
        match provider.generate(&terms(), &"chan".into(), cancel).await {
            Ok(result) => {
                let entries = result
                    .entries
                    .into_iter()
                    .map(|e| {
                        JsonValue::Object(vec![
                            ("term".into(), JsonValue::String(e.term)),
                            (
                                "spellings".into(),
                                JsonValue::Array(
                                    e.spellings.into_iter().map(JsonValue::String).collect(),
                                ),
                            ),
                            (
                                "pattern".into(),
                                JsonValue::Object(vec![
                                    ("id".into(), JsonValue::String(e.pattern.id)),
                                    ("source".into(), JsonValue::String(e.pattern.source)),
                                    ("boundary".into(), JsonValue::String("whole_word".into())),
                                    ("ignoreCase".into(), JsonValue::Bool(e.pattern.ignore_case)),
                                ]),
                            ),
                            ("version".into(), JsonValue::String(e.version)),
                        ])
                    })
                    .collect();
                let actual = JsonValue::Object(vec![
                    ("entries".into(), JsonValue::Array(entries)),
                    ("model".into(), result.model),
                    ("usage".into(), result.usage),
                ])
                .to_json_string()
                .encode_utf16()
                .collect::<Vec<_>>();
                let expected = source["result"]["wire"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "{id}");
            }
            Err(error) => {
                let expected = source["result"]["message"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>();
                assert_eq!(
                    error.to_string().encode_utf16().collect::<Vec<_>>(),
                    expected,
                    "{id}"
                );
            }
        }
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        task.join().unwrap();
    }
}

#[tokio::test]
async fn cancellation_during_response_body_and_transport_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let peer = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            headers.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .map(|(_, v)| v.trim().parse().unwrap())
            })
            .unwrap();
        let mut request = vec![0; length];
        reader.read_exact(&mut request).unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{").unwrap();
        socket.flush().unwrap();
        ready_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    });
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        format!("http://{address}"),
        Some("x".into()),
    );
    let (stop, cancel) = watch::channel(false);
    let handle =
        tokio::spawn(async move { provider.generate(&terms(), &"chan".into(), cancel).await });
    tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(10)).unwrap())
        .await
        .unwrap();
    stop.send(true).unwrap();
    assert!(matches!(handle.await.unwrap(), Err(MuseError::Cancelled)));
    release_tx.send(()).unwrap();
    peer.join().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        format!("http://{address}"),
        Some("x".into()),
    );
    let (_stop, cancel) = watch::channel(false);
    assert!(matches!(
        provider.generate(&terms(), &"chan".into(), cancel).await,
        Err(MuseError::Transport(_))
    ));
}

#[tokio::test]
#[ignore = "requires independently generated actual TypeScript oracle"]
async fn remaining_transport_source_cases() {
    let fixture = source_fixture();
    let source = |id: &str| {
        fixture["transport"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .unwrap()
    };
    let compare_message = |id: &str, error: MuseError| {
        let expected = source(id)["result"]["message"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect::<Vec<_>>();
        assert_eq!(
            error.to_string().encode_utf16().collect::<Vec<_>>(),
            expected,
            "{id}"
        );
    };
    let (_stop, cancel) = watch::channel(false);
    let provider = MuseVariationsProvider::new(reqwest::Client::new(), "http://127.0.0.1:1", None);
    compare_message(
        "no-channel",
        provider
            .generate(&terms(), &" ".into(), cancel.clone())
            .await
            .unwrap_err(),
    );
    compare_message(
        "no-key",
        provider
            .generate(&terms(), &"chan".into(), cancel.clone())
            .await
            .unwrap_err(),
    );
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        "http://127.0.0.1:1",
        Some("fixture-key".into()),
    );
    let (_stop, aborted) = watch::channel(true);
    let err = provider
        .generate(&terms(), &"chan".into(), aborted)
        .await
        .unwrap_err();
    compare_message("cancel", err);
    let cases = [
        ("http-error", 503, "{}"),
        ("json-error", 200, "{"),
        (
            "malformed",
            200,
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{"}}]}"#,
        ),
        (
            "duplicate",
            200,
            r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"entries\":[{\"term\":\"cat\",\"spellings\":[]},{\"term\":\"cat\",\"spellings\":[]}]}"}}]}"#,
        ),
    ];
    for (id, status, body) in cases {
        let (endpoint, rx, task) = server(vec![(status, body.to_owned())]);
        let provider = MuseVariationsProvider::new(
            reqwest::Client::new(),
            endpoint,
            Some("fixture-key".into()),
        );
        let input = if id == "duplicate" {
            vec!["cat".into(), "dog".into()]
        } else {
            terms()
        };
        let err = provider
            .generate(&input, &"chan".into(), cancel.clone())
            .await
            .unwrap_err();
        if id == "json-error" || id == "malformed" {
            assert!(matches!(err, MuseError::Json(_)));
            assert_eq!(source(id)["result"]["ok"], false);
        } else {
            compare_message(id, err);
        }
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        task.join().unwrap();
    }
    // Source stub rejects with an arbitrary Error; a real connection refusal is
    // a reqwest transport error, whose provider-specific message is not portable.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let provider = MuseVariationsProvider::new(
        reqwest::Client::new(),
        format!("http://{address}"),
        Some("fixture-key".into()),
    );
    assert!(matches!(
        provider.generate(&terms(), &"chan".into(), cancel).await,
        Err(MuseError::Transport(_))
    ));
    assert_eq!(source("fetch-error")["result"]["ok"], false);
}
