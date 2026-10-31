//! Native `createClip` (`POST clips`) and the read-back `getClip` (`GET clips?id=`).
//!
//! Sources:
//!
//! | TypeScript source                        | Native port                        |
//! |------------------------------------------|------------------------------------|
//! | `src/functions/clips/create.clip.ts`       | [`TwitchFunctions::create_clip`]    |
//! | `src/functions/clips/get_clip.clip.ts`     | [`TwitchFunctions::get_clip`]       |
//!
//! `getClip` is ported here because it is a **direct** dependency of
//! `createClipCommand` (`src/commands/create_clip.command.ts`), which polls the
//! new clip until Twitch returns it. The eventual split into
//! `src/functions/clips/get_clip.clip.rs` is recorded in
//! `migration-notes/ast-create-clip-handoff.md`; both entry points are inherent
//! methods on [`TwitchFunctions`], so a future split only moves code.
//!
//! # Failure shape
//!
//! Every outcome the TypeScript source can observe is an `Ok` **response value**,
//! including the `catch` block, which returns `{ error: true, message:
//! 'Internal server error' }`. The only `Err` this module produces is
//! [`ClipCancelled`], a cooperative cancellation that TypeScript cannot express:
//! the source's `fetch` has no `AbortSignal`. A caller that passes no
//! [`RequestCancellation`] therefore never sees `Err`.
//!
//! `createClip` authenticates with [`TwitchAuth::Bot`] and `getClip` with
//! [`TwitchAuth::App`], matching `getTwitchBotHeader()` and
//! `getTwitchAppHeader()`. A bot-header refusal is the source's
//! `status: 403, type: 'permission_error'` value and is **not** logged. An
//! app-header refusal is inside `getClip`'s `try`, so it becomes the logged
//! `"Internal server error"` value, exactly like the source.
//!
//! # Boundaries
//!
//! - The source logs with `logError(..., { destination: 'both' })`; the port
//!   writes to the injected [`crate::utils::logger::Logger`] when the caller
//!   configured one, and stays silent otherwise. The source's ISO `timestamp`,
//!   its JavaScript `stack`, and the absent optionals it omits from the payload
//!   are not reproduced (`stack` is a captured Rust backtrace).
//! - JSON keys that are present but **not strings** are treated as absent: the
//!   source's `message: errorData.message` would copy `null`/numbers through to
//!   callers that only ever test truthiness. Twitch returns strings here.
//! - A `data[0].id` (or `data.url`) that is a JSON number, boolean, array or
//!   object is rendered with JavaScript `String()` semantics
//!   ([`js_value_text`]); a string id is copied verbatim. Twitch returns
//!   strings.
//! - When `data.data` is a **string**, the source indexes its first UTF-16 code
//!   unit. A supplementary-plane first code unit is a lone surrogate, which a
//!   Rust `String` cannot hold, so the whole first scalar is returned instead.
//!   That shape is not a Twitch clip payload and changes no reachable response.
//!
//! Construction performs no I/O: the HTTP call goes through
//! [`TwitchFunctions::request_detailed`] (one attempt, matching the raw
//! `fetch`), and the canonical URL from
//! [`get_twitch_helix_url`](crate::utils::links::get_twitch_helix_url) keeps the
//! source shape while a loopback fixture only ever sees the configured base.

use std::fmt;

use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    functions::{
        DetailedRequestFailure, FunctionFailure, RequestCancellation, TwitchFunctions, query,
    },
    utils::{
        json_number::number_string,
        js_compat,
        links::get_twitch_helix_url,
        logger::{Destination, Level, LogOptions},
        twitch::TwitchAuth,
    },
};

/// `getTwitchHelixUrl('clips', …)` for both directions of the family.
pub const CLIP_ENDPOINT: &str = "clips";
/// `'Broadcaster must be live to create a clip'`.
pub const BROADCASTER_NOT_LIVE: &str = "Broadcaster must be live to create a clip";
/// `'Clip created'`.
pub const CLIP_CREATED: &str = "Clip created";
/// `'Twitch accepted clip request but did not return a clip ID.'` — includes the
/// source's trailing period.
pub const CLIP_ID_MISSING: &str =
    "Twitch accepted clip request but did not return a clip ID.";
