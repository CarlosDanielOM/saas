//! Access rules from `server/routes/asset-library.route.ts`. Preview tickets
//! identify both owner and asset; channel operations require the authenticated
//! owner. Listing, deletion and multipart upload are guarded; preview tickets
//! use an injected secret, HS256 and a fifteen-minute lifetime.

/// The ticket audience used by the source.
pub const PREVIEW_AUDIENCE: &str = "asset-preview";
/// Lifetime of an issued preview ticket in seconds.
pub const PREVIEW_TTL_SECONDS: u64 = 15 * 60;

/// Whether an authenticated ID can operate on the channel's private library.
pub fn is_channel_owner(authenticated_id: Option<&str>, channel_id: &str) -> bool {
    authenticated_id == Some(channel_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_is_exact() {
        assert!(is_channel_owner(Some("12"), "12"));
        assert!(!is_channel_owner(Some("012"), "12"));
        assert!(!is_channel_owner(None, "12"));
    }
    #[test]
    fn ticket_scope_is_fixed() {
        assert_eq!(PREVIEW_AUDIENCE, "asset-preview");
        assert_eq!(PREVIEW_TTL_SECONDS, 900);
    }
}

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use serde::Serialize;
use super::library::{AssetError, AssetLibrary};

/// The currently implemented authenticated listing, upload and delete routes.
/// The public ticket route and owner-protected routes share one library instance.
#[derive(Clone)]
pub struct AssetLibraryRouteService { library: AssetLibrary, secret: Option<std::sync::Arc<[u8]>>, uploading: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>> }
impl AssetLibraryRouteService {
    /// Construct from the caller's native private-library adapter.
    pub fn new(library: AssetLibrary, secret: Option<Vec<u8>>) -> Self { Self { library, secret: secret.filter(|value| !value.is_empty()).map(std::sync::Arc::from), uploading: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())) } }
    /// Build the public preview and authenticated owner routes.
    pub fn protected_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        let routes = self.authenticated_router();
        self.with_public(auth.protect(routes))
    }
    /// Build only owner routes; caller must install an authentication layer.
    pub fn authenticated_router(&self) -> Router {
        Router::new()
            .route("/{channelID}", get(list_assets).post(upload_asset))
            .route("/{channelID}/{id}", delete(delete_asset))
            .route("/{channelID}/{id}/access", get(issue_access))
            .layer(DefaultBodyLimit::disable())
            .with_state(self.clone())
    }
    /// Merge public preview into a caller-authenticated owner router.
    pub fn with_public(&self, authenticated: Router) -> Router {
        let public = Router::new().route("/content/{id}", get(serve_content)).with_state(self.clone());
        authenticated.merge(public).layer(middleware::from_fn(private_headers))
    }
}

async fn private_headers(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

#[derive(Serialize)]
struct ErrorBody { error: bool, status: u16, code: &'static str, message: &'static str }
fn failure(error: AssetError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, Json(ErrorBody { error: true, status: error.status, code: error.code, message: error.code })).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response
}

#[derive(Serialize)]
struct Success<T: Serialize> { error: bool, status: u16, message: &'static str, data: T }
fn success<T: Serialize>(data: T) -> Response {
    let mut response = Json(Success { error: false, status: 200, message: "OK", data }).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response
}

async fn check_owner(library: &AssetLibrary, user: &crate::api_auth::types::AuthenticatedUser, channel: &str) -> Result<(), AssetError> {
    if !is_channel_owner(Some(&user.id), channel) { return Err(AssetError { code: "owner_required", status: 403 }); }
    library.asset_quota(channel).await?;
    Ok(())
}

async fn list_assets(State(state): State<AssetLibraryRouteService>, Path(channel): Path<String>, user: crate::api_auth::types::AuthenticatedUser) -> Response {
    if let Err(error) = check_owner(&state.library, &user, &channel).await { return failure(error); }
    match state.library.list_assets(&channel).await { Ok(data) => success(data), Err(error) => failure(error) }
}

#[derive(Serialize)]
struct Deleted { deleted: bool }
async fn delete_asset(State(state): State<AssetLibraryRouteService>, Path((channel, id)): Path<(String, String)>, user: crate::api_auth::types::AuthenticatedUser) -> Response {
    if let Err(error) = check_owner(&state.library, &user, &channel).await { return failure(error); }
    match state.library.delete_asset(&channel, &id).await { Ok(()) => success(Deleted { deleted: true }), Err(error) => failure(error) }
}

struct UploadGuard {
    owner: String,
    slots: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    directory: Option<std::path::PathBuf>,
}
impl Drop for UploadGuard {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.slots.lock() { slots.remove(&self.owner); }
        if let Some(path) = self.directory.take() { let _ = std::fs::remove_dir_all(path); }
    }
}

