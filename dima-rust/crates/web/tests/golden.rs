//! Golden conformance against real Express.
//!
//! `golden/record.mjs` builds a fixture app with the Express stack production runs and records
//! every scripted request with its response in `golden/express.json`. This test builds the same
//! fixture with dima-web, serves it on a loopback port, sends the identical request bytes and
//! compares status, headers and body bytes.
//!
//! Headers are compared in full except for this list:
//! - `date`: wall-clock time.
//! - `connection`, `keep-alive`: connection management (Node adds `Keep-Alive: timeout=5`;
//!   hyper words `Connection: close` differently); not part of the application contract.
//! - `x-powered-by`: deliberately not sent by dima-web (decision recorded in the package report).
//! - `content-length` on 204 responses only: hyper never sends it (RFC 9110 section 8.6 forbids
//!   it); Node sends `Content-Length: 0` where `cors()` sets it on preflight answers.
//!
//! Cases in `KNOWN_DIFFERENCES` are checked exactly as described there; each has its reason.

// Test code may unwrap, expect and panic (see clippy.toml); helpers outside `#[test]`
// functions need the allowance spelled out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;

use base64::Engine as _;
use dima_web::multipart::{
    DiskStorage, FileInfo, FileStream, Limits, Multer, Storage, StoredFile, UploadError,
    UploadedFile,
};
use dima_web::{
    App, BodyState, Envelope, Error, Flow, Req, Response, Router, ServeOptions, body, cors, serve,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

const EXCLUDED_HEADERS: [&str; 4] = ["date", "connection", "keep-alive", "x-powered-by"];

/// What dima-web answers instead of the recorded response.
#[derive(Clone, Copy)]
enum Expect {
    /// Express's body with this change; `Content-Length` and the ETag follow the new body, every
    /// other header is compared as usual.
    Transformed(fn(&[u8]) -> Vec<u8>),
    /// hyper refuses the request target before the application sees it: exactly
    /// `400 Bad Request` with `Connection: close`, `Content-Length: 0` and no body.
    Rejected,
    /// Exactly what Express answered for the named case (status, headers and body).
    SameAs(&'static str),
}

const RAW_TARGET: &str = "hyper (http crate) refuses this raw byte in the request target; Node routes it. \
                          Browsers and HTTP clients percent-encode it";

/// Cases where dima-web knowingly answers differently.
const KNOWN_DIFFERENCES: [(&str, Expect, &str); 12] = [
    (
        "json-lone-surrogate",
        Expect::Transformed(lone_surrogates_replaced),
        "MIGRATION.md text rule 3: lone surrogate escapes become U+FFFD instead of a lone surrogate",
    ),
    ("unmatched-with-query", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-lt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-lt", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-gt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-gt", Expect::Rejected, RAW_TARGET),
    ("raw-char-query-quote", Expect::Rejected, RAW_TARGET),
    ("raw-char-path-backtick", Expect::Rejected, RAW_TARGET),
    (
        "raw-char-path-hash",
        Expect::Transformed(fragment_dropped),
        "the http crate drops a '#fragment' from the request target, so req.url and \
         req.originalUrl lack it; Node keeps it (clients never send fragments)",
    ),
    (
        "json-number-infinity",
        Expect::SameAs("json-malformed"),
        "a number beyond the double range is a parse error (400) where JSON.parse gives Infinity",
    ),
    (
        "json-gzip-empty-members",
        Expect::SameAs("json-over-limit"),
        "compressed input is bounded on the wire (body::wire_budget); raw-body reads it all",
    ),
    (
        "upload-disk-truncated",
        Expect::Transformed(partial_upload_removed),
        "multer leaves a partly written disk file behind when the form breaks off; \
         DiskStorage removes it",
    ),
];

/// No leftover partial file in the upload directory.
fn partial_upload_removed(body: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(body)
        .replace("\"leftover\":[\"upload.mp4\"]", "\"leftover\":[]")
        .into_bytes()
}

/// `\ud800` and `\udc00` escapes as dima-web sends them: the replacement character, raw UTF-8.
fn lone_surrogates_replaced(body: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(body)
        .replace("\\ud800", "\u{FFFD}")
        .replace("\\udc00", "\u{FFFD}")
        .into_bytes()
}

/// `req.url` and `req.originalUrl` without the `#b` fragment.
fn fragment_dropped(body: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(body)
        .replace("/users/a#b\"", "/users/a\"")
        .into_bytes()
}

// ------------------------------------------------------------------------------------------
// The fixture, in the same order as record.mjs.
// ------------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct WidgetError {
    message: String,
    status: u16,
}

fn located(req: &Req, mut fields: Map<String, Value>) -> Value {
    fields.insert("path".into(), req.path().into());
    fields.insert("baseUrl".into(), req.base_url().into());
    fields.insert("originalUrl".into(), req.original_url().into());
    fields.insert("url".into(), req.url().into());
    Value::Object(fields)
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn ok(value: Value) -> Response {
    Response::new().json(&value)
}

async fn describe_body(req: &mut Req) -> Response {
    match req.body_state() {
        BodyState::Raw(bytes) => ok(json!({
            "isBuffer": true,
            "length": bytes.len(),
            "hex": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        })),
        _ => ok(json!({ "isBuffer": false, "body": req.body() })),
    }
}

async fn docs_ask(req: &mut Req) -> Response {
    let size = serde_json::to_string(req.body())
        .map(|s| s.len())
        .unwrap_or(0);
    ok(json!({ "size": size }))
}

async fn oauth_boundary(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    if req.method() == http::Method::OPTIONS {
        return Ok(Response::status(204).end().into());
    }
    Ok(Flow::Next)
}

async fn oauth_authorize(req: &mut Req) -> Response {
    ok(json!({ "ok": true, "query": req.query() }))
}

async fn echo_body(req: &mut Req) -> Response {
    ok(json!({ "body": req.body() }))
}

async fn oauth_fail(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(401, "bad token"))
}

async fn oauth_limited(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(429, "slow down"))
}

