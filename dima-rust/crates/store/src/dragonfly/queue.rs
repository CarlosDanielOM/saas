//! Opaque queues (charter data rule 6): an item is carried as the exact bytes that were popped.
//!
//! `LREM` and `LPOS` match whole elements byte for byte, so an item that was parsed and written
//! again (another key order, `1.0` for `1`, `\/` for `/`, a different escape) is never found: the
//! processing entry stays stuck, or a deduplicating publish pushes a duplicate. [`QueueItem`]
//! makes that mistake hard: reading it gives a borrowed view ([`QueueItem::view`]) or a parsed
//! copy ([`QueueItem::parse`]), and every operation that removes, acknowledges or requeues takes
//! the item itself, never a parsed value.
//!
//! Items Rust creates are written with [`QueueItem::encode`]. The encoding is Rust's own (queues
//! are drained at the cutover, `MIGRATION.md` section 3): compact JSON from one deterministic
//! writer, so the same value always gives the same bytes. Nothing depends on it matching what
//! Node's `JSON.stringify` would write; that it currently does for plain values is incidental.
//! What matters is that acknowledgement and requeue use the popped bytes, never a re-encoding.
//!
//! Direction is part of the contract and differs per queue (ledger, "Queues"); [`presets`] lists
//! the reference's list queues. Two are newest-first (`LPUSH` + head pop): `cron:jobs:queue` and
//! `cron:stream-memory:queue`. That is how the reference behaves; do not "fix" it.

use super::blocking::BlockingConnection;
use super::client::Dragonfly;
use super::commands::{End, reply};
use super::error::{DragonflyError, Result};
use super::script::{Script, reads};
use dima_text::{number_to_string, sanitize_lone_surrogates, to_js_json, to_js_json_from};
use serde::de::{Deserialize, DeserializeOwned};
use std::borrow::Cow;
use std::num::NonZeroUsize;
use std::time::Duration;

/// One queue element, exactly as stored.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct QueueItem {
    raw: Vec<u8>,
}

impl std::fmt::Debug for QueueItem {
    // Items can carry tokens or personal data: show the size only.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "QueueItem({} bytes)", self.raw.len())
    }
}

impl QueueItem {
    /// An element as Dragonfly returned it (a pop, a move, a script reply). The bytes are kept
    /// as they are; they need not be UTF-8 or JSON.
    pub fn from_popped(raw: Vec<u8>) -> Self {
        Self { raw }
    }

    /// A new item Rust creates: compact JSON of `value`, Rust's own deterministic encoding (see
    /// the module docs).
    pub fn encode<T: serde::Serialize + ?Sized>(value: &T) -> Result<Self> {
        Ok(Self {
            raw: to_js_json_from(value)?,
        })
    }

    /// A new item from a JSON value built in Rust, with the same writer as [`Self::encode`].
    /// Prefer [`Self::encode`] with a struct; this is for producers that spread free-form data.
    pub fn encode_value(value: &serde_json::Value) -> Self {
        Self {
            raw: to_js_json(value).into_bytes(),
        }
    }

    /// The exact bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.raw
    }

    /// The bytes as text, when they are UTF-8.
    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.raw).ok()
    }

    /// A borrowed view: deserialise into a type that may borrow from the item (`&str`,
    /// `Cow<str>`, `&RawValue`). Strict JSON: a lone surrogate escape (which `JSON.parse` accepts)
    /// is an error here; use [`Self::parse`] for such input.
    pub fn view<'a, T: Deserialize<'a>>(&'a self) -> Result<T> {
        super::error::decode(&self.raw)
    }

    /// A parsed copy, after replacing lone surrogate escapes with U+FFFD as `JSON.parse` input
    /// is repaired at the edge (text rule 3). The item keeps its original bytes for
    /// acknowledgement and requeue. Failures of both are [`super::DragonflyError::Decode`]:
    /// a category and a position, never the item's text.
    pub fn parse<T: DeserializeOwned>(&self) -> Result<T> {
        super::error::decode(&sanitize_lone_surrogates(&self.raw))
    }

    /// Gives up the item and returns its bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.raw
    }
}

impl AsRef<[u8]> for QueueItem {
    fn as_ref(&self) -> &[u8] {
        &self.raw
    }
}

