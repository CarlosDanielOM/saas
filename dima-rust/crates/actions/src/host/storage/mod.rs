//! The host's storage: where the variables of the command language live, read and written as
//! `handlers/special_parser.handler.ts` (`loadScopedVariable`, `saveScopedVariable` and the
//! closures of `createSpecialExecutionContext`) and `utils/ast_parser/evaluator.ts` (the cache
//! variables) do. Package P4-ACT-CORE.
//!
//! # Where each kind of variable lives
//!
//! | Written as | Lives in | Key or document | Lifetime |
//! |---|---|---|---|
//! | `%(name …)` | the run ([`dima_engine::context::State`]) | — | the run |
//! | `#name` | Dragonfly | `{platform}:{channel}:variable:{name}` (string) | `EXPIRE 86400` after each write |
//! | `##name` | Dragonfly | the same `…:id:{userId}` and `…:login:{login}` | the same |
//! | `*name` | MongoDB `astvariables` | `{channelID, scopeType: 'global', scopeName: 'global', userId: '', userLogin: ''}`, `variables.{name}` | durable |
//! | `**name` | MongoDB `astvariables` | the same with the viewer's `userId` (or `login:{login}` for another viewer) and `userLogin` | durable |
//! | `%(responses …)` | nowhere | `saveResponses` is the reference's default no-op | the run |
//!
//! The cache keys are built by the engine and passed here whole; this module puts the process's
//! [`dima_commands::runtime::KeyPrefix`] before them (empty in production). The documents are
//! the reference's exactly, so the variables stored by the TypeScript are read as they are, and
//! after a rollback the TypeScript reads what Rust wrote (same filter, same `$set` of
//! `variables.{name}`, same `$setOnInsert`, through the `astvariables` write helpers of
//! `dima-model`, which add `__v` and the timestamps as Mongoose does).
//!
//! Nothing is cached in the process: every read goes to MongoDB (the evaluation keeps its own
//! memo of what it read, [`dima_engine::context::State::command_variables`]), and every write is
//! one atomic upsert. Two processes writing the same variable at once: the last write wins, as
//! in the reference. Two upserts that both find no document race on the unique index; the
//! loser fails with a duplicate key, and where the reference logged it and lost the write
//! (every case but a viewer variable whose user has both an id and a login), Rust runs the
//! upsert once more, which then updates the document the winner made (closed weakness).
//!
//! # Failures
//!
//! As in the reference, a MongoDB failure never stops the evaluation: a read that fails answers
//! `''` and a write that fails is logged (`Error loading AST scoped variable`, `Error saving
//! AST scoped variable`). A Dragonfly failure does stop it (the reference does not catch the
//! cache calls). Every MongoDB call runs under [`StorageConfig::store_deadline`] (the reference
//! has none); a write cut short there may or may not have happened, and is logged as failed.
//!
//! # Bounds
//!
//! A read returns at most one value: the MongoDB reads project `variables.{name}` only, the
//! cache read is a script that measures the value before it reads it. A value longer than
//! [`StorageConfig::max_value_bytes`] is refused with a host error before it is transferred;
//! a shorter one that is still over the engine's text limit reaches the engine, which refuses
//! it with its own limit (`[Parse error: …]` in place). Only a value written outside the
//! command language (a hand edit) can be that long: the engine never writes one.
//!
//! # Names MongoDB cannot hold
//!
//! A variable name containing `.`, starting with `$` or containing a NUL is not a valid key of
//! the `variables` map (Mongoose refuses such map keys): it reads as `''` and is never written
//! (logged). The grammar never produces one; this only guards the boundary.

use super::HostDeps;
use bson::{Bson, Document, doc};
use dima_engine::host::HostError;
use dima_model::ast_variables::{COLLECTION, INFO};
use dima_store::dragonfly::Script;
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::{Returned, UpdateOptions as StoreUpdateOptions};
use dima_telemetry::LogOptions;
use serde_json::json;
use std::future::IntoFuture;
use std::time::Duration;

/// `VARIABLE_SCOPE_TYPE` and `VARIABLE_SCOPE_NAME`: every persistent variable belongs to the
/// channel (and optionally a viewer), whatever runs it.
pub const GLOBAL_SCOPE: &str = "global";

