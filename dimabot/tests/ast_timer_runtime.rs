#![cfg(feature = "ast-bot-runtime")]
//! Behavioural checks for the native AST timer runtime
//! (`dimabot/src/utils/ast_timer_runtime.ts` port).
//!
//! Every test uses an in-memory fake of the [`AstTimerStore`] seam that
//! reproduces the source Lua sequence step by step: prune stale scores, apply
//! both caps, write the payload and both index entries, and consume on claim.
//! Nothing here talks to Dragonfly, MongoDB, the network or Docker.
//!
//! The fake cannot prove `EVAL` atomicity itself; that property lives in
//! [`ENQUEUE_TIMER_JOB_SCRIPT`] / [`CLAIM_TIMER_JOB_SCRIPT`], which are kept
//! verbatim from the source and are guarded by
//! `scripts_keep_the_source_atomicity_and_ordering`. Cross-instance at-most-once
//! is a property of the single-round-trip script and is therefore listed as an
//! open verification gap in the lane note, not claimed here.

use dima_rust::utils::ast_evaluator::{
    Context, EffectToken, ExecutionContext, JsString, JsValue, LoopVars,
};
use dima_rust::utils::ast_syntax::AstNode;
use dima_rust::utils::ast_timer_runtime::{
    AST_TIMER_CHANNEL_PREFIX, AST_TIMER_INDEX, AST_TIMER_JOB_PREFIX, AST_TIMER_JOB_VERSION,
    AstTimerClock, AstTimerError, AstTimerIdSource, AstTimerScheduler, AstTimerStore,
    CLAIM_TIMER_JOB_SCRIPT, ClaimOutcome, ENQUEUE_TIMER_JOB_SCRIPT, MAX_CHANNEL_TIMERS,
    MAX_JOB_BYTES, MAX_PENDING_TIMERS, PendingTimer, RECONCILE_MS, TIMER_GRACE_MS, TimerEnqueue,
    TimerNamespace, enqueue_ast_timer,
};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
};

/// Fixed wall clock: 2026-10-31T00:00:00.000Z.
const NOW: i64 = 1_793_462_400_000;

fn body() -> AstNode {
    AstNode::Root {
        children: vec![AstNode::Literal {
            value: "5 minutes over!".into(),
        }],
    }
}

fn context(channel: &str) -> Context {
    let mut execution = ExecutionContext::default();
    execution.broadcaster_id = channel.to_owned();
    execution.user_id = "viewer".to_owned();
    execution.user_login = "viewer_login".to_owned();
    execution.user_display_name = "Viewer".to_owned();
    execution.into_context()
}

struct FakeClock {
    now: Cell<i64>,
}

impl FakeClock {
    fn new(now_ms: i64) -> Self {
        Self {
            now: Cell::new(now_ms),
        }
    }

    fn set(&self, now_ms: i64) {
        self.now.set(now_ms);
    }
}

impl AstTimerClock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
}

#[derive(Default)]
struct CountingIds {
    issued: u32,
}

impl AstTimerIdSource for CountingIds {
    fn next_id(&mut self) -> String {
        self.issued += 1;
        format!("timer-{:04}", self.issued)
    }
}

/// In-memory Dragonfly substitute. The index sets keep `(score, member)` order so
/// score pruning and pending order match the source `ZSET` behaviour.
#[derive(Default)]
struct FakeStore {
    namespace: TimerNamespace,
    jobs: BTreeMap<String, String>,
    pending: BTreeSet<(i64, String)>,
    channels: BTreeMap<String, BTreeSet<(i64, String)>>,
    channel_ttl_ms: BTreeMap<String, i64>,
    enqueues: usize,
    claims: usize,
}

impl FakeStore {
    fn new() -> Self {
        Self {
            namespace: TimerNamespace::source(),
            ..Self::default()
        }
    }

    fn channel_key(&self, channel_id: &str) -> String {
        self.namespace.channel_key(channel_id)
    }

