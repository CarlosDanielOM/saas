//! Special-command template preparation and native AST rendering.
use std::{cell::RefCell, collections::HashSet, rc::Rc};
use crate::utils::ast_evaluator::{Engine, ExecutionContext, JsValue, is_truthy, js_string, to_number};
use crate::utils::twitch_streamers::TwitchStreamers;
use super::{AstBodyParser, AstRuntimeError, AstScope, BoxFuture, ScopedAstHost, SpecialParserContext, SpecialParserResult};

pub fn normalize_scope_name(name: &str) -> String {
    let result = name.split_whitespace().collect::<Vec<_>>().join("_");
    if result.is_empty() { "default".into() } else { result }
}
pub fn normalize_scope_aliases(names: &[String], resolved: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    names.iter().map(|n| normalize_scope_name(n)).filter(|n| n != "default" && n != resolved && seen.insert(n.clone())).collect()
}
/// Resolves placeholders before compiling; literal bindings prevent AST injection.
pub fn resolve_argument_placeholders(text: &str, argument: &str, literal: bool) -> Result<(String, Vec<(String, String)>), &'static str> {
    let args: Vec<&str> = argument.split_whitespace().collect();
    let mut positions = HashSet::new();
    let mut max = 0usize;
    let mut tail: Option<String> = None;
    let mut vars = Vec::new();
    let prefix = format!("cmd_arg_{}", uuid::Uuid::new_v4().simple());
    let mut out = String::new();
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let mut consumed = 0;
        let mut value = None;
        if let Some(after) = rest.strip_prefix("&p") {
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 {
                consumed = 2 + digits;
                let position = after[..digits].parse::<usize>().unwrap_or(0);
                if position == 0 { value = Some(String::new()); }
                else {
                    if tail.is_some() && !positions.contains(&position) { return Err("cannot create new &pN after &t"); }
                    positions.insert(position);
                    max = max.max(position);
                    value = Some(args.get(position - 1).copied().unwrap_or("").to_owned());
                }
            }
        } else if let Some(after) = rest.strip_prefix("&t") {
            if !after.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                consumed = 2;
                let saved = tail.get_or_insert_with(|| args.iter().skip(max).copied().collect::<Vec<_>>().join(" "));
                value = Some(saved.clone());
            }
        }
        if let Some(value) = value {
            if literal {
                let name = format!("{prefix}_{}", vars.len());
                out.push_str(&format!("%({name})"));
                vars.push((name, value));
            } else { out.push_str(&value); }
            i += consumed;
        } else if let Some(c) = rest.chars().next() { out.push(c); i += c.len_utf8(); } else { break; }
    }
    Ok((out, vars))
}
fn text(v: &JsValue) -> String { js_string(v).to_utf8().unwrap_or_default() }
fn first(data: &JsValue, keys: &[&str]) -> String {
    keys.iter().map(|k| data.get(k)).find(is_truthy).map(|v| text(&v)).unwrap_or_default()
}
pub fn resolve_authored_user_level(data: &JsValue, supplied: Option<f64>) -> f64 {
    let mut inferred: f64 = 1.0;
    if let JsValue::Array(badges) = data.get("badges") {
        for badge in badges.borrow().iter() {
            let id = first(badge, &["set_id", "id"]).to_lowercase();
            if ["moderator", "lead_mod", "lead_moderator", "mod"].contains(&id.as_str()) { inferred = 7.0; break; }
        }
    }
    if let Some(level) = supplied.filter(|n| n.is_finite()) { return level.max(inferred); }
    if ["chatter_user_id", "chatter_user_login", "chatter_user_name"].iter().any(|k| is_truthy(&data.get(k))) { inferred } else { 10.0 }
}
/// Construct the explicit authority passed to authored command references.
pub fn authored_authorization(level: f64) -> JsValue {
    JsValue::object(vec![("origin".into(), JsValue::string("authored")), ("identity".into(), JsValue::object(vec![("level".into(), JsValue::Number(level)), ("tags".into(), JsValue::array(if level >= 10.0 { vec![JsValue::string("broadcaster")] } else { vec![] }))]))])
}
/// Engine, host and directory are borrowed for the returned non-Send future.
pub fn parse_special_commands<'a, H: ScopedAstHost + 'a>(engine: &'a Engine, host: &'a mut H, directory: &'a TwitchStreamers, source: &'a str, context: SpecialParserContext) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> {
    Box::pin(async move {
        let (source, literal) = match resolve_argument_placeholders(source, context.argument.as_deref().unwrap_or(""), context.literal_arguments) {
            Ok(v) => v,
            Err(e) => return Ok(SpecialParserResult { parsed_text: format!("[Parser error: {e}]"), count: context.count.unwrap_or(0.0), ..Default::default() }),
        };
        let account = match directory.account_by_id(&context.channel_id).await {
            Ok(a) => Some(a.metadata),
            Err(crate::utils::twitch_streamers::DirectoryError::Missing) => None,
            Err(e) => return Err(AstRuntimeError::Host(e.to_string())),
        };
        let data = context.event_data.unwrap_or_else(|| JsValue::object(vec![]));
        let eventsub = context.eventsub_data.unwrap_or_else(|| JsValue::object(vec![]));
        let user_id = first(&data, &["chatter_user_id", "user_id", "from_broadcaster_user_id", "moderator_user_id"]);
        let user_login = first(&data, &["chatter_user_login", "user_login", "from_broadcaster_user_login", "moderator_user_login"]);
        let user_name = first(&data, &["chatter_user_name", "user_name", "from_broadcaster_user_name", "moderator_user_name"]);
        let level = resolve_authored_user_level(&data, context.user_level);
        let scope = context.scope_name.filter(|s| !s.is_empty()).unwrap_or_else(|| { let name = first(&eventsub, &["name"]); if name.is_empty() { first(&data.get("reward"), &["title"]) } else { name } });
        let scope = normalize_scope_name(&scope);
        let extra = JsValue::object(vec![]);
        for (key, value) in [("userName", user_name.clone()), ("userLogin", user_login.clone()), ("userID", user_id.clone()), ("broadcasterName", first(&data, &["broadcaster_user_name", "to_broadcaster_user_name"])), ("broadcasterLogin", first(&data, &["broadcaster_user_login", "to_broadcaster_user_login"])), ("broadcasterID", first(&data, &["broadcaster_user_id", "to_broadcaster_user_id"]))] { if !value.is_empty() { extra.set(key, JsValue::string(value)); } }
        for (key, value) in [("bits", { let b = data.get("bits"); if is_truthy(&b) { b } else { data.get("cheer").get("bits") } }), ("viewers", data.get("viewers"))] { if !matches!(value, JsValue::Undefined) { extra.set(key, JsValue::Number(to_number(&value))); } }
        if let Some(JsValue::Object(fields)) = context.extra_context { for (key, value) in fields.borrow().iter() { extra.set(key.clone(), value.clone()); } }
        host.set_scope(AstScope { channel_id: context.channel_id.clone(), user_id: user_id.clone(), user_login: user_login.clone() });
        let mut execution = ExecutionContext::default();
        execution.broadcaster_id = context.channel_id;
        execution.user_id = user_id; execution.user_login = user_login; execution.user_display_name = user_name;
        execution.user_plan = context.user_plan.filter(|s| !s.is_empty()).or_else(|| account.as_ref().map(|a| a.plan_tier.clone())).unwrap_or_else(|| "free".into());
        execution.user_level = level; execution.enforce_function_permissions = false;
        execution.authorization = authored_authorization(level);
        execution.argument = context.argument.map(Into::into); execution.count = context.count.unwrap_or(0.0);
        execution.event_data = data; execution.eventsub_data = eventsub; execution.extra_context = extra;
        execution.streamer = account.map(|a| JsValue::object(vec![("id".into(), JsValue::string(a.id)), ("name".into(), JsValue::string(a.name))])).unwrap_or(JsValue::Null);
        execution.scope_type = context.scope_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "command".into());
        execution.scope_aliases = Rc::new(RefCell::new(normalize_scope_aliases(&context.scope_aliases, &scope).iter().map(JsValue::string).collect()));
        execution.scope_name = scope.clone(); execution.command_name = scope; execution.effect_context = context.effect_context;
        if let Some(state) = context.command_reference_state { execution.visited_commands = Some(Rc::new(RefCell::new(state.visited_commands))); execution.command_ref_depth = Some(state.command_ref_depth); execution.command_ref_budget = state.command_ref_budget; execution.timer_depth = state.timer_depth; }
        for (name, value) in context.variables.into_iter().chain(literal) { execution.variables.borrow_mut().insert(name, JsValue::string(value)); }
        let compiled = engine.compile_template(&source).map_err(|e| AstRuntimeError::Syntax(e.message))?;
        let result = engine.render(&compiled, execution.into_context(), host).await.map_err(|e| AstRuntimeError::Evaluation(e.to_string()))?;
        let rendered = result.text.to_utf8().map_err(|e| AstRuntimeError::Evaluation(e.to_string()))?;
        let result_context = result.context.borrow();
        let references = result_context.command_references.borrow().clone();
        Ok(SpecialParserResult { parsed_text: crate::utils::ast_syntax::unescape_rendered_text(&rendered), count: result_context.count, count_modified: result_context.count_modified.unwrap_or(false), command_references: references })
    })
}
pub struct SpecialParser<'a, H> { pub engine: &'a Engine, pub host: &'a mut H, pub directory: &'a TwitchStreamers }
impl<H: ScopedAstHost> AstBodyParser for SpecialParser<'_, H> {
    fn parse<'a>(&'a mut self, text: &'a str, context: SpecialParserContext) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> { parse_special_commands(self.engine, self.host, self.directory, text, context) }
}
