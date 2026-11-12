//! Races between the roulette's writers. Every writer compares the revision it read (the
//! finishing write of a winner action compares the action's `running` status), so of two
//! writers exactly one wins and the other reloads and recomputes. What must hold, whoever wins:
//! one draw at a time, every completed draw recorded once (its winner copy removed once), every
//! winner action run once.
//!
//! - concurrent starts in one process;
//! - a completion forced between a start's read and its write (deterministic);
//! - a second process (this test binary, re-run as a child) completing draws while this one
//!   starts them, and the old crate's native completion worker as a third writer when it is built
//!   (`target/debug/roulette_completion`);
//! - two action loops claiming the same due actions.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "roulette_support/mod.rs"]
mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use bson::doc;
use dima_core::{Clock, ManualClock, Random, SeededRandom, SystemClock};
use dima_engine::syntax::SyntaxEngine;
use dima_features::roulette::{
    Action, DrawActor, Operation, RouletteConfig, RouletteService, ServiceError, WinnerAction,
    WinnerActionRunner,
};
use dima_store::mongo::MongoStore;
use serde_json::json;
use support::with_database;

fn service(mongo: &MongoStore, clock: Arc<dyn Clock>, random: Arc<dyn Random>) -> RouletteService {
    RouletteService::new(
        mongo.clone(),
        clock,
        random,
        Arc::new(SyntaxEngine::default()),
        RouletteConfig {
            deadline: Duration::from_secs(60),
            action_deadline: Duration::from_secs(60),
        },
    )
}

fn act(operation: Operation, data: serde_json::Value) -> Action {
    Action {
        operation,
        roulette: None,
        item_id: None,
        data: data.as_object().cloned(),
    }
}

async fn wheel(roulette: &RouletteService, channel: &str, copies: u32, action: &str) -> Result<()> {
    roulette
        .execute(channel, &act(Operation::Create, json!({"name": "Race", "alias": "race", "durationSeconds": 1, "settings": {"winnerAction": "remove-copy"}})), None, None, None)
        .await?;
    roulette
        .execute(
            channel,
            &act(
                Operation::Add,
                json!({"label": "Prize", "multiplier": copies, "action": action}),
            ),
            None,
            None,
            None,
        )
        .await?;
    Ok(())
}

fn refused_code(error: &ServiceError) -> Option<&str> {
    error.refused().map(|e| e.code.as_str())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_make_one_draw() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(1_794_355_200_000);
        let roulette = service(
            &mongo,
            Arc::new(clock.clone()),
            Arc::new(SeededRandom::new(3)),
        );
        wheel(&roulette, "7001", 10, "$(user) won").await?;
        let mut tasks = Vec::new();
        for n in 0..8 {
            let roulette = roulette.clone();
            tasks.push(tokio::spawn(async move {
                let actor = DrawActor {
                    user_id: format!("{n}"),
                    user_login: format!("u{n}"),
                    user_display_name: format!("U{n}"),
                    argument: None,
                };
                roulette
                    .execute(
                        "7001",
                        &Action::new(Operation::Start),
                        None,
                        None,
                        Some(&actor),
                    )
                    .await
            }));
        }
        let mut won = 0;
        for task in tasks {
            match task.await? {
                Ok(_) => won += 1,
                Err(error) => assert_eq!(refused_code(&error), Some("spinning"), "{error}"),
            }
        }
        assert_eq!(won, 1);
        let loaded = roulette.read("7001").await?.context("doc")?;
        assert_eq!(loaded.actions.len(), 1, "one winner action for one draw");
        assert_eq!(loaded.revision, 3.0);
        Ok(())
    })
    .await
}

/// A random source that runs `hook` once, the first time the draw asks for bytes: between the
/// start's read and its compare-and-set.
struct Interfering {
    inner: SeededRandom,
    fired: AtomicBool,
    hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl std::fmt::Debug for Interfering {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Interfering")
    }
}

impl Random for Interfering {
    fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
        if !self.fired.swap(true, Ordering::SeqCst)
            && let Some(hook) = self.hook.lock().unwrap().take()
        {
            hook();
        }
        self.inner.fill(buf)
    }
}