    fn payload(&self, id: &str) -> Option<&String> {
        self.jobs.get(&self.namespace.job_key(id))
    }

    fn pending_ids(&self) -> Vec<String> {
        self.pending.iter().map(|(_, id)| id.clone()).collect()
    }

    fn channel_ids(&self, channel_id: &str) -> Vec<String> {
        self.channels
            .get(&self.channel_key(channel_id))
            .map(|set| set.iter().map(|(_, id)| id.clone()).collect())
            .unwrap_or_default()
    }

    fn channel_ttl(&self, channel_id: &str) -> Option<i64> {
        self.channel_ttl_ms.get(&self.channel_key(channel_id)).copied()
    }

    fn seed_pending(&mut self, id: &str, due_at_ms: i64) {
        self.pending.insert((due_at_ms, id.to_owned()));
    }

    fn seed_channel(&mut self, channel_id: &str, id: &str, expires_at_ms: i64) {
        self.channels
            .entry(self.channel_key(channel_id))
            .or_default()
            .insert((expires_at_ms, id.to_owned()));
    }
}

impl AstTimerStore for FakeStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        self.enqueues += 1;
        let job_key = self.namespace.job_key(request.id);
        let channel_key = self.namespace.channel_key(request.channel_id);
        // ENQUEUE steps 1-2: prune stale scores before the caps are read.
        self.pending
            .retain(|(score, _)| *score > request.now_ms - TIMER_GRACE_MS);
        if let Some(channel) = self.channels.get_mut(&channel_key) {
            channel.retain(|(score, _)| *score > request.now_ms);
        }
        // ENQUEUE step 3: per-channel and global caps.
        let channel_len = self
            .channels
            .get(&channel_key)
            .map_or(0, |channel| channel.len());
        if self.pending.len() >= MAX_PENDING_TIMERS || channel_len >= MAX_CHANNEL_TIMERS {
            return Ok(false);
        }
        // ENQUEUE steps 4-7: payload, global score (dueAt), channel score
        // (expiresAt), then the channel TTL at its highest score.
        self.jobs.insert(job_key, request.payload.to_owned());
        self.pending.insert((request.due_at_ms, request.id.to_owned()));
        let channel = self.channels.entry(channel_key.clone()).or_default();
        channel.insert((request.expires_at_ms, request.id.to_owned()));
        let ttl = channel
            .iter()
            .next_back()
            .map(|(score, _)| *score)
            .unwrap_or(request.expires_at_ms);
        self.channel_ttl_ms.insert(channel_key, ttl);
        Ok(true)
    }

    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError> {
        Ok(self.jobs.get(&self.namespace.job_key(id)).cloned())
    }

    async fn claim(
        &mut self,
        id: &str,
        channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError> {
        self.claims += 1;
        let job_key = self.namespace.job_key(id);
        let channel_key = self.namespace.channel_key(channel_id);
        let Some(raw) = self.jobs.get(&job_key).cloned() else {
            // CLAIM line 2: no payload, only the global index entry is cleared.
            self.pending.retain(|(_, member)| member != id);
            return Ok(None);
        };
        let wire: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
            AstTimerError::JobDecoding {
                message: error.to_string(),
            }
        })?;
        let due_at = wire.get("dueAt").and_then(serde_json::Value::as_i64);
        let expires_at = wire.get("expiresAt").and_then(serde_json::Value::as_i64);
        // CLAIM line 4: a future job is left untouched.
        if due_at.unwrap_or(i64::MAX) > now_ms {
            return Ok(None);
        }
        // CLAIM lines 5-7: consume the payload and both index entries first.
        self.jobs.remove(&job_key);
        self.pending.retain(|(_, member)| member != id);
        if let Some(channel) = self.channels.get_mut(&channel_key) {
            channel.retain(|(_, member)| member != id);
        }
        // CLAIM line 8: past the grace window, the consumed job is dropped.
        if expires_at.unwrap_or(i64::MIN) <= now_ms {
            return Ok(None);
        }
        Ok(Some(raw))
    }

    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError> {
        let before = self.pending.len();
        self.pending.retain(|(score, _)| *score > max_score_ms);
        Ok(before - self.pending.len())
    }

    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        Ok(self
            .pending
            .iter()
            .take(limit)
            .map(|(score, id)| PendingTimer {
                id: id.clone(),
                due_at_ms: *score,
            })
            .collect())
    }

    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError> {
        let before = self.pending.len();
        self.pending.retain(|(_, member)| member != id);
        Ok(before != self.pending.len())
    }
}

