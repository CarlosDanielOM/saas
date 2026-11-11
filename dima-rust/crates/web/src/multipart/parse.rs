//! `multipart/form-data` as busboy 1.6.0 reads it for multer: the request's `Content-Type`, part
//! headers (`Content-Disposition` parameters as latin1 text, RFC 5987 `filename*`), and the body
//! split on `\r\n--<boundary>` with the same handling of preamble, epilogue and stray bytes.

use bytes::{Buf as _, Bytes, BytesMut};
use http_body_util::BodyExt as _;

use crate::Body;

/// busboy's part header limits (Node's values).
const MAX_HEADER_PAIRS: usize = 2000;
const MAX_HEADER_SIZE: usize = 16 * 1024;

/// Bytes after the closing delimiter read before the form counts as complete anyway.
const EPILOGUE_BUDGET: u64 = 64 * 1024;

/// Why the multipart stream could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ScanError {
    /// `Malformed part header`.
    MalformedHeader,
    /// `Unexpected end of form`.
    UnexpectedEnd,
    /// The request body failed (the client went away, or the request deadline passed).
    Aborted,
}

pub(crate) fn tchar(b: u8) -> bool {
    matches!(b, b'!' | b'#'..=b'\'' | b'*' | b'+' | b'-' | b'.' | b'0'..=b'9' | b'A'..=b'Z' | b'^'..=b'z' | b'|' | b'~')
}

fn qdtext(b: u8) -> bool {
    matches!(b, b'\t' | b' ' | b'!' | 0x23..=0x5B | 0x5D..=0x7E | 0x80..=0xFF)
}

fn charset_char(b: u8) -> bool {
    matches!(b, b'!' | b'#'..=b'&' | b'+' | b'-' | b'0'..=b'9' | b'A'..=b'Z' | b'^'..=b'{' | b'}' | b'~')
}

fn extended_value(b: u8) -> bool {
    matches!(b, b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'0'..=b'9' | b'A'..=b'Z' | b'^'..=b'z' | b'|' | b'~')
}

fn field_vchar(b: u8) -> bool {
    matches!(b, b'\t' | 0x20..=0x7E | 0x80..=0xFF)
}

/// Text from latin1 bytes (header values as busboy reads them: one character per byte).
pub(crate) fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// The character codes of latin1 text (header text has none above U+00FF), which is what
/// busboy's parsers walk.
fn char_codes(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(0))
        .collect()
}

/// Parameters in order of appearance, the first of each name kept.
pub(crate) type Params = Vec<(String, String)>;

/// busboy's `parseContentType`: lower-cased type and subtype, parameters (first one wins).
pub(crate) fn parse_content_type(value: &str) -> Option<(String, String, Params)> {
    let codes = char_codes(value);
    let bytes = codes.as_slice();
    if bytes.is_empty() {
        return None;
    }
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes.get(i).copied().unwrap_or(0);
        if !tchar(b) {
            if b != b'/' || i == 0 {
                return None;
            }
            break;
        }
        i += 1;
    }
    if i == bytes.len() {
        return None;
    }
    let kind = latin1(bytes.get(..i)?).to_ascii_lowercase();
    i += 1;
    let subtype_start = i;
    while bytes.get(i).copied().is_some_and(tchar) {
        i += 1;
    }
    if i == subtype_start {
        return None;
    }
    let subtype = latin1(bytes.get(subtype_start..i)?).to_ascii_lowercase();
    let params = if i < bytes.len() {
        parse_params(bytes, i, false)?
    } else {
        Vec::new()
    };
    Some((kind, subtype, params))
}

/// The `Content-Disposition` value: lower-cased type and parameters. Plain values stay latin1 text
/// (multer passes no `defParamCharset`); `name*=charset'lang'value` values are decoded.
pub(crate) fn parse_disposition(value: &str) -> Option<(String, Params)> {
    let codes = char_codes(value);
    let bytes = codes.as_slice();
    if bytes.is_empty() {
        return None;
    }
    let end = bytes.iter().position(|&b| !tchar(b)).unwrap_or(bytes.len());
    let params = if end < bytes.len() {
        parse_params(bytes, end, true)?
    } else {
        Vec::new()
    };
    let kind = latin1(bytes.get(..end)?).to_ascii_lowercase();
    Some((kind, params))
}

