//! Alert expression evaluation and the overlay AST family from `ast.ts` and
//! `utils/ast_parser/functions/overlay.functions.ts`.
//! The entire parsed tree is checked before evaluation, including untaken
//! branches; unsupported operations and overly complex expressions are rejected.

use std::fmt;
use crate::utils::ast_syntax::{AstNode, CompiledProgram, SyntaxEngine, TemplateSegment};
use crate::utils::ast_evaluator::{Context, Engine, EvalError, ExecutionContext, FunctionRegistry, Host, HostFuture, HostRequest, JsString as EvalString, JsValue, js_string};
use crate::utils::{js_string::JsString, lossless_json::{truthy, JsonValue}};
use crate::utils::twitch_streamers::{CallerContext, Platform, TwitchStreamers};
use mongodb::Database;
use std::{sync::Arc, time::Duration};
/// Presentation-only alert functions, matching the source allowlist.
pub const ALERT_FUNCTIONS: [&str; 17] = ["user", "touser", "cheer.amount", "cheer.message", "sub.tier", "sub.months", "gifted.user", "raid.channel", "raid.login", "raid.viewers", "upper", "lower", "title", "capitalize", "trim", "length", "slice"];
/// Template validation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertAstError { /// Public error message.
    pub message: String }
impl fmt::Display for AlertAstError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.message) } }
impl std::error::Error for AlertAstError {}
fn error(message: impl Into<String>) -> AlertAstError { AlertAstError { message: message.into() } }
fn visit(node: &AstNode, depth: usize, nodes: &mut usize) -> Result<(), AlertAstError> {
    *nodes += 1;
    if *nodes > 300 || depth > 20 { return Err(error("Alert expression is too complex")); }
    match node {
        AstNode::Root { children } => for child in children { visit(child, depth + 1, nodes)?; },
        AstNode::Literal { .. } => {},
        AstNode::Function { name, args } => {
            if name.is_empty() || !ALERT_FUNCTIONS.contains(&name.as_str()) { return Err(error(format!("Unsupported alert function: {name}"))); }
            for child in args { visit(child, depth + 1, nodes)?; }
        }
        AstNode::Binary { left, right, .. } => { visit(left, depth + 1, nodes)?; visit(right, depth + 1, nodes)?; }
        AstNode::Unary { argument, .. } => visit(argument, depth + 1, nodes)?,
        AstNode::Ternary { test, consequent, alternate } => { visit(test, depth + 1, nodes)?; visit(consequent, depth + 1, nodes)?; visit(alternate, depth + 1, nodes)?; }
        AstNode::Template { segments } => for segment in segments { if let TemplateSegment::Expr { node } = segment { visit(node, depth + 1, nodes)?; } },
        _ => return Err(error("This AST operation cannot be used in alert text")),
    }
    Ok(())
}
/// Parse and validate alert text through the existing TypeScript-compatible parser.
pub fn parse_template(text: &str) -> Result<CompiledProgram, AlertAstError> {
    if text.encode_utf16().count() > 2000 { return Err(error("Alert text exceeds 2000 characters")); }
    let program = SyntaxEngine::typescript_compatible().parse(text).map_err(|value| error(value.to_string()))?;
    visit(program.root(), 0, &mut 0)?;
    Ok(program)
}
fn value(input: &JsonValue) -> JsValue {
    match input {
        JsonValue::Null => JsValue::Null,
        JsonValue::Bool(value) => JsValue::Boolean(*value),
        JsonValue::Number(value) => JsValue::Number(*value),
        JsonValue::String(value) => JsValue::String(EvalString::from_units(value.units())),
        JsonValue::Array(items) => JsValue::array(items.iter().map(value).collect()),
        JsonValue::Object(fields) => JsValue::object(fields.iter().map(|(key, item)| (EvalString::from_units(key.units()), value(item))).collect()),
    }
}
fn property<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value { JsonValue::Object(fields) => fields.iter().find(|(name, _)| name.as_str() == Some(key)).map(|(_, value)| value), _ => None }
}
struct AlertHost;
impl Host for AlertHost {
    fn execute<'a>(&'a mut self, _: HostRequest, _: Context) -> HostFuture<'a> {
        Box::pin(async { Err(EvalError::new("Unsupported alert operation")) })
    }
    fn random(&mut self) -> Result<f64, EvalError> { Err(EvalError::new("Unsupported alert operation")) }
}
/// Evaluate an authorized alert expression using the existing pure function registry.
pub async fn render_template(text: &str, channel: &str, event: &JsonValue) -> Result<JsString, AlertAstError> {
    let program = parse_template(text)?;
    let display = if property(event, "is_anonymous").is_some_and(truthy) { EvalString::from("Anonymous") } else {
        ["user_name", "user_login", "from_broadcaster_user_name", "from_broadcaster_user_login"]
            .into_iter().find_map(|key| property(event, key).filter(|item| truthy(item)).map(|item| js_string(&value(item))))
            .unwrap_or_else(|| EvalString::from("Viewer"))
    };
    let string_field = |key: &str| property(event, key).filter(|item| truthy(item)).map(|item| js_string(&value(item)).to_utf8().unwrap_or_default()).unwrap_or_default();
    let context = ExecutionContext {
        broadcaster_id: channel.into(), user_id: string_field("user_id"), user_login: string_field("user_login"),
        user_display_name_override: Some(JsValue::String(display.clone())), user_plan: "pro".into(),
        enforce_function_permissions: true, event_data: value(event),
        extra_context: JsValue::object(vec![("userName".into(), JsValue::String(display))]),
        ..Default::default()
    }.into_context();
    let engine = Engine::new(FunctionRegistry::with_pure_builtins());
    let output = engine.evaluate_program(&program, context, &mut AlertHost).await.map_err(|error| AlertAstError { message: error.to_string() })?;
    let rendered = match output.value { JsValue::Null | JsValue::Undefined => EvalString::from(""), value => js_string(&value) };
    Ok(JsString::from_units(rendered.units().iter().take(8000).copied().collect()))
}
/// Render a JavaScript string. A literal made entirely of unpaired surrogates
/// can be preserved without passing it through the UTF-8-only syntax parser.
pub async fn render_js_template(text: &JsString, channel: &str, event: &JsonValue) -> Result<JsString, AlertAstError> {
    if let Some(text) = text.as_str() { return render_template(text, channel, event).await; }
    if text.len() > 2000 { return Err(error("Alert text exceeds 2000 characters")); }
    if text.code_units().all(|unit| (0xd800..=0xdfff).contains(&unit)) { return Ok(text.clone()); }
    Err(error("Invalid UTF-16 template"))
}
/// Render text widgets on a copied alert layout, retaining all other data.
pub async fn render_layout(layout: &JsonValue, channel: &str, event: &JsonValue) -> Result<JsonValue, AlertAstError> {
    let mut result = layout.clone();
    let JsonValue::Object(fields) = &mut result else { return Err(error("Invalid alert layout")) };
    let Some((_, JsonValue::Array(widgets))) = fields.iter_mut().find(|(key, _)| key.as_str() == Some("widgets")) else { return Err(error("Invalid alert widgets")) };
    for widget in widgets {
        if !matches!(property(widget, "kind"), Some(JsonValue::String(kind)) if kind.as_str() == Some("text")) { continue; }
        let raw = match property(widget, "text") { Some(JsonValue::String(text)) => text.clone(), _ => JsString::from("") };
        let rendered = render_js_template(&raw, channel, event).await?;
        if let JsonValue::Object(fields) = widget {
            if let Some((_, value)) = fields.iter_mut().find(|(key, _)| key.as_str() == Some("text")) { *value = JsonValue::String(rendered); }
            else { fields.push(("text".into(), JsonValue::String(rendered))); }
        }
    }
    Ok(result)
}
/// Evaluation context required by the native overlay-control AST family.
pub struct OverlayFunctionContext<'a> {
    /// Broadcaster ID for the originating provider.
    pub broadcaster_id: &'a str,
    /// Originating platform.
    pub platform: &'a str,
    /// User permission level.
    pub user_level: f64,
    /// Whether function permission enforcement is enabled.
    pub enforce_permissions: bool,
}
/// Concrete overlay AST service using the shared owner lookup and Twitch tokens.
pub struct NativeOverlayFamily {
    database: Database,
    directory: Arc<TwitchStreamers>,
    client: reqwest::Client,
    base_url: reqwest::Url,
}
impl NativeOverlayFamily {
    /// Inject application-owned handles and a configured internal API URL.
    pub fn new(database: Database, directory: Arc<TwitchStreamers>, client: reqwest::Client, base_url: reqwest::Url) -> Self {
        Self { database, directory, client, base_url }
    }
    /// Invoke one of the twelve overlay action/platform functions.
    pub async fn call(&self, name: &str, argument_count: usize, context: &OverlayFunctionContext<'_>) -> String {
        let Some(rest) = name.strip_prefix("overlay.") else { return "Error: Unsupported overlay function".into() };
        let mut segments = rest.split('.');
        let action = segments.next().unwrap_or_default();
        let platform = segments.next().unwrap_or("all");
        if segments.next().is_some() || !super::controls::OVERLAY_ACTIONS.contains(&action) || !["all", "twitch", "kick"].contains(&platform) { return "Error: Unsupported overlay function".into(); }
        if argument_count != 0 { return format!("Usage: $({name})"); }
        if context.enforce_permissions && context.user_level < 7.0 { return "Error: Moderator permission required".into(); }
        if !["twitch", "kick"].contains(&context.platform) { return "Error: Unsupported originating platform".into(); }
        let users = crate::schemas::users::schema().native_collection(&self.database);
        let owner = match users.find_one(mongodb::bson::doc! { "accounts": { "$elemMatch": { "type": context.platform, "id": context.broadcaster_id } } }).await {
            Ok(Some(owner)) => owner,
            Ok(None) => return "Error: Overlay owner account unavailable".into(),
            Err(_) => return "Error: Overlay controls are temporarily unavailable".into(),
        };
        let channel = if context.platform == "twitch" { Some(context.broadcaster_id.to_owned()) } else {
            owner.get_array("accounts").ok().and_then(|accounts| accounts.iter().filter_map(|value| value.as_document()).find(|value| value.get_str("type").ok() == Some("twitch"))).and_then(|account| account.get_str("id").ok()).map(str::to_owned)
        };
        let Some(channel) = channel else { return "Error: No linked Global Overlay Studio account".into() };
        let token = match self.directory.account_token(&channel, Platform::Twitch, &CallerContext::new("overlay.functions")).await {
            Ok(token) => token,
            Err(_) => return "Error: Reconnect the overlay owner’s account in the dashboard".into(),
        };
        let mut url = self.base_url.clone();
        { let Ok(mut path) = url.path_segments_mut() else { return "Error: Overlay controls are temporarily unavailable".into() }; path.pop_if_empty().push("overlay-studio").push(&channel).push("queue"); }
        let response = match self.client.post(url).bearer_auth(token.expose_secret()).json(&serde_json::json!({ "action": action, "platform": platform })).timeout(Duration::from_secs(10)).send().await {
            Ok(response) => response,
            Err(_) => return "Error: Overlay controls are temporarily unavailable".into(),
        };
        let success = response.status().is_success();
        let result: serde_json::Value = match response.json().await { Ok(result) => result, Err(_) => return "Error: Overlay controls are temporarily unavailable".into() };
        if success { String::new() } else { format!("Error: {}", result.get("message").and_then(serde_json::Value::as_str).filter(|message| !message.is_empty()).unwrap_or("Overlay control failed")) }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_long_text_before_parsing() { assert!(parse_template(&"x".repeat(2001)).is_err()); }
    #[test]
    fn tree_validation_rejects_unsupported_functions_even_in_branches() {
        let node = AstNode::Function { name: "unregistered".into(), args: vec![] };
        assert!(visit(&node, 0, &mut 0).is_err());
    }
    #[tokio::test]
    async fn renders_a_safe_alert_without_mutating_other_widgets() {
        let event = JsonValue::Object(vec![("user_name".into(), JsonValue::String("Luna".into()))]);
        let layout = JsonValue::Object(vec![("widgets".into(), JsonValue::Array(vec![JsonValue::Object(vec![("kind".into(), JsonValue::String("text".into())), ("text".into(), JsonValue::String("$(user)".into()))]), JsonValue::Object(vec![("kind".into(), JsonValue::String("image".into()))])]))]);
        let result = render_layout(&layout, "1", &event).await.expect("safe alert");
        let JsonValue::Object(fields) = result else { panic!("layout object") };
        let Some(JsonValue::Array(widgets)) = fields.iter().find(|(key, _)| key.as_str() == Some("widgets")).map(|(_, value)| value) else { panic!("widgets") };
        assert_eq!(property(&widgets[0], "text"), Some(&JsonValue::String("Luna".into())));
        assert_eq!(property(&widgets[1], "kind"), Some(&JsonValue::String("image".into())));
    }
    #[tokio::test]
    async fn preserves_a_standalone_unpaired_surrogate_literal() {
        let literal = JsString::from_units(vec![0xd800]);
        assert_eq!(render_js_template(&literal, "1", &JsonValue::Null).await.expect("literal"), literal);
    }
}
