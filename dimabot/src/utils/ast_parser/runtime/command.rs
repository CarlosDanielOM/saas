//! Command execution using injected lookup, cooldown and body parser collaborators.
use crate::utils::ast_evaluator::{CommandReference, JsValue, json_stringify};
use crate::utils::commands::{CommandGetResponse, Commands};
use crate::utils::permissions::{command_allowed, parse_user_identity, BROADCASTER_USER_LEVEL};
use crate::utils::lossless_json::JsonValue;
use crate::utils::keywords::native::NativeKeywordCache;
use crate::utils::twitch_streamers::{DirectoryError, TwitchStreamers};
use super::{AstBodyParser, AstRuntimeError, BoxFuture, CommandExecutionResult, CommandRunner, SpecialParserContext};
use super::effects::scope_ast_effect_context;

/// Build the source-compatible per-channel execution cooldown key.
pub fn cooldown_key(channel_id: &str, execution_name: &str) -> String {
    format!("command:execution:cooldown:{channel_id}:{execution_name}")
}

/// JavaScript truthiness for a JSON value.
///
/// The source writes `if (!commandData.enabled)`, so a document whose `enabled`
/// is not a boolean is judged by JavaScript's rules, not by a strict boolean
/// check. The native command and keyword documents are schema-typed, so this
/// only differs for a malformed document — but it must differ in the same
/// direction as the source, otherwise the native would skip a command the
/// TypeScript still runs.
pub fn js_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(flag)) => *flag,
        Some(serde_json::Value::Number(number)) => number
            .as_f64()
            .map_or(true, |value| value != 0.0 && !value.is_nan()),
        Some(serde_json::Value::String(text)) => !text.is_empty(),
        Some(serde_json::Value::Array(_)) | Some(serde_json::Value::Object(_)) => true,
    }
}

/// Apply the owner-plan floor only to keyword executions.
pub fn execution_cooldown(configured: f64, keyword: bool, plan: Option<&str>) -> f64 {
    if keyword {
        (if configured.is_finite() { configured } else { 0.0 })
            .max(f64::from(crate::utils::command_cooldown::minimum_command_cooldown(plan)))
    } else {
        configured
    }
}

