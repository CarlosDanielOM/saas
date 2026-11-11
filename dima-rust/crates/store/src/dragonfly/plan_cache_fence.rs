//! The plan/credit cache fence, ported from the pre-existing crate (`dima-rust/src/utils/
//! plan_cache_fence.rs`) onto this module's client. TypeScript originals:
//! `dimabot/src/utils/plan_cache_fence.ts` and `dimabot/src/domain_events/polar_billing_events.ts`.
//!
//! Versions are opaque UTF-8 strings compared by Lua's byte order (`fence > version`), never parsed
//! as numbers: `String(epochMs).padStart(13, "0") + ":" + eventKey`. Missing and empty fences are
//! distinct states; equal versions are accepted. Raw cached JSON is passed through unchanged:
//! `ACCEPT_PLAN_CREDITS_SCRIPT` in read mode compares the stored credits value with the argument
//! byte for byte, and the credits value may have been rewritten by Lua's `cjson.encode`
//! (`APPLY_AI_CREDIT_USAGE_SCRIPT` in `billing.ts`), so the caller passes back exactly the bytes it
//! read, never a re-serialised copy.
//!
//! This protocol fences plan metadata only; it is not a credential compare-and-set. The
//! full-hash `HSET` may overwrite credentials and plan invalidation deletes the whole account hash.
//!
//! Every script is the reference's text, verbatim, from `lua/plan_*.lua` (checked against the
//! TypeScript by `tests/dragonfly_lua_sources.rs`). `READ_PLAN_ACCOUNT_SCRIPT` exists only in Rust
//! (read-only; it touches no key a TypeScript process does not already read).
//!
//! Operations are bounded by an operation deadline (default 2 s) on top of the handle's response
//! timeout. A timeout or transport failure can leave a mutation's outcome unknown; callers
//! reconcile, they do not blindly retry. Only a confirmed `NOSCRIPT` is retried.

use super::client::Dragonfly;
use super::commands::reply;
use super::error::DragonflyError;
use super::script::Script;
use redis::Value;
use std::future::Future;
use std::time::Duration;

/// Internal cache metadata field; never part of returned account or credit API payloads.
pub const PLAN_CACHE_VERSION_FIELD: &str = "__polar_plan_version";
/// The published accounts aggregate.
pub const ACCOUNTS_CACHE_KEY: &str = "twitch:accounts";
/// Default bound on one fence operation.
pub const DEFAULT_OPERATION_DEADLINE: Duration = Duration::from_secs(2);
/// Largest channel id accepted.
pub const MAX_ID_BYTES: usize = 1024;
/// Largest single key or argument accepted.
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
/// Largest request (keys + arguments with framing allowance) accepted.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// Most account hash fields written or read.
pub const MAX_ACCOUNT_FIELDS: usize = 256;
/// Most accounts validated in one check.
pub const MAX_CHECK_ACCOUNTS: usize = 4096;
/// Largest account hash returned by a read.
pub const MAX_READ_ACCOUNT_BYTES: usize = 64 * 1024;
/// Most accounts in one batched read.
pub const MAX_READ_BATCH_ACCOUNTS: usize = 64;
/// Largest batched read request.
pub const MAX_READ_BATCH_REQUEST_BYTES: usize = 64 * 1024;

/// `WRITE_PLAN_ACCOUNT_SCRIPT` (`plan_cache_fence.ts`).
pub static WRITE_PLAN_ACCOUNT: Script = Script::new(
    "WRITE_PLAN_ACCOUNT_SCRIPT",
    include_str!("lua/plan_write_account.lua"),
);
/// `CHECK_PLAN_ACCOUNTS_SCRIPT` (`plan_cache_fence.ts`).
pub static CHECK_PLAN_ACCOUNTS: Script = Script::new(
    "CHECK_PLAN_ACCOUNTS_SCRIPT",
    include_str!("lua/plan_check_accounts.lua"),
);
/// `ACCEPT_PLAN_CREDITS_SCRIPT` (`plan_cache_fence.ts`).
pub static ACCEPT_PLAN_CREDITS: Script = Script::new(
    "ACCEPT_PLAN_CREDITS_SCRIPT",
    include_str!("lua/plan_accept_credits.lua"),
);
/// `INVALIDATE_PLAN_SCRIPT` (`polar_billing_events.ts`).
pub static INVALIDATE_PLAN: Script = Script::new(
    "INVALIDATE_PLAN_SCRIPT",
    include_str!("lua/plan_invalidate.lua"),
);
/// `SYNC_CREDITS_SCRIPT` (`polar_billing_events.ts`).
pub static SYNC_CREDITS: Script = Script::new(
    "SYNC_CREDITS_SCRIPT",
    include_str!("lua/plan_sync_credits.lua"),
);
/// Rust-only atomic hash and fence snapshot. Bounds apply before account data is returned
/// (`HLEN` rejects huge hashes before `HGETALL`).
pub static READ_PLAN_ACCOUNT: Script = Script::new(
    "READ_PLAN_ACCOUNT_SCRIPT",
    include_str!("lua/plan_read_account.lua"),
);

