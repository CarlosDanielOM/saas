//! Trace context (`ledger/runtime.md` 6.1): ids, sampling, the per-task context and its
//! propagation, and the signed `traceparent` used between our own services.
//!
//! The reference keeps one `AsyncLocalStorage<TraceContext>`. Here the context is a tokio
//! task-local: [`TraceContext::scope`] runs a future inside one, [`in_current`] and [`spawn`] carry
//! the current one into a spawned task, and [`SavedTrace`] carries it through a queue payload
//! (`restoreContext`). A task that was spawned without it simply has no context, like a callback
//! the reference runs outside `context.run`.

use crate::label::{self, Channel, Label, OUTCOME_MAX};
use dima_core::SecretString;
use dima_core::crypto::keys::{trace_signature, verify_trace_signature};
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

/// The reference's sampling rate: `Math.random() < 0.01`.
pub const DEFAULT_SAMPLE_RATE: f64 = 0.01;

/// A trace id: 16 random bytes, never all zero.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct TraceId(pub [u8; 16]);

/// A span id: 8 random bytes, never all zero.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct SpanId(pub [u8; 8]);

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_into(bytes: &[u8], out: &mut [u8]) {
    for (index, byte) in bytes.iter().enumerate() {
        if let Some(pair) = out.get_mut(index * 2..index * 2 + 2) {
            pair[0] = HEX[usize::from(byte >> 4)];
            pair[1] = HEX[usize::from(byte & 0x0f)];
        }
    }
}

fn parse_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let bytes = text.as_bytes();
    if bytes.len() != N * 2 {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut out = [0_u8; N];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = (digit(bytes[index * 2])? << 4) | digit(bytes[index * 2 + 1])?;
    }
    Some(out)
}

impl TraceId {
    /// A fresh random id.
    pub fn random() -> Self {
        let (a, b) = (rng::next(), rng::next());
        let mut bytes = [0_u8; 16];
        bytes[..8].copy_from_slice(&a.to_le_bytes());
        bytes[8..].copy_from_slice(&(b | 1).to_le_bytes());
        Self(bytes)
    }

    /// Lowercase hex (32 characters), on the stack.
    pub fn hex(&self) -> HexId<32> {
        let mut out = [0_u8; 32];
        hex_into(&self.0, &mut out);
        HexId(out)
    }

    /// Parses 32 lowercase hex characters (`^[a-f0-9]{32}$`).
    pub fn parse(text: &str) -> Option<Self> {
        parse_hex::<16>(text).map(Self)
    }
}

impl SpanId {
    /// A fresh random id.
    pub fn random() -> Self {
        Self((rng::next() | 1).to_le_bytes())
    }

    /// Lowercase hex (16 characters), on the stack.
    pub fn hex(&self) -> HexId<16> {
        let mut out = [0_u8; 16];
        hex_into(&self.0, &mut out);
        HexId(out)
    }

    /// Parses 16 lowercase hex characters (`^[a-f0-9]{16}$`).
    pub fn parse(text: &str) -> Option<Self> {
        parse_hex::<8>(text).map(Self)
    }
}

/// An id as lowercase hex text, without allocating.
#[derive(Clone, Copy)]
pub struct HexId<const N: usize>([u8; N]);

impl<const N: usize> HexId<N> {
    /// The text.
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).unwrap_or_default()
    }
}

impl fmt::Debug for TraceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.hex().as_str())
    }
}

impl fmt::Debug for SpanId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.hex().as_str())
    }
}

/// The per-thread generator behind ids and sampling decisions: SplitMix64, seeded from the
/// operating system once per thread. Ids need to be unique, not secret; nothing is derived from
/// them. Per-thread state keeps the hot path free of shared cache lines.
pub(crate) mod rng {
    use dima_core::{Random, SystemRandom};
    use std::cell::Cell;

    thread_local! {
        static STATE: Cell<u64> = Cell::new(seed());
    }

    fn seed() -> u64 {
        let mut bytes = [0_u8; 8];
        if SystemRandom.fill(&mut bytes).is_err() {
            // No OS randomness: still unique per thread and process.
            let hasher = std::hash::RandomState::new();
            return std::hash::BuildHasher::hash_one(&hasher, std::thread::current().id());
        }
        u64::from_le_bytes(bytes)
    }

    pub(crate) fn next() -> u64 {
        STATE.with(|state| {
            let next = state.get().wrapping_add(0x9e37_79b9_7f4a_7c15);
            state.set(next);
            let mut z = next;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        })
    }

    /// A uniform number in `[0, 1)`.
    pub(crate) fn unit() -> f64 {
        (next() >> 11) as f64 / (1_u64 << 53) as f64
    }
}

/// The sampling decision for a new trace: `random < rate`.
pub(crate) fn sample(rate: f64) -> bool {
    rate > 0.0 && (rate >= 1.0 || rng::unit() < rate)
}

