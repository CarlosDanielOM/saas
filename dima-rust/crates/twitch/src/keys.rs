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
//! | `locks:refresh:twitch:{id}` (`PX 5000`) | `acquireRefreshLock` | **rebuilt** (a 5 s lease; Rust's database starts without one) |
//! | `app:twitch:token` (envelope, `EX expires_in`; plain text in the reference) | `getNewTwitchAppToken` | **rebuilt**: a new app token is requested on first use |
//! | `twitch:{id}:emote-catalog:v1` (JSON, `EX 86400`) | `twitch_emotes.ts` | **rebuilt** from Helix on first use |
//! | `twitch:{id}:ai:credits:plan-version` (fence) | billing | read here (fence of the account hash); owned by the billing package |
//! | `streamers:by:name` | legacy (`DEL` only, no writer) | not written or deleted by Rust |
//! | `app:twitch:bot` (hash, bot token copy) | `getBotToken` (write only, no reader) | not written by Rust |
//! | `oauth:failures:{api,token_refresh}:{ms}` | `oauth_debug_cache.ts` (write only, no reader) | not written by Rust |
//!
//! Nothing here is *carried*: every value is derived from MongoDB or Twitch, and the Rust
//! processes use their own logical database (`MIGRATION.md` section 3).

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
    }
}
