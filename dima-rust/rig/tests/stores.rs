//! Store inspection against the local MongoDB: only "namespace does not exist" means "no
//! indexes"; any other failure (here: a user without the listIndexes privilege) fails.
//!
//! Needs the local stores (`eval "$(dima-rust/tools/test-env)"`); skips with a message otherwise.
//! Creates `rig_<pid>_stores` (database, role and user) and drops all three.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bson::doc;
use dima_rig::stores::{drop_user, list_indexes, uri_with_db};

#[test]
fn index_inspection_fails_on_anything_but_a_missing_namespace() {
    let Some(uri) = std::env::var("DIMA_TEST_MONGO_URI")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        eprintln!("skipping: DIMA_TEST_MONGO_URI is not set");
        return;
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let name = format!("rig_{}_stores", std::process::id());
    let client = rt.block_on(mongodb::Client::with_uri_str(&uri)).unwrap();
    let db = client.database(&name);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rt.block_on(async {
            db.run_command(doc! {"createIndexes": "c", "indexes": [{"key": {"a": 1, "b": -1}, "name": "a_1_b_-1"}]})
                .await
                .unwrap();
            db.run_command(doc! {"create": "v", "viewOn": "c", "pipeline": []})
                .await
                .unwrap();
            let names = |specs: Vec<bson::Document>| -> Vec<String> {
                specs
                    .iter()
                    .map(|d| d.get_str("name").unwrap().to_string())
                    .collect()
            };
            assert_eq!(
                names(list_indexes(&db, "c", "collection").await.unwrap()),
                vec!["_id_", "a_1_b_-1"]
            );
            assert!(list_indexes(&db, "v", "view").await.unwrap().is_empty());
            assert!(
                list_indexes(&db, "missing", "collection")
                    .await
                    .unwrap()
                    .is_empty(),
                "a collection that does not exist has no indexes"
            );
            if !uri.contains('@') {
                eprintln!("the server runs without authentication: privilege check skipped");
                return;
            }
            // A user who may read documents but not list indexes.
            db.run_command(doc! {
                "createRole": &name,
                "privileges": [{"resource": {"db": &name, "collection": ""}, "actions": ["find", "listCollections"]}],
                "roles": []
            })
            .await
            .unwrap();
            client
                .database("admin")
                .run_command(doc! {"createUser": &name, "pwd": "rig-test-only", "roles": [{"role": &name, "db": &name}]})
                .await
                .unwrap();
            let limited_uri = {
                let base = uri_with_db(&uri, &name);
                let (scheme, rest) = base.split_once("://").unwrap();
                let hosts = rest.rsplit_once('@').map_or(rest, |(_, h)| h);
                format!("{scheme}://{name}:rig-test-only@{hosts}")
            };
            let limited = mongodb::Client::with_uri_str(&limited_uri).await.unwrap();
            let err = list_indexes(&limited.database(&name), "c", "collection")
                .await
                .unwrap_err()
                .to_string();
            assert!(err.contains("listIndexes on c"), "{err}");
        })
    }));
    rt.block_on(async {
        drop_user(&client, &name).await.unwrap();
        let _ = db.run_command(doc! {"dropRole": &name}).await;
        db.drop().await.unwrap();
    });
    if let Err(p) = result {
        std::panic::resume_unwind(p);
    }
}
