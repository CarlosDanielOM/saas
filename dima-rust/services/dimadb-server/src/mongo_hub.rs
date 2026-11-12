//! MongoDB connections (`mongo.mjs`): one client per connection id, created with
//! `serverSelectionTimeoutMS: 8000` like the reference's `mongoose.createConnection`.
//!
//! Reads and writes are sent as the commands the Node driver sends (`find` with `skip` and
//! `limit`, the `countDocuments` aggregation, `count`, `insert`, `update` with one replacement,
//! `delete` with `limit: 1`), with filters and documents built by [`crate::ejson`], so the stored
//! BSON types are the reference's. Server errors carry the server's message, as the Node
//! driver's `MongoServerError` does.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_store::mongo::{MongoConfig, MongoError, MongoStore};
use futures_util::TryStreamExt as _;
use serde_json::{Value, json};

use crate::config::Engine;
use crate::connections::Registry;
use crate::ejson::{self, Js};
use crate::error::{ApiError, ApiResult};
use crate::js;

/// `serverSelectionTimeoutMS` of the reference.
pub const SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(8);

/// The cached clients.
#[derive(Default)]
pub struct MongoHub {
    clients: Mutex<HashMap<String, MongoStore>>,
}

impl std::fmt::Debug for MongoHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MongoHub").finish_non_exhaustive()
    }
}

/// A driver error as the Node driver words it.
fn mongo_message(error: &mongodb::error::Error) -> String {
    use mongodb::error::{ErrorKind, WriteFailure};
    match error.kind.as_ref() {
        ErrorKind::Command(command) => command.message.clone(),
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.message.clone(),
        ErrorKind::Write(WriteFailure::WriteConcernError(concern)) => concern.message.clone(),
        other => other.to_string(),
    }
}

fn driver_error(error: &mongodb::error::Error) -> ApiError {
    ApiError::internal(mongo_message(error))
}

/// `requireName(value, label)`.
pub fn require_name(value: Option<&Value>, label: &str) -> ApiResult<()> {
    if dima_text::trim(&js::string_or_empty(value)).is_empty() {
        return Err(ApiError::bad_request(format!("{label} is required")));
    }
    Ok(())
}

/// The database name the driver is given (`conn.useDb(name)`), checked like `new Db`.
fn db_name(value: Option<&Value>) -> ApiResult<String> {
    let name = js::string_or_empty(value);
    if name.contains('.') {
        return Err(ApiError::internal(
            "Database names cannot contain the character '.'",
        ));
    }
    Ok(name)
}

/// `idQuery(docId)`: a 24-character lowercase hex id is an ObjectId, anything else a string.
pub fn id_query(doc_id: &str) -> Document {
    let is_oid = doc_id.len() == 24
        && doc_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    match bson::oid::ObjectId::parse_str(doc_id) {
        Ok(oid) if is_oid => doc! { "_id": oid },
        _ => doc! { "_id": doc_id },
    }
}

/// `parseFilter(raw)`: relaxed Extended JSON; any failure is `400 Invalid filter JSON`.
pub fn parse_filter(raw: &str) -> ApiResult<Js> {
    let text = dima_text::trim(raw);
    let text = if text.is_empty() { "{}" } else { text };
    let invalid = || ApiError::bad_request("Invalid filter JSON");
    let value = js::parse_json(text.as_bytes()).ok_or_else(invalid)?;
    ejson::deserialize(&value).map_err(|_| invalid())
}

/// `decodeDocument(document)`: a JSON string is parsed first; the value must be an object.
pub fn decode_document(document: Option<&Value>) -> ApiResult<Js> {
    let parsed;
    let value = match document {
        Some(Value::String(text)) => {
            parsed = js::parse_json(text.as_bytes())
                .ok_or_else(|| ApiError::bad_request(crate::js_errors::json_parse_message(text)))?;
            &parsed
        }
        Some(value) => value,
        None => &Value::Null,
    };
    if !value.is_object() {
        return Err(ApiError::bad_request("document must be an object"));
    }
    ejson::deserialize(value).map_err(|error| ApiError::bad_request(error.0))
}

