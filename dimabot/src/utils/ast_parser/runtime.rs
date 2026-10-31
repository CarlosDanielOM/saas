//! Native bot/AST application runtime — shared contract.
//!
//! The native AST syntax engine ([`crate::utils::ast_syntax`]) and evaluator
//! ([`crate::utils::ast_evaluator`]) already exist and are substantial. This
//! module is the **application layer** that turns them into a working bot
//! flow: it binds the evaluator to the real Twitch client, the Dragonfly
//! cache and the MongoDB AST-variable collection, and it ports the TypeScript
//! chat/command pipeline that drives the evaluator.
//!
//! | TypeScript source                         | Native module            |
//! |------------------------------------------|--------------------------|
//! | `src/handlers/special_parser.handler.ts`   | `runtime::parser`        |
//! | `src/handlers/commands.handler.ts`        | `runtime::command`       |
//! | `src/functions/chats/send_message.chat.ts`| `runtime::chat`          |
//! | `src/utils/ast_command_delivery.ts`       | `runtime::delivery`      |
//! | `src/utils/ast_parser/evaluator.ts`       | `runtime::host`          |
//! | `src/utils/ast_parser/effects.ts`         | `runtime::effects`       |
//!
//! # Threading
//!
//! The native evaluator's context is `Rc<RefCell<..>>` and its host future is
//! not `Send`, so this runtime is single-threaded by construction — exactly
//! like the Node event loop it replaces. Every seam below therefore uses a
//! **non-`Send`** boxed future. Do not add `Send` bounds to these traits or to
//! anything holding a [`CommandReference`]: the native AST context,
//! [`EffectToken`] and the command-reference queue are all `Rc`-based.
//! A `tokio::task::LocalSet` (or an equivalent single-threaded task) is
//! required to drive the runtime.
//!
//! # Construction
//!
//! No constructor in this tree performs I/O. Every adapter is injected by the
//! caller, so a test can drive the same code paths with in-memory fakes.

use std::{future::Future, pin::Pin};

use crate::utils::ast_evaluator::{CommandReference, CommandReferenceState, EffectToken, JsValue};

#[path = "runtime/chat.rs"]
pub mod chat;
#[path = "runtime/command.rs"]
pub mod command;
#[path = "runtime/bootstrap.rs"]
pub mod bootstrap;
#[path = "runtime/delivery.rs"]
pub mod delivery;
#[path = "runtime/effects.rs"]
pub mod effects;
#[path = "runtime/functions.rs"]
pub mod functions;
#[path = "runtime/host.rs"]
pub mod host;
#[path = "runtime/keyword_state.rs"]
pub mod keyword_state;
#[path = "runtime/parser.rs"]
pub mod parser;
#[path = "runtime/variables.rs"]
pub mod variables;
#[path = "runtime/wiring.rs"]
pub mod wiring;

/// Boxed future used by every seam in this tree.
///
/// Deliberately **not** `Send`: the native AST context and effect authority
/// are `Rc`-based and cannot cross a thread boundary.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Persistent AST variables always live in the channel-wide `global` scope,
/// regardless of which command, event, redemption or timer executed the AST.
pub const AST_VARIABLE_SCOPE_TYPE: &str = "global";
pub const AST_VARIABLE_SCOPE_NAME: &str = "global";

/// The channel and user that own a persistent AST variable.
///
/// Mirrors the TypeScript variable document key: `channelID`, `scopeType`,
/// `scopeName` and either `userId` or a normalized `userLogin`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AstScope {
    pub channel_id: String,
    pub user_id: String,
    pub user_login: String,
}

impl AstScope {
    pub fn new(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            user_id: String::new(),
            user_login: String::new(),
        }
    }

    pub fn with_user(
        mut self,
        user_id: impl Into<String>,
        user_login: impl Into<String>,
    ) -> Self {
        self.user_id = user_id.into();
        self.user_login = user_login.into();
        self
    }

    /// The TypeScript `normalizeUserLogin`: trim, strip leading `@`, lowercase.
    pub fn normalized_user_login(&self) -> String {
        normalize_user_login(&self.user_login)
    }
}

/// Trim, strip leading `@`, lowercase — the source's login normalization.
pub fn normalize_user_login(user_login: &str) -> String {
    user_login.trim().trim_start_matches('@').to_lowercase()
}

/// Typed failure for every runtime operation.
///
/// The source returns ad-hoc strings; the native port keeps the failure
/// kinds distinguishable so callers can react without string matching.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AstRuntimeError {
    /// The AST source did not compile. Carries the source's diagnostic text.
    Syntax(String),
    /// The evaluator rejected the program at run time.
    Evaluation(String),
    /// A host operation (cache, variable store, timer, function) failed.
    Host(String),
    /// The requested capability has no application adapter in this port.
    Unsupported(String),
    /// The application service refused the call (moderation hold, auth, …).
    Rejected(String),
    /// The operation was cancelled before it completed.
    Cancelled,
}

