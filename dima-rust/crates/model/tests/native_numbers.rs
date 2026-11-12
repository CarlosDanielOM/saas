//! Native writer shapes taken from the deployed workers (not TypeScript number inputs).
//! Reference collections live only in the disposable database; domdimabot is read-only.
mod support;

use anyhow::{Context, Result};
use bson::{Bson, DateTime, Document, doc};
use dima_model::{CollectionInfo, REGISTRY};
use dima_store::mongo::{WriteContext, update::UpdateOptions};

const NOW: i64 = 1_794_392_430_456;
fn at() -> DateTime {
    DateTime::from_millis(NOW)
}

// Each entry names the worker's actual write, including the explicit numeric widths.
fn writes() -> Vec<(&'static str, Document)> {
    vec![
        // roulette_completion.rs: state/dueAt completion CAS; epoch fields double,
        // remaining copies int32, revision increment int32. Actions/tokens untouched.
        (
            "roulette_channels",
            doc! {"$set":{
            "state":{"roulettes":[{"id":"roulette","items":[{"id":"item","multiplier":1_i32,"copies":["copy"]}],"order":["copy"]}],
            "activeId":"roulette","visible":true,
            "draw":{"id":"draw","rouletteId":"roulette","startedAt":1_794_392_429_456.0_f64,"endsAt":1_794_392_430_456.0_f64,"completedAt":1_794_392_430_456.0_f64},
            "history":[{"id":"draw","startedAt":1_794_392_429_456.0_f64,"endsAt":1_794_392_430_456.0_f64,"completedAt":1_794_392_430_456.0_f64}],"hideAt":1_794_392_435_456.0_f64},
            "dueAt":1_794_392_435_456.0_f64},"$inc":{"revision":1_i32}},
        ),
        // stream_activity/projection.rs: Change::update; bucket is i64, inc/seq f64.
        (
            "stream_activity_aggregates",
            doc! {"$setOnInsert":{"channelID":"c","scope":"chart","kind":"message","bucket":5_i64},"$inc":{"messages":1.0},"$set":{"lastSeq":5.0,"updatedAt":at()},"$min":{"firstAt":at()},"$max":{"expiresAt":at()}},
        ),
        // stream_activity/mod.rs checkpoint, shared with dashboard_activity.rs.
        (
            "stream_activity_states",
            doc! {"$set":{"seq":5.0,"active":{"seq":5.0,"ids":["a"]},"owner":"owner","leaseUntil":at()}},
        ),
        (
            "stream_activities",
            doc! {"$set":{"dashboardProcessed":true}},
        ),
        // dashboard_activity.rs:450 uses bson_number, hence integral int32.
        (
            "dashboard_activity_dailies",
            doc! {"$inc":{"count":1_i32},"$set":{"lastSeq":5_i32}},
        ),
        (
            "dashboard_activity_summaries",
            doc! {"$set":{"payload":{"7":{"days":7_i32,"messages":5_i32}},"updatedAt":at(),"error":false}},
        ),
        (
            "dashboard_insights",
            doc! {"$set":{"payload":{"7":{"days":7_i32}},"updatedAt":at(),"error":false,"nextRefreshAt":at()}},
        ),
        // raid_analytics.rs:follow_values explicitly uses int32-or-double.
        (
            "raid_analytics_histories",
            doc! {"$set":{"followsAfter":5_i32,"followWindowEnd":at(),"followsComputedAt":at()}},
        ),
        (
            "raid_analytics_summaries",
            doc! {"$set":{"owner":"owner","leaseUntil":at()}},
        ),
        // raid_sessions.rs retention, and moderation.rs checkpoint/lease.
        (
            "raid_sessions",
            doc! {"$set":{"retentionHours":72_i32},"$max":{"expiresAt":at(),"purgeAt":at()}},
        ),
        ("raid_followers", doc! {"$max":{"purgeAt":at()}}),
        (
            "raid_moderation_requests",
            doc! {"$set":{"lockedUntil":at(),"leaseToken":"owner"}},
        ),
        (
            "follow_defense_controls",
            doc! {"$max":{"pendingUntil":at()}},
        ),
        ("follow_defense_actions", doc! {"$set":{"updatedAt":at()}}),
        // ai_usage_receipts ledger.rs / dashboard.rs: numbers already bson_number-normalized.
        ("ai_usage_receipts", doc! {"$set":{"updated_at":at()}}),
        (
            "ai_usage_dailies",
            doc! {"$set":{"spentCredits":5_i32,"transactionCount":1_i32}},
        ),
        (
            "ai_usage_dashboards",
            doc! {"$set":{"data":{"summary":{"totalSpentCredits":5_i32}},"dirty":false,"refreshedAt":at()}},
        ),
    ]
}