/// busboy's `parseContentTypeParams` / `parseDispositionParams` from `i`. `None` when malformed.
fn parse_params(bytes: &[u8], mut i: usize, disposition: bool) -> Option<Params> {
    let at = |i: usize| bytes.get(i).copied();
    let mut params: Params = Vec::new();
    while i < bytes.len() {
        while matches!(at(i), Some(b' ' | b'\t')) {
            i += 1;
        }
        if i == bytes.len() {
            break;
        }
        if at(i) != Some(b';') {
            return None;
        }
        i += 1;
        while matches!(at(i), Some(b' ' | b'\t')) {
            i += 1;
        }
        if i == bytes.len() {
            return None;
        }
        let name_start = i;
        while let Some(b) = at(i) {
            if !tchar(b) {
                if b != b'=' {
                    return None;
                }
                break;
            }
            i += 1;
        }
        if i == bytes.len() {
            return None;
        }
        let mut name = latin1(bytes.get(name_start..i)?);
        let value;
        if disposition && name.ends_with('*') {
            // Extended value: charset'language'percent-encoded.
            i += 1;
            let charset_start = i;
            while let Some(b) = at(i) {
                if !charset_char(b) {
                    if b != b'\'' {
                        return None;
                    }
                    break;
                }
                i += 1;
            }
            if i == bytes.len() {
                return None;
            }
            let charset = latin1(bytes.get(charset_start..i)?);
            i += 1;
            while let Some(b) = at(i) {
                if b == b'\'' {
                    break;
                }
                i += 1;
            }
            if i == bytes.len() {
                return None;
            }
            i += 1;
            if i == bytes.len() {
                return None;
            }
            let mut raw: Vec<u8> = Vec::new();
            let mut hint = 0u8;
            while let Some(b) = at(i) {
                if extended_value(b) {
                    raw.push(b);
                    i += 1;
                    continue;
                }
                if b == b'%' {
                    let high = at(i + 1).and_then(crate::uri::hex_value);
                    let low = at(i + 2).and_then(crate::uri::hex_value);
                    if let (Some(high), Some(low)) = (high, low)
                        && i + 2 < bytes.len()
                    {
                        let byte = (high << 4) | low;
                        raw.push(byte);
                        i += 3;
                        if byte >= 128 {
                            hint = 2;
                        } else if hint == 0 {
                            hint = 1;
                        }
                        continue;
                    }
                    return None;
                }
                break;
            }
            value = decode_text(&raw, &charset, hint)?;
        } else {
            i += 1;
            if i == bytes.len() {
                return None;
            }
            if at(i) == Some(b'"') {
                i += 1;
                let mut raw: Vec<u8> = Vec::new();
                let mut escaping = false;
                loop {
                    let b = at(i)?;
                    if b == b'\\' {
                        if escaping {
                            raw.push(b);
                            escaping = false;
                        } else {
                            escaping = true;
                        }
                        i += 1;
                        continue;
                    }
                    if b == b'"' {
                        if escaping {
                            raw.push(b);
                            escaping = false;
                            i += 1;
                            continue;
                        }
                        break;
                    }
                    if escaping {
                        raw.push(b'\\');
                        escaping = false;
                    }
                    if !qdtext(b) {
                        return None;
                    }
                    raw.push(b);
                    i += 1;
                }
                i += 1;
                value = latin1(&raw);
            } else {
                let start = i;
                while let Some(b) = at(i) {
                    if !tchar(b) {
                        if i == start {
                            return None;
                        }
                        break;
                    }
                    i += 1;
                }
                value = latin1(bytes.get(start..i)?);
            }
        }
        name.make_ascii_lowercase();
        if !params.iter().any(|(existing, _)| *existing == name) {
            params.push((name, value));
        }
    }
    Some(params)
}

/// busboy's `convertToUTF8(data, charset, hint)` for text that is still latin1 (a percent-decoded
/// `filename*`): UTF-8 is decoded only when an escape above 0x7F was seen.
fn decode_text(raw: &[u8], charset: &str, hint: u8) -> Option<String> {
    let lower = charset.to_ascii_lowercase();
    Some(match lower.as_str() {
        "utf-8" | "utf8" => {
            if hint < 2 {
                latin1(raw)
            } else {
                String::from_utf8_lossy(raw).into_owned()
            }
        }
        _ => decode_bytes(raw, &lower),
    })
}