fn decoded_payload(payload: &str) -> serde_json::Value {
    serde_json::from_str(payload).expect("stored timer payload must be JSON")
}

#[test]
fn source_limits_and_keys_are_preserved() {
    assert_eq!(AST_TIMER_INDEX, "ast:timers:pending");
    assert_eq!(AST_TIMER_JOB_PREFIX, "ast:timers:job:");
    assert_eq!(AST_TIMER_CHANNEL_PREFIX, "ast:timers:channel:");
    assert_eq!(AST_TIMER_JOB_VERSION, 1);
    assert_eq!(MAX_CHANNEL_TIMERS, 100);
    assert_eq!(MAX_PENDING_TIMERS, 10_000);
    assert_eq!(MAX_JOB_BYTES, 64 * 1024);
    assert_eq!(RECONCILE_MS, 2_000);
    assert_eq!(TIMER_GRACE_MS, 10 * 60 * 1000);

    let namespace = TimerNamespace::source();
    assert_eq!(namespace.job_key("abc"), "ast:timers:job:abc");
    assert_eq!(namespace.channel_key("42"), "ast:timers:channel:42");
    assert_eq!(TimerNamespace::default(), namespace);
}

#[test]
fn scripts_keep_the_source_atomicity_and_ordering() {
    // Caps are read after the stale-score prune inside the same script.
    assert!(ENQUEUE_TIMER_JOB_SCRIPT.contains(
        "if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) or redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[8]) then return 0 end"
    ));
    assert!(ENQUEUE_TIMER_JOB_SCRIPT.contains(
        "redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[4])"
    ));
    assert!(ENQUEUE_TIMER_JOB_SCRIPT.contains(
        "redis.call('PEXPIREAT', KEYS[3], redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')[2])"
    ));
    let prune = ENQUEUE_TIMER_JOB_SCRIPT
        .find("ZREMRANGEBYSCORE")
        .expect("enqueue must prune stale scores");
    let cap = ENQUEUE_TIMER_JOB_SCRIPT
        .find("ZCARD")
        .expect("enqueue must apply both caps");
    assert!(
        prune < cap,
        "stale index entries must be pruned before the caps are read"
    );
    let set = ENQUEUE_TIMER_JOB_SCRIPT.find("'SET'").expect("payload write");
    let zadd = ENQUEUE_TIMER_JOB_SCRIPT.find("ZADD").expect("index write");
    let ttl = ENQUEUE_TIMER_JOB_SCRIPT
        .find("PEXPIREAT")
        .expect("channel index TTL");
    assert!(
        set < zadd && zadd < ttl,
        "payload and both index entries are written in the one script"
    );

    // Consume before executing: the due check gates the delete, and the expiry
    // outcome is reported only after the job has been consumed.
    let due = CLAIM_TIMER_JOB_SCRIPT
        .find("job.dueAt > tonumber(ARGV[2])")
        .expect("claim must check the due instant");
    let delete = CLAIM_TIMER_JOB_SCRIPT
        .find("redis.call('DEL', KEYS[1])")
        .expect("claim must delete the payload");
    let expiry = CLAIM_TIMER_JOB_SCRIPT
        .find("job.expiresAt <= tonumber(ARGV[2])")
        .expect("claim must drop expired jobs");
    assert!(due < delete, "a future job must not be consumed");
    assert!(
        delete < expiry,
        "the job is consumed before the expiry outcome is reported"
    );
    assert!(CLAIM_TIMER_JOB_SCRIPT.contains("return raw"));
}

