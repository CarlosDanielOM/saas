//! Typed permit parsing and native Redis transport for moderation/permit.ts.
//! The default client follows the shared native connection policy; see the
//! migration handoff for its telemetry/logging differences from the TS wrapper.
use crate::utils::{
    js_string::JsString,
    js_unicode::lowercase,
    json_number::number_string,
    observability::{Telemetry, restore_context, telemetry_context},
    redis_application_runtime,
};
use redis::{RedisResult, aio::ConnectionManager};
use std::{
    future::Future,
    time::{SystemTime, UNIX_EPOCH},
};

type PermitRead = RedisResult<Option<Vec<u8>>>;

// A detached coordinator owns both futures, forwarding each completion as it
// occurs. Dropping the receiver leaves the other read running, like the
// remaining promise after Promise.all rejects. Both futures are polled on the
// coordinator's first pass, in the source's user-then-channel order.
async fn concurrent_reads<A, B>(user: A, channel: B) -> RedisResult<bool>
where
    A: Future<Output = PermitRead> + Send + 'static,
    B: Future<Output = PermitRead> + Send + 'static,
{
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let other_sender = sender.clone();
    let parent_context = telemetry_context();
    tokio::spawn(async move {
        let coordinator = async move {
            tokio::join!(biased;
                async { let _ = sender.send(user.await); },
                async { let _ = other_sender.send(channel.await); }
            );
        };
        if let Some(context) = parent_context {
            let channel_id = context.channel.clone();
            restore_context(Some(context), &channel_id, coordinator).await;
        } else {
            coordinator.await;
        }
    });
    let missing = || redis::RedisError::from(std::io::Error::other("permit read task exited"));
    let first = receiver.recv().await.ok_or_else(missing)??;
    let second = receiver.recv().await.ok_or_else(missing)??;
    Ok(first.is_some() || second.is_some())
}

