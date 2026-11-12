//! Body middleware equal to body-parser 1.20.6: `json`, `urlencoded({ extended: true })`, `raw`.
//!
//! Each parser skips a request another parser already read (`req._body`), leaves `{}` in
//! `req.body` when the content type does not match, and sends failures down the error path:
//! 400 malformed, 413 too large or too many parameters, 415 unsupported charset or encoding.
//! Limits count bytes after `gzip`/`deflate` inflation, as raw-body does. Compressed bodies are
//! also limited on the wire to [`wire_budget`] of the limit, so input that inflates to little or
//! nothing (concatenated empty gzip members) cannot be streamed in forever; raw-body has no such
//! bound and reads until the request deadline.

use std::borrow::Cow;
use std::io::Write as _;

use bytes::{Bytes, BytesMut};
use http_body_util::BodyExt as _;
use serde_json::{Map, Value};

use crate::error::Error;
use crate::handler::{BoxFuture, Flow, Handler};
use crate::mediatype::{request_charset, type_is};
use crate::qs::{self, QsError, QsOptions};
use crate::request::{BodyState, Req};

/// body-parser's default limit, `"100kb"`.
pub const DEFAULT_LIMIT: usize = 100 * 1024;

/// How much of a rejected body is still read off the connection before answering, so the
/// client sees the error response (body-parser reads all of it; this bounds that).
const DRAIN_BUDGET: usize = 64 * 1024 * 1024;

/// Compressed bytes accepted for a body whose inflated size may be `limit`: the limit plus an
/// eighth (deflate's worst case for incompressible data is a few percent) plus 64 KiB for
/// headers. Past it the body is refused as too large (413).
pub const fn wire_budget(limit: usize) -> usize {
    limit.saturating_add(limit / 8).saturating_add(64 * 1024)
}

/// `bytes.parse('<n>kb')`.
pub const fn kb(n: usize) -> usize {
    n * 1024
}

/// `bytes.parse('<n>mb')`.
pub const fn mb(n: usize) -> usize {
    n * 1024 * 1024
}

/// Options shared by the three parsers.
#[derive(Debug, Clone)]
struct Common {
    limit: usize,
    inflate: bool,
    types: Vec<String>,
}

impl Common {
    fn new(default_type: &str) -> Self {
        Self {
            limit: DEFAULT_LIMIT,
            inflate: true,
            types: vec![default_type.to_owned()],
        }
    }
}

/// `express.json(options)`.
#[derive(Debug, Clone)]
pub struct Json {
    common: Common,
    strict: bool,
}

/// `express.json()`: 100 KB, strict, `application/json`, inflates gzip and deflate.
pub fn json() -> Json {
    Json {
        common: Common::new("application/json"),
        strict: true,
    }
}

/// `express.urlencoded(options)` with `extended: true`.
#[derive(Debug, Clone)]
pub struct Urlencoded {
    common: Common,
    parameter_limit: usize,
    depth: usize,
    node_limit: usize,
}

/// `express.urlencoded({ extended: true })`: 100 KB, 1000 parameters, depth 32.
pub fn urlencoded() -> Urlencoded {
    Urlencoded {
        common: Common::new("application/x-www-form-urlencoded"),
        parameter_limit: 1000,
        depth: 32,
        node_limit: qs::NODE_LIMIT,
    }
}

/// `express.raw(options)`: keeps the exact bytes.
#[derive(Debug, Clone)]
pub struct Raw {
    common: Common,
}

/// `express.raw()`: 100 KB, `application/octet-stream`.
pub fn raw() -> Raw {
    Raw {
        common: Common::new("application/octet-stream"),
    }
}

macro_rules! common_options {
    ($ty:ty) => {
        impl $ty {
            /// `limit`, in bytes (see [`kb`] and [`mb`]).
            #[must_use]
            pub fn limit(mut self, bytes: usize) -> Self {
                self.common.limit = bytes;
                self
            }

            /// `inflate`: accept `gzip` and `deflate` bodies (default true).
            #[must_use]
            pub fn inflate(mut self, inflate: bool) -> Self {
                self.common.inflate = inflate;
                self
            }

            /// `type`: the media types this parser reads (`type-is` syntax: `application/json`,
            /// `+json`, `text/*`, `urlencoded`, an extension).
            #[must_use]
            pub fn types(mut self, types: &[&str]) -> Self {
                self.common.types = types.iter().map(|t| (*t).to_owned()).collect();
                self
            }
        }
    };
}

