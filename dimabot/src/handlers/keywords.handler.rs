//! Keyword chat ingress, ported from `keywords.handler.ts`.
//! Construction and module loading perform no I/O.
use std::{cell::RefCell, rc::Rc, sync::Arc};

use crate::utils::{
    ast_evaluator::{CommandRefBudget, CommandReference, CommandReferenceState, EffectToken, JsValue},
    ast_runtime::{AstBodyParser, AstMessage, AstRuntimeError, BoxFuture, ChatSender, CommandExecutionResult, CommandRunner,
        command::{execute_command, execute_command_with_body, CommandStore}, delivery::{deliver_ast_message, DeliverySeams}},
    keywords::{keyword_matches, match_keywords, normalize_keyword, KeywordEntry, KeywordIndex, KeywordMatchMode, native::NativeKeywordCache},
    logger::Logger,
    lossless_json::parse_json,
};

/// Ingress cache seam; the production implementation delegates to the native cache.
pub trait KeywordIngressCache {
    fn index<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Arc<KeywordIndex>, AstRuntimeError>>;
    fn body<'a>(&'a self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<serde_json::Value>, AstRuntimeError>>;
}
impl KeywordIngressCache for NativeKeywordCache {
    fn index<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Arc<KeywordIndex>, AstRuntimeError>> {
        Box::pin(async move { self.index.get(channel).await.map_err(|e| AstRuntimeError::Host(e.to_string())) })
    }
    fn body<'a>(&'a self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<serde_json::Value>, AstRuntimeError>> {
        Box::pin(async move { NativeKeywordCache::body(self, channel, id).await.map_err(|e| AstRuntimeError::Host(e.to_string())) })
    }
}

/// The original event is retained intact for the parser; text and chatter ID
/// are extracted by the caller from that same event.
pub struct KeywordChatEvent<'a> {
    pub chatter_user_id: &'a str,
    pub text: &'a str,
    pub event_data: JsValue,
}

struct Runner<'a, S, P> { store: &'a mut S, parser: &'a mut P }
impl<S: CommandStore, P: AstBodyParser> CommandRunner for Runner<'_, S, P> {
    fn execute<'a>(&'a mut self, request: &'a CommandReference) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        execute_command(self.store, self.parser, request)
    }
}

/// Matches in index order, resolves each body by ID, executes, and delivers.
/// `bot_account_id` is the configured Twitch bot account ID; `identity` and
/// `event.event_data` are the original caller values.
pub async fn handle_keywords<C: KeywordIngressCache, S: CommandStore, P: AstBodyParser, T: ChatSender>(
    channel_id: &str, event: &KeywordChatEvent<'_>, bot_account_id: &str,
    identity: &JsValue, effect_context: Option<EffectToken>, cache: &C,
    store: &mut S, parser: &mut P, sender: &mut T, logger: Option<&Arc<Logger>>,
) -> Result<(), AstRuntimeError> {
    if event.chatter_user_id == bot_account_id { return Ok(()); }
    let index = cache.index(channel_id).await?;
    for matched in match_keywords(&index, event.text) {
        let Some(body) = cache.body(channel_id, &matched.id).await? else { continue };
        // The source writes `if (!keyword.enabled)`, so a non-boolean value is
        // judged by JavaScript's truthiness, not by a strict boolean check.
        if !crate::utils::ast_runtime::command::js_truthy(body.get("enabled")) { continue; }
        let Some(cmd) = body.get("cmd").and_then(|v| v.as_str()) else { continue };
        let mode = match body.get("keywordSettings").and_then(|v| v.get("matchMode")) {
            None | Some(serde_json::Value::Null) => KeywordMatchMode::Start,
            Some(v) if v.as_str() == Some("start") => KeywordMatchMode::Start,
            Some(v) if v.as_str() == Some("exact") => KeywordMatchMode::Exact,
            _ => KeywordMatchMode::Anywhere,
        };
        if !keyword_matches(event.text, &KeywordEntry { id: matched.id.clone(), text: normalize_keyword(cmd), match_mode: mode }) { continue; }
        let request = CommandReference {
            effect_context: effect_context.clone(), channel_id: channel_id.to_owned(), command_name: cmd.to_owned(),
            argument: event.text.into(), event_data: event.event_data.clone(),
            authorization: JsValue::object(vec![("origin".into(), JsValue::string("chat")), ("identity".into(), identity.clone())]),
            state: CommandReferenceState { visited_commands: vec![format!("{channel_id}:keyword:{}", matched.id)], command_ref_depth: 0.0,
                command_ref_budget: Rc::new(RefCell::new(CommandRefBudget { remaining: 50.0 })), timer_depth: None },
        };
        let raw = parse_json(&body.to_string()).map_err(AstRuntimeError::Host)?;
        let result = execute_command_with_body(store, parser, &request, raw).await?;
        if !result.error {
            let mut message = AstMessage { parsed_text: result.message, command_references: result.command_references };
            let mut runner = Runner { store: &mut *store, parser: &mut *parser };
            deliver_ast_message(channel_id, &mut message, true, DeliverySeams { sender: &mut *sender, runner: &mut runner, logger }).await?;
        }
    }
    Ok(())
}
