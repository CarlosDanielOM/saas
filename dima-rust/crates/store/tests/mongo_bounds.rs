//! Resource bounds of the write helpers: nesting depth and the cost of many changes.

use bson::{Bson, Document, doc, oid::ObjectId};
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::update::{UpdateOptions, prepare_update};
use dima_store::mongo::{MAX_DEPTH, PrepareError, WriteContext};
use std::time::{Duration, Instant};

static S: Schema = Schema::new(&[Field::mixed("meta"), Field::array("tags")]);

/// A schema whose sub-document defaults to itself: building a new document never ends.
static NODE: Schema = Schema::subdocument(&[
    Field::value("v"),
    Field::subdocument("child", &NODE).default_fn(D::EmptyDocument),
]);
static TREE: Schema =
    Schema::new(&[Field::subdocument("root", &NODE).default_fn(D::EmptyDocument)]);

fn deep(levels: usize) -> Bson {
    (0..levels).fold(Bson::Int32(1), |inner, _| {
        Bson::Document(doc! { "k": inner })
    })
}

const TOO_DEEP: PrepareError = PrepareError::TooDeep { limit: MAX_DEPTH };

#[test]
fn nesting_up_to_the_limit_is_accepted() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(0);
    // The document itself is level 1, so `meta` may hold MAX_DEPTH - 1 levels.
    prepare_insert(
        &S,
        &doc! { "meta": deep(MAX_DEPTH - 1) },
        InsertStyle::Create,
        &mut ctx,
    )?;
    Ok(())
}

#[test]
fn deeper_inputs_fail_with_a_clear_error() {
    let mut ctx = WriteContext::new(0);
    let too_deep = deep(MAX_DEPTH);
    // Much deeper than MongoDB stores (cloning and dropping a `Bson` recurse, so the test
    // stays far below what would overflow a test thread's stack).
    let much_deeper = deep(1_000);
    for value in [too_deep, much_deeper] {
        assert_eq!(
            prepare_insert(
                &S,
                &doc! { "meta": value.clone() },
                InsertStyle::Create,
                &mut ctx
            )
            .err(),
            Some(TOO_DEEP)
        );
        let update = prepare_update(
            &S,
            &doc! {},
            doc! { "$set": { "meta": value.clone() } },
            UpdateOptions::default(),
            &mut ctx,
        );
        assert_eq!(update.err(), Some(TOO_DEEP));
        let filter = prepare_update(
            &S,
            &doc! { "meta": value.clone() },
            doc! { "$set": { "tags": [] } },
            UpdateOptions::default(),
            &mut ctx,
        );
        assert_eq!(filter.err(), Some(TOO_DEEP));
        let array_filters = prepare_update(
            &S,
            &doc! {},
            doc! { "$set": { "tags.$[t]": "x" } },
            UpdateOptions::default().array_filters(vec![doc! { "t": value.clone() }]),
            &mut ctx,
        );
        assert_eq!(array_filters.err(), Some(TOO_DEEP));
        let loaded = doc! { "_id": ObjectId::from_bytes([1; 12]), "meta": value.clone() };
        assert_eq!(
            prepare_save(&S, &loaded, &[], &mut ctx).err(),
            Some(TOO_DEEP)
        );
        let loaded = doc! { "_id": ObjectId::from_bytes([1; 12]) };
        assert_eq!(
            prepare_save(&S, &loaded, &[Change::set("meta", value.clone())], &mut ctx).err(),
            Some(TOO_DEEP)
        );
        assert_eq!(
            prepare_save(&S, &loaded, &[Change::push("tags", [value])], &mut ctx).err(),
            Some(TOO_DEEP)
        );
    }
}

#[test]
fn a_schema_that_defaults_to_itself_stops_at_the_limit() {
    let mut ctx = WriteContext::new(0);
    assert_eq!(
        prepare_insert(&TREE, &doc! {}, InsertStyle::Create, &mut ctx).err(),
        Some(TOO_DEEP)
    );
}

#[test]
fn many_pushes_and_changes_stay_linear() -> Result<(), PrepareError> {
    static ARRAYS: Schema = Schema::new(&[
        Field::array("tags"),
        Field::mixed("meta"),
        Field::value("n"),
    ]);
    let loaded: Document = doc! {
        "_id": ObjectId::from_bytes([1; 12]),
        "tags": (0..10_000).map(Bson::Int32).collect::<Vec<_>>(),
        "__v": 0,
    };
    let mut changes: Vec<Change> = (0..20_000)
        .map(|i| Change::push("tags", [Bson::Int32(i)]))
        .collect();
    changes.extend((0..20_000).map(|i| Change::set("n", i)));
    let started = Instant::now();
    let mut ctx = WriteContext::new(0);
    let Some(out) = prepare_save(&ARRAYS, &loaded, &changes, &mut ctx)? else {
        panic!("nothing to save");
    };
    let elapsed = started.elapsed();
    let pushed = out
        .update
        .get_document("$push")
        .and_then(|p| p.get_document("tags"))
        .and_then(|t| t.get_array("$each"))
        .map(Vec::len)
        .ok();
    assert_eq!(pushed, Some(20_000));
    assert_eq!(
        out.update
            .get_document("$set")
            .ok()
            .and_then(|s| s.get("n")),
        Some(&Bson::Int32(19_999))
    );
    // Quadratic behaviour (copying the 10 000-element array on every push) takes tens of
    // seconds in a debug build; linear work takes well under one.
    assert!(
        elapsed < Duration::from_secs(5),
        "40 000 changes took {elapsed:?}"
    );
    Ok(())
}
