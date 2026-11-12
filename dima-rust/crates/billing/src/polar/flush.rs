//! A channel's queue of AI usage and its flush to Polar (item 1 of P2-BILLING-01b, review
//! findings 1 and 8): no event is lost or sent twice under a new identity, a backlog of any
//! size drains, and one event Polar will never accept no longer blocks its channel.
//!
//! The reference read the whole queue, sent it in one request and trimmed the queue by the
//! length it had read, under an 8-second lock it never checked again: a flush that outlived its
//! lock could trim events another flush had queued and nobody had sent, and a backlog past the
//! request size limit could never be flushed. Here:
//!
//! 1. A flush holds the channel's lease (`locks:polar-ingest:{channel}`, `SET NX PX 8000` with
//!    a random owner token; a caller waits up to 2.5 s, retrying every 350 ms, as the
//!    reference did). Every later step is a [`FencedTransition`]: a Lua script that first
//!    checks the lease still holds this owner's token and changes nothing otherwise.
//! 2. **Claim** moves a bounded batch from the queue head into the channel's processing list
//!    (at most [`FLUSH_MAX_EVENTS`] events and [`FLUSH_MAX_BYTES`] bytes). What the processing
//!    list already holds is an earlier flush's batch whose outcome is unknown; it is resumed
//!    first and topped up. A lease that expired is taken over only by acquiring it again, so
//!    the new owner resends that batch before anything else.
//! 3. Each item is decoded and checked against the Polar SDK's input validation; one that
//!    fails, or is larger than the byte limit alone, moves to the dead-letter list with its
//!    reason.
//! 4. The lease is extended to cover the send ([`FLUSH_SEND_LEASE_MS`]), and the batch is sent
//!    with an explicit timeout ([`FLUSH_SEND_TIMEOUT`]).
//! 5. Polar stored every event: **acknowledge** removes exactly the claimed items (by their
//!    bytes), whatever was queued meanwhile, and in the same step holds their credits against
//!    the balances published from Polar until its meter has had time to count them
//!    ([`crate::plans::balance`]).
//! 6. Polar refused the request as invalid (400/422, nothing stored): the events it names go to
//!    the dead-letter list with its error type; the rest return to the queue head in order. A
//!    refusal that names no event makes the rest of this flush send one event at a time, so the
//!    bad one is found and set aside.
//! 7. A failure that certainly stored nothing (no connection, another 4xx, no token): the batch
//!    returns to the queue head. A failure after which Polar may have stored some or all of it
//!    (a lost reply, a timeout, a 5xx, an answer that cannot be read, fewer stored than sent):
//!    the batch **stays** in the processing list and is resent as it is by the next flush.
//! 8. At most [`FLUSH_MAX_BATCHES`] batches per flush; then the lease is released (fenced).
//!
//! **Why a resend is harmless.** An event's `external_id` is fixed when the event is built,
//! before it is queued (`build_usage_event`: the caller's `externalId`, else the usage entry
//! id, else `aiu_<uuid>` drawn once), and it travels in the queued bytes. A resend sends the
//! same bytes, so the same external ids, and Polar counts an event it already has under
//! `duplicates` instead of storing it twice.
//!
//! **Nothing financial is dropped silently.** An event leaves the queue only into Polar
//! (acknowledged) or into the dead-letter list (with the reason, reported to the
//! [`Observer`]). The dead-letter list is never trimmed: an operator fixes and requeues an
//! entry (its bytes after the first newline are the queued event) or credits it.
//!
//! Keys (Rust's own; all are *drained* at cutover with the queue, which holds money):
//!
//! | Key | Type |
//! |---|---|
//! | `twitch:{channel}:ai:polarshevent` | list: the queue (`RPUSH`, claimed from the head); each item is the event's JSON with `queuedAt` |
//! | `twitch:{channel}:ai:polarshevent:processing` | list: the batch being sent |
//! | `twitch:{channel}:ai:polarshevent:dead` | list: `{"reason","at"}` JSON (`"held":false` added for an event refused before it was queued), a newline, the item |
//! | `locks:polar-ingest:{channel}` | the lease (expires on its own) |

