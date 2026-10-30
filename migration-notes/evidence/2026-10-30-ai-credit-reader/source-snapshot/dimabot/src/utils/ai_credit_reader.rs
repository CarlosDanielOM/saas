//! Concrete, opt-in `getAiCredits` reader, scoped to the semantic worker.
//! Constructors do not perform I/O. All instances share injected Redis/Mongo and
//! Polar pools; the default path acquires the process clients lazily. A total
//! provider timeout and optional overall deadline are independent.
//! Dropping the future cancels further work; never retry an uncertain Redis write.
use super::{
    ai_credit_projection::{
        AI_CREDITS_CACHE_TTL_SECONDS, AI_CREDITS_METER_ID, PlanTier,
        build_ai_credits_data_from_meter_at, get_ai_credit_limit_for_plan, iso_at,
    },
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    plan_cache_fence::{
        Acceptance, CreditMode, PLAN_CACHE_VERSION_FIELD, PlanCacheFence, TtlSeconds,
        credits_cache_key, exhaustion_cache_keys, plan_cache_fence_key, plan_cache_version,
    },
    polar::{PolarClient, PolarPolicy},
    tts::settings::{js_number, truthy},
};
use mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use redis::aio::ConnectionManager;
use reqwest::{Method, header::HeaderMap};
use serde_json::value::RawValue;
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::OnceCell;

#[derive(Clone, Debug)]
pub struct CreditOwner {
    pub tier: Option<PlanTier>,
    pub customer_id: Option<String>,
}

#[derive(Clone)]
enum DatabaseSource {
    Explicit(Database),
    Default,
}
#[derive(Clone)]
enum PolarSource {
    Explicit(PolarClient),
    Default,
}

#[derive(Clone)]
pub struct AiCreditReader {
    connection: ConnectionManager,
    database: DatabaseSource,
    polar: PolarSource,
    provider_timeout: Duration,
    overall_deadline: Option<Duration>,
    clock: Option<SystemTime>,
}
static DEFAULT_POLAR: OnceCell<Arc<PolarClient>> = OnceCell::const_new();

impl AiCreditReader {
    /// No connection or environment reads occur here. All clients are pooled.
    pub fn new(
        connection: ConnectionManager,
        database: Database,
        polar: PolarClient,
        deadline: Duration,
    ) -> Result<Self, String> {
        if deadline.is_zero() {
            return Err("deadline must be nonzero".into());
        }
        Ok(Self {
            connection,
            database: DatabaseSource::Explicit(database),
            polar: PolarSource::Explicit(polar),
            provider_timeout: deadline,
            overall_deadline: None,
            clock: None,
        })
    }