async fn broken(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("broken"))
}

async fn json_not_found(_req: &mut Req) -> Response {
    Response::status(404).json(&json!({ "error": "not_found" }))
}

async fn oauth_errors(error: Error, _req: &mut Req) -> Response {
    let status = error
        .status()
        .filter(|s| matches!(s, 401 | 429))
        .unwrap_or(503);
    let mut response = Response::status(status);
    if status == 401 {
        response = response.header("WWW-Authenticate", "Bearer error=\"invalid_token\"");
    }
    if status == 429 {
        response = response.header("Retry-After", "60");
    }
    let code = match status {
        401 => "invalid_token",
        429 => "slow_down",
        _ => "temporarily_unavailable",
    };
    response.json(&json!({ "error": code }))
}

async fn pre_get(_req: &mut Req) -> Response {
    ok(json!({ "pre": "get" }))
}

async fn pre_post(_req: &mut Req) -> Response {
    ok(json!({ "pre": "post" }))
}

async fn pre_put(_req: &mut Req) -> Response {
    ok(json!({ "pre": "put" }))
}

async fn early(_req: &mut Req) -> Response {
    ok(json!({ "early": true }))
}

async fn users_id(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "route": "id", "params": req.params().to_json() })),
    ))
}

async fn route_me(_req: &mut Req) -> Response {
    ok(json!({ "route": "me" }))
}

async fn route_id(req: &mut Req) -> Response {
    ok(json!({ "route": "id", "params": req.params().to_json() }))
}

async fn params_only(req: &mut Req) -> Response {
    ok(json!({ "params": req.params().to_json() }))
}

async fn query(req: &mut Req) -> Response {
    ok(json!({ "query": req.query() }))
}

async fn summary(req: &mut Req) -> Response {
    let keys: Vec<&String> = req
        .body()
        .as_object()
        .map(|m| m.keys().collect())
        .unwrap_or_default();
    let pad = req.body().get("pad").and_then(Value::as_str).map(str::len);
    ok(json!({ "keys": keys, "padLength": pad }))
}

async fn form_summary(req: &mut Req) -> Response {
    ok(json!({ "keys": req.body().as_object().map_or(0, Map::len) }))
}

async fn etag(_req: &mut Req) -> Response {
    ok(json!({ "ok": true }))
}

async fn text(_req: &mut Req) -> Response {
    Response::new().text("<p>hello</p>")
}

async fn text_plain(_req: &mut Req) -> Response {
    Response::new().content_type("text/plain").text("plain")
}

async fn buffer(_req: &mut Req) -> Response {
    Response::new().bytes(vec![0u8, 1, 2, 255])
}

async fn buffer_typed(_req: &mut Req) -> Response {
    Response::new()
        .content_type("image/png")
        .bytes(&b"png!"[..])
}

async fn object(_req: &mut Req) -> Response {
    ok(json!({ "sent": "object" }))
}

async fn set_ct(_req: &mut Req) -> Response {
    Response::new()
        .set("Content-Type", "application/javascript")
        .text("var a = 1;")
}

async fn emoji(_req: &mut Req) -> Response {
    ok(json!({ "text": "héllo 😀 שלום e\u{301}" }))
}

async fn send_status(req: &mut Req) -> Response {
    let code = req
        .param("code")
        .and_then(|c| c.parse().ok())
        .unwrap_or(500);
    Response::send_status(code)
}

async fn created(_req: &mut Req) -> Response {
    Response::status(201).json(&json!({ "error": false, "status": 200, "message": "Created" }))
}

async fn no_content(_req: &mut Req) -> Response {
    Response::status(204).json(&json!({ "ignored": true }))
}

async fn reset(_req: &mut Req) -> Response {
    Response::status(205).text("ignored")
}

async fn end_204(_req: &mut Req) -> Response {
    Response::status(204).end()
}

async fn end_200(_req: &mut Req) -> Response {
    Response::new().end()
}

async fn redirect(_req: &mut Req) -> Response {
    Response::redirect("/target?x=1&y=é")
}

async fn redirect_301(_req: &mut Req) -> Response {
    Response::redirect_with(301, "https://example.com/a b<c>")
}

async fn throw(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("boom"))
}

async fn next_err(req: &mut Req) -> Result<Response, Error> {
    let status = req
        .param("status")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Err(Error::new(status, "x"))
}

async fn next_err_headers(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(429, "x").with_header("Retry-After", "60"))
}

async fn status_then_error(req: &mut Req) -> Result<Response, Error> {
    req.set_status(403);
    Err(Error::msg("x"))
}

