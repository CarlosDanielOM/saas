//! What one evaluation runs with ([`Context`], read-only) and what it changes ([`State`]),
//! and what it leaves for the caller (command references, timer snapshots).
//!
//! The reference passes one `ExecutionContext` object that mixes both; JavaScript object
//! spreads then decide which changes survive. Here the invocation data is immutable, the
//! mutable part is [`State`], and the evaluator reproduces which changes survive.

use crate::map::OrderedMap;
use crate::value::Value;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

/// The channel's plan (`userPlan`): it sets loop limits and whether `*`/`**` variables are
/// written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    /// Free: loops 2 deep and 25 iterations, database variables are read-only.
    #[default]
    Free,
    /// Premium: loops 3 deep and 50 iterations.
    Premium,
    /// Pro: loops 4 deep and 100 iterations.
    Pro,
}

impl Plan {
    /// `free`, `premium` or `pro`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }

    /// `canWriteDbVariables`.
    pub fn writes_db_variables(self) -> bool {
        matches!(self, Self::Premium | Self::Pro)
    }

    /// `getMaxLoopDepth`.
    pub fn max_loop_depth(self) -> u32 {
        match self {
            Self::Free => 2,
            Self::Premium => 3,
            Self::Pro => 4,
        }
    }

    /// `getMaxLoopIterations`.
    pub fn max_loop_iterations(self) -> u32 {
        match self {
            Self::Free => 25,
            Self::Premium => 50,
            Self::Pro => 100,
        }
    }
}

/// Who a run acts for (`AstAuthorization.origin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// A chat command typed by a viewer.
    Chat,
    /// An AI tool call on behalf of a chatter.
    Llm,
    /// Text the streamer wrote (commands, events, timers, rewards).
    Authored,
}

/// `AstAuthorization`: the run's origin and, for AI runs, the requesting chatter's identity as
/// stored (any shape; [`crate::permissions::parse_identity`] reads it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    /// Origin.
    pub origin: Origin,
    /// `auditOrigin` (`oauth_desktop` for the desktop app).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub audit_origin: Option<String>,
    /// The serialized identity, as data.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub identity: Option<Value>,
}

/// The permission system's role tags and identities (`dima-commands`).
pub use crate::permissions::{RoleTag, UserIdentity};

/// Live effect authority (`AstEffectContext`): minted only by the host from verified ingress,
/// opaque to the engine and never built from data. The engine carries it, strips it from
/// timers and asks the host to fork it for command references.
#[derive(Clone)]
pub struct Effect(Arc<dyn Any + Send + Sync>);

impl Effect {
    /// Wraps the host's authority state.
    pub fn new<T: Any + Send + Sync>(state: T) -> Self {
        Self(Arc::new(state))
    }

    /// The host's state, when it is a `T`.
    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref()
    }

    /// Whether two handles are the same authority.
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Effect(<opaque>)")
    }
}

/// `commandRefBudget`: how many more command references the whole call tree may start. One
/// budget is shared by a run, the references it starts and theirs (clones share it).
#[derive(Clone, Debug)]
pub struct Budget(Arc<AtomicI64>);

impl Budget {
    /// A new budget.
    pub fn new(remaining: i64) -> Self {
        Self(Arc::new(AtomicI64::new(remaining)))
    }

    /// What is left.
    pub fn remaining(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    /// Takes one unit, if any is left.
    pub fn take(&self) -> bool {
        self.0
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                (left > 0).then(|| left - 1)
            })
            .is_ok()
    }

    /// Whether `other` is this same budget (not a copy).
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Default for Budget {
    /// The reference's 50 references per call tree.
    fn default() -> Self {
        Self::new(50)
    }
}

/// `randomUserState`: per-run memory of `$(randomuser)`, for the host's implementation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RandomUserState {
    /// Lowercase identities already picked this run (`unique`).
    pub selected: Vec<String>,
    /// The channel's blacklist once loaded (or the failure, which is not retried in the run).
    pub blacklist: Option<Result<Vec<String>, String>>,
}

