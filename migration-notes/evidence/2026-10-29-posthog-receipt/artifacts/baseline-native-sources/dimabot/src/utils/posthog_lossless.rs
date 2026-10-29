//! Concrete, pooled `/batch/` transport for application PostHog events.
//!
//! The queue owns already serialized lossless JSON, timestamps and UUIDs. No
//! serde Value conversion occurs. Clones share one queue, actor and HTTP pool.
//! `capture` acknowledges enqueue, whereas `flush` is a causal delivery barrier.
//! See migration-notes/posthog-lossless-handoff.md for deliberate native limits.
use super::{credit_policy::JsDate, js_string::JsString, lossless_json::JsonValue};
use std::{
    collections::VecDeque,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
    time::Instant,
};

pub const MAX_EVENT_BYTES: usize = 256 * 1024;
pub const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const RETRIES: usize = 3;
const RETRY_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct PosthogLosslessConfig {
    pub api_key: String,
    /// Full batch URL, including `/batch/` (no host/path concatenation).
    pub endpoint: String,
    pub flush_at: usize,
    pub flush_interval: Duration,
    pub max_batch_size: usize,
    pub max_queue_size: usize,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
}
impl PosthogLosslessConfig {
    pub fn new(api_key: impl Into<String>, endpoint: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: endpoint.into(),
            flush_at: 20,
            flush_interval: Duration::from_millis(1000),
            max_batch_size: 100,
            max_queue_size: 10_000,
            request_timeout: Duration::from_secs(10),
            shutdown_timeout: Duration::from_secs(30),
        }
    }
}

