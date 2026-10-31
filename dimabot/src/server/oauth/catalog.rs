//! Pure OAuth catalogue, matching `dimabot/src/server/oauth/catalog.ts` and the
//! pure helpers in `service.ts` (`secret`, `hash`, Redis key names, issuer).
//!
//! This module opens no socket and constructs no client. [`oauth_issuer`] and
//! [`oauth_website`] read `PUBLIC_API_URL` and `DASHBOARD_URL` only when called,
//! and a bad value becomes [`ConfigError`] without echoing the raw text.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;

/// Scope catalogue in source insertion order. `key` is the unused stable alias
/// from `OAUTH_SCOPES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScopeDefinition {
    pub name: &'static str,
    pub active: bool,
    pub key: &'static str,
}

pub const OAUTH_SCOPES: &[ScopeDefinition] = &[
    ScopeDefinition { name: "profile:read", active: true, key: "profile" },
    ScopeDefinition { name: "credits:read", active: true, key: "credits" },
    ScopeDefinition { name: "desktop:connect", active: true, key: "connect" },
    ScopeDefinition { name: "usage:read", active: false, key: "usage" },
    ScopeDefinition { name: "pet:read", active: true, key: "petRead" },
    ScopeDefinition { name: "pet:write", active: false, key: "petWrite" },
    ScopeDefinition { name: "pet:receive", active: true, key: "petReceive" },
    ScopeDefinition { name: "pet:interact", active: false, key: "petInteract" },
    ScopeDefinition { name: "pet:control", active: true, key: "petControl" },
    ScopeDefinition { name: "pet:playback:select", active: true, key: "petSelect" },
];

pub const ACCESS_TTL_SECONDS: u64 = 600;
pub const REQUEST_TTL_SECONDS: u64 = 600;
pub const CODE_TTL_SECONDS: u64 = 60;
/// `30 * 24 * 60 * 60 * 1000`.
pub const REFRESH_IDLE_MS: i64 = 2_592_000_000;
/// `90 * 24 * 60 * 60 * 1000`.
pub const SESSION_ABSOLUTE_MS: i64 = 7_776_000_000;
pub const DESKTOP_CLIENT_ID: &str = "dima-desktop";
pub const DESKTOP_CLIENT_NAME: &str = "Dima Desktop Beta";
pub const DESKTOP_CLIENT_TYPE: &str = "public";
pub const DEFAULT_DEVICE_NAME: &str = "Desktop computer";
pub const DEVICE_NAME_MAX_CHARS: usize = 80;
pub const SCOPE_MAX_CHARS: usize = 500;
pub const REDIRECT_MAX_CHARS: usize = 300;
pub const CLIENT_ID_MAX_CHARS: usize = 100;
pub const REVOKE_TOKEN_MAX_CHARS: usize = 100;
/// Express `json` / `urlencoded` default limit (100 KiB).
pub const BODY_LIMIT_BYTES: usize = 100 * 1024;
pub const TWITCH_VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
pub const TWITCH_VALIDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(5_000);
pub const DEFAULT_PUBLIC_API_URL: &str = "https://api.domdimabot.com";
pub const DEFAULT_DASHBOARD_URL: &str = "https://domdimabot.com";
pub const PUBLIC_RATE_LIMIT: i64 = 600;
pub const DESKTOP_RATE_LIMIT: i64 = 1_200;
pub const APPROVAL_RATE_LIMIT: i64 = 30;
pub const PUBLIC_MOUNT: &str = "/oauth";
pub const DESKTOP_MOUNT: &str = "/v1";

pub const DESKTOP_REDIRECT_URIS: [&str; 2] = [
    "http://127.0.0.1/oauth/callback",
    "http://[::1]/oauth/callback",
];

/// `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`
pub const RATE_LIMIT_LUA: &str =
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";

pub const WWW_AUTHENTICATE_INVALID_TOKEN: &str = "Bearer error=\"invalid_token\"";
pub const RETRY_AFTER_SLOW_DOWN: &str = "60";
pub const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";