/// Reads a string value only when it is at most `ARGV[1]` bytes: answers the value, nil when the
/// key is missing, or the length when it is longer. One key, no loop.
static BOUNDED_GET: Script =
    Script::new("ast_variable_bounded_get", include_str!("bounded_get.lua"));

/// Limits and deadlines of the host's storage. [`Default`] holds the production values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageConfig {
    /// Deadline of one MongoDB call (none in the reference: a generous one that only fires on a
    /// real hang).
    pub store_deadline: Duration,
    /// The longest stored value handed to the engine, in bytes (four times the engine's default
    /// text limit of 256 KiB). Longer values are refused before they are transferred.
    pub max_value_bytes: usize,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(5),
            max_value_bytes: 1024 * 1024,
        }
    }
}

/// Whose variables a run reads and writes: the reference's two kinds of execution context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VariableScope {
    /// `createSpecialExecutionContext`: channel variables of the channel, viewer variables of
    /// the user the event names (`extractUserInfo(eventData)`: `chatter_user_id || user_id ||
    /// …`, which may differ from the run's own user).
    Event {
        /// The user id the event names (`''` when none).
        user_id: String,
        /// The user login the event names (`''` when none).
        user_login: String,
    },
    /// `createExecutionContext`'s defaults (the AI tool's `parseAndEvaluate`): channel and
    /// viewer variables read as `''` and writes do nothing. Cache variables still work.
    Detached,
}

/// `normalizeUserLogin`: trimmed, leading `@`s removed, lowercase.
pub fn normalize_login(login: &str) -> String {
    dima_text::to_lower(dima_text::trim(login).trim_start_matches('@'))
}

fn map_key_ok(name: &str) -> bool {
    !name.contains('.') && !name.starts_with('$') && !name.contains('\0')
}

impl HostDeps {
    fn cache_key(&self, key: &str) -> String {
        self.keys.key(key)
    }

    fn log_error(&self, data: &serde_json::Value, channel_id: &str) {
        if let Some(telemetry) = &self.telemetry {
            telemetry.error(data, LogOptions::console().channel(channel_id));
        }
    }

    async fn mongo<T, E>(&self, future: impl IntoFuture<Output = Result<T, E>>) -> Result<T, String>
    where
        E: std::fmt::Display,
    {
        match tokio::time::timeout(self.storage.store_deadline, future).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err(format!(
                "did not finish within {} ms",
                self.storage.store_deadline.as_millis()
            )),
        }
    }
}

fn dragonfly_error(error: impl std::fmt::Display) -> HostError {
    HostError::new(format!("Dragonfly: {error}"))
}

// ---- cache variables (`#`, `##`) ----

/// `redis.get(key)` of a cache variable, bounded.
pub(crate) async fn cache_get(deps: &HostDeps, key: &str) -> Result<Option<String>, HostError> {
    let key = deps.cache_key(key);
    let limit = deps.storage.max_value_bytes.to_string();
    let reply = BOUNDED_GET
        .run_value(&deps.dragonfly, &[key.as_str()], &[limit.as_str()])
        .await
        .map_err(dragonfly_error)?;
    match reply {
        redis::Value::Nil => Ok(None),
        redis::Value::Int(length) => Err(HostError::new(format!(
            "a stored cache variable is too long ({length} bytes)"
        ))),
        other => {
            let bytes =
                dima_store::dragonfly::commands::reply::bytes(other).map_err(dragonfly_error)?;
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| HostError::new("a stored cache variable is not UTF-8"))
        }
    }
}

/// `redis.exists(key)`.
pub(crate) async fn cache_exists(deps: &HostDeps, key: &str) -> Result<bool, HostError> {
    let key = deps.cache_key(key);
    deps.dragonfly
        .exists(&[key.as_str()])
        .await
        .map(|count| count > 0)
        .map_err(dragonfly_error)
}

/// `redis.set(key, value)`: no expiry option, so the key loses any lifetime it had until the
/// `EXPIRE` the engine sends next.
pub(crate) async fn cache_set(deps: &HostDeps, key: &str, value: &str) -> Result<(), HostError> {
    let key = deps.cache_key(key);
    deps.dragonfly
        .set(&key, value.as_bytes(), Default::default())
        .await
        .map(drop)
        .map_err(dragonfly_error)
}

