//! The part of RESP2 a subscriber connection speaks: commands out (arrays of bulk strings), and
//! frames in, parsed from a byte buffer without copying the whole stream and with hard limits,
//! so a misbehaving peer cannot make the reader allocate without bound.
//!
//! A subscriber only ever receives scalars and flat arrays of scalars (`message`, `pmessage`,
//! the confirmations, `pong`), so a nested array is refused, and a whole frame has a byte budget
//! ([`Limits::max_frame`]) besides the bound on each bulk string: a frame is refused as soon as a
//! header says it would exceed either, before its bytes arrive.

/// The longest line accepted for a simple string, an error or a length header.
pub(super) const MAX_LINE: usize = 64 * 1024;
/// The most elements in one array (pub/sub frames have at most 4).
const MAX_ARRAY: i64 = 16;

/// The size limits of one received frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Limits {
    /// The longest bulk string.
    pub(super) max_bulk: usize,
    /// The most bytes one whole frame may take, headers included.
    pub(super) max_frame: usize,
}

/// One reply or push frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Frame {
    Simple(Vec<u8>),
    Error(Vec<u8>),
    Int(i64),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<Frame>>),
}

/// Why the input cannot be read as frames. Either way the connection is discarded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProtocolError {
    /// A bulk string longer than the message limit.
    TooLarge,
    /// Not RESP2, or beyond the structural limits.
    Malformed(&'static str),
}

impl ProtocolError {
    pub(super) fn describe(self) -> &'static str {
        match self {
            Self::TooLarge => "a pub/sub message exceeds the configured size limit",
            Self::Malformed(what) => what,
        }
    }
}

/// Finds where the frame at the start of a growing buffer ends, keeping its progress between
/// reads, and parses it once it is complete.
///
/// Headers are checked as they arrive (limits, nesting); a bulk string's bytes are not looked at
/// until all of them are there; nothing is copied before the frame is complete. So each byte of
/// the input is examined a bounded number of times however the frame is split into reads, and a
/// frame trickling in costs no more than one that arrives whole.
///
/// Contract: between calls the buffer only grows at its end, and once a frame is returned the
/// caller removes (or skips) its bytes; the next call starts at the next frame.
#[derive(Debug, Default)]
pub(super) struct Framer {
    /// Offset from the frame's start of the next header to read.
    cursor: usize,
    /// Elements still expected in the frame's array; `None` before the first header is read.
    remaining: Option<usize>,
    /// Bytes from the cursor already searched for the header's CRLF without finding it.
    searched: usize,
    /// A bulk string's bytes are awaited: the buffer must reach this length, and its CRLF ends
    /// there.
    awaiting: Option<usize>,
    /// Bytes looked at so far (tests check it stays linear).
    #[cfg(test)]
    pub(super) examined: usize,
}

/// What reading one header found.
enum Step {
    /// An element (or the whole scalar frame) ended at this offset.
    Element(usize),
    /// The top-level array header: this many elements follow, from this offset.
    Array(usize, usize),
    /// A bulk string's data ends (with its CRLF) at this offset.
    Bulk(usize),
}

impl Framer {
    /// The next complete frame and how many bytes it used, or `Ok(None)` while it is incomplete.
    pub(super) fn next(
        &mut self,
        input: &[u8],
        limits: Limits,
    ) -> Result<Option<(Frame, usize)>, ProtocolError> {
        loop {
            if let Some(end) = self.awaiting {
                if input.len() < end {
                    return Ok(None);
                }
                if input.get(end - 2..end) != Some(b"\r\n") {
                    return Err(ProtocolError::Malformed("bulk string without its CRLF"));
                }
                self.awaiting = None;
                if self.element_done(end) {
                    return self.complete(input, limits);
                }
                continue;
            }
            let Some(step) = self.header(input, limits)? else {
                return Ok(None);
            };
            match step {
                Step::Element(end) => {
                    if self.element_done(end) {
                        return self.complete(input, limits);
                    }
                }
                Step::Array(count, after) => {
                    self.cursor = after;
                    self.remaining = Some(count);
                    if count == 0 {
                        return self.complete(input, limits);
                    }
                }
                Step::Bulk(end) => self.awaiting = Some(end),
            }
        }
    }

