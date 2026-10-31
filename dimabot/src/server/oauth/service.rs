//! OAuth desktop-beta persistence, matching `dimabot/src/server/oauth/service.ts`
//! and the user lookups in `routes.ts`.
//!
//! [`OAuthApiService::new`] stores concrete handles and does not connect, read
//! the environment, or install indexes. [`OAuthApiService::initialize`] is the
//! explicit index and desktop-client step. `PUBLIC_API_URL`, `DASHBOARD_URL`,
//! and `CLIENT_ID` are read when a request needs them.
//!
//! Credit and pet behaviour stay behind [`OAuthCreditsReader`] and
//! [`OAuthPetAccess`]. The unwired sentinels are real types that fail closed;
//! they do not invent billing or pet results. Their 503
//! `temporarily_unavailable` envelope is an adapter-boundary convention, not
//! source parity. The TypeScript source always calls the real implementation.
//! Once the owning adapter is passed to [`OAuthApiService::new`], the route
//! returns that value and this 503 disappears.

use super::catalog::{
    ACCESS_TTL_SECONDS, CLIENT_ID_MAX_CHARS, CODE_TTL_SECONDS, CallbackParam, ConfigError,
    DESKTOP_CLIENT_ID, DESKTOP_CLIENT_NAME, DESKTOP_CLIENT_TYPE, DESKTOP_REDIRECT_URIS, JsonString,
    OAUTH_SCOPES, OAuthError, RATE_LIMIT_LUA, REFRESH_IDLE_MS, REQUEST_TTL_SECONDS,
    REVOKE_TOKEN_MAX_CHARS, RuntimeError, SESSION_ABSOLUTE_MS, SocketIoMetadata,
    TWITCH_VALIDATE_TIMEOUT, TWITCH_VALIDATE_URL, access_key, active_scopes, bearer_token,
    browser_bearer, callback_url, code_key, constant_time_eq, device_name, error_headers, hash,
    is_access_token, is_code_verifier, is_object_id_hex, is_refresh_token, is_valid_secret,
    iso_timestamp, js_or, oauth_issuer, parse_scopes, rate_key, refresh_expires_in, request_key,
    require_absolute_http_url, secret, utf16_len, validate_redirect, validate_redirect_str,
};
use crate::schemas::{
    PersistenceError, SchemaRepository, UpsertError, oauth_client, oauth_grant, oauth_refresh_token,
    oauth_session, users,
};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value};
use std::{fmt, future::Future};

pub const REVOKE_USER: &str = "user_revoked";
pub const REVOKE_REFRESH_REUSE: &str = "refresh_reuse";
pub const REVOKE_ROTATION_FAILED: &str = "rotation_failed";
pub const REVOKE_ISSUANCE_FAILED: &str = "issuance_failed";
pub const REVOKE_GRANT: &str = "grant_revoked";
pub const REVOKE_ACCOUNT_DELETED: &str = "account_deleted";
pub const REVOKE_SIGNED_OUT: &str = "signed_out";

const VALIDATE_BODY_LIMIT: usize = 64 * 1024;

/// Team1-billing-ai must implement this. `user` is the native users document
/// with the schema's default projection (hidden fields excluded), which is
/// Mongoose `findById` without `select('+...')`.
///
/// `Ok` is the JSON object the route sends. Do not put secrets in [`CreditsError`].
pub trait OAuthCreditsReader: Clone + Send + Sync + 'static {
    fn credits_document<'a>(
        &'a self,
        user: &'a Document,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, CreditsError>> + Send + 'a;
}

/// Failure of [`OAuthCreditsReader`]. `NotWired` and `Failed` both become
/// `503 temporarily_unavailable`. That envelope is an adapter-boundary
/// convention, not source parity: the source always calls `getAiCredits` and
/// `getFreeAiCreditDisplay`. Once a real reader is passed to
/// [`OAuthApiService::new`], `GET /me/credits` returns that value and this
/// 503 disappears. `NotWired` is logged as `AdapterNotWired`. `Failed` is
/// logged as `Adapter`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreditsError {
    NotWired,
    Failed,
}

/// Team4-speech-media must implement this, including the pet-settings read
/// that team2-api-data owns in TypeScript. Codes passed back are short tokens
/// copied into the JSON `error` field.
pub trait OAuthPetAccess: Clone + Send + Sync + 'static {
    fn configuration<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a;

    fn runtime<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a;

    fn select_playback<'a>(
        &'a self,
        identity: &'a AccessIdentity,
        body: &'a Value,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a;

    fn ensure_configuration<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<(), PetAccessError>> + Send + 'a;

    fn cancel_request<'a>(
        &'a self,
        user_id: &'a str,
        request_id: &'a str,
        command_id: Option<&'a Value>,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a;
}

/// Pet adapter failure. `Settings` is the source `PetSettingsError`. `Pet` is
/// the source `PetError`. Both keep their code and status. `NotWired` and
/// `Failed` become `503 temporarily_unavailable`. That 503 is an
/// adapter-boundary convention, not source parity. The source always calls
/// `getPetConfiguration`, `getPetRuntime`, `selectOwnPetPlayback`, or
/// `cancelPetRequest`. Once a real [`OAuthPetAccess`] is passed to
/// [`OAuthApiService::new`], the route returns that value and this 503
/// disappears.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PetAccessError {
    NotWired,
    Settings { code: String, status: u16 },
    Pet { code: String, status: u16 },
    Failed,
}

/// Sentinel required by [`OAuthApiService::new`]. Every call returns
/// [`CreditsError::NotWired`]. The resulting 503 is an adapter-boundary
/// convention, not source parity, and disappears when a real reader is passed
/// to [`OAuthApiService::new`].
#[derive(Clone, Copy, Debug, Default)]
pub struct UnwiredCreditsReader;

impl OAuthCreditsReader for UnwiredCreditsReader {
    fn credits_document<'a>(
        &'a self,
        _user: &'a Document,
        _channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, CreditsError>> + Send + 'a {
        async { Err(CreditsError::NotWired) }
    }
}

/// Sentinel required by [`OAuthApiService::new`]. Every call returns
/// [`PetAccessError::NotWired`]. The resulting 503 is an adapter-boundary
/// convention, not source parity, and disappears when a real pet adapter is
/// passed to [`OAuthApiService::new`].
#[derive(Clone, Copy, Debug, Default)]
pub struct UnwiredPetAccess;

impl OAuthPetAccess for UnwiredPetAccess {
    fn configuration<'a>(
        &'a self,
        _user_id: &'a str,
        _channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a {
        async { Err(PetAccessError::NotWired) }
    }

    fn runtime<'a>(
        &'a self,
        _user_id: &'a str,
        _channel_id: &'a str,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a {
        async { Err(PetAccessError::NotWired) }
    }

    fn select_playback<'a>(
        &'a self,
        _identity: &'a AccessIdentity,
        _body: &'a Value,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a {
        async { Err(PetAccessError::NotWired) }
    }

    fn ensure_configuration<'a>(
        &'a self,
        _user_id: &'a str,
        _channel_id: &'a str,
    ) -> impl Future<Output = Result<(), PetAccessError>> + Send + 'a {
        async { Err(PetAccessError::NotWired) }
    }

    fn cancel_request<'a>(
        &'a self,
        _user_id: &'a str,
        _request_id: &'a str,
        _command_id: Option<&'a Value>,
    ) -> impl Future<Output = Result<Value, PetAccessError>> + Send + 'a {
        async { Err(PetAccessError::NotWired) }
    }
}

