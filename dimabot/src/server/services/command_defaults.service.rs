//! Ports `src/server/services/command_defaults.service.ts`: the reserved-command
//! catalog payload and the idempotent per-channel default-command seeder.
//!
//! Reused natively instead of re-ported:
//! * `crate::utils::command_cooldown` — `write_command_with_cooldown` is the
//!   source's `writeCommandWithCooldown` (plan minimum, Redis `NX` lease,
//!   one-editable-zero-slot check, compare-and-delete release).
//! * `crate::utils::twitch_streamers::TwitchStreamers::account_by_id` — the
//!   source's `TwitchStreamers.getTwitchAccountById`, including its plan cache
//!   and fence. The directory catches every failure internally in the source
//!   (`classes/twitch_streamers.class.ts:162-178`) and returns `null`, so the
//!   seeder sees free-tier policy on any directory failure; this port maps every
//!   `DirectoryError` to `None` for the same reason.
//! * `crate::schemas::commands` — `CommandsSchema` field contract, defaults,
//!   validation and the `commands` collection.
//! * `src/config/commands/reservedcommands.json`, embedded byte for byte and
//!   parsed once, so the source catalog is not duplicated.
//!
//! Deliberately recorded adapter differences (no source counterpart):
//! * the source helper logs a swallowed directory failure; the native directory
//!   logs only identity failures, so a swallowed plan read is silent here.
//! * `DateTime::now()` replaces `new Date()`; BSON keeps millisecond
//!   precision. [`ensure_reserved_commands_at`] accepts a fixed instant so the
//!   source oracle can be replayed deterministically.
//! * the raw payload is cloned before it is returned, so a caller cannot mutate
//!   the embedded catalog (the TypeScript array is shared module state).
//!
//! Constructors perform no IO and install no indexes. Every write is explicit.

use crate::schemas::commands;
use crate::utils::bson_compat::js_number;
use crate::utils::command_cooldown::{CooldownError, CooldownStore, write_command_with_cooldown};
use crate::utils::js_compat::trim;
use crate::utils::twitch_streamers::TwitchStreamers;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{ErrorKind, WriteFailure},
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fmt, sync::Arc, sync::LazyLock};

/// `dimabot:default-command:v1` — the stable-id namespace in the source.
pub const DEFAULT_COMMAND_ID_NAMESPACE: &str = "dimabot:default-command:v1";

/// MongoDB duplicate-key error code, the only duplicate signal the source uses.
pub const DUPLICATE_KEY_CODE: i32 = 11_000;

const RESERVED_COMMANDS_JSON: &str = include_str!("../../config/commands/reservedcommands.json");

static RESERVED_COMMANDS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(RESERVED_COMMANDS_JSON)
        .expect("embedded reservedcommands.json is valid JSON")
});

/// `RESERVED_COMMANDS` — the declared catalog, in file order.
pub fn reserved_commands() -> &'static [Value] {
    RESERVED_COMMANDS["commands"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// `SupportedLanguage`; only the catalog's two description languages exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportedLanguage {
    En,
    Es,
}

impl SupportedLanguage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Es => "es",
        }
    }
}

/// The `Pick<ReservedCommandDefinition, 'cmd' | 'func'>` the source passes to
/// its lookup helpers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReservedCommandIdentity<'a> {
    pub cmd: Option<&'a str>,
    pub func: Option<&'a str>,
}

impl<'a> ReservedCommandIdentity<'a> {
    pub fn new(cmd: Option<&'a str>, func: Option<&'a str>) -> Self {
        Self { cmd, func }
    }

    /// The identity of a catalog entry or of a stored command document.
    pub fn of_command(command: &'a Value) -> Self {
        Self {
            cmd: command.get("cmd").and_then(Value::as_str),
            func: command.get("func").and_then(Value::as_str),
        }
    }
}

/// `normalizeSupportedLanguage`: `String(language || '').trim().toLowerCase()`
/// compared with `'es'`.
pub fn normalize_supported_language(language: Option<&str>) -> SupportedLanguage {
    let normalized = trim(language.unwrap_or("")).to_lowercase();
    if normalized == "es" {
        SupportedLanguage::Es
    } else {
        SupportedLanguage::En
    }
}

/// `getReservedCommandDefinition`: the first entry matching `func` (when
/// present) wins, otherwise the first entry matching `cmd` (when present).
pub fn get_reserved_command_definition(
    command: ReservedCommandIdentity<'_>,
) -> Option<&'static Value> {
    reserved_commands().iter().find(|reserved| {
        if command.func.is_some_and(|func| {
            !func.is_empty() && reserved.get("func").and_then(Value::as_str) == Some(func)
        }) {
            return true;
        }
        command.cmd.is_some_and(|cmd| {
            !cmd.is_empty() && reserved.get("cmd").and_then(Value::as_str) == Some(cmd)
        })
    })
}

