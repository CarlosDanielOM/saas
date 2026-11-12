//! The part of RESP2 a subscriber connection speaks: commands out (arrays of bulk strings), and
//! frames in, parsed from a byte buffer without copying the whole stream and with hard limits,
//! so a misbehaving peer cannot make the reader allocate without bound.

/// The longest line accepted for a simple string, an error or a length header.
pub(super) const MAX_LINE: usize = 64 * 1024;
/// The most elements in one array (pub/sub frames have at most 4).
const MAX_ARRAY: i64 = 16;
/// The deepest nesting accepted (pub/sub frames are flat arrays).
const MAX_DEPTH: usize = 4;

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

/// Parses one frame from the start of `input`: `Ok(None)` while it is incomplete, else the frame
/// and how many bytes it used. `max_bulk` bounds every bulk string.
pub(super) fn parse(
    input: &[u8],
    max_bulk: usize,
) -> Result<Option<(Frame, usize)>, ProtocolError> {
    parse_at(input, 0, max_bulk, 0)
}

fn parse_at(
    input: &[u8],
    at: usize,
    max_bulk: usize,
    depth: usize,
) -> Result<Option<(Frame, usize)>, ProtocolError> {
    let Some(&kind) = input.get(at) else {
        return Ok(None);
    };
    let Some((line, next)) = line(input, at + 1)? else {
        return Ok(None);
    };
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
            if length > max_bulk {
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
            let count = integer(line)?;
            if count == -1 {
                return Ok(Some((Frame::Array(None), next)));
            }
            if !(0..=MAX_ARRAY).contains(&count) {
                return Err(ProtocolError::Malformed("array length out of range"));
            }
            if depth >= MAX_DEPTH {
                return Err(ProtocolError::Malformed("arrays nested too deeply"));
            }
            let mut items = Vec::with_capacity(count.unsigned_abs() as usize);
            let mut cursor = next;
            for _ in 0..count {
                match parse_at(input, cursor, max_bulk, depth + 1)? {
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
        assert!(parse(b"*1\r\n*1\r\n*1\r\n*1\r\n*1\r\n", 1024).is_err());
        assert!(parse(b"$-2\r\n", 1024).is_err());
        assert!(parse(b"$2\r\nabXY", 1024).is_err());
        assert!(parse(b"?\r\n", 1024).is_err());
        assert!(parse(&vec![b'+'; MAX_LINE + 2], 1024).is_err());
    }

    #[test]
    fn commands_are_arrays_of_bulk_strings() {
        let mut out = Vec::new();
        command(&mut out, &[b"SUBSCRIBE", "é".as_bytes()]);
        assert_eq!(out, b"*2\r\n$9\r\nSUBSCRIBE\r\n$2\r\n\xc3\xa9\r\n");
    }
}
