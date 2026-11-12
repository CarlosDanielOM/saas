//! Running commands: looking a command up and executing its stored text
//! (`commandHandler`, `executeCustomCommand`), and the [`CommandRunner`] handle the AI chat's
//! tools run command language through. Package P4-ACT-CORE.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `handlers/commands.handler.ts` (198 lines): `commandHandler`
//!   ([`ChatDelivery::command_handler`]), `executeCustomCommand`
//!   ([`ChatDelivery::execute_custom_command`]), `commandExecutionAllowed`
//!   ([`command_execution_allowed`]);
//! - `utils/ast_parser/index.ts` (50 lines): `parseAndEvaluate`
//!   ([`CommandRunner::run_program`]; the rest of the file re-exports the engine).
//!
//! # Who calls it
//!
//! - The message handler (P4-CHAT-MESSAGE): [`ChatDelivery::command_handler`] with a `chat`
//!   authorization and the chat message's effect authority ([`crate::host::effects`]), then
//!   [`ChatDelivery::deliver_message`] with the result; the keywords handler:
//!   [`ChatDelivery::execute_custom_command`] with the keyword's stored command.
//! - The delivery itself, for every command reference ([`CommandRequest::from`] a
//!   [`CommandReference`]).
//! - The AI chat's tools (P4-ACT-AI-B, P4-ACT-AI-C): [`CommandRunner::run_program`].
//!
//! # The counter
//!
//! `$(count)` and `$(scount)` change the command's count during the run; the reference then
//! stored the new total with `$set` (`updateCommandInDB`, `saveKeywordCount`), so two runs at
//! once (the bot and the API, or two bots) both stored their own total and one increment was
//! lost. Rust stores the change instead, `$inc` by the run's total minus the count it started
//! with, through the same write helpers (Mongoose's `updatedAt` and the availability hook
//! included): increments are never lost, and what the run showed in chat is unchanged (closed
//! weakness). The stored BSON type is the reference's (an `int32` total stays `int32`).

use crate::delivery::{CallTree, ChatDelivery, RenderError, RenderInput};
use crate::host::{VariableScope, effects};
use bson::{Bson, doc, oid::ObjectId};
use dima_commands::cooldown::{ExecutionCooldown, execution_cooldown, execution_cooldown_key};
use dima_commands::keywords::keyword_body_key;
use dima_commands::permissions::{CompiledPermission, UserIdentity};
use dima_commands::runtime::lookup::Names;
use dima_engine::context::{
    CommandReference, Context, Effect, ReferenceOrigin, ReferenceState, State,
};
use dima_engine::eval::EvalError;
use dima_engine::host::HostFuture;
use dima_engine::syntax::Diagnostic;
use dima_engine::value::Value;
use dima_model::availability::Writer;
use dima_model::commands::{self, Activation, Command};
use dima_store::dragonfly::{SetCondition, SetExpiry, SetOptions, SetOutcome};
use dima_store::mongo::WriteContext;
use serde_json::json;

/// What the AI chat's tools use to run command language, without naming the host or the
/// runner's implementation (plan section 2.1: "its tools get `&dyn ChatOut` and a
/// `CommandRunner` handle, not the host module").
///
/// Implemented by [`ChatDelivery`]; called by the `ast_parser` tool of [`crate::ai::catalog`]
/// (P4-ACT-AI-C) and by the tool loop of [`crate::ai::chat`] (P4-ACT-AI-B). A tool's test uses
/// a fake.
pub trait CommandRunner: Send + Sync {
    /// `parseAndEvaluate(program, context)` then `deliverAstMessage(channel, { parsedText: '',
    /// commandReferences })` (`utils/ai/tools/ast_parser.tool.ts:150-158`): parses `program` as
    /// one program, evaluates it as a message of its own with `context`, delivers the command
    /// references it produced (their own text is posted), and answers the program's value.
    ///
    /// The caller builds `context` as the tool does: an `llm` authorization carrying the real
    /// chatter's identity, a level never above the chatter's verified one, the channel's plan,
    /// and `enforce_function_permissions` on. As in the reference (`createExecutionContext`'s
    /// defaults), channel and viewer variables read as `''` and are not written; cache
    /// variables and timers work.
    fn run_program<'a>(
        &'a self,
        program: &'a str,
        context: Context,
    ) -> HostFuture<'a, Result<Value, RunError>>;
}

