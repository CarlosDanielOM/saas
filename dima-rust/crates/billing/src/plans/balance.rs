//! The usage revision of a channel's cached balance (item 4 of P2-BILLING-01b, review findings
//! 4 and 7).
//!
//! **Workaround module.** The plan fence and its scripts belong to `dima-store`
//! (`dragonfly::plan_cache_fence`), which this package may not edit. Its credit scripts are the
//! reference's (`ACCEPT_PLAN_CREDITS_SCRIPT` in write mode, `SYNC_CREDITS_SCRIPT`) and know
//! nothing of local debits, so this crate publishes balances with its own scripts that keep the
//! same plan-fence and snapshot-version checks and add the revision. Change wanted in the store:
//! a revisioned credit publication in `plan_cache_fence` (these four scripts and
//! [`revision_key`]), after which this module goes away. The plan fence itself stays as it is
//! for plan changes (`INVALIDATE_PLAN_SCRIPT`).
//!
//! **The revision.** `twitch:{id}:ai:credits:revision` is a hash (*rebuilt* at cutover, like the
//! cache it guards; 31-day TTL, renewed on every write):
//!
//! | Field | Advanced by |
//! |---|---|
//! | `rev` | every local debit and every accepted publication |
//! | `pub` | set to `rev` by every accepted publication |
//! | `debits` | every local debit, by the credits it consumed (whole credits) |
//!
//! A fetch reads it before asking Polar. Its publication ([`PUBLISH`]) is refused when a
//! publication was accepted since (`pub` newer: that snapshot is at least as fresh), and
//! otherwise applies the debits made since (`debits` grew) to what Polar answered before it
//! stores it, so a slow fetch can neither overwrite a newer snapshot nor give back credit spent
//! meanwhile; the debit's deduplication marker no longer loses it. A webhook's snapshot
//! ([`SYNC`]) is published as the reference publishes it and is reconciled the same way with the
//! debits made since its projection began. A debit can at worst be counted twice for a few
//! minutes (when Polar's answer already included it), never given back.
//!
//! **The exhaustion flags** are read and repaired in one script ([`EXHAUSTION`]), so a repair
//! is conditional, by construction, on exactly the state it read: it can no longer recreate
//! flags a refill cleared after the read.
//!
//! Every script is bounded (no loop) and declares every key it touches.

use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{Dragonfly, DragonflyError, Script};

/// The lines the debit script adds to `APPLY_AI_CREDIT_USAGE_SCRIPT`, right before it reads the
/// snapshot: every debit (not a duplicate) advances the revision, with or without a snapshot to
/// apply it to.
pub const DEBIT_REVISION_LINES: &str =
    "local consumedNow = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
if consumedNow > 0 then
    redis.call('HINCRBY', KEYS[5], 'rev', 1)
    redis.call('HINCRBY', KEYS[5], 'debits', consumedNow)
    redis.call('EXPIRE', KEYS[5], ARGV[4])
end
";

/// `APPLY_AI_CREDIT_USAGE_SCRIPT` with [`DEBIT_REVISION_LINES`] (`KEYS[5]`, the revision).
pub static DEBIT: Script = Script::new(
    "APPLY_AI_CREDIT_USAGE_REVISED",
    include_str!("lua/credits_debit.lua"),
);
/// The publication of a fetched balance.
pub static PUBLISH: Script = Script::new(
    "PUBLISH_AI_CREDITS",
    include_str!("lua/credits_publish.lua"),
);
/// `SYNC_CREDITS_SCRIPT` with the revision.
pub static SYNC: Script = Script::new("SYNC_CREDITS_REVISED", include_str!("lua/credits_sync.lua"));
/// `isAiCreditsExhausted` in one step.
pub static EXHAUSTION: Script = Script::new(
    "CHECK_AI_CREDITS_EXHAUSTION",
    include_str!("lua/credits_exhaustion.lua"),
);

/// The revision's TTL: as long as a debit's deduplication marker.
pub const REVISION_TTL_SECONDS: u64 = super::credits_cache::USAGE_MARKER_TTL_SECONDS;

/// `twitch:{id}:ai:credits:revision`.
pub fn revision_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:revision")
}

/// The revision as read before a fetch or a projection.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Revision {
    /// `rev`.
    pub rev: i64,
    /// `debits`.
    pub debits: i64,
}

/// Reads the revision (`HMGET`, one atomic command); a missing hash or field is 0.
pub async fn read_revision(dragonfly: &Dragonfly, id: &str) -> Result<Revision, DragonflyError> {
    let values: Vec<Option<String>> = dragonfly
        .query(
            redis::cmd("HMGET")
                .arg(revision_key(id))
                .arg("rev")
                .arg("debits"),
        )
        .await?;
    let field = |index: usize| {
        values
            .get(index)
            .and_then(Option::as_deref)
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0)
    };
    Ok(Revision {
        rev: field(0),
        debits: field(1),
    })
}

/// What [`PUBLISH`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Publication {
    /// Stored: the value stored (with the debits made since the fetch began).
    Accepted(String),
    /// A newer publication was accepted since the fetch began: the value cached now (may be
    /// empty when it has expired since).
    Superseded(String),
    /// The plan fence is newer.
    Fenced,
}

/// Decodes `{status, value}`.
pub(crate) fn publication(value: redis::Value) -> Result<Publication, DragonflyError> {
    let mut items = reply::array(value)?.into_iter();
    let (Some(status), Some(raw), None) = (items.next(), items.next(), items.next()) else {
        return Err(DragonflyError::Reply("unexpected publication reply"));
    };
    let raw = reply::text(raw)?;
    Ok(match reply::int(status)? {
        1 => Publication::Accepted(raw),
        2 => Publication::Superseded(raw),
        0 => Publication::Fenced,
        _ => return Err(DragonflyError::Reply("unexpected publication status")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_script_is_bounded() {
        for script in [&DEBIT, &PUBLISH, &SYNC, &EXHAUSTION] {
            assert!(script.check().is_ok(), "{}", script.name());
        }
        assert!(DEBIT.source().contains(DEBIT_REVISION_LINES));
        assert_eq!(revision_key("12"), "twitch:12:ai:credits:revision");
    }
}