/// A list used as a queue: which end producers push to and which end consumers take from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListQueue {
    key: Cow<'static, str>,
    push_end: End,
    pop_end: End,
}

impl ListQueue {
    /// A queue on `key`. Same ends (`Left`, `Left`) is newest-first; opposite ends is oldest-first.
    pub const fn new(key: Cow<'static, str>, push_end: End, pop_end: End) -> Self {
        Self {
            key,
            push_end,
            pop_end,
        }
    }

    /// The list key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The end producers push to.
    pub fn push_end(&self) -> End {
        self.push_end
    }

    /// The end consumers take from.
    pub fn pop_end(&self) -> End {
        self.pop_end
    }

    /// Pushes a new item at the producers' end; returns the new length.
    pub async fn push(&self, dragonfly: &Dragonfly, item: &QueueItem) -> Result<i64> {
        self.push_at(dragonfly, item, self.push_end).await
    }

    /// Pushes the item's exact bytes at `end` (requeue to the tail with `RPUSH`, to the head with
    /// `LPUSH`, as the consumer in the reference does); returns the new length.
    pub async fn push_at(&self, dragonfly: &Dragonfly, item: &QueueItem, end: End) -> Result<i64> {
        let command = match end {
            End::Left => "LPUSH",
            End::Right => "RPUSH",
        };
        reply::int(
            dragonfly
                .query_value(
                    redis::cmd(command)
                        .arg(self.key.as_ref())
                        .arg(item.as_bytes()),
                )
                .await?,
        )
    }

    /// Takes one item from the consumers' end without blocking (`LPOP` / `RPOP`).
    pub async fn pop(&self, dragonfly: &Dragonfly) -> Result<Option<QueueItem>> {
        let command = match self.pop_end {
            End::Left => "LPOP",
            End::Right => "RPOP",
        };
        Ok(reply::bytes_or_nil(
            dragonfly
                .query_value(redis::cmd(command).arg(self.key.as_ref()))
                .await?,
        )?
        .map(QueueItem::from_popped))
    }

    /// Takes one item, waiting up to `timeout` (`BLPOP` / `BRPOP`; zero waits forever). A
    /// destructive pop: if the process dies before the work is done, the item is gone (the
    /// reference's `cron:jobs:queue` accepts that).
    pub async fn blocking_pop(
        &self,
        connection: &mut BlockingConnection,
        timeout: Duration,
    ) -> Result<Option<QueueItem>> {
        let popped = match self.pop_end {
            End::Left => connection.blpop(&[self.key.as_ref()], timeout).await?,
            End::Right => connection.brpop(&[self.key.as_ref()], timeout).await?,
        };
        Ok(popped.map(|(_, item)| item))
    }

    /// Moves one item from the consumers' end into a processing list (`LMOVE`), without blocking.
    pub async fn claim(
        &self,
        dragonfly: &Dragonfly,
        processing: &ProcessingList,
    ) -> Result<Option<QueueItem>> {
        let mut cmd = redis::cmd("LMOVE");
        cmd.arg(self.key.as_ref())
            .arg(processing.key.as_ref())
            .arg(self.pop_end.keyword())
            .arg(processing.insert_end.keyword());
        Ok(reply::bytes_or_nil(dragonfly.query_value(&cmd).await?)?.map(QueueItem::from_popped))
    }

    /// Moves one item into a processing list, waiting up to `timeout` (`BLMOVE`; zero waits
    /// forever). The item stays recoverable from the processing list if the process dies.
    pub async fn blocking_claim(
        &self,
        connection: &mut BlockingConnection,
        processing: &ProcessingList,
        timeout: Duration,
    ) -> Result<Option<QueueItem>> {
        connection
            .blmove(
                self.key.as_ref(),
                processing.key.as_ref(),
                self.pop_end,
                processing.insert_end,
                timeout,
            )
            .await
    }

    /// Length (`LLEN`).
    pub async fn len(&self, dragonfly: &Dragonfly) -> Result<i64> {
        reply::int(
            dragonfly
                .query_value(redis::cmd("LLEN").arg(self.key.as_ref()))
                .await?,
        )
    }
}