async fn upload_asset(
    State(state): State<AssetLibraryRouteService>,
    Path(channel): Path<String>,
    user: crate::api_auth::types::AuthenticatedUser,
    multipart: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Response {
    if let Err(error) = check_owner(&state.library, &user, &channel).await { return failure(error); }
    {
        let Ok(mut slots) = state.uploading.lock() else { return failure(AssetError { code: "unavailable", status: 500 }); };
        if slots.contains(&channel) || slots.len() >= 4 { return failure(AssetError { code: "upload_busy", status: 429 }); }
        slots.insert(channel.clone());
    }
    let mut guard = UploadGuard { owner: channel.clone(), slots: state.uploading.clone(), directory: None };
    let mut multipart = match multipart { Ok(value) => value, Err(_) => return failure(AssetError { code: "file_size", status: 413 }) };
    let operation = async {
        use tokio::io::AsyncWriteExt;
        let directory = std::env::temp_dir().join(format!("design-asset-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory).await.map_err(|_| AssetError { code: "unavailable", status: 500 })?;
        guard.directory = Some(directory.clone());
        let path = directory.join("upload");
        let mut found = None;
        let mut parts = 0usize;
        while let Some(mut field) = multipart.next_field().await.map_err(|_| AssetError { code: "file_size", status: 413 })? {
            parts += 1;
            if parts > 2 || field.name() != Some("file") || field.file_name().is_none() || found.is_some() {
                return Err(AssetError { code: "file_size", status: 413 });
            }
            let original_name = field.file_name().unwrap_or("").to_owned();
            let mut output = tokio::fs::File::create_new(&path).await.map_err(|_| AssetError { code: "unavailable", status: 500 })?;
            let mut size = 0u64;
            while let Some(chunk) = field.chunk().await.map_err(|_| AssetError { code: "upload_aborted", status: 400 })? {
                size = size.saturating_add(chunk.len() as u64);
                if size > super::library::MAX_ASSET_BYTES { return Err(AssetError { code: "file_size", status: 413 }); }
                output.write_all(&chunk).await.map_err(|_| AssetError { code: "unavailable", status: 500 })?;
            }
            drop(output);
            found = Some(super::library::UploadFile { path: path.clone(), original_name, size });
        }
        let file = found.ok_or(AssetError { code: "file_required", status: 400 })?;
        state.library.upload_asset(&channel, &file).await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(120), operation).await {
        Ok(Ok(asset)) => success(asset),
        Ok(Err(error)) => failure(error),
        Err(_) => failure(AssetError { code: "upload_aborted", status: 400 }),
    }
}

fn now_seconds() -> Result<u64, AssetError> {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_secs()).map_err(|_| AssetError { code: "unavailable", status: 503 })
}
fn ticket_parameter(query: Option<&str>) -> Option<String> {
    let mut found = None;
    for pair in query?.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "ticket" { continue; }
        if found.is_some() { return None; }
        let mut result = Vec::new();
        let mut input = value.bytes();
        while let Some(byte) = input.next() {
            if byte == b'%' {
                let hi = (input.next()? as char).to_digit(16)?;
                let lo = (input.next()? as char).to_digit(16)?;
                result.push((hi * 16 + lo) as u8);
            } else { result.push(if byte == b'+' { b' ' } else { byte }); }
        }
        found = String::from_utf8(result).ok();
    }
    found
}
async fn serve_content(State(state): State<AssetLibraryRouteService>, Path(id): Path<String>, RawQuery(query): RawQuery, method: Method, headers: HeaderMap) -> Response {
    let Some(secret) = state.secret.as_deref() else { return failure(unauthorized()); };
    let Some(ticket) = ticket_parameter(query.as_deref()) else { return failure(unauthorized()); };
    let now = match now_seconds() { Ok(now) => now, Err(_) => return failure(unauthorized()) };
    let owner = match verify_ticket(secret, &ticket, &id, now) { Ok(owner) => owner, Err(error) => return failure(error) };
    match super::http::serve_asset(&state.library, &owner, &id, &method, &headers, false).await { Ok(response) => response, Err(error) => failure(error) }
}
#[derive(Serialize)]
struct AccessPath { path: String }
async fn issue_access(State(state): State<AssetLibraryRouteService>, Path((channel, id)): Path<(String, String)>, user: crate::api_auth::types::AuthenticatedUser) -> Response {
    if let Err(error) = check_owner(&state.library, &user, &channel).await { return failure(error); }
    if let Err(error) = state.library.find_asset(&channel, &id).await { return failure(error); }
    let Some(secret) = state.secret.as_deref() else { return failure(AssetError { code: "unavailable", status: 503 }); };
    let now = match now_seconds() { Ok(now) => now, Err(error) => return failure(error) };
    match issue_ticket(secret, &channel, &id, now) {
        Ok(ticket) => success(AccessPath { path: format!("/asset-library/content/{id}?ticket={ticket}") }),
        Err(error) => failure(error),
    }
}


use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PreviewClaims {
    owner: String,
    sub: String,
    aud: String,
    exp: u64,
}

#[derive(Debug, Deserialize)]
struct VerifiedPreviewClaims {
    owner: String,
    sub: String,
    exp: f64,
    #[serde(flatten)]
    extra: std::collections::HashMap<String, serde_json::Value>,
}

fn unauthorized() -> AssetError { AssetError { code: "unauthorized", status: 401 } }

/// Issue an owner-scoped HS256 preview ticket.
pub fn issue_ticket(secret: &[u8], owner: &str, id: &str, now: u64) -> Result<String, AssetError> {
    if secret.is_empty() { return Err(AssetError { code: "unavailable", status: 503 }); }
    let exp = now.checked_add(PREVIEW_TTL_SECONDS).ok_or(AssetError { code: "unavailable", status: 503 })?;
    let claims = PreviewClaims { owner: owner.to_owned(), sub: id.to_owned(), aud: PREVIEW_AUDIENCE.to_owned(), exp };
    encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret)).map_err(|_| AssetError { code: "unavailable", status: 500 })
}