/// Why [`OAuthApiService::from_runtime`] could not build the service.
/// Display text never includes a URI, a host, or a secret.
#[derive(Debug)]
pub enum OAuthInitError {
    Mongo(mongodb::error::Error),
    Redis(redis::RedisError),
    MissingDatabase,
    Http,
    ValidateUrl,
}

impl fmt::Display for OAuthInitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Mongo(_) => "MongoDB client could not be created",
            Self::Redis(_) => "Redis client could not be created",
            Self::MissingDatabase => "MONGO_URI must select a database",
            Self::Http => "HTTP client configuration was rejected",
            Self::ValidateUrl => "Twitch validate URL was rejected",
        })
    }
}

impl std::error::Error for OAuthInitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mongo(error) => Some(error),
            Self::Redis(error) => Some(error),
            Self::MissingDatabase | Self::Http | Self::ValidateUrl => None,
        }
    }
}

/// Which known external error produced a failure. Both kinds keep their own
/// HTTP status and are not logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalKind {
    Pet,
    PetSettings,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalFailure {
    pub kind: ExternalKind,
    pub code: String,
    pub status: u16,
}

impl ExternalFailure {
    pub fn pet(code: impl Into<String>, status: u16) -> Self {
        Self { kind: ExternalKind::Pet, code: code.into(), status }
    }

    pub fn settings(code: impl Into<String>, status: u16) -> Self {
        Self { kind: ExternalKind::PetSettings, code: code.into(), status }
    }
}

impl fmt::Display for ExternalFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for ExternalFailure {}

/// Typed failure for this slice. Protocol and external errors answer their own
/// code. Configuration and runtime errors answer `503 temporarily_unavailable`
/// and are logged by name only. `RuntimeError::AdapterNotWired` and
/// `RuntimeError::Adapter` use that envelope as an adapter-boundary
/// convention, not source parity. The source 503 is any throw that is not an
/// `OAuthError`, `PetError`, or `PetSettingsError` (Redis, Mongo, or another
/// unknown error). A missing scope stays `403 insufficient_scope` and does
/// not call the adapter.
#[derive(Debug)]
pub enum OAuthFailure {
    Protocol(OAuthError),
    External(ExternalFailure),
    Configuration(ConfigError),
    Runtime(RuntimeError),
}

impl fmt::Display for OAuthFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => error.fmt(formatter),
            Self::External(error) => error.fmt(formatter),
            Self::Configuration(error) => error.fmt(formatter),
            Self::Runtime(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for OAuthFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::External(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Runtime(error) => Some(error),
        }
    }
}

impl From<OAuthError> for OAuthFailure {
    fn from(error: OAuthError) -> Self {
        Self::Protocol(error)
    }
}

impl From<ConfigError> for OAuthFailure {
    fn from(error: ConfigError) -> Self {
        Self::Configuration(error)
    }
}

impl From<RuntimeError> for OAuthFailure {
    fn from(error: RuntimeError) -> Self {
        Self::Runtime(error)
    }
}

impl From<ExternalFailure> for OAuthFailure {
    fn from(error: ExternalFailure) -> Self {
        Self::External(error)
    }
}