/// `redis.expire(key, seconds)`.
pub(crate) async fn cache_expire(
    deps: &HostDeps,
    key: &str,
    seconds: u64,
) -> Result<(), HostError> {
    let key = deps.cache_key(key);
    let mut cmd = redis::cmd("EXPIRE");
    cmd.arg(&key).arg(seconds);
    deps.dragonfly
        .query_value(&cmd)
        .await
        .map(drop)
        .map_err(dragonfly_error)
}

/// `redis.del(key)`.
pub(crate) async fn cache_delete(deps: &HostDeps, key: &str) -> Result<(), HostError> {
    let key = deps.cache_key(key);
    deps.dragonfly
        .del(&[key.as_str()])
        .await
        .map(drop)
        .map_err(dragonfly_error)
}

// ---- persistent variables (`*`, `**`) ----

/// The value of `variables.{name}` in a document read with that projection, as Mongoose's
/// `Map` of `String` reads it: `None` when the map has no such key.
fn variable_of(document: &Document, name: &str) -> Option<String> {
    let value = document.get_document("variables").ok()?.get(name)?;
    Some(match value {
        Bson::String(text) => text.clone(),
        Bson::Null | Bson::Undefined => String::new(),
        Bson::Boolean(flag) => flag.to_string(),
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        Bson::Double(n) => dima_text::number_to_string(*n),
        // Mongoose casts what it can to String; anything else cannot be in a map of String.
        _ => String::new(),
    })
}

/// `loadScopedVariable(channelID, 'global', 'global', name, userId, userLogin)`.
async fn load_scoped(
    deps: &HostDeps,
    channel_id: &str,
    name: &str,
    user_id: &str,
    user_login: &str,
) -> String {
    if !map_key_ok(name) {
        return String::new();
    }
    let mut filter = doc! {
        "channelID": channel_id,
        "scopeType": GLOBAL_SCOPE,
        "scopeName": GLOBAL_SCOPE,
    };
    let login = normalize_login(user_login);
    if login.is_empty() {
        filter.insert("userId", user_id);
    } else {
        filter.insert("userLogin", login.as_str());
    }
    let path = format!("variables.{name}");
    let projection = doc! { path.as_str(): 1 };
    let collection = deps.mongo.documents(COLLECTION);
    let outcome = async {
        let found = deps
            .mongo(
                collection
                    .find_one(filter.clone())
                    .projection(projection.clone()),
            )
            .await?;
        if let Some(value) = found.as_ref().and_then(|found| variable_of(found, name)) {
            return Ok(value);
        }
        // Until legacy documents are copied, the most recently updated trigger-local value.
        // A global empty value is a deletion tombstone (found above).
        let mut legacy = filter.clone();
        legacy.insert("scopeType", doc! { "$ne": GLOBAL_SCOPE });
        legacy.insert("scopeName", doc! { "$exists": true });
        legacy.insert(path.as_str(), doc! { "$exists": true });
        let found = deps
            .mongo(
                collection
                    .find_one(legacy)
                    .sort(doc! { "updatedAt": -1, "_id": -1 })
                    .projection(projection.clone()),
            )
            .await?;
        Ok::<_, String>(
            found
                .and_then(|found| variable_of(&found, name))
                .unwrap_or_default(),
        )
    }
    .await;
    match outcome {
        Ok(value) => value,
        Err(error) => {
            deps.log_error(
                &json!({
                    "message": "Error loading AST scoped variable",
                    "channelID": channel_id, "scopeType": GLOBAL_SCOPE, "scopeName": GLOBAL_SCOPE,
                    "userId": user_id, "userLogin": user_login, "variableName": name,
                    "error": error,
                }),
                channel_id,
            );
            String::new()
        }
    }
}

