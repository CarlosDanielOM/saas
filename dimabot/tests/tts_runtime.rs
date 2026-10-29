#![cfg(feature = "tts-services")]

use dima_rust::{
    tts_services::{
        fish_voice_catalog::FishVoiceSearch,
        runtime::{Environment, TtsRuntime, TtsRuntimeConfig, speech_root_from_module_dir},
        tts_provider::{TtsMode, TtsSynthesisRequest, TtsSynthesisResult},
    },
    utils::{
        js_string::JsString,
        tts::{TtsLanguage, TtsProvider},
    },
};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};

const WAIT: Duration = Duration::from_secs(4);
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "tts-runtime-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("create owned fixture directory");
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
type Values = Arc<RwLock<HashMap<String, String>>>;
fn env(values: Values) -> Environment {
    Arc::new(move |name| values.read().unwrap().get(name).cloned())
}
fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}
fn runtime(values: Values, root: &Path) -> TtsRuntime {
    TtsRuntime::with_client(TtsRuntimeConfig::new(root.into()), env(values), client())
}
fn put(values: &Values, key: &str, value: &str) {
    values.write().unwrap().insert(key.into(), value.into());
}
fn request(root: &Path) -> TtsSynthesisRequest {
    TtsSynthesisRequest {
        channel_id: "channel 1".into(),
        speech_id: "id+1".into(),
        mode: TtsMode::Speak,
        provider: TtsProvider::Piper,
        model: None,
        text: JsString::from("Hello chat!"),
        language: TtsLanguage::En,
        voice: JsString::from("af_heart"),
        output_path: root.join("private/output"),
        clone_name: None,
        private_output: false,
        signal: None,
        max_audio_bytes: None,
        single_attempt: true,
    }
}
fn search() -> FishVoiceSearch {
    FishVoiceSearch {
        name: "fixture".into(),
        gender: "all".into(),
        language: "all".into(),
        license: "all".into(),
        page: 1,
    }
}
#[derive(Debug)]
struct Received {
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
// Read exactly one message, avoiding loss of any following keep-alive request.
async fn read_request(socket: &mut TcpStream) -> Received {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let byte = socket.read_u8().await.expect("request headers");
        head.push(byte);
        assert!(head.len() < 65536, "oversized headers");
    }
    let head = String::from_utf8(head).unwrap();
    let mut lines = head.split("\r\n");
    let line = lines.next().unwrap().to_owned();
    let headers: BTreeMap<String, String> = lines
        .filter_map(|s| s.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .map(|s| s.parse().unwrap())
        .unwrap_or(0);
    assert!(length < 1024 * 1024, "oversized body");
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.expect("request body");
    Received {
        line,
        headers,
        body,
    }
}
#[derive(Debug)]
enum Reply {
    Full(Vec<u8>),
    Split {
        first: Vec<u8>,
        started: oneshot::Sender<()>,
        rest: oneshot::Receiver<Vec<u8>>,
    },
}
struct Server {
    origin: String,
    received: mpsc::UnboundedReceiver<(Received, oneshot::Sender<Reply>)>,
    task: JoinHandle<()>,
}
impl Server {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = timeout(WAIT, listener.accept())
                .await
                .expect("first connection timeout")
                .unwrap();
            loop {
                let request = tokio::select! {
                    incoming = listener.accept() => panic!("unexpected second connection: {:?}", incoming.map(|(_, address)| address)),
                    received = timeout(WAIT, read_request(&mut socket)) => received.expect("request timeout"),
                };
                let (reply_tx, reply_rx) = oneshot::channel();
                if tx.send((request, reply_tx)).is_err() {
                    return;
                }
                let reply = tokio::select! {
                    incoming = listener.accept() => panic!("unexpected second connection: {:?}", incoming.map(|(_, address)| address)),
                    reply = timeout(WAIT, reply_rx) => reply.expect("fixture reply timeout").expect("fixture reply dropped"),
                };
                match reply {
                    Reply::Full(bytes) => {
                        socket.write_all(&bytes).await.expect("write fixture reply")
                    }
                    Reply::Split {
                        first,
                        started,
                        rest,
                    } => {
                        socket
                            .write_all(&first)
                            .await
                            .expect("write fixture headers and partial body");
                        let _ = started.send(());
                        let tail = tokio::select! {
                            incoming = listener.accept() => panic!("unexpected second connection: {:?}", incoming.map(|(_, address)| address)),
                            tail = timeout(WAIT, rest) => tail.expect("fixture body timeout").expect("fixture body dropped"),
                        };
                        socket
                            .write_all(&tail)
                            .await
                            .expect("write fixture body tail");
                    }
                }
            }
        });
        Self {
            origin,
            received,
            task,
        }
    }
    async fn next(&mut self) -> (Received, oneshot::Sender<Reply>) {
        timeout(WAIT, self.received.recv())
            .await
            .expect("request timed out")
            .expect("server stopped")
    }
    async fn finish(mut self) {
        // Keep the listener active briefly to detect a second client after the last reply.
        assert!(
            timeout(Duration::from_millis(100), self.received.recv())
                .await
                .is_err(),
            "extra request"
        );
        assert!(
            !self.task.is_finished(),
            "server failed: {:?}",
            (&mut self.task).await
        );
        self.task.abort();
        assert!(
            timeout(WAIT, &mut self.task)
                .await
                .unwrap()
                .unwrap_err()
                .is_cancelled()
        );
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn reply(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
fn spawn_synth(
    runtime: &TtsRuntime,
    provider: Option<TtsProvider>,
    req: &TtsSynthesisRequest,
) -> JoinHandle<TtsSynthesisResult> {
    let runtime = runtime.clone();
    let req = req.clone();
    tokio::spawn(async move { runtime.synthesize(provider, &req).await })
}
async fn result(task: JoinHandle<TtsSynthesisResult>) -> TtsSynthesisResult {
    timeout(WAIT, task)
        .await
        .expect("synthesis timeout")
        .expect("synthesis task")
}
fn assert_audio(
    result: &TtsSynthesisResult,
    root: &Path,
    extension: &str,
    audio: &[u8],
    base: &str,
) {
    assert!(!result.error, "{result:?}");
    let path = root.join(format!("channel 1/id+1.{extension}"));
    assert_eq!(result.output_path.as_ref(), Some(&path));
    assert_eq!(std::fs::read(path).unwrap(), audio);
    assert_eq!(
        result.mime_type,
        Some(if extension == "wav" {
            "audio/wav"
        } else {
            "audio/mpeg"
        })
    );
    assert_eq!(
        result.public_path.as_deref(),
        Some(format!("{base}/speech/audio/channel%201/id%2B1").as_str())
    );
}
fn auth(received: &Received, key: &str) {
    assert_eq!(
        received.headers.get("authorization").map(String::as_str),
        Some(format!("Bearer {key}").as_str())
    );
}

#[test]
fn configuration_refresh_and_path_rules() {
    let dir = TempDir::new();
    let values = Arc::new(RwLock::new(HashMap::new()));
    let runtime = runtime(values.clone(), &dir.0);
    assert_eq!(runtime.piper_config().python_bin, Path::new("python3"));
    for (k, v) in [
        ("PIPER_PYTHON_BIN", "  "),
        ("PIPER_DATA_DIR", "\u{feff} relative \u{feff}"),
        ("PIPER_HTTP_URL", " https://example///"),
        ("PUBLIC_API_URL", " https://api///"),
        ("NODE_ENV", "production"),
    ] {
        put(&values, k, v);
    }
    let config = runtime.clone().piper_config();
    assert_eq!(config.python_bin, Path::new("  "));
    assert_eq!(config.data_dir.as_deref(), Some("relative"));
    assert_eq!(config.http_url.as_deref(), Some(" https://example"));
    assert_eq!(
        config.paths.public_path("a/b ?", "é+!"),
        " https://api/speech/audio/a%2Fb%20%3F/%C3%A9%2B!"
    );
    values.write().unwrap().clear();
    assert_eq!(runtime.paths().public_api_url, "http://localhost:3000");
    assert!(speech_root_from_module_dir(Path::new("relative")).is_none());
    let mut cfg = TtsRuntimeConfig::new(dir.0.clone());
    cfg.piper.http_url = Some("http://piper-secret/path?credential=url-secret".into());
    cfg.piper.paths.public_api_url = "http://public-secret/?key=value".into();
    cfg.fish.openrouter_api_key = Some("openrouter-secret".into());
    cfg.fish.fish_api_key = Some("fish-secret".into());
    cfg.fish.openrouter_url = "http://fish-primary-secret/?token=fake".into();
    cfg.fish.fish_url = "http://fish-url-secret/?token=fake".into();
    cfg.kokoro.openrouter_api_key = Some("kokoro-secret".into());
    cfg.catalog.key = Some("catalog-secret".into());
    cfg.kokoro.openrouter_url = "http://kokoro-url-secret/?token=fake".into();
    cfg.catalog.endpoint = "http://catalog-url-secret/?token=fake".into();
    let debug = format!(
        "{:?} {:?} {:?} {:?} {:?} {:?}",
        cfg, cfg.piper, cfg.piper.paths, cfg.fish, cfg.kokoro, cfg.catalog
    );
    for secret in [
        "piper-secret",
        "url-secret",
        "public-secret",
        "openrouter-secret",
        "fish-secret",
        "kokoro-secret",
        "catalog-secret",
        "fish-primary-secret",
        "fish-url-secret",
        "kokoro-url-secret",
        "catalog-url-secret",
    ] {
        assert!(!debug.contains(secret), "debug leaked {secret}");
    }
}
#[test]
fn runtime_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<TtsRuntime>();
}

#[test]
fn process_environment_reads_child_values() {
    const MARKER: &str = "TTS_RUNTIME_ISOLATED_CHILD";
    if std::env::var_os(MARKER).is_some() {
        let get = dima_rust::tts_services::runtime::process_environment();
        assert_eq!(
            get("OPENROUTER_API_KEY").as_deref(),
            Some("fixture-key-only")
        );
        assert_eq!(get("TTS_RUNTIME_MISSING"), None);
        #[cfg(unix)]
        assert_eq!(get("TTS_RUNTIME_INVALID_UTF8").as_deref(), Some("\u{fffd}"));
        return;
    }
    // The child has only fixture variables; no process-global mutation in tests.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "process_environment_reads_child_values",
            "--nocapture",
        ])
        .env_clear()
        .env(MARKER, "1")
        .env("OPENROUTER_API_KEY", "fixture-key-only");
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        child.env(
            "TTS_RUNTIME_INVALID_UTF8",
            std::ffi::OsString::from_vec(vec![255]),
        );
    }
    let output = child.output().expect("run isolated child");
    assert!(
        output.status.success(),
        "child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "isolated child did not run its check"
    );
}

