#![cfg(feature = "moderation-semantic")]
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    moderation::semantic::{SemanticDecision, SemanticProvider, semantic_request},
};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Duration,
};

fn read_request(reader: &mut impl BufRead) -> (String, String) {
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
    (headers, String::from_utf8(bytes).unwrap())
}

type CapturedRequests = Vec<(String, String)>;
type HttpFixture = (
    String,
    mpsc::Receiver<CapturedRequests>,
    thread::JoinHandle<()>,
);

fn fixture(responses: Vec<(u16, Vec<u8>)>) -> HttpFixture {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let task = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut captures = Vec::new();
        for (status, body) in responses {
            let (headers, request_body) = read_request(&mut reader);
            captures.push((headers, request_body));
            write!(
                socket,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
            socket.flush().unwrap();
        }
        tx.send(captures).unwrap();
    });
    (format!("http://{address}/api/alpha/decisions"), rx, task)
}
#[tokio::test]
async fn wire_pool_preflight_bom_and_model_selection() {
    let response = b"\xef\xbb\xbf{\"answers\":{\"violation\":{\"type\":\"noul\",\"noul\":0.9}},\"usage\":{\"input_tokens\":2,\"cost\":0},\"model\":\"returned\",\"id\":\"\"}".to_vec();
    let (endpoint, rx, task) = fixture(vec![(200, response.clone()), (200, response)]);
    let provider =
        SemanticProvider::new(reqwest::Client::new(), endpoint, Some("fixture-key".into()));
    assert!(!format!("{provider:?}").contains("fixture-key"));
    let sem = parse_json(r#"{"policy":"p","examples":[]}"#).unwrap();
    let id: JsString = "r".into();
    let text: JsString = "hello".into();
    let user: JsString = "name".into();
    let channel: JsString = " channel ".into();
    let decision = SemanticDecision {
        rule_id: &id,
        semantic: Some(&sem),
        message_text: &text,
        username: &user,
        context: &[],
        matches: &[],
        channel_id: Some(&channel),
        deadline_ms: 5000.0,
    };
    for _ in 0..2 {
        let result = provider.evaluate_at(&decision, None, 0.0).await.unwrap();
        assert_eq!(result.verdict, "violation");
        assert_eq!(result.model.as_str(), Some("respan/span-01-lite"));
    }
    let captures = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    task.join().unwrap();
    let mut expected = semantic_request(&decision, None).unwrap();
    if let JsonValue::Object(ref mut fields) = expected {
        fields.push(("user".into(), JsonValue::String(channel.clone())));
    }
    for (headers, body) in captures {
        let headers = headers.to_ascii_lowercase();
        assert!(headers.contains("authorization: bearer fixture-key\r\n"));
        assert!(headers.contains("http-referer: https://domdimabot.com\r\n"));
        assert_eq!(body, expected.to_json_string());
    }
    let mut missing = decision;
    missing.semantic = None;
    assert!(provider.evaluate_at(&missing, None, 9999.0).await.is_err());
}
#[tokio::test]
async fn http_and_deadline_fallbacks() {
    let id: JsString = "r".into();
    let text: JsString = "x".into();
    let channel: JsString = "c".into();
    let sem = parse_json(r#"{"policy":"p","examples":[]}"#).unwrap();
    let decision = SemanticDecision {
        rule_id: &id,
        semantic: Some(&sem),
        message_text: &text,
        username: &text,
        context: &[],
        matches: &[],
        channel_id: Some(&channel),
        deadline_ms: 1000.0,
    };
    for (status, body, expected) in [
        (429, b"ignored".to_vec(), "rate_limited"),
        (500, b"ignored".to_vec(), "unavailable"),
        (200, b"{".to_vec(), "unavailable"),
    ] {
        let (endpoint, rx, task) = fixture(vec![(status, body)]);
        let provider = SemanticProvider::new(reqwest::Client::new(), endpoint, Some("x".into()));
        assert_eq!(
            provider
                .evaluate_at(&decision, None, 0.0)
                .await
                .unwrap()
                .status
                .as_str(),
            Some(expected)
        );
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        task.join().unwrap();
    }
    let provider = SemanticProvider::new(
        reqwest::Client::new(),
        "http://127.0.0.1:1",
        Some("x".into()),
    );
    assert_eq!(
        provider
            .evaluate_at(&decision, None, 1000.0)
            .await
            .unwrap()
            .status
            .as_str(),
        Some("timeout")
    );
    assert_eq!(
        provider
            .evaluate_at(&decision, None, 0.5)
            .await
            .unwrap()
            .status
            .as_str(),
        Some("unavailable")
    );
}
#[tokio::test]
async fn deadline_covers_held_headers_and_body_and_future_drop() {
    for mode in 0..3 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            // Receive the complete request before sending a partial response;
            // an unsolicited early response is a distinct HTTP protocol error.
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            assert!(read_request(&mut reader).0.starts_with("POST /"));
            if mode == 1 {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                    .unwrap();
                socket.flush().unwrap();
            }
            ready_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let peer = socket.peek(&mut [0; 1]);
            let closed = match &peer {
                Ok(0) => true,
                Err(error) => matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ),
                _ => false,
            };
            assert!(
                closed,
                "HTTP connection remained open after cancellation, mode {mode}: {peer:?}"
            );
        });
        let sem = parse_json(r#"{"policy":"p","examples":[]}"#).unwrap();
        let id: JsString = "r".into();
        let msg: JsString = "m".into();
        let decision = SemanticDecision {
            rule_id: &id,
            semantic: Some(&sem),
            message_text: &msg,
            username: &msg,
            context: &[],
            matches: &[],
            channel_id: Some(&msg),
            deadline_ms: if mode == 2 { 5000.0 } else { 100.0 },
        };
        let provider = SemanticProvider::new(
            reqwest::Client::new(),
            format!("http://{address}"),
            Some("x".into()),
        );
        if mode == 2 {
            let outcome = tokio::time::timeout(
                Duration::from_millis(100),
                provider.evaluate_at(&decision, None, 0.0),
            )
            .await;
            assert!(outcome.is_err()); // Dropping the future cancels the I/O.
        } else {
            assert_eq!(
                provider
                    .evaluate_at(&decision, None, 0.0)
                    .await
                    .unwrap()
                    .status
                    .as_str(),
                Some("timeout"),
                "held HTTP fixture mode {mode}"
            );
        }
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        release_tx.send(()).unwrap();
        tokio::task::spawn_blocking(move || worker.join().unwrap())
            .await
            .unwrap();
    }
}
