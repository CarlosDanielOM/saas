//! Every number a write helper sends is typed as the Node BSON writer types a JavaScript number
//! (int32 when integral and in the int32 range, double otherwise), whatever Rust type the caller
//! started from. The Node side of this table is pinned by `golden.json` (`numbers.jsNumbers`,
//! and the `numbers_*` cases replayed by `mongo_golden.rs`).

use bson::{Bson, Document, doc, oid::ObjectId};
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use dima_store::mongo::update::{
    BulkUpdate, Returned, UpdateDoc, UpdateOptions, prepare_bulk_update,
    prepare_find_one_and_update, prepare_update,
};
use dima_store::mongo::{PrepareError, WriteContext};

static S: Schema = Schema::new(&[
    Field::number("n"),
    Field::number("count").default(D::Int(0)),
    Field::mixed("free"),
    Field::array("list", ValueType::Number),
])
.timestamps(Timestamps::CAMEL);

/// (what a Rust caller may pass, what Node stores for the same JavaScript number)
fn table() -> Vec<(Bson, Bson)> {
    vec![
        (Bson::Int32(0), Bson::Int32(0)),
        (Bson::Int64(7), Bson::Int32(7)),
        (Bson::Double(1.0), Bson::Int32(1)),
        (Bson::Double(0.5), Bson::Double(0.5)),
        (Bson::Double(-0.0), Bson::Double(-0.0)),
        (Bson::Int32(i32::MAX), Bson::Int32(i32::MAX)),
        (Bson::Int64(2_147_483_648), Bson::Double(2_147_483_648.0)),
        (Bson::Int32(i32::MIN), Bson::Int32(i32::MIN)),
        (Bson::Int64(-2_147_483_649), Bson::Double(-2_147_483_649.0)),
        (Bson::Double(2_147_483_647.0), Bson::Int32(i32::MAX)),
        (Bson::Double(2_147_483_648.0), Bson::Double(2_147_483_648.0)),
        (
            Bson::Int64(9_007_199_254_740_991),
            Bson::Double(9_007_199_254_740_991.0),
        ),
        (
            Bson::Int64(9_007_199_254_740_992),
            Bson::Double(9_007_199_254_740_992.0),
        ),
        // 2^53 + 1 has no JavaScript number: Mongoose casts a `Long` with `toNumber()`, the
        // nearest double.
        (
            Bson::Int64(9_007_199_254_740_993),
            Bson::Double(9_007_199_254_740_992.0),
        ),
        (
            Bson::Int64(-9_007_199_254_740_992),
            Bson::Double(-9_007_199_254_740_992.0),
        ),
        (Bson::Int64(i64::MIN), Bson::Double(i64::MIN as f64)),
        (Bson::Double(1e21), Bson::Double(1e21)),
        (Bson::Double(f64::INFINITY), Bson::Double(f64::INFINITY)),
    ]
}

/// Equality that tells `-0` from `0` and int32 from double.
fn exact(a: &Bson, b: &Bson) -> bool {
    match (a, b) {
        (Bson::Double(x), Bson::Double(y)) => x.to_bits() == y.to_bits(),
        (Bson::Document(x), Bson::Document(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((ka, va), (kb, vb))| ka == kb && exact(va, vb))
        }
        (Bson::Array(x), Bson::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| exact(v, w))
        }
        _ => a == b,
    }
}

