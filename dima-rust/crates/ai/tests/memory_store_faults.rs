#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Two stores, one truth: every operation with its second write failing and with a kill
//! between its two writes (the operation's future dropped at that step), against the local
//! MongoDB and Qdrant. After each, no point exists without a confirmed document holding the
//! same text (no ghost); a document left without its point is restored by the retry or by
//! `repair`. Also: the limits under a race of two processes, the size bounds, ownership across
//! channels, embedding counts, and private text in `Debug`.

mod memory_store_support;

use dima_ai::memory_store::{
    ActorInput, CreateMemory, CreateOutcome, ErrorKind, KnownUserQuery, ListMemories, Private,
    RecallQuery, RepairScope, SetStatus, Step, UpdateMemory,
};
use dima_ai::qdrant::{MemoryRetrievalMode, MemorySubjectScope};
use dima_model::channel_ai_memories::{MemorySource, MemoryStatus, MemoryType};
use memory_store_support::{Env, Plan, with_env};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const A: &str = "1001";
const B: &str = "2002";
const NAMES: &[(&str, &str)] = &[(A, "alpha"), (B, "beta")];

fn confirmed(channel: &str, content: &str) -> CreateMemory {
    let mut input = CreateMemory::new(channel, MemoryType::ChannelLore, content);
    input.confidence = Some(0.9);
    input
}

async fn create(env: &Env, channel: &str, content: &str) -> anyhow::Result<String> {
    let outcome = env
        .store
        .create_or_update(confirmed(channel, content))
        .await?;
    Ok(outcome.memory().unwrap().id().unwrap().to_hex())
}

/// No ghost: every point belongs to a confirmed document of its channel with the same text.
/// Returns the confirmed documents that have no point.
async fn check_invariant(env: &Env) -> anyhow::Result<Vec<String>> {
    let docs = env.documents().await?;
    let points = env.points().await?;
    for p in &points {
        let id = p["payload"]["memory_id"].as_str().unwrap_or_default();
        let doc = docs
            .iter()
            .find(|d| d.get_object_id("_id").ok().map(|o| o.to_hex()).as_deref() == Some(id));
        let Some(doc) = doc else {
            anyhow::bail!("ghost point {}", p["id"])
        };
        anyhow::ensure!(
            doc.get_str("status")? == "confirmed",
            "point of an unconfirmed memory"
        );
        anyhow::ensure!(
            p["payload"]["channel_id"] == doc.get_str("channelID")?,
            "point of another channel"
        );
        anyhow::ensure!(
            p["payload"]["content"] == doc.get_str("content")?,
            "stale point content"
        );
        anyhow::ensure!(
            p["payload"]["summary"] == doc.get_str("summary")?,
            "stale point summary"
        );
    }
    Ok(docs
        .iter()
        .filter(|d| d.get_str("status").ok() == Some("confirmed"))
        .map(|d| d.get_object_id("_id").unwrap().to_hex())
        .filter(|id| {
            !points
                .iter()
                .any(|p| p["payload"]["memory_id"] == id.as_str())
        })
        .collect())
}

/// Runs `op` with `step` killed: waits until the step is reached, then drops the operation.
async fn kill_at<F, T>(env: &Arc<Env>, step: Step, op: F) -> anyhow::Result<()>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    env.faults.plan(step, Plan::Kill);
    let task = tokio::spawn(op);
    tokio::time::timeout(Duration::from_secs(60), env.faults.reached.notified()).await?;
    task.abort();
    let _ = task.await;
    Ok(())
}

