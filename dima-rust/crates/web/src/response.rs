//! Responses: a builder that mirrors `res.status().set().json()/send()/sendStatus()/redirect()`,
//! and the code that turns it into HTTP exactly as Express's `res.send` and finalhandler do.

use bytes::Bytes;
use http::header::{self, HeaderMap, HeaderValue};
use http::{Method, StatusCode};
use serde::Serialize;

use crate::Body;
use crate::conditional::{fresh, weak_etag};
use crate::error::Error;
use crate::mediatype::{express_content_type, express_type, set_charset};
use crate::request::{Req, ResponseState, header_name, header_value};
use crate::uri::{encode_url, escape_html};
use crate::{negotiate, status};

#[derive(Debug)]
enum HeaderOp {
    /// `res.setHeader(name, value)`.
    Raw(String, String),
    /// `res.set(name, value)`: `Content-Type` gains a charset from the mime table.
    Express(String, String),
    /// `res.append(name, value)`.
    Append(String, String),
    /// `res.vary(field)`.
    Vary(String),
    /// `res.removeHeader(name)`.
    Remove(String),
}

#[derive(Debug)]
enum Payload {
    /// `res.end()`: no body, no content headers.
    End,
    /// `res.json(value)`, serialized when the handler built the response.
    Json(Result<Vec<u8>, String>),
    /// `res.send(string)`.
    Text(String),
    /// `res.send(buffer)`.
    Bytes(Bytes),
    /// `res.sendStatus(code)`.
    SendStatus(u16),
    /// `res.redirect([status,] url)`.
    Redirect(u16, String),
    /// A response built by hand (streams, files): sent with the pending headers merged under it.
    Http(http::Response<Body>),
    /// `res.sendFile(path)`.
    File(String),
    /// `res.write(...)` as it comes: a streamed body.
    Stream(Body),
}

/// The answer a handler gives, built like Express's chained `res` calls.
///
/// ```
/// use dima_web::Response;
/// use serde_json::json;
///
/// let created = Response::status(201).json(&json!({ "error": false, "status": 200 }));
/// let page = Response::new().text("<p>hi</p>");
/// let gone = Response::send_status(410);
/// let moved = Response::redirect("/login");
/// # let _ = (created, page, gone, moved);
/// ```
#[derive(Debug)]
#[must_use = "a Response is sent only when the handler returns it"]
pub struct Response {
    status: Option<u16>,
    ops: Vec<HeaderOp>,
    payload: Payload,
}

impl Default for Response {
    fn default() -> Self {
        Self::new()
    }
}

impl Response {
    /// A response that keeps the status set so far (200 by default) and ends with no body until
    /// a body method is called.
    pub fn new() -> Self {
        Self {
            status: None,
            ops: Vec::new(),
            payload: Payload::End,
        }
    }

    /// `res.status(code)`.
    pub fn status(code: u16) -> Self {
        Self {
            status: Some(code),
            ..Self::new()
        }
    }

    /// `res.status(code)` on an existing builder.
    pub fn with_status(mut self, code: u16) -> Self {
        self.status = Some(code);
        self
    }