#[test]
#[ignore = "requires source oracle generated in a disposable Node fixture directory"]
fn source_config_fixture() {
    let dir = std::env::var("TTS_RUNTIME_FIXTURE_DIR").expect("TTS_RUNTIME_FIXTURE_DIR required");
    let bytes = std::fs::read(Path::new(&dir).join("tts_runtime_reference.json"))
        .expect("source fixture required");
    assert!(!bytes.is_empty());
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let paths = data["paths"].as_array().unwrap();
    assert!(paths.len() >= 4);
    for item in paths {
        assert_eq!(
            speech_root_from_module_dir(Path::new(item["moduleDir"].as_str().unwrap())).unwrap(),
            Path::new(item["publicDir"].as_str().unwrap())
        );
    }
    let cases = data["cases"].as_array().unwrap();
    assert!(cases.len() >= 10);
    let dir = TempDir::new();
    for case in cases {
        let values = Arc::new(RwLock::new(HashMap::new()));
        for (k, v) in case["env"].as_object().unwrap() {
            put(&values, k, v.as_str().unwrap());
        }
        let runtime = runtime(values, &dir.0);
        let config = runtime.piper_config();
        let actual = serde_json::json!([
            config.python_bin.to_str().unwrap(),
            config.data_dir,
            config.http_url,
            config.paths.public_api_url,
            runtime.paths().public_path("a/b ?", "é+!")
        ]);
        assert_eq!(actual, case["result"], "case {:?}", case["env"]);
    }
}