/// `getLocalizedReservedCommandDescription`: a string description is used
/// verbatim; an object prefers the normalized language, then `en`, then the
/// fallback. Empty strings fall through exactly like JavaScript `||`.
pub fn get_localized_reserved_command_description(
    command: ReservedCommandIdentity<'_>,
    language: Option<&str>,
    fallback_description: &str,
) -> String {
    let Some(reserved) = get_reserved_command_definition(command) else {
        return fallback_description.to_owned();
    };
    match reserved.get("description") {
        Some(Value::String(description)) if !description.is_empty() => description.clone(),
        Some(Value::Object(descriptions)) => {
            let language = normalize_supported_language(language).as_str();
            descriptions
                .get(language)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    descriptions
                        .get("en")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                })
                .map_or_else(|| fallback_description.to_owned(), str::to_owned)
        }
        _ => fallback_description.to_owned(),
    }
}

/// `getReservedCommandsPayload`: without a language the catalog is returned
/// unchanged (including every extra source key); with one, each entry gains the
/// localized `description`.
pub fn get_reserved_commands_payload(language: Option<&str>) -> Value {
    if language.is_none_or(str::is_empty) {
        return json!({ "commands": reserved_commands() });
    }
    let commands = reserved_commands()
        .iter()
        .map(|entry| {
            let mut localized = entry.as_object().cloned().unwrap_or_default();
            let identity = ReservedCommandIdentity::of_command(entry);
            localized.insert(
                "description".to_owned(),
                Value::String(get_localized_reserved_command_description(
                    identity, language, "",
                )),
            );
            Value::Object(localized)
        })
        .collect::<Vec<_>>();
    json!({ "commands": commands })
}

/// `getDefaultCommandID`: `sha256(JSON.stringify([namespace, channelID, func]))`
/// truncated to 24 lowercase hex characters and read as an `ObjectId`.
pub fn default_command_id(channel_id: &str, func: &str) -> ObjectId {
    let payload = json!([DEFAULT_COMMAND_ID_NAMESPACE, channel_id, func]);
    let digest = format!("{:x}", Sha256::digest(payload.to_string().as_bytes()));
    ObjectId::parse_str(&digest[..24]).expect("24 lowercase hex characters form an ObjectId")
}

/// Wire-compatible failures of the seeder. `Display` matches the source's
/// propagated `Error`/driver messages; no variant carries a URI or credential.
#[derive(Debug)]
pub enum CommandDefaultsError {
    /// Any driver failure, including a non-duplicate write failure.
    Mongo(mongodb::error::Error),
    /// A Redis command failure from the zero-slot lease.
    Redis(redis::RedisError),
    /// Lazy Dragonfly initialization failed before a command was attempted.
    RedisInit(String),
    /// `newCommand.save()` schema validation failed.
    Validation(crate::schemas::ValidationErrors),
    /// An unusable command `_id` reached the cooldown adapter.
    InvalidData(&'static str),
}

impl fmt::Display for CommandDefaultsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mongo(error) => error.fmt(formatter),
            Self::Redis(error) => error.fmt(formatter),
            Self::RedisInit(error) => formatter.write_str(error),
            Self::Validation(error) => error.fmt(formatter),
            Self::InvalidData(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CommandDefaultsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mongo(error) => Some(error),
            Self::Redis(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::RedisInit(_) | Self::InvalidData(_) => None,
        }
    }
}

impl From<mongodb::error::Error> for CommandDefaultsError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

impl From<redis::RedisError> for CommandDefaultsError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

impl From<crate::schemas::ValidationErrors> for CommandDefaultsError {
    fn from(error: crate::schemas::ValidationErrors) -> Self {
        Self::Validation(error)
    }
}

/// Concrete MongoDB (commands) / account-directory / Redis adapter for the
/// seeder.
///
/// The directory is the application's `TwitchStreamers` instance, so the plan
/// read uses the same cache, fence and generation rules as the rest of the
/// application. `new` uses the process-wide lazy Dragonfly client only when the
/// zero-slot lease is actually needed; `with_redis` injects a pooled
/// connection. Clones share the same clients.
#[derive(Clone)]
pub struct CommandDefaultsStore {
    commands: Collection<Document>,
    directory: Arc<TwitchStreamers>,
    redis: Option<ConnectionManager>,
}

impl CommandDefaultsStore {
    pub fn new(database: &Database, directory: Arc<TwitchStreamers>) -> Self {
        Self {
            commands: commands::collection(database),
            directory,
            redis: None,
        }
    }