/// The ids of one span: what crosses task, queue and process boundaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpanIds {
    /// The trace.
    pub trace_id: TraceId,
    /// This span.
    pub span_id: SpanId,
    /// Whether the whole trace is exported.
    pub sampled: bool,
}

/// The current span's context: its ids, the channel it works for and an outcome set from inside
/// (`bindChannel` and `traceOutcome` mutate it in the reference).
pub struct TraceContext {
    ids: SpanIds,
    channel: Cell<Channel>,
    outcome: Cell<Label<OUTCOME_MAX>>,
    link: Option<Arc<Link>>,
}

/// State shared between an inbound request's context and the observer that ends its span, so a
/// channel bound or an outcome set by a handler reaches the request's span (the reference's
/// handlers run inside the span's own store). Only request spans have one.
#[derive(Debug)]
pub(crate) struct Link {
    pub(crate) parent: Option<SpanId>,
    pub(crate) at: u64,
    pub(crate) channel: Mutex<Channel>,
    pub(crate) outcome: Mutex<Label<OUTCOME_MAX>>,
}

impl Clone for TraceContext {
    fn clone(&self) -> Self {
        Self {
            ids: self.ids,
            channel: Cell::new(self.channel.get()),
            outcome: Cell::new(self.outcome.get()),
            link: self.link.clone(),
        }
    }
}

impl fmt::Debug for TraceContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TraceContext")
            .field("ids", &self.ids)
            .field("channel", &self.channel.get())
            .field("outcome", &self.outcome.get())
            .finish()
    }
}

tokio::task_local! {
    static CONTEXT: TraceContext;
}

impl TraceContext {
    /// A context for these ids.
    pub fn new(ids: SpanIds, channel: Channel) -> Self {
        Self {
            ids,
            channel: Cell::new(channel),
            outcome: Cell::new(Label::EMPTY),
            link: None,
        }
    }

    /// A request context whose channel and outcome are also visible through the returned link.
    pub(crate) fn linked(ids: SpanIds, parent: Option<SpanId>, at: u64) -> (Self, Arc<Link>) {
        let link = Arc::new(Link {
            parent,
            at,
            channel: Mutex::new(Channel::EMPTY),
            outcome: Mutex::new(Label::EMPTY),
        });
        let context = Self {
            link: Some(link.clone()),
            ..Self::new(ids, Channel::EMPTY)
        };
        (context, link)
    }

    /// The request context again, from its ids and link.
    pub(crate) fn from_link(ids: SpanIds, link: Arc<Link>) -> Self {
        let channel = *link.channel.lock().unwrap_or_else(PoisonError::into_inner);
        let outcome = *link.outcome.lock().unwrap_or_else(PoisonError::into_inner);
        Self {
            ids,
            channel: Cell::new(channel),
            outcome: Cell::new(outcome),
            link: Some(link),
        }
    }

    pub(crate) fn link(&self) -> Option<&Arc<Link>> {
        self.link.as_ref()
    }

    fn set_channel(&self, channel: Channel) {
        self.channel.set(channel);
        if let Some(link) = &self.link {
            *link.channel.lock().unwrap_or_else(PoisonError::into_inner) = channel;
        }
    }

    fn set_outcome(&self, outcome: Label<OUTCOME_MAX>) {
        self.outcome.set(outcome);
        if let Some(link) = &self.link {
            *link.outcome.lock().unwrap_or_else(PoisonError::into_inner) = outcome;
        }
    }

    /// The ids.
    pub fn ids(&self) -> SpanIds {
        self.ids
    }

    /// The channel (empty for system work).
    pub fn channel(&self) -> Channel {
        self.channel.get()
    }

    /// The outcome set from inside the span, if any.
    pub fn outcome(&self) -> Option<Label<OUTCOME_MAX>> {
        let outcome = self.outcome.get();
        (!outcome.is_empty()).then_some(outcome)
    }

    /// Runs `future` with this context as the current one.
    pub fn scope<F: Future>(self, future: F) -> tokio::task::futures::TaskLocalFuture<Self, F> {
        CONTEXT.scope(self, future)
    }

    /// Runs `f` with this context as the current one (synchronous code).
    pub fn sync_scope<R>(self, f: impl FnOnce() -> R) -> R {
        CONTEXT.sync_scope(self, f)
    }
}

/// A copy of the current context, if the task has one.
pub fn current() -> Option<TraceContext> {
    CONTEXT.try_with(TraceContext::clone).ok()
}

/// The current span's ids, if the task has a context.
pub fn current_ids() -> Option<SpanIds> {
    CONTEXT.try_with(|context| context.ids).ok()
}

/// The current channel, or empty.
pub fn current_channel() -> Channel {
    CONTEXT
        .try_with(|context| context.channel.get())
        .unwrap_or(Channel::EMPTY)
}

/// `bindChannel`: sets the current context's channel (validated; an invalid id clears it).
pub fn bind_channel(channel: &str) {
    let channel = label::channel(channel);
    let _ = CONTEXT.try_with(|context| context.set_channel(channel));
}

