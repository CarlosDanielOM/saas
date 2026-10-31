//! Native `Commands` CRUD/cache service, ported from
//! `src/classes/command.class.ts`.
//!
//! The cooldown policy, zero-slot lease and grandfathering live in
//! [`crate::utils::command_cooldown`]; this module only supplies the concrete
//! application adapter (owner plan from the shared Twitch directory, MongoDB
//! existence query, real Dragonfly lease commands). No parallel policy exists.
//!
//! Reads use the schema's default projection (hidden `blocks`, `availability`
//! and `availabilityLease` stay excluded) and then apply the schema's own read
//! defaults through `SchemaDefinition::hydrate`, matching hydrated Mongoose
//! documents without writing those defaults. Updates use the typed commands
//! repository so ordinary `enabled` edits replace availability schedules.
//!
//! Construction performs no I/O. [`Commands::new`] defers the pooled Dragonfly
//! connection until the first cache or lease operation; [`Commands::with_redis`]
//! accepts a caller-owned long-lived connection for application wiring and
//! fixture tests.

use std::{fmt, sync::Arc, time::Duration};

use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use serde_json::Value as JsonInput;
use tokio::sync::OnceCell;

use crate::{
    schemas::{FieldDefault, SchemaDefinition, ValidationErrors, commands::CommandsRepository},
    utils::{
        availability::{AvailabilityWriteError, QueryUpdate},
        bson_js_json::{BsonJsJsonError, bson_js_json_string},
        command_cooldown::{
            CooldownError, CooldownStore, CurrentCommand, write_command_with_cooldown,
        },
        logger::{
            ConfigError, Destination, Level, LogOptions, Logger, LoggerConfig, SinkHandles,
            StdConsole, SystemClock, UuidSource, redis::RedisCacheSink,
        },
        lossless_json::{JsonValue, parse_json},
        twitch_streamers::{DirectoryError, TwitchStreamers},
    },
};

/// Source cache lifetime (`Commands.CACHE_TTL`).
pub const CACHE_TTL_SECONDS: u64 = 3600;
const LOGGER_SINK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum CommandsError {
    Storage(AvailabilityWriteError),
    Mongo(mongodb::error::Error),
    Validation(ValidationErrors),
    Redis(redis::RedisError),
    RedisInit(String),
    Directory(DirectoryError),
    Wire(BsonJsJsonError),
    Json(String),
    InvalidData(&'static str),
}

impl fmt::Display for CommandsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => error.fmt(formatter),
            Self::Mongo(error) => error.fmt(formatter),
            Self::Validation(error) => error.fmt(formatter),
            Self::Redis(error) => error.fmt(formatter),
            Self::RedisInit(error) => formatter.write_str(error),
            Self::Directory(error) => error.fmt(formatter),
            Self::Wire(error) => error.fmt(formatter),
            Self::Json(error) => formatter.write_str(error),
            Self::InvalidData(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CommandsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            Self::Mongo(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::Redis(error) => Some(error),
            Self::RedisInit(_) => None,
            Self::Directory(error) => Some(error),
            Self::Wire(error) => Some(error),
            Self::Json(_) | Self::InvalidData(_) => None,
        }
    }
}

impl From<AvailabilityWriteError> for CommandsError {
    fn from(error: AvailabilityWriteError) -> Self {
        Self::Storage(error)
    }
}
impl From<mongodb::error::Error> for CommandsError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}
impl From<ValidationErrors> for CommandsError {
    fn from(error: ValidationErrors) -> Self {
        Self::Validation(error)
    }
}
impl From<redis::RedisError> for CommandsError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}
impl From<DirectoryError> for CommandsError {
    fn from(error: DirectoryError) -> Self {
        Self::Directory(error)
    }
}
impl From<BsonJsJsonError> for CommandsError {
    fn from(error: BsonJsJsonError) -> Self {
        Self::Wire(error)
    }
}

#[derive(Clone, Debug)]
pub struct CommandCreateResponse {
    pub error: bool,
    pub created: Option<bool>,
    pub command: Option<JsonValue>,
    pub message: String,
    pub status: u16,
    pub type_name: String,
}

#[derive(Clone, Debug)]
pub struct CommandDeleteResponse {
    pub error: bool,
    pub deleted: Option<bool>,
    pub command: Option<JsonValue>,
    pub message: String,
    pub status: u16,
    pub type_name: String,
}