/// One upsert of `saveScopedVariable`.
async fn upsert(
    deps: &HostDeps,
    filter: &Document,
    channel_id: &str,
    name: &str,
    value: &str,
    user_id: &str,
    login: &str,
) -> Result<(), dima_store::mongo::write::WriteError> {
    let update = doc! {
        "$set": { format!("variables.{name}"): value },
        "$setOnInsert": {
            "channelID": channel_id,
            "scopeType": GLOBAL_SCOPE,
            "scopeName": GLOBAL_SCOPE,
            "userId": user_id,
            "userLogin": login,
        },
    };
    let mut ctx = WriteContext::new(deps.clock.now_ms());
    let prepared = INFO
        .prepare_find_one_and_update(
            filter,
            update,
            StoreUpdateOptions::upsert(),
            Returned::Before,
            &mut ctx,
        )
        .map_err(|error| {
            dima_store::mongo::write::WriteError::Driver(mongodb::error::Error::custom(
                error.to_string(),
            ))
        })?;
    deps.mongo
        .writes(COLLECTION)
        .find_one_and_update(&prepared)
        .await
        .map(drop)
}

/// The failure of one write, as the reference tells them apart.
enum WriteFailure {
    Duplicate,
    Other(String),
}

async fn upsert_within(
    deps: &HostDeps,
    filter: &Document,
    channel_id: &str,
    name: &str,
    value: &str,
    user_id: &str,
    login: &str,
) -> Result<(), WriteFailure> {
    match tokio::time::timeout(
        deps.storage.store_deadline,
        upsert(deps, filter, channel_id, name, value, user_id, login),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(dima_store::mongo::write::WriteError::Driver(error)))
            if dima_store::mongo::error::duplicate_key(&error).is_some() =>
        {
            Err(WriteFailure::Duplicate)
        }
        Ok(Err(error)) => Err(WriteFailure::Other(error.to_string())),
        Err(_) => Err(WriteFailure::Other(format!(
            "did not finish within {} ms (the write may have happened)",
            deps.storage.store_deadline.as_millis()
        ))),
    }
}

/// `saveScopedVariable(channelID, 'global', 'global', name, value, userId, userLogin)`.
async fn save_scoped(
    deps: &HostDeps,
    channel_id: &str,
    name: &str,
    value: &str,
    user_id: &str,
    user_login: &str,
) {
    let login = normalize_login(user_login);
    let log = |error: String, message: &str| {
        deps.log_error(
            &json!({
                "message": message,
                "channelID": channel_id, "scopeType": GLOBAL_SCOPE, "scopeName": GLOBAL_SCOPE,
                "userId": user_id, "userLogin": user_login, "variableName": name,
                "error": error,
            }),
            channel_id,
        );
    };
    if !map_key_ok(name) {
        log(
            "the variable name is not a valid map key".into(),
            "Error saving AST scoped variable:",
        );
        return;
    }
    let mut filter = doc! {
        "channelID": channel_id,
        "scopeType": GLOBAL_SCOPE,
        "scopeName": GLOBAL_SCOPE,
    };
    if user_id.is_empty() {
        filter.insert("userLogin", login.as_str());
    } else {
        filter.insert("userId", user_id);
    }
    let first = upsert_within(deps, &filter, channel_id, name, value, user_id, &login).await;
    let retry_filter = match first {
        Ok(()) => return,
        Err(WriteFailure::Other(error)) => {
            log(error, "Error saving AST scoped variable:");
            return;
        }
        // The reference's fallback: a viewer known by id and login whose login document
        // exists already (another id, or `login:{login}`).
        Err(WriteFailure::Duplicate) if !user_id.is_empty() && !login.is_empty() => doc! {
            "channelID": channel_id,
            "scopeType": GLOBAL_SCOPE,
            "scopeName": GLOBAL_SCOPE,
            "userLogin": login.as_str(),
        },
        // Two upserts raced on the unique index: the other one made the document, so the same
        // upsert now updates it (the reference logged and lost the write).
        Err(WriteFailure::Duplicate) => filter,
    };
    match upsert_within(
        deps,
        &retry_filter,
        channel_id,
        name,
        value,
        user_id,
        &login,
    )
    .await
    {
        Ok(()) => {}
        Err(WriteFailure::Duplicate) => log(
            "E11000 duplicate key".into(),
            "Error saving AST scoped variable (fallback):",
        ),
        Err(WriteFailure::Other(error)) => {
            log(error, "Error saving AST scoped variable (fallback):")
        }
    }
}

