//! Files as `send` 0.19.2 sends them for `express.static` (serve-static 1.16.3) and
//! `res.sendFile` (Express 4.22) with the options the reference uses (all defaults).
//!
//! Every request resolves and opens its path anew: generated audio and clips appear and
//! disappear at run time, so nothing about a file is cached between requests. The file is opened
//! once, and its size, modification time and validators come from the opened file, so the
//! headers and the bytes always belong to the same file even when the path is replaced in
//! between (send stats the path, then opens it again). Symbolic links are followed as before.
//!
//! Knowingly different: a file that exists but cannot be opened (no read permission) fails at
//! lookup, so `HEAD` answers 500 too, and `express.static` reports it instead of trying the
//! next file (send answered `HEAD` with the headers from `stat` and failed `GET` while
//! streaming).

use std::io;
use std::time::SystemTime;

use http::header::{self, HeaderValue};
use http::{Method, StatusCode};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio_util::io::ReaderStream;

use crate::Body;
use crate::conditional::{fresh, parse_http_date};
use crate::error::Error;
use crate::mediatype::{mime_charset, mime_lookup};
use crate::request::{Req, header_value};
use crate::uri::{decode_uri_component, encode_url, escape_html};

/// Bytes read from a file per chunk (Node's default for file streams).
const CHUNK: usize = 64 * 1024;

/// What sending produced.
pub(crate) enum Sent {
    /// The answer: the file, a 206 range, a 304, a HEAD answer, or the static redirect.
    Response(http::Response<Body>),
    /// `next()`: serve-static falls through, or `sendFile` met a directory.
    Next,
    /// `next(err)`.
    Error(Error),
}

/// `send.error(status, err)` while an `error` listener is attached: the error to emit. Headers
/// already set on the response stay (finalhandler then sends them with its page).
struct Failure {
    status: u16,
    headers: Vec<(String, String)>,
    source: Option<io::Error>,
}

impl Failure {
    fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            source: None,
        }
    }

    /// `onStatError`: missing paths are 404, anything else 500.
    fn stat(error: io::Error) -> Self {
        let status = match error.kind() {
            io::ErrorKind::NotFound
            | io::ErrorKind::NotADirectory
            | io::ErrorKind::InvalidFilename => 404,
            _ => 500,
        };
        Self {
            status,
            headers: Vec::new(),
            source: Some(error),
        }
    }

    /// `createError(status, err)` from http-errors.
    fn into_error(self) -> Error {
        let error = match self.source {
            Some(source) => Error::from_source(source)
                .with_status(self.status)
                .with_expose(false),
            None => Error::new(
                self.status,
                crate::status::message(self.status).unwrap_or("Unknown Error"),
            ),
        };
        self.headers
            .into_iter()
            .fold(error, |error, (name, value)| error.with_header(name, value))
    }
}

/// A file opened for sending, with the metadata of that open file.
struct Opened {
    path: String,
    file: tokio::fs::File,
    metadata: std::fs::Metadata,
}

/// Where the file lookup ended.
enum Found {
    File(Box<Opened>),
    Directory,
    Failed(Failure),
}

/// Opens `path` (following symbolic links) and reads the metadata of what was opened.
async fn open(path: &str) -> io::Result<(tokio::fs::File, std::fs::Metadata)> {
    let file = tokio::fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    Ok((file, metadata))
}

/// `express.static(root)` for the request path (relative to the mount point).
pub(crate) async fn serve_static<S>(req: &mut Req<S>, root: &str) -> Sent {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return Sent::Next;
    }
    let original = crate::request::pathname(req.original_url()).to_owned();
    let mut path = req.path().to_owned();
    // Make the redirect happen at the mount point.
    if path == "/" && !original.ends_with('/') {
        path.clear();
    }
    // Once a file is found every error is forwarded; before that, client errors fall through.
    let mut file_seen = false;
    let found = match decode_uri_component(&path) {
        Some(decoded) => find(&path, &decoded, Some(root), &mut file_seen).await,
        None => Found::Failed(Failure::status(400)),
    };
    let forward = |failure: Failure, file_seen: bool| {
        if file_seen || failure.status >= 500 {
            Sent::Error(failure.into_error())
        } else {
            Sent::Next
        }
    };
    match found {
        Found::File(opened) => match deliver(req, opened).await {
            Ok(response) => Sent::Response(response),
            Err(failure) => forward(failure, true),
        },
        Found::Directory => match redirect_to_directory(req) {
            Ok(response) => Sent::Response(response),
            Err(error) => Sent::Error(error),
        },
        Found::Failed(failure) => forward(failure, file_seen),
    }
}

