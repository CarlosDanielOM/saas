//! Replays `tests/dragonfly_golden/golden.json` (written by `record.mjs` with node-redis 5.12.1 and
//! the reference's Lua) through `dima_store::dragonfly` and compares bytes.
//!
//! - Offline (always): Rust's encoders give the recorded bytes for the same inputs: cron jobs
//!   (including the awkward text and JavaScript number formatting), plan versions, the pub/sub
//!   envelopes.
//! - Live (when `DIMA_TEST_DRAGONFLY` is set, logical database 9): Rust performs the same
//!   operations through the Rust API and the stored values equal the recorded ones, after the
//!   run's key prefix is swapped for the recorded one.

mod dragonfly_support;

use anyhow::{Context, Result, ensure};
use base64::Engine;
use dima_store::dragonfly::cron_queue::{self, CronQueueConfig, EnqueueCronJobInput, EnqueuePlan};
use dima_store::dragonfly::plan_cache_fence::{
    self, Acceptance, AccountVersion, CreditMode, Exhaustion, PLAN_CACHE_VERSION_FIELD,
    PlanCacheFence, TtlSeconds,
};
use dima_store::dragonfly::pubsub::envelope;
use dima_store::dragonfly::{End, ListQueue, QueueItem, SetOptions, Topic, Ttl};
use dragonfly_support::{AWKWARD_TEXT, cleanup, connect, prefix};
use serde::Serialize;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::time::Duration;

const DB: u8 = 9;

fn golden() -> Result<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/dragonfly_golden/golden.json"
    );
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

fn recorded(value: &Value) -> Result<Vec<u8>> {
    let encoded = value["base64"].as_str().context("base64 field")?;
    Ok(base64::engine::general_purpose::STANDARD.decode(encoded)?)
}

fn text(value: &Value) -> Result<String> {
    Ok(value.as_str().context("text")?.to_owned())
}

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

struct Run {
    golden: Value,
    now_iso: String,
    now_ms: f64,
    golden_prefix: String,
    golden_channel: String,
}

impl Run {
    fn load() -> Result<Self> {
        let golden = golden()?;
        Ok(Self {
            now_iso: text(&golden["fixed"]["nowIso"])?,
            now_ms: golden["fixed"]["nowMs"].as_f64().context("nowMs")?,
            golden_prefix: text(&golden["prefix"])?,
            golden_channel: text(&golden["channelId"])?,
            golden,
        })
    }

    fn case(&self, name: &str) -> &Value {
        &self.golden["cases"][name]
    }

    /// Bytes produced under `ours` with the recorded prefix (and channel id) put back.
    fn normalise(&self, bytes: &[u8], ours: &str) -> Vec<u8> {
        let text = String::from_utf8_lossy(bytes)
            .replace(&channel_of(ours), &self.golden_channel)
            .replace(ours, &self.golden_prefix);
        text.into_bytes()
    }
}

fn channel_of(prefix: &str) -> String {
    format!("{}chan", prefix.replace(':', "-"))
}

fn follow_ledger_input(prefix: &str) -> EnqueueCronJobInput {
    EnqueueCronJobInput {
        job: "follow-ledger-sync".into(),
        channel_id: Some("123456".into()),
        account_id: Some("123456".into()),
        requested_by: Some("golden".into()),
        dedupe_seconds: Some(120.0),
        dedupe_token: Some(format!("{prefix}follow-ledger:123456")),
        data: Some(json!({"reason": "manual_request", "type": "follow-ledger-sync"})),
        queue_key: Some(format!("{prefix}cron-queue")),
        ..EnqueueCronJobInput::default()
    }
}

