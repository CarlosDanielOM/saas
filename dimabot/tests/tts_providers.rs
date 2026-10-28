#![cfg(feature = "tts-services")]

use dima_rust::{
    tts_services::{
        fish_tts::{FishConfig, FishTtsService},
        speech_paths::SpeechPaths,
        tts_provider::{TtsMode, TtsSynthesisRequest, TtsSynthesisResult},
    },
    utils::{
        js_string::JsString,
        tts::{TtsLanguage, TtsProvider},
    },
};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
const WAIT: Duration = Duration::from_secs(2);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "fish-tts-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("create task-owned fixture directory");
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
struct Received {
    request_line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
async fn read_request(socket: &mut TcpStream) -> Received {
    let mut data = Vec::new();
    let (end, length) = loop {
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&data[..pos]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            break (pos + 4, length);
        }
        let mut buf = [0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "request headers ended early");
        data.extend_from_slice(&buf[..n]);
    };
    while data.len() < end + length {
        let mut buf = [0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "request body ended early");
        data.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8(data[..end].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Received {
        request_line,
        headers,
        body: data[end..end + length].to_vec(),
    }
}

enum Reply {
    Bytes(Vec<u8>),
    HoldHeaders,
    HoldBody(Vec<u8>),
    Backoff(Vec<u8>),
}
struct Server {
    url: String,
    received: mpsc::UnboundedReceiver<Received>,
    task: JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
}
impl Server {
    async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/speech", listener.local_addr().unwrap());
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let (tx, received) = mpsc::unbounded_channel();
        let (shutdown, mut shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let reply = replies.lock().unwrap().pop_front();
                let tx = tx.clone();
                children.spawn(async move {
                    let request = read_request(&mut socket).await;
                    match reply {
                        Some(Reply::Bytes(bytes)) => {
                            let _ = socket.write_all(&bytes).await;
                            let _ = tx.send(request);
                        }
                        Some(Reply::HoldBody(bytes)) => {
                            let _ = socket.write_all(&bytes).await;
                            let _ = tx.send(request);
                            std::future::pending::<()>().await;
                        }
                        Some(Reply::Backoff(bytes)) => {
                            socket.write_all(&bytes).await.unwrap();
                            socket.shutdown().await.unwrap();
                            let mut byte = [0u8; 1];
                            let n = timeout(Duration::from_millis(700), socket.read(&mut byte))
                                .await
                                .expect("client did not consume retry response")
                                .unwrap();
                            assert_eq!(n, 0);
                            let _ = tx.send(request);
                        }
                        Some(Reply::HoldHeaders) | None => {
                            let _ = tx.send(request);
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
            children.abort_all();
            while children.join_next().await.is_some() {}
        });
        Self {
            url,
            received,
            task,
            shutdown: Some(shutdown),
        }
    }
    async fn next(&mut self) -> Received {
        timeout(WAIT, self.received.recv())
            .await
            .expect("fixture request timed out")
            .expect("fixture stopped")
    }
    async fn no_more(&mut self) {
        assert!(
            timeout(Duration::from_millis(75), self.received.recv())
                .await
                .is_err(),
            "unexpected extra HTTP request"
        );
    }
    async fn stop(mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        timeout(WAIT, &mut self.task)
            .await
            .expect("fixture shutdown timed out")
            .expect("fixture server failed");
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn response(status: &str, headers: &str, body: &[u8]) -> Reply {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    Reply::Bytes(bytes)
}
fn ok(body: &[u8]) -> Reply {
    response("200 OK", "Content-Type: audio/mpeg\r\n", body)
}
fn request(dir: &Path) -> TtsSynthesisRequest {
    TtsSynthesisRequest {
        channel_id: "channel 1".into(),
        speech_id: "id+1".into(),
        mode: TtsMode::Speak,
        provider: TtsProvider::Fish,
        model: None,
        text: JsString::from("[happy] Hi"),
        language: TtsLanguage::En,
        voice: " voice ".into(),
        output_path: dir.join("private.mp3"),
        clone_name: None,
        private_output: false,
        signal: None,
        max_audio_bytes: None,
        single_attempt: true,
    }
}
fn config(dir: &Path, primary: Option<&str>, fish: Option<&str>) -> FishConfig {
    FishConfig::new(
        SpeechPaths::new(dir.to_path_buf(), Some("https://example.test/"), false),
        primary.map(str::to_owned),
        fish.map(str::to_owned),
    )
}
fn failed(result: &TtsSynthesisResult) {
    assert!(result.error, "unexpected success: {result:?}");
    assert_eq!(result.output_path, None);
    assert_eq!(result.public_path, None);
    assert_eq!(result.mime_type, None);
}
fn target(dir: &Path) -> PathBuf {
    dir.join("channel 1/id+1.mp3")
}
async fn synth(service: &FishTtsService, request: &TtsSynthesisRequest) -> TtsSynthesisResult {
    timeout(WAIT, service.synthesize(request))
        .await
        .expect("synthesis exceeded fixture timeout")
}

// Decode the SDK's documented map shape, independently of the encoder's byte layout.
fn msgpack_map(bytes: &[u8]) -> BTreeMap<String, String> {
    fn string(bytes: &[u8], pos: &mut usize) -> String {
        let tag = bytes[*pos];
        *pos += 1;
        let n = match tag {
            0xa0..=0xbf => (tag & 31) as usize,
            0xd9 => {
                let n = bytes[*pos] as usize;
                *pos += 1;
                n
            }
            0xda => {
                let n = u16::from_be_bytes([bytes[*pos], bytes[*pos + 1]]) as usize;
                *pos += 2;
                n
            }
            0xdb => {
                let n = u32::from_be_bytes(bytes[*pos..*pos + 4].try_into().unwrap()) as usize;
                *pos += 4;
                n
            }
            _ => panic!("expected MessagePack string, got {tag:#x}"),
        };
        let s = String::from_utf8(bytes[*pos..*pos + n].to_vec()).unwrap();
        *pos += n;
        s
    }
    let count = match bytes[0] {
        0x80..=0x8f => (bytes[0] & 15) as usize,
        n => panic!("expected map, got {n:#x}"),
    };
    let mut pos = 1;
    let mut result = BTreeMap::new();
    for _ in 0..count {
        let key = string(bytes, &mut pos);
        let value = string(bytes, &mut pos);
        result.insert(key, value);
    }
    assert_eq!(pos, bytes.len());
    result
}

#[tokio::test]
async fn primary_wire_contract_and_public_file() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![ok(b"abc")]).await;
    let mut cfg = config(dir.path(), Some(" fixture-key "), None);
    cfg.openrouter_url = server.url.clone();
    assert_eq!(cfg.attempt_timeout, Duration::from_secs(20));
    let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
    assert!(!result.error, "{}", result.message);
    assert_eq!(
        result.message,
        "Speech synthesized with Fish Audio (fish-audio/drama-3)"
    );
    assert_eq!(result.output_path.as_ref(), Some(&target(dir.path())));
    assert_eq!(
        result.public_path.as_deref(),
        Some("https://example.test/speech/audio/channel%201/id%2B1")
    );
    assert_eq!(result.mime_type, Some("audio/mpeg"));
    assert_eq!(std::fs::read(target(dir.path())).unwrap(), b"abc");
    let sent = server.next().await;
    assert_eq!(sent.request_line, "POST /speech HTTP/1.1");
    for (key, value) in [
        ("authorization", "Bearer fixture-key"),
        ("content-type", "application/json"),
        ("http-referer", "https://domdimabot.com"),
        ("x-openrouter-title", "DomDimaBot"),
        (
            "x-openrouter-description",
            "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
        ),
        ("x-openrouter-categories", "general-chat, roleplay"),
    ] {
        assert_eq!(sent.headers.get(key).map(String::as_str), Some(value));
    }
    let body: serde_json::Value = serde_json::from_slice(&sent.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"model":"fish-audio/drama-3", "input":"[happy] Hi", "voice":"voice", "response_format":"mp3", "user":"channel 1"})
    );
    server.stop().await;
}

#[tokio::test]
async fn fallback_direct_contract_and_private_file() {
    let dir = TempDir::new();
    let mut primary = Server::start(vec![response("503 Service Unavailable", "", b"")]).await;
    let mut direct = Server::start(vec![response(
        "200 OK",
        "Content-Type: application/octet-stream\r\n",
        b"xyz",
    )])
    .await;
    let mut cfg = config(dir.path(), Some("primary"), Some(" fish-key "));
    cfg.openrouter_url = primary.url.clone();
    cfg.fish_url = direct.url.clone();
    let mut req = request(dir.path());
    req.single_attempt = false;
    req.private_output = true;
    let result = synth(&FishTtsService::new(cfg), &req).await;
    assert!(!result.error, "{}", result.message);
    assert_eq!(
        result.message,
        "Speech synthesized with Fish Audio (s2.1-pro)"
    );
    assert_eq!(result.output_path.as_ref(), Some(&req.output_path));
    assert_eq!(result.public_path, None);
    assert_eq!(result.mime_type, Some("audio/mpeg"));
    assert_eq!(std::fs::read(&req.output_path).unwrap(), b"xyz");
    assert!(!target(dir.path()).exists());
    let first = primary.next().await;
    let first_json: serde_json::Value = serde_json::from_slice(&first.body).unwrap();
    assert_eq!(first_json["input"], "[happy] Hi");
    let sent = direct.next().await;
    for (key, value) in [
        ("authorization", "Bearer fish-key"),
        ("content-type", "application/msgpack"),
        ("model", "s2.1-pro"),
        ("user-agent", "fish-audio"),
    ] {
        assert_eq!(sent.headers.get(key).map(String::as_str), Some(value));
    }
    let expected = [
        ("text".into(), "[happy] [happy] Hi".into()),
        ("reference_id".into(), "voice".into()),
        ("format".into(), "mp3".into()),
    ]
    .into_iter()
    .collect();
    assert_eq!(msgpack_map(&sent.body), expected);
    direct.no_more().await;
    primary.no_more().await;
    primary.stop().await;
    direct.stop().await;
}

#[tokio::test]
async fn missing_keys_and_single_attempt_do_not_call_fallback() {
    let dir = TempDir::new();
    let mut direct = Server::start(vec![]).await;
    for key in [None, Some(""), Some(" \t\n ")] {
        let mut cfg = config(dir.path(), key, Some("fish"));
        cfg.fish_url = direct.url.clone();
        let req = request(dir.path());
        let result = synth(&FishTtsService::new(cfg), &req).await;
        failed(&result);
        assert!(
            result
                .message
                .contains("fish-audio/drama-3: OpenRouter API key is not configured")
        );
        assert!(!target(dir.path()).exists());
    }
    let mut cfg = config(dir.path(), None, Some(" \t "));
    cfg.fish_url = direct.url.clone();
    let mut req = request(dir.path());
    req.single_attempt = false;
    let result = synth(&FishTtsService::new(cfg), &req).await;
    failed(&result);
    assert!(
        result
            .message
            .contains("s2.1-pro: Fish Audio API key is not configured")
    );
    direct.no_more().await;
    direct.stop().await;
}

#[tokio::test]
async fn primary_rejections_do_not_write_files() {
    for (reply, message) in [
        (
            response("503 Service Unavailable", "", b"error"),
            "OpenRouter Fish synthesis failed (HTTP 503)",
        ),
        (
            response("200 OK", "Content-Type: text/plain\r\n", b"abc"),
            "OpenRouter Fish returned an unexpected audio format",
        ),
        (
            response("204 No Content", "Content-Type: audio/mpeg\r\n", b""),
            "OpenRouter Fish returned an unexpected audio format",
        ),
        (
            response("205 Reset Content", "Content-Type: audio/mpeg\r\n", b""),
            "OpenRouter Fish returned an unexpected audio format",
        ),
        (
            ok(b""),
            "Fish Audio TTS returned empty audio from 'fish-audio/drama-3'",
        ),
    ] {
        let dir = TempDir::new();
        let mut server = Server::start(vec![reply]).await;
        let mut cfg = config(dir.path(), Some("fixture"), None);
        cfg.openrouter_url = server.url.clone();
        let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
        failed(&result);
        assert!(result.message.contains(message), "{}", result.message);
        assert!(!target(dir.path()).exists());
        server.next().await;
        server.stop().await;
    }
}

#[tokio::test]
async fn direct_422_exposes_sdk_error_and_does_not_retry() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![response(
        "422 Unprocessable Entity",
        "Content-Type: application/json\r\n",
        br#"{"detail":"invalid voice"}"#,
    )])
    .await;
    let mut cfg = config(dir.path(), None, Some("fixture"));
    cfg.fish_url = server.url.clone();
    let mut req = request(dir.path());
    req.single_attempt = false;
    let result = synth(&FishTtsService::new(cfg), &req).await;
    failed(&result);
    assert!(
        result
            .message
            .contains("s2.1-pro: UnprocessableEntityError\nStatus code: 422"),
        "{}",
        result.message
    );
    assert!(result.message.contains("invalid voice"));
    assert!(!target(dir.path()).exists());
    server.next().await;
    server.no_more().await;
    server.stop().await;
}