    /// Reads the header at the cursor, if its line is complete.
    fn header(&mut self, input: &[u8], limits: Limits) -> Result<Option<Step>, ProtocolError> {
        let at = self.cursor;
        let from = at + 1 + self.searched;
        let rest = input.get(from..).unwrap_or_default();
        self.count(rest.len());
        let Some(found) = rest.windows(2).position(|pair| pair == b"\r\n") else {
            // Keep the last byte: it may be the CR of a CRLF split across reads.
            self.searched += rest.len().saturating_sub(1);
            // The earliest the line can still end is with a CR as the last byte received.
            if input.len() + 1 > limits.max_frame {
                return Err(ProtocolError::TooLarge);
            }
            if input.len().saturating_sub(at + 2) > MAX_LINE {
                return Err(ProtocolError::Malformed("RESP line too long"));
            }
            return Ok(None);
        };
        self.searched = 0;
        let line_end = from + found;
        let next = line_end + 2;
        if next > limits.max_frame {
            return Err(ProtocolError::TooLarge);
        }
        if line_end - at - 1 > MAX_LINE {
            return Err(ProtocolError::Malformed("RESP line too long"));
        }
        let kind = input.get(at).copied().unwrap_or_default();
        let line = input.get(at + 1..line_end).unwrap_or_default();
        let nested = self.remaining.is_some();
        match kind {
            b'+' | b'-' => Ok(Some(Step::Element(next))),
            b':' => {
                integer(line)?;
                Ok(Some(Step::Element(next)))
            }
            b'$' => {
                let length = integer(line)?;
                if length == -1 {
                    return Ok(Some(Step::Element(next)));
                }
                let length = usize::try_from(length)
                    .map_err(|_| ProtocolError::Malformed("negative bulk string length"))?;
                let end = next.saturating_add(length).saturating_add(2);
                if length > limits.max_bulk || end > limits.max_frame {
                    return Err(ProtocolError::TooLarge);
                }
                Ok(Some(Step::Bulk(end)))
            }
            b'*' if nested => Err(ProtocolError::Malformed(
                "nested RESP arrays are not accepted",
            )),
            b'*' => {
                let count = integer(line)?;
                if count == -1 {
                    return Ok(Some(Step::Element(next)));
                }
                if !(0..=MAX_ARRAY).contains(&count) {
                    return Err(ProtocolError::Malformed("array length out of range"));
                }
                Ok(Some(Step::Array(count.unsigned_abs() as usize, next)))
            }
            _ => Err(ProtocolError::Malformed("unknown RESP2 type byte")),
        }
    }

    /// An element ended at `end`: `true` when that completes the frame.
    fn element_done(&mut self, end: usize) -> bool {
        self.cursor = end;
        match &mut self.remaining {
            None => true,
            Some(remaining) => {
                *remaining = remaining.saturating_sub(1);
                *remaining == 0
            }
        }
    }

    /// Parses the complete frame (one linear pass) and starts over for the next one.
    fn complete(
        &mut self,
        input: &[u8],
        limits: Limits,
    ) -> Result<Option<(Frame, usize)>, ProtocolError> {
        let end = self.cursor;
        self.count(end);
        let frame = parse_with(input.get(..end).unwrap_or_default(), limits)?;
        *self = Self {
            #[cfg(test)]
            examined: self.examined,
            ..Self::default()
        };
        match frame {
            Some((frame, used)) if used == end => Ok(Some((frame, used))),
            _ => Err(ProtocolError::Malformed("RESP frame boundary mismatch")),
        }
    }

    #[cfg(test)]
    fn count(&mut self, bytes: usize) {
        self.examined += bytes;
    }

    #[cfg(not(test))]
    fn count(&mut self, _bytes: usize) {}
}

/// Parses one frame from the start of `input`: `Ok(None)` while it is incomplete, else the frame
/// and how many bytes it used.
pub(super) fn parse_with(
    input: &[u8],
    limits: Limits,
) -> Result<Option<(Frame, usize)>, ProtocolError> {
    parse_at(input, 0, limits, false)
}

#[cfg(test)]
fn parse(input: &[u8], max_bulk: usize) -> Result<Option<(Frame, usize)>, ProtocolError> {
    parse_with(
        input,
        Limits {
            max_bulk,
            max_frame: usize::MAX,
        },
    )
}

