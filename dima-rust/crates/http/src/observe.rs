//! The telemetry seam: an observer for request starts and ends, and a hook that adds trace
//! headers to requests for our own services. No telemetry is implemented here.
//!
//! The reference (`utils/observability/telemetry.ts` `instrumentFetch`) opens a span per call
//! labelled by a fixed provider name, and adds `traceparent` and its HMAC only for the internal
//! API hosts; PostHog and dima-analytics are not instrumented at all. Here the label is the
//! [`crate::Provider`] name, trace headers go only to providers built with
//! [`crate::ProviderBuilder::internal`], and the telemetry crate decides which providers it
//! records. The guarded client reports as provider `"guarded"` with a
//! [`crate::guard::host_class`] in place of the template, never the user's URL.

use crate::error::FailureClass;
use http::{HeaderMap, Method};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// An attempt is about to be sent.
#[derive(Clone, Copy, Debug)]
pub struct RequestStart<'a> {
    /// The provider name.
    pub provider: &'static str,
    /// The method.
    pub method: &'a Method,
    /// The path template (never the rendered path).
    pub template: &'static str,
    /// The attempt number, from 1.
    pub attempt: u32,
}

/// An attempt has ended: it failed, it was retried, or its body was read, failed or dropped.
#[derive(Clone, Copy, Debug)]
pub struct RequestEnd<'a> {
    /// The provider name.
    pub provider: &'static str,
    /// The method.
    pub method: &'a Method,
    /// The path template.
    pub template: &'static str,
    /// The attempt number, from 1.
    pub attempt: u32,
    /// The status, if the server answered.
    pub status: Option<u16>,
    /// The failure, if the attempt or its body failed.
    pub failure: Option<FailureClass>,
    /// Whether the body was read to its end.
    pub body_complete: bool,
    /// From sending to the end of the body (or the failure).
    pub duration: Duration,
    /// Request body bytes, when known.
    pub bytes_sent: Option<u64>,
    /// Response body bytes read (after decompression).
    pub bytes_received: u64,
}

/// Sees every attempt. Calls happen on the request's task: keep them cheap and non-blocking.
pub trait Observer: Send + Sync + std::fmt::Debug {
    /// An attempt starts.
    fn request_start(&self, _start: &RequestStart<'_>) {}
    /// An attempt ends.
    fn request_end(&self, _end: &RequestEnd<'_>) {}
}

/// The observer that does nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopObserver;

impl Observer for NoopObserver {}

/// Adds trace headers to requests for internal providers.
pub trait TraceInjector: Send + Sync + std::fmt::Debug {
    /// Called for each attempt to a provider marked internal.
    fn inject(&self, provider: &'static str, headers: &mut HeaderMap);
}

/// Emits the end of one attempt exactly once: on [`EndGuard::finish`], or when dropped.
#[derive(Debug)]
pub(crate) struct EndGuard {
    observer: Arc<dyn Observer>,
    provider: &'static str,
    method: Method,
    template: &'static str,
    attempt: u32,
    started: Instant,
    bytes_sent: Option<u64>,
    status: Option<u16>,
    failure: Option<FailureClass>,
    received: u64,
    complete: bool,
    done: bool,
}

impl EndGuard {
    pub(crate) fn start(
        observer: Arc<dyn Observer>,
        provider: &'static str,
        method: &Method,
        template: &'static str,
        attempt: u32,
        bytes_sent: Option<u64>,
    ) -> Self {
        observer.request_start(&RequestStart {
            provider,
            method,
            template,
            attempt,
        });
        Self {
            observer,
            provider,
            method: method.clone(),
            template,
            attempt,
            started: Instant::now(),
            bytes_sent,
            status: None,
            failure: None,
            received: 0,
            complete: false,
            done: false,
        }
    }

    pub(crate) fn set_status(&mut self, status: u16) {
        self.status = Some(status);
    }

    pub(crate) fn add_received(&mut self, bytes: u64) {
        self.received += bytes;
    }

    pub(crate) fn finish_body(&mut self) {
        self.complete = true;
        self.emit();
    }

    pub(crate) fn fail(&mut self, failure: FailureClass) {
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
        self.emit();
    }

    fn emit(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        self.observer.request_end(&RequestEnd {
            provider: self.provider,
            method: &self.method,
            template: self.template,
            attempt: self.attempt,
            status: self.status,
            failure: self.failure,
            body_complete: self.complete,
            duration: self.started.elapsed(),
            bytes_sent: self.bytes_sent,
            bytes_received: self.received,
        });
    }
}

impl Drop for EndGuard {
    fn drop(&mut self) {
        self.emit();
    }
}
