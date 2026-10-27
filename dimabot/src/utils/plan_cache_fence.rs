//! Opt-in Redis plan/credit cache protocol, with explicitly injected transport.
//!
//! Construction does no I/O and reads no environment. Versions are opaque UTF-8
//! strings compared by Lua's binary ordering, never parsed as numbers. Missing
//! and empty fences remain distinct Redis states; equal versions are accepted.
//! Raw cached JSON is passed unchanged, including whitespace and field order.
//!
//! This protocol fences plan metadata only: it does not perform credential CAS.
//! The source-compatible full-hash HSET may overwrite credentials, and plan
//! invalidation deletes the entire account hash. Callers must supply separate
//! credential CAS or restrict their payloads to metadata before adopting it in
//! a credential-sensitive path. No existing worker or TypeScript caller uses it.
//!
//! Deadlines affect only these operations, never the injected connection's
//! global timeout. A timeout/transport failure can leave a mutation's outcome
//! unknown; callers must reconcile it, not blindly retry it. Only a confirmed
//! NOSCRIPT response is retried by the native prepared-script implementation.

use redis::{ErrorKind, Script, ServerErrorKind, aio::ConnectionManager};
use std::{fmt, future::Future, time::Duration};

pub const PLAN_CACHE_VERSION_FIELD: &str = "__polar_plan_version";
pub const ACCOUNTS_CACHE_KEY: &str = "twitch:accounts";
pub const DEFAULT_OPERATION_DEADLINE: Duration = Duration::from_secs(2);
pub const MAX_ID_BYTES: usize = 1024;
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ACCOUNT_FIELDS: usize = 256;
pub const MAX_CHECK_ACCOUNTS: usize = 4096;
pub const MAX_READ_ACCOUNT_BYTES: usize = 64 * 1024;
pub const MAX_READ_BATCH_ACCOUNTS: usize = 64;
pub const MAX_READ_BATCH_REQUEST_BYTES: usize = 64 * 1024;

/// Exact Lua source from `dimabot/src/utils/plan_cache_fence.ts`.
pub const WRITE_PLAN_ACCOUNT_SCRIPT: &str = r#"
local fence = redis.call('GET', KEYS[1])
if fence and fence > ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV, 2))
redis.call('DEL', KEYS[3])
return 1
"#;

/// Exact Lua source from `dimabot/src/utils/plan_cache_fence.ts`.
pub const CHECK_PLAN_ACCOUNTS_SCRIPT: &str = r#"
for index = 1, #ARGV - 1 do
    local fence = redis.call('GET', KEYS[index])
    if fence and fence > ARGV[index] then return 0 end
end
if ARGV[#ARGV] ~= '' then
    redis.call('SET', KEYS[#KEYS], ARGV[#ARGV], 'EX', 3600)
end
return 1
"#;

/// Exact Lua source from `dimabot/src/utils/plan_cache_fence.ts`.
pub const ACCEPT_PLAN_CREDITS_SCRIPT: &str = r#"
local fence = redis.call('GET', KEYS[4])
if fence and fence > ARGV[1] then return 0 end
if ARGV[3] == 'read' then
    if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
else
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
end
if ARGV[4] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
else
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
"#;

/// Exact Lua source from `dimabot/src/domain_events/polar_billing_events.ts`.
pub const INVALIDATE_PLAN_SCRIPT: &str = r#"
local previous = redis.call('GET', KEYS[1])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
"#;

/// Exact Lua source from `dimabot/src/domain_events/polar_billing_events.ts`.
pub const SYNC_CREDITS_SCRIPT: &str = r#"
local currentPlanVersion = redis.call('GET', KEYS[5])
if currentPlanVersion and currentPlanVersion > ARGV[5] then return 0 end
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[4], ARGV[1])
if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4]) end
if ARGV[3] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
elseif ARGV[3] == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
"#;

/// One atomic hash/fence snapshot. Bounds apply before returning account data;
/// HLEN rejects huge hashes before HGETALL. The result retains internal version
/// metadata so callers can perform the final aggregate publication check.
pub const READ_PLAN_ACCOUNT_SCRIPT: &str = r#"
if redis.call('HLEN', KEYS[1]) > tonumber(ARGV[1]) then return {-2, {}} end
local account = redis.call('HGETALL', KEYS[1])
local id = ''
local version = ''
local bytes = 0
for index = 1, #account, 2 do
    bytes = bytes + string.len(account[index]) + string.len(account[index + 1])
    if bytes > tonumber(ARGV[2]) then return {-2, {}} end
    if account[index] == 'id' then id = account[index + 1] end
    if account[index] == '__polar_plan_version' then version = account[index + 1] end
