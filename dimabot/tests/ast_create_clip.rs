#![cfg(feature = "ast-bot-runtime")]
//! Native `create.clip` family checks.
//!
//! Sources under test:
//!
//! - `src/utils/ast_parser/functions/clip.functions.ts` (`createClipHandler`,
//!   `registerFunction('create.clip', …, { minUserLevel: 7 })`)
//! - `src/commands/create_clip.command.ts` (`parseClipOptions`,
//!   `createClipCommand`, `checkClipStatus`, the duration bounds and the
//!   `retries < 15` / `2000 ms` poll loop)
//! - `src/functions/clips/create.clip.ts` (`createClip`)
//! - `src/functions/clips/get_clip.clip.ts` (`getClip`, the command's read-back)
//!
//! Lean tests decode bodies, build requests and drive the AST catalog with
//! in-memory fakes: no Twitch client, network, Docker or wall-clock sleep. The
//! ignored tests need an integration execution lease: the `loopback_*` tests
//! bind `127.0.0.1` and drive the real native Helix client, and
//! `oracle_matches_native_clip_family` replays the JSON oracle written by
//! `tests/fixtures/ast_create_clip_reference.cjs`. Neither contacts Twitch.
//!
//! `dima_rust::functions::clips` and `dima_rust::create_clip_command` are not
//! declared until the central registration patch recorded in
//! `migration-notes/ast-create-clip-handoff.md`. Enabling `ast-bot-runtime`
//! without that patch makes this target fail to compile, exactly like
//! `tests/announcement_chat.rs`.

#[path = "../src/utils/test_http.rs"]
mod test_http;
#[path = "support/sha256.rs"]
mod digest;

use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use dima_rust::{
    create_clip_command::{
        CLIP_STATUS_POLL_MILLIS, CLIP_STATUS_RETRIES, ClipStatusWaiter, CreateClipCommandResponse,
        DEFAULT_CLIP_DURATION, MAX_CLIP_DURATION, MIN_CLIP_DURATION, parse_clip_options,
    },
    functions::{
        CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture,
        RequestCancellation, TwitchFunctions,
        clips::{
            BROADCASTER_NOT_LIVE, CLIP_CREATED, CLIP_ID_MISSING, CLIP_NOT_FOUND, ClipCancelled,
            ClipFailure, CreateClipOptions, CreateClipResponse, GET_CLIP_SUCCESS, GetClipResponse,
            create_clip_body, create_clip_request, get_clip_body, get_clip_request,
        },
    },
    utils::{
        ast_evaluator::{FunctionRegistry, JsValue},
        ast_runtime::{
            AstFunctionCatalog, AstRuntimeError, AstScope, BoxFuture, SendResult,
            functions::{AstChatSend, AstClipCreate, AstDelayClock, BotAstFunctions},
        },
        ast_timer_runtime::{
            AstTimerClock, AstTimerError, AstTimerIdSource, AstTimerScheduler, AstTimerStore,
            PendingTimer, TimerEnqueue,
        },
        logger::{
            ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
            UuidSource,
        },
        twitch::{AccessToken, TWITCH_BOT_ACCOUNT_ID, TwitchAuth, TwitchClient, TwitchEndpoints},
    },
};
use serde_json::{Value, json};
use test_http::{CannedResponse, Recorder};

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn as_text(value: &JsValue) -> String {
    match value {
        JsValue::String(text) => text.to_utf8().expect("AST function text is valid UTF-8"),
        other => panic!("expected a string result, got {other:?}"),
    }
}

fn scope() -> AstScope {
    AstScope::new("channel-1")
}

/// Timer store that fails loudly if the clip family ever schedules a timer.
#[derive(Default)]
struct EmptyStore;

impl AstTimerStore for EmptyStore {
    async fn enqueue(&mut self, _: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        panic!("create.clip must not enqueue a timer")
    }

    async fn load_payload(&mut self, _: &str) -> Result<Option<String>, AstTimerError> {
        Ok(None)
    }

    async fn claim(&mut self, _: &str, _: &str, _: i64) -> Result<Option<String>, AstTimerError> {
        Ok(None)
    }

    async fn prune_pending(&mut self, _: i64) -> Result<usize, AstTimerError> {
        Ok(0)
    }

    async fn pending(&mut self, _: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        Ok(Vec::new())
    }

    async fn drop_pending(&mut self, _: &str) -> Result<bool, AstTimerError> {
        Ok(false)
    }
}

struct FixedClock;

impl AstTimerClock for FixedClock {
    fn now_ms(&self) -> i64 {
        0
    }
}

struct SequentialIds(u32);

impl AstTimerIdSource for SequentialIds {
    fn next_id(&mut self) -> String {
        self.0 += 1;
        format!("timer-{}", self.0)
    }
}

struct FakeChat;

impl AstChatSend for FakeChat {
    fn send<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async { Ok(SendResult::ok("sent")) })
    }
}

#[derive(Default)]
struct RecordingDelayClock {
    sleeps: Arc<StdMutex<Vec<u64>>>,
}

impl AstDelayClock for RecordingDelayClock {
    fn sleep_millis<'a>(&'a self, millis: u64) -> BoxFuture<'a, ()> {
        let sleeps = Arc::clone(&self.sleeps);
        Box::pin(async move {
            lock(&sleeps).push(millis);
        })
    }
}

#[derive(Clone)]
enum FakeClipOutcome {
    Created(&'static str),
    NotLive,
    MissingId,
    Cancelled,
}

#[derive(Clone)]
struct FakeClip {
    calls: Arc<StdMutex<Vec<(String, Option<CreateClipOptions>)>>>,
    outcome: FakeClipOutcome,
}

impl FakeClip {
    fn new(outcome: FakeClipOutcome) -> Self {
        Self {
            calls: Arc::default(),
            outcome,
        }
    }

    fn calls(&self) -> Vec<(String, Option<CreateClipOptions>)> {
        lock(&self.calls).clone()
    }
}

impl AstClipCreate for FakeClip {
    fn create<'a>(
        &'a self,
        channel_id: &'a str,
        options: Option<&'a CreateClipOptions>,
    ) -> BoxFuture<'a, Result<CreateClipResponse, AstRuntimeError>> {
        let calls = Arc::clone(&self.calls);
        let outcome = self.outcome.clone();
        let channel = channel_id.to_owned();
        let options = options.cloned();
        Box::pin(async move {
            lock(&calls).push((channel, options));
            match outcome {
                FakeClipOutcome::Created(id) => {
                    Ok(CreateClipResponse::created(Some(Value::from(id))))
                }
                FakeClipOutcome::NotLive => Ok(CreateClipResponse::not_live()),
                FakeClipOutcome::MissingId => Ok(CreateClipResponse::clip_id_missing()),
                FakeClipOutcome::Cancelled => Err(AstRuntimeError::Cancelled),
            }
        })
    }
}

fn catalog(
    clip: Option<Arc<dyn AstClipCreate>>,
) -> BotAstFunctions<EmptyStore, FixedClock, SequentialIds> {
    let timers = AstTimerScheduler::new(EmptyStore, FixedClock, SequentialIds(0));
    let catalog = BotAstFunctions::new(
        Arc::new(FakeChat),
        Arc::new(RecordingDelayClock::default()),
        timers,
    );
    match clip {
        Some(clip) => catalog.with_clip(clip),
        None => catalog,
    }
}

