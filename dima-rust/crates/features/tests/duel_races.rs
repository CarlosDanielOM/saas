//! Races and kills around a duel.
//!
//! - An accept raced by other accepts: one run, one `started`.
//! - Two completion loops on one finished fight, the second one after the first one's lease
//!   expired while it hung on Twitch: the announcement, the timeout and the result happen once.
//! - Kills at every Twitch call of a losing moderator's timeout and of the restore (the tick is
//!   dropped while the call hangs, which is what a killed process leaves), and one real process
//!   killed (SIGKILL) after the demotion: no path ends with the moderator demoted and no restore
//!   recorded; the restore loop gives the role back; the timeout is sent at most once.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "duel_support/mod.rs"]
mod duel_support;
#[path = "roulette_support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bson::doc;
use dima_core::{ManualClock, SeededRandom};
use dima_features::duel::{DuelCompletion, DuelService};
use duel_support::Fakes;
use serde_json::{Value, json};
use support::with_database;

const CHANNEL: &str = "4001";
const START: i64 = 1_794_355_200_000;

/// A chat duel `alice` (500) against `bob` (501), accepted, with the clock at its end.
async fn finished_fight(
    service: &DuelService,
    clock: &ManualClock,
) -> Result<dima_features::duel::DuelRun> {
    service.challenge(CHANNEL, "alice", "bob", None).await?;
    let run = service.accept(CHANNEL, "bob").await?;
    clock.set(run.ends_at as i64);
    Ok(run)
}

fn calls_of(fakes: &Fakes, kind: &str) -> usize {
    fakes
        .shared
        .state
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|c| c[0] == kind)
        .count()
}

async fn wait_for_call(fakes: &Fakes, kind: &str) -> Result<()> {
    for _ in 0..2_000 {
        if calls_of(fakes, kind) > 0 {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    anyhow::bail!("{kind} never called")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_accept_raced_by_accepts_makes_one_run() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(START);
        let fakes = Fakes::new(mongo.clone());
        let service = fakes.service(&mongo, &clock, Arc::new(SeededRandom::new(1)));
        service.challenge(CHANNEL, "alice", "bob", None).await?;
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let s = service.clone();
                tokio::spawn(async move { s.accept(CHANNEL, "bob").await })
            })
            .collect();
        let mut runs = 0;
        for task in tasks {
            match task.await? {
                Ok(_) => runs += 1,
                Err(error) => assert!(
                    matches!(
                        error.refused().map(|e| e.code.as_str()),
                        Some("busy" | "missing")
                    ),
                    "{error}"
                ),
            }
        }
        assert_eq!(runs, 1);
        assert_eq!(calls_of(&fakes, "event"), 1);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_loops_settle_a_fight_once() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(START);
        let fakes = Fakes::new(mongo.clone());
        let service = fakes.service(&mongo, &clock, Arc::new(SeededRandom::new(2)));
        finished_fight(&service, &clock).await?;
        fakes.prepare(&json!({"users": {"alice": "500", "bob": "501"}}));
        fakes.shared.state.lock().unwrap().hang = Some("chat".into());
        // The first loop hangs on the announcement while holding the lease.
        let first = DuelCompletion::new(
            service.clone(),
            fakes.chat.clone(),
            fakes.moderation.clone(),
        );
        let hung = tokio::spawn(async move { first.tick().await });
        wait_for_call(&fakes, "chat").await?;
        // The lease expires; a second loop takes the channel over.
        fakes.shared.state.lock().unwrap().hang = None;
        clock.advance(31_000);
        let second = DuelCompletion::new(
            service.clone(),
            fakes.chat.clone(),
            fakes.moderation.clone(),
        );
        second.tick().await?;
        second.tick().await?;
        hung.abort();
        let _ = hung.await;
        let doc = service.read(CHANNEL).await?.context("doc")?;
        let run = doc.run.context("run")?;
        assert!(run.completed_at.is_some());
        assert_eq!(calls_of(&fakes, "chat"), 1, "announced once");
        assert_eq!(calls_of(&fakes, "ban"), 1, "timed out once");
        assert_eq!(
            calls_of(&fakes, "event"),
            1,
            "ended once (the log was reset after the start)"
        );
        Ok(())
    })
    .await
}