/// The invocation: who runs what, where. Read-only during the run.
#[derive(Clone, Debug)]
pub struct Context {
    /// `broadcasterId`.
    pub broadcaster_id: String,
    /// `userId`.
    pub user_id: String,
    /// `userLogin`.
    pub user_login: String,
    /// `userDisplayName`.
    pub user_display_name: String,
    /// `userPlan`.
    pub user_plan: Plan,
    /// `userLevel` (a number in the reference; 1 to 10 in practice).
    pub user_level: f64,
    /// `enforceFunctionPermissions`: false for streamer-authored text, where the command's own
    /// level is the gate; true for AI tool calls.
    pub enforce_function_permissions: bool,
    /// `authorization`.
    pub authorization: Option<Authorization>,
    /// `argument`: the text after the command name.
    pub argument: Option<String>,
    /// `eventData` (an object in practice).
    pub event_data: Value,
    /// `eventsubData`.
    pub eventsub_data: Value,
    /// `extraContext`.
    pub extra_context: Value,
    /// `streamer` (`null` when absent).
    pub streamer: Value,
    /// `platform`.
    pub platform: String,
    /// `scopeType`.
    pub scope_type: String,
    /// `scopeName`.
    pub scope_name: String,
    /// `scopeAliases`.
    pub scope_aliases: Vec<String>,
    /// `commandName`.
    pub command_name: String,
    /// `commandId`.
    pub command_id: String,
    /// `effectContext`: live effect authority, when the run came from verified ingress.
    pub effect: Option<Effect>,
    /// `commandRefBudget`, shared by the whole call tree.
    pub budget: Budget,
    /// `visitedCommands`: `{channel}:{name}` of the references above this run.
    pub visited_commands: Vec<String>,
    /// `commandRefDepth`.
    pub command_ref_depth: Option<u32>,
    /// `timerDepth`: how many timers deep this run is.
    pub timer_depth: Option<u32>,
    /// `simulation` is set: a test run (the docs assistant's command tester). Every function
    /// call goes to [`crate::host::Host::simulate`] first, and timers are never evaluated.
    pub simulation: bool,
}

impl Default for Context {
    /// `createExecutionContext()`'s defaults.
    fn default() -> Self {
        Self {
            broadcaster_id: String::new(),
            user_id: String::new(),
            user_login: String::new(),
            user_display_name: String::new(),
            user_plan: Plan::Free,
            user_level: 1.0,
            enforce_function_permissions: true,
            authorization: None,
            argument: None,
            event_data: Value::Undefined,
            eventsub_data: Value::Undefined,
            extra_context: Value::Undefined,
            streamer: Value::Null,
            platform: "twitch".into(),
            scope_type: "command".into(),
            scope_name: String::new(),
            scope_aliases: Vec::new(),
            command_name: String::new(),
            command_id: String::new(),
            effect: None,
            budget: Budget::default(),
            visited_commands: Vec::new(),
            command_ref_depth: None,
            timer_depth: None,
            simulation: false,
        }
    }
}

/// `loopExit`: set by `$(break)` and `$(continue)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LoopExit {
    /// Leave the innermost loop.
    Break,
    /// Skip to its next iteration.
    Continue,
}

impl LoopExit {
    /// `break` or `continue`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Break => "break",
            Self::Continue => "continue",
        }
    }
}

/// What a run reads and changes: variables, the use count, responses, the references it
/// starts. The caller supplies it (usually [`State::default`]) and gets it back.
#[derive(Clone, Debug, Default)]
pub struct State {
    /// The command's use count (`count`).
    pub count: f64,
    /// Whether `$(count)` or `$(scount)` ran (`countModified`): the caller then stores `count`.
    pub count_modified: bool,
    /// Plain variables (`variables`): argument placeholders and `%(name …)`.
    pub variables: OrderedMap<String, String>,
    /// Legacy list variables (`arrays`), read as JSON.
    pub arrays: OrderedMap<String, Vec<String>>,
    /// Loop variables (`loopVars`); empty outside loops.
    pub loop_vars: OrderedMap<String, String>,
    /// How many loops deep (`loopDepth`).
    pub loop_depth: u32,
    /// A pending `break`/`continue` (`loopExit`).
    pub loop_exit: Option<LoopExit>,
    /// The command's stored responses (`commandResponses`, `%(responses…)`).
    pub command_responses: Vec<String>,
    /// Channel variables read or written this run (`commandVariables`), by name.
    pub command_variables: OrderedMap<String, String>,
    /// Viewer variables read or written this run (`userCommandVariables`), by
    /// `login:{login}:{name}` or `id:{id}:{name}`.
    pub user_command_variables: OrderedMap<String, String>,
    /// References started (`commandReferences`), run by the caller after delivery.
    pub command_references: Vec<CommandReference>,
    /// `randomUserState`.
    pub random_user: RandomUserState,
}

