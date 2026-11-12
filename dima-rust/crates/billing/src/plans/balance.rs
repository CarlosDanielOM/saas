//! The hold of local debits against the balance Polar reports, and the generation of a
//! channel's cached balance (item 4 of P2-BILLING-01b; item 1 of P2-BILLING-01c, re-check
//! finding N1).
//!
//! **Workaround module.** The plan fence and its scripts belong to `dima-store`
//! (`dragonfly::plan_cache_fence`), which this package may not edit. Its credit scripts are the
//! reference's (`ACCEPT_PLAN_CREDITS_SCRIPT` in write mode, `SYNC_CREDITS_SCRIPT`) and know
//! nothing of local debits, so this crate publishes balances with its own scripts that keep the
//! same plan-fence and snapshot-version checks and add the hold. Change wanted in the store: a
//! held credit publication in `plan_cache_fence` (these scripts, [`revision_key`] and the queue
//! keys of [`crate::polar::flush`]), after which this module goes away. The plan fence itself
//! stays as it is for plan changes (`INVALIDATE_PLAN_SCRIPT`).
//!
//! # What "covered" means
//!
//! Polar's customer state gives one net figure per meter (`consumed_units`, `credited_units`,
//! `balance`) and no trace of which events it counted; its meter is updated in the background
//! after an event is stored. Our own grants (usage events with negative credits), period resets
//! and other Twitch accounts of the same customer move those figures too, so "the consumption
//! went up by at least the pending debits" can be satisfied by an event that is not the debit
//! (which would give it back) or never (a grant landed meanwhile). The rule here therefore uses
//! only what this crate knows for certain, the life of the usage event behind each debit:
//!
//! - **queued** (in the channel's usage queue or its processing list): Polar has not stored it,
//!   or the outcome of the request is unknown. Held, counted straight from the lists at
//!   publication (exact: no counter to drift).
//! - **acknowledged** (the flush's acknowledgement, an immediate ingest that Polar answered, or a
//!   debit recorded without a queued event, [`super::credits_cache::CreditsCache::record_ai_credit_usage`]):
//!   Polar stored it at `ack`. Held for figures dated before `ack + `[`SETTLE_AFTER_ACK_MS`]: the
//!   time Polar's meter is given to count it.
//! - **dead-lettered** (Polar refuses it for good): held like a queued event; Polar never counts
//!   it and an operator settles it.
//!
//! A debit is **covered** by a figure from Polar dated `T` (when the fetch began, or the
//! webhook's `occurredAt`, never later than now) when it was acknowledged at least
//! [`SETTLE_AFTER_ACK_MS`] before `T`, or queued at least [`QUEUED_HOLD_MS`] before `T`. Every
//! debit not covered is subtracted from the figure before it is stored. This is the lead's rule
//! (acknowledged, then a time bound) without the consumption test, for the reason above: it
//! releases a debit only on a fact that no other event can fake, so it is at least as safe.
//!
//! # The bound
//!
//! Errors fall on one side only: the stored balance is Polar's figure minus what is held, never
//! more than Polar's figure; a debit Polar already counts but that is still held is counted twice
//! and shows **less**, for at most [`SETTLE_AFTER_ACK_MS`] after its acknowledgement (plus the
//! [`ACK_BUCKET_MS`] rounding), and it is corrected by the next publication after that (a
//! published balance lives [`super::credits::AI_CREDITS_CACHE_TTL_SECONDS`]). No debit is held
//! for ever: an acknowledged one is released `SETTLE_AFTER_ACK_MS` after its acknowledgement; a
//! queued or dead-lettered one [`QUEUED_HOLD_MS`] after it was queued (plus
//! [`DEAD_LETTER_BUCKET_MS`] rounding for a dead letter), even if the flush never succeeds. If
//! Polar's meter takes longer than [`SETTLE_AFTER_ACK_MS`] to count an acknowledged event, the
//! balance shows Polar's own figure until it does (never more than Polar shows).
//!
//! # Publications
//!
//! A fetch from Polar first runs [`BEGIN`], which returns the channel's generation and how many
//! publications were accepted in it; its publication ([`PUBLISH`]) is then:
//!
//! | Case | Outcome |
//! |---|---|
//! | same generation, no publication since | stored, with every uncovered debit held ([`Publication::Accepted`]) |
//! | a publication was accepted since the fetch began | nothing changes; the newer balance stands ([`Publication::Superseded`]) |
//! | the revision is gone, or was recreated (Dragonfly lost it) | nothing published; a balance left without its revision is deleted, so the next read starts clean ([`Publication::Lost`]) |
//! | the plan fence is newer | nothing changes ([`Publication::Fenced`]) |
//! | more than [`MOST_QUEUED`] events wait to be counted | nothing changes ([`Publication::Backlog`]) |
//! | the figure is older than [`MAX_FIGURE_AGE_MS`] | nothing changes ([`Publication::Stale`]) |
//!
//! A webhook's snapshot ([`SYNC`]) is ordered by its snapshot version as in the reference (an
//! equal version is published again), within the generation read when its projection began, and
//! held the same way, dated by its `occurredAt`. Publishing the same snapshot twice stores the
//! same balance whatever debits happen in between: each debit is in the snapshot already (the
//! debit script applied it) and in the hold, in the same amount, until it is covered, and whether
//! it is covered depends only on the snapshot's date. A balance found without its revision
//! (by a read, a debit, an acknowledgement or [`BEGIN`]) belongs to a lost generation and is
//! deleted: the next read starts from Polar under a new one.
//!
//! # The revision hash
//!
//! `twitch:{id}:ai:credits:revision` (*rebuilt* at cutover, like the cache it guards; 31-day TTL,
//! renewed on every write):
//!
//! | Field | Value |
//! |---|---|
//! | `gen` | a random token (UUID) set when the hash is created |
//! | `pub` | publications accepted in this generation |
//! | `h:{ms}` | whole credits held for figures dated before `{ms}`: acknowledged events in [`ACK_BUCKET_MS`] buckets, dead letters in [`DEAD_LETTER_BUCKET_MS`] buckets; buckets older than [`MAX_FIGURE_AGE_MS`] are removed by every write, so the hash holds at most [`MAX_HOLD_FIELDS`] of them |
//!
//! A queued event carries `queuedAt` (ms) in its queued JSON ([`crate::polar::flush`]).
//!
//! **The exhaustion flags** are read and repaired in one script ([`EXHAUSTION`]).
//!
//! Every script is bounded (loops over the hash's fields, at most [`MOST_QUEUED`] queued items,
//! or a batch) and declares every key it touches.