/// `'Internal server error'` (both catch blocks).
pub const INTERNAL_SERVER_ERROR: &str = "Internal server error";
/// `'Clip not found'` (`getClip`'s empty `data.data`).
pub const CLIP_NOT_FOUND: &str = "Clip not found";
/// `'Success'` (`getClip`'s non-error message).
pub const GET_CLIP_SUCCESS: &str = "Success";
/// `'Clip ID is required'`.
pub const CLIP_ID_REQUIRED: &str = "Clip ID is required";

/// `CreateClipOptions` in `src/functions/clips/create.clip.ts`.
///
/// `duration` is `f64` because the source only tests `typeof === 'number'` and
/// `!isNaN`; the command's parser narrows it to `5..=60` or `30`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CreateClipOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl CreateClipOptions {
    pub fn with_duration(duration: f64) -> Self {
        Self {
            duration: Some(duration),
            title: None,
        }
    }

    pub fn with_title(title: impl Into<String>) -> Self {
        Self {
            duration: None,
            title: Some(title.into()),
        }
    }
}

/// Source `TwitchClip`. Kept as raw JSON: the source never validates it.
pub type TwitchClip = Value;

/// `CreateClipResponse`. Absent fields are `None` (`undefined`, omitted by
/// `JSON.stringify`); `clip_id` keeps the raw `data[0].id` value.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateClipResponse {
    pub error: bool,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub type_name: Option<String>,
    pub clip_id: Option<Value>,
}

impl CreateClipResponse {
    /// `{ error: true, message, status: 403, type: 'permission_error' }`.
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: Some(message.into()),
            status: Some(403),
            type_name: Some("permission_error".to_owned()),
            clip_id: None,
        }
    }

    /// `{ error: true, message: 'Broadcaster must be live to create a clip', status: 404, type: 'broadcaster_not_live' }`.
    pub fn not_live() -> Self {
        Self {
            error: true,
            message: Some(BROADCASTER_NOT_LIVE.to_owned()),
            status: Some(404),
            type_name: Some("broadcaster_not_live".to_owned()),
            clip_id: None,
        }
    }

    /// The `status !== 202` branch: `message` / `type` come straight from the
    /// Twitch error body and are `None` when absent or not strings.
    pub fn rejected(status: u16, message: Option<String>, type_name: Option<String>) -> Self {
        Self {
            error: true,
            message,
            status: Some(status),
            type_name,
            clip_id: None,
        }
    }

    /// `{ error: true, message: 'Twitch accepted clip request but did not return a clip ID.', status: 500, type: 'clip_id_missing' }`.
    pub fn clip_id_missing() -> Self {
        Self {
            error: true,
            message: Some(CLIP_ID_MISSING.to_owned()),
            status: Some(500),
            type_name: Some("clip_id_missing".to_owned()),
            clip_id: None,
        }
    }

    /// `{ error: false, message: 'Clip created', status: 202, type: 'success', clipID }`.
    pub fn created(clip_id: Option<Value>) -> Self {
        Self {
            error: false,
            message: Some(CLIP_CREATED.to_owned()),
            status: Some(202),
            type_name: Some("success".to_owned()),
            clip_id,
        }
    }

    /// The `catch` value: `{ error: true, message: 'Internal server error', type: 'error' }`.
    /// It carries **no** `status`, exactly like the source.
    pub fn internal_error() -> Self {
        Self {
            error: true,
            message: Some(INTERNAL_SERVER_ERROR.to_owned()),
            status: None,
            type_name: Some("error".to_owned()),
            clip_id: None,
        }
    }

    /// The id rendered the way the AST handler's template literal would render
    /// it, or `None` when the source's `!result.clipID` guard is true.
    pub fn clip_id_text(&self) -> Option<String> {
        self.clip_id
            .as_ref()
            .filter(|value| !js_value_is_falsy(*value))
            .map(js_value_text)
    }

    /// `JSON.stringify(response)` with the source's key order
    /// (`error, message, status, type, clipID`). Absent fields are omitted.
    pub fn to_json_string(&self) -> String {
        let mut out = format!("{{\"error\":{}}}", self.error);
        push_field(&mut out, "message", self.message.as_deref().map(Value::from));
        push_field(&mut out, "status", self.status.map(Value::from));
        push_field(
            &mut out,
            "type",
            self.type_name.as_deref().map(Value::from),
        );
        push_field(&mut out, "clipID", self.clip_id.clone());
        out.push('}');
        out
    }
}

