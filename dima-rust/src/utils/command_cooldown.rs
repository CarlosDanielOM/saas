//! Owner-plan cooldown policy and serialized command writes, ported from
//! `command_cooldown.ts` and `command_cooldown_write.ts`.
//!
//! This module opens no connections. A [`CooldownStore`] implementation must
//! supply the account lookup, MongoDB existence query and Redis lease operations
//! described on its methods. In particular, an in-process mutex is not a
//! substitute for the cross-process lease. Callers supply the actual write.
//! The 60-second lease is intentionally not renewed (matching TypeScript);
//! adapters should bound writes accordingly. Cancellation drops the Rust future
//! and cannot run async release; the lease then expires after at most 60 seconds.

use std::fmt;
use std::future::Future;

use serde_json::Value;

pub const ZERO_SLOT_LEASE_SECONDS: u64 = 60;
pub const RELEASE_LEASE_SCRIPT: &str =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/// Only the channel owner's plan is relevant; missing/unknown plans use Free.
pub fn minimum_command_cooldown(plan_tier: Option<&str>) -> u8 {
    match plan_tier {
        Some("pro") => 1,
        Some("premium") => 3,
        _ => 5,
    }
}

pub fn command_write_key(channel_id: &str) -> String {
    format!("command-cooldown-write:{channel_id}")
}

#[derive(Debug, Clone, Default)]
pub struct CurrentCommand {
    /// String representation of the Mongo ObjectId; adapters must convert back
    /// to the schema's actual ID type for `$ne`, rather than compare strings.
    pub id: Option<String>,
    pub cooldown: Option<f64>,
    pub reserved: bool,
}

/// All effects needed by the original API/chat write path, with no worker or
/// database dependency. Errors are propagated, including release failures.
pub trait CooldownStore: Sync {
    type Error;

    /// Read `TwitchStreamers.getTwitchAccountById(channelID)?.plan_tier`.
    fn owner_plan<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send + 'a;

    /// Atomic Redis `SET key token NX EX ttl_seconds`; return false on contention.
    fn acquire_lease<'a>(
        &'a self,
        key: &'a str,
        token: &'a str,
        ttl_seconds: u64,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// `Commands.exists({channelID, cooldown: 0, reserved: {$ne: true},
    /// ...exclude_id && {_id: {$ne: ObjectId(exclude_id)}}})`.
    fn editable_zero_exists<'a>(
        &'a self,
        channel_id: &'a str,
        exclude_id: Option<&'a str>,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// Atomic compare-token-and-delete, e.g. [`RELEASE_LEASE_SCRIPT`]. Never
    /// delete a successor's lease after this caller's lease has expired.
    fn release_lease<'a>(
        &'a self,
        key: &'a str,
        token: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

#[derive(Debug, PartialEq, Eq)]
pub enum CooldownError<E> {
    Invalid(String),
    Storage(E),
}

impl<E: fmt::Display> fmt::Display for CooldownError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Storage(error) => error.fmt(f),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for CooldownError<E> {}

/// Keywords have no zero-slot exception, even for Pro owners.
pub async fn validate_keyword_cooldown<S: CooldownStore>(
    store: &S,
    channel_id: &str,
    cooldown: &Value,
) -> Result<(), CooldownError<S::Error>> {
    let plan = store
        .owner_plan(channel_id)
        .await
        .map_err(CooldownError::Storage)?;
    let minimum = minimum_command_cooldown(plan.as_deref());
    if !cooldown
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= f64::from(minimum))
    {
        return Err(CooldownError::Invalid(format!(
            "Keyword cooldown must be at least {minimum} seconds"
        )));
    }
    Ok(())
}

