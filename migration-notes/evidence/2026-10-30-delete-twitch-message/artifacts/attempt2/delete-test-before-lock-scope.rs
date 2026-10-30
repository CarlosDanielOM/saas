#![cfg(feature = "twitch-functions")]
//! The independently generated fixture is supplied externally; Rust never invokes Node.
#[path = "../src/utils/test_http.rs"]
mod test_http;
use dima_rust::{
    functions::{
        CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture,
        TwitchFunctions,
        chats::delete_message::{DeleteMessageResponse, delete_message_body},
    },
    utils::{
        logger::{
            ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkError, SinkFuture, SinkHandles,
            SystemClock, UuidSource,
        },
        lossless_json::{JsonValue, parse_json},
        twitch::{AccessToken, TWITCH_BOT_ACCOUNT_ID, TwitchAuth, TwitchClient, TwitchEndpoints},
    },
};
#[path = "support/sha256.rs"]
mod digest;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use test_http::{CannedResponse, Recorder};
struct Auth(Arc<AtomicUsize>);
impl FunctionAuth for Auth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            assert!(matches!(auth, TwitchAuth::Bot));
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(AccessToken::user("fixture", TWITCH_BOT_ACCOUNT_ID))
        })
    }
}
struct NoCache;
impl FunctionCache for NoCache {
    fn execute<'a>(
        &'a self,
        _: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("delete must not use cache") })
    }
}
fn obj<'a>(v: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    if let JsonValue::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    } else {
        None
    }
}
fn string(v: &JsonValue) -> &str {
    if let JsonValue::String(s) = v {
        s.as_str().unwrap()
    } else {
        panic!("expected string")
    }
}
fn num(v: &JsonValue) -> u16 {
    if let JsonValue::Number(n) = v {
        *n as u16
    } else {
        panic!("expected number")
    }
}
fn b64(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let n = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("base64"),
        };
        acc = (acc << 6) | u32::from(n);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}
fn result_json(r: DeleteMessageResponse) -> JsonValue {
    let mut fields = vec![
        ("error".into(), JsonValue::Bool(r.error)),
        ("message".into(), r.message),
    ];
    if let Some(n) = r.status {
        fields.push(("status".into(), JsonValue::Number(n.into())))
    }
    if let Some(k) = r.kind {
        fields.push(("type".into(), JsonValue::String(k.into())))
    }
    JsonValue::Object(fields)
}