/// `GetClipResponse`. `data` is the raw `data[0]`; `None` is `undefined`
/// (omitted by `JSON.stringify`), `Some(Value::Null)` is a `null` element.
#[derive(Clone, Debug, PartialEq)]
pub struct GetClipResponse {
    pub error: bool,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub type_name: Option<String>,
    pub data: Option<TwitchClip>,
}

impl GetClipResponse {
    pub fn clip_id_required() -> Self {
        Self {
            error: true,
            message: Some(CLIP_ID_REQUIRED.to_owned()),
            status: Some(400),
            type_name: Some("clip_id_required".to_owned()),
            data: None,
        }
    }

    pub fn not_found() -> Self {
        Self {
            error: true,
            message: Some(CLIP_NOT_FOUND.to_owned()),
            status: Some(404),
            type_name: Some("clip_not_found".to_owned()),
            data: None,
        }
    }

    /// The source's `data.error` branch, copying the Twitch body's fields.
    pub fn rejected(
        message: Option<String>,
        status: Option<u16>,
        type_name: Option<String>,
    ) -> Self {
        Self {
            error: true,
            message,
            status,
            type_name,
            data: None,
        }
    }

    pub fn success(data: Option<TwitchClip>) -> Self {
        Self {
            error: false,
            message: Some(GET_CLIP_SUCCESS.to_owned()),
            status: None,
            type_name: None,
            data,
        }
    }

    /// The `catch` value: `{ error: true, message: 'Internal server error' }`.
    pub fn internal_error() -> Self {
        Self {
            error: true,
            message: Some(INTERNAL_SERVER_ERROR.to_owned()),
            status: None,
            type_name: None,
            data: None,
        }
    }

    /// `JSON.stringify(response)` with the source's key order
    /// (`error, message, status, type, data`).
    pub fn to_json_string(&self) -> String {
        let mut out = format!("{{\"error\":{}}}", self.error);
        push_field(&mut out, "message", self.message.as_deref().map(Value::from));
        push_field(&mut out, "status", self.status.map(Value::from));
        push_field(
            &mut out,
            "type",
            self.type_name.as_deref().map(Value::from),
        );
        push_field(&mut out, "data", self.data.clone());
        out.push('}');
        out
    }
}

/// Why `createClip` / `getClip` reached their `catch` block.
///
/// Every variant becomes the logged `error` string and the source's
/// `"Internal server error"` value; none escapes to the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipFailure {
    /// `await response.json()` rejected.
    InvalidJson(String),
    /// Reading a property of `null`, which throws in JavaScript.
    NullPropertyAccess(&'static str),
    /// Reading a property of `undefined`, which throws in JavaScript.
    UndefinedPropertyAccess(&'static str),
    /// `response.bytes()` failed where `response.json()` would have.
    UnreadableBody,
    /// The app token could not be acquired (`getTwitchAppHeader` throws).
    AuthUnavailable,
    /// Transport failure before a response existed.
    Transport(String),
}

impl fmt::Display for ClipFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(reason) | Self::Transport(reason) => formatter.write_str(reason),
            Self::NullPropertyAccess(property) => {
                write!(
                    formatter,
                    "Cannot read properties of null (reading '{property}')"
                )
            }
            Self::UndefinedPropertyAccess(property) => {
                write!(
                    formatter,
                    "Cannot read properties of undefined (reading '{property}')"
                )
            }
            Self::UnreadableBody => formatter.write_str("Twitch response body could not be read"),
            Self::AuthUnavailable => formatter.write_str("Twitch authentication unavailable"),
        }
    }
}

impl std::error::Error for ClipFailure {}

/// The only failure that is **not** a source response value: cooperative
/// cancellation. The TypeScript source has no cancellation path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipCancelled;

impl fmt::Display for ClipCancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Twitch request cancelled")
    }
}

impl std::error::Error for ClipCancelled {}

/// One `POST clips` request: endpoint, `URLSearchParams` text and canonical URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateClipRequest {
    pub endpoint: &'static str,
    pub params: String,
    pub url: String,
}

/// One `GET clips?id=` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GetClipRequest {
    pub endpoint: &'static str,
    pub params: String,
    pub url: String,
}