/// `res.sendFile(path)` without options or callback, as every reference call site uses it.
pub(crate) async fn send_file<S>(req: &mut Req<S>, path: &str) -> Sent {
    if !path.starts_with('/') {
        return Sent::Error(Error::msg(
            "path must be absolute or specify root to res.sendFile",
        ));
    }
    // Express hands `encodeURI(path)` to send, which decodes it again: the path itself.
    let mut file_seen = false;
    match find(path, path, None, &mut file_seen).await {
        Found::File(opened) => match deliver(req, opened).await {
            Ok(response) => Sent::Response(response),
            Err(failure) => Sent::Error(failure.into_error()),
        },
        // `EISDIR` is passed to `next()` without the error.
        Found::Directory => Sent::Next,
        Found::Failed(failure) => Sent::Error(failure.into_error()),
    }
}

/// send's `pipe`, `sendFile` and `sendIndex`: from the raw path (for the trailing slash) and its
/// decoded form to the file to send.
async fn find(raw: &str, decoded: &str, root: Option<&str>, file_seen: &mut bool) -> Found {
    if decoded.contains('\0') {
        return Found::Failed(Failure::status(400));
    }
    let (full, parts) = match root {
        Some(root) => {
            let relative = if decoded.is_empty() {
                String::new()
            } else {
                normalize(&format!("./{decoded}"))
            };
            if climbs_up(&relative) {
                return Found::Failed(Failure::status(403));
            }
            let parts: Vec<String> = relative.split('/').map(str::to_owned).collect();
            let joined = if relative.is_empty() {
                root.to_owned()
            } else {
                format!("{root}/{relative}")
            };
            (normalize(&joined), parts)
        }
        None => {
            if climbs_up(decoded) {
                return Found::Failed(Failure::status(403));
            }
            let parts = normalize(decoded).split('/').map(str::to_owned).collect();
            (resolve(decoded), parts)
        }
    };
    // `dotfiles` is not set, so send's legacy rule applies: only a dotfile as the last part is
    // ignored (404); dot directories on the way are allowed.
    if parts
        .iter()
        .any(|part| part.len() > 1 && part.starts_with('.'))
    {
        let last_is_dotfile = parts.last().is_some_and(|last| last.starts_with('.'));
        if last_is_dotfile {
            return Found::Failed(Failure::status(404));
        }
    }
    if raw.ends_with('/') {
        let index = normalize(&format!("{full}/index.html"));
        return match open(&index).await {
            Ok((_, metadata)) if metadata.is_dir() => Found::Failed(Failure::status(404)),
            Ok((file, metadata)) => {
                *file_seen = true;
                Found::File(Box::new(Opened {
                    path: index,
                    file,
                    metadata,
                }))
            }
            Err(error) => Found::Failed(Failure::stat(error)),
        };
    }
    match open(&full).await {
        Ok((_, metadata)) if metadata.is_dir() => Found::Directory,
        Ok((file, metadata)) => {
            *file_seen = true;
            Found::File(Box::new(Opened {
                path: full,
                file,
                metadata,
            }))
        }
        Err(error) => Found::Failed(Failure::stat(error)),
    }
}

