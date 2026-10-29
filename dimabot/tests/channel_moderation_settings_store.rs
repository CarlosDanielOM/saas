#![cfg(feature = "channel-moderation-settings")]
use dima_rust::schemas::channel_moderation_settings::get_channel_moderation_settings_model;
use futures_util::FutureExt;
use mongodb::{
    Client,
    bson::{DateTime, doc},
};
use std::panic::AssertUnwindSafe;

#[tokio::test]
#[ignore = "requires explicit task-owned disposable MongoDB"]
async fn isolated_repository_index_insert_read_update_and_duplicate() {
    let owner = std::env::var("DIMA_MODERATION_SCHEMA_TEST_OWNER").expect("owner token");
    assert!(
        owner.len() >= 12
            && owner.len() <= 40
            && owner
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    );
    let endpoint = std::env::var("DIMA_MODERATION_SCHEMA_MONGO_ENDPOINT")
        .expect("explicit disposable endpoint");
    let (host, port) = endpoint.rsplit_once(':').expect("host:port");
    assert!(
        host == "127.0.0.1"
            || (host.starts_with("moderation-schema-mongo-")
                && host
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    );
    assert!(port.parse::<u16>().is_ok());
    let uri = std::env::var("DIMA_MODERATION_SCHEMA_MONGO_URI").expect("explicit disposable uri");
    assert_eq!(uri, format!("mongodb://{endpoint}"));
    let client = Client::with_uri_str(&uri).await.unwrap();
    let database = client.database(&format!("test_moderation_schema_{owner}"));
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fixture database must be empty"
    );
    let marker = database.collection::<mongodb::bson::Document>("task_owner");
    database.create_collection("task_owner").await.unwrap();
    let result = AssertUnwindSafe(async {
        marker.insert_one(doc! {"_id":&owner}).await.unwrap();
        let repo = get_channel_moderation_settings_model(&database);
        repo.schema.install_indexes(&database).await.unwrap();
        let now = DateTime::from_millis(1_900_000_000_000);
        let first = repo.insert(doc! {"channelID":"alpha"}, now).await.unwrap();
        assert_eq!(first.get_str("channelID").unwrap(), "alpha");
        assert!(repo.insert(doc! {"channelID":"alpha"}, now).await.is_err());
        let found = repo
            .find_one(doc! {"channelID":"alpha"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            found.get_object_id("_id").unwrap(),
            first.get_object_id("_id").unwrap()
        );
        let updated = repo
            .save(
                doc! {"_id":first.get_object_id("_id").unwrap(),"channel":"changed"},
                DateTime::from_millis(now.timestamp_millis() + 1000),
            )
            .await
            .unwrap();
        assert_eq!(updated.get_str("channel").unwrap(), "changed");
        assert_eq!(
            updated
                .get_datetime("updatedAt")
                .unwrap()
                .timestamp_millis(),
            now.timestamp_millis() + 1000
        );
    })
    .catch_unwind()
    .await;
    // Never drop a database: remove only the two task-owned collections after
    // checking ownership and that no unexpected collection appeared.
    let marker_doc = marker.find_one(doc! {"_id":&owner}).await.unwrap();
    let names = database.list_collection_names().await.unwrap();
    if marker_doc.is_none() {
        // Marker creation can fail after the task created its empty collection.
        // Only that still-empty collection can be removed without a marker.
        assert!(
            names.iter().all(|n| n == "task_owner")
                && marker.find_one(doc! {}).await.unwrap().is_none(),
            "owner marker missing; refusing cleanup"
        );
    } else {
        assert!(
            names
                .iter()
                .all(|n| n == "task_owner" || n == "channel_moderation_settings"),
            "unexpected collection; refusing cleanup"
        );
        if names.iter().any(|n| n == "channel_moderation_settings") {
            database
                .collection::<mongodb::bson::Document>("channel_moderation_settings")
                .drop()
                .await
                .unwrap();
        }
    }
    marker.drop().await.unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