    /// Application/test factory with an existing pooled Dragonfly connection.
    pub fn with_redis(
        database: &Database,
        directory: Arc<TwitchStreamers>,
        connection: ConnectionManager,
    ) -> Self {
        Self {
            commands: commands::collection(database),
            directory,
            redis: Some(connection),
        }
    }

    async fn connection(&self) -> Result<ConnectionManager, CommandDefaultsError> {
        match &self.redis {
            Some(connection) => Ok(connection.clone()),
            None => crate::utils::redis::get_redis_client()
                .await
                .map_err(|error| CommandDefaultsError::RedisInit(error.to_string())),
        }
    }
}

impl CooldownStore for CommandDefaultsStore {
    type Error = CommandDefaultsError;

    /// `TwitchStreamers.getTwitchAccountById(channelID)?.plan_tier`.
    ///
    /// The source method catches every failure, logs it and returns `null`
    /// (`classes/twitch_streamers.class.ts:162-178`), which the cooldown helper
    /// turns into the free-tier minimum. Mirroring that here keeps a cache,
    /// fence or store failure from failing a command write; only the plan value
    /// crosses this boundary.
    async fn owner_plan(&self, channel_id: &str) -> Result<Option<String>, Self::Error> {
        Ok(self
            .directory
            .account_by_id(channel_id)
            .await
            .ok()
            .map(|account| account.metadata.plan_tier))
    }

    async fn acquire_lease(
        &self,
        key: &str,
        token: &str,
        ttl_seconds: u64,
    ) -> Result<bool, Self::Error> {
        let mut connection = self.connection().await?;
        let reply: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(token)
            .arg("NX")
            .arg("EX")
            .arg(ttl_seconds)
            .query_async(&mut connection)
            .await?;
        Ok(reply.is_some())
    }

    async fn editable_zero_exists(
        &self,
        channel_id: &str,
        exclude_id: Option<&str>,
    ) -> Result<bool, Self::Error> {
        let mut filter = doc! {
            "channelID": channel_id,
            "cooldown": 0i32,
            "reserved": {"$ne": true},
        };
        if let Some(id) = exclude_id.filter(|id| !id.is_empty()) {
            let id = ObjectId::parse_str(id)
                .map_err(|_| CommandDefaultsError::InvalidData("command _id is not an ObjectId"))?;
            filter.insert("_id", doc! {"$ne": id});
        }
        Ok(self
            .commands
            .find_one(filter)
            .projection(doc! {"_id": 1})
            .await?
            .is_some())
    }

    async fn release_lease(&self, key: &str, token: &str) -> Result<(), Self::Error> {
        let mut connection = self.connection().await?;
        redis::cmd("EVAL")
            .arg(crate::utils::command_cooldown::RELEASE_LEASE_SCRIPT)
            .arg(1)
            .arg(key)
            .arg(token)
            .query_async::<i64>(&mut connection)
            .await?;
        Ok(())
    }
}

impl CommandDefaultsStore {
    /// `ensureReservedCommands(channelID, channelName)`.
    pub async fn ensure_reserved_commands(
        &self,
        channel_id: &str,
        channel_name: &str,
    ) -> Result<u64, CommandDefaultsError> {
        ensure_reserved_commands(self, channel_id, channel_name).await
    }

    /// Deterministic replay form: every command uses the supplied instant in
    /// place of the source's per-command `new Date()`.
    pub async fn ensure_reserved_commands_at(
        &self,
        channel_id: &str,
        channel_name: &str,
        now: DateTime,
    ) -> Result<u64, CommandDefaultsError> {
        ensure_with_clock(self, channel_id, channel_name, || now).await
    }
}

/// `ensureReservedCommands`: seeds the catalog for one channel, returning the
/// number of commands this call inserted.
pub async fn ensure_reserved_commands(
    store: &CommandDefaultsStore,
    channel_id: &str,
    channel_name: &str,
) -> Result<u64, CommandDefaultsError> {
    ensure_with_clock(store, channel_id, channel_name, DateTime::now).await
}

