//! Fresh keyword counter read for native command execution.
//!
//! Port of the keyword branch in `executeCustomCommand`
//! (`dimabot/src/handlers/commands.handler.ts`).
//!
//! # Ordering
//!
//! The TypeScript source reads mutable keyword state only after this message
//! wins the cooldown gate (`command:execution:cooldown:<channel>:<name>`).
//! This adapter does not acquire that gate. Call
//! [`KeywordStateReader::keyword_state`] only after the gate is won, which is
//! where `runtime::command::execute_command` already calls
//! `CommandStore::keyword_state`.
//!
//! # Cached bodies are not mutable state
//!
//! `NativeKeywordCache::body` and the keyword index store configuration.
//! The source comment on this branch says those caches must not supply the
//! counter. `count` and `enabled` are read here with a fresh MongoDB
//! `find_one` on `{ channelID, _id, activation: "keyword" }`, projecting only
//! `count` and `enabled`. Do not substitute [`NativeKeywordCache::body`] for
//! this read.
//!
//! On a later count modification the source calls `saveKeywordCount`. That
//! write is [`NativeKeywordCache::save_count`], injected here rather than
//! reimplemented.
//!
//! # `_id` representation
//!
//! `Commands::get_command_from_db` serialises the document through
//! `bson_js_json`. That projector renders `Bson::ObjectId` with
//! `ObjectId::to_hex()` as a JSON string (`bson_js_json::project`). It does
//! not emit Extended JSON `{ "$oid": "..." }`. `execute_command` then reads
//! `command["_id"]` with `Value::as_str` and passes that string here.
//! [`resolve_keyword_object_id`] parses it with `ObjectId::parse_str`, the
//! same pair `Commands::editable_zero_exists` uses. A value that is not that
//! hex string fails before any query.

use std::fmt;

use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use tokio::sync::OnceCell;

use crate::utils::keywords::native::{KeywordNativeError, NativeKeywordCache};

use super::BoxFuture;

/// Collection `commands`: Mongoose's plural of model `Commands`.
///
/// This is [`crate::schemas::commands::COLLECTION_NAME`].
pub const KEYWORD_STATE_COLLECTION: &str = crate::schemas::commands::COLLECTION_NAME;

/// Stored `activation` discriminator for a keyword document.
///
/// `CommandActivation::Keyword` formats as this string. The schema helper
/// `as_str` is private to the schema module, so the query uses the same
/// literal the TypeScript filter uses (`activation: 'keyword'`).
pub const KEYWORD_ACTIVATION: &str = "keyword";

/// Enabled keyword counter returned by a fresh read.
///
/// `enabled` is always `true` on this value. A disabled or missing keyword is
/// [`KeywordStateError::Disabled`] or [`KeywordStateError::NotFound`] and does
/// not carry `count`, so a caller cannot use a stale counter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeywordState {
    pub enabled: bool,
    pub count: f64,
}

/// Typed failure for the fresh keyword read and the delegated count write.
///
/// `NotFound` and `Disabled` are normal outcomes. The command executor turns
/// both into the source's `command_disabled` failure (`Keyword is disabled or
/// deleted`, status 400). They are not panics and they are not the same
/// variant. `IdentifierUnresolved` is raised before a query. `Mongo` is a
/// driver or count-write failure from the injected cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeywordStateError {
    /// `id` is not the executor's `ObjectId::to_hex()` string.
    IdentifierUnresolved { id: String, missing: &'static str },
    /// No document matched `{ channelID, _id, activation: "keyword" }`.
    NotFound,
    /// The document exists and `enabled` is not strictly `true`.
    ///
    /// Missing, null, and `false` all take this path, matching
    /// `if (!current?.enabled)` in the TypeScript source. `count` is not
    /// part of this error.
    Disabled,
    /// The MongoDB read, or the injected `save_count` write, failed.
    ///
    /// The string is a complete sentence. Count-write failures from
    /// [`NativeKeywordCache::save_count`] use this variant because that
    /// method is the source's `saveKeywordCount` and is not reimplemented
    /// here. Redis failures inside that method are included, with a message
    /// that says the count write failed.
    Mongo(String),
}

