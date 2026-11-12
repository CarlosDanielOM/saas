//! TypeScript and Rust on the same keys at the same time. `record.mjs peer` is the TypeScript
//! side: node-redis 5.12.1, the reference's Lua read from `dimabot/src`, the reference's producers.
//!
//! Rust never runs beside TypeScript in production (one cutover, `MIGRATION.md` section 3), so
//! this is not a compatibility contract. It is kept as an independent check of the reference's
//! Lua scripts and of claim and acknowledge by the claimed bytes. Queue items and envelopes are
//! Rust's own encoding; nothing here requires Node to produce the same bytes as Rust.
//!
//! - Node pushes, Rust pops, acknowledges and requeues; Node sees the exact bytes.
//! - Rust pushes, Node claims and acknowledges by the bytes it claimed.
//! - Both race the plan fence scripts; Lua's cjson rewrite of the credits value is accepted by
//!   Rust's read mode with the exact bytes and refused when re-serialised.
//! - Pub/sub envelopes in both directions.
//!
//! Logical database 9, unique prefixes. Skipped with a message when `DIMA_TEST_DRAGONFLY` is not
//! set, when `node` is missing, or when no node-redis install is found (see `record.mjs`).

mod dragonfly_support;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use dima_store::dragonfly::cron_queue::{self, CronQueueConfig, EnqueueCronJobInput};
use dima_store::dragonfly::plan_cache_fence::{
    self, Acceptance, AccountRead, AccountVersion, CreditMode, PlanCacheFence, TtlSeconds,
};
use dima_store::dragonfly::pubsub::{envelope, parse_envelope};
use dima_store::dragonfly::{Dragonfly, End, ListQueue, ProcessingList, QueueItem, Topic};
use dragonfly_support::{AWKWARD_TEXT, cleanup, connect, prefix};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const DB: u8 = 9;
const NOW_ISO: &str = "2026-11-11T12:00:00.000Z";

struct Peer {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl Peer {
    /// Starts the Node peer, or `None` (with a message) when it cannot run here.
    async fn start() -> Result<Option<Self>> {
        if Command::new("node")
            .arg("--version")
            .output()
            .await
            .is_err()
        {
            eprintln!("skipped: `node` is not available");
            return Ok(None);
        }
        let script = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/dragonfly_golden/record.mjs"
        );
        let mut child = Command::new("node")
            .arg(script)
            .arg("peer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("stdout")?).lines();
        let mut peer = Self {
            _child: child,
            stdin,
            stdout,
        };
        match peer
            .call("lrange", json!({"key": "dima-test:interleaved:probe"}))
            .await
        {
            Ok(_) => Ok(Some(peer)),
            Err(error) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = peer._child.stderr.take() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        tokio::io::AsyncReadExt::read_to_string(&mut pipe, &mut stderr),
                    )
                    .await;
                }
                if stderr.contains("node-redis not found") {
                    eprintln!("skipped: no node-redis install found (set DIMABOT_DIR)");
                    return Ok(None);
                }
                bail!("node peer failed to start: {error}; stderr: {stderr}")
            }
        }
    }

    async fn call(&mut self, op: &str, args: Value) -> Result<Value> {
        // Node's readline also ends a line at U+2028 / U+2029, which serde_json leaves raw
        // inside strings: escape them (still the same JSON value).
        let line = serde_json::to_string(&json!({"op": op, "args": args}))?
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        let reply = tokio::time::timeout(Duration::from_secs(15), self.stdout.next_line())
            .await
            .context("node peer did not answer")??
            .context("node peer closed its output")?;
        let reply: Value = serde_json::from_str(&reply)?;
        if reply["ok"] != true {
            bail!("node peer {op} failed: {}", reply["error"]);
        }
        Ok(reply["result"].clone())
    }
}

async fn setup() -> Result<Option<(Dragonfly, Peer)>> {
    let Some(df) = connect(DB).await? else {
        return Ok(None);
    };
    let Some(peer) = Peer::start().await? else {
        return Ok(None);
    };
    Ok(Some((df, peer)))
}

