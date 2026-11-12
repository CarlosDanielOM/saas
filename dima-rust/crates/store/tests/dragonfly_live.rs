//! Live checks against the local Dragonfly: connection policy (reconnect after a killed
//! connection, the response timeout, cancel-safe blocking pops), the subscriber (resubscribe
//! after reconnect, overflow, unsubscribe on drop, the JSON handler), `NOSCRIPT` fallback, the
//! typed reply helpers, the command hook, and what Dragonfly's Lua accepts.
//!
//! Logical database 10, a unique key prefix per test, everything deleted afterwards. Skipped
//! with a message when `DIMA_TEST_DRAGONFLY` is not set.

mod dragonfly_support;

use anyhow::{Context, Result, bail, ensure};
use dima_store::dragonfly::hooks::{
    CacheLookup, CommandHook, CommandOutcome, ConnectionError, ErrorHook,
};
use dima_store::dragonfly::pubsub::envelope;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, Event, Gap, Hooks, Overflow, QueueItem, Script, SetCondition,
    SetExpiry, SetOptions, SetOutcome, Subscription, Topic, Ttl,
};
use dragonfly_support::{cleanup, config, expect_message, prefix};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DB: u8 = 10;

#[derive(Default)]
struct Recorder {
    commands: Mutex<Vec<(String, CommandOutcome)>>,
    errors: Mutex<Vec<String>>,
}

impl CommandHook for Recorder {
    fn finished(&self, method: &'static str, _elapsed: Duration, outcome: CommandOutcome) {
        if let Ok(mut commands) = self.commands.lock() {
            commands.push((method.to_owned(), outcome));
        }
    }
}

impl ErrorHook for Recorder {
    fn connection_error(&self, error: &ConnectionError<'_>) {
        if let Ok(mut errors) = self.errors.lock() {
            errors.push(format!("{}:{}:{}", error.caller, error.code, error.error));
        }
    }
}

async fn connect_recorded(
    response_timeout: Option<Duration>,
) -> Result<Option<(Dragonfly, Arc<Recorder>)>> {
    let Some(mut config) = config(DB) else {
        return Ok(None);
    };
    if let Some(timeout) = response_timeout {
        config.response_timeout = timeout;
    }
    let recorder = Arc::new(Recorder::default());
    let hooks = Hooks {
        command: Some(recorder.clone()),
        errors: Some(recorder.clone()),
    };
    Ok(Some((Dragonfly::connect(config, hooks).await?, recorder)))
}

async fn plain() -> Result<Option<Dragonfly>> {
    dragonfly_support::connect(DB).await
}

#[tokio::test]
async fn database_path_in_the_port_selects_the_logical_database() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let info: String = df.query(redis::cmd("CLIENT").arg("INFO")).await?;
    ensure!(info.contains(&format!("db={DB}")), "CLIENT INFO: {info}");
    Ok(())
}

