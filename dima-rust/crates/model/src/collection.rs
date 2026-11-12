//! What every collection module declares ([`CollectionInfo`]) and the reads every HTTP route
//! shares: documents without their `select: false` paths, rendered as Express renders them.

use crate::decode::DecodeError;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::{Rule, ValidationError, validate, validate_given};
use bson::{Document, RawDocument};
use dima_store::mongo::filter::prepare_filter;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::{InsertStyle, PreparedInsert, prepare_insert};
use dima_store::mongo::schema::Schema;
use dima_store::mongo::{MongoStore, PrepareError, WriteContext, json};
use futures_util::TryStreamExt;
use mongodb::options::FindOptions;
use serde_json::Value;

/// One collection: everything the registry, the tests and the binaries need to know about it.
#[derive(Clone, Copy, Debug)]
pub struct CollectionInfo {
    /// The collection name, exactly as Mongoose named it.
    pub name: &'static str,
    /// The Mongoose model name (validation messages start with it).
    pub model: &'static str,
    /// The TypeScript schema file, for readers.
    pub source: &'static str,
    /// The schema the store's write helpers work from. Collections with hooks keep writes behind
    /// their module's adapter functions; this is here for the registry and the tests.
    pub schema: &'static Schema,
    /// The type of `_id`.
    pub id_type: IdType,
    /// The `select: false` paths: left out of every read unless asked for.
    pub hidden: &'static [&'static str],
    /// The declared indexes, in the order Mongoose creates them.
    pub indexes: &'static [IndexSpec],
    /// The validators, in schema path order.
    pub rules: &'static [Rule],
    /// What the read type cannot decode: the write helpers refuse to store it (`shape.rs`).
    pub read_needs: &'static [ReadNeed],
    /// The Mongoose middleware the module's adapters reproduce.
    pub hooks: Hooks,
    /// Decodes a stored document with the module's read type (used by the real-data check).
    pub decode: fn(&RawDocument) -> Result<(), DecodeError>,
}

/// The Mongoose middleware of a collection. With any, writes go through the module's adapter
/// functions, never straight through the store's helpers with [`CollectionInfo::schema`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hooks {
    /// None: the store's helpers can be used with the schema directly.
    None,
    /// `pre('save')` document middleware: creates and saves go through the module.
    Save,
    /// Query middleware on updates and `pre('save')`: every update, create and save goes through
    /// the module.
    UpdatesAndSave,
}

