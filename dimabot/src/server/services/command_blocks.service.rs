//! Ports `src/server/services/command_blocks.service.ts`: the plan gate, the
//! client projection and the body → `{ message, authoring, blocks }` resolver
//! for block commands.
//!
//! Reused natively instead of re-ported:
//! * `crate::utils::ast_blocks::{compile_blocks, stored_blocks, BlocksError,
//!   MAX_COMMAND_TEXT}` — the already-migrated block compiler, including its
//!   JavaScript UTF-16 length limit and its `blockId` diagnostics.
//! * `crate::schemas::users` — the channel owner's `plan_tier` read.
//! * `crate::utils::js_compat::trim` for the JavaScript `trim()` used by the
//!   blank-reply check.
//!
//! Decomposition note: the source's `resolveCommandBody` is one async function
//! whose only await is `channelPlanTier`. [`CommandBlocksService::resolve_command_body`]
//! is that function; [`resolve_command_body_with_plan`] is the identical tail
//! after the plan has been read, so the body rules can be replayed without a
//! database while the production path still reads the real owner document.
//!
//! Constructors perform no IO. `channelPlanTier` is the one read and keeps the
//! source's `maxTimeMS(1500)`.

use crate::schemas::users;
use crate::utils::ast_blocks::{MAX_COMMAND_TEXT, compile_blocks, stored_blocks};
use crate::utils::js_compat::trim;
use mongodb::{
    Collection, Database,
    bson::{Document, doc},
};
use serde_json::{Map, Value, json};
use std::{fmt, time::Duration};

/// `maxTimeMS(1500)` from `channelPlanTier`.
pub const PLAN_READ_TIMEOUT: Duration = Duration::from_millis(1500);

/// Block commands are a Premium/Pro feature; the channel owner's plan decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelPlan {
    Free,
    Premium,
    Pro,
}

impl ChannelPlan {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }

    /// The source's two exact comparisons; anything else is `free`.
    pub fn from_plan_tier(plan_tier: Option<&str>) -> Self {
        match plan_tier {
            Some("pro") => Self::Pro,
            Some("premium") => Self::Premium,
            _ => Self::Free,
        }
    }
}

impl fmt::Display for ChannelPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

pub fn can_edit_blocks(plan: ChannelPlan) -> bool {
    matches!(plan, ChannelPlan::Premium | ChannelPlan::Pro)
}

/// `options: { blocks?: boolean }` — the default is `{ blocks: false }`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PresentCommandOptions {
    pub blocks: bool,
}

/// Command as sent to any client. Block commands never include their compiled
/// text (`message` is blank); their blocks are included only when asked for, so
/// viewers can open the read-only block view.
pub fn present_command(command: &Value, options: PresentCommandOptions) -> Value {
    // `...(typeof toObject === 'function' ? toObject() : command)`; a
    // non-object spread yields an empty object in JavaScript as well.
    let mut plain = command.as_object().cloned().unwrap_or_default();
    let is_blocks = plain.get("authoring").and_then(Value::as_str) == Some("blocks");
    plain.insert(
        "authoring".to_owned(),
        Value::String(if is_blocks { "blocks" } else { "text" }.to_owned()),
    );
    if is_blocks {
        plain.insert("message".to_owned(), Value::String(String::new()));
    }
    if !is_blocks || !options.blocks {
        plain.remove("blocks");
    }
    Value::Object(plain)
}

/// The `current` command fields `resolveCommandBody` reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandBodyCurrent {
    pub authoring: Option<String>,
    pub reserved: bool,
}

impl CommandBodyCurrent {
    pub fn new(authoring: Option<&str>, reserved: bool) -> Self {
        Self {
            authoring: authoring.map(str::to_owned),
            reserved,
        }
    }

    /// `command.authoring` / `command.reserved` as stored.
    pub fn from_document(document: &Document) -> Self {
        Self {
            authoring: document.get_str("authoring").ok().map(str::to_owned),
            reserved: document.get_bool("reserved").unwrap_or(false),
        }
    }
}

/// `CommandBlocksRequestError` — a client-visible `{status, code, message,
/// blockId?}` envelope, never a storage failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandBlocksRequestError {
    status: u16,
    code: &'static str,
    message: String,
    block_id: Option<String>,
}

impl CommandBlocksRequestError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            block_id: None,
        }
    }

    fn with_block_id(mut self, block_id: Option<String>) -> Self {
        self.block_id = block_id;
        self
    }

    pub const fn status(&self) -> u16 {
        self.status
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn block_id(&self) -> Option<&str> {
        self.block_id.as_deref()
    }
}

impl fmt::Display for CommandBlocksRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CommandBlocksRequestError {}

/// The resolver's failure: a request error the route answers with the source
/// envelope, or a failure the source lets reach its 500 path.
#[derive(Debug)]
pub enum CommandBlocksError {
    Request(CommandBlocksRequestError),
    Mongo(mongodb::error::Error),
    /// `storedBlocks(root)` could not be serialized for the update payload.
    Serialize(String),
}

impl fmt::Display for CommandBlocksError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => error.fmt(formatter),
            Self::Mongo(error) => error.fmt(formatter),
            Self::Serialize(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for CommandBlocksError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(error) => Some(error),
            Self::Mongo(error) => Some(error),
            Self::Serialize(_) => None,
        }
    }
}

impl From<CommandBlocksRequestError> for CommandBlocksError {
    fn from(error: CommandBlocksRequestError) -> Self {
        Self::Request(error)
    }
}