#[derive(Clone, Debug)]
pub struct CommandGetResponse {
    pub error: bool,
    pub command: Option<JsonValue>,
    pub message: String,
    pub status: u16,
    pub type_name: String,
}

#[derive(Clone, Debug)]
pub struct CommandUpdateResponse {
    pub error: bool,
    pub message: String,
    pub status: u16,
    pub type_name: String,
}

#[derive(Clone, Debug)]
pub struct CommandExistsResponse {
    pub error: bool,
    pub command: Option<JsonValue>,
    pub message: String,
    pub status: u16,
    pub type_name: String,
}

impl CommandCreateResponse {
    fn error(message: impl Into<String>, status: u16, type_name: impl Into<String>) -> Self {
        Self {
            error: true,
            created: None,
            command: None,
            message: message.into(),
            status,
            type_name: type_name.into(),
        }
    }
    fn invalid(message: String) -> Self {
        Self::error(message, 400, "invalid_cooldown")
    }
}

impl CommandDeleteResponse {
    fn error(message: impl Into<String>, status: u16, type_name: impl Into<String>) -> Self {
        Self {
            error: true,
            deleted: None,
            command: None,
            message: message.into(),
            status,
            type_name: type_name.into(),
        }
    }
}

impl CommandGetResponse {
    fn error(message: impl Into<String>, status: u16, type_name: impl Into<String>) -> Self {
        Self {
            error: true,
            command: None,
            message: message.into(),
            status,
            type_name: type_name.into(),
        }
    }
}

impl CommandUpdateResponse {
    fn error(message: impl Into<String>, status: u16, type_name: impl Into<String>) -> Self {
        Self {
            error: true,
            message: message.into(),
            status,
            type_name: type_name.into(),
        }
    }
}

impl CommandExistsResponse {
    fn error(message: impl Into<String>, status: u16, type_name: impl Into<String>) -> Self {
        Self {
            error: true,
            command: None,
            message: message.into(),
            status,
            type_name: type_name.into(),
        }
    }
}

/// Source has one lazy Dragonfly client per class instance. The shared native
/// manager is already pooled; this cell keeps acquisition lazy and injectable.
#[derive(Clone)]
struct LazyRedis {
    connection: Arc<OnceCell<Result<redis::aio::ConnectionManager, String>>>,
}

impl Default for LazyRedis {
    fn default() -> Self {
        Self {
            connection: Arc::new(OnceCell::new()),
        }
    }
}

impl LazyRedis {
    fn injected(connection: redis::aio::ConnectionManager) -> Self {
        let cell = OnceCell::new();
        let _ = cell.set(Ok(connection));
        Self {
            connection: Arc::new(cell),
        }
    }

    async fn get(&self) -> Result<redis::aio::ConnectionManager, CommandsError> {
        let cell = Arc::clone(&self.connection);
        // The class-level promise caches a failed initialization as well, so a
        // rejected lazy client is not retried inside the same Commands instance.
        let value = cell
            .get_or_init(|| async {
                crate::utils::redis::get_redis_client()
                    .await
                    .map_err(|error| error.to_string())
            })
            .await;
        value.clone().map_err(CommandsError::RedisInit)
    }
}

/// Closed Redis cache used by the concrete logger helper.
pub fn redis_logger(connection: redis::aio::ConnectionManager) -> Result<Logger, ConfigError> {
    let sink = RedisCacheSink::new(connection, LOGGER_SINK_TIMEOUT)?;
    Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            cache: Some(Arc::new(sink)),
            console: Some(Arc::new(StdConsole)),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
}

/// Instance-equivalent replacement for the exported TypeScript singleton.
#[derive(Clone)]
pub struct Commands {
    commands: CommandsRepository,
    directory: Arc<TwitchStreamers>,
    cache: LazyRedis,
    logger: Logger,
}

/// Explicit alias for callers that prefer a service name.
pub type CommandsService = Commands;

impl Commands {
    /// Explicit application factory. Creates no connection and performs no I/O.
    pub fn new(
        commands: CommandsRepository,
        directory: Arc<TwitchStreamers>,
        logger: Logger,
    ) -> Self {
        Self {
            commands,
            directory,
            cache: LazyRedis::default(),
            logger,
        }
    }

