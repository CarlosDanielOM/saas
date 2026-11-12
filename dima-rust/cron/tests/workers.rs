//! The three projection workers in `dima-cron` processes against the local stores (each test its
//! own `dima_test_cron_<random>` database and key prefix in Dragonfly database 11, removed
//! afterwards): the work is seeded through the libraries, the binary runs it, and the result is
//! read back.
//!
//! - Two processes started at once share the work and do each piece once: every event counted
//!   once, every summary and baseline written, every lease released.
//! - A process killed (SIGKILL) in the middle of a backlog leaves the libraries' checkpoint and
//!   lease; the next process finishes the backlog and nothing is counted twice.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::{Context, Result};
use bson::{DateTime, doc, oid::ObjectId};
use dima_core::{Clock, SystemClock};
use dima_store::dragonfly::Ttl;
use dima_stream::defense_baseline::{self, Baselines};
use dima_stream::raid_analytics::RaidAnalytics;
use dima_stream::stream_activity::{Activities, ActivityKind, Capture, Session};
use futures_util::{StreamExt, TryStreamExt};
use nix::sys::signal::Signal;
use std::sync::Arc;
use std::time::Duration;
use support::{Cron, Stores, eventually};

const CHANNEL: &str = "900000001";
const COMMAND: &str = "!dance";
const RAID_CHANNELS: [&str; 6] = [
    "900000011",
    "900000012",
    "900000013",
    "900000014",
    "900000015",
    "900000016",
];
const BASELINE_CHANNELS: [&str; 12] = [
    "900000021",
    "900000022",
    "900000023",
    "900000024",
    "900000025",
    "900000026",
    "900000027",
    "900000028",
    "900000029",
    "900000030",
    "900000031",
    "900000032",
];

fn clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}

/// `count` command activities of one session, as the bot captures them.
async fn seed_activities(stores: &Stores, count: usize) -> Result<()> {
    let activities = Activities::new(stores.mongo.clone(), clock(), Default::default())?;
    let now = SystemClock.now_ms();
    let session = Session {
        id: ObjectId::new(),
        started_at: DateTime::from_millis(now - 3_600_000),
    };
    futures_util::stream::iter(0..count)
        .map(|n| {
            let capture = Capture {
                channel_id: CHANNEL.to_owned(),
                event_id: format!("event-{n}"),
                kind: ActivityKind::Command,
                occurred_at: Some(DateTime::from_millis(now - 1_000_000 + n as i64)),
                session: Some(session.clone()),
                actor: format!("viewer{}", n % 7),
                actor_label: format!("Viewer {}", n % 7),
                key: COMMAND.to_owned(),
                label: COMMAND.to_owned(),
                value: None,
                outcome: None,
                emotes: Vec::new(),
            };
            let activities = activities.clone();
            async move { activities.capture_stream_activity(&capture).await }
        })
        .buffer_unordered(32)
        .try_collect::<Vec<()>>()
        .await?;
    Ok(())
}

async fn pending(stores: &Stores) -> Result<u64> {
    Ok(stores
        .mongo
        .documents("stream_activities")
        .count_documents(doc! { "processed": false })
        .await?)
}

/// The command's count in the session's rank aggregate.
async fn command_count(stores: &Stores) -> Result<f64> {
    let row = stores
        .mongo
        .documents("stream_activity_aggregates")
        .find_one(doc! { "channelID": CHANNEL, "scope": "rank", "kind": "command", "key": COMMAND })
        .await?
        .context("the command's rank aggregate")?;
    Ok(row.get_f64("count").or_else(|_| {
        row.get_i64("count")
            .map(|n| n as f64)
            .or_else(|_| row.get_i32("count").map(f64::from))
    })?)
}

/// Due summaries for each raid channel.
async fn seed_raids(stores: &Stores) -> Result<()> {
    let raids = RaidAnalytics::new(stores.mongo.clone(), clock(), clock(), Default::default())?;
    for channel in RAID_CHANNELS {
        raids.queue_raid_summary(channel).await?;
    }
    Ok(())
}

async fn raids_projected(stores: &Stores) -> Result<bool> {
    let projected = stores
        .mongo
        .documents("raid_analytics_summaries")
        .count_documents(doc! {
            "_id": { "$in": RAID_CHANNELS.to_vec() },
            "payload": { "$exists": true },
            "rustPending": false,
            "error": false,
        })
        .await?;
    Ok(projected == RAID_CHANNELS.len() as u64)
}

fn baselines(stores: &Stores) -> Baselines {
    Baselines::new(
        stores.mongo.clone(),
        stores.dragonfly.clone(),
        clock(),
        defense_baseline::Config {
            key_prefix: stores.prefix.clone(),
            ..Default::default()
        },
    )
}

/// A read of a missing baseline requests a refresh: each channel comes due now.
async fn seed_baselines(stores: &Stores) -> Result<()> {
    let baselines = baselines(stores);
    for channel in BASELINE_CHANNELS {
        assert!(baselines.get_defense_baseline(channel).await?.is_none());
    }
    Ok(())
}

