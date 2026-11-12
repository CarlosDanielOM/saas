//! Running prepared writes: the one checked way to execute what [`crate::mongo::update`],
//! [`crate::mongo::insert`] and [`crate::mongo::save`] prepared.
//!
//! Every method first checks the prepared write's `dropped_paths` (paths the schema does not
//! know, which strict mode removed). Writing an unknown field is a mistake in the caller
//! (`MIGRATION.md` section 7, rule 4), so what happens is a [`DroppedPathPolicy`] of the
//! [`MongoStore`]: [`DroppedPathPolicy::Fail`] refuses the write with
//! [`WriteError::DroppedPaths`] (the default in debug builds, so every test that writes an
//! unknown field fails); [`DroppedPathPolicy::Report`] hands the paths to
//! [`CommandHook::dropped_paths`] and runs the write as Mongoose would (the default in release
//! builds, so production logs the mistake and keeps working).
//!
//! ```no_run
//! # async fn demo(store: &dima_store::mongo::MongoStore, prepared: dima_store::mongo::update::PreparedUpdate) -> Result<(), dima_store::mongo::write::WriteError> {
//! let outcome = store.writes("golden_camels").update_one(&prepared).await?;
//! if outcome.matched == 0 { /* nothing matched */ }
//! # Ok(()) }
//! ```
//!
//! [`Writes::session`] runs the writes inside a session (a transaction), and
//! [`Writes::write_concern`] sets the write concern (the reference uses `{w: 1, j: true}` for
//! domain events and stream-operation receipts). `bulkWrite` is not executed here: check it with
//! [`Writes::check`] and send the statements with the driver.

#[cfg(doc)]
use crate::mongo::connection::CommandHook;
use crate::mongo::connection::MongoStore;
use crate::mongo::insert::PreparedInsert;
use crate::mongo::save::PreparedSave;
use crate::mongo::update::{PreparedFindAndModify, PreparedUpdate};
use bson::{Bson, Document};
use mongodb::options::{UpdateModifications, WriteConcern};
use mongodb::{ClientSession, Collection};

/// What executing a write with dropped paths does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DroppedPathPolicy {
    /// Refuse the write with [`WriteError::DroppedPaths`]; nothing is sent.
    Fail,
    /// Report the paths to [`CommandHook::dropped_paths`] and send the write.
    Report,
}

impl Default for DroppedPathPolicy {
    /// [`DroppedPathPolicy::Fail`] in debug builds (tests), [`DroppedPathPolicy::Report`] in
    /// release builds (production).
    fn default() -> Self {
        if cfg!(debug_assertions) {
            Self::Fail
        } else {
            Self::Report
        }
    }
}

/// Paths a write dropped, as reported to [`CommandHook::dropped_paths`].
#[derive(Clone, Copy, Debug)]
pub struct DroppedPaths<'a> {
    /// The collection.
    pub collection: &'a str,
    /// `updateOne`, `insertOne`, `save`...
    pub operation: &'static str,
    /// The dropped paths (schema paths, never values).
    pub paths: &'a [String],
}

/// A write that failed.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// The write names paths the schema does not know, and the policy is
    /// [`DroppedPathPolicy::Fail`]. Nothing was sent.
    #[error("{operation} on {collection} names paths the schema does not know: {paths:?}")]
    DroppedPaths {
        /// The collection.
        collection: String,
        /// The operation.
        operation: &'static str,
        /// The dropped paths.
        paths: Vec<String>,
    },
    /// The driver failed (duplicate keys included: see [`crate::mongo::error::duplicate_key`]).
    #[error(transparent)]
    Driver(#[from] mongodb::error::Error),
}

/// What an `updateOne` / `updateMany` did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpdateOutcome {
    /// `false` when Mongoose would send nothing (the prepared update was empty): the counts are
    /// then 0, as Mongoose reports them.
    pub sent: bool,
    /// Matched documents.
    pub matched: u64,
    /// Modified documents.
    pub modified: u64,
    /// The `_id` of the document an upsert inserted.
    pub upserted_id: Option<Bson>,
}

