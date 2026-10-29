//! The bounded local AI-credit projection in billing.ts; no Polar/usage producer.
//! Constructors do no IO/environment work. Clones share the native multiplexed
//! manager. EVAL is sent once: cancellation/timeout/disconnect can leave an
//! unknown mutation outcome and must never cause an application-level replay.
//! Meter properties follow number|string|null|undefined. Snapshots follow the
//! declared AiCreditsData interface, with additional JSON properties preserved.
//! Arbitrary runtime casts/prototypes/undefined extra properties are outside
//! that interface. UTF-16 strings and every binary64 value remain lossless.
use super::{
    credit_policy::JsDate,
    js_string::JsString,
    json_number::{number_string, string_number},
    lossless_json::{JsonValue, parse_json},
    plan_cache_fence::{credits_cache_key, exhaustion_cache_keys},
    tts_usage_pricing::js_round,
};
use redis::aio::ConnectionManager;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const AI_CREDITS_METER_ID: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";
pub const AI_CREDITS_CACHE_TTL_SECONDS: u64 = 300;
pub const AI_CREDITS_CACHE_SCHEMA_VERSION: u32 = 3;
pub const LOCAL_USAGE_TTL_SECONDS: u64 = 31 * 24 * 60 * 60;
pub const RECORD_ERROR_PREFIX: &str = "recordAiCreditUsage: local credit projection failed";