#[tokio::test]
async fn a_killed_connection_fails_the_next_command_once_then_reconnects() -> Result<()> {
    let Some((df, recorder)) = connect_recorded(None).await? else {
        return Ok(());
    };
    let Some(killer) = plain().await? else {
        return Ok(());
    };
    let p = prefix("reconnect");
    let counter = format!("{p}counter");
    df.set(&counter, b"0", SetOptions::default()).await?;
    let old_id: i64 = df.query(redis::cmd("CLIENT").arg("ID")).await?;
    let killed: i64 = killer
        .query(redis::cmd("CLIENT").arg("KILL").arg("ID").arg(old_id))
        .await?;
    ensure!(killed == 1, "CLIENT KILL ID returned {killed}");

    // The command that meets the dropped socket fails to its caller; it is not replayed.
    let first = df.query::<i64>(redis::cmd("INCR").arg(&counter)).await;
    let error = match first {
        Ok(value) => bail!("INCR after the kill succeeded ({value}); expected a connection error"),
        Err(error) => error,
    };
    ensure!(error.outcome_unknown(), "unexpected error kind: {error:?}");

    // The handle reconnects on its own.
    let mut value = None;
    for _ in 0..50 {
        match df.query::<i64>(redis::cmd("INCR").arg(&counter)).await {
            Ok(v) => {
                value = Some(v);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    ensure!(
        value == Some(1),
        "the failed INCR must not have been applied or replayed: {value:?}"
    );
    let new_id: i64 = df.query(redis::cmd("CLIENT").arg("ID")).await?;
    ensure!(new_id != old_id, "still on the killed connection");
    ensure!(
        !recorder.errors.lock().map(|e| e.is_empty()).unwrap_or(true),
        "error hook not called"
    );
    cleanup(&killer, &p).await
}

/// A script that keeps the server busy for a bounded number of iterations (about a second).
///
/// Never loop on `TIME` here: Dragonfly freezes the clock inside a script, so a time-based loop
/// never ends, and Dragonfly has no `SCRIPT KILL` and no Lua time limit: the thread spins until
/// the server restarts. A counted loop always ends.
///
/// Sent with a plain `EVAL`, not through [`Script`]: its bound is computed from its argument,
/// which the loop check refuses on purpose, and its argument is the fixed count below.
const SLOW_SCRIPT: &str = "local n = 0 for i = 1, tonumber(ARGV[1]) do n = n + 1 end return n";

/// `EVAL source 0 count` for a test script whose only loop runs `count` times.
fn counted_eval(source: &str, count: &str) -> redis::Cmd {
    let mut cmd = redis::cmd("EVAL");
    cmd.arg(source).arg(0).arg(count);
    cmd
}

/// Iterations for roughly one second on the local Dragonfly (30 million took 0.18 s).
const SLOW_ITERATIONS: &str = "150000000";

#[tokio::test]
async fn the_response_timeout_fires_on_a_slow_script_and_no_stale_reply_follows() -> Result<()> {
    let Some((df, recorder)) = connect_recorded(Some(Duration::from_millis(200))).await? else {
        return Ok(());
    };
    let started = tokio::time::Instant::now();
    let slow = df
        .query_value(&counted_eval(SLOW_SCRIPT, SLOW_ITERATIONS))
        .await;
    let elapsed = started.elapsed();
    match slow {
        Err(error) => ensure!(error.is_timeout() && error.outcome_unknown(), "{error:?}"),
        Ok(value) => bail!("slow script returned {value:?} instead of timing out"),
    }
    ensure!(
        elapsed < Duration::from_millis(900),
        "timeout fired late: {elapsed:?}"
    );
    ensure!(
        recorder
            .commands
            .lock()
            .map(|c| c
                .iter()
                .any(|(m, o)| m == "eval" && *o == CommandOutcome::Error))
            .unwrap_or(false),
        "eval span not recorded as an error"
    );
    // Let the script finish on the server; then the same handle answers its own commands.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let echoed: String = df.query(redis::cmd("ECHO").arg("after-timeout")).await?;
    ensure!(echoed == "after-timeout", "stale reply read: {echoed}");
    Ok(())
}

#[tokio::test]
async fn a_cancelled_blocking_pop_leaves_no_waiter_and_the_connection_works_after() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let p = prefix("blocking");
    let queue = format!("{p}queue");
    let mut blocking = df.blocking();
    blocking.connect().await?;
    let first_id = blocking.connection_id().context("connection id")?;

    // Cancel a pop that would wait forever.
    let keys = [queue.as_str()];
    tokio::select! {
        result = blocking.blpop(&keys, Duration::ZERO) => bail!("BLPOP returned {result:?} on an empty list"),
        () = tokio::time::sleep(Duration::from_millis(200)) => {}
    }
    // The next use opens a fresh connection and makes sure the abandoned waiter is gone.
    blocking.connect().await?;
    let second_id = blocking.connection_id().context("connection id")?;
    ensure!(second_id != first_id, "abandoned connection was reused");
    let clients: String = df.query(redis::cmd("CLIENT").arg("LIST")).await?;
    ensure!(
        !clients
            .lines()
            .any(|line| line.starts_with(&format!("id={first_id} "))),
        "abandoned BLPOP connection still listed"
    );

    // An item pushed now reaches the live caller, not the abandoned one.
    let item = QueueItem::encode(&serde_json::json!({"job": "after-cancel"}))?;
    df.lpush(&queue, &[item.as_bytes()]).await?;
    let popped = blocking
        .blpop(&[queue.as_str()], Duration::from_secs(2))
        .await?;
    ensure!(
        popped == Some((queue.clone(), item.clone())),
        "popped {popped:?}"
    );

    // A timed-out pop returns None and keeps the connection.
    let empty = blocking
        .blpop(&[queue.as_str()], Duration::from_millis(100))
        .await?;
    ensure!(empty.is_none());
    ensure!(
        blocking.connection_id() == Some(second_id),
        "connection replaced after a normal timeout"
    );

    // A server error reply keeps the connection too.
    let string_key = format!("{p}string");
    df.set(&string_key, b"x", SetOptions::default()).await?;
    let wrong = blocking
        .blpop(&[string_key.as_str()], Duration::from_millis(100))
        .await;
    ensure!(
        matches!(&wrong, Err(e) if e.is_server_code("WRONGTYPE")),
        "{wrong:?}"
    );
    ensure!(blocking.connection_id() == Some(second_id));
    cleanup(&df, &p).await
}

#[tokio::test]
async fn dragonfly_freezes_time_inside_a_script() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    // Bounded by an iteration count: about 0.1 s of work between the two TIME calls. A plain
    // EVAL, as for SLOW_SCRIPT: the bound is computed from the fixed argument.
    const TWO_TIMES: &str = "local a = redis.call('TIME') local n = 0 \
        for i = 1, tonumber(ARGV[1]) do n = n + 1 end \
        local b = redis.call('TIME') return {a[1], a[2], b[1], b[2], n}";
    let value = df.query_value(&counted_eval(TWO_TIMES, "20000000")).await?;
    let (s1, us1, s2, us2, n): (String, String, String, String, i64) =
        redis::from_redis_value(value).map_err(redis::RedisError::from)?;
    ensure!(n == 20_000_000);
    // The clock does not move inside a script: a loop waiting on TIME never ends.
    ensure!((s1, us1) == (s2, us2), "TIME advanced inside the script");
    Ok(())
}

#[tokio::test]
async fn blmove_claims_into_a_processing_list() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let p = prefix("blmove");
    let (queue, processing) = (format!("{p}queue"), format!("{p}processing"));
    df.rpush(&queue, &[b"a", b"b"]).await?;
    let mut blocking = df.blocking();
    use dima_store::dragonfly::End;
    let moved = blocking
        .blmove(
            &queue,
            &processing,
            End::Left,
            End::Right,
            Duration::from_secs(1),
        )
        .await?;
    ensure!(moved.as_ref().map(QueueItem::as_bytes) == Some(b"a".as_slice()));
    let in_processing: Vec<Vec<u8>> = df
        .query(redis::cmd("LRANGE").arg(&processing).arg(0).arg(-1))
        .await?;
    ensure!(in_processing == vec![b"a".to_vec()]);
    cleanup(&df, &p).await
}