end
if id == '' then return {0, {}} end
local fence = redis.call('GET', KEYS[2])
if fence and fence > version then return {-1, {}} end
return {1, account}
"#;

/// Static errors intentionally omit keys, account data, credentials and JSON.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FenceError {
    InvalidDate,
    InvalidTtl,
    InvalidDeadline,
    InputTooLarge,
    AccountTooLarge,
    Protocol,
    Redis { write_outcome_unknown: bool },
    DeadlineExceeded { write_outcome_unknown: bool },
}

impl fmt::Display for FenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidDate => "plan cache date is outside the valid JavaScript Date range",
            Self::InvalidTtl => "plan cache TTL must be positive and representable in milliseconds",
            Self::InvalidDeadline => "plan cache operation deadline must be positive",
            Self::InputTooLarge => "plan cache input exceeds the operation bounds",
            Self::AccountTooLarge => "plan cache account exceeds the read bounds",
            Self::Protocol => "plan cache returned an unexpected response",
            Self::Redis {
                write_outcome_unknown: true,
            } => "plan cache Redis operation failed; mutation outcome may be unknown",
            Self::Redis {
                write_outcome_unknown: false,
            } => "plan cache Redis operation failed",
            Self::DeadlineExceeded {
                write_outcome_unknown: true,
            } => "plan cache deadline exceeded; mutation outcome may be unknown",
            Self::DeadlineExceeded {
                write_outcome_unknown: false,
            } => "plan cache deadline exceeded",
        })
    }
}

impl std::error::Error for FenceError {}

/// Integer milliseconds from a valid JS Date. Unlike an invalid JS Date's
/// `NaN` string, out-of-range supplied milliseconds are explicitly rejected.
/// Missing date or empty/missing key preserves the source's empty version.
pub fn plan_cache_version(at_millis: Option<i64>, key: Option<&str>) -> Result<String, FenceError> {
    let (Some(at), Some(key)) = (at_millis, key.filter(|key| !key.is_empty())) else {
        return Ok(String::new());
    };
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&at) {
        return Err(FenceError::InvalidDate);
    }
    check_value(key)?;
    let millis = at.to_string();
    // JS padStart pads before the minus sign, unlike Rust numeric formatting.
    Ok(format!(
        "{}{}:{key}",
        "0".repeat(13_usize.saturating_sub(millis.len())),
        millis
    ))
}

/// Mirrors Lua's `fence and fence > version`, including an empty fence.
pub fn version_is_accepted(fence: Option<&str>, version: &str) -> bool {
    fence.is_none_or(|fence| fence.as_bytes() <= version.as_bytes())
}

pub fn plan_cache_fence_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:plan-version")
}

pub fn account_cache_key(id: &str) -> String {
    format!("accounts:twitch:{id}:data")
}

pub fn credits_cache_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits")
}

pub fn exhaustion_cache_keys(id: &str) -> [String; 2] {
    [
        format!("twitch:{id}:ai:exhaust"),
        format!("{id}:ai:exhaust"),
    ]
}