use super::{BatchAnswer, IngestEvent, PolarClient};
use crate::Observer;
use crate::plans::balance;
use dima_core::{Clock, Random};
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::plan_cache_fence::credits_cache_key;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, End, Fence, FencedTransition, ProcessingList, QueueItem,
    SetCondition, SetExpiry, SetOptions, SetOutcome, Transition,
};
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::time::Duration;

/// `INGEST_LOCK_TTL_MS`: the lease while claiming and acknowledging.
pub const INGEST_LOCK_TTL_MS: u64 = 8000;
/// `INGEST_LOCK_MAX_WAIT_MS`.
pub const INGEST_LOCK_MAX_WAIT: Duration = Duration::from_millis(2500);
/// `INGEST_LOCK_RETRY_MS`.
pub const INGEST_LOCK_RETRY: Duration = Duration::from_millis(350);
/// Most events in one request (the reference sent the whole queue).
pub const FLUSH_MAX_EVENTS: usize = 100;
/// Most queued bytes in one request: far below `dima-http`'s 8 MiB request limit, whatever the
/// wire form adds.
pub const FLUSH_MAX_BYTES: usize = 512 * 1024;
/// Most batches one flush sends before it lets go of the lease.
pub const FLUSH_MAX_BATCHES: usize = 10;
/// The timeout of one flush request (the reference set none: `dima-http`'s 60 s applied).
pub const FLUSH_SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// The lease while a request is in flight: the send's timeout and a margin.
pub const FLUSH_SEND_LEASE_MS: u64 = 35_000;

static CLAIM: FencedTransition =
    FencedTransition::new("INGEST_CLAIM", include_str!("lua/ingest_claim.lua"));
static ACK: FencedTransition = FencedTransition::new(
    "INGEST_ACK_HELD",
    concat!(
        include_str!("../plans/lua/credits_hold.lua"),
        include_str!("lua/ingest_ack.lua")
    ),
);
static REQUEUE: FencedTransition =
    FencedTransition::new("INGEST_REQUEUE", include_str!("lua/ingest_requeue.lua"));
static DEAD_LETTER: FencedTransition = FencedTransition::new(
    "INGEST_DEAD_LETTER",
    include_str!("lua/ingest_dead_letter.lua"),
);
static EXTEND: FencedTransition = FencedTransition::new(
    "INGEST_LEASE_EXTEND",
    include_str!("lua/ingest_lease_extend.lua"),
);
static RELEASE: FencedTransition = FencedTransition::new(
    "INGEST_LEASE_RELEASE",
    include_str!("lua/ingest_lease_release.lua"),
);

/// Every script of the flush, for the tests that check them.
pub fn scripts() -> [&'static FencedTransition; 6] {
    [&CLAIM, &ACK, &REQUEUE, &DEAD_LETTER, &EXTEND, &RELEASE]
}

/// `twitch:{channel}:ai:polarshevent`.
pub fn queue_key(channel: &str) -> String {
    format!("twitch:{channel}:ai:polarshevent")
}

/// `twitch:{channel}:ai:polarshevent:processing`.
pub fn processing_key(channel: &str) -> String {
    format!("twitch:{channel}:ai:polarshevent:processing")
}

/// `twitch:{channel}:ai:polarshevent:dead`.
pub fn dead_letter_key(channel: &str) -> String {
    format!("twitch:{channel}:ai:polarshevent:dead")
}

/// `locks:polar-ingest:{channel}`.
pub fn lease_key(channel: &str) -> String {
    format!("locks:polar-ingest:{channel}")
}

/// The queued form of an event: Rust's own JSON (the key family is drained at cutover), with
/// when it was queued (`queuedAt`, ms): its debit is held until then plus
/// [`crate::plans::balance::QUEUED_HOLD_MS`] at most (item 1 of P2-BILLING-01c).
pub(crate) fn queued_text(event: &IngestEvent, queued_at_ms: i64) -> String {
    let mut map = Map::new();
    map.insert("name".into(), Value::from(event.name.as_str()));
    map.insert(
        "customerId".into(),
        Value::from(event.customer_id.expose().as_str()),
    );
    map.insert("externalId".into(), Value::from(event.external_id.as_str()));
    map.insert("metadata".into(), Value::Object(event.metadata.clone()));
    map.insert("queuedAt".into(), Value::from(queued_at_ms));
    dima_text::to_js_json(&Value::Object(map))
}