#[tokio::test]
async fn enqueue_writes_payload_and_both_index_entries() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-enqueue");

    let job = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect("enqueue must succeed");

    assert_eq!(job.version, AST_TIMER_JOB_VERSION);
    assert_eq!(job.id, "timer-0001");
    assert_eq!(job.due_at, NOW + 60_000);
    assert_eq!(job.expires_at, job.due_at + TIMER_GRACE_MS);
    assert_eq!(store.enqueues, 1);

    let payload = store.payload(&job.id).expect("payload must be stored");
    let wire = decoded_payload(payload);
    assert_eq!(wire["version"], serde_json::json!(1));
    assert_eq!(wire["id"], serde_json::json!("timer-0001"));
    assert_eq!(wire["dueAt"], serde_json::json!(NOW + 60_000));
    assert_eq!(wire["expiresAt"], serde_json::json!(job.expires_at));
    assert_eq!(wire["body"]["type"], serde_json::json!("root"));
    assert_eq!(
        wire["body"]["children"][0]["value"],
        serde_json::json!("5 minutes over!")
    );
    assert_eq!(
        wire["context"]["broadcasterId"],
        serde_json::json!("chan-enqueue")
    );
    assert_eq!(wire["context"]["timerDepth"], serde_json::json!(1));

    assert_eq!(store.pending_ids(), vec!["timer-0001".to_owned()]);
    assert_eq!(store.channel_ids("chan-enqueue"), vec!["timer-0001".to_owned()]);
    assert_eq!(store.channel_ttl("chan-enqueue"), Some(job.expires_at));
}

#[tokio::test]
async fn enqueue_rejects_when_the_channel_cap_is_reached() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-cap");

    for _ in 0..MAX_CHANNEL_TIMERS {
        enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
            .await
            .expect("every timer below the channel cap is accepted");
    }
    assert_eq!(store.pending_ids().len(), MAX_CHANNEL_TIMERS);

    let error = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect_err("the channel cap must reject the next timer");
    match &error {
        AstTimerError::PendingLimitReached { channel_id } => {
            assert_eq!(channel_id, "chan-cap");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(error.to_string().contains("Pending timer limit reached"));
    assert_eq!(store.pending_ids().len(), MAX_CHANNEL_TIMERS);
    assert_eq!(store.jobs.len(), MAX_CHANNEL_TIMERS);
}

#[tokio::test]
async fn enqueue_rejects_when_the_global_cap_is_reached() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let per_channel = MAX_CHANNEL_TIMERS;
    for channel in 0..(MAX_PENDING_TIMERS / per_channel) {
        for slot in 0..per_channel {
            store.seed_pending(&format!("seed-{channel}-{slot}"), NOW + 60_000);
        }
    }
    assert_eq!(store.pending_ids().len(), MAX_PENDING_TIMERS);

    // A fresh channel is below its own cap, so only the global cap can reject.
    let channel = context("chan-global");
    let error = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect_err("the global cap must reject the next timer");
    match &error {
        AstTimerError::PendingLimitReached { channel_id } => {
            assert_eq!(channel_id, "chan-global");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(store.pending_ids().len(), MAX_PENDING_TIMERS);
    assert!(store.channel_ids("chan-global").is_empty());
}

#[tokio::test]
async fn enqueue_prunes_stale_scores_before_applying_the_caps() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-stale");
    // A full channel index of dead entries, as left behind when the payload
    // expired while the bot was offline.
    for slot in 0..MAX_CHANNEL_TIMERS {
        store.seed_pending(&format!("stale-{slot}"), NOW - TIMER_GRACE_MS - 1);
        store.seed_channel("chan-stale", &format!("stale-{slot}"), NOW - 1);
    }
    assert_eq!(store.channel_ids("chan-stale").len(), MAX_CHANNEL_TIMERS);

    let job = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect("stale entries must not lock the channel");
    assert_eq!(store.channel_ids("chan-stale"), vec![job.id.clone()]);
    assert_eq!(store.pending_ids(), vec![job.id]);
}

#[tokio::test]
async fn enqueue_rejects_a_payload_over_64_kib() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-big");
    channel
        .borrow_mut()
        .variables
        .borrow_mut()
        .insert("payload".to_owned(), JsValue::string("x".repeat(MAX_JOB_BYTES)));

    let error = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect_err("an oversized context must be rejected");
    match &error {
        AstTimerError::PayloadTooLarge { bytes } => assert!(*bytes > MAX_JOB_BYTES),
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(error.to_string().contains("Timer context exceeds 64 KiB"));
    assert_eq!(store.enqueues, 0, "nothing may reach the store");
    assert!(store.pending_ids().is_empty());
    assert!(store.jobs.is_empty());
}

#[tokio::test]
async fn expiry_is_due_plus_the_ten_minute_grace() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-grace");

    let whole = enqueue_ast_timer(&mut store, &clock, &mut ids, 300.0, &body(), &channel)
        .await
        .expect("whole seconds");
    assert_eq!(whole.due_at, NOW + 300_000);
    assert_eq!(whole.expires_at - whole.due_at, TIMER_GRACE_MS);

    let fractional = enqueue_ast_timer(&mut store, &clock, &mut ids, 0.5, &body(), &channel)
        .await
        .expect("fractional seconds");
    assert_eq!(fractional.due_at, NOW + 500);
    assert_eq!(fractional.expires_at - fractional.due_at, TIMER_GRACE_MS);
    assert_eq!(fractional.expires_at, fractional.due_at + 600_000);
}