/// send's `send(path, stat)`: headers, conditional requests, ranges, then the bytes.
async fn deliver<S>(
    req: &mut Req<S>,
    opened: Box<Opened>,
) -> Result<http::Response<Body>, Failure> {
    let Opened {
        path,
        mut file,
        metadata,
    } = *opened;
    let path = path.as_str();
    let size = metadata.len();
    let mtime = metadata.modified().map(js_time).unwrap_or(0);
    set_absent(req, header::ACCEPT_RANGES, "bytes");
    set_absent(req, header::CACHE_CONTROL, "public, max-age=0");
    set_absent(req, header::LAST_MODIFIED, &utc_string(mtime));
    set_absent(
        req,
        header::ETAG,
        &format!("W/\"{size:x}-{}\"", js_hex(mtime)),
    );
    if !req.res.headers.contains_key(header::CONTENT_TYPE) {
        let kind = mime_lookup(path);
        let value = match mime_charset(kind) {
            Some(charset) => format!("{kind}; charset={charset}"),
            None => kind.to_owned(),
        };
        set(req, header::CONTENT_TYPE, &value);
    }
    if is_conditional(req) {
        if precondition_failed(req) {
            return Err(Failure::status(412));
        }
        let status = req.res.status;
        if ((200..300).contains(&status) || status == 304) && is_fresh(req) {
            for name in [
                header::CONTENT_ENCODING,
                header::CONTENT_LANGUAGE,
                header::CONTENT_LENGTH,
                header::CONTENT_RANGE,
                header::CONTENT_TYPE,
            ] {
                req.res.headers.remove(name);
            }
            req.res.status = 304;
            return Ok(take_response(req, Body::empty()));
        }
    }
    let mut offset = 0u64;
    let mut length = size;
    let range = req.header("range").map(|value| value.into_owned());
    if let Some(range) = range.filter(|value| value.trim_start_matches(' ').starts_with("bytes=")) {
        let ranges = if range_fresh(req) {
            parse_range(size, &range)
        } else {
            Ranges::Ignored
        };
        match ranges {
            Ranges::Unsatisfiable => {
                let content_range = format!("bytes */{size}");
                set(req, header::CONTENT_RANGE, &content_range);
                return Err(Failure {
                    status: 416,
                    headers: vec![("Content-Range".to_owned(), content_range)],
                    source: None,
                });
            }
            Ranges::Satisfiable(list) => {
                if let [only] = list.as_slice() {
                    req.res.status = 206;
                    set(
                        req,
                        header::CONTENT_RANGE,
                        &format!("bytes {}-{}/{size}", only.start, only.end),
                    );
                    offset = only.start;
                    length = only.end - only.start + 1;
                }
            }
            Ranges::Ignored => {}
        }
    }
    req.res
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if req.method() == Method::HEAD {
        return Ok(take_response(req, Body::empty()));
    }
    if offset > 0 {
        file.seek(io::SeekFrom::Start(offset))
            .await
            .map_err(Failure::stat)?;
    }
    let stream = ReaderStream::with_capacity(file.take(length), CHUNK);
    Ok(take_response(req, Body::from_stream(stream)))
}

/// serve-static's directory listener: `301` to the path with a slash, keeping the query.
fn redirect_to_directory<S>(req: &mut Req<S>) -> Result<http::Response<Body>, Error> {
    let original = req.original_url().to_owned();
    let (pathname, search) = match original.find('?') {
        Some(at) => (
            original.get(..at).unwrap_or(""),
            original.get(at..).unwrap_or(""),
        ),
        None => (original.as_str(), ""),
    };
    let location = encode_url(&format!(
        "{}{search}",
        collapse_leading_slashes(&format!("{pathname}/"))
    ));
    let document = html_document(
        "Redirecting",
        &format!("Redirecting to {}", escape_html(&location)),
    );
    req.res.status = 301;
    let headers = &mut req.res.headers;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=UTF-8"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(document.len()));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::LOCATION, header_value(&location)?);
    let body = if req.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(document)
    };
    Ok(take_response(req, body))
}

fn take_response<S>(req: &mut Req<S>, body: Body) -> http::Response<Body> {
    let state = std::mem::take(&mut req.res);
    let mut response = http::Response::new(body);
    *response.status_mut() = StatusCode::from_u16(state.status).unwrap_or(StatusCode::OK);
    *response.headers_mut() = state.headers;
    response
}

fn set<S>(req: &mut Req<S>, name: header::HeaderName, value: &str) {
    if let Ok(value) = header_value(value) {
        req.res.headers.insert(name, value);
    }
}

/// `if (!res.getHeader(name)) res.setHeader(name, value)`.
fn set_absent<S>(req: &mut Req<S>, name: header::HeaderName, value: &str) {
    let present = req
        .res
        .headers
        .get(&name)
        .is_some_and(|value| !value.is_empty());
    if !present {
        set(req, name, value);
    }
}

fn request_header<S>(req: &Req<S>, name: &str) -> Option<String> {
    req.header(name)
        .map(|value| value.into_owned())
        .filter(|value| !value.is_empty())
}

/// `isConditionalGET`.
fn is_conditional<S>(req: &Req<S>) -> bool {
    [
        "if-match",
        "if-unmodified-since",
        "if-none-match",
        "if-modified-since",
    ]
    .iter()
    .any(|name| request_header(req, name).is_some())
}

