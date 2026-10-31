//! Native port of `src/commands/create_clip.command.ts`.
//!
//! | TypeScript source                        | Native port                                    |
//! |------------------------------------------|------------------------------------------------|
//! | `parseClipOptions(argument?)`              | [`parse_clip_options`]                          |
//! | `createClipCommand(channelID, argument?)`  | [`TwitchFunctions::create_clip_command`]         |
//! | `checkClipStatus(clipID, retries = 0)`     | [`TwitchFunctions::check_clip_status`]           |
//! | `DEFAULT_CLIP_DURATION` / `MIN` / `MAX`     | [`DEFAULT_CLIP_DURATION`] and friends            |
//!
//! The command composes the native `createClip` and `getClip` ports from
//! [`crate::functions::clips`]; it owns no HTTP request of its own.
//!
//! # Failure shape
//!
//! Every source outcome is an `Ok` response value, including the `catch` block.
//! The only `Err` is [`ClipCancelled`], which the source cannot express: its
//! `setTimeout` retry loop has no abort path. Callers that pass no
//! [`RequestCancellation`] never see it.
//!
//! # Retry pause
//!
//! `checkClipStatus` sleeps 2000 ms between a `404` and the next `getClip`,
//! at most 15 times (16 `getClip` calls). That pause is a seam,
//! [`ClipStatusWaiter`], so a test can prove the retry count without wall-clock
//! time; production uses [`TokioClipStatusWaiter`]. The pause is **not** dropped
//! or shortened: it protects Twitch's clip pipeline from a hot poll loop.
//!
//! # Boundaries
//!
//! - `parseClipOptions` uses JavaScript `String.prototype.trim` /
//!   `/\s+/` / `Number(...)` semantics through
//!   [`crate::utils::js_compat`] and
//!   [`crate::utils::ast_evaluator::to_number`]; a feature set that compiles
//!   this module must include both.
//! - The source's `catch` logs
//!   `{ function: 'createClipCommand', channelID, argument, error, stack }`.
//!   Natively the only throw-like path is cancellation, so the plain
//!   [`TwitchFunctions::create_clip_command`] wrapper projects `Err` onto the
//!   source's catch response and logs it with those fields. The source's ISO
//!   `timestamp` and JavaScript `stack` are not reproduced.
//! - `JSON.stringify` field order differs between the source's success branch
//!   (`clipData` before `status`) and its error branches; the native JSON view
//!   is object-equivalent, not byte-identical, and is documented as such.

use std::time::Duration;

use serde_json::{Value, json};

use crate::{
    functions::{
        FunctionFuture, RequestCancellation, TwitchFunctions,
        clips::{
            ClipCancelled, CreateClipOptions, GetClipResponse, js_value_is_falsy, js_value_text,
        },
    },
    utils::{
        ast_evaluator::{JsString, JsValue, to_number},
        js_compat,
        logger::{Destination, Level, LogOptions},
    },
};

/// `DEFAULT_CLIP_DURATION` — used when the parsed number is out of range.
pub const DEFAULT_CLIP_DURATION: f64 = 30.0;
/// `MIN_CLIP_DURATION`.
pub const MIN_CLIP_DURATION: f64 = 5.0;
/// `MAX_CLIP_DURATION`.
pub const MAX_CLIP_DURATION: f64 = 60.0;
/// `retries < 15`: at most 15 pauses and 16 `getClip` calls.
pub const CLIP_STATUS_RETRIES: u32 = 15;
/// `setTimeout(resolve, 2000)`.
pub const CLIP_STATUS_POLL_MILLIS: u64 = 2_000;

