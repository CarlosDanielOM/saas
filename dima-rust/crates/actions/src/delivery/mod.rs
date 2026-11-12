//! Rendering chat, posting it, and running the command references it produced:
//! [`ChatDelivery`], the implementer of [`dima_twitch::chat::ChatOut`]. Package P4-ACT-CORE.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `handlers/special_parser.handler.ts` (474 lines): `parseSpecialCommands`
//!   ([`ChatDelivery::render`]), `createSpecialExecutionContext` (`context.rs`),
//!   `resolveArgumentPlaceholders` ([`placeholders::resolve`]), and the variable storage
//!   ([`crate::host::storage`]);
//! - `utils/ast_command_delivery.ts` (49 lines): `deliverAstMessage`
//!   ([`ChatDelivery::deliver_message`]);
//! - `functions/chats/send_message.chat.ts`, the render branch (`:37-55`, `:149`):
//!   [`ChatOut::send`]; the plain post is `dima_twitch::chat::send` (P4-TW-CHAT);
//! - `functions/chats/index.ts` (24 lines): the module's re-exports (nothing of its own).
//!
//! # Who calls what
//!
//! - Every feature that posts templated chat holds an `Arc<dyn ChatOut>` (the list of the
//!   reference's callers is on [`ChatOut`]): [`ChatOut::send`] and [`ChatOut::deliver`].
//! - The handlers that run a command and deliver its result (the message handler, keywords,
//!   raids, redemptions: P4-CHAT-MESSAGE and P4-CHAT-EVENTS) use [`ChatDelivery::render`]
//!   (`parseSpecialCommands` with a context they build: [`RenderInput`]),
//!   [`ChatDelivery::command_handler`] and [`ChatDelivery::execute_custom_command`]
//!   (`crate::runner`), then [`ChatDelivery::deliver_message`] (`deliverAstMessage`).
//! - The AST timers run a job through [`ChatDelivery::run_timer`] and deliver it.
//!
//! # The two delivery semantics (both are contract)
//!
//! [`ChatOut::send`] (`sendTwitchChatMessage`): renders when asked; a rendering failure other
//! than the required goal contribution is logged and the text is posted **unrendered**; a
//! blank text is never posted (its references still run, and their failure is the answer); the
//! text is posted **as rendered, not trimmed**, as a reply when asked; after a successful post
//! the references run and their outcome is ignored; after a failed post they do not run.
//!
//! [`ChatOut::deliver`] (`parseSpecialCommands` then `deliverAstMessage`): a rendering failure
//! is [`ChatError::Render`] and **nothing is posted**; the text is posted **trimmed**, never as
//! a reply; a failed post stops the delivery (no reference runs); each reference's own text is
//! posted (trimmed) before the next reference runs; a reference that is refused (missing,
//! disabled, on cooldown, not allowed) is skipped, one that fails is logged and skipped, one
//! whose post fails stops the delivery with that failure.
//!
//! # One budget per message
//!
//! A rendering whose call tree carries no message budget (an event's text, or the command a chat
//! message names: [`CallTree::message`] `None`) starts a message:
//! [`dima_engine::eval::Engine::render_message`]. A command started by a command reference
//! renders with [`dima_engine::eval::Engine::render_reference`] and the budget the reference
//! carries ([`dima_engine::context::ReferenceState::message`]), so the command, its references
//! and theirs, at any depth, share one budget; a reference started after the message stopped is
//! refused. References are looked up in the channel of the run that made them (the engine
//! names it), and render with that channel's plan (the streamer directory), never with a plan
//! taken from the text or the event. A timer firing later starts a message of its own.

pub mod placeholders;

mod context;

pub(crate) use context::plan_of;

use crate::host::HostDeps;
use crate::host::effects::{self, EffectInput, EffectOrigin, OriginKind};
use dima_engine::context::{
    Budget, CommandReference, Effect, Plan, ReferenceState, State, TimerSnapshot,
};
use dima_engine::eval::{Engine, EvalError, MessageBudget};
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use dima_http::guard::BoxFuture;
use dima_telemetry::LogOptions;
use dima_twitch::chat::send::SendConfig;
use dima_twitch::chat::{ChatError, ChatOut, RenderScope, Rendering, Sent};
use serde_json::json;
use std::sync::{Arc, Weak};

