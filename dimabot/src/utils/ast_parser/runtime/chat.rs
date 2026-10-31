//! Native port of the **context half** of
//! `src/functions/chats/send_message.chat.ts`.
//!
//! The context-free plain send already exists as
//! [`TwitchFunctions::send_message_plain`] and is reused unchanged. This module
//! adds the two things that reserved port intentionally leaves out:
//!
//! 1. the **reply-parent** Helix request (`reply_parent_message_id`), and
//! 2. the **context-aware** flow that renders the authored AST body, sends the
//!    rendered text and then dispatches the queued command references.
//!
//! Source behaviour preserved:
//!
//! - `parseSpecialCommands` runs only when a [`SpecialParserContext`] is
//!   supplied. A parse failure is logged as a warning and the **original**
//!   text is sent with no command references, exactly as the source does.
//! - The rendered text is trimmed only to decide whether anything must be sent;
//!   the untrimmed rendered text is the message body.
//! - A blank rendered text (`''.trim()`) skips the HTTP request and delivers the
//!   collected references instead. That delivery result is returned.
//! - Otherwise the outer message is sent first. Token failure, a rejected
//!   status, `is_sent === false` and a transport/parse failure all return
//!   **before** any command reference runs.
//! - After a successful send the references are delivered with
//!   `parsed_text: ''` (the rendered text is never sent twice) and the source
//!   discards that delivery result; this port also discards its `Ok` value but
//!   still propagates a typed failure, which TypeScript cannot express.
//! - `replyToMessageId` is forwarded to the outer send only. Reference delivery
//!   is a plain send with no reply target, matching the source.
//!
//! Explicit migration boundaries (not silently claimed):
//!
//! - The source acquires the app token itself (`getAppToken('twitch')`). The
//!   native port delegates that to the existing token lifecycle inside
//!   [`TwitchFunctions::request_detailed`] and
//!   [`TwitchFunctions::send_message_plain`]; a token failure is reported with
//!   the source's `"Failed to get Twitch app token"` text and `status: 500`.
//! - [`SendResult`] carries `error`, `message` and `status`. The source's extra
//!   `type`/`reason`/`data` fields stay available on the richer
//!   [`PlainMessageResponse`] the reserved plain port returns; the reply-parent
//!   path builds the same shape internally but this seam keeps only the shared
//!   projection.
//! - The reply-parent path reports cancellation as
//!   [`AstRuntimeError::Cancelled`]. The reserved plain port maps cancellation to
//!   a caught failure `SendResult`; that asymmetry belongs to the reserved port
//!   and is not changed here. This port never cancels on its own.
//! - Logging is opt-in through the injected [`Logger`]; with no logger the
//!   adapter stays silent instead of writing to a process-global console. Log
//!   payload fields match the source except its ISO `timestamp`, its JavaScript
//!   `stack`, and absent optionals (encoded as `null` here).
//! - JSON object key order is not preserved by the existing native request body
//!   (`serde_json` maps sort keys); fields and values are identical.

use std::sync::Arc;

use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    functions::{
        DetailedRequestFailure, RequestCancellation, TwitchFunctions,
        chats::send_message_plain::{
            CANCELLED_REASON, HELD_MESSAGE, HELD_REASON, PlainMessageResponse, SEND_FAILURE,
            SENT_MESSAGE, TOKEN_FAILURE,
        },
        prefix_utf16,
    },
    utils::{
        js_compat,
        logger::{Level, LogOptions, Logger},
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};

use super::delivery::{DeliverySeams, deliver_ast_message};
use super::{
    AstBodyParser, AstMessage, AstRuntimeError, BoxFuture, ChatSender, CommandRunner, SendResult,
    SpecialParserContext,
};

/// Source `MODERATOR_ID`; identical to the shared bot account constant.
pub const MODERATOR_ID: &str = TWITCH_BOT_ACCOUNT_ID;

/// Source field order is retained by struct serialization.
#[derive(Serialize)]
struct ReplyParentChatBody<'a> {
    broadcaster_id: &'a str,
    sender_id: &'static str,
    message: &'a str,
    for_source_only: bool,
    reply_parent_message_id: &'a str,
}

/// Project the source's richer chat response onto the shared [`SendResult`].
pub fn send_result_from_plain(response: &PlainMessageResponse) -> SendResult {
    let fallback = if response.error {
        response.reason.as_deref().unwrap_or(SEND_FAILURE)
    } else {
        SENT_MESSAGE
    };
    SendResult {
        error: response.error,
        message: response.message_text_or(fallback),
        status: Some(response.status),
    }
}

