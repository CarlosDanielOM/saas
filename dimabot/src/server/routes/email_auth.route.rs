//! Public email activation redirect. Construction performs no I/O.
use std::{future::Future, pin::Pin, sync::Arc};
use axum::{extract::{RawQuery, State}, http::{header, HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use mongodb::{bson::{doc, oid::ObjectId, Bson, Document}, Database};
use crate::utils::{jwt::ActivationTokenService, logger::{Destination, Level, LogOptions, Logger}};

pub const INVALID: &str = "https://domdimabot.com/login?error=invalid_activation_link";
pub const ACTIVE: &str = "https://domdimabot.com/login?emailAction=alreadyActivated";
pub type LookupFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<Document>, ()>> + Send + 'a>>;
pub trait ActivationUsers: Send + Sync { fn find<'a>(&'a self, id: &'a str) -> LookupFuture<'a>; }
#[derive(Clone)]
pub struct MongoActivationUsers { database: Database }
impl MongoActivationUsers { pub fn new(database: Database) -> Self { Self { database } } }
impl ActivationUsers for MongoActivationUsers {
    fn find<'a>(&'a self, id: &'a str) -> LookupFuture<'a> {
        Box::pin(async move {
            let id = ObjectId::parse_str(id).map_err(|_| ())?;
            crate::schemas::users::schema().native_collection(&self.database).find_one(doc! {"_id": id}).await.map_err(|_| ())
        })
    }
}
#[derive(Clone)]
pub struct EmailAuthRoute { tokens: ActivationTokenService, users: Arc<dyn ActivationUsers>, logger: Logger }
impl EmailAuthRoute {
    pub fn new(database: Database, tokens: ActivationTokenService, logger: Logger) -> Self { Self::with_users(tokens, Arc::new(MongoActivationUsers::new(database)), logger) }
    pub fn with_users(tokens: ActivationTokenService, users: Arc<dyn ActivationUsers>, logger: Logger) -> Self { Self { tokens, users, logger } }
    /// Nest at `/email`; this router must remain outside authentication middleware.
    pub fn router(&self) -> Router { Router::new().route("/auth", get(activate)).with_state(self.clone()) }
    async fn failure(&self) -> String {
        // Driver errors and user IDs can contain credentials or attacker-controlled data.
        let _ = self.logger.log(Level::Error, serde_json::json!({"message":"[EMAIL-AUTH] Error processing activation token:", "error":"activation lookup or account processing failed"}), LogOptions { destination: Destination::Console, ..Default::default() }).await;
        INVALID.into()
    }
    pub async fn location(&self, query: Option<&str>, host: Option<&str>) -> String {
        let Some(token) = token_query(query) else { return INVALID.into() };
        let Some(verified) = self.tokens.verify(&token) else { return INVALID.into() };
        let user = match self.users.find(&verified.user_id).await { Ok(Some(user)) => user, Ok(None) => return INVALID.into(), Err(()) => return self.failure().await };
        let accounts = match user.get("accounts") { None | Some(Bson::Null | Bson::Undefined) => return INVALID.into(), Some(Bson::Array(accounts)) => accounts, Some(_) => return self.failure().await };
        let mut twitch = None;
        for item in accounts { match item { Bson::Null | Bson::Undefined => return self.failure().await, Bson::Document(account) if account.get_str("type").ok() == Some("twitch") => { twitch = Some(account); break }, _ => {} } }
        let Some(account) = twitch else { return INVALID.into() };
        if account.get("actived").is_some_and(js_truthy) { return ACTIVE.into() }
        let name = match account.get("name").filter(|name| js_truthy(name)) { Some(value) => match js_string(value) { Some(name) => name, None => return self.failure().await }, None => verified.login };
        let host = host.filter(|host| !host.is_empty()).unwrap_or("api.domdimabot.com");
        let protocol = if host.contains("localhost") { "http" } else { "https" };
        encode_url(&format!("{protocol}://{host}/auth/authorize?state={}&action=activate", form_encode(&name)))
    }
}
fn js_truthy(value: &Bson) -> bool { match value { Bson::Null | Bson::Undefined => false, Bson::Boolean(v) => *v, Bson::Int32(v) => *v != 0, Bson::Int64(v) => *v != 0, Bson::Double(v) => *v != 0.0 && !v.is_nan(), Bson::String(v) => !v.is_empty(), _ => true } }
// Values are the Mongo driver's lean BSON objects, not JSON.stringify projections.
fn js_string(value: &Bson) -> Option<String> {
    Some(match value {
        Bson::String(v) | Bson::Symbol(v) => v.clone(), Bson::Boolean(v) => v.to_string(),
        Bson::Int32(v) => crate::utils::json_number::number_string(f64::from(*v)),
        Bson::Int64(v) => crate::utils::json_number::number_string(*v as f64),
        Bson::Double(v) => crate::utils::json_number::number_string(*v),
        Bson::ObjectId(v) => v.to_hex(), Bson::Null => "null".into(), Bson::Undefined => "undefined".into(),
        Bson::Array(items) => { let mut parts = Vec::new(); for item in items { parts.push(if matches!(item, Bson::Null | Bson::Undefined) { String::new() } else { js_string(item)? }); } parts.join(",") },
        Bson::Document(doc) if doc.contains_key("toString") => return None,
        Bson::Document(_) => "[object Object]".into(),
        // BSON-specific object toString behavior is an explicit remaining dependency.
        _ => return None,
    })
}
fn decode(s: &str) -> String {
    let mut out = Vec::new(); let b = s.as_bytes(); let mut i = 0;
    while i < b.len() { if b[i] == b'+' { out.push(b' '); i += 1; } else if b[i] == b'%' && i + 2 < b.len() {
        if let (Some(a), Some(c)) = ((b[i+1] as char).to_digit(16), (b[i+2] as char).to_digit(16)) { out.push((a * 16 + c) as u8); i += 3; } else { out.push(b[i]); i += 1; }
    } else { out.push(b[i]); i += 1; } }
    String::from_utf8_lossy(&out).into_owned()
}
fn token_query(query: Option<&str>) -> Option<String> {
    let mut found = None; for pair in query?.split('&').take(1000) { let (key, value) = pair.split_once('=').unwrap_or((pair, "")); if decode(key) == "token" { if found.is_some() { return None } found = Some(decode(value)); } } found.filter(|s| !s.is_empty())
}
fn form_encode(s: &str) -> String { let mut out = String::new(); for b in s.bytes() { match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char), b' ' => out.push('+'), _ => out.push_str(&format!("%{b:02X}")) } } out }
// encodeurl's safe ASCII set; a final lone `%` is escaped and `%A` is preserved.
fn encode_url(s: &str) -> String {
    let bytes = s.as_bytes(); let mut out = String::new();
    for (i, &b) in bytes.iter().enumerate() {
        let valid_percent = b == b'%' && i + 1 < bytes.len() && bytes[i+1].is_ascii_hexdigit() && (i + 2 == bytes.len() || bytes[i+2].is_ascii_hexdigit());
        let safe = matches!(b, 0x21 | 0x23..=0x3b | 0x3d | 0x3f..=0x5f | 0x61..=0x7a | 0x7c | 0x7e) && (b != b'%' || valid_percent);
        if safe { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    } out
}
#[derive(Clone, Copy)]
struct Priority { q: f64, specificity: u8, order: usize, provided: usize }
fn split_quoted(input: &str, delimiter: char) -> Vec<&str> {
    let mut result = Vec::new(); let mut start = 0; let mut quoted = false;
    for (index, ch) in input.char_indices() { if ch == '"' { quoted = !quoted } else if ch == delimiter && !quoted { result.push(&input[start..index]); start = index + ch.len_utf8(); } }
    result.push(&input[start..]); result
}
fn parse_float_prefix(s: &str) -> f64 {
    let s = s.trim_start(); for end in (1..=s.len()).rev() { if s.is_char_boundary(end) { if let Ok(v) = s[..end].parse::<f64>() { return v } } } f64::NAN
}
fn negotiate(accept: Option<&str>) -> Option<&'static str> {
    let accept = accept.filter(|s| !s.is_empty()).unwrap_or("*/*"); let mut best: [Option<Priority>; 2] = [None, None];
    for (order, raw) in split_quoted(accept, ',').into_iter().enumerate() {
        let mut parts = split_quoted(raw.trim(), ';').into_iter(); let Some(media) = parts.next() else { continue }; let Some((ty, sub)) = media.trim().split_once('/') else { continue };
        if ty.is_empty() || sub.is_empty() || ty.chars().any(char::is_whitespace) || sub.chars().any(char::is_whitespace) { continue }
        let mut q = 1.0; let mut params = Vec::new();
        for part in parts { let (key, val) = part.trim().split_once('=').unwrap_or((part.trim(), "")); let val = val.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(val); if key.eq_ignore_ascii_case("q") { q = parse_float_prefix(val); break } params.push(val); }
        for (provided, subtype) in ["plain", "html"].into_iter().enumerate() {
            if !ty.eq_ignore_ascii_case("text") && ty != "*" { continue } if !sub.eq_ignore_ascii_case(subtype) && sub != "*" { continue }
            if params.iter().any(|value| !value.is_empty() && *value != "*") { continue }
            let specificity = (if ty.eq_ignore_ascii_case("text") {4} else {0}) | (if sub.eq_ignore_ascii_case(subtype) {2} else {0}) | (if params.is_empty() {0} else {1});
            let p = Priority { q, specificity, order, provided };
            if best[provided].is_none_or(|old| specificity > old.specificity || (specificity == old.specificity && (q > old.q || ((q == old.q || q.is_nan() || old.q.is_nan()) && order > old.order)))) { best[provided] = Some(p); }
        }
    }
    let mut choices: Vec<_> = best.into_iter().flatten().filter(|p| p.q > 0.0).collect();
    choices.sort_by(|a,b| b.q.total_cmp(&a.q).then(b.specificity.cmp(&a.specificity)).then(a.order.cmp(&b.order)).then(a.provided.cmp(&b.provided)));
    choices.first().map(|p| if p.provided == 0 { "text/plain; charset=utf-8" } else { "text/html; charset=utf-8" })
}
async fn activate(State(service): State<EmailAuthRoute>, RawQuery(query): RawQuery, headers: HeaderMap) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()); let location = service.location(query.as_deref(), host).await;
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()); let content_type = negotiate(accept);
    let body = match content_type { Some("text/plain; charset=utf-8") => format!("Found. Redirecting to {location}"), Some(_) => { let escaped = location.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;"); format!("<p>Found. Redirecting to {escaped}</p>") }, None => String::new() };
    let mut response = (StatusCode::FOUND, body.clone()).into_response();
    if let Ok(value) = location.parse() { response.headers_mut().insert(header::LOCATION, value); }
    response.headers_mut().insert(header::VARY, "Accept".parse().unwrap());
    response.headers_mut().insert(header::CONTENT_LENGTH, body.len().to_string().parse().unwrap());
    if let Some(value) = content_type { response.headers_mut().insert(header::CONTENT_TYPE, value.parse().unwrap()); } else { response.headers_mut().remove(header::CONTENT_TYPE); }
    response
}