    /// Lazily obtains the shared Redis manager; Mongo and Polar are obtained
    /// only on the branches that need them. URI must select a Mongo database.
    pub async fn default(deadline: Duration) -> Result<Self, String> {
        if deadline.is_zero() {
            return Err("deadline must be nonzero".into());
        }
        let connection = super::redis::get_redis_client()
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection,
            database: DatabaseSource::Default,
            polar: PolarSource::Default,
            provider_timeout: deadline,
            overall_deadline: None,
            clock: None,
        })
    }

    pub fn with_provider_timeout(mut self, timeout: Duration) -> Result<Self, String> {
        if timeout.is_zero() {
            return Err("provider timeout must be nonzero".into());
        }
        self.provider_timeout = timeout;
        Ok(self)
    }
    /// Optional total budget is distinct from the provider signal timeout. A
    /// total timeout or dropped future can leave a Redis write outcome unknown.
    pub fn with_overall_deadline(mut self, deadline: Duration) -> Result<Self, String> {
        if deadline.is_zero() {
            return Err("deadline must be nonzero".into());
        }
        self.overall_deadline = Some(deadline);
        Ok(self)
    }
    /// Fixture clock also applies to fallback and cache default timestamps.
    pub fn with_fixed_clock(mut self, now: SystemTime) -> Self {
        self.clock = Some(now);
        self
    }
    fn now(&self) -> SystemTime {
        self.clock.unwrap_or_else(SystemTime::now)
    }
    pub async fn get_ai_credits(
        &self,
        owner: &CreditOwner,
        channel: &str,
        require_verified: bool,
    ) -> Result<JsonValue, String> {
        let signal_deadline = tokio::time::Instant::now() + self.provider_timeout;
        self.get_with_signal_deadline(owner, channel, require_verified, signal_deadline)
            .await
    }
    async fn get_with_signal_deadline(
        &self,
        owner: &CreditOwner,
        channel: &str,
        require_verified: bool,
        signal_deadline: tokio::time::Instant,
    ) -> Result<JsonValue, String> {
        match self.overall_deadline {
            Some(deadline) => tokio::time::timeout(
                deadline,
                self.read(owner, channel, require_verified, signal_deadline),
            )
            .await
            .map_err(|_| {
                "credit reader overall deadline exceeded; a Redis write may have completed"
                    .to_string()
            })?,
            None => {
                self.read(owner, channel, require_verified, signal_deadline)
                    .await
            }
        }
    }

    async fn get(&self, key: &str) -> Result<Option<String>, String> {
        let mut connection = self.connection.clone();
        redis::cmd("GET")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|e| e.to_string())
    }
    async fn exists(&self, key: &str) -> Result<i64, String> {
        let mut connection = self.connection.clone();
        redis::cmd("EXISTS")
            .arg(key)
            .query_async(&mut connection)
            .await
            .map_err(|e| e.to_string())
    }
    async fn accept(
        &self,
        channel: &str,
        version: &str,
        raw: &str,
        mode: CreditMode,
        payload: &JsonValue,
    ) -> Result<bool, String> {
        let fence = PlanCacheFence::new(self.connection.clone());
        let result = fence
            .accept_credits(
                channel,
                version,
                raw,
                mode,
                payload.get("status") == Some(&s("exhausted")),
                TtlSeconds::new(AI_CREDITS_CACHE_TTL_SECONDS).map_err(|e| e.to_string())?,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(result == Acceptance::Accepted)
    }
    async fn current_owner(
        &self,
        channel: &str,
        expected: Option<&str>,
    ) -> Result<Option<(CreditOwner, String)>, String> {
        let database = match &self.database {
            DatabaseSource::Explicit(db) => db.clone(),
            DatabaseSource::Default => super::mongo::get_mongo_client()
                .await
                .map_err(|e| e.to_string())?
                .default_database()
                .ok_or_else(|| "MONGO_URI must select a database".to_string())?,
        };
        let mut filter = doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}};
        if let Some(customer) = expected.filter(|s| !s.is_empty()) {
            filter.insert("polar_sh_customer_id", customer);
        }
        let result = database.collection::<Document>("users").find_one(filter)
            .projection(doc! {"_id": 0, "plan_tier": 1, "polar_sh_customer_id": 1, "polar_plan_event_at": 1, "polar_plan_event_key": 1})
            .await.map_err(|e| e.to_string())?;
        let Some(user) = result else {
            return Ok(None);
        };
        let tier = match user.get_str("plan_tier").ok() {
            Some("premium") => Some(PlanTier::Premium),
            Some("pro") => Some(PlanTier::Pro),
            _ => Some(PlanTier::Free),
        };
        let customer_id = user.get_str("polar_sh_customer_id").ok().map(str::to_owned);
        let at = match user.get("polar_plan_event_at") {
            Some(Bson::DateTime(v)) => Some(v.timestamp_millis()),
            _ => None,
        };
        let key = user.get_str("polar_plan_event_key").ok();
        let version = plan_cache_version(at, key).map_err(|e| e.to_string())?;
        Ok(Some((CreditOwner { tier, customer_id }, version)))
    }
    async fn state(&self, customer: &str) -> Result<JsonValue, String> {
        let client = match &self.polar {
            PolarSource::Explicit(client) => Arc::new(client.clone()),
            PolarSource::Default => DEFAULT_POLAR
                .get_or_try_init(|| async {
                    PolarClient::from_env(PolarPolicy::Billing)
                        .map(Arc::new)
                        .map_err(|e| e.to_string())
                })
                .await?
                .clone(),
        };
        // RawValue keeps JSON's exact bytes for the existing JS-compatible parser.
        let raw: Box<RawValue> = client
            .request_json(
                Method::GET,
                &format!("/v1/customers/{customer}/state"),
                None,
                &HeaderMap::new(),
            )
            .await
            .map_err(|e| e.to_string())?;
        parse_json(raw.get())
    }
    async fn read(
        &self,
        owner: &CreditOwner,
        channel: &str,
        verified: bool,
        signal_deadline: tokio::time::Instant,
    ) -> Result<JsonValue, String> {
        // These failures escape, as do failures to acquire the cache itself.
        let cached = self.get(&credits_cache_key(channel)).await?;
        if let Some(raw) = cached.filter(|raw| !raw.is_empty())
            && let Ok(parsed) = parse_json(&raw)
            && let Ok(Some(payload)) = cached_payload_at(&parsed, verified, self.now())
        {
            let version = match parsed.get(PLAN_CACHE_VERSION_FIELD) {
                Some(JsonValue::String(v)) => Some(v.to_utf8_lossy()),
                None | Some(JsonValue::Null) => Some(String::new()),
                // The source passes this value to Redis, whose client rejects non-string values.
                _ => None,
            };
            if let Some(version) = version
                && self
                    .accept(channel, &version, &raw, CreditMode::Read, &payload)
                    .await
                    .unwrap_or(false)
            {
                return Ok(payload);
            }
        }
        let mut fence = None;
        let mut current = owner.clone();
        let attempt: Result<JsonValue, String> = async {
            fence = self.get(&plan_cache_fence_key(channel)).await?;
            let mut version = String::new();
            if fence.as_ref().is_some_and(|s| !s.is_empty()) {
                let Some((fresh, fresh_version)) = self
                    .current_owner(channel, owner.customer_id.as_deref())
                    .await?
                else {
                    return unavailable(self.now());
                };
                // This comparison runs in JavaScript before the separate Lua
                // fence check, so it uses UTF-16 order rather than UTF-8 bytes.
                if fresh_version
                    .encode_utf16()
                    .cmp(fence.as_ref().unwrap().encode_utf16())
                    == std::cmp::Ordering::Less
                {
                    return unavailable(self.now());
                }
                version = fresh_version;
                current = fresh;
            }
            let Some(customer) = current.customer_id.as_deref().filter(|id| !id.is_empty()) else {
                if fence.as_ref().is_some_and(|s| !s.is_empty()) {
                    return unavailable(self.now());
                }
                let mut payload = unavailable(self.now())?;
                let limit = get_ai_credit_limit_for_plan(current.tier);
                set(&mut payload, "limit", JsonValue::Number(limit));
                set(&mut payload, "balance", JsonValue::Number(limit));
                return Ok(payload);
            };
            let state = tokio::time::timeout_at(signal_deadline, self.state(customer))
                .await
                .map_err(|_| "Polar provider timeout".to_string())??;
            let meter = match state.get("active_meters") {
                Some(JsonValue::Array(values)) => values
                    .iter()
                    .find(|v| v.get("meter_id") == Some(&s(AI_CREDITS_METER_ID))),
                _ => None,
            };
            let mut payload =
                build_ai_credits_data_from_meter_at(meter, current.tier, None, self.now())?;
            if verified && meter.is_none() {
                set(&mut payload, "available", JsonValue::Bool(false));
                set(&mut payload, "status", s("unavailable"));
            }
            let mut cached = payload.clone();
            set(&mut cached, PLAN_CACHE_VERSION_FIELD, s(&version));
            if self
                .accept(
                    channel,
                    &version,
                    &cached.to_json_string(),
                    CreditMode::Write,
                    &payload,
                )
                .await?
            {
                Ok(payload)
            } else {
                unavailable(self.now())
            }
        }
        .await;
        match attempt {
            Ok(payload) => Ok(payload),
            Err(error) => {
                eprintln!(
                    "getAiCredits: Polar fetch failed, returning fallback from plan limit: {error}"
                );
                if fence.as_ref().is_some_and(|s| !s.is_empty()) {
                    return unavailable(self.now());
                }
                match self.get(&plan_cache_fence_key(channel)).await {
                    Ok(Some(f)) if !f.is_empty() => return unavailable(self.now()),
                    Err(_) => return unavailable(self.now()),
                    _ => {}
                }
                let [canonical, legacy] = exhaustion_cache_keys(channel);
                let exhausted =
                    match tokio::try_join!(self.exists(&canonical), self.exists(&legacy)) {
                        Ok((a, b)) => a == 1 || b == 1,
                        Err(_) => false,
                    };
                fallback(current.tier, exhausted, self.now())
            }
        }
    }
}