/// The list claimed items wait in until they are acknowledged.
///
/// # Unfenced helpers
///
/// The helpers here ([`Self::acknowledge_unfenced`], [`Self::recover_one_unfenced`],
/// [`Self::contains`]) check no owner: any process that holds the item's bytes can remove or
/// move it, even after its lease (the worker lock) has passed to another process. They are one
/// command each, so composing them is not atomic either: "check the lease, then `LREM`, then
/// `LPUSH`" can interleave with another owner's moves. That is enough only where the reference
/// itself is unfenced (stream memory's success path `LREM processing 1 raw`, its recovery
/// `RPOPLPUSH` while holding the worker lock).
///
/// Wherever the reference fences a transition with a Lua script that first compares the lease
/// (`clip_recommendation_claims.ts`, the stream memory retry at `stream_memory.worker.ts:399`,
/// the AI usage receipt claims), use a [`FencedTransition`]: the consumer's own script, run
/// atomically with the lease check inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessingList {
    key: Cow<'static, str>,
    insert_end: End,
}

impl ProcessingList {
    /// A processing list on `key`; claims insert at `insert_end`.
    pub const fn new(key: Cow<'static, str>, insert_end: End) -> Self {
        Self { key, insert_end }
    }

    /// The list key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Acknowledges an item without an owner check: `LREM processing 1 <exact bytes>`. Returns
    /// how many were removed (0: it was not there, for example already acknowledged or recovered
    /// elsewhere). Unfenced (see the type docs); a fenced queue uses a [`FencedTransition`].
    pub async fn acknowledge_unfenced(
        &self,
        dragonfly: &Dragonfly,
        item: &QueueItem,
    ) -> Result<i64> {
        reply::int(
            dragonfly
                .query_value(
                    redis::cmd("LREM")
                        .arg(self.key.as_ref())
                        .arg(1)
                        .arg(item.as_bytes()),
                )
                .await?,
        )
    }

    /// Recovers one item into `queue` with `RPOPLPUSH processing queue` (stream memory's
    /// recovery: the oldest claim goes back to the queue's head). Unfenced (see the type docs):
    /// call it only while holding the worker lock, as the reference does; the clip queue's
    /// recovery checks the lease inside Lua and needs a [`FencedTransition`].
    pub async fn recover_one_unfenced(
        &self,
        dragonfly: &Dragonfly,
        queue: &ListQueue,
    ) -> Result<Option<QueueItem>> {
        Ok(reply::bytes_or_nil(
            dragonfly
                .query_value(
                    redis::cmd("RPOPLPUSH")
                        .arg(self.key.as_ref())
                        .arg(queue.key()),
                )
                .await?,
        )?
        .map(QueueItem::from_popped))
    }

    /// Whether the exact item is in the list (`LPOS`), as the clip scripts check before moving it.
    pub async fn contains(&self, dragonfly: &Dragonfly, item: &QueueItem) -> Result<bool> {
        let value = dragonfly
            .query_value(
                redis::cmd("LPOS")
                    .arg(self.key.as_ref())
                    .arg(item.as_bytes()),
            )
            .await?;
        Ok(!matches!(value, redis::Value::Nil))
    }
}

/// Who may move a processing list's items: the lease key and the owner token stored in it.
#[derive(Clone, Copy, Debug)]
pub struct Fence<'a> {
    /// The lease key (the worker lock), `KEYS[1]` of a [`FencedTransition`].
    pub lease_key: &'a str,
    /// The token this process stored in it, `ARGV[1]`.
    pub owner: &'a [u8],
}

/// How a [`FencedTransition`] ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Transition {
    /// The script answered `-1`: the lease is not ours (any more), and nothing was changed.
    LeaseLost,
    /// The lease held and the script ran; its reply, decoded by the caller.
    Applied(redis::Value),
}