fn awkward_data() -> Value {
    json!({
        "texts": AWKWARD_TEXT,
        "one": 1.0,
        "big": 1e21,
        "small": 1e-7,
        "sum": 0.1 + 0.2,
        "negZero": -0.0,
        // 2 ** 53 + 1 in JavaScript is already 9007199254740992.
        "huge": 9_007_199_254_740_993_u64,
        // Built with "b" first: JavaScript enumerates the index key "10" first anyway.
        "nested": {"b": [true, null, "é"], "10": "index key"},
        "source": "stream_offline",
        "sessionID": " sess ",
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipRequestData<'a> {
    #[serde(rename = "clipID")]
    clip_id: &'a str,
    streamer_login: &'a str,
    duration: f64,
    clip_url: &'a str,
    title: &'a str,
    game: &'a str,
    streamer: &'a str,
    profile_image: &'a str,
    description: &'a str,
    streamer_color: &'a str,
    timestamp: f64,
}

fn clip_data(now_ms: f64) -> ClipRequestData<'static> {
    ClipRequestData {
        clip_id: "AwkwardClip",
        streamer_login: "golden",
        duration: 30.5,
        clip_url: "https://clips.twitch.tv/x?a=1&b=2",
        title: AWKWARD_TEXT[1],
        game: AWKWARD_TEXT[3],
        streamer: "Gölden",
        profile_image: "https://x/y.png",
        description: AWKWARD_TEXT[5],
        streamer_color: "#FF00FF",
        timestamp: now_ms - 5.0,
    }
}

fn widget_message(now_ms: f64) -> Value {
    json!({"channel": "42", "type": "chat", "data": {
        "id": "m1", "user": {"login": "u", "color": null}, "text": AWKWARD_TEXT[2], "emotes": [], "at": now_ms
    }})
}

// ---- Offline ----------------------------------------------------------------------------------

#[test]
fn cron_jobs_are_written_with_the_recorded_bytes() -> Result<()> {
    let run = Run::load()?;
    let config = CronQueueConfig::default();
    let case = run.case("cron_follow_ledger");
    let plan = cron_queue::prepare_enqueue_cron_job(
        &follow_ledger_input(&run.golden_prefix),
        config,
        &run.now_iso,
        &uuid(1),
    )?;
    let EnqueuePlan::Deduplicated { job, args, .. } = plan else {
        anyhow::bail!("expected the deduplicated route")
    };
    ensure!(
        job.to_item()?.as_bytes() == recorded(&case["item"])?.as_slice(),
        "follow ledger job bytes differ"
    );
    ensure!(args[0] == text(&case["dedupeSecondsArg"])?.as_bytes());

    let case = run.case("cron_awkward");
    let input = EnqueueCronJobInput {
        job: "summary".into(),
        channel_id: Some(" 42 ".into()),
        data: Some(awkward_data()),
        queue_key: Some(format!("{}cron-awkward", run.golden_prefix)),
        dedupe_token: Some(format!("{}awkward", run.golden_prefix)),
        ..EnqueueCronJobInput::default()
    };
    let plan = cron_queue::prepare_enqueue_cron_job(&input, config, &run.now_iso, &uuid(2))?;
    let EnqueuePlan::Deduplicated { job, keys, .. } = plan else {
        anyhow::bail!("expected the deduplicated route")
    };
    let expected = recorded(&case["item"])?;
    ensure!(
        job.to_item()?.as_bytes() == expected.as_slice(),
        "awkward job differs:\n rust: {}\n node: {}",
        String::from_utf8_lossy(job.to_item()?.as_bytes()),
        String::from_utf8_lossy(&expected)
    );
    ensure!(keys.get(2).map(String::as_str) == case["acceptanceKeyByReference"].as_str());

    let case = run.case("cron_durable");
    let input = EnqueueCronJobInput {
        job: "stream-memory-summary".into(),
        channel_id: Some("42".into()),
        account_id: Some("42".into()),
        dedupe_token: Some("stream-memory-summary:42:s:v".into()),
        dedupe_seconds: Some(43200.0),
        queue_key: Some(cron_queue::STREAM_MEMORY_QUEUE_KEY.into()),
        data: Some(
            json!({"reason": "stream_offline", "source": "stream_offline", "sessionID": "s", "streamID": "v", "notBeforeUnix": 0}),
        ),
        ..EnqueueCronJobInput::default()
    };
    let plan = cron_queue::prepare_enqueue_cron_job(&input, config, &run.now_iso, &uuid(3))?;
    let EnqueuePlan::Durable { job, .. } = plan else {
        anyhow::bail!("expected the durable route")
    };
    ensure!(
        job.to_item()?.as_bytes() == recorded(&case["item"])?.as_slice(),
        "durable payload differs"
    );
    Ok(())
}

#[test]
fn plan_versions_and_pubsub_envelopes_match() -> Result<()> {
    let run = Run::load()?;
    let fence = run.case("fence");
    ensure!(
        plan_cache_fence::plan_cache_version(Some(1_790_000_000_000), Some("evt-1"))?
            == text(&fence["version"])?
    );
    let pubsub = run.case("pubsub");
    ensure!(envelope(&clip_data(run.now_ms), run.now_ms)? == recorded(&pubsub["clip_request"])?);
    let ended = json!({"channelID": "42", "session": "sess-é"});
    ensure!(envelope(&ended, run.now_ms)? == recorded(&pubsub["tts_session_ended"])?);
    ensure!(
        envelope(&widget_message(run.now_ms), run.now_ms)? == recorded(&pubsub["widget_feed"])?
    );
    // keywords:changed is published raw: JSON.stringify({channelID}).
    ensure!(
        QueueItem::encode(&json!({"channelID": "42"}))?.as_bytes()
            == recorded(&pubsub["keywords_changed"])?.as_slice()
    );
    Ok(())
}

// ---- Live -------------------------------------------------------------------------------------

#[tokio::test]
async fn rust_operations_store_the_recorded_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let run = Run::load()?;
    let p = prefix("golden-replay");
    let config = CronQueueConfig::default();

    // Cron enqueue through the real script.
    let case = run.case("cron_follow_ledger");
    let input = follow_ledger_input(&p);
    let first = cron_queue::enqueue_cron_job(&df, &input, config, &run.now_iso, &uuid(1)).await?;
    ensure!(first.enqueued);
    ensure!(
        !cron_queue::enqueue_cron_job(&df, &input, config, &run.now_iso, &uuid(1))
            .await?
            .enqueued
    );
    let stored: Vec<Vec<u8>> = df
        .query(
            redis::cmd("LRANGE")
                .arg(format!("{p}cron-queue"))
                .arg(0)
                .arg(-1),
        )
        .await?;
    ensure!(stored.len() == 1 && run.normalise(&stored[0], &p) == recorded(&case["item"])?);
    let dedupe_key = first.job.dedupe_key.clone().context("dedupe key")?;
    ensure!(df.get(&dedupe_key).await? == Some(recorded(&case["marker"])?));
    ensure!(matches!(
        df.ttl(&dedupe_key).await?,
        Ttl::Seconds(119 | 120)
    ));
    df.del(&[&dedupe_key]).await?;

    // Newest first.
    let lifo = ListQueue::new(Cow::Owned(format!("{p}lifo")), End::Left, End::Left);
    for value in ["a", "b", "c"] {
        lifo.push(&df, &QueueItem::from_popped(value.as_bytes().to_vec()))
            .await?;
    }
    let order: Vec<String> = df
        .query(redis::cmd("LRANGE").arg(lifo.key()).arg(0).arg(-1))
        .await?;
    let expected: Vec<String> = serde_json::from_value(run.case("lifo_order").clone())?;
    ensure!(order == expected);

    // Durable publish: pushed once, LPOS finds the exact bytes the second time.
    let case = run.case("cron_durable");
    let durable_input = EnqueueCronJobInput {
        job: "stream-memory-summary".into(),
        channel_id: Some("42".into()),
        account_id: Some("42".into()),
        dedupe_token: Some("stream-memory-summary:42:s:v".into()),
        dedupe_seconds: Some(43200.0),
        queue_key: Some(cron_queue::STREAM_MEMORY_QUEUE_KEY.into()),
        data: Some(
            json!({"reason": "stream_offline", "source": "stream_offline", "sessionID": "s", "streamID": "v", "notBeforeUnix": 0}),
        ),
        ..EnqueueCronJobInput::default()
    };
    let EnqueuePlan::Durable { job, .. } =
        cron_queue::prepare_enqueue_cron_job(&durable_input, config, &run.now_iso, &uuid(3))?
    else {
        anyhow::bail!("expected the durable route")
    };
    let queue = format!("{p}stream-memory");
    let automatic = format!("{p}automatic");
    let item = job.to_item()?;
    ensure!(
        cron_queue::publish_durable_cron_job(&df, &queue, Some(&automatic), &item).await?
            == (case["first"] == 1)
    );
    ensure!(
        cron_queue::publish_durable_cron_job(&df, &queue, None, &item).await?
            == (case["second"] == 1)
    );
    let stored: Vec<Vec<u8>> = df
        .query(redis::cmd("LRANGE").arg(&queue).arg(0).arg(-1))
        .await?;
    ensure!(stored == vec![recorded(&case["item"])?]);
    ensure!(df.get(&automatic).await? == Some(recorded(&case["automatic"])?));
    cleanup(&df, &p).await
}