fn parse_at(
    input: &[u8],
    at: usize,
    limits: Limits,
    nested: bool,
) -> Result<Option<(Frame, usize)>, ProtocolError> {
    let Some(&kind) = input.get(at) else {
        return Ok(None);
    };
    let Some((line, next)) = line(input, at + 1)? else {
        return Ok(None);
    };
    if next > limits.max_frame {
        return Err(ProtocolError::TooLarge);
    }
    match kind {
        b'+' => Ok(Some((Frame::Simple(line.to_vec()), next))),
        b'-' => Ok(Some((Frame::Error(line.to_vec()), next))),
        b':' => Ok(Some((Frame::Int(integer(line)?), next))),
        b'$' => {
            let length = integer(line)?;
            if length == -1 {
                return Ok(Some((Frame::Bulk(None), next)));
            }
            let length = usize::try_from(length)
                .map_err(|_| ProtocolError::Malformed("negative bulk string length"))?;
            if length > limits.max_bulk || next + length + 2 > limits.max_frame {
                return Err(ProtocolError::TooLarge);
            }
            let end = next + length;
            match input.get(end..end + 2) {
                None => Ok(None),
                Some(b"\r\n") => Ok(Some((
                    Frame::Bulk(input.get(next..end).map(<[u8]>::to_vec)),
                    end + 2,
                ))),
                Some(_) => Err(ProtocolError::Malformed("bulk string without its CRLF")),
            }
        }
        b'*' => {
            if nested {
                return Err(ProtocolError::Malformed(
                    "nested RESP arrays are not accepted",
                ));
            }
            let count = integer(line)?;
            if count == -1 {
                return Ok(Some((Frame::Array(None), next)));
            }
            if !(0..=MAX_ARRAY).contains(&count) {
                return Err(ProtocolError::Malformed("array length out of range"));
            }
            let mut items = Vec::with_capacity(count.unsigned_abs() as usize);
            let mut cursor = next;
            for _ in 0..count {
                match parse_at(input, cursor, limits, true)? {
                    None => return Ok(None),
                    Some((item, after)) => {
                        items.push(item);
                        cursor = after;
                    }
                }
            }
            Ok(Some((Frame::Array(Some(items)), cursor)))
        }
        _ => Err(ProtocolError::Malformed("unknown RESP2 type byte")),
    }
}

/// The line starting at `at` (without its CRLF) and the index after the CRLF.
fn line(input: &[u8], at: usize) -> Result<Option<(&[u8], usize)>, ProtocolError> {
    let rest = input.get(at..).unwrap_or_default();
    match rest.windows(2).position(|pair| pair == b"\r\n") {
        Some(end) if end <= MAX_LINE => Ok(rest.get(..end).map(|line| (line, at + end + 2))),
        Some(_) => Err(ProtocolError::Malformed("RESP line too long")),
        None if rest.len() > MAX_LINE => Err(ProtocolError::Malformed("RESP line too long")),
        None => Ok(None),
    }
}

fn integer(line: &[u8]) -> Result<i64, ProtocolError> {
    std::str::from_utf8(line)
        .ok()
        .and_then(|text| text.parse::<i64>().ok())
        .ok_or(ProtocolError::Malformed("RESP integer is not a number"))
}