common_options!(Json);
common_options!(Urlencoded);
common_options!(Raw);

impl Json {
    /// `strict`: only objects and arrays at the top level (default true).
    #[must_use]
    pub fn strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }
}

impl Urlencoded {
    /// `parameterLimit` (default 1000).
    #[must_use]
    pub fn parameter_limit(mut self, limit: usize) -> Self {
        self.parameter_limit = limit.max(1);
        self
    }

    /// `depth` (default 32).
    #[must_use]
    pub fn depth(mut self, depth: usize) -> Self {
        self.depth = depth;
        self
    }

    /// Not in body-parser: the most nested values one body may build ([`qs::NODE_LIMIT`] by
    /// default). Past it the body is refused like too many parameters (413).
    #[must_use]
    pub fn node_limit(mut self, nodes: usize) -> Self {
        self.node_limit = nodes;
        self
    }
}

/// The checks every parser makes before reading. `Ok(false)` means "skip, call next()".
fn should_read<S>(req: &mut Req<S>, common: &Common) -> bool {
    if req.body_parsed {
        return false;
    }
    if matches!(req.body, BodyState::Undefined) {
        req.body = BodyState::Value(Value::Object(Map::new()));
    }
    if !req.has_body() {
        return false;
    }
    let content_type = req.header("content-type").map(Cow::into_owned);
    type_is(content_type.as_deref(), &common.types)
}

fn charset_of<S>(req: &Req<S>) -> String {
    let content_type = req.header("content-type").map(Cow::into_owned);
    request_charset(content_type.as_deref())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "utf-8".to_owned())
}

fn unsupported_charset(charset: &str) -> Error {
    Error::new(
        415,
        format!("unsupported charset \"{}\"", charset.to_uppercase()),
    )
    .with_kind("charset.unsupported")
}

impl<S: Send + Sync + 'static> Handler<S> for Json {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            if !should_read(req, &self.common) {
                return Ok(Flow::Next);
            }
            let charset = charset_of(req);
            if !charset.starts_with("utf-") {
                return Err(unsupported_charset(&charset));
            }
            let bytes = read(req, &self.common, Some(&charset)).await?;
            let text =
                decode_text(&bytes, &charset).ok_or_else(|| unsupported_charset(&charset))?;
            req.body = BodyState::Value(parse_json(&text, self.strict)?);
            Ok(Flow::Next)
        })
    }
}

impl<S: Send + Sync + 'static> Handler<S> for Urlencoded {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            if !should_read(req, &self.common) {
                return Ok(Flow::Next);
            }
            let charset = charset_of(req);
            if charset != "utf-8" {
                return Err(unsupported_charset(&charset));
            }
            let bytes = read(req, &self.common, Some(&charset)).await?;
            let text =
                decode_text(&bytes, &charset).ok_or_else(|| unsupported_charset(&charset))?;
            req.body = BodyState::Value(self.parse(&text)?);
            Ok(Flow::Next)
        })
    }
}

fn too_many_parameters() -> Error {
    Error::new(413, "too many parameters").with_kind("parameters.too.many")
}

impl Urlencoded {
    fn parse(&self, text: &str) -> Result<Value, Error> {
        if text.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        let count = text.matches('&').count() + 1;
        if count > self.parameter_limit {
            return Err(too_many_parameters());
        }
        let options = QsOptions {
            node_limit: self.node_limit,
            ..QsOptions::urlencoded(count, self.depth, self.parameter_limit)
        };
        qs::parse(text, &options).map_err(|error| match error {
            QsError::DepthExceeded => Error::new(400, "The input exceeded the depth")
                .with_kind("querystring.parse.rangeError"),
            QsError::TooManyNodes => too_many_parameters(),
        })
    }
}

impl<S: Send + Sync + 'static> Handler<S> for Raw {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            if !should_read(req, &self.common) {
                return Ok(Flow::Next);
            }
            let bytes = read(req, &self.common, None).await?;
            req.body = BodyState::Raw(bytes);
            Ok(Flow::Next)
        })
    }
}

fn too_large() -> Error {
    Error::new(413, "request entity too large").with_kind("entity.too.large")
}

enum Inflater {
    Gzip(flate2::write::MultiGzDecoder<Sink>),
    Deflate(flate2::write::ZlibDecoder<Sink>),
}