#[tokio::test]
async fn deadline_covers_held_headers_and_body() {
    for reply in [
        Reply::HoldHeaders,
        Reply::HoldBody(
            b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 3\r\n\r\na".to_vec(),
        ),
    ] {
        let dir = TempDir::new();
        let mut server = Server::start(vec![reply]).await;
        let mut cfg = config(dir.path(), Some("fixture"), None);
        cfg.openrouter_url = server.url.clone();
        cfg.attempt_timeout = Duration::from_millis(100);
        let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
        failed(&result);
        assert!(
            result.message.contains("Fish Audio TTS timed out"),
            "{}",
            result.message
        );
        assert!(!target(dir.path()).exists());
        server.next().await;
        server.stop().await;
    }
}

#[tokio::test]
async fn pre_abort_and_abort_during_headers_body_or_backoff_stop_requests() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![]).await;
    let mut cfg = config(dir.path(), Some("fixture"), Some("fixture"));
    cfg.openrouter_url = server.url.clone();
    cfg.fish_url = server.url.clone();
    let (tx, rx) = watch::channel(Some("cancelled".to_owned()));
    let mut req = request(dir.path());
    req.signal = Some(rx);
    req.single_attempt = false;
    let result = synth(&FishTtsService::new(cfg), &req).await;
    failed(&result);
    assert_eq!(result.message, "cancelled");
    assert!(!dir.path().join("channel 1").exists());
    drop(tx);
    server.no_more().await;
    server.stop().await;
    for (reply, direct) in [(Reply::HoldHeaders, false), (Reply::HoldBody(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 3\r\n\r\na".to_vec()), false), (Reply::Backoff(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()), true)] {
        let dir = TempDir::new(); let mut server = Server::start(vec![reply]).await;
        let mut cfg = config(dir.path(), if direct { None } else { Some("fixture") }, Some("fixture")); cfg.openrouter_url = server.url.clone(); cfg.fish_url = server.url.clone(); cfg.attempt_timeout = Duration::from_millis(1200);
        let (tx, rx) = watch::channel(None); let mut req = request(dir.path()); req.single_attempt = false; req.signal = Some(rx);
        let service = FishTtsService::new(cfg);
        let job = tokio::spawn(async move { service.synthesize(&req).await });
        server.next().await; tx.send(Some("cancelled".into())).unwrap();
        let result = timeout(WAIT, job).await.unwrap().unwrap(); failed(&result); assert!(result.message.contains("Fish Audio TTS timed out"), "{}", result.message); assert!(!target(dir.path()).exists());
        if direct { assert!(timeout(Duration::from_millis(1100), server.received.recv()).await.is_err(), "retry occurred after cancellation"); }
        else { server.no_more().await; }
        server.stop().await;
    }
}

#[tokio::test]
async fn exact_limit_and_chunk_crossing_limit() {
    for (limit, success) in [(3, true), (2, false)] {
        let dir = TempDir::new();
        let mut server = Server::start(vec![Reply::Bytes(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n".to_vec())]).await;
        let mut cfg = config(dir.path(), Some("fixture"), None);
        cfg.openrouter_url = server.url.clone();
        let mut req = request(dir.path());
        req.max_audio_bytes = Some(limit);
        let result = synth(&FishTtsService::new(cfg), &req).await;
        if success {
            assert!(!result.error, "{}", result.message);
            assert_eq!(std::fs::read(target(dir.path())).unwrap(), b"abc");
        } else {
            failed(&result);
            assert!(result.message.contains("TTS audio exceeds byte limit"));
            assert!(!target(dir.path()).exists());
        }
        server.next().await;
        server.stop().await;
    }
}

#[tokio::test]
async fn truncated_and_invalid_chunked_bodies_fail_without_overwrite() {
    for bytes in [b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 5\r\nConnection: close\r\n\r\nab".as_slice(), b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nQ\r\nabc\r\n".as_slice()] {
        let dir = TempDir::new(); std::fs::create_dir(dir.path().join("channel 1")).unwrap(); std::fs::write(target(dir.path()), b"old").unwrap();
        let mut server = Server::start(vec![Reply::Bytes(bytes.to_vec())]).await;
        let mut cfg = config(dir.path(), Some("fixture"), None); cfg.openrouter_url = server.url.clone();
        let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await; failed(&result);
        assert_eq!(std::fs::read(target(dir.path())).unwrap(), b"old"); server.next().await; server.stop().await;
    }
}

#[tokio::test]
async fn mkdir_and_write_failures_leave_existing_data_unchanged() {
    let dir = TempDir::new();
    std::fs::write(dir.path().join("channel 1"), b"sentinel").unwrap();
    let mut server = Server::start(vec![]).await;
    let mut cfg = config(dir.path(), Some("fixture"), None);
    cfg.openrouter_url = server.url.clone();
    let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
    failed(&result);
    assert_eq!(
        std::fs::read(dir.path().join("channel 1")).unwrap(),
        b"sentinel"
    );
    server.no_more().await;
    server.stop().await;
    let dir = TempDir::new();
    std::fs::create_dir_all(target(dir.path())).unwrap();
    std::fs::write(target(dir.path()).join("sentinel"), b"old").unwrap();
    let mut server = Server::start(vec![ok(b"new")]).await;
    let mut cfg = config(dir.path(), Some("fixture"), None);
    cfg.openrouter_url = server.url.clone();
    let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
    failed(&result);
    assert_eq!(
        std::fs::read(target(dir.path()).join("sentinel")).unwrap(),
        b"old"
    );
    server.next().await;
    server.stop().await;
}

#[tokio::test]
async fn direct_retries_429_and_500_at_most_twice() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![
        response("429 Too Many Requests", "Retry-After: 1\r\n", b""),
        response("500 Internal Server Error", "Retry-After: 1\r\n", b""),
        response(
            "422 Unprocessable Entity",
            "Content-Type: application/json\r\n",
            br#"{"detail":"last"}"#,
        ),
    ])
    .await;
    let mut cfg = config(dir.path(), None, Some("fixture"));
    cfg.fish_url = server.url.clone();
    cfg.attempt_timeout = Duration::from_secs(4);
    let mut req = request(dir.path());
    req.single_attempt = false;
    let result = timeout(
        Duration::from_secs(5),
        FishTtsService::new(cfg).synthesize(&req),
    )
    .await
    .expect("retry fixture deadline");
    failed(&result);
    assert!(
        result.message.contains("Status code: 422"),
        "{}",
        result.message
    );
    let mut bodies = Vec::new();
    for _ in 0..3 {
        bodies.push(server.next().await.body);
    }
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(bodies[1], bodies[2]);
    assert!(!target(dir.path()).exists());
    server.no_more().await;
    server.stop().await;
}

#[tokio::test]
async fn retry_after_is_bounded_by_attempt_deadline() {
    for (status, header) in [
        ("429 Too Many Requests", "Retry-After: 10\r\n"),
        ("500 Internal Server Error", "Retry-After: 10\r\n"),
        ("600 Fixture", "Retry-After: 10\r\n"),
        (
            "429 Too Many Requests",
            "Retry-After: Thu, 01 Jan 2099 00:00:00 GMT\r\n",
        ),
    ] {
        let dir = TempDir::new();
        let mut server = Server::start(vec![response(status, header, b"")]).await;
        let mut cfg = config(dir.path(), None, Some("fixture"));
        cfg.fish_url = server.url.clone();
        cfg.attempt_timeout = Duration::from_millis(100);
        let mut req = request(dir.path());
        req.single_attempt = false;
        let result = synth(&FishTtsService::new(cfg), &req).await;
        failed(&result);
        assert!(
            result
                .message
                .contains("s2.1-pro: Fish Audio TTS timed out"),
            "{}",
            result.message
        );
        server.next().await;
        server.no_more().await;
        assert!(!target(dir.path()).exists());
        server.stop().await;
    }
}

#[tokio::test]
async fn same_origin_307_retains_post_body_and_auth() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![
        response("307 Temporary Redirect", "Location: /redirected\r\n", b""),
        ok(b"audio"),
    ])
    .await;
    let mut cfg = config(dir.path(), Some("fixture"), None);
    cfg.openrouter_url = server.url.clone();
    let result = synth(&FishTtsService::new(cfg), &request(dir.path())).await;
    assert!(!result.error, "{}", result.message);
    let first = server.next().await;
    let second = server.next().await;
    assert_eq!(first.request_line, "POST /speech HTTP/1.1");
    assert_eq!(second.request_line, "POST /redirected HTTP/1.1");
    assert_eq!(first.body, second.body);
    assert_eq!(
        second.headers.get("authorization").map(String::as_str),
        Some("Bearer fixture")
    );
    assert_eq!(std::fs::read(target(dir.path())).unwrap(), b"audio");
    server.no_more().await;
    server.stop().await;
}

