//! Offline checks of every write helper and the JSON renderer on awkward input: emoji (with
//! skin tones and ZWJ sequences), combining marks, right-to-left text, in keys and values;
//! field names that need escaping or look like operators; empty objects and arrays; deep
//! nesting. Nothing here needs a database.

use bson::{Bson, DateTime, Document, doc};
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, Timestamps};
use dima_store::mongo::update::{
    Returned, UpdateDoc, UpdateOptions, prepare_find_one_and_update, prepare_update,
};
use dima_store::mongo::{PrepareError, WriteContext, json};

const EMOJI: &str = "👋🏽 👨‍👩‍👧";
const COMBINING: &str = "e\u{301}\u{302}";
const RTL: &str = "مرحبا שלום";
const NOW: i64 = 1_794_391_200_123;

static ITEM: Schema = Schema::subdocument(&[
    Field::value("label").trim(),
    Field::value("n").default(D::Int(1)),
]);
static S: Schema = Schema::new(&[
    Field::value("name").trim(),
    Field::value("count").default(D::Int(0)),
    Field::mixed("meta"),
    Field::map("vars", MapOf::Values),
    Field::array("tags").trim(),
    Field::document_array("items", &ITEM),
])
.timestamps(Timestamps::CAMEL);

fn text() -> String {
    format!("{EMOJI} {COMBINING} {RTL}")
}

fn deep(levels: usize, leaf: Bson) -> Bson {
    (0..levels).fold(leaf, |inner, i| {
        let mut doc = Document::new();
        doc.insert(format!("{}{i}", RTL), inner);
        Bson::Document(doc)
    })
}

#[test]
fn trim_keeps_marks_and_uses_the_javascript_whitespace_set() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    // NBSP, ZWNBSP (BOM) and LINE SEPARATOR are JavaScript whitespace; ZWJ is not.
    let padded = format!("\u{a0}\u{feff} {}\u{2028}\t", text());
    let out = prepare_insert(
        &S,
        &doc! { "name": padded, "tags": [" \u{200d}x ", format!(" {RTL} ")] },
        InsertStyle::Create,
        &mut ctx,
    )?;
    assert_eq!(out.document.get_str("name").ok(), Some(text().as_str()));
    assert_eq!(
        out.document.get_array("tags").ok(),
        Some(&vec![Bson::from("\u{200d}x"), Bson::from(RTL)])
    );
    Ok(())
}

#[test]
fn unicode_keys_in_mixed_and_maps_are_kept_and_never_trimmed() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    let key = format!("{EMOJI}{COMBINING}");
    let mut set = Document::new();
    set.insert(format!("meta.{RTL}.{key}"), format!(" {} ", text()));
    set.insert(format!("vars.{key}"), format!(" {RTL} "));
    set.insert(RTL.to_string(), 1);
    let update = doc! { "$set": set };
    let prepared = prepare_update(&S, &doc! {}, update, UpdateOptions::default(), &mut ctx)?;
    assert_eq!(prepared.dropped_paths, vec![RTL.to_owned()]);
    let Some(UpdateDoc::Document(update)) = prepared.update else {
        return Err(PrepareError::MissingId);
    };
    let set = update
        .get_document("$set")
        .map_err(|_| PrepareError::MissingId)?;
    assert_eq!(
        set.get_str(format!("meta.{RTL}.{key}")).ok(),
        Some(format!(" {} ", text()).as_str())
    );
    assert_eq!(
        set.get_str(format!("vars.{key}")).ok(),
        Some(format!(" {RTL} ").as_str())
    );
    Ok(())
}

#[test]
fn keys_that_need_escaping_or_look_like_operators() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    let meta = doc! {
        "quote\"key": "\\\"\n\t\u{1}\u{2028}",
        "a.b": 1,
        "$dollar": 2,
        "": 3,
        "__proto__": { "x": 1 },
        "10": 4,
        "2": 5,
    };
    let out = prepare_insert(
        &S,
        &doc! { "meta": meta.clone() },
        InsertStyle::Create,
        &mut ctx,
    )?;
    assert_eq!(out.document.get_document("meta").ok(), Some(&meta));
    // JSON: escapes as JSON.stringify does, integer-like keys first, `__proto__` kept.
    assert_eq!(
        json::to_json_string(&meta),
        r#"{"2":5,"10":4,"quote\"key":"\\\"\n\t\u0001 ","a.b":1,"$dollar":2,"":3,"__proto__":{"x":1}}"#
            .replace(' ', "\u{2028}")
    );
    Ok(())
}