/// HTTP mapping of [`OAuthFailure`] after any safe log line has been written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailureResponse {
    pub status: u16,
    pub code: String,
    pub www_authenticate: bool,
    pub retry_after: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthClient {
    pub client_id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub allowed_scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequest {
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub state: String,
    pub code_challenge: String,
    pub device_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct AuthorizationCode {
    client_id: String,
    redirect_uri: String,
    scopes: Vec<String>,
    state: String,
    code_challenge: String,
    device_name: String,
    user_id: String,
    channel_id: String,
}

/// Redis access-token identity. Field order matches `JSON.stringify` of the
/// source object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessIdentity {
    pub session_id: String,
    pub user_id: String,
    pub client_id: String,
    pub channel_id: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: u64,
    pub refresh_token: String,
    pub scope: String,
    pub session_id: String,
    pub refresh_expires_in: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserUser {
    pub user_id: String,
    pub twitch_id: String,
    pub name: JsonString,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuthorizationView {
    pub client_id: String,
    pub client_name: String,
    pub device_name: String,
    pub scopes: Vec<String>,
    pub redirect_uri: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConnectionSession {
    #[serde(rename = "_id")]
    pub id: String,
    pub client_id: String,
    pub grant_id: String,
    pub device_name: String,
    pub scopes: Vec<String>,
    pub last_used_at: Value,
    pub expires_at: Value,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Value>,
}

#[derive(Clone, Debug)]
struct IssuedSession {
    id: ObjectId,
    user_id: ObjectId,
    client_id: String,
    channel_id: String,
    scopes: Vec<String>,
    idle_expires_at: DateTime,
    expires_at: DateTime,
}

#[derive(Clone, Debug)]
struct ActiveSession {
    id: ObjectId,
    user_id: ObjectId,
    client_id: String,
    channel_id: String,
    scopes: Vec<String>,
    current_refresh_hash: String,
    idle_expires_at: DateTime,
    expires_at: DateTime,
}

enum ClientIdEnv {
    Absent,
    Value(String),
    Invalid,
}

/// Concrete OAuth service. `C` and `P` are required; use
/// [`UnwiredCreditsReader`] and [`UnwiredPetAccess`] until those teams wire
/// real adapters.
#[derive(Clone)]
pub struct OAuthApiService<C, P> {
    database: Database,
    redis: ConnectionManager,
    http: reqwest::Client,
    logger: Option<crate::utils::logger::Logger>,
    validate_url: String,
    credits: C,
    pet: P,
}

impl<C, P> OAuthApiService<C, P>
where
    C: OAuthCreditsReader,
    P: OAuthPetAccess,
{
    /// Stores the handles. No I/O. `validate_url` must be an absolute http(s) URL.
    pub fn new(
        database: Database,
        redis: ConnectionManager,
        http: reqwest::Client,
        logger: Option<crate::utils::logger::Logger>,
        validate_url: impl Into<String>,
        credits: C,
        pet: P,
    ) -> Result<Self, ConfigError> {
        let validate_url = validate_url.into();
        require_absolute_http_url(&validate_url)?;
        Ok(Self { database, redis, http, logger, validate_url, credits, pet })
    }

    /// Pooled client used for the Twitch validate call. Redirects are not followed.
    pub fn validate_http_client() -> Result<reqwest::Client, OAuthInitError> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| OAuthInitError::Http)
    }

    /// Connects through the native Mongo and Redis helpers.
    ///
    /// `MONGO_URI` must name a database. Redis uses `DRAGONFLY_HOST` and
    /// `DRAGONFLY_PORT`. The validate URL is the production Twitch endpoint.
    pub async fn from_runtime(
        logger: Option<crate::utils::logger::Logger>,
        credits: C,
        pet: P,
    ) -> Result<Self, OAuthInitError> {
        let database = {
            let client = crate::utils::mongo::get_mongo_client().await.map_err(OAuthInitError::Mongo)?;
            client.default_database().ok_or(OAuthInitError::MissingDatabase)?
        };
        let redis = crate::utils::redis::get_redis_client().await.map_err(OAuthInitError::Redis)?;
        let http = Self::validate_http_client()?;
        Self::new(database, redis, http, logger, TWITCH_VALIDATE_URL, credits, pet)
            .map_err(|_| OAuthInitError::ValidateUrl)
    }

    pub fn logger(&self) -> Option<&crate::utils::logger::Logger> {
        self.logger.as_ref()
    }

    pub fn credits_reader(&self) -> &C {
        &self.credits
    }

    pub fn pet_access(&self) -> &P {
        &self.pet
    }

    /// Installs the four OAuth indexes, upserts the desktop client, then adds
    /// any newly active scope without rewriting grants or sessions.
    pub async fn initialize(&self) -> Result<(), OAuthFailure> {
        let client = oauth_client::schema();
        let grant = oauth_grant::schema();
        let session = oauth_session::schema();
        let refresh = oauth_refresh_token::schema();
        tokio::try_join!(
            client.install_indexes(&self.database),
            grant.install_indexes(&self.database),
            session.install_indexes(&self.database),
            refresh.install_indexes(&self.database),
        )
        .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let now = DateTime::now();
        let scopes: Vec<String> = active_scopes().into_iter().map(str::to_owned).collect();
        let insert = doc! {
            "name": DESKTOP_CLIENT_NAME,
            "type": DESKTOP_CLIENT_TYPE,
            "enabled": true,
            "redirect_uris": DESKTOP_REDIRECT_URIS.map(str::to_owned).to_vec(),
            "allowed_scopes": scopes.clone(),
        };
        oauth_client::schema()
            .repository(&self.database)
            .upsert_equality(&doc! { "client_id": DESKTOP_CLIENT_ID }, &insert, &Document::new(), now)
            .await
            .map_err(map_upsert)?;
        let update = doc! {
            "$addToSet": { "allowed_scopes": { "$each": scopes } },
            "$set": { "updatedAt": DateTime::now() },
        };
        self.clients()
            .update_one(doc! { "client_id": DESKTOP_CLIENT_ID }, update)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        Ok(())
    }

    pub async fn rate_limit(&self, bucket: &str, limit: i64) -> Result<(), OAuthFailure> {
        let mut connection = self.redis.clone();
        let count: i64 = redis::Script::new(RATE_LIMIT_LUA)
            .key(rate_key(bucket))
            .invoke_async(&mut connection)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Redis))?;
        if count > limit {
            return Err(OAuthError::SlowDown.into());
        }
        Ok(())
    }

    pub async fn get_client(&self, client_id: &Value) -> Result<OAuthClient, OAuthFailure> {
        let Some(client_id) = client_id.as_str() else {
            return Err(OAuthError::InvalidClient.into());
        };
        if utf16_len(client_id) > CLIENT_ID_MAX_CHARS {
            return Err(OAuthError::InvalidClient.into());
        }
        let document = self
            .clients()
            .find_one(doc! { "client_id": client_id, "enabled": true })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
            .ok_or(OAuthError::InvalidClient)?;
        Ok(OAuthClient {
            client_id: required_client_string(&document, "client_id")?,
            name: required_client_string(&document, "name")?,
            redirect_uris: required_client_strings(&document, "redirect_uris")?,
            allowed_scopes: required_client_strings(&document, "allowed_scopes")?,
        })
    }

    pub async fn start_authorization(&self, input: &JsonMap<String, Value>) -> Result<String, OAuthFailure> {
        if input.get("response_type").and_then(Value::as_str) != Some("code")
            || input.get("code_challenge_method").and_then(Value::as_str) != Some("S256")
            || !input.get("code_challenge").and_then(Value::as_str).is_some_and(is_valid_secret)
            || !input.get("state").and_then(Value::as_str).is_some_and(is_valid_secret)
        {
            return Err(OAuthError::InvalidRequest.into());
        }
        let missing = Value::Null;
        let client = self.get_client(input.get("client_id").unwrap_or(&missing)).await?;
        let redirect = validate_redirect(input.get("redirect_uri").unwrap_or(&missing), &str_refs(&client.redirect_uris))?;
        let scopes = parse_scopes(input.get("scope").unwrap_or(&missing))?;
        if scopes.iter().any(|scope| !client.allowed_scopes.iter().any(|allowed| allowed == scope)) {
            return Err(OAuthError::InvalidScope.into());
        }
        let name = match input.get("device_name") {
            None => device_name(None)?,
            Some(Value::String(value)) => device_name(Some(value))?,
            Some(_) => return Err(OAuthError::InvalidRequest.into()),
        };
        let request = AuthorizationRequest {
            client_id: client.client_id,
            redirect_uri: redirect,
            scopes: scopes.into_iter().map(str::to_owned).collect(),
            state: required_str(input, "state")?.to_owned(),
            code_challenge: required_str(input, "code_challenge")?.to_owned(),
            device_name: name,
        };
        let id = secret("")?;
        let json = to_json(&request)?;
        self.redis_set(&request_key(&id), &json, REQUEST_TTL_SECONDS).await?;
        Ok(id)
    }

    pub async fn get_authorization(&self, id: &str) -> Result<AuthorizationRequest, OAuthFailure> {
        if !is_valid_secret(id) {
            return Err(OAuthError::InvalidRequest.into());
        }
        let Some(raw) = self.redis_present(&request_key(id)).await? else {
            return Err(OAuthError::InvalidRequest.into());
        };
        let request: AuthorizationRequest = parse_stored(&raw)?;
        let client = self.get_client(&Value::String(request.client_id.clone())).await?;
        validate_redirect_str(&request.redirect_uri, &str_refs(&client.redirect_uris))?;
        if request.scopes.iter().any(|scope| !client.allowed_scopes.iter().any(|allowed| allowed == scope)) {
            return Err(OAuthError::InvalidScope.into());
        }
        Ok(request)
    }

    /// Second client read, matching the route after `getAuthorization`.
    pub async fn authorization_view(&self, id: &str) -> Result<AuthorizationView, OAuthFailure> {
        let request = self.get_authorization(id).await?;
        let client = self.get_client(&Value::String(request.client_id.clone())).await?;
        Ok(AuthorizationView {
            client_id: client.client_id,
            client_name: client.name,
            device_name: request.device_name,
            scopes: request.scopes,
            redirect_uri: request.redirect_uri,
        })
    }

    pub async fn approve_authorization(
        &self,
        id: &str,
        twitch_id: &str,
        approve: bool,
    ) -> Result<String, OAuthFailure> {
        let request = self.get_authorization(id).await?;
        let Some(user) = self.user_by_twitch(twitch_id).await? else {
            return Err(OAuthError::AccountRequired.into());
        };
        let user_id = read_oid(&user, "_id")?;
        if self.redis_present_getdel(&request_key(id)).await?.is_none() {
            return Err(OAuthError::InvalidRequest.into());
        }
        let issuer = oauth_issuer()?;
        if !approve {
            return Ok(callback_url(&request.redirect_uri, &request.state, &issuer, CallbackParam::Denied)?);
        }
        let code = secret("")?;
        let record = AuthorizationCode {
            client_id: request.client_id,
            redirect_uri: request.redirect_uri.clone(),
            scopes: request.scopes,
            state: request.state.clone(),
            code_challenge: request.code_challenge,
            device_name: request.device_name,
            user_id: user_id.to_hex(),
            channel_id: twitch_id.to_owned(),
        };
        self.redis_set(&code_key(&code), &to_json(&record)?, CODE_TTL_SECONDS).await?;
        Ok(callback_url(&request.redirect_uri, &request.state, &issuer, CallbackParam::Code(&code))?)
    }

    pub async fn exchange_code(&self, input: &JsonMap<String, Value>) -> Result<TokenResponse, OAuthFailure> {
        let missing = Value::Null;
        let client = self.get_client(input.get("client_id").unwrap_or(&missing)).await?;
        let code = input.get("code").and_then(Value::as_str).unwrap_or("");
        let verifier = input.get("code_verifier").and_then(Value::as_str).unwrap_or("");
        if !is_valid_secret(code) || !is_code_verifier(verifier) {
            return Err(OAuthError::InvalidGrant.into());
        }
        let key = code_key(code);
        let Some(raw) = self.redis_present(&key).await? else {
            return Err(OAuthError::InvalidGrant.into());
        };
        let record: AuthorizationCode = parse_stored(&raw)?;
        let challenge = hash(verifier);
        let pkce_ok = constant_time_eq(challenge.as_bytes(), record.code_challenge.as_bytes());
        let redirect_ok = input.get("redirect_uri").and_then(Value::as_str) == Some(record.redirect_uri.as_str());
        let client_ok = record.client_id == client.client_id;
        let scopes_ok = covers(&client.allowed_scopes, &record.scopes);
        if !client_ok || !redirect_ok || !pkce_ok || !scopes_ok {
            return Err(OAuthError::InvalidGrant.into());
        }
        if self.redis_present_getdel(&key).await?.is_none() {
            return Err(OAuthError::InvalidGrant.into());
        }
        let user_id = parse_oid(&record.user_id)?;
        let exists = self
            .users()
            .find_one(doc! {
                "_id": user_id,
                "accounts": { "$elemMatch": { "type": "twitch", "id": &record.channel_id } },
            })
            .projection(doc! { "_id": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        if exists.is_none() {
            return Err(OAuthError::InvalidGrant.into());
        }
        let now = DateTime::now();
        let grant = self.upsert_grant(&user_id, &client.client_id, &record.channel_id, &record.scopes, now).await?;
        let grant_id = read_oid(&grant, "_id")?;
        let refresh = secret("dima_rt_")?;
        let refresh_hash = hash(&refresh);
        let idle = add_ms(now, REFRESH_IDLE_MS)?;
        let expires = add_ms(now, SESSION_ABSOLUTE_MS)?;
        let session = self
            .insert_session(SessionInsert {
                grant_id,
                user_id,
                client_id: record.client_id,
                channel_id: record.channel_id,
                device_name: record.device_name,
                scopes: record.scopes,
                current_refresh_hash: refresh_hash.clone(),
                last_used_at: now,
                idle_expires_at: idle,
                expires_at: expires,
            })
            .await?;
        match self.issue_refresh_and_response(&session, &refresh, &refresh_hash).await {
            Ok(response) => Ok(response),
            Err(error) => Err(self.revoke_or_original(&session.id, REVOKE_ISSUANCE_FAILED, error).await),
        }
    }

    pub async fn refresh_access(&self, input: &JsonMap<String, Value>) -> Result<TokenResponse, OAuthFailure> {
        let missing = Value::Null;
        let client = self.get_client(input.get("client_id").unwrap_or(&missing)).await?;
        let Some(token) = input.get("refresh_token").and_then(Value::as_str).filter(|value| is_refresh_token(value)) else {
            return Err(OAuthError::InvalidGrant.into());
        };
        let token_hash = hash(token);
        let now_lookup = DateTime::now();
        let Some(record) = self
            .refresh_tokens()
            .find_one(doc! { "token_hash": &token_hash, "expires_at": { "$gt": now_lookup } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::InvalidGrant.into());
        };
        let record_id = read_oid(&record, "_id")?;
        let session_id = read_oid(&record, "session_id")?;
        let session = match self.active_session(&session_id.to_hex()).await {
            Ok(session) => session,
            Err(_) => return Err(OAuthError::InvalidGrant.into()),
        };
        if session.client_id != client.client_id {
            return Err(OAuthError::InvalidGrant.into());
        }
        if let Some(scope) = input.get("scope") {
            let joined = session.scopes.join(" ");
            if scope.as_str() != Some(joined.as_str()) {
                return Err(OAuthError::InvalidScope.into());
            }
        }
        if bson_truthy(record.get("used_at")) || session.current_refresh_hash != token_hash {
            self.revoke_session_oid(&session.id, REVOKE_REFRESH_REUSE).await?;
            return Err(OAuthError::InvalidGrant.into());
        }
        let refresh = secret("dima_rt_")?;
        let next_hash = hash(&refresh);
        self.insert_refresh_token(&next_hash, &session.id, session.expires_at).await?;
        let now = DateTime::now();
        let idle_ms = add_ms(now, REFRESH_IDLE_MS)?.timestamp_millis().min(session.expires_at.timestamp_millis());
        let rotated = self
            .sessions()
            .find_one_and_update(
                doc! {
                    "_id": session.id,
                    "revoked_at": Bson::Null,
                    "current_refresh_hash": &token_hash,
                    "idle_expires_at": { "$gt": now },
                    "expires_at": { "$gt": now },
                },
                doc! {
                    "$set": {
                        "current_refresh_hash": &next_hash,
                        "last_used_at": now,
                        "idle_expires_at": DateTime::from_millis(idle_ms),
                        "updatedAt": now,
                    }
                },
            )
            .return_document(mongodb::options::ReturnDocument::After)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let Some(rotated) = rotated else {
            self.revoke_session_oid(&session.id, REVOKE_REFRESH_REUSE).await?;
            return Err(OAuthError::InvalidGrant.into());
        };
        let finished = async {
            self.stamp_used(&record_id, now).await?;
            let issued = issued_from_document(&rotated)?;
            self.token_response(&issued, &refresh).await
        };
        match finished.await {
            Ok(response) => Ok(response),
            Err(error) => Err(self.revoke_or_original(&session.id, REVOKE_ROTATION_FAILED, error).await),
        }
    }

    pub async fn authenticate_header(&self, authorization: Option<&str>) -> Result<AccessIdentity, OAuthFailure> {
        let Some(token) = bearer_token(authorization.unwrap_or("")) else {
            return Err(OAuthError::InvalidToken.into());
        };
        self.authenticate_access(token).await
    }

    pub async fn authenticate_access(&self, token: &str) -> Result<AccessIdentity, OAuthFailure> {
        if !is_access_token(token) {
            return Err(OAuthError::InvalidToken.into());
        }
        let Some(raw) = self.redis_present(&access_key(token)).await? else {
            return Err(OAuthError::InvalidToken.into());
        };
        let identity: AccessIdentity = parse_stored(&raw)?;
        let session = self.active_session(&identity.session_id).await?;
        if identity.user_id != session.user_id.to_hex()
            || identity.client_id != session.client_id
            || identity.channel_id != session.channel_id
            || !covers(&session.scopes, &identity.scopes)
        {
            return Err(OAuthError::InvalidToken.into());
        }
        Ok(identity)
    }

    pub async fn revoke_token(&self, input: &JsonMap<String, Value>) -> Result<(), OAuthFailure> {
        let missing = Value::Null;
        let client = self.get_client(input.get("client_id").unwrap_or(&missing)).await?;
        let Some(token) = input.get("token").and_then(Value::as_str) else {
            return Err(OAuthError::InvalidRequest.into());
        };
        if utf16_len(token) > REVOKE_TOKEN_MAX_CHARS {
            return Err(OAuthError::InvalidRequest.into());
        }
        if is_refresh_token(token) {
            if let Some(record) = self
                .refresh_tokens()
                .find_one(doc! { "token_hash": hash(token) })
                .await
                .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
            {
                let session_id = read_oid(&record, "session_id")?;
                if let Some(session) = self
                    .sessions()
                    .find_one(doc! { "_id": session_id, "client_id": &client.client_id })
                    .await
                    .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
                {
                    let id = read_oid(&session, "_id")?;
                    self.revoke_session_oid(&id, REVOKE_USER).await?;
                }
            }
        } else if is_access_token(token) {
            let key = access_key(token);
            if let Some(raw) = self.redis_present(&key).await? {
                let identity: AccessIdentity = parse_stored(&raw)?;
                if identity.client_id == client.client_id {
                    self.revoke_session(&identity.session_id, REVOKE_USER).await?;
                    self.redis_del(&key).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn revoke_session(&self, id: &str, reason: &str) -> Result<(), OAuthFailure> {
        let oid = parse_oid(id)?;
        self.revoke_session_oid(&oid, reason).await
    }

    /// No-op unless `user_id` is 24 hex characters. Mongoose's 12-character
    /// `ObjectId.isValid` quirk is intentionally not reproduced.
    pub async fn revoke_user_oauth(&self, user_id: &str) -> Result<(), OAuthFailure> {
        if !is_object_id_hex(user_id) {
            return Ok(());
        }
        let oid = parse_oid(user_id)?;
        let now = DateTime::now();
        self.grants()
            .update_many(doc! { "user_id": oid }, doc! { "$set": { "revoked_at": now, "updatedAt": now } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        self.sessions()
            .update_many(
                doc! { "user_id": oid },
                doc! { "$set": { "revoked_at": now, "revoke_reason": REVOKE_ACCOUNT_DELETED, "updatedAt": now } },
            )
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let sessions: Vec<Document> = self
            .sessions()
            .find(doc! { "user_id": oid })
            .projection(doc! { "_id": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
            .try_collect()
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let ids = Bson::Array(
            sessions.iter().filter_map(|document| match document.get("_id") {
                Some(Bson::ObjectId(id)) => Some(Bson::ObjectId(*id)),
                _ => None,
            }).collect(),
        );
        self.refresh_tokens()
            .delete_many(doc! { "session_id": { "$in": ids } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        self.sessions()
            .delete_many(doc! { "user_id": oid })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        self.grants()
            .delete_many(doc! { "user_id": oid })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        Ok(())
    }

    pub async fn browser_user(&self, authorization: Option<&str>) -> Result<BrowserUser, OAuthFailure> {
        let Some(token) = browser_bearer(authorization.unwrap_or("")) else {
            return Err(OAuthError::LoginRequired.into());
        };
        let proof = self.twitch_proof(token).await?;
        let Some(user) = self.user_by_twitch(&proof).await? else {
            return Err(OAuthError::AccountRequired.into());
        };
        let user_id = read_oid(&user, "_id")?;
        let account_name = twitch_account(&user, &proof)
            .map(|account| json_string_field(account, "name"))
            .unwrap_or(JsonString::Absent);
        Ok(BrowserUser {
            user_id: user_id.to_hex(),
            twitch_id: proof,
            name: js_or(account_name, json_string_field(&user, "name")),
        })
    }

    pub async fn connections(&self, user_id: &str) -> Result<Vec<ConnectionSession>, OAuthFailure> {
        let oid = parse_oid(user_id)?;
        let now = DateTime::now();
        let documents: Vec<Document> = self
            .sessions()
            .find(doc! {
                "user_id": oid,
                "revoked_at": Bson::Null,
                "expires_at": { "$gt": now },
                "idle_expires_at": { "$gt": now },
            })
            .projection(doc! {
                "_id": 1,
                "client_id": 1,
                "grant_id": 1,
                "device_name": 1,
                "scopes": 1,
                "last_used_at": 1,
                "expires_at": 1,
                "createdAt": 1,
            })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
            .try_collect()
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        documents.iter().map(connection_session).collect()
    }

    pub async fn revoke_connection(&self, user_id: &str, session_id: &str) -> Result<(), OAuthFailure> {
        if !is_object_id_hex(session_id) {
            return Err(OAuthError::InvalidRequest.into());
        }
        let session_oid = parse_oid(session_id)?;
        let user_oid = parse_oid(user_id)?;
        let Some(session) = self
            .sessions()
            .find_one(doc! { "_id": session_oid, "user_id": user_oid })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::NotFound.into());
        };
        let id = read_oid(&session, "_id")?;
        self.revoke_session_oid(&id, REVOKE_USER).await
    }

    pub async fn revoke_grant(&self, user_id: &str, grant_id: &str) -> Result<(), OAuthFailure> {
        if !is_object_id_hex(grant_id) {
            return Err(OAuthError::InvalidRequest.into());
        }
        let grant_oid = parse_oid(grant_id)?;
        let user_oid = parse_oid(user_id)?;
        let Some(grant) = self
            .grants()
            .find_one(doc! { "_id": grant_oid, "user_id": user_oid })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::NotFound.into());
        };
        let id = read_oid(&grant, "_id")?;
        let now = DateTime::now();
        self.sessions()
            .update_many(
                doc! { "grant_id": id },
                doc! { "$set": { "revoked_at": now, "revoke_reason": REVOKE_GRANT, "updatedAt": now } },
            )
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        self.grants()
            .update_one(doc! { "_id": id }, doc! { "$set": { "revoked_at": now, "updatedAt": now } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        Ok(())
    }

    pub async fn profile(&self, identity: &AccessIdentity) -> Result<Value, OAuthFailure> {
        let oid = parse_oid(&identity.user_id)?;
        let Some(user) = self
            .users()
            .find_one(doc! { "_id": oid })
            .projection(doc! { "name": 1, "accounts.type": 1, "accounts.id": 1, "accounts.name": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::InvalidToken.into());
        };
        let Some(account) = twitch_account(&user, &identity.channel_id) else {
            return Err(OAuthError::InvalidToken.into());
        };
        let Some(account_id) = account.get("id").and_then(Bson::as_str) else {
            return Err(OAuthError::InvalidToken.into());
        };
        let mut channel = JsonMap::new();
        channel.insert("platform".to_owned(), Value::String("twitch".to_owned()));
        channel.insert("id".to_owned(), Value::String(account_id.to_owned()));
        json_string_field(account, "name").insert(&mut channel, "name");
        let mut body = JsonMap::new();
        body.insert("user_id".to_owned(), Value::String(identity.user_id.clone()));
        json_string_field(&user, "name").insert(&mut body, "name");
        body.insert("channel".to_owned(), Value::Object(channel));
        Ok(Value::Object(body))
    }

    pub async fn desktop_session(&self, identity: &AccessIdentity) -> Result<Value, OAuthFailure> {
        let oid = parse_oid(&identity.session_id)?;
        let session = self
            .sessions()
            .find_one(doc! { "_id": oid })
            .projection(doc! { "device_name": 1, "expires_at": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let mut body = JsonMap::new();
        body.insert("session_id".to_owned(), Value::String(identity.session_id.clone()));
        body.insert("user_id".to_owned(), Value::String(identity.user_id.clone()));
        body.insert("client_id".to_owned(), Value::String(identity.client_id.clone()));
        body.insert("channel_id".to_owned(), Value::String(identity.channel_id.clone()));
        body.insert(
            "scopes".to_owned(),
            Value::Array(identity.scopes.iter().cloned().map(Value::String).collect()),
        );
        if let Some(document) = session.as_ref() {
            insert_optional_string(&mut body, "device_name", document)?;
            insert_optional_date(&mut body, "expires_at", document)?;
        }
        body.insert("protocol_version".to_owned(), Value::from(1_u32));
        body.insert(
            "pet_available".to_owned(),
            Value::Bool(identity.scopes.iter().any(|scope| scope == "pet:receive")),
        );
        body.insert(
            "socket_io".to_owned(),
            serde_json::to_value(SocketIoMetadata::DESKTOP).map_err(|_| RuntimeError::Json)?,
        );
        Ok(Value::Object(body))
    }

    pub async fn sign_out(&self, identity: &AccessIdentity) -> Result<(), OAuthFailure> {
        self.revoke_session(&identity.session_id, REVOKE_SIGNED_OUT).await
    }

    pub async fn credits(&self, identity: &AccessIdentity) -> Result<Value, OAuthFailure> {
        let oid = parse_oid(&identity.user_id)?;
        let Some(user) = self
            .users()
            .find_one(doc! { "_id": oid })
            .projection(users::schema().default_projection())
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::InvalidToken.into());
        };
        self.credits.credits_document(&user, &identity.channel_id).await.map_err(map_credits)
    }

    /// `GET /me/pet`. `PetSettingsError` becomes a protocol error before the
    /// response is written. `profiles` and `voices` are removed here.
    pub async fn pet_configuration(&self, identity: &AccessIdentity) -> Result<Value, OAuthFailure> {
        match self.pet.configuration(&identity.user_id, &identity.channel_id).await {
            Ok(Value::Object(mut configuration)) => {
                configuration.remove("profiles");
                configuration.remove("voices");
                Ok(Value::Object(configuration))
            }
            Ok(_) => Err(RuntimeError::Adapter.into()),
            Err(PetAccessError::Settings { code, status }) => Err(OAuthError::custom(code, status).into()),
            Err(error) => Err(map_pet(error)),
        }
    }

    pub async fn pet_runtime(&self, identity: &AccessIdentity) -> Result<Value, OAuthFailure> {
        self.pet.runtime(&identity.user_id, &identity.channel_id).await.map_err(map_pet)
    }

    pub async fn pet_playback(&self, identity: &AccessIdentity, body: &Value) -> Result<Value, OAuthFailure> {
        self.pet.select_playback(identity, body).await.map_err(map_pet)
    }

    pub async fn ensure_pet(&self, identity: &AccessIdentity) -> Result<(), OAuthFailure> {
        self.pet.ensure_configuration(&identity.user_id, &identity.channel_id).await.map_err(map_pet)
    }

    pub async fn pet_cancel(
        &self,
        identity: &AccessIdentity,
        request_id: &str,
        command_id: Option<&Value>,
    ) -> Result<Value, OAuthFailure> {
        self.pet.cancel_request(&identity.user_id, request_id, command_id).await.map_err(map_pet)
    }

    /// Maps a failure to the JSON envelope. Unknown configuration and runtime
    /// errors are the source-parity 503. `AdapterNotWired` and `Adapter` share
    /// the envelope and are the unwired-adapter convention described on
    /// [`OAuthFailure`].
    pub async fn describe_failure(&self, failure: OAuthFailure) -> FailureResponse {
        let (status, code, log_name) = match &failure {
            OAuthFailure::Protocol(error) => (error.status(), error.code().to_owned(), None),
            OAuthFailure::External(error) => (error.status, error.code.clone(), None),
            OAuthFailure::Configuration(error) => (503, "temporarily_unavailable".to_owned(), Some(error.name())),
            OAuthFailure::Runtime(error) => (503, "temporarily_unavailable".to_owned(), Some(error.name())),
        };
        if let Some(name) = log_name {
            self.log_name(name).await;
        }
        let headers = error_headers(status);
        FailureResponse {
            status,
            code,
            www_authenticate: headers.www_authenticate,
            retry_after: headers.retry_after,
        }
    }

    async fn log_name(&self, name: &str) {
        let Some(logger) = &self.logger else {
            return;
        };
        let _ = logger
            .log(
                crate::utils::logger::Level::Error,
                serde_json::json!({ "message": "[OAuth] Request failed", "name": name }),
                crate::utils::logger::LogOptions {
                    destination: crate::utils::logger::Destination::Console,
                    ..Default::default()
                },
            )
            .await;
    }

    async fn active_session(&self, id: &str) -> Result<ActiveSession, OAuthFailure> {
        let oid = parse_oid(id)?;
        let now = DateTime::now();
        let Some(document) = self
            .sessions()
            .find_one(doc! {
                "_id": oid,
                "revoked_at": Bson::Null,
                "expires_at": { "$gt": now },
                "idle_expires_at": { "$gt": now },
            })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
        else {
            return Err(OAuthError::InvalidToken.into());
        };
        let session = ActiveSession {
            id: read_oid(&document, "_id")?,
            user_id: read_oid(&document, "user_id")?,
            client_id: read_string(&document, "client_id")?,
            channel_id: read_string(&document, "channel_id")?,
            scopes: read_strings(&document, "scopes")?,
            current_refresh_hash: document.get_str("current_refresh_hash").unwrap_or("").to_owned(),
            idle_expires_at: read_date(&document, "idle_expires_at")?,
            expires_at: read_date(&document, "expires_at")?,
        };
        let grant = self
            .grants()
            .find_one(doc! { "_id": read_oid(&document, "grant_id")?, "revoked_at": Bson::Null })
            .projection(doc! { "scopes": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let client = self.get_client(&Value::String(session.client_id.clone())).await?;
        let user = self
            .users()
            .find_one(doc! {
                "_id": session.user_id,
                "accounts": { "$elemMatch": { "type": "twitch", "id": &session.channel_id } },
            })
            .projection(doc! { "_id": 1 })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        let Some(grant) = grant else {
            return Err(OAuthError::InvalidToken.into());
        };
        if user.is_none() {
            return Err(OAuthError::InvalidToken.into());
        }
        let grant_scopes = read_strings(&grant, "scopes")?;
        let scopes_ok = session.scopes.iter().all(|scope| {
            client.allowed_scopes.iter().any(|allowed| allowed == scope)
                && grant_scopes.iter().any(|allowed| allowed == scope)
                && scope_is_active(scope)
        });
        if !scopes_ok {
            return Err(OAuthError::InvalidToken.into());
        }
        Ok(session)
    }

    async fn upsert_grant(
        &self,
        user_id: &ObjectId,
        client_id: &str,
        channel_id: &str,
        scopes: &[String],
        now: DateTime,
    ) -> Result<Document, OAuthFailure> {
        self.grants()
            .find_one_and_update(
                doc! { "user_id": user_id, "client_id": client_id, "channel_id": channel_id },
                doc! {
                    "$addToSet": { "scopes": { "$each": scopes.to_vec() } },
                    "$set": { "revoked_at": Bson::Null, "updatedAt": now },
                    "$setOnInsert": { "createdAt": now, "__v": 0_i32 },
                },
            )
            .upsert(true)
            .return_document(mongodb::options::ReturnDocument::After)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?
            .ok_or(OAuthFailure::Runtime(RuntimeError::Mongo))
    }

    async fn insert_session(&self, input: SessionInsert) -> Result<IssuedSession, OAuthFailure> {
        let document = session_repository(&self.database)
            .insert(
                doc! {
                    "grant_id": input.grant_id,
                    "user_id": input.user_id,
                    "client_id": input.client_id,
                    "channel_id": input.channel_id,
                    "device_name": input.device_name,
                    "scopes": input.scopes,
                    "current_refresh_hash": input.current_refresh_hash,
                    "last_used_at": input.last_used_at,
                    "idle_expires_at": input.idle_expires_at,
                    "expires_at": input.expires_at,
                },
                input.last_used_at,
            )
            .await
            .map_err(map_persistence)?;
        issued_from_document(&document)
    }

    async fn insert_refresh_token(&self, token_hash: &str, session_id: &ObjectId, expires_at: DateTime) -> Result<(), OAuthFailure> {
        refresh_repository(&self.database)
            .insert(
                doc! { "token_hash": token_hash, "session_id": session_id, "expires_at": expires_at },
                DateTime::now(),
            )
            .await
            .map_err(map_persistence)?;
        Ok(())
    }

    async fn issue_refresh_and_response(
        &self,
        session: &IssuedSession,
        refresh: &str,
        refresh_hash: &str,
    ) -> Result<TokenResponse, OAuthFailure> {
        self.insert_refresh_token(refresh_hash, &session.id, session.expires_at).await?;
        self.token_response(session, refresh).await
    }

    async fn token_response(&self, session: &IssuedSession, refresh: &str) -> Result<TokenResponse, OAuthFailure> {
        let identity = AccessIdentity {
            session_id: session.id.to_hex(),
            user_id: session.user_id.to_hex(),
            client_id: session.client_id.clone(),
            channel_id: session.channel_id.clone(),
            scopes: session.scopes.clone(),
        };
        let access = secret("dima_at_")?;
        self.redis_set(&access_key(&access), &to_json(&identity)?, ACCESS_TTL_SECONDS).await?;
        let now = DateTime::now().timestamp_millis();
        Ok(TokenResponse {
            access_token: access,
            token_type: "Bearer",
            expires_in: ACCESS_TTL_SECONDS,
            refresh_token: refresh.to_owned(),
            scope: session.scopes.join(" "),
            session_id: identity.session_id,
            refresh_expires_in: refresh_expires_in(
                session.idle_expires_at.timestamp_millis(),
                session.expires_at.timestamp_millis(),
                now,
            ),
        })
    }

    async fn stamp_used(&self, id: &ObjectId, now: DateTime) -> Result<(), OAuthFailure> {
        self.refresh_tokens()
            .update_one(doc! { "_id": id }, doc! { "$set": { "used_at": now, "updatedAt": now } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        Ok(())
    }

    async fn revoke_session_oid(&self, id: &ObjectId, reason: &str) -> Result<(), OAuthFailure> {
        let now = DateTime::now();
        self.sessions()
            .update_one(
                doc! { "_id": id, "revoked_at": Bson::Null },
                doc! { "$set": { "revoked_at": now, "revoke_reason": reason, "updatedAt": now } },
            )
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))?;
        Ok(())
    }

    async fn revoke_or_original(&self, id: &ObjectId, reason: &str, error: OAuthFailure) -> OAuthFailure {
        match self.revoke_session_oid(id, reason).await {
            Ok(()) => error,
            Err(revoke_error) => revoke_error,
        }
    }

    async fn user_by_twitch(&self, twitch_id: &str) -> Result<Option<Document>, OAuthFailure> {
        self.users()
            .find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": twitch_id } } })
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Mongo))
    }

    async fn twitch_proof(&self, token: &str) -> Result<String, OAuthFailure> {
        let response = self
            .http
            .get(&self.validate_url)
            .header(reqwest::header::AUTHORIZATION, format!("OAuth {token}"))
            .timeout(TWITCH_VALIDATE_TIMEOUT)
            .send()
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::ValidateTransport))?;
        if !response.status().is_success() {
            return Err(OAuthError::LoginRequired.into());
        }
        let bytes = response.bytes().await.map_err(|_| OAuthFailure::Runtime(RuntimeError::ValidateTransport))?;
        if bytes.len() > VALIDATE_BODY_LIMIT {
            return Err(OAuthFailure::Runtime(RuntimeError::ValidateResponse));
        }
        let proof: Value = serde_json::from_slice(&bytes).map_err(|_| RuntimeError::ValidateResponse)?;
        let object = proof.as_object().ok_or(RuntimeError::ValidateResponse)?;
        let user_id = object.get("user_id").and_then(Value::as_str).filter(|value| !value.is_empty());
        let expires_ok = object.get("expires_in").and_then(Value::as_number).and_then(serde_json::Number::as_f64).is_some_and(|value| value.is_finite() && value > 0.0);
        if !client_id_matches(object.get("client_id"), &client_id_env()) || user_id.is_none() || !expires_ok {
            return Err(OAuthError::LoginRequired.into());
        }
        Ok(user_id.unwrap_or("").to_owned())
    }

    async fn redis_set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), OAuthFailure> {
        let mut connection = self.redis.clone();
        let _: () = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(ttl_seconds)
            .query_async(&mut connection)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Redis))?;
        Ok(())
    }

    async fn redis_present(&self, key: &str) -> Result<Option<String>, OAuthFailure> {
        let mut connection = self.redis.clone();
        let value: Option<String> = redis::cmd("GET")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Redis))?;
        Ok(value.filter(|text| !text.is_empty()))
    }

    async fn redis_present_getdel(&self, key: &str) -> Result<Option<String>, OAuthFailure> {
        let mut connection = self.redis.clone();
        let value: Option<String> = redis::cmd("GETDEL")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Redis))?;
        Ok(value.filter(|text| !text.is_empty()))
    }

    async fn redis_del(&self, key: &str) -> Result<(), OAuthFailure> {
        let mut connection = self.redis.clone();
        let _: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|_| OAuthFailure::Runtime(RuntimeError::Redis))?;
        Ok(())
    }

    fn clients(&self) -> Collection<Document> {
        oauth_client::schema().native_collection(&self.database)
    }

    fn grants(&self) -> Collection<Document> {
        oauth_grant::schema().native_collection(&self.database)
    }

    fn sessions(&self) -> Collection<Document> {
        oauth_session::schema().native_collection(&self.database)
    }

    fn refresh_tokens(&self) -> Collection<Document> {
        oauth_refresh_token::schema().native_collection(&self.database)
    }

    fn users(&self) -> Collection<Document> {
        users::schema().native_collection(&self.database)
    }
}