/// `URLSearchParams` order: `broadcaster_id`, then `duration`, then `title`.
///
/// `duration` is appended when it is a number and not `NaN`; `title` is appended
/// when it is **truthy** (an empty string is skipped) and its **trimmed** value
/// is what goes on the wire, so a whitespace-only title produces `title=`.
pub fn create_clip_request(
    channel_id: &str,
    options: Option<&CreateClipOptions>,
) -> CreateClipRequest {
    let mut pairs = vec![("broadcaster_id".to_owned(), channel_id.to_owned())];
    if let Some(options) = options {
        if let Some(duration) = options.duration.filter(|duration| !duration.is_nan()) {
            pairs.push(("duration".to_owned(), number_string(duration)));
        }
        if let Some(title) = options.title.as_deref().filter(|title| !title.is_empty()) {
            pairs.push(("title".to_owned(), js_compat::trim(title).to_owned()));
        }
    }
    let params = query(pairs);
    let url = get_twitch_helix_url(CLIP_ENDPOINT, Some(&params));
    CreateClipRequest {
        endpoint: CLIP_ENDPOINT,
        params,
        url,
    }
}

/// `URLSearchParams` with the single `id` parameter.
pub fn get_clip_request(clip_id: &str) -> GetClipRequest {
    let params = query([("id".to_owned(), clip_id.to_owned())]);
    let url = get_twitch_helix_url(CLIP_ENDPOINT, Some(&params));
    GetClipRequest {
        endpoint: CLIP_ENDPOINT,
        params,
        url,
    }
}

/// Decode one `createClip` response the way the source does.
///
/// `404` is answered from the status alone (the body is never parsed). Any
/// other status parses JSON first: `202` follows the clip-id path and every
/// other status the Twitch-error path.
pub fn create_clip_body(
    status: u16,
    bytes: &[u8],
) -> Result<CreateClipResponse, ClipFailure> {
    if status == 404 {
        return Ok(CreateClipResponse::not_live());
    }
    let data: Value = serde_json::from_slice(bytes).map_err(|error| {
        ClipFailure::InvalidJson(format!("Invalid JSON response body ({error})"))
    })?;
    if data.is_null() {
        // `errorData.message` / `data.data` on a `null` root throws.
        return Err(ClipFailure::NullPropertyAccess(if status == 202 {
            "data"
        } else {
            "message"
        }));
    }
    if status != 202 {
        return Ok(CreateClipResponse::rejected(
            status,
            string_property(&data, "message"),
            string_property(&data, "error"),
        ));
    }
    let Some(payload) = data.get("data") else {
        // `!data.data` — a missing property is `undefined` and therefore falsy.
        return Ok(CreateClipResponse::clip_id_missing());
    };
    if js_value_is_falsy(payload) {
        return Ok(CreateClipResponse::clip_id_missing());
    }
    if let Value::Array(items) = payload
        && items.is_empty()
    {
        // `[]` is truthy but `[].length === 0`, which the source also rejects.
        return Ok(CreateClipResponse::clip_id_missing());
    }
    // `data.data[0]` then `.id`. Only an array element can carry an id; a string
    // indexes a primitive whose `.id` is `undefined`, while a boolean, number or
    // object indexes `undefined` and throws on `.id`.
    match payload {
        Value::Array(items) => match items.first() {
            Some(Value::Null) => Err(ClipFailure::NullPropertyAccess("id")),
            Some(Value::Object(map)) => Ok(CreateClipResponse::created(map.get("id").cloned())),
            Some(_) => Ok(CreateClipResponse::created(None)),
            // Unreachable: an empty array returned above.
            None => Err(ClipFailure::UndefinedPropertyAccess("id")),
        },
        Value::String(_) => Ok(CreateClipResponse::created(None)),
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => {
            Err(ClipFailure::UndefinedPropertyAccess("id"))
        }
        // Unreachable: `null` returned through the falsiness check above.
        Value::Null => Err(ClipFailure::NullPropertyAccess("id")),
    }
}

/// Decode one `getClip` response. The source never inspects the HTTP status:
/// it reads the body and branches on `data.error`.
pub fn get_clip_body(bytes: &[u8]) -> Result<GetClipResponse, ClipFailure> {
    let data: Value = serde_json::from_slice(bytes).map_err(|error| {
        ClipFailure::InvalidJson(format!("Invalid JSON response body ({error})"))
    })?;
    if data.is_null() {
        // `data.error` on a `null` root throws.
        return Err(ClipFailure::NullPropertyAccess("error"));
    }
    if data.get("error").is_some_and(js_value_is_truthy) {
        return Ok(GetClipResponse::rejected(
            string_property(&data, "message"),
            integer_property(&data, "status"),
            string_property(&data, "error"),
        ));
    }
    let Some(payload) = data.get("data") else {
        return Err(ClipFailure::UndefinedPropertyAccess("length"));
    };
    let length = json_length(payload)?;
    if length == Some(0) {
        return Ok(GetClipResponse::not_found());
    }
    Ok(GetClipResponse::success(first_element(payload)?))
}

