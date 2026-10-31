//! Partial native stream timeline routes. See the handoff before integration.
use axum::{extract::{rejection::JsonRejection, FromRequestParts, Path, RawQuery, State}, http::{header, request::Parts, StatusCode}, response::{IntoResponse, Response}, routing::{get, put}, Json, Router};
use mongodb::{bson::{doc, Bson, Document}, Database};
use serde::Serialize;
use std::{collections::HashMap, future::Future, pin::Pin, sync::{Arc, Mutex}, time::Duration};
use crate::{api_admin::AdminService, api_auth::{authenticated_user, AuthService}, utils::stream_timeline::StreamTimelineService};

pub const STREAMS_PATH: &str = "/streams/{channelID}";
pub const STREAM_PATH: &str = "/streams/{channelID}/{sessionID}";
pub const INVALID_JSON_MESSAGE: &str = "Invalid JSON body";
#[derive(Clone, Copy, Debug)]
pub enum Envelope { Timeline, Standard }
#[derive(Clone, Debug)]
pub struct RouteError { pub status: StatusCode, pub message: &'static str, pub envelope: Envelope, pub no_store: bool, pub diagnostic: Option<String> }
impl RouteError {
    pub fn timeline(status: StatusCode, message: &'static str) -> Self { Self { status, message, envelope: Envelope::Timeline, no_store: false, diagnostic: None } }
    pub fn after_gate(mut self) -> Self { self.no_store = true; self }
    pub fn internal() -> Self { Self::timeline(StatusCode::INTERNAL_SERVER_ERROR, "Unable to load stream timeline") }
    pub fn with_error(mut self, error: &(dyn std::error::Error + 'static)) -> Self { self.diagnostic = Some(safe_error(error)); self }
}
impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message) }
}
impl std::error::Error for RouteError {}
#[derive(Clone, Debug)]
struct RouteDiagnostic(String);
/// A message containing any likely credential, URL or identifier is fully redacted.
pub fn safe_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut values = Vec::new(); let mut current = Some(error);
    while let Some(error) = current {
        let text = error.to_string(); let lower = text.to_ascii_lowercase();
        if ["://", "password", "secret", "bearer ", "token", "authorization"].iter().any(|word| lower.contains(word)) {
            values.push("sensitive diagnostic redacted".to_owned());
        } else { values.push(text); }
        if values.len() >= 8 { break; } current = error.source();
    }
    values.join(": ")
}
#[derive(Clone, Default)]
struct SensitiveIds(Arc<Mutex<Vec<String>>>);
pub fn remember_sensitive(extensions: &axum::http::Extensions, value: &str) {
    if value.is_empty() { return; }
    if let Some(ids) = extensions.get::<SensitiveIds>() {
        if let Ok(mut ids) = ids.0.lock() { ids.push(value.to_owned()); }
    }
}
pub fn redact_identifiers(message: &str, ids: &[String]) -> String {
    let mut output = message.to_owned();
    for id in ids.iter().filter(|id| !id.is_empty()) { output = output.replace(id, "[redacted]"); }
    output
}
/// Express's simple query parser turns repeated keys into arrays. String(array)
/// joins them with commas, including empty items; no axum query rejection occurs.
pub fn parse_query(raw: Option<&str>) -> HashMap<String, String> {
    let mut result: HashMap<String, String> = HashMap::new();
    let Ok(mut url) = reqwest::Url::parse("http://localhost/") else { return result; };
    url.set_query(raw);
    for (key, value) in url.query_pairs() {
        let (key, value) = if let Some((root, suffix)) = key.split_once('[') {
            if root.is_empty() { continue; }
            let array_index = suffix.strip_suffix(']').is_some_and(|index| index.is_empty() || index.bytes().all(|b| b.is_ascii_digit()));
            (root.to_owned(), if array_index { value.into_owned() } else { "[object Object]".to_owned() })
        } else if let Some((root, _)) = key.split_once(']') {
            if root.is_empty() { continue; }
            (root.to_owned(), "[object Object]".to_owned())
        } else { (key.into_owned(), value.into_owned()) };
        match result.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut entry) => { entry.get_mut().push(','); entry.get_mut().push_str(&value); }
            std::collections::hash_map::Entry::Vacant(entry) => { entry.insert(value); }
        }
    }
    result
}
#[derive(Serialize)]
pub struct TimelineErrorBody { pub error: bool, pub status: u16, pub message: &'static str }
#[derive(Serialize)]
pub struct StandardErrorBody { pub error: bool, pub message: &'static str, pub status: u16 }
impl IntoResponse for RouteError {
    fn into_response(self) -> Response {
        let body = match self.envelope {
            Envelope::Timeline => serde_json::to_string(&TimelineErrorBody { error: true, status: self.status.as_u16(), message: self.message }),
            Envelope::Standard => serde_json::to_string(&StandardErrorBody { error: true, message: self.message, status: self.status.as_u16() }),
        }.unwrap_or_else(|_| "{}".into());
        let mut response = (self.status, body).into_response();
        response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json; charset=utf-8"));
        if self.no_store { response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store")); }
        if let Some(diagnostic) = self.diagnostic { response.extensions_mut().insert(RouteDiagnostic(diagnostic)); }
        response
    }
}
pub fn valid_channel(value: &str) -> bool { (1..=30).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()) }
pub fn valid_object_id(value: &str) -> bool { value.len() == 24 && value.bytes().all(|b| b.is_ascii_hexdigit()) }
pub fn tier(value: Option<&str>) -> &'static str { match value { Some("pro") => "pro", Some("premium") => "premium", _ => "free" } }
pub fn can_see_credits(tier: &str, allowed: bool) -> bool { tier == "pro" && allowed }
pub fn parse_page(value: Option<&str>) -> Option<u64> {
    let Some(value) = value else { return Some(1); };
    let number = crate::utils::json_number::to_number(&serde_json::Value::String(value.to_owned()));
    (number.is_finite() && number.fract() == 0.0 && (1.0..=1000.0).contains(&number)).then_some(number as u64)
}
pub fn initial_gate(requester: Option<&str>, channel: &str) -> Result<(), RouteError> {
    if requester.is_none_or(str::is_empty) { return Err(RouteError::timeline(StatusCode::UNAUTHORIZED, "Authentication required")); }
    if !valid_channel(channel) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid channel")); }
    Ok(())
}
pub fn permission_gate(allowed: bool) -> Result<(), RouteError> {
    if !allowed { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "Analytics access required")); }
    Ok(())
}
/// Injectable gate and timeline-read boundary. The default adapter uses the
/// same concrete services and owner query as the original route.
pub type RouteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RouteError>> + Send + 'a>>;
pub trait TimelineRouteData: Send + Sync {
    fn permissions<'a>(&'a self, requester: &'a str, channel: &'a str) -> RouteFuture<'a, (bool, bool)>;
    fn owner<'a>(&'a self, channel: &'a str) -> RouteFuture<'a, Option<Document>>;
    fn list<'a>(&'a self, channel: &'a str, page: u64) -> RouteFuture<'a, Document>;
    fn session<'a>(&'a self, channel: &'a str, id: &'a str) -> RouteFuture<'a, Option<Document>>;
    fn timeline<'a>(&'a self, channel: &'a str, id: &'a str, tier: &'a str) -> RouteFuture<'a, Option<Document>>;
    fn rows<'a>(&'a self, collection: TimelineRows, filter: Document) -> RouteFuture<'a, Vec<Document>>;
    fn insert_marker<'a>(&'a self, filter: Document, update: Document) -> RouteFuture<'a, ()>;
    fn delete_marker<'a>(&'a self, filter: Document) -> RouteFuture<'a, ()>;
}
#[derive(Clone, Copy, Debug)]
pub enum TimelineRows { People, Moments, Credits }
struct MongoTimelineRouteData { database: Database, admin: AdminService, timeline: StreamTimelineService }
impl TimelineRouteData for MongoTimelineRouteData {
    fn permissions<'a>(&'a self, requester: &'a str, channel: &'a str) -> RouteFuture<'a, (bool, bool)> { Box::pin(async move {
        let permissions = vec!["analytics:view".to_owned(), "billing:view".to_owned()];
        let access = self.admin.get_channel_access_decisions(Some(requester), Some(channel), &permissions).await.map_err(|error| RouteError::internal().with_error(&error))?;
        Ok((access.allowed("analytics:view").unwrap_or(false), access.allowed("billing:view").unwrap_or(false)))
    }) }
    fn owner<'a>(&'a self, channel: &'a str) -> RouteFuture<'a, Option<Document>> { Box::pin(async move {
        crate::schemas::users::schema().native_collection(&self.database).find_one(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}}).projection(doc! {"plan_tier": 1, "polar_sh_customer_id": 1}).max_time(Duration::from_millis(1500)).await.map_err(|error| RouteError::internal().with_error(&error))
    }) }
    fn list<'a>(&'a self, channel: &'a str, page: u64) -> RouteFuture<'a, Document> { Box::pin(async move { self.timeline.list_timeline_streams(channel, page).await.map_err(|error| RouteError::internal().with_error(&error).after_gate()) }) }
    fn session<'a>(&'a self, channel: &'a str, id: &'a str) -> RouteFuture<'a, Option<Document>> { Box::pin(async move { self.timeline.get_timeline_session(channel, id).await.map_err(|error| RouteError::internal().with_error(&error).after_gate()) }) }
    fn timeline<'a>(&'a self, channel: &'a str, id: &'a str, tier: &'a str) -> RouteFuture<'a, Option<Document>> { Box::pin(async move { self.timeline.get_stream_timeline(channel, id, Some(tier)).await.map_err(|error| RouteError::internal().with_error(&error).after_gate()) }) }
    fn rows<'a>(&'a self, collection: TimelineRows, filter: Document) -> RouteFuture<'a, Vec<Document>> { Box::pin(async move {
        use futures_util::TryStreamExt;
        let (collection, sort, limit) = match collection {
            TimelineRows::People => (crate::schemas::stream_activity::aggregate_schema().native_collection(&self.database), doc! {"count": -1, "_id": 1}, 51),
            TimelineRows::Moments => (crate::schemas::stream_timeline::marker_schema().native_collection(&self.database), doc! {"occurredAt": 1, "_id": 1}, 101),
            TimelineRows::Credits => (crate::schemas::ai_usage_receipt::schema().native_collection(&self.database), doc! {"occurredAt": -1, "entryId": -1}, 101),
        };
        collection.find(filter).sort(sort).limit(limit).max_time(Duration::from_millis(1500)).await.map_err(|error| RouteError::internal().with_error(&error).after_gate())?.try_collect().await.map_err(|error| RouteError::internal().with_error(&error).after_gate())
    }) }
    fn insert_marker<'a>(&'a self, filter: Document, update: Document) -> RouteFuture<'a, ()> { Box::pin(async move {
        if let Err(error) = crate::schemas::stream_timeline::marker_schema().native_collection(&self.database).update_one(filter, update).upsert(true).await {
            if !crate::workers::stream_activity::capture::is_duplicate(&error) { return Err(RouteError::internal().with_error(&error).after_gate()); }
        }
        Ok(())
    }) }
    fn delete_marker<'a>(&'a self, filter: Document) -> RouteFuture<'a, ()> { Box::pin(async move {
        crate::schemas::stream_timeline::marker_schema().native_collection(&self.database).delete_one(filter).await.map_err(|error| RouteError::internal().with_error(&error).after_gate())?; Ok(())
    }) }
}
#[derive(Clone)]
pub struct StreamTimelineRouteService { pub database: Database, pub admin: AdminService, pub timeline: StreamTimelineService, pub logger: crate::utils::logger::Logger, data: Arc<dyn TimelineRouteData> }
impl StreamTimelineRouteService {
    pub fn new(database: Database, admin: AdminService, logger: crate::utils::logger::Logger) -> Self { let timeline = StreamTimelineService::new(database.clone()); let data = Arc::new(MongoTimelineRouteData { database: database.clone(), admin: admin.clone(), timeline: timeline.clone() }); Self { timeline, database, admin, logger, data } }
    pub fn with_data(mut self, data: Arc<dyn TimelineRouteData>) -> Self { self.data = data; self }
    /// Exposes the configured adapter for direct integration and isolated adapter checks.
    pub fn data(&self) -> Arc<dyn TimelineRouteData> { self.data.clone() }
    pub fn router(&self) -> Router {
        Router::new().route(STREAMS_PATH, get(list_streams)).route(STREAM_PATH, get(stream_details))
            .route("/streams/{channelID}/{sessionID}/compare/{otherID}", get(compare))
            .route("/streams/{channelID}/{sessionID}/people", get(people))
            .route("/streams/{channelID}/{sessionID}/moments", get(moments))
            .route("/streams/{channelID}/{sessionID}/credits", get(credits))
            .route("/streams/{channelID}/{sessionID}/markers/{markerID}", put(put_marker).delete(delete_marker))
            .route_layer(axum::middleware::from_fn_with_state((self.logger.clone(), "Stream timeline request failed"), log_route_failure))
            .with_state(self.clone())
    }
    pub fn protected_router(&self, auth: &AuthService) -> Router { auth.protect(self.router()) }
    pub fn mounted_router(&self, mount: &str) -> Router { Router::new().nest(mount, self.router()) }
}
/// The source logs thrown requests; never include owner/customer identifiers.
pub async fn log_route_failure(State((logger, message)): State<(crate::utils::logger::Logger, &'static str)>, mut request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let sensitive = SensitiveIds::default();
    request.extensions_mut().insert(sensitive.clone());
    let path = request.extensions().get::<axum::extract::MatchedPath>().map(|path| path.as_str().to_owned());
    let response = next.run(request).await;
    if response.status() == StatusCode::INTERNAL_SERVER_ERROR {
        use crate::utils::logger::{Destination, Level, LogOptions};
        let message = if message == "Stream summaries request failed" {
            if path.as_deref().is_some_and(|p| p.ends_with("/{summaryID}")) { "Error in GET /stream-summaries/:channelID/:summaryID:" }
            else { "Error in GET /stream-summaries/:channelID:" }
        } else { message };
        let diagnostic = response.extensions().get::<RouteDiagnostic>().map(|value| value.0.as_str()).unwrap_or("diagnostic unavailable");
        let diagnostic = match sensitive.0.lock() { Ok(ids) => redact_identifiers(diagnostic, &ids), Err(_) => "sensitive diagnostic redacted".to_owned() };
        let _ = logger.log(Level::Error, serde_json::json!({"message": message, "error": diagnostic}), LogOptions { destination: Destination::Console, ..Default::default() }).await;
    }
    response
}
pub struct TimelineContext { pub channel_id: String, pub can_annotate: bool, pub tier: &'static str, pub can_see_credits: bool, pub customer_id: Option<String> }
impl FromRequestParts<StreamTimelineRouteService> for TimelineContext {
    type Rejection = RouteError;
    async fn from_request_parts(parts: &mut Parts, state: &StreamTimelineRouteService) -> Result<Self, Self::Rejection> {
        let params = Path::<HashMap<String, String>>::from_request_parts(parts, state).await.map_err(|error| RouteError::internal().with_error(&error))?.0;
        let channel = params.get("channelID").cloned().unwrap_or_default();
        let requester = authenticated_user(&parts.extensions).map(|user| user.id.clone());
        remember_sensitive(&parts.extensions, &channel);
        if let Some(id) = requester.as_deref() { remember_sensitive(&parts.extensions, id); }
        initial_gate(requester.as_deref(), &channel)?;
        let requester = requester.ok_or_else(|| RouteError::timeline(StatusCode::UNAUTHORIZED, "Authentication required"))?;
        let (analytics, billing) = state.data.permissions(&requester, &channel).await?;
        permission_gate(analytics)?;
        let owner = state.data.owner(&channel).await?;
        let customer_id = owner.as_ref().and_then(|row| row.get_str("polar_sh_customer_id").ok()).map(str::to_owned);
        if let Some(id) = customer_id.as_deref() { remember_sensitive(&parts.extensions, id); }
        Ok(Self { can_annotate: requester == channel, tier: tier(owner.as_ref().and_then(|row| row.get_str("plan_tier").ok())), can_see_credits: billing, customer_id, channel_id: channel })
    }
}
fn success(data: Document) -> Result<Response, RouteError> {
    let json = crate::utils::bson_js_json::bson_js_json_string(&Bson::Document(data)).map_err(|error| RouteError::internal().with_error(&error).after_gate())?;
    let mut response = (StatusCode::OK, format!("{{\"error\":false,\"data\":{json}}}")).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json; charset=utf-8"));
    response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    Ok(response)
}
async fn list_streams(State(state): State<StreamTimelineRouteService>, context: TimelineContext, RawQuery(raw): RawQuery) -> Result<Response, RouteError> {
    let query = parse_query(raw.as_deref());
    let page = parse_page(query.get("page").map(String::as_str)).ok_or_else(|| RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid page").after_gate())?;
    let data = state.data.list(&context.channel_id, page).await?;
    success(data)
}
async fn stream_details(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>) -> Result<Response, RouteError> {
    let id = params.get("sessionID").map(String::as_str).unwrap_or("");
    if !valid_object_id(id) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid stream").after_gate()); }
    let mut data = state.data.timeline(&context.channel_id, id, context.tier).await?.ok_or_else(|| RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate())?;
    data.insert("canAnnotate", context.can_annotate);
    data.insert("canSeeCredits", can_see_credits(context.tier, context.can_see_credits));
    success(data)
}

async fn compare(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>) -> Result<Response, RouteError> {
    if context.tier == "free" { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "Comparison requires Premium").after_gate()); }
    let id = params.get("sessionID").map(String::as_str).unwrap_or("");
    let other = params.get("otherID").map(String::as_str).unwrap_or("");
    if !valid_object_id(id) || !valid_object_id(other) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid stream").after_gate()); }
    let mut data = state.data.timeline(&context.channel_id, other, context.tier).await?.ok_or_else(|| RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate())?;
    if state.data.session(&context.channel_id, id).await?.is_none() { return Err(RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate()); }
    data.insert("canAnnotate", false); success(data)
}
fn marker_id_valid(value: &str) -> bool { (16..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
async fn put_marker(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>, body: Result<Json<serde_json::Value>, JsonRejection>) -> Result<Response, RouteError> {
    let Ok(Json(body)) = body else { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, INVALID_JSON_MESSAGE)); };
    if !context.can_annotate { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "Only the channel owner can add markers").after_gate()); }
    let id = params.get("sessionID").map(String::as_str).unwrap_or(""); let key = params.get("markerID").map(String::as_str).unwrap_or("");
    let label = body.get("label").and_then(serde_json::Value::as_str).map(crate::utils::js_compat::trim).unwrap_or("");
    let seconds = body.get("offsetSeconds").and_then(serde_json::Value::as_f64);
    if !valid_object_id(id) || !marker_id_valid(key) || label.is_empty() || label.encode_utf16().count() > 120 || !seconds.is_some_and(|value| value.is_finite() && value >= 0.0) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid marker").after_gate()); }
    let session = state.data.session(&context.channel_id, id).await?.ok_or_else(|| RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate())?;
    let started = session.get_datetime("started_at").map_err(|error| RouteError::internal().with_error(&error).after_gate())?.timestamp_millis();
    // JavaScript constructs a Date before comparing it with the stream end.
    // TimeClip truncates fractional milliseconds and rejects invalid dates.
    let at = crate::utils::credit_policy::JsDate::from_millis(started as f64 + seconds.unwrap_or(0.0) * 1000.0).timestamp_millis();
    let end = session.get_datetime("ended_at").map(|v| v.timestamp_millis()).unwrap_or_else(|_| mongodb::bson::DateTime::now().timestamp_millis());
    if at.is_some_and(|at| at > end) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Marker must be within the stream").after_gate()); }
    // An invalid Date compares false in JS, then Mongoose rejects it on update.
    let at = at.ok_or_else(|| RouteError::internal().after_gate())?;
    let session_id = session.get_object_id("_id").map_err(|error| RouteError::internal().with_error(&error).after_gate())?;
    state.data.insert_marker(doc! {"channelID": &context.channel_id, "session_id": session_id, "key": format!("note:{key}")},
        doc! {"$setOnInsert": {"kind": "note", "label": label, "occurredAt": mongodb::bson::DateTime::from_millis(at), "expiresAt": mongodb::bson::DateTime::from_millis(started.saturating_add(crate::utils::stream_timeline::TIMELINE_RETENTION_MS))}}).await?;
    success(doc! {"saved": true})
}
async fn delete_marker(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>) -> Result<Response, RouteError> {
    if !context.can_annotate { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "Only the channel owner can remove markers").after_gate()); }
    let id = params.get("sessionID").map(String::as_str).unwrap_or(""); let marker = params.get("markerID").map(String::as_str).unwrap_or("");
    if !valid_object_id(id) || !valid_object_id(marker) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid marker").after_gate()); }
    let session_id = mongodb::bson::oid::ObjectId::parse_str(id).map_err(|error| RouteError::internal().with_error(&error).after_gate())?;
    let marker_id = mongodb::bson::oid::ObjectId::parse_str(marker).map_err(|error| RouteError::internal().with_error(&error).after_gate())?;
    state.data.delete_marker(doc! {"_id": marker_id, "channelID": &context.channel_id, "session_id": session_id, "kind": "note"}).await?;
    success(doc! {"deleted": true})
}

