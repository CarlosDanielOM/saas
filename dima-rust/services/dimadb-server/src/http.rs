//! The request handler (`index.mjs`): `/api` and `/api/*` go to the API, everything else to
//! the static files with the single-page-app fallback.
//!
//! The reference is a plain `node:http` server, not Express, so only `dima_web`'s server loop and
//! request view are used: responses are built by hand (no ETag, no 304, no `X-Powered-By`).
//!
//! Differences from the reference, all fixes of crashes or holes:
//!
//! - A request URL `new URL()` cannot parse (a bad `Host` header) and a static path with a
//!   malformed escape (`GET /%`) crashed the Node process; here they answer `400`.
//! - The static path check is component-wise: `/..%2Fpublic-x/f` no longer reaches a sibling
//!   directory whose name starts with the public directory's.
//! - Request bodies are limited ([`AUTH_BODY_LIMIT`], [`DATA_BODY_LIMIT`]); over the limit the
//!   answer is `413 Request body too large` (the reference buffered any size).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dima_core::Clock;
use dima_web::{Body, Req, Response};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};

use crate::auth::{self, Auth};
use crate::config::{self, Config};
use crate::connections::Registry;
use crate::error::{ApiError, ApiResult};
use crate::js;
use crate::mongo_hub::{self, Conn, MongoHub};
use crate::redis_hub::{self, RedisHub};
use crate::store::Store;

/// Body limit for login, setup, users and connections (a few hundred bytes in practice).
pub const AUTH_BODY_LIMIT: usize = 64 * 1024;
/// Body limit for documents, keys and commands: a 16 MB BSON document as Extended JSON
/// (base64 binaries grow by a third, wrappers add more).
pub const DATA_BODY_LIMIT: usize = 48 * 1024 * 1024;

/// Everything a request needs.
pub struct State {
    /// The configuration.
    pub config: Config,
    /// The data directory.
    pub store: Store,
    /// Time.
    pub clock: Arc<dyn Clock>,
    /// Redis clients.
    pub redis: RedisHub,
    /// MongoDB clients.
    pub mongo: MongoHub,
    /// `localeCompare`.
    pub collator: dima_text::Collator,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl State {
    fn registry(&self) -> Registry<'_> {
        Registry::new(
            &self.config.env_connections,
            &self.store,
            self.clock.as_ref(),
        )
    }

    fn auth(&self) -> Auth<'_> {
        Auth::new(&self.store, self.clock.as_ref())
    }
}

/// The single handler.
pub async fn handle(req: &mut Req<State>) -> Response {
    let host = req.header("host").map(|h| h.into_owned());
    let base = format!("http://{}", host.as_deref().unwrap_or("localhost"));
    let url = url::Url::parse(&base).and_then(|base| base.join(req.original_url()));
    let Ok(url) = url else {
        return plain(400, None);
    };
    let path = url.path().to_owned();
    if path == "/api" || path.starts_with("/api/") {
        return api(req, &url).await;
    }
    static_file(req.state(), &path).await
}

fn plain(status: u16, body: Option<(&str, &'static str)>) -> Response {
    let mut builder = http::Response::builder().status(status);
    let body = match body {
        Some((text, content_type)) => {
            builder = builder.header("content-type", content_type);
            Body::from(text.to_owned())
        }
        None => Body::empty(),
    };
    Response::from_http(builder.body(body).unwrap_or_default())
}

/// `sendJson(res, status, body, extraHeaders)`.
fn send_json(status: u16, body: &Value, cookie: Option<String>) -> Response {
    let mut builder = http::Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store");
    if let Some(cookie) = cookie {
        builder = builder.header("set-cookie", cookie);
    }
    let text = dima_text::to_js_json(body);
    Response::from_http(builder.body(Body::from(text)).unwrap_or_default())
}

fn ok(data: Value) -> Response {
    send_json(
        200,
        &json!({ "error": false, "status": 200, "data": data }),
        None,
    )
}

fn ok_with_cookie(data: Value, cookie: String) -> Response {
    send_json(
        200,
        &json!({ "error": false, "status": 200, "data": data }),
        Some(cookie),
    )
}

fn fail(error: &ApiError) -> Response {
    if error.status >= 500 {
        eprintln!("dimadb: {} {}", error.status, error.message_or_default());
    }
    send_json(
        error.status,
        &json!({ "error": true, "status": error.status, "message": error.message_or_default() }),
        None,
    )
}

/// `readBody(req)`: the whole body as JSON; no body is `{}`; text that is not JSON is the
/// reference's status-less `Error('Invalid JSON')`, a 500.
async fn read_body(req: &mut Req<State>, limit: usize) -> ApiResult<Value> {
    let Some(mut body) = req.take_body_stream() else {
        return Ok(json!({}));
    };
    let mut buffer: Vec<u8> = Vec::new();
    let mut any_chunk = false;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| ApiError::internal(error.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if data.is_empty() {
                continue;
            }
            any_chunk = true;
            if buffer.len() + data.len() > limit {
                return Err(ApiError::new(413, "Request body too large"));
            }
            buffer.extend_from_slice(&data);
        }
    }
    if !any_chunk {
        return Ok(json!({}));
    }
    let text = String::from_utf8_lossy(&buffer);
    js::parse_json(text.as_bytes()).ok_or_else(|| ApiError::internal("Invalid JSON"))
}