async fn repaired(env: &Env) -> anyhow::Result<()> {
    env.store.repair(RepairScope::Channel(A)).await?;
    env.store.repair(RepairScope::Channel(B)).await?;
    let missing = check_invariant(env).await?;
    anyhow::ensure!(missing.is_empty(), "repair left {missing:?} without points");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_second_write_fails_or_is_killed() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        // Failure of the point: the insert is rolled back (the reference's outcome).
        env.faults.plan(Step::QdrantUpsert, Plan::Fail);
        let e = env
            .store
            .create_or_update(confirmed(A, "tea fails"))
            .await
            .unwrap_err();
        anyhow::ensure!(e.message == "Failed to create or update memory", "{e}");
        anyhow::ensure!(env.documents().await?.is_empty() && env.points().await?.is_empty());
        // Failure of the embedding: the same.
        env.faults.plan(Step::Embed, Plan::Fail);
        anyhow::ensure!(
            env.store
                .create_or_update(confirmed(A, "tea fails"))
                .await
                .is_err()
        );
        anyhow::ensure!(env.documents().await?.is_empty());
        // Kill between: a document without its point; the retry (dedupe) writes it.
        let store = env.store.clone();
        kill_at(&env, Step::QdrantUpsert, async move {
            store.create_or_update(confirmed(A, "tea killed")).await
        })
        .await?;
        anyhow::ensure!(
            check_invariant(&env).await?.len() == 1,
            "one document without point"
        );
        env.store
            .create_or_update(confirmed(A, "tea killed"))
            .await?;
        anyhow::ensure!(check_invariant(&env).await?.is_empty());
        // Kill between again; this time the repair restores it.
        let store = env.store.clone();
        kill_at(&env, Step::Embed, async move {
            store.create_or_update(confirmed(A, "music killed")).await
        })
        .await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        repaired(&env).await
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_second_write_fails_or_is_killed() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let id = create(&env, A, "tea original").await?;
        let edit = |text: &str| UpdateMemory {
            channel_id: A.into(),
            memory_id: id.clone(),
            content: Some(Private::new(text.into())),
            summary: Some(Private::new(text.into())),
            ..UpdateMemory::default()
        };
        // The save fails after the point was removed: the document keeps its text, no ghost.
        env.faults.plan(Step::MongoSave, Plan::Fail);
        anyhow::ensure!(env.store.update(edit("music edit one")).await.is_err());
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        repaired(&env).await?;
        // Killed before the save.
        let store = env.store.clone();
        let e = edit("music edit two");
        kill_at(&env, Step::MongoSave, async move { store.update(e).await }).await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        repaired(&env).await?;
        // The new point fails / is killed after the save: the document has the new text.
        env.faults.plan(Step::QdrantUpsert, Plan::Fail);
        anyhow::ensure!(env.store.update(edit("game edit three")).await.is_err());
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        let store = env.store.clone();
        let e = edit("game edit four");
        kill_at(
            &env,
            Step::QdrantUpsert,
            async move { store.update(e).await },
        )
        .await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        // The retry repairs its own memory.
        env.store.update(edit("game edit four")).await?;
        anyhow::ensure!(check_invariant(&env).await?.is_empty());
        let docs = env.documents().await?;
        anyhow::ensure!(docs[0].get_str("content")? == "game edit four");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_changes_fail_or_are_killed() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let mut pending = confirmed(A, "tea pending");
        pending.confidence = Some(0.1);
        let id = env
            .store
            .create_or_update(pending)
            .await?
            .memory()
            .unwrap()
            .id()
            .unwrap()
            .to_hex();
        let set = |status| SetStatus {
            channel_id: A.into(),
            memory_id: id.clone(),
            status,
            review_reason: None,
            reviewer: Some(ActorInput {
                source: Some(MemorySource::Streamer),
                ..ActorInput::default()
            }),
        };
        // To confirmed: save, then point. The point fails / is killed: no ghost, retry repairs.
        env.faults.plan(Step::QdrantUpsert, Plan::Fail);
        let e = env
            .store
            .set_status(set(MemoryStatus::Confirmed))
            .await
            .unwrap_err();
        anyhow::ensure!(e.message == "Failed to update memory status", "{e}");
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        env.store.set_status(set(MemoryStatus::Confirmed)).await?;
        anyhow::ensure!(check_invariant(&env).await?.is_empty() && env.points().await?.len() == 1);
        // Away from confirmed: point, then save. The save fails / is killed: still confirmed,
        // without point; the repair restores what the truth says.
        env.faults.plan(Step::MongoSave, Plan::Fail);
        anyhow::ensure!(
            env.store
                .set_status(set(MemoryStatus::Archived))
                .await
                .is_err()
        );
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        repaired(&env).await?;
        let store = env.store.clone();
        let s = set(MemoryStatus::Rejected);
        kill_at(
            &env,
            Step::MongoSave,
            async move { store.set_status(s).await },
        )
        .await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        // The Qdrant delete fails: nothing changes, the delete's own message.
        repaired(&env).await?;
        env.faults.plan(Step::QdrantDelete, Plan::Fail);
        let e = env
            .store
            .set_status(set(MemoryStatus::Archived))
            .await
            .unwrap_err();
        anyhow::ensure!(
            e.message == "Failed to delete channel memory embedding",
            "{e}"
        );
        anyhow::ensure!(check_invariant(&env).await?.is_empty() && env.points().await?.len() == 1);
        env.store.set_status(set(MemoryStatus::Archived)).await?;
        anyhow::ensure!(env.points().await?.is_empty());
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deletes_fail_or_are_killed() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let id = create(&env, A, "tea delete").await?;
        env.faults.plan(Step::MongoDelete, Plan::Fail);
        let e = env.store.delete(A, &id).await.unwrap_err();
        anyhow::ensure!(e.message == "Failed to permanently delete memory", "{e}");
        anyhow::ensure!(
            check_invariant(&env).await?.len() == 1,
            "document left without point"
        );
        let store = env.store.clone();
        let i = id.clone();
        kill_at(
            &env,
            Step::MongoDelete,
            async move { store.delete(A, &i).await },
        )
        .await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 1);
        env.store.delete(A, &id).await?;
        anyhow::ensure!(env.documents().await?.is_empty() && env.points().await?.is_empty());
        // All of a channel: killed between the points and the documents, then retried.
        create(&env, A, "tea one").await?;
        create(&env, A, "game two").await?;
        create(&env, B, "music other").await?;
        let store = env.store.clone();
        kill_at(&env, Step::MongoDeleteMany, async move {
            store.delete_all_channel_memories(A).await
        })
        .await?;
        anyhow::ensure!(check_invariant(&env).await?.len() == 2);
        anyhow::ensure!(env.store.delete_all_channel_memories(A).await? == 2);
        let points = env.points().await?;
        anyhow::ensure!(
            env.documents().await?.len() == 1
                && points.len() == 1
                && points[0]["payload"]["channel_id"] == B
        );
        Ok(())
    })
    .await
}

