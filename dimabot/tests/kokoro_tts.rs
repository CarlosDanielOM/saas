#![cfg(feature = "tts-services")]

use dima_rust::{
    tts_services::{
        kokoro_tts::{KOKORO_ATTEMPT_TIMEOUT, KokoroConfig, KokoroTtsService},
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
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
const WAIT: Duration = Duration::from_secs(3);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kokoro-tts-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
struct Received {
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
async fn read_request(socket: &mut TcpStream) -> Option<Received> {
    let mut bytes = Vec::new();
    let (end, length) = loop {
        if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..pos]);
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            break (pos + 4, length);
        }
        let mut chunk = [0; 4096];
        let n = socket.read(&mut chunk).await.unwrap();
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..n]);
    };
    while bytes.len() < end + length {
        let mut chunk = [0; 4096];
        let n = socket.read(&mut chunk).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
    assert_eq!(head.lines().next(), Some("POST /speech HTTP/1.1"));
    let headers = head
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Some(Received {
        headers,
        body: bytes[end..end + length].to_vec(),
    })
}

enum Reply {
    Bytes(Vec<u8>),
    HoldHeaders,
    HoldBody(Vec<u8>),
}
struct Server {
    url: String,
    received: mpsc::UnboundedReceiver<Received>,
    connections: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl Server {
    async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/speech", listener.local_addr().unwrap());
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let connections = Arc::new(AtomicUsize::new(0));
        let count = connections.clone();
        let (tx, received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                count.fetch_add(1, Ordering::Relaxed);
                let tx = tx.clone();
                let replies = replies.clone();
                children.spawn(async move {
                    while let Some(request) = read_request(&mut socket).await {
                        let reply = replies.lock().unwrap().pop_front();
                        let _ = tx.send(request);
                        match reply {
                            Some(Reply::Bytes(bytes)) => {
                                if socket.write_all(&bytes).await.is_err() {
                                    break;
                                }
                            }
                            Some(Reply::HoldBody(bytes)) => {
                                let _ = socket.write_all(&bytes).await;
                                std::future::pending::<()>().await;
                            }
                            Some(Reply::HoldHeaders) | None => std::future::pending::<()>().await,
                        }
                    }
                });
            }
        });
        Self {
            url,
            received,
            connections,
            task,
        }
    }
    async fn next(&mut self) -> Received {
        timeout(WAIT, self.received.recv()).await.unwrap().unwrap()
    }
    async fn no_more(&mut self) {
        assert!(
            timeout(Duration::from_millis(75), self.received.recv())
                .await
                .is_err(),
            "unexpected provider request"
        );
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn response(status: &str, headers: &str, body: &[u8]) -> Reply {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    Reply::Bytes(bytes)
}
fn ok(body: &[u8]) -> Reply {
    response(
        "200 OK",
        "Content-Type: Audio/Mpeg; charset=binary\r\n",
        body,
    )
}
fn request(dir: &Path) -> TtsSynthesisRequest {
    TtsSynthesisRequest {
        channel_id: "channel 1".into(),
        speech_id: "id+1".into(),
        mode: TtsMode::Speak,
        provider: TtsProvider::Kokoro,
        model: None,
        text: JsString::from("Hello chat!"),
        language: TtsLanguage::En,
        voice: JsString::from(" AF_HEART "),
        output_path: dir.join("private/output.mp3"),
        clone_name: None,
        private_output: false,
        signal: None,
        max_audio_bytes: None,
        single_attempt: false,
    }
}
fn service(dir: &Path, server: &Server, key: Option<&str>) -> KokoroTtsService {
    let mut config = KokoroConfig::new(
        SpeechPaths::new(dir.into(), Some("https://example.test/"), false),
        key.map(str::to_owned),
    );
    config.openrouter_url = server.url.clone();
    config.attempt_timeout = Duration::from_secs(2);
    KokoroTtsService::new(config)
}
async fn synth(service: &KokoroTtsService, request: &TtsSynthesisRequest) -> TtsSynthesisResult {
    timeout(WAIT, service.synthesize(request))
        .await
        .expect("synthesis stuck")
}
fn failure(result: &TtsSynthesisResult, message: &str) {
    assert!(result.error, "{result:?}");
    assert_eq!(result.message, message);
    assert_eq!(result.output_path, None);
    assert_eq!(result.public_path, None);
    assert_eq!(result.mime_type, None);
}

#[tokio::test]
async fn request_contract_public_private_and_pool_reuse() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![ok(b"ID3audio"), ok(b"private")]).await;
    let service = service(&dir.0, &server, Some("  test-only  "));
    let mut req = request(&dir.0);
    req.voice = " AF_KORE ".into();
    req.text = JsString::from_units(vec![b'H' as u16, 0xd800]);
    let result = synth(&service, &req).await;
    assert!(!result.error, "{result:?}");
    assert_eq!(result.message, "Speech synthesized with Kokoro (DeepInfra)");
    assert_eq!(result.output_path, Some(dir.0.join("channel 1/id+1.mp3")));
    assert_eq!(
        result.public_path.as_deref(),
        Some("https://example.test/speech/audio/channel%201/id%2B1")
    );
    assert_eq!(result.mime_type, Some("audio/mpeg"));
    assert_eq!(
        std::fs::read(result.output_path.unwrap()).unwrap(),
        b"ID3audio"
    );
    let received = server.next().await;
    assert_eq!(
        received.headers.get("authorization").unwrap(),
        "Bearer test-only"
    );
    assert_eq!(
        received.headers.get("content-type").unwrap(),
        "application/json"
    );
    for (key, expected) in [
        ("http-referer", "https://domdimabot.com"),
        ("x-openrouter-title", "DomDimaBot"),
        (
            "x-openrouter-description",
            "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
        ),
        ("x-openrouter-categories", "general-chat, roleplay"),
    ] {
        assert_eq!(received.headers.get(key).unwrap(), expected);
    }
    assert_eq!(
        String::from_utf8(received.body).unwrap(),
        r#"{"model":"hexgrad/kokoro-82m","input":"H\ud800","voice":"af_kore","response_format":"mp3","user":"channel 1","provider":{"only":["deepinfra"],"order":["deepinfra"],"allow_fallbacks":false}}"#
    );
    req.private_output = true;
    let result = synth(&service, &req).await;
    assert!(!result.error, "{result:?}");
    assert_eq!(result.public_path, None);
    assert_eq!(result.output_path.as_ref(), Some(&req.output_path));
    assert_eq!(std::fs::read(&req.output_path).unwrap(), b"private");
    server.next().await;
    assert_eq!(
        server.connections.load(Ordering::Relaxed),
        1,
        "pooled client must reuse connection"
    );
    server.no_more().await;
}

