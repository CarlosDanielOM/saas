//! AST timers against the local stores and the TypeScript's recordings
//! (`reference/record_timers.mts`, `fixtures/timers_recorded.json`): a job Rust writes is the
//! TypeScript's job byte for byte (payload, index scores, expiries); a job the TypeScript wrote is
//! claimed and run by Rust's scheduler with the same posts and the same nested jobs; the claim is
//! at most once across two processes; the per-channel limit; a timer's command runs as a message
//! of its own; and the one-off carry from the TypeScript's database at the cutover.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use dima_actions::delivery::RenderInput;
use dima_actions::runner::{
    CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_actions::timers::{self, SchedulerConfig, TimerJob, TimerScheduler};
use dima_engine::eval::{Engine, EvalLimits, LimitKind, PerPlan};
use dima_engine::registry::Registry;
use dima_engine::value::Value;
use serde_json::json;
use std::sync::Arc;
use support::*;

const FIXTURE: &str = include_str!("fixtures/timers_recorded.json");
const CHANNEL: &str = "1001";

fn event() -> Value {
    Value::from(json!({
        "broadcaster_user_id": CHANNEL, "broadcaster_user_login": "streamer", "broadcaster_user_name": "Streamer",
        "chatter_user_id": "5001", "chatter_user_login": "viewerone", "chatter_user_name": "ViewerOne", "message_id": "chat-1",
        "badges": [], "message": { "text": "!x uno dos tres", "fragments": [] },
    }))
}

fn input() -> RenderInput {
    RenderInput {
        event_data: event(),
        argument: Some("uno dos tres".into()),
        literal_arguments: true,
        ..RenderInput::new(CHANNEL)
    }
}

async fn pending(stores: &Stores) -> Result<Vec<(String, f64)>> {
    Ok(stores
        .dragonfly
        .zrange_with_scores(&stores.key(timers::AST_TIMER_INDEX), 0, -1)
        .await?
        .into_iter()
        .map(|(member, score)| (String::from_utf8(member).unwrap(), score))
        .collect())
}

async fn clear_timers(stores: &Stores) -> Result<()> {
    for key in keys_matching(stores, "ast:timers:*").await? {
        stores.dragonfly.del(&[&stores.key(&key)]).await?;
    }
    Ok(())
}

async fn setup(stores: &Stores) -> Result<(TwitchMock, Process, Arc<Reseedable>)> {
    insert_user(stores, CHANNEL, "streamer", "premium").await?;
    insert_command(stores, command_document(CHANNEL, "ref", "from ref")).await?;
    let twitch = TwitchMock::start().await?;
    let random = Reseedable::new(0);
    let process = process(stores, &twitch, random.clone())?;
    Ok((twitch, process, random))
}

fn scheduler(process: &Process) -> TimerScheduler {
    TimerScheduler::new(Arc::clone(&process.delivery), SchedulerConfig::default())
}

/// Writes a job as the TypeScript's `ENQUEUE` leaves it, under the test's prefix.
async fn put_job(stores: &Stores, payload: &str) -> Result<TimerJob> {
    let job = TimerJob::from_json(payload)?;
    stores
        .dragonfly
        .set(
            &stores.key(&format!("ast:timers:job:{}", job.id)),
            payload.as_bytes(),
            Default::default(),
        )
        .await?;
    stores
        .dragonfly
        .zadd(
            &stores.key(timers::AST_TIMER_INDEX),
            &[(job.due_at as f64, job.id.as_bytes())],
        )
        .await?;
    stores
        .dragonfly
        .zadd(
            &stores.key(&format!(
                "ast:timers:channel:{}",
                job.context.broadcaster_id
            )),
            &[(job.expires_at as f64, job.id.as_bytes())],
        )
        .await?;
    Ok(job)
}

#[test]
fn rust_writes_and_runs_the_typescript_jobs() -> Result<()> {
    run(with_stores(|stores| async move {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE)?;
        let now = fixture["nowMs"].as_i64().unwrap();
        let (twitch, process, random) = setup(&stores).await?;
        let scheduler = scheduler(&process);
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            // Scheduling: the same job, byte for byte.
            clear_timers(&stores).await?;
            process.clock.set(now);
            random.reseed(case["seed"].as_u64().unwrap());
            let before = twitch.posts().len();
            let output = process
                .delivery
                .render(case["text"].as_str().unwrap(), input())
                .await?;
            process
                .delivery
                .deliver_message(CHANNEL, output.into(), true)
                .await?;
            let posted: Vec<String> = twitch
                .posts()
                .into_iter()
                .skip(before)
                .map(|p| p.text)
                .collect();
            assert_eq!(
                json!(posted),
                case["scheduled"],
                "{name}: posts while scheduling"
            );
            let jobs = case["jobs"].as_array().unwrap();
            let ids = pending(&stores).await?;
            assert_eq!(ids.len(), jobs.len(), "{name}");
            for (job, (id, score)) in jobs.iter().zip(&ids) {
                assert_eq!(id, job["id"].as_str().unwrap(), "{name}: job id");
                let payload = stores
                    .dragonfly
                    .get_text(&stores.key(&format!("ast:timers:job:{id}")))
                    .await?
                    .unwrap();
                assert_eq!(payload, job["payload"].as_str().unwrap(), "{name}: payload");
                assert_eq!(json!(*score as i64), job["pending"], "{name}: due score");
                let by_channel = stores
                    .dragonfly
                    .zrange_with_scores(&stores.key("ast:timers:channel:1001"), 0, -1)
                    .await?;
                assert_eq!(
                    json!(by_channel[0].1 as i64),
                    job["byChannel"],
                    "{name}: expiry score"
                );
            }
            let expiry: i64 = stores
                .dragonfly
                .query(redis::cmd("PEXPIRETIME").arg(stores.key("ast:timers:channel:1001")))
                .await?;
            assert_eq!(
                json!(expiry),
                case["channelExpiry"],
                "{name}: channel index expiry"
            );

            // Running: the TypeScript's own job, claimed and run by Rust.
            clear_timers(&stores).await?;
            let mut fired = Vec::new();
            for job in jobs {
                let job = put_job(&stores, job["payload"].as_str().unwrap()).await?;
                process.clock.set(job.due_at);
                let before = twitch.posts().len();
                let tick = scheduler.tick().await?;
                assert_eq!(tick.started, 1, "{name}");
                scheduler.drain().await;
                fired.push(
                    twitch
                        .posts()
                        .into_iter()
                        .skip(before)
                        .map(|p| p.text)
                        .collect::<Vec<_>>(),
                );
                process.clock.set(now);
            }
            assert_eq!(json!(fired), case["fired"], "{name}: posts when fired");
            let mut nested = Vec::new();
            for (id, _) in pending(&stores).await? {
                nested.push(
                    stores
                        .dragonfly
                        .get_text(&stores.key(&format!("ast:timers:job:{id}")))
                        .await?
                        .unwrap(),
                );
            }
            assert_eq!(
                json!(nested),
                case["nested"],
                "{name}: timers the job scheduled"
            );
        }
        assert!(twitch.unexpected().is_empty());
        Ok(())
    }))
}

