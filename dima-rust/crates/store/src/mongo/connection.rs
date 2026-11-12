//! The MongoDB connection: one client per process, built from a configuration struct, and a
//! cheap cloneable handle to its database.
//!
//! The reference opens one connection with `mongoose.connect(MONGO_URI, { monitorCommands:
//! true })` (`dimabot/src/utils/databases/mongodb.database.ts:30`) and nothing else, so the
//! driver options are the URI's, then the Node driver's defaults. Where the Rust driver's
//! defaults differ they are set here to the Node values, unless the URI sets them:
//!
//! | option | Node driver 6.20 | Rust driver | here |
//! |---|---|---|---|
//! | `maxPoolSize` | 100 | 10 | 100 |
//! | `connectTimeoutMS` | 30000 | 10000 | 30000 |
//! | `serverSelectionTimeoutMS` | 30000 | 30000 | 30000 |
//! | default database (no path in the URI) | `test` | none | `test` |
//!
//! `socketTimeoutMS` (Node default 0, no timeout) has no Rust equivalent; retryable reads and
//! writes are on in both. [`MongoStore::connect`] waits for the first server like
//! `mongoose.connect` does (a `ping`, bounded by server selection). Configuration is read from
//! the environment by the binary, never here.

use crate::mongo::error::MongoError;
use crate::mongo::write::{DroppedPathPolicy, DroppedPaths};
use bson::{Document, doc};
use mongodb::event::EventHandler;
use mongodb::event::command::CommandEvent;
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Node driver default pool size.
pub const DEFAULT_MAX_POOL_SIZE: u32 = 100;
/// Node driver default connect timeout.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Node driver default server selection timeout.
pub const DEFAULT_SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(30);
/// The database the Node driver uses when the URI names none.
pub const DEFAULT_DATABASE: &str = "test";

/// Commands the reference's monitoring ignores (`mongodb.database.ts`); they never reach a
/// [`CommandHook`].
pub const UNMONITORED_COMMANDS: [&str; 6] = [
    "hello",
    "isMaster",
    "saslStart",
    "saslContinue",
    "authenticate",
    "endSessions",
];

/// How many started commands are remembered to give their collection to the finish event
/// (the reference keeps at most 1000 open spans).
const MAX_PENDING: usize = 1000;

/// How to connect. Every `None` means "the URI's value, else the Node driver default".
#[derive(Clone)]
pub struct MongoConfig {
    /// The connection string (`MONGO_URI`). Never printed: it holds credentials.
    pub uri: String,
    /// The database to use instead of the URI's.
    pub database: Option<String>,
    /// `appName` reported to the server.
    pub app_name: Option<String>,
    /// Server selection timeout.
    pub server_selection_timeout: Option<Duration>,
    /// Connect timeout.
    pub connect_timeout: Option<Duration>,
    /// Pool size.
    pub max_pool_size: Option<u32>,
}

impl MongoConfig {
    /// A configuration for `uri` with every other option left to the URI and the defaults.
    pub fn new(uri: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            database: None,
            app_name: None,
            server_selection_timeout: None,
            connect_timeout: None,
            max_pool_size: None,
        }
    }
}

impl fmt::Debug for MongoConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MongoConfig")
            .field("uri", &"<redacted>")
            .field("database", &self.database)
            .field("app_name", &self.app_name)
            .field("server_selection_timeout", &self.server_selection_timeout)
            .field("connect_timeout", &self.connect_timeout)
            .field("max_pool_size", &self.max_pool_size)
            .finish()
    }
}

/// A command that started.
#[derive(Clone, Copy, Debug)]
pub struct CommandStarted<'a> {
    /// The driver's request id, shared with the finish event.
    pub request_id: i32,
    /// `find`, `update`, `aggregate`...
    pub command_name: &'a str,
    /// The database.
    pub database: &'a str,
    /// The collection, when the command names one.
    pub collection: Option<&'a str>,
}

/// A command that succeeded.
#[derive(Clone, Copy, Debug)]
pub struct CommandSucceeded<'a> {
    /// The driver's request id.
    pub request_id: i32,
    /// The command name.
    pub command_name: &'a str,
    /// The collection from the start event, when it was remembered.
    pub collection: Option<&'a str>,
    /// Round-trip time.
    pub duration: Duration,
}

