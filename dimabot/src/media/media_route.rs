//! Native `GET /:mediaID` from `server/routes/media.route.ts`. It queries the
//! existing media asset collection and redirects to the configured S3 public URL
//! or stored URL, preserving the source's unauthenticated lookup and 307 status.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use mongodb::{Database, bson::{doc, oid::ObjectId}};
use serde::Serialize;
use crate::{schemas::media_asset, utils::s3::S3Settings};

/// Concrete handles used by the media redirect route; construction performs no I/O.
#[derive(Clone)]
pub struct MediaRouteService {
    database: Database,
    storage: S3Settings,
}

impl MediaRouteService {
    /// Construct from a caller-provided Mongo database and storage settings.
    pub fn new(database: Database, storage: S3Settings) -> Self {
        Self { database, storage }
    }
    /// Create the router-relative media redirect route.
    pub fn router(&self) -> Router {
        Router::new().route("/{mediaID}", get(redirect_media)).with_state(self.clone())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: bool,
    message: &'static str,
    status: u16,
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorBody { error: true, message, status: status.as_u16() })).into_response()
}

async fn redirect_media(State(service): State<MediaRouteService>, Path(id): Path<String>) -> Response {
    if id.is_empty() { return error(StatusCode::BAD_REQUEST, "mediaID is required"); }
    let Ok(id) = ObjectId::parse_str(&id) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    let result = media_asset::collection(&service.database)
        .find_one(doc! { "_id": id, "deletedAt": null })
        .projection(doc! { "s3Key": 1, "storageUrl": 1 })
        .await;
    let document = match result {
        Ok(Some(document)) => document,
        Ok(None) => return error(StatusCode::NOT_FOUND, "Media not found"),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let key = document.get_str("s3Key").ok().filter(|value| !value.is_empty());
    let destination = key.map(|key| service.storage.public_object_url(key))
        .or_else(|| document.get_str("storageUrl").ok().filter(|value| !value.is_empty()).map(str::to_owned));
    let Some(destination) = destination else {
        return error(StatusCode::NOT_FOUND, "Media URL not found");
    };
    let Ok(location) = axum::http::HeaderValue::from_str(&destination) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    (StatusCode::TEMPORARY_REDIRECT, [(header::CACHE_CONTROL, axum::http::HeaderValue::from_static("private, no-store")), (header::LOCATION, location)]).into_response()
}