/// Deadlines of the delivery. [`Default`] holds the production values.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeliveryConfig {
    /// The plain post's deadline (`dima_twitch::chat::send::SendConfig`, 60 s).
    pub send: SendConfig,
}

/// Renders command language with the engine and [`crate::host::DimaHost`], posts the result
/// with the plain send of `dima_twitch::chat::send`, and runs the command references through
/// [`crate::runner`]. One per process, shared; built by the binaries (P4-BIN-BOT, P4-BIN-API,
/// P2-CRON-01) and handed to every feature as `Arc<dyn ChatOut>`.
pub struct ChatDelivery {
    me: Weak<ChatDelivery>,
    host: Arc<HostDeps>,
    engine: Arc<Engine>,
    config: DeliveryConfig,
}

/// The context `parseSpecialCommands` renders with (`ISpecialParserContext`), with the event
/// data as the engine's values.
#[derive(Clone, Debug, Default)]
pub struct RenderInput {
    /// `channelID`.
    pub channel_id: String,
    /// `eventData` (`{}` when undefined).
    pub event_data: Value,
    /// `eventsubData` (`{}` when undefined).
    pub eventsub_data: Value,
    /// `argument`.
    pub argument: Option<String>,
    /// `literalArguments`.
    pub literal_arguments: bool,
    /// `variables`, in order.
    pub variables: Vec<(String, String)>,
    /// `userPlan`; `None`: the channel's plan from the streamer directory.
    pub user_plan: Option<Plan>,
    /// `userLevel`; `None`: resolved from the event data.
    pub user_level: Option<f64>,
    /// `extraContext`, merged over the fields extracted from the event data.
    pub extra_context: Vec<(String, Value)>,
    /// `scopeType`; `None`: `command`.
    pub scope_type: Option<String>,
    /// `scopeName`.
    pub scope_name: Option<String>,
    /// `scopeAliases`.
    pub scope_aliases: Vec<String>,
    /// `effectContext`: live authority, already scoped by the caller.
    pub effect: Option<Effect>,
    /// `commandReferenceState`: set by the command runner for every command it runs.
    pub call_tree: Option<CallTree>,
    /// `count`: the command's use count.
    pub count: f64,
}

impl RenderInput {
    /// A rendering for `channel_id` with every other field empty (`{ channelID }`).
    pub fn new(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            ..Self::default()
        }
    }

    /// The rendering a [`Rendering`] describes. Its effect grant, when it has one, is minted
    /// and scoped as the durable chat announcements do (`createTwitchEffectContext` with a
    /// `twitch-event` origin, then `scopeAstEffectContext` with the grant's scope); a grant that
    /// fails the checks gives no authority.
    pub fn from_rendering(channel_id: &str, rendering: &Rendering) -> Self {
        let object = |map: &serde_json::Map<String, serde_json::Value>| {
            Value::from(serde_json::Value::Object(map.clone()))
        };
        let effect = rendering.effect.as_ref().and_then(|grant| {
            let minted = effects::twitch_effect(EffectInput {
                channel_id: channel_id.to_owned(),
                origin: EffectOrigin {
                    kind: OriginKind::TwitchEvent,
                    id: grant.origin_id.clone(),
                    occurred_at: grant.occurred_at.clone(),
                },
                actor_id: grant.actor_id.clone(),
                actor_name: grant.actor_name.clone(),
                chat: None,
            });
            effects::scope_effect(minted.as_ref(), channel_id, &grant.scope)
        });
        Self {
            channel_id: channel_id.to_owned(),
            event_data: object(&rendering.event_data),
            eventsub_data: object(&rendering.eventsub_data),
            argument: rendering.argument.clone(),
            literal_arguments: rendering.literal_arguments,
            variables: rendering.variables.clone(),
            user_plan: rendering
                .user_plan
                .map(|plan| plan_of(Some(dima_model::StrEnum::as_str(plan)))),
            user_level: rendering.user_level,
            extra_context: rendering
                .extra_context
                .iter()
                .map(|(key, value)| (key.clone(), Value::from(value.clone())))
                .collect(),
            scope_type: rendering.scope_type.clone(),
            scope_name: rendering.scope_name.clone(),
            scope_aliases: rendering.scope_aliases.clone(),
            effect,
            call_tree: None,
            count: 0.0,
        }
    }
}

