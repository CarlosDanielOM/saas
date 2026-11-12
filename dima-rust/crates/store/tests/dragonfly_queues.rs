//! Opaque queues against the local Dragonfly: items go in and come out as the same bytes, are
//! acknowledged and requeued by those bytes, and keep each queue's direction. Payloads carry
//! emoji, combining marks, right-to-left text, quotes, newlines, and bytes that are not UTF-8.
//! Logical database 11. Skipped when `DIMA_TEST_DRAGONFLY` is not set.

mod dragonfly_support;

use anyhow::{Context, Result, ensure};
use dima_store::dragonfly::queue::presets;
use dima_store::dragonfly::{
    DelayQueue, DragonflyError, End, Fence, FencedTransition, ListQueue, ProcessingList, QueueItem,
    SetOptions, Transition,
};
use dragonfly_support::{AWKWARD_TEXT, cleanup, connect, prefix};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::num::NonZeroUsize;
use std::time::Duration;

const DB: u8 = 11;

#[derive(Serialize)]
struct Payload<'a> {
    id: usize,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'a str>,
}

fn items() -> Result<Vec<QueueItem>> {
    let mut items = AWKWARD_TEXT
        .iter()
        .enumerate()
        .map(|(id, text)| {
            QueueItem::encode(&Payload {
                id,
                text,
                note: None,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Not UTF-8, not JSON: carried untouched anyway.
    items.push(QueueItem::from_popped(vec![
        0xff, b'{', 0xc3, 0x28, 0x00, b'"',
    ]));
    // Valid JSON with a lone surrogate escape (JSON.parse accepts it).
    items.push(QueueItem::from_popped(
        br#"{"id":99,"text":"\ud83d"}"#.to_vec(),
    ));
    Ok(items)
}

#[tokio::test]
async fn items_round_trip_as_exact_bytes_and_parse_as_borrowed_views() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("queue-bytes");
    let queue = ListQueue::new(Cow::Owned(format!("{p}fifo")), End::Right, End::Left);
    let items = items()?;
    for item in &items {
        queue.push(&df, item).await?;
    }
    for (index, item) in items.iter().enumerate() {
        let popped = queue.pop(&df).await?.context("item")?;
        ensure!(popped == *item, "item {index} changed");
        if index < AWKWARD_TEXT.len() {
            #[derive(Deserialize)]
            struct View<'a> {
                id: usize,
                #[serde(borrow)]
                text: Cow<'a, str>,
            }
            let view: View<'_> = popped.view()?;
            ensure!(view.id == index && view.text == AWKWARD_TEXT[index]);
        }
    }
    ensure!(queue.pop(&df).await?.is_none());
    cleanup(&df, &p).await
}

#[tokio::test]
async fn claim_acknowledge_requeue_and_recover_use_the_popped_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("queue-claim");
    // Stream memory's shape: LPUSH, BLMOVE LEFT RIGHT into processing (newest first).
    let queue = ListQueue::new(Cow::Owned(format!("{p}queue")), End::Left, End::Left);
    let processing = ProcessingList::new(Cow::Owned(format!("{p}processing")), End::Right);
    let items = items()?;
    for item in &items {
        queue.push(&df, item).await?;
    }
    let mut blocking = df.blocking();
    // Newest first: the last pushed comes out first.
    let first = queue
        .blocking_claim(&mut blocking, &processing, Duration::from_secs(1))
        .await?
        .context("claim")?;
    ensure!(first == items[items.len() - 1]);
    let second = queue.claim(&df, &processing).await?.context("claim")?;
    ensure!(second == items[items.len() - 2]);
    ensure!(processing.contains(&df, &first).await? && processing.contains(&df, &second).await?);

    // A re-encoded copy is not the same element: acknowledging it removes nothing.
    let reparsed: serde_json::Value = first.parse()?;
    let reencoded = QueueItem::encode_value(&reparsed);
    ensure!(
        reencoded != first,
        "the lone surrogate must not survive a re-encode"
    );
    ensure!(processing.acknowledge_unfenced(&df, &reencoded).await? == 0);
    ensure!(processing.acknowledge_unfenced(&df, &first).await? == 1);
    ensure!(!processing.contains(&df, &first).await?);

    // The non-UTF-8 item: requeue to the tail with its exact bytes, recover the other claim.
    ensure!(second.as_str().is_none());
    queue.push_at(&df, &second, End::Right).await?;
    ensure!(processing.acknowledge_unfenced(&df, &second).await? == 1);
    let tail: Vec<Vec<u8>> = df
        .query(redis::cmd("LRANGE").arg(queue.key()).arg(-1).arg(-1))
        .await?;
    ensure!(tail == vec![second.as_bytes().to_vec()]);

    let third = queue.claim(&df, &processing).await?.context("claim")?;
    let recovered = processing
        .recover_one_unfenced(&df, &queue)
        .await?
        .context("recover")?;
    ensure!(recovered == third);
    // RPOPLPUSH puts it back at the head, so it is the next claim again.
    ensure!(queue.pop(&df).await? == Some(third));
    cleanup(&df, &p).await
}

#[tokio::test]
async fn presets_keep_the_reference_directions() -> Result<()> {
    // Newest first, as the reference does; do not "fix".
    ensure!(
        presets::CRON_JOBS.push_end() == End::Left && presets::CRON_JOBS.pop_end() == End::Left
    );
    ensure!(
        presets::STREAM_MEMORY.push_end() == End::Left
            && presets::STREAM_MEMORY.pop_end() == End::Left
    );
    // Oldest first.
    for queue in [
        &presets::CLIP_RECOMMENDATIONS,
        &presets::AI_USAGE_RECEIPTS,
        &presets::AI_USAGE_BACKFILLS,
        &presets::OBSERVABILITY_INBOX,
    ] {
        ensure!(
            queue.push_end() != queue.pop_end(),
            "{} must be FIFO",
            queue.key()
        );
    }
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("queue-order");
    let lifo = ListQueue::new(Cow::Owned(format!("{p}lifo")), End::Left, End::Left);
    let fifo = ListQueue::new(Cow::Owned(format!("{p}fifo")), End::Left, End::Right);
    for name in ["a", "b", "c"] {
        let item = QueueItem::encode(name)?;
        lifo.push(&df, &item).await?;
        fifo.push(&df, &item).await?;
    }
    let mut blocking = df.blocking();
    let mut lifo_order = Vec::new();
    let mut fifo_order = Vec::new();
    for _ in 0..3 {
        let item = lifo
            .blocking_pop(&mut blocking, Duration::from_secs(1))
            .await?
            .context("lifo")?;
        lifo_order.push(item.parse::<String>()?);
        let item = fifo
            .blocking_pop(&mut blocking, Duration::from_secs(1))
            .await?
            .context("fifo")?;
        fifo_order.push(item.parse::<String>()?);
    }
    ensure!(lifo_order == ["c", "b", "a"] && fifo_order == ["a", "b", "c"]);
    cleanup(&df, &p).await
}

fn batch(n: usize) -> Result<NonZeroUsize> {
    NonZeroUsize::new(n).context("batch size")
}

#[tokio::test]
async fn delay_queue_reads_are_bounded_by_the_batch_limit() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("delay-batch");
    let queue = DelayQueue::new(Cow::Owned(format!("{p}zset")));
    let members: Vec<QueueItem> = (0..7)
        .map(|n| QueueItem::from_popped(format!("due-{n}").into_bytes()))
        .collect();
    for (n, member) in members.iter().enumerate() {
        queue.schedule(&df, member, 100.0 + n as f64).await?;
    }
    queue
        .schedule(&df, &QueueItem::from_popped(b"not-yet".to_vec()), 9_000.0)
        .await?;
    // One call returns at most the limit, lowest scores first.
    let first = queue.due(&df, 0.0, 1_000.0, batch(3)?).await?;
    ensure!(first == members[..3], "first batch");
    // A caller that needs everything claims its batch and asks again.
    let mut seen = Vec::new();
    loop {
        let batch_items = queue.due(&df, 0.0, 1_000.0, batch(3)?).await?;
        ensure!(batch_items.len() <= 3);
        for item in &batch_items {
            ensure!(queue.claim(&df, item).await?);
            seen.push(item.clone());
        }
        if batch_items.len() < 3 {
            break;
        }
    }
    ensure!(seen == members, "every due member once, in score order");
    ensure!(queue.due(&df, 0.0, 1_000.0, batch(3)?).await?.is_empty());
    cleanup(&df, &p).await
}