/// `repair`: ghosts, stale points, points of unconfirmed memories, a missing point id, and a
/// collision it cannot resolve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repair_restores_the_invariant() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let kept = create(&env, A, "tea kept").await?;
        let stale = create(&env, A, "game stale").await?;
        let archived = create(&env, A, "music archived").await?;
        let ghost = create(&env, A, "ghost tea").await?;
        // Make the leftovers older code could leave: stale text, an archived memory with its
        // point, a point whose document is gone, a confirmed memory without id and point.
        let oid = |s: &str| bson::oid::ObjectId::parse_str(s).unwrap();
        let docs = env.mongo.documents("channelaimemories");
        docs.update_one(
            bson::doc! {"_id": oid(&stale)},
            bson::doc! {"$set": {"content": "game stale edited"}},
        )
        .await?;
        docs.update_one(
            bson::doc! {"_id": oid(&archived)},
            bson::doc! {"$set": {"status": "archived"}},
        )
        .await?;
        docs.delete_one(bson::doc! {"_id": oid(&ghost)}).await?;
        let legacy = create(&env, B, "legacy tea").await?;
        let point = env
            .points()
            .await?
            .into_iter()
            .find(|p| p["payload"]["memory_id"] == legacy.as_str())
            .unwrap();
        env.qdrant_call(
            dima_http::Method::POST,
            "/points/delete?wait=true",
            Some(json!({"points": [point["id"]]})),
        )
        .await?;
        docs.update_one(
            bson::doc! {"_id": oid(&legacy)},
            bson::doc! {"$unset": {"qdrantPointID": 1}},
        )
        .await?;
        anyhow::ensure!(check_invariant(&env).await.is_err());
        let report = env.store.repair(RepairScope::All).await?;
        anyhow::ensure!(
            report.points_written == 2 && report.points_removed == 1 && report.ghosts_removed == 1,
            "{report:?}"
        );
        anyhow::ensure!(check_invariant(&env).await?.is_empty());
        let restored = env
            .documents()
            .await?
            .into_iter()
            .find(|d| d.get_object_id("_id").ok() == Some(oid(&legacy)))
            .unwrap();
        anyhow::ensure!(restored.get("qdrantPointID").is_some(), "point id assigned");
        // A second run finds nothing to do.
        let again = env.store.repair(RepairScope::All).await?;
        anyhow::ensure!(
            again.points_written + again.points_removed + again.ghosts_removed == 0,
            "{again:?}"
        );
        anyhow::ensure!(again.documents == 4, "{again:?}");
        let _ = kept;
        Ok(())
    })
    .await
}

