//! A stored document loaded whole, the only input a save accepts.
//!
//! A save hydrates the loaded document as Mongoose does: every schema path the document lacks gets
//! its default, and those defaults are written. A document read with a projection lacks the paths
//! the projection left out, so saving it would overwrite them with their defaults (a stream
//! session read without `select: false` paths would get `applied_domain_event_keys: []`).
//! [`LoadedForSave`] makes that impossible: only [`CollectionInfo::load_for_save`] (no projection,
//! hidden paths included) creates one, and every save entry point takes it.

use crate::collection::{CollectionInfo, ReadError};
use crate::decode::{DecodeError, decode_document};
use bson::{Bson, Document};
use dima_store::mongo::filter::prepare_filter;
use dima_store::mongo::{MongoStore, WriteContext};
use mongodb::ClientSession;
use serde::de::DeserializeOwned;
use std::fmt;

/// One whole stored document of a collection (no projection), as a save needs it.
///
/// Created only by [`CollectionInfo::load_for_save`] and
/// [`CollectionInfo::load_for_save_in`]: a projected read, a document built by hand or one of
/// another collection cannot be saved. `Debug` prints the collection and `_id` only (the
/// document holds private paths).
///
/// ```compile_fail
/// // Not constructible outside this crate.
/// let loaded = dima_model::LoadedForSave { collection: "users", document: bson::Document::new() };
/// ```
#[derive(Clone)]
pub struct LoadedForSave {
    collection: &'static str,
    document: Document,
}

impl LoadedForSave {
    /// The collection the document was loaded from.
    pub fn collection(&self) -> &'static str {
        self.collection
    }

    /// The stored document, as read.
    pub fn document(&self) -> &Document {
        &self.document
    }

    /// `_id`.
    pub fn id(&self) -> Option<&Bson> {
        self.document.get("_id")
    }

    /// The document as the collection's read type.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T, DecodeError> {
        decode_document(&self.document)
    }

    /// A value for the crate's unit tests, which have no database.
    #[cfg(test)]
    pub(crate) fn for_test(info: &CollectionInfo, document: Document) -> Self {
        Self {
            collection: info.name,
            document,
        }
    }
}

impl fmt::Debug for LoadedForSave {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoadedForSave")
            .field("collection", &self.collection)
            .field("_id", &self.id())
            .finish_non_exhaustive()
    }
}

impl CollectionInfo {
    /// `Model.findOne(filter)` for a later `doc.save()`: the whole document, `select: false`
    /// paths included. The filter is cast as Mongoose casts it.
    pub async fn load_for_save(
        &self,
        store: &MongoStore,
        filter: &Document,
        ctx: &mut WriteContext,
    ) -> Result<Option<LoadedForSave>, ReadError> {
        let filter = prepare_filter(self.schema, filter, ctx)?;
        let found = store.documents(self.name).find_one(filter).await?;
        Ok(found.map(|document| self.loaded(document)))
    }

    /// [`CollectionInfo::load_for_save`] inside a session (a transaction).
    pub async fn load_for_save_in(
        &self,
        store: &MongoStore,
        session: &mut ClientSession,
        filter: &Document,
        ctx: &mut WriteContext,
    ) -> Result<Option<LoadedForSave>, ReadError> {
        let filter = prepare_filter(self.schema, filter, ctx)?;
        let found = store
            .documents(self.name)
            .find_one(filter)
            .session(session)
            .await?;
        Ok(found.map(|document| self.loaded(document)))
    }

    fn loaded(&self, document: Document) -> LoadedForSave {
        LoadedForSave {
            collection: self.name,
            document,
        }
    }
}
