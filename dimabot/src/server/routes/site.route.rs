//! Native site event routes. See the handoff for remaining behavior boundaries,
//! including error logging and Mongoose casting.
use crate::utils::eventsub::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::Response,
    routing::{get, post},
};
use futures_util::TryStreamExt;
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    options::ReturnDocument,
};
use redis::aio::ConnectionManager;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, time::Duration};

pub const ROOT_PATH: &str = "/";
pub const EVENTS_PATH: &str = "/events";
pub const EVENT_ID_PATH: &str = "/events/{id}";
/// The TypeScript application installs `express.json()` at app level before
/// mounting `/site`, and it registers no Express error-handling middleware, so a
/// malformed body is answered by Express's default error handler with status 400
/// and an HTML body. The native port keeps the status and uses this repository's
/// JSON error envelope instead of the HTML page.
pub const INVALID_JSON_MESSAGE: &str = "Invalid JSON body";
pub fn canonicalize_eventsub_type(kind: &str) -> &str {
    if LEGACY_BITS_EVENT_TYPES.contains(&kind) {
        CANONICAL_BITS_EVENT_TYPE
    } else {
        kind
    }
}
pub fn get_equivalent_eventsub_types(kind: &str) -> Vec<&str> {
    let canonical = canonicalize_eventsub_type(kind);
    if canonical == CANONICAL_BITS_EVENT_TYPE {
        std::iter::once(CANONICAL_BITS_EVENT_TYPE)
            .chain(LEGACY_BITS_EVENT_TYPES)
            .collect()
    } else {
        vec![canonical]
    }
}
#[derive(Serialize)]
pub struct ErrorBody<'a> {
    pub error: bool,
    pub message: &'a str,
    pub status: u16,
}
#[derive(Serialize)]
pub struct DataBody<T> {
    pub error: bool,
    pub data: T,
}
#[derive(Serialize)]
pub struct CreatedBody<T> {
    pub error: bool,
    pub message: &'static str,
    pub data: T,
}
fn json_response(status: StatusCode, body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}
fn failure(status: StatusCode, message: &str) -> Response {
    let body = serde_json::to_string(&ErrorBody {
        error: true,
        message,
        status: status.as_u16(),
    })
    .unwrap_or_else(|_| "{}".into());
    json_response(status, body)
}
fn internal() -> Response {
    failure(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// Concrete handles, with no network access during construction.
#[derive(Clone)]
pub struct SiteRouteService {
    _redis: ConnectionManager,
    database: Database,
    logger: crate::utils::logger::Logger,
    deadline: Duration,
}
impl SiteRouteService {
    pub fn new(
        redis: ConnectionManager,
        database: Database,
        logger: crate::utils::logger::Logger,
    ) -> Self {
        Self {
            _redis: redis,
            database,
            logger,
            deadline: Duration::from_secs(12),
        }
    }
    pub async fn from_runtime(
        database_name: &str,
        logger: crate::utils::logger::Logger,
    ) -> Result<Self, crate::utils::siteanalytics::SiteAnalyticsError> {
        if database_name.trim().is_empty() {
            return Err(crate::utils::siteanalytics::SiteAnalyticsError::Configuration);
        }
        let redis = crate::utils::redis::get_redis_client()
            .await
            .map_err(|_| crate::utils::siteanalytics::SiteAnalyticsError::Runtime)?;
        let mongo = crate::utils::mongo::get_mongo_client()
            .await
            .map_err(|_| crate::utils::siteanalytics::SiteAnalyticsError::Runtime)?;
        Ok(Self::new(redis, mongo.database(database_name), logger))
    }
    async fn log_failure(&self, message: &str, id: Option<&str>, body: Option<&Value>) {
        emit_site_failure(&self.logger, message, id, body).await;
    }
    async fn log_type_failure(&self, kind: &str, message: &str) {
        use crate::utils::logger::{Destination, Level, LogOptions};
        let now = mongodb::bson::DateTime::now().timestamp_millis();
        let mut payload = failure_log_payload(
            message,
            None,
            None,
            &crate::domain_event_contracts::time::native_date_iso(now),
        );
        if let Some(fields) = payload.as_object_mut() {
            fields.insert("type".into(), Value::String(kind.to_owned()));
        }
        let _ = self
            .logger
            .log(
                Level::Error,
                payload,
                LogOptions {
                    destination: Destination::Both,
                    ..Default::default()
                },
            )
            .await;
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route(ROOT_PATH, get(root))
            .route(EVENTS_PATH, post(create_event).get(list_events))
            .route(EVENT_ID_PATH, get(read_event).patch(update_event))
            .with_state(self.clone())
    }
    pub fn protected_router(&self, auth: &crate::api_auth::AuthService) -> Router {
        auth.protect(self.router())
    }
    pub fn mounted_router(&self, mount: &str) -> Router {
        Router::new().nest(mount, self.router())
    }
}
/// Preserve error chains unless their text could expose credentials or URLs.
fn safe_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut messages = Vec::new();
    let mut current = Some(error);
    while let Some(error) = current {
        let message = error.to_string();
        let lower = message.to_ascii_lowercase();
        if [
            "://",
            "password",
            "secret",
            "bearer ",
            "token",
            "authorization",
        ]
        .iter()
        .any(|word| lower.contains(word))
        {
            messages.push("sensitive error details redacted".to_owned());
        } else {
            messages.push(message);
        }
        if messages.len() == 8 {
            break;
        }
        current = error.source();
    }
    messages.join(": ")
}
/// Sanitized native failures have no Node stack, but retain source fields.
pub fn failure_log_payload(
    message: &str,
    id: Option<&str>,
    body: Option<&Value>,
    timestamp: &str,
) -> Value {
    let mut data = serde_json::Map::new();
    data.insert("error".into(), Value::String(message.to_owned()));
    if let Some(id) = id {
        data.insert("id".into(), Value::String(id.to_owned()));
    }
    if let Some(body) = body {
        data.insert("body".into(), body.clone());
    }
    data.insert("timestamp".into(), Value::String(timestamp.to_owned()));
    Value::Object(data)
}
pub async fn emit_site_failure(
    logger: &crate::utils::logger::Logger,
    message: &str,
    id: Option<&str>,
    body: Option<&Value>,
) {
    use crate::utils::logger::{Destination, Level, LogOptions};
    let now = mongodb::bson::DateTime::now().timestamp_millis();
    let payload = failure_log_payload(
        message,
        id,
        body,
        &crate::domain_event_contracts::time::native_date_iso(now),
    );
    let _ = logger
        .log(
            Level::Error,
            payload,
            LogOptions {
                destination: Destination::Both,
                ..Default::default()
            },
        )
        .await;
}
async fn root(State(_service): State<SiteRouteService>) -> Response {
    // The source only acquires its shared Redis handle; acquisition already
    // happened when this service was constructed.
    json_response(StatusCode::OK, "{}".into())
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(v)) => !v.is_empty(),
        Some(Value::Number(v)) => v.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}