struct SessionInsert {
    grant_id: ObjectId,
    user_id: ObjectId,
    client_id: String,
    channel_id: String,
    device_name: String,
    scopes: Vec<String>,
    current_refresh_hash: String,
    last_used_at: DateTime,
    idle_expires_at: DateTime,
    expires_at: DateTime,
}

fn session_repository(database: &Database) -> SchemaRepository {
    oauth_session::schema().repository(database)
}

fn refresh_repository(database: &Database) -> SchemaRepository {
    oauth_refresh_token::schema().repository(database)
}

fn map_persistence(error: PersistenceError) -> OAuthFailure {
    match error {
        PersistenceError::Mongo(_) => OAuthFailure::Runtime(RuntimeError::Mongo),
        PersistenceError::Validation(_) | PersistenceError::MissingId | PersistenceError::NotFound => {
            OAuthFailure::Runtime(RuntimeError::Schema)
        }
    }
}

fn map_upsert(error: UpsertError) -> OAuthFailure {
    match error {
        UpsertError::Mongo(_) => OAuthFailure::Runtime(RuntimeError::Mongo),
        UpsertError::Preparation(_) | UpsertError::MissingResult => OAuthFailure::Runtime(RuntimeError::Schema),
    }
}

/// `NotWired` and `Failed` become the adapter-boundary 503, not source parity.
fn map_credits(error: CreditsError) -> OAuthFailure {
    match error {
        CreditsError::NotWired => RuntimeError::AdapterNotWired.into(),
        CreditsError::Failed => RuntimeError::Adapter.into(),
    }
}