async fn header_then_next(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    Ok(Flow::Next)
}

async fn skip_route(_req: &mut Req) -> Flow {
    Flow::NextRoute
}

async fn first(_req: &mut Req) -> Response {
    ok(json!({ "first": true }))
}

async fn second(_req: &mut Req) -> Response {
    ok(json!({ "second": true }))
}

async fn any_method(req: &mut Req) -> Response {
    ok(json!({ "method": req.method().as_str() }))
}

async fn vary(_req: &mut Req) -> Response {
    Response::new()
        .vary("Origin")
        .vary("Accept")
        .json(&json!({ "vary": true }))
}

async fn no_store(req: &mut Req) -> Result<Flow, Error> {
    req.set_header("Cache-Control", "no-store")?;
    Ok(Flow::Next)
}

async fn widget_overlay(req: &mut Req) -> Response {
    ok(json!({ "public": true, "channel": req.param("channelID") }))
}

async fn widget_auth(req: &mut Req) -> Flow {
    if req.header("authorization").as_deref() != Some("Bearer good") {
        return Response::status(401)
            .json(&json!({ "error": true, "status": 401, "message": "Unauthorized" }))
            .into();
    }
    Flow::Next
}

async fn widget_access(req: &mut Req) -> Flow {
    if req.param("channelID") == Some("forbidden") {
        return Response::status(403)
            .json(&json!({ "error": true, "status": 403, "code": "permission_required" }))
            .into();
    }
    Flow::Next
}

async fn duel_state(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "duel": true, "params": req.params().to_json() })),
    ))
}

async fn duel_fail(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::new(409, "duel"))
}

async fn plain_state(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "plain": true, "params": req.params().to_json() })),
    ))
}

async fn widget_get(req: &mut Req) -> Response {
    ok(json!({ "channel": req.param("channelID") }))
}

async fn widget_post(req: &mut Req) -> Response {
    ok(json!({ "channel": req.param("channelID"), "body": req.body() }))
}

async fn widget_boom(_req: &mut Req) -> Result<Response, Error> {
    Err(WidgetError {
        message: "Bad widget".into(),
        status: 422,
    }
    .into())
}

async fn widget_crash(_req: &mut Req) -> Result<Response, Error> {
    Err(Error::msg("crash"))
}

async fn widget_errors(error: Error, _req: &mut Req) -> Response {
    let known = error.downcast_ref::<WidgetError>();
    let status = known.map_or(500, |e| e.status);
    Response::status(status).json(&json!({
        "error": true,
        "status": status,
        "code": if known.is_some() { "widget" } else { "internal" },
        "message": known.map_or("Widget operation failed".to_owned(), |e| e.message.clone()),
    }))
}

async fn timeline(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "timeline": req.param("channelID") })),
    ))
}

async fn analytics_summary(_req: &mut Req) -> Response {
    ok(json!({ "summary": true }))
}

async fn overlay(req: &mut Req) -> Response {
    ok(located(req, fields(json!({ "overlay": req.param("id") }))))
}

async fn v1_me(_req: &mut Req) -> Response {
    ok(json!({ "me": true }))
}

async fn duel_item(req: &mut Req) -> Response {
    ok(located(
        req,
        fields(json!({ "item": req.param("itemID"), "params": req.params().to_json() })),
    ))
}

async fn well_known(_req: &mut Req) -> Response {
    ok(json!({ "wellKnown": true }))
}

async fn dotted_segment(_req: &mut Req) -> Response {
    ok(json!({ "dotted": "segment" }))
}

async fn dotted_file(_req: &mut Req) -> Response {
    ok(json!({ "dotted": "file" }))
}

async fn raw_length(req: &mut Req) -> Response {
    let length = req.body_bytes().map(|bytes| bytes.len());
    ok(json!({ "isBuffer": length.is_some(), "length": length }))
}

/// The directory the static fixture tree lives in for this run.
#[derive(Clone)]
struct Files(std::sync::Arc<String>);

impl Files {
    fn path(&self, relative: &str) -> String {
        format!("{}/{relative}", self.0)
    }
}

fn files(req: &Req) -> Files {
    req.extensions()
        .get::<Files>()
        .cloned()
        .unwrap_or_else(|| Files(std::sync::Arc::new(String::new())))
}

async fn speech_page(req: &mut Req) -> Response {
    ok(json!({ "speechPage": req.param("channelID") }))
}

async fn sendfile_text(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path("hello.txt"))
}

async fn sendfile_typed(req: &mut Req) -> Response {
    Response::new()
        .set("Content-Type", "audio/mpeg")
        .send_file(files(req).path("speech/chan1/one.wav"))
}

async fn sendfile_status(req: &mut Req) -> Response {
    Response::status(200).send_file(files(req).path("index.html"))
}

async fn sendfile_no_store(req: &mut Req) -> Response {
    Response::new()
        .header("Cache-Control", "no-store")
        .send_file(files(req).path("script.js"))
}

async fn sendfile_missing(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path("nope.txt"))
}

async fn sendfile_dir(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path("dir"))
}

async fn sendfile_dotfile(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path(".env"))
}

async fn sendfile_relative(_req: &mut Req) -> Response {
    Response::new().send_file("hello.txt")
}

