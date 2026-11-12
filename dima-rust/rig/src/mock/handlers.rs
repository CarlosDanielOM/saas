//! Built-in handlers: the parts of the outside world that have state or shape that a canned
//! answer cannot give (Twitch tokens, users and EventSub subscriptions, pagination, streamed
//! LLM answers, deterministic embeddings, an S3 object store).
//!
//! Every answer is deterministic for a given sequence of requests: ids derive from the request
//! content, vectors from the input text.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::route::{BodySpec, Respond};
use crate::canon::fnv1a64;
use crate::template::{self, NowFmt};

/// A request as handlers see it.
pub struct Req<'a> {
    pub host: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, Vec<u8>)],
    pub body: &'a [u8],
    pub json: Option<&'a Value>,
    pub now_ms: i64,
    /// The deterministic id of this request.
    pub id: &'a str,
}

impl Req<'_> {
    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| String::from_utf8_lossy(v).to_string())
    }

    fn query_all(&self, name: &str) -> Vec<&str> {
        self.query
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    fn query_one(&self, name: &str) -> Option<&str> {
        self.query_all(name).into_iter().next()
    }

    fn iso(&self, offset_ms: i64) -> String {
        template::format_now(self.now_ms, offset_ms, NowFmt::Iso)
    }

    /// The bearer or OAuth token of the request.
    fn token(&self) -> Option<String> {
        let h = self.header("authorization")?;
        let (scheme, t) = h.split_once(' ')?;
        (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("oauth"))
            .then(|| t.trim().to_string())
    }
}

fn json_answer(status: u16, v: Value) -> Respond {
    Respond {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: BodySpec::Json(v),
        chunk_delay_ms: 0,
        delay_ms: 0,
        fail: None,
    }
}

fn bytes_answer(status: u16, content_type: &str, b: Vec<u8>) -> Respond {
    Respond {
        status,
        headers: vec![("content-type".into(), content_type.into())],
        body: BodySpec::Bytes(b),
        chunk_delay_ms: 0,
        delay_ms: 0,
        fail: None,
    }
}

fn empty(status: u16) -> Respond {
    Respond {
        status,
        headers: Vec::new(),
        body: BodySpec::Empty,
        chunk_delay_ms: 0,
        delay_ms: 0,
        fail: None,
    }
}

/// A UUID v4 shaped string derived from bytes (deterministic).
pub fn uuid_from(seed: &[u8]) -> String {
    let a = fnv1a64(seed);
    let b = fnv1a64(&a.to_le_bytes());
    let hex = format!("{a:016x}{b:016x}");
    let part = |x: usize, y: usize| hex.get(x..y).unwrap_or("0");
    let variant = ["8", "9", "a", "b"]
        .get(usize::try_from(b % 4).unwrap_or(0))
        .copied()
        .unwrap_or("8");
    format!(
        "{}-{}-4{}-{}{}-{}",
        part(0, 8),
        part(8, 12),
        part(13, 16),
        variant,
        part(17, 20),
        part(20, 32)
    )
}

