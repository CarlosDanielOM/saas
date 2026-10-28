//! Redis hints are best effort and never participate in the durable ACK. One
//! pending bit coalesces bursts; failed hints are dropped during cooldown.

use futures_util::StreamExt;
use redis::{AsyncConnectionConfig, Client, aio::MultiplexedConnection};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, task::JoinHandle};

pub const DOMAIN_EVENT_WAKEUP_CHANNEL: &str = "domain-events:wakeup:v1";
pub fn domain_event_wakeups_enabled() -> bool {
    std::env::var("DOMAIN_EVENTS_WAKEUPS_ENABLED")
        .map(|value| !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}
#[derive(Debug, Clone)]
pub struct WakeupConfig {
    pub enabled: bool,
    pub timeout: Duration,
    pub retry: Duration,
    pub idle: Duration,
}
impl Default for WakeupConfig {
    fn default() -> Self {
        Self {
            enabled: domain_event_wakeups_enabled(),
            timeout: Duration::from_millis(500),
            retry: Duration::from_secs(1),
            idle: Duration::from_secs(30),
        }
    }
}
struct State {
    pending: AtomicBool,
    cooldown: AtomicBool,
    stopped: AtomicBool,
    notify: Notify,
    stop: Notify,
}
pub struct DomainEventWakeups {
    state: Arc<State>,
    client: Client,
    config: WakeupConfig,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl DomainEventWakeups {
    pub fn new(client: Client, config: WakeupConfig) -> Self {
        Self {
            state: Arc::new(State {
                pending: AtomicBool::new(false),
                cooldown: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                notify: Notify::new(),
                stop: Notify::new(),
            }),
            client,
            config,
            task: Mutex::new(None),
        }
    }
    pub fn publish(&self) {
        if !self.config.enabled
            || self.state.stopped.load(Ordering::Acquire)
            || self.state.cooldown.load(Ordering::Acquire)
        {
            return;
        };
        self.state.pending.store(true, Ordering::Release);
        let mut task = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if task.is_none() {
            let state = self.state.clone();
            let client = self.client.clone();
            let config = self.config.clone();
            *task = Some(tokio::spawn(async move {
                publisher(state, client, config).await
            }));
        }
        self.state.notify.notify_one();
    }
    pub async fn shutdown(&self) {
        self.state.stopped.store(true, Ordering::Release);
        self.state.stop.notify_waiters();
        let task = self.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for DomainEventWakeups {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Release);
        self.state.stop.notify_waiters();
        if let Some(task) = self
            .task
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
    }
}

async fn connect(client: &Client, timeout: Duration) -> Result<MultiplexedConnection, ()> {
    let config = AsyncConnectionConfig::new()
        .set_connection_timeout(Some(timeout))
        .set_response_timeout(Some(timeout));
    tokio::time::timeout(
        timeout,
        client.get_multiplexed_async_connection_with_config(&config),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn publisher(state: Arc<State>, client: Client, config: WakeupConfig) {
    let mut connection = None;
    loop {
        if state.stopped.load(Ordering::Acquire) {
            break;
        };
        if !state.pending.swap(false, Ordering::AcqRel) {
            tokio::select! {_=state.stop.notified()=>break,_=state.notify.notified()=>{},_=tokio::time::sleep(config.idle)=>{connection=None;}}
            continue;
        }
        if connection.is_none() {
            connection = connect(&client, config.timeout).await.ok();
        }
        let sent = if let Some(connection) = connection.as_mut() {
            matches!(
                tokio::time::timeout(
                    config.timeout,
                    redis::cmd("PUBLISH")
                        .arg(DOMAIN_EVENT_WAKEUP_CHANNEL)
                        .arg("1")
                        .query_async::<i64>(connection)
                )
                .await,
                Ok(Ok(_))
            )
        } else {
            false
        };
        if !sent {
            connection = None;
            state.pending.store(false, Ordering::Release);
            state.cooldown.store(true, Ordering::Release);
            tokio::select! {_=state.stop.notified()=>break,_=tokio::time::sleep(config.retry)=>{}}
            state.cooldown.store(false, Ordering::Release);
        }
    }
}

/// Dedicated Pub/Sub transport; hints trigger a readiness check, not event
/// execution. Reconnect waiting protects Redis after real transport errors.
pub struct DomainEventWakeupListener {
    stop: Arc<Notify>,
    stopped: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}
impl DomainEventWakeupListener {
    pub fn start(
        client: Client,
        config: WakeupConfig,
        on_wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let stop = Arc::new(Notify::new());
        let stopped = Arc::new(AtomicBool::new(false));
        let (s, t) = (stop.clone(), stopped.clone());
        let task=config.enabled.then(||tokio::spawn(async move{
            while !t.load(Ordering::Acquire){
                let connection=tokio::select!{_=s.notified()=>break,result=tokio::time::timeout(config.timeout,client.get_async_pubsub())=>result};
                if let Ok(Ok(mut pubsub))=connection
                    && matches!(tokio::time::timeout(config.timeout,pubsub.subscribe(DOMAIN_EVENT_WAKEUP_CHANNEL)).await,Ok(Ok(()))){
                        let mut messages=pubsub.on_message();
                        loop{tokio::select!{_=s.notified()=>return,message=messages.next()=>{if message.is_none(){break};if !t.load(Ordering::Acquire){on_wake();}}}}
                }
                tokio::select!{_=s.notified()=>break,_=tokio::time::sleep(config.retry)=>{}}
            }
        }));
        Self {
            stop,
            stopped,
            task,
        }
    }
    pub async fn shutdown(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.stop.notify_waiters();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for DomainEventWakeupListener {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.stop.notify_waiters();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
