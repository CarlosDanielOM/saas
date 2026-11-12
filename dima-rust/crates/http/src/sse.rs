//! Server-Sent Events, framed as the WHATWG HTML specification's "event stream interpretation".
//!
//! - Lines end with CRLF, LF or a lone CR; a CR at the end of one chunk followed by LF at the
//!   start of the next is one line end.
//! - A leading UTF-8 byte order mark is dropped; bytes are decoded per complete line, so a
//!   character split across chunks is decoded whole, and invalid UTF-8 becomes U+FFFD.
//! - `data` lines are joined with `\n`; `event` sets the type (default `message`); `id` sets the
//!   last event id (ignored if it contains NUL) and persists across events; `retry` with ASCII
//!   digits only sets the reconnection time; lines starting with `:` are comments; a field with
//!   no colon has an empty value; one space after the colon is removed.
//! - An empty line dispatches; an event with no data is not dispatched; an event still open when
//!   the stream ends is discarded.
//!
//! **Limits.** A decoder holds at most [`SseLimits::max_line`] bytes of one line,
//! [`SseLimits::max_event`] bytes of one event (its data and type) and
//! [`SseLimits::max_queued`] dispatched events not yet taken out. Passing one is an
//! [`SseError`] from [`SseDecoder::feed`]; the decoder then refuses further input. An
//! [`SseStream`] uses the response's byte limit for the line and event bounds and feeds the
//! decoder in pieces of at most [`SseStream::PIECE`] bytes, taking events out between pieces,
//! so its queue bound holds for any chunk the network delivers.

use crate::error::Result;
use crate::response::Response;
use bytes::Bytes;
use std::collections::VecDeque;

/// The bounds of an [`SseDecoder`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SseLimits {
    /// The longest line, in bytes, without its line end.
    pub max_line: usize,
    /// The largest event: its joined data plus its type, in bytes.
    pub max_event: usize,
    /// Dispatched events waiting to be taken out with [`SseDecoder::next_event`]. Their bytes
    /// (data, type and id together) are bounded too, at twice [`SseLimits::max_event`], so a
    /// caller that feeds without taking events out cannot be made to hold more than that.
    pub max_queued: usize,
}

/// The longest event id, in bytes. Every queued event carries the last id, so an unbounded id
/// would multiply by the queue length.
pub const MAX_ID_BYTES: usize = 1024;

impl Default for SseLimits {
    /// 8 MiB per line and per event (the default response body limit), 1024 queued events.
    fn default() -> Self {
        Self {
            max_line: 8 * 1024 * 1024,
            max_event: 8 * 1024 * 1024,
            max_queued: 1024,
        }
    }
}

/// Which [`SseLimits`] bound the input passed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SseError {
    /// A line longer than [`SseLimits::max_line`].
    #[error("event stream line longer than {0} bytes")]
    LineTooLong(usize),
    /// An event larger than [`SseLimits::max_event`].
    #[error("event stream event larger than {0} bytes")]
    EventTooLarge(usize),
    /// More than [`SseLimits::max_queued`] events waiting.
    #[error("more than {0} event stream events queued")]
    TooManyQueued(usize),
    /// An `id` field longer than [`MAX_ID_BYTES`].
    #[error("event stream id longer than {0} bytes")]
    IdTooLong(usize),
    /// The waiting events hold more than this many bytes (twice [`SseLimits::max_event`]).
    #[error("more than {0} bytes of event stream events queued")]
    QueueTooLarge(usize),
}

/// One dispatched event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    /// The event type (`message` unless an `event` field set it).
    pub event: String,
    /// The data lines joined with `\n`.
    pub data: String,
    /// The last event id at dispatch (empty if none was set).
    pub id: String,
}

/// The incremental decoder: feed it bytes, take events out.
#[derive(Default)]
pub struct SseDecoder {
    limits: SseLimits,
    failed: Option<SseError>,
    line: Vec<u8>,
    after_cr: bool,
    started: bool,
    data: String,
    has_data: bool,
    event: String,
    last_id: String,
    retry: Option<u64>,
    events: VecDeque<SseEvent>,
    /// Bytes held by `events` (data, type and id of each).
    queued_bytes: usize,
}

/// Sizes only: the buffered text is response content.
impl std::fmt::Debug for SseDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SseDecoder")
            .field("pending_bytes", &self.pending_bytes())
            .field("queued_events", &self.events.len())
            .finish_non_exhaustive()
    }
}