/// A read for an HTTP response that failed.
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// The filter could not be cast (Mongoose's `CastError`).
    #[error(transparent)]
    Filter(#[from] PrepareError),
    /// The driver failed.
    #[error(transparent)]
    Driver(#[from] mongodb::error::Error),
}

impl CollectionInfo {
    /// Runs the validators on a document about to be inserted.
    pub fn validate(&self, document: &Document) -> Result<(), ValidationError> {
        validate(self.model, self.schema, self.rules, document)
    }

    /// `Model.create(given)` (or `new Model(given).save()`): the document Mongoose inserts
    /// (defaults, `_id`, `trim`, timestamps, `__v`), refused when a validator fails. Input types
    /// call this with the values they were given; hooks that run on create are the module's.
    pub fn prepare_create(
        &self,
        given: &Document,
        ctx: &mut WriteContext,
    ) -> Result<PreparedInsert, ModelError> {
        let prepared = prepare_insert(self.schema, given, InsertStyle::Create, ctx)?;
        validate_given(
            self.model,
            self.schema,
            self.rules,
            &prepared.document,
            Some(given),
        )?;
        self.check_insert(&prepared.document)?;
        Ok(prepared)
    }

    /// The projection Mongoose adds to a query that does not ask for the hidden paths, merged
    /// into the caller's projection: an exclusion projection gains the hidden paths, an inclusion
    /// projection is kept as it is (a hidden path then appears only if the caller named it, which
    /// is Mongoose's `+path`). `None` when there is nothing to add.
    pub fn read_projection(&self, projection: Option<Document>) -> Option<Document> {
        match projection {
            None if self.hidden.is_empty() => None,
            None => Some(json::exclusion_projection(self.hidden.iter().copied())),
            Some(projection) if is_inclusion(&projection) => Some(projection),
            Some(mut projection) => {
                for path in self.hidden {
                    if !projection.contains_key(*path) {
                        projection.insert(*path, 0);
                    }
                }
                Some(projection)
            }
        }
    }

    /// `Model.find(filter).lean()` sent to `res.json`: the filter cast as Mongoose casts it, the
    /// hidden paths excluded ([`CollectionInfo::read_projection`]), each document rendered as
    /// Express renders it. `options` carries sort, skip, limit and the caller's projection.
    pub async fn find_json(
        &self,
        store: &MongoStore,
        filter: &Document,
        mut options: FindOptions,
        ctx: &mut WriteContext,
    ) -> Result<Vec<Value>, ReadError> {
        let filter = prepare_filter(self.schema, filter, ctx)?;
        options.projection = self.read_projection(options.projection.take());
        let mut cursor = store
            .documents(self.name)
            .find(filter)
            .with_options(options)
            .await?;
        let mut out = Vec::new();
        while let Some(document) = cursor.try_next().await? {
            out.push(json::to_json_value(&document));
        }
        Ok(out)
    }

    /// `Model.findOne(filter).lean()` sent to `res.json` (see [`CollectionInfo::find_json`]).
    pub async fn find_one_json(
        &self,
        store: &MongoStore,
        filter: &Document,
        ctx: &mut WriteContext,
    ) -> Result<Option<Value>, ReadError> {
        let filter = prepare_filter(self.schema, filter, ctx)?;
        let collection = store.documents(self.name);
        let found = collection
            .find_one(filter)
            .with_options(
                mongodb::options::FindOneOptions::builder()
                    .projection(self.read_projection(None))
                    .build(),
            )
            .await?;
        Ok(found.map(|document| json::to_json_value(&document)))
    }

    /// A document read without the projection (what `findOneAndUpdate` returns) as `res.json`
    /// sends it: the hidden paths removed, then rendered.
    pub fn response_json(&self, mut document: Document) -> Value {
        json::remove_paths(&mut document, self.hidden);
        json::to_json_value(&document)
    }
}

fn is_inclusion(projection: &Document) -> bool {
    projection.iter().any(|(key, value)| {
        key != "_id"
            && !matches!(
                value,
                bson::Bson::Int32(0) | bson::Bson::Int64(0) | bson::Bson::Boolean(false)
            )
            && !matches!(value, bson::Bson::Double(v) if *v == 0.0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    static EMPTY: Schema = Schema::new(&[]);
    const INFO: CollectionInfo = CollectionInfo {
        name: "things",
        model: "Thing",
        source: "",
        schema: &EMPTY,
        id_type: IdType::ObjectId,
        hidden: &["secret", "deep.token"],
        indexes: &[],
        rules: &[],
        read_needs: &[],
        hooks: Hooks::None,
        decode: |_| Ok(()),
    };

    #[test]
    fn projections_follow_mongoose() {
        assert_eq!(
            INFO.read_projection(None),
            Some(doc! { "secret": 0, "deep.token": 0 })
        );
        assert_eq!(
            INFO.read_projection(Some(doc! { "other": 0 })),
            Some(doc! { "other": 0, "secret": 0, "deep.token": 0 })
        );
        assert_eq!(
            INFO.read_projection(Some(doc! { "name": 1, "_id": 0 })),
            Some(doc! { "name": 1, "_id": 0 })
        );
        let json =
            INFO.response_json(doc! { "a": 1, "secret": "s", "deep": { "token": "t", "k": 2 } });
        assert_eq!(json, serde_json::json!({ "a": 1, "deep": { "k": 2 } }));
    }
}