pub const SECURITY_CACHE_CONTROL: &str = "no-store";
pub const SECURITY_PRAGMA: &str = "no-cache";
pub const SECURITY_REFERRER_POLICY: &str = "no-referrer";
pub const SECURITY_CONTENT_TYPE_OPTIONS: &str = "nosniff";
pub const CORS_ALLOW_HEADERS: &str = "Authorization, Content-Type";
pub const CORS_ALLOW_METHODS: &str = "GET, PUT, POST, DELETE, OPTIONS";

pub fn active_scopes() -> Vec<&'static str> {
    OAUTH_SCOPES.iter().filter(|scope| scope.active).map(|scope| scope.name).collect()
}

pub fn inactive_scopes() -> Vec<&'static str> {
    OAUTH_SCOPES.iter().filter(|scope| !scope.active).map(|scope| scope.name).collect()
}

/// Known OAuth protocol failure. `code()` is the JSON `error` value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OAuthError {
    InvalidRequest,
    InvalidClient,
    InvalidGrant,
    InvalidScope,
    InvalidToken,
    LoginRequired,
    AccessDenied,
    AccountRequired,
    InsufficientScope,
    SlowDown,
    NotFound,
    UnsupportedGrantType,
    /// A converted `PetSettingsError` (or another known code) keeps its own
    /// code and status. The code is a short token, never a payload.
    Custom { code: String, status: u16 },
}

impl OAuthError {
    pub fn custom(code: impl Into<String>, status: u16) -> Self {
        Self::Custom { code: code.into(), status }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidClient => "invalid_client",
            Self::InvalidGrant => "invalid_grant",
            Self::InvalidScope => "invalid_scope",
            Self::InvalidToken => "invalid_token",
            Self::LoginRequired => "login_required",
            Self::AccessDenied => "access_denied",
            Self::AccountRequired => "account_required",
            Self::InsufficientScope => "insufficient_scope",
            Self::SlowDown => "slow_down",
            Self::NotFound => "not_found",
            Self::UnsupportedGrantType => "unsupported_grant_type",
            Self::Custom { code, .. } => code.as_str(),
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidToken | Self::LoginRequired => 401,
            Self::AccessDenied | Self::AccountRequired | Self::InsufficientScope => 403,
            Self::SlowDown => 429,
            Self::NotFound => 404,
            Self::Custom { status, .. } => *status,
            Self::InvalidRequest
            | Self::InvalidClient
            | Self::InvalidGrant
            | Self::InvalidScope
            | Self::UnsupportedGrantType => 400,
        }
    }
}

impl fmt::Display for OAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for OAuthError {}

/// A public URL or validate URL that cannot be used. Messages never include
/// the raw environment value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    PublicApiUrl,
    DashboardUrl,
    ValidateUrl,
}

impl ConfigError {
    pub const fn name(self) -> &'static str {
        match self {
            Self::PublicApiUrl => "PublicApiUrl",
            Self::DashboardUrl => "DashboardUrl",
            Self::ValidateUrl => "ValidateUrl",
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PublicApiUrl => "PUBLIC_API_URL is not a usable absolute http(s) URL",
            Self::DashboardUrl => "DASHBOARD_URL is not a usable absolute http(s) URL",
            Self::ValidateUrl => "Twitch validate URL must be an absolute http(s) URL",
        })
    }
}

impl std::error::Error for ConfigError {}

/// Redis, Mongo, entropy, or adapter failure. [`Self::name`] is safe to log.
/// Driver text and response bodies are never stored here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Redis,
    Mongo,
    MongoCast,
    Schema,
    Json,
    Entropy,
    ValidateTransport,
    ValidateResponse,
    AdapterNotWired,
    Adapter,
}

impl RuntimeError {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Redis => "Redis",
            Self::Mongo => "Mongo",
            Self::MongoCast => "MongoCast",
            Self::Schema => "Schema",
            Self::Json => "Json",
            Self::Entropy => "Entropy",
            Self::ValidateTransport => "ValidateTransport",
            Self::ValidateResponse => "ValidateResponse",
            Self::AdapterNotWired => "AdapterNotWired",
            Self::Adapter => "Adapter",
        }
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

impl std::error::Error for RuntimeError {}

/// `{ "error": "<code>" }` in the source's only field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ErrorBody<'a> {
    pub error: &'a str,
}