fn unb64(value: &Value) -> Result<Vec<u8>> {
    Ok(base64::engine::general_purpose::STANDARD.decode(value.as_str().context("base64")?)?)
}

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn awkward_data(n: u64) -> Value {
    json!({"reason": "manual_request", "texts": AWKWARD_TEXT, "n": n, "half": 0.5, "big": 1e21,
           "nested": {"b": [true, null], "7": "index"}})
}

/// The same input for both sides: Rust's struct and the JSON Node's `enqueueCronJob` receives.
fn job_input(queue: &str, token: &str, n: u64) -> (EnqueueCronJobInput, Value) {
    let data = awkward_data(n);
    let rust = EnqueueCronJobInput {
        job: "follow-ledger-sync".into(),
        channel_id: Some("123".into()),
        account_id: Some("123".into()),
        requested_by: Some("interleaved 🎉".into()),
        dedupe_token: Some(token.into()),
        dedupe_seconds: Some(120.0),
        data: Some(data.clone()),
        queue_key: Some(queue.into()),
        ..EnqueueCronJobInput::default()
    };
    let node = json!({"job": "follow-ledger-sync", "channelID": "123", "accountID": "123",
        "requestedBy": "interleaved 🎉", "dedupeToken": token, "dedupeSeconds": 120, "data": data, "queueKey": queue});
    (rust, node)
}

#[tokio::test]
async fn node_pushes_and_rust_pops_acknowledges_and_requeues() -> Result<()> {
    let Some((df, mut node)) = setup().await? else {
        return Ok(());
    };
    let p = prefix("interleaved-node-push");
    let queue_key = format!("{p}jobs");
    let mut pushed = Vec::new();
    for n in 1..=3 {
        let (_, input) = job_input(&queue_key, &format!("{p}token-{n}"), n);
        let reply = node
            .call("enqueue", json!({"input": input, "uuid": uuid(n)}))
            .await?;
        ensure!(reply["result"] == 1);
        pushed.push(reply["json"].as_str().context("json")?.as_bytes().to_vec());
    }

    // cron:jobs:queue shape: newest first, destructive pop, requeue at the tail.
    let queue = ListQueue::new(Cow::Owned(queue_key.clone()), End::Left, End::Left);
    let mut blocking = df.blocking();
    let newest = queue
        .blocking_pop(&mut blocking, Duration::from_secs(2))
        .await?
        .context("pop")?;
    ensure!(
        newest.as_bytes() == pushed[2].as_slice(),
        "not the newest, or bytes changed"
    );
    let job = cron_queue::parse_cron_queue_job(&newest, NOW_ISO, "unused")?.context("parse")?;
    ensure!(job.job == "follow-ledger-sync" && job.id == uuid(3));
    queue.push_at(&df, &newest, End::Right).await?;
    let listed = node.call("lrange", json!({"key": queue_key})).await?;
    let listed: Vec<Vec<u8>> = listed
        .as_array()
        .context("list")?
        .iter()
        .map(unb64)
        .collect::<Result<_>>()?;
    ensure!(
        listed == vec![pushed[1].clone(), pushed[0].clone(), pushed[2].clone()],
        "requeued bytes changed"
    );

    // Stream memory shape: claim into a processing list, acknowledge by the claimed bytes.
    let processing = ProcessingList::new(Cow::Owned(format!("{p}processing")), End::Right);
    let claimed = queue
        .blocking_claim(&mut blocking, &processing, Duration::from_secs(2))
        .await?
        .context("claim")?;
    ensure!(claimed.as_bytes() == pushed[1].as_slice());
    ensure!(processing.acknowledge_unfenced(&df, &claimed).await? == 1);
    let left = node
        .call("lrange", json!({"key": processing.key()}))
        .await?;
    ensure!(
        left.as_array().is_some_and(Vec::is_empty),
        "processing entry stuck: {left}"
    );

    node.call("cleanup", json!({"prefix": p})).await?;
    // Dedupe markers live under cron:jobs:dedupe:<token>, outside the prefix.
    cleanup(&df, &format!("cron:jobs:dedupe:{p}")).await?;
    cleanup(&df, &p).await
}