/// busboy's decoders for a part's bytes (`convertToUTF8(buffer, charset)`): UTF-8 with
/// replacement characters, latin1, UTF-16LE, base64. Charsets busboy hands to `TextDecoder` are
/// read as UTF-8 here (allowed difference: no browser sends them).
pub(crate) fn decode_bytes(raw: &[u8], charset: &str) -> String {
    match charset.to_ascii_lowercase().as_str() {
        "latin1" | "ascii" | "us-ascii" | "iso-8859-1" | "iso8859-1" | "iso88591"
        | "iso_8859-1" | "windows-1252" | "iso_8859-1:1987" | "cp1252" | "x-cp1252" => latin1(raw),
        "utf16le" | "utf-16le" | "ucs2" | "ucs-2" => {
            let units = raw
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair));
            char::decode_utf16(units)
                .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                .collect()
        }
        "base64" => {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(raw)
        }
        _ => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// busboy's `basename`: the text after the last `/` or `\`; `.` and `..` become empty.
pub(crate) fn basename(path: &str) -> String {
    let tail = match path.rfind(['/', '\\']) {
        Some(at) => path.get(at + 1..).unwrap_or(""),
        None => path,
    };
    if tail == "." || tail == ".." {
        String::new()
    } else {
        tail.to_owned()
    }
}

/// Part headers: lower-cased names, every value in arrival order, latin1 text.
pub(crate) type PartHeaders = Vec<(String, Vec<String>)>;

/// busboy's `HeaderParser`, byte for byte (including how it counts towards the 16 KiB limit).
#[derive(Debug, Default)]
struct HeaderParser {
    state: HeaderState,
    name: Vec<u8>,
    value: Vec<u8>,
    crlf: u8,
    bytes: usize,
    pairs: usize,
    headers: PartHeaders,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum HeaderState {
    #[default]
    Name,
    PreOws,
    Value,
}

impl HeaderParser {
    fn count(&mut self) -> Result<(), ScanError> {
        if self.bytes == MAX_HEADER_SIZE {
            return Err(ScanError::MalformedHeader);
        }
        self.bytes += 1;
        Ok(())
    }

    fn save(&mut self) {
        self.pairs += 1;
        if self.pairs < MAX_HEADER_PAIRS {
            let name = latin1(&self.name).to_ascii_lowercase();
            let value = latin1(&self.value);
            match self.headers.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(value),
                None => self.headers.push((name, vec![value])),
            }
        }
    }

    /// Feeds bytes; returns how many were consumed when the header block ended.
    fn push(&mut self, chunk: &[u8]) -> Result<Option<usize>, ScanError> {
        let mut pos = 0;
        while let Some(&b) = chunk.get(pos) {
            match self.state {
                HeaderState::Name => {
                    self.count()?;
                    if tchar(b) {
                        self.name.push(b);
                        pos += 1;
                    } else if b == b':' && !self.name.is_empty() {
                        self.state = HeaderState::PreOws;
                        pos += 1;
                    } else {
                        return Err(ScanError::MalformedHeader);
                    }
                }
                HeaderState::PreOws => {
                    self.count()?;
                    if b == b' ' || b == b'\t' {
                        pos += 1;
                    } else {
                        // The value starts here; busboy counts this byte again below.
                        self.state = HeaderState::Value;
                        self.crlf = 0;
                    }
                }
                HeaderState::Value => match self.crlf {
                    0 => {
                        self.count()?;
                        if field_vchar(b) {
                            self.value.push(b);
                        } else if b == b'\r' {
                            self.crlf = 1;
                        } else {
                            return Err(ScanError::MalformedHeader);
                        }
                        pos += 1;
                    }
                    1 => {
                        self.count()?;
                        if b != b'\n' {
                            return Err(ScanError::MalformedHeader);
                        }
                        self.crlf = 2;
                        pos += 1;
                    }
                    2 => {
                        self.count()?;
                        if b == b' ' || b == b'\t' {
                            // A folded line: the space or tab stays in the value (counted again).
                            self.crlf = 0;
                        } else {
                            self.save();
                            if b == b'\r' {
                                self.crlf = 3;
                                pos += 1;
                            } else {
                                // The next header's name starts here (counted again).
                                self.state = HeaderState::Name;
                                self.crlf = 0;
                                self.name.clear();
                                self.value.clear();
                            }
                        }
                    }
                    _ => {
                        self.count()?;
                        if b != b'\n' {
                            return Err(ScanError::MalformedHeader);
                        }
                        return Ok(Some(pos + 1));
                    }
                },
            }
        }
        Ok(None)
    }
}