/// A command that failed.
#[derive(Clone, Copy, Debug)]
pub struct CommandFailed<'a> {
    /// The driver's request id.
    pub request_id: i32,
    /// The command name.
    pub command_name: &'a str,
    /// The collection from the start event, when it was remembered.
    pub collection: Option<&'a str>,
    /// Time until the failure.
    pub duration: Duration,
    /// The server error code, when there is one.
    pub code: Option<i32>,
}

/// Command monitoring for telemetry (the reference opens a span per command). Called on the
/// driver's threads: keep it quick and non-blocking. Every method defaults to doing nothing.
pub trait CommandHook: Send + Sync + 'static {
    /// A command was sent.
    fn started(&self, _event: &CommandStarted<'_>) {}
    /// A command succeeded.
    fn succeeded(&self, _event: &CommandSucceeded<'_>) {}
    /// A command failed.
    fn failed(&self, _event: &CommandFailed<'_>) {}
    /// A write named paths the schema does not know and ran anyway
    /// ([`DroppedPathPolicy::Report`]): a mistake in the caller, to be logged.
    fn dropped_paths(&self, _event: &DroppedPaths<'_>) {}
}

/// The connected database: cheap to clone, shared by every task.
#[derive(Clone)]
pub struct MongoStore {
    client: Client,
    database: Database,
    hook: Option<Arc<dyn CommandHook>>,
    dropped_paths: DroppedPathPolicy,
}

impl fmt::Debug for MongoStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MongoStore")
            .field("database", &self.database.name())
            .field("hook", &self.hook.is_some())
            .field("dropped_paths", &self.dropped_paths)
            .finish()
    }
}

impl MongoStore {
    /// Connects and waits until a server answers (like `mongoose.connect`). Errors never contain
    /// the URI.
    pub async fn connect(
        config: &MongoConfig,
        hook: Option<Arc<dyn CommandHook>>,
    ) -> Result<Self, MongoError> {
        if config.uri.trim().is_empty() {
            return Err(MongoError::Config("the MongoDB URI is empty"));
        }
        let mut options = ClientOptions::parse(&config.uri).await.map_err(|_| {
            MongoError::Config("the MongoDB URI is not a usable connection string (value omitted)")
        })?;
        apply_config(&mut options, config);
        if let Some(hook) = &hook {
            options.command_event_handler = Some(monitor(Arc::clone(hook)));
        }
        let database_name = config
            .database
            .clone()
            .or_else(|| options.default_database.clone())
            .unwrap_or_else(|| DEFAULT_DATABASE.to_owned());
        let client = Client::with_options(options)?;
        let database = client.database(&database_name);
        let store = Self {
            client,
            database,
            hook,
            dropped_paths: DroppedPathPolicy::default(),
        };
        store.ping().await?;
        Ok(store)
    }

    /// The same store with another [`DroppedPathPolicy`] for its [`crate::mongo::write`]s
    /// (the default fails in debug builds and reports in release builds).
    pub fn with_dropped_path_policy(mut self, policy: DroppedPathPolicy) -> Self {
        self.dropped_paths = policy;
        self
    }

    /// The store's [`DroppedPathPolicy`].
    pub fn dropped_path_policy(&self) -> DroppedPathPolicy {
        self.dropped_paths
    }

    /// The telemetry hook given to [`MongoStore::connect`].
    pub fn hook(&self) -> Option<&dyn CommandHook> {
        self.hook.as_deref()
    }

    /// The driver client (sessions, other databases).
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// The database.
    pub fn database(&self) -> &Database {
        &self.database
    }

    /// A typed collection.
    pub fn collection<T: Send + Sync>(&self, name: &str) -> Collection<T> {
        self.database.collection(name)
    }

    /// An untyped collection.
    pub fn documents(&self, name: &str) -> Collection<Document> {
        self.database.collection(name)
    }

    /// `ping` on the `admin` database.
    pub async fn ping(&self) -> Result<(), MongoError> {
        self.client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await?;
        Ok(())
    }

    /// Closes the pool, waiting for checked-out connections and sessions to come back.
    pub async fn shutdown(self) {
        self.client.shutdown().await;
    }
}

fn apply_config(options: &mut ClientOptions, config: &MongoConfig) {
    if let Some(name) = &config.app_name {
        options.app_name = Some(name.clone());
    }
    options.server_selection_timeout = config
        .server_selection_timeout
        .or(options.server_selection_timeout)
        .or(Some(DEFAULT_SERVER_SELECTION_TIMEOUT));
    options.connect_timeout = config
        .connect_timeout
        .or(options.connect_timeout)
        .or(Some(DEFAULT_CONNECT_TIMEOUT));
    options.max_pool_size = config
        .max_pool_size
        .or(options.max_pool_size)
        .or(Some(DEFAULT_MAX_POOL_SIZE));
}

/// The collection a command names: the value of its first field, or `collection` for `getMore`.
fn command_collection(command_name: &str, command: &Document) -> Option<String> {
    let field = if command_name == "getMore" {
        "collection"
    } else {
        command_name
    };
    command.get_str(field).ok().map(str::to_owned)
}

fn monitor(hook: Arc<dyn CommandHook>) -> EventHandler<CommandEvent> {
    let pending: Arc<Mutex<HashMap<i32, String>>> = Arc::new(Mutex::new(HashMap::new()));
    EventHandler::callback(move |event| {
        let take = |request_id: i32| {
            pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&request_id))
        };
        match event {
            CommandEvent::Started(started) => {
                if UNMONITORED_COMMANDS.contains(&started.command_name.as_str()) {
                    return;
                }
                let collection = command_collection(&started.command_name, &started.command);
                if let (Some(name), Ok(mut map)) = (&collection, pending.lock())
                    && map.len() < MAX_PENDING
                {
                    map.insert(started.request_id, name.clone());
                }
                hook.started(&CommandStarted {
                    request_id: started.request_id,
                    command_name: &started.command_name,
                    database: &started.db,
                    collection: collection.as_deref(),
                });
            }
            CommandEvent::Succeeded(done) => {
                if UNMONITORED_COMMANDS.contains(&done.command_name.as_str()) {
                    return;
                }
                let collection = take(done.request_id);
                hook.succeeded(&CommandSucceeded {
                    request_id: done.request_id,
                    command_name: &done.command_name,
                    collection: collection.as_deref(),
                    duration: done.duration,
                });
            }
            CommandEvent::Failed(failed) => {
                if UNMONITORED_COMMANDS.contains(&failed.command_name.as_str()) {
                    return;
                }
                let collection = take(failed.request_id);
                hook.failed(&CommandFailed {
                    request_id: failed.request_id,
                    command_name: &failed.command_name,
                    collection: collection.as_deref(),
                    duration: failed.duration,
                    code: crate::mongo::error::server_code(&failed.failure),
                });
            }
            _ => {}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_never_prints_the_uri() {
        let config = MongoConfig::new("mongodb://user:secret@host/db");
        assert!(!format!("{config:?}").contains("secret"));
    }

    #[tokio::test]
    async fn options_follow_uri_then_node_defaults() -> Result<(), Box<dyn std::error::Error>> {
        let mut options = ClientOptions::parse("mongodb://127.0.0.1:1/?maxPoolSize=7").await?;
        apply_config(&mut options, &MongoConfig::new("ignored"));
        assert_eq!(options.max_pool_size, Some(7));
        assert_eq!(options.connect_timeout, Some(DEFAULT_CONNECT_TIMEOUT));
        assert_eq!(
            options.server_selection_timeout,
            Some(DEFAULT_SERVER_SELECTION_TIMEOUT)
        );
        let mut options = ClientOptions::parse("mongodb://127.0.0.1:1/").await?;
        let config = MongoConfig {
            connect_timeout: Some(Duration::from_secs(2)),
            app_name: Some("dima-cron".into()),
            ..MongoConfig::new("x")
        };
        apply_config(&mut options, &config);
        assert_eq!(options.max_pool_size, Some(DEFAULT_MAX_POOL_SIZE));
        assert_eq!(options.connect_timeout, Some(Duration::from_secs(2)));
        assert_eq!(options.app_name.as_deref(), Some("dima-cron"));
        Ok(())
    }

    #[test]
    fn collection_names_from_commands() {
        assert_eq!(
            command_collection("find", &doc! { "find": "users", "filter": {} }).as_deref(),
            Some("users")
        );
        assert_eq!(
            command_collection("getMore", &doc! { "getMore": 5_i64, "collection": "users" })
                .as_deref(),
            Some("users")
        );
        assert_eq!(command_collection("ping", &doc! { "ping": 1 }), None);
        assert_eq!(
            command_collection("aggregate", &doc! { "aggregate": 1 }),
            None
        );
    }
}
