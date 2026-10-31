//! End-to-end application facade for the native bot/AST runtime.
//!
//! [`BotRuntime`] owns the real collaborators and implements the three runtime
//! seams — [`AstBodyParser`], [`CommandRunner`] and [`ChatSender`] — so a chat
//! message can flow end to end:
//!
//! ```text
//! chat message
//!   → AstBodyParser (runtime::parser,  Lane C)   rendered text + command references
//!   → ChatSender    (runtime::chat,    this tree) outer send, reply target honoured
//!   → CommandRunner (runtime::command, Lane C)   one command reference at a time
//!   → ChatSender                                 nested send per referenced channel
//! ```
//!
//! Construction performs no I/O: every collaborator is injected, so a caller
//! can also build the same facade around in-memory seams in tests. The command
//! store is generic over Lane C's [`CommandStore`]; the production
//! implementation is `command::NativeCommandStore`, whose Redis connection and
//! `Commands` service belong to the caller.
//!
//! # Collaborators
//!
//! - `Engine`: the native evaluator ([`crate::utils::ast_evaluator::Engine`]).
//! - `ApplicationHost` (Lane B): the scoped cache/variable/Twitch host.
//! - `SpecialParser` and `execute_command` (Lane C) with a `CommandStore`.
//! - `TwitchStreamers`: channel directory used by the special parser.
//! - `TwitchFunctions`: the real Helix client behind [`ChatSender`].
//!
//! # Why two `ApplicationHost` instances
//!
//! Lane B's [`ScopedAstHost`](super::ScopedAstHost) carries the channel/user
//! scope of one evaluation, so parsing and command execution cannot share a
//! single `&mut` host while both seams are alive. [`BotRuntime`] therefore owns
//! one host per seam. Both are built from the same `Arc` cache and variable
//! store, and every call re-scopes its own host, so no state is duplicated.

use std::sync::Arc;

use crate::{
    functions::TwitchFunctions,
    utils::{
        ast_evaluator::{CommandReference, Engine},
        logger::Logger,
        twitch_streamers::TwitchStreamers,
    },
};

use super::{
    AstBodyParser, AstCache, AstFunctionCatalog, AstMessage, AstRuntimeError, AstVariableStore,
    BoxFuture, ChatSender, CommandExecutionResult, CommandRunner, SendResult, SpecialParserContext,
    SpecialParserResult,
    chat::{
        ContextualMessage, ContextualSeams, TwitchChatSender, send_chat_message,
        send_contextual_message,
    },
    command::{CommandStore, execute_command},
    delivery::{DeliverySeams, deliver_ast_message},
    host::ApplicationHost,
    parser::{SpecialParser, parse_special_commands},
};

/// Application facade that binds the evaluator, the Lane B host, the Lane C
/// parser/command executor and the Twitch client together.
pub struct BotRuntime<S: CommandStore> {
    engine: Engine,
    parser_host: ApplicationHost,
    command_host: ApplicationHost,
    cache: Arc<dyn AstCache>,
    variables: Arc<dyn AstVariableStore>,
    directory: Arc<TwitchStreamers>,
    store: S,
    twitch: TwitchFunctions,
    logger: Option<Arc<Logger>>,
}

impl<S: CommandStore> BotRuntime<S> {
    /// Assemble the facade from real collaborators. No I/O, no background task
    /// and no global state; `engine` is supplied by the caller so the production
    /// function registry stays Lane B/C's decision.
    pub fn new(
        engine: Engine,
        cache: Arc<dyn AstCache>,
        variables: Arc<dyn AstVariableStore>,
        directory: Arc<TwitchStreamers>,
        store: S,
        twitch: TwitchFunctions,
    ) -> Self {
        let parser_host = ApplicationHost::new(Arc::clone(&cache), Arc::clone(&variables));
        let command_host = ApplicationHost::new(Arc::clone(&cache), Arc::clone(&variables));
        Self {
            engine,
            parser_host,
            command_host,
            cache,
            variables,
            directory,
            store,
            twitch,
            logger: None,
        }
    }

    /// Install the AST function catalog and the timer scheduler.
    ///
    /// The catalog is the single owner of the application-backed AST function
    /// families (`chat.send`, `delay`, …). It also implements the host's
    /// [`TimerScheduler`](super::host::TimerScheduler), so the same object
    /// serves both seams and there is only one timer path in this runtime.
    ///
    /// Without this, `HostRequest::Function` refuses every family and
    /// `HostRequest::ScheduleTimer` reports the timer adapter gap.
    pub fn with_functions(
        mut self,
        functions: Arc<dyn AstFunctionCatalog>,
        timer: Arc<dyn super::host::TimerScheduler>,
    ) -> Self {
        self.parser_host = ApplicationHost::new(
            Arc::clone(&self.cache),
            Arc::clone(&self.variables),
        )
        .with_functions(Arc::clone(&functions))
        .with_timer(Arc::clone(&timer));
        self.command_host = ApplicationHost::new(
            Arc::clone(&self.cache),
            Arc::clone(&self.variables),
        )
        .with_functions(Arc::clone(&functions))
        .with_timer(Arc::clone(&timer));
        self
    }

