#![cfg(feature = "ast-bot-runtime")]
//! Native `sendAnnouncement` checks for `functions/chats/announcement.chat.rs`.
//!
//! Lean tests build requests and decode bodies in memory. The ignored tests
//! need an integration execution lease: one binds `127.0.0.1` and drives the
//! native Helix client, and one reads the JSON oracle written by
//! `tests/fixtures/announcement_chat_reference.cjs`. Neither contacts Twitch.
//!
//! `dima_rust::functions` is behind the `twitch-functions` feature, and this
//! module is not declared until the central `chats/mod.rs` patch. Enabling
//! `ast-bot-runtime` without both makes this target fail to compile.

#[path = "../src/utils/test_http.rs"]
mod test_http;
#[path = "support/sha256.rs"]
mod digest;

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use dima_rust::{
    functions::{
        CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture,
        TwitchFunctions,
        chats::announcement::{
            AnnouncementFailure, announcement_body, announcement_body_json, announcement_color,
            announcement_denied, announcement_internal_error, announcement_request,
            announcement_success,
        },
    },
    utils::{
        links::get_twitch_helix_url,
        logger::{
            ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
            UuidSource,
        },
        twitch::{AccessToken, TWITCH_BOT_ACCOUNT_ID, TwitchAuth, TwitchClient, TwitchEndpoints},
    },
};
use test_http::{CannedResponse, Recorder};

struct CountingAuth(Arc<AtomicUsize>);

impl FunctionAuth for CountingAuth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            assert!(
                matches!(auth, TwitchAuth::Bot),
                "announcements authenticate as the bot"
            );
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(AccessToken::user("fixture", TWITCH_BOT_ACCOUNT_ID))
        })
    }
}

struct DeniedAuth(String);

impl FunctionAuth for DeniedAuth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            assert!(matches!(auth, TwitchAuth::Bot));
            Err(FunctionFailure::Denied(self.0.clone()))
        })
    }
}

struct InternalAuth;

impl FunctionAuth for InternalAuth {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { Err(FunctionFailure::Internal) })
    }
}

struct NoCache;

impl FunctionCache for NoCache {
    fn execute<'a>(
        &'a self,
        _: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("sendAnnouncement must not use the cache") })
    }
}

fn service(
    base: &str,
    auth: Arc<dyn FunctionAuth>,
    logger: Option<Arc<Logger>>,
) -> TwitchFunctions {
    let endpoints = TwitchEndpoints::new(base, &format!("{base}/oauth/")).unwrap();
    let client = TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(2))).unwrap();
    TwitchFunctions::with_adapters(client, auth, Arc::new(NoCache), None, logger)
}

struct CaptureConsole(std::sync::Mutex<Vec<String>>);

impl ConsoleSink for CaptureConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(record.json.to_string());
            Ok(())
        })
    }
}

fn capture_logger() -> (Arc<Logger>, Arc<CaptureConsole>) {
    let sink = Arc::new(CaptureConsole(std::sync::Mutex::new(Vec::new())));
    let logger = Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(sink.clone()),
                ..SinkHandles::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    );
    (logger, sink)
}

#[test]
fn decodes_204_success_and_ignores_body() {
    let response = announcement_body(204, b"not-json").unwrap();
    assert_eq!(response, announcement_success());
    assert!(!response.error);
    assert_eq!(response.message, "Announcement sent");
    assert_eq!(response.status, None);
    assert_eq!(response.type_name, None);
    assert_eq!(
        response.to_json_string(),
        r#"{"error":false,"message":"Announcement sent"}"#
    );
}