/// `isPreconditionFailure`: `If-Match`, then `If-Unmodified-Since`.
fn precondition_failed<S>(req: &Req<S>) -> bool {
    if let Some(wanted) = request_header(req, "if-match") {
        let Some(etag) = req.res.get_str("etag").filter(|tag| !tag.is_empty()) else {
            return true;
        };
        return wanted != "*"
            && token_list(&wanted).into_iter().all(|candidate| {
                candidate != etag
                    && candidate != format!("W/{etag}")
                    && format!("W/{candidate}") != etag
            });
    }
    let since = request_header(req, "if-unmodified-since").and_then(|v| parse_http_date(&v));
    if let Some(since) = since {
        let modified = req
            .res
            .get_str("last-modified")
            .and_then(|value| parse_http_date(&value));
        return modified.is_none_or(|modified| modified > since);
    }
    false
}

/// `isFresh`: `fresh(req.headers, { etag, 'last-modified' })`.
fn is_fresh<S>(req: &Req<S>) -> bool {
    fresh(
        req.header("if-none-match").as_deref(),
        req.header("if-modified-since").as_deref(),
        req.header("cache-control").as_deref(),
        req.res.get_str("etag").as_deref(),
        req.res.get_str("last-modified").as_deref(),
    )
}

/// `isRangeFresh`: `If-Range` as an entity tag (a substring test, as send does) or a date.
fn range_fresh<S>(req: &Req<S>) -> bool {
    let Some(if_range) = request_header(req, "if-range") else {
        return true;
    };
    if if_range.contains('"') {
        return req
            .res
            .get_str("etag")
            .is_some_and(|etag| !etag.is_empty() && if_range.contains(&etag));
    }
    let modified = req
        .res
        .get_str("last-modified")
        .and_then(|value| parse_http_date(&value));
    matches!(
        (modified, parse_http_date(&if_range)),
        (Some(modified), Some(since)) if modified <= since
    )
}

/// send's `parseTokenList`: comma-separated, spaces trimmed, empty tokens skipped.
fn token_list(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(|token| token.trim_matches(' '))
        .filter(|token| !token.is_empty())
        .collect()
}

/// One satisfiable byte range, both ends inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ByteRange {
    pub(crate) start: u64,
    pub(crate) end: u64,
}

/// `range-parser` 1.2.1 with `combine: true`, as send calls it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ranges {
    /// `-2`: no `=` (or a stale `If-Range`): the whole file is sent.
    Ignored,
    /// `-1`: no range fits the file.
    Unsatisfiable,
    /// The ranges, overlapping and adjacent ones combined, in request order.
    Satisfiable(Vec<ByteRange>),
}

/// `rangeParser(size, header, { combine: true })`.
pub(crate) fn parse_range(size: u64, header: &str) -> Ranges {
    let Some((_, specs)) = header.split_once('=') else {
        return Ranges::Ignored;
    };
    let size_f = size as f64;
    let mut ranges: Vec<(ByteRange, usize)> = Vec::new();
    for spec in specs.split(',') {
        let mut bounds = spec.split('-');
        let first = dima_text::parse_int(bounds.next().unwrap_or(""), dima_text::Radix::Decimal);
        let second = match bounds.next() {
            Some(text) => dima_text::parse_int(text, dima_text::Radix::Decimal),
            None => f64::NAN,
        };
        let (mut start, mut end) = (first, second);
        if start.is_nan() {
            start = size_f - end;
            end = size_f - 1.0;
        } else if end.is_nan() {
            end = size_f - 1.0;
        }
        if end > size_f - 1.0 {
            end = size_f - 1.0;
        }
        if start.is_nan() || end.is_nan() || start > end || start < 0.0 {
            continue;
        }
        let index = ranges.len();
        ranges.push((
            ByteRange {
                start: start as u64,
                end: end as u64,
            },
            index,
        ));
    }
    if ranges.is_empty() {
        return Ranges::Unsatisfiable;
    }
    // combineRanges: stable sort by start, merge overlapping or adjacent, back to request order.
    ranges.sort_by_key(|(range, _)| range.start);
    let mut combined: Vec<(ByteRange, usize)> = Vec::with_capacity(ranges.len());
    for (range, index) in ranges {
        match combined.last_mut() {
            Some((current, current_index)) if range.start <= current.end.saturating_add(1) => {
                if range.end > current.end {
                    current.end = range.end;
                    *current_index = (*current_index).min(index);
                }
            }
            _ => combined.push((range, index)),
        }
    }
    combined.sort_by_key(|(_, index)| *index);
    Ranges::Satisfiable(combined.into_iter().map(|(range, _)| range).collect())
}

