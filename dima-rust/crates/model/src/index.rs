//! Declared indexes, created the way Mongoose's `Model.init()` creates them.
//!
//! On first use of a model, Mongoose creates the collection (`autoCreate`) and then each declared
//! index, one `createIndexes` command per index, in `schema.indexes()` order (field-level
//! `index: true` first, then the `schema.index(...)` calls). It adds `background: true`, which
//! MongoDB 4.2 and later ignore and do not store (the stored specifications are compared in
//! `tests/writes.rs`), so it is not sent here. It never drops an index. An index that fails (an `IndexOptionsConflict` with an older index of
//! the same name, for example) is reported and the others are still created; [`ensure_indexes`]
//! does the same and returns every failure for the caller to log.

use crate::collection::CollectionInfo;
use bson::{Bson, Document};
use dima_store::mongo::MongoStore;
use mongodb::IndexModel;
use mongodb::options::IndexOptions;
use std::time::Duration;

/// One declared index.
#[derive(Clone, Copy, Debug)]
pub struct IndexSpec {
    /// The keys in order, with their direction (`1` or `-1`).
    pub keys: &'static [(&'static str, i32)],
    /// `unique: true`.
    pub unique: bool,
    /// `sparse: true`.
    pub sparse: bool,
    /// `expireAfterSeconds` (TTL indexes).
    pub expire_after_seconds: Option<u64>,
    /// `partialFilterExpression`.
    pub partial_filter: Option<fn() -> Document>,
}

impl IndexSpec {
    /// A plain index on `keys`.
    pub const fn on(keys: &'static [(&'static str, i32)]) -> Self {
        Self {
            keys,
            unique: false,
            sparse: false,
            expire_after_seconds: None,
            partial_filter: None,
        }
    }

    /// `unique: true`.
    pub const fn unique(mut self) -> Self {
        self.unique = true;
        self
    }

    /// `sparse: true`.
    pub const fn sparse(mut self) -> Self {
        self.sparse = true;
        self
    }

    /// `expireAfterSeconds`.
    pub const fn expire_after_seconds(mut self, seconds: u64) -> Self {
        self.expire_after_seconds = Some(seconds);
        self
    }

    /// `partialFilterExpression`.
    pub const fn partial(mut self, filter: fn() -> Document) -> Self {
        self.partial_filter = Some(filter);
        self
    }

    /// The key document.
    pub fn key_document(&self) -> Document {
        self.keys
            .iter()
            .map(|(key, direction)| ((*key).to_owned(), Bson::Int32(*direction)))
            .collect()
    }

    /// The name the server gives it (`channelID_1_started_at_-1`), which both drivers derive
    /// from the keys.
    pub fn name(&self) -> String {
        self.keys
            .iter()
            .map(|(key, direction)| format!("{key}_{direction}"))
            .collect::<Vec<_>>()
            .join("_")
    }

    /// The driver index model, with the declared options.
    pub fn model(&self) -> IndexModel {
        let options = IndexOptions::builder()
            .unique(self.unique.then_some(true))
            .sparse(self.sparse.then_some(true))
            .expire_after(self.expire_after_seconds.map(Duration::from_secs))
            .partial_filter_expression(self.partial_filter.map(|filter| filter()))
            .build();
        IndexModel::builder()
            .keys(self.key_document())
            .options(options)
            .build()
    }
}

/// An index [`ensure_indexes`] could not create.
#[derive(Debug, thiserror::Error)]
#[error("{collection}: index {index}: {error}")]
pub struct IndexFailure {
    /// The collection.
    pub collection: &'static str,
    /// The index name.
    pub index: String,
    /// The driver error.
    pub error: mongodb::error::Error,
}

/// What `Model.init()` does for `info`: creates the collection if it does not exist, then each
/// declared index in order. Returns the indexes that failed (none is retried).
pub async fn ensure_indexes(store: &MongoStore, info: &CollectionInfo) -> Vec<IndexFailure> {
    let mut failures = Vec::new();
    if let Err(error) = ensure_collection(store, info.name).await {
        failures.push(IndexFailure {
            collection: info.name,
            index: String::new(),
            error,
        });
        return failures;
    }
    let collection = store.documents(info.name);
    for spec in info.indexes {
        if let Err(error) = collection.create_index(spec.model()).await {
            failures.push(IndexFailure {
                collection: info.name,
                index: spec.name(),
                error,
            });
        }
    }
    failures
}

/// `createCollection` unless the collection exists (the server's `NamespaceExists`, code 48, is
/// what Mongoose ignores too).
async fn ensure_collection(store: &MongoStore, name: &str) -> Result<(), mongodb::error::Error> {
    match store.database().create_collection(name).await {
        Ok(()) => Ok(()),
        Err(error) if dima_store::mongo::error::server_code(&error) == Some(48) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn names_and_options() {
        let spec = IndexSpec::on(&[("channelID", 1), ("started_at", -1), ("ended_at", 1)])
            .unique()
            .partial(|| doc! { "ended_at": Bson::Null });
        assert_eq!(spec.name(), "channelID_1_started_at_-1_ended_at_1");
        let model = spec.model();
        assert_eq!(
            model.keys,
            doc! { "channelID": 1, "started_at": -1, "ended_at": 1 }
        );
        let options = model.options.unwrap_or_default();
        assert_eq!(options.unique, Some(true));
        assert_eq!(options.sparse, None);
        assert_eq!(
            options.partial_filter_expression,
            Some(doc! { "ended_at": Bson::Null })
        );
        let ttl = IndexSpec::on(&[("expiresAt", 1)])
            .expire_after_seconds(0)
            .model();
        assert_eq!(
            ttl.options.and_then(|o| o.expire_after),
            Some(Duration::from_secs(0))
        );
        assert_eq!(
            IndexSpec::on(&[("availability.nextAt", 1)]).name(),
            "availability.nextAt_1"
        );
    }
}