#[derive(Clone, Copy, Debug)]
pub enum PlanTier {
    Free,
    Premium,
    Pro,
    Null,
    Undefined,
}
pub fn get_ai_credit_limit_for_plan(tier: Option<PlanTier>) -> f64 {
    match tier.unwrap_or(PlanTier::Undefined) {
        PlanTier::Premium => 200000.0,
        PlanTier::Pro => 800000.0,
        _ => 25000.0,
    }
}
// Rust f64::max ignores NaN and its tie handling is not the ECMAScript contract.
// Preserve NaN and prefer +0 in a +/-0 tie. Keep source formula/order intact.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        }
    } else if a > b {
        a
    } else {
        b
    }
}
fn finite(value: Option<&JsonValue>, fallback: f64) -> f64 {
    let n = match value {
        None => f64::NAN,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Number(n)) => *n,
        Some(JsonValue::String(s)) => s.as_str().map(string_number).unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if n.is_finite() { n } else { fallback }
}
fn field(name: &str, value: JsonValue) -> (JsString, JsonValue) {
    (name.into(), value)
}
fn number(n: f64) -> JsonValue {
    JsonValue::Number(n)
}
fn string(s: &str) -> JsonValue {
    JsonValue::String(s.into())
}
fn set(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: JsonValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k.as_str() == Some(key)) {
        *old = value;
    } else {
        fields.push(field(key, value));
    }
}
/// Concrete Date path; JsDate supplies UTC ISO formatting and TimeClip.
pub fn iso_at(now: SystemTime) -> Result<JsString, String> {
    let millis = match now.duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as f64,
        Err(value) => -(value.duration().as_millis() as f64),
    };
    JsDate::from_millis(millis)
        .to_iso_string()
        .map(JsString::from)
        .map_err(|e| e.to_string())
}
fn timestamp(at: Option<&JsString>, now: SystemTime) -> Result<JsString, String> {
    at.cloned().map(Ok).unwrap_or_else(|| iso_at(now))
}
/// None for timestamp uses the real system clock, including on a no-op snapshot.
pub fn build_ai_credits_data_from_meter(
    meter: Option<&JsonValue>,
    tier: Option<PlanTier>,
    at: Option<&JsString>,
) -> Result<JsonValue, String> {
    build_ai_credits_data_from_meter_at(meter, tier, at, SystemTime::now())
}
pub fn build_ai_credits_data_from_meter_at(
    meter: Option<&JsonValue>,
    tier: Option<PlanTier>,
    at: Option<&JsString>,
    now: SystemTime,
) -> Result<JsonValue, String> {
    let updated_at = timestamp(at, now)?;
    let get = |key| meter.and_then(|m| m.get(key));
    let polar = finite(get("limit"), 0.0);
    let credited = finite(get("credited_units"), 0.0);
    let consumed = finite(get("consumed_units"), f64::NAN);
    let balance = finite(get("balance"), f64::NAN);
    let used = if consumed.is_finite() && consumed > 0.0 {
        consumed
    } else if credited > 0.0 && balance.is_finite() {
        js_max(0.0, credited - balance)
    } else if balance.is_finite() && balance < 0.0 {
        balance.abs()
    } else if consumed.is_finite() {
        js_max(0.0, consumed)
    } else {
        0.0
    };
    let used = js_max(0.0, js_round(used));
    let remaining_polar = if balance.is_finite() {
        js_max(0.0, js_round(balance))
    } else {
        0.0
    };
    let limit = js_max(
        0.0,
        js_round(js_max(
            js_max(js_max(get_ai_credit_limit_for_plan(tier), polar), credited),
            remaining_polar,
        )),
    );
    let remaining = if balance > 0.0 {
        js_max(limit - used, remaining_polar)
    } else {
        limit - used
    };
    Ok(JsonValue::Object(vec![
        field("version", number(3.0)),
        field("used", number(used)),
        field("limit", number(limit)),
        field("balance", number(remaining)),
        field("meterId", string(AI_CREDITS_METER_ID)),
        field("updatedAt", JsonValue::String(updated_at)),
        field("available", JsonValue::Bool(true)),
        field(
            "status",
            string(if remaining <= 0.0 {
                "exhausted"
            } else {
                "available"
            }),
        ),
    ]))
}
pub fn apply_ai_credit_usage_to_snapshot(
    snapshot: &JsonValue,
    credits: f64,
    at: Option<&JsString>,
) -> Result<JsonValue, String> {
    apply_ai_credit_usage_to_snapshot_at(snapshot, credits, at, SystemTime::now())
}
pub fn apply_ai_credit_usage_to_snapshot_at(
    snapshot: &JsonValue,
    credits: f64,
    at: Option<&JsString>,
    now: SystemTime,
) -> Result<JsonValue, String> {
    let updated_at = timestamp(at, now)?;
    let JsonValue::Object(mut fields) = snapshot.clone() else {
        return Ok(snapshot.clone());
    };
    let consumed = js_max(
        0.0,
        if credits.is_finite() {
            credits.ceil()
        } else {
            0.0
        },
    );
    if snapshot.get("available") != Some(&JsonValue::Bool(true)) || consumed == 0.0 {
        return Ok(JsonValue::Object(fields));
    }
    let used = match snapshot.get("used") {
        Some(JsonValue::Number(n)) => *n,
        _ => f64::NAN,
    };
    let balance = match snapshot.get("balance") {
        Some(JsonValue::Number(n)) => *n,
        _ => f64::NAN,
    } - consumed;
    set(&mut fields, "version", number(3.0));
    set(&mut fields, "used", number(used + consumed));
    set(&mut fields, "balance", number(balance));
    set(&mut fields, "updatedAt", JsonValue::String(updated_at));
    set(
        &mut fields,
        "status",
        string(if balance <= 0.0 {
            "exhausted"
        } else {
            "available"
        }),
    );
    Ok(JsonValue::Object(fields))
}
pub const APPLY_AI_CREDIT_USAGE_SCRIPT: &str = r#"
if ARGV[5] == '1' then
    local marked = redis.call('SET', KEYS[4], '1', 'NX', 'EX', ARGV[4])
    if not marked then return 2 end
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, data = pcall(cjson.decode, raw)
if not ok or tonumber(data.version) ~= tonumber(ARGV[3]) or data.available == false then return 0 end
local consumed = math.max(0, math.ceil(tonumber(ARGV[1]) or 0))
if consumed == 0 then return 0 end
data.used = math.max(0, (tonumber(data.used) or 0) + consumed)
data.balance = (tonumber(data.balance) or 0) - consumed
data.updatedAt = ARGV[2]
data.status = data.balance <= 0 and 'exhausted' or 'available'
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ARGV[4])
if data.balance <= 0 then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
end
return data.balance <= 0 and 1 or 0
"#;
#[derive(Debug, Clone)]
pub struct RecordCommand {
    pub keys: [String; 4],
    pub arguments: [String; 5],
}
fn record_guard(channel: &JsString, credits: f64) -> bool {
    !channel.is_empty() && credits.is_finite() && credits > 0.0
}
/// The guard runs before clock/key/marker work. Node's crypto and Redis encode
/// lone UTF-16 units as replacement UTF-8; the pure builders retain those units.
pub fn record_command_at(
    channel: &JsString,
    credits: f64,
    external_id: Option<&JsString>,
    now: SystemTime,
) -> Result<Option<RecordCommand>, String> {
    if !record_guard(channel, credits) {
        return Ok(None);
    }
    let channel = channel.to_utf8_lossy();
    let [canonical, legacy] = exhaustion_cache_keys(&channel);
    let external = external_id.filter(|s| !s.is_empty());
    let suffix = external
        .map(|id| format!("{:x}", Sha256::digest(id.to_utf8_lossy().as_bytes())))
        .unwrap_or_else(|| "untracked".into());
    Ok(Some(RecordCommand {
        keys: [
            credits_cache_key(&channel),
            canonical,
            legacy,
            format!("twitch:{channel}:ai:usage-local:{suffix}"),
        ],
        arguments: [
            number_string(credits),
            iso_at(now)?.to_utf8_lossy(),
            AI_CREDITS_CACHE_SCHEMA_VERSION.to_string(),
            LOCAL_USAGE_TTL_SECONDS.to_string(),
            if external.is_some() { "1" } else { "0" }.into(),
        ],
    }))
}
/// Console.error's prefix and logical payload. JSON preserves channel UTF-16;
/// console inspector layout and redis-rs diagnostic wording are native boundaries.
/// No additional unknown-outcome annotation is appended to source error payloads.
pub fn record_error_payload(channel: &JsString, error: &str) -> JsonValue {
    record_error_payload_lossless(channel, &error.into())
}
pub fn record_error_payload_lossless(channel: &JsString, error: &JsString) -> JsonValue {
    JsonValue::Object(vec![
        field("channelID", JsonValue::String(channel.clone())),
        field("error", JsonValue::String(error.clone())),
    ])
}
fn log_record_error(channel: &JsString, error: &str) {
    eprintln!(
        "{} {}",
        RECORD_ERROR_PREFIX,
        record_error_payload(channel, error).to_json_string()
    );
}
#[derive(Clone)]
pub struct AiCreditProjection {
    connection: ConnectionManager,
    deadline: Duration,
}
impl AiCreditProjection {
    pub fn new(connection: ConnectionManager, deadline: Duration) -> Self {
        Self {
            connection,
            deadline,
        }
    }
    pub async fn record_ai_credit_usage(
        &self,
        channel: &JsString,
        credits: f64,
        external_id: Option<&JsString>,
    ) {
        if !record_guard(channel, credits) {
            return;
        }
        if let Err(error) = self
            .record_ai_credit_usage_at(channel, credits, external_id, SystemTime::now())
            .await
        {
            log_record_error(channel, &error);
        }
    }
    /// Checked primitive for verification/callers needing diagnostics; the source
    /// public best-effort wrapper above catches/logs errors and discards Lua codes.
    pub async fn record_ai_credit_usage_at(
        &self,
        channel: &JsString,
        credits: f64,
        external_id: Option<&JsString>,
        now: SystemTime,
    ) -> Result<Option<i64>, String> {
        let Some(request) = record_command_at(channel, credits, external_id, now)? else {
            return Ok(None);
        };
        let mut connection = self.connection.clone();
        let mut command = redis::cmd("EVAL");
        command
            .arg(APPLY_AI_CREDIT_USAGE_SCRIPT)
            .arg(4)
            .arg(&request.keys)
            .arg(&request.arguments);
        tokio::time::timeout(self.deadline, command.query_async::<i64>(&mut connection))
            .await
            .map_err(|_| "Redis deadline exceeded".to_string())?
            .map(Some)
            .map_err(|e| e.to_string())
    }
    /// EXISTS/initial GET/existing-flag repair errors escape. Cached JSON parse
    /// and the repair it triggers are caught, exactly at the source try boundary.
    pub async fn is_ai_credits_exhausted(&self, channel: &JsString) -> Result<bool, String> {
        if channel.is_empty() {
            return Ok(false);
        }
        let channel = channel.to_utf8_lossy();
        let [canonical, legacy] = exhaustion_cache_keys(&channel);
        let (a, b) = tokio::try_join!(self.exists(&canonical), self.exists(&legacy))?;
        if a == 1 || b == 1 {
            if a != 1 || b != 1 {
                self.sync_flags(&canonical, &legacy).await?;
            }
            return Ok(true);
        }
        let mut connection = self.connection.clone();
        let cached: Option<String> = tokio::time::timeout(
            self.deadline,
            redis::cmd("GET")
                .arg(credits_cache_key(&channel))
                .query_async(&mut connection),
        )
        .await
        .map_err(|_| "Redis deadline exceeded".to_string())?
        .map_err(|e| e.to_string())?;
        let Some(cached) = cached.filter(|s| !s.is_empty()) else {
            return Ok(false);
        };
        let parsed = match parse_json(&cached) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        let exhausted = parsed.get("status") == Some(&string("exhausted"))
            || (parsed.get("available") == Some(&JsonValue::Bool(true))
                && matches!(parsed.get("balance"), Some(JsonValue::Number(n)) if *n <= 0.0));
        if exhausted && self.sync_flags(&canonical, &legacy).await.is_err() {
            return Ok(false);
        }
        Ok(exhausted)
    }
    async fn exists(&self, key: &str) -> Result<i64, String> {
        let mut connection = self.connection.clone();
        tokio::time::timeout(
            self.deadline,
            redis::cmd("EXISTS").arg(key).query_async(&mut connection),
        )
        .await
        .map_err(|_| "Redis deadline exceeded".to_string())?
        .map_err(|e| e.to_string())
    }
    async fn set_flag(&self, key: &str) -> Result<(), String> {
        let mut connection = self.connection.clone();
        tokio::time::timeout(
            self.deadline,
            redis::cmd("SET")
                .arg(key)
                .arg("true")
                .query_async::<()>(&mut connection),
        )
        .await
        .map_err(|_| "Redis deadline exceeded".to_string())?
        .map_err(|e| e.to_string())
    }
    async fn sync_flags(&self, canonical: &str, legacy: &str) -> Result<(), String> {
        tokio::try_join!(self.set_flag(canonical), self.set_flag(legacy))?;
        Ok(())
    }
}
/// The separate native bootstrap retains its five-second initialization bound.
pub async fn record_ai_credit_usage_default(
    channel: &JsString,
    credits: f64,
    external_id: Option<&JsString>,
    deadline: Duration,
) {
    if !record_guard(channel, credits) {
        return;
    }
    match super::redis::get_redis_client().await {
        Ok(connection) => {
            AiCreditProjection::new(connection, deadline)
                .record_ai_credit_usage(channel, credits, external_id)
                .await
        }
        Err(error) => log_record_error(channel, &error.to_string()),
    }
}
pub async fn is_ai_credits_exhausted_default(
    channel: &JsString,
    deadline: Duration,
) -> Result<bool, String> {
    if channel.is_empty() {
        return Ok(false);
    }
    let connection = super::redis::get_redis_client()
        .await
        .map_err(|e| e.to_string())?;
    AiCreditProjection::new(connection, deadline)
        .is_ai_credits_exhausted(channel)
        .await
}