/// A consumer's own owner-fenced transition on a processing list (acknowledge, retry, dead
/// letter, recover), run as one Lua script so the lease check and the moves are atomic.
///
/// The layout is the reference's (`clip_recommendation_claims.ts`: "KEYS start with the worker
/// lock and processing list; ARGV start with owner and raw claim"), so its scripts are reused
/// verbatim:
///
/// - `KEYS[1]` the lease key, `KEYS[2]` the processing list, then the caller's keys;
/// - `ARGV[1]` the owner token, `ARGV[2]` the item's exact bytes, then the caller's arguments;
/// - the script starts with `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end`,
///   and `-1` means [`Transition::LeaseLost`].
///
/// It runs through [`Script::run_value`], which refuses scripts with obviously unbounded loops
/// (`MIGRATION.md` data rule 7); [`Self::check`] also refuses a script whose code (comments and
/// strings excluded) never reads `KEYS[1]` and `ARGV[1]`. That is a convention check, not a
/// proof that the script compares them before it changes anything: review each script. Register each as a `static`, one `.lua` file per script:
///
/// ```ignore
/// pub static REQUEUE: FencedTransition =
///     FencedTransition::new("STREAM_MEMORY_REQUEUE", include_str!("lua/stream_memory_requeue.lua"));
/// ```
#[derive(Debug)]
pub struct FencedTransition {
    script: Script,
}

impl FencedTransition {
    /// A transition from its embedded source; `name` is the reference's name for it.
    pub const fn new(name: &'static str, source: &'static str) -> Self {
        Self {
            script: Script::new(name, source),
        }
    }

    /// The script.
    pub fn script(&self) -> &Script {
        &self.script
    }

    /// Refuses a script with an obviously unbounded loop, or one whose code (comments and
    /// strings excluded) never reads `KEYS[1]` and `ARGV[1]` (a convention check).
    pub fn check(&self) -> Result<()> {
        self.script.check()?;
        let source = self.script.source();
        if !(reads(source, b"KEYS", b"1") && reads(source, b"ARGV", b"1")) {
            return Err(DragonflyError::ScriptRefused {
                name: self.script.name(),
                reason: "a fenced transition must compare KEYS[1] (the lease) with ARGV[1] (the owner)",
            });
        }
        Ok(())
    }

    /// Runs the transition for `item` under `fence` (see the type docs for the layout).
    /// `keys` and `args` follow the fixed ones. A lost reply leaves the outcome unknown
    /// ([`DragonflyError::outcome_unknown`]): read the lists to learn what happened.
    pub async fn run(
        &self,
        dragonfly: &Dragonfly,
        fence: Fence<'_>,
        processing: &ProcessingList,
        item: &QueueItem,
        keys: &[&str],
        args: &[&[u8]],
    ) -> Result<Transition> {
        self.check()?;
        let mut all_keys: Vec<&[u8]> = Vec::with_capacity(2 + keys.len());
        all_keys.push(fence.lease_key.as_bytes());
        all_keys.push(processing.key().as_bytes());
        all_keys.extend(keys.iter().map(|key| key.as_bytes()));
        let mut all_args: Vec<&[u8]> = Vec::with_capacity(2 + args.len());
        all_args.push(fence.owner);
        all_args.push(item.as_bytes());
        all_args.extend_from_slice(args);
        match self
            .script
            .run_value(dragonfly, &all_keys, &all_args)
            .await?
        {
            redis::Value::Int(-1) => Ok(Transition::LeaseLost),
            value => Ok(Transition::Applied(value)),
        }
    }
}

/// A sorted set used as a delay queue: members are ids (or payloads), scores are due times.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelayQueue {
    key: Cow<'static, str>,
}

impl DelayQueue {
    /// A delay queue on `key`.
    pub const fn new(key: Cow<'static, str>) -> Self {
        Self { key }
    }

    /// The sorted-set key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Schedules (or reschedules) `member` at `score` (`ZADD`, score written as JavaScript would).
    pub async fn schedule(
        &self,
        dragonfly: &Dragonfly,
        member: &QueueItem,
        score: f64,
    ) -> Result<i64> {
        dragonfly
            .zadd(&self.key, &[(score, member.as_bytes())])
            .await
    }

    /// At most `limit` members due between `min` and `max` inclusive, lowest score first
    /// (`ZRANGEBYSCORE key min max LIMIT 0 limit`). The limit is sent to the server, so one call
    /// never reads more than `limit` members however far behind the queue is. The reference reads
    /// every due member (`0 .. now`) and slices its batch in memory; the batch it then works on is
    /// the same. A caller that needs every due member loops: claim (remove) the batch, then ask
    /// again until a call returns fewer than `limit`.
    pub async fn due(
        &self,
        dragonfly: &Dragonfly,
        min: f64,
        max: f64,
        limit: NonZeroUsize,
    ) -> Result<Vec<QueueItem>> {
        let value = dragonfly
            .query_value(
                redis::cmd("ZRANGEBYSCORE")
                    .arg(self.key.as_ref())
                    .arg(number_to_string(min))
                    .arg(number_to_string(max))
                    .arg("LIMIT")
                    .arg(0)
                    .arg(limit.get()),
            )
            .await?;
        let members = reply::array(value)?;
        if members.len() > limit.get() {
            return Err(super::DragonflyError::Reply(
                "ZRANGEBYSCORE returned more members than its LIMIT",
            ));
        }
        members
            .into_iter()
            .map(|member| reply::bytes(member).map(QueueItem::from_popped))
            .collect()
    }