/// `body.<name>` on a parsed body: reading a property of `null` throws a `TypeError` (500).
fn field<'a>(body: &'a Value, name: &str) -> ApiResult<Option<&'a Value>> {
    match body {
        Value::Null => Err(ApiError::internal(format!(
            "Cannot read properties of null (reading '{name}')"
        ))),
        Value::Object(map) => Ok(map.get(name)),
        _ => Ok(None),
    }
}

/// Destructuring a `null` parameter (`function f({ name, url })`).
fn destructure(body: &Value, first: &str) -> ApiResult<()> {
    if body.is_null() {
        return Err(ApiError::internal(format!(
            "Cannot destructure property '{first}' of 'object null' as it is null."
        )));
    }
    Ok(())
}

async fn api(req: &mut Req<State>, url: &url::Url) -> Response {
    let path = url.path();
    // CSRF gate, before routing: unknown paths without the header are 403 too.
    if path != "/api/health" && req.header("x-dimadb").as_deref() != Some("1") {
        return fail(&ApiError::new(403, "Missing X-Dimadb header"));
    }
    match route(req, url).await {
        Ok(response) => response,
        Err(error) => fail(&error),
    }
}

fn query(url: &url::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// `url.searchParams.get(name) || fallback`.
fn query_or(url: &url::Url, name: &str, fallback: &str) -> String {
    query(url, name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

async fn require_user(req: &Req<State>) -> ApiResult<Value> {
    let cookie = req.header("cookie").map(|c| c.into_owned());
    req.state()
        .auth()
        .current_user(cookie.as_deref())
        .await?
        .ok_or_else(|| ApiError::new(401, "Not authenticated"))
}

fn secure(req: &Req<State>) -> bool {
    auth::is_secure(req.header("x-forwarded-proto").as_deref())
}

/// The path segment after a prefix, matching `([^/]+)` then `rest`.
fn segment<'p>(path: &'p str, prefix: &str) -> Option<(&'p str, &'p str)> {
    let rest = path.strip_prefix(prefix)?;
    let (id, tail) = match rest.find('/') {
        Some(at) => (rest.get(..at)?, rest.get(at..)?),
        None => (rest, ""),
    };
    if id.is_empty() {
        return None;
    }
    Some((id, tail))
}

fn decode_id(raw: &str) -> ApiResult<String> {
    js::decode_uri_component(raw).ok_or_else(|| ApiError::internal("URI malformed"))
}

#[expect(
    clippy::too_many_lines,
    reason = "one route table, in the reference's order"
)]
async fn route(req: &mut Req<State>, url: &url::Url) -> ApiResult<Response> {
    let method = req.method().as_str().to_owned();
    let path = url.path().to_owned();
    let state = req.state_arc();
    let m = method.as_str();

    if m == "GET" && path == "/api/health" {
        return Ok(ok(json!({
            "ok": true,
            "service": "dimadb",
            "dataDir": state.config.data_dir.display().to_string(),
        })));
    }
    if m == "GET" && path == "/api/setup/status" {
        return Ok(ok(
            json!({ "needsSetup": state.auth().needs_setup().await }),
        ));
    }
    if m == "POST" && path == "/api/setup" {
        if !state.auth().needs_setup().await {
            return Err(ApiError::conflict("Setup already completed"));
        }
        let body = read_body(req, AUTH_BODY_LIMIT).await?;
        let username = field(&body, "username")?;
        let user = state
            .auth()
            .create_user(username, field(&body, "password")?, "admin")
            .await?;
        let session = state.auth().open_session(&user).await?;
        return Ok(ok_with_cookie(
            json!({ "user": auth::public_user(&user) }),
            auth::session_cookie(&session, secure(req)),
        ));
    }
    if m == "POST" && path == "/api/login" {
        let body = read_body(req, AUTH_BODY_LIMIT).await?;
        let username = field(&body, "username")?;
        let (user, session) = state
            .auth()
            .login(username, field(&body, "password")?)
            .await?;
        return Ok(ok_with_cookie(
            json!({ "user": auth::public_user(&user) }),
            auth::session_cookie(&session, secure(req)),
        ));
    }
    if m == "POST" && path == "/api/logout" {
        let cookie = req.header("cookie").map(|c| c.into_owned());
        state.auth().logout(cookie.as_deref()).await?;
        return Ok(ok_with_cookie(
            json!({ "ok": true }),
            auth::clear_session_cookie(secure(req)),
        ));
    }
    if m == "GET" && path == "/api/me" {
        let user = require_user(req).await?;
        return Ok(ok(json!({ "user": auth::public_user(&user) })));
    }
    if path == "/api/users" && (m == "GET" || m == "POST") {
        let user = require_user(req).await?;
        if user.get("role").and_then(Value::as_str) != Some("admin") {
            return Err(ApiError::new(403, "Admin only"));
        }
        if m == "GET" {
            let users = state.store.read(crate::store::List::Users).await;
            return Ok(ok(Value::Array(
                users.iter().map(auth::public_user).collect(),
            )));
        }
        let body = read_body(req, AUTH_BODY_LIMIT).await?;
        let username = field(&body, "username")?;
        let password = field(&body, "password")?;
        let role = if field(&body, "role")?.and_then(Value::as_str) == Some("user") {
            "user"
        } else {
            "admin"
        };
        let created = state.auth().create_user(username, password, role).await?;
        return Ok(ok(auth::public_user(&created)));
    }
    if m == "GET" && path == "/api/connections" {
        require_user(req).await?;
        return Ok(ok(Value::Array(state.registry().list().await?)));
    }
    if m == "POST" && path == "/api/connections" {
        require_user(req).await?;
        let body = read_body(req, AUTH_BODY_LIMIT).await?;
        destructure(&body, "name")?;
        let body = if body.is_object() { body } else { json!({}) };
        return Ok(ok(state.registry().add(&body).await?));
    }

    if let Some((raw_id, tail)) = segment(&path, "/api/connections/")
        && (tail.is_empty() || tail == "/ping")
    {
        require_user(req).await?;
        let id = decode_id(raw_id)?;
        let registry = state.registry();
        if m == "DELETE" && tail.is_empty() {
            state.redis.drop_client(&id);
            state.mongo.drop_client(&id);
            registry.remove(&id).await?;
            return Ok(ok(json!({ "ok": true })));
        }
        if m == "POST" && tail == "/ping" {
            let row = registry.require(&id, None).await?;
            let pong = if row.engine == config::Engine::Mongo {
                mongo_hub::ping(Conn {
                    hub: &state.mongo,
                    registry: &registry,
                    id: &id,
                })
                .await?
            } else {
                state.redis.client(&registry, &id).await?.ping().await?
            };
            return Ok(ok(json!({ "ok": true, "pong": pong })));
        }
    }

    if let Some((raw_id, tail)) = segment(&path, "/api/mongo/")
        && let Some(action) = tail.strip_prefix('/')
        && matches!(action, "dbs" | "collections" | "docs" | "doc")
    {
        require_user(req).await?;
        let id = decode_id(raw_id)?;
        let registry = state.registry();
        let conn = Conn {
            hub: &state.mongo,
            registry: &registry,
            id: &id,
        };
        let text = |name: &str| Value::from(query_or(url, name, ""));
        match (action, m) {
            ("dbs", "GET") => return Ok(ok(mongo_hub::databases(conn).await?)),
            ("collections", "GET") => {
                return Ok(ok(mongo_hub::collections(conn, &text("db")).await?));
            }
            ("docs", "GET") => {
                let query = mongo_hub::DocsQuery {
                    db: query_or(url, "db", ""),
                    collection: query_or(url, "collection", ""),
                    skip: query_or(url, "skip", "0"),
                    limit: query_or(url, "limit", "50"),
                    filter: query_or(url, "filter", "{}"),
                };
                return Ok(ok(mongo_hub::docs(conn, &query).await?));
            }
            ("doc", "GET") => {
                return Ok(ok(mongo_hub::inspect(
                    conn,
                    &text("db"),
                    &text("collection"),
                    &text("id"),
                )
                .await?));
            }
            ("doc", "POST") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                destructure(&body, "db")?;
                return Ok(ok(mongo_hub::insert(conn, &body).await?));
            }
            ("doc", "PUT") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                destructure(&body, "db")?;
                return Ok(ok(mongo_hub::save(conn, &body).await?));
            }
            ("doc", "DELETE") => {
                return Ok(ok(mongo_hub::delete(
                    conn,
                    &text("db"),
                    &text("collection"),
                    &text("id"),
                )
                .await?));
            }
            _ => {}
        }
    }

    if let Some((raw_id, tail)) = segment(&path, "/api/redis/")
        && let Some(action) = tail.strip_prefix('/')
        && matches!(action, "keys" | "key" | "command" | "tree")
    {
        require_user(req).await?;
        let id = decode_id(raw_id)?;
        let registry = state.registry();
        match (action, m) {
            ("tree", "GET") => {
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(client
                    .tree(
                        &query_or(url, "prefix", ""),
                        &query_or(url, "query", ""),
                        &query_or(url, "cursor", "0"),
                        &state.collator,
                    )
                    .await?));
            }
            ("keys", "GET") => {
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(client
                    .scan(
                        &query_or(url, "cursor", "0"),
                        &query_or(url, "match", "*"),
                        &query_or(url, "count", "50"),
                    )
                    .await?));
            }
            ("key", "GET") => {
                let key = query_or(url, "key", "");
                if key.is_empty() {
                    return Err(ApiError::bad_request("key is required"));
                }
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(client.inspect(&key).await?));
            }
            ("key", "PUT") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                let key = field(&body, "key")?;
                if !js::truthy(key) {
                    return Err(ApiError::bad_request("key is required"));
                }
                let key = key.cloned().unwrap_or(Value::Null);
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(client.set_string(&key, field(&body, "value")?).await?));
            }
            ("key", "POST") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                if !js::truthy(field(&body, "key")?) {
                    return Err(ApiError::bad_request("key is required"));
                }
                let key = js::string_or_empty(body.get("key"));
                let kind = {
                    let kind = js::string_or_empty(body.get("type"));
                    if kind.is_empty() {
                        "string".to_owned()
                    } else {
                        kind
                    }
                };
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(client.create(&key, &kind, &body).await?));
            }
            ("key", "PATCH") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                if !js::truthy(field(&body, "key")?) {
                    return Err(ApiError::bad_request("key is required"));
                }
                let (key, op) = redis_hub::mutate_args(&body)?;
                let mut client = state.redis.client(&registry, &id).await?;
                let marker = ldel_marker(state.clock.as_ref(), state.store.random())?;
                return Ok(ok(client.mutate(&key, &op, &body, &marker).await?));
            }
            ("key", "DELETE") => {
                let key = query_or(url, "key", "");
                if key.is_empty() {
                    return Err(ApiError::bad_request("key is required"));
                }
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(json!({ "deleted": client.del(&key).await? })));
            }
            ("command", "POST") => {
                let body = read_body(req, DATA_BODY_LIMIT).await?;
                let args: Vec<String> = match field(&body, "args")? {
                    Some(Value::Array(items)) => {
                        items.iter().map(|item| js::string(Some(item))).collect()
                    }
                    _ => js::split_whitespace(&js::string_or_empty(body.get("command"))),
                };
                let first = match body.get("args") {
                    Some(Value::Array(items)) => js::truthy(items.first()),
                    _ => args.first().is_some_and(|a| !a.is_empty()),
                };
                if !first {
                    return Err(ApiError::bad_request("command is required"));
                }
                redis_hub::check_dangerous(&args, js::truthy(body.get("confirm")))?;
                let mut client = state.redis.client(&registry, &id).await?;
                return Ok(ok(json!({ "result": client.command(&args).await? })));
            }
            _ => {}
        }
    }

    Err(ApiError::not_found("Not found"))
}