/// Collects inflated bytes and refuses to grow past the limit (a gzip bomb stops early).
struct Sink {
    buf: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl std::io::Write for Sink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.len() + data.len() > self.limit {
            self.exceeded = true;
            return Err(std::io::Error::other("limit"));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Inflater {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Gzip(d) => d.write_all(data),
            Self::Deflate(d) => d.write_all(data),
        }
    }

    /// Flushes the decoder; a truncated or corrupt stream is an error.
    fn finish(self) -> (std::io::Result<()>, Sink) {
        let empty = || Sink {
            buf: Vec::new(),
            limit: 0,
            exceeded: false,
        };
        match self {
            Self::Gzip(mut d) => {
                let result = d.try_finish();
                (result, std::mem::replace(d.get_mut(), empty()))
            }
            Self::Deflate(mut d) => {
                let result = d.try_finish();
                (result, std::mem::replace(d.get_mut(), empty()))
            }
        }
    }

    fn exceeded(&self) -> bool {
        match self {
            Self::Gzip(d) => d.get_ref().exceeded,
            Self::Deflate(d) => d.get_ref().exceeded,
        }
    }
}

/// body-parser `read` + raw-body: content-encoding, the limit, charset support, then the bytes.
async fn read<S>(req: &mut Req<S>, common: &Common, charset: Option<&str>) -> Result<Bytes, Error> {
    req.body_parsed = true;
    let mut stream = req.take_body_stream();
    let encoding = req
        .header("content-encoding")
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "identity".to_owned());
    if !common.inflate && encoding != "identity" {
        drain(stream.as_mut()).await;
        return Err(
            Error::new(415, "content encoding unsupported").with_kind("encoding.unsupported")
        );
    }
    let sink = || Sink {
        buf: Vec::new(),
        limit: common.limit,
        exceeded: false,
    };
    let mut inflater = match encoding.as_str() {
        "identity" => None,
        "gzip" => Some(Inflater::Gzip(flate2::write::MultiGzDecoder::new(sink()))),
        "deflate" => Some(Inflater::Deflate(flate2::write::ZlibDecoder::new(sink()))),
        other => {
            drain(stream.as_mut()).await;
            return Err(
                Error::new(415, format!("unsupported content encoding \"{other}\""))
                    .with_kind("encoding.unsupported"),
            );
        }
    };
    if inflater.is_none() {
        let declared = req.header("content-length").and_then(|v| js_parse_int(&v));
        if declared.is_some_and(|length| length > common.limit as f64) {
            drain(stream.as_mut()).await;
            return Err(too_large());
        }
    }
    if let Some(charset) = charset
        && canonical_charset(charset).is_none()
    {
        drain(stream.as_mut()).await;
        return Err(unsupported_charset(charset));
    }
    let Some(mut body) = stream else {
        return Ok(Bytes::new());
    };
    let mut collected = BytesMut::new();
    let aborted = || Error::new(400, "request aborted").with_kind("request.aborted");
    let budget = wire_budget(common.limit);
    let mut wire = 0usize;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| aborted())?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        wire = wire.saturating_add(data.len());
        if inflater.is_some() && wire > budget {
            drain(Some(&mut body)).await;
            return Err(too_large());
        }
        match inflater.as_mut() {
            None => {
                if collected.len() + data.len() > common.limit {
                    drain(Some(&mut body)).await;
                    return Err(too_large());
                }
                collected.extend_from_slice(&data);
            }
            Some(inflate) => {
                if let Err(inflate_error) = inflate.write(&data) {
                    let error = if inflate.exceeded() {
                        too_large()
                    } else {
                        Error::new(400, inflate_error.to_string())
                    };
                    drain(Some(&mut body)).await;
                    return Err(error);
                }
            }
        }
    }
    match inflater {
        None => Ok(collected.freeze()),
        Some(inflate) => {
            let exceeded_before = inflate.exceeded();
            let (result, sink) = inflate.finish();
            if exceeded_before || sink.exceeded {
                return Err(too_large());
            }
            result.map_err(|e| Error::new(400, e.to_string()))?;
            Ok(Bytes::from(sink.buf))
        }
    }
}

/// Reads off the rest of a rejected body (up to [`DRAIN_BUDGET`]), like body-parser's `dump`.
async fn drain(body: Option<&mut crate::Body>) {
    let Some(body) = body else { return };
    let mut seen = 0usize;
    while let Some(Ok(frame)) = body.frame().await {
        if let Some(data) = frame.data_ref() {
            seen += data.len();
            if seen > DRAIN_BUDGET {
                return;
            }
        }
    }
}