    /// Claims a member by removing it (`ZREM` = 1): of several processes racing for the same
    /// member exactly one gets `true`, the reference's single-delivery rule.
    pub async fn claim(&self, dragonfly: &Dragonfly, member: &QueueItem) -> Result<bool> {
        let removed = reply::int(
            dragonfly
                .query_value(
                    redis::cmd("ZREM")
                        .arg(self.key.as_ref())
                        .arg(member.as_bytes()),
                )
                .await?,
        )?;
        Ok(removed == 1)
    }

    /// Takes the lowest-scored member (`ZPOPMIN`), with its score.
    pub async fn pop_min(&self, dragonfly: &Dragonfly) -> Result<Option<(QueueItem, f64)>> {
        Ok(dragonfly
            .zpopmin(&self.key)
            .await?
            .map(|(member, score)| (QueueItem::from_popped(member), score)))
    }
}

/// The reference's list queues, with their direction (ledger, "Queues").
pub mod presets {
    use super::{End, ListQueue, ProcessingList};
    use std::borrow::Cow::Borrowed;

    /// `cron:jobs:queue`: `LPUSH` (Lua `ENQUEUE_DEDUPLICATED_JOB`) + `BLPOP` = **newest first**.
    /// Requeues and unsupported jobs go to the tail with `RPUSH`. No processing list: a crash
    /// after the pop loses the job (its dedupe marker expires).
    pub const CRON_JOBS: ListQueue =
        ListQueue::new(Borrowed("cron:jobs:queue"), End::Left, End::Left);
    /// `cron:jobs:dead-letter` (`RPUSH`).
    pub const CRON_JOBS_DEAD_LETTER: &str = "cron:jobs:dead-letter";

    /// `cron:stream-memory:queue`: `LPUSH` (Lua `PUBLISH_DURABLE_CRON_JOB`) + `BLMOVE LEFT RIGHT`
    /// into the processing list = **newest first**. Acknowledge is `LREM processing 1 raw`
    /// ([`ProcessingList::acknowledge_unfenced`]); the owner-checked requeue (Lua, moves the raw
    /// item back with `LPUSH` to the head) is a [`super::FencedTransition`] of the worker's;
    /// recovery is `RPOPLPUSH processing queue` under the worker lock.
    pub const STREAM_MEMORY: ListQueue =
        ListQueue::new(Borrowed("cron:stream-memory:queue"), End::Left, End::Left);
    /// `cron:stream-memory:processing` (claims inserted at the tail).
    pub const STREAM_MEMORY_PROCESSING: ProcessingList =
        ProcessingList::new(Borrowed("cron:stream-memory:processing"), End::Right);
    /// `cron:stream-memory:dead-letter` (`RPUSH`).
    pub const STREAM_MEMORY_DEAD_LETTER: &str = "cron:stream-memory:dead-letter";

    /// `cron:clip-recommendations:queue`: `LPUSH` + `BLMOVE RIGHT LEFT` = oldest first. Every
    /// later transition (acknowledge, requeue, dead letter, recover) is owner-fenced Lua
    /// (`CLIP_CLAIM_SCRIPTS`): [`super::FencedTransition`]s ported with the clip worker.
    pub const CLIP_RECOMMENDATIONS: ListQueue = ListQueue::new(
        Borrowed("cron:clip-recommendations:queue"),
        End::Left,
        End::Right,
    );
    /// `cron:clip-recommendations:processing` (claims inserted at the head).
    pub const CLIP_RECOMMENDATIONS_PROCESSING: ProcessingList =
        ProcessingList::new(Borrowed("cron:clip-recommendations:processing"), End::Left);