fn info(name: &str) -> Result<&'static CollectionInfo> {
    REGISTRY
        .iter()
        .copied()
        .find(|i| i.name == name)
        .with_context(|| format!("missing model: {name}"))
}
fn numeric_types(document: &Document) -> Vec<(String, &'static str)> {
    fn walk(value: &Bson, path: String, out: &mut Vec<(String, &'static str)>) {
        let ty = match value {
            Bson::Int32(_) => "int",
            Bson::Int64(_) => "long",
            Bson::Double(_) => "double",
            Bson::Document(doc) => {
                for (key, value) in doc {
                    walk(value, format!("{path}.{key}"), out);
                }
                return;
            }
            Bson::Array(items) => {
                for value in items {
                    walk(value, format!("{path}[]"), out);
                }
                return;
            }
            _ => return,
        };
        out.push((path, ty));
    }
    let mut out = Vec::new();
    for (key, value) in document {
        walk(value, key.clone(), &mut out);
    }
    out.sort();
    out
}

#[tokio::test]
async fn native_worker_writes_store_the_same_types_and_decode() -> Result<()> {
    support::with_store(|store| async move {
        let cases = support::recorded_cases()?;
        for (name, update) in writes() {
            let info = info(name)?;
            let mut ctx = WriteContext::new(NOW).native_numbers();
            let base = support::base_given(&cases, name)?;
            let insert = info.prepare_create(&base, &mut ctx).with_context(|| name)?;
            let id = insert.document.get("_id").cloned().context("id")?;
            let filter = doc! {"_id":id};
            let reference = store.documents(&format!("reference_{name}"));
            reference.insert_one(insert.document.clone()).await?;
            reference.update_one(filter.clone(), update.clone()).await?;
            store.writes(name).insert_one(&insert).await?;
            let prepared = info
                .prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)
                .with_context(|| name)?;
            assert!(prepared.dropped_paths.is_empty(), "{name}");
            store.writes(name).update_one(&prepared).await?;
            let expected = reference
                .find_one(filter.clone())
                .await?
                .context("reference")?;
            let stored = store
                .documents(name)
                .find_one(filter)
                .await?
                .context("stored")?;
            assert_eq!(numeric_types(&stored), numeric_types(&expected), "{name}");
            (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?).with_context(|| name)?;
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn native_upsert_insert_and_inc_promotion() -> Result<()> {
    support::with_store(|store| async move {
        let info = info("stream_activity_aggregates")?;
        let mut ctx = WriteContext::new(NOW).native_numbers();
        // Old projection's upsert: explicit int64 bucket, double increment and sequence.
        let update = doc!{"$setOnInsert":{"bucket":5_i64,"channelID":"c","scope":"chart","kind":"message"},"$inc":{"messages":1.0},"$set":{"lastSeq":5.0},"$max":{"expiresAt":at()}};
        let prepared = info.prepare_update(&doc!{"_id":"upsert"}, update, UpdateOptions::upsert(), &mut ctx)?;
        store.writes(info.name).update_one(&prepared).await?;
        let stored = store.documents(info.name).find_one(doc!{"_id":"upsert"}).await?.context("upsert")?;
        assert_eq!(stored.get("bucket"), Some(&Bson::Int64(5)));
        assert_eq!(stored.get("messages"), Some(&Bson::Double(1.0)));
        assert_eq!(stored.get("count"), Some(&Bson::Int32(0)));
        (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        let copied = info.prepare_update(&doc!{"_id":"filter-copy","bucket":5_i64}, doc!{"$inc":{"count":1.0},"$set":{"expiresAt":at()}}, UpdateOptions::upsert(), &mut ctx)?;
        store.writes(info.name).update_one(&copied).await?;
        let stored = store.documents(info.name).find_one(doc!{"_id":"filter-copy"}).await?.context("filter copy")?;
        assert_eq!(stored.get("bucket"), Some(&Bson::Int64(5)));
        (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        for (id, initial, increment) in [("long", Bson::Int64(5), Bson::Double(1.0)), ("double", Bson::Double(5.0), Bson::Int64(1))] {
            let insert = info.prepare_create(&doc!{"_id":id,"count":initial,"expiresAt":at()}, &mut ctx)?;
            store.writes(info.name).insert_one(&insert).await?;
            let prepared = info.prepare_update(&doc!{"_id":id}, doc!{"$inc":{"count":increment}}, UpdateOptions::default(), &mut ctx)?;
            store.writes(info.name).update_one(&prepared).await?;
            let stored = store.documents(info.name).find_one(doc!{"_id":id}).await?.context("increment")?;
            assert_eq!(stored.get("count"), Some(&Bson::Double(6.0)));
            (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        }
        Ok(())
    }).await
}

#[tokio::test]
async fn local_native_collection_samples_match_the_census_types() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let ledger: serde_json::Value =
        serde_json::from_str(include_str!("../../../ledger/mongo.json"))?;
    for (name, _) in writes() {
        let census = &ledger["collections"][name];
        let sample = store.documents(name).find_one(doc! {}).await?;
        if let Some(sample) = sample {
            for (path, ty) in numeric_types(&sample) {
                let types = &census["census"]["sampledPaths"][&path]["types"];
                // The census is sampled: a field missing from its sample has no evidence.
                if types.is_object() {
                    assert!(
                        types.get(ty).is_some(),
                        "{name}.{path}: {ty} absent from census {types}"
                    );
                }
            }
        } else {
            assert_eq!(
                census["db"]["count"].as_u64().unwrap_or(0),
                0,
                "{name}: missing production sample"
            );
            eprintln!("{name}: census and local copy empty; no real document to compare");
        }
    }
    Ok(())
}

#[test]
fn native_option_keeps_model_validation_and_non_numeric_values() -> Result<()> {
    let cases = support::recorded_cases()?;
    for native in [false, true] {
        let mut ctx = WriteContext::new(NOW);
        if native {
            ctx = ctx.native_numbers();
        }
        let aggregate = info("stream_activity_aggregates")?;
        assert!(
            aggregate
                .prepare_create(&doc! {"_id":"a","count":"bad"}, &mut ctx)
                .is_err()
        );
        let session = info("raid_sessions")?;
        assert!(
            session
                .prepare_create(&doc! {"_id":"missing-required"}, &mut ctx)
                .is_err()
        );
        let mut base = support::base_given(&cases, "raid_sessions")?;
        base.insert("backfillDone", true);
        base.insert("startedAt", at());
        base.insert("viewers", 5_i64);
        let prepared = session.prepare_create(&base, &mut ctx)?;
        assert_eq!(
            prepared.document.get("backfillDone"),
            Some(&Bson::Boolean(true))
        );
        assert_eq!(
            prepared.document.get("startedAt"),
            Some(&Bson::DateTime(at()))
        );
        assert_eq!(prepared.document.get("_id"), base.get("_id"));
        for frequency in [Bson::Int64(0), Bson::Double(1441.0)] {
            let refused = info("custom_timers")?.prepare_update(
                &doc! {},
                doc! {"$set":{"frequency":frequency}},
                dima_model::UpdateOptions::default().run_validators(),
                &mut ctx,
            );
            assert!(refused.is_err());
        }
        let receipts = info("ai_usage_receipts")?;
        let mut base = support::base_given(&cases, receipts.name)?;
        base.insert("retentionTier", "invalid-enum");
        assert!(receipts.prepare_create(&base, &mut ctx).is_err());
    }
    Ok(())
}

#[tokio::test]
async fn native_worker_inserts_and_control_upsert_decode() -> Result<()> {
    support::with_store(|store| async move {
        let mut ctx = WriteContext::new(NOW).native_numbers();
        // raid_sessions/values.rs:follower_document and ai_usage_receipts/ledger.rs:rebuild.
        for (name, original) in [
            ("raid_followers", doc!{"_id":"f","channelID":"c","sessionID":"s","eventID":"e","userID":"u","login":"login","name":"name","followedAt":at(),"recordedAt":at(),"queuedRequestIDs":[],"eligibleRequestIDs":[],"purgeAt":at()}),
            ("ai_usage_dailies", doc!{"channelID":"c","customerId":"customer","date":"2026-11-11","dayStart":at(),"spentCredits":5_i32,"grantedCredits":0_i32,"netConsumedCredits":5_i32,"transactionCount":1_i32,"retentionTier":"free","expiresAt":at(),"created_at":at(),"updated_at":at(),"__v":0_i32}),
        ] {
            let info = info(name)?;
            let prepared = info.prepare_create(&original, &mut ctx)?;
            assert!(prepared.dropped_paths.is_empty());
            store.writes(name).insert_one(&prepared).await?;
            let stored = store.documents(name).find_one(doc!{}).await?.context("insert")?;
            for (path, ty) in numeric_types(&original) { assert!(numeric_types(&stored).contains(&(path, ty)), "{name}"); }
            (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        }
        let controls = info("follow_defense_controls")?;
        let original = doc!{"$max":{"pendingUntil":at()},"$setOnInsert":{"cancelledThrough":DateTime::from_millis(0),"nextAllowedAt":DateTime::from_millis(0),"lastServedAt":DateTime::from_millis(0),"ratePerSecond":5_i32,"successStreak":0_i32,"lockedUntil":DateTime::from_millis(0),"leaseToken":""}};
        let prepared = controls.prepare_update(&doc!{"_id":"control"}, original, UpdateOptions::upsert(), &mut ctx)?;
        store.writes(controls.name).update_one(&prepared).await?;
        let stored = store.documents(controls.name).find_one(doc!{"_id":"control"}).await?.context("control")?;
        assert_eq!(stored.get("ratePerSecond"), Some(&Bson::Int32(5)));
        (controls.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        Ok(())
    }).await
}

#[tokio::test]
async fn roulette_native_default_upsert_and_hide_decode() -> Result<()> {
    support::with_store(|store| async move {
        let info = info("roulette_channels")?;
        let mut ctx = WriteContext::new(NOW).native_numbers();
        // roulette_completion.rs:default_document/load, including Node-normalized defaults.
        let empty = doc! {"roulettes":[],"activeId":null,"visible":false,"draw":null,"history":[],"hideAt":null};
        let original = doc! {"$setOnInsert":{"actions":[],"actionDueAt":null,"revision":0_i32,"state":empty.clone(),"tokenHash":null,"dueAt":null,"receipts":[]}};
        let prepared = info.prepare_update(&doc!{"_id":"native"}, original, UpdateOptions::upsert(), &mut ctx)?;
        assert!(prepared.dropped_paths.is_empty());
        store.writes(info.name).update_one(&prepared).await?;
        let stored = store.documents(info.name).find_one(doc!{"_id":"native"}).await?.context("native default")?;
        assert_eq!(stored.get("revision"), Some(&Bson::Int32(0)));
        assert_eq!(stored.get("dueAt"), Some(&Bson::Null));
        (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        let hide = info.prepare_update(&doc!{"_id":"native","revision":0_i32}, doc!{"$set":{"state":empty,"dueAt":null},"$inc":{"revision":1_i32}}, UpdateOptions::default(), &mut ctx)?;
        store.writes(info.name).update_one(&hide).await?;
        let stored = store.documents(info.name).find_one(doc!{"_id":"native"}).await?.context("native hide")?;
        assert_eq!(stored.get("revision"), Some(&Bson::Int32(1)));
        assert_eq!(stored.get("dueAt"), Some(&Bson::Null));
        (info.decode)(&bson::serialize_to_raw_document_buf(&stored)?)?;
        Ok(())
    }).await
}
