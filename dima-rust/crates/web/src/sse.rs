//! Server-Sent Events: a response body fed through a bounded channel, one frame per write, with
//! an optional fixed-interval heartbeat comment, and a sender that knows when the client is gone.
//!
//! The three reference streams, as handlers write them here:
//!
//! ```
//! use std::time::Duration;
//!
//! use dima_web::sse::{self, Event, SseOptions};
//! use dima_web::{Req, Response};
//! use serde_json::json;
//!
//! // GET /config/site/analytics/stream: unnamed `data:` frames, `: keep-alive` every 30 s.
//! async fn analytics(_req: &mut Req) -> Response {
//!     let (events, body) = sse::channel(SseOptions::new().heartbeat(Duration::from_secs(30), "keep-alive"));
//!     tokio::spawn(async move {
//!         let mut every = tokio::time::interval(Duration::from_millis(500));
//!         loop {
//!             tokio::select! {
//!                 () = events.closed() => break,
//!                 _ = every.tick() => {
//!                     let snapshot = json!({ "online": 3 });
//!                     if events.json(&snapshot).await.is_err() {
//!                         break;
//!                     }
//!                 }
//!             }
//!         }
//!     });
//!     Response::new()
//!         .header("Content-Type", "text/event-stream")
//!         .header("Cache-Control", "no-cache")
//!         .header("Connection", "keep-alive")
//!         .stream(body)
//! }
//!
//! // docs-assistant and site-agent: named events, `id:` lines, `: ping` every 15 s.
//! async fn agent_events(_req: &mut Req) -> Response {
//!     let (events, body) = sse::channel(SseOptions::new().heartbeat(Duration::from_secs(15), "ping"));
//!     tokio::spawn(async move {
//!         let start = Event::json(&json!({ "id": "t1" })).map(|e| e.id("1700000000000-0").event("start"));
//!         if let Ok(start) = start {
//!             let _ = events.send(&start).await;
//!         }
//!         let _ = events.send(&Event::data("{}").event("resync")).await;
//!     });
//!     Response::new()
//!         .header("Content-Type", "text/event-stream; charset=utf-8")
//!         .header("Cache-Control", "no-cache, no-transform")
//!         .header("X-Accel-Buffering", "no")
//!         .stream(body)
//! }
//! # let _ = (analytics, agent_events);
//! ```
//!
//! The stream ends (`res.end()`) when every [`SseSender`] is dropped. When the client goes away
//! the body is dropped, [`SseSender::closed`] resolves and further writes fail with [`Closed`].

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::HttpBody;
use bytes::Bytes;
use hyper::body::Frame;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::{Instant, Interval, MissedTickBehavior};
use tokio_util::sync::{CancellationToken, DropGuard};

/// Frames buffered for a slow client by default; writers wait when it is full.
pub const DEFAULT_CAPACITY: usize = 64;

/// The client went away (or the stream was otherwise dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the event stream is closed")]
pub struct Closed;

/// One event: optional `id:` and `event:` lines, then the data, one `data:` line per line of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    id: Option<String>,
    name: Option<String>,
    data: String,
}

impl Event {
    /// An event whose data is `data`.
    pub fn data(data: impl Into<String>) -> Self {
        Self {
            id: None,
            name: None,
            data: data.into(),
        }
    }

    /// An event whose data is `JSON.stringify(value)` (`dima_text::to_js_json_from`).
    pub fn json<T: Serialize + ?Sized>(value: &T) -> Result<Self, crate::Error> {
        let bytes =
            dima_text::to_js_json_from(value).map_err(|e| crate::Error::msg(e.to_string()))?;
        let text = String::from_utf8(bytes).map_err(|e| crate::Error::msg(e.to_string()))?;
        Ok(Self::data(text))
    }

    /// Sets the `id:` line. Line breaks are removed so a value cannot end the frame.
    #[must_use]
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(single_line(id.into()));
        self
    }

    /// Sets the `event:` line. Line breaks are removed so a value cannot end the frame.
    #[must_use]
    pub fn event(mut self, name: impl Into<String>) -> Self {
        self.name = Some(single_line(name.into()));
        self
    }

    /// The frame on the wire: `id: …\nevent: …\ndata: …\n\n`, in that order (the order the
    /// site-agent stream writes). Data with line breaks becomes several `data:` lines, which a
    /// client joins back with `\n`; single-line data (all JSON) is exactly the reference's
    /// `data: ${JSON.stringify(x)}\n\n`.
    pub fn encode(&self) -> Bytes {
        let mut frame = String::with_capacity(self.data.len() + 32);
        if let Some(id) = &self.id {
            frame.push_str("id: ");
            frame.push_str(id);
            frame.push('\n');
        }
        if let Some(name) = &self.name {
            frame.push_str("event: ");
            frame.push_str(name);
            frame.push('\n');
        }
        for line in self.data.split("\r\n").flat_map(|l| l.split(['\r', '\n'])) {
            frame.push_str("data: ");
            frame.push_str(line);
            frame.push('\n');
        }
        frame.push('\n');
        Bytes::from(frame)
    }
}

fn single_line(text: String) -> String {
    if text.contains(['\r', '\n']) {
        text.replace(['\r', '\n'], "")
    } else {
        text
    }
}

/// A comment frame: `: text\n\n` (heartbeats).
pub fn comment(text: &str) -> Bytes {
    Bytes::from(format!(": {}\n\n", single_line(text.to_owned())))
}

/// How an event stream is set up.
#[derive(Debug, Clone)]
pub struct SseOptions {
    capacity: usize,
    heartbeat: Option<(Duration, Bytes)>,
}