/// The cache operation is an atomic SET NX PX; `false` means cooldown contention.
pub trait CommandStore {
    fn lookup<'a>(&'a mut self, channel: &'a str, name: &'a str) -> BoxFuture<'a, Result<CommandGetResponse, AstRuntimeError>>;
    fn acquire<'a>(&'a mut self, key: &'a str, milliseconds: u64) -> BoxFuture<'a, Result<bool, AstRuntimeError>>;
    fn update_count<'a>(&'a mut self, channel: &'a str, name: &'a str, count: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    fn keyword_plan<'a>(&'a mut self, channel: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>>;
    /// Must query mutable state directly, after acquiring the cooldown; never use the cached body.
    fn keyword_state<'a>(&'a mut self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<(bool, f64)>, AstRuntimeError>>;
    fn update_keyword_count<'a>(&'a mut self, channel: &'a str, id: &'a str, count: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
    /// Observes the command handoff, before any gate runs.
    ///
    /// The TypeScript hands a resolved command body to `executeCustomCommand`,
    /// which is the seam its source-comparison fixture replaces. This hook is
    /// the native equivalent of that seam: it fires at the same point — the
    /// body and the reference are in hand, before the `enabled`, permission,
    /// cooldown and count gates — so a test can observe exactly what the
    /// source's recorder observes (the body, the command name, the argument
    /// and the authorization).
    ///
    /// The default implementation does nothing, so a production store pays
    /// nothing for it.
    fn handoff(&mut self, _request: &CommandReference, _body: &JsonValue) {}
}
/// Application adapter; construction performs no I/O. Supply a task-owned or application connection.
pub struct NativeCommandStore<'a> { pub commands: &'a Commands, pub redis: redis::aio::ConnectionManager, pub keywords: &'a NativeKeywordCache, pub directory: &'a TwitchStreamers }
impl NativeCommandStore<'_> {
    /// Cached configuration only; this does not provide fresh mutable keyword state.
    pub fn keyword_body<'a>(&'a self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<JsonValue>, AstRuntimeError>> {
        Box::pin(async move {
            let body = self.keywords.body(channel, id).await.map_err(|e| AstRuntimeError::Host(e.to_string()))?;
            body.map(|value| crate::utils::lossless_json::parse_json(&value.to_string()).map_err(AstRuntimeError::Host)).transpose()
        })
    }
}
impl CommandStore for NativeCommandStore<'_> {
    fn lookup<'a>(&'a mut self, channel: &'a str, name: &'a str) -> BoxFuture<'a, Result<CommandGetResponse, AstRuntimeError>> { Box::pin(async move { Ok(self.commands.get_command_from_db(channel, name).await) }) }
    fn acquire<'a>(&'a mut self, key: &'a str, milliseconds: u64) -> BoxFuture<'a, Result<bool, AstRuntimeError>> { Box::pin(async move {
        let result: Option<String> = redis::cmd("SET").arg(key).arg("1").arg("NX").arg("PX").arg(milliseconds).query_async(&mut self.redis).await.map_err(|e| AstRuntimeError::Host(format!("cooldown: {e}")))?;
        Ok(result.is_some())
    }) }
    fn update_count<'a>(&'a mut self, channel: &'a str, name: &'a str, count: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async move {
        let result = self.commands.update_command_in_db(channel, name, mongodb::bson::doc! { "count": count }).await;
        if result.error { return Err(AstRuntimeError::Host(result.message)); } Ok(())
    }) }
    fn keyword_plan<'a>(&'a mut self, channel: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> { Box::pin(async move {
        match self.directory.account_by_id(channel).await { Ok(account) => Ok(Some(account.metadata.plan_tier)), Err(DirectoryError::Missing) => Ok(None), Err(e) => Err(AstRuntimeError::Host(e.to_string())) }
    }) }
    fn keyword_state<'a>(&'a mut self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<(bool, f64)>, AstRuntimeError>> { Box::pin(async move {
        // Fresh mutable state, read only after the cooldown gate is won. The
        // cached keyword body holds configuration, never the counter.
        let reader = crate::utils::ast_runtime::keyword_state::KeywordStateReader::from_collection(
            self.commands.repository().collection().clone(),
            self.keywords,
        );
        match crate::utils::ast_runtime::keyword_state::as_command_store_state(reader.keyword_state(channel, id).await) {
            Ok(state) => Ok(state),
            Err(crate::utils::ast_runtime::keyword_state::KeywordStateError::IdentifierUnresolved { .. }) => {
                Err(AstRuntimeError::Unsupported("keyword command requires a string ObjectId".into()))
            }
            Err(error) => Err(AstRuntimeError::Host(error.to_string())),
        }
    }) }
    fn update_keyword_count<'a>(&'a mut self, channel: &'a str, id: &'a str, count: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async move {
        self.keywords.save_count(channel, id, count).await.map_err(|e| AstRuntimeError::Host(e.to_string()))
    }) }
}
fn json_number(value: Option<&JsonValue>) -> f64 {
    match value {
        None | Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(v)) => if *v { 1.0 } else { 0.0 },
        Some(JsonValue::Number(v)) => *v,
        Some(JsonValue::String(v)) => crate::utils::ast_evaluator::to_number(&JsValue::String(crate::utils::ast_evaluator::JsString::from_units(v.units().to_vec()))),
        Some(JsonValue::Array(_) | JsonValue::Object(_)) => f64::NAN,
    }
}
fn js_json(value: &JsValue) -> Option<serde_json::Value> {
    let s = json_stringify(value).ok()??.to_utf8().ok()?;
    serde_json::from_str(&s).ok()
}
fn string(value: &JsValue) -> String { match value { JsValue::String(s) => s.to_utf8().unwrap_or_default(), _ => String::new() } }
fn failure(message: impl Into<String>, status: u16, kind: &str) -> CommandExecutionResult { CommandExecutionResult { error: true, message: message.into(), status: Some(status), type_name: kind.into(), command_references: vec![] } }
/// Execute a reference using the same parser and application service as direct calls.
pub fn execute_command<'a, S: CommandStore + 'a, P: AstBodyParser + 'a>(store: &'a mut S, parser: &'a mut P, request: &'a CommandReference) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
    Box::pin(async move {
        let found = store.lookup(&request.channel_id, &request.command_name).await?;
        let raw = match found.command { Some(c) if !found.error => c, _ => return Ok(failure(found.message, found.status, "command_not_found")) };
        execute_command_body(store, parser, request, raw).await
    })
}

