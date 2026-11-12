//! Spans (`beginSpan` / `traced`).
//!
//! A [`Span`] is a guard: it records its metric (`observe(kind, name, duration, outcome)`) when it
//! ends, and a span row when the trace is sampled, the span took at least one second, or it
//! failed. A span that is dropped without [`Span::end`] (its future was cancelled) ends
//! `aborted`. Starting and ending a span that is not kept does not allocate.
//!
//! Deviation: the metric goes into the 10-second bucket in which the span **ended** (the reference
//! uses the bucket it started in). The page shows completed operations, and this keeps every
//! series within two buckets between flushes.

use crate::aggregate::FinishedSpan;
use crate::label::Channel;
use crate::telemetry::Telemetry;
use crate::trace::{self, SpanId, SpanIds, TraceContext};
use std::future::Future;
use tokio::time::Instant;

/// One span in progress.
pub struct Span<'a> {
    telemetry: &'a Telemetry,
    kind: &'a str,
    name: &'a str,
    context: TraceContext,
    parent: Option<SpanId>,
    started: Instant,
    at: u64,
    ended: bool,
}

impl std::fmt::Debug for Span<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Span")
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("context", &self.context)
            .finish()
    }
}

impl<'a> Span<'a> {
    pub(crate) fn start(
        telemetry: &'a Telemetry,
        kind: &'a str,
        name: &'a str,
        channel: Option<Channel>,
    ) -> Self {
        let parent = trace::current();
        let parent_ids = parent.as_ref().map(TraceContext::ids);
        let ids = telemetry.new_ids(parent_ids);
        let channel = channel.unwrap_or_else(|| {
            parent
                .as_ref()
                .map_or(Channel::EMPTY, TraceContext::channel)
        });
        Self {
            telemetry,
            kind,
            name,
            context: TraceContext::new(ids, channel),
            parent: parent_ids.map(|ids| ids.span_id),
            started: Instant::now(),
            at: telemetry.now_ms(),
            ended: false,
        }
    }

    /// The span's ids.
    pub fn ids(&self) -> SpanIds {
        self.context.ids()
    }

    /// The span's context (a copy is what [`Span::run`] makes current).
    pub fn context(&self) -> &TraceContext {
        &self.context
    }

    /// Runs `future` with this span as the current context. A channel bound or an outcome set
    /// inside ([`trace::bind_channel`], [`trace::set_outcome`]) is kept by the span.
    pub async fn run<F: Future>(&mut self, future: F) -> F::Output {
        let mut scoped = std::pin::pin!(self.context.clone().scope(future));
        let output = scoped.as_mut().await;
        if let Some(context) = scoped.as_mut().take_value() {
            self.context = context;
        }
        output
    }

    /// Ends the span with `outcome`, unless an outcome was set from inside.
    pub fn end(mut self, outcome: &str) {
        self.finish(outcome, None);
    }

    /// Ends the span under a final name (`span.end(outcome, finalName)`).
    pub fn end_as(mut self, outcome: &str, name: &str) {
        self.finish(outcome, Some(name));
    }

    fn finish(&mut self, outcome: &str, name: Option<&str>) {
        if self.ended {
            return;
        }
        self.ended = true;
        let set = self.context.outcome();
        let outcome = set.as_ref().map_or(outcome, |label| label.as_str());
        let ids = self.context.ids();
        self.telemetry.finish_span(&FinishedSpan {
            trace_id: ids.trace_id,
            span_id: ids.span_id,
            parent: self.parent,
            sampled: ids.sampled,
            channel: self.context.channel(),
            at: self.at,
            duration_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            kind: self.kind,
            name: name.unwrap_or(self.name),
            outcome,
        });
    }
}

impl Drop for Span<'_> {
    fn drop(&mut self) {
        self.finish("aborted", None);
    }
}