/// A queued event read back; `None` when the bytes are not one.
pub(crate) fn queued_event(text: &[u8]) -> Option<IngestEvent> {
    let value: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(text)).ok()?;
    let object = value.as_object()?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(IngestEvent {
        name: text("name")?,
        customer_id: dima_model::Private::new(text("customerId")?),
        external_id: text("externalId")?,
        metadata: object
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

/// The dead-letter entry: `{"reason","at"}`, a newline, the item's bytes. The entry holds its
/// event's debit against Polar's figure ([`crate::plans::balance`]); `held: false` marks an event
/// refused before it was queued, whose debit was never recorded.
fn dead_letter_header(reason: &str, at_ms: i64, held: bool) -> String {
    let mut map = Map::new();
    map.insert("reason".into(), Value::from(reason));
    map.insert("at".into(), Value::from(at_ms));
    if !held {
        map.insert("held".into(), Value::Bool(false));
    }
    dima_text::to_js_json(&Value::Object(map))
}

/// A held flush lease.
#[derive(Clone)]
pub struct Lease {
    key: String,
    owner: String,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Lease")
    }
}

/// How a flush ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlushEnd {
    /// The queue and the processing list are empty.
    Drained,
    /// [`FLUSH_MAX_BATCHES`] batches were sent; more may wait for the next flush.
    BatchLimit,
    /// Another flush holds the lease.
    Busy,
    /// The lease passed to another flush during this one, which now owns what is left.
    LeaseLost,
    /// Polar refused for now and stored nothing: the batch is back at the queue head.
    Retry {
        /// The reference's message.
        message: String,
    },
    /// Polar may have stored some or all of the batch: it stays in the processing list and the
    /// next flush resends it with the same external ids.
    OutcomeUnknown {
        /// The reference's message.
        message: String,
    },
    /// Dragonfly failed; nothing is lost (an unacknowledged batch is resent).
    StoreFailed {
        /// What failed.
        message: String,
    },
}

/// What one flush did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlushReport {
    /// Events Polar acknowledged (stored or already had).
    pub sent: usize,
    /// Events resumed from an earlier flush's unfinished batch.
    pub resumed: usize,
    /// Events moved to the dead-letter list.
    pub dead_lettered: usize,
    /// How it ended.
    pub end: FlushEnd,
}

impl FlushReport {
    fn new() -> Self {
        Self {
            sent: 0,
            resumed: 0,
            dead_lettered: 0,
            end: FlushEnd::Drained,
        }
    }

    fn ending(mut self, end: FlushEnd) -> Self {
        self.end = end;
        self
    }
}

/// The flush of one channel's queue.
#[derive(Clone, Copy)]
pub struct Flush<'a> {
    /// Polar.
    pub polar: &'a PolarClient,
    /// Dragonfly.
    pub dragonfly: &'a Dragonfly,
    /// Lease tokens.
    pub random: &'a dyn Random,
    /// Dead-letter times.
    pub clock: &'a dyn Clock,
    /// Dead letters and unknown outcomes are reported here.
    pub observer: &'a dyn Observer,
}

impl std::fmt::Debug for Flush<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Flush")
    }
}

/// One claimed item: its bytes, and its wire form when it can be sent.
struct Claimed {
    item: QueueItem,
    wire: Result<Value, String>,
}

enum Step {
    /// Claim the next batch.
    Continue,
    /// Polar refused a batch without naming the event: send one event at a time from now on.
    OneAtATime,
    End(FlushEnd),
}