/// `ISpecialParserResult`.
#[derive(Debug)]
pub struct RenderOutput {
    /// `parsedText`: rendered, escapes undone.
    pub text: String,
    /// `count` afterwards.
    pub count: f64,
    /// `countModified`: `$(count)` or `$(scount)` ran, so the caller stores `count`.
    pub count_modified: bool,
    /// `commandReferences`, in authored order, for [`ChatDelivery::deliver_message`].
    pub references: Vec<CommandReference>,
}

/// Why a rendering produced nothing (`parseSpecialCommands` threw).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RenderError {
    /// `goal.add` could not journal a required contribution: the caller passes it on so the
    /// event is retried.
    #[error("Required goal contribution could not be journaled")]
    RequiredGoalContribution,
    /// Anything else (a host function that threw, a coercion, the stack contract, a reference
    /// refused because its message stopped).
    #[error("{0}")]
    Failed(String),
}

/// `CommandReferenceState`: where a command sits in its message's call tree.
#[derive(Clone, Debug)]
pub struct CallTree {
    /// `visitedCommands`: `{channel}:{name}` of the commands above, this one included.
    pub visited_commands: Vec<String>,
    /// `commandRefDepth`.
    pub command_ref_depth: u32,
    /// `commandRefBudget`: references the whole tree may still start (50 at the root).
    pub budget: Budget,
    /// `timerDepth`.
    pub timer_depth: Option<u32>,
    /// The budget of the message this command belongs to; `None` at the root, which starts
    /// the message.
    pub message: Option<MessageBudget>,
}

impl CallTree {
    /// The root of a message: the command `{channel}:{execution name}`, depth 0, a budget of 50
    /// references.
    pub fn root(channel_id: &str, execution_name: &str) -> Self {
        Self {
            visited_commands: vec![format!("{channel_id}:{execution_name}")],
            command_ref_depth: 0,
            budget: Budget::default(),
            timer_depth: None,
            message: None,
        }
    }
}

impl From<ReferenceState> for CallTree {
    fn from(state: ReferenceState) -> Self {
        Self {
            visited_commands: state.visited_commands,
            command_ref_depth: state.command_ref_depth,
            budget: state.budget,
            timer_depth: state.timer_depth,
            message: Some(state.message),
        }
    }
}

/// `AstMessage`: a rendered text and the command references it produced.
#[derive(Debug, Default)]
pub struct AstMessage {
    /// `parsedText`.
    pub text: String,
    /// `commandReferences`.
    pub references: Vec<CommandReference>,
}

impl From<RenderOutput> for AstMessage {
    fn from(output: RenderOutput) -> Self {
        Self {
            text: output.text,
            references: output.references,
        }
    }
}

/// The answer of the empty-text branch of the send: the reference returns the reference's own
/// failed result with `type: 'error'`.
fn as_error_type(error: ChatError) -> ChatError {
    match error {
        ChatError::Rejected {
            status, message, ..
        } => ChatError::Rejected {
            status,
            kind: Some("error".into()),
            message,
        },
        ChatError::HeldForModeration { status, .. } => ChatError::Rejected {
            status,
            kind: Some("error".into()),
            message: Some("Message held for moderation review by Twitch".into()),
        },
        other => other,
    }
}