/// Execute an already-resolved command body, including all normal gates and writes.
pub fn execute_command_with_body<'a, S: CommandStore + 'a, P: AstBodyParser + 'a>(store: &'a mut S, parser: &'a mut P, request: &'a CommandReference, raw: JsonValue) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
    Box::pin(execute_command_body(store, parser, request, raw))
}

async fn execute_command_body<'a, S: CommandStore + 'a, P: AstBodyParser + 'a>(store: &'a mut S, parser: &'a mut P, request: &'a CommandReference, raw: JsonValue) -> Result<CommandExecutionResult, AstRuntimeError> {
        // The handoff seam: the body and the reference are in hand, and no gate
        // has run yet. This is where the TypeScript calls
        // `executeCustomCommand`, so it is where an observer sees the same
        // facts the source's recorder sees.
        store.handoff(request, &raw);
        let command: serde_json::Value = serde_json::from_str(&raw.to_json_string()).map_err(|e| AstRuntimeError::Host(format!("command JSON conversion: {e}")))?;
        if !js_truthy(command.get("enabled")) { return Ok(failure("Command is disabled", 400, "command_disabled")); }
        let origin = string(&request.authorization.get("origin"));
        let identity = js_json(&request.authorization.get("identity"));
        let allowed = match origin.as_str() { "authored" => true, "chat" | "llm" => command_allowed(Some(&command), &parse_user_identity(identity.as_ref(), 1.0)), _ => false };
        if !allowed { return Ok(failure("You do not have permission to use this command", 403, "permission_denied")); }
        let keyword = command.get("activation").and_then(|v| v.as_str()) == Some("keyword");
        let id = command.get("_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let execution_name = if keyword { format!("keyword:{}", id.ok_or_else(|| AstRuntimeError::Unsupported("keyword command requires a string ObjectId".into()))?) } else { request.command_name.to_lowercase() };
        let configured = json_number(raw.get("cooldown"));
        let plan = if keyword { store.keyword_plan(&request.channel_id).await? } else { None };
        let cooldown = execution_cooldown(configured, keyword, plan.as_deref());
        if cooldown.is_finite() && cooldown > 0.0 {
            let millis = (cooldown * 1000.0).ceil();
            if millis > u64::MAX as f64 { return Err(AstRuntimeError::Rejected("command cooldown exceeds supported duration".into())); }
            let key = cooldown_key(&request.channel_id, &execution_name);
            if !store.acquire(&key, millis as u64).await? { return Ok(failure("Command is on cooldown", 429, "command_cooldown")); }
        }
        let count = if keyword { match store.keyword_state(&request.channel_id, id.unwrap_or_default()).await? { Some((true, count)) => count, _ => return Ok(failure("Keyword is disabled or deleted", 400, "command_disabled")) } } else { json_number(raw.get("count")) };
        let config_id = id.unwrap_or(&execution_name);
        let effect = if origin == "llm" { None } else { scope_ast_effect_context(request.effect_context.as_ref(), &request.channel_id, &format!("command:{config_id}")) };
        let scope = if keyword { execution_name.clone() } else { command.get("cmd").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&request.command_name).to_owned() };
        let aliases = command.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| vec![s.to_owned()]).unwrap_or_default();
        let argument = request.argument.to_utf8().map_err(|e| AstRuntimeError::Evaluation(e.to_string()))?;
        let result = parser.parse(command.get("message").and_then(|v| v.as_str()).unwrap_or(""), SpecialParserContext { channel_id: request.channel_id.clone(), effect_context: effect, command_reference_state: Some(request.state.clone()), scope_type: Some("command".into()), scope_name: Some(scope), scope_aliases: aliases, event_data: Some(request.event_data.clone()), argument: Some(argument), literal_arguments: true, count: Some(count), user_level: Some(BROADCASTER_USER_LEVEL), ..Default::default() }).await?;
        if result.count_modified { if keyword { store.update_keyword_count(&request.channel_id, id.unwrap_or_default(), result.count).await?; } else { store.update_count(&request.channel_id, &request.command_name, result.count).await?; } }
        Ok(CommandExecutionResult { error: false, message: result.parsed_text, status: Some(200), type_name: "success".into(), command_references: result.command_references })
}
pub struct CommandExecutor<S, P> { pub store: S, pub parser: P }
impl<S: CommandStore, P: AstBodyParser> CommandRunner for CommandExecutor<S, P> {
    fn execute<'a>(&'a mut self, request: &'a CommandReference) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> { execute_command(&mut self.store, &mut self.parser, request) }
}