/// The fight's loser (`alice`, a moderator) and the tick killed while `step` hangs; then the
/// loops run on and the role must come back.
async fn killed_at(step: &str) -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(START);
        let fakes = Fakes::new(mongo.clone());
        let service = fakes.service(&mongo, &clock, Arc::new(SeededRandom::new(4)));
        let run = finished_fight(&service, &clock).await?;
        let (loser, loser_id) = if run.winner == "left" {
            ("bob", "501")
        } else {
            ("alice", "500")
        };
        fakes.prepare(&json!({"users": {"alice": "500", "bob": "501"}, "mods": ["500", "501"]}));
        let completion = DuelCompletion::new(
            service.clone(),
            fakes.chat.clone(),
            fakes.moderation.clone(),
        );
        if step == "add" {
            // Let the timeout go through, then hang the re-mod.
            completion.tick().await?;
            clock.advance(run.timeout_seconds as i64 * 1000 + 31_000);
        }
        fakes.shared.state.lock().unwrap().hang = Some(step.into());
        let killed = {
            let c = completion.clone();
            tokio::spawn(async move { c.tick().await })
        };
        wait_for_call(&fakes, step).await?;
        killed.abort();
        let _ = killed.await;
        fakes.shared.state.lock().unwrap().hang = None;
        let demoted = !fakes.mods().contains(&loser_id.to_owned());
        let rows = mongo
            .documents("duel_moderator_restores")
            .count_documents(doc! {})
            .await?;
        assert!(
            !demoted || rows == 1,
            "{step}: {loser} demoted with no restore recorded"
        );
        // The loops run on: within the restore's deadline plus a lease the role is back.
        for _ in 0..6 {
            clock.advance(run.timeout_seconds as i64 * 1000 + 31_000);
            completion.tick().await?;
        }
        assert!(
            fakes.mods().contains(&loser_id.to_owned()),
            "{step}: {loser} is a moderator again"
        );
        assert_eq!(
            mongo
                .documents("duel_moderator_restores")
                .count_documents(doc! {})
                .await?,
            0,
            "{step}: restore finished"
        );
        let bans = calls_of(&fakes, "ban");
        assert!(bans <= 1, "{step}: timed out {bans} times");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_before_the_restore_is_recorded() -> Result<()> {
    killed_at("moderators").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_during_the_demotion() -> Result<()> {
    killed_at("remove").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_during_the_timeout() -> Result<()> {
    killed_at("ban").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_during_the_re_mod() -> Result<()> {
    killed_at("add").await
}

/// Child mode of [`a_killed_process_leaves_a_restore_the_next_one_applies`].
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_duel_tick() -> Result<()> {
    let Ok(database) = std::env::var("DIMA_DUEL_KILL_CHILD") else {
        return Ok(());
    };
    let mongo = support::connect(&database).await?.context("mongo")?;
    let now: i64 = std::env::var("DIMA_DUEL_KILL_NOW")?.parse()?;
    let clock = ManualClock::new(now);
    let fakes = Fakes::new(mongo.clone());
    fakes.prepare(&json!({"users": {"alice": "500", "bob": "501"}, "mods": ["500", "501"]}));
    {
        let mut state = fakes.shared.state.lock().unwrap();
        state.hang = Some("ban".into());
        state.persist = true;
    }
    let service = fakes.service(&mongo, &clock, Arc::new(SeededRandom::new(5)));
    DuelCompletion::new(service, fakes.chat.clone(), fakes.moderation.clone())
        .tick()
        .await?;
    anyhow::bail!("the tick should hang on the timeout until the process is killed")
}

/// A real process is killed (SIGKILL) after it demoted the losing moderator, while the timeout
/// is in flight. This process's loop then gives the role back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_killed_process_leaves_a_restore_the_next_one_applies() -> Result<()> {
    with_database(|mongo, database| async move {
        let clock = ManualClock::new(START);
        let fakes = Fakes::new(mongo.clone());
        let service = fakes.service(&mongo, &clock, Arc::new(SeededRandom::new(5)));
        let run = finished_fight(&service, &clock).await?;
        let loser_id = if run.winner == "left" { "501" } else { "500" };
        let mut child = tokio::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "child_duel_tick", "--nocapture"])
            .env("DIMA_DUEL_KILL_CHILD", &database)
            .env("DIMA_DUEL_KILL_NOW", clock_now(&clock).to_string())
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .spawn()?;
        // Wait until the child demoted the loser (it records that), then kill it.
        let mut demoted = false;
        for _ in 0..6_000 {
            if mongo
                .documents("fake_twitch")
                .count_documents(doc! {"_id": loser_id})
                .await?
                > 0
            {
                demoted = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(demoted, "the child demoted the loser");
        child.start_kill()?;
        let status = child.wait().await?;
        assert!(!status.success());
        assert_eq!(
            mongo
                .documents("duel_moderator_restores")
                .count_documents(doc! {})
                .await?,
            1,
            "a restore was recorded before the demotion"
        );
        // This process's loop: the fake Twitch knows the loser was demoted.
        let mods: Vec<Value> = ["500", "501"]
            .iter()
            .filter(|m| **m != loser_id)
            .map(|m| json!(m))
            .collect();
        fakes.prepare(&json!({"mods": mods}));
        let completion = DuelCompletion::new(
            service.clone(),
            fakes.chat.clone(),
            fakes.moderation.clone(),
        );
        for _ in 0..6 {
            clock.advance(run.timeout_seconds as i64 * 1000 + 31_000);
            completion.tick().await?;
        }
        assert!(fakes.mods().contains(&loser_id.to_owned()));
        assert_eq!(
            mongo
                .documents("duel_moderator_restores")
                .count_documents(doc! {})
                .await?,
            0
        );
        assert_eq!(
            calls_of(&fakes, "ban"),
            0,
            "the timeout claimed by the killed process is never sent again"
        );
        Ok(())
    })
    .await
}

fn clock_now(clock: &ManualClock) -> i64 {
    dima_core::Clock::now_ms(clock)
}

/// A timeout Twitch does not answer in time is reported as unknown, never retried, and the
/// moderator's restore is made due at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unanswered_timeout_is_reported_as_unknown() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(START);
        let fakes = Fakes::new(mongo.clone());
        let service = DuelService::new(
            mongo.clone(),
            Arc::new(clock.clone()),
            Arc::new(SeededRandom::new(6)),
            fakes.presence.clone(),
            fakes.events.clone(),
            dima_features::duel::DuelConfig {
                deadline: Duration::from_secs(60),
                twitch_deadline: Duration::from_millis(300),
                bot_id: dima_twitch::TWITCH_BOT_ACCOUNT_ID.into(),
            },
        );
        let run = finished_fight(&service, &clock).await?;
        fakes.prepare(&json!({"users": {"alice": "500", "bob": "501"}, "mods": ["500", "501"]}));
        fakes.shared.state.lock().unwrap().hang = Some("ban".into());
        let completion = DuelCompletion::new(
            service.clone(),
            fakes.chat.clone(),
            fakes.moderation.clone(),
        );
        let report = completion.tick().await?;
        let stored = service
            .read(CHANNEL)
            .await?
            .context("doc")?
            .run
            .context("run")?;
        assert_eq!(
            stored.timeout_error.as_deref(),
            Some("Timeout outcome unknown: Twitch did not answer in time")
        );
        assert!(report.errors.iter().any(|e| e.contains("outcome unknown")));
        fakes.shared.state.lock().unwrap().hang = None;
        completion.tick().await?;
        assert_eq!(calls_of(&fakes, "ban"), 1, "never sent twice");
        let loser_id = if run.winner == "left" { "501" } else { "500" };
        assert!(
            fakes.mods().contains(&loser_id.to_owned()),
            "restored at once"
        );
        Ok(())
    })
    .await
}