fn session_param(params: &HashMap<String, String>) -> Result<&str, RouteError> {
    let id = params.get("sessionID").map(String::as_str).unwrap_or("");
    if !valid_object_id(id) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid stream").after_gate()); }
    Ok(id)
}
fn object_id(value: &str) -> Result<mongodb::bson::oid::ObjectId, RouteError> { mongodb::bson::oid::ObjectId::parse_str(value).map_err(|error| RouteError::internal().after_gate().with_error(&error)) }
fn db_time(row: &Document, name: &str) -> Result<mongodb::bson::DateTime, RouteError> { row.get_datetime(name).copied().map_err(|error| RouteError::internal().after_gate().with_error(&error)) }
fn copy_field(source: &Document, target: &mut Document, from: &str, to: &str) { if let Some(value) = source.get(from) { target.insert(to, value.clone()); } }
async fn people(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>, RawQuery(raw): RawQuery) -> Result<Response, RouteError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    if context.tier != "pro" { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "User breakdown requires Pro").after_gate()); }
    let query = parse_query(raw.as_deref());
    let id = params.get("sessionID").map(String::as_str).unwrap_or("");
    let kind = query.get("kind").map(String::as_str).unwrap_or(""); let key = query.get("key").map(String::as_str).unwrap_or("");
    if !valid_object_id(id) || !matches!(kind, "command" | "emote") || key.is_empty() || key.encode_utf16().count() > 100 { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid breakdown").after_gate()); }
    if state.data.session(&context.channel_id, id).await?.is_none() { return Err(RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate()); }
    let mut filter = doc! {"channelID": &context.channel_id, "session_id": object_id(id)?, "scope": "actor", "kind": kind, "key": key, "expiresAt": {"$gt": mongodb::bson::DateTime::now()}};
    if let Some(cursor) = query.get("cursor").filter(|v| !v.is_empty()) {
        let invalid = || RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid cursor").after_gate();
        if cursor.len() > 256 { return Err(invalid()); }
        let raw = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
        let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        let count = value.get("count").and_then(serde_json::Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0).ok_or_else(invalid)?;
        let after = value.get("id").and_then(serde_json::Value::as_str).filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).ok_or_else(invalid)?;
        filter.insert("$or", vec![doc! {"count": {"$lt": count}}, doc! {"count": count, "_id": {"$gt": after}}]);
    }
    let rows = state.data.rows(TimelineRows::People, filter).await?;
    let mut items = Vec::new();
    for row in rows.iter().take(50) { let mut item = Document::new(); for (from, to) in [("actor", "id"), ("label", "label"), ("count", "count"), ("failures", "errors")] { copy_field(row, &mut item, from, to); } items.push(item); }
    let cursor = if rows.len() > 50 { let last = &rows[49]; let count = last.get("count").cloned().unwrap_or(Bson::Null); let key = last.get_str("_id").map_err(|error| RouteError::internal().with_error(&error).after_gate())?;
        let payload = crate::utils::bson_js_json::bson_js_json_string(&Bson::Document(doc! {"count": count, "id": key})).map_err(|error| RouteError::internal().with_error(&error).after_gate())?; Bson::String(URL_SAFE_NO_PAD.encode(payload.as_bytes())) } else { Bson::Null };
    success(doc! {"items": items, "cursor": cursor})
}
async fn moments(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>, RawQuery(raw): RawQuery) -> Result<Response, RouteError> {
    let query = parse_query(raw.as_deref());
    let id = session_param(&params)?;
    let session = state.data.session(&context.channel_id, id).await?.ok_or_else(|| RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate())?;
    let started = db_time(&session, "started_at")?.timestamp_millis();
    let end = session.get_datetime("ended_at").map(|v| v.timestamp_millis()).ok().filter(|v| *v != 0).unwrap_or_else(|| mongodb::bson::DateTime::now().timestamp_millis());
    let number = |key: &str, default: f64| -> f64 { query.get(key).map(|v| crate::utils::json_number::to_number(&serde_json::Value::String(v.clone()))).unwrap_or(default) };
    let from = number("from", 0.0); let to = number("to", (end as f64 - started as f64) / 1000.0);
    if !from.is_finite() || !to.is_finite() || from < 0.0 || to < from || to > 90.0 * 86400.0 { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid time range").after_gate()); }
    let kind = query.get("kind").map(String::as_str).filter(|v| !v.is_empty()).unwrap_or("all");
    if !["all", "note", "redemption", "follow", "sub", "gift", "bits", "raid"].contains(&kind) { return Err(RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid kind").after_gate()); }
    let mut filter = doc! {"channelID": &context.channel_id, "session_id": object_id(id)?, "occurredAt": {"$gte": mongodb::bson::DateTime::from_millis((started as f64 + from * 1000.0) as i64), "$lte": mongodb::bson::DateTime::from_millis((started as f64 + to * 1000.0) as i64)}, "expiresAt": {"$gt": mongodb::bson::DateTime::now()}};
    if kind != "all" { filter.insert("kind", kind); }
    if let Some(cursor) = query.get("cursor").filter(|v| !v.is_empty()) {
        let invalid = || RouteError::timeline(StatusCode::BAD_REQUEST, "Invalid cursor").after_gate();
        let parts: Vec<_> = cursor.split('|').collect();
        if parts.len() != 2 || !valid_object_id(parts[1]) { return Err(invalid()); }
        let at = crate::utils::js_date::parse_date(parts[0]).map(mongodb::bson::DateTime::from_millis).ok_or_else(invalid)?;
        let id = object_id(parts[1])?;
        filter.insert("$or", vec![doc! {"occurredAt": {"$gt": at}}, doc! {"occurredAt": at, "_id": {"$gt": id}}]);
    }
    let rows = state.data.rows(TimelineRows::Moments, filter).await?;
    let mut events = Vec::new(); for row in rows.iter().take(100) { let mut event = doc! {"id": row.get_object_id("_id").map_err(|error| RouteError::internal().with_error(&error).after_gate())?.to_hex()};
        copy_field(row, &mut event, "kind", "kind"); event.insert("offsetSeconds", (db_time(row, "occurredAt")?.timestamp_millis() as f64 - started as f64) / 1000.0);
        for field in ["label", "value", "rewardID", "cost", "status"] { copy_field(row, &mut event, field, field); } events.push(event); }
    let cursor = if rows.len() > 100 { let last = &rows[99]; let at = db_time(last, "occurredAt")?.try_to_rfc3339_string().map_err(|error| RouteError::internal().with_error(&error).after_gate())?.replace("+00:00", "Z");
        Bson::String(format!("{}|{}", at, last.get_object_id("_id").map_err(|error| RouteError::internal().with_error(&error).after_gate())?.to_hex())) } else { Bson::Null };
    success(doc! {"events": events, "cursor": cursor})
}
async fn credits(State(state): State<StreamTimelineRouteService>, context: TimelineContext, Path(params): Path<HashMap<String, String>>) -> Result<Response, RouteError> {
    if context.tier != "pro" || !context.can_see_credits { return Err(RouteError::timeline(StatusCode::FORBIDDEN, "Pro and billing access required").after_gate()); }
    let id = session_param(&params)?;
    let session = state.data.session(&context.channel_id, id).await?.ok_or_else(|| RouteError::timeline(StatusCode::NOT_FOUND, "Stream unavailable").after_gate())?;
    let started = db_time(&session, "started_at")?; let end = session.get_datetime("ended_at").copied().unwrap_or_else(|_| mongodb::bson::DateTime::now());
    let rows: Vec<Document> = if let Some(customer) = context.customer_id.filter(|v| !v.is_empty()) {
        state.data.rows(TimelineRows::Credits, doc! {"channelID": &context.channel_id, "customerId": customer, "occurredAt": {"$gte": started, "$lt": end}, "expiresAt": {"$gt": mongodb::bson::DateTime::now()}}).await?
    } else { Vec::new() };
    let mut items = Vec::new(); for row in rows.iter().take(100) { let mut item = Document::new(); copy_field(row, &mut item, "entryId", "id"); item.insert("offsetSeconds", (db_time(row, "occurredAt")?.timestamp_millis() as f64 - started.timestamp_millis() as f64) / 1000.0);
        for field in ["category", "operation", "provider", "model", "credits", "entryKind"] { copy_field(row, &mut item, field, field); } items.push(item); }
    success(doc! {"items": items, "truncated": rows.len() > 100})
}
