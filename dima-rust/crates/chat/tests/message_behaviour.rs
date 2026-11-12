//! The message handler's order around moderation, two messages of one command at the same
//! moment (one process and two), and the bounds on messages in flight, against the local stores.
//! The "stops here" cases of the module documentation are also replayed against the reference in
//! `message_recorded.rs` (shared chat, the bot, no account, the subscription off, moderation,
//! timers refused, the AI off, not found, disabled, permission, both cooldowns, a thrown built-in).
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod message_support;

use anyhow::Result;
use bson::Bson;
use dima_chat::message::MessageConfig;
use dima_chat::message::seams::ModerationVerdict;
use message_support::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const VIEWER: (&str, &str) = ("5001", "viewerone");
const VIEWER2: (&str, &str) = ("5002", "viewertwo");

fn gated(channel: &str, verdict: ModerationVerdict) -> (Seams, Arc<Semaphore>) {
    let gate = Arc::new(Semaphore::new(0));
    (
        Seams {
            moderation: verdict,
            moderation_gate: Some((channel.to_owned(), Arc::clone(&gate))),
            ..Seams::default()
        },
        gate,
    )
}

async fn history_len(stores: &Stores, channel: &str) -> Result<usize> {
    let mut command = redis::cmd("LLEN");
    command.arg(stores.key(&format!("twitch:{channel}:chat:history")));
    Ok(stores.dragonfly.query::<usize>(&command).await?)
}

#[test]
fn moderation_runs_after_the_history_and_before_keywords_and_commands() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let channel = "990080001";
        seed_channel(&stores, channel, "free", true).await?;
        seed_command(&stores, channel, "hola", "Hola $(user)", 0).await?;
        let (seams, gate) = gated(channel, ModerationVerdict::Pass);
        let process = process(&stores, &twitch, seeded(1), seams, test_config(), "pass")?;
        let event = chat_event(channel, VIEWER, "!hola");
        let handler = process.handler.clone();
        let running = tokio::spawn(async move {
            handler
                .handle_notification(notification(&event, "2030-01-01T09:30:00.123Z"))
                .await
        });
        eventually("moderation is asked", || {
            process.calls.count("moderation") == 1
        })
        .await?;
        // Held in moderation: the history, the site counter and the embedding happened, nothing else.
        assert_eq!(history_len(&stores, channel).await?, 1);
        assert_eq!(process.calls.count("embedding"), 1);
        assert!(twitch.posts().is_empty());
        assert_eq!(process.calls.count("product.command"), 0);
        gate.add_permits(1);
        running.await??;
        assert_eq!(twitch.posts().len(), 1);
        assert_eq!(process.calls.count("product.command"), 1);

        // An action taken stops the message: no command, no product event, no reply.
        let (seams, gate) = gated(channel, ModerationVerdict::ActionTaken);
        let moderated = self::process(&stores, &twitch, seeded(2), seams, test_config(), "action")?;
        gate.add_permits(1);
        moderated
            .handler
            .handle_notification(notification(
                &chat_event(channel, VIEWER2, "!hola"),
                "2030-01-01T09:30:00.123Z",
            ))
            .await?;
        assert_eq!(moderated.calls.count("moderation"), 1);
        assert_eq!(moderated.calls.count("product.command"), 0);
        assert_eq!(twitch.posts().len(), 1, "nothing more was posted");
        assert_eq!(
            history_len(&stores, channel).await?,
            2,
            "the history has it"
        );
        Ok(())
    }))
}