impl SseDecoder {
    /// A decoder at the start of a stream, with the default [`SseLimits`].
    pub fn new() -> Self {
        Self::default()
    }

    /// A decoder at the start of a stream, with these limits.
    pub fn with_limits(limits: SseLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    /// The limits.
    pub fn limits(&self) -> SseLimits {
        self.limits
    }

    /// Feeds bytes; complete events become available from [`SseDecoder::next_event`]. Passing a
    /// limit is an error, and every later call returns the same error.
    pub fn feed(&mut self, bytes: &[u8]) -> std::result::Result<(), SseError> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let result = self.feed_inner(bytes);
        if let Err(error) = result {
            self.failed = Some(error);
            self.line = Vec::new();
            self.data = String::new();
        }
        result
    }

    fn feed_inner(&mut self, mut bytes: &[u8]) -> std::result::Result<(), SseError> {
        if self.after_cr {
            self.after_cr = false;
            if let Some((b'\n', rest)) = bytes.split_first() {
                bytes = rest;
            }
        }
        while let Some(end) = bytes.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let (head, tail) = bytes.split_at(end);
            let is_cr = tail.first() == Some(&b'\r');
            let mut rest = tail.get(1..).unwrap_or_default();
            if is_cr {
                match rest.split_first() {
                    Some((b'\n', after)) => rest = after,
                    None => self.after_cr = true,
                    Some(_) => {}
                }
            }
            if self.line.len() + head.len() > self.limits.max_line {
                return Err(SseError::LineTooLong(self.limits.max_line));
            }
            if self.line.is_empty() {
                self.process_line(head)?;
            } else {
                self.line.extend_from_slice(head);
                let line = std::mem::take(&mut self.line);
                let result = self.process_line(&line);
                self.line = line;
                self.line.clear();
                result?;
            }
            bytes = rest;
        }
        if self.line.len() + bytes.len() > self.limits.max_line {
            return Err(SseError::LineTooLong(self.limits.max_line));
        }
        self.line.extend_from_slice(bytes);
        Ok(())
    }

    /// The next complete event, if any.
    pub fn next_event(&mut self) -> Option<SseEvent> {
        let event = self.events.pop_front()?;
        self.queued_bytes = self.queued_bytes.saturating_sub(event_bytes(&event));
        Some(event)
    }

    /// Bytes held for a line that has not ended yet.
    pub fn pending_bytes(&self) -> usize {
        self.line.len() + self.data.len()
    }

    /// The reconnection time a `retry` field set, in milliseconds.
    pub fn retry(&self) -> Option<u64> {
        self.retry
    }

    /// The last event id.
    pub fn last_event_id(&self) -> &str {
        &self.last_id
    }

    fn process_line(&mut self, mut line: &[u8]) -> std::result::Result<(), SseError> {
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix(b"\xEF\xBB\xBF") {
                line = rest;
            }
        }
        if line.is_empty() {
            return self.dispatch();
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        let (field, value) = match line.iter().position(|b| *b == b':') {
            Some(colon) => {
                let (field, rest) = line.split_at(colon);
                let value = rest.get(1..).unwrap_or_default();
                (field, value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &[][..]),
        };
        match field {
            // The limits count decoded bytes: an invalid byte becomes a three-byte replacement
            // character, so the text can be up to three times its input (itself at most a line).
            b"data" => {
                let text = String::from_utf8_lossy(value);
                if self.data.len() + self.event.len() + text.len() + 1 > self.limits.max_event {
                    return Err(SseError::EventTooLarge(self.limits.max_event));
                }
                self.data.push_str(&text);
                self.data.push('\n');
                self.has_data = true;
            }
            b"event" => {
                let text = String::from_utf8_lossy(value);
                if self.data.len() + text.len() > self.limits.max_event {
                    return Err(SseError::EventTooLarge(self.limits.max_event));
                }
                self.event = text.into_owned();
            }
            b"id" => {
                if value.len() > MAX_ID_BYTES {
                    return Err(SseError::IdTooLong(MAX_ID_BYTES));
                }
                if !value.contains(&0) {
                    let text = String::from_utf8_lossy(value);
                    if text.len() > MAX_ID_BYTES {
                        return Err(SseError::IdTooLong(MAX_ID_BYTES));
                    }
                    self.last_id = text.into_owned();
                }
            }
            // Too many digits to fit is ignored like any other invalid value.
            b"retry" if !value.is_empty() && value.iter().all(u8::is_ascii_digit) => {
                if let Ok(ms) = String::from_utf8_lossy(value).parse() {
                    self.retry = Some(ms);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn dispatch(&mut self) -> std::result::Result<(), SseError> {
        let event = std::mem::take(&mut self.event);
        if !self.has_data {
            self.data.clear();
            return Ok(());
        }
        if self.events.len() >= self.limits.max_queued {
            return Err(SseError::TooManyQueued(self.limits.max_queued));
        }
        self.has_data = false;
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
            data.pop();
        }
        let event = SseEvent {
            event: if event.is_empty() {
                "message".to_owned()
            } else {
                event
            },
            data,
            id: self.last_id.clone(),
        };
        let budget = self.limits.max_event.saturating_mul(2);
        let queued = self.queued_bytes.saturating_add(event_bytes(&event));
        // One event always fits, whatever its size: `max_event` already bounded it.
        if queued > budget && !self.events.is_empty() {
            return Err(SseError::QueueTooLarge(budget));
        }
        self.queued_bytes = queued;
        self.events.push_back(event);
        Ok(())
    }
}

fn event_bytes(event: &SseEvent) -> usize {
    event.event.len() + event.data.len() + event.id.len()
}

/// An event stream read from a [`Response`] with its limits: the body byte limit bounds the whole
/// stream, the idle timeout bounds the gap between chunks, the total deadline and shutdown apply.
/// Dropping it closes the connection.
pub struct SseStream {
    response: Response,
    decoder: SseDecoder,
    /// The rest of the last network chunk, not fed yet.
    pending: Bytes,
    done: bool,
}

/// Sizes only: the bytes not fed yet are response content.
impl std::fmt::Debug for SseStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SseStream")
            .field("response", &self.response)
            .field("decoder", &self.decoder)
            .field("unfed_bytes", &self.pending.len())
            .field("done", &self.done)
            .finish()
    }
}

impl SseStream {
    /// The most bytes fed to the decoder at once. Every dispatched event after the first takes at
    /// least 6 bytes (`data\n\n`), so one piece queues at most 172 events, fewer than the
    /// default [`SseLimits::max_queued`], and the stream takes them out before the next piece.
    pub const PIECE: usize = 1024;

    /// A stream whose line and event bounds are the response's byte limit (nothing larger can
    /// arrive) and whose queue holds the default number of events.
    pub(crate) fn new(response: Response) -> Self {
        let body = usize::try_from(response.max_body_bytes()).unwrap_or(usize::MAX);
        let limits = SseLimits {
            max_line: body,
            max_event: body,
            ..SseLimits::default()
        };
        Self::with_limits(response, limits)
    }

    pub(crate) fn with_limits(response: Response, limits: SseLimits) -> Self {
        Self {
            response,
            decoder: SseDecoder::with_limits(limits),
            pending: Bytes::new(),
            done: false,
        }
    }

    /// The next event; `None` when the stream has ended.
    pub async fn next_event(&mut self) -> Option<Result<SseEvent>> {
        loop {
            if let Some(event) = self.decoder.next_event() {
                return Some(Ok(event));
            }
            if !self.pending.is_empty() {
                let piece = self.pending.split_to(self.pending.len().min(Self::PIECE));
                if let Err(error) = self.decoder.feed(&piece) {
                    self.done = true;
                    self.pending = Bytes::new();
                    return Some(Err(self.response.decode_failed(error)));
                }
                continue;
            }
            if self.done {
                return None;
            }
            match self.response.chunk().await {
                Ok(Some(bytes)) => self.pending = bytes,
                Ok(None) => {
                    self.done = true;
                    return None;
                }
                Err(error) => {
                    self.done = true;
                    return Some(Err(error));
                }
            }
        }
    }

    /// The reconnection time the stream asked for, in milliseconds.
    pub fn retry(&self) -> Option<u64> {
        self.decoder.retry()
    }

    /// The last event id.
    pub fn last_event_id(&self) -> &str {
        self.decoder.last_event_id()
    }

    /// The response the stream reads (status and headers).
    pub fn response(&self) -> &Response {
        &self.response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_in(chunks: &[&[u8]]) -> (Vec<SseEvent>, SseDecoder) {
        let mut decoder = SseDecoder::new();
        let mut out = Vec::new();
        for chunk in chunks {
            decoder.feed(chunk).unwrap();
            while let Some(event) = decoder.next_event() {
                out.push(event);
            }
        }
        (out, decoder)
    }

    fn decode(chunks: &[&[u8]]) -> Vec<SseEvent> {
        decode_in(chunks).0
    }

    fn ev(event: &str, data: &str, id: &str) -> SseEvent {
        SseEvent {
            event: event.to_owned(),
            data: data.to_owned(),
            id: id.to_owned(),
        }
    }

    #[test]
    fn multi_line_data_and_event_types() {
        let events = decode(&[b"data: a\ndata:b\ndata:  c\n\nevent: delta\ndata: x\n\n"]);
        assert_eq!(
            events,
            vec![ev("message", "a\nb\n c", ""), ev("delta", "x", "")]
        );
    }

    #[test]
    fn every_line_ending_and_a_cr_split_from_its_lf() {
        let expected = vec![ev("message", "1", ""), ev("message", "2", "")];
        assert_eq!(decode(&[b"data: 1\r\n\r\ndata: 2\r\n\r\n"]), expected);
        assert_eq!(decode(&[b"data: 1\r\rdata: 2\r\r"]), expected);
        assert_eq!(decode(&[b"data: 1\n\ndata: 2\n\n"]), expected);
        // CR at the end of one chunk, LF at the start of the next: one line end, not two.
        assert_eq!(
            decode(&[b"data: 1\r", b"\ndata: 2\r", b"\n\r", b"\n"]),
            vec![ev("message", "1\n2", "")]
        );
        // Mixed endings, one byte at a time.
        let text = b"data: 1\r\n\ndata: 2\r\r\n";
        let bytes: Vec<&[u8]> = text.chunks(1).collect();
        assert_eq!(decode(&bytes), expected);
    }

    #[test]
    fn utf8_split_across_chunks_bom_and_invalid_bytes() {
        let text = "\u{feff}data: héllo 👋 مرحبا\n\n".as_bytes();
        for split in 1..text.len() {
            let (a, b) = text.split_at(split);
            assert_eq!(
                decode(&[a, b]),
                vec![ev("message", "héllo 👋 مرحبا", "")],
                "split at {split}"
            );
        }
        assert_eq!(
            decode(&[b"data: \xff\xfe\n\n"]),
            vec![ev("message", "\u{fffd}\u{fffd}", "")]
        );
        // A BOM is only dropped at the very start.
        assert_eq!(
            decode(&[b"data: 1\n\n\xEF\xBB\xBFdata: 2\n\n"]),
            vec![ev("message", "1", "")]
        );
    }

    #[test]
    fn comments_ids_retry_and_unknown_fields() {
        let (events, decoder) = decode_in(&[
            b": keep-alive\n: OPENROUTER PROCESSING\n\nid: 7\ndata: a\n\ndata: b\n\nid\ndata: c\n\nid: x\0y\ndata: d\n\nretry: 2500\nretry: 12x\nfoo: bar\ndata\n\n",
        ]);
        assert_eq!(
            events,
            vec![
                ev("message", "a", "7"),
                ev("message", "b", "7"),
                ev("message", "c", ""),
                ev("message", "d", ""),
                ev("message", "", ""),
            ]
        );
        assert_eq!(decoder.retry(), Some(2500));
    }

    #[test]
    fn events_without_data_and_unterminated_events_are_not_dispatched() {
        assert_eq!(decode(&[b"event: ping\n\n\n\ndata: end"]), vec![]);
        // The type of an undispatched event does not leak into the next one.
        assert_eq!(
            decode(&[b"event: ping\n\ndata: x\n\n"]),
            vec![ev("message", "x", "")]
        );
        // A colon in the value is kept; only one leading space is removed.
        assert_eq!(
            decode(&[b"data:  {\"a\": 1}\n\n"]),
            vec![ev("message", " {\"a\": 1}", "")]
        );
    }

    #[test]
    fn limits_bound_lines_events_and_the_queue() {
        let limits = SseLimits {
            max_line: 16,
            max_event: 24,
            max_queued: 2,
        };
        // A line that never ends, in one piece or many.
        let mut decoder = SseDecoder::with_limits(limits);
        assert_eq!(decoder.feed(&[b'a'; 17]), Err(SseError::LineTooLong(16)));
        let mut decoder = SseDecoder::with_limits(limits);
        for _ in 0..16 {
            decoder.feed(b"a").unwrap();
        }
        assert_eq!(decoder.feed(b"a"), Err(SseError::LineTooLong(16)));
        // Once failed, always failed, and nothing is held.
        assert_eq!(decoder.feed(b"\n\n"), Err(SseError::LineTooLong(16)));
        assert_eq!(decoder.pending_bytes(), 0);
        // A complete line over the limit inside one feed.
        let mut decoder = SseDecoder::with_limits(limits);
        assert_eq!(
            decoder.feed(b"data: 0123456789abcdef\n"),
            Err(SseError::LineTooLong(16))
        );
        // Exactly at the line limit is fine.
        let mut decoder = SseDecoder::with_limits(limits);
        decoder.feed(b"data: 0123456789\n\n").unwrap();
        assert_eq!(decoder.next_event().unwrap().data, "0123456789");
        // Many short data lines add up to one event over the limit.
        let mut decoder = SseDecoder::with_limits(limits);
        decoder.feed(b"data: 0123456789\n").unwrap();
        decoder.feed(b"data: 0123456789\n").unwrap();
        assert_eq!(
            decoder.feed(b"data: 0123456789\n"),
            Err(SseError::EventTooLarge(24))
        );
        // Events not taken out are bounded.
        let mut decoder = SseDecoder::with_limits(limits);
        decoder.feed(b"data: 1\n\ndata: 2\n\n").unwrap();
        assert_eq!(
            decoder.feed(b"data: 3\n\n"),
            Err(SseError::TooManyQueued(2))
        );
        // Taking them out makes room.
        let mut decoder = SseDecoder::with_limits(limits);
        for n in 0..10 {
            decoder.feed(format!("data: {n}\n\n").as_bytes()).unwrap();
            assert_eq!(decoder.next_event().unwrap().data, n.to_string());
        }
        assert_eq!(SseDecoder::new().limits(), SseLimits::default());
    }

    #[test]
    fn ids_and_queued_bytes_are_bounded_and_limits_count_decoded_text() {
        // An id is repeated on every queued event, so it has its own small bound.
        let mut decoder = SseDecoder::new();
        let mut long_id = b"id: ".to_vec();
        long_id.extend(std::iter::repeat_n(b'x', MAX_ID_BYTES + 1));
        long_id.push(b'\n');
        assert_eq!(
            decoder.feed(&long_id),
            Err(SseError::IdTooLong(MAX_ID_BYTES))
        );
        // Invalid bytes triple when decoded: the bound is on the decoded id.
        let mut decoder = SseDecoder::new();
        let mut wide_id = b"id: ".to_vec();
        wide_id.extend(std::iter::repeat_n(0xff, MAX_ID_BYTES / 2));
        wide_id.push(b'\n');
        assert_eq!(
            decoder.feed(&wide_id),
            Err(SseError::IdTooLong(MAX_ID_BYTES))
        );
        // The same for data and for the event type.
        let limits = SseLimits {
            max_line: 64,
            max_event: 24,
            max_queued: 100,
        };
        let mut decoder = SseDecoder::with_limits(limits);
        assert_eq!(
            decoder.feed(b"data: \xff\xff\xff\xff\xff\xff\xff\xff\n"),
            Err(SseError::EventTooLarge(24))
        );
        let mut decoder = SseDecoder::with_limits(limits);
        assert_eq!(
            decoder.feed(b"event: \xff\xff\xff\xff\xff\xff\xff\xff\xff\n"),
            Err(SseError::EventTooLarge(24))
        );
        // Events not taken out are bounded by their bytes as well as by their number: here 48
        // bytes, each event holding 7 of type, 10 of data and 3 of id.
        let mut decoder = SseDecoder::with_limits(limits);
        decoder.feed(b"id: abc\n").unwrap();
        decoder.feed(b"data: 0123456789\n\n").unwrap();
        decoder.feed(b"data: 0123456789\n\n").unwrap();
        assert_eq!(
            decoder.feed(b"data: 0123456789\n\n"),
            Err(SseError::QueueTooLarge(48))
        );
        // Taking events out gives the bytes back.
        let mut decoder = SseDecoder::with_limits(limits);
        decoder.feed(b"id: abc\n").unwrap();
        for _ in 0..10 {
            decoder.feed(b"data: 0123456789\n\n").unwrap();
            decoder.feed(b"data: 0123456789\n\n").unwrap();
            assert_eq!(decoder.next_event().unwrap().id, "abc");
            assert_eq!(decoder.next_event().unwrap().data, "0123456789");
        }
    }

    #[test]
    fn openrouter_style_stream() {
        let body: &[u8] = b": OPENROUTER PROCESSING\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: [DONE]\n\n";
        let events = decode(&[body]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].data, "[DONE]");
    }
}