#[tokio::test]
async fn the_subscriber_resubscribes_after_its_connection_is_killed() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let channel = prefix("pubsub-channel");
    let pattern_base = prefix("pubsub-pattern");
    let subscriber = df.subscriber();
    let mut by_channel = subscriber
        .subscribe(Topic::Channel(channel.clone()), Overflow::Gap)
        .await?;
    let mut by_pattern = subscriber
        .subscribe(
            Topic::Pattern(format!("{pattern_base}*")),
            Overflow::DropNewest,
        )
        .await?;
    ensure!(by_channel.confirmed() && by_pattern.confirmed());

    df.publish(&channel, b"one").await?;
    df.publish(&format!("{pattern_base}x"), b"p-one").await?;
    let got = expect_message(timeout(by_channel.recv()).await?)?;
    ensure!(got.payload == b"one", "{got:?}");
    let got = expect_message(timeout(by_pattern.recv()).await?)?;
    ensure!(got.payload == b"p-one" && got.channel == format!("{pattern_base}x").as_bytes());
    ensure!(got.pattern.as_deref() == Some(format!("{pattern_base}*").as_str()));

    let id = subscriber.connection_id();
    ensure!(id > 0 && subscriber.connections() == 1);
    let killed: i64 = df
        .query(redis::cmd("CLIENT").arg("KILL").arg("ID").arg(id))
        .await?;
    ensure!(killed == 1);
    let mut reconnected = false;
    for _ in 0..100 {
        if subscriber.connections() >= 2 && subscriber.connection_id() != 0 {
            reconnected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ensure!(reconnected, "subscriber did not reconnect");
    ensure!(subscriber.connection_id() != id);

    df.publish(&channel, b"two").await?;
    df.publish(&format!("{pattern_base}y"), b"p-two").await?;
    // The Gap subscription is told that it missed whatever was published meanwhile.
    let marker = timeout(by_channel.recv()).await?;
    ensure!(
        marker
            == Some(Event::Gap(Gap {
                overflowed: 0,
                resubscribed: true
            })),
        "{marker:?}"
    );
    let got = expect_message(timeout(by_channel.recv()).await?)?;
    ensure!(got.payload == b"two", "{got:?}");
    // The DropNewest one just carries on.
    let got = expect_message(timeout(by_pattern.recv()).await?)?;
    ensure!(got.payload == b"p-two", "{got:?}");

    // Dropping a subscription unsubscribes; shutting down ends every stream.
    drop(by_pattern);
    let mut gone = false;
    for _ in 0..40 {
        let receivers = df.publish(&format!("{pattern_base}z"), b"nobody").await?;
        if receivers == 0 {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ensure!(gone, "pattern subscription still active after drop");
    // Dragonfly's unsubscribe confirmation was understood: no reconnect, delivery goes on.
    df.publish(&channel, b"three").await?;
    let got = expect_message(timeout(by_channel.recv()).await?)?;
    ensure!(got.payload == b"three", "{got:?}");
    ensure!(
        subscriber.connections() == 2,
        "reconnected after the unsubscribe"
    );
    subscriber.shutdown().await;
    ensure!(
        by_channel.recv().await.is_none(),
        "stream did not end on shutdown"
    );
    Ok(())
}

fn timeout<F: std::future::Future>(future: F) -> tokio::time::Timeout<F> {
    tokio::time::timeout(Duration::from_secs(2), future)
}

/// Waits until the subscription counted `expected` dropped messages.
async fn dropped_reaches(subscription: &Subscription, expected: u64) -> Result<()> {
    for _ in 0..80 {
        if subscription.dropped() == expected {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    bail!("dropped {} instead of {expected}", subscription.dropped())
}

#[tokio::test]
async fn a_full_buffer_drops_newest_or_reports_a_gap_as_each_subscription_chose() -> Result<()> {
    let Some(mut config) = config(DB) else {
        return Ok(());
    };
    config.subscription_buffer = 2;
    let df = Dragonfly::connect(config, Hooks::default()).await?;
    let samples = prefix("pubsub-samples");
    let feed = prefix("pubsub-feed");
    let subscriber = df.subscriber();
    let mut dropping = subscriber
        .subscribe(Topic::Channel(samples.clone()), Overflow::DropNewest)
        .await?;
    let mut gapping = subscriber
        .subscribe(Topic::Channel(feed.clone()), Overflow::Gap)
        .await?;
    for index in 0..5 {
        df.publish(&samples, format!("m{index}").as_bytes()).await?;
        df.publish(&feed, format!("m{index}").as_bytes()).await?;
    }
    dropped_reaches(&dropping, 3).await?;
    dropped_reaches(&gapping, 3).await?;

    // DropNewest: the oldest two, nothing else; delivery continues once there is room.
    ensure!(expect_message(dropping.recv().await)?.payload == b"m0");
    ensure!(expect_message(dropping.recv().await)?.payload == b"m1");
    df.publish(&samples, b"m5").await?;
    ensure!(expect_message(timeout(dropping.recv()).await?)?.payload == b"m5");

    // Gap: the oldest two, then one marker standing for the three that were lost, then on.
    ensure!(expect_message(gapping.recv().await)?.payload == b"m0");
    ensure!(expect_message(gapping.recv().await)?.payload == b"m1");
    let marker = gapping.recv().await;
    ensure!(
        marker
            == Some(Event::Gap(Gap {
                overflowed: 3,
                resubscribed: false
            })),
        "{marker:?}"
    );
    df.publish(&feed, b"m5").await?;
    ensure!(expect_message(timeout(gapping.recv()).await?)?.payload == b"m5");
    Ok(())
}

#[tokio::test]
async fn json_handler_receives_the_envelope() -> Result<()> {
    let Some((df, recorder)) = connect_recorded(None).await? else {
        return Ok(());
    };
    let channel = prefix("pubsub-json");
    let subscriber = df.subscriber();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
    #[derive(serde::Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Ended {
        #[serde(rename = "channelID")]
        channel_id: String,
        session: String,
        timestamp: f64,
    }
    let _guard = subscriber
        .on_json(
            Topic::Channel(channel.clone()),
            Overflow::Gap,
            move |event: Event<Ended>| {
                if let Event::Message(value) = event {
                    let _ = sender.try_send(value);
                }
            },
        )
        .await?;
    df.publish(&channel, b"not json").await?;
    // Valid JSON of the wrong shape: serde's message would quote the value.
    df.publish(
        &channel,
        br#"{"channelID":"1","session":"s","timestamp":"top-secret-token"}"#,
    )
    .await?;
    let data = serde_json::json!({"channelID": "123", "session": "s \u{1F600}"});
    df.publish_envelope(&channel, &data, 1_794_000_000_000.0)
        .await?;
    let got = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await?
        .context("handler")?;
    ensure!(
        got == Ended {
            channel_id: "123".into(),
            session: "s \u{1F600}".into(),
            timestamp: 1_794_000_000_000.0
        }
    );
    ensure!(
        envelope(&data, 1.0)? == r#"{"channelID":"123","session":"s 😀","timestamp":1}"#.as_bytes()
    );
    // Both bad payloads were reported, with a category and a position, never their text.
    let errors = recorder
        .errors
        .lock()
        .map(|e| e.clone())
        .unwrap_or_default();
    let reports: Vec<&String> = errors
        .iter()
        .filter(|e| e.contains("not the expected JSON"))
        .collect();
    ensure!(reports.len() == 2, "{errors:?}");
    ensure!(
        reports
            .iter()
            .all(|e| !e.contains("top-secret") && e.contains("column")),
        "{reports:?}"
    );
    ensure!(
        reports.iter().any(|e| e.contains("data error")),
        "{reports:?}"
    );
    Ok(())
}

static ECHO_SCRIPT: Script = Script::new("TEST_ECHO", "return {KEYS[1], ARGV[1], 7}");

#[tokio::test]
async fn evalsha_falls_back_to_eval_after_script_flush() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let p = prefix("noscript");
    let key = format!("{p}k");
    let first = ECHO_SCRIPT.run_value(&df, &[key.as_str()], &["é"]).await?;
    // Once, not in a loop: SCRIPT FLUSH empties the server's whole script cache.
    let _: String = df.query(redis::cmd("SCRIPT").arg("FLUSH")).await?;
    let exists: Vec<i64> = df
        .query(redis::cmd("SCRIPT").arg("EXISTS").arg(ECHO_SCRIPT.sha1()))
        .await?;
    ensure!(exists == vec![0], "script still cached after SCRIPT FLUSH");
    // The fence's pipelined EVALSHA batch reloads its script and replays once.
    let fence = dima_store::dragonfly::plan_cache_fence::PlanCacheFence::new(df.clone());
    let reads = fence
        .read_accounts(&["dima-test-noscript-a", "dima-test-noscript-b"])
        .await?;
    ensure!(reads.len() == 2, "{reads:?}");
    let second = ECHO_SCRIPT.run_value(&df, &[key.as_str()], &["é"]).await?;
    ensure!(first == second, "{first:?} vs {second:?}");
    let exists: Vec<i64> = df
        .query(redis::cmd("SCRIPT").arg("EXISTS").arg(ECHO_SCRIPT.sha1()))
        .await?;
    ensure!(exists == vec![1], "EVAL fallback did not reload the script");
    let typed: (String, String, i64) = ECHO_SCRIPT.run(&df, &[key.as_str()], &["é"]).await?;
    ensure!(typed == (key, "é".to_owned(), 7));
    Ok(())
}

#[tokio::test]
async fn reply_shapes_match_what_node_redis_reports() -> Result<()> {
    let Some((df, recorder)) = connect_recorded(None).await? else {
        return Ok(());
    };
    let p = prefix("replies");
    let key = |name: &str| format!("{p}{name}");

    // GET: nil versus empty string.
    ensure!(df.get(&key("missing")).await?.is_none());
    df.set(&key("empty"), b"", SetOptions::default()).await?;
    ensure!(df.get(&key("empty")).await? == Some(Vec::new()));

    // SET: the three outcomes.
    let lock = SetOptions::if_missing_ex(60);
    ensure!(df.set(&key("lock"), b"owner-1", lock).await? == SetOutcome::Written);
    ensure!(df.set(&key("lock"), b"owner-2", lock).await? == SetOutcome::NotWritten);
    let get_nx = SetOptions {
        condition: SetCondition::IfMissing,
        expiry: SetExpiry::None,
        get: true,
    };
    ensure!(
        df.set(&key("lock"), b"owner-3", get_nx).await?
            == SetOutcome::Previous(Some(b"owner-1".to_vec()))
    );
    ensure!(df.set(&key("fresh"), b"v", get_nx).await? == SetOutcome::Previous(None));
    let xx = SetOptions {
        condition: SetCondition::IfExists,
        ..SetOptions::default()
    };
    ensure!(df.set(&key("absent"), b"v", xx).await? == SetOutcome::NotWritten);
    ensure!(df.get(&key("lock")).await? == Some(b"owner-1".to_vec()));

    // TTL codes.
    ensure!(df.ttl(&key("missing")).await? == Ttl::Missing);
    ensure!(df.ttl(&key("empty")).await? == Ttl::NoExpiry);
    ensure!(matches!(df.ttl(&key("lock")).await?, Ttl::Seconds(59 | 60)));
    let keep = SetOptions {
        expiry: SetExpiry::KeepTtl,
        ..SetOptions::default()
    };
    df.set(&key("lock"), b"owner-1", keep).await?;
    ensure!(matches!(df.ttl(&key("lock")).await?, Ttl::Seconds(59 | 60)));

    // HGETALL on a missing key, and field order.
    ensure!(df.hgetall(&key("nohash")).await?.is_empty());
    df.hset(
        &key("hash"),
        &[("z", b"1"), ("a", b"2"), ("m", "é".as_bytes())],
    )
    .await?;
    let pairs = df.hgetall(&key("hash")).await?;
    ensure!(
        pairs
            == [
                ("z".into(), "1".into()),
                ("a".into(), "2".into()),
                ("m".into(), "é".into())
            ],
        "{pairs:?}"
    );
    ensure!(df.hget(&key("hash"), "nofield").await?.is_none());

    // Integer replies.
    ensure!(
        df.exists(&[key("hash").as_str(), key("missing").as_str()])
            .await?
            == 1
    );
    ensure!(
        df.del(&[key("fresh").as_str(), key("missing").as_str()])
            .await?
            == 1
    );

    // ZPOPMIN and scores written like JavaScript numbers.
    ensure!(df.zpopmin(&key("zset")).await?.is_none());
    df.zadd(
        &key("zset"),
        &[(1e21, b"big"), (1.5, b"frac"), (f64::INFINITY, b"inf")],
    )
    .await?;
    let scores: Vec<String> = df
        .query(
            redis::cmd("ZRANGE")
                .arg(key("zset"))
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES"),
        )
        .await?;
    ensure!(
        scores == ["frac", "1.5", "big", "1e+21", "inf", "inf"],
        "{scores:?}"
    );
    ensure!(df.zpopmin(&key("zset")).await? == Some((b"frac".to_vec(), 1.5)));
    ensure!(df.zcard(&key("zset")).await? == 2);
    df.zpopmin(&key("zset")).await?;
    ensure!(df.zpopmin(&key("zset")).await? == Some((b"inf".to_vec(), f64::INFINITY)));

    // SCAN pages until the cursor returns to 0.
    let mut scan = df.scan(&format!("{p}*"), Some(2));
    let mut seen = Vec::new();
    while let Some(page) = scan.next_page().await? {
        seen.extend(page);
    }
    seen.sort();
    seen.dedup();
    // empty, lock, hash (fresh was deleted, the sorted set emptied and so removed).
    ensure!(seen.len() == 3, "scan saw {} keys", seen.len());

    // Lists: nil pops, non-UTF-8 values carried as bytes.
    ensure!(df.lpop(&key("nolist")).await?.is_none());
    df.rpush(&key("list"), &[&[0xff, 0x00, 0xfe]]).await?;
    ensure!(df.rpop(&key("list")).await? == Some(vec![0xff, 0x00, 0xfe]));
    ensure!(matches!(df.get_text(&key("nolist")).await, Ok(None)));
    df.set(&key("binary"), &[0xc3, 0x28], SetOptions::default())
        .await?;
    ensure!(matches!(
        df.get_text(&key("binary")).await,
        Err(DragonflyError::NotUtf8)
    ));

    // The command hook saw get with hit/miss, and nothing for un-instrumented commands.
    let commands = recorder
        .commands
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    ensure!(commands.iter().any(|(m, o)| m == "get"
        && *o
            == CommandOutcome::Ok {
                lookup: Some(CacheLookup::Miss)
            }));
    ensure!(commands.iter().any(|(m, o)| m == "get"
        && *o
            == CommandOutcome::Ok {
                lookup: Some(CacheLookup::Hit)
            }));
    ensure!(
        commands.iter().any(|(m, _)| m == "hGetAll")
            && commands.iter().any(|(m, _)| m == "zPopMin")
    );
    ensure!(
        !commands
            .iter()
            .any(|(m, _)| m == "ttl" || m == "scan" || m == "zRange")
    );
    cleanup(&df, &p).await
}

#[tokio::test]
async fn dragonfly_lua_accepts_scan_and_keys_but_not_reading_what_they_return() -> Result<()> {
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let p = prefix("lua-scan");
    df.set(&format!("{p}a"), b"1", SetOptions::default())
        .await?;
    df.set(&format!("{p}b"), b"2", SetOptions::default())
        .await?;
    df.query::<i64>(redis::cmd("SADD").arg(format!("{p}set")).arg("x"))
        .await?;

    // SCAN inside a script pages like SCAN anywhere (COUNT is a hint, and with other tests'
    // keys in the database one call can return a non-zero cursor and no match), so the cursor
    // is iterated from Rust, bounded.
    static SCAN: Script = Script::new(
        "TEST_SCAN",
        "return redis.call('SCAN', ARGV[2], 'MATCH', ARGV[1], 'COUNT', '1000')",
    );
    static KEYS: Script = Script::new("TEST_KEYS", "return redis.call('KEYS', ARGV[1])");
    static SSCAN: Script = Script::new("TEST_SSCAN", "return redis.call('SSCAN', KEYS[1], '0')");
    static SCAN_THEN_GET: Script = Script::new(
        "TEST_SCAN_GET",
        "local r = redis.call('SCAN', ARGV[2], 'MATCH', ARGV[1], 'COUNT', '1000') \
         local out = {} for _, k in ipairs(r[2]) do table.insert(out, redis.call('GET', k)) end return {r[1], out}",
    );
    let pattern = format!("{p}?");
    let mut cursor = "0".to_owned();
    let mut keys: Vec<String> = Vec::new();
    for _ in 0..10_000 {
        let (next, page): (String, Vec<String>) = SCAN
            .run(&df, &[] as &[&str], &[pattern.as_str(), cursor.as_str()])
            .await?;
        keys.extend(page);
        cursor = next;
        if cursor == "0" {
            break;
        }
    }
    keys.sort();
    ensure!(
        cursor == "0" && keys == [format!("{p}a"), format!("{p}b")],
        "SCAN in Lua: {keys:?}"
    );
    let mut keys: Vec<String> = KEYS.run(&df, &[] as &[&str], &[pattern.as_str()]).await?;
    keys.sort();
    ensure!(
        keys == [format!("{p}a"), format!("{p}b")],
        "KEYS in Lua: {keys:?}"
    );
    let (_, members): (String, Vec<String>) = SSCAN
        .run(&df, &[format!("{p}set").as_str()], &[] as &[&str])
        .await?;
    ensure!(members == ["x"]);
    let mut cursor = "0".to_owned();
    let mut refused = None;
    for _ in 0..10_000 {
        match SCAN_THEN_GET
            .run_value(&df, &[] as &[&str], &[pattern.as_str(), cursor.as_str()])
            .await
        {
            Err(error) => {
                refused = Some(error.to_string());
                break;
            }
            Ok(value) => {
                let (next, _): (String, redis::Value) =
                    redis::from_redis_value(value).map_err(redis::RedisError::from)?;
                cursor = next;
                if cursor == "0" {
                    break;
                }
            }
        }
    }
    ensure!(
        refused
            .as_deref()
            .is_some_and(|e| e.contains("undeclared key")),
        "reading a scanned key must be refused as undeclared: {refused:?}"
    );
    cleanup(&df, &p).await
}

/// The specialised reply helpers against real replies: scored ranges, counted pops, stream
/// entries and reads, and a transaction that keeps every command's result.
#[tokio::test]
async fn specialised_reply_helpers_decode_live_replies() -> Result<()> {
    use dima_store::dragonfly::commands::reply;
    use std::num::NonZeroUsize;
    let Some(df) = plain().await? else {
        return Ok(());
    };
    let p = prefix("reply-helpers");
    let n = |n: usize| NonZeroUsize::new(n).context("count");
    let result = async {
        let z = format!("{p}z");
        let l = format!("{p}l");
        let s = format!("{p}s");
        let missing = format!("{p}missing");
        df.zadd(
            &z,
            &[(1.5, b"a"), (2.0, "é🎉".as_bytes()), (f64::INFINITY, b"c")],
        )
        .await?;
        ensure!(
            df.zrange_with_scores(&z, 0, -1).await?
                == vec![
                    (b"a".to_vec(), 1.5),
                    ("é🎉".as_bytes().to_vec(), 2.0),
                    (b"c".to_vec(), f64::INFINITY)
                ]
        );
        let by_score = reply::scored(
            df.query_value(
                redis::cmd("ZRANGEBYSCORE")
                    .arg(&z)
                    .arg("2")
                    .arg("+inf")
                    .arg("WITHSCORES")
                    .arg("LIMIT")
                    .arg(0)
                    .arg(1),
            )
            .await?,
        )?;
        ensure!(by_score == vec![("é🎉".as_bytes().to_vec(), 2.0)]);
        ensure!(df.zpopmin_count(&z, n(2)?).await?.len() == 2);
        ensure!(df.zpopmin_count(&missing, n(2)?).await?.is_empty());

        df.rpush(&l, &[b"x", b"y", b"z"]).await?;
        ensure!(df.lpop_count(&l, n(2)?).await? == Some(vec![b"x".to_vec(), b"y".to_vec()]));
        ensure!(df.rpop_count(&l, n(5)?).await? == Some(vec![b"z".to_vec()]));
        ensure!(
            df.lpop_count(&missing, n(5)?).await?.is_none(),
            "nil for a missing key"
        );

        let id = reply::text(
            df.query_value(
                redis::cmd("XADD")
                    .arg(&s)
                    .arg("*")
                    .arg("f")
                    .arg("v")
                    .arg("text")
                    .arg("שלום e\u{301}"),
            )
            .await?,
        )?;
        let entries = df.xrange(&s, "-", "+", n(10)?).await?;
        ensure!(entries.len() == 1 && entries[0].id == id);
        ensure!(
            entries[0].fields
                == vec![
                    (b"f".to_vec(), b"v".to_vec()),
                    (b"text".to_vec(), "שלום e\u{301}".as_bytes().to_vec())
                ]
        );
        ensure!(df.xrange(&missing, "-", "+", n(10)?).await?.is_empty());
        let read = reply::stream_read(
            df.query_value(
                redis::cmd("XREAD")
                    .arg("COUNT")
                    .arg(5)
                    .arg("STREAMS")
                    .arg(&s)
                    .arg("0"),
            )
            .await?,
        )?;
        ensure!(read.len() == 1 && read[0].0 == s.as_bytes() && read[0].1 == entries);
        let none = reply::stream_read(
            df.query_value(redis::cmd("XREAD").arg("STREAMS").arg(&s).arg(&id))
                .await?,
        )?;
        ensure!(none.is_empty(), "nothing newer is an empty list");

        // One command fails at run time; the others ran and keep their replies.
        df.set(&missing, b"v", SetOptions::default()).await?;
        let mut pipeline = redis::pipe();
        pipeline
            .cmd("INCR")
            .arg(format!("{p}counter"))
            .cmd("LPUSH")
            .arg(&missing)
            .arg("x")
            .cmd("XRANGE")
            .arg(&s)
            .arg("-")
            .arg("+");
        let replies = df.transaction(pipeline).await?;
        ensure!(replies.len() == 3);
        ensure!(
            matches!(replies[0], Ok(redis::Value::Int(1))),
            "{:?}",
            replies[0]
        );
        ensure!(
            matches!(&replies[1], Err(error) if error.is_server_code("WRONGTYPE")),
            "{:?}",
            replies[1]
        );
        let nested = replies[2].as_ref().map_err(|e| anyhow::anyhow!("{e}"))?;
        ensure!(reply::stream_entries(nested.clone())? == entries);
        ensure!(df.get(&format!("{p}counter")).await? == Some(b"1".to_vec()));
        // A command refused while queueing aborts the whole transaction.
        let mut aborted = redis::pipe();
        aborted
            .cmd("INCR")
            .arg(format!("{p}counter"))
            .cmd("NOSUCHCOMMAND");
        ensure!(df.transaction(aborted).await.is_err());
        ensure!(df.get(&format!("{p}counter")).await? == Some(b"1".to_vec()));
        Ok(())
    }
    .await;
    cleanup(&df, &p).await?;
    result
}
