#![cfg(feature = "ast-bot-runtime")]
//! Lane C behavioural fixtures; all collaborators are in memory.
use std::{cell::RefCell, rc::Rc};
use dima_rust::utils::{ast_evaluator::{CommandRefBudget, CommandReference, CommandReferenceState, JsValue}, ast_runtime::{AstBodyParser, AstRuntimeError, BoxFuture, SpecialParserContext, SpecialParserResult, command::{CommandStore, execute_command}, parser::{authored_authorization, normalize_scope_aliases, normalize_scope_name, resolve_argument_placeholders, resolve_authored_user_level}}, commands::CommandGetResponse, lossless_json::{JsonValue, parse_json}};
use std::{sync::Arc, time::Duration};
use dima_rust::utils::{ast_evaluator::{Context, Engine, EvalError, Host, HostFuture, HostRequest}, ast_runtime::{AstScope, ScopedAstHost, parser::parse_special_commands}, twitch::AccessToken, twitch_streamers::{CachedStreamer, DirectoryCache, DirectoryConfig, DirectoryError, DirectoryFuture, DirectorySnapshot, IdPage, MetadataPage, MetadataStore, StreamerAccount, StreamerCredentials, StreamerMetadata, TwitchStreamers}, twitch_tokens::{CachedAccount, SystemTokenClock}};

struct Unused;
fn unused<'a, T: 'a>() -> DirectoryFuture<'a, T> { Box::pin(async { Err(DirectoryError::Missing) }) }
impl MetadataStore for Unused {
    fn account<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>> { unused() }
    fn page<'a>(&'a self, _: Option<&'a str>, _: usize) -> DirectoryFuture<'a, MetadataPage> { unused() }
}
impl DirectoryCache for Unused {
    fn revision(&self) -> DirectoryFuture<'_, String> { unused() }
    fn observe<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, DirectorySnapshot> { unused() }
    fn read_accounts<'a>(&'a self, _: &'a [String]) -> DirectoryFuture<'a, Vec<CachedStreamer>> { unused() }
    fn publish<'a>(&'a self, _: &'a StreamerMetadata, _: &'a DirectorySnapshot, _: Option<&'a str>) -> DirectoryFuture<'a, String> { unused() }
    fn evict<'a>(&'a self, _: &'a str, _: &'a DirectorySnapshot, _: Option<&'a str>) -> DirectoryFuture<'a, bool> { unused() }
    fn ids<'a>(&'a self, _: u64, _: usize) -> DirectoryFuture<'a, IdPage> { unused() }
    fn hash_ids<'a>(&'a self, _: u64, _: usize) -> DirectoryFuture<'a, IdPage> { unused() }
    fn validate<'a>(&'a self, _: &'a str, _: &'a [(String, String)]) -> DirectoryFuture<'a, bool> { unused() }
    fn validate_ids<'a>(&'a self, _: &'a str, _: &'a [String]) -> DirectoryFuture<'a, bool> { unused() }
    fn validate_accounts<'a>(&'a self, _: &'a str, _: &'a [StreamerAccount]) -> DirectoryFuture<'a, bool> { unused() }
    fn acquire_lease<'a>(&'a self, _: &'a str, _: Duration) -> DirectoryFuture<'a, bool> { unused() }
    fn release_lease<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, ()> { unused() }
    fn kick_credentials<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, Option<CachedAccount>> { unused() }
}
impl StreamerCredentials for Unused {
    fn snapshot<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, CachedAccount> { unused() }
    fn token<'a>(&'a self, _: &'a str) -> DirectoryFuture<'a, AccessToken> { unused() }
}
impl Host for Unused {
    fn execute<'a>(&'a mut self, _: HostRequest, _: Context) -> HostFuture<'a> { Box::pin(async { Err(EvalError::new("unexpected host call")) }) }
    fn random(&mut self) -> Result<f64, EvalError> { Err(EvalError::new("unexpected random call")) }
}
impl ScopedAstHost for Unused { fn set_scope(&mut self, _: AstScope) {} }

#[tokio::test]
async fn parser_renders_placeholder_error_and_preserves_count() {
    let directory = TwitchStreamers::new(Arc::new(Unused), Arc::new(Unused), Arc::new(Unused), Arc::new(SystemTokenClock::default()), DirectoryConfig::default());
    let Ok(directory) = directory else { panic!("invalid directory fixture") };
    let engine = Engine::default();
    let mut host = Unused;
    let result = parse_special_commands(&engine, &mut host, &directory, "&t &p1", SpecialParserContext { count: Some(17.0), argument: Some("one".into()), ..Default::default() }).await;
    assert!(matches!(result, Ok(result) if result.parsed_text == "[Parser error: cannot create new &pN after &t]" && result.count == 17.0 && !result.count_modified));
}

