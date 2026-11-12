//! Replays every case recorded from Mongoose 8.24.3 (`tests/mongo_golden/golden.json`, written by
//! `record.mjs`) through the `dima_store::mongo` write helpers, against a throwaway database:
//!
//! 1. the case's seed documents are inserted exactly as the server stored them;
//! 2. the intent (what the TypeScript asked Mongoose to do) is translated into the matching
//!    helper call, with its values as given: the helpers type numbers as Node does. Every case
//!    runs three times, with the intent's numbers as recorded (int32, int64 for large integers,
//!    double), as int64 wherever they are integral, and as doubles everywhere: the commands and
//!    stored documents must equal Mongoose's in all three. String ids in filters are cast as a
//!    Rust caller must (`parse_object_id`);
//! 3. the helper output is put in the shape of the command Mongoose sent and compared with the
//!    recorded command, **key order included**;
//! 4. the write is executed with the Rust driver and the whole collection (and the
//!    `findOneAndUpdate` result) is compared with what Mongoose left, key order included.
//!
//! Normalisation, identical to the recorder's: the helpers get the recorder's sentinel time
//! (`meta.nowMs`) as "now", so their dates need nothing; dates the *server* writes
//! (`$currentDate`) fall inside the window measured around the execution and become the
//! sentinel. ObjectIds that appear in neither the seed nor the intent were generated (by the
//! helpers or by the server for an upsert) and are renamed `ffffffffffffffff` + an 8-digit
//! counter by first appearance while walking commands, then the result, then the stored
//! documents; ids are therefore compared by where they appear, not by value.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set
//! (`eval "$(dima-rust/tools/test-env)"`).

use anyhow::{Context, Result, anyhow, bail};
use bson::oid::ObjectId;
use bson::{Bson, DateTime, Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::id::parse_object_id;
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::update::{
    BulkUpdate, Returned, Update, UpdateDoc, UpdateOptions, prepare_bulk_update,
    prepare_find_one_and_update, prepare_update,
};
use mongodb::{Collection, Database};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------- the recorder's schemas

static ITEM: Schema = Schema::subdocument(&[
    Field::value("label").trim(),
    Field::value("n").default(D::Int(1)),
    Field::value("at"),
]);
static PLAIN_SUB: Schema = Schema::subdocument(&[
    Field::value("label"),
    Field::value("on").default(D::Bool(false)),
])
.no_id();
static OPTS: Schema = Schema::subdocument(&[
    Field::value("enabled").default(D::Bool(true)),
    Field::value("mode").default(D::Str("start")),
    Field::array("list").default_fn(D::Strings(&["a", "b"])),
])
.no_id();

fn opts_default(_now: i64) -> Bson {
    Bson::Document(doc! { "enabled": true })
}

static CAMEL: Schema = Schema::new(&[
    Field::value("name").trim(),
    Field::value("key").immutable(),
    Field::value("count").default(D::Int(0)),
    Field::value("score"),
    Field::array("tags"),
    Field::document_array("items", &ITEM),
    Field::document_array("plain", &PLAIN_SUB),
    Field::nested(
        "nested",
        &[
            Field::value("a").default(D::Str("x")),
            Field::value("b"),
            Field::nested("deep", &[Field::value("c").default(D::Bool(false))]),
        ],
    ),
    Field::subdocument("opts", &OPTS).default_fn(D::With(opts_default)),
    Field::mixed("meta").default_fn(D::EmptyDocument),
    Field::mixed("blob"),
    Field::map("vars"),
    Field::value("leaseUntil").default_fn(D::DateMs(0)),
    Field::value("seenAt").default_fn(D::Now),
    Field::value("flag").default(D::Null),
    Field::value("rank").default(D::Int(5)),
])
.timestamps(Timestamps::CAMEL);

static ACCOUNT: Schema = Schema::subdocument(&[
    Field::value("type").default(D::Str("twitch")),
    Field::value("id").default(D::Null),
    Field::nested(
        "token",
        &[
            Field::value("iv").default(D::Null),
            Field::value("content").default(D::Null),
        ],
    ),
    Field::value("active").default(D::Bool(true)),
]);
static HISTORY: Schema = Schema::subdocument(&[Field::value("at"), Field::value("v")]).no_id();
static SNAKE: Schema = Schema::new(&[
    Field::value("channelID"),
    Field::value("status").default(D::Str("active")),
    Field::value("total").default(D::Int(0)),
    Field::value("ended_at").default(D::Null),
    Field::nested(
        "settings",
        &[
            Field::value("enabled").default(D::Bool(true)),
            Field::value("mode").default(D::Str("auto")),
        ],
    ),
    Field::document_array("history", &HISTORY),
    Field::document_array("accounts", &ACCOUNT),
    Field::mixed_array("responses").default(D::EmptyArray),
    Field::map("variables").default(D::EmptyDocument),
])
.timestamps(Timestamps::SNAKE);

static PLAIN: Schema = Schema::new(&[
    Field::value("_id"),
    Field::value("channelID").immutable(),
    Field::value("dueAt").default(D::Int(0)),
    Field::mixed("payload"),
    Field::nested(
        "state",
        &[Field::value("seq").default(D::Int(0)), Field::array("ids")],
    ),
    Field::value("expiresAt"),
    Field::value("label").trim().default(D::Str("")),
])
.declared_id()
.no_version_key();

static NOMIN: Schema = Schema::new(&[
    Field::value("_id"),
    Field::mixed("config").default_fn(D::EmptyDocument),
    Field::mixed("extra").default(D::EmptyDocument),
    Field::nested(
        "meta",
        &[Field::value("a"), Field::nested("b", &[Field::value("c")])],
    ),
    Field::array("list"),
])
.declared_id()
.no_version_key()
.no_minimize()
.timestamps(Timestamps::CAMEL);

static HAND: Schema = Schema::new(&[
    Field::value("name"),
    Field::value("enabled").default(D::Bool(true)),
    Field::value("createdAt").default_fn(D::Now),
    Field::value("updatedAt").default_fn(D::Now),
]);

fn schema_for(name: &str) -> Result<(&'static Schema, bool)> {
    // (schema, `_id` is an ObjectId)
    Ok(match name {
        "camel" => (&CAMEL, true),
        "snake" => (&SNAKE, true),
        "plain" => (&PLAIN, false),
        "nomin" => (&NOMIN, false),
        "hand" => (&HAND, true),
        other => bail!("unknown schema {other}"),
    })
}

// ---------------------------------------------------------------- golden data

fn golden() -> Result<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/mongo_golden/golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path)?).context("parsing golden.json")
}