/// Why [`CommandRunner::run_program`] produced no value.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RunError {
    /// The program does not parse (`[Parse error: …]` in chat).
    #[error("{}", .0.message)]
    Parse(Diagnostic),
    /// The evaluation stopped: a host failure, a limit, a coercion, the stack contract.
    #[error(transparent)]
    Eval(#[from] EvalError),
}

/// `CommandExecutionOrigin`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionOrigin {
    /// A chat message names the command: its policy governs the chatter.
    Chat,
    /// An AI-written program references it: its policy governs the real requesting chatter.
    Llm,
    /// A reference inside streamer-authored text: the outer gate passed; no policy applies.
    Authored,
}

/// `CommandExecutionAuthorization`.
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutionAuthorization {
    /// `origin`.
    pub origin: ExecutionOrigin,
    /// `identity`: the chatter's resolved identity.
    pub identity: UserIdentity,
}

/// `commandExecutionAllowed(command, authorization)`: no authorization is refused; an authored
/// reference is allowed; otherwise the command's permission (tag expression or legacy level)
/// against the identity.
pub fn command_execution_allowed(
    command: &Command,
    authorization: Option<&ExecutionAuthorization>,
) -> bool {
    let Some(authorization) = authorization else {
        return false;
    };
    if authorization.origin == ExecutionOrigin::Authored {
        return true;
    }
    let expression = command
        .permission_expression
        .as_ref()
        .map(|expression| &expression.0);
    let level = command.user_level.map(|level| level.to_bson());
    CompiledPermission::compile(expression, level.as_ref())
        .decide(&authorization.identity)
        .allowed
}

/// The arguments of `commandHandler(channelID, messageEventData, command, argument,
/// authorization, referenceState, effectContext)`.
#[derive(Clone, Debug, Default)]
pub struct CommandRequest {
    /// `channelID`: where the command is looked up and runs.
    pub channel_id: String,
    /// `messageEventData`: the chat message (or the reference's event data) as the engine's
    /// value.
    pub event_data: Value,
    /// `command`: the name as given (looked up byte for byte).
    pub name: String,
    /// `argument`.
    pub argument: Option<String>,
    /// `authorization` (`None` is refused).
    pub authorization: Option<ExecutionAuthorization>,
    /// `referenceState`: set for a command a reference started.
    pub reference: Option<ReferenceState>,
    /// `effectContext`: the live authority of the chat message or of the reference.
    pub effect: Option<Effect>,
}

impl From<CommandReference> for CommandRequest {
    /// The delivery's `execute(request)`.
    fn from(reference: CommandReference) -> Self {
        Self {
            channel_id: reference.channel_id,
            event_data: reference.event_data,
            name: reference.command_name,
            argument: Some(reference.argument),
            authorization: Some(ExecutionAuthorization {
                origin: match reference.authorization.origin {
                    ReferenceOrigin::Authored => ExecutionOrigin::Authored,
                    ReferenceOrigin::Llm => ExecutionOrigin::Llm,
                },
                identity: reference.authorization.identity,
            }),
            reference: Some(reference.state),
            effect: reference.effect,
        }
    }
}

/// `ICommandData`: the command as it ran.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandData {
    /// `enabled`.
    pub enabled: bool,
    /// `name`.
    pub name: Option<String>,
    /// `cmd`.
    pub cmd: Option<String>,
    /// `message`: the rendered text.
    pub message: String,
    /// `type`.
    pub kind: Option<String>,
    /// `count`: the count it started with.
    pub count: f64,
}

