//! Live checks of `dima_store::mongo::write`: prepared writes run through `Writes`, dropped
//! paths fail (debug default) or are reported and written (release default), and the outcomes
//! (counts, upserted id, returned documents, save conflicts). Each test uses its own
//! `dima_test_store_<random>` database and drops it, also when the test fails. Skipped with a
//! message when `DIMA_TEST_MONGO_URI` is not set.

use anyhow::{Context, Result, bail};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_store::mongo::insert::{InsertStyle, prepare_insert};
use dima_store::mongo::save::{Change, prepare_save};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::update::{
    Returned, UpdateOptions, prepare_find_one_and_update, prepare_update,
};
use dima_store::mongo::write::{
    DroppedPathPolicy, DroppedPaths, SaveOutcome, UpdateOutcome, WriteError,
};
use dima_store::mongo::{CommandHook, MongoConfig, MongoStore, WriteContext};
use futures_util::TryStreamExt;
use std::future::Future;
use std::sync::{Arc, Mutex};

static ITEMS: Schema = Schema::new(&[
    Field::value("name"),
    Field::value("count").default(D::Int(0)),
    Field::array("tags"),
])
.timestamps(Timestamps::CAMEL);

const NOW: i64 = 1_794_391_200_000;

#[derive(Default)]
struct Reports {
    dropped: Mutex<Vec<(String, &'static str, Vec<String>)>>,
}

impl CommandHook for Reports {
    fn dropped_paths(&self, event: &DroppedPaths<'_>) {
        if let Ok(mut dropped) = self.dropped.lock() {
            dropped.push((
                event.collection.to_owned(),
                event.operation,
                event.paths.to_vec(),
            ));
        }
    }
}

/// Runs `test` against a fresh database and drops it afterwards, whatever the outcome.
async fn with_store<F, Fut>(policy: Option<DroppedPathPolicy>, test: F) -> Result<()>
where
    F: FnOnce(MongoStore, Arc<Reports>) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
        return Ok(());
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(format!("dima_test_store_{}", ObjectId::new().to_hex()));
    let reports = Arc::new(Reports::default());
    let hook: Arc<dyn CommandHook> = Arc::clone(&reports) as Arc<dyn CommandHook>;
    let mut store = MongoStore::connect(&config, Some(hook)).await?;
    if let Some(policy) = policy {
        store = store.with_dropped_path_policy(policy);
    }
    let database = store.database().clone();
    let outcome = test(store, reports).await;
    database.drop().await?;
    outcome
}

async fn all(store: &MongoStore) -> Result<Vec<Document>> {
    Ok(store
        .documents("items")
        .find(doc! {})
        .sort(doc! { "_id": 1 })
        .await?
        .try_collect()
        .await?)
}

fn is_dropped(result: &Result<impl std::fmt::Debug, WriteError>, paths: &[&str]) -> bool {
    matches!(result, Err(WriteError::DroppedPaths { collection, paths: found, .. })
        if collection == "items" && found.iter().map(String::as_str).eq(paths.iter().copied()))
}