async fn baselines_written(stores: &Stores) -> Result<bool> {
    for channel in BASELINE_CHANNELS {
        let key = format!("{}{}", stores.prefix, defense_baseline::key(channel));
        if stores.dragonfly.get(&key).await?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every channel refreshed has its value for seven days and is due again in an hour.
async fn check_baselines(stores: &Stores) -> Result<()> {
    let baselines = baselines(stores);
    let due_key = format!("{}{}", stores.prefix, defense_baseline::DUE);
    let now = SystemClock.now_ms() as f64;
    for channel in BASELINE_CHANNELS {
        let value = baselines
            .get_defense_baseline(channel)
            .await?
            .context("a fresh baseline")?;
        assert_eq!(
            value.attack_threshold, None,
            "sparse history publishes null"
        );
        let key = format!("{}{}", stores.prefix, defense_baseline::key(channel));
        assert!(matches!(
            stores.dragonfly.ttl(&key).await?,
            Ttl::Seconds(604_700..=604_800)
        ));
    }
    let due = stores.dragonfly.zrange_with_scores(&due_key, 0, -1).await?;
    assert_eq!(due.len(), BASELINE_CHANNELS.len());
    for (_, score) in due {
        assert!(
            score > now + 3_500_000.0,
            "due again within the hour: {score}"
        );
    }
    Ok(())
}

async fn leases_released(stores: &Stores) -> Result<()> {
    let state = stores
        .mongo
        .documents("stream_activity_states")
        .find_one(doc! { "_id": "projector-v1" })
        .await?
        .context("checkpoint")?;
    assert_eq!(
        state.get_datetime("leaseUntil")?.timestamp_millis(),
        0,
        "the stream activity lease is released"
    );
    assert!(state.get("active").is_none(), "no batch is left half done");
    let held = stores
        .mongo
        .documents("raid_analytics_summaries")
        .count_documents(doc! { "leaseUntil": { "$gt": DateTime::from_millis(0) } })
        .await?;
    assert_eq!(held, 0, "every raid lease is released");
    Ok(())
}

const WORKERS: &str = "stream-activity,raid-analytics,follow-defense-baseline";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_processes_started_at_once_do_each_piece_of_work_once() -> Result<()> {
    let Some(stores) = Stores::new().await? else {
        return Ok(());
    };
    let result = async {
        // Five batches of 500 for the two processes to share.
        let events = 2400;
        seed_activities(&stores, events).await?;
        seed_raids(&stores).await?;
        seed_baselines(&stores).await?;
        assert_eq!(pending(&stores).await?, events as u64);
        let env = stores.cron_env(WORKERS);
        let mut first = Cron::start(&env, &[])?;
        let mut second = Cron::start(&env, &[])?;
        for cron in [&first, &second] {
            cron.wait_line("ready", Duration::from_secs(40), |data| {
                data["step"] == "ready"
            })?;
        }
        eventually("every event projected", Duration::from_secs(60), || async {
            Ok(pending(&stores).await? == 0)
        })
        .await?;
        eventually(
            "every raid summary projected",
            Duration::from_secs(60),
            || async { raids_projected(&stores).await },
        )
        .await?;
        eventually(
            "every baseline written",
            Duration::from_secs(60),
            || async { baselines_written(&stores).await },
        )
        .await?;
        for cron in [&mut first, &mut second] {
            let status = cron.stop(Signal::SIGTERM, Duration::from_secs(25))?;
            assert_eq!(status, 0, "stderr {:?}", cron.stderr.lock().unwrap());
            let failures: Vec<_> = cron
                .json_lines()
                .into_iter()
                .filter(|line| {
                    line["data"]["message"].as_str().is_some_and(|text| {
                        text.contains("failed") || text.starts_with("Restarting")
                    })
                })
                .collect();
            assert!(failures.is_empty(), "{failures:#?}");
        }
        // Each event counted once, by whichever process projected its batch.
        assert_eq!(command_count(&stores).await?, events as f64);
        leases_released(&stores).await?;
        check_baselines(&stores).await?;
        Ok(())
    }
    .await;
    stores.clean().await?;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_process_killed_in_a_backlog_leaves_nothing_counted_twice() -> Result<()> {
    let Some(stores) = Stores::new().await? else {
        return Ok(());
    };
    let result = async {
        let events = 6000;
        seed_activities(&stores, events).await?;
        let env = stores.cron_env("stream-activity");
        let mut first = Cron::start(&env, &[])?;
        // Kill it once some of the backlog is projected and some is not.
        eventually(
            "part of the backlog projected",
            Duration::from_secs(60),
            || async { Ok(pending(&stores).await? < events as u64) },
        )
        .await?;
        nix::sys::signal::kill(first.pid(), Signal::SIGKILL)?;
        first.wait_exit(Duration::from_secs(10)).ok();
        let left = pending(&stores).await?;
        assert!(
            left > 0,
            "the backlog finished before the kill; raise the event count"
        );
        // The next process takes over once the dead one's lease (60 s) has expired, if it held
        // it, and finishes the backlog.
        let mut second = Cron::start(&env, &[])?;
        eventually("the rest projected", Duration::from_secs(120), || async {
            Ok(pending(&stores).await? == 0)
        })
        .await?;
        assert_eq!(second.stop(Signal::SIGTERM, Duration::from_secs(25))?, 0);
        assert_eq!(command_count(&stores).await?, events as f64);
        leases_released(&stores).await?;
        Ok(())
    }
    .await;
    stores.clean().await?;
    result
}
