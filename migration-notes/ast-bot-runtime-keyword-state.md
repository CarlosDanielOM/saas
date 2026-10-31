# AST bot runtime: fresh keyword state (lane C2)

Wave 1 authoring only. No `cargo`, formatter, test runner, container, network, or production execution was performed. Integration execution lease and review are pending. This lane is not validated and is not migration-complete.

## What this lane implemented

The native command executor already ports `executeCustomCommand`, but `NativeCommandStore::keyword_state` still returns `AstRuntimeError::Unsupported("missing native fresh keyword count and enabled MongoDB read adapter")`. This lane adds that adapter.

The adapter is a fresh MongoDB `find_one` of mutable keyword state. It is not the keyword body cache and not the keyword index. Those hold configuration. The TypeScript source reads `count` and `enabled` only after the cooldown gate is won, and this adapter does not acquire that gate. `runtime::command::execute_command` already calls `CommandStore::keyword_state` at that point; the integration patch below is what makes that call real.

A missing document and a disabled keyword are distinct typed outcomes (`NotFound` and `Disabled`). Neither carries `count`. The executor already maps any non-`Some((true, count))` result to the source failure `Keyword is disabled or deleted`, status 400, type `command_disabled`. Identifier and Mongo failures stay errors so they are not reported as a disabled keyword.