/// Appends a command (an array of bulk strings) to `output`.
pub(super) fn command(output: &mut Vec<u8>, parts: &[&[u8]]) {
    output.extend_from_slice(format!("*{}\r\n", parts.len()).as_bytes());
    for part in parts {
        output.extend_from_slice(format!("${}\r\n", part.len()).as_bytes());
        output.extend_from_slice(part);
        output.extend_from_slice(b"\r\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bulk(text: &str) -> Frame {
        Frame::Bulk(Some(text.as_bytes().to_vec()))
    }

    #[test]
    fn frames_parse_whole_and_wait_when_incomplete() {
        let message = b"*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$5\r\nh\r\nlo\r\n+PONG\r\n";
        let (frame, used) = parse(message, 1024).unwrap().unwrap();
        assert_eq!(
            frame,
            Frame::Array(Some(vec![bulk("message"), bulk("ch"), bulk("h\r\nlo")]))
        );
        let (pong, end) = parse(message.get(used..).unwrap(), 1024).unwrap().unwrap();
        assert_eq!(pong, Frame::Simple(b"PONG".to_vec()));
        assert_eq!(used + end, message.len());
        // Every strict prefix is incomplete, never an error.
        for cut in 0..used {
            assert_eq!(
                parse(message.get(..cut).unwrap(), 1024).unwrap(),
                None,
                "{cut}"
            );
        }
        assert_eq!(
            parse(b":-3\r\n$-1\r\n", 8).unwrap(),
            Some((Frame::Int(-3), 5))
        );
        assert_eq!(parse(b"*-1\r\n", 8).unwrap(), Some((Frame::Array(None), 5)));
        assert_eq!(
            parse(b"-ERR no\r\n", 8).unwrap(),
            Some((Frame::Error(b"ERR no".to_vec()), 9))
        );
    }

    #[test]
    fn limits_are_enforced_before_the_data_arrives() {
        // The header alone says the payload is too big: refused without waiting for it.
        assert_eq!(parse(b"$1025\r\n", 1024), Err(ProtocolError::TooLarge));
        assert_eq!(
            parse(b"*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$9999999\r\n", 1024),
            Err(ProtocolError::TooLarge)
        );
        assert!(parse(b"*17\r\n", 1024).is_err());
        assert!(parse(b"*1\r\n*1\r\n", 1024).is_err());
        assert!(parse(b"$-2\r\n", 1024).is_err());
        assert!(parse(b"$2\r\nabXY", 1024).is_err());
        assert!(parse(b"?\r\n", 1024).is_err());
        assert!(parse(&vec![b'+'; MAX_LINE + 2], 1024).is_err());
    }

    #[test]
    fn a_frame_has_a_total_budget_and_no_nested_arrays() {
        let limits = Limits {
            max_bulk: 1024,
            max_frame: 1500,
        };
        // A subscriber never receives a nested array: refused from its header.
        assert!(parse_with(b"*2\r\n$7\r\nmessage\r\n*1\r\n", limits).is_err());
        assert!(parse_with(b"*1\r\n*0\r\n", limits).is_err());
        // Children each within the bulk limit but together over the frame budget: refused from
        // the second header, before its data arrives.
        let mut frame = b"*16\r\n$1024\r\n".to_vec();
        frame.extend(std::iter::repeat_n(b'x', 1024));
        frame.extend_from_slice(b"\r\n$1024\r\n");
        assert_eq!(parse_with(&frame, limits), Err(ProtocolError::TooLarge));
        // Exactly at the budget is fine.
        let mut exact = b"*1\r\n$1024\r\n".to_vec();
        exact.extend(std::iter::repeat_n(b'x', 1024));
        exact.extend_from_slice(b"\r\n");
        let at_budget = Limits {
            max_bulk: 1024,
            max_frame: exact.len(),
        };
        assert!(matches!(parse_with(&exact, at_budget), Ok(Some(_))));
        let under = Limits {
            max_bulk: 1024,
            max_frame: exact.len() - 1,
        };
        assert_eq!(parse_with(&exact, under), Err(ProtocolError::TooLarge));
    }

    /// Feeds `bytes` to a framer `step` bytes at a time, as reads would arrive.
    fn feed(bytes: &[u8], step: usize, limits: Limits) -> (Vec<Frame>, Framer) {
        let mut framer = Framer::default();
        let mut input = Vec::new();
        let mut frames = Vec::new();
        for chunk in bytes.chunks(step) {
            input.extend_from_slice(chunk);
            while let Some((frame, used)) = framer.next(&input, limits).unwrap() {
                frames.push(frame);
                input.drain(..used);
            }
        }
        assert!(input.is_empty(), "{} bytes left", input.len());
        (frames, framer)
    }

    #[test]
    fn a_partial_frame_is_never_parsed_again() {
        // A pmessage whose pattern and channel are complete while its payload trickles in one
        // byte at a time: the framer looks at each byte a bounded number of times, instead of
        // copying the finished children again on every read.
        let big = vec![b'p'; 16 * 1024];
        let mut frame = b"*4\r\n$8\r\npmessage\r\n".to_vec();
        for _ in 0..3 {
            frame.extend_from_slice(format!("${}\r\n", big.len()).as_bytes());
            frame.extend_from_slice(&big);
            frame.extend_from_slice(b"\r\n");
        }
        frame.extend_from_slice(b"+PONG\r\n");
        let limits = Limits {
            max_bulk: big.len(),
            max_frame: 64 * 1024,
        };
        let (frames, framer) = feed(&frame, 1, limits);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1], Frame::Simple(b"PONG".to_vec()));
        let Frame::Array(Some(items)) = &frames[0] else {
            panic!("{:?}", frames[0]);
        };
        assert_eq!(items.len(), 4);
        assert!(
            framer.examined <= 3 * frame.len(),
            "{} bytes examined for {}",
            framer.examined,
            frame.len()
        );
        // Every split gives the same frames.
        for step in [2, 3, 7, 1000, frame.len()] {
            assert_eq!(feed(&frame, step, limits).0, frames, "step {step}");
        }
    }

    #[test]
    fn the_framer_keeps_the_limits() {
        let limits = Limits {
            max_bulk: 8,
            max_frame: 40,
        };
        let refused = |bytes: &[u8]| {
            let mut framer = Framer::default();
            framer.next(bytes, limits)
        };
        assert_eq!(refused(b"$9\r\n"), Err(ProtocolError::TooLarge));
        assert!(refused(b"*1\r\n*1\r\n").is_err());
        assert!(refused(b"*17\r\n").is_err());
        assert!(refused(b"$2\r\nabXY").is_err());
        assert_eq!(
            refused(b"*5\r\n$8\r\n12345678\r\n$8\r\n12345678\r\n$8\r\n"),
            Err(ProtocolError::TooLarge)
        );
        // A line that cannot end within the frame budget is refused before it ends.
        assert_eq!(refused(&[b'+'; 41]), Err(ProtocolError::TooLarge));
        assert_eq!(refused(b"+OK"), Ok(None));
    }

    #[test]
    fn commands_are_arrays_of_bulk_strings() {
        let mut out = Vec::new();
        command(&mut out, &[b"SUBSCRIBE", "é".as_bytes()]);
        assert_eq!(out, b"*2\r\n$9\r\nSUBSCRIBE\r\n$2\r\n\xc3\xa9\r\n");
    }
}