#[tokio::test]
async fn invalid_input_and_preabort_do_not_call_provider() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![]).await;
    let mut req = request(&dir.0);
    req.voice = "invalid".into();
    req.text = " ".into();
    failure(
        &synth(&service(&dir.0, &server, None), &req).await,
        "OpenRouter API key is not configured",
    );
    let service = service(&dir.0, &server, Some("test"));
    failure(&synth(&service, &req).await, "Invalid Kokoro preset voice");
    req.voice = "af_heart".into();
    failure(&synth(&service, &req).await, "No text provided");
    req.text = "x".into();
    let (_tx, rx) = watch::channel(Some("caller stopped".to_string()));
    req.signal = Some(rx);
    failure(&synth(&service, &req).await, "caller stopped");
    server.no_more().await;
    assert!(!dir.0.join("channel 1").exists());
}

#[tokio::test]
async fn response_failures_and_byte_bound_leave_no_files() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![
        response(
            "503 Service Unavailable",
            "Content-Type: audio/mpeg\r\n",
            b"error",
        ),
        response("200 OK", "Content-Type: application/json\r\n", b"{}"),
        response("200 OK", "Content-Type: audio/mpeg\r\n", b""),
        response("204 No Content", "Content-Type: audio/mpeg\r\n", b""),
        ok(b"1234"),
        ok(b"1234"),
        ok(b"1"),
    ])
    .await;
    let service = service(&dir.0, &server, Some("test"));
    let mut req = request(&dir.0);
    for expected in [
        "Kokoro DeepInfra synthesis failed (HTTP 503)",
        "Kokoro returned an unexpected audio format",
        "Kokoro returned empty audio",
        "Kokoro returned empty audio",
    ] {
        failure(&synth(&service, &req).await, expected);
        server.next().await;
        assert!(!dir.0.join("channel 1").exists());
    }
    req.max_audio_bytes = Some(3);
    failure(&synth(&service, &req).await, "TTS audio exceeds byte limit");
    server.next().await;
    assert!(!dir.0.join("channel 1").exists());
    req.max_audio_bytes = Some(4);
    assert!(!synth(&service, &req).await.error);
    server.next().await;
    std::fs::remove_dir_all(dir.0.join("channel 1")).unwrap();
    req.max_audio_bytes = Some(0);
    failure(&synth(&service, &req).await, "TTS audio exceeds byte limit");
    server.next().await;
    assert!(!dir.0.join("channel 1").exists());
    server.no_more().await;
}