/// A memory of another channel is out of reach whatever the call: no read, edit, status
/// change or delete crosses, and recall never returns another channel's points.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_channel_is_out_of_reach() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let theirs = create(&env, B, "their tea secret").await?;
        create(&env, A, "our tea").await?;
        let before = (env.documents().await?, env.points().await?);
        let not_found = |r: Result<(), dima_ai::memory_store::MemoryError>| {
            r.err().is_some_and(|e| e.kind == ErrorKind::NotFound)
        };
        anyhow::ensure!(not_found(env.store.delete(A, &theirs).await));
        anyhow::ensure!(not_found(
            env.store
                .update(UpdateMemory {
                    channel_id: A.into(),
                    memory_id: theirs.clone(),
                    content: Some(Private::new("x".into())),
                    ..UpdateMemory::default()
                })
                .await
                .map(|_| ())
        ));
        anyhow::ensure!(not_found(
            env.store
                .set_status(SetStatus {
                    channel_id: A.into(),
                    memory_id: theirs.clone(),
                    status: MemoryStatus::Archived,
                    review_reason: None,
                    reviewer: None
                })
                .await
                .map(|_| ())
        ));
        anyhow::ensure!(not_found(
            env.store.sync_memory(A, &theirs).await.map(|_| ())
        ));
        anyhow::ensure!(
            before == (env.documents().await?, env.points().await?),
            "nothing changed"
        );
        let recalled = env
            .store
            .recall(&RecallQuery {
                channel_id: A.into(),
                query: Private::new("tea secret".into()),
                limit: 10,
                min_score: Some(0.0),
                mode: MemoryRetrievalMode::Explicit,
                subject_scope: MemorySubjectScope::Any,
            })
            .await?;
        anyhow::ensure!(recalled.len() == 1 && recalled.iter().all(|i| i.channel_id == A));
        let page = env
            .store
            .list(&ListMemories {
                channel_id: A.into(),
                ..ListMemories::default()
            })
            .await?;
        anyhow::ensure!(page.total == 1);
        let validated = env
            .store
            .validate_context(
                A,
                &[dima_ai::memory_store::ScoredCandidate {
                    memory_id: theirs.clone(),
                    score: 1.0,
                }],
                5,
                &dima_ai::memory::Policy {
                    allow_sensitive_memories: true,
                    allow_user_preference_memories: true,
                    allow_running_jokes: true,
                },
            )
            .await;
        anyhow::ensure!(validated.is_empty());
        env.store
            .record_usage(A, std::slice::from_ref(&theirs))
            .await;
        anyhow::ensure!(
            before.0 == env.documents().await?,
            "usage of another channel's memory"
        );
        Ok(())
    })
    .await
}

