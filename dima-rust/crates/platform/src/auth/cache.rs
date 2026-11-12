//! The validation cache: which Twitch identity a token was proven to belong to, for a short time.
//!
//! Rust's own key family (Dragonfly is internal, `MIGRATION.md` section 3; *rebuilt* at the
//! cutover: clearing it logs nobody out, a miss validates with Twitch again).
//!
//! | | reference (`token:{token}`) | here |
//! |---|---|---|
//! | key | the raw bearer token | `auth:token:{sha256(token) base64url}`: the token cannot be read back from the key space |
//! | value | hash `id, login, display_name, profile_image_url` (HSET, then a separate EXPIRE) | JSON of the same four fields and `since` (when the authentication began), written with `SET … EX` inside the publication script |
//! | lifetime | 14000 s | `min(cache_ttl, expires_in − time spent)`: [`super::DEFAULT_CACHE_TTL`] (3600 s, Twitch's hourly validation rule) and never past the token's own expiry; not written below [`super::MIN_CACHE_TTL`] or when `expires_in` is unknown |
//!
//! Why the differences: a raw token in a key is readable by anyone who can list keys; a
//! separate `EXPIRE` that fails after the `HSET` leaves an entry that never expires (a revoked
//! token accepted for ever); and 14000 s outlived both a revocation on Twitch's side and a token
//! that expires sooner.
//!
//! # Fences: a sign-out cannot be undone by an authentication in flight
//!
//! An authentication reads the entry and Dragonfly's clock in one script ([`LOOKUP`]): that
//! server time is when it *began*. It then asks Twitch, and publishes the entry with
//! [`PUBLISH`], which in the same script refuses to write when
//!
//! - the authentication began more than the publication window ago
//!   ([`super::AuthConfig::publish_window`]: one lookup, two Twitch calls and the publication,
//!   each under its deadline, plus 5 s of slack; 35 s by default), or
//! - the **token fence** `auth:token-fence:{sha256(token)}` holds a time at or after the
//!   beginning ([`forget_token`] sets it, and deletes the entry, in one script), or
//! - the **user fence** `auth:user-fence:{twitch id}` does ([`forget_user`]).
//!
//! A fence is the server time of the forget plus [`CLOCK_ALLOWANCE`] (so a small step back of
//! the server's clock cannot let an authentication that began before the forget through; the
//! cost is that tokens authenticated in the next 5 s are not cached), never lowered by a later
//! forget, and expires. Its lifetime:
//!
//! - token fence: `2 × window + allowance` (75 s by default). Enough: a publication that
//!   arrives after the fence expired is more than `window` after any beginning the fence
//!   covered, so the age check refuses it. One small string per forgotten token, gone after it.
//! - user fence: `cache_ttl + 2 × window + allowance` (3675 s by default). Forgetting by user
//!   must also end the entries **already cached** for that user's tokens, which cannot be listed
//!   (the key is a hash of the token). So every read checks the entry's `since` against the
//!   user fence ([`get`], a second `GET` on a hit) and treats an entry that began at or before
//!   it as a miss. The fence outlives every entry it covers: such an entry was published within
//!   `window` of its beginning and lives at most `cache_ttl`. One small string per forgotten
//!   user, gone after an hour. Chosen over an index of tokens per user: an index must be kept
//!   in step with every publication and expiry, grows with every sign-in, and would still need
//!   the fence for authentications in flight.
//!
//! The comparisons use only Dragonfly's clock, never a process clock, so two processes
//! (the API and the bot) agree.

use super::AuthenticatedUser;
use dima_core::crypto::keys::sha256_base64url;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{Dragonfly, Script, SetOptions};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// How far ahead of the server's clock a fence is set (see the module docs).
pub const CLOCK_ALLOWANCE: Duration = Duration::from_secs(5);

/// Reads an entry and the server's clock.
static LOOKUP: Script = Script::new("AUTH_TOKEN_LOOKUP_SCRIPT", include_str!("lookup.lua"));
/// Writes an entry unless a fence moved or the authentication is too old.
static PUBLISH: Script = Script::new("AUTH_TOKEN_PUBLISH_SCRIPT", include_str!("publish.lua"));
/// Advances a fence (and deletes a token's entry).
static FORGET: Script = Script::new("AUTH_TOKEN_FORGET_SCRIPT", include_str!("forget.lua"));