#[test]
fn two_processes_claim_a_due_timer_once() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, bot, random) = setup(&stores).await?;
        let twitch_two = twitch.clone();
        let other = process(&stores, &twitch_two, seeded(77))?;
        random.reseed(5);
        for round in 0..10 {
            bot.clock.set(NOW_MS);
            let output = bot
                .delivery
                .render(&format!("$(timer 1 fired {round})"), input())
                .await?;
            assert!(output.text.is_empty());
            let due = NOW_MS + 1_000;
            bot.clock.set(due);
            other.clock.set(due);
            let (one, two) = (scheduler(&bot), scheduler(&other));
            let before = twitch.posts().len();
            let (a, b) = tokio::join!(one.tick(), two.tick());
            a?;
            b?;
            one.drain().await;
            two.drain().await;
            let posted: Vec<String> = twitch
                .posts()
                .into_iter()
                .skip(before)
                .map(|p| p.text)
                .collect();
            assert_eq!(posted, [format!("fired {round}")], "round {round}");
            assert!(pending(&stores).await?.is_empty());
        }
        Ok(())
    }))
}

#[test]
fn a_channel_holds_at_most_a_hundred_pending_timers_and_expired_ones_never_run() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process, _) = setup(&stores).await?;
        process.clock.set(NOW_MS);
        for _ in 0..100 {
            let output = process.delivery.render("$(timer 60 late)", input()).await?;
            assert_eq!(output.text, "");
        }
        let output = process.delivery.render("$(timer 60 late)", input()).await?;
        assert_eq!(output.text, "timer: could not schedule timer");
        assert_eq!(pending(&stores).await?.len(), 100);
        // Past the grace: claimed and dropped without running.
        process
            .clock
            .set(NOW_MS + 60_000 + timers::TIMER_GRACE_MS + 1);
        let scheduler = scheduler(&process);
        scheduler.tick().await?;
        scheduler.drain().await;
        assert!(twitch.posts().is_empty());
        assert!(pending(&stores).await?.is_empty());
        Ok(())
    }))
}