/// `Object.keys(value).length` for a deserialized filter (bson class instances have own
/// properties such as `buffer`; `Date`, `MinKey` and `MaxKey` have none).
fn key_count(value: &Js) -> usize {
    match value {
        Js::Object(entries) => entries.len(),
        Js::Array(items) => items.len(),
        Js::String(text) => dima_text::utf16_len(text),
        Js::Null | Js::Bool(_) | Js::Number(_) | Js::Date(_) | Js::MinKey | Js::MaxKey => 0,
        _ => 1,
    }
}

/// The document the driver serializes for a deserialized value (non-objects have no own keys).
fn as_document(value: &Js) -> Document {
    match ejson::to_bson(value) {
        Bson::Document(document) => document,
        _ => Document::new(),
    }
}

impl MongoHub {
    /// `drop(id)`.
    pub fn drop_client(&self, id: &str) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.remove(id);
        }
    }

    /// Forgets every client (shutdown).
    pub fn clear(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.clear();
        }
    }

    /// `connFor(id)`.
    pub async fn client(&self, registry: &Registry<'_>, id: &str) -> ApiResult<mongodb::Client> {
        let row = registry.require(id, Some(Engine::Mongo)).await?;
        if let Some(store) = self.clients.lock().ok().and_then(|c| c.get(id).cloned()) {
            return Ok(store.client().clone());
        }
        let url = registry.resolve_url_text(&row)?;
        let mut config = MongoConfig::new(url);
        config.server_selection_timeout = Some(SERVER_SELECTION_TIMEOUT);
        let store = MongoStore::connect(&config, None)
            .await
            .map_err(|error| match error {
                MongoError::Driver(error) => driver_error(&error),
                other => ApiError::internal(other.to_string()),
            })?;
        let client = store.client().clone();
        if let Ok(mut clients) = self.clients.lock() {
            clients.insert(id.to_owned(), store);
        }
        Ok(client)
    }
}

/// A connection id, connected (`connFor(id)`) at the point the reference connects.
#[derive(Debug, Clone, Copy)]
pub struct Conn<'a> {
    /// The hub.
    pub hub: &'a MongoHub,
    /// The registry.
    pub registry: &'a Registry<'a>,
    /// The connection id.
    pub id: &'a str,
}

impl Conn<'_> {
    async fn get(&self) -> ApiResult<mongodb::Client> {
        self.hub.client(self.registry, self.id).await
    }
}

/// `ping(id)`.
pub async fn ping(conn: Conn<'_>) -> ApiResult<Value> {
    let client = conn.get().await?;
    let result = client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await
        .map_err(|e| driver_error(&e))?;
    let ok = result
        .get("ok")
        .and_then(Bson::as_f64)
        .or_else(|| result.get_i32("ok").ok().map(f64::from));
    if ok == Some(1.0) {
        return Ok(Value::from("PONG"));
    }
    let json = ejson::serialize_owned(&result).map_err(|e| ApiError::internal(e.0))?;
    Ok(Value::from(dima_text::to_js_json(&json)))
}

/// A BSON number the way the driver promotes it to a JavaScript number.
fn number_of(value: Option<&Bson>) -> Option<Value> {
    #[expect(clippy::cast_precision_loss, reason = "JavaScript numbers")]
    match value? {
        Bson::Int32(n) => Some(Value::from(*n)),
        Bson::Int64(n) => Some(js::number_value(*n as f64)),
        Bson::Double(n) => Some(js::number_value(*n)),
        _ => None,
    }
}

