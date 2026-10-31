# AST bot runtime: parser and command lane (authoring draft)

Wave 1 authoring only. No build, formatter, test, container, network, or production execution was performed. Integration execution lease and review are pending; this lane is not validated or migration-complete.

## Sources and reuse

The parser follows `dimabot/src/handlers/special_parser.handler.ts` and `special_parser.userlevel.ts`; command ordering and response shapes follow `dimabot/src/handlers/commands.handler.ts`; opaque capability state follows `dimabot/src/utils/ast_parser/effects.ts`. Reference data comes from `dimabot/src/utils/ast_parser/types.ts`. The parser uses the native `ast_evaluator::Engine`, `ExecutionContext`, and `ast_syntax::unescape_rendered_text`. Commands use `Commands::get_command_from_db`, `Commands::update_command_in_db`, and `permissions::command_allowed`; Redis SET NX PX mirrors the request-time cooldown in the source. `command_cooldown::write_command_with_cooldown` is a *configuration write* policy, not the execution lock; it cannot be substituted for the latter. `effects` reuses `js_date::parse_date` for V8 Date.parse behavior. Behavioral fixtures are in `dimabot/tests/ast_command_execution.rs`.

## Public API

- `parse_special_commands<'a, H: ScopedAstHost + 'a>(engine: &'a Engine, host: &'a mut H, directory: &'a TwitchStreamers, source: &'a str, context: SpecialParserContext) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>>`.
- `SpecialParser<'a, H> { engine: &'a Engine, host: &'a mut H, directory: &'a TwitchStreamers }` implements `AstBodyParser`.
- `execute_command<'a, S: CommandStore + 'a, P: AstBodyParser + 'a>(store: &'a mut S, parser: &'a mut P, request: &'a CommandReference) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>>`; `CommandExecutor<S, P>` implements `CommandRunner`. `NativeCommandStore<'a> { commands: &'a Commands, redis: ConnectionManager, keywords: &'a NativeKeywordCache, directory: &'a TwitchStreamers }` implements `CommandStore` and exposes `keyword_body<'a>(&'a self, channel: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<JsonValue>, AstRuntimeError>>`. Its non-Send trait futures expose `lookup(channel, name) -> Result<CommandGetResponse, AstRuntimeError>`, `acquire(key, milliseconds) -> Result<bool, AstRuntimeError>`, `update_count(channel, name, count) -> Result<(), AstRuntimeError>`, `keyword_plan(channel) -> Result<Option<String>, AstRuntimeError>`, `keyword_state(channel, id) -> Result<Option<(bool, f64)>, AstRuntimeError>`, and `update_keyword_count(channel, id, count) -> Result<(), AstRuntimeError>`.
- `resolve_argument_placeholders(&str, &str, bool) -> Result<(String, Vec<(String, String)>), &'static str>`; `normalize_scope_name(&str) -> String`; `normalize_scope_aliases(&[String], &str) -> Vec<String>`; `resolve_authored_user_level(&JsValue, Option<f64>) -> f64`; `authored_authorization(f64) -> JsValue`.
- `create_twitch_effect_context(&str, EffectOrigin, EffectActor) -> Option<EffectToken>`; `scope_ast_effect_context(Option<&EffectToken>, &str, &str) -> Option<EffectToken>`; `fork_ast_effect_context(Option<&EffectToken>) -> Option<EffectToken>`; `next_pet_action(Option<&EffectToken>, &str) -> Option<PetAction>`.

## Gaps and integration risks

Keyword execution uses the existing owner-plan minimum, atomic gate, and `NativeKeywordCache::save_count`, but the native `CommandStore::keyword_state` returns Unsupported: the missing adapter is a direct MongoDB read of `count` and `enabled` by channel ID, keyword ObjectId and activation after winning the cooldown. `NativeKeywordCache::body` is cached configuration and cannot replace this read. Keyword execution also requires a caller supplying the matched keyword body; the current public runner looks up a command by name. These gaps prevent a claim of keyword coverage. The directory returns typed failures, unlike the TypeScript nullable lookup: missing accounts fall back to free while other directory errors propagate. `Commands` serializes Mongo ObjectIds and the command effect config ID needs integration verification for its actual JSON shape. Native AST function families and the other runtime adapters still determine overall migration completeness. No live caller adoption or deployment is included. Rust compile and runtime compatibility remain unverified; integration execution lease is pending.

## Central integration patch (not applied)

`dimabot/Cargo.toml`:

```toml
ast-bot-runtime = ["ast-evaluator", "ast-pure-functions", "ast-blocks", "ast-syntax", "commands-service", "keyword-store", "twitch-functions", "twitch-client", "twitch-streamers", "twitch-tokens", "permissions", "redis-application-runtime", "logger-redis", "application-schemas", "timer-policy", "mongo", "redis", "http-client", "dep:tokio", "dep:serde", "dep:serde_json", "dep:uuid", "dep:sha2"]
```

`dimabot/src/utils/mod.rs`:

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_parser/runtime.rs"]
pub mod ast_runtime;
```
