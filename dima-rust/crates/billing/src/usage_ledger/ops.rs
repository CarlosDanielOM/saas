//! **Workaround module.** MongoDB operations of the usage ledger with a server time limit.
//!
//! The store's write helpers (`dima_store::mongo::write::Writes`) send no `maxTimeMS`, and the
//! ledger's destructive steps must have one (`PlanEffects` asks for at most 10 s per step), as
//! must every step taken under a lease. These run the documents the model crate prepared
//! (`CollectionInfo::prepare_*`: casting, defaults, timestamps, the write guard) as raw
//! `update`, `delete` and `insert` commands with `maxTimeMS`, refuse a prepared write that lost
//! paths, and read the per-statement write errors. Reads use the driver's `max_time`. Each call
//! also has a client deadline ([`super::LedgerConfig::op_deadline`]). Change wanted in the
//! store: a time limit option on `Writes` (and an unordered `insert_many`), after which these
//! go through it.

use super::{Ledger, LedgerError};
use bson::{Bson, Document, doc};
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::update::{PreparedUpdate, UpdateDoc};
use futures_util::TryStreamExt;
use std::future::Future;
use std::time::Duration;

/// What a write command reported.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WriteReport {
    /// `n`: matched (update), deleted (delete) or inserted (insert), upserts included.
    pub n: i64,
    /// `nModified` (update).
    pub modified: i64,
    /// Statements that inserted a document by upsert.
    pub upserted: Vec<usize>,
    /// Statements refused for a duplicate key (E11000), by index.
    pub duplicates: Vec<usize>,
}

/// Runs `operation` under the configured client deadline.
pub(crate) async fn deadline<T>(
    ledger: &Ledger<'_>,
    what: &'static str,
    operation: impl Future<Output = Result<T, LedgerError>>,
) -> Result<T, LedgerError> {
    tokio::time::timeout(ledger.config.op_deadline, operation)
        .await
        .map_err(|_| LedgerError::Timeout(what))?
}

fn max_time(ledger: &Ledger<'_>) -> i64 {
    i64::try_from(ledger.config.max_time_ms).unwrap_or(10_000)
}

/// One statement of an `update` command from a prepared update.
pub(crate) fn statement(
    collection: &str,
    prepared: &PreparedUpdate,
    multi: bool,
) -> Result<Option<Document>, LedgerError> {
    if !prepared.dropped_paths.is_empty() {
        return Err(LedgerError::Dropped {
            collection: collection.to_owned(),
            paths: prepared.dropped_paths.clone(),
        });
    }
    let Some(update) = &prepared.update else {
        return Ok(None);
    };
    let u = match update {
        UpdateDoc::Document(document) => Bson::Document(document.clone()),
        UpdateDoc::Pipeline(stages) => {
            Bson::Array(stages.iter().cloned().map(Bson::Document).collect())
        }
    };
    let mut statement = doc! {
        "q": prepared.filter.clone(),
        "u": u,
        "upsert": prepared.upsert,
        "multi": multi,
    };
    if let Some(filters) = &prepared.array_filters {
        statement.insert(
            "arrayFilters",
            Bson::Array(filters.iter().cloned().map(Bson::Document).collect()),
        );
    }
    Ok(Some(statement))
}

fn report(reply: &Document) -> Result<WriteReport, LedgerError> {
    let number = |key: &str| match reply.get(key) {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        Some(Bson::Double(n)) => {
            #[allow(clippy::cast_possible_truncation)]
            let n = *n as i64;
            n
        }
        _ => 0,
    };
    let index = |entry: &Document| match entry.get("index") {
        Some(Bson::Int32(i)) => usize::try_from(*i).unwrap_or(usize::MAX),
        Some(Bson::Int64(i)) => usize::try_from(*i).unwrap_or(usize::MAX),
        _ => usize::MAX,
    };
    let mut out = WriteReport {
        n: number("n"),
        modified: number("nModified"),
        ..WriteReport::default()
    };
    if let Ok(upserted) = reply.get_array("upserted") {
        out.upserted = upserted
            .iter()
            .filter_map(Bson::as_document)
            .map(index)
            .collect();
    }
    if let Ok(errors) = reply.get_array("writeErrors") {
        for error in errors.iter().filter_map(Bson::as_document) {
            let code = match error.get("code") {
                Some(Bson::Int32(code)) => i64::from(*code),
                Some(Bson::Int64(code)) => *code,
                _ => 0,
            };
            if code == 11000 {
                out.duplicates.push(index(error));
            } else {
                return Err(LedgerError::Mongo(format!(
                    "write error {code}: {}",
                    error.get_str("errmsg").unwrap_or("")
                )));
            }
        }
    }
    if let Ok(concern) = reply.get_document("writeConcernError") {
        return Err(LedgerError::Mongo(format!(
            "write concern error: {}",
            concern.get_str("errmsg").unwrap_or("")
        )));
    }
    Ok(out)
}