// ---------------------------------------------------------------------------------------------
// Seeds (mock.twitch, mock.s3 in targets and scenarios).

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TwitchSeed {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub users: Vec<Map<String, Value>>,
    #[serde(default)]
    pub tokens: Vec<TokenSeed>,
    #[serde(default)]
    pub subscriptions: Vec<Map<String, Value>>,
    #[serde(default)]
    pub page_size: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenSeed {
    pub token: String,
    /// Absent: an app access token.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// An authorization code that exchanges for this token.
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct S3ObjectSeed {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub base64: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct S3Object {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct TwitchState {
    pub client_id: String,
    pub users: Vec<Map<String, Value>>,
    pub tokens: Vec<TokenSeed>,
    pub subs: Vec<Map<String, Value>>,
    pub page_size: usize,
    /// Tokens issued by the mock so far (refresh rotations).
    pub issued: u32,
}

impl TwitchState {
    pub fn from_seed(s: &TwitchSeed, now_ms: i64) -> TwitchState {
        let client_id = s
            .client_id
            .clone()
            .unwrap_or_else(|| "rigclientid00000000000000000000".into());
        let mut st = TwitchState {
            client_id,
            users: s.users.iter().map(user_defaults).collect(),
            tokens: s.tokens.clone(),
            subs: Vec::new(),
            page_size: s.page_size.unwrap_or(100).clamp(1, 1000),
            issued: 0,
        };
        for sub in &s.subscriptions {
            let mut m = sub.clone();
            let seed = format!(
                "{}|{}|{}",
                m.get("type").map(Value::to_string).unwrap_or_default(),
                m.get("version").map(Value::to_string).unwrap_or_default(),
                m.get("condition").map(Value::to_string).unwrap_or_default()
            );
            m.entry("id")
                .or_insert_with(|| Value::String(uuid_from(seed.as_bytes())));
            m.entry("status")
                .or_insert_with(|| Value::String("enabled".into()));
            m.entry("version")
                .or_insert_with(|| Value::String("1".into()));
            m.entry("condition").or_insert_with(|| json!({}));
            m.entry("created_at").or_insert_with(|| {
                Value::String(template::format_now(now_ms, -86_400_000, NowFmt::Iso))
            });
            m.entry("transport").or_insert_with(|| json!({"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub"}));
            m.entry("cost").or_insert_with(|| json!(1));
            st.subs.push(m);
        }
        st
    }

    fn token(&self, t: &str) -> Option<&TokenSeed> {
        self.tokens.iter().find(|x| x.token == t)
    }

    fn user(&self, id: &str) -> Option<&Map<String, Value>> {
        self.users
            .iter()
            .find(|u| u.get("id").and_then(Value::as_str) == Some(id))
    }
}

fn user_defaults(u: &Map<String, Value>) -> Map<String, Value> {
    let login = u
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or("riguser")
        .to_string();
    let mut m = Map::new();
    let fields: [(&str, Value); 10] = [
        ("id", Value::String(String::new())),
        ("login", Value::String(login.clone())),
        ("display_name", Value::String(login.clone())),
        ("type", Value::String(String::new())),
        ("broadcaster_type", Value::String(String::new())),
        ("description", Value::String(String::new())),
        (
            "profile_image_url",
            Value::String(format!(
                "https://static-cdn.jtvnw.net/jtv_user_pictures/{login}-profile_image-300x300.png"
            )),
        ),
        ("offline_image_url", Value::String(String::new())),
        ("view_count", json!(0)),
        ("created_at", Value::String("2020-01-01T00:00:00Z".into())),
    ];
    for (k, v) in fields {
        m.insert(k.into(), u.get(k).cloned().unwrap_or(v));
    }
    for (k, v) in u {
        if !m.contains_key(k) && k != "channel" {
            m.insert(k.clone(), v.clone());
        }
    }
    if let Some(c) = u.get("channel") {
        m.insert("channel".into(), c.clone());
    }
    m
}

/// A user as Helix shows it (without the mock-only `channel` field).
fn public_user(u: &Map<String, Value>) -> Value {
    let mut m = u.clone();
    m.remove("channel");
    Value::Object(m)
}

pub fn s3_objects(
    seeds: &BTreeMap<String, S3ObjectSeed>,
) -> Result<BTreeMap<String, S3Object>, String> {
    use base64::Engine as _;
    let mut out = BTreeMap::new();
    for (key, s) in seeds {
        let bytes = match (&s.text, &s.base64) {
            (Some(t), None) => t.clone().into_bytes(),
            (None, Some(b)) => base64::engine::general_purpose::STANDARD
                .decode(b)
                .map_err(|e| format!("mock.s3.objects[{key}].base64: {e}"))?,
            _ => {
                return Err(format!(
                    "mock.s3.objects[{key}]: exactly one of text, base64"
                ));
            }
        };
        out.insert(
            key.trim_start_matches('/').to_string(),
            S3Object {
                bytes,
                content_type: s
                    .content_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into()),
            },
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Dispatch.

pub struct HandlerState<'s> {
    pub twitch: &'s mut TwitchState,
    pub s3: &'s mut BTreeMap<String, S3Object>,
}

/// Run a handler. `None`: the handler does not implement this request (answered as unmatched).
pub fn run(name: &str, args: &Value, req: &Req<'_>, st: &mut HandlerState<'_>) -> Option<Respond> {
    match name {
        "twitch.oauth.token" => Some(oauth_token(req, st.twitch)),
        "twitch.oauth.validate" => Some(oauth_validate(req, st.twitch)),
        "twitch.users" => Some(twitch_users(req, st.twitch)),
        "twitch.channels" => Some(twitch_channels(req, st.twitch)),
        "twitch.eventsub.create" => Some(eventsub_create(req, st.twitch)),
        "twitch.eventsub.list" => Some(eventsub_list(req, st.twitch)),
        "twitch.eventsub.delete" => Some(eventsub_delete(req, st.twitch)),
        "twitch.chat.send" => Some(chat_send(req, st.twitch)),
        "paginate" => Some(paginate(req, args)),
        "openai.chat" => Some(openai_chat(req, args)),
        "openai.embeddings" => Some(openai_embeddings(req, args)),
        "anthropic.messages" => Some(anthropic_messages(req, args)),
        "s3" => s3(req, args, st.s3),
        "wav" => Some(bytes_answer(200, "audio/wav", wav())),
        "mp3" => Some(bytes_answer(200, "audio/mpeg", mp3())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Twitch.

fn helix_error(status: u16, error: &str, message: &str) -> Respond {
    json_answer(
        status,
        json!({"error": error, "status": status, "message": message}),
    )
}

/// The token of a Helix request, checked: `Err` is the 401 Twitch gives.
fn helix_auth<'t>(req: &Req<'_>, tw: &'t TwitchState) -> Result<&'t TokenSeed, Respond> {
    let Some(t) = req.token() else {
        return Err(helix_error(401, "Unauthorized", "OAuth token is missing"));
    };
    if req.header("client-id").is_none() {
        return Err(helix_error(401, "Unauthorized", "Client ID is missing"));
    }
    tw.token(&t)
        .ok_or_else(|| helix_error(401, "Unauthorized", "Invalid OAuth token"))
}

fn form_params(req: &Req<'_>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = req.query.to_vec();
    if let Some(Value::Object(m)) = req.json {
        for (k, v) in m {
            out.push((
                k.clone(),
                v.as_str().map_or_else(|| v.to_string(), str::to_string),
            ));
        }
    }
    out
}

fn oauth_token(req: &Req<'_>, tw: &mut TwitchState) -> Respond {
    let params = form_params(req);
    let get = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let bad = |m: &str| json_answer(400, json!({"status": 400, "message": m}));
    match get("grant_type").as_deref() {
        Some("client_credentials") => {
            let client = get("client_id").unwrap_or_else(|| tw.client_id.clone());
            let token = format!("rigapp{:016x}", fnv1a64(client.as_bytes()));
            if tw.token(&token).is_none() {
                tw.tokens.push(TokenSeed {
                    token: token.clone(),
                    user_id: None,
                    scopes: Vec::new(),
                    client_id: Some(client),
                    expires_in: Some(5_011_271),
                    refresh_token: None,
                    code: None,
                });
            }
            json_answer(
                200,
                json!({"access_token": token, "expires_in": 5_011_271, "token_type": "bearer"}),
            )
        }
        Some("refresh_token") => {
            let Some(rt) = get("refresh_token") else {
                return bad("missing refresh token");
            };
            let Some(pos) = tw
                .tokens
                .iter()
                .position(|t| t.refresh_token.as_deref() == Some(rt.as_str()))
            else {
                return bad("Invalid refresh token");
            };
            tw.issued += 1;
            let new_token = format!(
                "rigtok{:016x}",
                fnv1a64(format!("{rt}|{}", tw.issued).as_bytes())
            );
            let new_refresh = format!(
                "rigref{:016x}",
                fnv1a64(format!("{new_token}|r").as_bytes())
            );
            let Some(entry) = tw.tokens.get_mut(pos) else {
                return bad("Invalid refresh token");
            };
            entry.token = new_token.clone();
            entry.refresh_token = Some(new_refresh.clone());
            let scopes = entry.scopes.clone();
            let expires = entry.expires_in.unwrap_or(14_400);
            json_answer(
                200,
                json!({"access_token": new_token, "refresh_token": new_refresh, "expires_in": expires,
                    "scope": scopes, "token_type": "bearer"}),
            )
        }
        Some("authorization_code") => {
            let Some(code) = get("code") else {
                return bad("missing code");
            };
            match tw
                .tokens
                .iter()
                .find(|t| t.code.as_deref() == Some(code.as_str()))
            {
                Some(t) => json_answer(
                    200,
                    json!({"access_token": t.token, "refresh_token": t.refresh_token, "expires_in": t.expires_in.unwrap_or(14_400),
                        "scope": t.scopes, "token_type": "bearer"}),
                ),
                None => bad("Invalid authorization code"),
            }
        }
        _ => bad("Invalid grant type"),
    }
}

fn oauth_validate(req: &Req<'_>, tw: &TwitchState) -> Respond {
    let unauthorized = |m: &str| json_answer(401, json!({"status": 401, "message": m}));
    let Some(t) = req.token() else {
        return unauthorized("missing authorization token");
    };
    let Some(tok) = tw.token(&t) else {
        return unauthorized("invalid access token");
    };
    let client = tok
        .client_id
        .clone()
        .unwrap_or_else(|| tw.client_id.clone());
    let expires = tok.expires_in.unwrap_or(14_400);
    match &tok.user_id {
        Some(uid) => {
            let login = tw
                .user(uid)
                .and_then(|u| u.get("login"))
                .cloned()
                .unwrap_or(Value::String(String::new()));
            json_answer(
                200,
                json!({"client_id": client, "login": login, "scopes": tok.scopes, "user_id": uid, "expires_in": expires}),
            )
        }
        None => json_answer(
            200,
            json!({"client_id": client, "scopes": tok.scopes, "expires_in": expires}),
        ),
    }
}

fn twitch_users(req: &Req<'_>, tw: &TwitchState) -> Respond {
    let tok = match helix_auth(req, tw) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let ids = req.query_all("id");
    let logins = req.query_all("login");
    if ids.len() + logins.len() > 100 {
        return helix_error(400, "Bad Request", "The parameters must be at most 100");
    }
    let mut data = Vec::new();
    if ids.is_empty() && logins.is_empty() {
        match tok.user_id.as_deref().and_then(|u| tw.user(u)) {
            Some(u) => data.push(public_user(u)),
            None if tok.user_id.is_none() => {
                return helix_error(
                    400,
                    "Bad Request",
                    "Must provide an ID, Login or OAuth Token",
                );
            }
            None => {}
        }
    }
    for id in ids {
        if let Some(u) = tw.user(id) {
            data.push(public_user(u));
        }
    }
    for login in logins {
        let l = login.to_ascii_lowercase();
        if let Some(u) = tw
            .users
            .iter()
            .find(|u| u.get("login").and_then(Value::as_str) == Some(l.as_str()))
        {
            data.push(public_user(u));
        }
    }
    json_answer(200, json!({ "data": data }))
}

fn twitch_channels(req: &Req<'_>, tw: &TwitchState) -> Respond {
    if let Err(e) = helix_auth(req, tw) {
        return e;
    }
    let mut data = Vec::new();
    for id in req.query_all("broadcaster_id") {
        let Some(u) = tw.user(id) else { continue };
        let s = |k: &str| u.get(k).cloned().unwrap_or(Value::String(String::new()));
        let mut c = json!({
            "broadcaster_id": id, "broadcaster_login": s("login"), "broadcaster_name": s("display_name"),
            "broadcaster_language": "es", "game_id": "", "game_name": "", "title": "", "delay": 0,
            "tags": [], "content_classification_labels": [], "is_branded_content": false
        });
        if let (Some(Value::Object(over)), Value::Object(base)) = (u.get("channel"), &mut c) {
            for (k, v) in over {
                base.insert(k.clone(), v.clone());
            }
        }
        data.push(c);
    }
    json_answer(200, json!({ "data": data }))
}

fn sub_totals(tw: &TwitchState) -> (usize, i64) {
    let cost = tw
        .subs
        .iter()
        .map(|s| s.get("cost").and_then(Value::as_i64).unwrap_or(0))
        .sum();
    (tw.subs.len(), cost)
}

fn eventsub_create(req: &Req<'_>, tw: &mut TwitchState) -> Respond {
    if let Err(e) = helix_auth(req, tw) {
        return e;
    }
    let Some(Value::Object(body)) = req.json else {
        return helix_error(400, "Bad Request", "invalid body");
    };
    let get = |k: &str| body.get(k).cloned().unwrap_or(Value::Null);
    let (ty, version, condition, transport) = (
        get("type"),
        get("version"),
        get("condition"),
        get("transport"),
    );
    if !ty.is_string() || !version.is_string() || !condition.is_object() || !transport.is_object() {
        return helix_error(
            400,
            "Bad Request",
            "type, version, condition and transport are required",
        );
    }
    let exists = tw.subs.iter().any(|s| {
        s.get("type") == Some(&ty)
            && s.get("version") == Some(&version)
            && s.get("condition") == Some(&condition)
    });
    if exists {
        return helix_error(409, "Conflict", "subscription already exists");
    }
    let seed = format!("{ty}|{version}|{condition}");
    let method = transport
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("webhook");
    let mut shown_transport = Map::new();
    shown_transport.insert("method".into(), Value::String(method.into()));
    for k in ["callback", "session_id", "conduit_id"] {
        if let Some(v) = transport.get(k) {
            shown_transport.insert(k.into(), v.clone());
        }
    }
    let status = if method == "webhook" {
        "webhook_callback_verification_pending"
    } else {
        "enabled"
    };
    let mut sub = Map::new();
    sub.insert("id".into(), Value::String(uuid_from(seed.as_bytes())));
    sub.insert("status".into(), Value::String(status.into()));
    sub.insert("type".into(), ty);
    sub.insert("version".into(), version);
    sub.insert("condition".into(), condition);
    sub.insert("created_at".into(), Value::String(req.iso(0)));
    sub.insert("transport".into(), Value::Object(shown_transport));
    sub.insert("cost".into(), json!(1));
    tw.subs.push(sub.clone());
    let (total, cost) = sub_totals(tw);
    json_answer(
        202,
        json!({"data": [sub], "total": total, "total_cost": cost, "max_total_cost": 10000}),
    )
}

fn page<'v>(items: &'v [Value], req: &Req<'_>, size: usize) -> (&'v [Value], Option<String>) {
    let start = req
        .query_one("after")
        .and_then(|c| c.strip_prefix("rigcursor"))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0)
        .min(items.len());
    let first = req
        .query_one("first")
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(size)
        .clamp(1, size);
    let end = (start + first).min(items.len());
    let next = (end < items.len()).then(|| format!("rigcursor{end}"));
    (items.get(start..end).unwrap_or(&[]), next)
}

fn eventsub_list(req: &Req<'_>, tw: &TwitchState) -> Respond {
    if let Err(e) = helix_auth(req, tw) {
        return e;
    }
    let status = req.query_one("status");
    let ty = req.query_one("type");
    let user = req.query_one("user_id");
    let id = req.query_one("subscription_id");
    let matching: Vec<Value> = tw
        .subs
        .iter()
        .filter(|s| status.is_none_or(|x| s.get("status").and_then(Value::as_str) == Some(x)))
        .filter(|s| ty.is_none_or(|x| s.get("type").and_then(Value::as_str) == Some(x)))
        .filter(|s| id.is_none_or(|x| s.get("id").and_then(Value::as_str) == Some(x)))
        .filter(|s| {
            user.is_none_or(|u| {
                s.get("condition")
                    .and_then(Value::as_object)
                    .is_some_and(|c| c.values().any(|v| v.as_str() == Some(u)))
            })
        })
        .map(|s| Value::Object(s.clone()))
        .collect();
    let (data, next) = page(&matching, req, tw.page_size);
    let (total, cost) = sub_totals(tw);
    let pagination = match next {
        Some(c) => json!({ "cursor": c }),
        None => json!({}),
    };
    json_answer(
        200,
        json!({"data": data, "total": total, "total_cost": cost, "max_total_cost": 10000, "pagination": pagination}),
    )
}

fn eventsub_delete(req: &Req<'_>, tw: &mut TwitchState) -> Respond {
    if let Err(e) = helix_auth(req, tw) {
        return e;
    }
    let Some(id) = req.query_one("id") else {
        return helix_error(400, "Bad Request", "Missing required parameter \"id\"");
    };
    match tw
        .subs
        .iter()
        .position(|s| s.get("id").and_then(Value::as_str) == Some(id))
    {
        Some(i) => {
            tw.subs.remove(i);
            empty(204)
        }
        None => helix_error(404, "Not Found", "subscription not found"),
    }
}

fn chat_send(req: &Req<'_>, tw: &TwitchState) -> Respond {
    if let Err(e) = helix_auth(req, tw) {
        return e;
    }
    let Some(Value::Object(body)) = req.json else {
        return helix_error(400, "Bad Request", "invalid body");
    };
    for k in ["broadcaster_id", "sender_id", "message"] {
        if !body.get(k).is_some_and(Value::is_string) {
            return helix_error(
                400,
                "Bad Request",
                &format!("Missing required parameter \"{k}\""),
            );
        }
    }
    json_answer(
        200,
        json!({"data": [{"message_id": req.id, "is_sent": true}]}),
    )
}

/// `args`: `items` (the whole list), `page_size` (default 20), `data_key` (default `data`),
/// `extra` (fields merged into every page).
fn paginate(req: &Req<'_>, args: &Value) -> Respond {
    let items: Vec<Value> = args
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let size = args
        .get("page_size")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(20)
        .max(1);
    let key = args
        .get("data_key")
        .and_then(Value::as_str)
        .unwrap_or("data");
    let (data, next) = page(&items, req, size);
    let mut out = Map::new();
    out.insert(key.into(), Value::Array(data.to_vec()));
    out.insert(
        "pagination".into(),
        match next {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        },
    );
    if let Some(Value::Object(extra)) = args.get("extra") {
        for (k, v) in extra {
            out.insert(k.clone(), v.clone());
        }
    }
    json_answer(200, Value::Object(out))
}

// ---------------------------------------------------------------------------------------------
// LLM providers.

fn rough_tokens(v: &Value) -> i64 {
    i64::try_from(v.to_string().chars().count() / 4)
        .unwrap_or(1)
        .max(1)
}

/// `args`: `content` (default "Rig mock answer."), `tool_calls`, `finish_reason`.
fn openai_chat(req: &Req<'_>, args: &Value) -> Respond {
    let body = req.json.cloned().unwrap_or(Value::Null);
    let model = body
        .get("model")
        .cloned()
        .unwrap_or(Value::String("openai/gpt-4o-mini".into()));
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("Rig mock answer.");
    let tool_calls = args.get("tool_calls").cloned();
    let finish =
        args.get("finish_reason")
            .and_then(Value::as_str)
            .unwrap_or(if tool_calls.is_some() {
                "tool_calls"
            } else {
                "stop"
            });
    let prompt_tokens = rough_tokens(body.get("messages").unwrap_or(&Value::Null));
    let completion_tokens = i64::try_from(content.chars().count() / 4)
        .unwrap_or(1)
        .max(1);
    let usage = json!({"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens, "cost": 0.0001});
    let id = format!("gen-{}", req.id);
    let created = req.now_ms.div_euclid(1000);
    let stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    if !stream {
        let mut message =
            json!({"role": "assistant", "content": content, "refusal": null, "reasoning": null});
        if let (Some(tc), Value::Object(m)) = (&tool_calls, &mut message) {
            m.insert("tool_calls".into(), tc.clone());
        }
        return json_answer(
            200,
            json!({"id": id, "provider": "Rig", "model": model, "object": "chat.completion", "created": created,
                "choices": [{"index": 0, "logprobs": null, "finish_reason": finish, "native_finish_reason": finish, "message": message}],
                "usage": usage}),
        );
    }
    let chunk = |delta: Value, finish: Value, usage: Option<&Value>| {
        let mut c = json!({"id": id, "provider": "Rig", "model": model, "object": "chat.completion.chunk", "created": created,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish, "native_finish_reason": finish, "logprobs": null}]});
        if let (Some(u), Value::Object(m)) = (usage, &mut c) {
            m.insert("usage".into(), u.clone());
        }
        format!("data: {c}\n\n")
    };
    let mut pieces = vec![": OPENROUTER PROCESSING\n\n".to_string()];
    pieces.push(chunk(
        json!({"role": "assistant", "content": ""}),
        Value::Null,
        None,
    ));
    let words: Vec<&str> = content.split_inclusive(' ').collect();
    for w in words {
        pieces.push(chunk(
            json!({"role": "assistant", "content": w}),
            Value::Null,
            None,
        ));
    }
    if let Some(tc) = &tool_calls {
        pieces.push(chunk(
            json!({"role": "assistant", "content": null, "tool_calls": tc}),
            Value::Null,
            None,
        ));
    }
    pieces.push(chunk(
        json!({"role": "assistant", "content": ""}),
        Value::String(finish.into()),
        Some(&usage),
    ));
    pieces.push("data: [DONE]\n\n".into());
    Respond {
        status: 200,
        headers: vec![
            ("content-type".into(), "text/event-stream".into()),
            ("cache-control".into(), "no-cache".into()),
        ],
        body: BodySpec::Chunks(pieces),
        chunk_delay_ms: 5,
        delay_ms: 0,
        fail: None,
    }
}

/// A deterministic unit vector for a text.
pub fn vector(text: &str, dims: usize) -> Vec<f64> {
    let mut state = fnv1a64(text.as_bytes()) | 1;
    let mut v: Vec<f64> = (0..dims)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let unit = (state >> 11) as f64 / (1u64 << 53) as f64;
            unit * 2.0 - 1.0
        })
        .collect();
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x = (*x / norm * 1e6).round() / 1e6;
        }
    }
    v
}

/// `args.dimensions` (or the request's `dimensions`).
fn openai_embeddings(req: &Req<'_>, args: &Value) -> Respond {
    let body = req.json.cloned().unwrap_or(Value::Null);
    let inputs: Vec<String> = match body.get("input") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string))
            .collect(),
        _ => {
            return json_answer(
                400,
                json!({"error": {"message": "input is required", "type": "invalid_request_error", "code": 400}}),
            );
        }
    };
    let dims = body
        .get("dimensions")
        .or_else(|| args.get("dimensions"))
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(1024)
        .clamp(1, 8192);
    let data: Vec<Value> = inputs
        .iter()
        .enumerate()
        .map(|(i, t)| json!({"object": "embedding", "index": i, "embedding": vector(t, dims)}))
        .collect();
    let tokens: i64 = inputs
        .iter()
        .map(|t| i64::try_from(t.chars().count() / 4).unwrap_or(1).max(1))
        .sum();
    json_answer(
        200,
        json!({"object": "list", "data": data, "model": body.get("model").cloned().unwrap_or(Value::Null),
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}),
    )
}

