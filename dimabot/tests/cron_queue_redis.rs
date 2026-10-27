//! Ignored integration suite: the lead supplies an isolated, disposable Redis.
//! Required: CRON_QUEUE_REDIS_FIXTURE_URI=redis://fixture-redis:6379/0 and
//! CRON_QUEUE_REDIS_FIXTURE_ACK=disposable. Optional namespace stem:
//! CRON_QUEUE_REDIS_FIXTURE_PREFIX (a random suffix is always appended).
//! No production env fallback, fixture/container creation, FLUSHDB, or SCAN.
//! Every touched key is registered before mutation and deleted even when a
//! scenario returns an error or hits its bounded timeout. Acceptance markers
//! intentionally have no TTL; they are registered too. This suite must only be
//! executed by the lead inside its capped validation/fixture environment.
#![cfg(feature = "cron-queue")]

use std::{collections::BTreeSet, time::Duration};

use dima_rust::utils::cron_queue::{
    self, CronQueueClock, CronQueueConfig, CronQueueJob, EnqueueCronJobInput, EnqueueCronJobResult,
    RandomUuidSource, RedisCronQueue,
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct Clock;
impl CronQueueClock for Clock {
    fn now_iso(&mut self) -> String {
        "2026-10-22T12:34:56.789Z".into()
    }
}

struct Fixture {
    client: redis::Client,
    connection: ConnectionManager,
    queue: RedisCronQueue,
    prefix: String,
    owned: BTreeSet<String>,
}

fn check(condition: bool, message: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(std::io::Error::other(message).into())
    }
}

fn input(value: Value) -> TestResult<EnqueueCronJobInput> {
    Ok(serde_json::from_value(value)?)
}

impl Fixture {
    fn key(&mut self, name: &str) -> String {
        let key = format!("{}:{name}", self.prefix);
        self.owned.insert(key.clone());
        key
    }

    fn record(&mut self, input: &EnqueueCronJobInput) -> TestResult<Vec<String>> {
        let prepared = cron_queue::prepare_enqueue_cron_job(
            input,
            CronQueueConfig::default(),
            &mut Clock,
            &mut RandomUuidSource,
        )?;
        let keys = prepared
            .command
            .map(|command| command.keys)
            .unwrap_or_default();
        self.owned.extend(keys.iter().cloned());
        Ok(keys)
    }

    async fn enqueue(&mut self, input: &EnqueueCronJobInput) -> TestResult<EnqueueCronJobResult> {
        self.record(input)?;
        Ok(self
            .queue
            .enqueue_cron_job(input, &mut Clock, &mut RandomUuidSource)
            .await?)
    }

    async fn exists(&mut self, key: &str) -> TestResult<bool> {
        Ok(redis::cmd("EXISTS")
            .arg(key)
            .query_async::<i64>(&mut self.connection)
            .await?
            == 1)
    }

    async fn length(&mut self, key: &str) -> TestResult<i64> {
        Ok(redis::cmd("LLEN")
            .arg(key)
            .query_async(&mut self.connection)
            .await?)
    }

    async fn set(&mut self, key: &str) -> TestResult {
        self.owned.insert(key.to_owned());
        let _: () = redis::cmd("SET")
            .arg(key)
            .arg("wrong-type-or-marker")
            .arg("EX")
            .arg(120)
            .query_async(&mut self.connection)
            .await?;
        Ok(())
    }