async fn ensure_with_clock<C>(
    store: &CommandDefaultsStore,
    channel_id: &str,
    channel_name: &str,
    clock: C,
) -> Result<u64, CommandDefaultsError>
where
    C: Fn() -> DateTime,
{
    let mut created = 0u64;
    for command in reserved_commands() {
        let func = command.get("func").and_then(Value::as_str).unwrap_or_default();
        let exists = store
            .commands
            .find_one(doc! {"func": func, "activation": {"$ne": "keyword"}, "channelID": channel_id})
            .projection(doc! {"_id": 1})
            .await?
            .is_some();
        if exists {
            continue;
        }

        let now = clock();
        let id = default_command_id(channel_id, func);
        let draft = default_command_draft(command, channel_id, channel_name, id, now);
        let reserved = command.get("reserved").and_then(Value::as_bool).unwrap_or(false);
        let cooldown = command
            .get("cooldown")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(20.0);

        // The whole source `try` block: the cooldown branch, its 5-second
        // fallback, and the duplicate-key reconciliation.
        let written = async {
            if !reserved && cooldown == 0.0 {
                match write_command_with_cooldown(store, channel_id, Some(&json!(0)), None, || {
                    insert_draft(store, &draft, now)
                })
                .await
                {
                    Ok(()) => Ok(()),
                    Err(CooldownError::Invalid(_)) => {
                        // Existing custom commands retain their slot when
                        // missing defaults are added.
                        let mut retry = draft.clone();
                        retry.insert("cooldown", js_number(5.0));
                        insert_draft(store, &retry, now).await
                    }
                    Err(CooldownError::Storage(error)) => Err(error),
                }
            } else {
                insert_draft(store, &draft, now).await
            }
        }
        .await;

        match written {
            Ok(()) => created += 1,
            Err(error) => {
                let duplicate = match &error {
                    CommandDefaultsError::Mongo(mongo) => is_duplicate_key_error(mongo),
                    _ => false,
                };
                if !duplicate {
                    return Err(error);
                }
                // A concurrent seeder inserted this `_id`. Only a matching row
                // makes the collision benign; anything else is re-thrown.
                let concurrent_seed = store
                    .commands
                    .find_one(doc! {"_id": id, "func": func, "channelID": channel_id})
                    .projection(doc! {"_id": 1})
                    .await?
                    .is_some();
                if !concurrent_seed {
                    return Err(error);
                }
            }
        }
    }
    Ok(created)
}

async fn insert_draft(
    store: &CommandDefaultsStore,
    draft: &Document,
    now: DateTime,
) -> Result<(), CommandDefaultsError> {
    // Mongoose `new Model(doc).save()`: schema defaults, casts and validators
    // for a new document, then a single insert. `prepare_insert` adds `__v: 0`
    // exactly as the source's save does.
    let document = commands::schema().prepare_insert(draft.clone(), now)?;
    store.commands.insert_one(document).await?;
    Ok(())
}

/// The explicit source document passed to `new CommandsSchema({...})`. Fields
/// the source leaves `undefined` are absent here so the schema applies the same
/// defaults; every number goes through the house JavaScript-number encoder.
fn default_command_draft(
    command: &Value,
    channel_id: &str,
    channel_name: &str,
    id: ObjectId,
    now: DateTime,
) -> Document {
    let mut draft = Document::new();
    draft.insert("_id", id);
    for field in ["name", "cmd"] {
        if let Some(value) = command.get(field).and_then(Value::as_str) {
            draft.insert(field, value);
        }
    }
    draft.insert(
        "func",
        command.get("func").and_then(Value::as_str).unwrap_or_default(),
    );
    if let Some(value) = command.get("type").and_then(Value::as_str) {
        draft.insert("type", value);
    }
    draft.insert("channel", channel_name);
    draft.insert("channelID", channel_id);
    if let Some(cooldown) = command
        .get("cooldown")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    {
        draft.insert("cooldown", js_number(cooldown));
    }
    if let Some(enabled) = command.get("enabled").and_then(Value::as_bool) {
        draft.insert("enabled", enabled);
    }
    let user_level = command
        .get("userLevel")
        .and_then(Value::as_f64)
        .filter(|value| *value != 0.0 && value.is_finite())
        .unwrap_or(0.0);
    draft.insert("userLevel", js_number(user_level));
    draft.insert(
        "userLevelName",
        command
            .get("userLevelName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("everyone"),
    );
    if let Some(reserved) = command.get("reserved").and_then(Value::as_bool) {
        draft.insert("reserved", reserved);
    }
    draft.insert(
        "message",
        command
            .get("message")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(""),
    );
    draft.insert("responses", Bson::Array(Vec::new()));
    draft.insert("paused", false);
    draft.insert("platform", "twitch");
    draft.insert("premiumRequired", false);
    draft.insert("premiumLevelRequired", js_number(0.0));
    draft.insert("createdAt", now);
    draft
}

/// The duplicate-key signal the source reconciles on: MongoDB error code
/// `11000` in any driver shape an insert can produce. Exposed so a disposable
/// database check can assert the classification without a private seam.
pub fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == DUPLICATE_KEY_CODE,
        ErrorKind::Command(command) => command.code == DUPLICATE_KEY_CODE,
        ErrorKind::BulkWrite(bulk) => bulk
            .write_errors
            .values()
            .any(|write| write.code == DUPLICATE_KEY_CODE),
        ErrorKind::InsertMany(batch) => batch
            .write_errors
            .as_ref()
            .is_some_and(|errors| errors.iter().any(|write| write.code == DUPLICATE_KEY_CODE)),
        _ => false,
    }
}