/// Fence errors. Messages omit keys, account data, credentials and JSON.
#[derive(Debug, thiserror::Error)]
pub enum FenceError {
    /// The date is outside the JavaScript `Date` range.
    #[error("plan cache date is outside the valid JavaScript Date range")]
    InvalidDate,
    /// TTL zero or not representable in milliseconds.
    #[error("plan cache TTL must be positive and representable in milliseconds")]
    InvalidTtl,
    /// Zero operation deadline.
    #[error("plan cache operation deadline must be positive")]
    InvalidDeadline,
    /// An input exceeds the bounds above.
    #[error("plan cache input exceeds the operation bounds")]
    InputTooLarge,
    /// A stored account exceeds the read bounds.
    #[error("plan cache account exceeds the read bounds")]
    AccountTooLarge,
    /// A script answered outside its documented replies.
    #[error("plan cache returned an unexpected response")]
    Protocol,
    /// Dragonfly failed. `write_outcome_unknown` is set for mutations whose effect is unknown.
    #[error("plan cache Redis operation failed{}", if *write_outcome_unknown { "; mutation outcome may be unknown" } else { "" })]
    Redis {
        /// The mutation may or may not have been applied.
        write_outcome_unknown: bool,
        /// The underlying error.
        #[source]
        source: DragonflyError,
    },
    /// The operation deadline passed.
    #[error("plan cache deadline exceeded{}", if *write_outcome_unknown { "; mutation outcome may be unknown" } else { "" })]
    DeadlineExceeded {
        /// The mutation may or may not have been applied.
        write_outcome_unknown: bool,
    },
}

/// `planCacheVersion(at, key)`: `String(ms).padStart(13, "0") + ":" + key`, or `""` when either
/// part is missing (an empty key counts as missing, as `at && key` does). JavaScript's `padStart`
/// pads before a minus sign, unlike Rust's numeric formatting, and that is reproduced.
pub fn plan_cache_version(at_millis: Option<i64>, key: Option<&str>) -> Result<String, FenceError> {
    let (Some(at), Some(key)) = (at_millis, key.filter(|key| !key.is_empty())) else {
        return Ok(String::new());
    };
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&at) {
        return Err(FenceError::InvalidDate);
    }
    check_value(key)?;
    let millis = at.to_string();
    Ok(format!("{}:{key}", dima_text::pad_start(&millis, 13, "0")))
}

/// Lua's `fence and fence > version`, negated: `true` when `version` is accepted.
pub fn version_is_accepted(fence: Option<&str>, version: &str) -> bool {
    fence.is_none_or(|fence| fence.as_bytes() <= version.as_bytes())
}

/// `twitch:{id}:ai:credits:plan-version`.
pub fn plan_cache_fence_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:plan-version")
}

/// `accounts:twitch:{id}:data`.
pub fn account_cache_key(id: &str) -> String {
    format!("accounts:twitch:{id}:data")
}

/// `twitch:{id}:ai:credits`.
pub fn credits_cache_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits")
}

/// Both exhaustion keys: `twitch:{id}:ai:exhaust` and the legacy `{id}:ai:exhaust`.
pub fn exhaustion_cache_keys(id: &str) -> [String; 2] {
    [
        format!("twitch:{id}:ai:exhaust"),
        format!("{id}:ai:exhaust"),
    ]
}

/// `twitch:{id}:ai:credits:polar-version`.
pub fn snapshot_version_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:polar-version")
}

/// A positive TTL in seconds.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct TtlSeconds(u64);