use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{Dragonfly, DragonflyError, Script};

/// The functions every hold script shares (`lua/credits_hold.lua`), placed before each body.
pub const HOLD_PRELUDE: &str = include_str!("lua/credits_hold.lua");

/// The lines the debit script adds before `APPLY_AI_CREDIT_USAGE_SCRIPT`: the revision must be a
/// hash (or absent) before the idempotency marker is taken.
pub const DEBIT_GUARD_LINES: &str = "local revisionKind = holdKind(KEYS[5])
if revisionKind ~= 'none' and revisionKind ~= 'hash' then
    return redis.error_reply('WRONGTYPE revision is a ' .. tostring(revisionKind))
end
";

/// The lines the debit script adds to `APPLY_AI_CREDIT_USAGE_SCRIPT`, right before it reads the
/// snapshot: the generation (a balance without its revision is deleted, so the reference's text
/// then finds none), and the hold of a debit whose event is not queued.
pub const DEBIT_HOLD_LINES: &str =
    "local consumedNow = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
ensureGeneration(KEYS[5], KEYS[1], ARGV[6], ARGV[4])
if consumedNow > 0 and ARGV[7] ~= '' then
    holdUntil(KEYS[5], tonumber(ARGV[7]), tonumber(ARGV[8]), consumedNow)
    heldAt(KEYS[5], 0, tonumber(ARGV[9]))