fn to_bson(value: &Value) -> Result<Bson> {
    Bson::try_from(value.clone()).map_err(|e| anyhow!("extended JSON: {e}"))
}

fn to_doc(value: &Value) -> Result<Document> {
    match to_bson(value)? {
        Bson::Document(doc) => Ok(doc),
        other => bail!("expected a document, got {other:?}"),
    }
}

fn to_docs(value: &Value) -> Result<Vec<Document>> {
    value
        .as_array()
        .context("expected an array")?
        .iter()
        .map(to_doc)
        .collect()
}

/// How the replay types the intent's numbers before handing them to the helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Numbers {
    /// As the recording has them: int32, int64 for integers beyond int32, double.
    AsRecorded,
    /// Every integral number (except `-0`) as an int64.
    Int64,
    /// Every number as a double.
    Double,
}

const NUMBER_MODES: [Numbers; 3] = [Numbers::AsRecorded, Numbers::Int64, Numbers::Double];

fn retype(value: &Bson, mode: Numbers) -> Bson {
    const I64_LIMIT: f64 = 9_223_372_036_854_775_808.0;
    match (value, mode) {
        (_, Numbers::AsRecorded) => value.clone(),
        (Bson::Int32(v), Numbers::Int64) => Bson::Int64(i64::from(*v)),
        (Bson::Double(v), Numbers::Int64)
            if v.fract() == 0.0
                && (-I64_LIMIT..I64_LIMIT).contains(v)
                && !(*v == 0.0 && v.is_sign_negative()) =>
        {
            Bson::Int64(*v as i64)
        }
        (Bson::Int32(v), Numbers::Double) => Bson::Double(f64::from(*v)),
        (Bson::Int64(v), Numbers::Double) => Bson::Double(*v as f64),
        (Bson::Document(doc), _) => Bson::Document(
            doc.iter()
                .map(|(k, v)| (k.clone(), retype(v, mode)))
                .collect(),
        ),
        (Bson::Array(items), _) => Bson::Array(items.iter().map(|v| retype(v, mode)).collect()),
        _ => value.clone(),
    }
}