struct Store { command: JsonValue }
impl CommandStore for Store {
    fn lookup<'a>(&'a mut self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<CommandGetResponse, AstRuntimeError>> { Box::pin(async move { Ok(CommandGetResponse { error: false, command: Some(self.command.clone()), message: String::new(), status: 200, type_name: "success".into() }) }) }
    fn acquire<'a>(&'a mut self, _: &'a str, _: u64) -> BoxFuture<'a, Result<bool, AstRuntimeError>> { Box::pin(async { Ok(true) }) }
    fn update_count<'a>(&'a mut self, _: &'a str, _: &'a str, _: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async { Ok(()) }) }
    fn keyword_plan<'a>(&'a mut self, _: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> { Box::pin(async { Ok(None) }) }
    fn keyword_state<'a>(&'a mut self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Option<(bool, f64)>, AstRuntimeError>> { Box::pin(async { Ok(Some((true, 3.0))) }) }
    fn update_keyword_count<'a>(&'a mut self, _: &'a str, _: &'a str, _: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async { Ok(()) }) }
}
struct Parser { references: Vec<CommandReference> }
impl AstBodyParser for Parser {
    fn parse<'a>(&'a mut self, _: &'a str, context: SpecialParserContext) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> { Box::pin(async move { assert_eq!(context.user_level, Some(10.0)); Ok(SpecialParserResult { parsed_text: "rendered".into(), command_references: self.references.clone(), ..Default::default() }) }) }
}
fn reference(origin: &str) -> CommandReference {
    CommandReference { effect_context: None, channel_id: "1".into(), command_name: "hello".into(), argument: "".into(), event_data: JsValue::object(vec![]), authorization: JsValue::object(vec![("origin".into(), JsValue::string(origin)), ("identity".into(), JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]))]), state: CommandReferenceState { visited_commands: vec![], command_ref_depth: 0.0, command_ref_budget: Rc::new(RefCell::new(CommandRefBudget { remaining: 50.0 })), timer_depth: None } }
}
#[test]
fn placeholders_and_scope() {
    assert_eq!(resolve_argument_placeholders("&p1 &p2 &t &p1", "one two  three four", false).map(|v| v.0), Ok("one two three four one".into()));
    assert_eq!(resolve_argument_placeholders("&t &p1", "one", false).err(), Some("cannot create new &pN after &t"));
    assert_eq!(normalize_scope_name("  hello  world "), "hello_world");
    assert_eq!(normalize_scope_name("  "), "default");
    assert_eq!(normalize_scope_aliases(&["same name".into(), "same   name".into(), "".into(), "current".into()], "current"), vec!["same_name"]);
}
#[test]
fn authored_level_uses_real_chatter_and_explicit_override() {
    let event = JsValue::object(vec![("chatter_user_id".into(), JsValue::string("1")), ("badges".into(), JsValue::array(vec![JsValue::object(vec![("set_id".into(), JsValue::string("broadcaster"))])]))]);
    assert_eq!(resolve_authored_user_level(&event, None), 1.0);
    assert_eq!(resolve_authored_user_level(&event, Some(10.0)), 10.0);
    assert_eq!(resolve_authored_user_level(&JsValue::object(vec![]), None), 10.0);
    let level = resolve_authored_user_level(&event, Some(10.0));
    let auth = authored_authorization(level);
    assert!(matches!(auth.get("origin"), JsValue::String(s) if s.to_utf8().ok().as_deref() == Some("authored")));
    let identity = auth.get("identity");
    assert!(matches!(identity.get("level"), JsValue::Number(n) if n == level));
    assert!(matches!(identity.get("tags"), JsValue::Array(tags) if matches!(tags.borrow().as_slice(), [JsValue::String(s)] if s.to_utf8().ok().as_deref() == Some("broadcaster"))));
}
#[tokio::test]
async fn permission_and_nested_references() {
    let Ok(command) = parse_json(r#"{"enabled": true, "userLevel": 7, "message": "body", "cooldown": 0}"#) else { panic!("invalid fixture") };
    let mut store = Store { command };
    let nested = reference("authored");
    let mut parser = Parser { references: vec![nested] };
    let denied = execute_command(&mut store, &mut parser, &reference("chat")).await;
    assert!(matches!(denied, Ok(result) if result.error && result.status == Some(403) && result.message == "You do not have permission to use this command"));
    let allowed = execute_command(&mut store, &mut parser, &reference("authored")).await;
    assert!(matches!(allowed, Ok(result) if !result.error && result.message == "rendered" && result.command_references.len() == 1));
}
