//! Local accounts and cookie sessions (`auth.mjs`, the cookie helpers of `http-util.mjs`).
//!
//! - Users: `{id (uuid), username, passwordHash, role, createdAt}`; usernames are lowercased
//!   and must match `^[a-z0-9._-]{2,32}$`; passwords need 8 UTF-16 code units (the reference's
//!   `.length`, kept so no password valid today becomes invalid).
//! - Sessions: `{id (uuid), userId, createdAt, expiresAt}`, 14 days, never renewed. Expired rows
//!   are pruned (and the file rewritten) whenever a session is looked up or created.
//! - Cookie `dimadb_session=<id>; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600`, plus
//!   `Secure` when the first `X-Forwarded-Proto` value is `https`.
//!
//! Session ids are compared in constant time.

use dima_core::Clock;
use serde_json::{Map, Value, json};

use crate::error::{ApiError, ApiResult};
use crate::js;
use crate::store::{List, Store, password_bytes};

/// 14 days.
pub const SESSION_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// The cookie name.
pub const COOKIE: &str = "dimadb_session";

/// `publicUser(user)`: `{id, username, role}`; absent fields stay absent.
pub fn public_user(user: &Value) -> Value {
    let mut out = Map::new();
    for field in ["id", "username", "role"] {
        if let Some(value) = user.get(field) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `parseCookieHeader(req)`: `name=value` pairs split on `;`, the value
/// `decodeURIComponent`'d (a malformed escape throws `URIError`, a 500), later names win.
pub fn parse_cookies(header: Option<&str>) -> ApiResult<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for part in header.unwrap_or_default().split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = dima_text::trim(name).to_owned();
        let value = js::decode_uri_component(dima_text::trim(value))
            .ok_or_else(|| ApiError::internal("URI malformed"))?;
        match out.iter_mut().find(|(existing, _)| *existing == name) {
            Some(entry) => entry.1 = value,
            None => out.push((name, value)),
        }
    }
    Ok(out)
}

/// The session id from the cookie header, when set and not empty.
pub fn session_id(cookie_header: Option<&str>) -> ApiResult<Option<String>> {
    Ok(parse_cookies(cookie_header)?
        .into_iter()
        .find(|(name, _)| name == COOKIE)
        .map(|(_, value)| value)
        .filter(|value| !value.is_empty()))
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    dima_text::encode_uri_component(text).into_owned()
}

/// `sessionCookie(id, secure)`.
pub fn session_cookie(id: &str, secure: bool) -> String {
    let mut parts = vec![
        format!("{COOKIE}={}", encode_uri_component(id)),
        "Path=/".to_owned(),
        "HttpOnly".to_owned(),
        "SameSite=Strict".to_owned(),
        "Max-Age=1209600".to_owned(),
    ];
    if secure {
        parts.push("Secure".to_owned());
    }
    parts.join("; ")
}

/// `clearSessionCookie(secure)`.
pub fn clear_session_cookie(secure: bool) -> String {
    let mut text = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    if secure {
        text.push_str("; Secure");
    }
    text
}

/// `isSecureRequest(req)`: the first `X-Forwarded-Proto` value is `https`.
pub fn is_secure(forwarded_proto: Option<&str>) -> bool {
    dima_text::trim(
        forwarded_proto
            .unwrap_or_default()
            .split(',')
            .next()
            .unwrap_or_default(),
    ) == "https"
}

/// JavaScript `a === b` for JSON values (objects and arrays are never equal).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// Constant-time `row.id === id` for session ids.
fn id_matches(row: &Value, id: &str) -> bool {
    match row.get("id") {
        Some(Value::String(text)) => {
            dima_core::crypto::constant_time_eq(text.as_bytes(), id.as_bytes())
        }
        _ => false,
    }
}

/// Accounts and sessions over the store.
#[derive(Debug)]
pub struct Auth<'a> {
    store: &'a Store,
    clock: &'a dyn Clock,
}

impl<'a> Auth<'a> {
    /// Accounts and sessions.
    pub fn new(store: &'a Store, clock: &'a dyn Clock) -> Self {
        Self { store, clock }
    }

    /// `needsSetup()`: no users.
    pub async fn needs_setup(&self) -> bool {
        self.store.read(List::Users).await.is_empty()
    }