The count write reuses `NativeKeywordCache::save_count` (the source's `saveKeywordCount`). The adapter does not write the counter itself.

## Public API

Module: `dima_rust::utils::ast_runtime::keyword_state`.

```rust
pub struct KeywordState {
    pub enabled: bool, // always true on Ok; disabled does not return this struct
    pub count: f64,
}

pub enum KeywordStateError {
    IdentifierUnresolved { id: String, missing: &'static str },
    NotFound,
    Disabled,
    Mongo(String),
}
// Display + std::error::Error

pub struct KeywordStateReader<S, C> { /* private */ }

impl<S, C> KeywordStateReader<S, C> {
    pub fn new(source: S, cache: C) -> Self // no I/O
}

impl<S: KeywordDocumentSource, C: KeywordCountSink> KeywordStateReader<S, C> {
    pub async fn keyword_state(
        &self,
        channel_id: &str,
        id: &str,
    ) -> Result<KeywordState, KeywordStateError>

    pub async fn save_keyword_count(
        &self,
        channel_id: &str,
        id: &str,
        count: f64,
    ) -> Result<(), KeywordStateError>
}

impl<C> KeywordStateReader<MongoKeywordDocuments, C> {
    pub fn from_database(database: &Database, cache: C) -> Self // no I/O
    pub fn from_collection(commands: Collection<Document>, cache: C) -> Self // no I/O
}

impl<C> KeywordStateReader<LazyMongoKeywordDocuments, C> {
    pub fn lazy(database_name: impl Into<String>, cache: C) -> Self
    // no I/O; get_mongo_client() runs on the first keyword_state call
}

pub fn resolve_keyword_object_id(id: &str) -> Result<ObjectId, KeywordStateError>
pub fn interpret_keyword_document(document: Option<&Document>) -> Result<KeywordState, KeywordStateError>
pub fn keyword_state_filter(channel_id: &str, id: ObjectId) -> Document
pub fn keyword_state_projection() -> Document
pub fn as_command_store_state(
    result: Result<KeywordState, KeywordStateError>,
) -> Result<Option<(bool, f64)>, KeywordStateError>

pub trait KeywordDocumentSource {
    fn find_keyword<'a>(
        &'a self,
        channel_id: &'a str,
        id: ObjectId,
    ) -> BoxFuture<'a, Result<Option<Document>, KeywordStateError>>;
}
pub trait KeywordCountSink {
    fn save_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> BoxFuture<'a, Result<(), KeywordStateError>>;
}
impl KeywordCountSink for NativeKeywordCache
impl KeywordCountSink for &NativeKeywordCache
```

`as_command_store_state` maps `NotFound` and `Disabled` to `Ok(None)` and an enabled read to `Ok(Some((enabled, count)))`. That is the `CommandStore::keyword_state` shape. Success is not `Result<Option<KeywordState>, _>`: an `Option` would either hide the not-found/disabled distinction or still hand back `count` on a disabled value. `KeywordStateError` keeps those outcomes typed, and `Disabled` has no count.

`KeywordCountSink` for `NativeKeywordCache` calls `NativeKeywordCache::save_count` with the same `(channel_id, id, count)` arguments. `InvalidCommandId` from that method becomes `IdentifierUnresolved` (`MISSING_CACHE_ID`). Other cache failures, including Redis, become `Mongo` with a message that says the count write failed. The read path's `Mongo` message says the MongoDB read failed.

Construction of `MongoKeywordDocuments`, `LazyMongoKeywordDocuments`, and `KeywordStateReader` performs no I/O. The lazy reader resolves `crate::utils::mongo::get_mongo_client()` on first use and selects the caller-supplied database name. An empty name returns before the client is touched. A failed init is not cached. The recommended executor patch does not use the lazy reader; it clones the collection `Commands` already holds.

The query is:

- collection `commands` (`schemas::commands::COLLECTION_NAME`, exposed as `KEYWORD_STATE_COLLECTION`)
- filter `{ channelID, _id: ObjectId, activation: "keyword" }` (`KEYWORD_ACTIVATION`)
- projection `{ count: 1, enabled: 1, _id: 0 }`

`enabled` is not part of the filter, so a disabled keyword is found and reported as `Disabled` rather than `NotFound`. The projection drops `_id`. Mongoose `.select('count enabled')` would still return `_id`; the caller already has it, and the source only uses `count` and `enabled`.

Decision, matching `if (!current?.enabled)` then `current.count ?? 0`:

- no document → `NotFound`
- `enabled` missing, null, or `false` → `Disabled`, and `count` is not read
- `enabled: true` and nullish `count` → `KeywordState { enabled: true, count: 0.0 }`
- `enabled: true` and `Int32`, `Int64`, or `Double` → that number as `f64`, including a non-finite double (`??` does not replace it)
- any other `enabled` or `count` type → `Mongo`, not a guessed boolean or zero

## `_id` representation

Determined by reading the serializer and the executor. Not executed.

The executor carries a JSON string: `ObjectId::to_hex()`.

Evidence:

1. `Commands::get_command_from_db` → `get_command_inner` → `wire_string` → `bson_js_json_string` (`dimabot/src/classes/command.class.rs`, `wire_string`).
2. `bson_js_json::project` maps `Bson::ObjectId(v)` to a JSON string of `v.to_hex()` (`dimabot/src/utils/bson_js_json.rs`). It does not emit Extended JSON. The `$oid` read in that file is only how a DBPointer's serde form is unpacked, not how command `_id` is written.
3. `execute_command` parses that JSON and takes `command.get("_id").and_then(Value::as_str)` (`dimabot/src/utils/ast_parser/runtime/command.rs`). A non-string `_id` never reaches this adapter. For a keyword it fails first with `AstRuntimeError::Unsupported("keyword command requires a string ObjectId")`.
4. The same process stores `object_id(document)?.to_hex()` on `CurrentCommand` and parses it back with `ObjectId::parse_str` in `Commands::editable_zero_exists`.

Resolution: `resolve_keyword_object_id` accepts that string via `ObjectId::parse_str` and puts the resulting `Bson::ObjectId` in the filter. It does not query by `cmd` or any other field. Empty strings, text containing `$oid` or starting with `{`, and any string `parse_str` rejects become `IdentifierUnresolved` before `KeywordDocumentSource::find_keyword`. The `missing` text is one of `KeywordStateError::MISSING_EMPTY_ID`, `MISSING_EXTENDED_JSON`, or `MISSING_HEX`.

This lane did not execute `ObjectId::to_hex`, so it does not add a second alphabet check on top of the driver. The executor form is the `to_hex()` string. `parse_str` is the inverse already used on that string. Extended JSON is rejected in this adapter even if a future `parse_str` learned to accept it.

## TypeScript source

`dimabot/src/handlers/commands.handler.ts`, `executeCustomCommand`:

```ts
if (isKeyword) {
    // Body/index caches contain configuration; mutable counter state is read
    // only after this message wins the cooldown gate.
    const current = await CommandsSchema.findOne({ channelID, _id: storedCommand._id, activation: 'keyword' })
        .select('count enabled').lean();
    if (!current?.enabled) return { error: true, message: 'Keyword is disabled or deleted', status: 400, type: 'command_disabled' };
    commandData.count = current.count ?? 0;
}
```

Later, when `specialRes.countModified`:

```ts
if (isKeyword) await saveKeywordCount(channelID, String(storedCommand._id), specialRes.count);
```

`String(storedCommand._id)` on a Mongoose ObjectId is the same 24-hex-digit string `to_hex()` produces. The native count writer parses it with `ObjectId::parse_str` inside `MongoRedisKeywordStorage::update_keyword_count`.

## Fixture proof

`dimabot/tests/ast_keyword_state.rs` (feature `ast-bot-runtime`, in-memory fake, no MongoDB):

- enabled keyword returns its `count`, and the fake records the channel id plus the parsed ObjectId
- nullish `count` on an enabled keyword becomes `0`
- missing keyword is `NotFound`, and its `Display` is distinct from `Disabled`
- disabled, missing `enabled`, and disabled-with-a-non-numeric-count are `Disabled`; the count is not in the error
- empty, Extended JSON `$oid`, and non-hex ids are `IdentifierUnresolved` and the fake's query count stays `0`
- `save_keyword_count` records the same `(channel_id, id, count)` pairs and does not query
- the production filter is exactly `channelID`, ObjectId `_id`, and `activation: "keyword"`, with no `enabled` and no `cmd`
- the projection is `count: 1`, `enabled: 1`, `_id: 0`

Async tests use `#[tokio::test(flavor = "current_thread")]` because `BoxFuture` in this runtime is not `Send`.

## Central patch (do not apply in this lane)

Prerequisite, still absent from this checkout when this note was written. The parser/command lane already proposed it. Keep `keyword-store` (for `NativeKeywordCache`), `mongo`, `commands-service` (for `Commands` and `schemas::commands::COLLECTION_NAME`), and `tokio`. Dropping `keyword-store` breaks both `runtime/command.rs` and this adapter.

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

The read stub this lane exists to replace, in `dimabot/src/utils/ast_parser/runtime/command.rs`. Replace the `Unsupported` body of `NativeCommandStore`'s `keyword_state` only. Do not replace `keyword_body`; that method is cached configuration.

```rust
fn keyword_state<'a>(
    &'a mut self,
    channel: &'a str,
    id: &'a str,
) -> BoxFuture<'a, Result<Option<(bool, f64)>, AstRuntimeError>> {
    Box::pin(async move {
        let reader = crate::utils::ast_runtime::keyword_state::KeywordStateReader::from_collection(
            self.commands.repository().collection().clone(),
            self.keywords,
        );
        match crate::utils::ast_runtime::keyword_state::as_command_store_state(
            reader.keyword_state(channel, id).await,
        ) {
            Ok(state) => Ok(state),
            Err(crate::utils::ast_runtime::keyword_state::KeywordStateError::IdentifierUnresolved { .. }) => {
                Err(AstRuntimeError::Unsupported(
                    "keyword command requires a string ObjectId".into(),
                ))
            }
            Err(error) => Err(AstRuntimeError::Host(error.to_string())),
        }
    })
}
```

`from_collection` uses the `commands` collection the command service already holds, so the patch does not choose a database name and does not call `get_mongo_client` again. `CommandsRepository` derefs to the repository whose `collection()` returns that handle.

`update_keyword_count` already calls `self.keywords.save_count(channel, id, count)`. That is the source's `saveKeywordCount`. Leave it. `KeywordStateReader::save_keyword_count` is the same delegation for a caller that has the reader.

No `[[test]]` entry is required. `dimabot/tests/ast_keyword_state.rs` is an integration test gated by `ast-bot-runtime`.

## Remaining gaps

- `NativeCommandStore::keyword_state` still returns `Unsupported` until the patch above is applied. This lane did not edit `command.rs`.
- `ast-bot-runtime` is not in `dimabot/Cargo.toml`, and `utils/mod.rs` does not declare `ast_runtime`. The new module is only reachable after that prerequisite.
- `runtime.rs` also declares `functions`, `host`, and `variables`. Those files were present beside `keyword_state.rs` at the end of this lane. This lane did not edit them. `ast_runtime` still does not compile until the feature and the `utils/mod.rs` declaration exist, and until those sibling modules type-check under that feature.
- Keyword execution still looks up the command body by name. Supplying the matched keyword body to the runner is a separate gap, recorded in `migration-notes/ast-bot-runtime-parser-command.md`. This adapter only reads fresh `count` and `enabled`.
- No compile, test, or runtime check was run. Verification is pending an integration execution lease.
- No caller adoption and no deployment.

## Blocked

Nothing in this lane's file list was left unfinished. Compilation and the behavioural tests are blocked on the integration feature, the `ast_runtime` module declaration, and the execution lease. The `Unsupported` stub remains until the `command.rs` patch is applied by the integration team.