/// A command that ran (`{error: false, status: 200, type: 'success'}`).
#[derive(Debug)]
pub struct Ran {
    /// `message`: the rendered text, for [`ChatDelivery::deliver_message`].
    pub message: String,
    /// `command`.
    pub command: CommandData,
    /// `commandReferences`.
    pub references: Vec<CommandReference>,
}

/// A command that did not run (`{error: true, …}`): nothing to deliver.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    /// `message`.
    pub message: &'static str,
    /// `status`.
    pub status: u16,
    /// `type`.
    pub kind: &'static str,
}

impl Refused {
    const NOT_FOUND: Self = Self {
        message: "Command does not exist",
        status: 400,
        kind: "command_not_found",
    };
    const LOOKUP_FAILED: Self = Self {
        message: "Error retrieving command",
        status: 500,
        kind: "command_not_found",
    };
    const DISABLED: Self = Self {
        message: "Command is disabled",
        status: 400,
        kind: "command_disabled",
    };
    const DENIED: Self = Self {
        message: "You do not have permission to use this command",
        status: 403,
        kind: "permission_denied",
    };
    const COOLDOWN: Self = Self {
        message: "Command is on cooldown",
        status: 429,
        kind: "command_cooldown",
    };
    const KEYWORD_GONE: Self = Self {
        message: "Keyword is disabled or deleted",
        status: 400,
        kind: "command_disabled",
    };
}

/// What `commandHandler` answered.
#[derive(Debug)]
pub enum CommandOutcome {
    /// It ran.
    Ran(Ran),
    /// It did not.
    Refused(Refused),
}

/// What `commandHandler` threw: the run failed.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    /// The rendering failed.
    #[error(transparent)]
    Render(#[from] RenderError),
    /// The cooldown gate or the keyword's state could not be read or written.
    #[error("{0}")]
    Store(String),
}

impl ChatDelivery {
    /// `commandHandler(...)`: looks the command up in the channel (by its name, byte for byte)
    /// and runs it with [`Self::execute_custom_command`].
    pub async fn command_handler(
        &self,
        request: CommandRequest,
    ) -> Result<CommandOutcome, CommandError> {
        let lookup = match self
            .host()
            .commands
            .find(&request.channel_id, &request.name)
            .await
        {
            Ok(lookup) => lookup,
            Err(error) => {
                self.log(
                    false,
                    &json!({
                        "function": "Commands.getCommandFromDB",
                        "channelID": request.channel_id,
                        "error": error.to_string(),
                    }),
                    &request.channel_id,
                );
                return Ok(CommandOutcome::Refused(Refused::LOOKUP_FAILED));
            }
        };
        if let Some(error) = &lookup.cache_error {
            self.log(
                true,
                &json!({
                    "function": "Commands.getCommandFromDB",
                    "channelID": request.channel_id,
                    "cache": error.to_string(),
                }),
                &request.channel_id,
            );
        }
        let Some(command) = lookup.command else {
            return Ok(CommandOutcome::Refused(Refused::NOT_FOUND));
        };
        self.execute_custom_command(&command, request).await
    }