/// `parseClipOptions(argument?)`.
///
/// A leading token that `Number()` accepts becomes `duration` — clamped to
/// `30` when it is outside `5..=60` — and the remaining tokens become the
/// trimmed `title`. A first token that is not a number makes the **whole**
/// trimmed argument the title and leaves `duration` unset.
///
/// Concrete JavaScript cases: `"1e1"` → 10, `"0x10"` → 16, `"Infinity"` → 30,
/// `"NaN"`/`"abc"` → title, `"5  chill"` → duration 5 title `"chill"`,
/// `"5"` → duration 5 with no title.
pub fn parse_clip_options(argument: Option<&str>) -> CreateClipOptions {
    let Some(trimmed_argument) = argument
        .map(js_compat::trim)
        .filter(|argument| !argument.is_empty())
    else {
        return CreateClipOptions::default();
    };

    // `const [firstToken, ...restTokens] = trimmedArgument.split(/\s+/);`
    let mut tokens = js_tokens(trimmed_argument).into_iter();
    let first_token = tokens.next().unwrap_or_default();
    let rest_tokens: Vec<&str> = tokens.collect();

    let parsed_number = js_number(first_token);
    if parsed_number.is_nan() {
        return CreateClipOptions {
            duration: None,
            title: Some(trimmed_argument.to_owned()),
        };
    }

    let duration = if (MIN_CLIP_DURATION..=MAX_CLIP_DURATION).contains(&parsed_number) {
        parsed_number
    } else {
        DEFAULT_CLIP_DURATION
    };
    // `restTokens.join(' ').trim() || undefined`
    let title = js_compat::trim(&rest_tokens.join(" ")).to_owned();
    CreateClipOptions {
        duration: Some(duration),
        title: if title.is_empty() { None } else { Some(title) },
    }
}

/// `createClipCommand`'s response.
///
/// `message` is optional because the `if (clipData.error) return clipData;`
/// branch forwards `getClip`'s message, which can be absent when Twitch omitted
/// it. `clip_data` is the success branch's `clipData`; `data` is the forwarded
/// `getClip` payload. A given call sets at most one of them.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateClipCommandResponse {
    pub error: bool,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub type_name: Option<String>,
    pub clip_data: Option<Value>,
    pub data: Option<Value>,
}

impl CreateClipCommandResponse {
    /// `{ error: true, message: 'Clip creation is currently unavailable.', status: 503, type: 'Clip creation unavailable' }`.
    pub fn unavailable() -> Self {
        Self {
            error: true,
            message: Some("Clip creation is currently unavailable.".to_owned()),
            status: Some(503),
            type_name: Some("Clip creation unavailable".to_owned()),
            clip_data: None,
            data: None,
        }
    }

    /// `{ error: true, message: 'There was an internal Twitch server error that we cannot resolve.', status, type: 'Clip creation error' }`.
    pub fn twitch_server_error(status: u16) -> Self {
        Self {
            error: true,
            message: Some(
                "There was an internal Twitch server error that we cannot resolve.".to_owned(),
            ),
            status: Some(status),
            type_name: Some("Clip creation error".to_owned()),
            clip_data: None,
            data: None,
        }
    }

    /// The `createClipFun.error` branch: `message || 'Error creating clip'`.
    pub fn create_failure(
        message: Option<String>,
        status: Option<u16>,
        type_name: Option<String>,
    ) -> Self {
        Self {
            error: true,
            message: Some(message.filter(|text| !text.is_empty()).unwrap_or_else(|| {
                "Error creating clip".to_owned()
            })),
            status,
            type_name,
            clip_data: None,
            data: None,
        }
    }

    /// `{ error: true, message: 'Clip ID not returned from creation', status: 500, type: 'Clip creation error' }`.
    pub fn clip_id_missing() -> Self {
        Self {
            error: true,
            message: Some("Clip ID not returned from creation".to_owned()),
            status: Some(500),
            type_name: Some("Clip creation error".to_owned()),
            clip_data: None,
            data: None,
        }
    }

    /// `{ error: true, message: 'There was an error finding the clip, …', status: 404, type: 'Clip not found' }`.
    pub fn clip_not_found() -> Self {
        Self {
            error: true,
            message: Some(
                "There was an error finding the clip, it may have been created but is taking too \
                 long to process. Please check your clips later."
                    .to_owned(),
            ),
            status: Some(404),
            type_name: Some("Clip not found".to_owned()),
            clip_data: None,
            data: None,
        }
    }

