//! Responses, read under their limits.

use crate::client::Cancel;
use crate::error::{Error, FailureClass, RequestInfo, Result, StatusError, TimeoutKind};
use crate::observe::EndGuard;
use crate::redact::QueryShown;
use crate::sse::SseStream;
use bytes::{Bytes, BytesMut};
use http::{HeaderMap, StatusCode};
use serde::de::DeserializeOwned;
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::Instant;

/// The limits a body is read under.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub max_bytes: u64,
    pub idle: Duration,
    pub deadline: Instant,
}

/// A response whose body has not been read yet.
///
/// Every read counts decompressed bytes against the byte limit (going over is
/// [`Error::BodyTooLarge`], never a silent cut), waits at most the idle timeout for each chunk,
/// stops at the request's total deadline, and stops with [`Error::Cancelled`] on shutdown.
/// Dropping the response closes the connection if the body was not read to the end.
pub struct Response {
    inner: reqwest::Response,
    url: url::Url,
    info: RequestInfo,
    query: QueryShown,
    limits: Limits,
    received: u64,
    cancel: Cancel,
    attempts: u32,
    refresh_unavailable: bool,
    retried_status: bool,
    end: Option<EndGuard>,
    _permit: Option<OwnedSemaphorePermit>,
}

impl std::fmt::Debug for Response {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Response")
            .field("info", &self.info)
            .field("status", &self.inner.status().as_u16())
            .field("attempts", &self.attempts)
            .finish_non_exhaustive()
    }
}

impl Response {
    pub(crate) fn new(
        inner: reqwest::Response,
        info: RequestInfo,
        query: QueryShown,
        limits: Limits,
        cancel: Cancel,
    ) -> Self {
        Self {
            url: inner.url().clone(),
            inner,
            info,
            query,
            limits,
            received: 0,
            cancel,
            attempts: 1,
            refresh_unavailable: false,
            retried_status: false,
            end: None,
            _permit: None,
        }
    }

    pub(crate) fn with_attempt_state(
        mut self,
        attempts: u32,
        refresh_unavailable: bool,
        retried_status: bool,
        end: Option<EndGuard>,
        permit: Option<OwnedSemaphorePermit>,
    ) -> Self {
        self.attempts = attempts;
        self.refresh_unavailable = refresh_unavailable;
        self.retried_status = retried_status;
        self.end = end;
        self._permit = permit;
        self
    }

    /// The URL this answered, for a response rebuilt from buffered parts.
    pub(crate) fn with_url(mut self, url: url::Url) -> Self {
        self.url = url;
        self
    }

    /// The status.
    pub fn status(&self) -> StatusCode {
        self.inner.status()
    }

    /// The headers.
    pub fn headers(&self) -> &HeaderMap {
        self.inner.headers()
    }

    /// The request this answers (safe to print), with its redacted query: a provider's secret
    /// parameters are replaced; for a guarded request every value is replaced.
    pub fn info(&self) -> RequestInfo {
        self.info.clone().with_query(&self.url, &self.query)
    }

    /// How many attempts were made.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// Whether a 401 could not be retried because the credential refresh returned
    /// [`crate::Refresh::Stop`] (the reference's `refreshUnavailable`, reported as 503).
    pub fn auth_refresh_unavailable(&self) -> bool {
        self.refresh_unavailable
    }

    /// Body bytes read so far.
    pub fn bytes_read(&self) -> u64 {
        self.received
    }

    /// Changes the body byte limit.
    pub fn max_bytes(mut self, max: u64) -> Self {
        self.limits.max_bytes = max;
        self
    }

    /// Changes the idle timeout between chunks.
    pub fn idle_timeout(mut self, idle: Duration) -> Self {
        self.limits.idle = idle;
        self
    }

    /// The `Content-Length` the server declared, if the body is not being decompressed.
    pub fn content_length(&self) -> Option<u64> {
        self.inner.content_length()
    }

    /// The next chunk of the body (`None` at the end).
    pub async fn chunk(&mut self) -> Result<Option<Bytes>> {
        if self.received == 0
            && let Some(declared) = self.inner.content_length()
            && declared > self.limits.max_bytes
        {
            return Err(self.fail(FailureClass::TooLarge));
        }
        enum Step {
            Cancelled,
            Total,
            Idle,
            Next(reqwest::Result<Option<Bytes>>),
        }
        let step = tokio::select! {
            biased;
            () = self.cancel.wait() => Step::Cancelled,
            () = tokio::time::sleep_until(self.limits.deadline) => Step::Total,
            () = tokio::time::sleep(self.limits.idle) => Step::Idle,
            next = self.inner.chunk() => Step::Next(next),
        };
        match step {
            Step::Cancelled => Err(self.fail(FailureClass::Cancelled)),
            Step::Total => Err(self.fail(FailureClass::Timeout(TimeoutKind::Total))),
            Step::Idle => Err(self.fail(FailureClass::Timeout(TimeoutKind::Idle))),
            Step::Next(Ok(Some(bytes))) => {
                let len = bytes.len() as u64;
                self.received += len;
                if let Some(end) = &mut self.end {
                    end.add_received(len);
                }
                if self.received > self.limits.max_bytes {
                    return Err(self.fail(FailureClass::TooLarge));
                }
                Ok(Some(bytes))
            }
            Step::Next(Ok(None)) => {
                if let Some(end) = &mut self.end {
                    end.finish_body();
                }
                Ok(None)
            }
            Step::Next(Err(error)) => {
                let error = Error::from_reqwest(self.info(), error);
                if let Some(end) = &mut self.end {
                    end.fail(error.class());
                }
                Err(error)
            }
        }
    }