    /// `res.setHeader(name, value)`: the value is sent as given.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.ops.push(HeaderOp::Raw(name.into(), value.into()));
        self
    }

    /// `res.set(name, value)`: like [`Response::header`], but a `Content-Type` without a charset
    /// gains the charset the mime table lists (`application/json` → `; charset=utf-8`).
    pub fn set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.ops.push(HeaderOp::Express(name.into(), value.into()));
        self
    }

    /// `res.append(name, value)`.
    pub fn append(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.ops.push(HeaderOp::Append(name.into(), value.into()));
        self
    }

    /// `res.type(type)`: a full media type, or an extension such as `"txt"` or `"html"`.
    pub fn content_type(mut self, value: &str) -> Self {
        self.ops.push(HeaderOp::Raw(
            "Content-Type".to_owned(),
            express_type(value),
        ));
        self
    }

    /// `res.vary(field)`.
    pub fn vary(mut self, field: impl Into<String>) -> Self {
        self.ops.push(HeaderOp::Vary(field.into()));
        self
    }

    /// `res.removeHeader(name)`.
    pub fn remove_header(mut self, name: impl Into<String>) -> Self {
        self.ops.push(HeaderOp::Remove(name.into()));
        self
    }

    /// `res.json(value)`.
    ///
    /// Numbers are written as JavaScript writes them (`1`, not `1.0`), so the usual bodies are
    /// byte-identical with the reference and keep their ETags. Object keys go out in the order
    /// the value serialises them; clients parse the body, so that order is not a contract. A
    /// value whose exact bytes are compared somewhere is built with `dima_text::to_js_json`
    /// and sent with [`Response::bytes`].
    pub fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.payload = Payload::Json(dima_text::to_js_json_from(value).map_err(|e| e.to_string()));
        self
    }

    /// `res.send(string)`: `text/html; charset=utf-8` unless a type was set.
    pub fn text(mut self, body: impl Into<String>) -> Self {
        self.payload = Payload::Text(body.into());
        self
    }

    /// `res.send(buffer)`: `application/octet-stream` unless a type was set.
    pub fn bytes(mut self, body: impl Into<Bytes>) -> Self {
        self.payload = Payload::Bytes(body.into());
        self
    }

    /// `res.end()`: no body and no content headers.
    pub fn end(mut self) -> Self {
        self.payload = Payload::End;
        self
    }

    /// `res.sendStatus(code)`: the status text as `text/plain`.
    pub fn send_status(code: u16) -> Self {
        Self {
            payload: Payload::SendStatus(code),
            ..Self::new()
        }
    }

    /// `res.redirect(url)`: 302.
    pub fn redirect(url: impl Into<String>) -> Self {
        Self::redirect_with(302, url)
    }

    /// `res.redirect(status, url)`.
    pub fn redirect_with(status: u16, url: impl Into<String>) -> Self {
        Self {
            payload: Payload::Redirect(status, url.into()),
            ..Self::new()
        }
    }

    /// `res.sendFile(path)`, as every reference call site uses it (absolute path, no options):
    /// `Content-Type` from the mime table unless one is set, `Accept-Ranges`, `Cache-Control:
    /// public, max-age=0`, `Last-Modified` and a weak ETag from the file's size and time unless
    /// set, conditional requests (304, 412), single byte ranges (206, 416) and HEAD. The file is
    /// looked up when the response is sent, never cached.
    ///
    /// Outcomes as in Express: a missing file or a dotfile is a 404 error and any other failure a
    /// 500 error on the error path (router error handlers see it, with the `std::io::Error` as
    /// its source when there is one); a directory continues with the next layer (`next()`); a
    /// relative path is a 500 error.
    ///
    /// A file that exists but cannot be opened (no read permission) answers `HEAD` with `500`,
    /// like `GET`: the file is opened before any header is set. Express answered `HEAD` from
    /// `stat` alone (`200` with the headers) and failed only the `GET`, while streaming.
    pub fn send_file(mut self, path: impl Into<String>) -> Self {
        self.payload = Payload::File(path.into());
        self
    }

    /// A streamed body (`res.flushHeaders()` then `res.write(...)` as data comes, `res.end()` when
    /// the body ends): the status and headers set so far go out at once, the body chunk by chunk
    /// with chunked transfer encoding, no ETag. Each chunk is flushed as soon as nothing else is
    /// ready. Server-Sent Events are built with [`crate::sse::channel`]; [`crate::Req::closed`]
    /// tells producers when the client is gone.
    pub fn stream<B>(mut self, body: B) -> Self
    where
        B: axum::body::HttpBody<Data = Bytes> + Send + 'static,
        B::Error: Into<axum::BoxError>,
    {
        self.payload = Payload::Stream(Body::new(body));
        self
    }

    /// A response built by hand, for streams and other bodies the helpers do not cover. Headers
    /// set earlier by middleware are kept unless this response sets the same name.
    pub fn from_http(response: http::Response<Body>) -> Self {
        Self {
            payload: Payload::Http(response),
            ..Self::new()
        }
    }

    /// A JSON serialization failure becomes an error on the error path, like a throwing
    /// `JSON.stringify` inside a handler.
    pub(crate) fn into_checked(self) -> Result<Self, Error> {
        if let Payload::Json(Err(message)) = &self.payload {
            return Err(Error::msg(message.clone()));
        }
        Ok(self)
    }
}