impl ChatDelivery {
    /// A delivery over the process's host handles and engine.
    pub fn new(host: Arc<HostDeps>, engine: Arc<Engine>) -> Arc<Self> {
        Self::with_config(host, engine, DeliveryConfig::default())
    }

    /// A delivery with other deadlines (tests).
    pub fn with_config(
        host: Arc<HostDeps>,
        engine: Arc<Engine>,
        config: DeliveryConfig,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            host,
            engine,
            config,
        })
    }

    /// The host handles each rendering's [`crate::host::DimaHost`] is made from.
    pub fn host(&self) -> &Arc<HostDeps> {
        &self.host
    }

    /// The engine that renders.
    pub fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }

    pub(crate) fn log(&self, warn: bool, data: &serde_json::Value, channel_id: &str) {
        if let Some(telemetry) = &self.host.telemetry {
            let options = LogOptions::new().channel(channel_id);
            if warn {
                telemetry.warn(data, options);
            } else {
                telemetry.error(data, options);
            }
        }
    }

    fn eval_error(error: EvalError, required_goal: bool) -> RenderError {
        if required_goal {
            return RenderError::RequiredGoalContribution;
        }
        RenderError::Failed(error.to_string())
    }

    /// `parseSpecialCommands(text, context)`: argument placeholders, the execution context, the
    /// rendering, the final unescape. A placeholder error is an answer (`[Parser error: …]`),
    /// not a failure.
    pub async fn render(
        &self,
        text: &str,
        input: RenderInput,
    ) -> Result<RenderOutput, RenderError> {
        let resolution = placeholders::resolve(
            text,
            input.argument.as_deref().unwrap_or_default(),
            input.literal_arguments,
            self.host.random.as_ref(),
        )
        .map_err(|error| RenderError::Failed(error.to_string()))?;
        if let Some(error) = resolution.error {
            return Ok(RenderOutput {
                text: format!("[Parser error: {error}]"),
                count: input.count,
                count_modified: false,
                references: Vec::new(),
            });
        }
        let template = self
            .engine
            .compile(&resolution.text)
            .map_err(|diagnostic| RenderError::Failed(diagnostic.message))?;
        let prepared = self.prepare(&input, resolution.variables).await?;
        let mut host = prepared.host;
        let signals = host.signals();
        let message = input
            .call_tree
            .as_ref()
            .and_then(|tree| tree.message.as_ref());
        let rendered = match message {
            Some(budget) => {
                self.engine
                    .render_reference(
                        &template,
                        &prepared.context,
                        prepared.state,
                        &mut host,
                        budget,
                    )
                    .await
            }
            None => {
                self.engine
                    .render_message(&template, &prepared.context, prepared.state, &mut host)
                    .await
            }
        };
        match rendered {
            Ok(rendered) => Ok(RenderOutput {
                text: dima_engine::syntax::unescape_rendered_text(&rendered.text),
                count: rendered.state.count,
                count_modified: rendered.state.count_modified,
                references: rendered.state.command_references,
            }),
            Err(error) => Err(Self::eval_error(
                error,
                signals
                    .required_goal
                    .load(std::sync::atomic::Ordering::SeqCst),
            )),
        }
    }

    /// The plain post (`sendTwitchChatMessage` without a context): `dima_twitch::chat::send`.
    pub async fn post(&self, scope: &RenderScope, text: &str) -> Result<Sent, ChatError> {
        dima_twitch::chat::send::send(&self.host.twitch, scope, text, &self.config.send).await
    }

    /// `deliverAstMessage(channelID, message, chatEnabled)`: posts the text, trimmed, unless it
    /// is empty or chat is off; then runs each command reference in authored order and
    /// delivers its result the same way. A failed post stops the delivery with its failure;
    /// a refused reference is skipped; a reference that fails is logged and skipped.
    pub fn deliver_message<'a>(
        &'a self,
        channel_id: &'a str,
        message: AstMessage,
        chat_enabled: bool,
    ) -> BoxFuture<'a, Result<(), ChatError>> {
        Box::pin(async move {
            let text = dima_text::trim(&message.text);
            if chat_enabled && !text.is_empty() {
                self.post(&RenderScope::plain(channel_id), text).await?;
            }
            for reference in message.references {
                let channel = reference.channel_id.clone();
                let name = reference.command_name.clone();
                match self
                    .command_handler(crate::runner::CommandRequest::from(reference))
                    .await
                {
                    Ok(crate::runner::CommandOutcome::Ran(ran)) => {
                        self.deliver_message(
                            &channel,
                            AstMessage {
                                text: ran.message,
                                references: ran.references,
                            },
                            chat_enabled,
                        )
                        .await?;
                    }
                    Ok(crate::runner::CommandOutcome::Refused(_)) => {}
                    Err(error) => self.log(
                        false,
                        &json!({
                            "message": "AST command reference failed",
                            "channelID": channel_id,
                            "command": name,
                            "error": error.to_string(),
                        }),
                        channel_id,
                    ),
                }
            }
            Ok(())
        })
    }

    /// `executeAstTimerJob`'s evaluation: the saved run's context rebuilt
    /// (`createSpecialExecutionContext` with the saved fields, then the saved data over it), the
    /// body evaluated as a message of its own with the channel's current plan. The value's text
    /// and the references it produced.
    pub async fn run_timer(
        &self,
        body: &AstNode,
        saved: TimerSnapshot,
    ) -> Result<(String, Vec<CommandReference>), RenderError> {
        let mut event = match &saved.event_data {
            Value::Object(entries) => entries.clone(),
            _ => Vec::new(),
        };
        event.push((
            "chatter_user_id".into(),
            Value::text(saved.user_id.as_str()),
        ));
        event.push((
            "chatter_user_login".into(),
            Value::text(saved.user_login.as_str()),
        ));
        event.push((
            "chatter_user_name".into(),
            Value::text(saved.user_display_name.as_str()),
        ));
        let input = RenderInput {
            channel_id: saved.broadcaster_id.clone(),
            event_data: Value::object(event),
            eventsub_data: saved.eventsub_data.clone(),
            argument: saved.argument.clone(),
            user_level: Some(saved.user_level),
            scope_type: Some(saved.scope_type.clone()),
            scope_name: Some(saved.scope_name.clone()),
            scope_aliases: saved.scope_aliases.clone(),
            count: saved.count,
            ..RenderInput::default()
        };
        let prepared = self.prepare(&input, Vec::new()).await?;
        let plan = prepared.context.user_plan;
        let mut context = prepared.context;
        // `{...base, ...saved}`: the saved data wins, except the plan (see `crate::timers`).
        context.user_id = saved.user_id;
        context.user_login = saved.user_login;
        context.user_display_name = saved.user_display_name;
        context.user_plan = plan;
        context.user_level = saved.user_level;
        context.enforce_function_permissions = saved.enforce_function_permissions;
        context.authorization = saved.authorization;
        context.argument = saved.argument;
        context.event_data = saved.event_data;
        context.eventsub_data = saved.eventsub_data;
        context.extra_context = saved.extra_context;
        context.platform = saved.platform;
        context.scope_type = saved.scope_type;
        context.scope_name = saved.scope_name;
        context.scope_aliases = saved.scope_aliases;
        context.command_name = saved.command_name;
        context.command_id = saved.command_id;
        context.budget = dima_engine::context::Budget::new(saved.command_ref_budget.remaining);
        context.command_ref_depth = saved.command_ref_depth;
        context.visited_commands = saved.visited_commands;
        context.timer_depth = Some(saved.timer_depth);
        let state = State {
            count: saved.count,
            variables: saved.variables.into_iter().collect(),
            arrays: saved.arrays.into_iter().collect(),
            loop_vars: saved.loop_vars.into_iter().collect(),
            command_responses: saved.command_responses,
            ..State::default()
        };
        let mut host = prepared.host;
        let signals = host.signals();
        match self
            .engine
            .evaluate_message(body, &context, state, &mut host)
            .await
        {
            Ok(evaluated) => {
                let text = evaluated
                    .value
                    .to_text_or_empty()
                    .map_err(|error| RenderError::Failed(error.to_string()))?
                    .into_owned();
                Ok((text, evaluated.state.command_references))
            }
            Err(error) => Err(Self::eval_error(
                error,
                signals
                    .required_goal
                    .load(std::sync::atomic::Ordering::SeqCst),
            )),
        }
    }

    /// `sendTwitchChatMessage(channel, text, replyTo, context)`; see [`ChatOut::send`].
    async fn send_message(&self, scope: &RenderScope, text: &str) -> Result<Sent, ChatError> {
        let mut final_text = text.to_owned();
        let mut references = Vec::new();
        if let Some(rendering) = &scope.render {
            match self
                .render(
                    text,
                    RenderInput::from_rendering(&scope.channel_id, rendering),
                )
                .await
            {
                Ok(output) => {
                    final_text = output.text;
                    references = output.references;
                }
                Err(RenderError::RequiredGoalContribution) => {
                    return Err(ChatError::RequiredGoalContribution);
                }
                Err(RenderError::Failed(reason)) => self.log(
                    true,
                    &json!({
                        "function": "sendTwitchChatMessage.parseSpecialCommands",
                        "channelID": scope.channel_id,
                        "error": reason,
                    }),
                    &scope.channel_id,
                ),
            }
        }
        if dima_text::trim(&final_text).is_empty() {
            return self
                .deliver_message(
                    &scope.channel_id,
                    AstMessage {
                        text: String::new(),
                        references,
                    },
                    true,
                )
                .await
                .map(|()| Sent::Nothing)
                .map_err(as_error_type);
        }
        let sent = self.post(scope, &final_text).await?;
        // The references run after the post; their outcome does not change the answer.
        let _ = self
            .deliver_message(
                &scope.channel_id,
                AstMessage {
                    text: String::new(),
                    references,
                },
                true,
            )
            .await;
        Ok(sent)
    }

    /// `parseSpecialCommands` (when `render` is given) then `deliverAstMessage`; see
    /// [`ChatOut::deliver`].
    async fn deliver_text(
        &self,
        channel_id: &str,
        render: Option<&Rendering>,
        text: &str,
    ) -> Result<(), ChatError> {
        let message = match render {
            Some(rendering) => match self
                .render(text, RenderInput::from_rendering(channel_id, rendering))
                .await
            {
                Ok(output) => AstMessage::from(output),
                Err(RenderError::RequiredGoalContribution) => {
                    return Err(ChatError::RequiredGoalContribution);
                }
                Err(RenderError::Failed(reason)) => return Err(ChatError::Render { reason }),
            },
            None => AstMessage {
                text: text.to_owned(),
                references: Vec::new(),
            },
        };
        self.deliver_message(channel_id, message, true).await
    }
}

impl ChatOut for ChatDelivery {
    fn send<'a>(
        &'a self,
        scope: &'a RenderScope,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Sent, ChatError>> {
        Box::pin(self.send_message(scope, text))
    }

    fn deliver<'a>(
        &'a self,
        channel_id: &'a str,
        render: Option<&'a Rendering>,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), ChatError>> {
        Box::pin(self.deliver_text(channel_id, render, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_empty_text_branch_answers_type_error() {
        let held = as_error_type(ChatError::HeldForModeration {
            status: 200,
            message_id: Some("m".into()),
        });
        assert_eq!(held.kind(), Some("error"));
        assert_eq!(
            held.message(),
            Some("Message held for moderation review by Twitch")
        );
        assert_eq!(held.status(), Some(200));
        let rejected = as_error_type(ChatError::Rejected {
            status: 403,
            kind: Some("Forbidden".into()),
            message: Some("no".into()),
        });
        assert_eq!(
            (rejected.kind(), rejected.message()),
            (Some("error"), Some("no"))
        );
        assert_eq!(as_error_type(ChatError::NoAppToken), ChatError::NoAppToken);
    }
}