/// What a save did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveOutcome {
    /// Nothing changed and the document still exists: nothing was written (Mongoose's save
    /// only reads `{_id}` then).
    Unchanged,
    /// The document was updated.
    Saved,
    /// Nothing matched the save's filter: the document is gone, or its version or a
    /// predicate added with [`PreparedSave::with_predicates`] no longer holds (Mongoose's
    /// `VersionError` when the save was versioned, `DocumentNotFoundError` otherwise). Not an
    /// error: the caller decides (reload and retry, or report a conflict).
    Conflict,
}

/// Writes to one collection of a [`MongoStore`].
pub struct Writes<'a> {
    store: &'a MongoStore,
    name: String,
    collection: Collection<Document>,
    session: Option<&'a mut ClientSession>,
    write_concern: Option<WriteConcern>,
}

impl MongoStore {
    /// Checked writes to `collection`.
    pub fn writes(&self, collection: &str) -> Writes<'_> {
        Writes {
            store: self,
            name: collection.to_owned(),
            collection: self.documents(collection),
            session: None,
            write_concern: None,
        }
    }
}

impl<'a> Writes<'a> {
    /// Runs every write in `session`.
    pub fn session(mut self, session: &'a mut ClientSession) -> Self {
        self.session = Some(session);
        self
    }

    /// The write concern of every write.
    pub fn write_concern(mut self, write_concern: WriteConcern) -> Self {
        self.write_concern = Some(write_concern);
        self
    }

    /// Applies the store's [`DroppedPathPolicy`] to `paths`: `Ok` when there are none or the
    /// policy reports them, [`WriteError::DroppedPaths`] when it fails them.
    pub fn check(&self, operation: &'static str, paths: &[String]) -> Result<(), WriteError> {
        if paths.is_empty() {
            return Ok(());
        }
        match self.store.dropped_path_policy() {
            DroppedPathPolicy::Fail => Err(WriteError::DroppedPaths {
                collection: self.name.clone(),
                operation,
                paths: paths.to_vec(),
            }),
            DroppedPathPolicy::Report => {
                if let Some(hook) = self.store.hook() {
                    hook.dropped_paths(&DroppedPaths {
                        collection: &self.name,
                        operation,
                        paths,
                    });
                }
                Ok(())
            }
        }
    }

    /// `Model.updateOne`.
    pub async fn update_one(
        &mut self,
        prepared: &PreparedUpdate,
    ) -> Result<UpdateOutcome, WriteError> {
        self.check("updateOne", &prepared.dropped_paths)?;
        self.run_update(prepared, false).await
    }

    /// `Model.updateMany`.
    pub async fn update_many(
        &mut self,
        prepared: &PreparedUpdate,
    ) -> Result<UpdateOutcome, WriteError> {
        self.check("updateMany", &prepared.dropped_paths)?;
        self.run_update(prepared, true).await
    }

    async fn run_update(
        &mut self,
        prepared: &PreparedUpdate,
        many: bool,
    ) -> Result<UpdateOutcome, WriteError> {
        let Some(update) = prepared.update.clone() else {
            return Ok(UpdateOutcome::default());
        };
        let update: UpdateModifications = update.into();
        let filter = prepared.filter.clone();
        let result = if many {
            let mut action = self
                .collection
                .update_many(filter, update)
                .upsert(prepared.upsert);
            if let Some(filters) = &prepared.array_filters {
                action = action.array_filters(filters.clone());
            }
            if let Some(concern) = &self.write_concern {
                action = action.write_concern(concern.clone());
            }
            match self.session.as_deref_mut() {
                Some(session) => action.session(session).await?,
                None => action.await?,
            }
        } else {
            let mut action = self
                .collection
                .update_one(filter, update)
                .upsert(prepared.upsert);
            if let Some(filters) = &prepared.array_filters {
                action = action.array_filters(filters.clone());
            }
            if let Some(concern) = &self.write_concern {
                action = action.write_concern(concern.clone());
            }
            match self.session.as_deref_mut() {
                Some(session) => action.session(session).await?,
                None => action.await?,
            }
        };
        Ok(UpdateOutcome {
            sent: true,
            matched: result.matched_count,
            modified: result.modified_count,
            upserted_id: result.upserted_id,
        })
    }

