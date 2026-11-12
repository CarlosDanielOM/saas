//! The validation cache: which Twitch identity a token was proven to belong to, for a short time.
//!
//! Rust's own key family (Dragonfly is internal, `MIGRATION.md` section 3; *rebuilt* at the
//! cutover: clearing it logs nobody out, a miss validates with Twitch again).
//!
//! | | reference (`token:{token}`) | here |
//! |---|---|---|
//! | key | the raw bearer token | `auth:token:{sha256(token) base64url}`: the token cannot be read back from the key space |
//! | value | hash `id, login, display_name, profile_image_url` (HSET, then a separate EXPIRE) | JSON of the same four fields, written with `SET … EX` in one command |
//! | lifetime | 14000 s | `min(cache_ttl, expires_in)`: [`super::DEFAULT_CACHE_TTL`] (3600 s, Twitch's hourly validation rule) and never past the token's own expiry |
//!
//! Why the differences: a raw token in a key is readable by anyone who can list keys; a
//! separate `EXPIRE` that fails after the `HSET` leaves an entry that never expires (a revoked
//! token accepted for ever); and 14000 s outlived both a revocation on Twitch's side and a token
//! that expires sooner.

use super::AuthenticatedUser;
use dima_core::crypto::keys::sha256_base64url;
use dima_store::dragonfly::{Dragonfly, SetOptions};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The cache key of a token.
pub fn token_cache_key(token: &str) -> String {
    format!("auth:token:{}", sha256_base64url(token))
}

/// The key that limits the activity touch to once a day per user (reference name kept).
pub fn activity_touch_key(twitch_user_id: &str) -> String {
    format!("twitch:{twitch_user_id}:last_app_activity_touch")
}

/// The stored value.
#[derive(Serialize, Deserialize)]
struct Cached {
    id: String,
    login: String,
    display_name: String,
    profile_image_url: String,
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

/// `getCachedToken`: the identity, when an entry with a non-empty `id` exists. A value that does
/// not decode is a miss (the reference: `!data.id`).
pub(crate) async fn get(
    cache: &Dragonfly,
    token: &str,
    deadline: Duration,
) -> Result<Option<AuthenticatedUser>, CacheError> {
    let Some(bytes) = bounded(deadline, cache.get(&token_cache_key(token))).await? else {
        return Ok(None);
    };
    let Ok(cached) = serde_json::from_slice::<Cached>(&bytes) else {
        return Ok(None);
    };
    if cached.id.is_empty() {
        return Ok(None);
    }
    Ok(Some(AuthenticatedUser {
        id: cached.id,
        login: cached.login,
        display_name: cached.display_name,
        // The reference caches `profile_image_url || ''` and reads that back.
        profile_image_url: Some(cached.profile_image_url),
    }))
}

/// `cacheToken`, in one command.
pub(crate) async fn put(
    cache: &Dragonfly,
    token: &str,
    user: &AuthenticatedUser,
    ttl_seconds: u64,
    deadline: Duration,
) -> Result<(), CacheError> {
    let value = serde_json::to_vec(&Cached {
        id: user.id.clone(),
        login: user.login.clone(),
        display_name: user.display_name.clone(),
        profile_image_url: user.profile_image_url.clone().unwrap_or_default(),
    })
    .map_err(|_| CacheError::Encode)?;
    bounded(
        deadline,
        cache.set(
            &token_cache_key(token),
            &value,
            SetOptions::ex(ttl_seconds.max(1)),
        ),
    )
    .await?;
    Ok(())
}

/// Removes a token's entry (sign-out, account deletion): the next request validates with Twitch.
pub(crate) async fn forget(
    cache: &Dragonfly,
    token: &str,
    deadline: Duration,
) -> Result<(), CacheError> {
    bounded(deadline, cache.del(&[&token_cache_key(token)])).await?;
    Ok(())
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
