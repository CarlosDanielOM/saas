//! The command handle: one multiplexed connection per process, as in the reference.
//!
//! [`Dragonfly`] is cheap to clone; every clone shares one socket (redis-rs `ConnectionManager`).
//! Behaviour on a lost connection matches node-redis as far as the ledger requires: the command
//! that hits the dropped socket fails to its caller and is **not** replayed; the next command
//! reconnects (exponential back-off with jitter, [`DragonflyConfig::reconnect_retries`] attempts per
//! outage). Unlike node-redis there is no offline queue that holds commands forever: a command
//! issued during an outage waits for the reconnection attempts and then fails.
//!
//! Every ordinary command is bounded by [`DragonflyConfig::response_timeout`]. A timed-out command
//! may still run on the server (outcome unknown, see [`DragonflyError::outcome_unknown`]); its late
//! reply is matched to it and discarded by the driver, so later commands never read a stale reply.
//! Blocking commands go through [`BlockingConnection`], subscriptions through [`Subscriber`]; neither
//! shares this socket.

use super::blocking::BlockingConnection;
use super::config::DragonflyConfig;
use super::error::{DragonflyError, Result};
use super::hooks::{CacheLookup, CommandOutcome, Hooks, instrumented_method};
use super::pubsub::Subscriber;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{AsyncConnectionConfig, Cmd, FromRedisValue, Pipeline, Value};
use std::sync::Arc;
use tokio::time::Instant;

/// The configuration error for credentials the server refused.
pub(crate) const AUTH_REFUSED: &str = "the server refused the credentials in the address (AUTH)";

/// `true` when the driver failed because the server refused `AUTH`.
pub(crate) fn is_auth_refused(error: &redis::RedisError) -> bool {
    error.kind() == redis::ErrorKind::AuthenticationFailed
        || matches!(error.code(), Some("WRONGPASS" | "NOAUTH" | "NOPERM"))
}

/// A cloneable handle for ordinary commands on the process's shared connection.
#[derive(Clone)]
pub struct Dragonfly {
    manager: ConnectionManager,
    shared: Arc<Shared>,
}

pub(crate) struct Shared {
    pub(crate) client: redis::Client,
    pub(crate) config: DragonflyConfig,
    pub(crate) hooks: Hooks,
}

impl std::fmt::Debug for Dragonfly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dragonfly")
            .field("config", &self.shared.config)
            .field("hooks", &self.shared.hooks)
            .finish()
    }
}

impl Dragonfly {
    /// Connects and checks the connection with `PING`, all within
    /// [`DragonflyConfig::connect_timeout`]. A failure is returned (and reported to the error hook);
    /// nothing is cached, so the caller may simply call again, as the reference's failed
    /// initialisation is retryable.
    pub async fn connect(config: DragonflyConfig, hooks: Hooks) -> Result<Self> {
        let client = config.client()?;
        let manager_config = ConnectionManagerConfig::new()
            .set_response_timeout(Some(config.response_timeout))
            .set_connection_timeout(Some(config.connect_timeout))
            .set_number_of_retries(config.reconnect_retries);
        let attempt = async {
            // The connection manager retries every failure, a refused AUTH included, until the
            // deadline; one plain connection first turns refused credentials into a prompt
            // configuration error.
            if config.has_credentials() {
                let probe = AsyncConnectionConfig::new()
                    .set_connection_timeout(Some(config.connect_timeout))
                    .set_response_timeout(Some(config.response_timeout));
                drop(
                    client
                        .get_multiplexed_async_connection_with_config(&probe)
                        .await?,
                );
            }
            let mut manager = client
                .get_connection_manager_with_config(manager_config)
                .await?;
            let _: Value = redis::cmd("PING").query_async(&mut manager).await?;
            Ok::<_, redis::RedisError>(manager)
        };
        let manager = match tokio::time::timeout(config.connect_timeout, attempt).await {
            Ok(Ok(manager)) => manager,
            Ok(Err(error)) if is_auth_refused(&error) => {
                return Err(DragonflyError::Config(AUTH_REFUSED));
            }
            Ok(Err(error)) => {
                hooks.report(&config.caller, &error);
                return Err(error.into());
            }
            Err(_) => {
                let error = redis::RedisError::from(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Dragonfly connection did not open within the connect timeout",
                ));
                hooks.report(&config.caller, &error);
                return Err(error.into());
            }
        };
        Ok(Self {
            manager,
            shared: Arc::new(Shared {
                client,
                config,
                hooks,
            }),
        })
    }

    /// The settings this handle was opened with.
    pub fn config(&self) -> &DragonflyConfig {
        &self.shared.config
    }

    /// A new dedicated connection for blocking commands (opened on first use).
    pub fn blocking(&self) -> BlockingConnection {
        BlockingConnection::new(self.shared.clone())
    }

    /// A new subscriber with its own connection and background task (opened at once, in the
    /// background). Requires a running tokio runtime.
    pub fn subscriber(&self) -> Subscriber {
        Subscriber::start(self.shared.clone())
    }

    /// Runs one command and returns the raw reply. Server error replies become errors.
    ///
    /// The reference's instrumented commands (see [`super::hooks`]) are reported to the command
    /// hook; connection errors to the error hook.
    pub async fn query_value(&self, cmd: &Cmd) -> Result<Value> {
        let method = cmd.args_iter().next().and_then(|arg| match arg {
            redis::Arg::Simple(name) => instrumented_method(name),
            _ => None,
        });
        let started = Instant::now();
        let mut manager = self.manager.clone();
        let result: redis::RedisResult<Value> = cmd.query_async(&mut manager).await;
        if let (Some(method), Some(hook)) = (method, &self.shared.hooks.command) {
            let outcome = match &result {
                Ok(value) => CommandOutcome::Ok {
                    lookup: matches!(method, "get" | "hGet").then(|| {
                        if matches!(value, Value::Nil) {
                            CacheLookup::Miss
                        } else {
                            CacheLookup::Hit
                        }
                    }),
                },
                Err(_) => CommandOutcome::Error,
            };
            hook.finished(method, started.elapsed(), outcome);
        }
        result.map_err(|error| self.failed(error))
    }

    /// Runs one command and converts the reply with redis-rs's [`FromRedisValue`]. Prefer the
    /// typed helpers ([`super::commands`]) where node-redis and redis-rs disagree on a reply shape.
    pub async fn query<T: FromRedisValue>(&self, cmd: &Cmd) -> Result<T> {
        let value = self.query_value(cmd).await?;
        Ok(redis::from_redis_value(value).map_err(redis::RedisError::from)?)
    }

    /// Runs a pipeline (or, with `atomic()`, a `MULTI`/`EXEC` transaction) and returns the replies
    /// in order. Not instrumented, like `multi()` in the reference.
    pub async fn query_pipeline<T: FromRedisValue>(&self, pipeline: &Pipeline) -> Result<T> {
        let mut manager = self.manager.clone();
        pipeline
            .query_async(&mut manager)
            .await
            .map_err(|error| self.failed(error))
    }

    fn failed(&self, error: redis::RedisError) -> DragonflyError {
        self.shared.hooks.report(&self.shared.config.caller, &error);
        error.into()
    }
}