/// Send one chat message, plain or as a reply to `reply_to_message_id`.
///
/// This is the source's `sendTwitchChatMessage(channelID, message,
/// replyToMessageId)` without a parser/context: the context-aware wrapper below
/// calls it.
pub async fn send_chat_message(
    twitch: &TwitchFunctions,
    logger: Option<&Arc<Logger>>,
    channel_id: &str,
    message: &str,
    reply_to_message_id: Option<&str>,
    cancel: Option<&RequestCancellation>,
) -> Result<SendResult, AstRuntimeError> {
    // Source `if(replyToMessageId)`: an empty id is falsy.
    match reply_to_message_id.filter(|id| !id.is_empty()) {
        None => {
            // Reuse the reserved plain port unchanged; only the optional native
            // cancellation token selects its sibling entry point.
            let response = match cancel {
                Some(cancel) => {
                    twitch
                        .send_message_plain_with_cancellation(channel_id, message, Some(cancel))
                        .await
                }
                None => twitch.send_message_plain(channel_id, message).await,
            };
            Ok(send_result_from_plain(&response))
        }
        Some(reply_parent_message_id) => Ok(send_result_from_plain(
            &send_reply_parent(
                twitch,
                logger,
                channel_id,
                message,
                reply_parent_message_id,
                cancel,
            )
            .await?,
        )),
    }
}

/// Concrete [`ChatSender`] backed by the real Twitch client.
///
/// Construction performs no I/O. The plain path reuses
/// [`TwitchFunctions::send_message_plain`]; the reply path issues the same
/// `POST chat/messages` request with `reply_parent_message_id` added.
pub struct TwitchChatSender {
    twitch: TwitchFunctions,
    logger: Option<Arc<Logger>>,
}

impl TwitchChatSender {
    pub fn new(twitch: TwitchFunctions) -> Self {
        Self {
            twitch,
            logger: None,
        }
    }

    pub fn with_logger(twitch: TwitchFunctions, logger: Arc<Logger>) -> Self {
        Self {
            twitch,
            logger: Some(logger),
        }
    }

    pub fn with_optional_logger(twitch: TwitchFunctions, logger: Option<Arc<Logger>>) -> Self {
        Self { twitch, logger }
    }

    pub fn twitch(&self) -> &TwitchFunctions {
        &self.twitch
    }

    pub fn logger(&self) -> Option<&Arc<Logger>> {
        self.logger.as_ref()
    }

    /// Source `sendTwitchChatMessage(channelID, message, replyToMessageId)`.
    pub async fn send_message(
        &self,
        channel_id: &str,
        message: &str,
        reply_to_message_id: Option<&str>,
    ) -> Result<SendResult, AstRuntimeError> {
        send_chat_message(
            &self.twitch,
            self.logger.as_ref(),
            channel_id,
            message,
            reply_to_message_id,
            None,
        )
        .await
    }

    /// Native cancellation seam; source-parity callers use [`Self::send_message`].
    pub async fn send_message_with_cancellation(
        &self,
        channel_id: &str,
        message: &str,
        reply_to_message_id: Option<&str>,
        cancel: Option<&RequestCancellation>,
    ) -> Result<SendResult, AstRuntimeError> {
        send_chat_message(
            &self.twitch,
            self.logger.as_ref(),
            channel_id,
            message,
            reply_to_message_id,
            cancel,
        )
        .await
    }
}

impl ChatSender for TwitchChatSender {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move { self.send_message(channel_id, text, None).await })
    }
}

/// One authored chat message plus its optional AST context.
pub struct ContextualMessage<'a> {
    pub channel_id: &'a str,
    pub message: &'a str,
    pub reply_to_message_id: Option<&'a str>,
    /// `None` reproduces a call without `SendMessageContext`: no parsing, no
    /// command references.
    pub context: Option<SpecialParserContext>,
}

/// Collaborators of one context-aware send.
pub struct ContextualSeams<'a> {
    pub sender: &'a mut TwitchChatSender,
    pub parser: &'a mut dyn AstBodyParser,
    pub runner: &'a mut dyn CommandRunner,
    pub logger: Option<&'a Arc<Logger>>,
}

