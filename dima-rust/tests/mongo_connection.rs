//! Opt-in integration coverage for
//! [`dima_rust::utils::mongo::get_mongo_client`].
//!
//! Run one fresh process per expectation, against a disposable fixture only:
//!
//! ```sh
//! MONGO_TEST_EXPECT=success MONGO_URI='mongodb://user:pass@127.0.0.1:27017/?' \
//!   cargo test --locked --test mongo_connection -- --ignored --exact mongo_client_fixture
//! ```
//!
//! Supported `MONGO_TEST_EXPECT` values:
//!
//! - `missing`: `MONGO_URI` must be unset.
//! - `blank`: `MONGO_URI` must be blank (empty or whitespace-only).
//! - `invalid`: `MONGO_URI` must be malformed (for example bad percent-encoding).
//! - `unreachable`: a well-formed URI for a dead endpoint, with short timeouts.
//! - `auth`: a reachable fixture with wrong credentials.
//! - `success`: a reachable fixture with working credentials.
//! - `retry`: an initially unreachable fixture made available after the first failure.
//!
//! The test reads the process environment instead of mutating it, so it avoids
//! Rust 2024's unsafe environment writes and can run with the default test
//! harness. It is ignored unless explicitly requested.

use std::ptr;
use std::time::{Duration, Instant};

use dima_rust::utils::mongo::get_mongo_client;
use mongodb::bson::doc;
use mongodb::error::ErrorKind;

const EXPECT_ENV: &str = "MONGO_TEST_EXPECT";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn mongo_client_fixture() {
    let mode = std::env::var(EXPECT_ENV).expect(
        "MONGO_TEST_EXPECT must be set to missing|blank|invalid|unreachable|auth|success|retry",
    );

    match mode.as_str() {
        "missing" => {
            let error = get_mongo_client()
                .await
                .expect_err("initialization must fail when MONGO_URI is unset");
            assert!(
                error.to_string().contains("MONGO_URI is not set"),
                "unexpected error: {error}"
            );
        }
        "blank" => {
            let error = get_mongo_client()
                .await
                .expect_err("initialization must fail when MONGO_URI is blank");
            assert!(
                error.to_string().contains("MONGO_URI is blank"),
                "unexpected error: {error}"
            );
        }
        "invalid" => {
            let raw_uri = std::env::var("MONGO_URI")
                .expect("MONGO_URI must contain the malformed connection string");
            let error = get_mongo_client()
                .await
                .expect_err("initialization must fail for a malformed MONGO_URI");
            let rendered = error.to_string();

            assert!(
                rendered.contains("not a usable MongoDB connection string"),
                "unexpected error: {rendered}"
            );
            assert!(
                !rendered.contains(&raw_uri),
                "parse errors must not repeat the raw URI"
            );
        }
        "unreachable" => {
            let error = get_mongo_client()
                .await
                .expect_err("initialization must fail for an unreachable fixture");
            assert!(matches!(
                error.kind.as_ref(),
                ErrorKind::ServerSelection { .. }
            ));
        }
        "auth" => {
            let error = get_mongo_client()
                .await
                .expect_err("initialization must fail for rejected fixture credentials");
            assert!(matches!(
                error.kind.as_ref(),
                ErrorKind::Authentication { .. }
            ));
        }
        "retry" => {
            let error = get_mongo_client()
                .await
                .expect_err("the fixture must initially be unreachable");
            assert!(matches!(
                error.kind.as_ref(),
                ErrorKind::ServerSelection { .. }
            ));
            // The external fixture runner enables the same endpoint after this
            // marker. Configuration stays unchanged throughout this process.
            println!("INITIAL_FAILURE_OBSERVED");
            let deadline = Instant::now() + Duration::from_secs(10);
            let client = loop {
                match get_mongo_client().await {
                    Ok(client) => break client,
                    Err(error) if Instant::now() >= deadline => {
                        panic!("initialization did not recover after fixture startup: {error}");
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            };
            client
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .expect("retried client must be ready");
            assert!(ptr::eq(
                client,
                get_mongo_client().await.expect("cached client")
            ));
        }
        "success" => {
            // First callers race on an empty cell; both must succeed with the
            // same cached client.
            let (first, second) = tokio::join!(get_mongo_client(), get_mongo_client());
            let first = first.expect("first initialization must succeed");
            let second = second.expect("concurrent initialization must succeed");

            assert!(
                ptr::eq(first, second),
                "concurrent callers must receive the same client pointer"
            );

            // A later call must reuse the cached client rather than creating
            // another one.
            let third = get_mongo_client()
                .await
                .expect("cached client must be returned");
            assert!(
                ptr::eq(first, third),
                "cached client must be reused across calls"
            );

            // Prove readiness: initialization pinged admin, and the returned
            // client is still usable for a real round trip.
            first
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .expect("fixture must accept an admin ping");
        }
        other => panic!(
            "unsupported MONGO_TEST_EXPECT value {other:?}; expected \
             missing|blank|invalid|unreachable|auth|success|retry"
        ),
    }
}