/// `NotWired` and `Failed` become the adapter-boundary 503, not source parity.
/// `Settings` and `Pet` keep the source code and status.
fn map_pet(error: PetAccessError) -> OAuthFailure {
    match error {
        PetAccessError::NotWired => RuntimeError::AdapterNotWired.into(),
        PetAccessError::Failed => RuntimeError::Adapter.into(),
        PetAccessError::Settings { code, status } => ExternalFailure::settings(code, status).into(),
        PetAccessError::Pet { code, status } => ExternalFailure::pet(code, status).into(),
    }
}

fn issued_from_document(document: &Document) -> Result<IssuedSession, OAuthFailure> {
    Ok(IssuedSession {
        id: read_oid(document, "_id")?,
        user_id: read_oid(document, "user_id")?,
        client_id: read_string(document, "client_id")?,
        channel_id: read_string(document, "channel_id")?,
        scopes: read_strings(document, "scopes")?,
        idle_expires_at: read_date(document, "idle_expires_at")?,
        expires_at: read_date(document, "expires_at")?,
    })
}

fn connection_session(document: &Document) -> Result<ConnectionSession, OAuthFailure> {
    Ok(ConnectionSession {
        id: read_oid(document, "_id")?.to_hex(),
        client_id: read_string(document, "client_id")?,
        grant_id: read_oid(document, "grant_id")?.to_hex(),
        device_name: read_string(document, "device_name")?,
        scopes: read_strings(document, "scopes")?,
        last_used_at: required_date_json(document, "last_used_at")?,
        expires_at: required_date_json(document, "expires_at")?,
        created_at: optional_date_json(document, "createdAt")?,
    })
}