/// Native port of the context-aware `sendTwitchChatMessage`.
///
/// Ordering, `replyToMessageId` forwarding and the "send first, then dispatch
/// references" rule follow the source exactly.
pub fn send_contextual_message<'a>(
    seams: ContextualSeams<'a>,
    request: ContextualMessage<'a>,
) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
    Box::pin(async move {
        let ContextualSeams {
            sender,
            parser,
            runner,
            logger,
        } = seams;
        let ContextualMessage {
            channel_id,
            message,
            reply_to_message_id,
            context,
        } = request;

        let mut final_message = message.to_owned();
        let mut command_references = Vec::new();

        if let Some(context) = context {
            match parser.parse(message, context).await {
                Ok(parsed) => {
                    final_message = parsed.parsed_text;
                    command_references = parsed.command_references;
                }
                Err(AstRuntimeError::Cancelled) => return Err(AstRuntimeError::Cancelled),
                Err(error) => {
                    // The source logs a warning and sends the unparsed text.
                    log_message(
                        logger,
                        Level::Warn,
                        json!({
                            "function": "sendTwitchChatMessage.parseSpecialCommands",
                            "channelID": channel_id,
                            "error": error.message(),
                        }),
                        channel_id,
                    )
                    .await;
                }
            }
        }

        if js_compat::trim(&final_message).is_empty() {
            let mut delivered = AstMessage {
                parsed_text: String::new(),
                command_references,
            };
            return deliver_ast_message(
                channel_id,
                &mut delivered,
                true,
                DeliverySeams {
                    sender: &mut *sender,
                    runner: &mut *runner,
                    logger,
                },
            )
            .await;
        }

        let sent = sender
            .send_message(channel_id, &final_message, reply_to_message_id)
            .await?;
        if sent.error {
            // The source returns a failed send before any reference runs.
            return Ok(sent);
        }

        let mut delivered = AstMessage {
            parsed_text: String::new(),
            command_references,
        };
        // The source discards this delivery result after a successful send.
        let _ = deliver_ast_message(
            channel_id,
            &mut delivered,
            true,
            DeliverySeams {
                sender: &mut *sender,
                runner: &mut *runner,
                logger,
            },
        )
        .await?;

        Ok(sent)
    })
}

