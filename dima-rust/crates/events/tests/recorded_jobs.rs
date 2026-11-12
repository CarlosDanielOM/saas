//! Replays the reference's durable cron-job intent scenario (`jobs` in
//! `tests/fixtures/recorded.json`): every step's answer, every queue publish (keys, and the
//! payload by meaning: the queue bytes are Rust's own), and the final `cron_job_intents`
//! documents field by field. The reference's tokens `uuid-<n>` are the n-th token Rust issues.

mod support;

use anyhow::{Context, Result, anyhow, ensure};
use bson::{Bson, Document, doc};
use dima_core::{ManualClock, Random, RandomError};
use dima_events::jobs::{
    Claim, ClaimResult, DurableJobs, JobError, JobQueue, JobsConfig, PrepareOptions,
};
use dima_events::store::StoreError;
use dima_model::cron_job_intents;
use dima_store::dragonfly::QueueItem;
use dima_store::dragonfly::cron_queue::CronQueueJob;
use futures_util::TryStreamExt;
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use support::{assert_same, document, recorded, with_store};

/// Tokens from a counter: the n-th `uuid_v4` is [`token`]`(n)`.
#[derive(Debug, Default)]
struct Counting(AtomicU8);

impl Random for Counting {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        let n = self.0.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        buf.fill(n);
        Ok(())
    }
}

fn token(n: u8) -> String {
    let random = Counting(AtomicU8::new(n - 1));
    random.uuid_v4().unwrap_or_default()
}

/// The queue stand-in: records each publish, answers with `reply`.
#[derive(Clone, Default)]
struct Recorder {
    calls: Arc<Mutex<Vec<Json>>>,
    reply: Arc<Mutex<bool>>,
}

impl JobQueue for Recorder {
    async fn publish(&self, queue_key: &str, automatic_key: Option<&str>, payload: &QueueItem) -> Result<bool, StoreError> {
        let mut keys = vec![queue_key.to_owned()];
        keys.extend(automatic_key.map(str::to_owned));
        let payload: Json = payload.parse().unwrap_or(Json::Null);
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(json!({ "script": "PUBLISH_DURABLE_CRON_JOB", "keys": keys, "payload": payload }));
        }
        Ok(self.reply.lock().map(|r| *r).unwrap_or(true))
    }

    async fn marker_exists(&self, _: &str) -> Result<bool, StoreError> {
        Ok(false)
    }
}

const QUEUE: &str = "cron:stream-memory:queue";

fn job(id: &str, at_ms: i64) -> CronQueueJob {
    CronQueueJob {
        id: id.into(),
        job: "stream-memory-summary".into(),
        requested_at: dima_text::to_iso_string(at_ms).unwrap_or_default(),
        requested_by: None,
        user_id: None,
        account_id: None,
        channel_id: Some("1001".into()),
        data: Some(json!({ "reason": "manual" })),
        dedupe_key: Some("cron:jobs:dedupe:stream-memory-summary:1001".into()),
    }
}

fn options(seconds: f64, acceptance: Option<&str>, legacy: bool) -> PrepareOptions {
    PrepareOptions {
        dedupe_seconds: seconds,
        acceptance_key: acceptance.map(str::to_owned),
        legacy_accepted: legacy,
    }
}

struct Run {
    tokens: HashMap<String, String>,
    steps: Vec<(String, Json, Vec<Json>)>,
}

impl Run {
    fn job_json(job: &CronQueueJob) -> Json {
        serde_json::to_value(job).unwrap_or(Json::Null)
    }

    fn claim_json(&self, claim: &Claim) -> Json {
        json!({
            "intentId": claim.intent_id,
            "queueKey": claim.queue_key,
            "owner": claim.owner,
            "token": self.tokens.get(&claim.token).cloned().unwrap_or_else(|| claim.token.clone()),
        })
    }