    /// `executeCustomCommand(channelID, messageEventData, storedCommand, command, argument,
    /// authorization, referenceState, effectContext)`: the enabled check, the authorization,
    /// the shared cooldown gate (`SET command:execution:cooldown:{channel}:{name} 1 NX PX`), a
    /// keyword's current state, the rendering, and the counter. `request.name` is the name the
    /// command was invoked by.
    pub async fn execute_custom_command(
        &self,
        stored: &Command,
        request: CommandRequest,
    ) -> Result<CommandOutcome, CommandError> {
        let deps = self.host();
        let channel_id = request.channel_id.as_str();
        let is_keyword = stored.activation == Activation::Keyword;
        let stored_id = stored.id.to_hex();
        let execution_name = if is_keyword {
            format!("keyword:{stored_id}")
        } else {
            dima_text::to_lower(&request.name)
        };
        let mut data = CommandData {
            enabled: stored.enabled.unwrap_or(false),
            name: stored.name.clone(),
            cmd: stored.cmd.clone(),
            message: stored.message.clone(),
            kind: stored.kind.clone(),
            count: if stored.count.0.is_nan() {
                0.0
            } else {
                stored.count.0
            },
        };
        if !data.enabled {
            return Ok(CommandOutcome::Refused(Refused::DISABLED));
        }
        if !command_execution_allowed(stored, request.authorization.as_ref()) {
            return Ok(CommandOutcome::Refused(Refused::DENIED));
        }
        let plan = if is_keyword {
            self.streamer(channel_id)
                .await
                .and_then(|account| account.plan_tier().map(str::to_owned))
        } else {
            None
        };
        let cooldown = stored
            .cooldown
            .map_or(serde_json::Value::Null, |seconds| json!(seconds.0));
        if let ExecutionCooldown::Millis(millis) =
            execution_cooldown(Some(&cooldown), is_keyword, plan.as_deref())
        {
            let key = deps
                .keys
                .key(execution_cooldown_key(channel_id, &execution_name));
            let options = SetOptions {
                condition: SetCondition::IfMissing,
                expiry: SetExpiry::Millis(millis),
                get: false,
            };
            match deps.dragonfly.set(&key, b"1", options).await {
                Ok(SetOutcome::Written) => {}
                Ok(_) => return Ok(CommandOutcome::Refused(Refused::COOLDOWN)),
                Err(error) => return Err(CommandError::Store(error.to_string())),
            }
        }
        if is_keyword {
            // The body cache holds configuration; the counter is read after the gate.
            let current = tokio::time::timeout(
                deps.storage.store_deadline,
                deps.mongo
                    .documents(commands::COLLECTION)
                    .find_one(
                        doc! { "channelID": channel_id, "_id": stored.id, "activation": "keyword" },
                    )
                    .projection(doc! { "count": 1, "enabled": 1 }),
            )
            .await
            .map_err(|_| CommandError::Store("the keyword's state did not load in time".into()))?
            .map_err(|error| CommandError::Store(error.to_string()))?;
            let Some(current) = current.filter(|current| {
                current.get("enabled").is_some_and(|enabled| match enabled {
                    Bson::Boolean(flag) => *flag,
                    Bson::Null | Bson::Undefined => false,
                    _ => true,
                })
            }) else {
                return Ok(CommandOutcome::Refused(Refused::KEYWORD_GONE));
            };
            data.count = current
                .get("count")
                .and_then(dima_store::mongo::number::read_number)
                .unwrap_or(0.0);
        }
        let tree = match request.reference {
            Some(reference) => CallTree::from(reference),
            None => CallTree::root(channel_id, &execution_name),
        };
        let effect = match request.authorization.as_ref().map(|a| a.origin) {
            Some(ExecutionOrigin::Llm) => None,
            _ => effects::scope_effect(
                request.effect.as_ref(),
                channel_id,
                &format!("command:{stored_id}"),
            ),
        };
        let scope_name = if is_keyword {
            execution_name.clone()
        } else {
            data.cmd
                .clone()
                .filter(|cmd| !cmd.is_empty())
                .unwrap_or_else(|| request.name.clone())
        };
        let input = RenderInput {
            channel_id: channel_id.to_owned(),
            event_data: request.event_data,
            argument: Some(request.argument.unwrap_or_default()),
            literal_arguments: true,
            user_level: Some(dima_commands::permissions::BROADCASTER_USER_LEVEL),
            scope_type: Some("command".into()),
            scope_name: Some(scope_name),
            scope_aliases: data
                .name
                .clone()
                .filter(|name| !name.is_empty())
                .into_iter()
                .collect(),
            effect,
            call_tree: Some(tree),
            count: data.count,
            ..RenderInput::default()
        };
        let output = self.render(&data.message, input).await?;
        if output.count_modified {
            let delta = output.count - data.count;
            if is_keyword {
                self.add_keyword_count(channel_id, stored.id, delta).await?;
            } else {
                self.add_command_count(channel_id, &request.name, stored.id, delta)
                    .await;
            }
        }
        data.message = output.text.clone();
        Ok(CommandOutcome::Ran(Ran {
            message: output.text,
            command: data,
            references: output.references,
        }))
    }