// ---------------------------------------------------------------------------
// `parseClipOptions`
// ---------------------------------------------------------------------------

fn options(duration: Option<f64>, title: Option<&str>) -> CreateClipOptions {
    CreateClipOptions {
        duration,
        title: title.map(str::to_owned),
    }
}

#[test]
fn parse_blank_argument_returns_no_options() {
    assert_eq!(parse_clip_options(None), CreateClipOptions::default());
    assert_eq!(parse_clip_options(Some("")), CreateClipOptions::default());
    assert_eq!(parse_clip_options(Some("   ")), CreateClipOptions::default());
    // JavaScript `trim` strips a BOM and a line separator; Rust's `trim` agrees
    // for these two, but not for NEL (covered below).
    assert_eq!(
        parse_clip_options(Some("\u{feff} \u{2028}")),
        CreateClipOptions::default()
    );
}

#[test]
fn parse_non_numeric_first_token_makes_the_whole_argument_the_title() {
    assert_eq!(
        parse_clip_options(Some("Epic win")),
        options(None, Some("Epic win"))
    );
    // `title: trimmedArgument` keeps interior spacing.
    assert_eq!(
        parse_clip_options(Some("  Epic  win  ")),
        options(None, Some("Epic  win"))
    );
    // `Number("NaN")` is NaN, so the numeric-looking token is a title.
    assert_eq!(parse_clip_options(Some("NaN")), options(None, Some("NaN")));
    // NEL (U+0085) is not JavaScript whitespace, so this token is not a number.
    assert_eq!(
        parse_clip_options(Some("\u{85}30")),
        options(None, Some("\u{85}30"))
    );
}

#[test]
fn parse_duration_uses_javascript_number_and_the_source_bounds() {
    assert_eq!(parse_clip_options(Some("30")), options(Some(30.0), None));
    assert_eq!(parse_clip_options(Some(" 30 ")), options(Some(30.0), None));
    assert_eq!(parse_clip_options(Some("10.5")), options(Some(10.5), None));
    // `Number("1e1")` is 10 and `Number("0x10")` is 16.
    assert_eq!(parse_clip_options(Some("1e1")), options(Some(10.0), None));
    assert_eq!(parse_clip_options(Some("0x10")), options(Some(16.0), None));
    assert_eq!(parse_clip_options(Some("5")), options(Some(5.0), None));
    assert_eq!(parse_clip_options(Some("60")), options(Some(60.0), None));
    // Out of range, including a non-finite number, falls back to 30.
    assert_eq!(
        parse_clip_options(Some("4")),
        options(Some(DEFAULT_CLIP_DURATION), None)
    );
    assert_eq!(
        parse_clip_options(Some("61")),
        options(Some(DEFAULT_CLIP_DURATION), None)
    );
    assert_eq!(
        parse_clip_options(Some("-5")),
        options(Some(DEFAULT_CLIP_DURATION), None)
    );
    assert_eq!(
        parse_clip_options(Some("Infinity")),
        options(Some(DEFAULT_CLIP_DURATION), None)
    );
    assert_eq!(MIN_CLIP_DURATION, 5.0);
    assert_eq!(MAX_CLIP_DURATION, 60.0);
}

