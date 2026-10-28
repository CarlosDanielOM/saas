#![cfg(all(feature = "tts-services", unix))]

use dima_rust::{
    tts_services::{
        piper_tts::{PIPER_TIMEOUT, PiperConfig, PiperTtsService},
        speech_paths::SpeechPaths,
        tts_provider::{TtsMode, TtsSynthesisRequest, TtsSynthesisResult},
    },
    utils::{
        js_string::JsString,
        tts::{TtsLanguage, TtsProvider},
    },
};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{Instant, timeout},
};

const WAIT: Duration = Duration::from_secs(3);
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "piper-native-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn fixture(&self) -> PathBuf {
        self.executable(
            "python-fixture",
            include_str!("fixtures/piper_cli_fixture.sh"),
        )
    }
    fn executable(&self, name: &str, source: &str) -> PathBuf {
        let path = self.path().join(name);
        std::fs::write(&path, source).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.path());
    }
}

struct Task<T>(JoinHandle<T>);
impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn request(dir: &TempDir) -> TtsSynthesisRequest {
    TtsSynthesisRequest {
        channel_id: "channel".into(),
        speech_id: "speech".into(),
        mode: TtsMode::Speak,
        provider: TtsProvider::Piper,
        model: None,
        text: JsString::from("hello ; $(not-a-command)\nworld"),
        language: TtsLanguage::En,
        voice: JsString::from("capture"),
        output_path: dir.path().join("private/audio.wav"),
        clone_name: None,
        private_output: true,
        signal: None,
        max_audio_bytes: None,
        single_attempt: false,
    }
}

fn config(dir: &TempDir) -> PiperConfig {
    PiperConfig::new(SpeechPaths::new(
        dir.path().join("public"),
        Some("https://example.invalid/base///"),
        false,
    ))
}

fn cli(dir: &TempDir) -> PiperTtsService {
    let mut config = config(dir);
    config.python_bin = dir.fixture();
    PiperTtsService::new(config)
}

fn sidecar(output: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", output.display()))
}

async fn read_pid(output: &Path, suffix: &str) -> i32 {
    tokio::fs::read_to_string(sidecar(output, suffix))
        .await
        .unwrap()
        .parse()
        .unwrap()
}