#[tokio::test]
async fn claim_consumes_the_payload_and_both_index_entries() {
    let clock = FakeClock::new(NOW);
    let ids = CountingIds::default();
    let mut scheduler = AstTimerScheduler::new(FakeStore::new(), clock, ids);
    scheduler.start().await.expect("scheduler start");
    let channel = context("chan-claim");

    let job = scheduler
        .schedule(60.0, &body(), &channel)
        .await
        .expect("schedule must succeed");
    assert!(scheduler.is_armed(&job.id));
    assert_eq!(scheduler.next_deadline_ms(), Some(job.due_at));

    scheduler.clock().set(job.due_at);
    let now = scheduler.clock().now_ms();
    let outcome = scheduler.fire(&job.id, now).await.expect("claim");
    let claimed = match outcome {
        ClaimOutcome::Claimed(claimed) => claimed,
        other => panic!("unexpected outcome: {other:?}"),
    };
    assert_eq!(claimed.id, job.id);
    assert_eq!(claimed.version, AST_TIMER_JOB_VERSION);
    assert_eq!(claimed.body, body());
    assert_eq!(claimed.channel_id().expect("channel id"), "chan-claim");
    match claimed.context.get("broadcasterId") {
        JsValue::String(value) => assert_eq!(
            value.to_utf8().expect("broadcasterId is UTF-8"),
            "chan-claim"
        ),
        other => panic!("broadcasterId must be a string, found {other:?}"),
    }

    // At most once: the payload and both index entries are gone.
    assert!(scheduler.store().payload(&job.id).is_none());
    assert!(scheduler.store().pending_ids().is_empty());
    assert!(scheduler.store().channel_ids("chan-claim").is_empty());
    assert!(!scheduler.is_armed(&job.id));

    let second = scheduler.fire(&job.id, now).await.expect("second claim");
    assert!(
        matches!(second, ClaimOutcome::Missing),
        "a second claim must find nothing: {second:?}"
    );
    assert_eq!(scheduler.store().claims, 2);
}

