//! The `eventsubs` reads and writes of this module. Writes go through `dima-model`'s helpers
//! (what Mongoose would send for the same call: casting, `setDefaultsOnInsert`, the write
//! guard); reads are `.lean()` reads of whole documents as stored (a missing field stays
//! missing, which the settings spread depends on). Every operation runs under the crate's
//! store deadline; a find reads at most [`MAX_DOCUMENTS`] documents.

use crate::base::Inner;
use crate::error::TwitchError;
use bson::{Bson, Document, doc};
use dima_model::eventsubs::{COLLECTION, INFO};
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::{Returned, UpdateOptions as StoreUpdateOptions};
use futures_util::TryStreamExt;

/// The most documents one find returns (the reference has no bound; the production copy holds
/// 2,154 subscriptions in all).
pub(crate) const MAX_DOCUMENTS: usize = 100_000;

fn refused(error: impl std::fmt::Display) -> TwitchError {
    TwitchError::Write(error.to_string())
}

/// The collection of a process.
pub(crate) struct Eventsubs<'a> {
    inner: &'a Inner,
}

impl<'a> Eventsubs<'a> {
    pub(crate) fn new(inner: &'a Inner) -> Self {
        Self { inner }
    }

    fn context(&self) -> WriteContext {
        WriteContext::new(self.inner.now_ms())
    }

    /// `Eventsub.find(filter).lean()` in natural order (at most [`MAX_DOCUMENTS`]).
    pub(crate) async fn find(
        &self,
        op: &'static str,
        filter: Document,
    ) -> Result<Vec<Document>, TwitchError> {
        let inner = self.inner;
        let collection = inner.mongo.documents(COLLECTION);
        let mut cursor = inner.mongo_op(op, collection.find(filter)).await?;
        let mut found = Vec::new();
        while let Some(document) = inner.mongo_op(op, cursor.try_next()).await? {
            if found.len() >= MAX_DOCUMENTS {
                return Err(TwitchError::Mongo {
                    op,
                    message: format!("more than {MAX_DOCUMENTS} documents"),
                });
            }
            found.push(document);
        }
        Ok(found)
    }

    /// `Eventsub.findOne(filter).lean()`.
    pub(crate) async fn find_one(
        &self,
        op: &'static str,
        filter: Document,
    ) -> Result<Option<Document>, TwitchError> {
        let inner = self.inner;
        let collection = inner.mongo.documents(COLLECTION);
        inner.mongo_op(op, collection.find_one(filter)).await
    }

    /// `Eventsub.findOneAndUpdate(filter, {$set}, {upsert, new: true, setDefaultsOnInsert})`
    /// (`upsert: false` without it).
    pub(crate) async fn set_returning(
        &self,
        op: &'static str,
        filter: Document,
        set: Document,
        upsert: bool,
    ) -> Result<Option<Document>, TwitchError> {
        let options = if upsert {
            StoreUpdateOptions::upsert()
        } else {
            StoreUpdateOptions::default()
        };
        let prepared = INFO
            .prepare_find_one_and_update(
                &filter,
                doc! { "$set": set },
                options,
                Returned::After,
                &mut self.context(),
            )
            .map_err(refused)?;
        let inner = self.inner;
        let mut writes = inner.mongo.writes(COLLECTION);
        inner
            .mongo_op(op, writes.find_one_and_update(&prepared))
            .await
    }

    /// `Eventsub.updateOne` / `updateMany(filter, {$set})`; the number of documents matched.
    #[allow(dead_code)] // The reconciliation's (part 3).
    pub(crate) async fn set(
        &self,
        op: &'static str,
        filter: Document,
        set: Document,
        many: bool,
    ) -> Result<u64, TwitchError> {
        let prepared = INFO
            .prepare_update(
                &filter,
                doc! { "$set": set },
                StoreUpdateOptions::default(),
                &mut self.context(),
            )
            .map_err(refused)?;
        let inner = self.inner;
        let mut writes = inner.mongo.writes(COLLECTION);
        let outcome = if many {
            inner.mongo_op(op, writes.update_many(&prepared)).await?
        } else {
            inner.mongo_op(op, writes.update_one(&prepared)).await?
        };
        Ok(outcome.matched)
    }

    /// `Eventsub.deleteOne(filter)`; the number deleted.
    pub(crate) async fn delete_one(
        &self,
        op: &'static str,
        filter: Document,
    ) -> Result<u64, TwitchError> {
        let inner = self.inner;
        let collection = inner.mongo.documents(COLLECTION);
        Ok(inner
            .mongo_op(op, collection.delete_one(filter))
            .await?
            .deleted_count)
    }

    /// `Eventsub.deleteMany({_id: {$in: ids}})`; the number deleted.
    #[allow(dead_code)] // The reconciliation's (part 3).
    pub(crate) async fn delete_ids(
        &self,
        op: &'static str,
        ids: Vec<Bson>,
    ) -> Result<u64, TwitchError> {
        let inner = self.inner;
        let collection = inner.mongo.documents(COLLECTION);
        Ok(inner
            .mongo_op(op, collection.delete_many(doc! { "_id": { "$in": ids } }))
            .await?
            .deleted_count)
    }
}

/// A stored value as a filter value: the value itself, `null` for a missing one (Mongoose sends
/// `{id: undefined}` as `{id: null}`, which also matches a missing path).
pub(crate) fn filter_value(document: &Document, path: &str) -> Bson {
    match document.get(path) {
        None | Some(Bson::Undefined) => Bson::Null,
        Some(value) => value.clone(),
    }
}