fn required_date_json(document: &Document, key: &str) -> Result<Value, OAuthFailure> {
    match document.get(key) {
        Some(Bson::DateTime(value)) => Ok(Value::String(iso_timestamp(value.timestamp_millis()))),
        Some(Bson::Null) => Ok(Value::Null),
        Some(_) => Err(RuntimeError::Schema.into()),
        None => Err(RuntimeError::Schema.into()),
    }
}

fn optional_date_json(document: &Document, key: &str) -> Result<Option<Value>, OAuthFailure> {
    match document.get(key) {
        None => Ok(None),
        Some(Bson::Null) => Ok(Some(Value::Null)),
        Some(Bson::DateTime(value)) => Ok(Some(Value::String(iso_timestamp(value.timestamp_millis())))),
        Some(_) => Err(RuntimeError::Schema.into()),
    }
}

fn insert_optional_string(body: &mut JsonMap<String, Value>, key: &str, document: &Document) -> Result<(), OAuthFailure> {
    match document.get(key) {
        None => Ok(()),
        Some(Bson::Null) => {
            body.insert(key.to_owned(), Value::Null);
            Ok(())
        }
        Some(Bson::String(value)) => {
            body.insert(key.to_owned(), Value::String(value.clone()));
            Ok(())
        }
        Some(_) => Err(RuntimeError::Schema.into()),
    }
}

