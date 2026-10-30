//! Working native port of `dimabot/src/middleware/workspace-owner.middleware.ts`.
//!
//! [`workspace_owner_middleware`] is a stateless Axum middleware: the internal
//! workspace tools are available only to the single account id `533538623`, and
//! every other request — including one without an authenticated identity —
//! receives the exact `403 { error, message, status }` body with no trailing
//! `next()` call. [`WORKSPACE_OWNER_TWITCH_USER_ID`] shares the admin
//! middleware's creator constant.

use crate::api_auth::AuthRequest;
use axum::{
    Json, Router,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

/// The only account allowed into the internal workspace tools.
pub const WORKSPACE_OWNER_TWITCH_USER_ID: &str = crate::api_admin::CREATOR_TWITCH_USER_ID;

/// The workspace middleware's JSON refusal: `{ error, message, status }`.
///
/// The source returns no `type` field, unlike the authentication middlewares.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceAccessErrorBody {
    pub error: bool,
    pub message: String,
    pub status: u16,
}

impl WorkspaceAccessErrorBody {
    pub fn denied() -> Self {
        Self {
            error: true,
            message: "Admin workspace access required".to_owned(),
            status: 403,
        }
    }
}

fn is_workspace_owner(user_id: Option<&str>) -> bool {
    user_id == Some(WORKSPACE_OWNER_TWITCH_USER_ID)
}

/// Axum middleware for the internal workspace tools.
pub async fn workspace_owner_middleware(request: Request, next: Next) -> Response {
    let user_id = AuthRequest::from_extensions(request.extensions())
        .user
        .map(|user| user.id);
    if !is_workspace_owner(user_id.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(WorkspaceAccessErrorBody::denied()),
        )
            .into_response();
    }
    next.run(request).await
}

/// Applies [`workspace_owner_middleware`] to every route in `router`.
///
/// Mount the authentication layer outside this one so the identity is already
/// in the request extensions when this middleware runs.
pub fn protect_workspace_owner<S>(router: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(middleware::from_fn(workspace_owner_middleware))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_admin::CREATOR_TWITCH_USER_ID;
    use serde_json::json;

    #[test]
    fn the_workspace_owner_is_the_admin_whitelist_creator() {
        assert_eq!(WORKSPACE_OWNER_TWITCH_USER_ID, CREATOR_TWITCH_USER_ID);
        assert!(is_workspace_owner(Some(WORKSPACE_OWNER_TWITCH_USER_ID)));
        assert!(!is_workspace_owner(Some("1234")));
        assert!(!is_workspace_owner(Some("")));
        assert!(!is_workspace_owner(None));
    }

    #[test]
    fn the_refusal_body_has_no_type_field() {
        assert_eq!(
            serde_json::to_value(WorkspaceAccessErrorBody::denied()).unwrap(),
            json!({"error": true, "message": "Admin workspace access required", "status": 403})
        );
    }
}