#[tokio::test]
async fn claim_leaves_a_job_that_is_not_yet_due() {
    let clock = FakeClock::new(NOW);
    let ids = CountingIds::default();
    let mut scheduler = AstTimerScheduler::new(FakeStore::new(), clock, ids);
    scheduler.start().await.expect("scheduler start");
    let channel = context("chan-early");
    let job = scheduler
        .schedule(60.0, &body(), &channel)
        .await
        .expect("schedule must succeed");

    let outcome = scheduler
        .fire(&job.id, NOW + 59_999)
        .await
        .expect("claim attempt");
    assert!(
        matches!(outcome, ClaimOutcome::NotYetDue),
        "unexpected outcome: {outcome:?}"
    );
    assert!(scheduler.store().payload(&job.id).is_some());
    assert_eq!(scheduler.store().pending_ids(), vec![job.id.clone()]);
    assert_eq!(scheduler.store().channel_ids("chan-early"), vec![job.id]);
}

#[tokio::test]
async fn claim_drops_a_job_past_the_grace_window() {
    let clock = FakeClock::new(NOW);
    let ids = CountingIds::default();
    let mut scheduler = AstTimerScheduler::new(FakeStore::new(), clock, ids);
    scheduler.start().await.expect("scheduler start");
    let channel = context("chan-late");
    let job = scheduler
        .schedule(60.0, &body(), &channel)
        .await
        .expect("schedule must succeed");

    // Exactly at expiresAt the job is no longer deliverable.
    let outcome = scheduler
        .fire(&job.id, job.expires_at)
        .await
        .expect("claim attempt");
    assert!(
        matches!(outcome, ClaimOutcome::Expired),
        "unexpected outcome: {outcome:?}"
    );
    assert!(scheduler.store().payload(&job.id).is_none());
    assert!(scheduler.store().pending_ids().is_empty());
    assert!(scheduler.store().channel_ids("chan-late").is_empty());
}

#[tokio::test]
async fn snapshot_crossing_the_cache_has_no_effect_authority() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-authority");
    {
        let mut execution = channel.borrow_mut();
        execution.effect_context = Some(EffectToken::from_host(String::from(
            "live-effect-authority",
        )));
        execution.timer_depth = Some(2.0);
        execution.enforce_function_permissions = true;
        execution.authorization = JsValue::object(vec![("origin".into(), JsValue::string("llm"))]);
        execution
            .variables
            .borrow_mut()
            .insert("name".to_owned(), JsValue::string("Original"));
        let loop_vars = LoopVars::default();
        loop_vars.insert("i".to_owned(), JsString::from("3"));
        execution.loop_vars = Some(loop_vars);
    }

    let job = enqueue_ast_timer(&mut store, &clock, &mut ids, 60.0, &body(), &channel)
        .await
        .expect("enqueue must succeed");

    let payload = store.payload(&job.id).expect("payload must be stored");
    assert!(
        !payload.contains("effect"),
        "effect authority must not cross the cache boundary: {payload}"
    );
    let wire = decoded_payload(payload);
    let saved = &wire["context"];
    assert!(saved.get("effectContext").is_none());
    assert!(saved.get("effectiveArgument").is_none());
    assert_eq!(saved["broadcasterId"], serde_json::json!("chan-authority"));
    // The snapshot rule from timer.ts: depth is incremented by one.
    assert_eq!(saved["timerDepth"], serde_json::json!(3));
    assert_eq!(saved["enforceFunctionPermissions"], serde_json::json!(true));
    assert_eq!(saved["authorization"]["origin"], serde_json::json!("llm"));
    assert_eq!(saved["variables"], serde_json::json!([["name", "Original"]]));
    assert_eq!(saved["loopVars"], serde_json::json!([["i", "3"]]));
    // The in-memory job carries the same data-only snapshot.
    assert!(matches!(job.context.get("effectContext"), JsValue::Undefined));
}

