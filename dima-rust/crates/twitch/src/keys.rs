//! The Dragonfly keys of this crate, and what happens to each family at the cutover.
//!
//! Every key is the reference's template. Tests put a prefix in front of all of them
//! ([`KeySpace::prefixed`]) so they can share a logical database; production has none.
//!
//! | Family | Reference | At the cutover |
//! |---|---|---|
//! | `accounts:twitch:{id}:data` (hash; tokens as `{iv, content}` envelopes, plain text in the reference) | `twitch_streamers.class.ts`, `tokens.ts` | **rebuilt**: the start-up load writes every streamer from MongoDB again |
//! | `twitch:accounts` (JSON aggregate, `EX 3600`) | `CHECK_PLAN_ACCOUNTS_SCRIPT` | **rebuilt** on the next read |
//! | `streamers:by:id` (set) | `getTwitchAccountsFromDB`, hydration | **rebuilt** by the start-up load |
//! | `locks:refresh:twitch:{id}` (`PX 5000`, renewed by its holder) | `acquireRefreshLock` | **rebuilt** (a 5 s lease; Rust's database starts without one) |
//! | `locks:refresh:twitch:{id}:exchange` (`PX 30000`, renewed) | Rust only: an exchange is (or may be) in flight | **rebuilt** |
//! | `app:twitch:token` (envelope, `EX expires_in`; plain text in the reference) | `getNewTwitchAppToken` | **rebuilt**: a new app token is requested on first use |
//! | `twitch:{id}:refresh:parked` (hash: `generation`, `rotation` as JSON of envelopes; **no expiry**) | Rust only: the recovery record of an answer MongoDB has not taken (`crate::recovery`) | **drained**, never flushed while one is left: the next refresh of that streamer or the reconciliation ([`crate::Twitch::reconcile_recovery`], at every start and on its tick) writes it to MongoDB. Rust's database starts without any at the cutover; before a rollback it is reconciled and the unmatched ones settled by an operator (`crate::recovery`, rollback) |
//! | `twitch:{id}:refresh:parked:conflict` (hash: `generation`, `rotation`, as the record; **no expiry**) | Rust only: a second, different answer of the record's generation (review G2: two exchanges of one stored state); both are unmatched until MongoDB's generation moves or an operator settles them | **drained** with the records |
//! | `twitch:{id}:refresh:quarantine` (hash: `parked:` and `conflict:` + `generation`, `rotation`, `type`; `signed_in_generation`, `quarantined_at` in ms; `PX` 30 days) | Rust only: records a verified sign-in superseded (older than its generation, or unreadable), moved there for inspection (review G3); never read by a refresh or the reconciliation, only counted and listed | **rebuilt** (inspection only; may be flushed once no one needs it) |
//! | `twitch:{id}:emote-catalog:v1` (JSON, `EX 86400`) | `twitch_emotes.ts` | **rebuilt** from Helix on first use |
//! | `twitch:{id}:ai:credits:plan-version` (fence) | billing | read here (fence of the account hash); owned by the billing package |
//! | `streamers:by:name` | legacy (`DEL` only, no writer) | not written or deleted by Rust |
//! | `app:twitch:bot` (hash, bot token copy) | `getBotToken` (write only, no reader) | not written by Rust |
//! | `oauth:failures:{api,token_refresh}:{ms}` | `oauth_debug_cache.ts` (write only, no reader) | not written by Rust |
//!
//! Nothing here is *carried*: every value is derived from MongoDB or Twitch, and the Rust
//! processes use their own logical database (`MIGRATION.md` section 3).

/// The kinds of recovery key ([`KeySpace::recovery_key`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RecoveryKey {
    /// `twitch:{id}:refresh:parked`, the recovery record.
    Parked,
    /// `twitch:{id}:refresh:parked:conflict`, its side record.
    Conflict,
    /// `twitch:{id}:refresh:quarantine`, records a sign-in superseded.
    Quarantine,
}

/// The prefix of every key (empty in production).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeySpace {
    prefix: String,
}

impl KeySpace {
    /// The production keys: the reference's templates as they are.
    pub fn production() -> Self {
        Self::default()
    }