    /// `{ error: true, message: 'There was an unexpected error retrieving the clip data.', status: 500, type: 'Clip data missing' }`.
    pub fn clip_data_missing() -> Self {
        Self {
            error: true,
            message: Some(
                "There was an unexpected error retrieving the clip data.".to_owned(),
            ),
            status: Some(500),
            type_name: Some("Clip data missing".to_owned()),
            clip_data: None,
            data: None,
        }
    }

    /// `{ error: false, message: 'Clip created successfully: <url>', clipData, status: 200, type: 'Clip created' }`.
    pub fn created(data: Value) -> Self {
        let url = match &data {
            Value::Object(map) => map
                .get("url")
                .map(js_value_text)
                .unwrap_or_else(|| "undefined".to_owned()),
            _ => "undefined".to_owned(),
        };
        Self {
            error: false,
            message: Some(format!("Clip created successfully: {url}")),
            status: Some(200),
            type_name: Some("Clip created".to_owned()),
            clip_data: Some(data),
            data: None,
        }
    }

    /// The forwarded `getClip` error branch: `return clipData;`.
    pub fn from_clip_lookup(clip: GetClipResponse) -> Self {
        Self {
            error: true,
            message: clip.message,
            status: clip.status,
            type_name: clip.type_name,
            clip_data: None,
            data: clip.data,
        }
    }

    /// The `catch` value: `{ error: true, message: 'Internal server error' }`.
    pub fn internal_error() -> Self {
        Self {
            error: true,
            message: Some("Internal server error".to_owned()),
            status: None,
            type_name: None,
            clip_data: None,
            data: None,
        }
    }

    /// Field-order-stable JSON view. Object-equivalent to the source's
    /// `JSON.stringify`; the success branch's source order puts `clipData`
    /// before `status`, which this view does not reproduce byte for byte.
    pub fn to_json_string(&self) -> String {
        let mut out = format!("{{\"error\":{}}}", self.error);
        push_field(&mut out, "message", self.message.as_deref().map(Value::from));
        push_field(&mut out, "status", self.status.map(Value::from));
        push_field(
            &mut out,
            "type",
            self.type_name.as_deref().map(Value::from),
        );
        push_field(&mut out, "clipData", self.clip_data.clone());
        push_field(&mut out, "data", self.data.clone());
        out.push('}');
        out
    }
}

/// The pause `checkClipStatus` performs between polls.
///
/// The production adapter is [`TokioClipStatusWaiter`]; tests inject a recorder
/// so a 15-retry sequence costs no wall-clock time.
pub trait ClipStatusWaiter: Send + Sync {
    fn wait_millis<'a>(&'a self, millis: u64) -> FunctionFuture<'a, ()>;
}

/// Production [`ClipStatusWaiter`]: a Tokio timer.
#[derive(Clone, Copy, Debug, Default)]
pub struct TokioClipStatusWaiter;

impl ClipStatusWaiter for TokioClipStatusWaiter {
    fn wait_millis<'a>(&'a self, millis: u64) -> FunctionFuture<'a, ()> {
        Box::pin(async move {
            if millis > 0 {
                tokio::time::sleep(Duration::from_millis(millis)).await;
            }
        })
    }
}

impl TwitchFunctions {
    /// Port of `createClipCommand(channelID, argument?)` with the production
    /// waiter and no cancellation token, so the source's response shape is
    /// total.
    pub async fn create_clip_command(
        &self,
        channel_id: &str,
        argument: Option<&str>,
    ) -> CreateClipCommandResponse {
        match self
            .create_clip_command_with(channel_id, argument, &TokioClipStatusWaiter, None)
            .await
        {
            Ok(response) => response,
            // Unreachable without a cancellation token. The source's own throw
            // path returns and logs exactly this shape.
            Err(ClipCancelled) => {
                self.log_command_failure(channel_id, argument, &ClipCancelled)
                    .await;
                CreateClipCommandResponse::internal_error()
            }
        }
    }