pub const PERMIT_MIN_SECONDS: u32 = 1;
pub const PERMIT_MAX_SECONDS: u32 = 600;
pub const PERMIT_DEFAULT_SECONDS: u32 = 60;
pub const PERMIT_USAGE: &str = "Usage: $(permit [user] [seconds]). No arguments permits everyone for 60s; a number permits everyone for that many seconds (1-600); a username permits only that user.";
pub const DURATION_ERROR: &str = "Duration must be between 1 and 600 seconds.";
pub const DURATION_NUMBER_ERROR: &str = "Duration must be a number between 1 and 600 seconds.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermitTarget {
    pub login: Option<JsString>,
    pub seconds: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermitParseResult {
    Error(&'static str),
    Target(PermitTarget),
}

pub fn normalize_permit_login(raw: &JsString) -> JsString {
    let trimmed = raw.trim();
    let units = trimmed.units();
    let first = units.iter().take_while(|&&u| u == u16::from(b'@')).count();
    let stripped = JsString::from_units(units[first..].to_vec());
    lowercase(&stripped).into_owned()
}

// The input has already been JS-trimmed. Saturation is enough because all
// values above 600 (including parseInt's Infinity) follow the same branch.
fn parse_seconds(text: &JsString) -> Option<Option<u32>> {
    let mut value = 0u32;
    let mut any = false;
    for unit in text.code_units() {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(&unit) {
            return None;
        }
        any = true;
        value = value
            .saturating_mul(10)
            .saturating_add(u32::from(unit - u16::from(b'0')));
    }
    any.then_some(
        (PERMIT_MIN_SECONDS..=PERMIT_MAX_SECONDS)
            .contains(&value)
            .then_some(value),
    )
}
fn valid_login(login: &JsString) -> bool {
    let units = login.units();
    (1..=25).contains(&units.len())
        && units
            .iter()
            .all(|&c| matches!(c, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f))
}
fn target(login: Option<JsString>, seconds: u32) -> PermitParseResult {
    PermitParseResult::Target(PermitTarget { login, seconds })
}

/// `rawArgs` is a typed JavaScript string array; arbitrary invalid casts and
/// custom object-to-string hooks are outside this interface.
pub fn parse_permit_args(raw_args: &[JsString]) -> PermitParseResult {
    let args: Vec<JsString> = raw_args
        .iter()
        .map(JsString::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if args.is_empty() {
        return target(None, PERMIT_DEFAULT_SECONDS);
    }
    if args.len() > 2 {
        return PermitParseResult::Error(PERMIT_USAGE);
    }
    let first_seconds = parse_seconds(&args[0]);
    if args.len() == 1 {
        match first_seconds {
            Some(Some(seconds)) => return target(None, seconds),
            Some(None) => return PermitParseResult::Error(DURATION_ERROR),
            None => {}
        }
        let login = normalize_permit_login(&args[0]);
        return if valid_login(&login) {
            target(Some(login), PERMIT_DEFAULT_SECONDS)
        } else {
            PermitParseResult::Error(PERMIT_USAGE)
        };
    }
    let login = normalize_permit_login(&args[0]);
    if first_seconds.is_some() || !valid_login(&login) {
        return PermitParseResult::Error(PERMIT_USAGE);
    }
    match parse_seconds(&args[1]) {
        Some(Some(seconds)) => target(Some(login), seconds),
        _ => PermitParseResult::Error(DURATION_NUMBER_ERROR),
    }
}

fn join_key(
    prefix: &str,
    channel_id: &JsString,
    suffix: &str,
    login: Option<&JsString>,
) -> JsString {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend(channel_id.code_units());
    units.extend(suffix.encode_utf16());
    if let Some(login) = login {
        units.extend(lowercase(login).code_units());
    }
    JsString::from_units(units)
}
pub fn permit_user_key(channel_id: &JsString, login: &JsString) -> JsString {
    join_key("moderation:", channel_id, ":permit:user:", Some(login))
}
pub fn permit_channel_key(channel_id: &JsString) -> JsString {
    join_key("moderation:", channel_id, ":permit:channel", None)
}

/// Arguments for the source's `SET key value EX seconds` command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermitGrant {
    pub key: JsString,
    pub value: String,
    pub seconds: String,
}
fn grant_key(channel_id: &JsString, login: Option<&JsString>) -> JsString {
    match login.filter(|login| !login.is_empty()) {
        Some(login) => permit_user_key(channel_id, login),
        None => permit_channel_key(channel_id),
    }
}
fn plan_with_key(key: JsString, seconds: f64, now: f64) -> PermitGrant {
    PermitGrant {
        key,
        value: number_string(now + seconds * 1000.0),
        seconds: number_string(seconds),
    }
}
pub fn grant_plan(
    channel_id: &JsString,
    seconds: f64,
    login: Option<&JsString>,
    now: f64,
) -> PermitGrant {
    plan_with_key(grant_key(channel_id, login), seconds, now)
}

fn now_ms() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as f64,
        Err(error) => -(error.duration().as_nanos().div_ceil(1_000_000) as f64),
    }
}

/// A supplied native manager shares its multiplexed socket with its clones.
/// Explicit telemetry instruments operations; `connect` uses the shared native
/// application owner. Connection-event logging and process metrics remain open.
#[derive(Clone)]
pub struct PermitStore {
    cache: ConnectionManager,
    telemetry: Option<Telemetry>,
}
impl PermitStore {
    pub fn new(cache: ConnectionManager) -> Self {
        Self {
            cache,
            telemetry: None,
        }
    }
    pub fn with_telemetry(cache: ConnectionManager, telemetry: Telemetry) -> Self {
        Self {
            cache,
            telemetry: Some(telemetry),
        }
    }
    pub async fn connect() -> RedisResult<Self> {
        let (cache, telemetry) = redis_application_runtime::acquire().await?;
        Ok(Self { cache, telemetry })
    }
    pub async fn grant_permit(
        &self,
        channel_id: &JsString,
        seconds: f64,
        login: Option<&JsString>,
    ) -> RedisResult<()> {
        let key = grant_key(channel_id, login);
        self.write_plan(plan_with_key(key, seconds, now_ms())).await
    }
    /// Explicit clock boundary for deterministic parity tests; seconds is not
    /// prevalidated, just as with the source export.
    pub async fn grant_permit_at(
        &self,
        channel_id: &JsString,
        seconds: f64,
        login: Option<&JsString>,
        now: f64,
    ) -> RedisResult<()> {
        self.write_plan(grant_plan(channel_id, seconds, login, now))
            .await
    }
    async fn write_plan(&self, plan: PermitGrant) -> RedisResult<()> {
        let mut cache = self.cache.clone();
        let span = self
            .telemetry
            .as_ref()
            .map(|t| t.begin_span("cache", "set", None));
        let reply: RedisResult<String> = redis::cmd("SET")
            .arg(plan.key.to_utf8_lossy())
            .arg(plan.value)
            .arg("EX")
            .arg(plan.seconds)
            .query_async(&mut cache)
            .await;
        if let Some(span) = span {
            span.end(if reply.is_ok() { "ok" } else { "error" }, None);
        }
        reply.map(|_| ())
    }
    async fn get(&self, key: JsString) -> RedisResult<Option<Vec<u8>>> {
        let mut cache = self.cache.clone();
        let span = self
            .telemetry
            .as_ref()
            .map(|t| t.begin_span("cache", "get", None));
        let reply: RedisResult<Option<Vec<u8>>> = redis::cmd("GET")
            .arg(key.to_utf8_lossy())
            .query_async(&mut cache)
            .await;
        if let Some(span) = span {
            span.end(if reply.is_ok() { "ok" } else { "error" }, None);
        }
        if let (Some(telemetry), Ok(value)) = (&self.telemetry, &reply) {
            telemetry.observe(
                "cache_lookup",
                "get",
                0.0,
                if value.is_some() { "hit" } else { "miss" },
                None,
                now_ms() as i64,
            );
        }
        reply
    }
    pub async fn has_active_permit(
        &self,
        channel_id: &JsString,
        login: &JsString,
    ) -> RedisResult<bool> {
        let user_key = permit_user_key(channel_id, login);
        let channel_key = permit_channel_key(channel_id);
        let user_store = self.clone();
        let channel_store = self.clone();
        concurrent_reads(async move { user_store.get(user_key).await }, async move {
            channel_store.get(channel_key).await
        })
        .await
    }
}