    /// Every key behind `prefix` (tests sharing a logical database). The prefix should be
    /// letters, digits and `:` or `_`: it also goes into a `SCAN MATCH` pattern.
    pub fn prefixed(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    /// The prefix.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// `accounts:twitch:{id}:data`.
    pub fn account(&self, id: &str) -> String {
        format!("{}accounts:twitch:{id}:data", self.prefix)
    }

    /// `accounts:twitch:*:data`, the pattern `getTwitchAccountsFromCache` lists.
    pub fn account_pattern(&self) -> String {
        format!("{}accounts:twitch:*:data", self.prefix)
    }

    /// `twitch:accounts`.
    pub fn aggregate(&self) -> String {
        format!("{}twitch:accounts", self.prefix)
    }

    /// `streamers:by:id`.
    pub fn streamer_ids(&self) -> String {
        format!("{}streamers:by:id", self.prefix)
    }

    /// `twitch:{id}:ai:credits:plan-version`.
    pub fn plan_fence(&self, id: &str) -> String {
        format!("{}twitch:{id}:ai:credits:plan-version", self.prefix)
    }

    /// `locks:refresh:twitch:{id}`.
    pub fn refresh_lock(&self, id: &str) -> String {
        format!("{}locks:refresh:twitch:{id}", self.prefix)
    }

    /// `locks:refresh:twitch:{id}:exchange`.
    pub fn exchange_marker(&self, id: &str) -> String {
        format!("{}:exchange", self.refresh_lock(id))
    }

    /// `twitch:{id}:refresh:parked`.
    pub fn parked_rotation(&self, id: &str) -> String {
        format!("{}twitch:{id}:refresh:parked", self.prefix)
    }

    /// `twitch:{id}:refresh:parked:conflict`, the side record of a second answer of the same
    /// generation.
    pub fn parked_conflict(&self, id: &str) -> String {
        format!("{}:conflict", self.parked_rotation(id))
    }

    /// `twitch:{id}:refresh:quarantine`, where a sign-in moves the records it supersedes.
    pub fn refresh_quarantine(&self, id: &str) -> String {
        format!("{}twitch:{id}:refresh:quarantine", self.prefix)
    }

    /// `twitch:*:refresh:*`, the pattern the reconciliation scans: every recovery key
    /// ([`KeySpace::recovery_key`]).
    pub fn recovery_pattern(&self) -> String {
        format!("{}twitch:*:refresh:*", self.prefix)
    }

    /// The streamer id and the kind of a recovery key (`None` for any other key).
    pub fn recovery_key<'a>(&self, key: &'a str) -> Option<(&'a str, RecoveryKey)> {
        let (id, rest) = key
            .strip_prefix(self.prefix.as_str())?
            .strip_prefix("twitch:")?
            .split_once(":refresh:")?;
        if id.is_empty() || id.contains(':') {
            return None;
        }
        let kind = match rest {
            "parked" => RecoveryKey::Parked,
            "parked:conflict" => RecoveryKey::Conflict,
            "quarantine" => RecoveryKey::Quarantine,
            _ => return None,
        };
        Some((id, kind))
    }

    /// `twitch:*:refresh:parked`, the pattern of the records alone.
    pub fn parked_pattern(&self) -> String {
        format!("{}twitch:*:refresh:parked", self.prefix)
    }

    /// The streamer id in a key of [`KeySpace::parked_rotation`] (`None` for any other key).
    pub fn parked_user<'a>(&self, key: &'a str) -> Option<&'a str> {
        key.strip_prefix(self.prefix.as_str())?
            .strip_prefix("twitch:")?
            .strip_suffix(":refresh:parked")
            .filter(|id| !id.is_empty() && !id.contains(':'))
    }

    /// `app:twitch:token`.
    pub fn app_token(&self) -> String {
        format!("{}app:twitch:token", self.prefix)
    }

    /// `twitch:{id}:emote-catalog:v1`.
    pub fn emote_catalog(&self, id: &str) -> String {
        format!("{}twitch:{id}:emote-catalog:v1", self.prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_keys_are_the_reference_templates() {
        let keys = KeySpace::production();
        assert_eq!(keys.account("42"), "accounts:twitch:42:data");
        assert_eq!(keys.account_pattern(), "accounts:twitch:*:data");
        assert_eq!(keys.aggregate(), "twitch:accounts");
        assert_eq!(keys.streamer_ids(), "streamers:by:id");
        assert_eq!(keys.plan_fence("42"), "twitch:42:ai:credits:plan-version");
        assert_eq!(keys.refresh_lock("42"), "locks:refresh:twitch:42");
        assert_eq!(keys.app_token(), "app:twitch:token");
        assert_eq!(keys.emote_catalog("42"), "twitch:42:emote-catalog:v1");
        // The store's own builders agree on the shared families.
        assert_eq!(
            keys.account("42"),
            dima_store::dragonfly::plan_cache_fence::account_cache_key("42")
        );
        assert_eq!(
            keys.plan_fence("42"),
            dima_store::dragonfly::plan_cache_fence::plan_cache_fence_key("42")
        );
        assert_eq!(
            keys.aggregate(),
            dima_store::dragonfly::plan_cache_fence::ACCOUNTS_CACHE_KEY
        );
        assert_eq!(
            KeySpace::prefixed("t1:").account("42"),
            "t1:accounts:twitch:42:data"
        );
        // The reconciliation finds recovery records by their pattern and reads the id back.
        assert_eq!(keys.parked_pattern(), "twitch:*:refresh:parked");
        assert_eq!(keys.parked_user(&keys.parked_rotation("42")), Some("42"));
        let test = KeySpace::prefixed("t1:");
        assert_eq!(test.parked_pattern(), "t1:twitch:*:refresh:parked");
        assert_eq!(test.parked_user(&test.parked_rotation("42")), Some("42"));
        assert_eq!(
            keys.parked_conflict("42"),
            "twitch:42:refresh:parked:conflict"
        );
        assert_eq!(keys.recovery_pattern(), "twitch:*:refresh:*");
        assert_eq!(
            test.recovery_key(&test.parked_rotation("42")),
            Some(("42", RecoveryKey::Parked))
        );
        assert_eq!(
            test.recovery_key(&test.parked_conflict("42")),
            Some(("42", RecoveryKey::Conflict))
        );
        assert_eq!(
            test.recovery_key(&test.refresh_quarantine("42")),
            Some(("42", RecoveryKey::Quarantine))
        );
        assert_eq!(
            keys.refresh_quarantine("42"),
            "twitch:42:refresh:quarantine"
        );
        for other in [
            "twitch:42:refresh:parked",
            "t1:twitch:42:refresh:other",
            "t1:twitch::refresh:parked",
            "t1:twitch:4:2:refresh:parked",
            "t1:twitch:42:emote-catalog:v1",
        ] {
            assert_eq!(test.recovery_key(other), None, "{other}");
        }
        for other in [
            "twitch:42:emote-catalog:v1",
            "t1:twitch:42:refresh:parked",
            "twitch::refresh:parked",
            "twitch:4:2:refresh:parked",
        ] {
            assert_eq!(keys.parked_user(other), None, "{other}");
        }
    }
}