/// Deliberately contains no URL, API key, payload, server body or reqwest error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    InvalidConfig,
    NoRuntime,
    Closed,
    InvalidProperties,
    EventTooLarge,
    QueueOverflow,
    Network,
    RequestTimeout,
    Http(u16),
    ResponseTooLarge,
    ShutdownTimeout,
    ActorStopped,
}
impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(code) => write!(f, "PostHog HTTP status {code}"),
            other => f.write_str(match other {
                Self::InvalidConfig => "invalid PostHog transport configuration",
                Self::NoRuntime => "PostHog transport requires a Tokio runtime",
                Self::Closed => "PostHog transport is closed",
                Self::InvalidProperties => "PostHog properties must be an object",
                Self::EventTooLarge => "PostHog event exceeds native resource limits",
                Self::QueueOverflow => "PostHog queue discarded an oldest event",
                Self::Network => "PostHog network request failed",
                Self::RequestTimeout => "PostHog request deadline expired",
                Self::ResponseTooLarge => "PostHog response exceeds native resource limits",
                Self::ShutdownTimeout => "PostHog shutdown deadline expired",
                Self::ActorStopped => "PostHog actor stopped before delivery",
                Self::Http(_) => unreachable!(),
            }),
        }
    }
}
impl std::error::Error for TransportError {}
type Outcome = Result<(), TransportError>;
type Signal = watch::Sender<Option<Outcome>>;
fn signal() -> Signal {
    watch::channel(None).0
}
async fn wait(signal: &Signal) -> Outcome {
    let mut rx = signal.subscribe();
    loop {
        if let Some(result) = *rx.borrow_and_update() {
            return result;
        }
        rx.changed()
            .await
            .map_err(|_| TransportError::ActorStopped)?;
    }
}
#[derive(Clone)]
struct Event {
    seq: u64,
    wire: Arc<str>,
    queued: Instant,
}
#[derive(Clone)]
struct Pass {
    target: u64,
    done: Signal,
}
struct Closing {
    deadline: Instant,
    done: Signal,
    failure: Option<TransportError>,
}
struct State {
    queue: VecDeque<Event>,
    bytes: usize,
    seq: u64,
    active: Option<Pass>,
    pending: Option<Pass>,
    // Loss is sticky: a later empty flush must not falsely certify delivery.
    first_loss: Option<(u64, TransportError)>,
    closing: Option<Closing>,
    closed: Option<Outcome>,
    batch_size: usize,
    retry_after: Option<Instant>,
}
struct Shared {
    config: PosthogLosslessConfig,
    state: Mutex<State>,
    wake: Notify,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn close(&self, result: Outcome) {
        let mut s = self.lock();
        s.closed = Some(result);
        if let Some(pass) = s.active.take() {
            pass.done.send_replace(Some(result));
        }
        if let Some(pass) = s.pending.take() {
            pass.done.send_replace(Some(result));
        }
        if let Some(closing) = &s.closing {
            closing.done.send_replace(Some(result));
        }
        s.queue.clear();
        s.bytes = 0;
    }
}
struct Owner {
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        // The actor owns Shared, never Owner; there is no Arc cycle. Abort drops
        // its single owned HTTP future; no detached retry/request tasks exist.
        self.task.abort();
        self.shared.close(Err(TransportError::Closed));
    }
}
struct ActorGuard(Arc<Shared>);
impl Drop for ActorGuard {
    fn drop(&mut self) {
        let unfinished = { self.0.lock().closed.is_none() };
        if unfinished {
            self.0.close(Err(TransportError::ActorStopped));
        }
    }
}
#[derive(Clone)]
pub struct PosthogLosslessTransport {
    owner: Arc<Owner>,
}
impl PosthogLosslessTransport {
    pub fn new(config: PosthogLosslessConfig) -> Result<Self, TransportError> {
        // Disable redirects so a batch/key can never migrate to another URL.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| TransportError::InvalidConfig)?;
        Self::with_client(config, client)
    }
    /// The supplied pool must also disable redirects and any implicit retries.
    pub fn with_client(
        config: PosthogLosslessConfig,
        client: reqwest::Client,
    ) -> Result<Self, TransportError> {
        let url =
            reqwest::Url::parse(&config.endpoint).map_err(|_| TransportError::InvalidConfig)?;
        let max_duration = Duration::from_secs(366 * 24 * 3600);
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || config.api_key.is_empty()
            || config.api_key.len() > 4096
            || config.flush_at == 0
            || config.max_batch_size == 0
            || config.max_queue_size == 0
            || config.max_batch_size > 10_000
            || config.max_queue_size > 1_000_000
            || config.flush_at > 1_000_000
            || config.request_timeout.is_zero()
            || config.shutdown_timeout.is_zero()
            || config.request_timeout > max_duration
            || config.shutdown_timeout > max_duration
            || config.flush_interval > max_duration
        {
            return Err(TransportError::InvalidConfig);
        }
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| TransportError::NoRuntime)?;
        let batch_size = config.max_batch_size;
        let shared = Arc::new(Shared {
            config,
            wake: Notify::new(),
            state: Mutex::new(State {
                queue: VecDeque::new(),
                bytes: 0,
                seq: 0,
                active: None,
                pending: None,
                first_loss: None,
                closing: None,
                closed: None,
                batch_size,
                retry_after: None,
            }),
        });
        let task = runtime.spawn(actor(shared.clone(), client));
        Ok(Self {
            owner: Arc::new(Owner { shared, task }),
        })
    }
    pub fn capture(&self, event: &str, distinct_id: &JsString, properties: &JsonValue) -> Outcome {
        let shared = &self.owner.shared;
        {
            let s = shared.lock();
            if s.closing.is_some() || s.closed.is_some() {
                return Err(TransportError::Closed);
            }
        }
        let wire = serialize_event(event, distinct_id, properties)?;
        let mut s = shared.lock();
        if s.closing.is_some() || s.closed.is_some() {
            return Err(TransportError::Closed);
        }
        while s.queue.len() >= shared.config.max_queue_size
            || s.bytes + wire.len() > MAX_QUEUE_BYTES
        {
            let old = s
                .queue
                .pop_front()
                .expect("one bounded event fits empty queue");
            s.bytes -= old.wire.len();
            s.first_loss
                .get_or_insert((old.seq, TransportError::QueueOverflow));
        }
        s.seq = s.seq.checked_add(1).ok_or(TransportError::Closed)?;
        let seq = s.seq;
        s.bytes += wire.len();
        s.queue.push_back(Event {
            seq,
            wire: wire.into(),
            queued: Instant::now(),
        });
        if s.queue.len() >= shared.config.flush_at {
            request_pass(&mut s);
        }
        drop(s);
        shared.wake.notify_one();
        Ok(())
    }
    /// All events captured before this call are either delivered or reported as
    /// failed/lost. Cancelling this waiter leaves the shared pass running.
    pub async fn flush(&self) -> Outcome {
        let shared = &self.owner.shared;
        let done = {
            let mut s = shared.lock();
            if let Some(result) = s.closed {
                return result;
            }
            if let Some(closing) = &s.closing {
                closing.done.clone()
            } else {
                request_pass(&mut s)
            }
        };
        shared.wake.notify_one();
        wait(&done).await
    }
    /// First poll closes admission. Concurrent/repeated calls share one result
    /// and one deadline, even if the first caller is cancelled.
    pub async fn shutdown(&self) -> Outcome {
        let shared = &self.owner.shared;
        let done = {
            let mut s = shared.lock();
            if let Some(result) = s.closed {
                return result;
            }
            if s.closing.is_none() {
                s.closing = Some(Closing {
                    deadline: Instant::now() + shared.config.shutdown_timeout,
                    done: signal(),
                    failure: None,
                });
                request_pass(&mut s);
            }
            s.closing.as_ref().expect("closing installed").done.clone()
        };
        shared.wake.notify_one();
        wait(&done).await
    }
}
fn request_pass(s: &mut State) -> Signal {
    if let Some(pass) = &s.active {
        if pass.target >= s.seq {
            return pass.done.clone();
        }
    }
    let target = s.seq;
    let pass = s.pending.get_or_insert_with(|| Pass {
        target,
        done: signal(),
    });
    pass.target = target;
    pass.done.clone()
}
fn now() -> String {
    let millis = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as f64,
        Err(e) => -(e.duration().as_millis() as f64),
    };
    JsDate::from_millis(millis)
        .to_iso_string()
        .expect("system clock within JS date range")
}
// Conservative preflight bounds recursion, traversal and writer allocation.
// Six bytes per UTF-16 unit bounds the existing lossless string writer.
fn value_budget(v: &JsonValue, depth: usize, remaining: &mut usize) -> bool {
    if depth > 64 {
        return false;
    }
    let cost = match v {
        JsonValue::String(s) => s.len().saturating_mul(6).saturating_add(3),
        JsonValue::Array(_) | JsonValue::Object(_) => 3,
        _ => 32,
    };
    if cost > *remaining {
        return false;
    }
    *remaining -= cost;
    match v {
        JsonValue::Array(values) => values.iter().all(|v| value_budget(v, depth + 1, remaining)),
        JsonValue::Object(fields) => fields.iter().all(|(k, v)| {
            let cost = k.len().saturating_mul(6).saturating_add(4);
            if cost > *remaining {
                return false;
            }
            *remaining -= cost;
            value_budget(v, depth + 1, remaining)
        }),
        _ => true,
    }
}
fn serialize_event(
    event: &str,
    id: &JsString,
    properties: &JsonValue,
) -> Result<String, TransportError> {
    let JsonValue::Object(fields) = properties else {
        return Err(TransportError::InvalidProperties);
    };
    let mut budget = MAX_EVENT_BYTES.saturating_sub(1024);
    let cost = event
        .len()
        .saturating_mul(6)
        .saturating_add(id.len().saturating_mul(6));
    if cost > budget {
        return Err(TransportError::EventTooLarge);
    }
    budget -= cost;
    if !value_budget(properties, 0, &mut budget) {
        return Err(TransportError::EventTooLarge);
    }
    // Use the shared writer for ECMAScript key ordering/nonfinite/UTF-16.
    let mut props = fields.clone();
    for (key, value) in [
        (
            "$lib",
            JsonValue::String(JsString::from("dima-rust-lossless")),
        ),
        (
            "$lib_version",
            JsonValue::String(JsString::from(env!("CARGO_PKG_VERSION"))),
        ),
        ("$is_server", JsonValue::Bool(true)),
        ("$geoip_disable", JsonValue::Bool(true)),
    ] {
        // Object spread overwrites without moving an existing property.
        if let Some((_, existing)) = props.iter_mut().find(|(k, _)| k.as_str() == Some(key)) {
            *existing = value;
        } else {
            props.push((JsString::from(key), value));
        }
    }
    let mut out = String::new();
    out.push_str("{\"distinct_id\":");
    id.write_json_string(&mut out);
    out.push_str(",\"event\":");
    JsString::from(event).write_json_string(&mut out);
    out.push_str(",\"properties\":");
    JsonValue::Object(props).write_json_string(&mut out);
    out.push_str(",\"timestamp\":");
    JsString::from(now()).write_json_string(&mut out);
    out.push_str(",\"uuid\":\"");
    out.push_str(&uuid::Uuid::new_v4().to_string());
    out.push_str("\"}");
    if out.len() > MAX_EVENT_BYTES {
        return Err(TransportError::EventTooLarge);
    }
    Ok(out)
}
fn batch_body(key: &str, events: &[Event]) -> String {
    let mut out = String::from("{\"api_key\":");
    JsString::from(key).write_json_string(&mut out);
    out.push_str(",\"batch\":[");
    for (i, event) in events.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&event.wire);
    }
    out.push_str("],\"sent_at\":");
    JsString::from(now()).write_json_string(&mut out);
    out.push('}');
    out
}
// Interruption is shared-state driven; a caller's cancelled wait is irrelevant.
async fn bounded<F, T>(shared: &Shared, future: F) -> Result<T, TransportError>
where
    F: std::future::Future<Output = T>,
{
    tokio::pin!(future);
    loop {
        let wake = shared.wake.notified();
        let deadline = {
            let s = shared.lock();
            if s.closed.is_some() {
                return Err(TransportError::Closed);
            }
            s.closing.as_ref().map(|c| c.deadline)
        };
        tokio::select! {
            biased;
            _ = async { match deadline { Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await } } => return Err(TransportError::ShutdownTimeout),
            result = &mut future => return Ok(result),
            _ = wake => {},
        }
    }
}
async fn send(shared: &Shared, client: &reqwest::Client, body: String) -> Outcome {
    for attempt in 0..=RETRIES {
        let operation = async {
            let mut response = client
                .post(&shared.config.endpoint)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone())
                .send()
                .await
                .map_err(|_| TransportError::Network)?;
            let status = response.status().as_u16();
            // SDK accepts 2xx/3xx and cancels response bodies. Native drains a
            // bounded body for pool reuse; held bodies remain deadline bounded.
            if !(200..400).contains(&status) {
                return Err(TransportError::Http(status));
            }
            let mut size = 0usize;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| TransportError::Network)?
            {
                size = size.saturating_add(chunk.len());
                if size > MAX_RESPONSE_BYTES {
                    return Err(TransportError::ResponseTooLarge);
                }
            }
            Ok(())
        };
        let result = bounded(
            shared,
            tokio::time::timeout(shared.config.request_timeout, operation),
        )
        .await?
        .unwrap_or(Err(TransportError::RequestTimeout));
        let retry = matches!(
            result,
            Err(TransportError::Network | TransportError::RequestTimeout)
        ) || matches!(result, Err(TransportError::Http(code)) if code == 408 || code == 429 || code >= 500);
        if !retry || attempt == RETRIES {
            return result;
        }
        bounded(shared, tokio::time::sleep(RETRY_DELAY)).await?;
    }
    unreachable!()
}
async fn drain(shared: &Shared, client: &reqwest::Client, target: u64) -> Outcome {
    loop {
        let events: Vec<Event> = {
            let s = shared.lock();
            s.queue
                .iter()
                .take_while(|e| e.seq <= target)
                .take(s.batch_size)
                .cloned()
                .collect()
        };
        if events.is_empty() {
            return Ok(());
        }
        let result = send(shared, client, batch_body(&shared.config.api_key, &events)).await;
        {
            let mut s = shared.lock();
            if result == Err(TransportError::Http(413)) && events.len() > 1 {
                s.batch_size = (events.len() / 2).max(1);
                continue;
            }
            // Never remove new records by count: concurrent drop-oldest may
            // have evicted in-flight records. Remove by stable sequence instead.
            if result.is_ok() || matches!(result, Err(TransportError::Http(_))) {
                let last = events.last().expect("nonempty batch").seq;
                while s.queue.front().is_some_and(|e| e.seq <= last) {
                    let event = s.queue.pop_front().expect("front exists");
                    s.bytes -= event.wire.len();
                }
                if let Err(error) = result {
                    s.first_loss.get_or_insert((events[0].seq, error));
                }
            }
        }
        result?;
        // Fairness between bounded ready batches; never an interval sleep.
        tokio::task::yield_now().await;
    }
}
async fn actor(shared: Arc<Shared>, client: reqwest::Client) {
    let _guard = ActorGuard(shared.clone());
    loop {
        let wake = shared.wake.notified();
        let (pass, timer, close) = {
            let mut s = shared.lock();
            if s.closed.is_some() {
                return;
            }
            let timer = if shared.config.flush_interval.is_zero() {
                None
            } else {
                s.queue.front().map(|e| {
                    let due = e.queued + shared.config.flush_interval;
                    s.retry_after.map_or(due, |retry| due.max(retry))
                })
            };
            if s.pending.is_none() && timer.is_some_and(|d| d <= Instant::now()) {
                request_pass(&mut s);
            }
            let pass = s.pending.take();
            s.active = pass.clone();
            let close = s
                .closing
                .as_ref()
                .map(|c| {
                    c.failure
                        .map_or_else(|| s.first_loss.map_or(Ok(()), |(_, e)| Err(e)), Err)
                })
                .filter(|_| pass.is_none());
            (pass, timer, close)
        };
        if let Some(result) = close {
            shared.close(result);
            return;
        }
        if let Some(pass) = pass {
            let delivery = drain(&shared, &client, pass.target).await;
            let mut s = shared.lock();
            let result = delivery.and_then(|()| {
                s.first_loss
                    .filter(|(seq, _)| *seq <= pass.target)
                    .map_or(Ok(()), |(_, e)| Err(e))
            });
            pass.done.send_replace(Some(result));
            s.active = None;
            if let Err(error) = delivery {
                if let Some(closing) = &mut s.closing {
                    closing.failure.get_or_insert(error);
                }
                // A failed pass completes pending pre-call barriers as failed;
                // retained network batches wait for a NEW trigger, not a hot loop.
                if let Some(pending) = s.pending.take() {
                    pending.done.send_replace(Some(result));
                }
                s.retry_after = Some(Instant::now() + RETRY_DELAY);
            } else {
                s.retry_after = None;
            }
            drop(s);
            if result == Err(TransportError::ShutdownTimeout) {
                shared.close(result);
                return;
            }
        } else {
            tokio::select! {
                _ = wake => {},
                _ = async { match timer { Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await } } => {},
            }
        }
    }
}