    /// `pruneSessions()`: drops rows whose `expiresAt` is not after now, rewriting the file when
    /// any were dropped. Call with the store lock held.
    async fn prune_sessions(&self) -> ApiResult<Vec<Value>> {
        let now = self.clock.now_ms();
        let rows = self.store.read(List::Sessions).await;
        let total = rows.len();
        let next: Vec<Value> = rows
            .into_iter()
            .filter(|row| {
                let expires = row.get("expiresAt").map(dima_text::string_of);
                expires
                    .as_deref()
                    .and_then(dima_text::parse_date)
                    .is_some_and(|at| at > now)
            })
            .collect();
        // The reference compares with a second read of the file.
        if next.len() != self.store.read(List::Sessions).await.len() || next.len() != total {
            self.store.write(List::Sessions, &next).await?;
        }
        Ok(next)
    }

    /// `currentUser(req)`.
    pub async fn current_user(&self, cookie_header: Option<&str>) -> ApiResult<Option<Value>> {
        let Some(session_id) = session_id(cookie_header)? else {
            return Ok(None);
        };
        let session = {
            let _guard = self.store.lock().await;
            let sessions = self.prune_sessions().await?;
            let mut found = None;
            for row in sessions {
                if id_matches(&row, &session_id) && found.is_none() {
                    found = Some(row);
                }
            }
            found
        };
        let Some(session) = session else {
            return Ok(None);
        };
        let user_id = session.get("userId").cloned();
        Ok(self.store.read(List::Users).await.into_iter().find(|row| {
            match (row.get("id"), user_id.as_ref()) {
                (Some(a), Some(b)) => strict_eq(a, b),
                _ => false,
            }
        }))
    }

    /// `createUser({username, password, role})`.
    pub async fn create_user(
        &self,
        username: Option<&Value>,
        password: Option<&Value>,
        role: &str,
    ) -> ApiResult<Value> {
        let name = dima_text::to_lower(dima_text::trim(&js::string_or_empty(username)));
        if !valid_username(&name) {
            return Err(ApiError::bad_request(
                "Username must be 2-32 letters, numbers, or ._-",
            ));
        }
        if dima_text::utf16_len(&js::string_or_empty(password)) < 8 {
            return Err(ApiError::bad_request(
                "Password must be at least 8 characters",
            ));
        }
        if self.username_taken(&name).await {
            return Err(ApiError::conflict("Username already exists"));
        }
        let hash = self.store.hash_password(password_bytes(password)?).await?;
        let _guard = self.store.lock().await;
        // Checked again under the lock: the hash ran without it.
        if self.username_taken(&name).await {
            return Err(ApiError::conflict("Username already exists"));
        }
        let id = self
            .store
            .random()
            .uuid_v4()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let user = json!({
            "id": id,
            "username": name,
            "passwordHash": hash,
            "role": role,
            "createdAt": self.iso(0)?,
        });
        let mut users = self.store.read(List::Users).await;
        users.push(user.clone());
        self.store.write(List::Users, &users).await?;
        Ok(user)
    }

    async fn username_taken(&self, name: &str) -> bool {
        self.store
            .read(List::Users)
            .await
            .iter()
            .any(|row| row.get("username").and_then(Value::as_str) == Some(name))
    }

    /// `findUserByName(username)`.
    async fn find_user_by_name(&self, username: Option<&Value>) -> Option<Value> {
        let name = dima_text::to_lower(dima_text::trim(&js::string_or_empty(username)));
        self.store
            .read(List::Users)
            .await
            .into_iter()
            .find(|row| row.get("username").and_then(Value::as_str) == Some(name.as_str()))
    }

    /// `login(username, password)`: the user and a new session id.
    pub async fn login(
        &self,
        username: Option<&Value>,
        password: Option<&Value>,
    ) -> ApiResult<(Value, String)> {
        let invalid = || ApiError::new(401, "Invalid username or password");
        let user = self.find_user_by_name(username).await.ok_or_else(invalid)?;
        let stored = user
            .get("passwordHash")
            .map(dima_text::string_of)
            .unwrap_or_default();
        // `String(stored || '').split(':')`: a malformed hash is a mismatch before scrypt runs.
        let well_formed = {
            let mut parts = stored.split(':');
            parts.next() == Some("scrypt")
                && parts.next().is_some_and(|s| !s.is_empty())
                && parts.next().is_some_and(|h| !h.is_empty())
        };
        if !well_formed
            || !self
                .store
                .verify_password(password_bytes(password)?, &stored)
                .await?
        {
            return Err(invalid());
        }
        let session = self.open_session(&user).await?;
        Ok((user, session))
    }