pub fn validate_event_body(body: &Value) -> Option<String> {
    for key in [
        "name",
        "type",
        "icon",
        "color",
        "textColor",
        "description",
        "config",
        "plan_tier",
    ] {
        if !truthy(body.get(key)) {
            return Some(format!("Missing required field: {key}"));
        }
    }
    let description = &body["description"];
    if !truthy(description.get("EN")) || !truthy(description.get("ES")) {
        return Some("Description must include both EN and ES translations".into());
    }
    let Some(config) = body
        .get("config")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    else {
        return Some("Config must be a non-empty array".into());
    };
    if !matches!(
        body.get("plan_tier").and_then(Value::as_str),
        Some("free" | "premium" | "pro")
    ) {
        return Some("plan_tier must be one of: free, premium, pro".into());
    }
    for item in config {
        if !truthy(item.get("id"))
            || !truthy(item.get("label"))
            || !truthy(item.get("type"))
            || item.get("value").is_none()
        {
            return Some("Each config item must have id, label, type, and value".into());
        }
        if !truthy(item.get("label").and_then(|v| v.get("EN")))
            || !truthy(item.get("label").and_then(|v| v.get("ES")))
        {
            return Some("Each config label must include both EN and ES translations".into());
        }
    }
    None
}
fn normalized(mut event: Document) -> Document {
    if let Ok(kind) = event.get_str("type") {
        let kind = canonicalize_eventsub_type(kind).to_owned();
        event.insert("type", kind);
    }
    event
}
fn dedupe(events: Vec<Document>) -> Vec<Document> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Document> = Vec::new();
    for event in events {
        let kind = event.get_str("type").unwrap_or("");
        let key = canonicalize_eventsub_type(kind).to_owned();
        if let Some(index) = seen.get(&key).copied() {
            let old_kind = out[index].get_str("type").unwrap_or("");
            if kind == key && old_kind != key {
                out[index] = event;
            }
        } else {
            seen.insert(key, out.len());
            out.push(event);
        }
    }
    out.into_iter().map(normalized).collect()
}
async fn create_event(
    State(service): State<SiteRouteService>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(mut body)) = body else {
        return failure(StatusCode::BAD_REQUEST, INVALID_JSON_MESSAGE);
    };
    if let Some(kind) = body.get("type").and_then(Value::as_str) {
        let canonical = canonicalize_eventsub_type(kind).to_owned();
        if let Some(map) = body.as_object_mut() {
            map.insert("type".into(), canonical.into());
        }
    }
    if let Some(message) = validate_event_body(&body) {
        return failure(StatusCode::BAD_REQUEST, &message);
    }
    let Some(kind) = body.get("type").and_then(Value::as_str) else {
        service
            .log_failure("event type is not a string", None, Some(&body))
            .await;
        return internal();
    };
    let collection = crate::schemas::event::schema().native_collection(&service.database);
    let result = tokio::time::timeout(service.deadline, async {
        if collection
            .find_one(doc! {"type": {"$in": get_equivalent_eventsub_types(kind)}})
            .await
            .map_err(|error| safe_error(&error))?
            .is_some()
        {
            return Ok(failure(
                StatusCode::CONFLICT,
                &format!("Event with type '{kind}' already exists"),
            ));
        }
        let input =
            mongodb::bson::serialize_to_document(&body).map_err(|error| safe_error(&error))?;
        let document = crate::schemas::event::schema()
            .prepare_insert(input, DateTime::now())
            .map_err(|error| safe_error(&error))?;
        collection
            .insert_one(document.clone())
            .await
            .map_err(|error| safe_error(&error))?;
        Ok::<Response, String>(json_response(
            StatusCode::CREATED,
            format!(
                "{{\"error\":false,\"message\":\"Event created successfully\",\"data\":{}}}",
                crate::utils::bson_js_json::bson_js_json_string(&Bson::Document(normalized(
                    document
                )))
                .map_err(|error| safe_error(&error))?
            ),
        ))
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            service.log_failure(&error, None, Some(&body)).await;
            internal()
        }
        Err(error) => {
            service
                .log_failure(&safe_error(&error), None, Some(&body))
                .await;
            internal()
        }
    }
}
async fn list_events(State(service): State<SiteRouteService>) -> Response {
    let result = tokio::time::timeout(service.deadline, async {
        let cursor = crate::schemas::event::schema()
            .native_collection(&service.database)
            .find(doc! {})
            .sort(doc! {"createdAt": -1})
            .await
            .map_err(|error| safe_error(&error))?;
        let events: Vec<Document> = cursor
            .try_collect()
            .await
            .map_err(|error| safe_error(&error))?;
        let events = dedupe(crate::utils::chat_event_catalog::with_builtin_chat_events(
            &events,
        ));
        Ok::<_, String>(format!(
            "{{\"error\":false,\"data\":{}}}",
            crate::utils::bson_js_json::bson_js_json_string(&Bson::Array(
                events.into_iter().map(Bson::Document).collect()
            ))
            .map_err(|error| safe_error(&error))?
        ))
    })
    .await;
    match result {
        Ok(Ok(body)) => json_response(StatusCode::OK, body),
        Ok(Err(error)) => {
            service.log_failure(&error, None, None).await;
            internal()
        }
        Err(error) => {
            service.log_failure(&safe_error(&error), None, None).await;
            internal()
        }
    }
}
async fn read_event(State(service): State<SiteRouteService>, Path(kind): Path<String>) -> Response {
    let kind = canonicalize_eventsub_type(&kind);
    let result = tokio::time::timeout(service.deadline, async {
        let cursor = crate::schemas::event::schema()
            .native_collection(&service.database)
            .find(doc! {"type": {"$in": get_equivalent_eventsub_types(kind)}})
            .await
            .map_err(|error| safe_error(&error))?;
        let events: Vec<Document> = cursor
            .try_collect()
            .await
            .map_err(|error| safe_error(&error))?;
        let event = events
            .iter()
            .find(|event| event.get_str("type").ok() == Some(kind))
            .or_else(|| events.first())
            .cloned()
            .or_else(|| crate::utils::chat_event_catalog::get_builtin_chat_event(kind));
        Ok::<_, String>(event)
    })
    .await;
    match result {
        Ok(Ok(Some(event))) => match crate::utils::bson_js_json::bson_js_json_string(
            &Bson::Document(normalized(event)),
        ) {
            Ok(body) => json_response(
                StatusCode::OK,
                format!("{{\"error\":false,\"data\":{body}}}"),
            ),
            Err(error) => {
                service.log_type_failure(kind, &safe_error(&error)).await;
                internal()
            }
        },
        Ok(Ok(None)) => failure(StatusCode::NOT_FOUND, "Event not found"),
        Ok(Err(error)) => {
            service.log_type_failure(kind, &error).await;
            internal()
        }
        Err(error) => {
            service.log_type_failure(kind, &safe_error(&error)).await;
            internal()
        }
    }
}