// ---------------------------------------------------------------- comparison helpers

/// Equality that also requires the same key order everywhere.
fn same(a: &Bson, b: &Bson) -> bool {
    match (a, b) {
        (Bson::Document(x), Bson::Document(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|((ka, va), (kb, vb))| ka == kb && same(va, vb))
        }
        (Bson::Array(x), Bson::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        (Bson::Double(x), Bson::Double(y)) => {
            x.to_bits() == y.to_bits() || (x.is_nan() && y.is_nan())
        }
        _ => a == b,
    }
}

fn show(value: &Bson) -> String {
    value.clone().into_relaxed_extjson().to_string()
}

fn collect_ids(value: &Bson, out: &mut HashSet<ObjectId>) {
    match value {
        Bson::ObjectId(id) => {
            out.insert(*id);
        }
        Bson::Document(doc) => doc.values().for_each(|v| collect_ids(v, out)),
        Bson::Array(items) => items.iter().for_each(|v| collect_ids(v, out)),
        _ => {}
    }
}

/// The recorder's normaliser: window dates become `now`, generated ids become counters.
struct Normaliser {
    inputs: HashSet<ObjectId>,
    generated: HashMap<ObjectId, ObjectId>,
    window: (i64, i64),
    now: i64,
}

impl Normaliser {
    fn walk(&mut self, value: &Bson) -> Result<Bson> {
        Ok(match value {
            Bson::DateTime(d) => {
                let ms = d.timestamp_millis();
                if ms >= self.window.0 && ms <= self.window.1 {
                    Bson::DateTime(DateTime::from_millis(self.now))
                } else {
                    value.clone()
                }
            }
            Bson::ObjectId(id) if self.inputs.contains(id) => value.clone(),
            Bson::ObjectId(id) => {
                let next = self.generated.len() + 1;
                let mapped = match self.generated.get(id) {
                    Some(mapped) => *mapped,
                    None => {
                        let mapped = ObjectId::parse_str(format!("ffffffffffffffff{next:08}"))?;
                        self.generated.insert(*id, mapped);
                        mapped
                    }
                };
                Bson::ObjectId(mapped)
            }
            Bson::Document(doc) => {
                let mut out = Document::new();
                for (key, v) in doc {
                    out.insert(key.clone(), self.walk(v)?);
                }
                Bson::Document(out)
            }
            Bson::Array(items) => {
                Bson::Array(items.iter().map(|v| self.walk(v)).collect::<Result<_>>()?)
            }
            other => other.clone(),
        })
    }
}

/// The server copies an upsert filter's equality fields into the new document right after `_id`
/// in an order of its own choosing, which varies from run to run (seen with the Node driver
/// too: 48 against 32 in 80 identical upserts with other writes in between). That run of
/// fields is put in a fixed order on both sides; everything else keeps its stored order.
fn canonical_upsert_fields(value: Bson, filter_keys: &[String]) -> Bson {
    let canonical = |doc: Document| -> Document {
        let mut entries: Vec<(String, Bson)> = doc.into_iter().collect();
        let start = usize::from(entries.first().is_some_and(|(k, _)| k == "_id"));
        let run = entries
            .iter()
            .skip(start)
            .take_while(|(k, _)| filter_keys.contains(k))
            .count();
        if let Some(slice) = entries.get_mut(start..start + run) {
            slice.sort_by(|a, b| a.0.cmp(&b.0));
        }
        entries.into_iter().collect()
    };
    match value {
        Bson::Array(items) => Bson::Array(
            items
                .into_iter()
                .map(|item| match item {
                    Bson::Document(doc) => Bson::Document(canonical(doc)),
                    other => other,
                })
                .collect(),
        ),
        Bson::Document(doc) => Bson::Document(canonical(doc)),
        other => other,
    }
}

/// Top-level keys an upsert in this case could copy from its filter.
fn upsert_filter_keys(intent: &Document) -> Vec<String> {
    let mut filters: Vec<&Document> = Vec::new();
    let upsert = intent
        .get_document("options")
        .ok()
        .and_then(|o| o.get_bool("upsert").ok())
        .unwrap_or(false);
    if upsert {
        filters.extend(intent.get_document("filter").ok());
    }
    for op in intent
        .get_array("ops")
        .map(|ops| ops.as_slice())
        .unwrap_or(&[])
    {
        if let Some(body) = op
            .as_document()
            .and_then(|o| o.values().next())
            .and_then(Bson::as_document)
            && body.get_bool("upsert").unwrap_or(false)
        {
            filters.extend(body.get_document("filter").ok());
        }
    }
    let mut keys: Vec<String> = filters
        .into_iter()
        .flat_map(|f| {
            f.keys()
                .map(|k| k.split('.').next().unwrap_or_default().to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|k| k != "_id")
        .collect();
    keys.dedup();
    keys
}

fn sort_by_id(stored: Bson) -> Bson {
    let Bson::Array(mut docs) = stored else {
        return stored;
    };
    docs.sort_by_key(|doc| match doc.as_document().and_then(|d| d.get("_id")) {
        Some(Bson::ObjectId(id)) => (0, id.bytes().to_vec()),
        Some(Bson::String(id)) => (1, id.as_bytes().to_vec()),
        _ => (2, Vec::new()),
    });
    Bson::Array(docs)
}

// ---------------------------------------------------------------- running a case

struct Outcome {
    commands: Vec<Document>,
    result: Option<Document>,
    error_code: Option<i32>,
}

fn now_ms() -> i64 {
    DateTime::now().timestamp_millis()
}

fn cast_filter(filter: &Document, object_ids: bool) -> Result<Document> {
    let mut out = filter.clone();
    if !object_ids {
        return Ok(out);
    }
    match out.get("_id").cloned() {
        Some(Bson::String(text)) => {
            out.insert("_id", parse_object_id(&text)?);
        }
        Some(Bson::Document(cond)) => {
            if let Some(Bson::Array(items)) = cond.get("$in") {
                let ids = items
                    .iter()
                    .map(|item| match item {
                        Bson::String(text) => parse_object_id(text)
                            .map(Bson::ObjectId)
                            .map_err(anyhow::Error::from),
                        other => Ok(other.clone()),
                    })
                    .collect::<Result<Vec<_>>>()?;
                out.insert("_id", doc! { "$in": ids });
            }
        }
        _ => {}
    }
    Ok(out)
}

fn update_of(value: &Bson) -> Result<Update> {
    Ok(match value.clone() {
        Bson::Document(doc) => Update::Document(doc),
        Bson::Array(items) => Update::Pipeline(
            items
                .into_iter()
                .map(|item| match item {
                    Bson::Document(doc) => Ok(doc),
                    other => Err(anyhow!("pipeline stage {other:?}")),
                })
                .collect::<Result<_>>()?,
        ),
        other => bail!("update {other:?}"),
    })
}

fn update_options(options: Option<&Document>) -> UpdateOptions {
    let flag = |key: &str| options.and_then(|o| o.get(key)).and_then(Bson::as_bool);
    UpdateOptions {
        upsert: flag("upsert").unwrap_or(false),
        set_defaults_on_insert: flag("setDefaultsOnInsert").unwrap_or(true),
        array_filters: options
            .and_then(|o| o.get_array("arrayFilters").ok())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_document().cloned())
                    .collect()
            }),
    }
}