async fn sendfile_emoji(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path("😀/smile.txt"))
}

async fn sendfile_big(req: &mut Req) -> Response {
    Response::new().send_file(files(req).path("big.bin"))
}

async fn type_unknown_ext(_req: &mut Req) -> Response {
    Response::new().content_type("xyz").bytes(&b"x"[..])
}

async fn type_wav(_req: &mut Req) -> Response {
    Response::new().content_type("wav").bytes(&b"RIFF"[..])
}

async fn set_manifest_json(_req: &mut Req) -> Response {
    Response::new()
        .set("Content-Type", "application/manifest+json")
        .bytes(&b"{}"[..])
}

async fn files_errors(error: Error, _req: &mut Req) -> Response {
    let code = error
        .downcast_ref::<std::io::Error>()
        .map(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::NotADirectory => "ENOTDIR",
            _ => "EIO",
        });
    Response::status(error.status().unwrap_or(500))
        .json(&json!({ "status": error.status(), "code": code, "expose": error.expose() }))
}

/// The directory uploads land in for this run.
#[derive(Clone)]
struct Uploads(std::sync::Arc<std::path::PathBuf>);

fn uploads(req: &Req) -> std::path::PathBuf {
    req.extensions()
        .get::<Uploads>()
        .map(|u| u.0.as_ref().clone())
        .unwrap_or_default()
}

const UPLOAD_TYPES: [&str; 4] = ["video/mp4", "image/png", "audio/mpeg", "text/csv"];

/// Node's `path.extname` for a file name without directories.
fn extname(name: &str) -> String {
    match name.rfind('.') {
        _ if name == ".." => String::new(),
        Some(0) | None => String::new(),
        Some(at) => name.get(at..).unwrap_or("").to_owned(),
    }
}

fn describe_error(error: &UploadError) -> Value {
    match error {
        UploadError::Multer(multer) => json!({
            "name": "MulterError",
            "code": multer.code.as_str(),
            "field": multer.field,
            "message": multer.code.message(),
        }),
        other => {
            json!({ "name": "Error", "code": null, "field": null, "message": other.to_string() })
        }
    }
}

fn describe_file(file: Option<&UploadedFile>, content: Option<Vec<u8>>) -> Value {
    match file {
        None => Value::Null,
        Some(file) => json!({
            "fieldname": file.fieldname,
            "originalname": file.originalname,
            "encoding": file.encoding,
            "mimetype": file.mimetype,
            "size": file.size(),
            "content": content.map(|c| base64::engine::general_purpose::STANDARD.encode(c)),
        }),
    }
}

/// Lists and empties the upload directory.
fn empty_uploads(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in &names {
        let _ = std::fs::remove_file(dir.join(name));
    }
    names
}

fn disk_storage(dir: &std::path::Path) -> DiskStorage {
    DiskStorage::new(dir).filename(|file| {
        format!(
            "upload{}",
            dima_text::to_lower(&extname(&file.originalname))
        )
    })
}

async fn upload_disk(req: &mut Req) -> Response {
    let dir = uploads(req);
    let multer = Multer::new(disk_storage(&dir))
        .file_filter(|file| Ok(UPLOAD_TYPES.contains(&file.mimetype.as_str())))
        .limits(Limits {
            file_size: Some(64),
            ..Limits::default()
        });
    let outcome = multer.single("trigger").run(req).await;
    let file = req.extensions().get::<UploadedFile>().cloned();
    let content = file
        .as_ref()
        .and_then(|f| f.path())
        .and_then(|p| std::fs::read(p).ok());
    let stored = file.as_ref().and_then(|f| f.stored.filename.clone());
    ok(json!({
        "error": outcome.as_ref().err().map(describe_error),
        "file": describe_file(file.as_ref(), content),
        "stored": stored,
        "body": req.body(),
        "leftover": empty_uploads(&dir),
    }))
}

/// A storage engine keeping files in memory, like the asset library's streaming engine.
#[derive(Default)]
struct Memory {
    contents: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    removed: std::sync::Mutex<Vec<String>>,
}

struct MemoryStorage(std::sync::Arc<Memory>);

impl Storage for MemoryStorage {
    fn handle_file<'a>(
        &'a self,
        file: &'a FileInfo,
        data: &'a mut FileStream<'_>,
    ) -> dima_web::BoxFuture<'a, Result<StoredFile, Error>> {
        Box::pin(async move {
            let mut bytes = Vec::new();
            while let Some(chunk) = data.chunk().await {
                bytes.extend_from_slice(&chunk?);
            }
            let size = bytes.len() as u64;
            self.0
                .contents
                .lock()
                .unwrap()
                .push((file.originalname.clone(), bytes));
            Ok(StoredFile {
                size,
                ..StoredFile::default()
            })
        })
    }

    fn remove_file<'a>(
        &'a self,
        file: &'a mut UploadedFile,
    ) -> dima_web::BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            self.0
                .removed
                .lock()
                .unwrap()
                .push(file.originalname.clone());
            Ok(())
        })
    }
}