/// One step of the multipart stream.
#[derive(Debug)]
pub(crate) enum Item {
    /// A part's headers are complete.
    Headers(PartHeaders),
    /// Bytes of the current part.
    Data(Bytes),
    /// A delimiter (`\r\n--boundary`), ending the current part if there is one.
    Delimiter,
    /// The input ended after the closing delimiter.
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Bytes outside any part (preamble, or after a delimiter not followed by CRLF): ignored.
    Ignore,
    /// Just after a delimiter.
    AfterDelimiter,
    Headers,
    Body,
    /// After the closing delimiter: everything is ignored.
    Done,
}

/// The body split on the delimiter, read from the request as needed.
pub(crate) struct Scanner {
    body: Option<Body>,
    buf: BytesMut,
    needle: Vec<u8>,
    state: State,
    headers: HeaderParser,
    peeked: Option<Item>,
    /// Bytes read off the request.
    pub(crate) wire: u64,
    /// `wire` when the closing delimiter was seen.
    done_at: u64,
}

impl Scanner {
    pub(crate) fn new(body: Option<Body>, boundary: &str) -> Self {
        let mut needle = b"\r\n--".to_vec();
        needle.extend_from_slice(boundary.as_bytes());
        // busboy writes a CRLF first, so a body without a preamble starts with a delimiter.
        let mut buf = BytesMut::with_capacity(16 * 1024);
        buf.extend_from_slice(b"\r\n");
        Self {
            body,
            buf,
            needle,
            state: State::Ignore,
            headers: HeaderParser::default(),
            peeked: None,
            wire: 0,
            done_at: 0,
        }
    }

    /// Reads more of the request; `false` at its end.
    async fn fill(&mut self) -> Result<bool, ScanError> {
        let Some(body) = self.body.as_mut() else {
            return Ok(false);
        };
        loop {
            match body.frame().await {
                None => {
                    self.body = None;
                    return Ok(false);
                }
                Some(Err(_)) => {
                    self.body = None;
                    return Err(ScanError::Aborted);
                }
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data()
                        && !data.is_empty()
                    {
                        self.wire += data.len() as u64;
                        self.buf.extend_from_slice(&data);
                        return Ok(true);
                    }
                }
            }
        }
    }

    /// Puts an item back (a file stream stops at the delimiter for the main loop).
    pub(crate) fn push_back(&mut self, item: Item) {
        self.peeked = Some(item);
    }

    fn find_needle(&self) -> Option<usize> {
        self.buf
            .windows(self.needle.len())
            .position(|window| window == self.needle.as_slice())
    }

    /// Bytes at the end of the buffer that could begin a delimiter must wait for more input.
    fn safe_len(&self) -> usize {
        let keep = self.needle.len().saturating_sub(1).min(self.buf.len());
        let mut safe = self.buf.len() - keep;
        // Hand out more when the tail cannot start the needle at all.
        while safe < self.buf.len() {
            let tail = self.buf.get(safe..).unwrap_or(&[]);
            if self.needle.starts_with(tail) {
                break;
            }
            safe += 1;
        }
        safe
    }

    /// The next item.
    pub(crate) async fn next(&mut self) -> Result<Item, ScanError> {
        if let Some(item) = self.peeked.take() {
            return Ok(item);
        }
        loop {
            match self.state {
                State::Done => {
                    // The epilogue is read and ignored, as busboy keeps accepting writes, up to
                    // a budget; past it the rest stays unread and the connection closes.
                    self.buf.clear();
                    if self.wire > self.done_at.saturating_add(EPILOGUE_BUDGET)
                        || !self.fill().await?
                    {
                        return Ok(Item::End);
                    }
                }
                State::Ignore | State::Body => {
                    if let Some(at) = self.find_needle() {
                        let data = self.buf.split_to(at).freeze();
                        self.buf.advance(self.needle.len());
                        let in_body = self.state == State::Body;
                        self.state = State::AfterDelimiter;
                        if in_body && !data.is_empty() {
                            self.peeked = Some(Item::Delimiter);
                            return Ok(Item::Data(data));
                        }
                        return Ok(Item::Delimiter);
                    }
                    let safe = self.safe_len();
                    if safe > 0 {
                        let data = self.buf.split_to(safe).freeze();
                        if self.state == State::Body {
                            return Ok(Item::Data(data));
                        }
                        continue;
                    }
                    if !self.fill().await? {
                        return Err(ScanError::UnexpectedEnd);
                    }
                }
                State::AfterDelimiter => {
                    if self.buf.len() < 2 && self.fill().await? {
                        continue;
                    }
                    match (self.buf.first().copied(), self.buf.get(1).copied()) {
                        (Some(b'-'), Some(b'-')) => {
                            self.state = State::Done;
                            self.done_at = self.wire;
                        }
                        (Some(b'\r'), Some(b'\n')) => {
                            self.buf.advance(2);
                            self.headers = HeaderParser::default();
                            self.state = State::Headers;
                        }
                        (Some(b'-' | b'\r'), None) => return Err(ScanError::UnexpectedEnd),
                        (None, _) => return Err(ScanError::UnexpectedEnd),
                        // Anything else is ignored up to the next delimiter.
                        _ => self.state = State::Ignore,
                    }
                }
                State::Headers => {
                    // As with part data, bytes that may begin a delimiter wait for more input.
                    let (limit, at_delimiter) = match self.find_needle() {
                        Some(at) => (at, true),
                        None => (self.safe_len(), false),
                    };
                    let chunk = self.buf.get(..limit).unwrap_or(&[]).to_vec();
                    match self.headers.push(&chunk)? {
                        Some(consumed) => {
                            self.buf.advance(consumed);
                            self.state = State::Body;
                            let headers = std::mem::take(&mut self.headers.headers);
                            return Ok(Item::Headers(headers));
                        }
                        None => {
                            if at_delimiter {
                                // A delimiter inside the part headers (busboy would go on
                                // feeding the bytes after it to the header parser).
                                return Err(ScanError::MalformedHeader);
                            }
                            self.buf.advance(limit);
                            if !self.fill().await? {
                                return Err(ScanError::UnexpectedEnd);
                            }
                        }
                    }
                }
            }
        }
    }

    /// Reads off and ignores the rest of the request, up to `budget` bytes.
    pub(crate) async fn drain(&mut self, budget: u64) {
        let start = self.wire;
        self.buf.clear();
        while self.wire - start <= budget {
            match self.fill().await {
                Ok(true) => self.buf.clear(),
                _ => return,
            }
        }
    }
}