    /// Application/test factory with an existing pooled Dragonfly connection.
    pub fn with_redis(
        commands: CommandsRepository,
        directory: Arc<TwitchStreamers>,
        connection: redis::aio::ConnectionManager,
        logger: Logger,
    ) -> Self {
        Self {
            commands,
            directory,
            cache: LazyRedis::injected(connection),
            logger,
        }
    }

    pub fn repository(&self) -> &CommandsRepository {
        &self.commands
    }

    pub async fn create_command(
        &self,
        channel_id: &str,
        command: Document,
    ) -> CommandCreateResponse {
        match self.create_command_inner(channel_id, command).await {
            Ok(response) => response,
            Err(error) => {
                self.log_failure("Commands.createCommand", channel_id, None, &error)
                    .await;
                CommandCreateResponse::error(
                    "Error creating command",
                    500,
                    "error_creating_command",
                )
            }
        }
    }

    pub async fn delete_command(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> CommandDeleteResponse {
        match self.delete_command_inner(channel_id, command_cmd).await {
            Ok(response) => response,
            Err(error) => {
                self.log_failure("Commands.deleteCommand", channel_id, None, &error)
                    .await;
                CommandDeleteResponse::error(
                    "Error deleting command",
                    500,
                    "error_deleting_command",
                )
            }
        }
    }

    pub async fn get_command_from_db(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> CommandGetResponse {
        match self.get_command_inner(channel_id, command_cmd, false).await {
            Ok(response) => response,
            Err(error) => {
                self.log_failure("Commands.getCommandFromDB", channel_id, None, &error)
                    .await;
                CommandGetResponse::error(
                    "Error retrieving command",
                    500,
                    "error_retrieving_command",
                )
            }
        }
    }

    pub async fn get_reserved_command_from_db(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> CommandGetResponse {
        match self.get_command_inner(channel_id, command_cmd, true).await {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(
                    "Commands.getReservedCommandFromDB",
                    channel_id,
                    None,
                    &error,
                )
                .await;
                CommandGetResponse::error(
                    "Error retrieving reserved command",
                    500,
                    "error_retrieving_command",
                )
            }
        }
    }

    pub async fn check_if_command_exists(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> CommandExistsResponse {
        match self
            .check_command_inner(channel_id, command_cmd, false)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.log_failure("Commands.checkIfCommandExists", channel_id, None, &error)
                    .await;
                CommandExistsResponse::error(
                    "Error checking command",
                    500,
                    "error_checking_command",
                )
            }
        }
    }

    pub async fn check_if_reserved_command_exists(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> CommandExistsResponse {
        match self
            .check_command_inner(channel_id, command_cmd, true)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(
                    "Commands.checkIfReservedCommandExists",
                    channel_id,
                    None,
                    &error,
                )
                .await;
                CommandExistsResponse::error(
                    "Error checking command",
                    500,
                    "error_checking_command",
                )
            }
        }
    }