fn statement(
    filter: Document,
    update: UpdateDoc,
    upsert: bool,
    multi: bool,
    array_filters: Option<Vec<Document>>,
) -> Document {
    let mut statement = Document::new();
    statement.insert("q", filter);
    match update {
        UpdateDoc::Document(doc) => statement.insert("u", doc),
        UpdateDoc::Pipeline(stages) => statement.insert("u", stages),
    };
    if upsert {
        statement.insert("upsert", true);
    }
    if multi {
        statement.insert("multi", true);
    }
    if let Some(filters) = array_filters {
        statement.insert("arrayFilters", filters);
    }
    statement
}

fn update_command(collection: &str, statements: Vec<Document>) -> Document {
    doc! { "update": collection, "updates": statements, "ordered": true }
}

fn insert_command(collection: &str, documents: Vec<Document>) -> Document {
    doc! { "insert": collection, "documents": documents, "ordered": true }
}

async fn execute_update(
    coll: &Collection<Document>,
    statement: &Document,
) -> mongodb::error::Result<()> {
    let filter = statement.get_document("q").cloned().unwrap_or_default();
    let update: mongodb::options::UpdateModifications = match statement.get("u") {
        Some(Bson::Array(stages)) => mongodb::options::UpdateModifications::Pipeline(
            stages
                .iter()
                .filter_map(|s| s.as_document().cloned())
                .collect(),
        ),
        Some(Bson::Document(doc)) => mongodb::options::UpdateModifications::Document(doc.clone()),
        _ => mongodb::options::UpdateModifications::Document(Document::new()),
    };
    let upsert = statement.get_bool("upsert").unwrap_or(false);
    let filters: Option<Vec<Document>> = statement.get_array("arrayFilters").ok().map(|items| {
        items
            .iter()
            .filter_map(|i| i.as_document().cloned())
            .collect()
    });
    if statement.get_bool("multi").unwrap_or(false) {
        let mut action = coll.update_many(filter, update).upsert(upsert);
        if let Some(filters) = filters {
            action = action.array_filters(filters);
        }
        action.await.map(|_| ())
    } else {
        let mut action = coll.update_one(filter, update).upsert(upsert);
        if let Some(filters) = filters {
            action = action.array_filters(filters);
        }
        action.await.map(|_| ())
    }
}

