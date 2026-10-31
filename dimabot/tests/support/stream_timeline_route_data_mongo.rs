//! Concrete `MongoTimelineRouteData` behaviour against a disposable MongoDB.
//!
//! This module is not a test target of its own: `tests/stream_timeline_data.rs`
//! includes it under the slice-4b route feature, so it reuses the same private
//! Mongoose-free MongoDB harness and the same `STREAM_TIMELINE_TEST_MONGO_*`
//! environment contract as the rest of slice 4a.
//!
//! ACCESS PRECONDITION: `MongoTimelineRouteData` is private to
//! `src/server/routes/stream_timeline.route.rs` and is only constructed inside
//! `StreamTimelineRouteService::new`. Reaching it needs exactly one accessor in
//! that file (which this lane must not edit):
//!
//! ```rust,ignore
//! pub fn data(&self) -> Arc<dyn TimelineRouteData> { self.data.clone() }
//! ```
//!
//! No other access change is required: `TimelineRouteData`, `TimelineRows` and
//! `StreamTimelineRouteService::new` are already public.
//!
//! The suite drives the real adapter, not a reimplementation: marker insert,
//! marker upsert dedupe, scoped marker delete, and the adapter's own
//! `rows(TimelineRows::*)` queries with their fixed sort and limit.

use super::support::{disposable_database, TestResult};
use dima_rust::{
    api_admin::AdminService,
    schemas::{admin as admin_schema, ai_usage_receipt, stream_activity, stream_timeline},
    stream_timeline_route::{StreamTimelineRouteService, TimelineRouteData, TimelineRows},
    utils::{
        logger::{Logger, LoggerConfig, SinkHandles, SystemClock, UuidSource},
        stream_timeline::TIMELINE_RETENTION_MS,
    },
};
use mongodb::bson::{doc, oid::ObjectId, DateTime};
use std::{sync::Arc, time::Duration};