impl TwitchFunctions {
    /// Port of `createClip(channelID, options?)`.
    ///
    /// Bot token, `POST clips`, `202` success, `404` broadcaster-not-live, and
    /// the logged `"Internal server error"` catch value.
    pub async fn create_clip(
        &self,
        channel_id: &str,
        options: Option<&CreateClipOptions>,
    ) -> Result<CreateClipResponse, ClipCancelled> {
        self.create_clip_with_cancellation(channel_id, options, None)
            .await
    }

    /// [`TwitchFunctions::create_clip`] with the native cooperative
    /// cancellation token.
    pub async fn create_clip_with_cancellation(
        &self,
        channel_id: &str,
        options: Option<&CreateClipOptions>,
        cancel: Option<&RequestCancellation>,
    ) -> Result<CreateClipResponse, ClipCancelled> {
        let request = create_clip_request(channel_id, options);
        let response = match self
            .request_detailed(
                TwitchAuth::Bot,
                Method::POST,
                request.endpoint,
                Some(&request.params),
                None,
                cancel,
            )
            .await
        {
            Ok(response) => response,
            // `getTwitchBotHeader()` refused: the source's 403 value, unlogged.
            Err(DetailedRequestFailure::Auth(FunctionFailure::Denied(message))) => {
                return Ok(CreateClipResponse::permission_denied(message));
            }
            Err(DetailedRequestFailure::Cancelled) => return Err(ClipCancelled),
            Err(error) => {
                let failure = match error {
                    DetailedRequestFailure::Auth(FunctionFailure::Internal) => {
                        ClipFailure::AuthUnavailable
                    }
                    DetailedRequestFailure::Twitch(error) => {
                        ClipFailure::Transport(error.to_string())
                    }
                    // Both arms above are handled before this match.
                    DetailedRequestFailure::Auth(FunctionFailure::Denied(_))
                    | DetailedRequestFailure::Cancelled => ClipFailure::AuthUnavailable,
                };
                self.log_create_failure(channel_id, options, &failure).await;
                return Ok(CreateClipResponse::internal_error());
            }
        };
        let status = response.status().as_u16();
        if status == 404 {
            // `response.status === 404` returns before `response.json()`.
            return Ok(CreateClipResponse::not_live());
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => {
                self.log_create_failure(channel_id, options, &ClipFailure::UnreadableBody)
                    .await;
                return Ok(CreateClipResponse::internal_error());
            }
        };
        match create_clip_body(status, &bytes) {
            Ok(response) => Ok(response),
            Err(failure) => {
                self.log_create_failure(channel_id, options, &failure).await;
                Ok(CreateClipResponse::internal_error())
            }
        }
    }

    /// Port of `getClip(clipID)`.
    ///
    /// App token; the header step runs **before** the empty-id check, as in the
    /// source; the body decides the result and the HTTP status is ignored.
    pub async fn get_clip(&self, clip_id: &str) -> Result<GetClipResponse, ClipCancelled> {
        self.get_clip_with_cancellation(clip_id, None).await
    }