/// The start reads a due, uncompleted draw and completes it itself (`settle` inside `execute`);
/// meanwhile another writer completes it first. The start's write loses, it reloads, and the
/// draw is completed once: one history entry, one winner copy removed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_completion_between_read_and_write_is_applied_once() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(1_794_355_200_000);
        let plain = service(
            &mongo,
            Arc::new(clock.clone()),
            Arc::new(SeededRandom::new(5)),
        );
        wheel(&plain, "7002", 5, "").await?;
        plain
            .execute("7002", &Action::new(Operation::Start), None, None, None)
            .await?;
        clock.advance(2_000);
        let other = plain.clone();
        let handle = tokio::runtime::Handle::current();
        let hook: Box<dyn FnOnce() + Send> = Box::new(move || {
            // Another process's snapshot completes the draw now.
            std::thread::spawn(move || handle.block_on(other.snapshot("7002")).unwrap())
                .join()
                .unwrap();
        });
        let interfering = Arc::new(Interfering {
            inner: SeededRandom::new(6),
            fired: AtomicBool::new(false),
            hook: Mutex::new(Some(hook)),
        });
        let racing = service(&mongo, Arc::new(clock.clone()), interfering.clone());
        let executed = racing
            .execute("7002", &Action::new(Operation::Start), None, None, None)
            .await?;
        assert!(interfering.fired.load(Ordering::SeqCst));
        // wheel: 2 writes, first start: 1, the other's completion: 1, this start: 1.
        assert_eq!(executed.revision, 5);
        let loaded = racing.read("7002").await?.context("doc")?;
        assert_eq!(
            loaded.state.history.len(),
            1,
            "the first draw completed once"
        );
        assert_eq!(
            loaded.state.roulettes[0].items[0].copies.len(),
            4,
            "its winner copy removed once"
        );
        assert!(
            loaded
                .state
                .draw
                .as_ref()
                .is_some_and(|d| d.completed_at.is_none())
        );
        Ok(())
    })
    .await
}

/// Child mode of [`another_process_completes_while_this_one_starts`]: completes draws in its
/// own process until told to stop. Does nothing in a normal run.
#[tokio::test]
async fn child_completion_loop() -> Result<()> {
    let Ok(database) = std::env::var("DIMA_ROULETTE_RACE_CHILD") else {
        return Ok(());
    };
    let mongo = support::connect(&database).await?.context("mongo")?;
    let roulette = service(
        &mongo,
        Arc::new(SystemClock),
        Arc::new(SeededRandom::new(9)),
    );
    let stop = std::path::PathBuf::from(std::env::var("DIMA_ROULETTE_RACE_STOP")?);
    while !stop.exists() {
        match roulette.snapshot("7003").await {
            Ok(_) => {}
            Err(error) if refused_code(&error) == Some("busy") => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Three writers on one channel, with the system clock: this process starts draws (each
/// `execute` also completes the previous one when due) and reads snapshots; a child process
/// completes draws with its own snapshots; the old crate's native worker, when built, completes
/// them too. Each start that won is completed exactly once: the history counts the starts and
/// exactly one copy is removed per completed draw.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_process_completes_while_this_one_starts() -> Result<()> {
    with_database(|mongo, database| async move {
        let roulette = service(
            &mongo,
            Arc::new(SystemClock),
            Arc::new(SeededRandom::new(11)),
        );
        let copies = 40;
        wheel(&roulette, "7003", copies, "").await?;
        // A draw lasts 1 s; shorten it so the race has many rounds.
        let scratch =
            std::env::temp_dir().join(format!("dima-roulette-race-{}", support::random_suffix()));
        let stop = scratch.with_extension("stop");
        let mut child = tokio::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "child_completion_loop", "--nocapture"])
            .env("DIMA_ROULETTE_RACE_CHILD", &database)
            .env("DIMA_ROULETTE_RACE_STOP", &stop)
            .kill_on_drop(true)
            .spawn()?;
        let native_bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/roulette_completion");
        let mut native = if native_bin.exists() {
            let uri = support::mongo_uri().context("uri")?;
            Some(
                tokio::process::Command::new(&native_bin)
                    .args(["--database", &database])
                    .env("MONGO_URI", uri)
                    .kill_on_drop(true)
                    .stdout(std::process::Stdio::null())
                    .spawn()?,
            )
        } else {
            eprintln!("native worker not built: racing two processes of this port only");
            None
        };
        let mut started = 0;
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        while started < 12 && std::time::Instant::now() < deadline {
            match roulette
                .execute("7003", &Action::new(Operation::Start), None, None, None)
                .await
            {
                Ok(_) => started += 1,
                Err(error) if matches!(refused_code(&error), Some("spinning" | "busy")) => {}
                Err(error) => return Err(error.into()),
            }
            let _ = roulette.snapshot("7003").await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Let the last draw complete.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let _ = roulette.snapshot("7003").await;
        std::fs::write(&stop, b"stop")?;
        let status = tokio::time::timeout(Duration::from_secs(60), child.wait()).await??;
        if let Some(native) = native.as_mut() {
            native.kill().await?;
        }
        let _ = std::fs::remove_file(&stop);
        assert!(status.success(), "child completion loop failed");
        assert!(started >= 3, "only {started} draws started");
        let loaded = roulette.read("7003").await?.context("doc")?;
        let history = loaded.state.history.len();
        assert_eq!(
            history, started,
            "every started draw completed exactly once"
        );
        let left: usize = loaded.state.roulettes[0]
            .items
            .iter()
            .map(|i| i.copies.len())
            .sum();
        assert_eq!(
            left,
            copies as usize - started,
            "one copy removed per completed draw"
        );
        assert_eq!(loaded.state.roulettes[0].order.len(), left);
        let ids: std::collections::HashSet<_> =
            loaded.state.history.iter().map(|h| h.id.clone()).collect();
        assert_eq!(ids.len(), history, "no draw recorded twice");
        Ok(())
    })
    .await
}

struct Counter {
    runs: Mutex<Vec<String>>,
    pause: Duration,
}

impl WinnerActionRunner for Counter {
    fn run<'a>(
        &'a self,
        _channel: &'a str,
        job: &'a WinnerAction,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.runs.lock().unwrap().push(job.draw_id.clone());
            tokio::time::sleep(self.pause).await;
            Ok(())
        })
    }
}

