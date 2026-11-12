//! Mock routes: when a request matches, and how it is answered. The same shape serves the
//! provider defaults (`mock/providers.json`), a target's `mock.routes` and a scenario's
//! `mock.routes`.
//!
//! ```json
//! { "host": "api.twitch.tv", "method": "GET", "path": "/helix/users", "query": { "login": "rig" },
//!   "headers": { "client-id": "*" }, "body": { "model": "m" }, "call": 2,
//!   "respond": { "status": 200, "headers": {}, "json": {}, "delay_ms": 0 } }
//! ```

use std::collections::BTreeMap;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::timefmt;

/// A route as written in a file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteFile {
    /// The provider host (target and scenario routes; implied in the provider table).
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub query: Map<String, Value>,
    #[serde(default)]
    pub headers: Map<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub body_contains: Option<String>,
    /// Answer only the Nth request (or these) that matches the other conditions.
    #[serde(default)]
    pub call: Option<Value>,
    #[serde(default)]
    pub respond: Option<RespondFile>,
    #[serde(default)]
    pub handler: Option<String>,
    #[serde(default)]
    pub args: Option<Value>,
    /// Forward the request to one of the side's own ports (`port.http`).
    #[serde(default)]
    pub proxy: Option<String>,
    /// Record the call under another provider name (one host, two services).
    #[serde(default)]
    pub provider: Option<String>,
    /// Why this route exists (shown in reports).
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RespondFile {
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: Map<String, Value>,
    #[serde(default)]
    pub json: Option<Value>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub base64: Option<String>,
    /// Server-sent events: each element is one `data:` event (a string as is, anything else as
    /// JSON). Sent as a stream, one event per chunk.
    #[serde(default)]
    pub sse: Option<Vec<Value>>,
    /// Raw body pieces sent one by one (with `chunk_delay_ms` between them).
    #[serde(default)]
    pub chunks: Option<Vec<String>>,
    #[serde(default)]
    pub chunk_delay_ms: Option<u64>,
    /// Wait this long before answering.
    #[serde(default)]
    pub delay_ms: Option<u64>,
    /// `drop` (close the connection without an answer), `timeout` (never answer), `truncate`
    /// (send the headers and the first chunk, then close).
    #[serde(default)]
    pub fail: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    Drop,
    Timeout,
    Truncate,
}

#[derive(Debug, Clone)]
pub enum BodySpec {
    Empty,
    Json(Value),
    Text(String),
    Bytes(Vec<u8>),
    Sse(Vec<Value>),
    Chunks(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Respond {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: BodySpec,
    pub chunk_delay_ms: u64,
    pub delay_ms: u64,
    pub fail: Option<Fail>,
}

#[derive(Debug, Clone)]
pub enum Action {
    Respond(Respond),
    Handler { name: String, args: Value },
    Proxy(String),
}

#[derive(Debug, Clone, PartialEq)]
enum PathSeg {
    Lit(String),
    /// `*` or `{name}`: one segment.
    One(Option<String>),
    /// `**`: the rest (also nothing).
    Rest,
}

#[derive(Debug, Clone)]
pub struct Route {
    /// Lower case; `None` matches any host of the provider (provider defaults).
    pub host: Option<String>,
    pub method: Option<String>,
    path: Option<Vec<PathSeg>>,
    pub path_text: String,
    query: Vec<(String, Value)>,
    headers: Vec<(String, Value)>,
    body: Option<Value>,
    body_contains: Option<String>,
    calls: Option<Vec<u32>>,
    pub action: Action,
    pub provider: Option<String>,
    /// Where it came from, for reports: `scenario route 2`, `default twitch.users`.
    pub origin: String,
}

/// A request as the mock sees it, for matching.
pub struct Incoming<'a> {
    pub method: &'a str,
    /// The path after the host segment (`/helix/users`), percent-decoded per segment.
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, Vec<u8>)],
    /// The body as JSON when it is JSON (or a form, as an object of strings).
    pub json: Option<&'a Value>,
    pub text: Option<&'a str>,
}

fn split_path(p: &str) -> Vec<&str> {
    let trimmed = p.strip_suffix('/').unwrap_or(p);
    trimmed.split('/').skip(1).collect()
}