/// Extra headers the source error handler adds for 401 and 429.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ErrorHeaders {
    pub www_authenticate: bool,
    pub retry_after: Option<&'static str>,
}

pub fn error_headers(status: u16) -> ErrorHeaders {
    ErrorHeaders {
        www_authenticate: status == 401,
        retry_after: (status == 429).then_some(RETRY_AFTER_SLOW_DOWN),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonString {
    Absent,
    Null,
    Text(String),
}

impl JsonString {
    pub fn insert(self, map: &mut Map<String, Value>, key: &str) {
        match self {
            Self::Absent => {}
            Self::Null => {
                map.insert(key.to_owned(), Value::Null);
            }
            Self::Text(text) => {
                map.insert(key.to_owned(), Value::String(text));
            }
        }
    }
}

/// JavaScript `left || right` for the name fields this API reads.
pub fn js_or(left: JsonString, right: JsonString) -> JsonString {
    if let JsonString::Text(value) = &left
        && !value.is_empty()
    {
        return left;
    }
    right
}

pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_js_trim_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&c)
}

/// `String.prototype.trim` (ECMAScript WhiteSpace and LineTerminator, plus FEFF).
pub fn js_trim(value: &str) -> &str {
    let start = value
        .char_indices()
        .find(|(_, character)| !is_js_trim_whitespace(*character))
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    let end = value
        .char_indices()
        .rev()
        .find(|(_, character)| !is_js_trim_whitespace(*character))
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    if start >= end { "" } else { &value[start..end] }
}

fn has_c0_or_del(value: &str) -> bool {
    value.chars().any(|character| character <= '\u{001F}' || character == '\u{007F}')
}

/// 32 random bytes, base64url without padding (43 characters), optional prefix.
pub fn secret(prefix: &str) -> Result<String, RuntimeError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RuntimeError::Entropy)?;
    Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/// SHA-256 digest of the UTF-8 bytes, base64url without padding.
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

/// `^[A-Za-z0-9_-]{43}$`.
pub fn is_valid_secret(value: &str) -> bool {
    value.len() == 43
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn is_access_token(value: &str) -> bool {
    value.starts_with("dima_at_") && is_valid_secret(&value["dima_at_".len()..])
}

pub fn is_refresh_token(value: &str) -> bool {
    value.starts_with("dima_rt_") && is_valid_secret(&value["dima_rt_".len()..])
}

/// `^[A-Za-z0-9._~-]{43,128}$`.
pub fn is_code_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value.bytes().all(|byte| {
            matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~')
        })
}

/// 24 hexadecimal characters. This is the ObjectId form this service writes.
/// Mongoose `Types.ObjectId.isValid` also accepts any 12-character string;
/// those values are rejected here because they are not ids we store.
pub fn is_object_id_hex(value: &str) -> bool {
    value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Byte-wise equality with no early return on the first differing byte.
///
/// A length mismatch is `false`. Node's `timingSafeEqual` throws `RangeError`
/// in that case; the caller maps `false` to `invalid_grant`.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut diff = left.len() ^ right.len();
    let width = left.len().max(right.len());
    let mut index = 0;
    while index < width {
        let left_byte = if index < left.len() { left[index] } else { 0 };
        let right_byte = if index < right.len() { right[index] } else { 0 };
        diff |= usize::from(left_byte ^ right_byte);
        index += 1;
    }
    diff == 0
}

pub fn request_key(id: &str) -> String {
    format!("oauth:request:{}", hash(id))
}

pub fn code_key(code: &str) -> String {
    format!("oauth:code:{}", hash(code))
}

pub fn access_key(access: &str) -> String {
    format!("oauth:access:{}", hash(access))
}

pub fn rate_key(bucket: &str) -> String {
    format!("oauth:rate:{}", hash(bucket))
}

/// `^Bearer (\S+)$` using ECMAScript `\s` (not Rust's extra U+0085).
pub fn bearer_token(header: &str) -> Option<&str> {
    let rest = header.strip_prefix("Bearer ")?;
    if rest.is_empty() || rest.chars().any(is_js_trim_whitespace) {
        None
    } else {
        Some(rest)
    }
}

