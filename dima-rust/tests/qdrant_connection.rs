#![cfg(feature = "qdrant")]

//! Opt-in integration coverage for [`dima_rust::utils::qdrant`].
//!
//! Run only against a disposable Qdrant fixture with an API key:
//!
//! ```sh
//! QDRANT_HOST=127.0.0.1 QDRANT_GRPC_PORT=6334 QDRANT_API_KEY=fixture-key \
//! QDRANT_TEST_COLLECTION_PREFIX=dima_rust_fixture \
//!   cargo test --locked --features qdrant --test qdrant_connection -- --ignored
//! ```
//!
//! The test creates, uses, and deletes one collection named from
//! `QDRANT_TEST_COLLECTION_PREFIX`, and checks that a wrong API key fails.

use dima_rust::utils::qdrant::{QdrantSettings, connect, get_qdrant_client};
use qdrant_client::qdrant::{
    CreateCollectionBuilder, Distance, PointStruct, SearchPointsBuilder, UpsertPointsBuilder,
    VectorParamsBuilder,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated Qdrant fixture; set QDRANT_HOST, QDRANT_API_KEY, and QDRANT_TEST_COLLECTION_PREFIX"]
async fn qdrant_client_fixture() {
    let prefix = std::env::var("QDRANT_TEST_COLLECTION_PREFIX")
        .expect("QDRANT_TEST_COLLECTION_PREFIX must name a fixture-only prefix");
    assert!(
        prefix.starts_with("dima_rust_fixture"),
        "fixture-only prefix required"
    );
    let collection = format!("{prefix}_{}", std::process::id());

    let client = get_qdrant_client().await.expect("fixture connection");
    let again = get_qdrant_client().await.expect("cached connection");
    assert!(std::ptr::eq(client, again), "the client is cached");

    client
        .create_collection(
            CreateCollectionBuilder::new(&collection)
                .vectors_config(VectorParamsBuilder::new(3, Distance::Cosine)),
        )
        .await
        .expect("create fixture collection");
    let result = async {
        client
            .upsert_points(
                UpsertPointsBuilder::new(
                    &collection,
                    vec![
                        PointStruct::new(1, vec![1.0, 0.0, 0.0], [("channel", "a".into())]),
                        PointStruct::new(2, vec![0.0, 1.0, 0.0], [("channel", "b".into())]),
                    ],
                )
                .wait(true),
            )
            .await?;
        let found = client
            .search_points(
                SearchPointsBuilder::new(&collection, vec![0.9, 0.1, 0.0], 1).with_payload(true),
            )
            .await?;
        assert_eq!(found.result.len(), 1);
        assert_eq!(
            found.result[0].payload["channel"]
                .as_str()
                .map(String::as_str),
            Some("a")
        );
        Ok::<(), qdrant_client::QdrantError>(())
    }
    .await;
    client
        .delete_collection(&collection)
        .await
        .expect("delete fixture collection");
    result.expect("upsert and search");

    let mut wrong = QdrantSettings::from_env().unwrap();
    wrong.api_key = "wrong-key".to_owned();
    assert!(connect(&wrong).await.is_err(), "a wrong API key must fail");
}