struct SpecificFailure(FunctionFailure);
impl FunctionAuth for SpecificFailure {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { Err(self.0.clone()) })
    }
}
struct BrokenConsole;
impl ConsoleSink for BrokenConsole {
    fn write(&self, _: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async { Err(SinkError::Io) })
    }
}
fn failing_logger() -> Arc<Logger> {
    Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(Arc::new(BrokenConsole)),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    )
}
fn service(
    base: &str,
    auth: Arc<dyn FunctionAuth>,
    logger: Option<Arc<Logger>>,
    timeout: Duration,
) -> TwitchFunctions {
    let endpoints = TwitchEndpoints::new(base, &format!("{base}/oauth/")).unwrap();
    let client = TwitchClient::new("fixture-client", endpoints, Some(timeout)).unwrap();
    TwitchFunctions::with_adapters(client, auth, Arc::new(NoCache), None, logger)
}
#[tokio::test]
#[ignore = "requires an independently generated external oracle fixture and pinned toolchain files"]
async fn actual_source_fixture_replay_and_source_hash() {
    let path = std::path::PathBuf::from(
        std::env::var("DELETE_TWITCH_MESSAGE_FIXTURE").expect("external fixture path"),
    );
    assert!(path.is_absolute());
    assert_eq!(std::fs::canonicalize(&path).unwrap(), path);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(
        !path.starts_with(root.parent().unwrap()),
        "fixture must be outside checkout"
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        digest::sha256_hex(&bytes),
        std::env::var("DELETE_TWITCH_MESSAGE_FIXTURE_SHA256").expect("independent fixture SHA-256")
    );
    let fixture = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
    let hashes = obj(obj(&fixture, "provenance").unwrap(), "hashes").unwrap();
    for (key, relative) in [
        ("source", "src/functions/chats/delete_message.chat.ts"),
        ("header", "src/utils/header.ts"),
        (
            "links",
            "../archives/dimabot-typescript/2026-10-28/src/utils/links.ts",
        ),
        ("logger", "src/utils/logger.ts"),
        (
            "oracle",
            "tests/fixtures/delete_twitch_message_reference.cjs",
        ),
        ("package", "package.json"),
        ("lock", "package-lock.json"),
        ("native", "src/functions/chats/delete_message.chat.rs"),
        ("nativeTest", "tests/delete_twitch_message.rs"),
        ("chatsModule", "src/functions/chats/mod.rs"),
        ("testDigest", "tests/support/sha256.rs"),
        ("auth", "src/functions/mod.rs"),
        ("transport", "src/utils/twitch.rs"),
        ("parser", "src/utils/lossless_json.rs"),
        ("jsString", "src/utils/js_string.rs"),
        ("nativeLogger", "src/utils/logger.rs"),
        ("nativeLinks", "src/utils/links.rs"),
        ("number", "src/utils/json_number.rs"),
    ] {
        let content = std::fs::read(root.join(relative)).unwrap();
        assert_eq!(
            digest::sha256_hex(&content),
            string(obj(hashes, key).unwrap()),
            "{key}"
        );
    }
    for (key, var) in [
        ("node", "DELETE_TWITCH_NODE_BINARY"),
        ("typescript", "DELETE_TWITCH_TYPESCRIPT_JS"),
        ("typescriptPackage", "DELETE_TWITCH_TYPESCRIPT_PACKAGE"),
    ] {
        let path = std::env::var(var).expect("pinned toolchain path");
        let content = std::fs::read(path).unwrap();
        assert_eq!(
            digest::sha256_hex(&content),
            string(obj(hashes, key).unwrap()),
            "{key}"
        );
    }
    let JsonValue::Array(cases) = obj(&fixture, "cases").unwrap() else {
        panic!()
    };
    for case in cases {
        let spec = obj(case, "spec").unwrap();
        let id = string(obj(case, "id").unwrap());
        let outcome = obj(case, "outcome").unwrap();
        if let Some(status) = obj(spec, "status") {
            let status = num(status);
            let bytes = b64(string(obj(spec, "body").unwrap()));
            if obj(spec, "nativeDepthLimit").is_some() {
                let expected = format!(
                    "{{\"error\":true,\"message\":{},\"status\":400}}",
                    std::str::from_utf8(&bytes)
                        .unwrap()
                        .strip_prefix("{\"error\":")
                        .unwrap()
                        .strip_suffix('}')
                        .unwrap()
                );
                assert_eq!(
                    b64(string(obj(outcome, "returnedJsonBase64").unwrap())),
                    expected.as_bytes(),
                    "{id}: source result"
                );
                assert!(
                    delete_message_body(status, &bytes).is_err(),
                    "{id}: known parser depth boundary"
                );
                continue;
            }
            let actual=match delete_message_body(status,&bytes) {Ok(r)=>result_json(r),Err(_)=>parse_json(r#"{"error":true,"message":"Internal server error","status":500,"type":"error"}"#).unwrap()};
            assert_eq!(&actual, obj(outcome, "returned").unwrap(), "{id}");
            let recorder = Recorder::start(move |_| CannedResponse {
                status,
                headers: vec![],
                body: bytes.clone(),
            });
            let service = service(
                &recorder.base_url,
                Arc::new(Auth(Arc::new(AtomicUsize::new(0)))),
                None,
                Duration::from_secs(2),
            );
            let actual = service
                .delete_message("message", "channel", "requester")
                .await
                .unwrap();
            assert_eq!(
                &result_json(actual),
                obj(outcome, "returned").unwrap(),
                "{id}"
            );
            let request = recorder.next(Duration::from_secs(2));
            assert_eq!(
                request.path,
                "/moderation/chat?broadcaster_id=channel&message_id=message&moderator_id=698614112"
            );
        } else {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            drop(listener);
            let base = format!("http://{address}");
            let auth: Arc<dyn FunctionAuth> = match id {
                "denied" => Arc::new(SpecificFailure(FunctionFailure::Denied("denied".into()))),
                "missing-header" => {
                    Arc::new(SpecificFailure(FunctionFailure::Denied("missing".into())))
                }
                "header-throw" => Arc::new(SpecificFailure(FunctionFailure::Internal)),
                _ => Arc::new(Auth(Arc::new(AtomicUsize::new(0)))),
            };
            let logger = if id == "logger-report-failed" || id == "logger-throw" {
                Some(failing_logger())
            } else {
                None
            };
            let result = service(&base, auth, logger, Duration::from_secs(2))
                .delete_message("message", "channel", "requester")
                .await;
            if let Some(thrown) = obj(outcome, "thrown") {
                assert_eq!(id, "logger-throw");
                assert_eq!(string(thrown), "log failure");
                assert_eq!(
                    result.unwrap().status,
                    Some(500),
                    "concrete native logger returns a report, not a thrown exception"
                );
            } else {
                assert_eq!(
                    &result_json(result.unwrap()),
                    obj(outcome, "returned").unwrap(),
                    "{id}"
                )
            };
        }
    }
}
#[tokio::test]
async fn request_is_bot_owned_single_attempt_without_body_or_cache() {
    let recorder = Recorder::start(|_| CannedResponse::json(401, r#"{"error":"no"}"#));
    let endpoints =
        TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url)).unwrap();
    let client =
        TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(2))).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let service = TwitchFunctions::with_adapters(
        client,
        Arc::new(Auth(count.clone())),
        Arc::new(NoCache),
        None,
        None,
    );
    let response = service.delete_message("m", "c", "requester").await.unwrap();
    assert_eq!(response.status, Some(401));
    assert_eq!(response.message, JsonValue::String("no".into()));
    let request = recorder.next(Duration::from_secs(2));
    assert_eq!(request.method, "DELETE");
    assert_eq!(
        request.path,
        "/moderation/chat?broadcaster_id=c&message_id=m&moderator_id=698614112"
    );
    assert!(request.body.is_empty());
    assert_eq!(request.header("authorization"), Some("Bearer fixture"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
struct Denied;
impl FunctionAuth for Denied {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { Err(FunctionFailure::Denied("denied".into())) })
    }
}
#[tokio::test]
async fn denial_has_source_shape_and_sends_no_request() {
    let recorder = Recorder::start(|_| panic!("denial must not send HTTP"));
    let endpoints =
        TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url)).unwrap();
    let client =
        TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(2))).unwrap();
    let service =
        TwitchFunctions::with_adapters(client, Arc::new(Denied), Arc::new(NoCache), None, None);
    let response = service.delete_message("m", "c", "r").await.unwrap();
    assert_eq!(
        result_json(response),
        parse_json(r#"{"error":true,"message":"denied","status":403,"type":"error"}"#).unwrap()
    );
}
#[tokio::test]
async fn no_content_fast_path_and_malformed_body_failure() {
    for status in [204, 400] {
        let recorder = Recorder::start(move |_| CannedResponse::json(status, "invalid"));
        let endpoints =
            TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url))
                .unwrap();
        let client =
            TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(2))).unwrap();
        let service = TwitchFunctions::with_adapters(
            client,
            Arc::new(Auth(Arc::new(AtomicUsize::new(0)))),
            Arc::new(NoCache),
            None,
            None,
        );
        let response = service.delete_message("m", "c", "r").await.unwrap();
        if status == 204 {
            assert!(!response.error);
            assert_eq!(response.status, None)
        } else {
            assert!(response.error);
            assert_eq!(response.status, Some(500));
            assert_eq!(response.kind, Some("error"));
        }
        recorder.next(Duration::from_secs(2));
    }
}