/// `args.text` (default "Rig mock answer.").
fn anthropic_messages(req: &Req<'_>, args: &Value) -> Respond {
    let body = req.json.cloned().unwrap_or(Value::Null);
    let model = body.get("model").cloned().unwrap_or(Value::Null);
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("Rig mock answer.");
    let id = format!("msg_{}", req.id.replace('-', ""));
    let input_tokens = rough_tokens(&body);
    let output_tokens = i64::try_from(text.chars().count() / 4).unwrap_or(1).max(1);
    let stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    if !stream {
        return json_answer(
            200,
            json!({"id": id, "type": "message", "role": "assistant", "model": model,
                "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": null,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}),
        );
    }
    let ev = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let pieces = vec![
        ev(
            "message_start",
            json!({"type": "message_start", "message": {"id": id, "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": input_tokens, "output_tokens": 1}}}),
        ),
        ev(
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        ev(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        ),
        ev(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        ev(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": output_tokens}}),
        ),
        ev("message_stop", json!({"type": "message_stop"})),
    ];
    Respond {
        status: 200,
        headers: vec![
            ("content-type".into(), "text/event-stream".into()),
            ("cache-control".into(), "no-cache".into()),
        ],
        body: BodySpec::Chunks(pieces),
        chunk_delay_ms: 5,
        delay_ms: 0,
        fail: None,
    }
}

// ---------------------------------------------------------------------------------------------
// S3.

fn s3_error(status: u16, code: &str, message: &str) -> Respond {
    Respond {
        status,
        headers: vec![("content-type".into(), "application/xml".into())],
        body: BodySpec::Text(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{code}</Code><Message>{message}</Message></Error>"
        )),
        chunk_delay_ms: 0,
        delay_ms: 0,
        fail: None,
    }
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `<bucket>/<key>` of a request: path style on the endpoint host itself, virtual-hosted on
/// `<bucket>.<endpoint>`.
fn s3_key(req: &Req<'_>, endpoint: &str) -> (String, String) {
    let path = crate::mock::percent_decode(req.path.trim_start_matches('/'));
    let virtual_bucket = req
        .host
        .strip_suffix(endpoint)
        .and_then(|b| b.strip_suffix('.'))
        .filter(|b| !b.is_empty());
    match virtual_bucket {
        Some(bucket) => (bucket.to_string(), path),
        None => match path.split_once('/') {
            Some((b, k)) => (b.to_string(), k.to_string()),
            None => (path, String::new()),
        },
    }
}

/// `args.endpoint`: the S3 endpoint host (`nyc3.digitaloceanspaces.com`).
fn s3(req: &Req<'_>, args: &Value, store: &mut BTreeMap<String, S3Object>) -> Option<Respond> {
    let endpoint = args
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("nyc3.digitaloceanspaces.com");
    let (bucket, key) = s3_key(req, endpoint);
    let full = format!("{bucket}/{key}");
    let etag = |b: &[u8]| format!("\"{}\"", dima_core::crypto::md5(b).hex());
    match (req.method, key.is_empty()) {
        ("PUT", false) => {
            let content_type = req
                .header("content-type")
                .unwrap_or_else(|| "binary/octet-stream".into());
            let tag = etag(req.body);
            store.insert(
                full,
                S3Object {
                    bytes: req.body.to_vec(),
                    content_type,
                },
            );
            let mut r = empty(200);
            r.headers.push(("etag".into(), tag));
            Some(r)
        }
        ("GET" | "HEAD", false) => Some(match store.get(&full) {
            Some(o) => {
                let mut r = bytes_answer(
                    200,
                    &o.content_type,
                    if req.method == "HEAD" {
                        Vec::new()
                    } else {
                        o.bytes.clone()
                    },
                );
                r.headers.push(("etag".into(), etag(&o.bytes)));
                if req.method == "HEAD" {
                    r.headers
                        .push(("content-length".into(), o.bytes.len().to_string()));
                    r.body = BodySpec::Empty;
                }
                r
            }
            None => s3_error(404, "NoSuchKey", "The specified key does not exist."),
        }),
        ("DELETE", false) => {
            store.remove(&full);
            Some(empty(204))
        }
        ("POST", true) if req.query.iter().any(|(k, _)| k == "delete") => {
            let text = String::from_utf8_lossy(req.body);
            let mut deleted = String::new();
            for part in text.split("<Key>").skip(1) {
                let Some((k, _)) = part.split_once("</Key>") else {
                    continue;
                };
                let k = xml_unescape(k);
                store.remove(&format!("{bucket}/{k}"));
                deleted.push_str(&format!("<Deleted><Key>{}</Key></Deleted>", xml_escape(&k)));
            }
            Some(Respond {
                status: 200,
                headers: vec![("content-type".into(), "application/xml".into())],
                body: BodySpec::Text(format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{deleted}</DeleteResult>"
                )),
                chunk_delay_ms: 0,
                delay_ms: 0,
                fail: None,
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Audio.

/// 0.1 s of silence: 16-bit mono PCM at 22050 Hz.
fn wav() -> Vec<u8> {
    let samples: u32 = 2205;
    let data_len = samples * 2;
    let mut b = Vec::with_capacity(44 + 4410);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&22_050u32.to_le_bytes());
    b.extend_from_slice(&44_100u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    b.resize(b.len() + 4410, 0);
    b
}

/// One silent MPEG-1 Layer III frame (128 kbit/s, 44.1 kHz) after an empty ID3 header.
fn mp3() -> Vec<u8> {
    let mut b = vec![b'I', b'D', b'3', 4, 0, 0, 0, 0, 0, 0];
    b.extend_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
    b.resize(b.len() + 413, 0);
    b
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn req<'a>(
        method: &'a str,
        path: &'a str,
        query: &'a [(String, String)],
        headers: &'a [(String, Vec<u8>)],
        json: Option<&'a Value>,
    ) -> Req<'a> {
        Req {
            host: "api.twitch.tv",
            method,
            path,
            query,
            headers,
            body: b"",
            json,
            now_ms: 1_794_400_000_000,
            id: "00000000-0000-4000-8000-000000000001",
        }
    }

    fn auth(token: &str) -> Vec<(String, Vec<u8>)> {
        vec![
            (
                "authorization".into(),
                format!("Bearer {token}").into_bytes(),
            ),
            ("client-id".into(), b"cid".to_vec()),
        ]
    }

    fn seed() -> TwitchState {
        let s: TwitchSeed = serde_json::from_value(json!({
            "users": [{"id": "1001", "login": "rigstreamer", "display_name": "RigStreamer"}],
            "tokens": [{"token": "tok1", "user_id": "1001", "scopes": ["chat:read"], "refresh_token": "ref1"}],
            "page_size": 2
        }))
        .unwrap();
        TwitchState::from_seed(&s, 0)
    }

    fn body(r: &Respond) -> Value {
        match &r.body {
            BodySpec::Json(v) => v.clone(),
            other => panic!("not JSON: {other:?}"),
        }
    }

    #[test]
    fn tokens_validate_and_refresh() {
        let mut tw = seed();
        let h = auth("tok1");
        let v = oauth_validate(&req("GET", "/oauth2/validate", &[], &h, None), &tw);
        assert_eq!(v.status, 200);
        assert_eq!(body(&v)["login"], "rigstreamer");
        let bad = oauth_validate(&req("GET", "/", &[], &auth("nope"), None), &tw);
        assert_eq!(bad.status, 401);
        let form = json!({"grant_type": "refresh_token", "refresh_token": "ref1"});
        let r = oauth_token(
            &req("POST", "/oauth2/token", &[], &[], Some(&form)),
            &mut tw,
        );
        let new_token = body(&r)["access_token"].as_str().unwrap().to_string();
        assert_ne!(new_token, "tok1");
        assert_eq!(
            oauth_validate(&req("GET", "/", &[], &auth("tok1"), None), &tw).status,
            401,
            "the old token is gone after a refresh"
        );
        assert_eq!(
            oauth_validate(&req("GET", "/", &[], &auth(&new_token), None), &tw).status,
            200
        );
        let q = vec![("grant_type".to_string(), "client_credentials".to_string())];
        let app = oauth_token(&req("POST", "/oauth2/token", &q, &[], None), &mut tw);
        let app_token = body(&app)["access_token"].as_str().unwrap().to_string();
        let again = oauth_token(&req("POST", "/oauth2/token", &q, &[], None), &mut tw);
        assert_eq!(body(&again)["access_token"], app_token.as_str(), "stable");
        let users = twitch_users(
            &req(
                "GET",
                "/helix/users",
                &[("login".into(), "RigStreamer".into())],
                &auth(&app_token),
                None,
            ),
            &tw,
        );
        assert_eq!(body(&users)["data"][0]["id"], "1001");
        assert!(body(&users)["data"][0].get("channel").is_none());
    }

    #[test]
    fn eventsub_is_stateful_and_paginated() {
        let mut tw = seed();
        let h = auth("tok1");
        for user in ["1", "2", "3"] {
            let b = json!({"type": "channel.follow", "version": "2", "condition": {"broadcaster_user_id": user},
                "transport": {"method": "webhook", "callback": "https://x/eventsub", "secret": "s"}});
            let r = eventsub_create(&req("POST", "/", &[], &h, Some(&b)), &mut tw);
            assert_eq!(r.status, 202);
            assert!(body(&r)["data"][0]["transport"].get("secret").is_none());
        }
        let dup = json!({"type": "channel.follow", "version": "2", "condition": {"broadcaster_user_id": "1"}, "transport": {"method": "webhook"}});
        assert_eq!(
            eventsub_create(&req("POST", "/", &[], &h, Some(&dup)), &mut tw).status,
            409
        );
        let p1 = body(&eventsub_list(&req("GET", "/", &[], &h, None), &tw));
        assert_eq!(p1["data"].as_array().unwrap().len(), 2);
        let cursor = p1["pagination"]["cursor"].as_str().unwrap().to_string();
        let q = vec![("after".to_string(), cursor)];
        let p2 = body(&eventsub_list(&req("GET", "/", &q, &h, None), &tw));
        assert_eq!(p2["data"].as_array().unwrap().len(), 1);
        assert_eq!(p2["pagination"], json!({}));
        let id = p2["data"][0]["id"].as_str().unwrap().to_string();
        let q = vec![("id".to_string(), id)];
        assert_eq!(
            eventsub_delete(&req("DELETE", "/", &q, &h, None), &mut tw).status,
            204
        );
        assert_eq!(
            eventsub_delete(&req("DELETE", "/", &q, &h, None), &mut tw).status,
            404
        );
        assert_eq!(
            body(&eventsub_list(&req("GET", "/", &[], &h, None), &tw))["total"],
            2
        );
    }

    #[test]
    fn embeddings_are_deterministic_unit_vectors() {
        let a = vector("hola 👋", 1024);
        assert_eq!(a, vector("hola 👋", 1024));
        assert_ne!(a, vector("hola", 1024));
        let norm: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "{norm}");
        let u = uuid_from(b"x");
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes().get(14), Some(&b'4'));
    }

    #[test]
    fn s3_store() {
        let mut store = BTreeMap::new();
        let mut put = req("PUT", "/rig-media/a/b.png", &[], &[], None);
        put.host = "nyc3.digitaloceanspaces.com";
        put.body = b"png";
        assert_eq!(s3(&put, &Value::Null, &mut store).unwrap().status, 200);
        let mut get = req("GET", "/a/b.png", &[], &[], None);
        get.host = "rig-media.nyc3.digitaloceanspaces.com";
        let r = s3(&get, &Value::Null, &mut store).unwrap();
        assert!(matches!(&r.body, BodySpec::Bytes(b) if b == b"png"));
        let q = vec![("delete".to_string(), String::new())];
        let mut del = req("POST", "/rig-media", &q, &[], None);
        del.host = "nyc3.digitaloceanspaces.com";
        del.body = b"<Delete><Object><Key>a/b.png</Key></Object></Delete>";
        assert_eq!(s3(&del, &Value::Null, &mut store).unwrap().status, 200);
        assert!(store.is_empty());
        assert_eq!(s3(&get, &Value::Null, &mut store).unwrap().status, 404);
    }
}