#[tokio::test]
async fn delay_queue_claims_are_single_delivery() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("delay");
    let queue = DelayQueue::new(Cow::Owned(format!("{p}zset")));
    let member = QueueItem::from_popped("evt-🎉-שלום".as_bytes().to_vec());
    let later = QueueItem::from_popped(b"later".to_vec());
    queue.schedule(&df, &member, 1_000.0).await?;
    queue.schedule(&df, &later, 5_000.0).await?;
    let due = queue.due(&df, 0.0, 2_000.0, batch(10)?).await?;
    ensure!(due == vec![member.clone()]);
    // Many claimers race for the same member: exactly one wins.
    let claims = futures_util::future::join_all((0..8).map(|_| queue.claim(&df, &member))).await;
    let winners = claims
        .into_iter()
        .filter(|claim| matches!(claim, Ok(true)))
        .count();
    ensure!(winners == 1, "{winners} winners");
    ensure!(queue.pop_min(&df).await? == Some((later, 5_000.0)));
    cleanup(&df, &p).await
}

/// The stream memory worker's retry after a failed adoption (`stream_memory.worker.ts:399`),
/// verbatim: lease check, then move the exact claim back to the queue's head.
static STREAM_MEMORY_RETRY: FencedTransition = FencedTransition::new(
    "STREAM_MEMORY_RETRY",
    "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end if redis.call('LREM', KEYS[2], 1, ARGV[2]) > 0 then return redis.call('LPUSH', KEYS[3], ARGV[2]) end return 0",
);