#[tokio::test]
async fn rust_pushes_and_node_claims_and_acknowledges_by_value() -> Result<()> {
    let Some((df, mut node)) = setup().await? else {
        return Ok(());
    };
    let p = prefix("interleaved-rust-push");
    let config = CronQueueConfig::default();

    // Node claims what Rust pushed (BLMOVE + LREM with the claimed bytes, as the worker does).
    let queue = format!("{p}jobs");
    let (input, _) = job_input(&queue, &format!("{p}token-a"), 10);
    let pushed = cron_queue::enqueue_cron_job(&df, &input, config, NOW_ISO, &uuid(10)).await?;
    ensure!(pushed.enqueued);
    let reply = node
        .call(
            "claim_and_ack",
            json!({"queue": queue, "processing": format!("{p}node-processing")}),
        )
        .await?;
    ensure!(reply["removed"] == 1);
    ensure!(unb64(&reply["base64"])? == pushed.job.to_item()?.into_bytes());

    // A raw item Rust encodes from a struct is acknowledged by Node by value too.
    let item = QueueItem::encode(&json!({"id": "raw", "text": AWKWARD_TEXT[1]}))?;
    let raw_queue = format!("{p}raw");
    df.rpush(&raw_queue, &[item.as_bytes()]).await?;
    let reply = node
        .call(
            "claim_and_ack",
            json!({"queue": raw_queue, "processing": format!("{p}raw-processing")}),
        )
        .await?;
    ensure!(reply["removed"] == 1 && unb64(&reply["base64"])? == item.as_bytes());

    node.call("cleanup", json!({"prefix": p})).await?;
    // Dedupe markers live under cron:jobs:dedupe:<token>, outside the prefix.
    cleanup(&df, &format!("cron:jobs:dedupe:{p}")).await?;
    cleanup(&df, &p).await
}

#[tokio::test]
async fn both_race_the_fence_scripts() -> Result<()> {
    let Some((df, mut node)) = setup().await? else {
        return Ok(());
    };
    let p = prefix("interleaved-fence");
    let id = format!("{}chan", p.replace(':', "-"));
    let fence = PlanCacheFence::new(df.clone());
    let versions: Vec<String> = (1..=8)
        .map(|n| plan_cache_fence::plan_cache_version(Some(1_790_000_000_000 + n), Some("evt")))
        .collect::<Result<_, _>>()?;
    let ours: Vec<&String> = versions.iter().step_by(2).collect();
    let theirs: Vec<&String> = versions.iter().skip(1).step_by(2).collect();

    // Both sides raise the fence concurrently; the highest version wins whatever the order.
    let rust_side = futures_util::future::join_all(
        ours.iter()
            .map(|version| fence.invalidate_plan(&id, version, "dima-test-unused-context")),
    );
    let node_side = node.call("fence_invalidate", json!({"id": id, "versions": theirs}));
    let (rust_results, node_results) = tokio::join!(rust_side, node_side);
    for result in rust_results {
        result?;
    }
    node_results?;
    let highest = versions.last().context("versions")?;
    ensure!(
        df.get_text(&plan_cache_fence::plan_cache_fence_key(&id))
            .await?
            .as_ref()
            == Some(highest)
    );

    // Rust's stale write is refused; Node's current write is accepted and Rust reads it fenced.
    ensure!(
        fence
            .write_account(&id, &versions[6], &[("id", id.as_str())])
            .await?
            == Acceptance::Rejected
    );
    let fields = json!([
        ["id", id],
        ["name", AWKWARD_TEXT[3]],
        ["__polar_plan_version", highest]
    ]);
    let written = node
        .call(
            "fence_write",
            json!({"id": id, "version": highest, "fields": fields}),
        )
        .await?;
    ensure!(written == 1);
    let AccountRead::Accepted(snapshot) = fence.read_account(&id).await? else {
        bail!("not accepted")
    };
    ensure!(
        snapshot.field("name") == Some(AWKWARD_TEXT[3]) && snapshot.version() == highest.as_str()
    );
    ensure!(
        fence
            .check_accounts(
                &[AccountVersion {
                    id: &id,
                    version: highest
                }],
                None
            )
            .await?
            == Acceptance::Accepted
    );

    // Rust writes credits; Node's usage script rewrites them with cjson; Rust's read mode accepts
    // exactly those bytes and refuses a re-serialised copy.
    let ttl = TtlSeconds::new(3600)?;
    let credits = dima_text::to_js_json(
        &json!({"version": 2, "available": true, "used": 0, "balance": 5,
        "updatedAt": NOW_ISO, "status": "available", "note": "a/b é"}),
    );
    ensure!(
        fence
            .accept_credits(&id, highest, &credits, CreditMode::Write, false, ttl)
            .await?
            == Acceptance::Accepted
    );
    let applied = node
        .call(
            "apply_usage",
            json!({"id": id, "credits": 2, "marker": format!("{p}usage-marker")}),
        )
        .await?;
    let rewritten = unb64(&applied["stored"])?;
    let raw = df
        .get(&plan_cache_fence::credits_cache_key(&id))
        .await?
        .context("credits")?;
    ensure!(
        raw == rewritten && raw != credits.as_bytes(),
        "cjson did not rewrite the value"
    );
    let raw = String::from_utf8(raw)?;
    ensure!(raw.contains("\\/"), "expected cjson's escaped slash: {raw}");
    ensure!(
        fence
            .accept_credits(&id, highest, &raw, CreditMode::Read, false, ttl)
            .await?
            == Acceptance::Accepted
    );
    let reserialised = dima_text::to_js_json(&serde_json::from_str(&raw)?);
    ensure!(
        fence
            .accept_credits(&id, highest, &reserialised, CreditMode::Read, false, ttl)
            .await?
            == Acceptance::Rejected
    );

    let keys = [
        plan_cache_fence::plan_cache_fence_key(&id),
        plan_cache_fence::account_cache_key(&id),
        plan_cache_fence::credits_cache_key(&id),
        format!("twitch:{id}:ai:exhaust"),
        format!("{id}:ai:exhaust"),
        format!("{id}:accounts-aggregate"),
    ];
    df.del(&keys.iter().map(String::as_str).collect::<Vec<_>>())
        .await?;
    node.call("cleanup", json!({"prefix": p})).await?;
    // Dedupe markers live under cron:jobs:dedupe:<token>, outside the prefix.
    cleanup(&df, &format!("cron:jobs:dedupe:{p}")).await?;
    cleanup(&df, &p).await
}