impl fmt::Display for KeywordStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IdentifierUnresolved { id, missing } => write!(
                formatter,
                "keyword identifier cannot be resolved to an ObjectId: {missing} (received {id:?})"
            ),
            Self::NotFound => formatter.write_str("keyword document was not found"),
            Self::Disabled => formatter.write_str("keyword is disabled"),
            Self::Mongo(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for KeywordStateError {}

/// Why an executor id string cannot become an ObjectId.
///
/// Each string names the missing representation. It is the `missing` field of
/// [`KeywordStateError::IdentifierUnresolved`].
impl KeywordStateError {
    pub const MISSING_EMPTY_ID: &'static str = concat!(
        "the executor _id string is empty; bson_js_json renders ObjectId as ",
        "ObjectId::to_hex(), a JSON string, and that hex string is missing"
    );

    pub const MISSING_EXTENDED_JSON: &'static str = concat!(
        "Extended JSON {\"$oid\":\"...\"} is not the executor representation; ",
        "bson_js_json renders ObjectId via ObjectId::to_hex() as a JSON string, ",
        "and that hex string is missing"
    );

    pub const MISSING_HEX: &'static str = concat!(
        "the value is not an ObjectId hex string; the executor carries ",
        "bson_js_json ObjectId::to_hex(), and this adapter does not query by ",
        "cmd or any other field"
    );

    pub const MISSING_CACHE_ID: &'static str = concat!(
        "NativeKeywordCache::save_count rejected the id; it requires ",
        "ObjectId::parse_str of the executor hex string from ",
        "bson_js_json ObjectId::to_hex()"
    );
}

/// Parse the `_id` string the native executor actually carries.
///
/// Accepts the JSON string produced by `bson_js_json` for `Bson::ObjectId`,
/// which is `ObjectId::to_hex()`, via `ObjectId::parse_str`. Extended JSON
/// and any other shape return [`KeywordStateError::IdentifierUnresolved`]
/// and must not be queried.
pub fn resolve_keyword_object_id(id: &str) -> Result<ObjectId, KeywordStateError> {
    if id.is_empty() {
        return Err(identifier_error(id, KeywordStateError::MISSING_EMPTY_ID));
    }
    if id.as_bytes().first() == Some(&b'{') || id.contains("$oid") {
        return Err(identifier_error(id, KeywordStateError::MISSING_EXTENDED_JSON));
    }
    ObjectId::parse_str(id).map_err(|_| identifier_error(id, KeywordStateError::MISSING_HEX))
}

fn identifier_error(id: &str, missing: &'static str) -> KeywordStateError {
    KeywordStateError::IdentifierUnresolved {
        id: id.to_owned(),
        missing,
    }
}

/// Filter for the fresh read: `channelID`, ObjectId `_id`, and `activation`.
///
/// `_id` is the parsed ObjectId, never the raw string and never `cmd`.
/// `enabled` is intentionally absent so a disabled keyword is returned and
/// reported as disabled rather than looking like a missing document.
pub fn keyword_state_filter(channel_id: &str, id: ObjectId) -> Document {
    doc! {
        "channelID": channel_id,
        "_id": id,
        "activation": KEYWORD_ACTIVATION,
    }
}

/// Projection equivalent to Mongoose `.select('count enabled')`.
///
/// `_id` is excluded. The caller already has the identifier, and the source
/// uses only `count` and `enabled` from the lean result. Mongoose would still
/// return `_id` by default; dropping it keeps the wire result to those two
/// fields.
pub fn keyword_state_projection() -> Document {
    doc! {
        "count": 1,
        "enabled": 1,
        "_id": 0,
    }
}

/// Apply the source's `if (!current?.enabled)` / `count ?? 0` decision.
///
/// `None` is not found. A document whose `enabled` field is missing, null, or
/// `false` is disabled, and its `count` is not read. Only `enabled: true`
/// yields a [`KeywordState`]. A nullish `count` becomes `0`. A stored BSON
/// number is kept, including a non-finite double, because `??` only replaces
/// null and undefined. `Int32` and `Int64` become `f64` the way a JavaScript
/// number read would. Any other `count` type is a [`KeywordStateError::Mongo`]
/// and is not coerced to `0`.
pub fn interpret_keyword_document(
    document: Option<&Document>,
) -> Result<KeywordState, KeywordStateError> {
    let Some(document) = document else {
        return Err(KeywordStateError::NotFound);
    };
    match document.get("enabled") {
        Some(Bson::Boolean(true)) => {}
        None | Some(Bson::Null) | Some(Bson::Boolean(false)) => {
            return Err(KeywordStateError::Disabled);
        }
        Some(_) => {
            return Err(KeywordStateError::Mongo(
                "keyword enabled field is not a boolean".to_owned(),
            ));
        }
    }
    let count = match document.get("count") {
        None | Some(Bson::Null) => 0.0,
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        Some(_) => {
            return Err(KeywordStateError::Mongo(
                "keyword count field is not a BSON number".to_owned(),
            ));
        }
    };
    Ok(KeywordState {
        enabled: true,
        count,
    })
}