/// Reply-parent variant of the source's Helix chat request.
///
/// The reserved plain port deliberately has no reply target, so this path
/// mirrors its request, status, moderation-hold and parse handling while adding
/// `reply_parent_message_id` to the body.
async fn send_reply_parent(
    twitch: &TwitchFunctions,
    logger: Option<&Arc<Logger>>,
    channel_id: &str,
    message: &str,
    reply_parent_message_id: &str,
    cancel: Option<&RequestCancellation>,
) -> Result<PlainMessageResponse, AstRuntimeError> {
    let body = ReplyParentChatBody {
        broadcaster_id: channel_id,
        sender_id: MODERATOR_ID,
        message,
        for_source_only: true,
        reply_parent_message_id,
    };
    let body = serde_json::to_value(&body).map_err(|error| {
        AstRuntimeError::Host(format!("reply chat body serialization failed: {error}"))
    })?;

    let response = match twitch
        .request_detailed(
            TwitchAuth::App,
            Method::POST,
            "chat/messages",
            None,
            Some(&body),
            cancel,
        )
        .await
    {
        Ok(response) => response,
        Err(DetailedRequestFailure::Auth(_)) => {
            log_message(
                logger,
                Level::Error,
                json!({
                    "function": "sendTwitchChatMessage.getAppToken",
                    "channelID": channel_id,
                    "sender_id": TWITCH_BOT_ACCOUNT_ID,
                    "messagePreview": prefix_utf16(message, 120),
                    "error": TOKEN_FAILURE,
                }),
                channel_id,
            )
            .await;
            return Ok(token_failure());
        }
        Err(DetailedRequestFailure::Cancelled) => {
            log_message(
                logger,
                Level::Error,
                json!({
                    "function": "sendTwitchChatMessage",
                    "channelID": channel_id,
                    "sender_id": TWITCH_BOT_ACCOUNT_ID,
                    "messagePreview": prefix_utf16(message, 120),
                    "error": CANCELLED_REASON,
                }),
                channel_id,
            )
            .await;
            return Err(AstRuntimeError::Cancelled);
        }
        Err(DetailedRequestFailure::Twitch(error)) => {
            let reason = error.to_string();
            log_message(
                logger,
                Level::Error,
                json!({
                    "function": "sendTwitchChatMessage",
                    "channelID": channel_id,
                    "sender_id": TWITCH_BOT_ACCOUNT_ID,
                    "messagePreview": prefix_utf16(message, 120),
                    "error": reason,
                }),
                channel_id,
            )
            .await;
            return Ok(caught(reason));
        }
    };

    let status = response.status().as_u16();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            let reason = error.to_string();
            log_message(
                logger,
                Level::Error,
                caught_payload(channel_id, message, &reason),
                channel_id,
            )
            .await;
            return Ok(caught(reason));
        }
    };
    let data: Value = match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
        Ok(data) => data,
        Err(error) => {
            let reason = error.to_string();
            log_message(
                logger,
                Level::Error,
                caught_payload(channel_id, message, &reason),
                channel_id,
            )
            .await;
            return Ok(caught(reason));
        }
    };

    if !(200..=299).contains(&status) {
        // Source evaluates `data.message`; only `null` throws there.
        if data.is_null() {
            let reason = "Cannot read properties of null (reading 'message')".to_owned();
            log_message(
                logger,
                Level::Error,
                caught_payload(channel_id, message, &reason),
                channel_id,
            )
            .await;
            return Ok(caught(reason));
        }
        log_message(
            logger,
            Level::Error,
            json!({
                "function": "sendTwitchChatMessage.twitchRejected",
                "channelID": channel_id,
                "sender_id": TWITCH_BOT_ACCOUNT_ID,
                "messagePreview": prefix_utf16(message, 120),
                "httpStatus": status,
                "twitchError": data.get("error").cloned(),
                "twitchMessage": data.get("message").cloned(),
                "tokenSource": "appToken",
            }),
            channel_id,
        )
        .await;
        return Ok(PlainMessageResponse {
            error: true,
            message: data.get("message").cloned(),
            status,
            kind: data.get("error").cloned(),
            reason: None,
            data: None,
        });
    }

    let first = data
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let is_sent = first.and_then(|item| item.get("is_sent"));
    if is_sent == Some(&Value::Bool(false)) {
        let first = first.cloned().unwrap_or(Value::Null);
        log_message(
            logger,
            Level::Error,
            json!({
                "function": "sendTwitchChatMessage.heldForModeration",
                "channelID": channel_id,
                "sender_id": TWITCH_BOT_ACCOUNT_ID,
                "messagePreview": prefix_utf16(message, 120),
                "httpStatus": status,
                "twitchMessageId": first.get("message_id").cloned(),
                "twitchIsSent": false,
                "reason": HELD_REASON,
                "tokenSource": "appToken",
            }),
            channel_id,
        )
        .await;
        return Ok(held(status, first));
    }

    let empty_data = data
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty);
    if first.is_none() && !empty_data {
        let reason = if data.is_null() {
            "Cannot read properties of null (reading 'data')"
        } else if data
            .get("data")
            .is_some_and(|value| !value.is_array() && !value.is_null())
        {
            "Twitch response data was not an array"
        } else if data.get("data").is_some_and(Value::is_null) {
            "Cannot read properties of null (reading '0')"
        } else {
            "Cannot read properties of undefined (reading '0')"
        };
        log_message(
            logger,
            Level::Error,
            caught_payload(channel_id, message, reason),
            channel_id,
        )
        .await;
        return Ok(caught(reason.to_owned()));
    }

    Ok(PlainMessageResponse {
        error: false,
        message: Some(Value::String(SENT_MESSAGE.into())),
        status,
        kind: Some(Value::String("success".into())),
        reason: None,
        data: first.cloned(),
    })
}

fn token_failure() -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(TOKEN_FAILURE.into())),
        status: 500,
        kind: Some(Value::String("error".into())),
        reason: Some(TOKEN_FAILURE.into()),
        data: None,
    }
}

fn caught(reason: String) -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(SEND_FAILURE.into())),
        status: 500,
        kind: Some(Value::String("error".into())),
        reason: Some(reason),
        data: None,
    }
}

fn held(status: u16, data: Value) -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(HELD_MESSAGE.into())),
        status,
        kind: Some(Value::String("held_for_moderation".into())),
        reason: Some(HELD_REASON.into()),
        data: Some(data),
    }
}

fn caught_payload(channel_id: &str, message: &str, reason: &str) -> Value {
    json!({
        "function": "sendTwitchChatMessage",
        "channelID": channel_id,
        "sender_id": TWITCH_BOT_ACCOUNT_ID,
        "messagePreview": prefix_utf16(message, 120),
        "error": reason,
    })
}

/// Best-effort log write; a failing sink never changes the send result.
async fn log_message(
    logger: Option<&Arc<Logger>>,
    level: Level,
    data: Value,
    channel_id: &str,
) {
    if let Some(logger) = logger {
        let _ = logger
            .log(
                level,
                data,
                LogOptions {
                    channel_id: Some(channel_id.to_owned()),
                    ..Default::default()
                },
            )
            .await;
    }
}