async fn command(
    ledger: &Ledger<'_>,
    what: &'static str,
    cmd: Document,
) -> Result<WriteReport, LedgerError> {
    deadline(ledger, what, async {
        let reply = ledger
            .mongo
            .database()
            .run_command(cmd)
            .await
            .map_err(|error| LedgerError::Mongo(error.to_string()))?;
        report(&reply)
    })
    .await
}

/// `update` with `statements` (from [`statement`]).
pub(crate) async fn update(
    ledger: &Ledger<'_>,
    collection: &str,
    statements: Vec<Document>,
    ordered: bool,
) -> Result<WriteReport, LedgerError> {
    if statements.is_empty() {
        return Ok(WriteReport::default());
    }
    let cmd = doc! {
        "update": collection,
        "updates": statements.into_iter().map(Bson::Document).collect::<Vec<_>>(),
        "ordered": ordered,
        "maxTimeMS": max_time(ledger),
    };
    command(ledger, "update", cmd).await
}

/// One prepared update (`updateOne` or `updateMany`).
pub(crate) async fn update_prepared(
    ledger: &Ledger<'_>,
    collection: &str,
    prepared: &PreparedUpdate,
    multi: bool,
) -> Result<WriteReport, LedgerError> {
    match statement(collection, prepared, multi)? {
        Some(statement) => update(ledger, collection, vec![statement], true).await,
        None => Ok(WriteReport::default()),
    }
}

/// `deleteMany(filter)`.
pub(crate) async fn delete_many(
    ledger: &Ledger<'_>,
    collection: &str,
    filter: Document,
) -> Result<i64, LedgerError> {
    let cmd = doc! {
        "delete": collection,
        "deletes": [ { "q": filter, "limit": 0 } ],
        "ordered": true,
        "maxTimeMS": max_time(ledger),
    };
    Ok(command(ledger, "delete", cmd).await?.n)
}

/// `insertMany(documents, {ordered})`.
pub(crate) async fn insert_many(
    ledger: &Ledger<'_>,
    collection: &str,
    prepared: &[PreparedInsert],
    ordered: bool,
) -> Result<WriteReport, LedgerError> {
    let mut documents = Vec::with_capacity(prepared.len());
    for insert in prepared {
        if !insert.dropped_paths.is_empty() {
            return Err(LedgerError::Dropped {
                collection: collection.to_owned(),
                paths: insert.dropped_paths.clone(),
            });
        }
        documents.push(Bson::Document(insert.document.clone()));
    }
    if documents.is_empty() {
        return Ok(WriteReport::default());
    }
    let cmd = doc! {
        "insert": collection,
        "documents": documents,
        "ordered": ordered,
        "maxTimeMS": max_time(ledger),
    };
    command(ledger, "insert", cmd).await
}

/// `find(filter)` with a sort, a projection and a limit (at most `limit` documents).
pub(crate) async fn find(
    ledger: &Ledger<'_>,
    collection: &str,
    filter: Document,
    sort: Option<Document>,
    projection: Option<Document>,
    limit: i64,
) -> Result<Vec<Document>, LedgerError> {
    deadline(ledger, "find", async {
        let documents = ledger.mongo.documents(collection);
        let mut action = documents
            .find(filter)
            .limit(limit)
            .max_time(Duration::from_millis(ledger.config.max_time_ms));
        if let Some(sort) = sort {
            action = action.sort(sort);
        }
        if let Some(projection) = projection {
            action = action.projection(projection);
        }
        let cursor = action
            .await
            .map_err(|error| LedgerError::Mongo(error.to_string()))?;
        cursor
            .try_collect()
            .await
            .map_err(|error| LedgerError::Mongo(error.to_string()))
    })
    .await
}

/// `findOne(filter)` with a projection.
pub(crate) async fn find_one(
    ledger: &Ledger<'_>,
    collection: &str,
    filter: Document,
    projection: Option<Document>,
) -> Result<Option<Document>, LedgerError> {
    Ok(find(ledger, collection, filter, None, projection, 1)
        .await?
        .into_iter()
        .next())
}

/// `aggregate(pipeline)`; refuses more than `most` result documents.
pub(crate) async fn aggregate(
    ledger: &Ledger<'_>,
    collection: &str,
    pipeline: Vec<Document>,
    most: usize,
) -> Result<Vec<Document>, LedgerError> {
    deadline(ledger, "aggregate", async {
        let documents = ledger.mongo.documents(collection);
        let mut cursor = documents
            .aggregate(pipeline)
            .max_time(Duration::from_millis(ledger.config.max_time_ms))
            .await
            .map_err(|error| LedgerError::Mongo(error.to_string()))?;
        let mut out = Vec::new();
        while let Some(document) = cursor
            .try_next()
            .await
            .map_err(|error| LedgerError::Mongo(error.to_string()))?
        {
            if out.len() >= most {
                return Err(LedgerError::Mongo(format!(
                    "aggregate returned more than {most} groups"
                )));
            }
            out.push(document);
        }
        Ok(out)
    })
    .await
}