/// `^Bearer ([A-Za-z0-9_-]{10,512})$`, rejecting a `dima_` prefix.
pub fn browser_bearer(header: &str) -> Option<&str> {
    let token = header.strip_prefix("Bearer ")?;
    if token.starts_with("dima_") {
        return None;
    }
    if (10..=512).contains(&token.len())
        && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Some(token)
    } else {
        None
    }
}

pub fn parse_scopes(value: &Value) -> Result<Vec<&'static str>, OAuthError> {
    let Some(text) = value.as_str() else {
        return Err(OAuthError::InvalidScope);
    };
    if utf16_len(text) > SCOPE_MAX_CHARS {
        return Err(OAuthError::InvalidScope);
    }
    let mut scopes = Vec::new();
    for scope in text.split(' ') {
        let Some(definition) = OAUTH_SCOPES.iter().find(|item| item.name == scope) else {
            return Err(OAuthError::InvalidScope);
        };
        if !definition.active {
            return Err(OAuthError::InvalidScope);
        }
        if !scopes.contains(&definition.name) {
            scopes.push(definition.name);
        }
    }
    if scopes.is_empty() {
        return Err(OAuthError::InvalidScope);
    }
    Ok(scopes)
}

pub fn validate_redirect(value: &Value, registered: &[&str]) -> Result<String, OAuthError> {
    let Some(text) = value.as_str() else {
        return Err(OAuthError::InvalidRequest);
    };
    validate_redirect_str(text, registered)
}

/// Only an ephemeral port may differ from a registered loopback callback.
/// `value` must equal the URL parser's canonical href.
pub fn validate_redirect_str(value: &str, registered: &[&str]) -> Result<String, OAuthError> {
    if utf16_len(value) > REDIRECT_MAX_CHARS {
        return Err(OAuthError::InvalidRequest);
    }
    let url = reqwest::Url::parse(value).map_err(|_| OAuthError::InvalidRequest)?;
    let host = url.host_str().unwrap_or("");
    let port_ok = matches!(url.port(), Some(port) if (1..=65535).contains(&port));
    let password_ok = url.password().is_none_or(|password| password.is_empty());
    let query_ok = url.query().is_none_or(|query| query.is_empty());
    let fragment_ok = url.fragment().is_none_or(|fragment| fragment.is_empty());
    let canonical = format!("http://{host}{}", url.path());
    let registered_ok = registered.iter().any(|item| *item == canonical);
    if url.scheme() != "http"
        || !matches!(host, "127.0.0.1" | "[::1]")
        || !port_ok
        || !url.username().is_empty()
        || !password_ok
        || !query_ok
        || !fragment_ok
        || !registered_ok
        || value != url.as_str()
    {
        return Err(OAuthError::InvalidRequest);
    }
    Ok(value.to_owned())
}

/// `undefined` selects [`DEFAULT_DEVICE_NAME`]. A present value is checked raw
/// for length and C0/DEL, then stored trimmed.
pub fn device_name(value: Option<&str>) -> Result<String, OAuthError> {
    let Some(name) = value else {
        return Ok(DEFAULT_DEVICE_NAME.to_owned());
    };
    if js_trim(name).is_empty() || utf16_len(name) > DEVICE_NAME_MAX_CHARS || has_c0_or_del(name) {
        return Err(OAuthError::InvalidRequest);
    }
    Ok(js_trim(name).to_owned())
}

pub fn http_origin(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = url.host_str().filter(|host| !host.is_empty())?;
    match url.port() {
        Some(port) if !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) => {
            Some(format!("{scheme}://{host}:{port}"))
        }
        _ => Some(format!("{scheme}://{host}")),
    }
}

fn origin_from_env(name: &str, default: &str, error: ConfigError) -> Result<String, ConfigError> {
    let raw = match std::env::var(name) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => default.to_owned(),
        Err(std::env::VarError::NotUnicode(_)) => return Err(error),
    };
    http_origin(&raw).ok_or(error)
}

/// Origin of `PUBLIC_API_URL`, or `https://api.domdimabot.com` when unset.
pub fn oauth_issuer() -> Result<String, ConfigError> {
    origin_from_env("PUBLIC_API_URL", DEFAULT_PUBLIC_API_URL, ConfigError::PublicApiUrl)
}