/// `databases(id)`.
pub async fn databases(conn: Conn<'_>) -> ApiResult<Value> {
    let client = conn.get().await?;
    let result = client
        .database("admin")
        .run_command(doc! { "listDatabases": 1 })
        .await
        .map_err(|e| driver_error(&e))?;
    let rows = result
        .get_array("databases")
        .map(|items| {
            items
                .iter()
                .filter_map(Bson::as_document)
                .map(|item| {
                    let mut row = serde_json::Map::new();
                    if let Some(name) = item.get("name") {
                        row.insert("name".to_owned(), bson_json(name));
                    }
                    if let Some(size) = number_of(item.get("sizeOnDisk")) {
                        row.insert("sizeOnDisk".to_owned(), size);
                    }
                    let empty = item.get("empty").is_some_and(|e| {
                        matches!(e, Bson::Boolean(true))
                            || number_of(Some(e))
                                .is_some_and(|n| n.as_f64().is_some_and(|f| f != 0.0))
                    });
                    row.insert("empty".to_owned(), Value::Bool(empty));
                    Value::Object(row)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Value::Array(rows))
}

fn bson_json(value: &Bson) -> Value {
    let mut document = Document::new();
    document.insert("v", value.clone());
    ejson::serialize_owned(&document)
        .ok()
        .and_then(|mut v| v.get_mut("v").map(Value::take))
        .unwrap_or(Value::Null)
}

/// `collections(id, db)`.
pub async fn collections(conn: Conn<'_>, db: &Value) -> ApiResult<Value> {
    require_name(Some(db), "db")?;
    let client = conn.get().await?;
    let database = client.database(&db_name(Some(db))?);
    let mut cursor = database
        .run_cursor_command(doc! { "listCollections": 1, "filter": {}, "nameOnly": true, "authorizedCollections": false })
        .await
        .map_err(|e| driver_error(&e))?;
    let mut rows = Vec::new();
    while let Some(item) = cursor.try_next().await.map_err(|e| driver_error(&e))? {
        let name = item.get("name").map(bson_json).unwrap_or(Value::Null);
        let kind = match item.get("type") {
            Some(Bson::String(text)) if !text.is_empty() => Value::from(text.clone()),
            Some(other)
                if !matches!(other, Bson::Null | Bson::String(_) | Bson::Boolean(false)) =>
            {
                bson_json(other)
            }
            _ => Value::from("collection"),
        };
        rows.push(json!({ "name": name, "type": kind }));
    }
    Ok(Value::Array(rows))
}

/// One document row: `{id, document}`.
fn row(document: &RawDocumentBuf) -> ApiResult<Value> {
    let rendered = ejson::serialize_document(document).map_err(|e| ApiError::internal(e.0))?;
    Ok(json!({ "id": ejson::id_text(document), "document": rendered }))
}

async fn find_raw(
    database: &mongodb::Database,
    command: Document,
) -> ApiResult<Vec<RawDocumentBuf>> {
    let cursor = database
        .run_cursor_command(command)
        .await
        .map_err(|e| driver_error(&e))?;
    let mut cursor = cursor.with_type::<RawDocumentBuf>();
    let mut out = Vec::new();
    while let Some(document) = cursor.try_next().await.map_err(|e| driver_error(&e))? {
        out.push(document);
    }
    Ok(out)
}

/// The query of `docs(id, …)`.
#[derive(Debug)]
pub struct DocsQuery {
    /// `db`.
    pub db: String,
    /// `collection`.
    pub collection: String,
    /// `skip` as given.
    pub skip: String,
    /// `limit` as given.
    pub limit: String,
    /// `filter` as given.
    pub filter: String,
}

/// `docs(id, {db, collection, skip, limit, filter})`.
pub async fn docs(conn: Conn<'_>, query: &DocsQuery) -> ApiResult<Value> {
    let db = Value::from(query.db.clone());
    let collection = Value::from(query.collection.clone());
    require_name(Some(&db), "db")?;
    require_name(Some(&collection), "collection")?;
    let client = conn.get().await?;
    let filter = parse_filter(&query.filter)?;
    let database = client.database(&db_name(Some(&db))?);
    let limit = dima_text::parse_number(&query.limit);
    let limit = if limit == 0.0 || limit.is_nan() {
        50.0
    } else {
        limit
    };
    let take = limit.clamp(1.0, 100.0);
    let skip = dima_text::parse_number(&query.skip);
    let from = if skip == 0.0 || skip.is_nan() {
        0.0
    } else {
        skip
    }
    .max(0.0);
    // `Object.keys(parsed)` runs first and throws on null; then the driver's `FindOperation`
    // accepts only an object (a bson value is sent as that BSON type, which the server refuses)
    // and turns an ObjectId into `{_id}`.
    let find_filter = match &filter {
        Js::Null => {
            return Err(ApiError::internal(
                "Cannot convert undefined or null to object",
            ));
        }
        Js::Array(_) | Js::Number(_) | Js::String(_) | Js::Bool(_) => {
            return Err(ApiError::internal(
                "Query filter must be a plain object or ObjectId",
            ));
        }
        Js::ObjectId(oid) => Bson::Document(doc! { "_id": *oid }),
        other => ejson::to_bson(other),
    };
    let filter_bson = ejson::to_bson(&filter);
    let find = doc! {
        "find": query.collection.clone(),
        "filter": find_filter,
        "skip": ejson::number_bson(from),
        "limit": ejson::number_bson(take),
    };
    let items = find_raw(&database, find).await?;
    let total = if key_count(&filter) > 0 {
        let pipeline = vec![
            Bson::Document(doc! { "$match": filter_bson }),
            Bson::Document(doc! { "$group": { "_id": 1, "n": { "$sum": 1 } } }),
        ];
        let counted = find_raw(
            &database,
            doc! { "aggregate": query.collection.clone(), "pipeline": pipeline, "cursor": {} },
        )
        .await?;
        counted
            .first()
            .and_then(|d| Document::try_from(d).ok())
            .and_then(|d| number_of(d.get("n")))
            .unwrap_or(Value::from(0))
    } else {
        let result = database
            .run_command(doc! { "count": query.collection.clone() })
            .await
            .map_err(|e| driver_error(&e))?;
        number_of(result.get("n")).unwrap_or(Value::from(0))
    };
    let mut docs = Vec::with_capacity(items.len());
    for item in &items {
        docs.push(row(item)?);
    }
    Ok(json!({
        "db": query.db,
        "collection": query.collection,
        "skip": js::number_value(from),
        "limit": js::number_value(take),
        "total": total,
        "docs": docs,
    }))
}

/// `inspect(id, {db, collection, docId})`; `db` and `collection` are echoed as given.
pub async fn inspect(
    conn: Conn<'_>,
    db: &Value,
    collection: &Value,
    doc_id: &Value,
) -> ApiResult<Value> {
    require_name(Some(db), "db")?;
    require_name(Some(collection), "collection")?;
    require_name(Some(doc_id), "id")?;
    let client = conn.get().await?;
    let database = client.database(&db_name(Some(db))?);
    let found = find_raw(
        &database,
        doc! {
            "find": js::string(Some(collection)),
            "filter": id_query(&js::string(Some(doc_id))),
            "limit": 1,
            "singleBatch": true,
            "batchSize": 1,
        },
    )
    .await?;
    let Some(document) = found.first() else {
        return Err(ApiError::not_found("Document not found"));
    };
    let rendered = row(document)?;
    Ok(json!({
        "db": db,
        "collection": collection,
        "id": rendered.get("id").cloned().unwrap_or(Value::Null),
        "document": rendered.get("document").cloned().unwrap_or(Value::Null),
    }))
}

/// The first write error of a write command reply, as `MongoServerError`.
fn write_result(reply: &Document) -> ApiResult<i64> {
    if let Ok(errors) = reply.get_array("writeErrors")
        && let Some(first) = errors.iter().filter_map(Bson::as_document).next()
    {
        return Err(ApiError::internal(
            first.get_str("errmsg").unwrap_or_default().to_owned(),
        ));
    }
    if let Ok(concern) = reply.get_document("writeConcernError") {
        return Err(ApiError::internal(
            concern.get_str("errmsg").unwrap_or_default().to_owned(),
        ));
    }
    Ok(match reply.get("n") {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        #[expect(clippy::cast_possible_truncation, reason = "a document count")]
        Some(Bson::Double(n)) => *n as i64,
        _ => 0,
    })
}

/// `save(id, {db, collection, docId, document})`.
pub async fn save(conn: Conn<'_>, body: &Value) -> ApiResult<Value> {
    let (db, collection, doc_id) = (body.get("db"), body.get("collection"), body.get("docId"));
    require_name(db, "db")?;
    require_name(collection, "collection")?;
    require_name(doc_id, "id")?;
    let client = conn.get().await?;
    let value = decode_document(body.get("document"))?;
    let replacement = as_document(&value);
    if replacement
        .keys()
        .next()
        .is_some_and(|k| k.starts_with('$'))
    {
        return Err(ApiError::internal(
            "Replacement document must not contain atomic operators",
        ));
    }
    let database = client.database(&db_name(db)?);
    let reply = database
        .run_command(doc! {
            "update": js::string(collection),
            "updates": [{ "q": id_query(&js::string(doc_id)), "u": replacement, "upsert": false, "multi": false }],
            "ordered": true,
        })
        .await
        .map_err(|e| driver_error(&e))?;
    if write_result(&reply)? == 0 {
        return Err(ApiError::not_found("Document not found"));
    }
    let null = Value::Null;
    inspect(
        conn,
        db.unwrap_or(&null),
        collection.unwrap_or(&null),
        doc_id.unwrap_or(&null),
    )
    .await
}

/// `insert(id, {db, collection, document})`.
pub async fn insert(conn: Conn<'_>, body: &Value) -> ApiResult<Value> {
    let (db, collection) = (body.get("db"), body.get("collection"));
    require_name(db, "db")?;
    require_name(collection, "collection")?;
    let client = conn.get().await?;
    let value = decode_document(body.get("document"))?;
    let mut document = as_document(&value);
    // The driver adds `_id` when it is missing or null (`doc._id == null`).
    if matches!(document.get("_id"), None | Some(Bson::Null)) {
        document.insert("_id", bson::oid::ObjectId::new());
    }
    let inserted = document.get("_id").cloned().unwrap_or(Bson::Null);
    let database = client.database(&db_name(db)?);
    let reply = database
        .run_command(doc! {
            "insert": js::string(collection),
            "documents": [document],
            "ordered": true,
        })
        .await
        .map_err(|e| driver_error(&e))?;
    write_result(&reply)?;
    let null = Value::Null;
    let id_text = {
        let mut probe = Document::new();
        probe.insert("_id", inserted);
        RawDocumentBuf::try_from(&probe)
            .map(|raw| ejson::id_text(&raw))
            .unwrap_or_default()
    };
    inspect(
        conn,
        db.unwrap_or(&null),
        collection.unwrap_or(&null),
        &Value::from(id_text),
    )
    .await
}

/// `del(id, {db, collection, docId})`.
pub async fn delete(
    conn: Conn<'_>,
    db: &Value,
    collection: &Value,
    doc_id: &Value,
) -> ApiResult<Value> {
    require_name(Some(db), "db")?;
    require_name(Some(collection), "collection")?;
    require_name(Some(doc_id), "id")?;
    let client = conn.get().await?;
    let database = client.database(&db_name(Some(db))?);
    let reply = database
        .run_command(doc! {
            "delete": js::string(Some(collection)),
            "deletes": [{ "q": id_query(&js::string(Some(doc_id))), "limit": 1 }],
            "ordered": true,
        })
        .await
        .map_err(|e| driver_error(&e))?;
    let deleted = write_result(&reply)?;
    Ok(json!({ "deleted": deleted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_queries() {
        assert_eq!(
            id_query("6650a1b2c3d4e5f601234567"),
            doc! { "_id": bson::oid::ObjectId::parse_str("6650a1b2c3d4e5f601234567").unwrap_or_default() }
        );
        assert_eq!(
            id_query("6650A1B2C3D4E5F601234567"),
            doc! { "_id": "6650A1B2C3D4E5F601234567" }
        );
        assert_eq!(id_query("aaaaaaaaaaaa"), doc! { "_id": "aaaaaaaaaaaa" });
        assert_eq!(id_query("🍕"), doc! { "_id": "🍕" });
    }

    #[test]
    fn names_and_filters() {
        assert!(require_name(Some(&json!(" ")), "db").is_err());
        assert!(require_name(Some(&json!(0)), "db").is_err());
        assert!(require_name(Some(&json!("x")), "db").is_ok());
        assert_eq!(
            db_name(Some(&json!("a.b"))).err().map(|e| e.status),
            Some(500)
        );
        assert_eq!(parse_filter("").ok().map(|f| key_count(&f)), Some(0));
        assert_eq!(
            parse_filter("{bad").err().map(|e| e.message),
            Some("Invalid filter JSON".to_owned())
        );
        assert_eq!(
            parse_filter("{\"_id\":{\"$oid\":\"x\"}}")
                .err()
                .map(|e| e.status),
            Some(400)
        );
        assert_eq!(
            decode_document(Some(&json!([1]))).err().map(|e| e.message),
            Some("document must be an object".to_owned())
        );
        assert_eq!(
            decode_document(Some(&json!("{\"a\":1}")))
                .ok()
                .map(|d| as_document(&d)),
            Some(doc! { "a": 1 })
        );
    }
}