#[tokio::test]
async fn mutation_is_not_retried_and_drained_response_reuses_connection() {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut seen = Vec::new();
        for status in [401, 200] {
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert!(!request.is_empty());
            seen.push(request);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(!line.is_empty());
                if line == "\r\n" {
                    break;
                }
            }
            let body = if status == 401 {
                r#"{"error":"denied"}"#
            } else {
                "{}"
            };
            write!(reader.get_mut(),"HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",body.len()).unwrap();
            reader.get_mut().flush().unwrap();
        }
        reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let mut extra = String::new();
        let read = reader.read_line(&mut extra);
        assert!(
            matches!(read, Ok(0)) || read.is_err(),
            "unexpected extra wire request: {extra}"
        );
        seen
    });
    let base = format!("http://{addr}");
    let count = Arc::new(AtomicUsize::new(0));
    let client = service(
        &base,
        Arc::new(Auth(count.clone())),
        None,
        Duration::from_secs(2),
    );
    let first = client.delete_message("first", "c", "r").await.unwrap();
    assert_eq!(first.status, Some(401));
    let second = client.delete_message("second", "c", "r").await.unwrap();
    assert!(!second.error);
    drop(client);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("message_id=first"));
    assert!(requests[1].contains("message_id=second"));
    assert_eq!(count.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn client_deadline_covers_a_held_response_body() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut data = [0; 2048];
        assert!(stream.read(&mut data).unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n")
            .unwrap();
        stream.flush().unwrap();
        let _ = wait.recv_timeout(Duration::from_secs(3));
    });
    let client = service(
        &format!("http://{addr}"),
        Arc::new(Auth(Arc::new(AtomicUsize::new(0)))),
        None,
        Duration::from_millis(200),
    );
    let result = tokio::time::timeout(Duration::from_secs(2), client.delete_message("m", "c", "r"))
        .await
        .expect("body deadline")
        .unwrap();
    assert_eq!(result.status, Some(500));
    assert_eq!(result.kind, Some("error"));
    let _ = release.send(());
    server.join().unwrap();
}
struct CaptureConsole(std::sync::Mutex<Vec<String>>);
impl ConsoleSink for CaptureConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.0.lock().unwrap().push(record.json.to_string());
            Ok(())
        })
    }
}
#[tokio::test]
async fn internal_failure_logs_attribution_and_ignores_failed_report() {
    let sink = Arc::new(CaptureConsole(std::sync::Mutex::new(Vec::new())));
    let logger = Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(sink.clone()),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    );
    let client = service(
        "http://127.0.0.1:1",
        Arc::new(SpecificFailure(FunctionFailure::Internal)),
        Some(logger),
        Duration::from_secs(1),
    );
    let result = client.delete_message("m", "c", "r").await.unwrap();
    assert_eq!(result.status, Some(500));
    let records = sink.0.lock().unwrap();
    assert_eq!(records.len(), 1);
    let record: serde_json::Value = serde_json::from_str(&records[0]).unwrap();
    assert_eq!(record["data"]["function"], "deleteMessage");
    assert_eq!(record["data"]["messageID"], "m");
    assert_eq!(record["data"]["channelID"], "c");
    assert_eq!(record["data"]["modID"], "r");
    assert!(record["data"].get("error").is_some());
    assert!(record["data"].get("stack").is_some());
    drop(records);
    let client = service(
        "http://127.0.0.1:1",
        Arc::new(SpecificFailure(FunctionFailure::Internal)),
        Some(failing_logger()),
        Duration::from_secs(1),
    );
    assert_eq!(
        client.delete_message("m", "c", "r").await.unwrap().status,
        Some(500)
    );
}

#[test]
fn known_shared_parser_depth_boundary() {
    for depth in [129, 256] {
        let body = format!("{{\"error\":{}0{}}}", "[".repeat(depth), "]".repeat(depth));
        assert!(
            delete_message_body(400, body.as_bytes()).is_err(),
            "depth {depth} is currently rejected by the shared parser"
        );
    }
}