/// Origin of `DASHBOARD_URL`, or `https://domdimabot.com` when unset.
pub fn oauth_website() -> Result<String, ConfigError> {
    origin_from_env("DASHBOARD_URL", DEFAULT_DASHBOARD_URL, ConfigError::DashboardUrl)
}

pub fn require_absolute_http_url(value: &str) -> Result<(), ConfigError> {
    let url = reqwest::Url::parse(value).map_err(|_| ConfigError::ValidateUrl)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ConfigError::ValidateUrl);
    }
    Ok(())
}

/// `issuer.replace(/^http/, 'ws')`. `https` becomes `wss`.
pub fn websocket_endpoint(issuer: &str) -> String {
    let suffix = issuer.strip_prefix("http").unwrap_or(issuer);
    format!("ws{suffix}/v1/desktop/ws")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SocketIoMetadata {
    pub path: &'static str,
    pub namespace: &'static str,
    pub protocol_version: u32,
}

impl SocketIoMetadata {
    pub const DESKTOP: Self = Self {
        path: "/socket.io/",
        namespace: "/desktop",
        protocol_version: 1,
    };
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BetaMetadata {
    pub client_id: &'static str,
    pub protocol_version: u32,
    pub access_token_lifetime: u64,
    pub websocket_endpoint: String,
    pub socket_io: SocketIoMetadata,
    pub planned_scopes: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MetadataDocument {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    pub scopes_supported: Vec<&'static str>,
    pub response_types_supported: [&'static str; 1],
    pub grant_types_supported: [&'static str; 2],
    pub code_challenge_methods_supported: [&'static str; 1],
    pub token_endpoint_auth_methods_supported: [&'static str; 1],
    pub authorization_response_iss_parameter_supported: bool,
    pub beta: BetaMetadata,
}

pub fn metadata_document(issuer: &str) -> MetadataDocument {
    MetadataDocument {
        authorization_endpoint: format!("{issuer}/oauth/authorize"),
        token_endpoint: format!("{issuer}/oauth/token"),
        revocation_endpoint: format!("{issuer}/oauth/revoke"),
        scopes_supported: active_scopes(),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        beta: BetaMetadata {
            client_id: DESKTOP_CLIENT_ID,
            protocol_version: 1,
            access_token_lifetime: ACCESS_TTL_SECONDS,
            websocket_endpoint: websocket_endpoint(issuer),
            socket_io: SocketIoMetadata::DESKTOP,
            planned_scopes: inactive_scopes(),
        },
        issuer: issuer.to_owned(),
    }
}

pub fn refresh_expires_in(idle_expires_at_ms: i64, expires_at_ms: i64, now_ms: i64) -> u64 {
    let deadline = idle_expires_at_ms.min(expires_at_ms);
    let delta = deadline.saturating_sub(now_ms);
    if delta <= 0 { 0 } else { (delta / 1000) as u64 }
}

/// `Date#toISOString` for the OAuth date range.
pub fn iso_timestamp(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    let within_day = millis.rem_euclid(86_400_000);
    let hour = within_day / 3_600_000;
    let minute = within_day / 60_000 % 60;
    let second = within_day / 1_000 % 60;
    let fraction = within_day % 1_000;
    format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z")
}

pub fn authorization_page(website: &str, request_id: &str) -> Result<String, OAuthError> {
    let mut url = reqwest::Url::parse(website).map_err(|_| OAuthError::InvalidRequest)?;
    url.set_path("/oauth/authorize");
    url.query_pairs_mut().append_pair("request", request_id);
    Ok(url.to_string())
}

pub enum CallbackParam<'a> {
    Denied,
    Code(&'a str),
}

pub fn callback_url(
    redirect: &str,
    state: &str,
    issuer: &str,
    result: CallbackParam<'_>,
) -> Result<String, OAuthError> {
    let mut url = reqwest::Url::parse(redirect).map_err(|_| OAuthError::InvalidRequest)?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("state", state);
        pairs.append_pair("iss", issuer);
        match result {
            CallbackParam::Denied => {
                pairs.append_pair("error", "access_denied");
            }
            CallbackParam::Code(code) => {
                pairs.append_pair("code", code);
            }
        }
    }
    Ok(url.to_string())
}