/// How a referenced command runs (`resolveCommandRefAuthorization`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceOrigin {
    /// Streamer-authored text: runs trusted as the broadcaster.
    Authored,
    /// AI-generated text: keeps the requesting chatter's authority.
    Llm,
}

/// The authorization a reference runs with.
#[derive(Clone, Debug, PartialEq)]
pub struct ReferenceAuthorization {
    /// Origin.
    pub origin: ReferenceOrigin,
    /// Identity.
    pub identity: UserIdentity,
}

impl Serialize for ReferenceAuthorization {
    /// `{origin, identity}` with the identity as `serializeUserIdentity` writes it.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut fields = serializer.serialize_struct("ReferenceAuthorization", 2)?;
        fields.serialize_field("origin", &self.origin)?;
        fields.serialize_field("identity", &self.identity.to_json())?;
        fields.end()
    }
}

/// `CommandReferenceState`: what a reference's run inherits.
#[derive(Clone, Debug)]
pub struct ReferenceState {
    /// `visitedCommands`, this reference included.
    pub visited_commands: Vec<String>,
    /// `commandRefDepth`.
    pub command_ref_depth: u32,
    /// The shared `commandRefBudget`.
    pub budget: Budget,
    /// `timerDepth`.
    pub timer_depth: Option<u32>,
}

/// `#(name args…)`: a deferred invocation of another command, run by the caller only after
/// the surrounding message is delivered (`CommandReferenceRequest`).
#[derive(Clone, Debug)]
pub struct CommandReference {
    /// A forked effect authority (authored runs with live authority only).
    pub effect: Option<Effect>,
    /// `channelID`.
    pub channel_id: String,
    /// `commandName`: trimmed, lowercase.
    pub command_name: String,
    /// `argument`: the evaluated arguments joined by spaces.
    pub argument: String,
    /// `eventData`: the run's event data with the chatter fields set.
    pub event_data: Value,
    /// `authorization`.
    pub authorization: ReferenceAuthorization,
    /// `state`.
    pub state: ReferenceState,
}

/// `{ remaining }` of a snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetSnapshot {
    /// `remaining`.
    pub remaining: i64,
}

/// `snapshotTimerContext`: the data a timer carries to its later run, in the reference's field
/// order and JSON names. Only data: no callbacks, no effect authority, no variable memos.
/// Serialise with `dima_text::to_js_json_from` for the reference's bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerSnapshot {
    /// `broadcasterId`.
    pub broadcaster_id: String,
    /// `userId`.
    pub user_id: String,
    /// `userLogin`.
    pub user_login: String,
    /// `userDisplayName`.
    pub user_display_name: String,
    /// `userPlan`.
    pub user_plan: Plan,
    /// `userLevel`.
    pub user_level: f64,
    /// `enforceFunctionPermissions`.
    pub enforce_function_permissions: bool,
    /// `authorization`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub authorization: Option<Authorization>,
    /// `argument`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub argument: Option<String>,
    /// `count`.
    pub count: f64,
    /// `eventData`.
    #[serde(skip_serializing_if = "is_undefined", default)]
    pub event_data: Value,
    /// `eventsubData`.
    #[serde(skip_serializing_if = "is_undefined", default)]
    pub eventsub_data: Value,
    /// `extraContext`.
    #[serde(skip_serializing_if = "is_undefined", default)]
    pub extra_context: Value,
    /// `platform`.
    pub platform: String,
    /// `scopeType`.
    pub scope_type: String,
    /// `scopeName`.
    pub scope_name: String,
    /// `scopeAliases`.
    pub scope_aliases: Vec<String>,
    /// `commandName`.
    pub command_name: String,
    /// `commandId`.
    pub command_id: String,
    /// `commandRefBudget`, as a copy.
    pub command_ref_budget: BudgetSnapshot,
    /// `commandRefDepth`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command_ref_depth: Option<u32>,
    /// `visitedCommands`.
    pub visited_commands: Vec<String>,
    /// `commandResponses`.
    pub command_responses: Vec<String>,
    /// `variables` as `[name, value]` pairs.
    pub variables: Vec<(String, String)>,
    /// `arrays` as `[name, items]` pairs.
    pub arrays: Vec<(String, Vec<String>)>,
    /// `loopVars` as `[name, value]` pairs.
    pub loop_vars: Vec<(String, String)>,
    /// `timerDepth` of the timer's run (this run's plus one).
    pub timer_depth: u32,
}

fn is_undefined(value: &Value) -> bool {
    matches!(value, Value::Undefined)
}