#[tokio::test]
async fn primary_wire_preserves_js_lone_surrogate() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![ok(b"audio")]).await;
    let mut cfg = config(dir.path(), Some("fixture"), None);
    cfg.openrouter_url = server.url.clone();
    let mut req = request(dir.path());
    req.text = JsString::from_units(vec![b'x' as u16, 0xd800, b'y' as u16]);
    let result = synth(&FishTtsService::new(cfg), &req).await;
    assert!(!result.error, "{}", result.message);
    let sent = server.next().await;
    let body = String::from_utf8(sent.body).unwrap();
    assert!(body.contains(r#""input":"x\ud800y""#), "{body}");
    server.stop().await;
}

struct TaskGuard(JoinHandle<()>);
impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn shared_client_reuses_one_keepalive_connection() {
    let dir = TempDir::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/speech", listener.local_addr().unwrap());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut task = TaskGuard(tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let first = read_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 3\r\n\r\none",
            )
            .await
            .unwrap();
        let second = tokio::select! {
            received = read_request(&mut socket) => received,
            _ = listener.accept() => panic!("second synthesis opened another connection"),
        };
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 3\r\nConnection: close\r\n\r\ntwo").await.unwrap();
        tx.send((first, second)).unwrap();
    }));
    let mut cfg = config(dir.path(), Some("fixture"), None);
    cfg.openrouter_url = url;
    let service = FishTtsService::with_client(cfg, reqwest::Client::new());
    let req = request(dir.path());
    let first = synth(&service, &req).await;
    assert!(!first.error, "{}", first.message);
    let mut req2 = request(dir.path());
    req2.speech_id = "second".into();
    let second = synth(&service, &req2).await;
    assert!(!second.error, "{}", second.message);
    let (one, two) = timeout(WAIT, rx.recv())
        .await
        .unwrap()
        .expect("keepalive fixture failed");
    assert_eq!(one.body, two.body);
    assert_eq!(std::fs::read(target(dir.path())).unwrap(), b"one");
    assert_eq!(
        std::fs::read(dir.path().join("channel 1/second.mp3")).unwrap(),
        b"two"
    );
    timeout(WAIT, &mut task.0).await.unwrap().unwrap();
}