impl AstRuntimeError {
    pub fn message(&self) -> &str {
        match self {
            Self::Syntax(message)
            | Self::Evaluation(message)
            | Self::Host(message)
            | Self::Unsupported(message)
            | Self::Rejected(message) => message,
            Self::Cancelled => "cancelled",
        }
    }

    pub fn cancelled() -> Self {
        Self::Cancelled
    }
}

impl std::fmt::Display for AstRuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for AstRuntimeError {}

/// Result of a context-aware chat send.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendResult {
    pub error: bool,
    pub message: String,
    pub status: Option<u16>,
}

impl SendResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            error: false,
            message: message.into(),
            status: Some(200),
        }
    }

    pub fn failure(message: impl Into<String>, status: u16) -> Self {
        Self {
            error: true,
            message: message.into(),
            status: Some(status),
        }
    }
}

/// Result of executing one command reference.
#[derive(Clone, Debug, Default)]
pub struct CommandExecutionResult {
    pub error: bool,
    pub message: String,
    pub status: Option<u16>,
    pub type_name: String,
    pub command_references: Vec<CommandReference>,
}

/// An authored AST message: rendered text plus the queued command references
/// the renderer produced.
#[derive(Clone, Debug, Default)]
pub struct AstMessage {
    pub parsed_text: String,
    pub command_references: Vec<CommandReference>,
}

/// Port of the TypeScript `ISpecialParserContext`.
///
/// Every field is optional exactly where the source is optional; the native
/// port does not invent defaults that change behaviour.
#[derive(Clone, Debug, Default)]
pub struct SpecialParserContext {
    pub effect_context: Option<EffectToken>,
    pub command_reference_state: Option<CommandReferenceState>,
    pub channel_id: String,
    pub scope_type: Option<String>,
    pub scope_name: Option<String>,
    pub scope_aliases: Vec<String>,
    pub event_data: Option<JsValue>,
    pub eventsub_data: Option<JsValue>,
    pub argument: Option<String>,
    /// Keep command arguments literal, including inside nested AST functions.
    pub literal_arguments: bool,
    pub count: Option<f64>,
    pub variables: Vec<(String, String)>,
    pub user_plan: Option<String>,
    pub user_level: Option<f64>,
    pub extra_context: Option<JsValue>,
}

/// Port of the TypeScript `ISpecialParserResult`.
#[derive(Clone, Debug, Default)]
pub struct SpecialParserResult {
    pub parsed_text: String,
    pub count: f64,
    pub count_modified: bool,
    pub command_references: Vec<CommandReference>,
}

/// Dragonfly-backed cache seam for AST runtime cache operations.
///
/// The production implementation lives in [`crate::utils::ast_runtime::host`].
pub trait AstCache: Send + Sync {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>>;
    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, AstRuntimeError>>;
    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn expire<'a>(
        &'a self,
        key: &'a str,
        seconds: u64,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
}

/// MongoDB-backed persistent AST variable seam.
///
/// The production implementation lives in
/// [`crate::utils::ast_runtime::variables`].
pub trait AstVariableStore: Send + Sync {
    fn load_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>>;
    fn save_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn delete_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn load_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>>;
    fn save_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn delete_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
}

/// A host that can be re-bound to the channel and user that own the
/// persistent variables it is about to touch.
///
/// The native evaluator's context carries no scope of its own, so the
/// application host is scoped per execution. The production implementation
/// lives in [`crate::utils::ast_runtime::host`].
pub trait ScopedAstHost: crate::utils::ast_evaluator::Host {
    /// Rebind the host to `scope` before the next evaluation.
    fn set_scope(&mut self, scope: AstScope);
}

/// A family of AST functions backed by real application adapters.
///
/// The native evaluator routes every function that is neither a context
/// builtin nor a pure native function through `HostRequest::Function`; the
/// application host hands that request to the catalog. The scope is the
/// channel and user the host is currently bound to, because the source's
/// handlers read `ctx.broadcasterId`.
///
/// A family with no adapter yet must return
/// [`AstRuntimeError::Unsupported`] rather than a fabricated value.
pub trait AstFunctionCatalog: Send + Sync {
    fn call<'a>(
        &'a self,
        scope: &AstScope,
        name: &str,
        args: &[JsValue],
    ) -> BoxFuture<'a, Result<JsValue, AstRuntimeError>>;
}

/// Parses an authored AST body into rendered text plus queued command
/// references.
///
/// Implemented by the special parser in
/// [`crate::utils::ast_runtime::parser`].
pub trait AstBodyParser {
    fn parse<'a>(
        &'a mut self,
        text: &'a str,
        context: SpecialParserContext,
    ) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>>;
}

/// Executes one command reference and returns its own reply plus any nested
/// references it produced.
///
/// Implemented by the command executor in
/// [`crate::utils::ast_runtime::command`].
pub trait CommandRunner {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>>;
}

/// Sends one rendered chat message.
///
/// Mirrors the source's `DeliveryDependencies.send`. The production
/// implementation lives in [`crate::utils::ast_runtime::chat`].
pub trait ChatSender {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>;
}