impl TtlSeconds {
    /// Refuses 0 and values not representable in milliseconds.
    pub fn new(seconds: u64) -> Result<Self, FenceError> {
        if seconds == 0 || seconds > (i64::MAX as u64) / 1000 {
            return Err(FenceError::InvalidTtl);
        }
        Ok(Self(seconds))
    }

    /// The seconds.
    pub fn get(self) -> u64 {
        self.0
    }
}

/// A fenced write's outcome.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Acceptance {
    /// The script returned 1.
    Accepted,
    /// The script returned 0 (stale version, or changed raw value in read mode).
    Rejected,
}

/// `ACCEPT_PLAN_CREDITS_SCRIPT` mode (`ARGV[3]`).
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CreditMode {
    /// `read`: accept only when the stored value equals the given raw bytes.
    Read,
    /// `write`: store the raw value with the TTL.
    Write,
}

/// `SYNC_CREDITS_SCRIPT` exhaustion argument (`ARGV[3]`).
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Exhaustion {
    /// `""`: leave both exhaustion keys as they are.
    Keep,
    /// `"1"`: set both to `true`.
    Exhausted,
    /// `"0"`: delete both.
    Available,
}

/// One account's id and plan version for [`PlanCacheFence::check_accounts`].
#[derive(Debug, Clone, Copy)]
pub struct AccountVersion<'a> {
    /// Channel id.
    pub id: &'a str,
    /// Plan version; empty for accounts that predate version metadata.
    pub version: &'a str,
}

/// An account hash exactly as stored. Deliberately not `Debug`: it may hold credentials.
#[derive(Clone, Eq, PartialEq)]
pub struct AccountSnapshot {
    fields: Vec<(String, String)>,
}

impl AccountSnapshot {
    /// Every field in server order, including the internal version.
    pub fn fields(&self) -> &[(String, String)] {
        &self.fields
    }

    /// The `id` field, or `""`.
    pub fn id(&self) -> &str {
        self.field("id").unwrap_or("")
    }

    /// The internal plan version, or `""`.
    pub fn version(&self) -> &str {
        self.field(PLAN_CACHE_VERSION_FIELD).unwrap_or("")
    }

    /// One field.
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Every field except the internal version, which never goes into API payloads.
    pub fn public_fields(&self) -> impl Iterator<Item = (&str, &str)> {
        self.fields
            .iter()
            .filter(|(key, _)| key != PLAN_CACHE_VERSION_FIELD)
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
}

/// A fenced account read.
#[derive(Clone, Eq, PartialEq)]
pub enum AccountRead {
    /// Present and not older than its fence.
    Accepted(AccountSnapshot),
    /// Present but older than its fence.
    Stale,
    /// No account hash (or one without `id`).
    Missing,
}

impl std::fmt::Debug for AccountRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Accepted(_) => "Accepted(<redacted account>)",
            Self::Stale => "Stale",
            Self::Missing => "Missing",
        })
    }
}

/// The fence protocol over a [`Dragonfly`] handle. Construction does no I/O.
#[derive(Clone, Debug)]
pub struct PlanCacheFence {
    dragonfly: Dragonfly,
    deadline: Duration,
}

impl PlanCacheFence {
    /// With [`DEFAULT_OPERATION_DEADLINE`].
    pub fn new(dragonfly: Dragonfly) -> Self {
        Self {
            dragonfly,
            deadline: DEFAULT_OPERATION_DEADLINE,
        }
    }

    /// With another operation deadline (positive).
    pub fn with_deadline(dragonfly: Dragonfly, deadline: Duration) -> Result<Self, FenceError> {
        if deadline.is_zero() {
            return Err(FenceError::InvalidDeadline);
        }
        Ok(Self {
            dragonfly,
            deadline,
        })
    }

    /// `WRITE_PLAN_ACCOUNT_SCRIPT` with `HSET` arguments as the reference builds them:
    /// `Object.entries(sanitizeCachePayload({...account, [FIELD]: version}))`. The caller passes
    /// the account's string fields in its object order (distinct names); the version field takes
    /// `version` and keeps its position when the account already has one, otherwise it goes last.
    pub async fn write_account(
        &self,
        channel_id: &str,
        version: &str,
        fields: &[(&str, &str)],
    ) -> Result<Acceptance, FenceError> {
        check_id(channel_id)?;
        if fields.len() > MAX_ACCOUNT_FIELDS - 1 {
            return Err(FenceError::InputTooLarge);
        }
        let keys = [
            plan_cache_fence_key(channel_id),
            account_cache_key(channel_id),
            ACCOUNTS_CACHE_KEY.into(),
        ];
        let args = write_account_args(version, fields);
        self.execute(&WRITE_PLAN_ACCOUNT, &keys, &args, true).await
    }

