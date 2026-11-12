//! The document Mongoose inserts for `Model.create` / `new Model().save()`, `insertMany` and
//! `bulkWrite` `insertOne` (ledger `mongo.md`, rules 4, 5, 9, 12, 14, 16).
//!
//! The document is built as Mongoose's `Document` constructor builds it (see
//! [`crate::mongo::cast`]): every default, sub-document `_id` only where the sub-schema has one,
//! `trim`, unknown keys dropped, keys in the order Mongoose would store them. Then, per style:
//!
//! | style | timestamps | version key | key position |
//! |---|---|---|---|
//! | [`InsertStyle::Create`] | `createdAt` = now unless given; `updatedAt` = `createdAt` (a given `updatedAt` is replaced) | always `0` | timestamps, then `__v` at the end unless given |
//! | [`InsertStyle::InsertMany`] | each = now unless given | always `0` | `__v`, then timestamps |
//! | [`InsertStyle::BulkInsertOne`] | each = now unless given | `0` unless given | timestamps, then `__v` |
//!
//! Every number is typed as the Node BSON writer types a JavaScript number, whatever BSON type
//! the caller used. `minimize` removes empty objects (not arrays, not Maps, and not an object inside an array,
//! which is kept even when emptied).

use crate::mongo::cast::{
    Caster, PrepareError, WriteContext, check_document_depth, minimize, truthy,
};
use crate::mongo::number::normalize_js_numbers;
use crate::mongo::schema::Schema;
use bson::{Bson, Document};

/// Which Mongoose call inserts the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertStyle {
    /// `Model.create(doc)` or `new Model(doc).save()`.
    Create,
    /// `Model.insertMany([...])`, one document.
    InsertMany,
    /// `Model.bulkWrite([{ insertOne: { document } }])`.
    BulkInsertOne,
}

/// A prepared insert. Run it with [`crate::mongo::write::Writes`], which also enforces
/// [`PreparedInsert::dropped_paths`].
#[must_use = "a prepared insert does nothing until it is executed, and its dropped paths must be checked"]
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedInsert {
    /// The document to insert.
    pub document: Document,
    /// Paths strict mode dropped (unknown to the schema).
    pub dropped_paths: Vec<String>,
}

/// The document Mongoose inserts for `document`.
pub fn prepare_insert(
    schema: &Schema,
    document: &Document,
    style: InsertStyle,
    ctx: &mut WriteContext,
) -> Result<PreparedInsert, PrepareError> {
    check_document_depth(document)?;
    let mut caster = Caster::new(ctx);
    let mut doc = caster.construct(schema, Some(document), "")?;
    let now = Bson::DateTime(caster.ctx.now());
    let created_at = schema.created_at();
    let updated_at = schema.updated_at();
    let unless_given = |doc: &mut Document, key: Option<&str>| {
        if let Some(key) = key
            && !doc.get(key).is_some_and(truthy)
        {
            doc.insert(key, now.clone());
        }
    };
    match style {
        InsertStyle::Create => {
            unless_given(&mut doc, created_at);
            if let Some(updated) = updated_at {
                let stamp = created_at
                    .and_then(|c| doc.get(c).cloned())
                    .unwrap_or_else(|| now.clone());
                doc.insert(updated, stamp);
            }
            minimize(schema, &mut doc);
            if let Some(key) = schema.version_key {
                doc.insert(key, Bson::Int32(0));
            }
        }
        InsertStyle::InsertMany => {
            if let Some(key) = schema.version_key {
                doc.insert(key, Bson::Int32(0));
            }
            unless_given(&mut doc, created_at);
            unless_given(&mut doc, updated_at);
            minimize(schema, &mut doc);
        }
        InsertStyle::BulkInsertOne => {
            unless_given(&mut doc, created_at);
            unless_given(&mut doc, updated_at);
            if let Some(key) = schema.version_key
                && matches!(doc.get(key), None | Some(Bson::Null))
            {
                doc.insert(key, Bson::Int32(0));
            }
            minimize(schema, &mut doc);
        }
    }
    normalize_js_numbers(&mut doc);
    Ok(PreparedInsert {
        document: doc,
        dropped_paths: caster.dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mongo::schema::{DefaultValue as D, Field, Timestamps};
    use bson::{DateTime, doc};

    static SUB: Schema = Schema::subdocument(&[
        Field::value("label").trim(),
        Field::value("n").default(D::Int(1)),
    ]);
    static S: Schema = Schema::new(&[
        Field::value("name").trim(),
        Field::value("count").default(D::Int(0)),
        Field::array("tags"),
        Field::document_array("items", &SUB),
        Field::nested(
            "nested",
            &[
                Field::value("a").default(D::Str("x")),
                Field::nested("deep", &[Field::value("c").default(D::Bool(false))]),
            ],
        ),
        Field::mixed("meta").default_fn(D::EmptyDocument),
        Field::value("seenAt").default_fn(D::Now),
    ])
    .timestamps(Timestamps::CAMEL);

    #[test]
    fn create_orders_keys_like_mongoose() -> Result<(), PrepareError> {
        let mut ctx = WriteContext::with_sequential_ids(5_000, 1);
        let out = prepare_insert(
            &S,
            &doc! { "name": "  שלום 👋🏽 ", "zz": 1, "items": [{ "label": " a " }] },
            InsertStyle::Create,
            &mut ctx,
        )?;
        let keys: Vec<&str> = out.document.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "name",
                "count",
                "tags",
                "items",
                "nested",
                "_id",
                "seenAt",
                "createdAt",
                "updatedAt",
                "__v"
            ]
        );
        assert_eq!(out.document.get_str("name").ok(), Some("שלום 👋🏽"));
        assert_eq!(
            out.document.get_document("nested").ok(),
            Some(&doc! { "deep": { "c": false }, "a": "x" })
        );
        assert_eq!(
            out.document.get("createdAt"),
            Some(&Bson::DateTime(DateTime::from_millis(5_000)))
        );
        assert_eq!(out.dropped_paths, ["zz"]);
        let items = out
            .document
            .get_array("items")
            .map_err(|_| PrepareError::MissingId)?;
        assert_eq!(items.len(), 1);
        Ok(())
    }

    #[test]
    fn styles_differ_in_version_and_timestamps() -> Result<(), PrepareError> {
        let t1 = DateTime::from_millis(1);
        let t2 = DateTime::from_millis(2);
        let given = doc! { "name": "n", "createdAt": t1, "updatedAt": t2, "__v": 4 };
        let mut ctx = WriteContext::new(9);
        let create = prepare_insert(&S, &given, InsertStyle::Create, &mut ctx)?.document;
        assert_eq!(
            (create.get("updatedAt"), create.get("__v")),
            (Some(&Bson::DateTime(t1)), Some(&Bson::Int32(0)))
        );
        let many = prepare_insert(&S, &given, InsertStyle::InsertMany, &mut ctx)?.document;
        assert_eq!(
            (many.get("updatedAt"), many.get("__v")),
            (Some(&Bson::DateTime(t2)), Some(&Bson::Int32(0)))
        );
        let bulk = prepare_insert(&S, &given, InsertStyle::BulkInsertOne, &mut ctx)?.document;
        assert_eq!(bulk.get("__v"), Some(&Bson::Int32(4)));
        Ok(())
    }
}