    /// [`TwitchFunctions::create_clip_command`] with an injected retry pause and
    /// the native cooperative cancellation token.
    pub async fn create_clip_command_with(
        &self,
        channel_id: &str,
        argument: Option<&str>,
        waiter: &dyn ClipStatusWaiter,
        cancel: Option<&RequestCancellation>,
    ) -> Result<CreateClipCommandResponse, ClipCancelled> {
        let options = parse_clip_options(argument);
        let created = self
            .create_clip_with_cancellation(channel_id, Some(&options), cancel)
            .await?;

        if created.status == Some(503) {
            return Ok(CreateClipCommandResponse::unavailable());
        }
        // `if (createClipFun.status && createClipFun.status > 500)`
        if let Some(status) = created.status.filter(|status| *status > 500 && *status != 0) {
            return Ok(CreateClipCommandResponse::twitch_server_error(status));
        }
        if created.error {
            return Ok(CreateClipCommandResponse::create_failure(
                created.message,
                created.status,
                created.type_name,
            ));
        }

        // `const clipID = createClipFun.clipID; if (!clipID)`
        let Some(clip_id) = created.clip_id_text() else {
            return Ok(CreateClipCommandResponse::clip_id_missing());
        };

        let clip = self.check_clip_status(&clip_id, waiter, cancel).await?;
        if clip.status == Some(404) {
            return Ok(CreateClipCommandResponse::clip_not_found());
        }
        if clip.error {
            return Ok(CreateClipCommandResponse::from_clip_lookup(clip));
        }
        // `if (!clipData.data)`
        let Some(data) = clip.data.filter(|data| !js_value_is_falsy(data)) else {
            return Ok(CreateClipCommandResponse::clip_data_missing());
        };
        Ok(CreateClipCommandResponse::created(data))
    }

    /// Port of `checkClipStatus(clipID, retries = 0)`.
    ///
    /// Polls `getClip` and repeats after [`CLIP_STATUS_POLL_MILLIS`] while the
    /// lookup answered `404` and fewer than [`CLIP_STATUS_RETRIES`] pauses have
    /// happened. A non-`404` error and any success return immediately, exactly
    /// like the source's two branches.
    pub async fn check_clip_status(
        &self,
        clip_id: &str,
        waiter: &dyn ClipStatusWaiter,
        cancel: Option<&RequestCancellation>,
    ) -> Result<GetClipResponse, ClipCancelled> {
        let mut retries = 0u32;
        loop {
            if cancel.is_some_and(RequestCancellation::is_cancelled) {
                return Err(ClipCancelled);
            }
            let clip = self.get_clip_with_cancellation(clip_id, cancel).await?;
            if clip.error && clip.status == Some(404) && retries < CLIP_STATUS_RETRIES {
                waiter.wait_millis(CLIP_STATUS_POLL_MILLIS).await;
                retries += 1;
                continue;
            }
            return Ok(clip);
        }
    }

    async fn log_command_failure(
        &self,
        channel_id: &str,
        argument: Option<&str>,
        failure: &ClipCancelled,
    ) {
        let payload = json!({
            "function": "createClipCommand",
            "channelID": channel_id,
            "argument": argument,
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
            eprintln!(
                "createClipCommand: native Twitch operation failed (no logger configured)"
            );
        }
    }
}

/// `String.prototype.split(/\s+/)` on a trimmed, non-empty string.
fn js_tokens(text: &str) -> Vec<&str> {
    text.split(js_compat::is_whitespace)
        .filter(|token| !token.is_empty())
        .collect()
}

/// `Number(token)`, the JavaScript conversion including `0x`/`0b`/`0o`,
/// `Infinity`, and whitespace trimming.
fn js_number(token: &str) -> f64 {
    to_number(&JsValue::String(JsString::from(token)))
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
