//! Observer lifetime, cancellation, named failures and last-resort forced drops.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use anyhow::{Result, ensure};
use dima_rig::{postgres, stores::Registry};
use std::time::Duration;

fn settings() -> dima_rig::run::Settings {
    dima_rig::config::settings(&Default::default(), std::env::vars().collect()).unwrap()
}
fn uri() -> Option<String> {
    let uri = std::env::var("DIMA_TEST_POSTGRES_URI").ok();
    assert!(
        uri.is_some() || std::env::var("DIMA_TEST_REQUIRE_STORES").is_err(),
        "PostgreSQL required"
    );
    uri
}
#[tokio::test]
async fn observers_close_after_success_error_and_cancellation() {
    let Some(root) = uri() else {
        return;
    };
    let registry = Registry::default();
    let name = format!("rig_{}_observer_close", std::process::id());
    let mut slow = None;
    let result: Result<()> = async {
        let db = postgres::Database::create(&root, &name, &registry).await?;
        let probe = postgres::Database::observer(root.clone());
        db.execute("CREATE TABLE data(id integer); INSERT INTO data VALUES(1)").await?;
        ensure!(db.read("SELECT * FROM data").await?.as_array().is_some());
        db.snapshot().await?;
        let mut observed = db.time_observer().await?;
        ensure!(observed.rows().await? == serde_json::json!([{"value":{"id":1}}]));
        // The provenance observer commits each pass, sees newly created tables/views, and
        // rolls back a failed pass before its scoped connection is closed.
        db.execute("INSERT INTO data VALUES(0); CREATE VIEW failing_view AS SELECT 1/id AS n FROM data").await?;
        ensure!(observed.rows().await.is_err());
        observed.finish().await?;
        db.execute("DROP VIEW failing_view; DELETE FROM data WHERE id=0").await?;
        ensure!(db.read("SELECT * FROM missing_table").await.is_err());
        let side_uri = db.uri.clone();
        slow = Some(tokio::spawn(async move { postgres::Database::observer(side_uri).read("SELECT pg_sleep(60)").await }));
        let deadline = tokio::time::Instant::now()+Duration::from_secs(30);
        loop {
            let rows = probe.read(&format!("SELECT pid FROM pg_stat_activity WHERE datname='{name}' AND query LIKE '%pg_sleep%'")).await?;
            if !rows.as_array().is_none_or(Vec::is_empty) { break; }
            ensure!(tokio::time::Instant::now() < deadline, "slow observer did not start");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if let Some(task) = slow.take() { task.abort(); let _ = task.await; }
        let waiter = tokio::spawn(postgres::flush_observers());
        tokio::time::sleep(Duration::from_millis(50)).await;
        waiter.abort();
        let _ = waiter.await;
        postgres::flush_observers().await?;
        let rows = probe.read(&format!("SELECT pid FROM pg_stat_activity WHERE datname='{name}'")).await?;
        ensure!(rows.as_array().is_some_and(Vec::is_empty), "observer backend remains: {rows}");
        // This intentionally cannot drop the database on its own current connection.
        let failed = postgres::drop_database(&db.uri, &name).await.expect_err("current database cannot be dropped");
        ensure!(failed.to_string().contains(&name), "failure omits database: {failed}");
        ensure!(!postgres::drop_database(&root, &name).await?, "normal cleanup unexpectedly forced");
        let orphan_name = format!("rig_0_{}_gc_fixture", std::process::id());
        let orphan = postgres::Database::create(&root, &orphan_name, &registry).await?;
        ensure!(postgres::drop_database(&orphan.uri, &orphan_name).await.is_err());
        let reclaimed = postgres::gc(&root).await?;
        ensure!(reclaimed.iter().any(|message| message.contains(&orphan_name)), "gc missed failed-drop database: {reclaimed:?}");
        Ok(())
    }.await;
    if let Some(task) = slow {
        task.abort();
        let _ = task.await;
    }
    let cleanup = registry.cleanup(&settings().stores, false).await;
    assert!(cleanup.errors.is_empty(), "{cleanup:?}");
    result.unwrap();
}

#[tokio::test]
async fn only_a_remaining_backend_requires_force() {
    let Some(root) = uri() else {
        return;
    };
    let registry = Registry::default();
    let name = format!("rig_{}_force_close", std::process::id());
    let mut held = None;
    let result: Result<()> = async {
        let db = postgres::Database::create(&root, &name, &registry).await?;
        let (client, connection) = tokio_postgres::connect(&db.uri, tokio_postgres::NoTls).await?;
        let driver = tokio::spawn(connection);
        held = Some((client, driver));
        let removed = registry.cleanup(&settings().stores, false).await;
        ensure!(
            removed.errors.is_empty(),
            "forced cleanup failed: {removed:?}"
        );
        ensure!(
            removed.forced_postgres.contains(&name),
            "FORCE was not reported: {removed:?}"
        );
        ensure!(
            removed
                .summary()
                .is_some_and(|summary| summary.contains("FORCE")),
            "missing FORCE summary"
        );
        Ok(())
    }
    .await;
    if let Some((client, driver)) = held {
        drop(client);
        let _ = driver.await;
    }
    let cleanup = registry.cleanup(&settings().stores, false).await;
    assert!(cleanup.errors.is_empty(), "{cleanup:?}");
    result.unwrap();
}