fn compile_path(p: &str) -> Result<Vec<PathSeg>, String> {
    if !p.starts_with('/') {
        return Err(format!("path `{p}` must start with /"));
    }
    let mut out = Vec::new();
    for s in split_path(p) {
        out.push(if s == "**" {
            PathSeg::Rest
        } else if s == "*" {
            PathSeg::One(None)
        } else if let Some(name) = s.strip_prefix('{').and_then(|x| x.strip_suffix('}')) {
            PathSeg::One(Some(name.to_string()))
        } else {
            PathSeg::Lit(s.to_string())
        });
    }
    Ok(out)
}

fn match_path(segs: &[PathSeg], path: &str, caps: &mut BTreeMap<String, String>) -> bool {
    let parts = split_path(path);
    let mut i = 0;
    for (k, s) in segs.iter().enumerate() {
        match s {
            PathSeg::Rest => {
                // `**` must be last; anything after it is ignored at compile time.
                let _ = k;
                return true;
            }
            PathSeg::Lit(l) => {
                if parts.get(i) != Some(&l.as_str()) {
                    return false;
                }
                i += 1;
            }
            PathSeg::One(name) => {
                let Some(v) = parts.get(i) else { return false };
                if let Some(n) = name {
                    caps.insert(n.clone(), (*v).to_string());
                }
                i += 1;
            }
        }
    }
    i == parts.len()
}

/// JSON subset: every key of `want` is in `have` with a matching value; arrays and scalars
/// compare exactly; `"*"` matches any present value.
pub fn json_subset(want: &Value, have: &Value) -> bool {
    match (want, have) {
        (Value::String(s), _) if s == "*" => true,
        (Value::Object(w), Value::Object(h)) => w.iter().all(|(k, v)| match h.get(k) {
            Some(x) => json_subset(v, x),
            None => v.is_null(),
        }),
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (a, b) => a == b,
    }
}

fn parse_calls(v: &Value, at: &str) -> Result<Vec<u32>, String> {
    let one = |x: &Value| {
        x.as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n >= 1)
            .ok_or_else(|| format!("{at}.call: call numbers start at 1"))
    };
    match v {
        Value::Array(items) if !items.is_empty() => items.iter().map(one).collect(),
        x => one(x).map(|n| vec![n]),
    }
}

fn string_map(m: &Map<String, Value>, at: &str) -> Result<Vec<(String, String)>, String> {
    m.iter()
        .map(|(k, v)| match v {
            Value::String(s) => Ok((k.to_ascii_lowercase(), s.clone())),
            Value::Number(n) => Ok((k.to_ascii_lowercase(), n.to_string())),
            _ => Err(format!("{at}.{k}: header values are strings")),
        })
        .collect()
}