#[test]
fn config_debug_does_not_disclose_keys() {
    let dir = TempDir::new();
    let cfg = config(
        dir.path(),
        Some("secret-primary-fixture"),
        Some("secret-fish-fixture"),
    );
    let output = format!("{cfg:?}");
    assert!(!output.contains("secret-primary-fixture"));
    assert!(!output.contains("secret-fish-fixture"));
}

// Generate this fixture with the installed TypeScript SDK in an isolated task
// container, then pass its directory explicitly. The ignored test never skips
// missing fixtures or an empty corpus.
#[tokio::test]
#[ignore = "requires FISH_TTS_FIXTURE_DIR generated by fish_sdk_oracle.mjs"]
async fn sdk_source_fixture_matches_encoder_and_http_wire() {
    use dima_rust::tts_services::fish_tts::encode_fish_msgpack;
    use std::fmt::Write;
    fn units(value: &serde_json::Value) -> JsString {
        JsString::from_units(
            value
                .as_array()
                .expect("UTF-16 array")
                .iter()
                .map(|v| u16::try_from(v.as_u64().expect("UTF-16 unit")).unwrap())
                .collect(),
        )
    }
    fn hex(bytes: &[u8]) -> String {
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut output, "{byte:02x}").unwrap();
        }
        output
    }
    let fixture_dir =
        std::env::var_os("FISH_TTS_FIXTURE_DIR").expect("FISH_TTS_FIXTURE_DIR is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(fixture_dir).join("fish-sdk-protocol.json"))
            .expect("SDK fixture missing"),
    )
    .unwrap();
    assert_eq!(fixture["schema"], 1);
    let cases = fixture["cases"].as_array().expect("SDK cases");
    assert!(!cases.is_empty());
    let dir = TempDir::new();
    let mut wire_cases = 0;
    let mut reinforced_cue_cases = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let text = units(&case["textUnits"]);
        let reference = units(&case["referenceUnits"]);
        let expected = case["request"]["body"]["hex"]
            .as_str()
            .expect("SDK request body hex");
        assert_eq!(
            hex(&encode_fish_msgpack(&text, &reference)),
            expected,
            "SDK encoder case {name}"
        );
        // The SDK fixture records its raw input, while the service intentionally
        // reinforces emotion tags before passing text to the SDK.
        if name == "cue-repeat" {
            reinforced_cue_cases += 1;
            continue;
        }
        let mut server = Server::start(vec![ok(&[1, 2, 3])]).await;
        let mut cfg = config(dir.path(), None, Some("fixture-key"));
        cfg.fish_url = server.url.clone();
        let mut req = request(dir.path());
        req.single_attempt = false;
        req.text = text;
        req.voice = reference;
        let result = synth(&FishTtsService::new(cfg), &req).await;
        assert!(!result.error, "{name}: {}", result.message);
        let sent = server.next().await;
        assert_eq!(hex(&sent.body), expected, "SDK HTTP wire case {name}");
        assert_eq!(
            sent.headers.get("model").map(String::as_str),
            Some("s2.1-pro")
        );
        assert_eq!(std::fs::read(target(dir.path())).unwrap(), [1, 2, 3]);
        server.stop().await;
        wire_cases += 1;
    }
    assert_eq!(reinforced_cue_cases, 1);
    assert!(wire_cases >= 20, "incomplete SDK corpus: {wire_cases}");
}

