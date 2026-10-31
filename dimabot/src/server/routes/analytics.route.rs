//! Partial analytics route composition and follow-ledger reads.
use axum::{extract::{Path, RawQuery, State}, http::{header, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use futures_util::TryStreamExt;
use mongodb::{bson::{doc, Bson, Document, Regex}, Database};
use std::sync::Arc;
use crate::{api_admin::AdminService, api_auth::{AuthRequest, AuthService}, stream_timeline_route::{parse_query, Envelope, RouteError, StreamTimelineRouteService}, utils::twitch_streamers::{DirectoryError, TwitchStreamers}};

pub const FOLLOWS_PATH: &str = "/follows/{channelID}";
pub trait AnalyticsRouteData: Send + Sync {
    fn streamer<'a>(&'a self, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, Option<String>>;
    fn access<'a>(&'a self, requester: &'a str, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, (bool, String)>;
    fn rows<'a>(&'a self, filter: Document, order: i32, skip: u64, limit: u64) -> crate::stream_timeline_route::RouteFuture<'a, Vec<Document>>;
    fn count<'a>(&'a self, filter: Document) -> crate::stream_timeline_route::RouteFuture<'a, u64>;
}
struct MongoAnalyticsRouteData { database: Database, admin: AdminService, streamers: TwitchStreamers }
impl AnalyticsRouteData for MongoAnalyticsRouteData {
    fn streamer<'a>(&'a self, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, Option<String>> { Box::pin(async move { match self.streamers.metadata_by_id(channel).await { Ok(value) => Ok(Some(value.name)), Err(DirectoryError::Missing) => Ok(None), Err(error) => Err(fail(500, "Internal server error").with_error(&error)) } }) }
    fn access<'a>(&'a self, requester: &'a str, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, (bool, String)> { Box::pin(async move {
        let access = self.admin.get_channel_access_context(Some(requester), Some(channel), &["analytics:view".into()]).await.map_err(|error| fail(500, "Internal server error").with_error(&error))?; Ok((access.allowed, access.role.as_str().to_owned()))
    }) }
    fn rows<'a>(&'a self, filter: Document, order: i32, skip: u64, limit: u64) -> crate::stream_timeline_route::RouteFuture<'a, Vec<Document>> { Box::pin(async move {
        crate::schemas::follow_relationship_ledger::schema().native_collection(&self.database).find(filter).sort(doc! {"followed_at": order}).skip(skip).limit(limit as i64).projection(doc! {"follower_id": 1, "follower_login": 1, "follower_name": 1, "mutual": 1, "status": 1, "followed_at": 1, "ended_at": 1}).await.map_err(|error| fail(500, "Internal server error").with_error(&error))?.try_collect().await.map_err(|error| fail(500, "Internal server error").with_error(&error))
    }) }
    fn count<'a>(&'a self, filter: Document) -> crate::stream_timeline_route::RouteFuture<'a, u64> { Box::pin(async move { crate::schemas::follow_relationship_ledger::schema().native_collection(&self.database).count_documents(filter).await.map_err(|error| fail(500, "Internal server error").with_error(&error)) }) }
}
#[derive(Clone)]
pub struct AnalyticsRouteService { data: Arc<dyn AnalyticsRouteData>, timeline: StreamTimelineRouteService, logger: crate::utils::logger::Logger }
impl AnalyticsRouteService {
    pub fn new(database: Database, admin: AdminService, streamers: TwitchStreamers, logger: crate::utils::logger::Logger) -> Self { Self { timeline: StreamTimelineRouteService::new(database.clone(), admin.clone(), logger.clone()), data: Arc::new(MongoAnalyticsRouteData { database, admin, streamers }), logger } }
    pub fn from_data(data: Arc<dyn AnalyticsRouteData>, timeline: StreamTimelineRouteService, logger: crate::utils::logger::Logger) -> Self { Self { data, timeline, logger } }
    pub fn router(&self) -> Router { Router::new().route(FOLLOWS_PATH, get(follows)).route_layer(axum::middleware::from_fn_with_state((self.logger.clone(), "Follow analytics request failed"), crate::stream_timeline_route::log_route_failure)).with_state(self.clone()).merge(self.timeline.router()) }
    pub fn protected_router(&self, auth: &AuthService) -> Router { auth.protect(self.router()) }
    pub fn mounted_router(&self, mount: &str) -> Router { Router::new().nest(mount, self.router()) }
}
fn fail(status: u16, message: &'static str) -> RouteError { RouteError { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), message, envelope: Envelope::Standard, no_store: false, diagnostic: None } }
pub fn status_filter(text: Option<&str>) -> &'static str { match text.unwrap_or("").trim().to_ascii_lowercase().as_str() { "ended" => "ended", "all" => "all", _ => "active" } }
pub fn mutual_filter(text: Option<&str>) -> &'static str { match text.unwrap_or("").trim().to_ascii_lowercase().as_str() { "mutual" | "true" | "1" => "mutual", "non-mutual" | "non_mutual" | "false" | "0" => "non-mutual", _ => "all" } }
pub fn sort_order(text: Option<&str>) -> &'static str { if text.unwrap_or("").trim().eq_ignore_ascii_case("asc") { "asc" } else { "desc" } }
fn positive(text: Option<&str>, fallback: u64) -> u64 { text.map(|s| crate::utils::json_number::to_number(&serde_json::Value::String(s.to_owned()))).filter(|n| n.is_finite() && *n > 0.0).map(|n| n.floor() as u64).unwrap_or(fallback) }
pub fn normalize_search(text: &str) -> String { crate::utils::js_string::JsString::from(crate::utils::js_compat::trim(text)).slice(0, 64).to_utf8_lossy() }
fn escape_regex(s: &str) -> String { let mut out = String::new(); for ch in s.chars() { if ".*+?^${}()|[]\\".contains(ch) { out.push('\\'); } out.push(ch); } out }
async fn follows(State(service): State<AnalyticsRouteService>, Path(channel): Path<String>, RawQuery(raw): RawQuery, request: axum::extract::Request) -> Result<Response, RouteError> {
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &channel);
    let requester = AuthRequest::from_extensions(request.extensions()).user.map(|u| u.id).filter(|id| !id.is_empty()).ok_or_else(|| fail(401, "Authentication required"))?;
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &requester);
    let streamer = service.data.streamer(&channel).await?.ok_or_else(|| fail(404, "Streamer not found"))?;
    let (allowed, role) = service.data.access(&requester, &channel).await?;
    if !allowed { return Err(fail(403, "You do not have permission to view this analytics page")); }
    let params = parse_query(raw.as_deref());
    let status = status_filter(params.get("status").map(String::as_str));
    let mutual = mutual_filter(params.get("mutual").map(String::as_str));
    let order = sort_order(params.get("order").map(String::as_str));
    let search: String = params.get("search").map(|s| normalize_search(s)).unwrap_or_default();
    let page = positive(params.get("page").map(String::as_str), 1);
    let limit = positive(params.get("limit").map(String::as_str), 48).min(200);
    let skip = page.saturating_sub(1).saturating_mul(limit);
    let mut filter = doc! {"platform": "twitch", "followed_id": &channel};
    if status != "all" { filter.insert("status", status); }
    if mutual != "all" { filter.insert("mutual", mutual == "mutual"); }
    if !search.is_empty() { let regex = Bson::RegularExpression(Regex { pattern: escape_regex(&search), options: "i".into() });
        filter.insert("$or", vec![doc! {"follower_login": regex.clone()}, doc! {"follower_name": regex.clone()}, doc! {"follower_id": regex}]); }
    let rows = service.data.rows(filter.clone(), if order == "asc" { 1 } else { -1 }, skip, limit).await?;
    let total = service.data.count(filter).await?;
    let active = service.data.count(doc! {"platform": "twitch", "followed_id": &channel, "status": "active"}).await?;
    let mutual_count = service.data.count(doc! {"platform": "twitch", "followed_id": &channel, "status": "active", "mutual": true}).await?;
    let rows: Vec<Document> = rows.into_iter().map(|row| { let mut result = Document::new();
        for key in ["follower_id", "follower_login", "follower_name"] { if let Some(value) = row.get(key) { result.insert(key, value.clone()); } }
        result.insert("mutual", row.get_bool("mutual").unwrap_or(false));
        for key in ["status", "followed_at"] { if let Some(value) = row.get(key) { result.insert(key, value.clone()); } }
        result.insert("ended_at", row.get("ended_at").cloned().unwrap_or(Bson::Null)); result }).collect();
    let data = doc! {"role": role, "channelID": channel, "channelName": streamer,
        "filters": {"status": status, "mutual": mutual, "order": order, "search": search}, "rows": rows,
        "pagination": {"page": page as i64, "limit": limit as i64, "total": total as i64, "totalPages": ((total.saturating_add(limit - 1) / limit).max(1)) as i64},
        "summary": {"activeCount": active as i64, "mutualCount": mutual_count as i64, "nonMutualCount": active.saturating_sub(mutual_count) as i64}};
    let data = crate::utils::bson_js_json::bson_js_json_string(&Bson::Document(data)).map_err(|error| fail(500, "Internal server error").with_error(&error))?;
    let mut response = (StatusCode::OK, format!("{{\"error\":false,\"message\":\"Follow ledger fetched successfully\",\"status\":200,\"data\":{data}}}")).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json; charset=utf-8")); Ok(response)
}