    /// Attach the shared logger used for delivery and chat diagnostics.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn twitch(&self) -> &TwitchFunctions {
        &self.twitch
    }

    pub fn directory(&self) -> &Arc<TwitchStreamers> {
        &self.directory
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn logger(&self) -> Option<&Arc<Logger>> {
        self.logger.as_ref()
    }

    /// Parse → send → deliver one chat message.
    ///
    /// `context` drives the AST parse; this is the single entry point a chat
    /// message needs.
    pub async fn handle_chat_message(
        &mut self,
        channel_id: &str,
        message: &str,
        context: SpecialParserContext,
    ) -> Result<SendResult, AstRuntimeError> {
        self.handle_chat_reply(channel_id, message, None, context)
            .await
    }

    /// Same as [`Self::handle_chat_message`] with an explicit reply target.
    pub async fn handle_chat_reply(
        &mut self,
        channel_id: &str,
        message: &str,
        reply_to_message_id: Option<&str>,
        context: SpecialParserContext,
    ) -> Result<SendResult, AstRuntimeError> {
        let mut sender =
            TwitchChatSender::with_optional_logger(self.twitch.clone(), self.logger.clone());
        let mut parser = SpecialParser {
            engine: &self.engine,
            host: &mut self.parser_host,
            directory: &*self.directory,
        };
        let mut runner = CommandAdapter {
            engine: &self.engine,
            host: &mut self.command_host,
            directory: &*self.directory,
            store: &mut self.store,
        };
        let logger = self.logger.as_ref();

        send_contextual_message(
            ContextualSeams {
                sender: &mut sender,
                parser: &mut parser,
                runner: &mut runner,
                logger,
            },
            ContextualMessage {
                channel_id,
                message,
                reply_to_message_id,
                context: Some(context),
            },
        )
        .await
    }

    /// Deliver an already rendered [`AstMessage`]: outer text first, then the
    /// queued command references in authored order.
    pub async fn deliver(
        &mut self,
        channel_id: &str,
        message: &mut AstMessage,
        chat_enabled: bool,
    ) -> Result<SendResult, AstRuntimeError> {
        let mut sender =
            TwitchChatSender::with_optional_logger(self.twitch.clone(), self.logger.clone());
        let mut runner = CommandAdapter {
            engine: &self.engine,
            host: &mut self.command_host,
            directory: &*self.directory,
            store: &mut self.store,
        };
        deliver_ast_message(
            channel_id,
            message,
            chat_enabled,
            DeliverySeams {
                sender: &mut sender,
                runner: &mut runner,
                logger: self.logger.as_ref(),
            },
        )
        .await
    }
}

/// Parse seam: Lane C's special parser against the parser-side host.
impl<S: CommandStore> AstBodyParser for BotRuntime<S> {
    fn parse<'a>(
        &'a mut self,
        text: &'a str,
        context: SpecialParserContext,
    ) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> {
        let engine = &self.engine;
        let host = &mut self.parser_host;
        let directory = &*self.directory;
        Box::pin(async move {
            parse_special_commands(engine, host, directory, text, context).await
        })
    }
}

/// Command seam: Lane C's executor against the command-side host.
impl<S: CommandStore> CommandRunner for BotRuntime<S> {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        let engine = &self.engine;
        let host = &mut self.command_host;
        let directory = &*self.directory;
        let store = &mut self.store;
        Box::pin(async move {
            // A command body is parsed with the same parser, borrowing only the
            // command-side host.
            let mut parser = SpecialParser {
                engine,
                host,
                directory,
            };
            execute_command(&mut *store, &mut parser, request).await
        })
    }
}

/// Send seam: a plain Twitch chat send with no reply target, as reference
/// delivery requires.
impl<S: CommandStore> ChatSender for BotRuntime<S> {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        let twitch = &self.twitch;
        let logger = self.logger.as_ref();
        Box::pin(async move {
            send_chat_message(twitch, logger, channel_id, text, None, None).await
        })
    }
}

/// Adapter that gives reference execution a runner borrowing only the
/// command-side fields. Lane C's `execute_command` needs both a
/// [`CommandStore`] and an [`AstBodyParser`] for the referenced command body.
struct CommandAdapter<'a, S: CommandStore> {
    engine: &'a Engine,
    host: &'a mut ApplicationHost,
    directory: &'a TwitchStreamers,
    store: &'a mut S,
}

impl<S: CommandStore> CommandRunner for CommandAdapter<'_, S> {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        let engine = self.engine;
        let directory = self.directory;
        let host = &mut *self.host;
        let store = &mut *self.store;
        Box::pin(async move {
            let mut parser = SpecialParser {
                engine,
                host,
                directory,
            };
            execute_command(store, &mut parser, request).await
        })
    }
}
