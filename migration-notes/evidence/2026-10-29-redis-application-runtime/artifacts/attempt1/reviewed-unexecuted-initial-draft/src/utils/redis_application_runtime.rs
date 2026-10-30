//! Opt-in application cache bootstrap. Keep the owner within one Tokio runtime.
//! The cached Redis manager itself cannot be reused after its runtime shuts down.
use crate::utils::{observability::{Telemetry, TelemetryTask}, redis::get_redis_client};
use redis::{aio::ConnectionManager, Client, ConnectionAddr, ErrorKind, RedisError, RedisResult};
use std::{env, sync::OnceLock};
use tokio::sync::Mutex;

struct Active { telemetry: Telemetry, task: TelemetryTask }
enum State { Uninitialized, Disabled, Active(Active), Closed }

/// A single owner serializes first successful initialization and owns its task.
/// Construct independent owners only for isolated tests; production uses `acquire`.
pub struct ApplicationCacheRuntime { state: Mutex<State> }
impl ApplicationCacheRuntime {
    pub const fn new() -> Self { Self { state: Mutex::const_new(State::Uninitialized) } }

    /// Failed or cancelled manager initialization is retryable. Once the first
    /// success is observed, the telemetry gate is sticky, matching the cached
    /// TypeScript connection promise. Caller cancellation cannot interrupt the
    /// synchronous transition that installs the telemetry task after success.
    pub async fn acquire(&self) -> RedisResult<(ConnectionManager, Option<Telemetry>)> {
        let mut state = self.state.lock().await;
        if matches!(*state, State::Closed) {
            return Err(RedisError::from((ErrorKind::InvalidClientConfig, "application cache runtime is shut down")));
        }
        let manager = get_redis_client().await?;
        if matches!(*state, State::Uninitialized) {
            *state = match telemetry_from_env() {
                Some(telemetry) => match telemetry.start() {
                    Some(task) => State::Active(Active { telemetry, task }),
                    None => State::Disabled,
                },
                None => State::Disabled,
            };
        }
        let telemetry = match &*state { State::Active(active) => Some(active.telemetry.clone()), _ => None };
        Ok((manager, telemetry))
    }

    /// Stops and flushes the sole owned telemetry task. This owner cannot restart.
    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        let old = std::mem::replace(&mut *state, State::Closed);
        if let State::Active(mut active) = old { active.task.shutdown().await; }
    }
}
impl Default for ApplicationCacheRuntime { fn default() -> Self { Self::new() } }

fn telemetry_from_env() -> Option<Telemetry> {
    let host = env::var("DRAGONFLY_HOST").ok()?;
    if env::var("OBSERVABILITY_DISABLED").ok().as_deref() == Some("true") || host.is_empty() { return None; }
    let port = match env::var("DRAGONFLY_PORT") { Ok(value) if !value.is_empty() => value.parse::<u16>().ok().filter(|p| *p != 0)?, _ => 6379 };
    // Structured address: no credentials, URI injection, or values in logs.
    let client = Client::open(ConnectionAddr::Tcp(host, port)).ok()?;
    let name = env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default();
    let service = if name.contains("cron") || name.ends_with("_worker") || name.ends_with("-worker") { "cron" } else if name.contains("bot") { "bot" } else { "api" };
    Some(Telemetry::new(client, service, true))
}
static APPLICATION: OnceLock<ApplicationCacheRuntime> = OnceLock::new();
/// Use one long-lived Tokio runtime. Calling after shutdown returns an error.
pub async fn acquire() -> RedisResult<(ConnectionManager, Option<Telemetry>)> {
    APPLICATION.get_or_init(ApplicationCacheRuntime::new).acquire().await
}
pub async fn shutdown() { if let Some(owner) = APPLICATION.get() { owner.shutdown().await; } }