/// `__dimadb_del_${Date.now()}_${Math.random().toString(36).slice(2)}`.
fn ldel_marker(clock: &dyn Clock, random: &dyn dima_core::Random) -> ApiResult<String> {
    let suffix = random
        .math_random_base36(2, usize::MAX)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(format!("__dimadb_del_{}_{suffix}", clock.now_ms()))
}

const MIME: [(&str, &str); 11] = [
    (".html", "text/html; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".ico", "image/x-icon"),
    (".png", "image/png"),
    (".webp", "image/webp"),
    (".woff2", "font/woff2"),
    (".map", "application/json"),
];

/// Node's `path.extname(p)`: from the last `.` of the last segment, unless that segment starts
/// with its only dot.
fn extname(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    let trimmed = base.trim_start_matches('.');
    let leading = base.len() - trimmed.len();
    match trimmed.rfind('.') {
        Some(at) => base.get(leading + at..).unwrap_or_default(),
        None => "",
    }
}

/// `safePublicPath(urlPath)`, with a component-wise containment check.
fn safe_public_path(public_dir: &Path, url_path: &str) -> Result<Option<PathBuf>, ()> {
    let path = url_path.split('?').next().unwrap_or_default();
    let decoded = js::decode_uri_component(path).ok_or(())?;
    let joined = format!("{}/{}", public_dir.display(), decoded);
    let resolved = config::normalize(Path::new(&joined));
    Ok(resolved.starts_with(public_dir).then_some(resolved))
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
}

async fn static_file(state: &State, pathname: &str) -> Response {
    let requested = if pathname == "/" {
        "/index.html"
    } else {
        pathname
    };
    let Ok(resolved) = safe_public_path(&state.config.public_dir, requested) else {
        // The reference crashed here (`decodeURIComponent` threw outside any handler).
        return plain(400, None);
    };
    let Some(resolved) = resolved else {
        return plain(400, None);
    };
    if is_file(&resolved).await {
        return send_file(&resolved, true).await;
    }
    let index = state.config.public_dir.join("index.html");
    if tokio::fs::metadata(&index).await.is_ok() {
        return send_file(&index, false).await;
    }
    plain(
        503,
        Some(("dimadb public assets missing", "text/plain; charset=utf-8")),
    )
}

/// `sendFile(res, filePath, cache)`: streamed, no length, no validators.
async fn send_file(path: &Path, cache: bool) -> Response {
    let text = path.display().to_string();
    let content_type = MIME
        .iter()
        .find(|(ext, _)| *ext == extname(&text))
        .map_or("application/octet-stream", |(_, kind)| *kind);
    let mut builder = http::Response::builder()
        .status(200)
        .header("content-type", content_type);
    if text.ends_with("index.html") {
        builder = builder.header("cache-control", "no-cache, no-store, must-revalidate");
    } else if cache {
        builder = builder.header("cache-control", "public, max-age=2592000, immutable");
    }
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => return plain(500, None),
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = Body::from_stream(stream);
    Response::from_http(builder.body(body).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extname_is_node_s() {
        assert_eq!(extname("/a/index.html"), ".html");
        assert_eq!(extname("/a/.bashrc"), "");
        assert_eq!(extname("/a/x.tar.gz"), ".gz");
        assert_eq!(extname("/a/file."), ".");
        assert_eq!(extname("/a/.."), "");
        assert_eq!(extname("/a/noext"), "");
        assert_eq!(extname("/a/..x.js"), ".js");
    }

    #[test]
    fn static_paths_stay_inside() {
        let root = Path::new("/app/public");
        assert_eq!(
            safe_public_path(root, "/main.js"),
            Ok(Some(PathBuf::from("/app/public/main.js")))
        );
        assert_eq!(
            safe_public_path(root, "/a/../b%20c.css"),
            Ok(Some(PathBuf::from("/app/public/b c.css")))
        );
        assert_eq!(safe_public_path(root, "/..%2F..%2Fetc%2Fpasswd"), Ok(None));
        assert_eq!(safe_public_path(root, "/..%2Fpublic-x%2Fsecret"), Ok(None));
        assert_eq!(safe_public_path(root, "/%"), Err(()));
        assert_eq!(safe_public_path(root, "/%E0%A4"), Err(()));
    }

    #[test]
    fn path_segments() {
        assert_eq!(
            segment("/api/redis/env%3Ax/key", "/api/redis/"),
            Some(("env%3Ax", "/key"))
        );
        assert_eq!(
            segment("/api/connections/abc", "/api/connections/"),
            Some(("abc", ""))
        );
        assert_eq!(segment("/api/connections/", "/api/connections/"), None);
        assert_eq!(segment("/api/mongo//dbs", "/api/mongo/"), None);
    }
}