/// Verify the algorithm, audience, expiry, owner and exact asset subject.
pub fn verify_ticket(secret: &[u8], token: &str, id: &str, now: u64) -> Result<String, AssetError> {
    if secret.is_empty() { return Err(unauthorized()); }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[PREVIEW_AUDIENCE]);
    validation.set_required_spec_claims(&["exp", "sub", "aud"]);
    validation.leeway = 0;
    // The crate rounds NumericDate values and rejects negative nbf. Node's
    // verifier accepts negative dates and compares fractional values directly.
    validation.validate_nbf = false;
    let claims = decode::<VerifiedPreviewClaims>(token, &DecodingKey::from_secret(secret), &validation).map_err(|_| unauthorized())?.claims;
    if claims.sub != id || claims.owner.is_empty() || !claims.exp.is_finite() || claims.exp <= now as f64 { return Err(unauthorized()); }
    if let Some(nbf) = claims.extra.get("nbf") {
        let nbf = nbf.as_f64().filter(|number| number.is_finite()).ok_or_else(unauthorized)?;
        if nbf > now as f64 { return Err(unauthorized()); }
    }
    Ok(claims.owner)
}

#[cfg(test)]
mod ticket_tests {
    use super::*;
    #[test]
    fn signed_ticket_scope_and_tampering() {
        let now = now_seconds().expect("system clock");
        let token = issue_ticket(b"test secret", "owner", "asset", now).expect("ticket");
        assert_eq!(verify_ticket(b"test secret", &token, "asset", now).expect("valid"), "owner");
        assert!(verify_ticket(b"wrong", &token, "asset", now).is_err());
        assert!(verify_ticket(b"test secret", &token, "other", now).is_err());
        assert!(verify_ticket(b"test secret", &token, "asset", now + 900).is_err());
        assert!(verify_ticket(b"test secret", "bad.token", "asset", now).is_err());
        let mut bytes = token.into_bytes();
        let point = bytes.iter().position(|byte| *byte == b'.').expect("separator") + 1;
        bytes[point] = if bytes[point] == b'A' { b'B' } else { b'A' };
        assert!(verify_ticket(b"test secret", std::str::from_utf8(&bytes).expect("ASCII"), "asset", now).is_err());
    }
    #[test]
    fn rejects_wrong_audience_and_algorithm() {
        let now = now_seconds().expect("system clock");
        let claims = PreviewClaims { owner: "owner".into(), sub: "asset".into(), aud: "wrong".into(), exp: now + 900 };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(b"key")).expect("ticket");
        assert!(verify_ticket(b"key", &token, "asset", now).is_err());
        for claims in [
            serde_json::json!({"owner":"owner","sub":"asset","aud":"asset-preview"}),
            serde_json::json!({"owner":"owner","sub":"asset","aud":"asset-preview","exp":"later"}),
            serde_json::json!({"owner":"owner","sub":"asset","aud":"asset-preview","exp":now+900,"nbf":null}),
            serde_json::json!({"owner":"owner","sub":"asset","aud":"asset-preview","exp":now+900,"nbf":now as f64 + 0.25}),
        ] {
            let token = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(b"key")).expect("ticket");
            assert!(verify_ticket(b"key", &token, "asset", now).is_err());
        }
        let negative_nbf = serde_json::json!({"owner":"owner","sub":"asset","aud":"asset-preview","exp":now+900,"nbf":-1});
        let token = encode(&Header::new(Algorithm::HS256), &negative_nbf, &EncodingKey::from_secret(b"key")).expect("ticket");
        assert!(verify_ticket(b"key", &token, "asset", now).is_ok());
        assert!(verify_ticket(b"key", "eyJhbGciOiJub25lIn0.e30.", "asset", now).is_err());
        assert!(verify_ticket(b"key", "eyJhbGciOiJSUzI1NiJ9.e30.eA", "asset", now).is_err());
    }
}
