//! Native stream-summary route service. See handoff for pending verification.
use axum::{extract::{Path, RawQuery, State}, http::{header, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use futures_util::TryStreamExt;
use mongodb::{bson::{doc, Bson, Document, oid::ObjectId}, Database};
use std::sync::Arc;
use crate::{api_admin::AdminService, api_auth::{AuthRequest, AuthService}, stream_timeline_route::{parse_query, Envelope, RouteError}};

pub const SUMMARIES_PATH: &str = "/{channelID}";
pub const SUMMARY_PATH: &str = "/{channelID}/{summaryID}";
pub trait SummaryRouteData: Send + Sync {
    fn access<'a>(&'a self, requester: &'a str, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, bool>;
    fn list<'a>(&'a self, filter: Document, limit: i64, skip: u64) -> crate::stream_timeline_route::RouteFuture<'a, (Vec<Document>, u64)>;
    fn details<'a>(&'a self, filter: Document) -> crate::stream_timeline_route::RouteFuture<'a, Option<Document>>;
}
struct MongoSummaryRouteData { database: Database, admin: AdminService }
impl SummaryRouteData for MongoSummaryRouteData {
    fn access<'a>(&'a self, requester: &'a str, channel: &'a str) -> crate::stream_timeline_route::RouteFuture<'a, bool> { Box::pin(async move {
        if self.admin.has_global_channel_owner_access(Some(requester), Some(channel)).await.map_err(|error| fail(500, "Internal server error").with_error(&error))? { return Ok(true); }
        let admin = self.admin.collection().find_one(doc! {"channelID": channel, "adminID": requester, "actived": true, "permissions": {"$in": ["*", "summaries:view"]}}).await.map_err(|error| fail(500, "Internal server error").with_error(&error))?;
        Ok(admin.is_some())
    }) }
    fn list<'a>(&'a self, filter: Document, limit: i64, skip: u64) -> crate::stream_timeline_route::RouteFuture<'a, (Vec<Document>, u64)> { Box::pin(async move {
        let collection = crate::schemas::channel_stream_summary::schema().native_collection(&self.database);
        let rows: Vec<Document> = collection.find(filter.clone()).sort(doc! {"ended_at": -1}).skip(skip).limit(limit).await.map_err(|error| fail(500, "Internal server error").with_error(&error))?.try_collect().await.map_err(|error| fail(500, "Internal server error").with_error(&error))?;
        let total = collection.count_documents(filter).await.map_err(|error| fail(500, "Internal server error").with_error(&error))?; Ok((rows, total))
    }) }
    fn details<'a>(&'a self, filter: Document) -> crate::stream_timeline_route::RouteFuture<'a, Option<Document>> { Box::pin(async move {
        crate::schemas::channel_stream_summary::schema().native_collection(&self.database).find_one(filter).await.map_err(|error| fail(500, "Internal server error").with_error(&error))
    }) }
}
#[derive(Clone)]
pub struct StreamSummaryRouteService { logger: crate::utils::logger::Logger, data: Arc<dyn SummaryRouteData> }
impl StreamSummaryRouteService {
    pub fn new(database: Database, admin: AdminService, logger: crate::utils::logger::Logger) -> Self { Self { data: Arc::new(MongoSummaryRouteData { database, admin }), logger } }
    pub fn with_data(mut self, data: Arc<dyn SummaryRouteData>) -> Self { self.data = data; self }
    pub fn router(&self) -> Router { Router::new().route(SUMMARIES_PATH, get(list)).route(SUMMARY_PATH, get(details)).route_layer(axum::middleware::from_fn_with_state((self.logger.clone(), "Stream summaries request failed"), crate::stream_timeline_route::log_route_failure)).with_state(self.clone()) }
    pub fn protected_router(&self, auth: &AuthService) -> Router { auth.protect(self.router()) }
    pub fn mounted_router(&self, mount: &str) -> Router { Router::new().nest(mount, self.router()) }
    async fn check_access(&self, requester: &str, channel: &str) -> Result<bool, RouteError> {
        if requester == channel { return Ok(true); }
        self.data.access(requester, channel).await
    }
}
fn fail(status: u16, message: &'static str) -> RouteError { RouteError { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), message, envelope: Envelope::Standard, no_store: false, diagnostic: None } }
fn response(message: &str, data: Bson) -> Result<Response, RouteError> {
    let data = crate::utils::bson_js_json::bson_js_json_string(&data).map_err(|error| fail(500, "Internal server error").with_error(&error))?;
    let mut response = (StatusCode::OK, format!("{{\"error\":false,\"message\":\"{message}\",\"status\":200,\"data\":{data}}}")).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json; charset=utf-8")); Ok(response)
}
pub fn summary_pagination(query: &std::collections::HashMap<String, String>) -> Result<(i64, u64), RouteError> {
    let number = |key: &str, default: f64| query.get(key).filter(|value| !value.is_empty())
        .map(|value| crate::utils::json_number::to_number(&serde_json::Value::String(value.clone()))).unwrap_or(default);
    let limit = number("limit", 10.0);
    let skip = number("skip", 0.0).max(0.0);
    if limit.is_nan() || !skip.is_finite() || number("skip", 0.0).is_nan() { return Err(fail(500, "Internal server error").with_error(&std::io::Error::other("invalid pagination number"))); }
    Ok((limit.clamp(1.0, 100.0) as i64, skip as u64))
}
fn user(request: AuthRequest) -> Result<String, RouteError> { request.user.map(|u| u.id).filter(|id| !id.is_empty()).ok_or_else(|| fail(401, "Authentication required")) }
async fn list(State(service): State<StreamSummaryRouteService>, Path(channel): Path<String>, RawQuery(raw): RawQuery, request: axum::extract::Request) -> Result<Response, RouteError> {
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &channel);
    let requester = user(AuthRequest::from_extensions(request.extensions()))?;
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &requester);
    let channel = crate::utils::js_compat::trim(&channel);
    if !service.check_access(&requester, channel).await? { return Err(fail(403, "Forbidden: access denied")); }
    let query = parse_query(raw.as_deref());
    let (limit, skip) = summary_pagination(&query)?;
    let mut filter = doc! {"channelID": channel};
    if let Some(status) = query.get("status").map(|v| crate::utils::js_compat::trim(v)).filter(|v| !v.is_empty()) { filter.insert("status", status); }
    let (rows, total) = service.data.list(filter, limit, skip).await?;
    response("Stream summaries fetched successfully", Bson::Document(doc! {"items": rows, "total": total as i64}))
}
async fn details(State(service): State<StreamSummaryRouteService>, Path((channel, summary)): Path<(String, String)>, request: axum::extract::Request) -> Result<Response, RouteError> {
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &channel);
    let requester = user(AuthRequest::from_extensions(request.extensions()))?;
    crate::stream_timeline_route::remember_sensitive(request.extensions(), &requester);
    let channel = crate::utils::js_compat::trim(&channel);
    if !service.check_access(&requester, channel).await? { return Err(fail(403, "Forbidden: access denied")); }
    let id = ObjectId::parse_str(crate::utils::js_compat::trim(&summary)).map_err(|_| fail(400, "Invalid summary ID"))?;
    let row = service.data.details(doc! {"_id": id, "channelID": channel}).await?.ok_or_else(|| fail(404, "Stream summary not found"))?;
    response("Stream summary fetched successfully", Bson::Document(row))
}