    async fn delete(&mut self, key: &str) -> TestResult {
        check(
            self.owned.contains(key),
            "refusing to delete an unregistered fixture key",
        )?;
        let _: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut self.connection)
            .await?;
        Ok(())
    }

    async fn cleanup(&mut self) -> TestResult {
        if !self.owned.is_empty() {
            let mut command = redis::cmd("DEL");
            for key in &self.owned {
                command.arg(key);
            }
            let _: i64 = command.query_async(&mut self.connection).await?;
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit isolated CRON_QUEUE_REDIS_FIXTURE_URI and CRON_QUEUE_REDIS_FIXTURE_ACK=disposable"]
async fn cron_queue_redis_fixture() {
    assert_eq!(
        std::env::var("CRON_QUEUE_REDIS_FIXTURE_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("CRON_QUEUE_REDIS_FIXTURE_URI")
        .expect("explicit fixture URI required; production settings are never used");
    let client = redis::Client::open(uri.as_str()).expect("invalid fixture Redis URI");
    let connection = tokio::time::timeout(Duration::from_secs(8), client.get_connection_manager())
        .await
        .expect("fixture connection timeout")
        .expect("fixture Redis must be reachable");
    let stem = std::env::var("CRON_QUEUE_REDIS_FIXTURE_PREFIX")
        .unwrap_or_else(|_| "cron-queue-fixture".into());
    assert!(
        !stem.is_empty()
            && stem.len() <= 128
            && stem
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ":_-".contains(ch)),
        "fixture namespace stem must be short ASCII text"
    );
    let mut fixture = Fixture {
        client,
        queue: RedisCronQueue::new(connection.clone(), CronQueueConfig::default()),
        connection,
        prefix: format!("{stem}:{}", uuid::Uuid::new_v4()),
        owned: BTreeSet::new(),
    };
    let result = tokio::time::timeout(Duration::from_secs(45), scenarios(&mut fixture)).await;
    let cleanup = tokio::time::timeout(Duration::from_secs(5), fixture.cleanup()).await;
    cleanup
        .expect("fixture cleanup timeout")
        .expect("all task-owned keys must be deleted");
    result
        .expect("cron queue fixture exceeded 45 seconds")
        .expect("cron queue fixture failed");
}

async fn scenarios(fixture: &mut Fixture) -> TestResult {
    duplicate_race(fixture).await?;
    acceptance_survives_dedupe_clear(fixture).await?;
    wrong_type_rollback(fixture).await?;
    rejected_ttl_has_no_markers(fixture).await?;
    optional_data_and_invalid_input(fixture).await?;
    list_transport_and_attempts(fixture).await?;
    source_clear_cases(fixture).await?;
    Ok(())
}

async fn duplicate_race(fixture: &mut Fixture) -> TestResult {
    let queue_key = fixture.key("race:queue");
    let token = format!("{}:race", fixture.prefix);
    let input = input(
        json!({ "job": "summary", "queueKey": queue_key, "dedupeToken": token, "dedupeSeconds": 120 }),
    )?;
    let keys = fixture.record(&input)?;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..24 {
        let input = input.clone();
        let mut queue = fixture.queue.clone();
        tasks.spawn(async move {
            queue
                .enqueue_cron_job(&input, &mut Clock, &mut RandomUuidSource)
                .await
        });
    }
    let mut accepted = Vec::new();
    let mut rejected = 0;
    while let Some(result) = tasks.join_next().await {
        let result = result??;
        if result.enqueued {
            accepted.push(result.job);
        } else {
            check(
                result.message == "Cron job already queued recently",
                "duplicate message parity",
            )?;
            rejected += 1;
        }
    }
    check(
        accepted.len() == 1 && rejected == 23,
        "exactly one atomic enqueue must win a duplicate race",
    )?;
    check(
        fixture.length(&queue_key).await? == 1,
        "race must push once",
    )?;
    let payload: String = redis::cmd("LINDEX")
        .arg(&queue_key)
        .arg(0)
        .query_async(&mut fixture.connection)
        .await?;
    let stored = cron_queue::parse_cron_queue_job(&payload, &mut Clock, &mut RandomUuidSource)?
        .ok_or("stored race payload must parse")?;
    check(
        stored == accepted[0],
        "stored payload must be the winning job",
    )?;
    let ttl: i64 = redis::cmd("TTL")
        .arg(&keys[0])
        .query_async(&mut fixture.connection)
        .await?;
    check(
        (1..=120).contains(&ttl),
        "dedupe marker must have the requested TTL",
    )?;
    fixture
        .queue
        .clear_cron_job_dedupe_by_key(Some(&format!(" \u{feff}{}\u{2028}", keys[0])))
        .await?;
    check(
        fixture.enqueue(&input).await?.enqueued,
        "ordinary dedupe clear must permit another enqueue",
    )?;
    check(
        fixture.length(&queue_key).await? == 2,
        "ordinary replay must push again after clear",
    )?;
    Ok(())
}

async fn acceptance_survives_dedupe_clear(fixture: &mut Fixture) -> TestResult {
    let queue_key = fixture.key("acceptance:queue");
    let token = format!("{}:acceptance", fixture.prefix);
    let session = format!("{}:session", fixture.prefix);
    let input = input(json!({
        "job": " summary ", "channelID": " channel ", "queueKey": queue_key,
        "dedupeToken": token, "data": { "source": "stream_offline", "sessionID": format!(" {session} ") },
    }))?;
    let keys = fixture.record(&input)?;
    let accepted = fixture.enqueue(&input).await?;
    check(
        accepted.enqueued,
        "first automatic session job must be accepted",
    )?;
    check(
        keys.len() == 3,
        "automatic session must use a separate acceptance key",
    )?;
    let ttl: i64 = redis::cmd("TTL")
        .arg(&keys[2])
        .query_async(&mut fixture.connection)
        .await?;
    check(ttl == -1, "acceptance marker must have no TTL")?;

    // Deliberately discard the first receipt, modeling a caller that never
    // recorded success. No claim is made that this injects a TCP response loss.
    fixture
        .queue
        .clear_cron_job_dedupe_by_key(accepted.job.dedupe_key.as_deref())
        .await?;
    check(
        !fixture.exists(&keys[0]).await?,
        "worker clear must remove the TTL marker",
    )?;
    check(
        fixture.exists(&keys[2]).await?,
        "worker clear must retain session acceptance",
    )?;
    check(
        !fixture.enqueue(&input).await?.enqueued,
        "lost receipt replay must not duplicate accepted work",
    )?;
    let mut corrected = input.clone();
    corrected.dedupe_token = Some(format!("{}:corrected-stream", fixture.prefix));
    let corrected_keys = fixture.record(&corrected)?;
    check(
        !fixture.enqueue(&corrected).await?.enqueued,
        "stream ID correction must not bypass session acceptance",
    )?;
    check(
        !fixture.exists(&corrected_keys[0]).await?,
        "acceptance rejection must not create a new TTL marker",
    )?;
    check(
        fixture.length(&queue_key).await? == 1,
        "accepted work must remain one-shot",
    )?;

    let dlq = fixture.key("acceptance:dead-letter");
    cron_queue::push_right_job(&mut fixture.connection, &dlq, Some(&accepted.job)).await?;
    fixture
        .queue
        .clear_cron_job_dedupe_by_key(accepted.job.dedupe_key.as_deref())
        .await?;
    check(
        fixture.exists(&keys[2]).await?,
        "dead-letter marker cleanup must not erase session acceptance",
    )?;
    let mut manual = input.clone();
    manual.data = Some(json!({ "source": "manual", "sessionID": session }));
    check(
        fixture.enqueue(&manual).await?.enqueued,
        "manual job must retain TTL-only dedupe behavior",
    )?;
    check(
        fixture.length(&queue_key).await? == 2,
        "manual job must be independently accepted",
    )?;

    // Any existing acceptance key type prevents replay; its stored value is
    // intentionally not interpreted by the enqueue protocol.
    fixture.delete(&keys[0]).await?;
    fixture.delete(&keys[2]).await?;
    let _: i64 = redis::cmd("RPUSH")
        .arg(&keys[2])
        .arg("existing-list-marker")
        .query_async(&mut fixture.connection)
        .await?;
    check(
        !fixture.enqueue(&input).await?.enqueued,
        "EXISTS acceptance semantics include non-string keys",
    )?;
    Ok(())
}

async fn wrong_type_rollback(fixture: &mut Fixture) -> TestResult {
    for automatic in [false, true] {
        let queue_key = fixture.key(&format!("wrong-type:{automatic}:queue"));
        let input = input(json!({
            "job": "summary", "queueKey": queue_key,
            "dedupeToken": format!("{}:wrong-type:{automatic}", fixture.prefix),
            "data": { "source": if automatic { "stream_offline" } else { "manual" },
                "sessionID": format!("{}:wrong-type:{automatic}", fixture.prefix) },
        }))?;
        let keys = fixture.record(&input)?;
        fixture.set(&queue_key).await?;
        let error = fixture
            .enqueue(&input)
            .await
            .err()
            .ok_or("WRONGTYPE queue must fail, not return a dedupe result")?;
        check(
            error.to_string().contains("WRONGTYPE"),
            "Redis error must be preserved",
        )?;
        check(
            !fixture.exists(&keys[0]).await?,
            "failed LPUSH must roll back dedupe",
        )?;
        if automatic {
            check(
                !fixture.exists(&keys[2]).await?,
                "failed LPUSH must roll back acceptance",
            )?;
        }
        let value: String = redis::cmd("GET")
            .arg(&queue_key)
            .query_async(&mut fixture.connection)
            .await?;
        check(
            value == "wrong-type-or-marker",
            "failed LPUSH must preserve the wrong-type queue value",
        )?;
        fixture.delete(&queue_key).await?;
        check(
            fixture.enqueue(&input).await?.enqueued,
            "corrected queue must accept the previously failed input",
        )?;
        check(
            fixture.length(&queue_key).await? == 1,
            "recovery must push exactly once",
        )?;
    }
    Ok(())
}

async fn rejected_ttl_has_no_markers(fixture: &mut Fixture) -> TestResult {
    for (index, seconds) in [json!(61.5), json!("invalid"), json!("Infinity")]
        .into_iter()
        .enumerate()
    {
        let queue_key = fixture.key(&format!("invalid-ttl:{index}:queue"));
        let input = input(json!({
            "job": "summary", "queueKey": queue_key, "dedupeSeconds": seconds,
            "dedupeToken": format!("{}:invalid-ttl:{index}", fixture.prefix),
            "data": { "source": "stream_offline", "sessionID": format!("{}:invalid-ttl:{index}", fixture.prefix) },
        }))?;
        let keys = fixture.record(&input)?;
        check(
            fixture.enqueue(&input).await.is_err(),
            "invalid EX value must propagate a Redis error",
        )?;
        for key in keys {
            check(
                !fixture.exists(&key).await?,
                "invalid EX must not create queue or markers",
            )?;
        }
    }
    Ok(())
}

async fn optional_data_and_invalid_input(fixture: &mut Fixture) -> TestResult {
    let queue_key = fixture.key("optional:queue");
    for (index, data) in [
        None,
        Some(Value::Null),
        Some(json!([])),
        Some(json!([1, {"x": true}])),
        Some(json!(false)),
        Some(json!({"nested": [1, 2]})),
    ]
    .into_iter()
    .enumerate()
    {
        let mut input = input(json!({
            "job": " summary ", "queueKey": format!(" {queue_key} "),
            "dedupeToken": format!("{}:optional:{index}", fixture.prefix),
            "requestedBy": false, "userID": 17, "accountID": " account ",
        }))?;
        input.data = data.clone();
        let result = fixture.enqueue(&input).await?;
        check(
            result.enqueued && result.job.requested_by.is_none() && result.job.user_id.is_none(),
            "optional string normalization",
        )?;
        check(
            result.job.data == data,
            "enqueue must preserve optional/null/scalar/array data without parse filtering",
        )?;
        let payload: String = redis::cmd("LINDEX")
            .arg(&queue_key)
            .arg(0)
            .query_async(&mut fixture.connection)
            .await?;
        let parsed = cron_queue::parse_cron_queue_job(&payload, &mut Clock, &mut RandomUuidSource)?
            .ok_or("enqueued job must parse")?;
        let expected = data.filter(|value| value.is_object() || value.is_array());
        check(
            parsed.data == expected,
            "parse must retain only arrays and objects",
        )?;
    }
    let invalid = input(json!({ "job": " \u{feff} ", "queueKey": queue_key }))?;
    let result = fixture.enqueue(&invalid).await?;
    check(
        !result.enqueued && result.message == "Invalid cron job name" && result.job.job.is_empty(),
        "invalid enqueue result parity",
    )?;
    check(
        fixture.length(&queue_key).await? == 6,
        "invalid input must not enqueue",
    )?;
    Ok(())
}

async fn list_transport_and_attempts(fixture: &mut Fixture) -> TestResult {
    let queue_key = fixture.key("transport:queue");
    let dlq = fixture.key("transport:dead-letter");
    // A freshly opened manager keeps blocking pop off the producer socket.
    let mut blocking = fixture.client.get_connection_manager().await?;
    check(
        cron_queue::pop_left_blocking_raw(&mut blocking, &queue_key, 0.01)
            .await?
            .is_none(),
        "empty queue pop must time out",
    )?;
    let mut jobs: Vec<CronQueueJob> = Vec::new();
    for index in 0..2 {
        let input = input(json!({
            "job": "summary", "queueKey": queue_key,
            "dedupeToken": format!("{}:transport:{index}", fixture.prefix),
            "data": { "attempt": "2.9", "retained": index },
        }))?;
        jobs.push(fixture.enqueue(&input).await?.job);
    }
    let (popped_key, raw) = cron_queue::pop_left_blocking_raw(&mut blocking, &queue_key, 0.1)
        .await?
        .ok_or("LPUSH queue must have an item")?;
    check(
        popped_key == queue_key,
        "BLPOP must return the custom queue key",
    )?;
    let popped = cron_queue::parse_cron_queue_job(&raw, &mut Clock, &mut RandomUuidSource)?
        .ok_or("popped job must parse")?;
    check(
        popped.id == jobs[1].id,
        "BLPOP must consume the leftmost, newest LPUSH job",
    )?;
    check(
        cron_queue::get_job_attempt(Some(&popped)) == 2.0,
        "numeric-string attempt floor",
    )?;
    let next = cron_queue::with_next_attempt(Some(&popped)).ok_or("next attempt must exist")?;
    cron_queue::push_right_job(&mut fixture.connection, &queue_key, Some(&next)).await?;
    for (id, attempt) in [(&jobs[0].id, 2.0), (&jobs[1].id, 3.0)] {
        let (_, raw) = cron_queue::pop_left_blocking_raw(&mut blocking, &queue_key, 0.1)
            .await?
            .ok_or("requeued jobs must be available")?;
        let job = cron_queue::parse_cron_queue_job(&raw, &mut Clock, &mut RandomUuidSource)?
            .ok_or("requeued job must parse")?;
        check(
            &job.id == id && cron_queue::get_job_attempt(Some(&job)) == attempt,
            "RPUSH must retain queue order and the caller's attempt change",
        )?;
    }
    check(
        fixture.length(&queue_key).await? == 0,
        "transport queue must be drained",
    )?;
    cron_queue::push_right_job(&mut fixture.connection, &dlq, None).await?;
    check(
        !fixture.exists(&dlq).await?,
        "null requeue helper must do nothing",
    )?;
    fixture.set(&dlq).await?;
    check(
        cron_queue::push_right_job(&mut fixture.connection, &dlq, Some(&next))
            .await
            .is_err(),
        "dead-letter wrong type must propagate",
    )?;
    check(
        fixture
            .exists(
                jobs[1]
                    .dedupe_key
                    .as_deref()
                    .ok_or("job must have dedupe")?,
            )
            .await?,
        "failed dead-letter write must not implicitly clear dedupe",
    )?;
    fixture.delete(&dlq).await?;
    cron_queue::push_right_job(&mut fixture.connection, &dlq, Some(&next)).await?;
    check(
        fixture
            .exists(
                jobs[1]
                    .dedupe_key
                    .as_deref()
                    .ok_or("job must have dedupe")?,
            )
            .await?,
        "successful RPUSH alone must not change dedupe policy",
    )?;
    fixture
        .queue
        .clear_cron_job_dedupe_by_key(next.dedupe_key.as_deref())
        .await?;
    check(
        fixture.length(&dlq).await? == 1,
        "caller-selected dead-letter write must succeed",
    )?;
    check(
        !fixture
            .exists(next.dedupe_key.as_deref().ok_or("job must have dedupe")?)
            .await?,
        "caller must be able to clear after successful DLQ write",
    )?;
    Ok(())
}

async fn source_clear_cases(fixture: &mut Fixture) -> TestResult {
    let source: Value = serde_json::from_str(include_str!("fixtures/cron_queue_parity.json"))?;
    let key = fixture.key("source-clear");
    for case in source["cases"]
        .as_array()
        .ok_or("fixture cases must be an array")?
    {
        if case["operation"] != "clear" {
            continue;
        }
        fixture.set(&key).await?;
        let argument = case["input"]["key"]
            .as_str()
            .map(|value| value.replace("key", &key));
        fixture
            .queue
            .clear_cron_job_dedupe_by_key(argument.as_deref())
            .await?;
        let expected_exists = case["expected"]["clientCalls"] == 0;
        check(
            fixture.exists(&key).await? == expected_exists,
            "clear behavior must match actual TypeScript source fixtures",
        )?;
    }
    Ok(())
}