async fn ready(output: &Path) {
    timeout(WAIT, async {
        while !sidecar(output, ".ready").exists() {
            // Fixture readiness only, never service synthesis pacing.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("fixture process becomes ready");
}

async fn stopped_and_reaped(root: i32, descendant: Option<i32>) {
    timeout(WAIT, async {
        loop {
            let root_gone = unsafe { libc::kill(root, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            let child_dead = descendant.is_none_or(|pid| {
                // An orphan zombie is dead and is owned by init for reaping.
                // The adapter deliberately does not install a global subreaper.
                std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|stat| {
                        stat.rsplit_once(") ")
                            .is_some_and(|(_, rest)| rest.starts_with('Z'))
                    })
                    .unwrap_or(true)
            });
            if root_gone && child_dead {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("owned root is reaped and descendants are no longer alive");
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(root, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD),
        "Tokio already reaped the owned root"
    );
}

#[tokio::test]
async fn cli_argv_is_literal_utf8_and_private_output_stays_private() {
    let dir = TempDir::new();
    let mut service = cli(&dir);
    service.config.data_dir = Some("\u{feff} /models with spaces \u{feff}".into());
    let mut request = request(&dir);
    request.text = JsString::from_units(vec![0xd800, 32, 36, 40, 120, 41, 10, 0xdc00]);
    request.voice = JsString::from_units(vec![0xd800, 39, 59, 32, 118]);
    let result = service.synthesize(&request).await;
    assert!(!result.error, "{result:?}");
    assert_eq!(service.name(), "piper");
    assert_eq!(service.config.timeout, PIPER_TIMEOUT);
    assert_eq!(result.message, "Speech synthesized with Piper CLI");
    assert_eq!(result.public_path, None);
    assert_eq!(result.output_path.as_ref(), Some(&request.output_path));
    assert_eq!(result.mime_type, Some("audio/wav"));
    assert_eq!(
        tokio::fs::read(&request.output_path).await.unwrap(),
        b"RIFFfixtureWAVE"
    );
    let args = tokio::fs::read(sidecar(&request.output_path, ".argv"))
        .await
        .unwrap();
    let args: Vec<_> = args
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8(part.to_vec()).unwrap())
        .collect();
    assert_eq!(
        args,
        vec![
            "-m".to_owned(),
            "piper".into(),
            "-m".into(),
            request.voice.to_utf8_lossy(),
            "-f".into(),
            request.output_path.display().to_string(),
            "--data-dir".into(),
            "/models with spaces".into(),
            "--".into(),
            request.text.to_utf8_lossy(),
        ]
    );
    stopped_and_reaped(read_pid(&request.output_path, ".pid").await, None).await;
}

#[tokio::test]
async fn cli_public_path_overrides_request_path_and_whitespace_url_uses_cli() {
    let dir = TempDir::new();
    let mut service = cli(&dir);
    service.config.http_url = Some("\u{feff}\n \t".into());
    service.config.data_dir = Some("\u{feff} \t".into());
    let mut request = request(&dir);
    request.private_output = false;
    request.channel_id = "a b".into();
    request.speech_id = "x?#".into();
    let result = service.synthesize(&request).await;
    assert!(!result.error, "{result:?}");
    let path = dir.path().join("public/a b/x?#.wav");
    assert_eq!(result.output_path, Some(path.clone()));
    assert_eq!(
        result.public_path.as_deref(),
        Some("https://example.invalid/base/speech/audio/a%20b/x%3F%23")
    );
    assert!(!request.output_path.exists());
    let argv = tokio::fs::read_to_string(sidecar(&path, ".argv"))
        .await
        .unwrap();
    assert!(!argv.contains("--data-dir"));
}

#[tokio::test]
async fn cli_drains_stderr_pressure_and_reports_empty_exit_or_signal() {
    let dir = TempDir::new();
    let service = cli(&dir);
    for (voice, ending) in [
        ("stderr", "STDERR-END"),
        ("exit-empty", "Piper CLI exited with code 9"),
        ("signal", "Piper CLI exited with code null"),
    ] {
        let mut request = request(&dir);
        request.voice = voice.into();
        let result = timeout(WAIT, service.synthesize(&request)).await.unwrap();
        assert!(result.error);
        assert!(result.message.ends_with(ending), "{result:?}");
        assert!(result.message.encode_utf16().count() <= 4096);
        assert_eq!(result.output_path, None);
        stopped_and_reaped(read_pid(&request.output_path, ".pid").await, None).await;
    }
}

#[tokio::test]
async fn cli_spawn_errors_are_explicit_and_no_output_is_claimed() {
    let dir = TempDir::new();
    let mut service = cli(&dir);
    service.config.python_bin = dir.path().join("missing-python");
    let result = service.synthesize(&request(&dir)).await;
    assert!(result.error);
    assert_eq!(
        result.message,
        format!(
            "Failed to start Piper CLI: spawn {} ENOENT",
            service.config.python_bin.display()
        )
    );
    let denied = dir.path().join("not-executable");
    std::fs::write(&denied, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o600)).unwrap();
    service.config.python_bin = denied;
    let result = service.synthesize(&request(&dir)).await;
    assert!(result.error);
    assert!(result.message.ends_with(" EACCES"), "{result:?}");
}

#[tokio::test]
async fn cli_size_limits_remove_oversized_files_and_preserve_zero_truthiness() {
    let dir = TempDir::new();
    let service = cli(&dir);
    for (limit, expected_error) in [(Some(2), true), (Some(0), false), (Some(15), false)] {
        let mut request = request(&dir);
        request.max_audio_bytes = limit;
        let result = service.synthesize(&request).await;
        assert_eq!(result.error, expected_error, "{result:?}");
        assert_eq!(request.output_path.exists(), !expected_error);
        if expected_error {
            assert_eq!(result.message, "Piper audio exceeds byte limit");
        }
    }
    let mut request = request(&dir);
    tokio::fs::remove_file(&request.output_path).await.unwrap();
    request.voice = "missing".into();
    request.max_audio_bytes = Some(1);
    let result = service.synthesize(&request).await;
    assert!(result.error);
    assert!(result.message.starts_with("ENOENT:"), "{result:?}");
    assert!(result.message.contains(", stat '"));
}

#[tokio::test]
async fn cli_cancel_and_timeout_kill_ignored_term_and_reap_owned_root() {
    for cancel in [false, true] {
        let dir = TempDir::new();
        let mut service = cli(&dir);
        service.config.timeout = if cancel {
            WAIT
        } else {
            Duration::from_millis(250)
        };
        let mut request = request(&dir);
        request.voice = "stubborn".into();
        let output = request.output_path.clone();
        let (sender, receiver) = watch::channel(None);
        request.signal = Some(receiver);
        let mut task = Task(tokio::spawn(
            async move { service.synthesize(&request).await },
        ));
        ready(&output).await;
        let root = read_pid(&output, ".pid").await;
        let descendant = read_pid(&output, ".child").await;
        if cancel {
            sender.send(Some("caller stopped Piper".into())).unwrap();
        }
        let result = timeout(WAIT, &mut task.0).await.unwrap().unwrap();
        assert!(result.error);
        assert_eq!(
            result.message,
            if cancel {
                "caller stopped Piper"
            } else {
                "Piper TTS timed out"
            }
        );
        stopped_and_reaped(root, Some(descendant)).await;
    }
}

#[tokio::test]
async fn cli_future_abandonment_and_successful_roots_leave_no_live_descendants() {
    for abandon in [false, true] {
        let dir = TempDir::new();
        let service = cli(&dir);
        let mut request = request(&dir);
        request.voice = if abandon { "stubborn" } else { "descendant" }.into();
        let output = request.output_path.clone();
        let mut task = Task(tokio::spawn(
            async move { service.synthesize(&request).await },
        ));
        if abandon {
            ready(&output).await;
        } else {
            let result = timeout(WAIT, &mut task.0).await.unwrap().unwrap();
            assert!(!result.error, "{result:?}");
        }
        let root = read_pid(&output, ".pid").await;
        let descendant = read_pid(&output, ".child").await;
        if abandon {
            task.0.abort();
            assert!(
                (&mut task.0)
                    .await
                    .as_ref()
                    .is_err_and(|error| error.is_cancelled())
            );
        }
        stopped_and_reaped(root, Some(descendant)).await;
    }
}

#[derive(Debug)]
struct Received {
    line: String,
    headers: BTreeMap<String, String>,
    body: String,
}
async fn read_request(socket: &mut TcpStream) -> Received {
    let mut data = Vec::new();
    let (end, length) = loop {
        if let Some(pos) = data.windows(4).position(|part| part == b"\r\n\r\n") {
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
        let mut buf = [0u8; 1024];
        let n = socket.read(&mut buf).await.unwrap();
        assert_ne!(n, 0);
        data.extend_from_slice(&buf[..n]);
    };
    while data.len() < end + length {
        let mut buf = [0u8; 1024];
        let n = socket.read(&mut buf).await.unwrap();
        assert_ne!(n, 0);
        data.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&data[..end]);
    let mut lines = head.lines();
    let line = lines.next().unwrap().to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Received {
        line,
        headers,
        body: String::from_utf8(data[end..end + length].to_vec()).unwrap(),
    }
}

enum Reply {
    Bytes(Vec<u8>),
    HoldHeaders,
    HoldBody(Vec<u8>),
    DelayedBody {
        header_delay: Duration,
        body_delay: Duration,
    },
}
struct Server {
    url: String,
    received: mpsc::UnboundedReceiver<Received>,
    task: JoinHandle<()>,
}
impl Server {
    async fn start(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sender, received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let _ = sender.send(request);
            match reply {
                Reply::Bytes(bytes) => {
                    let _ = socket.write_all(&bytes).await;
                }
                Reply::HoldHeaders => {
                    std::future::pending::<()>().await;
                }
                Reply::HoldBody(headers) => {
                    let _ = socket.write_all(&headers).await;
                    std::future::pending::<()>().await;
                }
                Reply::DelayedBody {
                    header_delay,
                    body_delay,
                } => {
                    tokio::time::sleep(header_delay).await;
                    if socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                        )
                        .await
                        .is_ok()
                    {
                        tokio::time::sleep(body_delay).await;
                        let _ = socket.write_all(b"x").await;
                    }
                }
            }
        });
        Self {
            url,
            received,
            task,
        }
    }
    async fn received(&mut self) -> Received {
        timeout(WAIT, self.received.recv()).await.unwrap().unwrap()
    }
    async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn response(status: u16, mime: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
fn http(dir: &TempDir, url: &str) -> PiperTtsService {
    let mut config = config(dir);
    config.http_url = Some(format!("{url}///"));
    // Any accidental CLI fallback fails this fixture without a real engine.
    config.python_bin = dir.path().join("never-run-real-python");
    PiperTtsService::new(config)
}

#[tokio::test]
async fn http_posts_lossless_utf16_and_accepts_empty_and_arbitrary_mime() {
    for (status, mime, audio) in [
        (200, "text/plain", b"xyz".as_slice()),
        (200, "", b"".as_slice()),
        (204, "audio/wav", b"".as_slice()),
    ] {
        let dir = TempDir::new();
        let mut server = Server::start(Reply::Bytes(response(status, mime, audio))).await;
        let service = http(&dir, &server.url);
        let mut request = request(&dir);
        request.text = JsString::from_units(vec![0xd800, 34, 10]);
        request.voice = JsString::from_units(vec![0xdc00, 92]);
        let result = service.synthesize(&request).await;
        assert!(!result.error, "{result:?}");
        assert_eq!(result.mime_type, Some("audio/wav"));
        assert_eq!(tokio::fs::read(&request.output_path).await.unwrap(), audio);
        let received = server.received().await;
        assert_eq!(received.line, "POST /synthesize HTTP/1.1");
        assert_eq!(
            received.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(
            received.body,
            format!(
                "{{\"text\":{},\"voice\":{}}}",
                request.text.to_json_string(),
                request.voice.to_json_string()
            )
        );
        server.stop().await;
    }
}

#[tokio::test]
async fn http_limits_are_checked_before_write_including_zero_and_chunked_bodies() {
    for limit in [0, 2, 3] {
        let dir = TempDir::new();
        let server = Server::start(Reply::Bytes(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n".to_vec())).await;
        let service = http(&dir, &server.url);
        let mut request = request(&dir);
        request.max_audio_bytes = Some(limit);
        let result = service.synthesize(&request).await;
        assert_eq!(result.error, limit < 3, "{result:?}");
        assert_eq!(request.output_path.exists(), limit == 3);
        if limit < 3 {
            assert_eq!(result.message, "TTS audio exceeds byte limit");
        }
        server.stop().await;
    }
}

#[tokio::test]
async fn http_status_public_reads_text_and_private_discards_a_stalled_body() {
    for (private, body, expected) in [
        (false, "upstream details", "upstream details"),
        (false, "", "Piper HTTP synthesis failed with 400"),
        (
            true,
            "private provider detail",
            "Piper HTTP synthesis failed with 400",
        ),
    ] {
        let dir = TempDir::new();
        let server =
            Server::start(Reply::Bytes(response(400, "text/plain", body.as_bytes()))).await;
        let service = http(&dir, &server.url);
        let mut request = request(&dir);
        request.private_output = private;
        let result = service.synthesize(&request).await;
        assert!(result.error);
        assert_eq!(result.message, expected);
        assert_eq!(result.output_path, None);
        server.stop().await;
    }
    let dir = TempDir::new();
    let server = Server::start(Reply::HoldBody(
        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 99999\r\n\r\n".to_vec(),
    ))
    .await;
    let service = http(&dir, &server.url);
    let result = timeout(
        Duration::from_millis(500),
        service.synthesize(&request(&dir)),
    )
    .await
    .expect("private status does not await error body");
    assert_eq!(result.message, "Piper HTTP synthesis failed with 403");
    server.stop().await;

    let dir = TempDir::new();
    let server = Server::start(Reply::Bytes(response(
        500,
        "text/plain",
        &vec![b'x'; 1024 * 1024 + 1],
    )))
    .await;
    let service = http(&dir, &server.url);
    let mut request = request(&dir);
    request.private_output = false;
    let result = service.synthesize(&request).await;
    assert!(result.error);
    assert_eq!(
        result.message,
        "Piper HTTP error response exceeds byte limit"
    );
    server.stop().await;
}

#[tokio::test]
async fn http_deadline_covers_headers_body_and_one_combined_budget() {
    for reply in [
        Reply::HoldHeaders,
        Reply::HoldBody(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n".to_vec()),
        Reply::DelayedBody {
            header_delay: Duration::from_millis(110),
            body_delay: Duration::from_millis(110),
        },
    ] {
        let dir = TempDir::new();
        let server = Server::start(reply).await;
        let mut service = http(&dir, &server.url);
        service.config.timeout = Duration::from_millis(180);
        let request = request(&dir);
        let started = Instant::now();
        let result = timeout(WAIT, service.synthesize(&request)).await.unwrap();
        assert!(result.error, "{result:?}");
        assert_eq!(result.message, "Piper TTS timed out");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!request.output_path.exists());
        server.stop().await;
    }
}

#[tokio::test]
async fn http_cancellation_interrupts_pending_headers_or_body_and_preabort_has_no_side_effects() {
    for body in [false, true] {
        let dir = TempDir::new();
        let mut server = Server::start(if body {
            Reply::HoldBody(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n".to_vec())
        } else {
            Reply::HoldHeaders
        })
        .await;
        let service = http(&dir, &server.url);
        let mut request = request(&dir);
        let output = request.output_path.clone();
        let (sender, receiver) = watch::channel(None);
        request.signal = Some(receiver);
        let mut task = Task(tokio::spawn(
            async move { service.synthesize(&request).await },
        ));
        server.received().await;
        sender.send(Some("fixture cancelled".into())).unwrap();
        let result = timeout(WAIT, &mut task.0).await.unwrap().unwrap();
        assert_eq!(result.message, "fixture cancelled");
        assert!(!output.exists());
        server.stop().await;
    }
    let dir = TempDir::new();
    let service = cli(&dir);
    let mut request = request(&dir);
    let (_sender, receiver) = watch::channel(Some("already aborted".into()));
    request.signal = Some(receiver);
    let result = service.synthesize(&request).await;
    assert_eq!(result.message, "already aborted");
    assert!(!request.output_path.parent().unwrap().exists());
}

#[tokio::test]
async fn output_directory_and_write_errors_are_reported_without_success_fields() {
    let dir = TempDir::new();
    let service = cli(&dir);
    std::fs::write(dir.path().join("private"), b"file blocks directory").unwrap();
    let result = service.synthesize(&request(&dir)).await;
    assert!(result.error);
    assert!(result.message.starts_with("EEXIST:") || result.message.starts_with("ENOTDIR:"));
    assert_eq!(result.output_path, None);
    std::fs::remove_file(dir.path().join("private")).unwrap();
    let server = Server::start(Reply::Bytes(response(200, "audio/wav", b"a"))).await;
    let service = http(&dir, &server.url);
    let mut request = request(&dir);
    std::fs::create_dir_all(&request.output_path).unwrap();
    request.private_output = true;
    let result = service.synthesize(&request).await;
    assert!(result.error);
    assert!(result.message.starts_with("EISDIR:"), "{result:?}");
    assert_eq!(result.output_path, None);
    server.stop().await;
}

fn unhex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let pair = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(pair, 16).unwrap()
        })
        .collect()
}
fn units(value: &serde_json::Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
fn normalized_path(path: &Path, dir: &TempDir) -> String {
    path.to_string_lossy()
        .replace(dir.path().to_str().unwrap(), "<fixture-dir>")
}
fn normalized_result(result: &TtsSynthesisResult, dir: &TempDir) -> serde_json::Value {
    let mut json = serde_json::json!({"error":result.error,"message":result.message});
    if let Some(path) = &result.output_path {
        json["outputPath"] = normalized_path(path, dir).into();
    }
    if let Some(path) = &result.public_path {
        json["publicPath"] = path.clone().into();
    }
    if let Some(mime) = result.mime_type {
        json["mimeType"] = mime.into();
    }
    json
}
fn shell_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut escaped = String::new();
    for byte in bytes {
        // Octal escapes avoid shell interpolation, even for arbitrary audio.
        write!(escaped, "\\{byte:03o}").unwrap();
    }
    escaped
}

/// Generate with the actual TypeScript source oracle in an isolated Node
/// container, then set PIPER_KOKORO_FIXTURE_DIR to its output directory.
/// All 20 Piper cases run through the concrete native adapters. Nineteen have
/// exact normalized result/file parity; the source's arbitrary injected spawn
/// error is compared as a typed failure category against real native ENOENT.
#[tokio::test]
#[ignore = "requires parent-generated actual-source PIPER_KOKORO_FIXTURE_DIR JSON"]
async fn replay_piper_source_fixture() {
    let fixture = PathBuf::from(
        std::env::var_os("PIPER_KOKORO_FIXTURE_DIR")
            .expect("set PIPER_KOKORO_FIXTURE_DIR to the actual-source fixture directory"),
    )
    .join("piper-kokoro-reference.json");
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    assert_eq!(document["schema"], 1);
    assert!(
        document["provenance"]["sourceHashes"]["src/server/services/tts/piper_tts.service.ts"]
            .as_str()
            .is_some()
    );
    let cases = document["cases"].as_array().unwrap();
    let mut count = 0;
    let mut exact = 0;
    let mut spawn_category = 0;
    for case in cases.iter().filter(|case| case["provider"] == "piper") {
        let name = case["name"].as_str().unwrap();
        let dir = TempDir::new();
        let input = &case["input"];
        let settings = &case["configuration"];
        let mut request = request(&dir);
        request.text = units(&input["textUnits"]);
        request.voice = units(&input["voiceUnits"]);
        request.channel_id = input["channelID"].as_str().unwrap().into();
        request.speech_id = input["speechID"].as_str().unwrap().into();
        request.output_path = input["outputPath"]
            .as_str()
            .unwrap()
            .replace("<fixture-dir>", dir.path().to_str().unwrap())
            .into();
        request.private_output = input["privateOutput"].as_bool().unwrap();
        request.max_audio_bytes = input["maxAudioBytes"]
            .as_u64()
            .map(|limit| usize::try_from(limit).unwrap());
        let (_signal_sender, signal_receiver) = watch::channel(
            input["preabort"]
                .as_bool()
                .unwrap()
                .then(|| "fixture abort".into()),
        );
        request.signal = Some(signal_receiver);
        let mut config = PiperConfig::new(SpeechPaths::new(
            dir.path().join("source/server/routes/public/speech"),
            settings["publicApiUrl"].as_str(),
            settings["nodeEnv"] == "production",
        ));
        config.data_dir = settings["dataDir"].as_str().map(str::to_owned);
        let http_url = settings["http"]
            .as_str()
            .filter(|url| !dima_rust::utils::js_compat::trim(url).is_empty());
        let mut server = if http_url.is_some() {
            let reply = case["responses"].as_array().unwrap().first().map_or(
                Reply::HoldHeaders,
                |response_spec| {
                    let body = response_spec["bodyHex"]
                        .as_str()
                        .map(unhex)
                        .unwrap_or_default();
                    let mime = response_spec["headers"]["content-type"]
                        .as_str()
                        .unwrap_or("");
                    Reply::Bytes(response(
                        response_spec["status"].as_u64().unwrap() as u16,
                        mime,
                        &body,
                    ))
                },
            );
            Some(Server::start(reply).await)
        } else {
            None
        };
        if let Some(server) = &server {
            config.http_url = Some(
                http_url
                    .unwrap()
                    .replace("https://piper.fixture", &server.url),
            );
            config.python_bin = dir.path().join("must-not-run-cli");
        } else {
            config.http_url = settings["http"].as_str().map(str::to_owned);
            let process = case["processes"].as_array().unwrap().first().unwrap();
            let command = process["command"].as_str().unwrap();
            assert_eq!(
                command,
                settings["bin"]
                    .as_str()
                    .filter(|bin| !bin.is_empty())
                    .unwrap_or("python3")
            );
            if process["event"] == "error" {
                config.python_bin = dir.path().join("missing-executable");
            } else {
                let stderr = unhex(process["stderrHex"].as_str().unwrap());
                let audio = if name == "piper-cli-oversize" {
                    vec![1, 2, 3]
                } else {
                    case["files"]
                        .as_array()
                        .unwrap()
                        .first()
                        .map(|file| unhex(file["hex"].as_str().unwrap()))
                        .unwrap_or_default()
                };
                let body = if process["event"] == "success" {
                    format!("printf '%b' '{}' > \"$6\"\n", shell_bytes(&audio))
                } else {
                    String::new()
                };
                let code = if process["event"] == "success" {
                    0
                } else if name == "piper-cli-exit" {
                    7
                } else {
                    1
                };
                let script = format!(
                    "#!/bin/sh\nset -eu\nprintf '%s\\000' \"$@\" > \"$6.argv\"\nprintf '%s' \"$$\" > \"$6.pid\"\nprintf '%b' '{}' >&2\n{body}exit {code}\n",
                    shell_bytes(&stderr),
                );
                config.python_bin = dir.executable(command, &script);
            }
        }
        let service = PiperTtsService::new(config);
        let result = timeout(WAIT, service.synthesize(&request)).await.unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(case["outcomeJson"].as_str().unwrap()).unwrap();
        if name == "piper-cli-error" {
            assert!(
                expected["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("Failed to start Piper CLI:")
            );
            assert!(result.error);
            assert!(result.message.starts_with("Failed to start Piper CLI:"));
            assert!(result.message.ends_with(" ENOENT"));
            assert_eq!(result.output_path, None);
            assert_eq!(result.public_path, None);
            assert_eq!(result.mime_type, None);
            spawn_category += 1;
        } else {
            assert_eq!(normalized_result(&result, &dir), expected, "{name}");
            exact += 1;
        }
        let expected_files = case["files"].as_array().unwrap();
        let output = if request.private_output {
            request.output_path.clone()
        } else {
            service
                .config
                .paths
                .output_dir(&request.channel_id)
                .join(format!("{}.wav", request.speech_id))
        };
        if let Some(file) = expected_files.first() {
            assert_eq!(
                normalized_path(&output, &dir),
                file["path"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                tokio::fs::read(&output).await.unwrap(),
                unhex(file["hex"].as_str().unwrap()),
                "{name}"
            );
        } else {
            assert!(!output.exists(), "{name}: no audio file expected");
        }
        if let Some(server) = &mut server {
            let expected_requests = case["requests"].as_array().unwrap();
            if let Some(expected_request) = expected_requests.first() {
                let received = server.received().await;
                let raw_url = expected_request["url"]
                    .as_str()
                    .unwrap()
                    .replace("https://piper.fixture", &server.url);
                // The oracle captures fetch's argument before URL parsing.
                // Compare actual parser semantics for its leading/trailing-space
                // case rather than pretending raw spaces can exist on the wire.
                let parsed = reqwest::Url::parse(&raw_url).unwrap();
                assert_eq!(
                    received.line,
                    format!("POST {} HTTP/1.1", parsed.path()),
                    "{name}"
                );
                assert_eq!(
                    received.body,
                    expected_request["body"].as_str().unwrap(),
                    "{name}"
                );
                for (header, expected) in expected_request["headers"].as_object().unwrap() {
                    assert_eq!(
                        received.headers.get(header).map(String::as_str),
                        expected.as_str(),
                        "{name}: {header}"
                    );
                }
            } else {
                assert!(
                    server.received.try_recv().is_err(),
                    "{name}: no provider request expected"
                );
            }
        } else if name != "piper-cli-error" {
            let argv = tokio::fs::read(sidecar(&output, ".argv")).await.unwrap();
            let actual: Vec<String> = argv
                .split(|byte| *byte == 0)
                .take_while(|arg| !arg.is_empty())
                .map(|arg| {
                    String::from_utf8(arg.to_vec())
                        .unwrap()
                        .replace(dir.path().to_str().unwrap(), "<fixture-dir>")
                })
                .collect();
            let process = &case["processes"][0];
            let expected: Vec<_> = process["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap())
                .collect();
            assert_eq!(actual, expected, "{name}");
            assert_eq!(process["timeoutMs"], PIPER_TIMEOUT.as_millis() as u64);
            assert_eq!(
                process["stdio"],
                serde_json::json!(["ignore", "ignore", "pipe"])
            );
            assert!(process["stdinHex"].is_null());
            stopped_and_reaped(read_pid(&output, ".pid").await, None).await;
        }
        if let Some(server) = server {
            server.stop().await;
        }
        count += 1;
    }
    assert_eq!((count, exact, spawn_category), (20, 19, 1));
}