#[tokio::test]
#[ignore = "requires FISH_TTS_FIXTURE_DIR generated by fish_sdk_oracle.mjs"]
async fn sdk_source_fixture_matches_direct_error_messages() {
    let fixture_dir =
        std::env::var_os("FISH_TTS_FIXTURE_DIR").expect("FISH_TTS_FIXTURE_DIR is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(fixture_dir).join("fish-sdk-protocol.json"))
            .expect("SDK fixture missing"),
    )
    .unwrap();
    let cases = fixture["cases"].as_array().expect("SDK cases");
    for (name, status, headers, body) in [
        ("error-json-ordered", "400 Bad Request", "Content-Type: application/json\r\n", br#"{"z":1,"2":"two","1":"one","a":{"y":3,"x":4}}"#.as_slice()),
        ("error-json-duplicate-keys", "400 Bad Request", "Content-Type: application/json\r\n", br#"{"z":1,"2":"first","a":2,"2":"last","z":3,"1":"one"}"#.as_slice()),
        ("error-json-binary64", "400 Bad Request", "Content-Type: application/json\r\n", br#"{"overflow":1e1000,"negativeOverflow":-1e1000,"tiny":1e-320,"underflow":1e-400,"largeInteger":9007199254740993,"rounded":1.234567890123456789,"small":1e-7,"large":1e21,"negativeZero":-0}"#.as_slice()),
        ("error-json-surrogates", "400 Bad Request", "Content-Type: application/json\r\n", br#"{"high":"\ud800","low":"\udc00","pair":"\ud83d\ude00"}"#.as_slice()),
        (
            "error-json",
            "400 Bad Request",
            "Content-Type: application/json\r\n",
            br#"{"error":"bad","count":2}"#.as_slice(),
        ),
        (
            "error-json-null",
            "400 Bad Request",
            "Content-Type: application/json\r\n",
            b"null".as_slice(),
        ),
        (
            "error-json-empty",
            "400 Bad Request",
            "Content-Type: application/json\r\n",
            b"".as_slice(),
        ),
        (
            "error-json-malformed",
            "400 Bad Request",
            "Content-Type: application/json\r\n",
            b"{bad".as_slice(),
        ),
        (
            "error-no-type-malformed",
            "400 Bad Request",
            "",
            b"{bad".as_slice(),
        ),
        (
            "error-text-empty",
            "400 Bad Request",
            "Content-Type: text/plain\r\n",
            b"".as_slice(),
        ),
        (
            "error-422",
            "422 Unprocessable Entity",
            "Content-Type: application/json\r\n",
            br#"{"detail":"bad"}"#.as_slice(),
        ),
    ] {
        let source = cases
            .iter()
            .find(|case| case["name"] == name)
            .unwrap_or_else(|| panic!("missing SDK case {name}"));
        let expected = source["outcome"]["message"]
            .as_str()
            .expect("SDK error message");
        let dir = TempDir::new();
        let mut server = Server::start(vec![response(status, headers, body)]).await;
        let mut cfg = config(dir.path(), None, Some("fixture"));
        cfg.fish_url = server.url.clone();
        let mut req = request(dir.path());
        req.single_attempt = false;
        let result = synth(&FishTtsService::new(cfg), &req).await;
        failed(&result);
        if name == "error-json-malformed" {
            // JSON parser diagnostics are runtime-specific; both must reject it.
            assert!(!expected.is_empty());
            assert!(result.message.contains("s2.1-pro: "));
        } else {
            assert!(
                result.message.contains(&format!("s2.1-pro: {expected}")),
                "{name}: expected SDK message {expected:?}, got {:?}",
                result.message
            );
        }
        assert!(!target(dir.path()).exists());
        server.next().await;
        server.no_more().await;
        server.stop().await;
    }
}

#[test]
#[ignore = "requires SDK fixture and FISH_MSGPACK_BENCH_OUTPUT"]
fn fish_msgpack_encoding_benchmark() {
    use dima_rust::tts_services::fish_tts::encode_fish_msgpack;
    use std::{hint::black_box, time::Instant};

    fn units(value: &serde_json::Value) -> JsString {
        JsString::from_units(
            value
                .as_array()
                .expect("UTF-16 array")
                .iter()
                .map(|v| u16::try_from(v.as_u64().expect("UTF-16 unit")).unwrap())
                .collect(),
        )
    }
    let directory =
        std::env::var_os("FISH_TTS_FIXTURE_DIR").expect("FISH_TTS_FIXTURE_DIR is required");
    let output = std::env::var_os("FISH_MSGPACK_BENCH_OUTPUT")
        .expect("FISH_MSGPACK_BENCH_OUTPUT is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(directory).join("fish-sdk-protocol.json"))
            .expect("SDK fixture missing"),
    )
    .unwrap();
    assert_eq!(fixture["schema"], 1);
    let cases = fixture["cases"].as_array().expect("SDK cases");
    let names = [
        "basic",
        "emoji",
        "unicode-reference",
        "units-49-high",
        "units-50-high",
        "units-51-high",
        "reference-50-high",
        "reference-51-high",
        "ascii-bytes-65536",
    ];
    let prepared: Vec<_> = names
        .iter()
        .map(|name| {
            let mut matching = cases.iter().filter(|case| case["name"] == *name);
            let case = matching
                .next()
                .unwrap_or_else(|| panic!("missing SDK benchmark case {name}"));
            assert!(
                matching.next().is_none(),
                "duplicate SDK benchmark case {name}"
            );
            (
                *name,
                units(&case["textUnits"]),
                units(&case["referenceUnits"]),
            )
        })
        .collect();
    assert_eq!(prepared.len(), names.len());
    let mut results = Vec::with_capacity(prepared.len());
    for (name, text, reference) in prepared {
        let iterations = if name == "ascii-bytes-65536" {
            1_000
        } else {
            10_000
        };
        for _ in 0..100 {
            black_box(encode_fish_msgpack(black_box(&text), black_box(&reference)));
        }
        let mut expected = None;
        let mut samples_ns = Vec::with_capacity(7);
        for _ in 0..7 {
            let mut checksum = 0u32;
            let mut bytes = 0u64;
            let start = Instant::now();
            for _ in 0..iterations {
                let encoded =
                    black_box(encode_fish_msgpack(black_box(&text), black_box(&reference)));
                bytes += encoded.len() as u64;
                for byte in encoded {
                    checksum = checksum.wrapping_add(u32::from(byte));
                }
            }
            let elapsed = u64::try_from(start.elapsed().as_nanos())
                .expect("benchmark duration exceeds u64 ns");
            black_box((bytes, checksum));
            match expected {
                None => expected = Some((bytes, checksum)),
                Some(first) => {
                    assert_eq!((bytes, checksum), first, "inconsistent sample for {name}")
                }
            }
            samples_ns.push(elapsed);
        }
        let (bytes, checksum) = expected.unwrap();
        results.push(serde_json::json!({"name": name, "iterations": iterations, "bytes": bytes, "checksum": checksum, "samplesNs": samples_ns}));
    }
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&serde_json::json!({"cases": results})).unwrap(),
    )
    .expect("write benchmark output");
}

#[tokio::test]
#[ignore = "requires FISH_TTS_FIXTURE_DIR generated by fish_tts_reference.mjs"]
async fn typescript_service_fixture_replay() {
    use std::fmt::Write;
    fn units(value: &serde_json::Value) -> JsString {
        JsString::from_units(
            value
                .as_array()
                .expect("UTF-16 array")
                .iter()
                .map(|v| u16::try_from(v.as_u64().expect("UTF-16 unit")).unwrap())
                .collect(),
        )
    }
    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    fn decode_base64(value: &str) -> Vec<u8> {
        fn digit(c: u8) -> u8 {
            match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => panic!("invalid base64 digit"),
            }
        }
        assert_eq!(value.len() % 4, 0);
        let mut output = Vec::new();
        for group in value.as_bytes().as_chunks::<4>().0 {
            let a = digit(group[0]);
            let b = digit(group[1]);
            output.push((a << 2) | (b >> 4));
            if group[2] != b'=' {
                let c = digit(group[2]);
                output.push((b << 4) | (c >> 2));
                if group[3] != b'=' {
                    output.push((c << 6) | digit(group[3]));
                }
            } else {
                assert_eq!(group[3], b'=');
            }
        }
        output
    }
    fn hex(bytes: &[u8]) -> String {
        let mut result = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut result, "{byte:02x}").unwrap();
        }
        result
    }
    fn replace_root(value: &str, root: &Path) -> String {
        value.replace(root.to_str().expect("UTF-8 temp path"), "<fixture-dir>")
    }
    fn fixture_path(value: &str, root: &Path) -> PathBuf {
        let suffix = value
            .strip_prefix("<fixture-dir>/")
            .expect("fixture path outside task root");
        assert!(
            !suffix.split('/').any(|p| p == ".."),
            "fixture path traverses root"
        );
        root.join(suffix)
    }
    fn files_under(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        if !dir.exists() {
            return;
        }
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                files_under(root, &path, out);
            } else {
                assert!(entry.file_type().unwrap().is_file());
                out.insert(
                    replace_root(path.to_str().unwrap(), root),
                    hex(&std::fs::read(path).unwrap()),
                );
            }
        }
    }
    let directory =
        std::env::var_os("FISH_TTS_FIXTURE_DIR").expect("FISH_TTS_FIXTURE_DIR is required");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(directory).join("fish-tts-reference.json"))
            .expect("TypeScript service fixture missing"),
    )
    .unwrap();
    assert_eq!(fixture["schema"], 1);
    let cases = fixture["cases"].as_array().expect("application cases");
    assert_eq!(cases.len(), 11);
    let mut names = std::collections::BTreeSet::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name), "duplicate case {name}");
        let dir = TempDir::new();
        let replies = case["responses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|spec| {
                let status = spec["status"].as_u64().unwrap();
                let mut headers = String::new();
                for (key, value) in spec["headers"].as_object().unwrap() {
                    write!(&mut headers, "{key}: {}\r\n", value.as_str().unwrap()).unwrap();
                }
                let body = spec["bodyHex"].as_str().map(decode_hex).unwrap_or_default();
                response(&format!("{status} Fixture"), &headers, &body)
            })
            .collect();
        let mut server = Server::start(replies).await;
        let input = &case["input"];
        let config_data = &case["configuration"];
        let paths = SpeechPaths::new(
            dir.path().join("audio-public"),
            Some(config_data["publicApiUrl"].as_str().unwrap()),
            false,
        );
        let mut cfg = FishConfig::new(
            paths,
            config_data["openrouterEnabled"]
                .as_bool()
                .unwrap()
                .then(|| " fixture-openrouter-key ".to_owned()),
            config_data["fishEnabled"]
                .as_bool()
                .unwrap()
                .then(|| " fixture-fish-key ".to_owned()),
        );
        cfg.openrouter_url = server.url.replace("/speech", "/primary");
        cfg.fish_url = server.url.replace("/speech", "/fish");
        let mut req = request(dir.path());
        req.text = units(&input["textUnits"]);
        req.voice = units(&input["voiceUnits"]);
        req.channel_id = input["channelID"].as_str().unwrap().to_owned();
        req.speech_id = input["speechID"].as_str().unwrap().to_owned();
        req.output_path = fixture_path(input["outputPath"].as_str().unwrap(), dir.path());
        req.private_output = input["privateOutput"].as_bool().unwrap();
        req.single_attempt = input["singleAttempt"].as_bool().unwrap_or(false);
        req.max_audio_bytes = input["maxAudioBytes"]
            .as_u64()
            .map(|v| usize::try_from(v).unwrap());
        let result = synth(&FishTtsService::new(cfg), &req).await;
        let mut actual = serde_json::json!({"error": result.error, "message": result.message});
        let actual_obj = actual.as_object_mut().unwrap();
        if let Some(path) = result.output_path {
            actual_obj.insert(
                "outputPath".into(),
                replace_root(path.to_str().unwrap(), dir.path()).into(),
            );
        }
        if let Some(path) = result.public_path {
            actual_obj.insert("publicPath".into(), path.into());
        }
        if let Some(mime) = result.mime_type {
            actual_obj.insert("mimeType".into(), mime.into());
        }
        assert_eq!(actual, case["outcome"], "service outcome: {name}");
        for expected in case["requests"].as_array().unwrap() {
            let sent = server.next().await;
            let expected_url = expected["url"].as_str().unwrap();
            let target = match expected_url {
                "https://openrouter.ai/api/v1/audio/speech" => "/primary",
                "https://api.fish.audio/v1/tts" => "/fish",
                _ => panic!("unknown SDK URL in {name}"),
            };
            assert_eq!(
                sent.request_line,
                format!("{} {target} HTTP/1.1", expected["method"].as_str().unwrap()),
                "request method: {name}"
            );
            let source_headers = expected["headers"].as_object().unwrap();
            for key in [
                "authorization",
                "content-type",
                "model",
                "user-agent",
                "http-referer",
                "x-openrouter-title",
                "x-openrouter-description",
                "x-openrouter-categories",
            ] {
                if let Some(value) = source_headers.get(key) {
                    assert_eq!(
                        sent.headers.get(key).map(String::as_str),
                        value.as_str(),
                        "header {key}: {name}"
                    );
                }
            }
            let body = expected["body"].as_str().unwrap();
            let expected_body = match expected["bodyEncoding"].as_str().unwrap() {
                "utf8" => body.as_bytes().to_vec(),
                "base64" => decode_base64(body),
                _ => panic!("unknown body encoding"),
            };
            assert_eq!(sent.body, expected_body, "request body: {name}");
        }
        server.no_more().await;
        let expected_files: BTreeMap<String, String> = case["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap().to_owned(),
                    file["hex"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let mut actual_files = BTreeMap::new();
        files_under(dir.path(), dir.path(), &mut actual_files);
        assert_eq!(actual_files, expected_files, "files: {name}");
        server.stop().await;
    }
    let public_cases = fixture["publicPathCases"]
        .as_array()
        .expect("public path cases");
    assert_eq!(public_cases.len(), 3);
    let paths = SpeechPaths::new(
        PathBuf::from("/unused"),
        Some("https://fixture.invalid/base///"),
        false,
    );
    let mut unsupported = 0;
    for case in public_cases {
        let channel = units(&case["channelUnits"]);
        let speech = units(&case["speechUnits"]);
        match (channel.as_str(), speech.as_str()) {
            (Some(channel), Some(speech)) => assert_eq!(
                paths.public_path(channel, speech),
                case["result"].as_str().expect("source public path")
            ),
            _ => {
                assert_eq!(case["error"]["name"], "URIError");
                unsupported += 1;
            }
        }
    }
    assert_eq!(
        unsupported, 1,
        "expected exactly one malformed UTF-16 ID boundary"
    );
}