    /// `cron:ai-usage-receipts:queue`: `RPUSH` + Lua claim (`LPOP` → `RPUSH` processing) = oldest
    /// first. Claim, complete and fail are Lua scripts owned by the receipts worker.
    pub const AI_USAGE_RECEIPTS: ListQueue = ListQueue::new(
        Borrowed("cron:ai-usage-receipts:queue"),
        End::Right,
        End::Left,
    );

    /// `cron:ai-usage-backfills:queue`: `RPUSH` (Lua) + Lua claim (`LPOP` → `RPUSH`) = oldest first.
    pub const AI_USAGE_BACKFILLS: ListQueue = ListQueue::new(
        Borrowed("cron:ai-usage-backfills:queue"),
        End::Right,
        End::Left,
    );

    /// `observability:v1:inbox`: `LPUSH` (Lua, trimmed to 100) + `LMOVE RIGHT LEFT` = oldest first.
    pub const OBSERVABILITY_INBOX: ListQueue =
        ListQueue::new(Borrowed("observability:v1:inbox"), End::Left, End::Right);
    /// `observability:v1:processing` (claims inserted at the head, read with `LINDEX 0`).
    pub const OBSERVABILITY_PROCESSING: ProcessingList =
        ProcessingList::new(Borrowed("observability:v1:processing"), End::Left);
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_fence_only_mentioned_in_a_comment_or_string_is_refused() {
        static COMMENTED: FencedTransition = FencedTransition::new(
            "COMMENTED",
            "-- compares KEYS[1] with ARGV[1]\nreturn redis.call('LREM', KEYS[2], 1, ARGV[2])",
        );
        assert!(COMMENTED.check().is_err());
        static QUOTED: FencedTransition = FencedTransition::new(
            "QUOTED",
            "local s = 'KEYS[1] ARGV[1]' return redis.call('LREM', KEYS[2], 1, ARGV[2])",
        );
        assert!(QUOTED.check().is_err());
        static FENCED: FencedTransition = FencedTransition::new(
            "FENCED",
            "if redis.call('GET', KEYS[ 1 ]) ~= ARGV[1] then return -1 end return 1",
        );
        assert!(FENCED.check().is_ok());
    }

    use super::*;
    use serde::Serialize;
    use std::borrow::Cow;

    #[derive(Serialize)]
    struct Job<'a> {
        id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        absent: Option<&'a str>,
        attempt: f64,
    }

    /// Pins Rust's own encoding (stable bytes for the same value), not Node's.
    #[test]
    fn encode_is_deterministic_compact_json() {
        let item = QueueItem::encode(&Job {
            id: "a\"/\u{2028}é",
            absent: None,
            attempt: 2.0,
        })
        .unwrap();
        assert_eq!(
            item.as_str().unwrap(),
            "{\"id\":\"a\\\"/\u{2028}é\",\"attempt\":2}"
        );
    }

    #[test]
    fn views_borrow_and_bytes_survive() {
        let raw = b"{\"id\":\"x\",  \"n\": 1.0}".to_vec();
        let item = QueueItem::from_popped(raw.clone());
        #[derive(serde::Deserialize)]
        struct View<'a> {
            #[serde(borrow)]
            id: Cow<'a, str>,
        }
        let view: View<'_> = item.view().unwrap();
        assert!(matches!(view.id, Cow::Borrowed("x")));
        assert_eq!(item.as_bytes(), raw.as_slice());
        assert_eq!(
            format!("{item:?}"),
            format!("QueueItem({} bytes)", raw.len())
        );
    }

    #[test]
    fn parse_repairs_lone_surrogates_but_keeps_bytes() {
        let item = QueueItem::from_popped(br#"{"t":"\ud800x"}"#.to_vec());
        assert!(item.view::<serde_json::Value>().is_err());
        let value: serde_json::Value = item.parse().unwrap();
        assert_eq!(value["t"], "\u{fffd}x");
        assert_eq!(item.as_bytes(), br#"{"t":"\ud800x"}"#);
    }

    #[test]
    fn non_utf8_items_are_carried() {
        let item = QueueItem::from_popped(vec![0xff, 0xfe, b'{']);
        assert_eq!(item.as_str(), None);
        assert!(item.parse::<serde_json::Value>().is_err());
        assert_eq!(item.into_bytes(), vec![0xff, 0xfe, b'{']);
    }
}