    /// The session half of `login`, for a user that was just created (setup).
    pub async fn open_session(&self, user: &Value) -> ApiResult<String> {
        let id = self
            .store
            .random()
            .uuid_v4()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let session = json!({
            "id": id,
            "userId": user.get("id").cloned().unwrap_or(Value::Null),
            "createdAt": self.iso(0)?,
            "expiresAt": self.iso(SESSION_MS)?,
        });
        if user.get("id").is_none() {
            // `userId: undefined` is dropped by JSON.stringify.
            if let Some(map) = session.as_object() {
                let mut map = map.clone();
                map.remove("userId");
                return self.save_session(Value::Object(map), id).await;
            }
        }
        self.save_session(session, id).await
    }

    async fn save_session(&self, session: Value, id: String) -> ApiResult<String> {
        let _guard = self.store.lock().await;
        let mut sessions = self.prune_sessions().await?;
        sessions.push(session);
        self.store.write(List::Sessions, &sessions).await?;
        Ok(id)
    }

    /// `logout(req)`: removes the cookie's session; rewrites the file whenever a cookie was sent.
    pub async fn logout(&self, cookie_header: Option<&str>) -> ApiResult<()> {
        let Some(session_id) = session_id(cookie_header)? else {
            return Ok(());
        };
        let _guard = self.store.lock().await;
        let rows: Vec<Value> = self
            .store
            .read(List::Sessions)
            .await
            .into_iter()
            .filter(|row| !id_matches(row, &session_id))
            .collect();
        self.store.write(List::Sessions, &rows).await
    }

    fn iso(&self, offset_ms: i64) -> ApiResult<String> {
        dima_text::to_iso_string(self.clock.now_ms().saturating_add(offset_ms))
            .ok_or_else(|| ApiError::internal("Invalid time value"))
    }
}

fn valid_username(name: &str) -> bool {
    let len = name.chars().count();
    (2..=32).contains(&len)
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_encoding_contract() {
        for text in ["", "!*'()~", "a /?%+", "café 😀 مرحبا e\u{301}", "\0"] {
            assert_eq!(
                encode_uri_component(text),
                dima_text::encode_uri_component(text)
            );
        }
    }

    #[test]
    fn cookies_parse_like_the_reference() -> Result<(), ApiError> {
        let cookies = parse_cookies(Some("a=1; dimadb_session=abc%20d; junk; a=2; =x"))?;
        assert_eq!(
            cookies,
            [
                ("a".to_owned(), "2".to_owned()),
                ("dimadb_session".to_owned(), "abc d".to_owned()),
                (String::new(), "x".to_owned()),
            ]
        );
        assert_eq!(
            parse_cookies(Some("dimadb_session=%zz"))
                .err()
                .map(|e| e.status),
            Some(500)
        );
        assert_eq!(session_id(Some("dimadb_session="))?, None);
        assert_eq!(session_id(None)?, None);
        // A whole Set-Cookie value sent back as the Cookie header still yields the id.
        assert_eq!(
            session_id(Some(&session_cookie("4f0e", true)))?.as_deref(),
            Some("4f0e")
        );
        Ok(())
    }

    #[test]
    fn cookie_text() {
        assert_eq!(
            session_cookie("id-1", false),
            "dimadb_session=id-1; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600"
        );
        assert_eq!(
            clear_session_cookie(true),
            "dimadb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"
        );
        assert!(is_secure(Some(" https , http")));
        assert!(!is_secure(Some("http, https")));
        assert!(!is_secure(None));
        assert_eq!(encode_uri_component("a b/ü!*"), "a%20b%2F%C3%BC!*");
    }

    #[test]
    fn usernames() {
        assert!(valid_username("ab"));
        assert!(valid_username("a.b_c-9"));
        assert!(!valid_username("a"));
        assert!(!valid_username("ünï"));
        assert!(!valid_username(&"a".repeat(33)));
        assert_eq!(
            public_user(&json!({"id": "1", "role": "admin", "passwordHash": "x"})),
            json!({"id": "1", "role": "admin"})
        );
    }
}