fn insert_optional_date(body: &mut JsonMap<String, Value>, key: &str, document: &Document) -> Result<(), OAuthFailure> {
    if let Some(value) = optional_date_json(document, key)? {
        body.insert(key.to_owned(), value);
    }
    Ok(())
}

fn read_oid(document: &Document, key: &str) -> Result<ObjectId, OAuthFailure> {
    match document.get(key) {
        Some(Bson::ObjectId(id)) => Ok(*id),
        _ => Err(RuntimeError::Schema.into()),
    }
}

fn read_string(document: &Document, key: &str) -> Result<String, OAuthFailure> {
    match document.get(key) {
        Some(Bson::String(value)) => Ok(value.clone()),
        _ => Err(RuntimeError::Schema.into()),
    }
}

fn read_strings(document: &Document, key: &str) -> Result<Vec<String>, OAuthFailure> {
    match document.get(key) {
        Some(Bson::Array(items)) => items.iter().map(|item| match item {
            Bson::String(value) => Ok(value.clone()),
            _ => Err(OAuthFailure::Runtime(RuntimeError::Schema)),
        }).collect(),
        _ => Err(RuntimeError::Schema.into()),
    }
}

fn read_date(document: &Document, key: &str) -> Result<DateTime, OAuthFailure> {
    match document.get(key) {
        Some(Bson::DateTime(value)) => Ok(*value),
        _ => Err(RuntimeError::Schema.into()),
    }
}