impl Default for SseOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl SseOptions {
    /// No heartbeat, [`DEFAULT_CAPACITY`] frames of buffer.
    pub fn new() -> Self {
        Self {
            capacity: DEFAULT_CAPACITY,
            heartbeat: None,
        }
    }

    /// Writes `: <text>\n\n` every `every`, from `every` after the stream starts, whatever else is
    /// written (the reference's `setInterval`).
    #[must_use]
    pub fn heartbeat(mut self, every: Duration, text: &str) -> Self {
        self.heartbeat = Some((every, comment(text)));
        self
    }

    /// Frames buffered before writers wait (at least 1).
    #[must_use]
    pub fn capacity(mut self, frames: usize) -> Self {
        self.capacity = frames.max(1);
        self
    }
}

/// Creates an event stream: the sender for the handler's producer task and the body to return
/// with [`crate::Response::stream`]. Must be called inside a Tokio runtime when a heartbeat is
/// set.
pub fn channel(options: SseOptions) -> (SseSender, SseBody) {
    let (frames, receiver) = mpsc::channel(options.capacity);
    let closed = CancellationToken::new();
    let heartbeat = options.heartbeat.map(|(every, frame)| {
        let every = every.max(Duration::from_millis(1));
        let mut interval = tokio::time::interval_at(Instant::now() + every, every);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        (interval, frame)
    });
    let sender = SseSender {
        frames,
        closed: closed.clone(),
    };
    let body = SseBody {
        frames: receiver,
        heartbeat,
        _closed: closed.drop_guard(),
    };
    (sender, body)
}

/// Writes frames to one event stream. Clone it to write from several tasks.
#[derive(Debug, Clone)]
pub struct SseSender {
    frames: mpsc::Sender<Bytes>,
    closed: CancellationToken,
}

impl SseSender {
    /// Writes one event; waits while the client's buffer is full.
    pub async fn send(&self, event: &Event) -> Result<(), Closed> {
        self.raw(event.encode()).await
    }

    /// Writes `data: <text>\n\n`.
    pub async fn data(&self, text: impl Into<String>) -> Result<(), Closed> {
        self.send(&Event::data(text)).await
    }

    /// Writes `data: <JSON.stringify(value)>\n\n`.
    pub async fn json<T: Serialize + ?Sized>(&self, value: &T) -> Result<(), Closed> {
        match Event::json(value) {
            Ok(event) => self.send(&event).await,
            Err(_) => Err(Closed),
        }
    }

    /// Writes `event: <name>\ndata: <text>\n\n`.
    pub async fn event(&self, name: &str, data: impl Into<String>) -> Result<(), Closed> {
        self.send(&Event::data(data).event(name)).await
    }

    /// Writes `: <text>\n\n`.
    pub async fn comment(&self, text: &str) -> Result<(), Closed> {
        self.raw(comment(text)).await
    }

    /// Writes bytes as they are, as one frame.
    pub async fn raw(&self, frame: Bytes) -> Result<(), Closed> {
        if self.closed.is_cancelled() {
            return Err(Closed);
        }
        tokio::select! {
            sent = self.frames.send(frame) => sent.map_err(|_| Closed),
            () = self.closed.cancelled() => Err(Closed),
        }
    }

    /// Resolves when the client has gone away (the body was dropped).
    pub async fn closed(&self) {
        self.closed.cancelled().await;
    }

    /// The client has gone away.
    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// A token cancelled when the client goes away, for work that should stop with the stream.
    pub fn close_token(&self) -> CancellationToken {
        self.closed.clone()
    }
}

/// The body of an event stream: frames as they are written, heartbeats in between. Ends when
/// every sender is dropped; dropping it (the client went away) closes the senders.
pub struct SseBody {
    frames: mpsc::Receiver<Bytes>,
    heartbeat: Option<(Interval, Bytes)>,
    _closed: DropGuard,
}

impl std::fmt::Debug for SseBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SseBody")
            .field(
                "heartbeat",
                &self.heartbeat.as_ref().map(|(i, _)| i.period()),
            )
            .finish_non_exhaustive()
    }
}

impl HttpBody for SseBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let this = self.get_mut();
        match this.frames.poll_recv(cx) {
            Poll::Ready(Some(frame)) => return Poll::Ready(Some(Ok(Frame::data(frame)))),
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => {}
        }
        if let Some((interval, frame)) = &mut this.heartbeat
            && interval.poll_tick(cx).is_ready()
        {
            return Poll::Ready(Some(Ok(Frame::data(frame.clone()))));
        }
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn frames_are_written_like_the_reference() {
        let analytics = Event::json(&json!({ "online": 3, "label": "😀" })).expect("json");
        assert_eq!(
            analytics.encode(),
            "data: {\"online\":3,\"label\":\"😀\"}\n\n"
        );
        let docs = Event::json(&json!({ "phase": "thinking" }))
            .expect("json")
            .event("status");
        assert_eq!(
            docs.encode(),
            "event: status\ndata: {\"phase\":\"thinking\"}\n\n"
        );
        let agent = Event::data("{}").event("resync").id("1700000000000-0");
        assert_eq!(
            agent.encode(),
            "id: 1700000000000-0\nevent: resync\ndata: {}\n\n"
        );
        assert_eq!(comment("ping"), ": ping\n\n");
        assert_eq!(comment("keep-alive"), ": keep-alive\n\n");
    }

    #[test]
    fn line_breaks_cannot_escape_a_frame() {
        assert_eq!(
            Event::data("a\nb\r\nc").encode(),
            "data: a\ndata: b\ndata: c\n\n"
        );
        assert_eq!(
            Event::data("x").event("evil\n\ndata: injected").encode(),
            "event: evildata: injected\ndata: x\n\n"
        );
        assert_eq!(Event::data("").encode(), "data: \n\n");
    }
}