#[tokio::test]
async fn shared_client_dispatch_keys_cache_and_fallback_timing() {
    let dir = TempDir::new();
    let mut server = Server::new().await;
    let values = Arc::new(RwLock::new(HashMap::new()));
    let mut cfg = TtsRuntimeConfig::new(dir.0.clone());
    cfg.piper.python_bin = dir.0.join("never-execute");
    cfg.kokoro.openrouter_url = format!("{}/kokoro", server.origin);
    cfg.fish.openrouter_url = format!("{}/fish-primary", server.origin);
    cfg.fish.fish_url = format!("{}/fish-direct", server.origin);
    cfg.catalog.endpoint = format!("{}/model", server.origin);
    let runtime = TtsRuntime::with_client(cfg, env(values.clone()), client());
    let cloned = runtime.clone();
    put(&values, "PIPER_HTTP_URL", &format!("{}///", server.origin));
    put(&values, "PUBLIC_API_URL", "http://old.test");
    let mut req = request(&dir.0);
    req.provider = TtsProvider::Fish; // Explicit function selection wins over this field.
    let task = spawn_synth(&runtime, None, &req);
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /synthesize HTTP/1.1");
    assert!(!r.headers.contains_key("authorization"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&r.body).unwrap(),
        serde_json::json!({"text":"Hello chat!","voice":"af_heart"})
    );
    // Hold the response body open, then change the URL before completion.
    let (started_tx, started_rx) = oneshot::channel();
    let (tail_tx, tail_rx) = oneshot::channel();
    send.send(Reply::Split {
        first: b"HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: 5\r\n\r\npi"
            .to_vec(),
        started: started_tx,
        rest: tail_rx,
    })
    .unwrap();
    timeout(WAIT, started_rx).await.unwrap().unwrap();
    put(&values, "PUBLIC_API_URL", "http://piper-new.test///");
    tail_tx.send(b"per".to_vec()).unwrap();
    assert_audio(
        &result(task).await,
        &dir.0,
        "wav",
        b"piper",
        "http://piper-new.test",
    );

    put(&values, "OPENROUTER_API_KEY", " kokoro-key ");
    req.provider = TtsProvider::Piper;
    let task = spawn_synth(&cloned, Some(TtsProvider::Kokoro), &req);
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /kokoro HTTP/1.1");
    auth(&r, "kokoro-key");
    let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"model":"hexgrad/kokoro-82m","input":"Hello chat!","voice":"af_heart","response_format":"mp3","user":"channel 1","provider":{"only":["deepinfra"],"order":["deepinfra"],"allow_fallbacks":false}})
    );
    put(&values, "PUBLIC_API_URL", "http://kokoro-new.test");
    send.send(Reply::Full(reply("200 OK", "audio/mpeg", b"kokoro")))
        .unwrap();
    assert_audio(
        &result(task).await,
        &dir.0,
        "mp3",
        b"kokoro",
        "http://kokoro-new.test",
    );

    put(&values, "OPENROUTER_API_KEY", " fish-primary-key ");
    req.voice = "voice".into();
    let task = spawn_synth(&runtime, Some(TtsProvider::Fish), &req);
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /fish-primary HTTP/1.1");
    auth(&r, "fish-primary-key");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&r.body).unwrap(),
        serde_json::json!({"model":"fish-audio/drama-3","input":"Hello chat!","voice":"voice","response_format":"mp3","user":"channel 1"})
    );
    put(&values, "PUBLIC_API_URL", "http://fish-new.test");
    send.send(Reply::Full(reply("200 OK", "audio/mpeg", b"fish-primary")))
        .unwrap();
    assert_audio(
        &result(task).await,
        &dir.0,
        "mp3",
        b"fish-primary",
        "http://fish-new.test",
    );

    // A failed single attempt must not start a direct Fish request.
    let task = spawn_synth(&cloned, Some(TtsProvider::Fish), &req);
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /fish-primary HTTP/1.1");
    auth(&r, "fish-primary-key");
    send.send(Reply::Full(reply("400 Bad Request", "text/plain", b"")))
        .unwrap();
    assert!(result(task).await.error);
    assert!(
        timeout(Duration::from_millis(100), server.received.recv())
            .await
            .is_err(),
        "single attempt triggered fallback"
    );

    put(&values, "OPENROUTER_API_KEY", " fish-next-key ");
    put(&values, "FISH_AUDIO_API_KEY", " old-fish-key ");
    req.single_attempt = false;
    let task = spawn_synth(&cloned, Some(TtsProvider::Fish), &req);
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /fish-primary HTTP/1.1");
    auth(&r, "fish-next-key");
    put(&values, "FISH_AUDIO_API_KEY", " fresh-fish-key ");
    send.send(Reply::Full(reply("400 Bad Request", "text/plain", b"")))
        .unwrap();
    let (r, send) = server.next().await;
    assert_eq!(r.line, "POST /fish-direct HTTP/1.1");
    auth(&r, "fresh-fish-key");
    assert_eq!(
        r.headers.get("content-type").map(String::as_str),
        Some("application/msgpack")
    );
    assert_eq!(r.headers.get("model").map(String::as_str), Some("s2.1-pro"));
    assert_eq!(
        r.body.as_slice(),
        b"\x83\xa4text\xabHello chat!\xacreference_id\xa5voice\xa6format\xa3mp3"
    );
    put(&values, "PUBLIC_API_URL", "http://fallback-new.test");
    send.send(Reply::Full(reply("200 OK", "audio/mpeg", b"fish-fallback")))
        .unwrap();
    assert_audio(
        &result(task).await,
        &dir.0,
        "mp3",
        b"fish-fallback",
        "http://fallback-new.test",
    );

    let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    put(&values, "FISH_AUDIO_API_KEY", " catalog-first ");
    let catalog = runtime.clone();
    let task = tokio::spawn(async move { catalog.get_fish_voice(id).await });
    let (r, send) = server.next().await;
    assert_eq!(r.line, format!("GET /model/{id} HTTP/1.1"));
    auth(&r, "catalog-first");
    send.send(Reply::Full(reply("200 OK", "application/json", br#"{"_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Fixture","type":"tts","visibility":"public"}"#))).unwrap();
    assert!(timeout(WAIT, task).await.unwrap().unwrap().is_ok());
    values.write().unwrap().remove("FISH_AUDIO_API_KEY");
    assert!(
        timeout(WAIT, cloned.get_fish_voice(id))
            .await
            .unwrap()
            .is_ok()
    );
    put(&values, "FISH_AUDIO_API_KEY", " catalog-second ");
    let catalog = cloned.clone();
    let query = search();
    let task = tokio::spawn(async move { catalog.search_fish_voices(&query).await });
    let (r, send) = server.next().await;
    assert_eq!(
        r.line,
        "GET /model?page_size=20&page_number=1&sort_by=score&title=fixture HTTP/1.1"
    );
    auth(&r, "catalog-second");
    send.send(Reply::Full(reply(
        "200 OK",
        "application/json",
        br#"{"items":[],"has_more":false}"#,
    )))
    .unwrap();
    assert!(timeout(WAIT, task).await.unwrap().unwrap().is_ok());
    values.write().unwrap().remove("FISH_AUDIO_API_KEY");
    assert!(
        timeout(WAIT, runtime.search_fish_voices(&search()))
            .await
            .unwrap()
            .is_ok()
    );
    server.finish().await;
}

#[tokio::test]
async fn catalog_cache_hit_does_not_lookup_key() {
    let dir = TempDir::new();
    let mut server = Server::new().await;
    let lookups = Arc::new(AtomicUsize::new(0));
    let count = lookups.clone();
    let env: Environment = Arc::new(move |name| {
        if name == "FISH_AUDIO_API_KEY" {
            count.fetch_add(1, Ordering::SeqCst);
            Some("catalog-key".into())
        } else {
            None
        }
    });
    let mut cfg = TtsRuntimeConfig::new(dir.0.clone());
    cfg.catalog.endpoint = format!("{}/model", server.origin);
    let runtime = TtsRuntime::with_client(cfg, env, client());
    let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let other = runtime.clone();
    let task = tokio::spawn(async move { other.get_fish_voice(id).await });
    let (r, send) = server.next().await;
    auth(&r, "catalog-key");
    send.send(Reply::Full(reply("200 OK", "application/json", br#"{"_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Fixture","type":"tts","visibility":"public"}"#))).unwrap();
    assert!(timeout(WAIT, task).await.unwrap().unwrap().is_ok());
    assert_eq!(lookups.load(Ordering::SeqCst), 1);
    assert!(
        timeout(WAIT, runtime.clone().get_fish_voice(id))
            .await
            .unwrap()
            .is_ok()
    );
    assert_eq!(
        lookups.load(Ordering::SeqCst),
        1,
        "cache hit must not read environment"
    );
    server.finish().await;
}

#[tokio::test]
async fn selected_services_defer_keys_and_piper_honors_cancellation() {
    let dir = TempDir::new();
    let runtime = runtime(Arc::new(RwLock::new(HashMap::new())), &dir.0);
    let (tx, signal) = tokio::sync::watch::channel(Some("cancelled".to_owned()));
    let mut request = request(&dir.0);
    request.signal = Some(signal);
    request.private_output = true;
    let piper = timeout(WAIT, runtime.synthesize(None, &request))
        .await
        .unwrap();
    assert!(piper.error);
    assert_eq!(piper.message, "cancelled");
    let kokoro = timeout(
        WAIT,
        runtime.synthesize(Some(TtsProvider::Kokoro), &request),
    )
    .await
    .unwrap();
    assert!(kokoro.error);
    assert_eq!(kokoro.message, "OpenRouter API key is not configured");
    drop(tx);
}

// This test consumes the independently generated actual-TypeScript VM oracle.
// It uses loopback and a task-owned CLI shim; it never contacts a provider.
#[tokio::test]
#[ignore = "requires dynamic TypeScript source oracle in TTS_RUNTIME_FIXTURE_DIR"]
async fn dynamic_source_replay() {
    use std::sync::Mutex;
    let fixture_dir =
        std::env::var("TTS_RUNTIME_FIXTURE_DIR").expect("TTS_RUNTIME_FIXTURE_DIR required");
    let bytes = std::fs::read(Path::new(&fixture_dir).join("tts_runtime_dynamic_reference.json"))
        .expect("dynamic source fixture required");
    assert!(!bytes.is_empty(), "empty dynamic source fixture");
    let document: serde_json::Value =
        serde_json::from_slice(&bytes).expect("valid dynamic source fixture");
    let cases = document["cases"].as_array().expect("fixture cases");
    assert_eq!(cases.len(), 7);
    let case = |name: &str| {
        cases
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("missing case {name}"))
    };
    let dir = TempDir::new();
    let mut server = Server::new().await;
    let values: Values = Arc::new(RwLock::new(HashMap::new()));
    let reads = Arc::new(Mutex::new(Vec::<String>::new()));
    let environment: Environment = {
        let values = values.clone();
        let reads = reads.clone();
        Arc::new(move |name| {
            reads.lock().unwrap().push(name.into());
            values.read().unwrap().get(name).cloned()
        })
    };
    let mut cfg = TtsRuntimeConfig::new(dir.0.clone());
    cfg.fish.openrouter_url = format!("{}/fish-primary", server.origin);
    cfg.fish.fish_url = format!("{}/fish-direct", server.origin);
    cfg.kokoro.openrouter_url = format!("{}/kokoro", server.origin);
    cfg.catalog.endpoint = format!("{}/model", server.origin);
    let runtime = TtsRuntime::with_client(cfg, environment, client());
    let mut req = request(&dir.0);
    put(&values, "OPENROUTER_API_KEY", " primary-key ");
    put(&values, "FISH_AUDIO_API_KEY", " old-fish-key ");
    put(&values, "PUBLIC_API_URL", "http://old.test");

    // The first response is held until the fixture key changes. The real Fish
    // SDK was mocked in the source oracle; native MessagePack is checked here.
    req.voice = "voice".into();
    req.single_attempt = false;
    let expected = case("fish-fallback");
    let task = spawn_synth(&runtime, Some(TtsProvider::Fish), &req);
    let (primary, send) = server.next().await;
    assert_eq!(
        primary.headers["authorization"],
        expected["requests"][0]["authorization"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&primary.body).unwrap(),
        expected["requests"][0]["body"]
    );
    put(&values, "FISH_AUDIO_API_KEY", " fresh-fish-key ");
    send.send(Reply::Full(reply("400 Bad Request", "text/plain", b"")))
        .unwrap();
    let (direct, send) = server.next().await;
    auth(&direct, expected["sdk"][0]["apiKey"].as_str().unwrap());
    assert_eq!(
        direct.headers["model"],
        expected["sdk"][0]["convert"]["backend"].as_str().unwrap()
    );
    assert_eq!(
        expected["sdk"][0]["convert"]["args"],
        serde_json::json!({"text":"Hello chat!","reference_id":"voice","format":"mp3"})
    );
    assert_eq!(
        direct.body.as_slice(),
        b"\x83\xa4text\xabHello chat!\xacreference_id\xa5voice\xa6format\xa3mp3"
    );
    put(&values, "PUBLIC_API_URL", "http://new.test///");
    send.send(Reply::Full(reply("200 OK", "audio/mpeg", &[1, 2, 3])))
        .unwrap();
    let actual = result(task).await;
    assert_eq!(
        actual.message,
        expected["outcome"]["message"].as_str().unwrap()
    );
    assert_eq!(
        actual.public_path.as_deref(),
        expected["outcome"]["publicPath"].as_str()
    );
    assert_eq!(
        std::fs::read(actual.output_path.unwrap()).unwrap(),
        [1, 2, 3]
    );
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);

    reads.lock().unwrap().clear();
    req.single_attempt = true;
    let expected = case("fish-single");
    let task = spawn_synth(&runtime, Some(TtsProvider::Fish), &req);
    let (primary, send) = server.next().await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&primary.body).unwrap(),
        expected["requests"][0]["body"]
    );
    send.send(Reply::Full(reply("400 Bad Request", "text/plain", b"")))
        .unwrap();
    let actual = result(task).await;
    assert!(actual.error);
    assert_eq!(
        actual.message,
        expected["outcome"]["message"].as_str().unwrap()
    );
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);

    reads.lock().unwrap().clear();
    req.voice = "af_heart".into();
    put(&values, "PUBLIC_API_URL", "http://old.test");
    let expected = case("kokoro-success");
    let task = spawn_synth(&runtime, Some(TtsProvider::Kokoro), &req);
    let (wire, send) = server.next().await;
    assert_eq!(
        wire.headers["authorization"],
        expected["requests"][0]["authorization"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&wire.body).unwrap(),
        expected["requests"][0]["body"]
    );
    put(&values, "PUBLIC_API_URL", "http://new.test///");
    send.send(Reply::Full(reply("200 OK", "audio/mpeg", &[1, 2, 3])))
        .unwrap();
    let actual = result(task).await;
    assert_eq!(
        actual.message,
        expected["outcome"]["message"].as_str().unwrap()
    );
    assert_eq!(
        actual.public_path.as_deref(),
        expected["outcome"]["publicPath"].as_str()
    );
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);
    reads.lock().unwrap().clear();
    values.write().unwrap().remove("OPENROUTER_API_KEY");
    let actual = runtime.synthesize(Some(TtsProvider::Kokoro), &req).await;
    let expected = case("kokoro-missing");
    assert!(actual.error);
    assert_eq!(
        actual.message,
        expected["outcome"]["message"].as_str().unwrap()
    );
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);

    reads.lock().unwrap().clear();
    let expected = case("catalog-sequence");
    put(&values, "FISH_AUDIO_API_KEY", " old-fish-key ");
    let first_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let other_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let catalog = runtime.clone();
    let task = tokio::spawn(async move { catalog.get_fish_voice(first_id).await });
    let (r, send) = server.next().await;
    assert_eq!(r.line, format!("GET /model/{first_id} HTTP/1.1"));
    assert_eq!(
        r.headers["authorization"],
        expected["requests"][0]["authorization"].as_str().unwrap()
    );
    send.send(Reply::Full(reply("200 OK", "application/json", br#"{"_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Fixture","type":"tts","visibility":"public"}"#))).unwrap();
    let first = timeout(WAIT, task).await.unwrap().unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&first.to_json_string()).unwrap(),
        expected["outcome"][0]
    );
    values.write().unwrap().remove("FISH_AUDIO_API_KEY");
    let hit = runtime.clone().get_fish_voice(first_id).await.unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&hit.to_json_string()).unwrap(),
        expected["outcome"][1]
    );
    put(&values, "FISH_AUDIO_API_KEY", " catalog-next ");
    let catalog = runtime.clone();
    let task = tokio::spawn(async move { catalog.get_fish_voice(other_id).await });
    let (r, send) = server.next().await;
    assert_eq!(r.line, format!("GET /model/{other_id} HTTP/1.1"));
    assert_eq!(
        r.headers["authorization"],
        expected["requests"][1]["authorization"].as_str().unwrap()
    );
    send.send(Reply::Full(reply("200 OK", "application/json", br#"{"_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","title":"Fixture","type":"tts","visibility":"public"}"#))).unwrap();
    let miss = timeout(WAIT, task).await.unwrap().unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&miss.to_json_string()).unwrap(),
        expected["outcome"][2]
    );
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);
    server.finish().await;

    // A fixture-owned executable stands in for the source's mocked spawn.
    // Translate only its synthetic executable path; compare all other CLI args.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = dir.0.join("fixture-python");
        let args_path = dir.0.join("cli-args");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '\\001\\002\\003' > \"$6\"\n",
                args_path.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let expected = case("piper-cli");
        let reads = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = reads.clone();
        let command = executable.to_string_lossy().into_owned();
        let output_dir = dir.0.join("cli-output");
        let directory_at_lookup = output_dir.clone();
        let environment: Environment = Arc::new(move |name| {
            seen.lock().unwrap().push(name.into());
            if name == "PIPER_HTTP_URL" {
                assert!(
                    directory_at_lookup.is_dir(),
                    "Piper selected HTTP before mkdir"
                );
            }
            match name {
                "PIPER_HTTP_URL" => Some("///".into()),
                "PIPER_DATA_DIR" => Some("  fixture-data  ".into()),
                "PIPER_PYTHON_BIN" => Some(command.clone()),
                _ => None,
            }
        });
        let runtime =
            TtsRuntime::with_client(TtsRuntimeConfig::new(dir.0.clone()), environment, client());
        let mut req = request(&dir.0);
        req.private_output = true;
        req.output_path = output_dir.join("output");
        let actual = runtime.synthesize(Some(TtsProvider::Piper), &req).await;
        assert_eq!(
            actual.error,
            expected["outcome"]["error"].as_bool().unwrap()
        );
        assert_eq!(
            actual.message,
            expected["outcome"]["message"].as_str().unwrap()
        );
        assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);
        assert_eq!(expected["processes"][0]["command"], " literal python ");
        let mut args: Vec<String> = std::fs::read_to_string(args_path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        args[5] = "/fixture/private/output".into();
        assert_eq!(serde_json::json!(args), expected["processes"][0]["args"]);
        assert_eq!(std::fs::read(req.output_path).unwrap(), [1, 2, 3]);
    }
    let expected = case("piper-http");
    let reads = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = reads.clone();
    let http_root = dir.0.join("http-output");
    let directory_at_lookup = http_root.join("channel 1");
    let environment: Environment = Arc::new(move |name| {
        seen.lock().unwrap().push(name.into());
        if name == "PIPER_HTTP_URL" {
            assert!(
                directory_at_lookup.is_dir(),
                "Piper selected HTTP before mkdir"
            );
        }
        (name == "PIPER_HTTP_URL").then(|| " ///".into())
    });
    let runtime = TtsRuntime::with_client(TtsRuntimeConfig::new(http_root), environment, client());
    let actual = runtime
        .synthesize(Some(TtsProvider::Piper), &request(&dir.0))
        .await;
    assert!(actual.error);
    assert!(expected["outcome"]["error"].as_bool().unwrap());
    assert_eq!(expected["requests"][0]["url"], " /synthesize");
    assert_eq!(serde_json::json!(*reads.lock().unwrap()), expected["reads"]);
}