fn required_client_string(document: &Document, key: &str) -> Result<String, OAuthFailure> {
    read_string(document, key).map_err(|_| OAuthError::InvalidClient.into())
}

fn required_client_strings(document: &Document, key: &str) -> Result<Vec<String>, OAuthFailure> {
    read_strings(document, key).map_err(|_| OAuthError::InvalidClient.into())
}

fn parse_oid(value: &str) -> Result<ObjectId, OAuthFailure> {
    ObjectId::parse_str(value).map_err(|_| OAuthFailure::Runtime(RuntimeError::MongoCast))
}

fn parse_stored<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, OAuthFailure> {
    serde_json::from_str(raw).map_err(|_| OAuthFailure::Runtime(RuntimeError::Json))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, OAuthFailure> {
    serde_json::to_string(value).map_err(|_| OAuthFailure::Runtime(RuntimeError::Json))
}

fn add_ms(now: DateTime, offset: i64) -> Result<DateTime, OAuthFailure> {
    let millis = now.timestamp_millis().checked_add(offset).ok_or(RuntimeError::Schema)?;
    Ok(DateTime::from_millis(millis))
}

fn str_refs(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).collect()
}

fn covers(allowed: &[String], requested: &[String]) -> bool {
    requested.iter().all(|scope| allowed.iter().any(|item| item == scope))
}

fn scope_is_active(scope: &str) -> bool {
    OAUTH_SCOPES.iter().any(|definition| definition.name == scope && definition.active)
}

fn required_str<'a>(input: &'a JsonMap<String, Value>, key: &str) -> Result<&'a str, OAuthError> {
    input.get(key).and_then(Value::as_str).ok_or(OAuthError::InvalidRequest)
}

fn bson_truthy(value: Option<&Bson>) -> bool {
    match value {
        None | Some(Bson::Null) => false,
        Some(_) => true,
    }
}

fn json_string_field(document: &Document, key: &str) -> JsonString {
    match document.get(key) {
        None => JsonString::Absent,
        Some(Bson::Null) => JsonString::Null,
        Some(Bson::String(value)) => JsonString::Text(value.clone()),
        Some(_) => JsonString::Absent,
    }
}

fn twitch_account<'a>(document: &'a Document, twitch_id: &str) -> Option<&'a Document> {
    let Bson::Array(accounts) = document.get("accounts")? else {
        return None;
    };
    accounts.iter().find_map(|item| {
        let Bson::Document(account) = item else {
            return None;
        };
        let type_ok = account.get("type").and_then(Bson::as_str) == Some("twitch");
        let id_ok = account.get("id").and_then(Bson::as_str) == Some(twitch_id);
        (type_ok && id_ok).then_some(account)
    })
}

fn client_id_env() -> ClientIdEnv {
    match std::env::var("CLIENT_ID") {
        Ok(value) => ClientIdEnv::Value(value),
        Err(std::env::VarError::NotPresent) => ClientIdEnv::Absent,
        Err(std::env::VarError::NotUnicode(_)) => ClientIdEnv::Invalid,
    }
}

fn client_id_matches(proof: Option<&Value>, env: &ClientIdEnv) -> bool {
    match (env, proof) {
        (ClientIdEnv::Invalid, _) => false,
        (ClientIdEnv::Absent, None) => true,
        (ClientIdEnv::Value(expected), Some(Value::String(actual))) => actual == expected,
        _ => false,
    }
}

