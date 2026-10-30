//! Opt-in application cache bootstrap. Keep the owner within one Tokio runtime.
//! The cached Redis manager itself cannot be reused after its runtime shuts down.
use crate::utils::{
    observability::{Telemetry, TelemetryTask},
    redis::get_redis_client,
};
use redis::{Client, ConnectionAddr, ErrorKind, RedisError, RedisResult, aio::ConnectionManager};
use std::{
    env,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};
use tokio::{sync::watch, task::JoinHandle};

type SharedResult = RedisResult<(ConnectionManager, Option<Telemetry>)>;
struct Active {
    telemetry: Telemetry,
    task: TelemetryTask,
}
struct Flight {
    id: Arc<()>,
    receiver: watch::Receiver<Option<SharedResult>>,
    leader: JoinHandle<()>,
}
enum State {
    Empty,
    Pending(Flight),
    Ready {
        manager: ConnectionManager,
        active: Option<Active>,
    },
    Closed,
}
fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}
fn closed_error() -> RedisError {
    RedisError::from((
        ErrorKind::InvalidClientConfig,
        "application cache runtime is shut down",
    ))
}
fn interrupted_error() -> RedisError {
    RedisError::from((
        ErrorKind::Io,
        "application cache initialization interrupted",
    ))
}
struct FlightGuard {
    state: Arc<Mutex<State>>,
    id: Arc<()>,
    sender: watch::Sender<Option<SharedResult>>,
    done: bool,
}
impl Drop for FlightGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let mut state = lock(&self.state);
        let closed = matches!(*state, State::Closed);
        if matches!(&*state, State::Pending(flight) if Arc::ptr_eq(&flight.id, &self.id)) {
            *state = State::Empty;
        }
        self.sender.send_replace(Some(Err(if closed {
            closed_error()
        } else {
            interrupted_error()
        })));
    }
}
/// Owns a single detached initialization flight and telemetry lifecycle.
pub struct ApplicationCacheRuntime {
    state: Arc<Mutex<State>>,
}
impl ApplicationCacheRuntime {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::Empty)),
        }
    }
    /// All callers attached to a flight see the same result. Dropping a caller
    /// does not cancel the leader; failed flights permit later retry.
    pub async fn acquire(&self) -> SharedResult {
        let mut receiver = {
            let mut state = lock(&self.state);
            match &*state {
                State::Closed => return Err(closed_error()),
                State::Ready { manager, active } => {
                    return Ok((
                        manager.clone(),
                        active.as_ref().map(|a| a.telemetry.clone()),
                    ));
                }
                State::Pending(flight) => flight.receiver.clone(),
                State::Empty => {
                    let (sender, receiver) = watch::channel(None);
                    let id = Arc::new(());
                    let mut guard = FlightGuard {
                        state: self.state.clone(),
                        id: id.clone(),
                        sender,
                        done: false,
                    };
                    let leader = tokio::spawn(async move {
                        let result = get_redis_client().await;
                        let mut state = lock(&guard.state);
                        if !matches!(&*state, State::Pending(flight) if Arc::ptr_eq(&flight.id, &guard.id))
                        {
                            drop(state);
                            return;
                        }
                        let result = match result {
                            Ok(manager) => {
                                let active = telemetry_from_env().and_then(|telemetry| {
                                    telemetry.start().map(|task| Active { telemetry, task })
                                });
                                let handle = active.as_ref().map(|a| a.telemetry.clone());
                                *state = State::Ready {
                                    manager: manager.clone(),
                                    active,
                                };
                                Ok((manager, handle))
                            }
                            Err(error) => {
                                *state = State::Empty;
                                Err(error)
                            }
                        };
                        guard.sender.send_replace(Some(result));
                        drop(state);
                        guard.done = true;
                    });
                    *state = State::Pending(Flight {
                        id,
                        receiver: receiver.clone(),
                        leader,
                    });
                    receiver
                }
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            if receiver.changed().await.is_err() {
                return Err(interrupted_error());
            }
        }
    }
    /// Abort an unfinished flight or flush the active exporter; closure is final.
    pub async fn shutdown(&self) {
        let old = {
            let mut state = lock(&self.state);
            std::mem::replace(&mut *state, State::Closed)
        };
        match old {
            State::Pending(flight) => {
                flight.leader.abort();
                let _ = flight.leader.await;
            }
            State::Ready {
                active: Some(mut active),
                ..
            } => active.task.shutdown().await,
            _ => {}
        }
    }
}
impl Default for ApplicationCacheRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn telemetry_from_env() -> Option<Telemetry> {
    let host = env::var("DRAGONFLY_HOST").ok()?;
    if env::var("OBSERVABILITY_DISABLED").ok().as_deref() == Some("true") || host.is_empty() {
        return None;
    }
    let port = match env::var("DRAGONFLY_PORT") {
        Ok(value) if !value.is_empty() => value.parse::<u16>().ok().filter(|p| *p != 0)?,
        _ => 6379,
    };
    // Structured address: no credentials, URI injection, or values in logs.
    let client = Client::open(ConnectionAddr::Tcp(host, port)).ok()?;
    let name = env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let service = if name.contains("cron") || name.ends_with("_worker") || name.ends_with("-worker")
    {
        "cron"
    } else if name.contains("bot") {
        "bot"
    } else {
        "api"
    };
    Some(Telemetry::new(client, service, true))
}
static APPLICATION: OnceLock<ApplicationCacheRuntime> = OnceLock::new();
/// Use one long-lived Tokio runtime. Calling after shutdown returns an error.
pub async fn acquire() -> RedisResult<(ConnectionManager, Option<Telemetry>)> {
    APPLICATION
        .get_or_init(ApplicationCacheRuntime::new)
        .acquire()
        .await
}
pub async fn shutdown() {
    if let Some(owner) = APPLICATION.get() {
        owner.shutdown().await;
    }
}