#[test]
fn two_messages_at_once_respect_the_cooldown_once() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let channel = "990080002";
        seed_channel(&stores, channel, "free", true).await?;
        let id = seed_command(
            &stores,
            channel,
            "hola",
            "Hola $(user), van $(count 1) saludos",
            30,
        )
        .await?;
        // Two bot processes on the same stores, one message each, at the same moment.
        let first = process(
            &stores,
            &twitch,
            seeded(1),
            Seams::default(),
            test_config(),
            "p1",
        )?;
        let second = process(
            &stores,
            &twitch,
            seeded(2),
            Seams::default(),
            test_config(),
            "p2",
        )?;
        let at = "2030-01-01T09:30:00.123Z";
        let (a, b) = tokio::join!(
            first
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER, "!hola"), at)),
            second
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER2, "!hola"), at)),
        );
        a?;
        b?;
        assert_eq!(twitch.posts().len(), 1, "the shared gate lets one run");
        assert_eq!(
            count_of(&stores, id).await?,
            Some(Bson::Int32(1)),
            "counted once: only one ran"
        );
        // And within one process, two at once: the local cooldown is not set yet, the gate decides.
        let channel = "990080003";
        seed_channel(&stores, channel, "free", true).await?;
        let id = seed_command(&stores, channel, "hola", "Van $(count 1)", 30).await?;
        let (a, b) = tokio::join!(
            first
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER, "!hola"), at)),
            first
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER2, "!hola"), at)),
        );
        a?;
        b?;
        let posts: Vec<_> = twitch
            .posts()
            .into_iter()
            .filter(|p| p.channel == channel)
            .collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(count_of(&stores, id).await?, Some(Bson::Int32(1)));
        // The process now remembers the cooldown: a third message stops before the lookup.
        first
            .handler
            .handle_notification(notification(&chat_event(channel, VIEWER, "!hola"), at))
            .await?;
        assert_eq!(
            twitch
                .posts()
                .into_iter()
                .filter(|p| p.channel == channel)
                .count(),
            1
        );
        Ok(())
    }))
}

#[test]
fn two_messages_at_once_without_a_cooldown_both_count() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let channel = "990080004";
        seed_channel(&stores, channel, "free", true).await?;
        let id = seed_command(&stores, channel, "hola", "Van $(count 1)", 0).await?;
        let first = process(
            &stores,
            &twitch,
            seeded(1),
            Seams::default(),
            test_config(),
            "p1",
        )?;
        let second = process(
            &stores,
            &twitch,
            seeded(2),
            Seams::default(),
            test_config(),
            "p2",
        )?;
        let at = "2030-01-01T09:30:00.123Z";
        let (a, b) = tokio::join!(
            first
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER, "!hola"), at)),
            second
                .handler
                .handle_notification(notification(&chat_event(channel, VIEWER2, "!hola"), at)),
        );
        a?;
        b?;
        assert_eq!(twitch.posts().len(), 2, "both ran");
        // The reference stores each run's total with `$set`, so one of two runs at once is lost;
        // the count is incremented by each run here.
        assert_eq!(count_of(&stores, id).await?, Some(Bson::Int32(2)));
        Ok(())
    }))
}

fn limits(
    per_channel: usize,
    per_channel_waiting: usize,
    total: usize,
    total_waiting: usize,
) -> MessageConfig {
    MessageConfig {
        per_channel_in_flight: per_channel,
        per_channel_waiting,
        total_in_flight: total,
        total_waiting,
        ..test_config()
    }
}

#[test]
fn a_busy_channel_holds_up_only_itself_and_overflows_with_a_count() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let (busy, other) = ("990080005", "990080006");
        for channel in [busy, other] {
            seed_channel(&stores, channel, "free", true).await?;
            seed_command(&stores, channel, "hola", "Hola $(user)", 0).await?;
        }
        let (seams, gate) = gated(busy, ModerationVerdict::Pass);
        let process = process(
            &stores,
            &twitch,
            seeded(1),
            seams,
            limits(1, 1, 16, 16),
            "busy",
        )?;
        let at = "2030-01-01T09:30:00.123Z";
        let spawn = |channel: &'static str, who: (&'static str, &'static str)| {
            let handler = process.handler.clone();
            let event = chat_event(channel, who, "!hola");
            tokio::spawn(async move { handler.handle_notification(notification(&event, at)).await })
        };
        let held = spawn(busy, VIEWER);
        eventually("the first message is in moderation", || {
            process.calls.count("moderation") == 1
        })
        .await?;
        let waiting = spawn(busy, VIEWER2);
        eventually("the second waits for its place", || {
            process.handler.admission().stats().waiting == 1
        })
        .await?;
        // The third finds the channel's queue full: dropped and counted, at once.
        process
            .handler
            .handle_notification(notification(&chat_event(busy, VIEWER, "!hola"), at))
            .await?;
        assert_eq!(process.handler.admission().stats().channel_queue_full, 1);
        // Another channel is not held up.
        process
            .handler
            .handle_notification(notification(&chat_event(other, VIEWER, "!hola"), at))
            .await?;
        assert_eq!(
            twitch.posts().iter().filter(|p| p.channel == other).count(),
            1
        );
        assert!(twitch.posts().iter().all(|p| p.channel != busy));
        gate.add_permits(2);
        held.await??;
        waiting.await??;
        assert_eq!(
            twitch.posts().iter().filter(|p| p.channel == busy).count(),
            2
        );
        let stats = process.handler.admission().stats();
        assert_eq!(
            (
                stats.admitted,
                stats.in_flight,
                stats.waiting,
                stats.channels
            ),
            (3, 0, 0, 0)
        );
        Ok(())
    }))
}