#[test]
fn empty_objects_and_arrays() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    let out = prepare_insert(
        &S,
        &doc! { "meta": { "a": {}, "b": [], "c": [{}], "d": { "e": {} } }, "vars": {}, "tags": [], "items": [] },
        InsertStyle::Create,
        &mut ctx,
    )?;
    // minimize: empty objects go, arrays (and objects inside them) stay, Maps stay.
    assert_eq!(
        out.document.get_document("meta").ok(),
        Some(&doc! { "b": [], "c": [{}] })
    );
    assert_eq!(out.document.get_document("vars").ok(), Some(&doc! {}));
    assert_eq!(out.document.get_array("tags").ok(), Some(&vec![]));
    // An update stores empty objects as they are.
    let prepared = prepare_update(
        &S,
        &doc! {},
        doc! { "$set": { "meta": {} } },
        UpdateOptions::default(),
        &mut ctx,
    )?;
    let set = prepared
        .update
        .and_then(|u| u.as_document().cloned())
        .and_then(|u| u.get_document("$set").ok().cloned());
    assert_eq!(
        set.and_then(|s| s.get("meta").cloned()),
        Some(Bson::Document(doc! {}))
    );
    assert_eq!(
        json::to_json_string(&doc! { "a": {}, "b": [], "c": [[]] }),
        r#"{"a":{},"b":[],"c":[[]]}"#
    );
    Ok(())
}

#[test]
fn deep_nesting() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    // 99 levels under `meta` reaches MongoDB's 100-level limit for the stored document.
    let nested = deep(99, Bson::String(text()));
    let out = prepare_insert(
        &S,
        &doc! { "meta": nested.clone() },
        InsertStyle::Create,
        &mut ctx,
    )?;
    assert_eq!(out.document.get("meta"), Some(&nested));
    let empty = deep(99, Bson::Document(doc! {}));
    let out = prepare_insert(&S, &doc! { "meta": empty }, InsertStyle::Create, &mut ctx)?;
    assert!(
        !out.document.contains_key("meta"),
        "a chain of empty objects is minimized away"
    );
    let rendered = json::to_json_string(&doc! { "meta": nested });
    assert!(rendered.ends_with(&format!("\"{}\"{}}}", text(), "}".repeat(99))));
    Ok(())
}

#[test]
fn save_with_unicode_values_and_pushes() -> Result<(), PrepareError> {
    let mut ctx = WriteContext::new(NOW);
    let loaded = doc! {
        "_id": "id-👋",
        "name": RTL,
        "count": 1,
        "tags": [EMOJI],
        "items": [],
        "createdAt": DateTime::from_millis(1),
        "updatedAt": DateTime::from_millis(1),
        "__v": 0,
    };
    let changes = [
        Change::set("name", format!(" {COMBINING} ")),
        Change::push("tags", [Bson::from(format!(" {RTL} "))]),
        Change::push(
            "items",
            [Bson::Document(doc! { "label": format!(" {EMOJI} ") })],
        ),
        Change::set(format!("meta.{RTL}"), EMOJI),
    ];
    let prepared = prepare_save(&S, &loaded, &changes, &mut ctx)?;
    assert_eq!(prepared.filter, doc! { "_id": "id-👋" });
    let saved = prepared.update.ok_or(PrepareError::MissingId)?;
    let set = saved
        .get_document("$set")
        .map_err(|_| PrepareError::MissingId)?;
    assert_eq!(set.get_str("name").ok(), Some(COMBINING));
    assert_eq!(set.get_str(format!("meta.{RTL}")).ok(), Some(EMOJI));
    let push = saved
        .get_document("$push")
        .map_err(|_| PrepareError::MissingId)?;
    assert_eq!(
        push.get("tags"),
        Some(&Bson::Document(doc! { "$each": [RTL] }))
    );
    let item = push
        .get_document("items")
        .ok()
        .and_then(|each| each.get_array("$each").ok())
        .and_then(|items| items.first())
        .and_then(Bson::as_document)
        .ok_or(PrepareError::MissingId)?;
    assert_eq!(item.get_str("label").ok(), Some(EMOJI));
    assert_eq!(item.get("n"), Some(&Bson::Int32(1)));
    Ok(())
}

#[test]
fn find_one_and_update_defaults() -> Result<(), PrepareError> {
    static PLAIN: Schema = Schema::new(&[Field::value("_id"), Field::value("n")])
        .declared_id()
        .no_version_key();
    let mut ctx = WriteContext::new(NOW);
    // Empty update without upsert: Mongoose runs a findOne instead.
    let find_only = prepare_find_one_and_update(
        &PLAIN,
        &doc! { "_id": "x" },
        doc! {},
        UpdateOptions::default(),
        Returned::default(),
        &mut ctx,
    )?;
    assert_eq!(find_only.update, None);
    assert_eq!(find_only.returned, Returned::Before);
    assert!(matches!(
        find_only.return_document(),
        mongodb::options::ReturnDocument::Before
    ));
    // Empty update with upsert and an empty filter: `{$set: {}}`.
    let upsert = prepare_find_one_and_update(
        &PLAIN,
        &doc! {},
        doc! {},
        UpdateOptions::upsert(),
        Returned::After,
        &mut ctx,
    )?;
    assert_eq!(
        upsert.update,
        Some(UpdateDoc::Document(doc! { "$set": {} }))
    );
    assert!(matches!(
        upsert.return_document(),
        mongodb::options::ReturnDocument::After
    ));
    assert_eq!(JsNumber(2.0).to_bson(), Bson::Int32(2));
    Ok(())
}