/// Parse MongoDB's 24-hex ObjectId representation without exposing input.
pub fn parse_event_id(id: &str) -> Option<ObjectId> {
    ObjectId::parse_str(id).ok()
}

/// Prepare an ordinary Mongoose query update. Casts reuse Event's schema;
/// there is no save hook or write-time validation on this source path.
pub fn prepare_event_update(body: Value) -> Result<Document, crate::schemas::ValidationErrors> {
    use crate::schemas::{FieldError, ValidationErrors};
    fn invalid() -> ValidationErrors {
        ValidationErrors(vec![FieldError {
            path: "update".into(),
            kind: "cast",
        }])
    }
    let mut fields = match body {
        Value::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    if let Some(Value::String(kind)) = fields.get_mut("type") {
        *kind = canonicalize_eventsub_type(kind).to_owned();
    }
    let mut sets = Document::new();
    let mut update = Document::new();
    for (key, value) in fields {
        if key.starts_with('$') {
            let Value::Object(entries) = value else {
                return Err(invalid());
            };
            let mut entries_out = Document::new();
            for (path, value) in entries {
                let bson = mongodb::bson::serialize_to_bson(&value).map_err(|_| invalid())?;
                if let Some(value) = crate::schemas::event::cast_update_operand(&key, &path, bson)?
                {
                    entries_out.insert(path, value);
                }
            }
            if !entries_out.is_empty() {
                update.insert(key, entries_out);
            }
        } else if let Some(value) = crate::schemas::event::cast_update_value(
            &key,
            mongodb::bson::serialize_to_bson(&value).map_err(|_| invalid())?,
        )? {
            sets.insert(key, value);
        }
    }
    if !sets.is_empty() {
        let mut combined = update
            .remove("$set")
            .and_then(|v| v.as_document().cloned())
            .unwrap_or_default();
        combined.extend(sets);
        update.insert("$set", combined);
    }
    Ok(update)
}

/// Serialize the successful source response in its exact envelope order.
pub fn updated_event_body(
    event: Document,
) -> Result<String, crate::utils::bson_js_json::BsonJsJsonError> {
    let data = crate::utils::bson_js_json::bson_js_json_string(&Bson::Document(normalized(event)))?;
    Ok(format!(
        "{{\"error\":false,\"message\":\"Event updated successfully\",\"data\":{data}}}"
    ))
}

fn is_bson_failure(error: &mongodb::error::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if current
            .downcast_ref::<mongodb::bson::error::Error>()
            .is_some()
        {
            return true;
        }
        source = current.source();
    }
    false
}