pub async fn grant_permit(
    channel_id: &JsString,
    seconds: f64,
    login: Option<&JsString>,
) -> RedisResult<()> {
    PermitStore::connect()
        .await?
        .grant_permit(channel_id, seconds, login)
        .await
}
pub async fn has_active_permit(channel_id: &JsString, login: &JsString) -> RedisResult<bool> {
    PermitStore::connect()
        .await?
        .has_active_permit(channel_id, login)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::observability::{TraceContext, telemetry_context, with_telemetry_context};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::{Barrier, Notify};

    #[tokio::test]
    async fn read_tasks_keep_parent_telemetry_context() {
        let parent = TraceContext {
            trace_id: "0123456789abcdef0123456789abcdef".into(),
            span_id: "0123456789abcdef".into(),
            sampled: true,
            channel: "permit_channel".into(),
            outcome: None,
        };
        let observed = Arc::new(Mutex::new(Vec::new()));
        let read = || {
            let observed = observed.clone();
            async move {
                observed.lock().unwrap().push(telemetry_context());
                Ok(None)
            }
        };
        let result = with_telemetry_context(parent, concurrent_reads(read(), read())).await;
        assert!(!result.unwrap());
        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 2, "both read futures must run");
        for context in observed.iter() {
            let context = context
                .as_ref()
                .expect("read lost parent telemetry context");
            assert_eq!(context.trace_id, "0123456789abcdef0123456789abcdef");
            assert_eq!(context.span_id, "0123456789abcdef");
            assert_eq!(context.channel, "permit_channel");
            assert!(context.sampled);
        }
    }

    #[tokio::test]
    async fn errors_do_not_wait_for_the_other_started_read() {
        for fail_user in [true, false] {
            let started = Arc::new(Barrier::new(3));
            let release = Arc::new(Notify::new());
            let finished = Arc::new(Notify::new());
            let read = |fails: bool| {
                let (started, release, finished) =
                    (started.clone(), release.clone(), finished.clone());
                async move {
                    started.wait().await;
                    if fails {
                        Err(redis::RedisError::from(std::io::Error::other(
                            "fixture read error",
                        )))
                    } else {
                        release.notified().await;
                        finished.notify_one();
                        Ok(Some(Vec::new()))
                    }
                }
            };
            let pending = tokio::spawn(concurrent_reads(read(fail_user), read(!fail_user)));
            tokio::time::timeout(Duration::from_secs(2), started.wait())
                .await
                .unwrap();
            let result = tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            assert!(
                result.is_err(),
                "first error should return before the held read"
            );
            release.notify_one();
            tokio::time::timeout(Duration::from_secs(2), finished.notified())
                .await
                .unwrap();
        }
    }
}