fn s(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}
fn set(value: &mut JsonValue, name: &str, new: JsonValue) {
    if let JsonValue::Object(fields) = value {
        if let Some((_, value)) = fields.iter_mut().find(|(k, _)| k.as_str() == Some(name)) {
            *value = new;
        } else {
            fields.push((JsString::from(name), new));
        }
    }
}
fn dto(
    used: f64,
    limit: f64,
    balance: f64,
    available: bool,
    status: &str,
    now: SystemTime,
) -> Result<JsonValue, String> {
    Ok(JsonValue::Object(vec![
        ("version".into(), JsonValue::Number(3.0)),
        ("used".into(), JsonValue::Number(used)),
        ("limit".into(), JsonValue::Number(limit)),
        ("balance".into(), JsonValue::Number(balance)),
        ("meterId".into(), s(AI_CREDITS_METER_ID)),
        ("updatedAt".into(), JsonValue::String(iso_at(now)?)),
        ("available".into(), JsonValue::Bool(available)),
        ("status".into(), s(status)),
    ]))
}
fn unavailable(now: SystemTime) -> Result<JsonValue, String> {
    dto(0.0, 25000.0, 0.0, false, "unavailable", now)
}
fn fallback(tier: Option<PlanTier>, exhausted: bool, now: SystemTime) -> Result<JsonValue, String> {
    let limit = get_ai_credit_limit_for_plan(tier);
    dto(
        if exhausted { limit } else { 0.0 },
        limit,
        if exhausted { 0.0 } else { limit },
        exhausted,
        if exhausted {
            "exhausted"
        } else {
            "unavailable"
        },
        now,
    )
}
/// Normalize a v3 cache using the source's partial DTO checks and truthiness.
pub fn cached_payload(parsed: &JsonValue, verified: bool) -> Result<Option<JsonValue>, String> {
    cached_payload_at(parsed, verified, SystemTime::now())
}
pub fn cached_payload_at(
    parsed: &JsonValue,
    verified: bool,
    now: SystemTime,
) -> Result<Option<JsonValue>, String> {
    if parsed.get("version") != Some(&JsonValue::Number(3.0)) {
        return Ok(None);
    }
    let (Some(JsonValue::Number(used)), Some(JsonValue::Number(limit))) =
        (parsed.get("used"), parsed.get("limit"))
    else {
        return Ok(None);
    };
    let raw_balance = parsed.get("balance");
    let balance = match raw_balance {
        Some(JsonValue::Number(n)) => *n,
        _ => {
            let n = limit - used;
            if n.is_nan() { n } else { n.max(0.0) }
        }
    };
    let available = !verified
        || (parsed.get("available") == Some(&JsonValue::Bool(true))
            && parsed.get("status") != Some(&s("unavailable")));
    let status = if !available {
        "unavailable"
    } else if parsed.get("status") == Some(&s("exhausted")) {
        "exhausted"
    } else {
        let exhaustion_value = match raw_balance.filter(|v| **v != JsonValue::Null) {
            Some(value) => js_number(Some(value)).map_err(|e| e.to_string())?,
            None => limit - used,
        };
        if exhaustion_value <= 0.0 {
            "exhausted"
        } else {
            "available"
        }
    };
    let mut result = dto(*used, *limit, balance, available, status, now)?;
    for key in ["meterId", "updatedAt"] {
        if let Some(value) = parsed.get(key).filter(|v| truthy(v)) {
            set(&mut result, key, value.clone());
        }
    }
    Ok(Some(result))
}

/// Lazy shared clients, with the provider signal timeout kept distinct from
/// any overall deadline chosen by the caller.
pub async fn get_ai_credits_default(
    owner: &CreditOwner,
    channel: &str,
    verified: bool,
    provider_timeout: Duration,
) -> Result<JsonValue, String> {
    let signal_deadline = tokio::time::Instant::now() + provider_timeout;
    let reader = AiCreditReader::default(provider_timeout).await?;
    reader
        .get_with_signal_deadline(owner, channel, verified, signal_deadline)
        .await
}