/// `vary.append(header, field)`; `None` when the result is empty.
pub(crate) fn vary_append(current: &str, field: &str) -> Option<String> {
    let fields: Vec<&str> = parse_list(field);
    if current == "*" {
        return Some("*".to_owned());
    }
    let mut existing: Vec<String> = parse_list(&current.to_lowercase())
        .into_iter()
        .map(str::to_owned)
        .collect();
    if fields.contains(&"*") || existing.iter().any(|f| f == "*") {
        return Some("*".to_owned());
    }
    let mut value = current.to_owned();
    for field in fields {
        let lower = field.to_lowercase();
        if !existing.contains(&lower) {
            existing.push(lower);
            if value.is_empty() {
                value = field.to_owned();
            } else {
                value.push_str(", ");
                value.push_str(field);
            }
        }
    }
    (!value.is_empty()).then_some(value)
}

/// `vary`'s list parser (commas, U+0020 trimmed).
fn parse_list(header: &str) -> Vec<&str> {
    let bytes = header.as_bytes();
    let mut list = Vec::new();
    let (mut start, mut end) = (0, 0);
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b' ' => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            b',' => {
                list.push(header.get(start..end).unwrap_or(""));
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    list.push(header.get(start..end).unwrap_or(""));
    list
}

fn set_express(state: &mut ResponseState, name: &str, value: &str) -> Result<(), Error> {
    let value = if name.eq_ignore_ascii_case("content-type") {
        express_content_type(value)
    } else {
        value.to_owned()
    };
    state
        .headers
        .insert(header_name(name)?, header_value(&value)?);
    Ok(())
}

fn apply_ops(state: &mut ResponseState, ops: Vec<HeaderOp>) -> Result<(), Error> {
    for op in ops {
        match op {
            HeaderOp::Raw(name, value) => {
                state
                    .headers
                    .insert(header_name(&name)?, header_value(&value)?);
            }
            HeaderOp::Express(name, value) => set_express(state, &name, &value)?,
            HeaderOp::Append(name, value) => {
                state
                    .headers
                    .append(header_name(&name)?, header_value(&value)?);
            }
            HeaderOp::Vary(field) => {
                let current = state.get_str("vary").unwrap_or_default();
                if let Some(value) = vary_append(&current, &field) {
                    state.headers.insert(header::VARY, header_value(&value)?);
                }
            }
            HeaderOp::Remove(name) => {
                state.headers.remove(header_name(&name)?);
            }
        }
    }
    Ok(())
}

fn build(status: u16, headers: HeaderMap, body: Bytes) -> Result<http::Response<Body>, Error> {
    let status = StatusCode::from_u16(status)
        .map_err(|_| Error::msg(format!("Invalid status code: {status}")))?;
    let mut response = http::Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

/// Turns a handler's [`Response`] into HTTP, running Express's `res.send` rules against the
/// headers set so far. An `Err` goes down the error path (Express would have thrown); `Ok(None)`
/// continues with the next layer (`res.sendFile` on a directory).
pub(crate) async fn finalize<S>(
    response: Response,
    req: &mut Req<S>,
) -> Result<Option<http::Response<Body>>, Error> {
    let response = response.into_checked()?;
    let Response {
        status,
        ops,
        payload,
    } = response;
    if let Some(status) = status {
        req.res.status = status;
    }
    apply_ops(&mut req.res, ops)?;
    if let Payload::File(path) = payload {
        return match crate::send::send_file(req, &path).await {
            crate::send::Sent::Response(response) => Ok(Some(response)),
            crate::send::Sent::Next => Ok(None),
            crate::send::Sent::Error(error) => Err(error),
        };
    }
    finish(payload, req).map(Some)
}

/// The synchronous payloads.
fn finish<S>(payload: Payload, req: &mut Req<S>) -> Result<http::Response<Body>, Error> {
    match payload {
        Payload::End => {
            let state = std::mem::take(&mut req.res);
            build(state.status, state.headers, Bytes::new())
        }
        Payload::Json(Ok(body)) => {
            if !req.res.headers.contains_key(header::CONTENT_TYPE) {
                set_express(&mut req.res, "Content-Type", "application/json")?;
            }
            send(req, Bytes::from(body), true)
        }
        Payload::Json(Err(message)) => Err(Error::msg(message)),
        Payload::Text(body) => {
            if !req.res.headers.contains_key(header::CONTENT_TYPE) {
                req.res
                    .headers
                    .insert(header::CONTENT_TYPE, header_value(&express_type("html"))?);
            }
            send(req, Bytes::from(body), true)
        }
        Payload::Bytes(body) => {
            if !req.res.headers.contains_key(header::CONTENT_TYPE) {
                req.res
                    .headers
                    .insert(header::CONTENT_TYPE, header_value(&express_type("bin"))?);
            }
            send(req, body, false)
        }
        Payload::SendStatus(code) => {
            let body = status::message(code)
                .map(str::to_owned)
                .unwrap_or_else(|| code.to_string());
            req.res.status = code;
            req.res
                .headers
                .insert(header::CONTENT_TYPE, header_value(&express_type("txt"))?);
            send(req, Bytes::from(body), true)
        }
        Payload::Redirect(code, url) => redirect(req, code, &url),
        Payload::Http(response) => {
            let (mut parts, body) = response.into_parts();
            let mut headers = std::mem::take(&mut req.res.headers);
            let mut last: Option<header::HeaderName> = None;
            for (name, value) in parts.headers.drain() {
                // `drain` yields `None` names for further values of the previous name.
                let name = match name {
                    Some(name) => {
                        headers.remove(&name);
                        last = Some(name.clone());
                        name
                    }
                    None => match &last {
                        Some(name) => name.clone(),
                        None => continue,
                    },
                };
                headers.append(name, value);
            }
            parts.headers = headers;
            Ok(http::Response::from_parts(parts, body))
        }
        Payload::Stream(body) => {
            let state = std::mem::take(&mut req.res);
            let status = StatusCode::from_u16(state.status)
                .map_err(|_| Error::msg(format!("Invalid status code: {}", state.status)))?;
            let mut response = http::Response::new(body);
            *response.status_mut() = status;
            *response.headers_mut() = state.headers;
            Ok(response)
        }
        Payload::File(_) => Err(Error::msg("file payloads are sent asynchronously")),
    }
}

/// `res.send(chunk)` after the type is settled: charset, Content-Length, ETag, freshness,
/// 204/304/205 stripping and HEAD.
fn send<S>(req: &mut Req<S>, chunk: Bytes, is_string: bool) -> Result<http::Response<Body>, Error> {
    if is_string && let Some(current) = req.res.get_str("content-type") {
        let with_charset = set_charset(&current, "utf-8")
            .ok_or_else(|| Error::msg(format!("invalid media type in Content-Type {current:?}")))?;
        set_express(&mut req.res, "Content-Type", &with_charset)?;
    }
    let generate_etag = !req.res.headers.contains_key(header::ETAG);
    req.res
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(chunk.len()));
    if generate_etag {
        req.res
            .headers
            .insert(header::ETAG, header_value(&weak_etag(&chunk))?);
    }
    let mut chunk = chunk;
    if is_fresh(req) {
        req.res.status = 304;
    }
    let status = req.res.status;
    if status == 204 || status == 304 {
        req.res.headers.remove(header::CONTENT_TYPE);
        req.res.headers.remove(header::CONTENT_LENGTH);
        req.res.headers.remove(header::TRANSFER_ENCODING);
        chunk = Bytes::new();
    }
    if status == 205 {
        req.res
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
        req.res.headers.remove(header::TRANSFER_ENCODING);
        chunk = Bytes::new();
    }
    if req.method() == Method::HEAD {
        chunk = Bytes::new();
    }
    let state = std::mem::take(&mut req.res);
    build(state.status, state.headers, chunk)
}

/// `req.fresh`.
fn is_fresh<S>(req: &Req<S>) -> bool {
    let method = req.method();
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    let status = req.res.status;
    if !((200..300).contains(&status) || status == 304) {
        return false;
    }
    let etag = req.res.get_str("etag");
    let last_modified = req.res.get_str("last-modified");
    fresh(
        req.header("if-none-match").as_deref(),
        req.header("if-modified-since").as_deref(),
        req.header("cache-control").as_deref(),
        etag.as_deref(),
        last_modified.as_deref(),
    )
}

/// `res.redirect(status, url)` including `res.location` and the `res.format` body.
fn redirect<S>(req: &mut Req<S>, code: u16, url: &str) -> Result<http::Response<Body>, Error> {
    let target = if url == "back" {
        req.get("referrer")
            .map(|r| r.into_owned())
            .unwrap_or_else(|| "/".to_owned())
    } else {
        url.to_owned()
    };
    let address = encode_url(&target);
    req.res
        .headers
        .insert(header::LOCATION, header_value(&address)?);
    let current = req.res.get_str("vary").unwrap_or_default();
    if let Some(value) = vary_append(&current, "Accept") {
        req.res.headers.insert(header::VARY, header_value(&value)?);
    }
    let accept = req.header("accept").map(|a| a.into_owned());
    let text = status::message(code).unwrap_or("undefined");
    let body = match negotiate::preferred(accept.as_deref(), &["text/plain", "text/html"]) {
        Some(0) => {
            set_express(&mut req.res, "Content-Type", "text/plain")?;
            format!("{text}. Redirecting to {address}")
        }
        Some(_) => {
            set_express(&mut req.res, "Content-Type", "text/html")?;
            format!("<p>{text}. Redirecting to {}</p>", escape_html(&address))
        }
        None => String::new(),
    };
    req.res.status = code;
    req.res
        .headers
        .insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    let body = if req.method() == Method::HEAD {
        Bytes::new()
    } else {
        Bytes::from(body)
    };
    let state = std::mem::take(&mut req.res);
    build(state.status, state.headers, body)
}

/// finalhandler 1.3 in production mode: the 404 page for `None`, the error page otherwise.
pub(crate) fn final_response<S>(req: &mut Req<S>, error: Option<Error>) -> http::Response<Body> {
    let (status, message, extra) = match &error {
        Some(error) => {
            let (status, honour_headers) = error.response_status(req.res.status);
            let message = status::message(status).unwrap_or("undefined").to_owned();
            let extra = if honour_headers {
                error.headers().to_vec()
            } else {
                Vec::new()
            };
            (status, message, extra)
        }
        None => {
            let path = crate::request::pathname(req.original_url());
            (
                404,
                format!("Cannot {} {}", req.method(), encode_url(path)),
                Vec::new(),
            )
        }
    };
    let body = error_document(&message);
    let mut headers = std::mem::take(&mut req.res.headers);
    headers.remove(header::CONTENT_ENCODING);
    headers.remove(header::CONTENT_LANGUAGE);
    headers.remove(header::CONTENT_RANGE);
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (header_name(&name), header_value(&value)) {
            headers.insert(name, value);
        }
    }
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    let body = if req.method() == Method::HEAD {
        Bytes::new()
    } else {
        Bytes::from(body)
    };
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = http::Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// finalhandler's `createHtmlDocument`.
fn error_document(message: &str) -> String {
    let escaped = escape_html(message)
        .replace('\n', "<br>")
        .replace("  ", " &nbsp;");
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{escaped}</pre>\n</body>\n</html>\n"
    )
}

/// The response for an `OPTIONS` request no route answered: `Allow` and the same text as body.
pub(crate) fn options_response<S>(
    req: &mut Req<S>,
    methods: &[String],
) -> Result<http::Response<Body>, Error> {
    let body = methods.join(",");
    let Response { ops, payload, .. } = Response::new().set("Allow", body.clone()).text(body);
    apply_ops(&mut req.res, ops)?;
    finish(payload, req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vary_appends_like_the_package() {
        assert_eq!(vary_append("", "Origin").as_deref(), Some("Origin"));
        assert_eq!(vary_append("Origin", "origin").as_deref(), Some("Origin"));
        assert_eq!(
            vary_append("Origin", "Accept").as_deref(),
            Some("Origin, Accept")
        );
        assert_eq!(vary_append("Origin", "*").as_deref(), Some("*"));
        assert_eq!(vary_append("*", "Accept").as_deref(), Some("*"));
    }

    #[test]
    fn error_document_matches_finalhandler() {
        let doc = error_document("Cannot GET /a&b");
        assert!(doc.contains("<pre>Cannot GET /a&amp;b</pre>"));
        assert!(doc.starts_with("<!DOCTYPE html>\n<html lang=\"en\">"));
    }
}