/// JavaScript `parseInt(value, 10)` for a header (NaN as `None`).
fn js_parse_int(value: &str) -> Option<f64> {
    let s = crate::mediatype::trim_js(value);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, s.get(1..)?),
        Some(b'+') => (false, s.get(1..)?),
        _ => (false, s),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    let number: f64 = digits.get(..end).filter(|d| !d.is_empty())?.parse().ok()?;
    Some(if negative { -number } else { number })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Charset {
    Utf8,
    Utf16Le,
    Utf16Be,
    Utf16,
}

/// iconv-lite 0.4.24 encodings body-parser can be asked for (name canonicalised the same way:
/// lower case, non-alphanumerics removed). UTF-7 exists in iconv-lite but is refused here.
fn canonical_charset(name: &str) -> Option<Charset> {
    let canonical: String = name
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    match canonical.as_str() {
        "utf8" | "unicode11utf8" => Some(Charset::Utf8),
        "utf16le" | "ucs2" => Some(Charset::Utf16Le),
        "utf16be" => Some(Charset::Utf16Be),
        "utf16" => Some(Charset::Utf16),
        _ => None,
    }
}

/// Bytes to text as iconv-lite decodes them: invalid sequences become U+FFFD, a leading BOM is
/// dropped. UTF-16 without a BOM picks its byte order with iconv-lite's ASCII heuristic.
fn decode_text(bytes: &[u8], charset: &str) -> Option<String> {
    let text = match canonical_charset(charset)? {
        Charset::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
        Charset::Utf16Le => decode_utf16(bytes, false),
        Charset::Utf16Be => decode_utf16(bytes, true),
        Charset::Utf16 => {
            let big_endian = match bytes {
                [0xFE, 0xFF, ..] => true,
                [0xFF, 0xFE, ..] => false,
                _ => {
                    let len = (bytes.len() - bytes.len() % 2).min(64);
                    let (mut le, mut be) = (0, 0);
                    for [a, b] in bytes.get(..len).unwrap_or(&[]).as_chunks::<2>().0 {
                        if *a == 0 && *b != 0 {
                            be += 1;
                        }
                        if *a != 0 && *b == 0 {
                            le += 1;
                        }
                    }
                    be > le
                }
            };
            decode_utf16(bytes, big_endian)
        }
    };
    Some(match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_owned(),
        None => text,
    })
}

/// UTF-16 to a Rust string without building UTF-16 data: unpaired surrogates become U+FFFD and
/// a trailing odd byte is dropped.
fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
    let units = bytes.as_chunks::<2>().0.iter().map(|pair| {
        if big_endian {
            u16::from_be_bytes(*pair)
        } else {
            u16::from_le_bytes(*pair)
        }
    });
    char::decode_utf16(units)
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn parse_failed(message: impl Into<Cow<'static, str>>) -> Error {
    Error::new(400, message).with_kind("entity.parse.failed")
}