/// `None` means JavaScript `undefined` (unchanged); `Some(Value::Null)` is
/// explicit null and fails validation. Unchanged nonzero values, and unchanged
/// reserved zero values, preserve the source's grandfathering fast path.
/// Validation does not modify the requested value or the supplied write.
/// As with JS `finally`, a release error supersedes an existence/write error.
pub async fn write_command_with_cooldown<S, T, W, F>(
    store: &S,
    channel_id: &str,
    cooldown: Option<&Value>,
    current: Option<&CurrentCommand>,
    write: W,
) -> Result<T, CooldownError<S::Error>>
where
    S: CooldownStore,
    W: FnOnce() -> F,
    F: Future<Output = Result<T, S::Error>>,
{
    let Some(value) = cooldown else {
        return write().await.map_err(CooldownError::Storage);
    };
    let number = value.as_f64();
    if current.is_some_and(|c| {
        number.is_some() && number == c.cooldown && (number != Some(0.0) || c.reserved)
    }) {
        return write().await.map_err(CooldownError::Storage);
    }
    let plan = store
        .owner_plan(channel_id)
        .await
        .map_err(CooldownError::Storage)?;
    let minimum = minimum_command_cooldown(plan.as_deref());
    let Some(number) = number.filter(|n| n.is_finite() && (*n == 0.0 || *n >= f64::from(minimum)))
    else {
        return Err(CooldownError::Invalid(format!(
            "Command cooldown must be 0 or at least {minimum} seconds"
        )));
    };
    if number != 0.0 {
        return write().await.map_err(CooldownError::Storage);
    }
    if current.is_some_and(|c| c.reserved) {
        return Err(CooldownError::Invalid(
            "Only editable commands can use the 0-second cooldown slot.".into(),
        ));
    }
    let key = command_write_key(channel_id);
    let token = uuid::Uuid::new_v4().to_string();
    if !store
        .acquire_lease(&key, &token, ZERO_SLOT_LEASE_SECONDS)
        .await
        .map_err(CooldownError::Storage)?
    {
        return Err(CooldownError::Invalid(
            "Another command is being saved. Please retry.".into(),
        ));
    }
    let result = async {
        let exclude = current
            .and_then(|c| c.id.as_deref())
            .filter(|id| !id.is_empty());
        if store
            .editable_zero_exists(channel_id, exclude)
            .await
            .map_err(CooldownError::Storage)?
        {
            return Err(CooldownError::Invalid(
                "Only one editable command per channel can have a 0-second cooldown.".into(),
            ));
        }
        write().await.map_err(CooldownError::Storage)
    }
    .await;
    store
        .release_lease(&key, &token)
        .await
        .map_err(CooldownError::Storage)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    #[derive(Default)]
    struct Store {
        lease: Mutex<Option<String>>,
        plans: AtomicUsize,
        exists: bool,
        exclude: Mutex<Option<String>>,
        release_error: bool,
    }
    impl CooldownStore for Store {
        type Error = &'static str;
        async fn owner_plan(&self, _: &str) -> Result<Option<String>, Self::Error> {
            self.plans.fetch_add(1, Ordering::SeqCst);
            Ok(Some("premium".into()))
        }
        async fn acquire_lease(
            &self,
            key: &str,
            token: &str,
            ttl: u64,
        ) -> Result<bool, Self::Error> {
            assert_eq!(key, "command-cooldown-write:c");
            assert_eq!(ttl, 60);
            let mut lease = self.lease.lock().unwrap();
            if lease.is_some() {
                return Ok(false);
            }
            *lease = Some(token.into());
            Ok(true)
        }
        async fn editable_zero_exists(
            &self,
            _: &str,
            exclude: Option<&str>,
        ) -> Result<bool, Self::Error> {
            *self.exclude.lock().unwrap() = exclude.map(str::to_owned);
            Ok(self.exists)
        }
        async fn release_lease(&self, _: &str, token: &str) -> Result<(), Self::Error> {
            if self.release_error {
                return Err("release failed");
            }
            let mut lease = self.lease.lock().unwrap();
            if lease.as_deref() == Some(token) {
                *lease = None;
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn source_policy_and_missing_vs_null() {
        for (plan, seconds) in [
            (None, 5),
            (Some("PRO"), 5),
            (Some("free"), 5),
            (Some("premium"), 3),
            (Some("pro"), 1),
        ] {
            assert_eq!(minimum_command_cooldown(plan), seconds);
        }
        let store = Store::default();
        assert_eq!(
            write_command_with_cooldown(&store, "c", None, None, || async { Ok(7) }).await,
            Ok(7)
        );
        assert_eq!(store.plans.load(Ordering::SeqCst), 0);
        for bad in [Value::Null, json!("3"), json!(true), json!(-1), json!(2.9)] {
            assert!(
                write_command_with_cooldown(&store, "c", Some(&bad), None, || async { Ok(()) })
                    .await
                    .is_err()
            );
        }
        assert!(
            validate_keyword_cooldown(&store, "c", &json!(0))
                .await
                .is_err()
        );
        assert!(
            validate_keyword_cooldown(&store, "c", &json!(3))
                .await
                .is_ok()
        );
        let old = CurrentCommand {
            cooldown: Some(1.0),
            ..Default::default()
        };
        let before = store.plans.load(Ordering::SeqCst);
        assert!(
            write_command_with_cooldown(&store, "c", Some(&json!(1)), Some(&old), || async {
                Ok(())
            })
            .await
            .is_ok()
        );
        assert_eq!(store.plans.load(Ordering::SeqCst), before);
        let reserved = CurrentCommand {
            cooldown: Some(0.0),
            reserved: true,
            ..Default::default()
        };
        assert!(
            write_command_with_cooldown(&store, "c", Some(&json!(0)), Some(&reserved), || async {
                Ok(())
            })
            .await
            .is_ok()
        );
        let reserved = CurrentCommand {
            cooldown: Some(5.0),
            reserved: true,
            ..Default::default()
        };
        assert!(
            write_command_with_cooldown(&store, "c", Some(&json!(0)), Some(&reserved), || async {
                Ok(())
            })
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn zero_slot_contention_and_failure_release() {
        let store = Store::default();
        let current = CurrentCommand {
            id: Some("own-id".into()),
            cooldown: Some(0.0),
            reserved: false,
        };
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let zero = json!(0);
        let first =
            write_command_with_cooldown(&store, "c", Some(&zero), Some(&current), || async {
                entered_tx.send(()).unwrap();
                finish_rx.await.unwrap();
                Ok(1)
            });
        let second = async {
            entered_rx.await.unwrap();
            let result =
                write_command_with_cooldown(&store, "c", Some(&json!(0)), None, || async {
                    Err::<i32, _>("contended write ran")
                })
                .await;
            assert!(matches!(result, Err(CooldownError::Invalid(_))));
            finish_tx.send(()).unwrap();
        };
        let (first, ()) = tokio::join!(first, second);
        assert_eq!(first, Ok(1));
        assert_eq!(store.exclude.lock().unwrap().as_deref(), Some("own-id"));
        assert!(store.lease.lock().unwrap().is_none());
        assert_eq!(
            write_command_with_cooldown(&store, "c", Some(&json!(0)), None, || async {
                Err::<(), _>("write failed")
            })
            .await,
            Err(CooldownError::Storage("write failed"))
        );
        assert!(store.lease.lock().unwrap().is_none());
        // Simulate TTL expiry and another process acquiring the same key while
        // our write is running. Release must preserve the successor's token.
        assert!(
            write_command_with_cooldown(&store, "c", Some(&json!(0)), None, || async {
                *store.lease.lock().unwrap() = Some("successor-token".into());
                Ok(())
            })
            .await
            .is_ok()
        );
        assert_eq!(
            store.lease.lock().unwrap().as_deref(),
            Some("successor-token")
        );
        let occupied = Store {
            exists: true,
            ..Default::default()
        };
        assert!(
            write_command_with_cooldown(&occupied, "c", Some(&json!(0)), None, || async { Ok(()) })
                .await
                .is_err()
        );
        assert!(occupied.lease.lock().unwrap().is_none());
        let release = Store {
            exists: true,
            release_error: true,
            ..Default::default()
        };
        assert_eq!(
            write_command_with_cooldown(&release, "c", Some(&json!(0)), None, || async { Ok(()) })
                .await,
            Err(CooldownError::Storage("release failed"))
        );
    }
}