/// A file part's or field part's description, from its headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Part {
    /// No `Content-Disposition`, or not `form-data`: ignored.
    Skip,
    File {
        name: Option<String>,
        /// After `basename` unless paths are preserved.
        filename: Option<String>,
        encoding: String,
        mime: String,
    },
    Field {
        name: Option<String>,
        charset: String,
    },
}

/// busboy's part classification.
pub(crate) fn classify(headers: &PartHeaders, preserve_path: bool) -> Part {
    let first = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, values)| values.first())
    };
    let Some(disposition) = first("content-disposition") else {
        return Part::Skip;
    };
    let Some((kind, params)) = parse_disposition(disposition) else {
        return Part::Skip;
    };
    if kind != "form-data" {
        return Part::Skip;
    }
    let param = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    // Empty values are absent (`if (disp.params.filename)`): a part with `filename=""` is a field
    // unless its type is application/octet-stream.
    let name = param("name").filter(|n| !n.is_empty());
    let mut filename = param("filename*")
        .filter(|f| !f.is_empty())
        .or_else(|| param("filename").filter(|f| !f.is_empty()));
    if !preserve_path {
        filename = filename.map(|f| basename(&f));
    }
    let mut mime = "text/plain".to_owned();
    let mut charset = "utf8".to_owned();
    if let Some(content_type) = first("content-type")
        && let Some((kind, subtype, params)) = parse_content_type(content_type)
    {
        mime = format!("{kind}/{subtype}");
        if let Some((_, value)) = params.iter().find(|(k, _)| k == "charset") {
            charset = value.to_ascii_lowercase();
        }
    }
    let encoding = first("content-transfer-encoding")
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "7bit".to_owned());
    if mime == "application/octet-stream" || filename.is_some() {
        Part::File {
            name,
            filename,
            encoding,
            mime,
        }
    } else {
        Part::Field { name, charset }
    }
}