#[tokio::test]
async fn pubsub_envelopes_cross_both_ways() -> Result<()> {
    let Some((df, mut node)) = setup().await? else {
        return Ok(());
    };
    let now = 1_794_398_400_123.0;
    let data =
        json!({"channelID": "42", "session": AWKWARD_TEXT[1], "texts": AWKWARD_TEXT, "n": 1.0});

    // Rust publishes, Node (PubSubManager.subscribe) receives the bytes its own publish would send.
    let to_node = prefix("interleaved-to-node");
    node.call("subscribe", json!({"channel": to_node})).await?;
    let receivers = df.publish_envelope(&to_node, &data, now).await?;
    ensure!(receivers == 1);
    let received = node
        .call("received", json!({"channel": to_node, "count": 1}))
        .await?;
    let node_envelope = node
        .call("envelope", json!({"data": data, "now": now}))
        .await?;
    ensure!(
        received[0]["raw"] == node_envelope,
        "{} vs {node_envelope}",
        received[0]["raw"]
    );
    ensure!(node_envelope.as_str().map(str::as_bytes) == Some(envelope(&data, now)?.as_slice()));

    // Node publishes, Rust receives and parses.
    let to_rust = prefix("interleaved-to-rust");
    let subscriber = df.subscriber();
    let mut subscription = subscriber
        .subscribe(Topic::Channel(to_rust.clone()))
        .await?;
    node.call(
        "publish_envelope",
        json!({"channel": to_rust, "data": data, "now": now}),
    )
    .await?;
    let message = tokio::time::timeout(Duration::from_secs(2), subscription.recv())
        .await?
        .context("message")?;
    ensure!(message.payload == envelope(&data, now)?);
    let parsed: Value = parse_envelope(&message.payload)?;
    ensure!(parsed["session"] == AWKWARD_TEXT[1] && parsed["timestamp"].as_f64() == Some(now));
    Ok(())
}
