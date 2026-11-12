//! One refresh at a time per streamer (review finding 3): the in-process gate, the
//! cross-process lease and the exchange marker.
//!
//! - **Gate.** Every refresh of a streamer in a process (a token request, a rejected token, the
//!   public [`crate::Twitch::refresh_token`], [`crate::Twitch::credentials_changed`]) first takes
//!   that streamer's gate, an async mutex: the protected section runs once at a time per process.
//! - **Lease** `locks:refresh:twitch:{id}`: the reference's `SET NX PX 5000` with a random
//!   owner, now **renewed** every third of its lifetime by a task while the holder works, so it
//!   cannot expire under a healthy holder however long the exchange and the write take. Release
//!   is a compare-and-delete. A holder that stalls longer than the lease (or loses Dragonfly)
//!   loses it; the marker below still stops a second exchange.
//! - **Exchange marker** `locks:refresh:twitch:{id}:exchange`: set (`NX`) by the lease holder
//!   right before it sends a refresh token to Twitch, with its own id, renewed with the lease,
//!   and removed once the outcome is known and stored. While it exists no other refresh is sent
//!   for that streamer, anywhere. It is left to expire
//!   ([`crate::Timings::exchange_marker_ttl`]) when the outcome is unknown (the answer was lost
//!   after the request may have reached Twitch, or the holder died): within that time a
//!   rejection cannot be blamed on the stored token, so nothing is wiped.
//!
//! A permanent refusal therefore wipes only when the refused token is still the stored one and
//! the marker is still the holder's own (no other exchange was or may be in flight).

use crate::base::Inner;
use crate::error::TwitchError;
use dima_store::dragonfly::script::Script;
use dima_store::dragonfly::{SetCondition, SetExpiry, SetOptions, SetOutcome};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

/// Deletes a key only if it still holds the given value (Rust only; no loop).
static COMPARE_DELETE: Script = Script::new(
    "RELEASE_REFRESH_LOCK_SCRIPT",
    "\nif redis.call('GET', KEYS[1]) == ARGV[1] then\n    return redis.call('DEL', KEYS[1])\nend\nreturn 0\n",
);

/// Extends a key's lifetime only if it still holds the given value (Rust only; no loop).
static COMPARE_EXPIRE: Script = Script::new(
    "RUST_RENEW_REFRESH_LOCK_SCRIPT",
    include_str!("lua/compare_expire.lua"),
);

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis())
        .unwrap_or(u64::MAX)
        .max(1)
}

/// The per-streamer gates of a process.
#[derive(Default)]
pub(crate) struct Gates {
    map: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// A held gate; dropping it frees the streamer (and forgets the gate when nobody waits).
pub(crate) struct Gate {
    guard: Option<OwnedMutexGuard<()>>,
    gates: Arc<Inner>,
    id: String,
}

impl Drop for Gate {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut map = self
            .gates
            .gates
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if map
            .get(&self.id)
            .is_some_and(|gate| Arc::strong_count(gate) == 1)
        {
            map.remove(&self.id);
        }
    }
}

/// The cross-process lease, held. [`Lease::share`] gives the background writer of a rotation
/// its own handle: the lease is released when the last holder releases it, and the marker is
/// then the writer's to settle.
pub(crate) struct Lease {
    state: Arc<LeaseState>,
    /// This handle's claim on the marker (the foreground's is given up by [`Lease::share`]).
    settles_marker: bool,
    /// Set by [`Inner::release`]; a handle dropped without it (its task was stopped) still
    /// stops the renewal when it is the last, and the lease then expires on its own.
    released: bool,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if !self.released && self.state.holders.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.state.renewal.cancel();
        }
    }
}

struct LeaseState {
    key: String,
    owner: String,
    marker: Arc<Mutex<Option<(String, String)>>>,
    renewal: CancellationToken,
    holders: AtomicUsize,
}

impl Lease {
    /// A second holder that keeps the lease (and its renewal) alive and alone settles the
    /// marker from now on.
    pub(crate) fn share(&mut self) -> Lease {
        self.state.holders.fetch_add(1, Ordering::SeqCst);
        self.settles_marker = false;
        Lease {
            state: Arc::clone(&self.state),
            settles_marker: true,
            released: false,
        }
    }
}

impl Inner {
    /// Takes the streamer's gate in this process. `Busy` when too many streamers are being
    /// refreshed at once.
    pub(crate) async fn gate(self: &Arc<Self>, id: &str) -> Result<Gate, TwitchError> {
        let gate = {
            let mut map = self
                .gates
                .map
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(gate) = map.get(id) {
                Arc::clone(gate)
            } else {
                if map.len() >= crate::base::MAX_FLIGHTS {
                    return Err(TwitchError::Busy);
                }
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                map.insert(id.to_owned(), Arc::clone(&gate));
                gate
            }
        };
        let guard = gate.lock_owned().await;
        Ok(Gate {
            guard: Some(guard),
            gates: Arc::clone(self),
            id: id.to_owned(),
        })
    }