    /// `CHECK_PLAN_ACCOUNTS_SCRIPT`: validates every version and, when `raw_aggregate` is a
    /// non-empty string, publishes it (exact bytes, `EX 3600`) in the same atomic step. Never
    /// split a large aggregate into chunks: reduce it instead.
    pub async fn check_accounts(
        &self,
        accounts: &[AccountVersion<'_>],
        raw_aggregate: Option<&str>,
    ) -> Result<Acceptance, FenceError> {
        if accounts.len() > MAX_CHECK_ACCOUNTS {
            return Err(FenceError::InputTooLarge);
        }
        let mut keys = Vec::with_capacity(accounts.len() + 1);
        let mut args = Vec::with_capacity(accounts.len() + 1);
        for account in accounts {
            check_id(account.id)?;
            keys.push(plan_cache_fence_key(account.id));
            args.push(account.version);
        }
        keys.push(ACCOUNTS_CACHE_KEY.into());
        let raw = raw_aggregate.unwrap_or("");
        args.push(raw);
        self.execute(&CHECK_PLAN_ACCOUNTS, &keys, &args, !raw.is_empty())
            .await
    }

    /// `ACCEPT_PLAN_CREDITS_SCRIPT`. In read mode `raw_payload` must be the exact bytes read from
    /// the credits key. Even read mode updates both exhaustion keys.
    pub async fn accept_credits(
        &self,
        channel_id: &str,
        version: &str,
        raw_payload: &str,
        mode: CreditMode,
        exhausted: bool,
        ttl: TtlSeconds,
    ) -> Result<Acceptance, FenceError> {
        check_id(channel_id)?;
        let [canonical, legacy] = exhaustion_cache_keys(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            plan_cache_fence_key(channel_id),
        ];
        let ttl = ttl.get().to_string();
        let args = [
            version,
            raw_payload,
            match mode {
                CreditMode::Read => "read",
                CreditMode::Write => "write",
            },
            if exhausted { "1" } else { "0" },
            ttl.as_str(),
        ];
        self.execute(&ACCEPT_PLAN_CREDITS, &keys, &args, true).await
    }

    /// `INVALIDATE_PLAN_SCRIPT`: raises the fence and deletes credits, the whole account hash,
    /// the aggregate and the billing context key (`creditPackBillingContextCacheKey`, passed in).
    pub async fn invalidate_plan(
        &self,
        channel_id: &str,
        version: &str,
        billing_context_key: &str,
    ) -> Result<Acceptance, FenceError> {
        check_id(channel_id)?;
        check_value(billing_context_key)?;
        let keys = [
            plan_cache_fence_key(channel_id),
            credits_cache_key(channel_id),
            account_cache_key(channel_id),
            ACCOUNTS_CACHE_KEY.into(),
            billing_context_key.into(),
        ];
        self.execute(&INVALIDATE_PLAN, &keys, &[version], true)
            .await
    }

    /// `SYNC_CREDITS_SCRIPT`. A missing payload leaves the cached credits and TTL alone.
    pub async fn sync_credits(
        &self,
        channel_id: &str,
        snapshot_version: &str,
        raw_payload: Option<&str>,
        exhaustion: Exhaustion,
        ttl: TtlSeconds,
        plan_version: &str,
    ) -> Result<Acceptance, FenceError> {
        check_id(channel_id)?;
        let [canonical, legacy] = exhaustion_cache_keys(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            snapshot_version_key(channel_id),
            plan_cache_fence_key(channel_id),
        ];
        let ttl = ttl.get().to_string();
        let args = [
            snapshot_version,
            raw_payload.unwrap_or(""),
            match exhaustion {
                Exhaustion::Keep => "",
                Exhaustion::Exhausted => "1",
                Exhaustion::Available => "0",
            },
            ttl.as_str(),
            plan_version,
        ];
        self.execute(&SYNC_CREDITS, &keys, &args, true).await
    }

    /// Reads one account hash and its fence atomically. A hash whose `id` differs from the
    /// requested id is a protocol error, not a snapshot fenced for another id.
    pub async fn read_account(&self, channel_id: &str) -> Result<AccountRead, FenceError> {
        check_id(channel_id)?;
        let keys = [
            account_cache_key(channel_id),
            plan_cache_fence_key(channel_id),
        ];
        let args = [
            MAX_ACCOUNT_FIELDS.to_string(),
            MAX_READ_ACCOUNT_BYTES.to_string(),
        ];
        let value = self
            .bounded(
                false,
                READ_PLAN_ACCOUNT.run_value(&self.dragonfly, &keys, &args),
            )
            .await?;
        decode_account_for_id(channel_id, decode_read_reply(value)?)
    }

    /// One pipeline of independent atomic reads, in request order. After a confirmed `NOSCRIPT`
    /// the script is loaded and this read-only batch replayed once.
    pub async fn read_accounts(
        &self,
        channel_ids: &[&str],
    ) -> Result<Vec<AccountRead>, FenceError> {
        validate_read_batch(channel_ids)?;
        if channel_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut pipeline = redis::pipe();
        for &id in channel_ids {
            pipeline
                .cmd("EVALSHA")
                .arg(READ_PLAN_ACCOUNT.sha1())
                .arg(2)
                .arg(account_cache_key(id))
                .arg(plan_cache_fence_key(id))
                .arg(MAX_ACCOUNT_FIELDS)
                .arg(MAX_READ_ACCOUNT_BYTES);
        }
        let operation = async {
            match self.dragonfly.query_pipeline::<Vec<Value>>(&pipeline).await {
                Err(error) if error.is_server_code("NOSCRIPT") => {
                    let _: String = self
                        .dragonfly
                        .query(
                            redis::cmd("SCRIPT")
                                .arg("LOAD")
                                .arg(READ_PLAN_ACCOUNT.source()),
                        )
                        .await?;
                    self.dragonfly.query_pipeline(&pipeline).await
                }
                result => result,
            }
        };
        let responses = self.bounded(false, operation).await?;
        if responses.len() != channel_ids.len() {
            return Err(FenceError::Protocol);
        }
        channel_ids
            .iter()
            .zip(responses)
            .map(|(id, value)| decode_account_for_id(id, decode_read_reply(value)?))
            .collect()
    }

    async fn execute(
        &self,
        script: &Script,
        keys: &[String],
        args: &[&str],
        mutation: bool,
    ) -> Result<Acceptance, FenceError> {
        validate_request(keys, args)?;
        let value = self
            .bounded(mutation, script.run_value(&self.dragonfly, keys, args))
            .await?;
        match reply::int(value) {
            Ok(1) => Ok(Acceptance::Accepted),
            Ok(0) => Ok(Acceptance::Rejected),
            _ => Err(FenceError::Protocol),
        }
    }

    async fn bounded<T>(
        &self,
        mutation: bool,
        operation: impl Future<Output = Result<T, DragonflyError>>,
    ) -> Result<T, FenceError> {
        tokio::time::timeout(self.deadline, operation)
            .await
            .map_err(|_| FenceError::DeadlineExceeded {
                write_outcome_unknown: mutation,
            })?
            .map_err(|source| FenceError::Redis {
                write_outcome_unknown: mutation,
                source,
            })
    }
}

/// `[version, ...Object.entries(sanitized).flat()]` for `WRITE_PLAN_ACCOUNT_SCRIPT`.
fn write_account_args<'a>(version: &'a str, fields: &[(&'a str, &'a str)]) -> Vec<&'a str> {
    let mut args = Vec::with_capacity(fields.len() * 2 + 3);
    args.push(version);
    let mut has_version = false;
    for &(key, value) in fields {
        if key == PLAN_CACHE_VERSION_FIELD {
            has_version = true;
            args.extend([key, version]);
        } else {
            args.extend([key, value]);
        }
    }
    if !has_version {
        args.extend([PLAN_CACHE_VERSION_FIELD, version]);
    }
    args
}