#[test]
fn the_total_bound_holds_across_channels() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let channels = ["990080007", "990080008", "990080009"];
        for channel in channels {
            seed_channel(&stores, channel, "free", false).await?;
        }
        let (seams, gate) = gated(channels[0], ModerationVerdict::Pass);
        let process = process(
            &stores,
            &twitch,
            seeded(1),
            seams,
            limits(4, 4, 1, 1),
            "total",
        )?;
        let at = "2030-01-01T09:30:00.123Z";
        let handler = process.handler.clone();
        let first = tokio::spawn({
            let event = chat_event(channels[0], VIEWER, "hola");
            async move { handler.handle_notification(notification(&event, at)).await }
        });
        eventually("the first message is in moderation", || {
            process.calls.count("moderation") == 1
        })
        .await?;
        let handler = process.handler.clone();
        let second = tokio::spawn({
            let event = chat_event(channels[1], VIEWER, "hola");
            async move { handler.handle_notification(notification(&event, at)).await }
        });
        eventually("the second waits", || {
            process.handler.admission().stats().waiting == 1
        })
        .await?;
        process
            .handler
            .handle_notification(notification(&chat_event(channels[2], VIEWER, "hola"), at))
            .await?;
        assert_eq!(process.handler.admission().stats().queue_full, 1);
        gate.add_permits(1);
        first.await??;
        second.await??;
        assert_eq!(
            process.calls.count("moderation"),
            2,
            "the dropped message never ran"
        );
        Ok(())
    }))
}

#[test]
fn a_message_that_waits_or_runs_too_long_is_dropped_and_counted() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let channel = "990080010";
        seed_channel(&stores, channel, "free", false).await?;
        let (seams, _gate) = gated(channel, ModerationVerdict::Pass);
        let config = MessageConfig {
            per_channel_in_flight: 1,
            admission_wait: Duration::from_millis(300),
            message_deadline: Duration::from_millis(1_500),
            ..test_config()
        };
        let process = process(&stores, &twitch, seeded(1), seams, config, "deadline")?;
        let at = "2030-01-01T09:30:00.123Z";
        let handler = process.handler.clone();
        let held = tokio::spawn({
            let event = chat_event(channel, VIEWER, "hola");
            async move { handler.handle_notification(notification(&event, at)).await }
        });
        eventually("the first message is in moderation", || {
            process.calls.count("moderation") == 1
        })
        .await?;
        // The second cannot get a place in time.
        process
            .handler
            .handle_notification(notification(&chat_event(channel, VIEWER2, "hola"), at))
            .await?;
        assert_eq!(process.handler.admission().stats().waited_too_long, 1);
        // The first is stopped at its deadline (moderation never answers).
        held.await??;
        let stats = process.handler.admission().stats();
        assert_eq!(
            (stats.timed_out, stats.in_flight, stats.channels),
            (1, 0, 0)
        );
        let metrics = process.message_metrics(&stores).await?;
        assert_eq!(
            metrics,
            serde_json::json!({"started": 1, "ended": 1, "failed": 1})
        );
        Ok(())
    }))
}