/// The command and its references use most of the message's budget; the timer it scheduled
/// runs later as a message of its own, with a fresh budget, and completes.
#[test]
fn a_timer_runs_as_a_message_of_its_own() -> Result<()> {
    run(with_stores(|stores| async move {
        let heavy = "*(for #i = 0; #i < 40; #i++ { %(#x #i) })";
        let limits = EvalLimits {
            host_calls: PerPlan::all(119),
            message_factor: 2,
            ..EvalLimits::default()
        };
        let engine = Engine::new(Registry::standard(), Default::default()).with_limits(limits);
        insert_user(&stores, CHANNEL, "streamer", "pro").await?;
        insert_command(
            &stores,
            command_document(CHANNEL, "heavy", &format!("{heavy}heavy done")),
        )
        .await?;
        insert_command(
            &stores,
            command_document(
                CHANNEL,
                "top",
                &format!("$(timer 1 {heavy}timer done) #(heavy) #(heavy) #(heavy)"),
            ),
        )
        .await?;
        let twitch = TwitchMock::start().await?;
        let process = process_with(&stores, &twitch, seeded(21), engine)?;
        process.clock.set(NOW_MS);
        let request = CommandRequest {
            channel_id: CHANNEL.into(),
            event_data: event(),
            name: "top".into(),
            argument: Some(String::new()),
            authorization: Some(ExecutionAuthorization {
                origin: ExecutionOrigin::Authored,
                identity: dima_engine::permissions::create_broadcaster_identity(),
            }),
            reference: None,
            effect: None,
        };
        let CommandOutcome::Ran(ran) = process.delivery.command_handler(request).await? else {
            panic!("ran")
        };
        process
            .delivery
            .deliver_message(
                CHANNEL,
                dima_actions::delivery::AstMessage {
                    text: ran.message,
                    references: ran.references,
                },
                true,
            )
            .await?;
        let marker = format!("[Parse error: {}]", LimitKind::HostCalls.message());
        let texts: Vec<String> = twitch.posts().into_iter().map(|p| p.text).collect();
        // The third reference ran out of the message's budget: nothing of it is left.
        assert_eq!(texts[..2], ["heavy done", "heavy done"]);
        assert!(texts[2].contains(&marker), "{texts:?}");
        process.clock.set(NOW_MS + 1_000);
        let scheduler = scheduler(&process);
        scheduler.tick().await?;
        scheduler.drain().await;
        let texts: Vec<String> = twitch.posts().into_iter().map(|p| p.text).collect();
        assert_eq!(
            texts.last().map(String::as_str),
            Some("timer done"),
            "{texts:?}"
        );
        Ok(())
    }))
}

/// The cutover's one-off step: the jobs the TypeScript left in its database (keys without
/// prefix, logical database 8 here) move into the Rust database unchanged and run there.
#[test]
fn pending_typescript_jobs_are_carried_at_the_cutover() -> Result<()> {
    run(with_stores(|stores| async move {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE)?;
        let (twitch, process, _) = setup(&stores).await?;
        let Some(source) = connect_dragonfly(8).await? else {
            return Ok(());
        };
        let case = &fixture["cases"][0];
        let payload = case["jobs"][0]["payload"].as_str().unwrap();
        let job = TimerJob::from_json(payload)?;
        let keys = [
            format!("ast:timers:job:{}", job.id),
            "ast:timers:pending".to_owned(),
            format!("ast:timers:channel:{}", job.context.broadcaster_id),
        ];
        let outcome = async {
            source
                .set(&keys[0], payload.as_bytes(), Default::default())
                .await?;
            source
                .zadd(&keys[1], &[(job.due_at as f64, job.id.as_bytes())])
                .await?;
            source
                .zadd(&keys[2], &[(job.expires_at as f64, job.id.as_bytes())])
                .await?;
            process.clock.set(job.due_at - 5_000);
            let carried = timers::carry(&source, &process.deps).await?;
            assert_eq!((carried.moved, carried.refused, carried.dropped), (1, 0, 0));
            assert_eq!(source.exists(&[&keys[0], &keys[1], &keys[2]]).await?, 0);
            let moved = stores
                .dragonfly
                .get_text(&stores.key(&keys[0]))
                .await?
                .unwrap();
            assert_eq!(moved, payload, "the carried bytes");
            process.clock.set(job.due_at);
            let scheduler = scheduler(&process);
            scheduler.tick().await?;
            scheduler.drain().await;
            let texts: Vec<String> = twitch.posts().into_iter().map(|p| p.text).collect();
            assert_eq!(json!([texts]), case["fired"]);
            anyhow::Ok(())
        }
        .await;
        source.del(&[&keys[0], &keys[1], &keys[2]]).await?;
        outcome
    }))
}