fn check_id(value: &str) -> Result<(), FenceError> {
    if value.len() > MAX_ID_BYTES {
        Err(FenceError::InputTooLarge)
    } else {
        Ok(())
    }
}

fn check_value(value: &str) -> Result<(), FenceError> {
    if value.len() > MAX_VALUE_BYTES {
        Err(FenceError::InputTooLarge)
    } else {
        Ok(())
    }
}

fn validate_request(keys: &[String], args: &[&str]) -> Result<(), FenceError> {
    let mut bytes = 0_usize;
    for value in keys.iter().map(String::as_str).chain(args.iter().copied()) {
        check_value(value)?;
        // Conservative per-argument RESP framing allowance, not only payload.
        bytes = bytes
            .checked_add(value.len() + 32)
            .ok_or(FenceError::InputTooLarge)?;
        if bytes > MAX_REQUEST_BYTES {
            return Err(FenceError::InputTooLarge);
        }
    }
    Ok(())
}

fn validate_read_batch(ids: &[&str]) -> Result<(), FenceError> {
    if ids.len() > MAX_READ_BATCH_ACCOUNTS {
        return Err(FenceError::InputTooLarge);
    }
    let mut bytes = 0_usize;
    for &id in ids {
        check_id(id)?;
        bytes += account_cache_key(id).len() + plan_cache_fence_key(id).len() + 192;
        if bytes > MAX_READ_BATCH_REQUEST_BYTES {
            return Err(FenceError::InputTooLarge);
        }
    }
    Ok(())
}