/// Size bounds are enforced before any read, write or embedding.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn size_bounds_come_first() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let mut chat = confirmed(A, &"t".repeat(2_001));
        chat.created_by = Some(ActorInput {
            source: Some(MemorySource::Chat),
            ..ActorInput::default()
        });
        let e = env.store.create_or_update(chat).await.unwrap_err();
        anyhow::ensure!(
            e.kind == ErrorKind::TooLarge && !e.message.contains("ttt"),
            "{e}"
        );
        let e = env
            .store
            .create_or_update(confirmed(A, &"😀".repeat(20_001)))
            .await
            .unwrap_err();
        anyhow::ensure!(e.kind == ErrorKind::TooLarge);
        let mut evidence = confirmed(A, "ok");
        evidence.evidence = vec![dima_ai::memory_store::EvidenceInput {
            message: Some(Private::new("m".repeat(2_001))),
            ..Default::default()
        }];
        anyhow::ensure!(
            env.store.create_or_update(evidence).await.unwrap_err().kind == ErrorKind::TooLarge
        );
        anyhow::ensure!(
            env.faults.steps().is_empty()
                && env.embeddings().is_empty()
                && env.documents().await?.is_empty()
        );
        // Within the bound: a streamer's long memory (20,000 scalars, emoji count 1).
        let mut long = confirmed(A, &"😀".repeat(20_000));
        long.created_by = Some(ActorInput {
            source: Some(MemorySource::Streamer),
            ..ActorInput::default()
        });
        env.store.create_or_update(long).await?;
        // A recall query is cut, not refused.
        env.store
            .recall(&RecallQuery {
                channel_id: A.into(),
                query: Private::new("q".repeat(5_000)),
                limit: 1,
                min_score: None,
                mode: MemoryRetrievalMode::Explicit,
                subject_scope: MemorySubjectScope::Channel,
            })
            .await?;
        let last = env.embeddings().pop().unwrap();
        anyhow::ensure!(
            last["input"].as_str().unwrap().chars().count() == 2_000 && last["kind"] == "query"
        );
        Ok(())
    })
    .await
}

/// Embedding calls per operation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn embedding_calls_per_operation() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        let count = || env.embeddings().len();
        let id = create(&env, A, "tea").await?;
        anyhow::ensure!(count() == 1, "create confirmed");
        let mut pending = confirmed(A, "game");
        pending.confidence = Some(0.1);
        let pid = env
            .store
            .create_or_update(pending)
            .await?
            .memory()
            .unwrap()
            .id()
            .unwrap()
            .to_hex();
        anyhow::ensure!(count() == 1, "create pending");
        env.store.create_or_update(confirmed(A, "tea")).await?;
        anyhow::ensure!(count() == 2, "dedupe update of a confirmed memory");
        env.store
            .update(UpdateMemory {
                channel_id: A.into(),
                memory_id: id.clone(),
                content: Some(Private::new("music".into())),
                ..UpdateMemory::default()
            })
            .await?;
        anyhow::ensure!(count() == 3, "update confirmed");
        env.store
            .update(UpdateMemory {
                channel_id: A.into(),
                memory_id: pid.clone(),
                content: Some(Private::new("game two".into())),
                ..UpdateMemory::default()
            })
            .await?;
        anyhow::ensure!(count() == 3, "update pending");
        env.store
            .set_status(SetStatus {
                channel_id: A.into(),
                memory_id: pid.clone(),
                status: MemoryStatus::Confirmed,
                review_reason: None,
                reviewer: None,
            })
            .await?;
        anyhow::ensure!(count() == 4, "confirm");
        env.store
            .set_status(SetStatus {
                channel_id: A.into(),
                memory_id: pid.clone(),
                status: MemoryStatus::Archived,
                review_reason: None,
                reviewer: None,
            })
            .await?;
        env.store
            .list(&ListMemories {
                channel_id: A.into(),
                ..ListMemories::default()
            })
            .await?;
        env.store
            .known_user_facts(&KnownUserQuery {
                channel_id: A.into(),
                user_id: "1".into(),
                limit: 3,
                allow_sensitive_memories: false,
            })
            .await;
        env.store.delete(A, &id).await?;
        anyhow::ensure!(count() == 4, "archive, list, known facts, delete");
        env.store
            .recall(&RecallQuery {
                channel_id: A.into(),
                query: Private::new("tea".into()),
                limit: 3,
                min_score: None,
                mode: MemoryRetrievalMode::Passive,
                subject_scope: MemorySubjectScope::Channel,
            })
            .await?;
        anyhow::ensure!(count() == 5, "recall");
        Ok(())
    })
    .await
}