pub fn snapshot_version_key(id: &str) -> String {
    format!("twitch:{id}:ai:credits:polar-version")
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct TtlSeconds(u64);

impl TtlSeconds {
    pub fn new(seconds: u64) -> Result<Self, FenceError> {
        if seconds == 0 || seconds > (i64::MAX as u64) / 1000 {
            return Err(FenceError::InvalidTtl);
        }
        Ok(Self(seconds))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Acceptance {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CreditMode {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Exhaustion {
    Keep,
    Exhausted,
    Available,
}

#[derive(Debug, Clone, Copy)]
pub struct AccountVersion<'a> {
    pub id: &'a str,
    /// Empty supports accounts that predate plan version metadata.
    pub version: &'a str,
}

/// Contains strings exactly as Redis stores them. Deliberately does not derive
/// Debug: account hashes may include credentials.
#[derive(Clone, Eq, PartialEq)]
pub struct AccountSnapshot {
    fields: Vec<(String, String)>,
}

impl AccountSnapshot {
    /// Internal representation for aggregation; includes version metadata.
    pub fn fields(&self) -> &[(String, String)] {
        &self.fields
    }

    pub fn id(&self) -> &str {
        self.field("id").unwrap_or("")
    }

    pub fn version(&self) -> &str {
        self.field(PLAN_CACHE_VERSION_FIELD).unwrap_or("")
    }

    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Never expose the protocol's internal version in public API payloads.
    pub fn public_fields(&self) -> impl Iterator<Item = (&str, &str)> {
        self.fields
            .iter()
            .filter(|(key, _)| key != PLAN_CACHE_VERSION_FIELD)
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum AccountRead {
    Accepted(AccountSnapshot),
    Stale,
    Missing,
}

impl fmt::Debug for AccountRead {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Accepted(_) => "Accepted(<redacted account>)",
            Self::Stale => "Stale",
            Self::Missing => "Missing",
        })
    }
}

/// Owns immutable prepared handles and a cheap cloneable injected transport.
/// Construction neither connects nor loads scripts; first use handles NOSCRIPT.
#[derive(Clone)]
pub struct PlanCacheFence {
    connection: ConnectionManager,
    deadline: Duration,
    write_account_script: Script,
    check_accounts_script: Script,
    accept_credits_script: Script,
    invalidate_plan_script: Script,
    sync_credits_script: Script,
    read_account_script: Script,
}

impl PlanCacheFence {
    pub fn new(connection: ConnectionManager) -> Self {
        Self::construct(connection, DEFAULT_OPERATION_DEADLINE)
    }

    pub fn with_deadline(
        connection: ConnectionManager,
        deadline: Duration,
    ) -> Result<Self, FenceError> {
        if deadline.is_zero() {
            return Err(FenceError::InvalidDeadline);
        }
        Ok(Self::construct(connection, deadline))
    }

    fn construct(connection: ConnectionManager, deadline: Duration) -> Self {
        Self {
            connection,
            deadline,
            write_account_script: Script::new(WRITE_PLAN_ACCOUNT_SCRIPT),
            check_accounts_script: Script::new(CHECK_PLAN_ACCOUNTS_SCRIPT),
            accept_credits_script: Script::new(ACCEPT_PLAN_CREDITS_SCRIPT),
            invalidate_plan_script: Script::new(INVALIDATE_PLAN_SCRIPT),
            sync_credits_script: Script::new(SYNC_CREDITS_SCRIPT),
            read_account_script: Script::new(READ_PLAN_ACCOUNT_SCRIPT),
        }
    }

    /// HSET preserves unspecified fields, string values and existing hash TTL.
    /// The internal version is always supplied last, matching the TS spread.
    /// This does not protect credential updates; see module-level contract.
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
        let mut args = vec![version];
        for &(key, value) in fields {
            if key != PLAN_CACHE_VERSION_FIELD {
                args.extend([key, value]);
            }
        }
        args.extend([PLAN_CACHE_VERSION_FIELD, version]);
        self.execute(&self.write_account_script, &keys, &args, true)
            .await
    }

    /// Validates every version and optionally publishes exact raw JSON in ONE
    /// atomic command. Never split a large aggregate into validation chunks.
    /// Rejected oversized aggregates must be reduced by the caller. Empty raw
    /// strings retain the source's no-publication behavior; TTL is 3600 seconds.
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
        self.execute(&self.check_accounts_script, &keys, &args, !raw.is_empty())
            .await
    }

    /// Even read mode updates both exhaustion keys; exact raw equality and the
    /// plan fence are checked atomically before touching either key.
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
        self.execute(&self.accept_credits_script, &keys, &args, true)
            .await
    }

    /// The context key is opaque and must come from the existing TS helper:
    /// SHA256(customerId).hex()[..20] inside its versioned billing context key.
    /// This adapter does not introduce a second billing hash implementation.
    /// Invalidates the ENTIRE account hash, exactly as the source script does.
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
        self.execute(&self.invalidate_plan_script, &keys, &[version], true)
            .await
    }

    /// Missing/empty payload leaves the cached credit value and TTL unchanged.
    /// Keep leaves BOTH exhaustion shapes unchanged. Snapshot and plan fences
    /// remain persistent, with equal versions accepted as in the source.
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
        self.execute(&self.sync_credits_script, &keys, &args, true)
            .await
    }

    /// Reads the requested account hash and that ID's fence in a single Redis
    /// script. A hash whose stored ID differs from the requested ID is rejected
    /// as malformed, rather than returning a snapshot fenced for another ID.
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
        let mut invocation = self.read_account_script.prepare_invoke();
        invocation.key(&keys).arg(&args);
        let mut connection = self.connection.clone();
        let response = self
            .bounded(
                false,
                invocation.invoke_async::<(i64, Vec<String>)>(&mut connection),
            )
            .await?;
        decode_account_for_id(channel_id, response)
    }

    /// One bounded pipeline of independent atomic reads, in request order.
    /// No KEYS/SCAN or aggregate publication occurs. A confirmed NOSCRIPT can
    /// reload and replay this read-only batch once; no other failure is retried.
    /// Final aggregate checks/publication still require `check_accounts`.
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
                .arg(self.read_account_script.get_hash())
                .arg(2)
                .arg(account_cache_key(id))
                .arg(plan_cache_fence_key(id))
                .arg(MAX_ACCOUNT_FIELDS)
                .arg(MAX_READ_ACCOUNT_BYTES);
        }
        let mut connection = self.connection.clone();
        let operation = async {
            let response: Result<Vec<(i64, Vec<String>)>, redis::RedisError> =
                pipeline.query_async(&mut connection).await;
            match response {
                Err(error) if error.kind() == ErrorKind::Server(ServerErrorKind::NoScript) => {
                    self.read_account_script.load_async(&mut connection).await?;
                    pipeline.query_async(&mut connection).await
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
            .map(|(id, response)| decode_account_for_id(id, response))
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
        let mut invocation = script.prepare_invoke();
        invocation.key(keys).arg(args);
        let mut connection = self.connection.clone();
        let response = self
            .bounded(mutation, invocation.invoke_async::<i64>(&mut connection))
            .await?;
        match response {
            1 => Ok(Acceptance::Accepted),
            0 => Ok(Acceptance::Rejected),
            _ => Err(FenceError::Protocol),
        }
    }

    async fn bounded<T>(
        &self,
        mutation: bool,
        operation: impl Future<Output = redis::RedisResult<T>>,
    ) -> Result<T, FenceError> {
        tokio::time::timeout(self.deadline, operation)
            .await
            .map_err(|_| FenceError::DeadlineExceeded {
                write_outcome_unknown: mutation,
            })?
            .map_err(|_| FenceError::Redis {
                write_outcome_unknown: mutation,
            })
    }
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
                plan_cache_version(Some(at), Some("event")),
                Ok(expected.into())
            );
        }
        for at in [
            i64::MIN,
            -8_640_000_000_000_001,
            8_640_000_000_000_001,
            i64::MAX,
        ] {
            assert_eq!(
                plan_cache_version(Some(at), Some("event")),
                Err(FenceError::InvalidDate)
            );
        }
    }

    #[test]
    fn legacy_versions_and_binary_order_are_not_numeric_or_utf16_order() {
        assert_eq!(plan_cache_version(None, Some("event")), Ok(String::new()));
        assert_eq!(plan_cache_version(Some(1), None), Ok(String::new()));
        assert_eq!(plan_cache_version(Some(1), Some("")), Ok(String::new()));
        // Source short-circuits missing key before accessing the Date.
        assert_eq!(
            plan_cache_version(Some(i64::MAX), Some("")),
            Ok(String::new())
        );
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
        assert_eq!(TtlSeconds::new(0), Err(FenceError::InvalidTtl));
        assert_eq!(TtlSeconds::new(u64::MAX), Err(FenceError::InvalidTtl));
        assert_eq!(TtlSeconds::new(1).unwrap().get(), 1);
        assert_eq!(TtlSeconds::new(3600).unwrap().get(), 3600);
        assert_eq!(check_id(&"a".repeat(MAX_ID_BYTES)), Ok(()));
        assert_eq!(
            check_id(&"a".repeat(MAX_ID_BYTES + 1)),
            Err(FenceError::InputTooLarge)
        );
        assert_eq!(check_value(&"ä".repeat(MAX_VALUE_BYTES / 2)), Ok(()));
        assert_eq!(
            check_value(&"ä".repeat(MAX_VALUE_BYTES / 2 + 1)),
            Err(FenceError::InputTooLarge)
        );
        let value = "a".repeat(MAX_VALUE_BYTES);
        assert_eq!(
            validate_request(&[], &[&value, &value, &value, &value]),
            Err(FenceError::InputTooLarge)
        );
        // Raw JSON is never parsed or normalized, even when invalid/empty.
        assert_eq!(
            validate_request(&["key".into()], &["", " {\n\"a\": 1 }", "not-json"]),
            Ok(())
        );
    }

    #[test]
    fn batches_have_independent_count_and_wire_size_bounds() {
        assert_eq!(validate_read_batch(&[]), Ok(()));
        assert_eq!(
            validate_read_batch(&vec!["x"; MAX_READ_BATCH_ACCOUNTS]),
            Ok(())
        );
        assert_eq!(
            validate_read_batch(&vec!["x"; MAX_READ_BATCH_ACCOUNTS + 1]),
            Err(FenceError::InputTooLarge)
        );
        let long = "x".repeat(MAX_ID_BYTES);
        assert_eq!(
            validate_read_batch(&vec![long.as_str(); MAX_READ_BATCH_ACCOUNTS]),
            Err(FenceError::InputTooLarge)
        );
    }

    #[test]
    fn account_read_states_do_not_collapse_errors_or_expose_metadata() {
        assert_eq!(decode_account((0, vec![])), Ok(AccountRead::Missing));
        assert_eq!(decode_account((-1, vec![])), Ok(AccountRead::Stale));
        assert_eq!(
            decode_account((-2, vec![])),
            Err(FenceError::AccountTooLarge)
        );
        assert_eq!(decode_account((5, vec![])), Err(FenceError::Protocol));
        assert_eq!(
            decode_account((1, vec!["id".into()])),
            Err(FenceError::Protocol)
        );
        assert_eq!(
            decode_account((1, vec!["name".into(), "x".into()])),
            Err(FenceError::Protocol)
        );
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
        assert_eq!(
            decode_account_for_id("requested-channel", (1, fields.clone())),
            Err(FenceError::Protocol)
        );
        assert!(matches!(
            decode_account_for_id("other-channel", (1, fields)),
            Ok(AccountRead::Accepted(_))
        ));
        assert_eq!(
            decode_account_for_id("requested-channel", (0, vec![])),
            Ok(AccountRead::Missing)
        );
    }

    #[test]
    fn constructor_types_are_synchronous_and_transport_is_injected() {
        let _: fn(ConnectionManager) -> PlanCacheFence = PlanCacheFence::new;
        let _: fn(ConnectionManager, Duration) -> Result<PlanCacheFence, FenceError> =
            PlanCacheFence::with_deadline;
        fn require_send_sync<T: Send + Sync>() {}
        require_send_sync::<PlanCacheFence>();
        // Preparing handles is pure; SCRIPT LOAD is deferred to an operation.
        for source in [
            WRITE_PLAN_ACCOUNT_SCRIPT,
            CHECK_PLAN_ACCOUNTS_SCRIPT,
            ACCEPT_PLAN_CREDITS_SCRIPT,
            INVALIDATE_PLAN_SCRIPT,
            SYNC_CREDITS_SCRIPT,
            READ_PLAN_ACCOUNT_SCRIPT,
        ] {
            let script = Script::new(source);
            assert_eq!(script.get_hash().len(), 40);
            assert_eq!(script.get_hash(), Script::new(source).get_hash());
        }
    }

    #[test]
    fn errors_are_static_and_unknown_mutation_outcomes_are_explicit() {
        for error in [
            FenceError::InvalidDate,
            FenceError::InvalidTtl,
            FenceError::InputTooLarge,
            FenceError::AccountTooLarge,
            FenceError::Protocol,
            FenceError::Redis {
                write_outcome_unknown: false,
            },
            FenceError::Redis {
                write_outcome_unknown: true,
            },
            FenceError::DeadlineExceeded {
                write_outcome_unknown: true,
            },
        ] {
            assert!(!error.to_string().contains("secret-token"));
            assert!(!format!("{error:?}").contains("secret-token"));
        }
        assert!(
            FenceError::DeadlineExceeded {
                write_outcome_unknown: true
            }
            .to_string()
            .contains("unknown")
        );
    }
}