fn respond(r: RespondFile, at: &str) -> Result<Respond, String> {
    let bodies = [
        r.json.is_some(),
        r.text.is_some(),
        r.base64.is_some(),
        r.sse.is_some(),
        r.chunks.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    if bodies > 1 {
        return Err(format!(
            "{at}: at most one of json, text, base64, sse, chunks"
        ));
    }
    let body = if let Some(j) = r.json {
        BodySpec::Json(j)
    } else if let Some(t) = r.text {
        BodySpec::Text(t)
    } else if let Some(b) = r.base64 {
        BodySpec::Bytes(
            base64::engine::general_purpose::STANDARD
                .decode(b)
                .map_err(|e| format!("{at}.base64: {e}"))?,
        )
    } else if let Some(s) = r.sse {
        BodySpec::Sse(s)
    } else if let Some(c) = r.chunks {
        BodySpec::Chunks(c)
    } else {
        BodySpec::Empty
    };
    let fail = match r.fail.as_deref() {
        None => None,
        Some("drop") => Some(Fail::Drop),
        Some("timeout") => Some(Fail::Timeout),
        Some("truncate") => Some(Fail::Truncate),
        Some(other) => {
            return Err(format!(
                "{at}.fail: `{other}` (use drop, timeout or truncate)"
            ));
        }
    };
    let status = r.status.unwrap_or(if matches!(body, BodySpec::Empty) {
        204
    } else {
        200
    });
    if !(100..=599).contains(&status) {
        return Err(format!("{at}.status: 100 to 599"));
    }
    Ok(Respond {
        status,
        headers: string_map(&r.headers, &format!("{at}.headers"))?,
        body,
        chunk_delay_ms: r.chunk_delay_ms.unwrap_or(0).min(600_000),
        delay_ms: r.delay_ms.unwrap_or(0).min(600_000),
        fail,
    })
}

/// Handlers the mock implements in code (see `handlers.rs`).
pub const HANDLERS: &[&str] = &[
    "twitch.users",
    "twitch.channels",
    "twitch.oauth.token",
    "twitch.oauth.validate",
    "twitch.eventsub.create",
    "twitch.eventsub.list",
    "twitch.eventsub.delete",
    "twitch.chat.send",
    "paginate",
    "openai.chat",
    "openai.embeddings",
    "anthropic.messages",
    "s3",
    "wav",
    "mp3",
];

impl Route {
    /// Check and compile a route. `need_host`: target and scenario routes name their provider.
    pub fn compile(f: RouteFile, need_host: bool, origin: String) -> Result<Route, String> {
        let at = origin.clone();
        let host = f.host.map(|h| h.to_ascii_lowercase());
        if need_host && host.is_none() {
            return Err(format!(
                "{at}: \"host\" names the provider (api.twitch.tv, openrouter.ai, ...)"
            ));
        }
        let method = f.method.map(|m| m.to_ascii_uppercase());
        let path = match &f.path {
            Some(p) => Some(compile_path(p).map_err(|e| format!("{at}: {e}"))?),
            None => None,
        };
        let actions = [f.respond.is_some(), f.handler.is_some(), f.proxy.is_some()]
            .iter()
            .filter(|x| **x)
            .count();
        if actions != 1 {
            return Err(format!(
                "{at}: a route has exactly one of respond, handler, proxy"
            ));
        }
        if f.args.is_some() && f.handler.is_none() {
            return Err(format!("{at}.args: only with a handler"));
        }
        let action = if let Some(r) = f.respond {
            Action::Respond(respond(r, &format!("{at}.respond"))?)
        } else if let Some(h) = f.handler {
            if !HANDLERS.contains(&h.as_str()) {
                return Err(format!(
                    "{at}.handler: `{h}`; known: {}",
                    HANDLERS.join(", ")
                ));
            }
            Action::Handler {
                name: h,
                args: f.args.unwrap_or(Value::Null),
            }
        } else if let Some(p) = f.proxy {
            if !p.starts_with("port.") {
                return Err(format!("{at}.proxy: a side port such as port.http"));
            }
            Action::Proxy(p)
        } else {
            return Err(format!("{at}: no action"));
        };
        let query = f
            .query
            .into_iter()
            .map(|(k, v)| match v {
                Value::String(_) | Value::Null => Ok((k, v)),
                _ => Err(format!("{at}.query.{k}: a string, \"*\" or null (absent)")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let headers = f
            .headers
            .into_iter()
            .map(|(k, v)| match v {
                Value::String(_) | Value::Null => Ok((k.to_ascii_lowercase(), v)),
                _ => Err(format!(
                    "{at}.headers.{k}: a string, \"*\" or null (absent)"
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let calls = match &f.call {
            Some(v) => Some(parse_calls(v, &at)?),
            None => None,
        };
        Ok(Route {
            host,
            method,
            path,
            path_text: f.path.unwrap_or_else(|| "/**".into()),
            query,
            headers,
            body: f.body,
            body_contains: f.body_contains,
            calls,
            action,
            provider: f.provider,
            origin,
        })
    }

    /// Whether the request meets every condition except the call number. Fills path captures.
    pub fn matches(
        &self,
        host: &str,
        req: &Incoming<'_>,
        caps: &mut BTreeMap<String, String>,
    ) -> bool {
        if let Some(h) = &self.host
            && !crate::path::name_glob(h, host)
        {
            return false;
        }
        if let Some(m) = &self.method
            && m != req.method
        {
            return false;
        }
        caps.clear();
        if let Some(segs) = &self.path
            && !match_path(segs, req.path, caps)
        {
            return false;
        }
        for (k, want) in &self.query {
            let have = req.query.iter().find(|(n, _)| n == k).map(|(_, v)| v);
            let ok = match (want, have) {
                (Value::Null, None) => true,
                (Value::Null, Some(_)) | (_, None) => false,
                (Value::String(w), Some(_)) if w == "*" => true,
                (Value::String(w), Some(h)) => w == h,
                _ => false,
            };
            if !ok {
                return false;
            }
        }
        for (k, want) in &self.headers {
            let have = req.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v);
            let ok = match (want, have) {
                (Value::Null, None) => true,
                (Value::Null, Some(_)) | (_, None) => false,
                (Value::String(w), Some(_)) if w == "*" => true,
                (Value::String(w), Some(h)) => w.as_bytes() == h.as_slice(),
                _ => false,
            };
            if !ok {
                return false;
            }
        }
        if let Some(want) = &self.body {
            match req.json {
                Some(have) if json_subset(want, have) => {}
                _ => return false,
            }
        }
        if let Some(needle) = &self.body_contains {
            match req.text {
                Some(t) if t.contains(needle.as_str()) => {}
                _ => return false,
            }
        }
        true
    }

    /// Whether this route answers its `n`-th matching request.
    pub fn answers_call(&self, n: u32) -> bool {
        self.calls.as_ref().is_none_or(|c| c.contains(&n))
    }
}

/// What a `${...}` in an answer can refer to.
pub struct AnswerCtx<'a> {
    pub now_ms: i64,
    pub path: &'a BTreeMap<String, String>,
    pub query: &'a [(String, String)],
    pub body: Option<&'a Value>,
    /// A deterministic id for this request (UUID v4 shaped).
    pub id: &'a str,
    /// The route's call number.
    pub call: u32,
}

fn lookup_body<'v>(body: &'v Value, dotted: &str) -> Option<&'v Value> {
    let mut cur = body;
    for part in dotted.split('.') {
        cur = match cur {
            Value::Object(m) => m.get(part)?,
            Value::Array(a) => a.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn expr_value(expr: &str, ctx: &AnswerCtx<'_>) -> Option<Value> {
    for (name, fmt) in [
        ("now_ms", template::NowFmt::Ms),
        ("now_s", template::NowFmt::S),
        ("now_iso", template::NowFmt::Iso),
    ] {
        if let Some(rest) = expr.strip_prefix(name) {
            let off = if rest.is_empty() {
                Some(0)
            } else {
                timefmt::parse_offset(rest)
            }?;
            let s = template::format_now(ctx.now_ms, off, fmt);
            return Some(match fmt {
                template::NowFmt::Iso => Value::String(s),
                _ => s
                    .parse::<i64>()
                    .map(Value::from)
                    .unwrap_or(Value::String(s)),
            });
        }
    }
    if expr == "id" {
        return Some(Value::String(ctx.id.to_string()));
    }
    if expr == "call" {
        return Some(Value::from(ctx.call));
    }
    if let Some(n) = expr.strip_prefix("path.") {
        return ctx.path.get(n).map(|v| Value::String(v.clone()));
    }
    if let Some(n) = expr.strip_prefix("query.") {
        return ctx
            .query
            .iter()
            .find(|(k, _)| k == n)
            .map(|(_, v)| Value::String(v.clone()));
    }
    if let Some(p) = expr.strip_prefix("body.") {
        return ctx.body.and_then(|b| lookup_body(b, p)).cloned();
    }
    None
}

use crate::template;

/// Fill `${...}` in an answer string. A string that is exactly one expression takes the value's
/// own JSON type (`"${body.max_tokens}"` stays a number); unknown values become `null` inside
/// JSON and empty text inside strings.
pub fn render_str(s: &str, ctx: &AnswerCtx<'_>) -> Value {
    if let Some(inner) = s.strip_prefix("${").and_then(|x| x.strip_suffix('}'))
        && !inner.contains('}')
    {
        return expr_value(inner, ctx).unwrap_or(Value::Null);
    }
    Value::String(render_text(s, ctx))
}

pub fn render_text(s: &str, ctx: &AnswerCtx<'_>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(pos) = rest.find("${") {
        let (before, after) = rest.split_at(pos);
        out.push_str(before);
        let Some(end) = after.find('}') else {
            out.push_str(after);
            return out;
        };
        let (expr, tail) = after.split_at(end);
        let expr = expr.strip_prefix("${").unwrap_or(expr);
        match expr_value(expr, ctx) {
            Some(Value::String(v)) => out.push_str(&v),
            Some(Value::Null) | None => {}
            Some(other) => out.push_str(&other.to_string()),
        }
        rest = tail.strip_prefix('}').unwrap_or(tail);
    }
    out.push_str(rest);
    out
}

/// Fill `${...}` everywhere in an answer value (keys too).
pub fn render_json(v: &Value, ctx: &AnswerCtx<'_>) -> Value {
    match v {
        Value::String(s) => render_str(s, ctx),
        Value::Array(items) => Value::Array(items.iter().map(|x| render_json(x, ctx)).collect()),
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                out.insert(render_text(k, ctx), render_json(x, ctx));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use serde_json::json;

    fn route(v: Value) -> Route {
        Route::compile(serde_json::from_value(v).unwrap(), true, "r".into()).unwrap()
    }

    fn incoming<'a>(
        method: &'a str,
        path: &'a str,
        query: &'a [(String, String)],
        json: Option<&'a Value>,
    ) -> Incoming<'a> {
        Incoming {
            method,
            path,
            query,
            headers: &[],
            json,
            text: None,
        }
    }

    #[test]
    fn paths_queries_and_bodies() {
        let r = route(
            json!({"host": "api.twitch.tv", "method": "get", "path": "/helix/users/{id}",
            "query": {"login": "rig", "after": null}, "respond": {"json": {}}}),
        );
        let mut caps = BTreeMap::new();
        let q = vec![("login".to_string(), "rig".to_string())];
        assert!(r.matches(
            "api.twitch.tv",
            &incoming("GET", "/helix/users/42", &q, None),
            &mut caps
        ));
        assert_eq!(caps.get("id").map(String::as_str), Some("42"));
        let q2 = vec![
            ("login".to_string(), "rig".to_string()),
            ("after".to_string(), "x".to_string()),
        ];
        assert!(!r.matches(
            "api.twitch.tv",
            &incoming("GET", "/helix/users/42", &q2, None),
            &mut caps
        ));
        assert!(!r.matches(
            "id.twitch.tv",
            &incoming("GET", "/helix/users/42", &q, None),
            &mut caps
        ));
        // A trailing slash is the same path (Polar writes /v1/customers/).
        let p = route(json!({"host": "api.polar.sh", "path": "/v1/customers", "respond": {}}));
        assert!(p.matches(
            "api.polar.sh",
            &incoming("POST", "/v1/customers/", &[], None),
            &mut caps
        ));
        let b = route(
            json!({"host": "h", "path": "/x/**", "body": {"model": "m", "n": 2}, "respond": {}}),
        );
        let body = json!({"model": "m", "n": 2.0, "other": [1]});
        assert!(b.matches(
            "h",
            &incoming("POST", "/x/a/b", &[], Some(&body)),
            &mut caps
        ));
        let wrong = json!({"model": "z", "n": 2});
        assert!(!b.matches("h", &incoming("POST", "/x", &[], Some(&wrong)), &mut caps));
    }

    #[test]
    fn nth_call_and_checks() {
        let r = route(json!({"host": "h", "call": [2, 3], "respond": {"status": 500}}));
        assert!(!r.answers_call(1) && r.answers_call(2) && r.answers_call(3));
        let bad = |v: Value| {
            Route::compile(serde_json::from_value(v).unwrap(), true, "r".into()).unwrap_err()
        };
        assert!(bad(json!({"respond": {}})).contains("host"));
        assert!(bad(json!({"host": "h", "handler": "nope"})).contains("known"));
        assert!(
            bad(json!({"host": "h", "respond": {}, "proxy": "port.http"})).contains("exactly one")
        );
        assert!(bad(json!({"host": "h", "respond": {"fail": "explode"}})).contains("drop"));
        assert!(bad(json!({"host": "h", "call": 0, "respond": {}})).contains("start at 1"));
    }

    #[test]
    fn answer_templates() {
        let caps: BTreeMap<String, String> = [("id".to_string(), "7".to_string())].into();
        let q = vec![("login".to_string(), "rig".to_string())];
        let body = json!({"model": "m", "n": 3, "user": {"name": "ñ"}});
        let ctx = AnswerCtx {
            now_ms: 1_000_000,
            path: &caps,
            query: &q,
            body: Some(&body),
            id: "00000000-0000-4000-8000-000000000001",
            call: 2,
        };
        let v = render_json(
            &json!({"m": "${body.model}", "n": "${body.n}", "who": "${body.user.name}!", "t": "${now_ms+1s}",
                "p": "${path.id}", "q": "${query.login}", "c": "${call}", "missing": "${body.nope}", "k${call}": 1}),
            &ctx,
        );
        assert_eq!(
            v,
            json!({"m": "m", "n": 3, "who": "ñ!", "t": 1_001_000, "p": "7", "q": "rig", "c": 2, "missing": null, "k2": 1})
        );
    }
}