/// The cache key of a token.
pub fn token_cache_key(token: &str) -> String {
    format!("auth:token:{}", sha256_base64url(token))
}

/// The fence a sign-out sets for one token.
pub fn token_fence_key(token: &str) -> String {
    format!("auth:token-fence:{}", sha256_base64url(token))
}

/// The fence that ends every cached validation of one Twitch user.
pub fn user_fence_key(twitch_user_id: &str) -> String {
    format!("auth:user-fence:{twitch_user_id}")
}

/// The key that limits the activity touch to once a day per user (reference name kept).
pub fn activity_touch_key(twitch_user_id: &str) -> String {
    format!("twitch:{twitch_user_id}:last_app_activity_touch")
}

/// The stored value. Decoded here only: the public identity is never deserialised.
#[derive(Serialize, Deserialize)]
struct Cached {
    id: String,
    login: String,
    display_name: String,
    profile_image_url: String,
    /// Server milliseconds when the authentication began; an entry without it is older than
    /// every fence.
    #[serde(default)]
    since: i64,
}

/// Why the cache could not be used.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CacheError {
    #[error("Dragonfly: {0}")]
    Store(#[from] dima_store::dragonfly::DragonflyError),
    #[error("Dragonfly did not answer within the deadline")]
    Deadline,
    #[error("the cached value could not be encoded")]
    Encode,
    #[error("Dragonfly answered a cache script unexpectedly")]
    Protocol,
}

async fn bounded<T>(
    deadline: Duration,
    future: impl Future<Output = Result<T, dima_store::dragonfly::DragonflyError>>,
) -> Result<T, CacheError> {
    match tokio::time::timeout(deadline, future).await {
        Ok(result) => result.map_err(CacheError::from),
        Err(_) => Err(CacheError::Deadline),
    }
}

/// Milliseconds since the epoch from a `TIME` reply's two strings.
fn server_ms(seconds: redis::Value, micros: redis::Value) -> Result<i64, CacheError> {
    let number = |value| -> Result<i64, CacheError> {
        reply::text(value)?
            .parse::<i64>()
            .map_err(|_| CacheError::Protocol)
    };
    Ok(number(seconds)?
        .saturating_mul(1000)
        .saturating_add(number(micros)? / 1000))
}

/// What a lookup found.
pub(crate) struct Lookup {
    /// The identity, when a live entry exists and no user fence covers it.
    pub user: Option<AuthenticatedUser>,
    /// Server time of the lookup: when an authentication that follows a miss began.
    pub began: i64,
}

/// `getCachedToken`: the identity, when an entry with a non-empty `id` exists and no user fence
/// covers it. A value that does not decode is a miss (the reference: `!data.id`).
pub(crate) async fn get(
    cache: &Dragonfly,
    token: &str,
    deadline: Duration,
) -> Result<Lookup, CacheError> {
    let keys = [token_cache_key(token)];
    let reply = bounded(deadline, LOOKUP.run_value(cache, &keys, &[] as &[&str])).await?;
    let mut items = reply::array(reply)?.into_iter();
    let (Some(seconds), Some(micros)) = (items.next(), items.next()) else {
        return Err(CacheError::Protocol);
    };
    let began = server_ms(seconds, micros)?;
    let miss = Lookup { user: None, began };
    let Some(entry) = items.next() else {
        return Ok(miss);
    };
    let Ok(cached) = serde_json::from_slice::<Cached>(&reply::bytes(entry)?) else {
        return Ok(miss);
    };
    if cached.id.is_empty() {
        return Ok(miss);
    }
    let fence = bounded(deadline, cache.get_text(&user_fence_key(&cached.id))).await?;
    if let Some(fence) = fence {
        // A fence that does not parse covers everything.
        if !matches!(fence.parse::<i64>(), Ok(at) if at < cached.since) {
            return Ok(miss);
        }
    }
    Ok(Lookup {
        user: Some(AuthenticatedUser {
            id: cached.id,
            login: cached.login,
            display_name: cached.display_name,
            // The reference caches `profile_image_url || ''` and reads that back.
            profile_image_url: Some(cached.profile_image_url),
        }),
        began,
    })
}