fn get<'a>(doc: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut current: &Bson = doc.get(path.split('.').next()?)?;
    for piece in path.split('.').skip(1) {
        current = match current {
            Bson::Document(d) => d.get(piece)?,
            Bson::Array(items) => items.get(piece.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn check(found: Option<&Bson>, expected: &Bson, what: &str) {
    assert!(
        found.is_some_and(|f| exact(f, expected)),
        "{what}: expected {expected:?}, found {found:?}"
    );
}

#[test]
fn inserts_type_every_number() -> Result<(), PrepareError> {
    for style in [
        InsertStyle::Create,
        InsertStyle::InsertMany,
        InsertStyle::BulkInsertOne,
    ] {
        for (given, stored) in table() {
            let mut ctx = WriteContext::new(1_000);
            let document = doc! {
                "n": given.clone(),
                "free": { "a": given.clone(), "deep": [[given.clone()]] },
                "list": [given.clone()],
            };
            let out = prepare_insert(&S, &document, style, &mut ctx)?.document;
            check(get(&out, "n"), &stored, "n");
            check(get(&out, "free.a"), &stored, "free.a");
            check(get(&out, "free.deep.0.0"), &stored, "free.deep.0.0");
            check(get(&out, "list.0"), &stored, "list.0");
            check(get(&out, "count"), &Bson::Int32(0), "count");
            check(get(&out, "__v"), &Bson::Int32(0), "__v");
        }
    }
    Ok(())
}

#[test]
fn updates_type_numbers_in_filter_operators_and_pipelines() -> Result<(), PrepareError> {
    for (given, stored) in table() {
        let mut ctx = WriteContext::new(1_000);
        let filter = doc! { "n": given.clone(), "count": { "$gt": given.clone() } };
        let update = doc! {
            "$set": { "free": { "x": [given.clone()] } },
            "$inc": { "count": given.clone() },
            "$max": { "n": given.clone() },
            "$push": { "list": { "$each": [given.clone()], "$position": given.clone() } },
        };
        for options in [UpdateOptions::default(), UpdateOptions::upsert()] {
            let out = prepare_update(&S, &filter, update.clone(), options, &mut ctx)?;
            check(get(&out.filter, "n"), &stored, "filter n");
            check(get(&out.filter, "count.$gt"), &stored, "filter $gt");
            let Some(UpdateDoc::Document(sent)) = &out.update else {
                panic!("not a document");
            };
            check(get(sent, "$set.free.x.0"), &stored, "$set");
            check(get(sent, "$inc.count"), &stored, "$inc");
            check(get(sent, "$max.n"), &stored, "$max");
            check(get(sent, "$push.list.$each.0"), &stored, "$push");
            check(get(sent, "$push.list.$position"), &stored, "$position");
        }
        // An empty upsert sends `{$setOnInsert: <filter>}`: the copy is typed too.
        static PLAIN: Schema = Schema::new(&[Field::number("n")]).no_version_key();
        let out = prepare_update(
            &PLAIN,
            &doc! { "n": given.clone() },
            doc! {},
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        let Some(UpdateDoc::Document(sent)) = &out.update else {
            panic!("not a document");
        };
        check(get(sent, "$setOnInsert.n"), &stored, "upsert filter copy");

        let pipeline = vec![doc! { "$set": { "n": { "$add": ["$n", given.clone()] } } }];
        let out = prepare_update(&S, &doc! {}, pipeline, UpdateOptions::default(), &mut ctx)?;
        let Some(UpdateDoc::Pipeline(stages)) = &out.update else {
            panic!("not a pipeline");
        };
        check(
            stages.first().and_then(|s| get(s, "$set.n.$add.1")),
            &stored,
            "pipeline",
        );

        let found = prepare_find_one_and_update(
            &S,
            &filter,
            doc! { "$set": { "n": given.clone() } },
            UpdateOptions::default(),
            Returned::After,
            &mut ctx,
        )?;
        check(get(&found.filter, "n"), &stored, "findOneAndUpdate filter");
        let Some(UpdateDoc::Document(sent)) = &found.update else {
            panic!("findOneAndUpdate not sent");
        };
        check(get(sent, "$set.n"), &stored, "findOneAndUpdate $set");

        for kind in [BulkUpdate::UpdateOne, BulkUpdate::UpdateMany] {
            let bulk = prepare_bulk_update(
                &S,
                &filter,
                doc! { "$set": { "n": given.clone() } },
                kind,
                UpdateOptions::upsert(),
                &mut ctx,
            )?;
            check(get(&bulk.filter, "n"), &stored, "bulk filter");
            let Some(UpdateDoc::Document(sent)) = &bulk.update else {
                panic!("not a document");
            };
            check(get(sent, "$set.n"), &stored, "bulk $set");
        }
    }
    Ok(())
}

#[test]
fn saves_type_numbers_including_the_loaded_version() -> Result<(), PrepareError> {
    for (given, stored) in table() {
        let mut ctx = WriteContext::new(1_000);
        // A document a Rust writer stored with int64 numbers: Mongoose reads them as JavaScript
        // numbers, so the filter's `__v` and every value written back are retyped.
        let loaded = doc! {
            "_id": ObjectId::from_bytes([1; 12]),
            "n": Bson::Int64(1),
            "count": Bson::Int64(2),
            "list": [Bson::Int64(3)],
            "createdAt": bson::DateTime::from_millis(1),
            "updatedAt": bson::DateTime::from_millis(1),
            "__v": Bson::Int64(4),
        };
        let changes = [
            Change::set("free", doc! { "a": given.clone() }),
            Change::set("list", vec![given.clone(), Bson::Int64(5)]),
        ];
        let out = prepare_save(&S, &loaded, &changes, &mut ctx)?;
        let Some(update) = &out.update else {
            panic!("save not sent");
        };
        check(get(&out.filter, "__v"), &Bson::Int32(4), "filter __v");
        check(get(update, "$set.free.a"), &stored, "$set free.a");
        check(get(update, "$set.list.0"), &stored, "$set list.0");
        check(get(update, "$set.list.1"), &Bson::Int32(5), "$set list.1");
        check(get(update, "$inc.__v"), &Bson::Int32(1), "$inc __v");

        let out = prepare_save(
            &S,
            &loaded,
            &[Change::push("list", [given.clone()])],
            &mut ctx,
        )?;
        let Some(update) = &out.update else {
            panic!("save not sent");
        };
        check(get(update, "$push.list.$each.0"), &stored, "$push");
    }
    Ok(())
}