/// The longest boundary accepted. RFC 2046 allows 70 characters; busboy accepts any length,
/// which makes delimiter scanning quadratic in it. Longer ones are refused as malformed.
pub(crate) const MAX_BOUNDARY: usize = 256;

/// The boundary from the request's `Content-Type`, or busboy's constructor error. The delimiter
/// is the boundary text encoded as UTF-8, as busboy builds it from the latin1 header text.
pub(crate) fn boundary(content_type: &str) -> Result<String, &'static str> {
    let (kind, subtype, params) =
        parse_content_type(content_type).ok_or("Malformed content type")?;
    if kind != "multipart" || subtype != "form-data" {
        return Err("Unsupported content type");
    }
    let boundary = params
        .into_iter()
        .find(|(k, _)| k == "boundary")
        .map(|(_, v)| v)
        .ok_or("Multipart: Boundary not found")?;
    if boundary.len() > MAX_BOUNDARY {
        return Err("Malformed content type");
    }
    Ok(boundary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dispositions_like_busboy() {
        assert_eq!(
            parse_disposition("form-data; name=\"a\\\"b\"; filename=x.txt"),
            Some((
                "form-data".to_owned(),
                vec![
                    ("name".to_owned(), "a\"b".to_owned()),
                    ("filename".to_owned(), "x.txt".to_owned())
                ]
            ))
        );
        // UTF-8 bytes in a plain value stay latin1 text (multer sets no defParamCharset).
        let raw = latin1("form-data; filename=\"😀.png\"".as_bytes());
        let (_, params) = parse_disposition(&raw).expect("parses");
        assert_eq!(params[0].1, "ð\u{9f}\u{98}\u{80}.png");
        let (_, params) =
            parse_disposition("form-data; filename*=utf-8''%F0%9F%98%80.png").expect("parses");
        assert_eq!(params[0], ("filename*".to_owned(), "😀.png".to_owned()));
        assert_eq!(
            parse_disposition("FORM-DATA; NAME=x; name=y"),
            Some((
                "form-data".to_owned(),
                vec![("name".to_owned(), "x".to_owned())]
            ))
        );
        assert_eq!(parse_disposition("form-data; name"), None);
        assert_eq!(parse_disposition("form-data; name=\"x"), None);
    }

    #[test]
    fn takes_basenames_like_busboy() {
        assert_eq!(basename("C:\\fakepath\\a.mp4"), "a.mp4");
        assert_eq!(basename("../../etc/passwd"), "passwd");
        assert_eq!(basename(".."), "");
        assert_eq!(basename("dir/.."), "");
        assert_eq!(basename("plain"), "plain");
    }

    #[test]
    fn reads_boundaries() {
        assert_eq!(
            boundary("multipart/form-data; boundary=abc").as_deref(),
            Ok("abc")
        );
        assert_eq!(
            boundary("Multipart/Form-Data; Boundary=\"a b\"").as_deref(),
            Ok("a b")
        );
        assert_eq!(
            boundary("multipart/form-data"),
            Err("Multipart: Boundary not found")
        );
        assert_eq!(
            boundary("multipart/mixed; boundary=x"),
            Err("Unsupported content type")
        );
        assert_eq!(boundary("multipart"), Err("Malformed content type"));
    }

    #[test]
    fn parses_part_headers_with_folding_and_limits() {
        let mut parser = HeaderParser::default();
        let block =
            b"Content-Disposition: form-data;\r\n name=\"x\"\r\nX-A: 1\r\nx-a:  2\r\n\r\nbody";
        let consumed = parser.push(block).expect("valid").expect("complete");
        assert_eq!(block.get(consumed..), Some(&b"body"[..]));
        assert_eq!(
            parser.headers,
            vec![
                (
                    "content-disposition".to_owned(),
                    vec!["form-data; name=\"x\"".to_owned()]
                ),
                ("x-a".to_owned(), vec!["1".to_owned(), "2".to_owned()]),
            ]
        );
        let mut parser = HeaderParser::default();
        assert_eq!(
            parser.push(b"No colon\r\n"),
            Err(ScanError::MalformedHeader)
        );
        let mut parser = HeaderParser::default();
        let long = format!("X: {}\r\n\r\n", "a".repeat(MAX_HEADER_SIZE));
        assert_eq!(
            parser.push(long.as_bytes()),
            Err(ScanError::MalformedHeader)
        );
    }
}