/// `loadChannelVariable(name)`.
pub(crate) async fn load_channel_variable(deps: &HostDeps, channel_id: &str, name: &str) -> String {
    load_scoped(deps, channel_id, name, "", "").await
}

/// `saveChannelVariable(name, value)`.
pub(crate) async fn save_channel_variable(
    deps: &HostDeps,
    channel_id: &str,
    name: &str,
    value: &str,
) {
    save_scoped(deps, channel_id, name, value, "", "").await;
}

/// `deleteChannelVariable(name)`: an empty value, the tombstone legacy reads stop at.
pub(crate) async fn delete_channel_variable(deps: &HostDeps, channel_id: &str, name: &str) {
    save_scoped(deps, channel_id, name, "", "", "").await;
}

/// `loadUserVariable(name, targetUserLogin)`.
pub(crate) async fn load_user_variable(
    deps: &HostDeps,
    channel_id: &str,
    (user_id, user_login): (&str, &str),
    name: &str,
    target: Option<&str>,
) -> String {
    let target = normalize_login(target.unwrap_or_default());
    if user_id.is_empty() && target.is_empty() {
        deps.log_error(
            &json!({
                "message": "AST user-scoped variable read skipped: missing userId",
                "channelID": channel_id, "scopeType": GLOBAL_SCOPE, "scopeName": GLOBAL_SCOPE,
                "variableName": name,
            }),
            channel_id,
        );
        return String::new();
    }
    let (id, login) = if target.is_empty() {
        (user_id, user_login)
    } else {
        ("", target.as_str())
    };
    load_scoped(deps, channel_id, name, id, login).await
}

/// `saveUserVariable(name, value, targetUserLogin)`.
pub(crate) async fn save_user_variable(
    deps: &HostDeps,
    channel_id: &str,
    (user_id, user_login): (&str, &str),
    name: &str,
    value: &str,
    target: Option<&str>,
) {
    let target = normalize_login(target.unwrap_or_default());
    if user_id.is_empty() && target.is_empty() {
        return;
    }
    let other = !target.is_empty() && target != normalize_login(user_login);
    // A selected login needs a distinct userId for the unique index; when a real-id document
    // exists already, the save falls back to the login index.
    let selected_id = if other {
        format!("login:{target}")
    } else {
        user_id.to_owned()
    };
    let login = if target.is_empty() {
        user_login
    } else {
        target.as_str()
    };
    save_scoped(deps, channel_id, name, value, &selected_id, login).await;
}

/// `deleteUserVariable(name, targetUserLogin)`.
pub(crate) async fn delete_user_variable(
    deps: &HostDeps,
    channel_id: &str,
    (user_id, user_login): (&str, &str),
    name: &str,
    target: Option<&str>,
) {
    let target = normalize_login(target.unwrap_or_default());
    if user_id.is_empty() && target.is_empty() {
        return;
    }
    let (id, login) = if target.is_empty() {
        (user_id, user_login)
    } else {
        ("", target.as_str())
    };
    save_scoped(deps, channel_id, name, "", id, login).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logins_are_normalised_as_the_reference_does() {
        assert_eq!(normalize_login("  @@ViewerOne "), "viewerone");
        assert_eq!(normalize_login("ÁLVARO"), "álvaro");
        assert_eq!(normalize_login(""), "");
    }

    #[test]
    fn map_values_read_as_mongoose_casts_them() {
        let document = doc! { "variables": { "a": "x", "n": 5, "f": 2.5, "z": Bson::Null } };
        assert_eq!(variable_of(&document, "a").as_deref(), Some("x"));
        assert_eq!(variable_of(&document, "n").as_deref(), Some("5"));
        assert_eq!(variable_of(&document, "f").as_deref(), Some("2.5"));
        assert_eq!(variable_of(&document, "z").as_deref(), Some(""));
        assert_eq!(variable_of(&document, "missing"), None);
        assert_eq!(variable_of(&doc! {}, "a"), None);
    }

    #[test]
    fn names_mongodb_cannot_hold() {
        assert!(map_key_ok("score_1"));
        assert!(!map_key_ok("a.b"));
        assert!(!map_key_ok("$x"));
        assert!(map_key_ok("x$"));
    }
}