#[test]
fn memory_text_is_private_in_debug() {
    let mut input = CreateMemory::new(A, MemoryType::Preference, "SECRET-CONTENT");
    input.summary = Some(Private::new("SECRET-SUMMARY".into()));
    input.evidence = vec![dima_ai::memory_store::EvidenceInput {
        message: Some(Private::new("SECRET-MESSAGE".into())),
        ..Default::default()
    }];
    let shown = format!("{input:?}");
    assert!(!shown.contains("SECRET"), "{shown}");
    let update = UpdateMemory {
        content: Some(Private::new("SECRET".into())),
        ..UpdateMemory::default()
    };
    assert!(!format!("{update:?}").contains("SECRET"));
    let q = RecallQuery {
        channel_id: A.into(),
        query: Private::new("SECRET".into()),
        limit: 1,
        min_score: None,
        mode: MemoryRetrievalMode::Passive,
        subject_scope: MemorySubjectScope::Channel,
    };
    assert!(!format!("{q:?}").contains("SECRET"));
}

/// Two processes race creates of confirmed memories against a limit of 3: the limit holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn limits_hold_under_a_race_of_two_processes() -> anyhow::Result<()> {
    with_env(NAMES, |env| async move {
        env.insert_ejson("channelaipersonalities", &json!({"channelID": A, "channel": "alpha", "learningConfig": {"maxConfirmedMemories": 3}})).await?;
        let exe = std::env::current_exe()?;
        let spawn = |offset: &str| {
            tokio::process::Command::new(&exe)
                .args(["--exact", "race_child", "--ignored", "--nocapture", "--test-threads=1"])
                .env("DIMA_RACE_DB", &env.name)
                .env("DIMA_RACE_OFFSET", offset)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        };
        let (a, b) = (spawn("1000")?, spawn("2000")?);
        let (a, b) = tokio::try_join!(a.wait_with_output(), b.wait_with_output())?;
        anyhow::ensure!(a.status.success() && b.status.success(), "children failed: {} {}", String::from_utf8_lossy(&a.stdout), String::from_utf8_lossy(&b.stdout));
        let created: usize = [&a, &b]
            .iter()
            .filter_map(|o| String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.split("created ").nth(1)?.trim().parse::<usize>().ok()))
            .sum();
        let docs = env.documents().await?;
        let confirmed = docs.iter().filter(|d| d.get_str("status").ok() == Some("confirmed")).count();
        anyhow::ensure!((1..=3).contains(&confirmed), "{confirmed} confirmed memories for a limit of 3");
        anyhow::ensure!(check_invariant(&env).await?.is_empty(), "every survivor indexed");
        anyhow::ensure!(env.points().await?.len() == confirmed && created == confirmed);
        Ok(())
    })
    .await
}

/// The child of the race: eight concurrent creates against the parent's scratch stores.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "run by limits_hold_under_a_race_of_two_processes"]
async fn race_child() -> anyhow::Result<()> {
    let (Ok(db), Ok(offset)) = (
        std::env::var("DIMA_RACE_DB"),
        std::env::var("DIMA_RACE_OFFSET"),
    ) else {
        return Ok(());
    };
    let env = Env::open(Default::default(), db, false).await?.unwrap();
    env.ids
        .0
        .store(offset.parse()?, std::sync::atomic::Ordering::SeqCst);
    let env = Arc::new(env);
    let mut tasks = Vec::new();
    for i in 0..8 {
        let store = env.store.clone();
        let content = format!("race tea {offset} {i}");
        tasks.push(tokio::spawn(async move {
            store.create_or_update(confirmed(A, &content)).await
        }));
    }
    let mut created = 0;
    for t in tasks {
        match t.await? {
            Ok(CreateOutcome::Created(_)) => created += 1,
            Ok(other) => anyhow::bail!("unexpected {other:?}"),
            Err(e) => anyhow::ensure!(e.kind == ErrorKind::Limit, "{e}"),
        }
    }
    println!("created {created}");
    Ok(())
}