async fn upload_stream(req: &mut Req) -> Response {
    let memory = std::sync::Arc::new(Memory::default());
    let multer = Multer::new(MemoryStorage(std::sync::Arc::clone(&memory))).limits(Limits {
        file_size: Some(50),
        files: Some(1),
        fields: Some(0),
        parts: Some(2),
        ..Limits::default()
    });
    let outcome = multer.single("file").run(req).await;
    let file = req.extensions().get::<UploadedFile>().cloned();
    let content = file.as_ref().and_then(|f| {
        memory
            .contents
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| *name == f.originalname)
            .map(|(_, bytes)| bytes.clone())
    });
    let removed = memory.removed.lock().unwrap().clone();
    ok(json!({
        "error": outcome.as_ref().err().map(describe_error),
        "file": describe_file(file.as_ref(), content),
        "removed": removed,
        "body": req.body(),
    }))
}

async fn upload_fields(req: &mut Req) -> Response {
    let dir = uploads(req);
    let multer = Multer::new(disk_storage(&dir)).limits(Limits {
        field_size: 16,
        fields: Some(3),
        parts: Some(5),
        field_name_size: Some(12),
        ..Limits::default()
    });
    let outcome = multer.single("doc").run(req).await;
    let file = req
        .extensions()
        .get::<UploadedFile>()
        .map(|f| f.originalname.clone());
    ok(json!({
        "error": outcome.as_ref().err().map(describe_error),
        "file": file,
        "body": req.body(),
        "leftover": empty_uploads(&dir),
    }))
}

async fn upload_middleware(req: &mut Req) -> Response {
    let file = req
        .extensions()
        .get::<UploadedFile>()
        .map(|f| f.originalname.clone());
    ok(json!({ "file": file, "body": req.body(), "leftover": empty_uploads(&uploads(req)) }))
}

async fn email_a(_req: &mut Req) -> Response {
    ok(json!({ "email": "a" }))
}

async fn email_b(_req: &mut Req) -> Response {
    ok(json!({ "email": "b" }))
}

fn docs_origin(origin: Option<&str>) -> bool {
    origin.is_none_or(|o| o.is_empty() || o == "https://docs.example.com")
}