#[tokio::test]
async fn debug_builds_fail_writes_with_unknown_paths_and_send_nothing() -> Result<()> {
    assert_eq!(DroppedPathPolicy::default(), DroppedPathPolicy::Fail);
    with_store(None, |store, reports| async move {
        let mut ctx = WriteContext::with_sequential_ids(NOW, 1);
        let mut items = store.writes("items");

        let insert = prepare_insert(
            &ITEMS,
            &doc! { "name": "a", "nmae": "typo" },
            InsertStyle::Create,
            &mut ctx,
        )?;
        assert!(is_dropped(&items.insert_one(&insert).await, &["nmae"]));
        assert!(is_dropped(
            &items.insert_many(std::slice::from_ref(&insert)).await,
            &["nmae"]
        ));
        assert!(all(&store).await?.is_empty(), "nothing was inserted");

        let clean = prepare_insert(&ITEMS, &doc! { "name": "a" }, InsertStyle::Create, &mut ctx)?;
        items.insert_one(&clean).await?;
        let before = all(&store).await?;

        // An update that names only unknown paths: nothing would be sent, but the caller still
        // hears about it.
        let only_unknown = prepare_update(
            &ITEMS,
            &doc! { "name": "a" },
            doc! { "$set": { "nmae": "b" } },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        assert_eq!(only_unknown.dropped_paths, ["nmae"]);
        assert!(is_dropped(
            &items.update_one(&only_unknown).await,
            &["nmae"]
        ));
        assert!(is_dropped(
            &items.update_many(&only_unknown).await,
            &["nmae"]
        ));
        let found = prepare_find_one_and_update(
            &ITEMS,
            &doc! { "name": "a" },
            doc! { "$inc": { "cuont": 1 } },
            UpdateOptions::default(),
            Returned::After,
            &mut ctx,
        )?;
        assert!(is_dropped(
            &items.find_one_and_update(&found).await,
            &["cuont"]
        ));

        let loaded = before.first().context("inserted document")?.clone();
        let save = prepare_save(&ITEMS, &loaded, &[Change::set("nmae", "x")], &mut ctx)?;
        assert_eq!(save.update, None);
        assert!(is_dropped(&items.save(&save).await, &["nmae"]));

        assert_eq!(all(&store).await?, before, "nothing was written");
        assert!(
            reports
                .dropped
                .lock()
                .map(|d| d.is_empty())
                .unwrap_or(false)
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn release_builds_report_unknown_paths_and_write_the_rest() -> Result<()> {
    with_store(
        Some(DroppedPathPolicy::Report),
        |store, reports| async move {
            let mut ctx = WriteContext::with_sequential_ids(NOW, 1);
            let mut items = store.writes("items");
            let insert = prepare_insert(
                &ITEMS,
                &doc! { "name": "a", "nmae": "typo" },
                InsertStyle::Create,
                &mut ctx,
            )?;
            items.insert_one(&insert).await?;
            let update = prepare_update(
                &ITEMS,
                &doc! { "name": "a" },
                doc! { "$set": { "nmae": "b" }, "$inc": { "count": 2 } },
                UpdateOptions::default(),
                &mut ctx,
            )?;
            let outcome = items.update_one(&update).await?;
            assert_eq!((outcome.matched, outcome.modified), (1, 1));
            let stored = all(&store).await?;
            let Some(document) = stored.first() else {
                bail!("not inserted");
            };
            assert!(!document.contains_key("nmae"));
            assert_eq!(document.get("count"), Some(&Bson::Int32(2)));
            let reported = reports
                .dropped
                .lock()
                .map(|d| d.clone())
                .unwrap_or_default();
            assert_eq!(
                reported,
                [
                    ("items".to_owned(), "insertOne", vec!["nmae".to_owned()]),
                    ("items".to_owned(), "updateOne", vec!["nmae".to_owned()]),
                ]
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn outcomes_of_updates_upserts_finds_and_saves() -> Result<()> {
    with_store(None, |store, _| async move {
        let mut ctx = WriteContext::with_sequential_ids(NOW, 1);
        let mut items = store.writes("items");

        let upsert = prepare_update(
            &ITEMS,
            &doc! { "name": "u" },
            doc! { "$inc": { "count": 1 } },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        let outcome = items.update_one(&upsert).await?;
        assert!(outcome.sent && outcome.matched == 0 && outcome.upserted_id.is_some());

        // Without timestamps an empty update is not sent; Mongoose reports zero counts.
        static PLAIN: Schema = Schema::new(&[Field::value("name")]).no_version_key();
        let empty = prepare_update(
            &PLAIN,
            &doc! {},
            doc! { "$set": {} },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        assert_eq!(
            store.writes("items").update_many(&empty).await?,
            UpdateOutcome::default()
        );

        let after = prepare_find_one_and_update(
            &ITEMS,
            &doc! { "name": "u" },
            doc! { "$inc": { "count": 1 } },
            UpdateOptions::default(),
            Returned::After,
            &mut ctx,
        )?;
        let returned = items.find_one_and_update(&after).await?;
        assert_eq!(
            returned.as_ref().and_then(|d| d.get("count")),
            Some(&Bson::Int32(2))
        );
        let find_only = prepare_find_one_and_update(
            &PLAIN,
            &doc! { "name": "u" },
            doc! {},
            UpdateOptions::default(),
            Returned::Before,
            &mut ctx,
        )?;
        assert_eq!(find_only.update, None);
        assert_eq!(items.find_one_and_update(&find_only).await?, returned);

        let loaded = returned.context("document")?;
        let unchanged = prepare_save(&ITEMS, &loaded, &[], &mut ctx)?;
        assert_eq!(items.save(&unchanged).await?, SaveOutcome::Unchanged);
        let push = prepare_save(
            &ITEMS,
            &loaded,
            &[Change::set("tags", vec![Bson::from("t")])],
            &mut ctx,
        )?;
        assert_eq!(items.save(&push).await?, SaveOutcome::Saved);
        // The same versioned save again: `__v` moved on, so nothing matches.
        assert_eq!(items.save(&push).await?, SaveOutcome::Conflict);
        Ok(())
    })
    .await
}