/// Map a fresh read onto `CommandStore::keyword_state`.
///
/// `Ok(Some((true, count)))` is an enabled keyword. `Ok(None)` is not found
/// or disabled, which `execute_command` already turns into `command_disabled`.
/// Identifier and Mongo failures stay errors so they are not reported as a
/// disabled keyword.
pub fn as_command_store_state(
    result: Result<KeywordState, KeywordStateError>,
) -> Result<Option<(bool, f64)>, KeywordStateError> {
    match result {
        Ok(state) => Ok(Some((state.enabled, state.count))),
        Err(KeywordStateError::NotFound | KeywordStateError::Disabled) => Ok(None),
        Err(error) => Err(error),
    }
}

/// In-memory or MongoDB document source for the fresh read.
///
/// The future is not `Send`, matching the rest of this runtime.
pub trait KeywordDocumentSource {
    fn find_keyword<'a>(
        &'a self,
        channel_id: &'a str,
        id: ObjectId,
    ) -> BoxFuture<'a, Result<Option<Document>, KeywordStateError>>;
}

/// Count writer. The production implementation delegates to
/// [`NativeKeywordCache::save_count`].
pub trait KeywordCountSink {
    fn save_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> BoxFuture<'a, Result<(), KeywordStateError>>;
}

/// Production document source bound to a `commands` collection handle.
///
/// Construction stores the handle and does not connect or query.
#[derive(Clone)]
pub struct MongoKeywordDocuments {
    commands: Collection<Document>,
}

impl MongoKeywordDocuments {
    /// Uses [`KEYWORD_STATE_COLLECTION`] on `database`. Performs no I/O.
    pub fn new(database: &Database) -> Self {
        Self::from_collection(database.collection(KEYWORD_STATE_COLLECTION))
    }

    /// Uses the caller's collection. The integration patch should pass
    /// `Commands::repository().collection().clone()`, which is already the
    /// `commands` collection on the application database. Performs no I/O.
    pub fn from_collection(commands: Collection<Document>) -> Self {
        Self { commands }
    }
}

impl KeywordDocumentSource for MongoKeywordDocuments {
    fn find_keyword<'a>(
        &'a self,
        channel_id: &'a str,
        id: ObjectId,
    ) -> BoxFuture<'a, Result<Option<Document>, KeywordStateError>> {
        Box::pin(async move { find_projected(&self.commands, channel_id, id).await })
    }
}

/// Resolves [`crate::utils::mongo::get_mongo_client`] on the first read.
///
/// Construction stores `database_name` and does not read `MONGO_URI`. The
/// caller selects the database; there is no implicit default. An empty name
/// fails before the client is resolved. A failed client init is not cached.
pub struct LazyMongoKeywordDocuments {
    database_name: String,
    commands: OnceCell<Collection<Document>>,
}

impl LazyMongoKeywordDocuments {
    /// Performs no I/O.
    pub fn new(database_name: impl Into<String>) -> Self {
        Self {
            database_name: database_name.into(),
            commands: OnceCell::new(),
        }
    }

    async fn collection(&self) -> Result<&Collection<Document>, KeywordStateError> {
        if self.database_name.trim().is_empty() {
            return Err(KeywordStateError::Mongo(
                "keyword state database name is empty; the MongoDB client was not resolved"
                    .to_owned(),
            ));
        }
        self.commands
            .get_or_try_init(|| async {
                let client = crate::utils::mongo::get_mongo_client().await.map_err(|error| {
                    KeywordStateError::Mongo(format!(
                        "keyword state MongoDB client initialization failed: {error}"
                    ))
                })?;
                Ok(client
                    .database(&self.database_name)
                    .collection(KEYWORD_STATE_COLLECTION))
            })
            .await
    }
}

impl KeywordDocumentSource for LazyMongoKeywordDocuments {
    fn find_keyword<'a>(
        &'a self,
        channel_id: &'a str,
        id: ObjectId,
    ) -> BoxFuture<'a, Result<Option<Document>, KeywordStateError>> {
        Box::pin(async move {
            let commands = self.collection().await?;
            find_projected(commands, channel_id, id).await
        })
    }
}