fn fixture(static_root: &str, upload_dir: &std::path::Path) -> App {
    let mut app = Router::new();
    let root = Files(std::sync::Arc::new(static_root.to_owned()));
    let upload = Uploads(std::sync::Arc::new(upload_dir.to_owned()));
    app.middleware(dima_web::from_fn(move |req: &mut Req| {
        req.extensions_mut().insert(root.clone());
        req.extensions_mut().insert(upload.clone());
        Ok(Flow::Next)
    }));

    let mut hook = Router::new();
    hook.post(
        "/",
        (body::raw().types(&["application/json"]), describe_body),
    );
    app.mount("/hook", hook);

    app.middleware_at("/big", body::json().limit(body::mb(5)));
    app.middleware_at("/mid", body::json().limit(body::mb(1)));
    app.middleware_at("/four", body::json().limit(body::mb(4)));

    let mut docs = Router::new();
    docs.middleware(
        cors::cors()
            .origin(cors::Origin::Callback(std::sync::Arc::new(docs_origin)))
            .methods(&["POST"])
            .max_age(86_400),
    );
    docs.middleware(body::json().limit(body::kb(256)));
    docs.post("/ask", docs_ask);
    app.mount("/docs", docs);

    app.middleware(body::json());
    app.middleware(body::urlencoded());

    let mut oauth = Router::new();
    oauth.middleware(oauth_boundary);
    oauth.get("/authorize", oauth_authorize);
    oauth.post("/token", echo_body);
    oauth.get("/fail", oauth_fail);
    oauth.get("/limited", oauth_limited);
    oauth.get("/broken", broken);
    oauth.middleware(json_not_found);
    oauth.on_error(oauth_errors);
    app.mount("/oauth", oauth);

    let mut pre = Router::new();
    pre.get("/thing", pre_get);
    pre.post("/thing", pre_post);
    pre.put("/other", pre_put);
    app.mount("/pre", pre);
    app.get("/early", early);

    // As in the reference: static files after the parsers and the OAuth mounts, before cors().
    app.middleware(dima_web::serve_static(static_root));
    app.middleware(cors::cors());

    app.get("/users/:id", users_id);
    app.get("/users/me", route_me);
    app.get("/order/me", route_me);
    app.get("/order/:id", route_id);
    app.get("/opt/:a/:b?", params_only);
    app.get("/files/*", params_only);
    app.get("/f/:name.:ext", params_only);
    app.post("/only-post/:id", params_only);
    app.get("/query", query);
    app.post("/echo", echo_body);
    app.put("/echo", echo_body);
    app.post("/big/echo", summary);
    app.post("/mid/echo", summary);
    app.post("/four/echo", summary);
    app.post("/form-summary", form_summary);
    app.get("/etag", etag);
    app.post("/etag", etag);
    app.get("/text", text);
    app.get("/text-plain", text_plain);
    app.get("/buffer", buffer);
    app.get("/buffer-typed", buffer_typed);
    app.get("/object", object);
    app.get("/set-ct", set_ct);
    app.get("/emoji", emoji);
    app.get("/status/:code", send_status);
    app.get("/created", created);
    app.get("/no-content", no_content);
    app.get("/reset", reset);
    app.get("/end", end_204);
    app.get("/end200", end_200);
    app.get("/redirect", redirect);
    app.get("/redirect301", redirect_301);
    app.get("/throw", throw);
    app.get("/next-err/:status", next_err);
    app.get("/next-err-headers", next_err_headers);
    app.get("/status-then-error", status_then_error);
    app.get("/header-then-404", header_then_next);
    app.get("/next-route", (skip_route, first));
    app.get("/next-route", second);
    app.all("/any", any_method);
    app.get("/vary", vary);
    app.get("/.well-known/thing", well_known);
    app.get("/a.b/c", dotted_segment);
    app.get("/files.json", dotted_file);
    app.get("/speech/:channelID", speech_page);
    app.get("/sendfile/text", sendfile_text);
    app.get("/sendfile/typed", sendfile_typed);
    app.get("/sendfile/status", sendfile_status);
    app.get("/sendfile/no-store", sendfile_no_store);
    app.get("/sendfile/missing", sendfile_missing);
    app.get("/sendfile/dir", sendfile_dir);
    app.get("/sendfile/dotfile", sendfile_dotfile);
    app.get("/sendfile/relative", sendfile_relative);
    app.get("/sendfile/emoji", sendfile_emoji);
    app.get("/sendfile/big", sendfile_big);
    app.get("/type-unknown-ext", type_unknown_ext);
    app.get("/type-wav", type_wav);
    app.get("/set-manifest-json", set_manifest_json);
    let mut files_router = Router::new();
    files_router.get("/missing", sendfile_missing);
    files_router.get("/range", sendfile_text);
    files_router.on_error(files_errors);
    app.mount("/files-router", files_router);
    app.post("/upload/disk", upload_disk);
    app.post("/upload/stream", upload_stream);
    app.post("/upload/fields", upload_fields);
    let middleware = Multer::new(disk_storage(upload_dir))
        .limits(Limits {
            file_size: Some(64),
            ..Limits::default()
        })
        .single("trigger");
    app.post("/upload/middleware", (middleware, upload_middleware));
    app.post("/raw-length", (body::raw(), raw_length));

    let mut widgets = Router::new();
    widgets.middleware(no_store);
    widgets.get("/:channelID/overlay", widget_overlay);
    widgets.middleware(widget_auth);
    widgets.middleware_at("/:channelID", widget_access);
    let mut duel = Router::with_merge_params();
    duel.get("/state", duel_state);
    duel.post("/fail", duel_fail);
    duel.get("/item/:itemID", duel_item);
    widgets.mount("/:channelID/duel", duel);
    let mut plain = Router::new();
    plain.get("/state", plain_state);
    widgets.mount("/:channelID/plain", plain);
    widgets.get("/:channelID", widget_get);
    widgets.post("/:channelID", widget_post);
    widgets.get("/:channelID/boom", widget_boom);
    widgets.get("/:channelID/crash", widget_crash);
    widgets.on_error(widget_errors);
    app.mount("/widgets", widgets);

    let mut timeline_router = Router::new();
    timeline_router.get("/streams/:channelID", timeline);
    let mut analytics = Router::new();
    analytics.get("/summary", analytics_summary);
    analytics.mount("/", timeline_router);
    app.mount("/analytics", analytics);

    let mut overlays = Router::new();
    overlays.get("/overlays/:id", overlay);
    app.mount("/", overlays);

    let mut v1 = Router::new();
    v1.get("/me", v1_me);
    v1.middleware(json_not_found);
    app.mount("/v1", v1);

    let mut email_first = Router::new();
    email_first.get("/a", email_a);
    let mut email_second = Router::new();
    email_second.get("/b", email_b);
    app.mount("/email", email_first);
    app.mount("/email", email_second);

    // Unused by the fixture; keeps the envelope helper in the compiled example surface.
    let _ = Envelope::ok("unused");
    App::new(app, ()).expect("fixture patterns are supported")
}

// ------------------------------------------------------------------------------------------
// Replay.
// ------------------------------------------------------------------------------------------

fn generate(spec: &Value) -> Vec<u8> {
    let kind = spec["type"].as_str().unwrap_or_default();
    let n = |key: &str| spec[key].as_u64().unwrap_or(0) as usize;
    match kind {
        "json-pad" => format!(
            "{{\"pad\":\"{}\"}}",
            "a".repeat(n("size") - "{\"pad\":\"\"}".len())
        )
        .into_bytes(),
        "form-pad" => format!("pad={}", "a".repeat(n("size") - 4)).into_bytes(),
        "form-params" => (0..n("count"))
            .map(|i| format!("k{i}={i}"))
            .collect::<Vec<_>>()
            .join("&")
            .into_bytes(),
        "form-depth" => format!("a{}=1", "[x]".repeat(n("depth"))).into_bytes(),
        "form-sparse" => {
            let tail = format!("[{}]", n("index")).repeat(n("depth"));
            (0..n("keys"))
                .map(|i| format!("k{i}{tail}=v"))
                .collect::<Vec<_>>()
                .join("&")
                .into_bytes()
        }
        "pattern" => (0..n("size")).map(|i| (i % 251) as u8).collect(),
        "repeat" => base64::engine::general_purpose::STANDARD
            .decode(spec["base64"].as_str().unwrap_or_default())
            .expect("base64 piece")
            .repeat(n("count")),
        other => panic!("unknown generator {other}"),
    }
}

