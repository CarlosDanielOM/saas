//! **Workaround module.** MongoDB operations of the gift, referral and reward flows with a
//! deadline on every call.
//!
//! The reference sends these with `maxTimeMS: 5_000` and `writeConcern: {w: 1, j: true}`
//! (`credit_gifts.ts` `WRITE`, `paid_order_reward.ts`). The store's write helpers
//! (`dima_store::mongo::write::Writes`) take the write concern but neither a server time limit
//! nor a `sort` on `findOneAndUpdate` (the gift worker's claim needs `sort: {nextAttemptAt: 1}`).
//! So: every write is prepared by the model crate (`CollectionInfo::prepare_*`: casting,
//! defaults, timestamps, the write guard), a prepared write that lost paths is refused, updates
//! run through `Writes` under a client deadline, and `findOneAndUpdate` and reads run on the
//! driver with `maxTimeMS` and the same deadline. Change wanted in the store: a time limit and a
//! sort on `Writes` (F-STORE-DF-c lists the same for the usage ledger), after which this module
//! goes away.

use bson::{Document, doc};
use dima_model::collection::CollectionInfo;
use dima_store::mongo::MongoStore;
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::{Returned, UpdateDoc, UpdateOptions};
use dima_store::mongo::write::{UpdateOutcome, WriteError};
use futures_util::TryStreamExt;
use mongodb::options::{Acknowledgment, WriteConcern};
use std::future::IntoFuture;
use std::time::Duration;

/// The reference's `maxTimeMS` (`credit_gifts.ts`: 5 s).
pub const MAX_TIME: Duration = Duration::from_secs(5);
/// The client deadline of one operation: the server limit and a margin.
pub const OP_DEADLINE: Duration = Duration::from_secs(15);
/// The most documents a list read here returns before it fails (no list of these flows is
/// near it: a page is 21 documents, a referral owner has at most 15 codes).
pub const MAX_LIST: usize = 10_000;