async fn find_projected(
    commands: &Collection<Document>,
    channel_id: &str,
    id: ObjectId,
) -> Result<Option<Document>, KeywordStateError> {
    commands
        .find_one(keyword_state_filter(channel_id, id))
        .projection(keyword_state_projection())
        .await
        .map_err(|error| {
            KeywordStateError::Mongo(format!("keyword state MongoDB read failed: {error}"))
        })
}

impl KeywordCountSink for NativeKeywordCache {
    fn save_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> BoxFuture<'a, Result<(), KeywordStateError>> {
        Box::pin(async move { write_saved_count(self, channel_id, id, count).await })
    }
}

impl KeywordCountSink for &NativeKeywordCache {
    fn save_count<'a>(
        &'a self,
        channel_id: &'a str,
        id: &'a str,
        count: f64,
    ) -> BoxFuture<'a, Result<(), KeywordStateError>> {
        Box::pin(async move { write_saved_count(*self, channel_id, id, count).await })
    }
}

async fn write_saved_count(
    cache: &NativeKeywordCache,
    channel_id: &str,
    id: &str,
    count: f64,
) -> Result<(), KeywordStateError> {
    // The arguments are forwarded unchanged. `save_count` is the native
    // `saveKeywordCount`; this function does not write the counter itself.
    cache
        .save_count(channel_id, id, count)
        .await
        .map_err(|error| match error {
            KeywordNativeError::InvalidCommandId => {
                identifier_error(id, KeywordStateError::MISSING_CACHE_ID)
            }
            KeywordNativeError::Mongo(error) => {
                KeywordStateError::Mongo(format!("keyword count write failed: {error}"))
            }
            other => KeywordStateError::Mongo(format!("keyword count write failed: {other}")),
        })
}

/// Fresh keyword read plus the delegated count write.
///
/// `S` is the document source. Production uses [`MongoKeywordDocuments`] or
/// [`LazyMongoKeywordDocuments`]. Tests supply an in-memory fake.
/// `C` is the count writer. Production passes [`NativeKeywordCache`] or a
/// reference to it, which delegates to `save_count`.
///
/// Construction performs no I/O.
pub struct KeywordStateReader<S, C> {
    source: S,
    cache: C,
}

impl<S, C> KeywordStateReader<S, C> {
    /// Stores the collaborators. Does not connect, ping, or query.
    pub fn new(source: S, cache: C) -> Self {
        Self { source, cache }
    }
}

impl<S, C> KeywordStateReader<S, C>
where
    S: KeywordDocumentSource,
    C: KeywordCountSink,
{
    /// Fresh `{ count, enabled }` read for one keyword.
    ///
    /// Call this only after the cooldown gate is won. The identifier is
    /// resolved before the source is touched. A missing document and a
    /// disabled keyword are distinct errors and do not return `count`.
    pub async fn keyword_state(
        &self,
        channel_id: &str,
        id: &str,
    ) -> Result<KeywordState, KeywordStateError> {
        let object_id = resolve_keyword_object_id(id)?;
        let document = self.source.find_keyword(channel_id, object_id).await?;
        interpret_keyword_document(document.as_ref())
    }

    /// Persist a modified keyword counter through the injected cache.
    ///
    /// Forwards `(channel_id, id, count)` to [`KeywordCountSink::save_count`].
    /// The production sink is [`NativeKeywordCache::save_count`].
    pub async fn save_keyword_count(
        &self,
        channel_id: &str,
        id: &str,
        count: f64,
    ) -> Result<(), KeywordStateError> {
        self.cache.save_count(channel_id, id, count).await
    }
}

impl<C> KeywordStateReader<MongoKeywordDocuments, C> {
    /// Binds `database`'s `commands` collection. Performs no I/O.
    pub fn from_database(database: &Database, cache: C) -> Self {
        Self::new(MongoKeywordDocuments::new(database), cache)
    }

    /// Binds an existing `commands` collection handle. Performs no I/O.
    pub fn from_collection(commands: Collection<Document>, cache: C) -> Self {
        Self::new(MongoKeywordDocuments::from_collection(commands), cache)
    }
}

impl<C> KeywordStateReader<LazyMongoKeywordDocuments, C> {
    /// Stores `database_name` and `cache`. The MongoDB client is resolved on
    /// the first [`KeywordStateReader::keyword_state`] call, not here.
    pub fn lazy(database_name: impl Into<String>, cache: C) -> Self {
        Self::new(LazyMongoKeywordDocuments::new(database_name), cache)
    }
}