/// The same multipart bodies record.mjs builds.
fn multipart_body(spec: &Value) -> Vec<u8> {
    if let Some(raw) = spec["raw"].as_str() {
        return raw.as_bytes().to_vec();
    }
    let boundary = spec["boundary"].as_str().unwrap_or_default();
    let mut out = Vec::new();
    if let Some(preamble) = spec["preamble"].as_str() {
        out.extend_from_slice(format!("{preamble}\r\n").as_bytes());
    }
    for part in spec["parts"].as_array().into_iter().flatten() {
        let head: String = part["headers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|h| {
                format!(
                    "{}: {}\r\n",
                    h[0].as_str().unwrap_or_default(),
                    h[1].as_str().unwrap_or_default()
                )
            })
            .collect();
        out.extend_from_slice(format!("--{boundary}\r\n{head}\r\n").as_bytes());
        out.extend_from_slice(&body_bytes(&part["data"]).unwrap_or_default());
        out.extend_from_slice(b"\r\n");
    }
    if spec["close"].as_bool() != Some(false) {
        out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    }
    if let Some(epilogue) = spec["epilogue"].as_str() {
        out.extend_from_slice(epilogue.as_bytes());
    }
    if let Some(cut) = spec["cut"].as_u64() {
        out.truncate(out.len().saturating_sub(cut as usize));
    }
    out
}

fn body_bytes(body: &Value) -> Option<Vec<u8>> {
    if body.is_null() {
        return None;
    }
    if !body["multipart"].is_null() {
        return Some(multipart_body(&body["multipart"]));
    }
    if let Some(text) = body.get("utf8").and_then(Value::as_str) {
        return Some(text.as_bytes().to_vec());
    }
    if let Some(encoded) = body.get("base64").and_then(Value::as_str) {
        return Some(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("base64 body"),
        );
    }
    Some(generate(&body["gen"]))
}

fn request_bytes(case: &Value) -> Vec<u8> {
    let method = case["method"].as_str().unwrap_or_default();
    let path = case["path"].as_str().unwrap_or_default();
    let mut lines = vec![
        format!("{method} {path} HTTP/1.1"),
        "Host: localhost".into(),
        "Connection: close".into(),
    ];
    for header in case["headers"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{}: {}",
            header[0].as_str().unwrap_or_default(),
            header[1].as_str().unwrap_or_default()
        ));
    }
    let mut payload = Vec::new();
    if let Some(body) = body_bytes(&case["body"]) {
        if case["chunked"].as_bool().unwrap_or(false) {
            lines.push("Transfer-Encoding: chunked".into());
            for piece in body.chunks(16_384) {
                payload.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
                payload.extend_from_slice(piece);
                payload.extend_from_slice(b"\r\n");
            }
            payload.extend_from_slice(b"0\r\n\r\n");
        } else {
            lines.push(format!("Content-Length: {}", body.len()));
            payload = body;
        }
    }
    // Header text is latin1 on the wire, as Node writes it.
    let head = format!("{}\r\n\r\n", lines.join("\r\n"));
    let mut bytes: Vec<u8> = head.chars().map(|c| u32::from(c) as u8).collect();
    bytes.extend_from_slice(&payload);
    bytes
}

struct Parsed {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn parse_response(raw: &[u8], method: &str) -> Parsed {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response head");
    let head: String = raw[..split].iter().map(|&b| char::from(b)).collect();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(n, v)| n == "transfer-encoding" && v.contains("chunked"));
    // A HEAD answer keeps whatever followed its head: nothing may be on the wire.
    if method != "HEAD" && chunked {
        let mut out = Vec::new();
        let mut at = 0;
        loop {
            let eol = at
                + body[at..]
                    .windows(2)
                    .position(|w| w == b"\r\n")
                    .expect("chunk size line");
            let size = usize::from_str_radix(std::str::from_utf8(&body[at..eol]).expect("hex"), 16)
                .expect("size");
            if size == 0 {
                break;
            }
            out.extend_from_slice(&body[eol + 2..eol + 2 + size]);
            at = eol + 2 + size + 2;
        }
        body = out;
    }
    Parsed {
        status,
        headers,
        body,
    }
}

async fn exchange(addr: SocketAddr, bytes: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    // The server may answer and close before the whole body is written (an oversized body).
    let _ = stream.write_all(bytes).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    raw
}

fn comparable(headers: &[(String, String)], status: u16) -> Vec<(String, String)> {
    let mut list: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| !EXCLUDED_HEADERS.contains(&name.as_str()))
        .filter(|(name, _)| !(status == 204 && name == "content-length"))
        .cloned()
        .collect();
    list.sort();
    list
}

fn recorded_body(response: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(response["bodyBase64"].as_str().unwrap_or_default())
        .expect("golden body")
}

fn expected_headers(response: &Value, status: u16) -> Vec<(String, String)> {
    let mut list = Vec::new();
    for (name, values) in response["headers"].as_object().into_iter().flatten() {
        for value in values.as_array().into_iter().flatten() {
            list.push((name.clone(), value.as_str().unwrap_or_default().to_owned()));
        }
    }
    comparable(&list, status)
}

/// The static fixture tree, built from the golden file's list with its modification time, and
/// removed when the test ends.
struct StaticTree(std::path::PathBuf);