fn logger() -> Logger {
    Logger::new(
        LoggerConfig::default(),
        SinkHandles::default(),
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .expect("logger configuration")
}

/// Builds the shipped route service and returns its concrete data adapter.
async fn adapter(database: &mongodb::Database) -> Arc<dyn TimelineRouteData> {
    let admin = AdminService::new(admin_schema::schema().native_collection(database), None);
    StreamTimelineRouteService::new(database.clone(), admin, logger()).data()
}

fn marker_collection(database: &mongodb::Database) -> mongodb::Collection<mongodb::bson::Document> {
    stream_timeline::marker_schema().native_collection(database)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn route_data_marker_insert_dedupe_delete_against_disposable_mongo() -> TestResult {
    let fixture = disposable_database("route_data_marker").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let channel = "123456";
        let session_id = ObjectId::new();
        let marker_id = ObjectId::new();
        let started = DateTime::from_millis(DateTime::now().timestamp_millis() - 600_000);
        let data = adapter(&fixture.database).await;
        let key = format!("note:{marker_id}");
        let filter = || doc! {"channelID": channel, "session_id": session_id, "key": &key};
        let update = |label: &str, at: DateTime| {
            doc! {"$setOnInsert": {
                "kind": "note",
                "label": label,
                "occurredAt": at,
                "expiresAt": DateTime::from_millis(started.timestamp_millis() + TIMELINE_RETENTION_MS),
            }}
        };
        let collection = marker_collection(&fixture.database);

        // (1) Insert: the route body's `$setOnInsert` document reaches the marker
        // collection unchanged.
        let first_at = DateTime::from_millis(started.timestamp_millis() + 60_000);
        data.insert_marker(filter(), update("first note", first_at))
            .await
            .expect("insert marker");
        assert_eq!(collection.count_documents(filter()).await?, 1);
        let stored = collection
            .find_one(filter())
            .await?
            .expect("stored marker");
        let stored_id = stored.get_object_id("_id")?;
        assert_eq!(stored.get_str("kind")?, "note");
        assert_eq!(stored.get_str("label")?, "first note");
        assert_eq!(stored.get_datetime("occurredAt")?.timestamp_millis(), first_at.timestamp_millis());
        assert_eq!(
            stored
                .get_datetime("expiresAt")?
                .timestamp_millis(),
            started.timestamp_millis() + TIMELINE_RETENTION_MS
        );

        // (2) Dedupe: the second write for the same key is an upsert no-op. The
        // route retries after a transport failure, so a changed label must never
        // overwrite the stored one.
        let retry_at = DateTime::from_millis(started.timestamp_millis() + 120_000);
        data.insert_marker(filter(), update("second note", retry_at))
            .await
            .expect("duplicate marker is absorbed");
        assert_eq!(collection.count_documents(filter()).await?, 1, "one receipt per marker key");
        let after_retry = collection
            .find_one(filter())
            .await?
            .expect("stored marker");
        assert_eq!(after_retry.get_str("label")?, "first note", "a retry must not rewrite the label");
        assert_eq!(
            after_retry.get_datetime("occurredAt")?.timestamp_millis(),
            first_at.timestamp_millis()
        );

        // (3) Readback through the adapter's own query: ascending occurrence.
        let rows = data.rows(TimelineRows::Moments, filter()).await?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get_str("label")?, "first note");

        // A redemption marker with the same session stays out of the note delete.
        let redemption_key = format!("redemption:{marker_id}");
        collection
            .insert_one(doc! {"channelID": channel, "session_id": session_id, "key": &redemption_key,
                "kind": "redemption", "label": "Hydrate", "occurredAt": first_at,
                "expiresAt": DateTime::from_millis(started.timestamp_millis() + TIMELINE_RETENTION_MS)})
            .await?;

        // (4) Delete is scoped by `_id`, channel, session and kind: the wrong
        // kind removes nothing, the route's own filter removes exactly the note.
        data.delete_marker(doc! {"_id": stored_id, "channelID": channel, "session_id": session_id, "kind": "redemption"})
            .await
            .expect("wrong-kind delete");
        assert_eq!(collection.count_documents(filter()).await?, 1, "wrong kind is a no-op");
        data.delete_marker(doc! {"_id": stored_id, "channelID": channel, "session_id": session_id, "kind": "note"})
            .await
            .expect("delete marker");
        assert_eq!(collection.count_documents(filter()).await?, 0);
        let remaining = data
            .rows(TimelineRows::Moments, doc! {"channelID": channel, "session_id": session_id})
            .await?;
        assert_eq!(remaining.len(), 1, "the redemption marker remains");
        assert_eq!(remaining[0].get_str("kind")?, "redemption");

        // Repeating the delete is an idempotent no-op, not an error.
        data.delete_marker(doc! {"_id": stored_id, "channelID": channel, "session_id": session_id, "kind": "note"})
            .await
            .expect("repeat delete");
        assert_eq!(collection.count_documents(doc! {"channelID": channel}).await?, 1);
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("route-data marker suite timed out in {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned disposable MongoDB (STREAM_TIMELINE_TEST_MONGO_*)"]
async fn route_data_rows_sort_and_limit_against_disposable_mongo() -> TestResult {
    let fixture = disposable_database("route_data_rows").await?;
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let channel = "654321";
        let session_id = ObjectId::new();
        let customer = "customer-route-data";
        let data = adapter(&fixture.database).await;
        let now = DateTime::now();

        // People rows: the adapter fixes `{count: -1, _id: 1}` and a 51-row limit.
        let aggregates = stream_activity::aggregate_schema().native_collection(&fixture.database);
        let people: Vec<_> = (0..55)
            .map(|index| doc! {"channelID": channel, "session_id": session_id, "scope": "actor",
                "kind": "command", "key": "ping", "actor": format!("actor-{index:02}"),
                "count": index, "failures": 0, "expiresAt": DateTime::from_millis(now.timestamp_millis() + TIMELINE_RETENTION_MS)})
            .collect();
        aggregates.insert_many(people).await?;
        let people_filter = doc! {"channelID": channel, "session_id": session_id, "scope": "actor",
            "kind": "command", "key": "ping", "expiresAt": {"$gt": now}};
        let rows = data.rows(TimelineRows::People, people_filter).await?;
        assert_eq!(rows.len(), 51, "the people query is capped at 51 rows");
        let counts: Vec<i32> = rows
            .iter()
            .map(|row| row.get_i32("count").expect("count"))
            .collect();
        assert_eq!(counts, (4..=54).rev().collect::<Vec<i32>>(), "count descending");
        assert_eq!(rows[0].get_str("actor")?, "actor-54");

        // Credits rows: `{occurredAt: -1, entryId: -1}` with a 101-row limit.
        let receipts = ai_usage_receipt::schema().native_collection(&fixture.database);
        let credits: Vec<_> = (0..105)
            .map(|index| doc! {"channelID": channel, "customerId": customer,
                "entryId": format!("entry-{index:03}"),
                "occurredAt": DateTime::from_millis(now.timestamp_millis() - 300_000 + index as i64 * 1_000),
                "category": "tts", "operation": "synthesis", "provider": "piper", "credits": 1,
                "entryKind": "usage", "expiresAt": DateTime::from_millis(now.timestamp_millis() + TIMELINE_RETENTION_MS)})
            .collect();
        receipts.insert_many(credits).await?;
        let credit_filter = doc! {"channelID": channel, "customerId": customer,
            "occurredAt": {"$gte": DateTime::from_millis(now.timestamp_millis() - 600_000), "$lt": now},
            "expiresAt": {"$gt": now}};
        let rows = data.rows(TimelineRows::Credits, credit_filter.clone()).await?;
        assert_eq!(rows.len(), 101, "the credits query is capped at 101 rows");
        assert_eq!(rows[0].get_str("entryId")?, "entry-104", "newest first");
        // Equal timestamps fall back to descending `entryId`: entry-104 and
        // entry-103 are 1000 ms apart, so pin the tie-break on two equal rows.
        let tied = DateTime::from_millis(now.timestamp_millis() - 10_000);
        receipts
            .insert_many(vec![
                doc! {"channelID": channel, "customerId": customer, "entryId": "tie-a",
                    "occurredAt": tied, "credits": 1, "expiresAt": DateTime::from_millis(now.timestamp_millis() + TIMELINE_RETENTION_MS)},
                doc! {"channelID": channel, "customerId": customer, "entryId": "tie-b",
                    "occurredAt": tied, "credits": 1, "expiresAt": DateTime::from_millis(now.timestamp_millis() + TIMELINE_RETENTION_MS)},
            ])
            .await?;
        let rows = data.rows(TimelineRows::Credits, credit_filter).await?;
        let tied_positions: Vec<&str> = rows
            .iter()
            .filter_map(|row| row.get_str("entryId").ok())
            .filter(|entry| entry.starts_with("tie-"))
            .collect();
        assert_eq!(tied_positions, vec!["tie-b", "tie-a"], "equal times order by entryId descending");
        Ok(())
    })
    .await;
    let name = fixture.name.clone();
    fixture.drop_database().await;
    outcome.unwrap_or_else(|_| panic!("route-data rows suite timed out in {name}"))
}