    fn value<T: Into<Answer>, E: std::fmt::Display>(&self, result: Result<T, E>) -> Json {
        match result.map(Into::into) {
            Err(error) => json!({ "error": { "message": error.to_string() } }),
            Ok(Answer::Bool(flag)) => json!(flag),
            Ok(Answer::Prepared(p)) => json!({ "job": Self::job_json(&p.job), "created": p.created, "accepted": p.accepted, "status": p.status }),
            Ok(Answer::Recovered(r)) => json!({ "examined": r.examined, "published": r.published, "uncertain": r.uncertain }),
            Ok(Answer::Claim(ClaimResult::Claimed { job, claim })) => json!({ "status": "claimed", "job": Self::job_json(&job), "claim": self.claim_json(&claim) }),
            Ok(Answer::Claim(ClaimResult::Busy { job })) => json!({ "status": "busy", "job": Self::job_json(&job) }),
            Ok(Answer::Claim(ClaimResult::Terminal { job })) => json!({ "status": "terminal", "job": Self::job_json(&job) }),
        }
    }
}

enum Answer {
    Bool(bool),
    Prepared(dima_events::jobs::Prepared),
    Recovered(dima_events::jobs::Recovered),
    Claim(ClaimResult),
}

impl From<bool> for Answer {
    fn from(flag: bool) -> Self {
        Self::Bool(flag)
    }
}
impl From<dima_events::jobs::Prepared> for Answer {
    fn from(p: dima_events::jobs::Prepared) -> Self {
        Self::Prepared(p)
    }
}
impl From<dima_events::jobs::Recovered> for Answer {
    fn from(r: dima_events::jobs::Recovered) -> Self {
        Self::Recovered(r)
    }
}
impl From<ClaimResult> for Answer {
    fn from(c: ClaimResult) -> Self {
        Self::Claim(c)
    }
}

fn claimed(result: &Result<ClaimResult, CloneableError>) -> Result<Claim> {
    match result {
        Ok(ClaimResult::Claimed { claim, .. }) => Ok(claim.clone()),
        other => Err(anyhow!("expected a claim, got {other:?}")),
    }
}