/// body-parser's JSON `parse`: empty is `{}`, strict mode wants `{` or `[` first.
fn parse_json(text: &str, strict: bool) -> Result<Value, Error> {
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    if strict {
        let first = text
            .chars()
            .find(|c| !matches!(c, ' ' | '\t' | '\n' | '\r'));
        if !matches!(first, Some('{' | '[')) {
            let shown = first.map(|c| c.to_string()).unwrap_or_default();
            return Err(parse_failed(format!(
                "Unexpected token '{shown}', strict mode allows only objects and arrays"
            )));
        }
    }
    // The decoded body has already passed the configured wire/inflated byte limits.
    // Keep serde_json's previous bound of 127 open containers.
    dima_text::parse_js_json(
        text,
        dima_text::JsonLimits {
            max_depth: 127,
            max_bytes: usize::MAX,
        },
    )
    .map_err(|error| {
        // Preserve the caller's existing diagnostic as well as status and error kind.
        // Only malformed inputs take this path; successful bodies are parsed once.
        let repaired = dima_text::sanitize_lone_surrogates(text.as_bytes());
        let message = serde_json::from_slice::<Value>(&repaired)
            .err()
            .map_or_else(|| error.to_string(), |error| error.to_string());
        parse_failed(message)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Text rule 3, through the shared `dima_text::sanitize_lone_surrogates`.
    #[test]
    fn lone_surrogates_become_replacement_characters() {
        let parse = |text: &str| parse_json(text, true).expect("parses");
        assert_eq!(parse(r#"{"a":"\ud83d\ude00"}"#), json!({"a": "😀"}));
        assert_eq!(parse(r#"{"a":"\ud83d"}"#), json!({"a": "\u{FFFD}"}));
        assert_eq!(parse(r#"{"a":"\ude00x"}"#), json!({"a": "\u{FFFD}x"}));
        assert_eq!(
            parse(r#"{"a":"\uDE00\uD83D"}"#),
            json!({"a": "\u{FFFD}\u{FFFD}"})
        );
        // An escaped backslash before `u` is text, not an escape.
        assert_eq!(parse(r#"{"a":"\\ud83d"}"#), json!({"a": "\\ud83d"}));
        assert_eq!(parse(r#"{"\ud83d":"x"}"#), json!({"\u{FFFD}": "x"}));
        assert_eq!(
            parse(r#"{"a":"x\ud800y","b":"\ud83d\ude00"}"#),
            json!({"a": "x\u{FFFD}y", "b": "😀"})
        );
    }

    #[test]
    fn json_parse_rules() {
        assert_eq!(parse_json("", true).ok(), Some(json!({})));
        assert_eq!(parse_json(" \n[1]", true).ok(), Some(json!([1])));
        assert_eq!(
            parse_json("\"x\"", true).map_err(|e| e.status()).err(),
            Some(Some(400))
        );
        assert_eq!(
            parse_json("  ", true)
                .map_err(|e| e.kind().map(str::to_owned))
                .err(),
            Some(Some("entity.parse.failed".to_owned()))
        );
        assert_eq!(parse_json("\"x\"", false).ok(), Some(json!("x")));
        assert!(parse_json("{bad", true).is_err());
        let ordered = parse_json(r#"{"b":1,"2":2,"a":3,"1":4}"#, true).expect("parses");
        let keys: Vec<&String> = ordered
            .as_object()
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        assert_eq!(keys, ["1", "2", "b", "a"]);
    }

    /// Review finding: integers above 2^53 kept full precision where `JSON.parse` rounds them.
    /// Expectations from Node 26 `JSON.stringify(JSON.parse(text))`.
    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let value = parse_json(r#"{"b":1,"2":2,"a":3,"b":4,"1":5}"#, true).expect("parses");
        assert_eq!(
            dima_text::to_js_json(&value),
            r#"{"1":5,"2":2,"b":4,"a":3}"#
        );
    }

    #[test]
    fn numbers_are_what_javascript_holds() {
        let text = r#"{"n":9007199254740993,"m":-9007199254740993,"big":18446744073709551615,"f":1.0,"e":1e2,"z":-0,"safe":9007199254740992,"frac":0.1,"neg":-5,"arr":[1.5e300,123456789012345678901234567890]}"#;
        let value = parse_json(text, true).expect("parses");
        assert_eq!(
            dima_text::to_js_json(&value),
            r#"{"n":9007199254740992,"m":-9007199254740992,"big":18446744073709552000,"f":1,"e":100,"z":0,"safe":9007199254740992,"frac":0.1,"neg":-5,"arr":[1.5e+300,1.2345678901234568e+29]}"#
        );
        // The shared parser canonicalizes the rounded ±2^53 to integers, like other
        // integral doubles in range. The old copy left these two as doubles.
        assert!(value["n"].is_i64() && value["m"].is_i64() && value["big"].is_f64());
        assert_eq!(value["n"].as_f64(), Some(9_007_199_254_740_992.0));
        // Integral values are integers for typed handlers, as `Number.isInteger` sees them.
        assert_eq!(value["f"].as_u64(), Some(1));
        assert_eq!(value["e"].as_u64(), Some(100));
        assert_eq!(value["safe"].as_u64(), Some(9_007_199_254_740_992));
        assert_eq!(value["neg"].as_i64(), Some(-5));
        assert!(
            value["z"]
                .as_f64()
                .is_some_and(|z| z == 0.0 && z.is_sign_negative())
        );
        // `JSON.parse` gives Infinity; here it is refused (allowed difference).
        let error = parse_json(r#"{"n":1e400}"#, true).expect_err("out of range");
        assert_eq!(error.status(), Some(400));
    }

    #[test]
    fn nesting_deeper_than_serde_json_allows_is_refused() {
        // Known difference: JSON.parse accepts any depth; serde_json stops at 128 levels.
        let deep = format!("{}{}", "[".repeat(128), "]".repeat(128));
        let error = parse_json(&deep, true).expect_err("too deep");
        assert_eq!(error.status(), Some(400));
        assert_eq!(error.kind(), Some("entity.parse.failed"));
        let fine = format!("{}{}", "[".repeat(127), "]".repeat(127));
        assert!(parse_json(&fine, true).is_ok());
    }

    #[test]
    fn decodes_charsets_like_iconv() {
        assert_eq!(
            decode_text(b"\xEF\xBB\xBF{}", "utf-8").as_deref(),
            Some("{}")
        );
        assert_eq!(
            decode_text(b"caf\xC3\xA9 \xFF", "utf-8").as_deref(),
            Some("café \u{FFFD}")
        );
        assert_eq!(
            decode_text(b"{\x00}\x00", "utf-16le").as_deref(),
            Some("{}")
        );
        assert_eq!(
            decode_text(b"\x00{\x00}", "utf-16be").as_deref(),
            Some("{}")
        );
        assert_eq!(
            decode_text(b"\xFE\xFF\x00{\x00}", "utf-16").as_deref(),
            Some("{}")
        );
        assert_eq!(decode_text(b"\x00{\x00}", "utf-16").as_deref(), Some("{}"));
        assert_eq!(
            decode_text(b"\x3D\xD8\x00\xDE", "utf-16le").as_deref(),
            Some("😀")
        );
        assert_eq!(
            decode_text(b"\x3D\xD8", "utf-16le").as_deref(),
            Some("\u{FFFD}")
        );
        assert!(decode_text(b"{}", "utf-32").is_none());
        assert!(decode_text(b"{}", "utf-7").is_none());
    }

    #[test]
    fn node_budget_is_refused_like_the_parameter_limit() {
        // The root object, two values and five segments.
        let form = urlencoded().node_limit(8);
        assert!(form.parse("a[b][c]=1&d[e]=2").is_ok());
        let error = form.parse("a[b][c]=1&d[e][f]=2").expect_err("over budget");
        assert_eq!(error.status(), Some(413));
        assert_eq!(error.kind(), Some("parameters.too.many"));
        assert_eq!(error.message(), "too many parameters");
    }

    fn request(headers: &[(&str, &str)], body: Vec<u8>) -> Req<()> {
        let mut builder = http::Request::builder()
            .method("POST")
            .uri("/")
            .header("content-length", body.len().to_string());
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let (parts, ()) = builder.body(()).expect("request").into_parts();
        Req::new(std::sync::Arc::new(()), parts, crate::Body::from(body))
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).expect("compress");
        encoder.finish().expect("compress")
    }

    /// Review finding: only the inflated output was bounded, so concatenated empty gzip members
    /// were read without end. Each member is 20 bytes that inflate to nothing.
    #[tokio::test]
    async fn compressed_input_is_bounded_on_the_wire() {
        let member = gzip(b"");
        let members = wire_budget(DEFAULT_LIMIT) / member.len() + 1;
        let body = member.repeat(members);
        let mut req = request(
            &[
                ("content-type", "application/json"),
                ("content-encoding", "gzip"),
            ],
            body,
        );
        let error = json()
            .call(&mut req)
            .await
            .expect_err("over the wire budget");
        assert_eq!(error.status(), Some(413));
        assert_eq!(error.kind(), Some("entity.too.large"));

        // Within the budget the same members are still an empty body, as in body-parser.
        let mut req = request(
            &[
                ("content-type", "application/json"),
                ("content-encoding", "gzip"),
            ],
            member.repeat(100),
        );
        assert!(matches!(json().call(&mut req).await, Ok(Flow::Next)));
        assert_eq!(req.body(), &json!({}));

        // A compressed body that inflates to exactly the limit still parses.
        let shell = r#"{"pad":""}"#.len();
        let text = format!(r#"{{"pad":"{}"}}"#, "a".repeat(DEFAULT_LIMIT - shell));
        let mut req = request(
            &[
                ("content-type", "application/json"),
                ("content-encoding", "gzip"),
            ],
            gzip(text.as_bytes()),
        );
        assert!(matches!(json().call(&mut req).await, Ok(Flow::Next)));
        assert_eq!(
            req.body()["pad"].as_str().map(str::len),
            Some(DEFAULT_LIMIT - shell)
        );
    }

    #[test]
    fn parses_header_integers_like_javascript() {
        assert_eq!(js_parse_int("12"), Some(12.0));
        assert_eq!(js_parse_int(" 12abc"), Some(12.0));
        assert_eq!(js_parse_int("abc"), None);
    }
}