    /// `SET locks:refresh:twitch:{id} <uuid> NX PX <ttl>`; on success the renewal starts.
    pub(crate) async fn try_lease(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<Option<Lease>, TwitchError> {
        let key = self.config.keys.refresh_lock(id);
        let random: &dyn dima_core::Random = &*self.random;
        let owner = random
            .uuid_v4()
            .map_err(|error| TwitchError::cache("lock", error))?;
        let outcome = self
            .dragonfly
            .set(
                &key,
                owner.as_bytes(),
                SetOptions {
                    condition: SetCondition::IfMissing,
                    expiry: SetExpiry::Millis(millis(self.config.timings.refresh_lock_ttl)),
                    get: false,
                },
            )
            .await
            .map_err(|error| TwitchError::cache("lock", error))?;
        if outcome != SetOutcome::Written {
            return Ok(None);
        }
        let lease = Lease {
            state: Arc::new(LeaseState {
                key,
                owner,
                marker: Arc::new(Mutex::new(None)),
                renewal: CancellationToken::new(),
                holders: AtomicUsize::new(1),
            }),
            settles_marker: true,
            released: false,
        };
        self.renew(&lease);
        Ok(Some(lease))
    }

    /// Whether the lease of `id` exists (any holder).
    pub(crate) async fn lease_held(&self, id: &str) -> Result<bool, TwitchError> {
        let held = self
            .dragonfly
            .exists(&[&self.config.keys.refresh_lock(id)])
            .await
            .map_err(|error| TwitchError::cache("exists", error))?;
        Ok(held == 1)
    }

    /// The renewal task: every third of the lease, the lease and the marker (while they are
    /// still this holder's) get their full lifetime again.
    fn renew(self: &Arc<Self>, lease: &Lease) {
        let inner = Arc::clone(self);
        let key = lease.state.key.clone();
        let owner = lease.state.owner.clone();
        let marker = Arc::clone(&lease.state.marker);
        let stop = lease.state.renewal.clone();
        let kill = self.kill.clone();
        let ttl = self.config.timings.refresh_lock_ttl;
        let marker_ttl = self.config.timings.exchange_marker_ttl;
        let every = (ttl / 3).max(Duration::from_millis(10));
        self.tracker.spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => return,
                    () = kill.cancelled() => return,
                    () = tokio::time::sleep(every) => {}
                }
                let current = marker
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                // A failed renewal is retried at the next tick; the lease may expire meanwhile,
                // which the marker covers.
                let _ = inner.compare_expire(&key, &owner, ttl).await;
                if let Some((marker_key, value)) = current {
                    let _ = inner.compare_expire(&marker_key, &value, marker_ttl).await;
                }
            }
        });
    }

    async fn compare_expire(
        &self,
        key: &str,
        value: &str,
        ttl: Duration,
    ) -> Result<bool, TwitchError> {
        let reply = COMPARE_EXPIRE
            .run_value(&self.dragonfly, &[key], &[value, &millis(ttl).to_string()])
            .await
            .map_err(|error| TwitchError::cache("renew lock", error))?;
        Ok(dima_store::dragonfly::commands::reply::int(reply).unwrap_or(0) == 1)
    }

    pub(crate) async fn compare_delete(&self, key: &str, value: &str) {
        // The key expires on its own; a failed delete only delays the next refresh.
        let _ = COMPARE_DELETE
            .run_value(&self.dragonfly, &[key], &[value])
            .await;
    }

    /// Sets the exchange marker for `id` (`NX`); `false` when another exchange is (or may be)
    /// in flight.
    pub(crate) async fn mark_exchange(&self, lease: &Lease, id: &str) -> Result<bool, TwitchError> {
        let key = self.config.keys.exchange_marker(id);
        let random: &dyn dima_core::Random = &*self.random;
        let value = random
            .uuid_v4()
            .map_err(|error| TwitchError::cache("exchange marker", error))?;
        let outcome = self
            .dragonfly
            .set(
                &key,
                value.as_bytes(),
                SetOptions {
                    condition: SetCondition::IfMissing,
                    expiry: SetExpiry::Millis(millis(self.config.timings.exchange_marker_ttl)),
                    get: false,
                },
            )
            .await
            .map_err(|error| TwitchError::cache("exchange marker", error))?;
        if outcome != SetOutcome::Written {
            return Ok(false);
        }
        *lease
            .state
            .marker
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((key, value));
        Ok(true)
    }

    /// Whether the marker is still the one this holder set (no other exchange started since).
    pub(crate) async fn marker_is_ours(&self, lease: &Lease) -> Result<bool, TwitchError> {
        let current = lease
            .state
            .marker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some((key, value)) = current else {
            return Ok(false);
        };
        let stored = self
            .dragonfly
            .get(&key)
            .await
            .map_err(|error| TwitchError::cache("exchange marker", error))?;
        Ok(stored.as_deref() == Some(value.as_bytes()))
    }

    /// The outcome of the exchange is known and stored: the marker goes (unless another
    /// holder settles it).
    pub(crate) async fn clear_marker(&self, lease: &Lease) {
        if !lease.settles_marker {
            return;
        }
        let current = lease
            .state
            .marker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((key, value)) = current {
            self.compare_delete(&key, &value).await;
        }
    }

    /// The outcome of the exchange is unknown: the marker is no longer renewed and expires on
    /// its own (unless another holder settles it).
    pub(crate) fn abandon_marker(&self, lease: &Lease) {
        if !lease.settles_marker {
            return;
        }
        lease
            .state
            .marker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    /// Gives up this handle; the last holder stops the renewal and deletes the lease if it is
    /// still this process's. A marker still set is left to expire (its outcome was not
    /// settled).
    pub(crate) async fn release(&self, mut lease: Lease) {
        lease.released = true;
        if lease.state.holders.fetch_sub(1, Ordering::SeqCst) != 1 {
            return;
        }
        lease.state.renewal.cancel();
        self.compare_delete(&lease.state.key, &lease.state.owner)
            .await;
    }
}