#[tokio::test]
async fn durable_intents_behave_as_the_reference() -> Result<()> {
    let recording = recorded()?;
    with_store(|store| async move {
        let now = recording["nowMs"].as_i64().context("nowMs")?;
        let clock = ManualClock::new(now);
        let report = support::indexes(&store, &cron_job_intents::INFO).await?;
        let queue = Recorder::default();
        if let Ok(mut reply) = queue.reply.lock() {
            *reply = true;
        }
        let jobs = DurableJobs::new(store.clone(), queue.clone(), Arc::new(clock.clone()), Arc::new(Counting::default()), JobsConfig::default(), &report)?;
        let mut run = Run { tokens: HashMap::new(), steps: Vec::new() };
        for n in 1..=20 {
            run.tokens.insert(token(n), format!("uuid-{n}"));
        }
        macro_rules! step {
            ($name:expr, $call:expr) => {{
                let before = queue.calls.lock().map(|c| c.len()).unwrap_or(0);
                let result = $call;
                let value = run.value(result.clone());
                let calls = queue.calls.lock().map(|c| c[before..].to_vec()).unwrap_or_default();
                run.steps.push(($name.to_owned(), value, calls));
                result
            }};
        }
        let set_reply = |value: bool| {
            if let Ok(mut reply) = queue.reply.lock() {
                *reply = value;
            }
        };
        let a = job("job-a", now);
        let _ = step!("prepare a", jobs.prepare(&a, QUEUE, &options(43200.0, None, false)).await.map_err(clone_error));
        let _ = step!("prepare a duplicate with another id", jobs.prepare(&job("job-a2", now), QUEUE, &options(43200.0, None, false)).await.map_err(clone_error));
        let _ = step!("publish a", jobs.publish(&a, QUEUE).await.map_err(clone_error));
        set_reply(false);
        let _ = step!("publish a while queued", jobs.publish(&a, QUEUE).await.map_err(clone_error));
        set_reply(true);
        let automatic = CronQueueJob {
            dedupe_key: Some("cron:jobs:dedupe:session:auto-1".into()),
            data: Some(json!({ "source": "stream_offline", "sessionID": "s-1" })),
            ..job("job-auto", now)
        };
        let _ = step!("prepare automatic", jobs.prepare(&automatic, QUEUE, &options(43200.0, Some("cron:jobs:accepted:stream-memory-summary:1001:s-1"), false)).await.map_err(clone_error));
        let wrong = CronQueueJob { data: Some(json!({ "source": "stream_offline", "sessionID": "s-9" })), ..job("job-auto-x", now) };
        let _ = step!("prepare automatic with a wrong acceptance key", jobs.prepare(&wrong, QUEUE, &options(60.0, Some("cron:jobs:accepted:x"), false)).await.map_err(clone_error));
        let legacy = CronQueueJob {
            dedupe_key: Some("cron:jobs:dedupe:session:legacy".into()),
            data: Some(json!({ "source": "stream_offline", "sessionID": "s-2" })),
            ..job("job-legacy", now)
        };
        let _ = step!("prepare legacy accepted", jobs.prepare(&legacy, QUEUE, &options(43200.0, Some("cron:jobs:accepted:stream-memory-summary:1001:s-2"), true)).await.map_err(clone_error));
        let claim_a = claimed(&step!("claim a", jobs.claim(&a, QUEUE, "owner-1").await.map_err(clone_error)))?;
        clock.advance(1000);
        let _ = step!("renew a", jobs.renew(&claim_a).await.map_err(clone_error));
        let _ = step!("assert a", jobs.assert_active(&claim_a).await.map_err(clone_error));
        let retried = CronQueueJob { data: Some(json!({ "reason": "manual", "attempt": 2 })), ..a.clone() };
        let _ = step!("retry a in a minute", jobs.retry(&claim_a, &retried, (clock_now(&clock) + 60_000) as f64).await.map_err(clone_error));
        let _ = step!("claim a before it is due", jobs.claim(&a, QUEUE, "owner-2").await.map_err(clone_error));
        clock.advance(61_000);
        let _ = step!("recover publishes a", jobs.recover(QUEUE, 10).await.map_err(clone_error));
        let claim_a2 = claimed(&step!("claim a when due", jobs.claim(&a, QUEUE, "owner-2").await.map_err(clone_error)))?;
        let _ = step!("complete with the old claim", jobs.complete(&claim_a).await.map_err(clone_error));
        let _ = step!("complete a", jobs.complete(&claim_a2).await.map_err(clone_error));
        let _ = step!("claim a after completion", jobs.claim(&a, QUEUE, "owner-3").await.map_err(clone_error));
        let _ = step!("claim legacy payload adopts it", jobs.claim(&legacy, QUEUE, "owner-4").await.map_err(clone_error));
        let claim_auto = claimed(&step!("claim automatic", jobs.claim(&automatic, QUEUE, "owner-5").await.map_err(clone_error)))?;
        let _ = step!("dead automatic", jobs.dead(&claim_auto, "boom").await.map_err(clone_error));
        clock.advance(5 * 60_000 + 1);
        let _ = step!("recover marks the stale legacy lease uncertain", jobs.recover(QUEUE, 10).await.map_err(clone_error));
        let at = clock_now(&clock);
        let later = CronQueueJob {
            dedupe_key: Some("cron:jobs:dedupe:later".into()),
            data: Some(json!({ "notBeforeUnix": at.div_euclid(1000) + 120 })),
            ..job("job-later", at)
        };
        let _ = step!("prepare a job due later", jobs.prepare(&later, QUEUE, &options(60.0, None, false)).await.map_err(clone_error));
        let _ = step!("publish before due", jobs.publish(&later, QUEUE).await.map_err(clone_error));
        let adopted = CronQueueJob { dedupe_key: None, job: "memory-maintenance-weekly".into(), data: None, ..job("job-adopted", at) };
        let claim_adopted = claimed(&step!("claim unknown job adopts it", jobs.claim(&adopted, QUEUE, "owner-6").await.map_err(clone_error)))?;
        let _ = step!("uncertain adopted", jobs.uncertain(&claim_adopted, "external effect unknown").await.map_err(clone_error));
        clock.advance(121_000);
        let _ = step!("recover publishes the later job", jobs.recover(QUEUE, 10).await.map_err(clone_error));
        let claim_later = claimed(&step!("claim later", jobs.claim(&later, QUEUE, "owner-7").await.map_err(clone_error)))?;
        let _ = step!("complete later", jobs.complete(&claim_later).await.map_err(clone_error));
        let at = clock_now(&clock);
        let later2 = CronQueueJob { dedupe_key: Some("cron:jobs:dedupe:later".into()), ..job("job-later-2", at) };
        let _ = step!("new job reuses an expired dedupe key", jobs.prepare(&later2, QUEUE, &options(60.0, None, false)).await.map_err(clone_error));
        let _ = step!("invalid recovery scope", jobs.recover(QUEUE, 0).await.map_err(clone_error));
        let _ = step!("invalid dedupe duration", jobs.prepare(&job("job-z", at), QUEUE, &options(0.0, None, false)).await.map_err(clone_error));

        // Compare with the recording.
        let intents: Vec<Document> = store.documents(cron_job_intents::COLLECTION).find(doc! {}).sort(doc! { "jobID": 1 }).await?.try_collect().await?;
        let recorded_intents: Vec<Document> = recording["jobs"]["intents"].as_array().context("intents")?.iter().map(document).collect::<Result<_>>()?;
        let job_of = |documents: &[Document]| -> HashMap<String, String> {
            documents.iter().filter_map(|d| Some((d.get_object_id("_id").ok()?.to_hex(), d.get_str("jobID").ok()?.to_owned()))).collect()
        };
        let (rust_ids, ts_ids) = (job_of(&intents), job_of(&recorded_intents));
        let steps = recording["jobs"]["steps"].as_array().context("steps")?;
        ensure!(steps.len() == run.steps.len(), "{} steps recorded, {} run", steps.len(), run.steps.len());
        for (recorded_step, (name, value, calls)) in steps.iter().zip(&run.steps) {
            ensure!(recorded_step["name"] == json!(name), "step order: {name}");
            let mut expected = recorded_step["value"].clone();
            let mut actual = value.clone();
            for (v, ids) in [(&mut expected, &ts_ids), (&mut actual, &rust_ids)] {
                if let Some(id) = v.pointer_mut("/claim/intentId") {
                    *id = json!(id.as_str().and_then(|i| ids.get(i)).cloned());
                }
                if let Some(error) = v.get_mut("error") {
                    *error = json!({ "message": error["message"] });
                }
            }
            ensure!(expected == actual, "{name}\n  expected {expected}\n  actual   {actual}");
            let expected_calls: Vec<Json> = recorded_step["calls"].as_array().cloned().unwrap_or_default().into_iter().map(|call| {
                let payload = call["arguments"][0].as_str().and_then(|p| serde_json::from_str::<Json>(p).ok()).unwrap_or(Json::Null);
                ensure!(call["arguments"][1] == json!("1000"), "{name}: scan limit");
                Ok(json!({ "script": call["script"], "keys": call["keys"], "payload": payload }))
            }).collect::<Result<_>>()?;
            ensure!(&expected_calls == calls, "{name}: queue calls\n  expected {expected_calls:?}\n  actual   {calls:?}");
        }
        ensure!(intents.len() == recorded_intents.len(), "{} intents, {} recorded", intents.len(), recorded_intents.len());
        for (want, got) in recorded_intents.iter().zip(&intents) {
            let mut want = want.clone();
            let mut got = got.clone();
            want.insert("_id", "generated");
            got.insert("_id", "generated");
            let name = want.get_str("jobID").unwrap_or_default().to_owned();
            assert_same(&Bson::Document(want), &Bson::Document(got), &name)?;
        }
        Ok(())
    })
    .await
}

fn clock_now(clock: &ManualClock) -> i64 {
    dima_core::Clock::now_ms(clock)
}

/// The step results are compared as text; errors are not `Clone`.
fn clone_error(error: JobError) -> CloneableError {
    CloneableError(error.to_string())
}

#[derive(Clone, Debug)]
struct CloneableError(String);

impl std::fmt::Display for CloneableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