end
";

/// `APPLY_AI_CREDIT_USAGE_SCRIPT` with [`HOLD_PRELUDE`], [`DEBIT_GUARD_LINES`] and
/// [`DEBIT_HOLD_LINES`].
pub static DEBIT: Script = Script::new(
    "APPLY_AI_CREDIT_USAGE_HELD",
    concat!(
        include_str!("lua/credits_hold.lua"),
        include_str!("lua/credits_debit.lua")
    ),
);
/// The start of a fetch or a webhook projection: the generation.
pub static BEGIN: Script = Script::new(
    "BEGIN_AI_CREDITS_READ",
    concat!(
        include_str!("lua/credits_hold.lua"),
        include_str!("lua/credits_begin.lua")
    ),
);
/// The publication of a fetched balance.
pub static PUBLISH: Script = Script::new(
    "PUBLISH_AI_CREDITS_HELD",
    concat!(
        include_str!("lua/credits_hold.lua"),
        include_str!("lua/credits_publish.lua")
    ),
);
/// `SYNC_CREDITS_SCRIPT` with the hold.
pub static SYNC: Script = Script::new(
    "SYNC_CREDITS_HELD",
    concat!(
        include_str!("lua/credits_hold.lua"),
        include_str!("lua/credits_sync.lua")
    ),
);
/// `isAiCreditsExhausted` in one step.
pub static EXHAUSTION: Script = Script::new(
    "CHECK_AI_CREDITS_EXHAUSTION",
    include_str!("lua/credits_exhaustion.lua"),
);

/// The revision's TTL: as long as a debit's deduplication marker.
pub const REVISION_TTL_SECONDS: u64 = super::credits_cache::USAGE_MARKER_TTL_SECONDS;
/// How long after Polar acknowledged a usage event its debit is still held: the time its meter
/// is given to count it (two minutes; normally a few seconds).
pub const SETTLE_AFTER_ACK_MS: i64 = 2 * 60 * 1000;
/// How long after it was queued an event Polar has not acknowledged (or refused for good) is
/// held at most: a flush that keeps failing cannot hold a channel down for longer.
pub const QUEUED_HOLD_MS: i64 = 24 * 60 * 60 * 1000;
/// The oldest figure from Polar still published (by its date); held buckets older than this are
/// removed.
pub const MAX_FIGURE_AGE_MS: i64 = 60 * 60 * 1000;
/// Acknowledged debits are held in buckets of this size (their release time rounded up).
pub const ACK_BUCKET_MS: i64 = 30 * 1000;
/// Dead letters are held in buckets of this size (their release time rounded up).
pub const DEAD_LETTER_BUCKET_MS: i64 = 60 * 60 * 1000;
/// The most queued and claimed events a publication counts; past it nothing is published (the
/// cached balance, which carries every local debit, stays).
pub const MOST_QUEUED: usize = 5000;
/// The most hold buckets the hash keeps: acknowledged ones span at most
/// `MAX_FIGURE_AGE_MS + SETTLE_AFTER_ACK_MS`, dead letters `MAX_FIGURE_AGE_MS + QUEUED_HOLD_MS`.
pub const MAX_HOLD_FIELDS: i64 = (MAX_FIGURE_AGE_MS + SETTLE_AFTER_ACK_MS) / ACK_BUCKET_MS
    + 1
    + (MAX_FIGURE_AGE_MS + QUEUED_HOLD_MS) / DEAD_LETTER_BUCKET_MS
    + 1;

/// `twitch:{id}:ai:credits:revision`.
pub fn revision_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:revision")
}

/// The sweep floor of every write at `now_ms`: buckets released before it are removed.
pub(crate) fn sweep_floor(now_ms: i64) -> i64 {
    now_ms - MAX_FIGURE_AGE_MS
}

/// Where a read from Polar began: the generation, the publications accepted so far, and the
/// date of the figure it will publish.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Start {
    pub(crate) generation: String,
    pub(crate) publications: i64,
    pub(crate) as_of_ms: i64,
}