#[test]
fn decodes_error_body_message_status_and_type() {
    let response = announcement_body(
        400,
        br#"{"error":"Bad Request","status":999,"message":"message is too long"}"#,
    )
    .unwrap();
    assert!(response.error);
    assert_eq!(response.message, "message is too long");
    assert_eq!(response.status, Some(400));
    assert_eq!(response.type_name.as_deref(), Some("Bad Request"));
    assert_eq!(
        response.to_json_string(),
        r#"{"error":true,"message":"message is too long","status":400,"type":"Bad Request"}"#
    );

    let spaced = announcement_body(422, br#"{"message":"  hi  ","error":"x"}"#).unwrap();
    assert_eq!(spaced.message, "  hi  ");
    assert_eq!(spaced.type_name.as_deref(), Some("x"));
}

#[test]
fn missing_or_empty_message_falls_back_and_non_json_is_typed() {
    let missing = announcement_body(401, br#"{"error":"Unauthorized"}"#).unwrap();
    assert_eq!(missing.message, "Failed to send announcement");
    assert_eq!(missing.status, Some(401));
    assert_eq!(missing.type_name.as_deref(), Some("Unauthorized"));
    assert_eq!(
        missing.to_json_string(),
        r#"{"error":true,"message":"Failed to send announcement","status":401,"type":"Unauthorized"}"#
    );

    let empty = announcement_body(400, br#"{"message":"","error":"Bad Request"}"#).unwrap();
    assert_eq!(empty.message, "Failed to send announcement");
    assert_eq!(empty.type_name.as_deref(), Some("Bad Request"));

    let object = announcement_body(422, b"{}").unwrap();
    assert_eq!(object.message, "Failed to send announcement");
    assert_eq!(object.type_name, None);
    assert_eq!(object.status, Some(422));
    assert_eq!(
        object.to_json_string(),
        r#"{"error":true,"message":"Failed to send announcement","status":422}"#
    );

    let array = announcement_body(400, b"[]").unwrap();
    assert_eq!(array.message, "Failed to send announcement");
    assert_eq!(array.type_name, None);
    let text = announcement_body(400, br#""hello""#).unwrap();
    assert_eq!(text.message, "Failed to send announcement");

    let invalid = announcement_body(500, b"<html>").unwrap_err();
    assert!(matches!(invalid, AnnouncementFailure::InvalidJson(_)));
    assert!(
        invalid
            .to_string()
            .starts_with("Invalid JSON response body")
    );
    let null_body = announcement_body(400, b"null").unwrap_err();
    assert_eq!(null_body, AnnouncementFailure::NullPropertyAccess);
    assert_eq!(
        null_body.to_string(),
        "Cannot read properties of null (reading 'message')"
    );
}

#[test]
fn request_pairs_bot_moderator_with_message_and_color() {
    let request = announcement_request("channel-1", "hello", "purple");
    assert_eq!(request.endpoint, "chat/announcements");
    assert_eq!(
        request.params,
        format!("broadcaster_id=channel-1&moderator_id={TWITCH_BOT_ACCOUNT_ID}")
    );
    assert!(!request.params.contains("mod-9"));
    assert_eq!(request.body["message"], "hello");
    assert_eq!(request.body["color"], "purple");
    assert_eq!(
        request.body_json,
        r#"{"message":"hello","color":"purple"}"#
    );
    assert_eq!(
        request.url,
        get_twitch_helix_url("chat/announcements", Some(&request.params))
    );
    assert_eq!(
        request.url,
        format!(
            "https://api.twitch.tv/helix/chat/announcements?broadcaster_id=channel-1&moderator_id={TWITCH_BOT_ACCOUNT_ID}"
        )
    );

    assert_eq!(announcement_color(None), "purple");
    assert_eq!(announcement_color(Some("")), "");
    assert_eq!(announcement_color(Some("blue")), "blue");
    let explicit = announcement_request("channel-2", "too long", announcement_color(Some("blue")));
    assert_eq!(explicit.body["message"], "too long");
    assert_eq!(explicit.body["color"], "blue");
    assert_eq!(
        explicit.params,
        format!("broadcaster_id=channel-2&moderator_id={TWITCH_BOT_ACCOUNT_ID}")
    );
    let blank = announcement_request("channel-2", "m", announcement_color(Some("")));
    assert_eq!(blank.body_json, r#"{"message":"m","color":""}"#);
}

#[test]
fn body_json_preserves_source_order_and_escapes() {
    assert_eq!(
        announcement_body_json("say \"hi\"\n", "purple"),
        "{\"message\":\"say \\\"hi\\\"\\n\",\"color\":\"purple\"}"
    );
    assert!(announcement_body_json("hello", "blue").starts_with("{\"message\":"));
}

#[test]
fn source_response_json_matches_status_messages_and_type() {
    assert_eq!(
        announcement_success().to_json_string(),
        r#"{"error":false,"message":"Announcement sent"}"#
    );
    assert_eq!(
        announcement_denied("Bot's account does not have the permissions required").to_json_string(),
        r#"{"error":true,"message":"Bot's account does not have the permissions required","status":403,"type":"error"}"#
    );
    assert_eq!(
        announcement_internal_error().to_json_string(),
        r#"{"error":true,"message":"Internal server error","status":500,"type":"error"}"#
    );
}

#[test]
fn failure_display_implements_error() {
    let cases = [
        AnnouncementFailure::Denied("denied".to_owned()),
        AnnouncementFailure::InvalidJson("Invalid JSON response body (eof)".to_owned()),
        AnnouncementFailure::NullPropertyAccess,
        AnnouncementFailure::UnreadableBody,
        AnnouncementFailure::Cancelled,
        AnnouncementFailure::AuthUnavailable,
        AnnouncementFailure::Transport("Twitch connection interrupted".to_owned()),
    ];
    for error in cases {
        let text = error.to_string();
        assert!(!text.is_empty());
        let trait_object: &dyn std::error::Error = &error;
        assert_eq!(trait_object.to_string(), text);
    }
    assert_eq!(AnnouncementFailure::Denied("denied".into()).to_string(), "denied");
    assert_eq!(
        AnnouncementFailure::AuthUnavailable.to_string(),
        "Twitch authentication unavailable"
    );
    assert_eq!(
        AnnouncementFailure::UnreadableBody.to_string(),
        "Twitch response body could not be read"
    );
    assert_eq!(
        AnnouncementFailure::Cancelled.to_string(),
        "Twitch request cancelled"
    );
}

#[tokio::test]
#[ignore = "needs an integration execution lease: binds 127.0.0.1 and drives send_announcement through the native Helix client. It never contacts Twitch."]
async fn loopback_send_announcement_never_contacts_twitch() {
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&seen);
    let recorder = Recorder::start(move |_| match counter.fetch_add(1, Ordering::SeqCst) {
        0 => CannedResponse {
            status: 204,
            headers: Vec::new(),
            body: Vec::new(),
        },
        1 => CannedResponse::json(
            400,
            r#"{"error":"Bad Request","message":"message is too long"}"#,
        ),
        2 => CannedResponse::json(401, r#"{"error":"Unauthorized"}"#),
        _ => CannedResponse {
            status: 502,
            headers: Vec::new(),
            body: b"not-json".to_vec(),
        },
    });
    let acquires = Arc::new(AtomicUsize::new(0));
    let functions = service(
        &recorder.base_url,
        Arc::new(CountingAuth(Arc::clone(&acquires))),
        None,
    );

    let sent = functions
        .send_announcement("channel-1", "mod-9", "hello", None)
        .await;
    assert_eq!(sent, announcement_success());
    let first = recorder.next(Duration::from_secs(2));
    let shaped = announcement_request("channel-1", "hello", "purple");
    assert_eq!(first.method, "POST");
    assert_eq!(
        first.path,
        format!("/{}?{}", shaped.endpoint, shaped.params)
    );
    assert!(first.path.contains("broadcaster_id=channel-1"));
    assert!(first.path.contains(&format!("moderator_id={TWITCH_BOT_ACCOUNT_ID}")));
    assert!(!first.path.contains("mod-9"));
    assert_eq!(first.header("authorization"), Some("Bearer fixture"));
    assert_eq!(first.header("client-id"), Some("fixture-client"));
    assert_eq!(first.header("content-type"), Some("application/json"));
    let body: serde_json::Value = serde_json::from_slice(&first.body).unwrap();
    assert_eq!(body["message"], "hello");
    assert_eq!(body["color"], "purple");
    assert!(shaped.url.starts_with("https://api.twitch.tv/helix/"));
    assert!(recorder.base_url.starts_with("http://127.0.0.1:"));

    let rejected = functions
        .send_announcement("channel-2", "mod-9", "too long", Some("blue"))
        .await;
    assert!(rejected.error);
    assert_eq!(rejected.message, "message is too long");
    assert_eq!(rejected.status, Some(400));
    assert_eq!(rejected.type_name.as_deref(), Some("Bad Request"));
    let second = recorder.next(Duration::from_secs(2));
    assert!(second.path.contains("broadcaster_id=channel-2"));
    assert!(second.path.contains(&format!("moderator_id={TWITCH_BOT_ACCOUNT_ID}")));
    let second_body: serde_json::Value = serde_json::from_slice(&second.body).unwrap();
    assert_eq!(second_body["message"], "too long");
    assert_eq!(second_body["color"], "blue");

    let fallback = functions
        .send_announcement("channel-3", "mod-9", "nope", None)
        .await;
    assert_eq!(fallback.message, "Failed to send announcement");
    assert_eq!(fallback.status, Some(401));
    assert_eq!(fallback.type_name.as_deref(), Some("Unauthorized"));
    let third = recorder.next(Duration::from_secs(2));
    let third_body: serde_json::Value = serde_json::from_slice(&third.body).unwrap();
    assert_eq!(third_body["message"], "nope");
    assert_eq!(third_body["color"], "purple");
    assert_eq!(seen.load(Ordering::SeqCst), 3, "401 must not be retried");
    assert_eq!(acquires.load(Ordering::SeqCst), 3);

    let broken_body = functions
        .send_announcement("channel-3b", "mod-9", "hello", None)
        .await;
    assert_eq!(broken_body, announcement_internal_error());
    let _bad = recorder.next(Duration::from_secs(2));
    assert_eq!(seen.load(Ordering::SeqCst), 4);
    assert_eq!(acquires.load(Ordering::SeqCst), 4);

    let blocked = Recorder::start(|_| panic!("header denial must not open a Twitch request"));
    let denied = service(
        &blocked.base_url,
        Arc::new(DeniedAuth(
            "Bot's account does not have the permissions required".to_owned(),
        )),
        None,
    );
    assert_eq!(
        denied
            .send_announcement("channel-4", "mod-9", "hello", None)
            .await,
        announcement_denied("Bot's account does not have the permissions required")
    );

    let (logger, sink) = capture_logger();
    let broken = service(
        "http://127.0.0.1:1",
        Arc::new(InternalAuth),
        Some(logger),
    );
    assert_eq!(
        broken
            .send_announcement("channel-5", "mod-9", "hello", Some("green"))
            .await,
        announcement_internal_error()
    );
    let record: serde_json::Value = {
        let records = sink
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(records.len(), 1);
        serde_json::from_str(&records[0]).unwrap()
    };
    assert_eq!(record["data"]["function"], "sendAnnouncement");
    assert_eq!(record["data"]["channelID"], "channel-5");
    assert_eq!(record["data"]["moderatorID"], "mod-9");
    assert_eq!(record["data"]["message"], "hello");
    assert_eq!(record["data"]["color"], "green");
    assert_eq!(record["data"]["operation"], "send_announcement");
    assert_eq!(record["data"]["apiEndpoint"], "chat/announcements");
    assert_eq!(record["data"]["method"], "POST");
    assert_eq!(
        record["data"]["error"],
        "Twitch authentication unavailable"
    );
    assert!(record["data"]["stack"].as_str().is_some_and(|stack| !stack.is_empty()));
    assert_eq!(record["channelId"], "channel-5");

    let quiet = service("http://127.0.0.1:1", Arc::new(InternalAuth), None);
    assert_eq!(
        quiet
            .send_announcement("channel-6", "mod-9", "hello", None)
            .await
            .to_json_string(),
        r#"{"error":true,"message":"Internal server error","status":500,"type":"error"}"#
    );
}

#[test]
#[ignore = "needs the JSON oracle written by tests/fixtures/announcement_chat_reference.cjs --write under an execution lease (ANNOUNCEMENT_CHAT_ORACLE). It does not contact Twitch."]
fn oracle_matches_native_decoder_and_request() {
    let path = std::env::var("ANNOUNCEMENT_CHAT_ORACLE").expect("ANNOUNCEMENT_CHAT_ORACLE");
    let bytes = std::fs::read(&path).unwrap();
    let oracle: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(oracle["schema"], 1);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let hashes = &oracle["provenance"]["hashes"];
    for (key, relative) in [
        (
            "announcement",
            "src/functions/chats/announcement.chat.ts",
        ),
        ("native", "src/functions/chats/announcement.chat.rs"),
        ("oracle", "tests/fixtures/announcement_chat_reference.cjs"),
        ("nativeTest", "tests/announcement_chat.rs"),
    ] {
        let content = std::fs::read(root.join(relative)).unwrap();
        assert_eq!(
            digest::sha256_hex(&content),
            hashes[key].as_str().unwrap(),
            "{key}"
        );
    }

    let cases = oracle["cases"].as_array().unwrap();
    assert!(cases.len() >= 3);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let response_json = case["responseJson"].as_str().unwrap();
        if case["request"].is_null() {
            let reason = case["headerError"].as_str().expect(id);
            assert_eq!(announcement_denied(reason).to_json_string(), response_json, "{id}");
            assert!(case["logs"].as_array().unwrap().is_empty(), "{id}");
            continue;
        }
        let status = case["httpStatus"].as_u64().unwrap() as u16;
        let body = case["responseBody"].as_str().unwrap_or("").as_bytes();
        let decoded = announcement_body(status, body).unwrap();
        assert_eq!(decoded.to_json_string(), response_json, "{id}");
        let request = announcement_request(
            case["channelID"].as_str().unwrap(),
            case["message"].as_str().unwrap(),
            case["color"].as_str().unwrap(),
        );
        assert_eq!(request.params, case["request"]["query"].as_str().unwrap(), "{id}");
        assert_eq!(request.url, case["request"]["url"].as_str().unwrap(), "{id}");
        assert_eq!(
            request.body["message"],
            case["request"]["body"]["message"],
            "{id}"
        );
        assert_eq!(request.body["color"], case["request"]["body"]["color"], "{id}");
        assert_eq!(
            case["request"]["moderatorId"].as_str().unwrap(),
            TWITCH_BOT_ACCOUNT_ID,
            "{id}"
        );
        assert_eq!(case["request"]["method"].as_str().unwrap(), "POST", "{id}");
        assert_eq!(
            case["request"]["endpoint"].as_str().unwrap(),
            "chat/announcements",
            "{id}"
        );
        assert_eq!(
            case["request"]["headerModeratorID"].as_str().unwrap(),
            case["moderatorID"].as_str().unwrap(),
            "{id}"
        );
        assert!(case["logs"].as_array().unwrap().is_empty(), "{id}");
    }
}