#[tokio::test]
async fn reconcile_recovers_cached_jobs_and_prunes_stale_scores() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-recover");
    // A parser consumer enqueues without arming; this is the restart case.
    let job = enqueue_ast_timer(&mut store, &clock, &mut ids, 120.0, &body(), &channel)
        .await
        .expect("enqueue must succeed");
    store.seed_pending("stale-timer", NOW - TIMER_GRACE_MS - 1);
    assert_eq!(store.pending_ids().len(), 2);

    let mut scheduler = AstTimerScheduler::new(store, clock, ids);
    assert!(scheduler.is_stopped());
    assert_eq!(scheduler.armed_len(), 0);

    scheduler.start().await.expect("scheduler start");
    assert!(!scheduler.is_stopped());
    assert_eq!(scheduler.armed_len(), 1);
    assert!(scheduler.is_armed(&job.id));
    assert_eq!(scheduler.next_deadline_ms(), Some(job.due_at));
    assert_eq!(scheduler.store().pending_ids(), vec![job.id.clone()]);
    // The cadence, not the far-future deadline, is the first wake target.
    assert_eq!(scheduler.next_wake_ms(NOW), NOW + RECONCILE_MS);

    // Reconcile is idempotent: a second pass does not re-arm twice.
    scheduler.reconcile().await.expect("reconcile");
    assert_eq!(scheduler.armed_len(), 1);
    assert_eq!(scheduler.next_deadline_ms(), Some(job.due_at));
}

#[tokio::test]
async fn step_delivers_due_jobs_before_sleeping_and_keeps_the_cadence() {
    let clock = FakeClock::new(NOW);
    let ids = CountingIds::default();
    let mut scheduler = AstTimerScheduler::new(FakeStore::new(), clock, ids);
    scheduler.start().await.expect("scheduler start");
    let channel = context("chan-step");
    let job = scheduler
        .schedule(30.0, &body(), &channel)
        .await
        .expect("schedule must succeed");

    // Nothing is due yet: the pass reports the reconcile cadence as its wake.
    let idle = scheduler.step().await.expect("step").expect("running");
    assert!(idle.jobs.is_empty());
    assert_eq!(idle.wake_ms, NOW + RECONCILE_MS);

    // The due job is delivered by the pass itself, not delayed to a poll.
    scheduler.clock().set(job.due_at);
    let due = scheduler.step().await.expect("step").expect("running");
    assert_eq!(due.jobs.len(), 1);
    assert_eq!(due.jobs[0].id, job.id);
    assert_eq!(due.jobs[0].body, body());
    // The wake instant is the next real deadline and is never in the past.
    assert!(due.wake_ms >= job.due_at);
    assert_eq!(due.wake_ms, job.due_at + RECONCILE_MS);

    // A due job that is already armed wakes immediately, not after the cadence.
    scheduler
        .schedule(0.0, &body(), &channel)
        .await
        .expect("immediate timer");
    let ready = scheduler.next_wake_ms(scheduler.clock().now_ms());
    assert_eq!(ready, scheduler.clock().now_ms());

    scheduler.stop();
    assert!(scheduler.step().await.expect("stopped step").is_none());
}

#[tokio::test]
async fn non_finite_seconds_are_rejected_without_writing() {
    let clock = FakeClock::new(NOW);
    let mut ids = CountingIds::default();
    let mut store = FakeStore::new();
    let channel = context("chan-nan");

    for seconds in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let error = enqueue_ast_timer(&mut store, &clock, &mut ids, seconds, &body(), &channel)
            .await
            .expect_err("non-finite seconds have no due instant");
        assert!(
            matches!(error, AstTimerError::InvalidDuration { .. }),
            "unexpected error: {error:?}"
        );
    }
    assert_eq!(store.enqueues, 0);
    assert!(store.pending_ids().is_empty());
    assert!(store.jobs.is_empty());
}