    /// `Model.findOneAndUpdate`: the document before or after the update, as
    /// [`PreparedFindAndModify::returned`] says. An empty update without upsert runs a plain
    /// `findOne`, as Mongoose does.
    pub async fn find_one_and_update(
        &mut self,
        prepared: &PreparedFindAndModify,
    ) -> Result<Option<Document>, WriteError> {
        self.check("findOneAndUpdate", &prepared.dropped_paths)?;
        let filter = prepared.filter.clone();
        let Some(update) = prepared.update.clone() else {
            let action = self.collection.find_one(filter);
            return Ok(match self.session.as_deref_mut() {
                Some(session) => action.session(session).await?,
                None => action.await?,
            });
        };
        let update: UpdateModifications = update.into();
        let mut action = self
            .collection
            .find_one_and_update(filter, update)
            .upsert(prepared.upsert)
            .return_document(prepared.return_document());
        if let Some(filters) = &prepared.array_filters {
            action = action.array_filters(filters.clone());
        }
        if let Some(concern) = &self.write_concern {
            action = action.write_concern(concern.clone());
        }
        Ok(match self.session.as_deref_mut() {
            Some(session) => action.session(session).await?,
            None => action.await?,
        })
    }

    /// `Model.create` / `new Model().save()` of one document.
    pub async fn insert_one(&mut self, prepared: &PreparedInsert) -> Result<(), WriteError> {
        self.check("insertOne", &prepared.dropped_paths)?;
        let mut action = self.collection.insert_one(prepared.document.clone());
        if let Some(concern) = &self.write_concern {
            action = action.write_concern(concern.clone());
        }
        match self.session.as_deref_mut() {
            Some(session) => action.session(session).await?,
            None => action.await?,
        };
        Ok(())
    }

    /// `Model.insertMany` (ordered, as Mongoose's default). Every document is checked before
    /// anything is sent.
    pub async fn insert_many(&mut self, prepared: &[PreparedInsert]) -> Result<(), WriteError> {
        let dropped: Vec<String> = prepared
            .iter()
            .flat_map(|p| p.dropped_paths.iter().cloned())
            .collect();
        self.check("insertMany", &dropped)?;
        if prepared.is_empty() {
            return Ok(());
        }
        let mut action = self
            .collection
            .insert_many(prepared.iter().map(|p| p.document.clone()));
        if let Some(concern) = &self.write_concern {
            action = action.write_concern(concern.clone());
        }
        match self.session.as_deref_mut() {
            Some(session) => action.session(session).await?,
            None => action.await?,
        };
        Ok(())
    }

    /// `doc.save()` of a loaded document. Nothing matched is a [`SaveOutcome::Conflict`].
    pub async fn save(&mut self, prepared: &PreparedSave) -> Result<SaveOutcome, WriteError> {
        self.check("save", &prepared.dropped_paths)?;
        let Some(update) = prepared.update.clone() else {
            // Mongoose still checks that the document exists (`findOne({_id})`, predicates
            // ignored) and fails with `DocumentNotFoundError` when it is gone.
            let action = self
                .collection
                .find_one(prepared.filter.clone())
                .projection(bson::doc! { "_id": 1 });
            let found = match self.session.as_deref_mut() {
                Some(session) => action.session(session).await?,
                None => action.await?,
            };
            return Ok(if found.is_some() {
                SaveOutcome::Unchanged
            } else {
                SaveOutcome::Conflict
            });
        };
        let mut action = self.collection.update_one(prepared.filter.clone(), update);
        if let Some(concern) = &self.write_concern {
            action = action.write_concern(concern.clone());
        }
        let result = match self.session.as_deref_mut() {
            Some(session) => action.session(session).await?,
            None => action.await?,
        };
        Ok(if result.matched_count == 0 {
            SaveOutcome::Conflict
        } else {
            SaveOutcome::Saved
        })
    }
}