/// `CLIP_CLAIM_SCRIPTS.deadLetter` (`clip_recommendation_claims.ts`), verbatim (checked below).
static CLIP_DEAD_LETTER: FencedTransition = FencedTransition::new(
    "CLIP_CLAIM_SCRIPTS.deadLetter",
    "
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if not redis.call('LPOS', KEYS[2], ARGV[2]) then return 0 end
local pushed = redis.pcall('RPUSH', KEYS[3], ARGV[3])
if type(pushed) == 'table' and pushed.err then return redis.error_reply(pushed.err) end
redis.call('LREM', KEYS[2], 1, ARGV[2])
if #KEYS > 3 then redis.call('DEL', KEYS[4]) end
return 1
",
);

/// The worked example: a consumer registers its own fenced transitions and runs them through
/// the checked runner. A process that lost the lease changes nothing; the owner's retry and dead
/// letter are atomic with the lease check.
#[tokio::test]
async fn fenced_transitions_check_the_lease_inside_the_script() -> Result<()> {
    let reference = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../dimabot/src/utils/ai/clip_recommendations/clip_recommendation_claims.ts"
    ))?;
    ensure!(
        reference.contains(&format!(
            "deadLetter: `{}`",
            CLIP_DEAD_LETTER.script().source()
        )),
        "the dead-letter script is not the reference's text"
    );
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("fenced");
    let result = async {
        let lease = format!("{p}lock");
        let dedupe = format!("{p}dedupe");
        let queue = ListQueue::new(Cow::Owned(format!("{p}queue")), End::Left, End::Left);
        let processing = ProcessingList::new(Cow::Owned(format!("{p}processing")), End::Right);
        let dead = format!("{p}dead");
        df.set(&lease, b"owner-a", SetOptions::default()).await?;
        df.set(&dedupe, b"1", SetOptions::default()).await?;
        let ours = Fence { lease_key: &lease, owner: b"owner-a" };
        let stale = Fence { lease_key: &lease, owner: b"owner-b" };

        let item = QueueItem::encode(&Payload { id: 1, text: AWKWARD_TEXT[1], note: None })?;
        queue.push(&df, &item).await?;
        let claimed = queue.claim(&df, &processing).await?.context("claim")?;

        // Another process's lease: nothing moves.
        let lost = STREAM_MEMORY_RETRY
            .run(&df, stale, &processing, &claimed, &[queue.key()], &[])
            .await?;
        ensure!(lost == Transition::LeaseLost, "{lost:?}");
        ensure!(processing.contains(&df, &claimed).await? && queue.len(&df).await? == 0);

        // Ours: the exact claim goes back to the head, once.
        let retried = STREAM_MEMORY_RETRY
            .run(&df, ours, &processing, &claimed, &[queue.key()], &[])
            .await?;
        ensure!(retried == Transition::Applied(redis::Value::Int(1)), "{retried:?}");
        ensure!(!processing.contains(&df, &claimed).await?);
        let again = STREAM_MEMORY_RETRY
            .run(&df, ours, &processing, &claimed, &[queue.key()], &[])
            .await?;
        ensure!(again == Transition::Applied(redis::Value::Int(0)), "{again:?}");

        // Dead letter with a new payload, releasing the dedupe marker, under the lease.
        let claimed = queue.claim(&df, &processing).await?.context("claim")?;
        ensure!(claimed == item);
        let dead_payload = br#"{"id":1,"attempt":4}"#;
        let stale_dead = CLIP_DEAD_LETTER
            .run(&df, stale, &processing, &claimed, &[&dead, &dedupe], &[dead_payload])
            .await?;
        ensure!(stale_dead == Transition::LeaseLost);
        ensure!(df.exists(&[&dedupe]).await? == 1);
        let moved = CLIP_DEAD_LETTER
            .run(&df, ours, &processing, &claimed, &[&dead, &dedupe], &[dead_payload])
            .await?;
        ensure!(moved == Transition::Applied(redis::Value::Int(1)), "{moved:?}");
        ensure!(!processing.contains(&df, &claimed).await?);
        ensure!(df.lpop(&dead).await? == Some(dead_payload.to_vec()));
        ensure!(df.exists(&[&dedupe]).await? == 0);

        // Scripts that could hang the server, or that skip the fence, are never sent.
        static UNBOUNDED: FencedTransition = FencedTransition::new(
            "TEST_UNBOUNDED",
            "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end while false do end return 0",
        );
        static UNFENCED: FencedTransition =
            FencedTransition::new("TEST_UNFENCED", "return redis.call('LREM', KEYS[2], 1, ARGV[2])");
        for transition in [&UNBOUNDED, &UNFENCED] {
            let refused = transition
                .run(&df, ours, &processing, &claimed, &[], &[])
                .await;
            ensure!(
                matches!(refused, Err(DragonflyError::ScriptRefused { .. })),
                "{refused:?}"
            );
        }
        Ok(())
    }
    .await;
    cleanup(&df, &p).await?;
    result
}