#[tokio::test]
async fn deadlines_cover_headers_and_body_and_abort_stops_request() {
    let dir = TempDir::new();
    for reply in [
        Reply::HoldHeaders,
        Reply::HoldBody(
            b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 4\r\n\r\n1".to_vec(),
        ),
    ] {
        let mut server = Server::start(vec![reply]).await;
        let mut service = service(&dir.0, &server, Some("test"));
        service.config.attempt_timeout = Duration::from_millis(150);
        let req = request(&dir.0);
        failure(&synth(&service, &req).await, "Kokoro TTS timed out");
        server.next().await;
        server.no_more().await;
        assert!(!dir.0.join("channel 1").exists());
    }
    let mut server = Server::start(vec![Reply::HoldHeaders]).await;
    let service = service(&dir.0, &server, Some("test"));
    let mut req = request(&dir.0);
    let (tx, rx) = watch::channel(None);
    req.signal = Some(rx);
    let task = tokio::spawn(async move { synth(&service, &req).await });
    server.next().await;
    tx.send(Some("user cancelled".into())).unwrap();
    failure(
        &timeout(WAIT, task).await.unwrap().unwrap(),
        "user cancelled",
    );
    server.no_more().await;
}

#[tokio::test]
async fn filesystem_error_is_reported_after_audio() {
    let dir = TempDir::new();
    let mut server = Server::start(vec![ok(b"audio")]).await;
    let service = service(&dir.0, &server, Some("test"));
    let mut req = request(&dir.0);
    std::fs::write(dir.0.join("blocker"), b"file").unwrap();
    req.private_output = true;
    req.output_path = dir.0.join("blocker/output.mp3");
    let result = synth(&service, &req).await;
    assert!(result.error);
    assert_eq!(result.output_path, None);
    assert_eq!(result.public_path, None);
    assert_eq!(result.mime_type, None);
    server.next().await;
    server.no_more().await;
}

#[test]
fn config_defaults_and_debug_do_not_expose_credentials() {
    let mut config = KokoroConfig::new(
        SpeechPaths::new("/speech".into(), None, false),
        Some("secret-key".into()),
    );
    assert_eq!(config.attempt_timeout, KOKORO_ATTEMPT_TIMEOUT);
    assert_eq!(config.attempt_timeout, Duration::from_secs(20));
    config.openrouter_url = "https://secret-url/?token=secret-query".into();
    let debug = format!("{config:?}");
    assert!(!debug.contains("secret-key"));
    assert!(!debug.contains("secret-url"));
    assert!(!debug.contains("secret-query"));
}