async fn update_event(
    State(service): State<SiteRouteService>,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return failure(StatusCode::BAD_REQUEST, INVALID_JSON_MESSAGE);
    };
    let raw_id = id;
    let Some(id) = parse_event_id(&raw_id) else {
        return failure(StatusCode::BAD_REQUEST, "Invalid ID");
    };
    let update = match prepare_event_update(body.clone()) {
        Ok(update) => update,
        Err(error) => {
            service
                .log_failure(&safe_error(&error), Some(&raw_id), Some(&body))
                .await;
            return failure(StatusCode::BAD_REQUEST, "Invalid ID");
        }
    };
    let collection = crate::schemas::event::schema().native_collection(&service.database);
    let result = tokio::time::timeout(service.deadline, async {
        if update.is_empty() {
            return collection.find_one(doc! {"_id": id}).await;
        }
        collection
            .find_one_and_update(doc! {"_id": id}, update)
            .return_document(ReturnDocument::After)
            .await
    })
    .await;
    match result {
        Ok(Ok(Some(event))) => match updated_event_body(event) {
            Ok(output) => json_response(StatusCode::OK, output),
            Err(error) => {
                service
                    .log_failure(&safe_error(&error), Some(&raw_id), Some(&body))
                    .await;
                internal()
            }
        },
        Ok(Ok(None)) => failure(StatusCode::NOT_FOUND, "Event not found"),
        Ok(Err(error)) if is_bson_failure(&error) => {
            service
                .log_failure(&safe_error(&error), Some(&raw_id), Some(&body))
                .await;
            failure(StatusCode::BAD_REQUEST, "Invalid ID")
        }
        Ok(Err(error)) => {
            service
                .log_failure(&safe_error(&error), Some(&raw_id), Some(&body))
                .await;
            internal()
        }
        Err(error) => {
            service
                .log_failure(&safe_error(&error), Some(&raw_id), Some(&body))
                .await;
            internal()
        }
    }
}