/// Two action loops (the cron restarted beside a slow old one) claim the same due actions:
/// each action runs once and ends `done`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_action_loops_run_each_action_once() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(1_794_355_200_000);
        let roulette = service(
            &mongo,
            Arc::new(clock.clone()),
            Arc::new(SeededRandom::new(13)),
        );
        wheel(&roulette, "7004", 20, "$(user)").await?;
        for _ in 0..6 {
            roulette
                .execute("7004", &Action::new(Operation::Start), None, None, None)
                .await?;
            clock.advance(1_500);
        }
        let counter = Arc::new(Counter {
            runs: Mutex::new(Vec::new()),
            pause: Duration::from_millis(20),
        });
        let rounds = Arc::new(AtomicUsize::new(0));
        let mut loops = Vec::new();
        for _ in 0..3 {
            let roulette = roulette.clone();
            let counter = counter.clone();
            let rounds = rounds.clone();
            loops.push(tokio::spawn(async move {
                for _ in 0..12 {
                    roulette.run_due_actions(counter.as_ref()).await?;
                    rounds.fetch_add(1, Ordering::SeqCst);
                }
                Ok::<_, ServiceError>(())
            }));
        }
        for task in loops {
            task.await??;
        }
        let runs = counter.runs.lock().unwrap().clone();
        let unique: std::collections::HashSet<_> = runs.iter().collect();
        assert_eq!(runs.len(), 6, "every draw's action ran: {runs:?}");
        assert_eq!(unique.len(), 6, "none twice");
        let loaded = roulette.read("7004").await?.context("doc")?;
        assert!(loaded.actions.iter().all(|a| a.status == "done"));
        let stored = mongo
            .documents("roulette_channels")
            .find_one(doc! {"_id": "7004"})
            .await?
            .context("doc")?;
        assert_eq!(stored.get("actionDueAt"), Some(&bson::Bson::Null));
        Ok(())
    })
    .await
}

/// Many first uses of a new channel at once create one document.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_first_loads_create_one_document() -> Result<()> {
    with_database(|mongo, _| async move {
        let roulette = service(
            &mongo,
            Arc::new(ManualClock::new(0)),
            Arc::new(SeededRandom::new(1)),
        );
        let loads: Vec<_> = (0..10)
            .map(|_| {
                let r = roulette.clone();
                tokio::spawn(async move { r.load("7005").await })
            })
            .collect();
        for load in loads {
            assert_eq!(load.await??.revision, 0.0);
        }
        assert_eq!(
            mongo
                .documents("roulette_channels")
                .count_documents(doc! {})
                .await?,
            1
        );
        Ok(())
    })
    .await
}