    /// Records the failure with the observer and builds its error.
    fn fail(&mut self, class: FailureClass) -> Error {
        if let Some(end) = &mut self.end {
            end.fail(class);
        }
        let info = self.info();
        match class {
            FailureClass::Cancelled => Error::Cancelled { info },
            FailureClass::Timeout(kind) => Error::Timeout { info, kind },
            _ => Error::BodyTooLarge {
                info,
                limit: self.limits.max_bytes,
            },
        }
    }

    /// The whole body.
    pub async fn bytes(mut self) -> Result<Bytes> {
        let first = match self.chunk().await? {
            Some(first) => first,
            None => return Ok(Bytes::new()),
        };
        let Some(second) = self.chunk().await? else {
            return Ok(first);
        };
        let hint = self
            .inner
            .content_length()
            .unwrap_or(0)
            .min(self.limits.max_bytes);
        let mut buffer = BytesMut::with_capacity(usize::try_from(hint).unwrap_or(0));
        buffer.extend_from_slice(&first);
        buffer.extend_from_slice(&second);
        while let Some(chunk) = self.chunk().await? {
            buffer.extend_from_slice(&chunk);
        }
        Ok(buffer.freeze())
    }

    /// The body as text (invalid UTF-8 becomes U+FFFD, as `Response.text()` does).
    pub async fn text(self) -> Result<String> {
        let bytes = self.bytes().await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// The body parsed as JSON. Unpaired surrogate escapes become U+FFFD first (MIGRATION.md,
    /// text rule 3).
    pub async fn json<T: DeserializeOwned>(self) -> Result<T> {
        let info = self.info();
        let bytes = self.bytes().await?;
        let clean = dima_text::sanitize_lone_surrogates(&bytes);
        serde_json::from_slice(&clean).map_err(|error| Error::Decode {
            info,
            category: crate::error::DecodeCategory::of_json(&error),
            line: error.line(),
            column: error.column(),
        })
    }

    /// Writes the body to `writer`, returning the bytes written.
    pub async fn write_to<W: AsyncWrite + Unpin>(mut self, writer: &mut W) -> Result<u64> {
        while let Some(chunk) = self.chunk().await? {
            writer
                .write_all(&chunk)
                .await
                .map_err(|error| Error::Transport {
                    info: self.info(),
                    source: Box::new(error),
                })?;
        }
        writer.flush().await.map_err(|error| Error::Transport {
            info: self.info(),
            source: Box::new(error),
        })?;
        Ok(self.received)
    }

    /// Reads the body as a Server-Sent Events stream.
    pub fn sse(self) -> SseStream {
        SseStream::new(self)
    }

    /// `Ok(self)` for a 2xx status; otherwise [`Error::Status`] with allow-listed headers and the
    /// first [`StatusError::BODY_SLICE`] bytes of the body (wrapped in
    /// [`Error::RetriesExhausted`] when the status was retried).
    pub async fn error_for_status(self) -> Result<Self> {
        if self.status().is_success() {
            return Ok(self);
        }
        Err(self.into_status_error().await)
    }

    /// The status error for this response, reading at most a bounded slice of the body.
    pub async fn into_status_error(mut self) -> Error {
        let status = self.status();
        let headers = crate::redact::kept_headers(self.headers());
        let mut body = BytesMut::new();
        let mut truncated = false;
        let slice = StatusError::BODY_SLICE;
        self.limits.max_bytes = u64::MAX;
        while body.len() < slice {
            match self.chunk().await {
                Ok(Some(chunk)) => {
                    let room = slice - body.len();
                    if chunk.len() > room {
                        body.extend_from_slice(chunk.get(..room).unwrap_or_default());
                        truncated = true;
                    } else {
                        body.extend_from_slice(&chunk);
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        let attempts = self.attempts;
        let retried = self.retried_status;
        let error = Error::Status(Box::new(StatusError {
            info: self.info(),
            status,
            headers,
            body: body.freeze(),
            body_truncated: truncated,
        }));
        if retried && attempts > 1 {
            Error::RetriesExhausted {
                attempts,
                last: Box::new(error),
            }
        } else {
            error
        }
    }
}