    /// The `$inc` of a command's counter, under the command cache's write protocol (the
    /// reference's `updateCommandInDB(channelID, command, {count})` then the cache
    /// invalidation). A failure is logged, as the reference logs it.
    async fn add_command_count(&self, channel_id: &str, name: &str, id: ObjectId, delta: f64) {
        let deps = self.host();
        let outcome = deps
            .commands
            .write(channel_id, Names::These(&[name]), || async {
                let mut ctx = WriteContext::new(deps.clock.now_ms());
                let prepared = commands::prepare_update(
                    &doc! { "_id": id },
                    doc! { "$inc": { "count": dima_store::mongo::number::js_number(delta) } },
                    dima_model::UpdateOptions::default(),
                    Writer::Client,
                    &mut ctx,
                    deps.random.as_ref(),
                )
                .map_err(|error| error.to_string())?;
                tokio::time::timeout(
                    deps.storage.store_deadline,
                    deps.mongo
                        .writes(commands::COLLECTION)
                        .update_one(&prepared),
                )
                .await
                .map_err(|_| "did not finish in time (the write may have happened)".to_owned())?
                .map(drop)
                .map_err(|error| error.to_string())
            })
            .await;
        if let Err(error) = outcome {
            let error = match error {
                dima_commands::runtime::lookup::WriteFailure::Write(error) => error,
                dima_commands::runtime::lookup::WriteFailure::Cache(error) => error.to_string(),
            };
            self.log(
                false,
                &json!({
                    "function": "Commands.updateCommandInDB",
                    "channelID": channel_id,
                    "error": error,
                }),
                channel_id,
            );
        }
    }

    /// `saveKeywordCount(channelID, id, count)` as an `$inc`, then the body cache entry is
    /// dropped. A failure is thrown, as the reference's is.
    async fn add_keyword_count(
        &self,
        channel_id: &str,
        id: ObjectId,
        delta: f64,
    ) -> Result<(), CommandError> {
        let deps = self.host();
        let mut ctx = WriteContext::new(deps.clock.now_ms());
        let prepared = commands::prepare_update(
            &doc! { "channelID": channel_id, "_id": id, "activation": "keyword" },
            doc! { "$inc": { "count": dima_store::mongo::number::js_number(delta) } },
            dima_model::UpdateOptions::default(),
            Writer::Client,
            &mut ctx,
            deps.random.as_ref(),
        )
        .map_err(|error| CommandError::Store(error.to_string()))?;
        tokio::time::timeout(
            deps.storage.store_deadline,
            deps.mongo
                .writes(commands::COLLECTION)
                .update_one(&prepared),
        )
        .await
        .map_err(|_| CommandError::Store("the keyword count did not save in time".into()))?
        .map_err(|error| CommandError::Store(error.to_string()))?;
        let key = deps.keys.key(keyword_body_key(channel_id, &id.to_hex()));
        deps.dragonfly
            .del(&[key.as_str()])
            .await
            .map_err(|error| CommandError::Store(error.to_string()))?;
        Ok(())
    }

    async fn program(&self, program: &str, context: Context) -> Result<Value, RunError> {
        let compiled = self.engine().parse(program).map_err(RunError::Parse)?;
        let channel_id = context.broadcaster_id.clone();
        let mut host = self.host_for(&channel_id, VariableScope::Detached);
        let evaluated = self
            .engine()
            .evaluate_program_message(&compiled, &context, State::default(), &mut host)
            .await?;
        let references = evaluated.state.command_references;
        let _ = self
            .deliver_message(
                &channel_id,
                crate::delivery::AstMessage {
                    text: String::new(),
                    references,
                },
                true,
            )
            .await;
        Ok(evaluated.value)
    }
}

impl CommandRunner for ChatDelivery {
    fn run_program<'a>(
        &'a self,
        program: &'a str,
        context: Context,
    ) -> HostFuture<'a, Result<Value, RunError>> {
        Box::pin(self.program(program, context))
    }
}
