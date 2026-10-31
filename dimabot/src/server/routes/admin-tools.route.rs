//! Native `/admin/read-file`, composed with real authentication and owner gates.
use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use std::path::PathBuf;

pub const DEFAULT_ALLOWED_ROOTS: [&str; 2] = ["/home/cdom/saas/dimabot", "/home/cdom/saas/admin"];
pub const DENIED_MESSAGE: &str =
    "Path not allowed. Must be within /home/cdom/saas/dimabot or /home/cdom/saas/admin";

#[derive(Clone, Debug)]
pub struct AdminToolsRoute {
    allowed_roots: Vec<String>,
}
impl Default for AdminToolsRoute {
    fn default() -> Self {
        Self::new(
            DEFAULT_ALLOWED_ROOTS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
    }
}
impl AdminToolsRoute {
    /// Constructor performs no filesystem or network I/O.
    pub fn new(allowed_roots: Vec<String>) -> Self {
        Self { allowed_roots }
    }
    pub fn path_allowed(&self, path: &str) -> bool {
        let normalized = path.replace('\\', "/");
        self.allowed_roots
            .iter()
            .any(|root| normalized.starts_with(root))
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/read-file", get(read_file))
            .with_state(self.clone())
    }
    pub fn protected_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        auth.protect(crate::workspace_owner::protect_workspace_owner(
            self.router(),
        ))
    }
    pub fn mounted_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        Router::new().nest("/admin", self.protected_router(auth))
    }
}
async fn read_file(State(service): State<AdminToolsRoute>, RawQuery(query): RawQuery) -> Response {
    // URL form decoding matches the ordinary Express query-string path case.
    let path = query.and_then(|query| {
        reqwest::Url::parse(&format!("http://localhost/?{query}"))
            .ok()?
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned())
    });
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "Missing path parameter");
    };
    if !service.path_allowed(&path) {
        return error(StatusCode::FORBIDDEN, DENIED_MESSAGE);
    }
    match crate::utils::fs::read_file(PathBuf::from(&path)).await {
        Ok(content) => (StatusCode::OK, Json(json!({"error":false,"message":"File read successfully","status":200,"data":{"content":content,"path":path}}))).into_response(),
        Err(message) => { eprintln!("Error in GET /admin/read-file: path={path:?} error={message}"); error(StatusCode::INTERNAL_SERVER_ERROR, &message) }
    }
}
fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({"error":true,"message":message,"status":status.as_u16()})),
    )
        .into_response()
}