    pub async fn update_command_in_db(
        &self,
        channel_id: &str,
        command_cmd: &str,
        update_data: Document,
    ) -> CommandUpdateResponse {
        match self
            .update_command_inner(channel_id, command_cmd, update_data)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.log_failure("Commands.updateCommandInDB", channel_id, None, &error)
                    .await;
                CommandUpdateResponse::error(
                    "Error updating command",
                    500,
                    "error_updating_command",
                )
            }
        }
    }

    pub async fn update_countable_command_in_db(
        &self,
        channel_id: &str,
        command_cmd: &str,
        count_data: f64,
    ) -> CommandUpdateResponse {
        match self
            .update_countable_inner(channel_id, command_cmd, count_data)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(
                    "Commands.updateCountableCommandInDB",
                    channel_id,
                    None,
                    &error,
                )
                .await;
                CommandUpdateResponse::error(
                    "Error updating command",
                    500,
                    "error_updating_command",
                )
            }
        }
    }

    pub async fn update_command_availability(
        &self,
        channel_id: &str,
        command_cmd: &str,
        availability: bool,
    ) -> CommandUpdateResponse {
        match self
            .update_availability_inner(channel_id, command_cmd, availability)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(
                    "Commands.updateCommandAvailability",
                    channel_id,
                    None,
                    &error,
                )
                .await;
                CommandUpdateResponse::error(
                    "Error updating command",
                    500,
                    "error_updating_command",
                )
            }
        }
    }

    async fn create_command_inner(
        &self,
        channel_id: &str,
        command: Document,
    ) -> Result<CommandCreateResponse, CommandsError> {
        let cmd_text = js_text(command.get("cmd"));
        let mut existence = doc! {"channelID": channel_id, "activation": {"$ne": "keyword"}};
        if let Some(cmd) = command.get("cmd") {
            existence.insert("cmd", cmd.clone());
        }
        if self
            .commands
            .find_one(existence)
            .await
            .map_err(CommandsError::Storage)?
            .is_some()
        {
            return Ok(CommandCreateResponse::error(
                "Command already exists",
                400,
                "command_already_exists",
            ));
        }
        let now = DateTime::now();
        // Construction casts/defaults cooldown before the policy; validation
        // of all fields happens later, inside the guarded save callback.
        let schema = self.commands.schema();
        let default_cooldown = || {
            schema
                .fields
                .iter()
                .find(|field| field.name == "cooldown")
                .and_then(|field| match &field.default {
                    FieldDefault::Number(value) => {
                        Some(crate::utils::bson_compat::js_number(*value))
                    }
                    _ => None,
                })
        };
        let cast_cooldown = match command.get("cooldown") {
            None | Some(Bson::Undefined) => default_cooldown(),
            Some(value) => schema
                .cast_update_path("cooldown", value.clone(), now)
                .ok()
                .flatten()
                .or_else(default_cooldown),
        };
        let cooldown = cooldown_input(cast_cooldown.as_ref());
        let service = self;
        let outcome = write_command_with_cooldown(
            service,
            channel_id,
            cooldown.as_ref(),
            None,
            move || async move {
                service
                    .commands
                    .insert(command, now)
                    .await
                    .map_err(CommandsError::Storage)
            },
        )
        .await;
        let saved = match outcome {
            Ok(saved) => saved,
            Err(CooldownError::Invalid(message)) => {
                return Ok(CommandCreateResponse::invalid(message));
            }
            Err(CooldownError::Storage(error)) => return Err(error),
        };
        let text = wire_string(&saved)?;
        let wire = parse_json(&text).map_err(CommandsError::Json)?;
        self.cache_set(&cache_key(channel_id, &cmd_text), &text)
            .await?;
        Ok(CommandCreateResponse {
            error: false,
            created: Some(true),
            command: Some(wire),
            message: "Command created successfully".into(),
            status: 200,
            type_name: "command_created".into(),
        })
    }

    async fn delete_command_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
    ) -> Result<CommandDeleteResponse, CommandsError> {
        let Some(raw) = self.find_editable(channel_id, command_cmd, false).await? else {
            return Ok(CommandDeleteResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let id = object_id(&raw)?;
        let hydrated = self.hydrate_read(raw)?;
        self.commands
            .collection()
            .delete_one(doc! {"_id": id})
            .await
            .map_err(CommandsError::Mongo)?;
        self.invalidate_cache(channel_id, command_cmd).await;
        Ok(CommandDeleteResponse {
            error: false,
            deleted: Some(true),
            command: Some(wire_document(&hydrated)?),
            message: "Command deleted successfully".into(),
            status: 200,
            type_name: "command_deleted".into(),
        })
    }

    async fn get_command_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
        reserved: bool,
    ) -> Result<CommandGetResponse, CommandsError> {
        let key = cache_key(channel_id, command_cmd);
        if let Some(cached) = self.cache_get(&key).await?
            && !cached.is_empty()
        {
            let wire = parse_json(&cached).map_err(CommandsError::Json)?;
            return Ok(CommandGetResponse {
                error: false,
                command: Some(wire),
                message: if reserved {
                    "Reserved command retrieved from cache"
                } else {
                    "Command retrieved from cache"
                }
                .into(),
                status: 200,
                type_name: "command_retrieved".into(),
            });
        }
        let Some(raw) = self
            .find_editable(channel_id, command_cmd, reserved)
            .await?
        else {
            return Ok(CommandGetResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let hydrated = self.hydrate_read(raw)?;
        let text = wire_string(&hydrated)?;
        let wire = parse_json(&text).map_err(CommandsError::Json)?;
        self.cache_set(&key, &text).await?;
        Ok(CommandGetResponse {
            error: false,
            command: Some(wire),
            message: if reserved {
                "Reserved command retrieved"
            } else {
                "Command retrieved"
            }
            .into(),
            status: 200,
            type_name: "command_retrieved".into(),
        })
    }

    async fn check_command_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
        reserved: bool,
    ) -> Result<CommandExistsResponse, CommandsError> {
        let key = cache_key(channel_id, command_cmd);
        if let Some(cached) = self.cache_get(&key).await?
            && !cached.is_empty()
        {
            let wire = parse_json(&cached).map_err(CommandsError::Json)?;
            return Ok(CommandExistsResponse {
                error: false,
                command: Some(wire),
                message: if reserved {
                    "Reserved command exists"
                } else {
                    "Command exists"
                }
                .into(),
                status: 200,
                type_name: "command_exists".into(),
            });
        }
        let Some(raw) = self
            .find_editable(channel_id, command_cmd, reserved)
            .await?
        else {
            return Ok(CommandExistsResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let hydrated = self.hydrate_read(raw)?;
        let text = wire_string(&hydrated)?;
        let wire = parse_json(&text).map_err(CommandsError::Json)?;
        self.cache_set(&key, &text).await?;
        Ok(CommandExistsResponse {
            error: false,
            command: Some(wire),
            message: if reserved {
                "Reserved command exists"
            } else {
                "Command exists"
            }
            .into(),
            status: 200,
            type_name: "command_exists".into(),
        })
    }

    async fn update_command_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
        update_data: Document,
    ) -> Result<CommandUpdateResponse, CommandsError> {
        let Some(raw) = self.find_editable(channel_id, command_cmd, false).await? else {
            return Ok(CommandUpdateResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let id = object_id(&raw)?;
        let hydrated = self.hydrate_read(raw)?;
        let mut current = current_command(&hydrated)?;
        current.reserved =
            current.reserved && !matches!(update_data.get("reserved"), Some(Bson::Boolean(false)));
        let cooldown = cooldown_input(update_data.get("cooldown"));
        let service = self;
        let outcome = write_command_with_cooldown(
            service,
            channel_id,
            cooldown.as_ref(),
            Some(&current),
            move || async move {
                let query = QueryUpdate::from_bson(Some(Bson::Document(update_data)))
                    .map_err(CommandsError::Storage)?;
                service
                    .commands
                    .update_one(doc! {"_id": id}, query)
                    .await
                    .map_err(CommandsError::Storage)
            },
        )
        .await;
        match outcome {
            Ok(_) => {
                self.invalidate_cache(channel_id, command_cmd).await;
                Ok(CommandUpdateResponse {
                    error: false,
                    message: "Command updated".into(),
                    status: 200,
                    type_name: "command_updated".into(),
                })
            }
            Err(CooldownError::Invalid(message)) => Ok(CommandUpdateResponse::error(
                message,
                400,
                "invalid_cooldown",
            )),
            Err(CooldownError::Storage(error)) => Err(error),
        }
    }

    async fn update_countable_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
        count_data: f64,
    ) -> Result<CommandUpdateResponse, CommandsError> {
        let Some(raw) = self.find_editable(channel_id, command_cmd, false).await? else {
            return Ok(CommandUpdateResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let id = object_id(&raw)?;
        let query = QueryUpdate::from_bson(Some(Bson::Document(doc! {"count": count_data})))
            .map_err(CommandsError::Storage)?;
        self.commands
            .update_one(doc! {"_id": id}, query)
            .await
            .map_err(CommandsError::Storage)?;
        self.invalidate_cache(channel_id, command_cmd).await;
        Ok(CommandUpdateResponse {
            error: false,
            message: "Command count updated".into(),
            status: 200,
            type_name: "command_updated".into(),
        })
    }

    async fn update_availability_inner(
        &self,
        channel_id: &str,
        command_cmd: &str,
        availability: bool,
    ) -> Result<CommandUpdateResponse, CommandsError> {
        let Some(raw) = self.find_editable(channel_id, command_cmd, false).await? else {
            return Ok(CommandUpdateResponse::error(
                "Command does not exist",
                400,
                "command_does_not_exist",
            ));
        };
        let id = object_id(&raw)?;
        let query = QueryUpdate::from_bson(Some(Bson::Document(doc! {"enabled": availability})))
            .map_err(CommandsError::Storage)?;
        self.commands
            .update_one(doc! {"_id": id}, query)
            .await
            .map_err(CommandsError::Storage)?;
        self.invalidate_cache(channel_id, command_cmd).await;
        Ok(CommandUpdateResponse {
            error: false,
            message: if availability {
                "Command enabled"
            } else {
                "Command disabled"
            }
            .into(),
            status: 200,
            type_name: "command_updated".into(),
        })
    }

    async fn find_editable(
        &self,
        channel_id: &str,
        command_cmd: &str,
        reserved: bool,
    ) -> Result<Option<Document>, CommandsError> {
        let mut filter = doc! {
            "channelID": channel_id,
            "activation": {"$ne": "keyword"},
            "cmd": command_cmd,
        };
        if reserved {
            filter.insert("reserved", true);
        }
        self.commands
            .find_one(filter)
            .await
            .map_err(CommandsError::Storage)
    }

    /// Apply hydrated-Mongoose read defaults to the projected document without
    /// writing them. Hidden fields stay excluded unless the caller loaded them.
    fn hydrate_read(&self, projected: Document) -> Result<Document, CommandsError> {
        let schema: &'static SchemaDefinition = self.commands.schema();
        let mut hydrated = schema.hydrate(&projected, DateTime::now())?;
        for field in schema.fields.iter().filter(|field| field.hidden) {
            if !projected.contains_key(field.name) {
                hydrated.remove(field.name);
            }
        }
        Ok(hydrated)
    }

    async fn cache_get(&self, key: &str) -> Result<Option<String>, CommandsError> {
        let mut connection = self.cache.get().await?;
        redis::cmd("GET")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(CommandsError::Redis)
    }

    async fn cache_set(&self, key: &str, value: &str) -> Result<(), CommandsError> {
        let mut connection = self.cache.get().await?;
        redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(CACHE_TTL_SECONDS)
            .query_async::<()>(&mut connection)
            .await
            .map_err(CommandsError::Redis)
    }

    async fn cache_del(&self, key: &str) -> Result<(), CommandsError> {
        let mut connection = self.cache.get().await?;
        redis::cmd("DEL")
            .arg(key)
            .query_async::<i64>(&mut connection)
            .await
            .map_err(CommandsError::Redis)?;
        Ok(())
    }

    async fn invalidate_cache(&self, channel_id: &str, command_cmd: &str) {
        let key = cache_key(channel_id, command_cmd);
        if let Err(error) = self.cache_del(&key).await {
            self.log_failure(
                "Commands.invalidateCache",
                channel_id,
                Some(command_cmd),
                &error,
            )
            .await;
        }
    }

    async fn log_failure(
        &self,
        function: &str,
        channel_id: &str,
        command_cmd: Option<&str>,
        error: &CommandsError,
    ) {
        let mut fields = serde_json::Map::new();
        fields.insert("function".into(), JsonInput::String(function.into()));
        match command_cmd {
            Some(cmd) => {
                fields.insert("cmd".into(), JsonInput::String(cmd.into()));
            }
            None => {
                fields.insert("channelID".into(), JsonInput::String(channel_id.into()));
            }
        }
        fields.insert("error".into(), JsonInput::String(error.to_string()));
        let _ = self
            .logger
            .log(
                Level::Error,
                JsonInput::Object(fields),
                LogOptions {
                    destination: Destination::Both,
                    channel_id: Some(channel_id.to_owned()),
                    ..LogOptions::default()
                },
            )
            .await;
    }
}

impl CooldownStore for Commands {
    type Error = CommandsError;

    async fn owner_plan(&self, channel_id: &str) -> Result<Option<String>, Self::Error> {
        match self.directory.account_by_id(channel_id).await {
            Ok(account) => Ok(Some(account.metadata.plan_tier)),
            Err(DirectoryError::Missing) => Ok(None),
            Err(error) => Err(CommandsError::Directory(error)),
        }
    }

    async fn acquire_lease(
        &self,
        key: &str,
        token: &str,
        ttl_seconds: u64,
    ) -> Result<bool, Self::Error> {
        let mut connection = self.cache.get().await?;
        let reply: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(token)
            .arg("NX")
            .arg("EX")
            .arg(ttl_seconds)
            .query_async(&mut connection)
            .await
            .map_err(CommandsError::Redis)?;
        Ok(reply.is_some())
    }

    async fn editable_zero_exists(
        &self,
        channel_id: &str,
        exclude_id: Option<&str>,
    ) -> Result<bool, Self::Error> {
        let mut filter = doc! {
            "channelID": channel_id,
            "cooldown": 0.0,
            "reserved": {"$ne": true},
        };
        if let Some(id) = exclude_id.filter(|id| !id.is_empty()) {
            let id = ObjectId::parse_str(id).map_err(|_| {
                CommandsError::InvalidData("current command _id is not an ObjectId")
            })?;
            filter.insert("_id", doc! {"$ne": id});
        }
        Ok(self
            .commands
            .find_one(filter)
            .await
            .map_err(CommandsError::Storage)?
            .is_some())
    }

    async fn release_lease(&self, key: &str, token: &str) -> Result<(), Self::Error> {
        let mut connection = self.cache.get().await?;
        redis::cmd("EVAL")
            .arg(crate::utils::command_cooldown::RELEASE_LEASE_SCRIPT)
            .arg(1)
            .arg(key)
            .arg(token)
            .query_async::<i64>(&mut connection)
            .await
            .map_err(CommandsError::Redis)?;
        Ok(())
    }
}

fn cache_key(channel_id: &str, command_cmd: &str) -> String {
    format!("{channel_id}:commands:{command_cmd}")
}

fn object_id(document: &Document) -> Result<ObjectId, CommandsError> {
    document
        .get_object_id("_id")
        .ok()
        .ok_or(CommandsError::InvalidData("command _id is not an ObjectId"))
}

fn current_command(document: &Document) -> Result<CurrentCommand, CommandsError> {
    Ok(CurrentCommand {
        id: Some(object_id(document)?.to_hex()),
        cooldown: bson_number(document.get("cooldown")),
        reserved: document.get_bool("reserved").unwrap_or(false),
    })
}

fn bson_number(value: Option<&Bson>) -> Option<f64> {
    match value? {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) => Some(*value),
        _ => None,
    }
}

fn cooldown_input(value: Option<&Bson>) -> Option<JsonInput> {
    match value {
        None => None,
        Some(Bson::Null) => Some(JsonInput::Null),
        Some(Bson::Int32(value)) => Some(JsonInput::from(*value)),
        Some(Bson::Int64(value)) => Some(JsonInput::from(*value)),
        Some(Bson::Double(value)) => Some(
            serde_json::Number::from_f64(*value)
                .map(JsonInput::Number)
                .unwrap_or(JsonInput::Null),
        ),
        Some(Bson::String(value)) => Some(JsonInput::String(value.clone())),
        Some(Bson::Boolean(value)) => Some(JsonInput::Bool(*value)),
        Some(value) => Some(JsonInput::String(format!("{value:?}"))),
    }
}

/// JavaScript template-string rendering for the create cache key.
fn js_text(value: Option<&Bson>) -> String {
    match value {
        None => "undefined".into(),
        Some(Bson::String(value)) => value.clone(),
        Some(Bson::Null) => "null".into(),
        Some(Bson::Boolean(value)) => value.to_string(),
        Some(Bson::Int32(value)) => value.to_string(),
        Some(Bson::Int64(value)) => value.to_string(),
        Some(Bson::Double(value)) => crate::utils::json_number::number_string(*value),
        Some(Bson::ObjectId(value)) => value.to_hex(),
        Some(value) => bson_js_json_string(value).unwrap_or_default(),
    }
}

fn wire_document(document: &Document) -> Result<JsonValue, CommandsError> {
    let text = wire_string(document)?;
    parse_json(&text).map_err(CommandsError::Json)
}

/// Mongoose's JSON conversion minimizes empty ordinary objects, but preserves
/// map defaults and empty objects that are array elements. This affects only
/// the serialized view; it must never rewrite the stored Mixed values.
fn wire_string(document: &Document) -> Result<String, CommandsError> {
    fn minimize(value: Bson, array_item: bool) -> Option<Bson> {
        match value {
            Bson::Document(document) => {
                let mut result = Document::new();
                for (key, value) in document {
                    if let Some(value) = minimize(value, false) {
                        result.insert(key, value);
                    }
                }
                if result.is_empty() && !array_item {
                    None
                } else {
                    Some(Bson::Document(result))
                }
            }
            Bson::Array(values) => Some(Bson::Array(
                values
                    .into_iter()
                    .filter_map(|value| minimize(value, true))
                    .collect(),
            )),
            other => Some(other),
        }
    }
    let mut output = Document::new();
    for (key, value) in document {
        let value = if key == "variables" {
            Some(value.clone())
        } else {
            minimize(value.clone(), false)
        };
        if let Some(value) = value {
            output.insert(key, value);
        }
    }
    Ok(bson_js_json_string(&Bson::Document(output))?)
}