impl Flush<'_> {
    /// Takes the channel's lease, waiting as the reference did; `None` when another flush
    /// keeps it.
    pub async fn acquire(&self, channel: &str) -> Result<Option<Lease>, DragonflyError> {
        let owner = self
            .random
            .uuid_v4()
            .map_err(|_| DragonflyError::Reply("lease token unavailable"))?;
        let key = lease_key(channel);
        let started = tokio::time::Instant::now();
        loop {
            let options = SetOptions {
                condition: SetCondition::IfMissing,
                expiry: SetExpiry::Millis(INGEST_LOCK_TTL_MS),
                get: false,
            };
            if self.dragonfly.set(&key, owner.as_bytes(), options).await? == SetOutcome::Written {
                return Ok(Some(Lease { key, owner }));
            }
            tokio::time::sleep(INGEST_LOCK_RETRY).await;
            if started.elapsed() >= INGEST_LOCK_MAX_WAIT {
                return Ok(None);
            }
        }
    }

    /// Takes the channel's lease if it is free, without waiting (P2-BILLING-02a: the flush of
    /// channels that have gone quiet, which must not wait on a channel that is flushing).
    pub async fn try_acquire(&self, channel: &str) -> Result<Option<Lease>, DragonflyError> {
        let owner = self
            .random
            .uuid_v4()
            .map_err(|_| DragonflyError::Reply("lease token unavailable"))?;
        let key = lease_key(channel);
        let options = SetOptions {
            condition: SetCondition::IfMissing,
            expiry: SetExpiry::Millis(INGEST_LOCK_TTL_MS),
            get: false,
        };
        Ok(
            (self.dragonfly.set(&key, owner.as_bytes(), options).await? == SetOutcome::Written)
                .then_some(Lease { key, owner }),
        )
    }

    /// Releases the lease if it is still this flush's.
    pub async fn release(&self, channel: &str, lease: &Lease) {
        let processing = processing_list(channel);
        if let Err(error) = RELEASE
            .run(
                self.dragonfly,
                fence(lease),
                &processing,
                &QueueItem::from_popped(Vec::new()),
                &[],
                &[],
            )
            .await
        {
            self.observer
                .error("flushPolarUsage", &format!("lease release failed: {error}"));
        }
    }

    /// Takes the lease (waiting as the reference did), flushes, and releases it.
    pub async fn flush(&self, channel: &str) -> FlushReport {
        match self.acquire(channel).await {
            Ok(Some(lease)) => {
                let report = self.run(channel, &lease).await;
                self.release(channel, &lease).await;
                report
            }
            Ok(None) => FlushReport::new().ending(FlushEnd::Busy),
            Err(error) => FlushReport::new().ending(FlushEnd::StoreFailed {
                message: error.to_string(),
            }),
        }
    }

    /// Flushes under a held lease (see the module docs); does not release it.
    pub async fn run(&self, channel: &str, lease: &Lease) -> FlushReport {
        let mut report = FlushReport::new();
        let mut one_at_a_time = false;
        for _ in 0..FLUSH_MAX_BATCHES {
            match self.batch(channel, lease, one_at_a_time, &mut report).await {
                Ok(Step::Continue) => {}
                Ok(Step::OneAtATime) => one_at_a_time = true,
                Ok(Step::End(end)) => return report.ending(end),
                Err(error) => {
                    return report.ending(FlushEnd::StoreFailed {
                        message: error.to_string(),
                    });
                }
            }
        }
        report.ending(FlushEnd::BatchLimit)
    }

    async fn batch(
        &self,
        channel: &str,
        lease: &Lease,
        one_at_a_time: bool,
        report: &mut FlushReport,
    ) -> Result<Step, DragonflyError> {
        let processing = processing_list(channel);
        let queue = queue_key(channel);
        let most = if one_at_a_time { 1 } else { FLUSH_MAX_EVENTS };
        let claimed = CLAIM
            .run(
                self.dragonfly,
                fence(lease),
                &processing,
                &QueueItem::from_popped(Vec::new()),
                &[&queue],
                &[
                    most.to_string().as_bytes(),
                    FLUSH_MAX_BYTES.to_string().as_bytes(),
                ],
            )
            .await?;
        let Transition::Applied(value) = claimed else {
            return Ok(Step::End(FlushEnd::LeaseLost));
        };
        let mut reply = reply::array(value)?.into_iter();
        let (Some(resumed), Some(items), None) = (reply.next(), reply.next(), reply.next()) else {
            return Err(DragonflyError::Reply("unexpected claim reply"));
        };
        let resumed = usize::try_from(reply::int(resumed)?).unwrap_or(0);
        let items: Vec<QueueItem> = reply::array(items)?
            .into_iter()
            .map(|item| reply::bytes(item).map(QueueItem::from_popped))
            .collect::<Result<_, _>>()?;
        if items.is_empty() {
            return Ok(Step::End(FlushEnd::Drained));
        }
        report.resumed += resumed;

        let mut sendable = Vec::with_capacity(items.len());
        for item in items {
            let claimed = Claimed {
                wire: if item.as_bytes().len() > FLUSH_MAX_BYTES {
                    Err("larger than a flush batch".to_owned())
                } else {
                    match queued_event(item.as_bytes()) {
                        None => Err("not a queued usage event".to_owned()),
                        Some(event) => event.wire().map_err(|error| error.to_string()),
                    }
                },
                item,
            };
            match claimed.wire {
                Ok(wire) => sendable.push((claimed.item, wire)),
                Err(reason) => {
                    if !self
                        .dead_letter(channel, lease, &claimed.item, &reason)
                        .await?
                    {
                        return Ok(Step::End(FlushEnd::LeaseLost));
                    }
                    report.dead_lettered += 1;
                }
            }
        }
        if sendable.is_empty() {
            return Ok(Step::Continue);
        }

        let extended = EXTEND
            .run(
                self.dragonfly,
                fence(lease),
                &processing,
                &QueueItem::from_popped(Vec::new()),
                &[],
                &[FLUSH_SEND_LEASE_MS.to_string().as_bytes()],
            )
            .await?;
        if extended == Transition::LeaseLost {
            return Ok(Step::End(FlushEnd::LeaseLost));
        }
        let wire: Vec<Value> = sendable.iter().map(|(_, wire)| wire.clone()).collect();
        let items: Vec<&QueueItem> = sendable.iter().map(|(item, _)| item).collect();
        match self.polar.ingest_batch(&wire, FLUSH_SEND_TIMEOUT).await {
            Ok(BatchAnswer::Stored(result)) if result.is_complete(wire.len()) => {
                if !self.acknowledge(channel, lease, &items).await? {
                    return Ok(Step::End(FlushEnd::LeaseLost));
                }
                report.sent += wire.len();
                Ok(Step::Continue)
            }
            Ok(BatchAnswer::Stored(_)) => {
                self.observer.error(
                    "flushPolarUsage",
                    &format!(
                        "PolarSH ingest incomplete ({} expected); batch kept",
                        wire.len()
                    ),
                );
                Ok(Step::End(FlushEnd::OutcomeUnknown {
                    message: "PolarSH ingest incomplete".into(),
                }))
            }
            Ok(BatchAnswer::Invalid { events, status }) => {
                let named: Vec<(usize, String)> = if events.is_empty() && items.len() == 1 {
                    vec![(0, "invalid".to_owned())]
                } else {
                    events
                };
                let mut rest = Vec::with_capacity(items.len());
                for (index, item) in items.iter().enumerate() {
                    match named.iter().find(|(at, _)| *at == index) {
                        Some((_, kind)) => {
                            let reason = format!("Polar refused it ({status} {kind})");
                            if !self.dead_letter(channel, lease, item, &reason).await? {
                                return Ok(Step::End(FlushEnd::LeaseLost));
                            }
                            report.dead_lettered += 1;
                        }
                        None => rest.push(*item),
                    }
                }
                if !rest.is_empty()
                    && !self
                        .transition(&REQUEUE, channel, lease, &rest, &[&queue])
                        .await?
                {
                    return Ok(Step::End(FlushEnd::LeaseLost));
                }
                // When Polar did not say which event, find it one event at a time.
                Ok(if named.is_empty() {
                    Step::OneAtATime
                } else {
                    Step::Continue
                })
            }
            Err(error) if !error.outcome_unknown() => {
                let message = error.to_string();
                self.observer.error("flushPolarUsage", &message);
                if !self
                    .transition(&REQUEUE, channel, lease, &items, &[&queue])
                    .await?
                {
                    return Ok(Step::End(FlushEnd::LeaseLost));
                }
                Ok(Step::End(FlushEnd::Retry { message }))
            }
            Err(error) => {
                let message = error.to_string();
                self.observer
                    .error("flushPolarUsage", &format!("{message}; batch kept"));
                Ok(Step::End(FlushEnd::OutcomeUnknown { message }))
            }
        }
    }

    /// A fenced transition over a batch (the first item is `ARGV[2]`, the rest follow);
    /// `false` when the lease was lost.
    async fn transition(
        &self,
        script: &FencedTransition,
        channel: &str,
        lease: &Lease,
        items: &[&QueueItem],
        keys: &[&str],
    ) -> Result<bool, DragonflyError> {
        let Some((first, rest)) = items.split_first() else {
            return Ok(true);
        };
        let args: Vec<&[u8]> = rest.iter().map(|item| item.as_bytes()).collect();
        Ok(script
            .run(
                self.dragonfly,
                fence(lease),
                &processing_list(channel),
                first,
                keys,
                &args,
            )
            .await?
            != Transition::LeaseLost)
    }

    /// A fresh generation token for a revision the script may have to create.
    fn generation_token(&self) -> Result<String, DragonflyError> {
        self.random
            .uuid_v4()
            .map_err(|_| DragonflyError::Reply("generation token unavailable"))
    }

    /// Acknowledges a stored batch and holds its credits ([`ACK`]); `false` when the lease was
    /// lost.
    async fn acknowledge(
        &self,
        channel: &str,
        lease: &Lease,
        items: &[&QueueItem],
    ) -> Result<bool, DragonflyError> {
        let Some((first, rest)) = items.split_first() else {
            return Ok(true);
        };
        let now = self.clock.now_ms();
        let trailing = [
            now.to_string(),
            balance::SETTLE_AFTER_ACK_MS.to_string(),
            balance::ACK_BUCKET_MS.to_string(),
            self.generation_token()?,
            balance::REVISION_TTL_SECONDS.to_string(),
            balance::sweep_floor(now).to_string(),
        ];
        let mut args: Vec<&[u8]> = rest.iter().map(|item| item.as_bytes()).collect();
        args.extend(trailing.iter().map(String::as_bytes));
        let revision = balance::revision_key(channel);
        let credits = credits_cache_key(channel);
        Ok(ACK
            .run(
                self.dragonfly,
                fence(lease),
                &processing_list(channel),
                first,
                &[&revision, &credits],
                &args,
            )
            .await?
            != Transition::LeaseLost)
    }

    /// Moves one claimed item to the dead-letter list, its debit held by the entry (item 3 of
    /// P2-BILLING-02c: the hold moves with the event); `false` when the lease was lost.
    async fn dead_letter(
        &self,
        channel: &str,
        lease: &Lease,
        item: &QueueItem,
        reason: &str,
    ) -> Result<bool, DragonflyError> {
        let header = dead_letter_header(reason, self.clock.now_ms(), true);
        let dead = dead_letter_key(channel);
        let moved = DEAD_LETTER
            .run(
                self.dragonfly,
                fence(lease),
                &processing_list(channel),
                item,
                &[&dead],
                &[header.as_bytes()],
            )
            .await?;
        if moved == Transition::LeaseLost {
            return Ok(false);
        }
        self.observer.error(
            "flushPolarUsage",
            &format!("queued AI usage moved to the dead-letter list: {reason}"),
        );
        Ok(true)
    }

    /// Sets aside an event Polar's validation refuses before it is queued (it would never be
    /// accepted); no lease is needed, nothing claims the dead-letter list. Nothing was debited
    /// for it, so its entry holds nothing (`"held":false`) until an operator requeues it.
    pub async fn dead_letter_at_admission(
        &self,
        channel: &str,
        text: &str,
        reason: &str,
    ) -> Result<(), DragonflyError> {
        let entry = format!(
            "{}\n{text}",
            dead_letter_header(reason, self.clock.now_ms(), false)
        );
        self.dragonfly
            .rpush(&dead_letter_key(channel), &[entry.as_bytes()])
            .await?;
        self.observer.error(
            "ingestPolarSHEvent",
            &format!("AI usage refused before queueing, moved to the dead-letter list: {reason}"),
        );
        Ok(())
    }
}

fn processing_list(channel: &str) -> ProcessingList {
    ProcessingList::new(Cow::Owned(processing_key(channel)), End::Right)
}

fn fence(lease: &Lease) -> Fence<'_> {
    Fence {
        lease_key: &lease.key,
        owner: lease.owner.as_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_script_is_fenced_and_bounded() {
        for script in scripts() {
            assert!(script.check().is_ok(), "{}", script.script().name());
        }
    }

    #[test]
    fn dead_letter_entries_name_the_reason_and_time() {
        assert_eq!(
            dead_letter_header("Polar refused it (422 missing)", 7, true),
            r#"{"reason":"Polar refused it (422 missing)","at":7}"#
        );
        assert_eq!(
            dead_letter_header("refused", 7, false),
            r#"{"reason":"refused","at":7,"held":false}"#
        );
    }
}