/// Why a MongoDB operation failed. Messages hold no document content.
#[derive(Debug, thiserror::Error)]
pub enum MongoOpError {
    /// The model crate refused the write (validation, the write guard).
    #[error(transparent)]
    Model(#[from] dima_model::error::ModelError),
    /// The store refused or the driver failed.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// The driver failed.
    #[error(transparent)]
    Driver(#[from] mongodb::error::Error),
    /// A stored document could not be read.
    #[error(transparent)]
    Decode(#[from] dima_model::decode::DecodeError),
    /// The operation passed its client deadline.
    #[error("MongoDB {0} passed its deadline")]
    Deadline(&'static str),
    /// A list read passed [`MAX_LIST`].
    #[error("MongoDB {0} returned more than {MAX_LIST} documents")]
    TooMany(&'static str),
}

impl MongoOpError {
    /// A duplicate key (E11000).
    pub fn is_duplicate_key(&self) -> bool {
        match self {
            Self::Driver(error) | Self::Write(WriteError::Driver(error)) => {
                dima_store::mongo::error::is_duplicate_key(error)
            }
            _ => false,
        }
    }
}

/// `{w: 1, j: true}`.
pub fn journaled() -> WriteConcern {
    WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build()
}

/// Runs `operation` under [`OP_DEADLINE`].
pub async fn deadline<T, E>(
    what: &'static str,
    operation: impl IntoFuture<Output = Result<T, E>>,
) -> Result<T, MongoOpError>
where
    MongoOpError: From<E>,
{
    match tokio::time::timeout(OP_DEADLINE, operation.into_future()).await {
        Ok(result) => result.map_err(MongoOpError::from),
        Err(_) => Err(MongoOpError::Deadline(what)),
    }
}

/// `Model.updateOne(filter, update, options)` with the write concern `concern` (or the
/// default), prepared by the model crate.
pub async fn update_one(
    store: &MongoStore,
    info: &CollectionInfo,
    filter: &Document,
    update: Document,
    options: UpdateOptions,
    concern: Option<WriteConcern>,
    now_ms: i64,
) -> Result<UpdateOutcome, MongoOpError> {
    let mut ctx = WriteContext::new(now_ms);
    let prepared = info.prepare_update(filter, update, options, &mut ctx)?;
    let mut writes = store.writes(info.name);
    if let Some(concern) = concern {
        writes = writes.write_concern(concern);
    }
    deadline("updateOne", writes.update_one(&prepared)).await
}

/// `Model.findOneAndUpdate(filter, update, {sort, new})` with `maxTimeMS`, prepared by the
/// model crate and run on the driver (the store's helper has no sort).
#[allow(clippy::too_many_arguments)]
pub async fn find_one_and_update(
    store: &MongoStore,
    info: &CollectionInfo,
    filter: &Document,
    update: Document,
    options: UpdateOptions,
    returned: Returned,
    sort: Option<Document>,
    concern: Option<WriteConcern>,
    now_ms: i64,
) -> Result<Option<Document>, MongoOpError> {
    let mut ctx = WriteContext::new(now_ms);
    let prepared = info.prepare_find_one_and_update(filter, update, options, returned, &mut ctx)?;
    // The store's own check (strict mode dropped a path: refused, never sent).
    store
        .writes(info.name)
        .check("findOneAndUpdate", &prepared.dropped_paths)?;
    let collection = store.documents(info.name);
    let Some(update) = prepared.update.clone() else {
        let mut action = collection
            .find_one(prepared.filter.clone())
            .max_time(MAX_TIME);
        if let Some(sort) = sort {
            action = action.sort(sort);
        }
        return deadline("findOne", action).await;
    };
    let update: mongodb::options::UpdateModifications = match update {
        UpdateDoc::Document(document) => document.into(),
        UpdateDoc::Pipeline(stages) => stages.into(),
    };
    let mut action = collection
        .find_one_and_update(prepared.filter.clone(), update)
        .upsert(prepared.upsert)
        .return_document(prepared.return_document())
        .max_time(MAX_TIME);
    if let Some(sort) = sort {
        action = action.sort(sort);
    }
    if let Some(filters) = prepared.array_filters.clone() {
        action = action.array_filters(filters);
    }
    if let Some(concern) = concern {
        action = action.write_concern(concern);
    }
    deadline("findOneAndUpdate", action).await
}

/// `Model.findOne(filter)` with `maxTimeMS` (`projection` as given, `None` for the whole
/// document).
pub async fn find_one(
    store: &MongoStore,
    collection: &str,
    filter: Document,
    projection: Option<Document>,
) -> Result<Option<Document>, MongoOpError> {
    let documents = store.documents(collection);
    let mut action = documents.find_one(filter).max_time(MAX_TIME);
    if let Some(projection) = projection {
        action = action.projection(projection);
    }
    deadline("findOne", action).await
}

/// `Model.exists(filter)`: whether a document matches.
pub async fn exists(
    store: &MongoStore,
    collection: &str,
    filter: Document,
) -> Result<bool, MongoOpError> {
    Ok(find_one(store, collection, filter, Some(doc! { "_id": 1 }))
        .await?
        .is_some())
}

/// A bounded `find` (sort, skip, limit, projection as given), read to its end within
/// [`MAX_LIST`].
pub async fn find(
    store: &MongoStore,
    collection: &str,
    filter: Document,
    options: mongodb::options::FindOptions,
) -> Result<Vec<Document>, MongoOpError> {
    let mut options = options;
    options.max_time = Some(MAX_TIME);
    let read = async {
        let mut cursor = store
            .documents(collection)
            .find(filter)
            .with_options(options)
            .await?;
        let mut out = Vec::new();
        while let Some(document) = cursor.try_next().await? {
            if out.len() >= MAX_LIST {
                return Err(MongoOpError::TooMany("find"));
            }
            out.push(document);
        }
        Ok(out)
    };
    match tokio::time::timeout(OP_DEADLINE, read).await {
        Ok(result) => result,
        Err(_) => Err(MongoOpError::Deadline("find")),
    }
}

/// `countDocuments(filter)` with `maxTimeMS`.
pub async fn count(
    store: &MongoStore,
    collection: &str,
    filter: Document,
) -> Result<u64, MongoOpError> {
    deadline(
        "countDocuments",
        store
            .documents(collection)
            .count_documents(filter)
            .max_time(MAX_TIME),
    )
    .await
}

/// An aggregation read to its end within [`MAX_LIST`].
pub async fn aggregate(
    store: &MongoStore,
    collection: &str,
    pipeline: Vec<Document>,
) -> Result<Vec<Document>, MongoOpError> {
    let read = async {
        let mut cursor = store
            .documents(collection)
            .aggregate(pipeline)
            .max_time(MAX_TIME)
            .await?;
        let mut out = Vec::new();
        while let Some(document) = cursor.try_next().await? {
            if out.len() >= MAX_LIST {
                return Err(MongoOpError::TooMany("aggregate"));
            }
            out.push(document);
        }
        Ok(out)
    };
    match tokio::time::timeout(OP_DEADLINE, read).await {
        Ok(result) => result,
        Err(_) => Err(MongoOpError::Deadline("aggregate")),
    }
}