impl From<mongodb::error::Error> for CommandBlocksError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

/// Concrete owner-plan reader for block editing.
#[derive(Clone)]
pub struct CommandBlocksService {
    users: Collection<Document>,
}

impl CommandBlocksService {
    pub fn new(database: &Database) -> Self {
        Self {
            users: users::schema().native_collection(database),
        }
    }

    /// `channelPlanTier`: the owner's `plan_tier`, bounded by `maxTimeMS(1500)`.
    pub async fn channel_plan_tier(
        &self,
        channel_id: &str,
    ) -> Result<ChannelPlan, CommandBlocksError> {
        let owner = self
            .users
            .find_one(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel_id}}})
            .projection(doc! {"plan_tier": 1, "_id": 0})
            .max_time(PLAN_READ_TIMEOUT)
            .await?;
        Ok(owner.as_ref().map_or(ChannelPlan::Free, |owner| {
            ChannelPlan::from_plan_tier(owner.get_str("plan_tier").ok())
        }))
    }

    /// `resolveCommandBody`: body → the `{ message, authoring, blocks }` fields
    /// to save, checking the plan and the limits.
    pub async fn resolve_command_body(
        &self,
        channel_id: &str,
        body: &Map<String, Value>,
        current: Option<&CommandBodyCurrent>,
    ) -> Result<Map<String, Value>, CommandBlocksError> {
        // The source returns the settings-only payload before it awaits the plan.
        if is_settings_only_block_body(body, current) {
            return Ok(Map::new());
        }
        if wants_blocks(body) {
            // The source's reserved check answers before `channelPlanTier`.
            if current.is_some_and(|current| current.reserved) {
                return Err(reserved_error().into());
            }
            let plan = self.channel_plan_tier(channel_id).await?;
            return resolve_command_body_with_plan(plan, body, current);
        }
        // A text body never reads the owner plan.
        resolve_command_body_with_plan(ChannelPlan::Free, body, current)
    }
}

/// The plan-aware tail of `resolveCommandBody`. `plan` is read only for a body
/// that asks for blocks, mirroring the source's `await` ordering: the reserved
/// check answers first, and the settings-only body never reads the plan.
pub fn resolve_command_body_with_plan(
    plan: ChannelPlan,
    body: &Map<String, Value>,
    current: Option<&CommandBodyCurrent>,
) -> Result<Map<String, Value>, CommandBlocksError> {
    let currently_blocks = current.is_some_and(|current| {
        current.authoring.as_deref() == Some("blocks")
    });
    let authored_text = body.get("authoring").and_then(Value::as_str) == Some("text");

    if is_settings_only_block_body(body, current) {
        return Ok(Map::new());
    }

    if wants_blocks(body) {
        if current.is_some_and(|current| current.reserved) {
            return Err(reserved_error().into());
        }
        if !can_edit_blocks(plan) {
            return Err(CommandBlocksRequestError::new(
                403,
                "plan_required",
                "Block commands need Premium or Pro",
            )
            .into());
        }
        let input = body.get("blocks").cloned().unwrap_or(Value::Null);
        let compiled = compile_blocks(&input).map_err(|error| {
            CommandBlocksRequestError::new(400, "blocks_invalid", error.message.clone())
                .with_block_id(error.block_id.clone())
        })?;
        let blocks = serde_json::to_value(stored_blocks(compiled.root))
            .map_err(|error| CommandBlocksError::Serialize(error.to_string()))?;
        let mut payload = Map::new();
        payload.insert("authoring".to_owned(), json!("blocks"));
        payload.insert("blocks".to_owned(), blocks);
        payload.insert("message".to_owned(), Value::String(compiled.text));
        return Ok(payload);
    }

    if authored_text || !currently_blocks {
        if !body.contains_key("message") {
            return if authored_text && currently_blocks {
                Err(missing_message().into())
            } else {
                Ok(Map::new())
            };
        }
        let message = body.get("message").and_then(Value::as_str).unwrap_or("");
        // `message.length` counts UTF-16 code units, not bytes.
        let length = message.encode_utf16().count();
        if length > MAX_COMMAND_TEXT {
            return Err(CommandBlocksRequestError::new(
                400,
                "too_long",
                format!("The reply is too long ({length} of {MAX_COMMAND_TEXT} characters)"),
            )
            .into());
        }
        if currently_blocks && trim(message).is_empty() {
            return Err(missing_message().into());
        }
        let mut payload = Map::new();
        if currently_blocks || authored_text {
            payload.insert("authoring".to_owned(), json!("text"));
            payload.insert("blocks".to_owned(), Value::Null);
        }
        payload.insert("message".to_owned(), Value::String(message.to_owned()));
        return Ok(payload);
    }

    // A block command edited without new blocks: settings only, the reply stays.
    Ok(Map::new())
}

fn wants_blocks(body: &Map<String, Value>) -> bool {
    body.get("authoring").and_then(Value::as_str) == Some("blocks")
}

fn is_settings_only_block_body(
    body: &Map<String, Value>,
    current: Option<&CommandBodyCurrent>,
) -> bool {
    wants_blocks(body)
        && current.is_some_and(|current| current.authoring.as_deref() == Some("blocks"))
        && !body.contains_key("blocks")
}

fn missing_message() -> CommandBlocksRequestError {
    CommandBlocksRequestError::new(
        400,
        "missing_message",
        "Type the new reply to switch back to text",
    )
}

fn reserved_error() -> CommandBlocksRequestError {
    CommandBlocksRequestError::new(400, "reserved", "Built-in commands can't use blocks")
}