#[test]
fn parse_title_is_the_remaining_tokens_joined_and_trimmed() {
    assert_eq!(
        parse_clip_options(Some("5 chill")),
        options(Some(5.0), Some("chill"))
    );
    assert_eq!(
        parse_clip_options(Some("5\tchill  clip")),
        options(Some(5.0), Some("chill clip"))
    );
    assert_eq!(parse_clip_options(Some("5   ")), options(Some(5.0), None));
    assert_eq!(
        parse_clip_options(Some("30 \u{feff}clutch")),
        options(Some(30.0), Some("clutch"))
    );
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

#[test]
fn create_request_appends_broadcaster_then_optional_duration_and_title() {
    let plain = create_clip_request("channel-1", None);
    assert_eq!(plain.endpoint, "clips");
    assert_eq!(plain.params, "broadcaster_id=channel-1");
    assert_eq!(
        plain.url,
        "https://api.twitch.tv/helix/clips?broadcaster_id=channel-1"
    );

    let defaulted = create_clip_request("channel-1", Some(&CreateClipOptions::default()));
    assert_eq!(defaulted.params, "broadcaster_id=channel-1");

    let full = create_clip_request("channel-1", Some(&options(Some(30.0), Some("Epic win"))));
    assert_eq!(
        full.params,
        "broadcaster_id=channel-1&duration=30&title=Epic+win"
    );
    assert_eq!(
        full.url,
        "https://api.twitch.tv/helix/clips?broadcaster_id=channel-1&duration=30&title=Epic+win"
    );

    // `typeof duration === 'number' && !isNaN(duration)`: NaN is skipped.
    let nan = create_clip_request("c", Some(&options(Some(f64::NAN), None)));
    assert_eq!(nan.params, "broadcaster_id=c");

    // A negative or fractional duration is still a number.
    let negative = create_clip_request("c", Some(&options(Some(-3.0), None)));
    assert_eq!(negative.params, "broadcaster_id=c&duration=-3");
    let fractional = create_clip_request("c", Some(&options(Some(1.5), None)));
    assert_eq!(fractional.params, "broadcaster_id=c&duration=1.5");
    let huge = create_clip_request("c", Some(&options(Some(1e21), None)));
    assert_eq!(huge.params, "broadcaster_id=c&duration=1e%2B21");

    // `options.title` truthiness is tested **before** trimming, so a
    // whitespace-only title still appends an empty parameter.
    let empty = create_clip_request("c", Some(&options(None, Some(""))));
    assert_eq!(empty.params, "broadcaster_id=c");
    let blank = create_clip_request("c", Some(&options(None, Some("   "))));
    assert_eq!(blank.params, "broadcaster_id=c&title=");
    let padded = create_clip_request("c", Some(&options(None, Some("  hi  "))));
    assert_eq!(padded.params, "broadcaster_id=c&title=hi");
}

#[test]
fn get_clip_request_sends_only_the_id() {
    let request = get_clip_request("ClipAbc");
    assert_eq!(request.endpoint, "clips");
    assert_eq!(request.params, "id=ClipAbc");
    assert_eq!(request.url, "https://api.twitch.tv/helix/clips?id=ClipAbc");
}

// ---------------------------------------------------------------------------
// `createClip` decoding
// ---------------------------------------------------------------------------

#[test]
fn create_202_returns_the_clip_id() {
    let response = create_clip_body(202, br#"{"data":[{"id":"ClipAbc","edit_url":"x"}]}"#).unwrap();
    assert_eq!(
        response,
        CreateClipResponse::created(Some(Value::from("ClipAbc")))
    );
    assert_eq!(response.clip_id_text().as_deref(), Some("ClipAbc"));
    assert_eq!(
        response.to_json_string(),
        r#"{"error":false,"message":"Clip created","status":202,"type":"success","clipID":"ClipAbc"}"#
    );
}

#[test]
fn create_404_is_broadcaster_not_live_without_reading_the_body() {
    let response = create_clip_body(404, b"<html>not json</html>").unwrap();
    assert_eq!(response, CreateClipResponse::not_live());
    assert_eq!(response.message.as_deref(), Some(BROADCASTER_NOT_LIVE));
    assert_eq!(
        response.to_json_string(),
        r#"{"error":true,"message":"Broadcaster must be live to create a clip","status":404,"type":"broadcaster_not_live"}"#
    );
}

#[test]
fn create_non_202_copies_the_twitch_error_body() {
    let body = create_clip_body(
        400,
        br#"{"error":"Bad Request","status":999,"message":"missing scope"}"#,
    )
    .unwrap();
    assert!(body.error);
    assert_eq!(body.message.as_deref(), Some("missing scope"));
    // The status is the HTTP status, not the body's.
    assert_eq!(body.status, Some(400));
    assert_eq!(body.type_name.as_deref(), Some("Bad Request"));
    assert_eq!(
        body.to_json_string(),
        r#"{"error":true,"message":"missing scope","status":400,"type":"Bad Request"}"#
    );

    let missing = create_clip_body(401, br#"{"error":"Unauthorized"}"#).unwrap();
    assert_eq!(missing.message, None);
    assert_eq!(missing.status, Some(401));
    assert_eq!(missing.type_name.as_deref(), Some("Unauthorized"));
    assert_eq!(
        missing.to_json_string(),
        r#"{"error":true,"status":401,"type":"Unauthorized"}"#
    );

    let empty = create_clip_body(400, br#"{"message":"","error":"Bad Request"}"#).unwrap();
    assert_eq!(empty.message.as_deref(), Some(""));
    assert_eq!(
        empty.to_json_string(),
        r#"{"error":true,"message":"","status":400,"type":"Bad Request"}"#
    );
}

#[test]
fn create_202_without_a_usable_id_is_clip_id_missing() {
    for body in [
        &br#"{}"#[..],
        &br#"{"data":[]}"#[..],
        &br#"{"data":null}"#[..],
        &br#"{"data":false}"#[..],
        &br#"{"data":0}"#[..],
        &br#"{"data":""}"#[..],
        &b"[]"[..],
    ] {
        let response = create_clip_body(202, body).unwrap();
        assert_eq!(response, CreateClipResponse::clip_id_missing(), "{body:?}");
        assert_eq!(response.clip_id_text(), None, "{body:?}");
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"Twitch accepted clip request but did not return a clip ID.","status":500,"type":"clip_id_missing"}"#
        );
    }
}

#[test]
fn create_202_with_a_primitive_or_empty_id_created_the_clip_without_an_id() {
    // `[{}]` and `[5]` are truthy elements without an `id`.
    for body in [
        &br#"{"data":[{}]}"#[..],
        &br#"{"data":[5]}"#[..],
        &br#"{"data":"ab"}"#[..],
    ] {
        let response = create_clip_body(202, body).unwrap();
        assert!(!response.error, "{body:?}");
        assert_eq!(response.clip_id, None, "{body:?}");
        assert_eq!(response.clip_id_text(), None, "{body:?}");
        assert_eq!(
            response.to_json_string(),
            r#"{"error":false,"message":"Clip created","status":202,"type":"success"}"#
        );
    }
    // A numeric id is rendered the way the source's template literal would.
    let numeric = create_clip_body(202, br#"{"data":[{"id":7}]}"#).unwrap();
    assert_eq!(numeric.clip_id_text().as_deref(), Some("7"));
    // A `null` id is falsy.
    let null = create_clip_body(202, br#"{"data":[{"id":null}]}"#).unwrap();
    assert_eq!(null.clip_id_text(), None);
}

#[test]
fn create_throwing_shapes_are_typed_failures() {
    assert!(matches!(
        create_clip_body(202, b"<html>").unwrap_err(),
        ClipFailure::InvalidJson(_)
    ));
    assert_eq!(
        create_clip_body(202, b"null").unwrap_err(),
        ClipFailure::NullPropertyAccess("data")
    );
    assert_eq!(
        create_clip_body(400, b"null").unwrap_err(),
        ClipFailure::NullPropertyAccess("message")
    );
    assert_eq!(
        create_clip_body(202, br#"{"data":[null]}"#).unwrap_err(),
        ClipFailure::NullPropertyAccess("id")
    );
    assert_eq!(
        create_clip_body(202, br#"{"data":{}}"#).unwrap_err(),
        ClipFailure::UndefinedPropertyAccess("id")
    );
    assert_eq!(
        create_clip_body(202, br#"{"data":true}"#).unwrap_err(),
        ClipFailure::UndefinedPropertyAccess("id")
    );
    assert_eq!(
        ClipFailure::NullPropertyAccess("id").to_string(),
        "Cannot read properties of null (reading 'id')"
    );
    assert_eq!(
        ClipFailure::UndefinedPropertyAccess("id").to_string(),
        "Cannot read properties of undefined (reading 'id')"
    );
}

// ---------------------------------------------------------------------------
// `getClip` decoding
// ---------------------------------------------------------------------------

#[test]
fn get_clip_returns_the_first_data_entry() {
    let response = get_clip_body(
        br#"{"data":[{"id":"ClipAbc","url":"https://clips.twitch.tv/ClipAbc"}]}"#,
    )
    .unwrap();
    assert!(!response.error);
    assert_eq!(response.message.as_deref(), Some(GET_CLIP_SUCCESS));
    assert_eq!(response.status, None);
    assert_eq!(response.type_name, None);
    assert_eq!(
        response
            .data
            .as_ref()
            .and_then(|data| data.get("url"))
            .and_then(Value::as_str),
        Some("https://clips.twitch.tv/ClipAbc")
    );
    assert_eq!(
        response.to_json_string(),
        r#"{"error":false,"message":"Success","data":{"id":"ClipAbc","url":"https://clips.twitch.tv/ClipAbc"}}"#
    );
}

#[test]
fn get_clip_empty_data_is_not_found() {
    let response = get_clip_body(br#"{"data":[]}"#).unwrap();
    assert_eq!(response, GetClipResponse::not_found());
    assert_eq!(response.message.as_deref(), Some(CLIP_NOT_FOUND));
    assert_eq!(
        response.to_json_string(),
        r#"{"error":true,"message":"Clip not found","status":404,"type":"clip_not_found"}"#
    );
}

#[test]
fn get_clip_error_body_is_copied_without_a_status_check() {
    let response =
        get_clip_body(br#"{"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}"#)
            .unwrap();
    assert!(response.error);
    assert_eq!(response.message.as_deref(), Some("Invalid OAuth token"));
    assert_eq!(response.status, Some(401));
    assert_eq!(response.type_name.as_deref(), Some("Unauthorized"));
    assert_eq!(
        response.to_json_string(),
        r#"{"error":true,"message":"Invalid OAuth token","status":401,"type":"Unauthorized"}"#
    );

    // A falsy `error` value does not take the error branch.
    let falsy = get_clip_body(br#"{"error":0,"data":[]}"#).unwrap();
    assert_eq!(falsy, GetClipResponse::not_found());
    let empty_error = get_clip_body(br#"{"error":"","data":[]}"#).unwrap();
    assert_eq!(empty_error, GetClipResponse::not_found());
}

#[test]
fn get_clip_undefined_data_is_a_typed_type_error() {
    assert_eq!(
        get_clip_body(b"{}").unwrap_err(),
        ClipFailure::UndefinedPropertyAccess("length")
    );
    assert_eq!(
        get_clip_body(b"null").unwrap_err(),
        ClipFailure::NullPropertyAccess("error")
    );
    assert!(matches!(
        get_clip_body(b"<html>").unwrap_err(),
        ClipFailure::InvalidJson(_)
    ));
}

#[test]
fn get_clip_non_array_data_is_passed_through_the_source_way() {
    // `{}.length` is `undefined`, which is not `=== 0`, and `{}[0]` is undefined.
    let object = get_clip_body(br#"{"data":{}}"#).unwrap();
    assert!(!object.error);
    assert_eq!(object.data, None);
    // A string's first code unit becomes `data`.
    let text = get_clip_body(br#"{"data":"xy"}"#).unwrap();
    assert_eq!(text.data, Some(Value::from("x")));
    // `null` data throws on `.length`.
    assert_eq!(
        get_clip_body(br#"{"data":null}"#).unwrap_err(),
        ClipFailure::NullPropertyAccess("length")
    );
}

// ---------------------------------------------------------------------------
// Command response values
// ---------------------------------------------------------------------------

#[test]
fn command_response_json_matches_the_source_strings() {
    assert_eq!(
        CreateClipCommandResponse::internal_error().to_json_string(),
        r#"{"error":true,"message":"Internal server error"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::unavailable().to_json_string(),
        r#"{"error":true,"message":"Clip creation is currently unavailable.","status":503,"type":"Clip creation unavailable"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::twitch_server_error(502).to_json_string(),
        r#"{"error":true,"message":"There was an internal Twitch server error that we cannot resolve.","status":502,"type":"Clip creation error"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::clip_id_missing().to_json_string(),
        r#"{"error":true,"message":"Clip ID not returned from creation","status":500,"type":"Clip creation error"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::clip_not_found().to_json_string(),
        r#"{"error":true,"message":"There was an error finding the clip, it may have been created but is taking too long to process. Please check your clips later.","status":404,"type":"Clip not found"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::clip_data_missing().to_json_string(),
        r#"{"error":true,"message":"There was an unexpected error retrieving the clip data.","status":500,"type":"Clip data missing"}"#
    );
    // `createClipFun.message || 'Error creating clip'`.
    assert_eq!(
        CreateClipCommandResponse::create_failure(
            None,
            Some(403),
            Some("permission_error".into())
        )
        .to_json_string(),
        r#"{"error":true,"message":"Error creating clip","status":403,"type":"permission_error"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::create_failure(Some(String::new()), None, None).to_json_string(),
        r#"{"error":true,"message":"Error creating clip"}"#
    );
    assert_eq!(
        CreateClipCommandResponse::create_failure(
            Some(BROADCASTER_NOT_LIVE.to_owned()),
            Some(404),
            Some("broadcaster_not_live".to_owned()),
        )
        .to_json_string(),
        format!(
            r#"{{"error":true,"message":"{BROADCASTER_NOT_LIVE}","status":404,"type":"broadcaster_not_live"}}"#
        )
    );
    let created = CreateClipCommandResponse::created(json!({
        "id": "ClipAbc",
        "url": "https://clips.twitch.tv/ClipAbc"
    }));
    assert_eq!(
        created.to_json_string(),
        r#"{"error":false,"message":"Clip created successfully: https://clips.twitch.tv/ClipAbc","status":200,"type":"Clip created","clipData":{"id":"ClipAbc","url":"https://clips.twitch.tv/ClipAbc"}}"#
    );
    assert_eq!(
        CreateClipCommandResponse::created(json!({ "id": "x" }))
            .message
            .as_deref(),
        Some("Clip created successfully: undefined")
    );
    // The forwarded `getClip` error branch keeps `getClip`'s fields.
    let forwarded = CreateClipCommandResponse::from_clip_lookup(GetClipResponse::rejected(
        Some("Invalid OAuth token".into()),
        Some(401),
        Some("Unauthorized".into()),
    ));
    assert_eq!(
        forwarded.to_json_string(),
        r#"{"error":true,"message":"Invalid OAuth token","status":401,"type":"Unauthorized"}"#
    );
    assert_eq!(CLIP_STATUS_RETRIES, 15);
    assert_eq!(CLIP_STATUS_POLL_MILLIS, 2_000);
}

#[test]
fn clip_constants_match_the_source_text() {
    assert_eq!(
        CLIP_ID_MISSING,
        "Twitch accepted clip request but did not return a clip ID."
    );
    assert_eq!(CLIP_CREATED, "Clip created");
    assert_eq!(ClipCancelled.to_string(), "Twitch request cancelled");
}

// ---------------------------------------------------------------------------
// AST family (`clip.functions.ts`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ast_create_clip_returns_the_source_url() {
    let clip = FakeClip::new(FakeClipOutcome::Created("ClipAbc"));
    let clip_seam: Arc<dyn AstClipCreate> = Arc::new(clip.clone());
    let catalog = catalog(Some(clip_seam));

    let result = catalog
        .create_clip(&scope(), &[JsValue::string("Epic win")], None)
        .await
        .expect("catalog result");
    assert_eq!(as_text(&result), "https://clips.twitch.tv/ClipAbc");
    assert_eq!(
        clip.calls(),
        vec![(
            "channel-1".to_owned(),
            Some(options(None, Some("Epic win")))
        )]
    );
}

#[tokio::test]
async fn ast_create_clip_joins_arguments_and_parses_a_duration() {
    let clip = FakeClip::new(FakeClipOutcome::Created("ClipAbc"));
    let clip_seam: Arc<dyn AstClipCreate> = Arc::new(clip.clone());
    let catalog = catalog(Some(clip_seam));

    // `args.map(String).join(' ')` makes `["30", "chill"]` the argument
    // `"30 chill"`, which `parseClipOptions` turns into 30 + title.
    let result = catalog
        .create_clip(
            &scope(),
            &[JsValue::Number(30.0), JsValue::string("chill")],
            None,
        )
        .await
        .expect("catalog result");
    assert_eq!(as_text(&result), "https://clips.twitch.tv/ClipAbc");
    assert_eq!(
        clip.calls(),
        vec![(
            "channel-1".to_owned(),
            Some(options(Some(30.0), Some("chill")))
        )]
    );

    // `1e1` is 10 through JavaScript `Number`.
    catalog
        .create_clip(
            &scope(),
            &[JsValue::string("1e1"), JsValue::string("clutch")],
            None,
        )
        .await
        .expect("catalog result");
    assert_eq!(
        clip.calls()[1],
        (
            "channel-1".to_owned(),
            Some(options(Some(10.0), Some("clutch")))
        )
    );

    // Out-of-range durations fall back to 30 and keep the rest as the title.
    catalog
        .create_clip(
            &scope(),
            &[JsValue::string("999"), JsValue::string("x")],
            None,
        )
        .await
        .expect("catalog result");
    assert_eq!(
        clip.calls()[2],
        (
            "channel-1".to_owned(),
            Some(options(Some(DEFAULT_CLIP_DURATION), Some("x")))
        )
    );
}

#[tokio::test]
async fn ast_create_clip_uses_the_context_argument_when_no_arguments_exist() {
    let clip = FakeClip::new(FakeClipOutcome::Created("ClipAbc"));
    let clip_seam: Arc<dyn AstClipCreate> = Arc::new(clip.clone());
    let catalog = catalog(Some(clip_seam));

    catalog
        .create_clip(&scope(), &[], Some("  45 clutch  "))
        .await
        .expect("catalog result");
    assert_eq!(
        clip.calls(),
        vec![(
            "channel-1".to_owned(),
            Some(options(Some(45.0), Some("clutch")))
        )]
    );

    // `call` cannot see `ctx.argument`, so it behaves as the undefined case.
    catalog
        .call(&scope(), "create.clip", &[])
        .await
        .expect("catalog result");
    assert_eq!(
        clip.calls()[1],
        ("channel-1".to_owned(), Some(CreateClipOptions::default()))
    );
}

#[tokio::test]
async fn ast_create_clip_is_silent_for_every_operational_failure() {
    for outcome in [FakeClipOutcome::NotLive, FakeClipOutcome::MissingId] {
        let clip_seam: Arc<dyn AstClipCreate> = Arc::new(FakeClip::new(outcome));
        let catalog = catalog(Some(clip_seam));
        let result = catalog
            .create_clip(&scope(), &[], Some("30"))
            .await
            .expect("catalog result");
        assert_eq!(as_text(&result), "");
    }

    // `!result.clipID` is true for a falsy id, so no URL is built.
    let empty_id = FakeClip::new(FakeClipOutcome::Created(""));
    let clip_seam: Arc<dyn AstClipCreate> = Arc::new(empty_id);
    let catalog = catalog(Some(clip_seam));
    let result = catalog
        .create_clip(&scope(), &[], None)
        .await
        .expect("catalog result");
    assert_eq!(as_text(&result), "");
}

#[tokio::test]
async fn ast_create_clip_propagates_cancellation_and_missing_adapter() {
    let clip_seam: Arc<dyn AstClipCreate> =
        Arc::new(FakeClip::new(FakeClipOutcome::Cancelled));
    let with_clip = catalog(Some(clip_seam));
    assert_eq!(
        with_clip.create_clip(&scope(), &[], None).await.unwrap_err(),
        AstRuntimeError::Cancelled
    );
    assert_eq!(
        with_clip
            .call(&scope(), "create.clip", &[JsValue::string("x")])
            .await
            .unwrap_err(),
        AstRuntimeError::Cancelled
    );

    let bare = catalog(None);
    let error = bare
        .call(&scope(), "create.clip", &[JsValue::string("x")])
        .await
        .unwrap_err();
    match error {
        AstRuntimeError::Unsupported(message) => {
            assert!(message.contains("create.clip"), "{message}");
            assert!(message.contains("with_clip"), "{message}");
            assert!(
                message.contains("src/functions/clips/create.clip.rs"),
                "{message}"
            );
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[tokio::test]
async fn ast_create_clip_metadata_matches_the_registration() {
    let catalog = catalog(None);
    let metadata = catalog.metadata("create.clip").expect("metadata");

    assert_eq!(metadata.category, "clip");
    assert_eq!(metadata.syntax, "create.clip [title]");
    assert_eq!(metadata.min_user_level, Some(7.0));
    assert_eq!(
        metadata.description,
        "Creates a clip of the current stream moment and returns the clip URL. Optional clip title."
    );
    assert_eq!(
        metadata.examples,
        vec!["create.clip".to_owned(), "create.clip Epic win".to_owned()]
    );
    let expected_keywords: Vec<String> = ["clip", "create clip", "crear clip", "clip this", "momento"]
        .iter()
        .map(|keyword| (*keyword).to_owned())
        .collect();
    assert_eq!(metadata.keywords.as_deref(), Some(expected_keywords.as_slice()));
    assert_eq!(catalog.registrations().len(), 6);
    assert!(
        catalog
            .registrations()
            .iter()
            .any(|(name, _)| name == "create.clip")
    );

    let mut registry = FunctionRegistry::default();
    catalog.register_into(&mut registry);
    assert!(registry.metadata("create.clip").is_some());
}

// ---------------------------------------------------------------------------
// Loopback fixtures: the real native Helix client, no Twitch
// ---------------------------------------------------------------------------

struct FixtureAuth {
    kinds: Arc<StdMutex<Vec<&'static str>>>,
    deny: Option<&'static str>,
}

impl FixtureAuth {
    fn accepting() -> Self {
        Self {
            kinds: Arc::default(),
            deny: None,
        }
    }

    fn denying() -> Self {
        Self {
            kinds: Arc::default(),
            deny: Some("Bot's account does not have the permissions required"),
        }
    }

    fn kinds(&self) -> Vec<&'static str> {
        lock(&self.kinds).clone()
    }
}

impl FunctionAuth for FixtureAuth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        lock(&self.kinds).push(match auth {
            TwitchAuth::App => "app",
            TwitchAuth::Bot => "bot",
            TwitchAuth::Streamer(_) => "streamer",
        });
        let deny = self.deny;
        Box::pin(async move {
            match deny {
                Some(message) => Err(FunctionFailure::Denied(message.to_owned())),
                None => Ok(match auth {
                    TwitchAuth::App => AccessToken::app("fixture"),
                    _ => AccessToken::user("fixture", TWITCH_BOT_ACCOUNT_ID),
                }),
            }
        })
    }
}

struct NoCache;

impl FunctionCache for NoCache {
    fn execute<'a>(
        &'a self,
        _: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("the clip family must not use the cache") })
    }
}

fn service(
    base: &str,
    auth: Arc<dyn FunctionAuth>,
    logger: Option<Arc<Logger>>,
) -> TwitchFunctions {
    let endpoints =
        TwitchEndpoints::new(base, &format!("{base}/oauth/")).expect("loopback endpoints");
    let client = TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(5)))
        .expect("client");
    TwitchFunctions::with_adapters(client, auth, Arc::new(NoCache), None, logger)
}

#[derive(Default)]
struct RecordingWaiter {
    waits: Arc<StdMutex<Vec<u64>>>,
}

impl RecordingWaiter {
    fn waits(&self) -> Vec<u64> {
        lock(&self.waits).clone()
    }
}

impl ClipStatusWaiter for RecordingWaiter {
    fn wait_millis<'a>(&'a self, millis: u64) -> FunctionFuture<'a, ()> {
        let waits = Arc::clone(&self.waits);
        Box::pin(async move {
            lock(&waits).push(millis);
        })
    }
}

/// A recorder that answers a scripted sequence of JSON responses.
fn scripted(responses: Vec<(u16, String)>) -> Recorder {
    let state = Arc::new(StdMutex::new((responses, 0usize)));
    let handler = Arc::clone(&state);
    Recorder::start(move |_| {
        let mut state = lock(&handler);
        let index = state.1;
        state.1 += 1;
        let response = state
            .0
            .get(index)
            .cloned()
            .or_else(|| state.0.last().cloned());
        drop(state);
        match response {
            Some((status, body)) => CannedResponse::json(status, &body),
            None => CannedResponse::json(500, r#"{"error":"missing script"}"#),
        }
    })
}

struct CaptureConsole(StdMutex<Vec<String>>);

impl ConsoleSink for CaptureConsole {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            lock(&self.0).push(record.json.to_string());
            Ok(())
        })
    }
}

fn capture_logger() -> (Arc<Logger>, Arc<CaptureConsole>) {
    let sink = Arc::new(CaptureConsole(StdMutex::new(Vec::new())));
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
        .expect("logger"),
    );
    (logger, sink)
}

#[tokio::test]
#[ignore = "needs an integration execution lease: binds 127.0.0.1 and drives create_clip/get_clip through the native Helix client. It never contacts Twitch."]
async fn loopback_create_and_get_clip_never_contact_twitch() {
    let recorder = scripted(vec![
        (202, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned()),
        (404, String::new()),
        (
            400,
            r#"{"error":"Bad Request","message":"missing scope"}"#.to_owned(),
        ),
        (202, "<html>not json</html>".to_owned()),
    ]);
    let auth = Arc::new(FixtureAuth::accepting());
    let functions = service(&recorder.base_url, auth.clone(), None);

    let created = functions
        .create_clip("channel-1", Some(&options(Some(30.0), Some("Epic win"))))
        .await
        .expect("no cancellation");
    assert_eq!(
        created,
        CreateClipResponse::created(Some(Value::from("ClipAbc")))
    );
    assert_eq!(created.clip_id_text().as_deref(), Some("ClipAbc"));
    let first = recorder.next(Duration::from_secs(2));
    assert_eq!(first.method, "POST");
    assert_eq!(
        first.path,
        "/clips?broadcaster_id=channel-1&duration=30&title=Epic+win"
    );
    assert_eq!(first.header("authorization"), Some("Bearer fixture"));
    assert_eq!(first.header("client-id"), Some("fixture-client"));
    assert!(first.body.is_empty(), "POST clips carries no body");
    assert_eq!(auth.kinds(), vec!["bot"]);

    let not_live = functions
        .create_clip("channel-2", None)
        .await
        .expect("no cancellation");
    assert_eq!(not_live, CreateClipResponse::not_live());
    let second = recorder.next(Duration::from_secs(2));
    assert_eq!(second.path, "/clips?broadcaster_id=channel-2");

    let rejected = functions
        .create_clip("channel-3", None)
        .await
        .expect("no cancellation");
    assert_eq!(rejected.message.as_deref(), Some("missing scope"));
    assert_eq!(rejected.status, Some(400));
    assert_eq!(rejected.type_name.as_deref(), Some("Bad Request"));
    let _third = recorder.next(Duration::from_secs(2));

    let (logger, sink) = capture_logger();
    let broken_functions = service(&recorder.base_url, Arc::new(FixtureAuth::accepting()), Some(logger));
    let broken = broken_functions
        .create_clip("channel-4", Some(&options(Some(30.0), None)))
        .await
        .expect("no cancellation");
    assert_eq!(broken, CreateClipResponse::internal_error());
    let _fourth = recorder.next(Duration::from_secs(2));
    let record: Value = {
        let records = lock(&sink.0);
        assert_eq!(records.len(), 1);
        serde_json::from_str(&records[0]).expect("log record")
    };
    assert_eq!(record["data"]["function"], "createClip");
    assert_eq!(record["data"]["channelID"], "channel-4");
    assert_eq!(record["data"]["options"]["duration"], 30);
    assert!(
        record["data"]["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Invalid JSON response body")
    );
    assert!(record["data"]["stack"].as_str().is_some_and(|stack| !stack.is_empty()));
    assert_eq!(auth.kinds(), vec!["bot", "bot", "bot"]);

    // `getClip` authenticates as the app.
    let lookups_recorder = scripted(vec![
        (
            200,
            r#"{"data":[{"id":"ClipAbc","url":"https://clips.twitch.tv/ClipAbc"}]}"#.to_owned(),
        ),
        (200, r#"{"data":[]}"#.to_owned()),
    ]);
    let lookup_auth = Arc::new(FixtureAuth::accepting());
    let lookups = service(&lookups_recorder.base_url, lookup_auth.clone(), None);
    let found = lookups.get_clip("ClipAbc").await.expect("no cancellation");
    assert!(!found.error);
    let request = lookups_recorder.next(Duration::from_secs(2));
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/clips?id=ClipAbc");
    assert_eq!(request.header("authorization"), Some("Bearer fixture"));
    assert_eq!(lookup_auth.kinds(), vec!["app"]);

    let missing = lookups.get_clip("Other").await.expect("no cancellation");
    assert_eq!(missing, GetClipResponse::not_found());
    let _second_lookup = lookups_recorder.next(Duration::from_secs(2));

    // An empty id still acquires the app header first and sends nothing.
    let quiet = Recorder::start(|_| panic!("an empty clip id must not open a request"));
    let empty_auth = Arc::new(FixtureAuth::accepting());
    let empty = service(&quiet.base_url, empty_auth.clone(), None);
    assert_eq!(
        empty.get_clip("").await.expect("no cancellation"),
        GetClipResponse::clip_id_required()
    );
    assert_eq!(empty_auth.kinds(), vec!["app"]);

    // A bot-header refusal is the source's 403 value and opens no request.
    let blocked = Recorder::start(|_| panic!("header denial must not open a Twitch request"));
    let denied = service(&blocked.base_url, Arc::new(FixtureAuth::denying()), None);
    assert_eq!(
        denied
            .create_clip("channel-5", None)
            .await
            .expect("no cancellation"),
        CreateClipResponse::permission_denied(
            "Bot's account does not have the permissions required"
        )
    );
}

#[tokio::test]
#[ignore = "needs an integration execution lease: binds 127.0.0.1 and drives create_clip_command through the native Helix client. It never contacts Twitch."]
async fn loopback_create_clip_command_polls_until_the_clip_exists() {
    let recorder = scripted(vec![
        (202, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned()),
        (404, r#"{"data":[]}"#.to_owned()),
        (404, r#"{"data":[]}"#.to_owned()),
        (
            200,
            r#"{"data":[{"id":"ClipAbc","url":"https://clips.twitch.tv/ClipAbc"}]}"#.to_owned(),
        ),
    ]);
    let functions = service(&recorder.base_url, Arc::new(FixtureAuth::accepting()), None);
    let waiter = RecordingWaiter::default();

    let response = functions
        .create_clip_command_with("channel-1", Some("30 Epic win"), &waiter, None)
        .await
        .expect("no cancellation");
    assert!(!response.error);
    assert_eq!(
        response.message.as_deref(),
        Some("Clip created successfully: https://clips.twitch.tv/ClipAbc")
    );
    assert_eq!(response.status, Some(200));
    assert_eq!(response.type_name.as_deref(), Some("Clip created"));
    assert_eq!(
        response
            .clip_data
            .as_ref()
            .and_then(|data| data.get("id"))
            .and_then(Value::as_str),
        Some("ClipAbc")
    );
    assert_eq!(waiter.waits(), vec![2_000, 2_000]);
    let first = recorder.next(Duration::from_secs(2));
    assert_eq!(first.method, "POST");
    assert_eq!(
        first.path,
        "/clips?broadcaster_id=channel-1&duration=30&title=Epic+win"
    );
    let second = recorder.next(Duration::from_secs(2));
    assert_eq!(second.method, "GET");
    assert_eq!(second.path, "/clips?id=ClipAbc");
    let _third = recorder.next(Duration::from_secs(2));
    let _fourth = recorder.next(Duration::from_secs(2));

    // 503 and >500 are the command's own pre-emptions.
    let unavailable = scripted(vec![(
        503,
        r#"{"error":"Service Unavailable","message":"down"}"#.to_owned(),
    )]);
    let functions = service(&unavailable.base_url, Arc::new(FixtureAuth::accepting()), None);
    let response = functions
        .create_clip_command_with("channel-2", None, &RecordingWaiter::default(), None)
        .await
        .expect("no cancellation");
    assert_eq!(response, CreateClipCommandResponse::unavailable());

    let gateway = scripted(vec![(
        502,
        r#"{"error":"Bad Gateway","message":"bad"}"#.to_owned(),
    )]);
    let functions = service(&gateway.base_url, Arc::new(FixtureAuth::accepting()), None);
    let response = functions
        .create_clip_command_with("channel-3", None, &RecordingWaiter::default(), None)
        .await
        .expect("no cancellation");
    assert_eq!(response, CreateClipCommandResponse::twitch_server_error(502));

    // A `createClip` error is forwarded with its own message.
    let rejected = scripted(vec![(
        400,
        r#"{"error":"Bad Request","message":"missing scope"}"#.to_owned(),
    )]);
    let functions = service(&rejected.base_url, Arc::new(FixtureAuth::accepting()), None);
    let response = functions
        .create_clip_command_with("channel-4", None, &RecordingWaiter::default(), None)
        .await
        .expect("no cancellation");
    assert_eq!(response.message.as_deref(), Some("missing scope"));
    assert_eq!(response.status, Some(400));
    assert_eq!(response.type_name.as_deref(), Some("Bad Request"));

    // A 202 without an id stops before any lookup.
    let no_id = scripted(vec![(202, r#"{"data":[]}"#.to_owned())]);
    let functions = service(&no_id.base_url, Arc::new(FixtureAuth::accepting()), None);
    let response = functions
        .create_clip_command_with("channel-5", None, &RecordingWaiter::default(), None)
        .await
        .expect("no cancellation");
    assert_eq!(response, CreateClipCommandResponse::clip_id_missing());

    // A never-appearing clip polls 16 times and then reports not found.
    let mut gone = vec![(202u16, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned())];
    gone.extend(std::iter::repeat_n((404u16, r#"{"data":[]}"#.to_owned()), 16));
    let missing = scripted(gone);
    let functions = service(&missing.base_url, Arc::new(FixtureAuth::accepting()), None);
    let waiter = RecordingWaiter::default();
    let response = functions
        .create_clip_command_with("channel-6", None, &waiter, None)
        .await
        .expect("no cancellation");
    assert_eq!(response, CreateClipCommandResponse::clip_not_found());
    assert_eq!(waiter.waits(), vec![CLIP_STATUS_POLL_MILLIS; 15]);

    // A lookup success with a falsy payload is "Clip data missing".
    let empty_data = scripted(vec![
        (202, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned()),
        (200, r#"{"data":{}}"#.to_owned()),
    ]);
    let functions = service(&empty_data.base_url, Arc::new(FixtureAuth::accepting()), None);
    let response = functions
        .create_clip_command_with("channel-7", None, &RecordingWaiter::default(), None)
        .await
        .expect("no cancellation");
    assert_eq!(response, CreateClipCommandResponse::clip_data_missing());
}

#[tokio::test]
#[ignore = "needs an integration execution lease: binds 127.0.0.1 and drives the AST catalog over the native Helix client. It never contacts Twitch."]
async fn loopback_ast_create_clip_returns_a_url_or_an_empty_string() {
    let recorder = scripted(vec![
        (202, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned()),
        (404, r#"{"data":[]}"#.to_owned()),
        (202, r#"{"data":[]}"#.to_owned()),
    ]);
    let functions = service(&recorder.base_url, Arc::new(FixtureAuth::accepting()), None);
    let catalog = BotAstFunctions::with_twitch(
        functions,
        AstTimerScheduler::new(EmptyStore, FixedClock, SequentialIds(0)),
    );

    let url = catalog
        .create_clip(
            &scope(),
            &[JsValue::string("30"), JsValue::string("clutch")],
            None,
        )
        .await
        .expect("catalog result");
    assert_eq!(as_text(&url), "https://clips.twitch.tv/ClipAbc");
    let request = recorder.next(Duration::from_secs(2));
    assert_eq!(
        request.path,
        "/clips?broadcaster_id=channel-1&duration=30&title=clutch"
    );

    let offline = catalog
        .create_clip(&scope(), &[], Some("Epic win"))
        .await
        .expect("catalog result");
    assert_eq!(as_text(&offline), "");
    let _second = recorder.next(Duration::from_secs(2));

    let no_id = catalog
        .call(&scope(), "create.clip", &[])
        .await
        .expect("catalog result");
    assert_eq!(as_text(&no_id), "");
    let third = recorder.next(Duration::from_secs(2));
    assert_eq!(third.path, "/clips?broadcaster_id=channel-1");
}

#[tokio::test]
#[ignore = "needs an integration execution lease: binds 127.0.0.1 for the cancellation checks. It never contacts Twitch."]
async fn cancellation_is_typed_and_opens_no_request() {
    let recorder = Recorder::start(|_| panic!("a cancelled request must not reach the wire"));
    let functions = service(&recorder.base_url, Arc::new(FixtureAuth::accepting()), None);

    let cancel = RequestCancellation::new();
    cancel.cancel();
    assert_eq!(
        functions
            .create_clip_with_cancellation("channel-1", None, Some(&cancel))
            .await
            .unwrap_err(),
        ClipCancelled
    );
    assert_eq!(
        functions
            .get_clip_with_cancellation("ClipAbc", Some(&cancel))
            .await
            .unwrap_err(),
        ClipCancelled
    );
    assert_eq!(
        functions
            .create_clip_command_with(
                "channel-1",
                None,
                &RecordingWaiter::default(),
                Some(&cancel)
            )
            .await
            .unwrap_err(),
        ClipCancelled
    );

    // A cancellation observed between polls stops the retry loop.
    let recorder = scripted(vec![(202, r#"{"data":[{"id":"ClipAbc"}]}"#.to_owned())]);
    let functions = service(&recorder.base_url, Arc::new(FixtureAuth::accepting()), None);
    let cancel = RequestCancellation::new();
    let cancelling = CancellingWaiter {
        cancel: cancel.clone(),
        waits: Arc::default(),
    };
    assert_eq!(
        functions
            .create_clip_command_with("channel-2", None, &cancelling, Some(&cancel))
            .await
            .unwrap_err(),
        ClipCancelled
    );
}

/// Waits once and then cancels, which the next loop iteration must observe.
struct CancellingWaiter {
    cancel: RequestCancellation,
    waits: Arc<StdMutex<Vec<u64>>>,
}

impl ClipStatusWaiter for CancellingWaiter {
    fn wait_millis<'a>(&'a self, millis: u64) -> FunctionFuture<'a, ()> {
        let cancel = self.cancel.clone();
        let waits = Arc::clone(&self.waits);
        Box::pin(async move {
            lock(&waits).push(millis);
            cancel.cancel();
        })
    }
}

// ---------------------------------------------------------------------------
// Actual-source oracle
// ---------------------------------------------------------------------------

fn oracle_auth(case: &Value) -> Arc<dyn FunctionAuth> {
    if case["botHeaderError"].is_string() || case["appHeaderError"].is_string() {
        Arc::new(FixtureAuth::denying())
    } else {
        Arc::new(FixtureAuth::accepting())
    }
}

fn oracle_responses(case: &Value) -> Vec<(u16, String)> {
    case["responses"]
        .as_array()
        .expect("responses")
        .iter()
        .map(|response| {
            (
                response["status"].as_u64().expect("status") as u16,
                response["body"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

fn oracle_delays(case: &Value) -> Vec<u64> {
    case["delays"]
        .as_array()
        .expect("delays")
        .iter()
        .map(|value| value.as_u64().expect("delay"))
        .collect()
}

fn oracle_paths(case: &Value) -> Vec<String> {
    case["requests"]
        .as_array()
        .expect("requests")
        .iter()
        .map(|request| request["pathWithQuery"].as_str().expect("path").to_owned())
        .collect()
}

fn recorded_paths(recorder: &Recorder, count: usize) -> Vec<String> {
    (0..count)
        .map(|_| recorder.next(Duration::from_secs(2)).path)
        .collect()
}

#[tokio::test]
#[ignore = "needs the JSON oracle written by tests/fixtures/ast_create_clip_reference.cjs --write under an execution lease (AST_CREATE_CLIP_ORACLE), plus a loopback recorder. It does not contact Twitch."]
async fn oracle_matches_native_clip_family() {
    let path = std::env::var("AST_CREATE_CLIP_ORACLE").expect("AST_CREATE_CLIP_ORACLE");
    let oracle: Value =
        serde_json::from_slice(&std::fs::read(&path).expect("oracle bytes")).expect("oracle json");
    assert_eq!(oracle["schema"], 1);

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let hashes = &oracle["provenance"]["hashes"];
    for (key, relative) in [
        ("create", "src/functions/clips/create.clip.ts"),
        ("getClip", "src/functions/clips/get_clip.clip.ts"),
        ("command", "src/commands/create_clip.command.ts"),
        ("astFamily", "src/utils/ast_parser/functions/clip.functions.ts"),
        ("nativeCreate", "src/functions/clips/create.clip.rs"),
        ("nativeMod", "src/functions/clips/mod.rs"),
        ("nativeCommand", "src/commands/create_clip.command.rs"),
        ("nativeCatalog", "src/utils/ast_parser/runtime/functions.rs"),
        ("nativeTest", "tests/ast_create_clip.rs"),
        ("oracle", "tests/fixtures/ast_create_clip_reference.cjs"),
    ] {
        let content = std::fs::read(root.join(relative)).expect(relative);
        assert_eq!(
            digest::sha256_hex(&content),
            hashes[key].as_str().expect(key),
            "{key}"
        );
    }

    let cases = oracle["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "only {} cases", cases.len());
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let mode = case["mode"].as_str().expect("case mode");
        let channel = case["channelID"].as_str().expect(id);
        let recorded = case["requests"].as_array().expect("requests").len();
        match mode {
            "create" => {
                let recorder = scripted(oracle_responses(case));
                let functions = service(&recorder.base_url, oracle_auth(case), None);
                let expected = &case["options"];
                let options = CreateClipOptions {
                    duration: expected["duration"].as_f64(),
                    title: expected["title"].as_str().map(str::to_owned),
                };
                let response = functions
                    .create_clip(channel, Some(&options))
                    .await
                    .expect("no cancellation");
                assert_eq!(
                    response.to_json_string(),
                    case["createResponseJson"].as_str().expect(id),
                    "{id}"
                );
                assert_eq!(
                    recorded_paths(&recorder, recorded),
                    oracle_paths(case),
                    "{id} requests"
                );
            }
            "getClip" => {
                let recorder = scripted(oracle_responses(case));
                let functions = service(&recorder.base_url, oracle_auth(case), None);
                let response = functions
                    .get_clip(case["clipID"].as_str().expect(id))
                    .await
                    .expect("no cancellation");
                assert_eq!(
                    response.to_json_string(),
                    case["getClipResponseJson"].as_str().expect(id),
                    "{id}"
                );
                assert_eq!(
                    recorded_paths(&recorder, recorded),
                    oracle_paths(case),
                    "{id} requests"
                );
            }
            "command" => {
                let parsed = parse_clip_options(case["argument"].as_str());
                assert_eq!(
                    serde_json::to_value(&parsed).expect("options"),
                    case["options"],
                    "{id}"
                );
                let recorder = scripted(oracle_responses(case));
                let functions = service(&recorder.base_url, oracle_auth(case), None);
                let waiter = RecordingWaiter::default();
                let response = functions
                    .create_clip_command_with(
                        channel,
                        case["argument"].as_str(),
                        &waiter,
                        None,
                    )
                    .await
                    .expect("no cancellation");
                let actual: Value =
                    serde_json::from_str(&response.to_json_string()).expect("command json");
                assert_eq!(actual, case["commandResponse"], "{id}");
                assert_eq!(waiter.waits(), oracle_delays(case), "{id} delays");
                assert_eq!(
                    recorded_paths(&recorder, recorded),
                    oracle_paths(case),
                    "{id} requests"
                );
            }
            "ast" => {
                let recorder = scripted(oracle_responses(case));
                let functions = service(&recorder.base_url, oracle_auth(case), None);
                let catalog = BotAstFunctions::with_twitch(
                    functions,
                    AstTimerScheduler::new(EmptyStore, FixedClock, SequentialIds(0)),
                );
                let args: Vec<JsValue> = case["astArgs"]
                    .as_array()
                    .expect(id)
                    .iter()
                    .map(|value| match value {
                        Value::Number(number) => JsValue::Number(number.as_f64().unwrap()),
                        Value::String(text) => JsValue::string(text),
                        Value::Bool(flag) => JsValue::Boolean(*flag),
                        Value::Null => JsValue::Null,
                        other => panic!("unsupported AST argument {other:?}"),
                    })
                    .collect();
                let result = catalog
                    .create_clip(&AstScope::new(channel), &args, case["astArgument"].as_str())
                    .await
                    .expect("catalog result");
                assert_eq!(
                    as_text(&result),
                    case["astResult"].as_str().expect(id),
                    "{id}"
                );
                assert_eq!(
                    recorded_paths(&recorder, recorded),
                    oracle_paths(case),
                    "{id} requests"
                );
            }
            other => panic!("unknown case mode {other}"),
        }
    }
}