impl StaticTree {
    fn build(golden: &Value) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let root =
            std::env::temp_dir().join(format!("dima-web-static-{}-{nanos}", std::process::id()));
        for dir in golden["staticDirs"].as_array().expect("staticDirs") {
            std::fs::create_dir_all(root.join(dir.as_str().expect("dir"))).expect("dir");
        }
        let mtime = std::time::UNIX_EPOCH
            + std::time::Duration::from_millis(golden["staticMtimeMs"].as_u64().expect("mtime"));
        for file in golden["staticFiles"].as_array().expect("staticFiles") {
            let path = root.join(file["path"].as_str().expect("path"));
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file["base64"].as_str().expect("bytes"))
                .expect("base64");
            std::fs::write(&path, bytes).expect("write");
            std::fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(mtime))
                .expect("mtime");
        }
        Self(root)
    }

    fn root(&self) -> String {
        self.0.to_str().expect("UTF-8 temp dir").to_owned()
    }
}

impl Drop for StaticTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn matches_express() {
    let golden: Value =
        serde_json::from_str(include_str!("golden/express.json")).expect("golden file");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 360, "golden file has {} cases", cases.len());
    let tree = StaticTree::build(&golden);
    let upload_dir = tree.0.with_extension("uploads");
    std::fs::create_dir_all(&upload_dir).expect("upload dir");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("address");
    let shutdown = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        fixture(&tree.root(), &upload_dir),
        shutdown.clone(),
        ServeOptions::default(),
    ));

    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        let method = case["method"].as_str().unwrap_or_default();
        let raw = exchange(addr, &request_bytes(case)).await;
        if raw.is_empty() {
            failures.push(format!("{name}: no response"));
            continue;
        }
        let actual = parse_response(&raw, method);
        if method == "HEAD" && !actual.body.is_empty() {
            failures.push(format!(
                "{name}: a HEAD answer carried {} body bytes on the wire",
                actual.body.len()
            ));
            continue;
        }
        let expected = &case["response"];
        let expected_status = expected["status"].as_u64().unwrap_or(0) as u16;
        let known = KNOWN_DIFFERENCES
            .iter()
            .find(|(known, _, _)| *known == name)
            .map(|(_, expect, _)| *expect);
        let (expected_status, expected_headers, expected_body) = match known {
            Some(Expect::Rejected) => {
                let wanted = vec![
                    ("connection".to_owned(), "close".to_owned()),
                    ("content-length".to_owned(), "0".to_owned()),
                ];
                let raw_headers: Vec<(String, String)> = actual
                    .headers
                    .iter()
                    .filter(|(name, _)| name != "date")
                    .cloned()
                    .collect();
                if actual.status != 400 || !actual.body.is_empty() || raw_headers != wanted {
                    failures.push(format!(
                        "{name}: expected hyper's bare 400, got {} {raw_headers:?} {:?} (express {expected_status})",
                        actual.status,
                        String::from_utf8_lossy(&actual.body)
                    ));
                }
                continue;
            }
            Some(Expect::SameAs(other)) => {
                let other = cases
                    .iter()
                    .find(|c| c["name"] == other)
                    .unwrap_or_else(|| panic!("{name}: no golden case {other}"));
                let response = &other["response"];
                let status = response["status"].as_u64().unwrap_or(0) as u16;
                (
                    status,
                    expected_headers(response, status),
                    recorded_body(response),
                )
            }
            Some(Expect::Transformed(change)) => {
                let body = change(&recorded_body(expected));
                let mut headers: Vec<(String, String)> =
                    expected_headers(expected, expected_status)
                        .into_iter()
                        .map(|(name, value)| match name.as_str() {
                            "content-length" => (name, body.len().to_string()),
                            "etag" => (name, dima_web::conditional::weak_etag(&body)),
                            _ => (name, value),
                        })
                        .collect();
                headers.sort();
                (expected_status, headers, body)
            }
            None => (
                expected_status,
                expected_headers(expected, expected_status),
                recorded_body(expected),
            ),
        };
        if actual.status != expected_status {
            failures.push(format!(
                "{name}: status {} != expected {expected_status}",
                actual.status
            ));
            continue;
        }
        let actual_headers = comparable(&actual.headers, actual.status);
        if actual_headers != expected_headers {
            failures.push(format!(
                "{name}: headers\n  dima-web: {actual_headers:?}\n  expected: {expected_headers:?}"
            ));
        }
        if actual.body != expected_body {
            failures.push(format!(
                "{name}: body\n  dima-web: {}\n  expected: {}",
                String::from_utf8_lossy(&actual.body),
                String::from_utf8_lossy(&expected_body)
            ));
        }
    }
    shutdown.cancel();
    server.await.expect("server task").expect("server");
    let _ = std::fs::remove_dir_all(&upload_dir);
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[tokio::test]
async fn known_differences_are_real_cases() {
    let golden: Value =
        serde_json::from_str(include_str!("golden/express.json")).expect("golden file");
    let names: Vec<&str> = golden["cases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["name"].as_str())
        .collect();
    for (name, _, reason) in KNOWN_DIFFERENCES {
        assert!(
            names.contains(&name),
            "{name} ({reason}) is not a golden case"
        );
    }
}