/// `/(?:^|[\\/])\.\.(?:[\\/]|$)/`: a `..` segment, with `/` or `\` as separators.
fn climbs_up(path: &str) -> bool {
    let separator = |c: Option<char>| matches!(c, None | Some('/' | '\\'));
    path.match_indices("..").any(|(at, _)| {
        let before = path.get(..at).and_then(|head| head.chars().next_back());
        let after = path.get(at + 2..).and_then(|tail| tail.chars().next());
        separator(before) && separator(after)
    })
}

/// Node's `path.posix.normalize`.
pub(crate) fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|last| *last != "..") {
                    segments.pop();
                } else if !absolute {
                    segments.push("..");
                }
            }
            other => segments.push(other),
        }
    }
    let joined = segments.join("/");
    if joined.is_empty() {
        return match (absolute, trailing) {
            (true, _) => "/".to_owned(),
            (false, true) => "./".to_owned(),
            (false, false) => ".".to_owned(),
        };
    }
    let mut out = String::with_capacity(joined.len() + 2);
    if absolute {
        out.push('/');
    }
    out.push_str(&joined);
    if trailing {
        out.push('/');
    }
    out
}

/// Node's `path.posix.resolve` for an absolute path: normalized, no trailing slash.
fn resolve(path: &str) -> String {
    let normalized = normalize(path);
    match normalized.strip_suffix('/') {
        Some(stripped) if !stripped.is_empty() => stripped.to_owned(),
        _ => normalized,
    }
}

/// `path.resolve(root)` for `express.static(root)`: absolute against the working directory.
pub(crate) fn resolve_root(root: &str) -> String {
    if root.starts_with('/') {
        return resolve(root);
    }
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    resolve(&format!("{cwd}/{root}"))
}

fn collapse_leading_slashes(path: &str) -> String {
    let rest = path.trim_start_matches('/');
    if path.len() - rest.len() > 1 {
        format!("/{rest}")
    } else {
        path.to_owned()
    }
}

/// send's and serve-static's `createHtmlDocument`.
fn html_document(title: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n<pre>{body}</pre>\n</body>\n</html>\n"
    )
}