/// What [`publish`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Published {
    /// The entry was written.
    Written,
    /// The authentication began longer than the window ago.
    TooOld,
    /// The token was forgotten after the authentication began.
    TokenForgotten,
    /// The user was forgotten after the authentication began.
    UserForgotten,
}

/// The fence-checked `cacheToken`, in one script.
pub(crate) struct Publication<'a> {
    pub token: &'a str,
    pub user: &'a AuthenticatedUser,
    pub began: i64,
    pub ttl_seconds: u64,
    pub window: Duration,
}

pub(crate) async fn publish(
    cache: &Dragonfly,
    publication: Publication<'_>,
    deadline: Duration,
) -> Result<Published, CacheError> {
    let Publication {
        token,
        user,
        began,
        ttl_seconds,
        window,
    } = publication;
    let value = serde_json::to_vec(&Cached {
        id: user.id.clone(),
        login: user.login.clone(),
        display_name: user.display_name.clone(),
        profile_image_url: user.profile_image_url.clone().unwrap_or_default(),
        since: began,
    })
    .map_err(|_| CacheError::Encode)?;
    let keys = [
        token_cache_key(token),
        token_fence_key(token),
        user_fence_key(&user.id),
    ];
    let args: [Vec<u8>; 4] = [
        value,
        ttl_seconds.max(1).to_string().into_bytes(),
        began.to_string().into_bytes(),
        window.as_millis().to_string().into_bytes(),
    ];
    let reply = bounded(deadline, PUBLISH.run_value(cache, &keys, &args)).await?;
    match reply::int(reply)? {
        1 => Ok(Published::Written),
        0 => Ok(Published::TooOld),
        -1 => Ok(Published::TokenForgotten),
        -2 => Ok(Published::UserForgotten),
        _ => Err(CacheError::Protocol),
    }
}

async fn advance(
    cache: &Dragonfly,
    keys: &[String],
    fence_ttl: Duration,
    deadline: Duration,
) -> Result<(), CacheError> {
    let args = [
        CLOCK_ALLOWANCE.as_millis().to_string(),
        fence_ttl.as_millis().max(1).to_string(),
    ];
    let reply = bounded(deadline, FORGET.run_value(cache, keys, &args)).await?;
    reply::int(reply)?;
    Ok(())
}

/// Removes a token's entry and advances its fence (sign-out), in one script: the next request
/// validates with Twitch, and no authentication already in flight can publish it again.
pub(crate) async fn forget_token(
    cache: &Dragonfly,
    token: &str,
    fence_ttl: Duration,
    deadline: Duration,
) -> Result<(), CacheError> {
    let keys = [token_fence_key(token), token_cache_key(token)];
    advance(cache, &keys, fence_ttl, deadline).await
}

/// Advances a user's fence (account deletion, a ban): every cached validation of that user's
/// tokens is a miss from now on, and none in flight can be published.
pub(crate) async fn forget_user(
    cache: &Dragonfly,
    twitch_user_id: &str,
    fence_ttl: Duration,
    deadline: Duration,
) -> Result<(), CacheError> {
    advance(
        cache,
        &[user_fence_key(twitch_user_id)],
        fence_ttl,
        deadline,
    )
    .await
}

/// `EXISTS` on the touch key.
pub(crate) async fn touched_recently(
    cache: &Dragonfly,
    twitch_user_id: &str,
    deadline: Duration,
) -> Result<bool, CacheError> {
    Ok(bounded(
        deadline,
        cache.exists(&[&activity_touch_key(twitch_user_id)]),
    )
    .await?
        == 1)
}

/// `SET key 1` and its expiry, in one command.
pub(crate) async fn mark_touched(
    cache: &Dragonfly,
    twitch_user_id: &str,
    ttl_seconds: u64,
    deadline: Duration,
) -> Result<(), CacheError> {
    bounded(
        deadline,
        cache.set(
            &activity_touch_key(twitch_user_id),
            b"1",
            SetOptions::ex(ttl_seconds.max(1)),
        ),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_pass_the_loop_check() {
        for script in [&LOOKUP, &PUBLISH, &FORGET] {
            assert!(script.check().is_ok(), "{}", script.name());
        }
    }
}