#[tokio::test]
async fn fence_operations_store_the_recorded_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let run = Run::load()?;
    let p = prefix("golden-fence");
    let id = channel_of(&p);
    let case = run.case("fence");
    let fence = PlanCacheFence::new(df.clone());
    let version = text(&case["version"])?;
    let ttl = TtlSeconds::new(3600)?;

    // WRITE: the account as twitch_streamers.class.ts passes it (string fields, the version field
    // already present mid-object keeps its place).
    let fields = [
        ("id", id.as_str()),
        ("login", "golden_user"),
        (PLAN_CACHE_VERSION_FIELD, "old"),
        ("display_name", "Ñandú 🎉 مرحبا"),
        ("plan_tier", "pro"),
    ];
    ensure!(fence.write_account(&id, &version, &fields).await? == Acceptance::Accepted);
    let pairs = df
        .hgetall(&plan_cache_fence::account_cache_key(&id))
        .await?;
    let pairs: Vec<(String, String)> = pairs
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                String::from_utf8_lossy(&run.normalise(v.as_bytes(), &p)).into_owned(),
            )
        })
        .collect();
    let expected: Vec<(String, String)> = serde_json::from_value(case["hashPairs"].clone())?;
    ensure!(pairs == expected, "{pairs:?}");

    // CHECK publishes JSON.stringify of the HGETALL objects (field order kept).
    let object: serde_json::Map<String, Value> = df
        .hgetall(&plan_cache_fence::account_cache_key(&id))
        .await?
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    let aggregate = dima_text::to_js_json(&Value::Array(vec![Value::Object(object)]));
    let accounts = [AccountVersion {
        id: &id,
        version: &version,
    }];
    ensure!(fence.check_accounts(&accounts, Some(&aggregate)).await? == Acceptance::Accepted);
    let published = df
        .get(plan_cache_fence::ACCOUNTS_CACHE_KEY)
        .await?
        .context("aggregate")?;
    ensure!(
        run.normalise(&published, &p) == recorded(&case["aggregate"])?,
        "aggregate differs"
    );
    if published == aggregate.as_bytes() {
        df.del(&[plan_cache_fence::ACCOUNTS_CACHE_KEY]).await?;
    }

    // SYNC with {...credits, __polar_plan_version}.
    let credits = json!({"version": 2, "available": true, "used": 5, "balance": 10,
        "updatedAt": run.now_iso, "status": "available", "note": "é/🎉", "__polar_plan_version": version});
    let payload = dima_text::to_js_json(&credits);
    ensure!(
        payload.as_bytes() == recorded(&case["syncPayload"])?.as_slice(),
        "sync payload differs"
    );
    let snapshot = format!("{}:snap-1", dima_text::pad_start("1790000000500", 13, "0"));
    ensure!(
        fence
            .sync_credits(
                &id,
                &snapshot,
                Some(&payload),
                Exhaustion::Exhausted,
                ttl,
                &version
            )
            .await?
            == Acceptance::Accepted
    );
    let stored = df
        .get(&plan_cache_fence::credits_cache_key(&id))
        .await?
        .context("credits")?;
    ensure!(stored == recorded(&case["afterSync"])?);
    for (index, key) in plan_cache_fence::exhaustion_cache_keys(&id)
        .iter()
        .enumerate()
    {
        ensure!(df.get(key).await? == Some(recorded(&case["exhaust"][index])?));
    }

    // The value Lua's cjson wrote: read mode accepts those exact bytes, and only those.
    let cjson = recorded(&case["afterApply"])?;
    df.set(
        &plan_cache_fence::credits_cache_key(&id),
        &cjson,
        SetOptions::ex(3600),
    )
    .await?;
    let raw = String::from_utf8(cjson)?;
    ensure!(
        fence
            .accept_credits(&id, &version, &raw, CreditMode::Read, false, ttl)
            .await?
            == Acceptance::Accepted
    );
    let reparsed = dima_text::to_js_json(&serde_json::from_str(&raw)?);
    ensure!(
        fence
            .accept_credits(&id, &version, &reparsed, CreditMode::Read, false, ttl)
            .await?
            == Acceptance::Rejected
    );

    // INVALIDATE raises the fence; the old version is then stale.
    let newer = plan_cache_fence::plan_cache_version(Some(1_800_000_000_000), Some("evt-2"))?;
    ensure!(
        fence
            .invalidate_plan(&id, &newer, &format!("{p}billing-context"))
            .await?
            == Acceptance::Accepted
    );
    let stored = df.get(&plan_cache_fence::plan_cache_fence_key(&id)).await?;
    ensure!(stored == Some(recorded(&case["fenceAfterInvalidate"])?));
    ensure!(
        fence
            .write_account(&id, &version, &[("id", id.as_str())])
            .await?
            == Acceptance::Rejected
    );
    ensure!(case["staleWrite"] == 0);

    let keys = [
        plan_cache_fence::plan_cache_fence_key(&id),
        plan_cache_fence::account_cache_key(&id),
        plan_cache_fence::credits_cache_key(&id),
        plan_cache_fence::snapshot_version_key(&id),
        format!("twitch:{id}:ai:exhaust"),
        format!("{id}:ai:exhaust"),
    ];
    df.del(&keys.iter().map(String::as_str).collect::<Vec<_>>())
        .await?;
    Ok(())
}

#[tokio::test]
async fn published_envelopes_arrive_as_the_recorded_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let run = Run::load()?;
    let channel = prefix("golden-pubsub");
    let subscriber = df.subscriber();
    let mut subscription = subscriber
        .subscribe(Topic::Channel(channel.clone()))
        .await?;
    df.publish_envelope(&channel, &clip_data(run.now_ms), run.now_ms)
        .await?;
    df.publish(&channel, br#"{"channelID":"42"}"#).await?;
    let pubsub = run.case("pubsub");
    for name in ["clip_request", "keywords_changed"] {
        let message = tokio::time::timeout(Duration::from_secs(2), subscription.recv())
            .await?
            .context("message")?;
        ensure!(
            message.payload == recorded(&pubsub[name])?,
            "{name} differs"
        );
    }
    Ok(())
}
