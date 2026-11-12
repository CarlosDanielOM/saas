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

use crate::error::Result;
use crate::response::Response;
use std::collections::VecDeque;

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
    line: Vec<u8>,
    after_cr: bool,
    started: bool,
    data: String,
    has_data: bool,
    event: String,
    last_id: String,
    retry: Option<u64>,
    events: VecDeque<SseEvent>,
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
    /// A decoder at the start of a stream.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds bytes; complete events become available from [`SseDecoder::next_event`].
    pub fn feed(&mut self, mut bytes: &[u8]) {
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
            if self.line.is_empty() {
                self.process_line(head);
            } else {
                self.line.extend_from_slice(head);
                let line = std::mem::take(&mut self.line);
                self.process_line(&line);
                self.line = line;
                self.line.clear();
            }
            bytes = rest;
        }
        self.line.extend_from_slice(bytes);
    }

    /// The next complete event, if any.
    pub fn next_event(&mut self) -> Option<SseEvent> {
        self.events.pop_front()
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

    fn process_line(&mut self, mut line: &[u8]) {
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix(b"\xEF\xBB\xBF") {
                line = rest;
            }
        }
        if line.is_empty() {
            self.dispatch();
            return;
        }
        if line.first() == Some(&b':') {
            return;
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
            b"data" => {
                self.data.push_str(&String::from_utf8_lossy(value));
                self.data.push('\n');
                self.has_data = true;
            }
            b"event" => self.event = String::from_utf8_lossy(value).into_owned(),
            b"id" => {
                if !value.contains(&0) {
                    self.last_id = String::from_utf8_lossy(value).into_owned();
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
    }

    fn dispatch(&mut self) {
        let event = std::mem::take(&mut self.event);
        if !self.has_data {
            self.data.clear();
            return;
        }
        self.has_data = false;
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
            data.pop();
        }
        self.events.push_back(SseEvent {
            event: if event.is_empty() {
                "message".to_owned()
            } else {
                event
            },
            data,
            id: self.last_id.clone(),
        });
    }
}

/// An event stream read from a [`Response`] with its limits: the body byte limit bounds the whole
/// stream, the idle timeout bounds the gap between chunks, the total deadline and shutdown apply.
/// Dropping it closes the connection.
#[derive(Debug)]
pub struct SseStream {
    response: Response,
    decoder: SseDecoder,
    done: bool,
}

impl SseStream {
    pub(crate) fn new(response: Response) -> Self {
        Self {
            response,
            decoder: SseDecoder::new(),
            done: false,
        }
    }

    /// The next event; `None` when the stream has ended.
    pub async fn next_event(&mut self) -> Option<Result<SseEvent>> {
        loop {
            if let Some(event) = self.decoder.next_event() {
                return Some(Ok(event));
            }
            if self.done {
                return None;
            }
            match self.response.chunk().await {
                Ok(Some(bytes)) => self.decoder.feed(&bytes),
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
            decoder.feed(chunk);
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
    fn openrouter_style_stream() {
        let body: &[u8] = b": OPENROUTER PROCESSING\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: [DONE]\n\n";
        let events = decode(&[body]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].data, "[DONE]");
    }
}