/// `{status, flat HGETALL array}` from `READ_PLAN_ACCOUNT_SCRIPT`.
fn decode_read_reply(value: Value) -> Result<(i64, Vec<String>), FenceError> {
    let mut items = reply::array(value)
        .map_err(|_| FenceError::Protocol)?
        .into_iter();
    let (Some(status), Some(flat), None) = (items.next(), items.next(), items.next()) else {
        return Err(FenceError::Protocol);
    };
    let status = reply::int(status).map_err(|_| FenceError::Protocol)?;
    let flat = reply::array(flat)
        .map_err(|_| FenceError::Protocol)?
        .into_iter()
        .map(|item| reply::text(item).map_err(|_| FenceError::Protocol))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((status, flat))
}

fn decode_account_for_id(
    expected_id: &str,
    response: (i64, Vec<String>),
) -> Result<AccountRead, FenceError> {
    let decoded = decode_account(response)?;
    if let AccountRead::Accepted(snapshot) = &decoded
        && snapshot.id() != expected_id
    {
        return Err(FenceError::Protocol);
    }
    Ok(decoded)
}

fn decode_account((status, flat): (i64, Vec<String>)) -> Result<AccountRead, FenceError> {
    match status {
        0 if flat.is_empty() => Ok(AccountRead::Missing),
        -1 if flat.is_empty() => Ok(AccountRead::Stale),
        -2 if flat.is_empty() => Err(FenceError::AccountTooLarge),
        1 if flat.len().is_multiple_of(2) && flat.len() <= MAX_ACCOUNT_FIELDS * 2 => {
            if flat.iter().map(String::len).sum::<usize>() > MAX_READ_ACCOUNT_BYTES {
                return Err(FenceError::AccountTooLarge);
            }
            let mut fields = Vec::with_capacity(flat.len() / 2);
            let mut flat = flat.into_iter();
            while let Some(key) = flat.next() {
                fields.push((key, flat.next().ok_or(FenceError::Protocol)?));
            }
            let snapshot = AccountSnapshot { fields };
            if snapshot.id().is_empty() {
                return Err(FenceError::Protocol);
            }
            Ok(AccountRead::Accepted(snapshot))
        }
        _ => Err(FenceError::Protocol),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_match_js_padding_and_date_boundaries() {
        for (at, expected) in [
            (0, "0000000000000:event"),
            (1, "0000000000001:event"),
            (-1, "00000000000-1:event"),
            (1_700_000_000_000, "1700000000000:event"),
            (-1_000_000_000_000, "-1000000000000:event"),
            (8_640_000_000_000_000, "8640000000000000:event"),
            (-8_640_000_000_000_000, "-8640000000000000:event"),
        ] {
            assert_eq!(
                plan_cache_version(Some(at), Some("event")).unwrap(),
                expected
            );
        }
        for at in [
            i64::MIN,
            -8_640_000_000_000_001,
            8_640_000_000_000_001,
            i64::MAX,
        ] {
            assert!(matches!(
                plan_cache_version(Some(at), Some("event")),
                Err(FenceError::InvalidDate)
            ));
        }
    }

    #[test]
    fn legacy_versions_and_binary_order_are_not_numeric_or_utf16_order() {
        assert_eq!(plan_cache_version(None, Some("event")).unwrap(), "");
        assert_eq!(plan_cache_version(Some(1), None).unwrap(), "");
        assert_eq!(plan_cache_version(Some(1), Some("")).unwrap(), "");
        // Source short-circuits missing key before accessing the Date.
        assert_eq!(plan_cache_version(Some(i64::MAX), Some("")).unwrap(), "");
        assert!(version_is_accepted(None, ""));
        assert!(version_is_accepted(Some(""), ""));
        assert!(version_is_accepted(Some("x"), "x"));
        assert!(!version_is_accepted(Some("x"), ""));
        assert!(!version_is_accepted(Some("9:event"), "10:event"));
        assert!(!version_is_accepted(Some("1:\u{10000}"), "1:\u{e000}"));
        assert!(version_is_accepted(Some("1:\u{e000}"), "1:\u{10000}"));
    }

    #[test]
    fn keys_retain_both_exhaustion_names_and_opaque_ids() {
        assert_eq!(
            plan_cache_fence_key("12:ä"),
            "twitch:12:ä:ai:credits:plan-version"
        );
        assert_eq!(account_cache_key("12"), "accounts:twitch:12:data");
        assert_eq!(credits_cache_key("12"), "twitch:12:ai:credits");
        assert_eq!(
            snapshot_version_key("12"),
            "twitch:12:ai:credits:polar-version"
        );
        assert_eq!(
            exhaustion_cache_keys("12"),
            ["twitch:12:ai:exhaust", "12:ai:exhaust"]
        );
        assert_eq!(plan_cache_fence_key(""), "twitch::ai:credits:plan-version");
    }

    #[test]
    fn positive_ttl_and_argument_bounds_fail_explicitly() {
        assert!(matches!(TtlSeconds::new(0), Err(FenceError::InvalidTtl)));
        assert!(matches!(
            TtlSeconds::new(u64::MAX),
            Err(FenceError::InvalidTtl)
        ));
        assert_eq!(TtlSeconds::new(1).unwrap().get(), 1);
        assert_eq!(TtlSeconds::new(3600).unwrap().get(), 3600);
        assert!(check_id(&"a".repeat(MAX_ID_BYTES)).is_ok());
        assert!(matches!(
            check_id(&"a".repeat(MAX_ID_BYTES + 1)),
            Err(FenceError::InputTooLarge)
        ));
        assert!(check_value(&"ä".repeat(MAX_VALUE_BYTES / 2)).is_ok());
        assert!(matches!(
            check_value(&"ä".repeat(MAX_VALUE_BYTES / 2 + 1)),
            Err(FenceError::InputTooLarge)
        ));
        let value = "a".repeat(MAX_VALUE_BYTES);
        assert!(matches!(
            validate_request(&[], &[&value, &value, &value, &value]),
            Err(FenceError::InputTooLarge)
        ));
        // Raw JSON is never parsed or normalized, even when invalid/empty.
        assert!(validate_request(&["key".into()], &["", " {\n\"a\": 1 }", "not-json"]).is_ok());
    }

    #[test]
    fn batches_have_independent_count_and_wire_size_bounds() {
        assert!(validate_read_batch(&[]).is_ok());
        assert!(validate_read_batch(&vec!["x"; MAX_READ_BATCH_ACCOUNTS]).is_ok());
        assert!(matches!(
            validate_read_batch(&vec!["x"; MAX_READ_BATCH_ACCOUNTS + 1]),
            Err(FenceError::InputTooLarge)
        ));
        let long = "x".repeat(MAX_ID_BYTES);
        assert!(matches!(
            validate_read_batch(&vec![long.as_str(); MAX_READ_BATCH_ACCOUNTS]),
            Err(FenceError::InputTooLarge)
        ));
    }

    #[test]
    fn account_read_states_do_not_collapse_errors_or_expose_metadata() {
        assert_eq!(decode_account((0, vec![])).unwrap(), AccountRead::Missing);
        assert_eq!(decode_account((-1, vec![])).unwrap(), AccountRead::Stale);
        assert!(matches!(
            decode_account((-2, vec![])),
            Err(FenceError::AccountTooLarge)
        ));
        assert!(matches!(
            decode_account((5, vec![])),
            Err(FenceError::Protocol)
        ));
        assert!(matches!(
            decode_account((1, vec!["id".into()])),
            Err(FenceError::Protocol)
        ));
        assert!(matches!(
            decode_account((1, vec!["name".into(), "x".into()])),
            Err(FenceError::Protocol)
        ));
        let accepted = decode_account((
            1,
            vec![
                "id".into(),
                "42".into(),
                PLAN_CACHE_VERSION_FIELD.into(),
                "v".into(),
                "access_token".into(),
                "secret-token".into(),
            ],
        ))
        .unwrap();
        assert!(!format!("{accepted:?}").contains("secret-token"));
        let AccountRead::Accepted(snapshot) = accepted else {
            panic!("accepted account expected")
        };
        assert_eq!(snapshot.id(), "42");
        assert_eq!(snapshot.version(), "v");
        assert_eq!(snapshot.fields().len(), 3);
        assert_eq!(snapshot.public_fields().count(), 2);
        assert!(
            !snapshot
                .public_fields()
                .any(|(key, _)| key == PLAN_CACHE_VERSION_FIELD)
        );
        let AccountRead::Accepted(legacy) =
            decode_account((1, vec!["id".into(), "42".into()])).unwrap()
        else {
            panic!("legacy account expected")
        };
        assert_eq!(legacy.version(), "");
    }

    #[test]
    fn mismatched_hash_identity_is_protocol_error_not_a_fenced_account() {
        let fields = vec!["id".into(), "other-channel".into()];
        assert!(matches!(
            decode_account_for_id("requested-channel", (1, fields.clone())),
            Err(FenceError::Protocol)
        ));
        assert!(matches!(
            decode_account_for_id("other-channel", (1, fields)),
            Ok(AccountRead::Accepted(_))
        ));
        assert_eq!(
            decode_account_for_id("requested-channel", (0, vec![])).unwrap(),
            AccountRead::Missing
        );
    }

    #[test]
    fn scripts_are_embedded_verbatim_and_hash_stably() {
        for script in [
            &WRITE_PLAN_ACCOUNT,
            &CHECK_PLAN_ACCOUNTS,
            &ACCEPT_PLAN_CREDITS,
            &INVALIDATE_PLAN,
            &SYNC_CREDITS,
            &READ_PLAN_ACCOUNT,
        ] {
            assert_eq!(script.sha1().len(), 40);
            assert!(script.source().starts_with('\n') && script.source().ends_with('\n'));
        }
        fn require_send_sync<T: Send + Sync>() {}
        require_send_sync::<PlanCacheFence>();
    }

    #[test]
    fn version_field_keeps_its_position_like_an_object_spread() {
        // {...account, [FIELD]: version}: an existing key keeps its place with the new value.
        assert_eq!(
            write_account_args(
                "v2",
                &[("id", "1"), (PLAN_CACHE_VERSION_FIELD, "v1"), ("name", "n")]
            ),
            ["v2", "id", "1", PLAN_CACHE_VERSION_FIELD, "v2", "name", "n"]
        );
        // A new key goes last.
        assert_eq!(
            write_account_args("v2", &[("id", "1"), ("name", "n")]),
            ["v2", "id", "1", "name", "n", PLAN_CACHE_VERSION_FIELD, "v2"]
        );
    }

    #[test]
    fn errors_are_static_and_unknown_mutation_outcomes_are_explicit() {
        for error in [
            FenceError::InvalidDate,
            FenceError::InvalidTtl,
            FenceError::InputTooLarge,
            FenceError::AccountTooLarge,
            FenceError::Protocol,
            FenceError::DeadlineExceeded {
                write_outcome_unknown: true,
            },
        ] {
            assert!(!error.to_string().contains("secret-token"));
        }
        assert!(
            FenceError::DeadlineExceeded {
                write_outcome_unknown: true
            }
            .to_string()
            .contains("unknown")
        );
        let redis = FenceError::Redis {
            write_outcome_unknown: true,
            source: DragonflyError::Reply("x"),
        };
        assert!(redis.to_string().contains("unknown"));
        assert!(std::error::Error::source(&redis).is_some());
    }
}