/// `stat.mtime.getTime()`: milliseconds since the epoch, truncated toward zero.
fn js_time(time: SystemTime) -> i64 {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// `Number.prototype.toString(16)` for an integer.
fn js_hex(value: i64) -> String {
    if value < 0 {
        format!("-{:x}", value.unsigned_abs())
    } else {
        format!("{value:x}")
    }
}

/// `Date.prototype.toUTCString()`: `Wed, 11 Nov 2026 22:31:10 GMT`.
pub(crate) fn utc_string(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let Some(fields) = dima_text::utc_fields(ms) else {
        return "Invalid Date".to_owned();
    };
    let day = DAYS.get(fields.weekday as usize).copied().unwrap_or("Sun");
    let month = MONTHS.get(fields.month as usize).copied().unwrap_or("Jan");
    let year = if fields.year < 0 {
        format!("-{:06}", fields.year.unsigned_abs())
    } else {
        format!("{:04}", fields.year)
    };
    format!(
        "{day}, {:02} {month} {year} {:02}:{:02}:{:02} GMT",
        fields.day, fields.hour, fields.minute, fields.second
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_node_path() {
        // Expectations from Node 26 `path.posix.normalize`.
        for (input, expected) in [
            ("", "."),
            ("./", "./"),
            (".//", "./"),
            ("./a/../..", ".."),
            ("./../x", "../x"),
            ("./a/./b/", "a/b/"),
            ("/a//b/../c", "/a/c"),
            ("/../a", "/a"),
            ("./a\\..\\b", "a\\..\\b"),
            ("./...", "..."),
            ("/", "/"),
            ("//", "/"),
        ] {
            assert_eq!(normalize(input), expected, "{input:?}");
        }
        assert_eq!(resolve("/a/b/"), "/a/b");
        assert_eq!(resolve("/"), "/");
    }

    #[test]
    fn finds_parent_segments_like_send() {
        for (path, up) in [
            ("../x", true),
            ("a/..", true),
            ("a/../b", true),
            ("a\\..\\b", true),
            ("..", true),
            ("a..b", false),
            ("...", false),
            ("a/...", false),
            ("x..", false),
        ] {
            assert_eq!(climbs_up(path), up, "{path}");
        }
    }

    #[test]
    fn parses_ranges_like_range_parser() {
        // Expectations from range-parser 1.2.1 with `combine: true` under Node 26.
        let r = |start, end| ByteRange { start, end };
        assert_eq!(parse_range(100, "bytes"), Ranges::Ignored);
        assert_eq!(
            parse_range(100, "bytes=0-4"),
            Ranges::Satisfiable(vec![r(0, 4)])
        );
        assert_eq!(
            parse_range(100, "bytes=-5"),
            Ranges::Satisfiable(vec![r(95, 99)])
        );
        assert_eq!(
            parse_range(100, "bytes=90-"),
            Ranges::Satisfiable(vec![r(90, 99)])
        );
        assert_eq!(
            parse_range(100, "bytes=90-500"),
            Ranges::Satisfiable(vec![r(90, 99)])
        );
        assert_eq!(parse_range(100, "bytes=-500"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(100, "bytes=100-"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(100, "bytes=5-2"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(100, "bytes=abc"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(100, "bytes=-0"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(0, "bytes=0-"), Ranges::Unsatisfiable);
        assert_eq!(
            parse_range(100, "bytes=0-4,3-8"),
            Ranges::Satisfiable(vec![r(0, 8)])
        );
        assert_eq!(
            parse_range(100, "bytes=10-14,0-4,5-6"),
            Ranges::Satisfiable(vec![r(10, 14), r(0, 6)])
        );
        assert_eq!(
            parse_range(100, "bytes=0-4, 10-14"),
            Ranges::Satisfiable(vec![r(0, 4), r(10, 14)])
        );
        assert_eq!(
            parse_range(100, "bytes= 1 - 2"),
            Ranges::Satisfiable(vec![r(1, 2)])
        );
        assert_eq!(
            parse_range(100, "bytes=1.9-2.5"),
            Ranges::Satisfiable(vec![r(1, 2)])
        );
    }

    #[test]
    fn formats_dates_like_to_utc_string() {
        assert_eq!(utc_string(784_111_777_000), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(utc_string(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(js_hex(255), "ff");
        assert_eq!(js_hex(-1500), "-5dc");
    }

    #[test]
    fn collapses_leading_slashes() {
        assert_eq!(
            collapse_leading_slashes("//evil.example/"),
            "/evil.example/"
        );
        assert_eq!(collapse_leading_slashes("/dir/"), "/dir/");
    }

    fn parts_for(uri: &str) -> http::request::Parts {
        let (parts, ()) = http::Request::builder()
            .uri(uri)
            .body(())
            .expect("request")
            .into_parts();
        parts
    }

    /// Review finding: the headers came from a path lookup and the bytes from opening the path
    /// again, so a file replaced in between was sent with the old file's length and validators.
    #[tokio::test]
    async fn headers_and_bytes_come_from_the_same_open_file() {
        use http_body_util::BodyExt as _;

        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir =
            std::env::temp_dir().join(format!("dima-web-send-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let target = dir.join("clip.txt");
        std::fs::write(&target, "AAAA").expect("first file");
        let path = target.to_string_lossy().into_owned();
        let mut seen = false;
        let Found::File(opened) = find(&path, &path, None, &mut seen).await else {
            panic!("found the file")
        };
        // The path now names another, longer file.
        let replacement = dir.join("next.tmp");
        std::fs::write(&replacement, "BBBBBBBB").expect("second file");
        std::fs::rename(&replacement, &target).expect("replace");
        let mut req = Req::new(
            std::sync::Arc::new(()),
            parts_for("/clip.txt"),
            Body::empty(),
        );
        let Ok(response) = deliver(&mut req, opened).await else {
            panic!("delivered")
        };
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "4");
        let etag = response.headers()[header::ETAG]
            .to_str()
            .expect("etag")
            .to_owned();
        assert!(etag.starts_with("W/\"4-"), "{etag}");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert_eq!(body, "AAAA");

        // Generated files are served through symbolic links: the link is followed, and the
        // headers are the target's.
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let link = link.to_string_lossy().into_owned();
        let Found::File(opened) = find(&link, &link, None, &mut seen).await else {
            panic!("followed the link")
        };
        let mut req = Req::new(
            std::sync::Arc::new(()),
            parts_for("/link.txt"),
            Body::empty(),
        );
        let Ok(response) = deliver(&mut req, opened).await else {
            panic!("delivered through the link")
        };
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "8");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert_eq!(body, "BBBBBBBB");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