fn fixture_units(value: &serde_json::Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect(),
    )
}
fn unhex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires PIPER_KOKORO_FIXTURE_DIR generated by piper_kokoro_reference.mjs"]
async fn replay_kokoro_source_fixture() {
    let fixture_dir =
        std::env::var_os("PIPER_KOKORO_FIXTURE_DIR").expect("PIPER_KOKORO_FIXTURE_DIR is required");
    let bytes = std::fs::read(PathBuf::from(fixture_dir).join("piper-kokoro-reference.json"))
        .expect("source fixture is required");
    let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(doc["schema"], 1);
    let cases = doc["cases"].as_array().expect("fixture cases");
    let cases: Vec<_> = cases
        .iter()
        .filter(|case| case["provider"] == "kokoro")
        .collect();
    assert_eq!(cases.len(), 14, "missing Kokoro source cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let dir = TempDir::new();
        let root = dir.0.to_str().unwrap();
        let input = &case["input"];
        let replies = case["responses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reply| {
                let status = reply["status"].as_u64().unwrap();
                let mut headers = String::new();
                for (key, value) in reply["headers"].as_object().unwrap() {
                    headers.push_str(&format!("{key}: {}\r\n", value.as_str().unwrap()));
                }
                let body = reply["bodyHex"].as_str().map(unhex).unwrap_or_default();
                response(&format!("{status} fixture"), &headers, &body)
            })
            .collect();
        let mut server = Server::start(replies).await;
        let mut config = KokoroConfig::new(
            SpeechPaths::new(
                dir.0.join("source/server/routes/public/speech"),
                case["configuration"]["publicApiUrl"].as_str(),
                false,
            ),
            case["configuration"]["key"]
                .as_bool()
                .unwrap()
                .then(|| " fixture-key ".to_owned()),
        );
        config.openrouter_url = server.url.clone();
        config.attempt_timeout = WAIT;
        let service = KokoroTtsService::new(config);
        let mut req = request(&dir.0);
        req.text = fixture_units(&input["textUnits"]);
        req.voice = fixture_units(&input["voiceUnits"]);
        req.channel_id = input["channelID"].as_str().unwrap().to_owned();
        req.speech_id = input["speechID"].as_str().unwrap().to_owned();
        req.output_path = PathBuf::from(
            input["outputPath"]
                .as_str()
                .unwrap()
                .replace("<fixture-dir>", root),
        );
        req.private_output = input["privateOutput"].as_bool().unwrap();
        req.max_audio_bytes = input
            .get("maxAudioBytes")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let (_tx, signal) = watch::channel(
            input["preabort"]
                .as_bool()
                .unwrap()
                .then(|| "fixture abort".to_owned()),
        );
        req.signal = Some(signal);
        let result = synth(&service, &req).await;
        let mut actual = serde_json::Map::new();
        actual.insert("error".into(), result.error.into());
        actual.insert("message".into(), result.message.into());
        if let Some(path) = result.output_path {
            actual.insert(
                "outputPath".into(),
                path.to_str().unwrap().replace(root, "<fixture-dir>").into(),
            );
        }
        if let Some(path) = result.public_path {
            actual.insert("publicPath".into(), path.into());
        }
        if let Some(mime) = result.mime_type {
            actual.insert("mimeType".into(), mime.into());
        }
        let expected: serde_json::Value =
            serde_json::from_str(case["outcomeJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            serde_json::Value::Object(actual),
            expected,
            "outcome for {name}"
        );
        for expected in case["requests"].as_array().unwrap() {
            let received = server.next().await;
            assert_eq!(
                expected["url"], "https://openrouter.ai/api/v1/audio/speech",
                "URL for {name}"
            );
            assert_eq!(expected["method"], "POST", "method for {name}");
            assert_eq!(
                received.body,
                expected["body"].as_str().unwrap().as_bytes(),
                "body for {name}"
            );
            for (key, value) in expected["headers"].as_object().unwrap() {
                assert_eq!(
                    received.headers.get(key).map(String::as_str),
                    value.as_str(),
                    "header {key} for {name}"
                );
            }
        }
        server.no_more().await;
        let files = case["files"].as_array().unwrap();
        let output_path = if req.private_output {
            req.output_path.clone()
        } else {
            dir.0
                .join("source/server/routes/public/speech")
                .join(&req.channel_id)
                .join(format!("{}.mp3", req.speech_id))
        };
        if files.is_empty() {
            assert!(!output_path.exists(), "unexpected output for {name}");
        } else {
            assert_eq!(files.len(), 1);
            assert_eq!(
                output_path.to_str().unwrap().replace(root, "<fixture-dir>"),
                files[0]["path"].as_str().unwrap()
            );
            assert_eq!(
                std::fs::read(output_path).unwrap(),
                unhex(files[0]["hex"].as_str().unwrap())
            );
        }
    }
}