fn error_code(error: &mongodb::error::Error) -> Option<i32> {
    use mongodb::error::{ErrorKind, WriteFailure};
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(e)) => Some(e.code),
        ErrorKind::Command(e) => Some(e.code),
        _ => None,
    }
}

async fn run_case(db: &Database, case: &Value, now: i64, numbers: Numbers) -> Result<Outcome> {
    let (schema, object_ids) = schema_for(case["schema"].as_str().context("schema")?)?;
    let collection = case["collection"].as_str().context("collection")?;
    let coll: Collection<Document> = db.collection(collection);
    let intent = match retype(&to_bson(&case["intent"])?, numbers) {
        Bson::Document(intent) => intent,
        other => bail!("intent {other:?}"),
    };
    let op = intent.get_str("op")?;
    let mut ctx = WriteContext::new(now);
    let mut commands = Vec::new();
    let mut result = None;
    let mut error_code = None;
    let options = intent.get_document("options").ok();

    match op {
        "create" | "newSave" | "insertMany" => {
            let (docs, style) = if op == "insertMany" {
                (
                    intent
                        .get_array("docs")?
                        .iter()
                        .filter_map(|d| d.as_document().cloned())
                        .collect::<Vec<_>>(),
                    InsertStyle::InsertMany,
                )
            } else {
                (
                    vec![intent.get_document("doc")?.clone()],
                    InsertStyle::Create,
                )
            };
            let prepared = docs
                .iter()
                .map(|d| prepare_insert(schema, d, style, &mut ctx).map(|p| p.document))
                .collect::<Result<Vec<_>, _>>()?;
            commands.push(insert_command(collection, prepared.clone()));
            if let Err(e) = coll.insert_many(prepared).await {
                error_code = error_code_of(&e);
            }
        }
        "updateOne" | "updateMany" => {
            let filter = cast_filter(intent.get_document("filter")?, object_ids)?;
            let update = update_of(intent.get("update").context("update")?)?;
            let opts = update_options(options);
            let upsert = opts.upsert;
            if let Some(prepared) = prepare_update(schema, &filter, update, opts, &mut ctx)? {
                let statement = statement(
                    prepared.filter,
                    prepared.update,
                    upsert,
                    op == "updateMany",
                    prepared.array_filters,
                );
                if let Err(e) = execute_update(&coll, &statement).await {
                    error_code = error_code_of(&e);
                }
                commands.push(update_command(collection, vec![statement]));
            }
        }
        "findOneAndUpdate" | "findByIdAndUpdate" => {
            let filter = if op == "findByIdAndUpdate" {
                doc! { "_id": parse_object_id(intent.get_str("id")?)? }
            } else {
                cast_filter(intent.get_document("filter")?, object_ids)?
            };
            let update = update_of(intent.get("update").context("update")?)?;
            let opts = update_options(options);
            let returned = match (
                options.and_then(|o| o.get_bool("new").ok()),
                options.and_then(|o| o.get_str("returnDocument").ok()),
            ) {
                (Some(true), _) | (_, Some("after")) => Returned::After,
                _ => Returned::Before,
            };
            let prepared =
                prepare_find_one_and_update(schema, &filter, update, opts, returned, &mut ctx)?;
            let filter = prepared.filter.clone();
            match prepared.update.clone() {
                Some(update) => {
                    let mut command = doc! {
                        "findAndModify": collection,
                        "query": filter.clone(),
                        "remove": false,
                        "new": prepared.returned == Returned::After,
                        "upsert": prepared.upsert,
                    };
                    let modifications: mongodb::options::UpdateModifications =
                        update.clone().into();
                    match update {
                        UpdateDoc::Document(doc) => command.insert("update", doc),
                        UpdateDoc::Pipeline(stages) => command.insert("update", stages),
                    };
                    commands.push(command);
                    match coll
                        .find_one_and_update(filter, modifications)
                        .return_document(prepared.return_document())
                        .upsert(prepared.upsert)
                        .await
                    {
                        Ok(found) => result = found,
                        Err(e) => error_code = error_code_of(&e),
                    }
                }
                None => result = coll.find_one(filter).await?,
            }
        }
        "bulkWrite" => {
            let mut updates: Vec<Document> = Vec::new();
            let mut inserts: Vec<Document> = Vec::new();
            for operation in intent.get_array("ops")? {
                let operation = operation.as_document().context("bulk op")?;
                let (kind, body) = operation.iter().next().context("bulk op kind")?;
                let body = body.as_document().context("bulk op body")?;
                if kind == "insertOne" {
                    if !updates.is_empty() {
                        commands.push(update_command(collection, std::mem::take(&mut updates)));
                    }
                    let prepared = prepare_insert(
                        schema,
                        body.get_document("document")?,
                        InsertStyle::BulkInsertOne,
                        &mut ctx,
                    )?;
                    inserts.push(prepared.document);
                    continue;
                }
                if !inserts.is_empty() {
                    commands.push(insert_command(collection, std::mem::take(&mut inserts)));
                }
                let filter = cast_filter(body.get_document("filter")?, object_ids)?;
                let upsert = body.get_bool("upsert").unwrap_or(false);
                let bulk = if kind == "updateMany" {
                    BulkUpdate::UpdateMany
                } else {
                    BulkUpdate::UpdateOne
                };
                let opts = UpdateOptions {
                    upsert,
                    ..UpdateOptions::default()
                };
                let prepared = prepare_bulk_update(
                    schema,
                    &filter,
                    update_of(body.get("update").context("update")?)?,
                    bulk,
                    opts,
                    &mut ctx,
                )?;
                updates.push(statement(
                    prepared.filter,
                    prepared.update,
                    upsert,
                    kind == "updateMany",
                    None,
                ));
            }
            if !updates.is_empty() {
                commands.push(update_command(collection, updates));
            }
            if !inserts.is_empty() {
                commands.push(insert_command(collection, inserts));
            }
            for command in &commands {
                if let Ok(statements) = command.get_array("updates") {
                    for s in statements.iter().filter_map(Bson::as_document) {
                        execute_update(&coll, s).await?;
                    }
                } else if let Ok(documents) = command.get_array("documents") {
                    coll.insert_many(documents.iter().filter_map(|d| d.as_document().cloned()))
                        .await?;
                }
            }
        }
        "save" => {
            let id = intent.get("id").context("id")?.clone();
            let loaded = coll
                .find_one(doc! { "_id": id })
                .await?
                .context("loaded document")?;
            let changes = intent
                .get_array("changes")?
                .iter()
                .map(|change| {
                    let change = change.as_document().context("change")?;
                    Ok(if let Ok(path) = change.get_str("set") {
                        Change::set(path, change.get("value").unwrap_or(&Bson::Null).clone())
                    } else if let Ok(path) = change.get_str("unset") {
                        Change::unset(path)
                    } else {
                        Change::push(
                            change.get_str("push")?,
                            change.get_array("values")?.iter().cloned(),
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            if let Some(prepared) = prepare_save(schema, &loaded, &changes, &mut ctx)? {
                let statement = statement(
                    prepared.filter,
                    UpdateDoc::Document(prepared.update),
                    false,
                    false,
                    None,
                );
                if let Err(e) = execute_update(&coll, &statement).await {
                    error_code = error_code_of(&e);
                }
                commands.push(update_command(collection, vec![statement]));
            }
        }
        other => bail!("unknown op {other}"),
    }
    Ok(Outcome {
        commands,
        result,
        error_code,
    })
}

fn error_code_of(error: &mongodb::error::Error) -> Option<i32> {
    error_code(error).or(Some(-1))
}

/// The statements the Rust driver really sent must be the prepared ones, byte for byte (key
/// order included): `q`/`u` of updates, inserted documents, findAndModify `query`/`update`.
fn compare_sent(name: &str, prepared: &[Document], captured: &[Document]) -> Vec<String> {
    fn parts(commands: &[Document]) -> Vec<Bson> {
        let mut out = Vec::new();
        for command in commands {
            if let Ok(updates) = command.get_array("updates") {
                for statement in updates.iter().filter_map(Bson::as_document) {
                    out.extend(statement.get("q").cloned());
                    out.extend(statement.get("u").cloned());
                }
            } else if let Ok(documents) = command.get_array("documents") {
                out.extend(documents.iter().cloned());
            } else if command.contains_key("findAndModify") {
                out.extend(command.get("query").cloned());
                out.extend(command.get("update").cloned());
            }
        }
        out
    }
    let (expected, actual) = (parts(prepared), parts(captured));
    if expected.len() == actual.len() && expected.iter().zip(&actual).all(|(a, b)| same(a, b)) {
        Vec::new()
    } else {
        vec![format!(
            "{name}: driver sent something else\n  prepared: {}\n  sent:     {}",
            show(&Bson::Array(expected)),
            show(&Bson::Array(actual))
        )]
    }
}

type Sent = std::sync::Arc<std::sync::Mutex<Vec<Document>>>;

async fn check_case(
    db: &Database,
    case: &Value,
    now: i64,
    numbers: Numbers,
    sent: &Sent,
) -> Result<(Vec<String>, Vec<Document>)> {
    let name = &format!("{} ({numbers:?})", case["name"].as_str().context("name")?);
    let collection: Collection<Document> =
        db.collection(case["collection"].as_str().context("collection")?);
    collection.delete_many(doc! {}).await?;
    let seed = to_docs(&case["seed"])?;
    if !seed.is_empty() {
        collection.insert_many(seed.clone()).await?;
    }
    if let Ok(mut sent) = sent.lock() {
        sent.clear();
    }
    let t0 = now_ms() - 1;
    let outcome = run_case(db, case, now, numbers)
        .await
        .with_context(|| format!("case {name}"))?;
    let t1 = now_ms() + 1;
    let stored: Vec<Document> = {
        use futures_util::TryStreamExt;
        collection
            .find(doc! {})
            .sort(doc! { "_id": 1 })
            .await?
            .try_collect()
            .await?
    };

    let mut inputs = HashSet::new();
    for document in &seed {
        collect_ids(&Bson::Document(document.clone()), &mut inputs);
    }
    collect_ids(&to_bson(&case["intent"])?, &mut inputs);
    let mut normaliser = Normaliser {
        inputs,
        generated: HashMap::new(),
        window: (t0, t1),
        now,
    };
    let prepared = outcome.commands.clone();
    let commands = Bson::Array(outcome.commands.into_iter().map(Bson::Document).collect());
    let commands = normaliser.walk(&commands)?;
    // The recorder re-serialises the `.lean()` result from JavaScript values, which retypes
    // its numbers as the Node writer does; the same is done to the driver's result here.
    let result = match outcome.result {
        Some(mut doc) => {
            dima_store::mongo::number::normalize_js_numbers(&mut doc);
            normaliser.walk(&Bson::Document(doc))?
        }
        None => Bson::Null,
    };
    let stored = sort_by_id(normaliser.walk(&Bson::Array(
        stored.into_iter().map(Bson::Document).collect(),
    ))?);

    let filter_keys = upsert_filter_keys(&to_doc(&case["intent"])?);
    let result = canonical_upsert_fields(result, &filter_keys);
    let stored = canonical_upsert_fields(stored, &filter_keys);
    let mut problems = Vec::new();
    let expected_commands = to_bson(&case["commands"])?;
    if !same(&commands, &expected_commands) {
        problems.push(format!(
            "{name}: commands\n  rust:     {}\n  mongoose: {}",
            show(&commands),
            show(&expected_commands)
        ));
    }
    let expected_result = if case["result"].is_null() {
        Bson::Null
    } else {
        to_bson(&case["result"])?
    };
    let expected_result = canonical_upsert_fields(expected_result, &filter_keys);
    if !same(&result, &expected_result) {
        problems.push(format!(
            "{name}: result\n  rust:     {}\n  mongoose: {}",
            show(&result),
            show(&expected_result)
        ));
    }
    // Sorted by normalised `_id`: a client-generated id and a server-generated upsert id compare
    // arbitrarily (their process bytes differ), so the raw `_id` order is not comparable.
    let expected_stored =
        canonical_upsert_fields(sort_by_id(to_bson(&case["stored"])?), &filter_keys);
    if !same(&stored, &expected_stored) {
        problems.push(format!(
            "{name}: stored\n  rust:     {}\n  mongoose: {}",
            show(&stored),
            show(&expected_stored)
        ));
    }
    let expected_error = case
        .get("error")
        .and_then(|e| e["code"].as_i64())
        .and_then(|c| i32::try_from(c).ok());
    if outcome.error_code != expected_error {
        problems.push(format!(
            "{name}: error {:?}, mongoose {:?}",
            outcome.error_code, expected_error
        ));
    }
    Ok((problems, prepared))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mongoose_write_cases_match() -> Result<()> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
        return Ok(());
    };
    let golden = golden()?;
    let now = golden["meta"]["nowMs"].as_i64().context("nowMs")?;
    let mut options = mongodb::options::ClientOptions::parse(&uri).await?;
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Document>::new()));
    let sink = std::sync::Arc::clone(&sent);
    options.command_event_handler = Some(mongodb::event::EventHandler::callback(move |event| {
        if let mongodb::event::command::CommandEvent::Started(started) = event
            && matches!(
                started.command_name.as_str(),
                "update" | "insert" | "findAndModify"
            )
            && let Ok(mut sent) = sink.lock()
        {
            sent.push(started.command);
        }
    }));
    let client = mongodb::Client::with_options(options)?;
    let db = client.database(&format!("dima_test_store_{}", ObjectId::new().to_hex()));
    let cases = golden["cases"].as_array().context("cases")?;
    let mut problems = Vec::new();
    let mut compared = 0;
    for numbers in NUMBER_MODES {
        for case in cases {
            match check_case(&db, case, now, numbers, &sent).await {
                Ok((found, prepared)) => {
                    problems.extend(found);
                    compared += 1;
                    let captured: Vec<Document> =
                        sent.lock().map(|s| s.clone()).unwrap_or_default();
                    problems.extend(compare_sent(
                        case["name"].as_str().unwrap_or("?"),
                        &prepared,
                        &captured,
                    ));
                }
                Err(e) => problems.push(format!("{:#}", e)),
            }
        }
    }
    db.drop().await?;
    assert!(
        problems.is_empty(),
        "{} of {} replays differ:\n{}",
        problems.len(),
        cases.len() * NUMBER_MODES.len(),
        problems.join("\n")
    );
    assert_eq!(compared, cases.len() * NUMBER_MODES.len());
    eprintln!(
        "{} Mongoose cases compared, {compared} replays (numbers as recorded, as int64, as \
         doubles): commands, results and stored documents identical",
        cases.len()
    );
    Ok(())
}
