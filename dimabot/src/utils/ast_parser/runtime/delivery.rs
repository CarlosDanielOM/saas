//! Native port of `src/utils/ast_command_delivery.ts`.
//!
//! Operational rules preserved from the source:
//!
//! - The command-reference queue is drained **once** (`splice(0)` in the
//!   source). [`std::mem::take`] empties the caller's [`AstMessage`], so a
//!   second delivery of the same message cannot resend the same references.
//! - The outer text is `message.parsed_text.trim()` and is sent only when
//!   `chat_enabled` is true **and** the trimmed text is non-empty.
//! - A failing outer send returns that failure immediately; command references
//!   are not executed.
//! - References execute in authored order. A reference whose execution reports
//!   `error == true` is skipped and the loop continues.
//! - An otherwise successful reference is delivered recursively as
//!   `{ parsed_text: result.message, command_references: result.command_references }`
//!   under the **referenced** command's channel (not the outer channel) with the
//!   same `chat_enabled` flag. A failing recursive send stops the loop and
//!   returns that failure.
//! - A failure raised while executing a reference is logged and the loop
//!   continues, exactly like the source's `try/catch`.
//! - Success returns [`SendResult::ok`] with the exact source text
//!   `"AST message delivered"`.
//!
//! Native differences (explicit, not silently claimed):
//!
//! - The source has no cancellation. A [`AstRuntimeError::Cancelled`] raised by
//!   a reference is treated as a typed stop instead of a logged-and-continued
//!   failure; every other [`AstRuntimeError`] keeps the source's
//!   log-and-continue behaviour.
//! - The source logs its caught errors with `console.error`. The native port
//!   uses the explicitly injected [`Logger`] when one is supplied and falls back
//!   to a single `eprintln!` line otherwise. Logging never changes the delivery
//!   result (the source awaits its logger).
//!
//! The runtime is `Rc`-based, so this module uses the non-`Send`
//! [`BoxFuture`] and never adds `Send` bounds.

use std::sync::Arc;

use serde_json::json;

use crate::utils::{
    js_compat,
    logger::{Level, LogOptions, Logger},
};

use super::{AstMessage, AstRuntimeError, BoxFuture, ChatSender, CommandRunner, SendResult};

/// Exact success text from the TypeScript source.
pub const AST_MESSAGE_DELIVERED: &str = "AST message delivered";

/// The two runtime seams the source's `DeliveryDependencies` becomes, plus an
/// optional log sink.
///
/// `S`/`R` are generic (`?Sized`) rather than hard-coded trait objects so the
/// recursive call can re-borrow them without changing the object's lifetime
/// bound. Callers normally pass `&mut dyn ChatSender` / `&mut dyn CommandRunner`
/// or their concrete adapters.
pub struct DeliverySeams<'a, S: ChatSender + ?Sized, R: CommandRunner + ?Sized> {
    pub sender: &'a mut S,
    pub runner: &'a mut R,
    pub logger: Option<&'a Arc<Logger>>,
}

impl<'a, S: ChatSender + ?Sized, R: CommandRunner + ?Sized> DeliverySeams<'a, S, R> {
    pub fn new(sender: &'a mut S, runner: &'a mut R) -> Self {
        Self {
            sender,
            runner,
            logger: None,
        }
    }

    pub fn with_logger(mut self, logger: &'a Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }
}

/// Send the outer response, then execute references in authored order.
///
/// `message.command_references` is drained by this call; `message.parsed_text`
/// is never parsed again.
pub fn deliver_ast_message<'a, S, R>(
    channel_id: &'a str,
    message: &'a mut AstMessage,
    chat_enabled: bool,
    seams: DeliverySeams<'a, S, R>,
) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>
where
    S: ChatSender + ?Sized + 'a,
    R: CommandRunner + ?Sized + 'a,
{
    Box::pin(async move {
        let DeliverySeams {
            sender,
            runner,
            logger,
        } = seams;

        // `splice(0)`: drain once so the same message cannot resend references.
        let references = std::mem::take(&mut message.command_references);
        let text = js_compat::trim(&message.parsed_text);

        if chat_enabled && !text.is_empty() {
            let sent = sender.send(channel_id, text).await?;
            if sent.error {
                return Ok(sent);
            }
        }

        for request in references {
            let executed = match runner.execute(&request).await {
                Ok(executed) => executed,
                Err(AstRuntimeError::Cancelled) => return Err(AstRuntimeError::Cancelled),
                Err(error) => {
                    log_reference_failure(logger, channel_id, &request.command_name, &error).await;
                    continue;
                }
            };

            if executed.error {
                continue;
            }

            let mut nested = AstMessage {
                parsed_text: executed.message,
                command_references: executed.command_references,
            };
            let sent = deliver_ast_message(
                &request.channel_id,
                &mut nested,
                chat_enabled,
                DeliverySeams {
                    sender: &mut *sender,
                    runner: &mut *runner,
                    logger,
                },
            )
            .await?;
            if sent.error {
                return Ok(sent);
            }
        }

        Ok(SendResult::ok(AST_MESSAGE_DELIVERED))
    })
}

/// Source `console.error('AST command reference failed', {...})`.
async fn log_reference_failure(
    logger: Option<&Arc<Logger>>,
    channel_id: &str,
    command_name: &str,
    error: &AstRuntimeError,
) {
    let payload = json!({
        "function": "deliverAstMessage.commandReference",
        "channelID": channel_id,
        "command": command_name,
        "error": error.message(),
    });
    match logger {
        Some(logger) => {
            let _ = logger
                .log(
                    Level::Error,
                    payload,
                    LogOptions {
                        channel_id: Some(channel_id.to_owned()),
                        ..Default::default()
                    },
                )
                .await;
        }
        None => eprintln!(
            "AST command reference failed: channelID={channel_id} command={command_name} error={}",
            error.message()
        ),
    }
}