/// Runs [`BEGIN`] for channel `id` at `now_ms`; `candidate` becomes the generation when the
/// channel has none (a fresh random token per call).
pub(crate) async fn begin(
    dragonfly: &Dragonfly,
    id: &str,
    candidate: &str,
    now_ms: i64,
) -> Result<Start, DragonflyError> {
    let keys = [
        revision_key(id),
        dima_store::dragonfly::plan_cache_fence::credits_cache_key(id),
    ];
    let args = [candidate.to_owned(), REVISION_TTL_SECONDS.to_string()];
    let mut items = reply::array(BEGIN.run_value(dragonfly, &keys, &args).await?)?.into_iter();
    let (Some(generation), Some(publications), None) = (items.next(), items.next(), items.next())
    else {
        return Err(DragonflyError::Reply("unexpected begin reply"));
    };
    Ok(Start {
        generation: reply::text(generation)?,
        publications: reply::int(publications)?,
        as_of_ms: now_ms,
    })
}

/// What [`PUBLISH`] did (see the module docs' table).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Publication {
    /// Stored: the value stored (with every uncovered debit held).
    Accepted(String),
    /// A newer publication was accepted since the fetch began: the value cached now (may be
    /// empty when it has expired since).
    Superseded(String),
    /// The plan fence is newer.
    Fenced,
    /// The generation was lost while the fetch ran: nothing published, and a balance left
    /// without its revision deleted.
    Lost,
    /// Too many queued events to count: nothing published; the value cached now.
    Backlog(String),
    /// The figure is older than [`MAX_FIGURE_AGE_MS`].
    Stale,
}

/// Decodes `{status, value, publications}`: the publication and, when it was accepted, the
/// publications accepted in the generation with it.
pub(crate) fn publication(value: redis::Value) -> Result<(Publication, i64), DragonflyError> {
    let mut items = reply::array(value)?.into_iter();
    let (Some(status), Some(raw), Some(count), None) =
        (items.next(), items.next(), items.next(), items.next())
    else {
        return Err(DragonflyError::Reply("unexpected publication reply"));
    };
    let raw = reply::text(raw)?;
    let count = reply::int(count)?;
    Ok((
        match reply::int(status)? {
            1 => Publication::Accepted(raw),
            2 => Publication::Superseded(raw),
            0 => Publication::Fenced,
            3 => Publication::Lost,
            4 => Publication::Backlog(raw),
            5 => Publication::Stale,
            _ => return Err(DragonflyError::Reply("unexpected publication status")),
        },
        count,
    ))
}

/// The local top-up after a grant ([`super::credits_cache::CreditsCache::top_up`]).
pub static TOP_UP: Script = Script::new(
    "TOP_UP_AI_CREDITS",
    concat!(
        include_str!("lua/credits_hold.lua"),
        include_str!("lua/credits_top_up.lua")
    ),
);

/// When a debit's event is released from the hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Hold {
    /// The event is in the channel's queue: the queue holds it ([`PUBLISH`] counts it there).
    Queued,
    /// Polar stored the event at `now` (or nothing is queued for it): held until
    /// `now + SETTLE_AFTER_ACK_MS`.
    Acknowledged,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_script_is_bounded() {
        for script in [&DEBIT, &BEGIN, &PUBLISH, &SYNC, &EXHAUSTION, &TOP_UP] {
            assert!(script.check().is_ok(), "{}", script.name());
        }
        assert!(DEBIT.source().starts_with(HOLD_PRELUDE));
        assert!(DEBIT.source().contains(DEBIT_GUARD_LINES));
        assert!(DEBIT.source().contains(DEBIT_HOLD_LINES));
        assert_eq!(revision_key("12"), "twitch:12:ai:credits:revision");
        // 125 acknowledgement buckets and 26 dead-letter buckets at most.
        assert_eq!(MAX_HOLD_FIELDS, 151);
        const { assert!(MAX_HOLD_FIELDS * 2 + 4 < 2000, "within heldAt's cap") };
    }
}