    /// [`TwitchFunctions::get_clip`] with the native cooperative cancellation
    /// token.
    pub async fn get_clip_with_cancellation(
        &self,
        clip_id: &str,
        cancel: Option<&RequestCancellation>,
    ) -> Result<GetClipResponse, ClipCancelled> {
        if clip_id.is_empty() {
            // The source acquires the app header first, then rejects the empty
            // id. Reproduce the header step so an unavailable token still wins.
            return match self.auth.acquire(&TwitchAuth::App).await {
                Ok(_) => Ok(GetClipResponse::clip_id_required()),
                Err(_) => {
                    self.log_get_failure(clip_id, &ClipFailure::AuthUnavailable)
                        .await;
                    Ok(GetClipResponse::internal_error())
                }
            };
        }
        let request = get_clip_request(clip_id);
        let response = match self
            .request_detailed(
                TwitchAuth::App,
                Method::GET,
                request.endpoint,
                Some(&request.params),
                None,
                cancel,
            )
            .await
        {
            Ok(response) => response,
            Err(DetailedRequestFailure::Cancelled) => return Err(ClipCancelled),
            Err(error) => {
                // `getTwitchAppHeader()` throws inside the source's `try`.
                let failure = match error {
                    DetailedRequestFailure::Twitch(error) => {
                        ClipFailure::Transport(error.to_string())
                    }
                    _ => ClipFailure::AuthUnavailable,
                };
                self.log_get_failure(clip_id, &failure).await;
                return Ok(GetClipResponse::internal_error());
            }
        };
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => {
                self.log_get_failure(clip_id, &ClipFailure::UnreadableBody)
                    .await;
                return Ok(GetClipResponse::internal_error());
            }
        };
        match get_clip_body(&bytes) {
            Ok(response) => Ok(response),
            Err(failure) => {
                self.log_get_failure(clip_id, &failure).await;
                Ok(GetClipResponse::internal_error())
            }
        }
    }

    async fn log_create_failure(
        &self,
        channel_id: &str,
        options: Option<&CreateClipOptions>,
        failure: &ClipFailure,
    ) {
        let payload = json!({
            "function": "createClip",
            "channelID": channel_id,
            "options": options.cloned().unwrap_or_default(),
            "error": failure.to_string(),
            "stack": std::backtrace::Backtrace::force_capture().to_string(),
        });
        if let Some(logger) = &self.logger {
            let _report = logger
                .log(
                    Level::Error,
                    payload,
                    LogOptions {
                        destination: Destination::Both,
                        channel_id: Some(channel_id.to_owned()),
                        ..LogOptions::default()
                    },
                )
                .await;
        } else {
            eprintln!("createClip: native Twitch operation failed (no logger configured)");
        }
    }

    async fn log_get_failure(&self, clip_id: &str, failure: &ClipFailure) {
        let payload = json!({
            "function": "getClip",
            "clipID": clip_id,
            "error": failure.to_string(),
            "stack": std::backtrace::Backtrace::force_capture().to_string(),
        });
        if let Some(logger) = &self.logger {
            // The source passes no `channelId` for this function.
            let _report = logger
                .log(
                    Level::Error,
                    payload,
                    LogOptions {
                        destination: Destination::Both,
                        ..LogOptions::default()
                    },
                )
                .await;
        } else {
            eprintln!("getClip: native Twitch operation failed (no logger configured)");
        }
    }
}

/// JavaScript `String(value)` for a validated JSON value.
pub fn js_value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => number_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let rendered: Vec<String> = items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => js_value_text(other),
                })
                .collect();
            rendered.join(",")
        }
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript truthiness of a validated JSON value. Arrays and objects are
/// always truthy, including empty ones.
pub fn js_value_is_truthy(value: &Value) -> bool {
    !js_value_is_falsy(value)
}

/// JavaScript falsiness: `null`, `false`, `0`, `NaN` and `''`.
pub fn js_value_is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !*flag,
        Value::Number(number) => number.as_f64().is_none_or(|number| number == 0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

/// `value.length` in JavaScript: `None` is `undefined` (never `=== 0`).
fn json_length(value: &Value) -> Result<Option<usize>, ClipFailure> {
    match value {
        Value::Array(items) => Ok(Some(items.len())),
        Value::String(text) => Ok(Some(text.encode_utf16().count())),
        Value::Null => Err(ClipFailure::NullPropertyAccess("length")),
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => Ok(None),
    }
}

/// `value[0]` in JavaScript: `None` is `undefined`.
fn first_element(value: &Value) -> Result<Option<Value>, ClipFailure> {
    match value {
        Value::Array(items) => Ok(items.first().cloned()),
        Value::String(text) => Ok(text.chars().next().map(|first| Value::from(first.to_string()))),
        Value::Null => Err(ClipFailure::NullPropertyAccess("0")),
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => Ok(None),
    }
}

fn string_property(data: &Value, key: &str) -> Option<String> {
    match data.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `data.status` copied as a `u16`: non-integers, negatives and values above
/// `u16::MAX` are treated as absent.
fn integer_property(data: &Value, key: &str) -> Option<u16> {
    data.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
}

fn push_field(out: &mut String, key: &str, value: Option<Value>) {
    let Some(value) = value else {
        return;
    };
    out.push_str(",\"");
    out.push_str(key);
    out.push_str("\":");
    out.push_str(
        &serde_json::to_string(&value).expect("JSON value serialization cannot fail"),
    );
}