/// `traceOutcome`: sets the outcome the current span ends with.
pub fn set_outcome(outcome: &str) {
    let outcome = Label::clean(outcome);
    let _ = CONTEXT.try_with(|context| context.set_outcome(outcome));
}

/// Wraps `future` so it runs with a copy of the current context (explicit propagation into a task
/// that is about to be spawned). Without a current context the future runs without one.
pub fn in_current<F: Future>(future: F) -> impl Future<Output = F::Output> {
    let context = current();
    async move {
        match context {
            Some(context) => context.scope(future).await,
            None => future.await,
        }
    }
}

/// [`tokio::spawn`] with the current context carried into the new task.
pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(in_current(future))
}

/// The ids saved in a queue payload (`observability` in the reference's TTS queue items and
/// domain-event metadata): `{traceId, spanId, sampled}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedTrace {
    /// 32 lowercase hex characters.
    #[serde(rename = "traceId")]
    pub trace_id: String,
    /// 16 lowercase hex characters.
    #[serde(rename = "spanId")]
    pub span_id: String,
    /// Whether the trace is sampled.
    #[serde(default)]
    pub sampled: bool,
}

impl SavedTrace {
    /// The current context's ids, for a payload that will be processed elsewhere.
    pub fn current() -> Option<Self> {
        current_ids().map(Self::from_ids)
    }

    /// From ids.
    pub fn from_ids(ids: SpanIds) -> Self {
        Self {
            trace_id: ids.trace_id.hex().as_str().to_owned(),
            span_id: ids.span_id.hex().as_str().to_owned(),
            sampled: ids.sampled,
        }
    }

    /// The ids, when both are well-formed.
    pub fn ids(&self) -> Option<SpanIds> {
        Some(SpanIds {
            trace_id: TraceId::parse(&self.trace_id)?,
            span_id: SpanId::parse(&self.span_id)?,
            sampled: self.sampled,
        })
    }
}

/// `restoreContext(saved, channel, run)`: the saved ids when valid (the work continues that
/// trace), otherwise a fresh trace sampled at `rate`; the channel is the given one.
pub fn restore(saved: Option<&SavedTrace>, channel: &str, rate: f64) -> TraceContext {
    let ids = saved.and_then(SavedTrace::ids).unwrap_or_else(|| SpanIds {
        trace_id: TraceId::random(),
        span_id: SpanId::random(),
        sampled: sample(rate),
    });
    TraceContext::new(ids, label::channel(channel))
}

/// [`restore`] from untyped JSON (a payload field that may be missing or malformed).
pub fn restore_json(saved: Option<&serde_json::Value>, channel: &str, rate: f64) -> TraceContext {
    let saved = saved.and_then(|value| SavedTrace::deserialize(value).ok());
    restore(saved.as_ref(), channel, rate)
}

/// The `traceparent` header name.
pub const TRACEPARENT: &str = "traceparent";
/// The signature header name.
pub const SIGNATURE: &str = "x-observability-signature";

/// `00-<trace>-<span>-<01|00>`, on the stack.
pub fn traceparent(ids: &SpanIds) -> HexId<55> {
    let mut out = [b'-'; 55];
    out[0] = b'0';
    out[1] = b'0';
    hex_into(&ids.trace_id.0, &mut out[3..35]);
    hex_into(&ids.span_id.0, &mut out[36..52]);
    out[53] = b'0';
    out[54] = if ids.sampled { b'1' } else { b'0' };
    HexId(out)
}

/// Parses `^00-([a-f0-9]{32})-([a-f0-9]{16})-(0[01])$`.
pub fn parse_traceparent(value: &str) -> Option<SpanIds> {
    let rest = value.strip_prefix("00-")?;
    let (trace, rest) = rest.split_once('-')?;
    let (span, flags) = rest.split_once('-')?;
    let sampled = match flags {
        "01" => true,
        "00" => false,
        _ => return None,
    };
    Some(SpanIds {
        trace_id: TraceId::parse(trace)?,
        span_id: SpanId::parse(span)?,
        sampled,
    })
}

/// The two headers for a call to one of our own services, or `None` without a secret key (the
/// reference adds nothing then).
pub fn sign(secret: &SecretString, ids: &SpanIds) -> Option<(HexId<55>, String)> {
    let parent = traceparent(ids);
    let signature = trace_signature(secret, parent.as_str())?;
    Some((parent, signature))
}

/// The remote parent of an incoming request: trusted only when the signature verifies, so public
/// callers cannot force capture or join a trace.
pub fn verify(
    secret: Option<&SecretString>,
    traceparent: &str,
    signature: &str,
) -> Option<SpanIds> {
    let secret = secret?;
    if !verify_trace_signature(secret, traceparent, signature) {
        return None;
    }
    parse_traceparent(traceparent)
}
