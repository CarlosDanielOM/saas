//! Request-time window, billing period, pacing, summary, and in-memory
//! pagination from `dimabot/src/utils/ai_usage_receipts.ts`.
//!
//! Preserves the source thresholds, clamps, `endExclusive` periods, pacing
//! arithmetic, category `localeCompare` order, and cursor text. Dates use
//! [`JsDate`](crate::utils::credit_policy::JsDate). Zone labels use the host
//! TZif data plus the POSIX footer after the last transition, with the same
//! three-step zoned-midnight iteration as `Intl`.
//!
//! `fetch_ai_usage_transactions` is the request-time Polar read. It takes an
//! injected event lister and an injected credit-source classifier. It does not
//! call `getPolarShClient` or `polarCreditSourceReads`. Cached receipt reads
//! and Redis stay out of this module. `AiUsageWindow` and `AiUsageTransaction`
//! stay in `ai_usage_ledger_queries`.

use std::{
    collections::HashMap,
    fs,
    future::Future,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use icu_collator::{Collator, CollatorBorrowed};
use mongodb::bson::{Bson, DateTime, Document, doc};

use super::{
    ai_credit_projection::AI_CREDITS_METER_ID,
    ai_usage::{classify_adjustment, normalize_receipt_category},
    ai_usage_ledger_queries::{
        AiUsagePacingHistory, AiUsageTransaction, AiUsageWindow, decode_ledger_transaction,
    },
    ai_usage_ledger_reads::{AiUsageLedgerReadError, LedgerField},
    bson_compat::js_number,
    credit_policy::JsDate,
    js_compat::trim as js_trim,
    js_string::JsString,
    json_number::number_string,
    lossless_json::JsonValue,
    tts_usage_pricing::js_round,
};

pub const AI_USAGE_ITEMIZATION_STARTED_AT: &str = "2026-09-18T19:30:00.000Z";
pub const AI_USAGE_MAX_RANGE_DAYS: f64 = 90.0;
pub const AI_USAGE_DEFAULT_RANGE_DAYS: f64 = 30.0;
pub const AI_USAGE_DEFAULT_MAX_RANGE_DAYS: f64 = 31.0;
pub const AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS: f64 = 32.0;
pub const AI_USAGE_PAGE_SIZE: i64 = 100;
pub const AI_USAGE_MAX_POLAR_PAGES: i64 = 100;
/// Polar receipt cache TTL. The dashboard freshness window is 60 seconds and
/// does not read this constant.
pub const AI_USAGE_CACHE_TTL_SECONDS: i64 = 120;
pub const MINIMUM_PACING_HISTORY_DAYS: f64 = 7.0;
pub const MILLISECONDS_PER_DAY: f64 = 86_400_000.0;

const RECEIPT_CATEGORIES: [&str; 7] = [
    "tts",
    "ai_chat",
    "ai_agent",
    "memory",
    "clip_recommendation",
    "credit_adjustment",
    "other",
];
const ZONEINFO_ROOT: &str = "/usr/share/zoneinfo";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiUsageReceiptError {
    Validation(String),
    Limit(String),
    /// ICU could not build the root collator. There is no codepoint fallback.
    Collation,
}

impl AiUsageReceiptError {
    pub fn message(&self) -> &str {
        match self {
            Self::Validation(message) | Self::Limit(message) => message,
            Self::Collation => "Cannot initialize AI usage collation",
        }
    }

    pub fn is_limit(&self) -> bool {
        matches!(self, Self::Limit(_))
    }
}

impl std::fmt::Display for AiUsageReceiptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for AiUsageReceiptError {}

fn invalid_time() -> AiUsageReceiptError {
    AiUsageReceiptError::Validation("Invalid time value".to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiUsagePeriodSource {
    Subscription,
    FreeMonthly,
    Rolling30Day,
    Custom,
}

impl AiUsagePeriodSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subscription => "subscription",
            Self::FreeMonthly => "free_monthly",
            Self::Rolling30Day => "rolling_30_day",
            Self::Custom => "custom",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsageBillingPeriod {
    pub source: AiUsagePeriodSource,
    pub starts_at: String,
    pub ends_at: String,
    pub end_exclusive: bool,
    pub from: String,
    pub to: String,
    pub total_day_count: usize,
    pub elapsed_day_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsagePeriodResolution {
    pub window: AiUsageWindow,
    pub billing_period: AiUsageBillingPeriod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PacingStatus {
    NoUsage,
    WithinPace,
    OverPace,
    Exhausted,
}

impl PacingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoUsage => "no_usage",
            Self::WithinPace => "within_pace",
            Self::OverPace => "over_pace",
            Self::Exhausted => "exhausted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForecastBasis {
    CurrentBillingPeriod,
    CurrentFreeCreditPeriod,
}

impl ForecastBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CurrentBillingPeriod => "current_billing_period",
            Self::CurrentFreeCreditPeriod => "current_free_credit_period",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForecastRateBasis {
    CurrentCycle,
    RetentionHistory,
}

impl ForecastRateBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CurrentCycle => "current_cycle",
            Self::RetentionHistory => "retention_history",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PacingConfidence {
    Low,
    Medium,
    High,
}

impl PacingConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsagePacing {
    pub status: PacingStatus,
    pub forecast_basis: ForecastBasis,
    pub forecast_rate_basis: ForecastRateBasis,
    pub confidence: PacingConfidence,
    pub confidence_reasons: Vec<String>,
    pub recent_average_daily_credits: Option<f64>,
    pub recent_history_days: f64,
    pub quota_used_percent: f64,
    pub average_daily_credits: f64,
    pub current_cycle_average_daily_credits: f64,
    pub historical_average_daily_credits: Option<f64>,
    pub forecast_history_days: f64,
    pub projected_period_credits: f64,
    pub projected_quota_used_percent: f64,
    pub projected_overage_credits: f64,
    pub remaining_period_days: f64,
    pub daily_credits_to_last_period: f64,
    pub expected_to_exhaust_within_period: bool,
    pub estimated_days_until_exhaustion: Option<f64>,
    pub estimated_exhaustion_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageSummaryDay {
    pub date: String,
    pub credits: f64,
    pub transaction_count: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageSummaryCategory {
    pub category: String,
    pub credits: f64,
    pub transaction_count: f64,
    pub percentage: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageSummary {
    pub schema_version: i64,
    pub itemization_started_at: String,
    pub period_from: String,
    pub period_to: String,
    pub period_time_zone: String,
    pub day_count: usize,
    pub total_spent_credits: f64,
    pub average_daily_spent_credits: f64,
    pub granted_credits: f64,
    pub net_consumed_credits: f64,
    pub transaction_count: f64,
    pub daily: Vec<AiUsageSummaryDay>,
    pub categories: Vec<AiUsageSummaryCategory>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsagePage {
    pub items: Vec<AiUsageTransaction>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct AiUsageWindowInput {
    pub from: Option<JsString>,
    pub to: Option<JsString>,
    pub time_zone: Option<JsString>,
    pub now: Option<JsDate>,
    pub max_days: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct AiUsagePeriodInput {
    pub customer_id: Option<JsString>,
    pub free_period_anchor: Option<JsDate>,
    pub from: Option<JsString>,
    pub to: Option<JsString>,
    pub time_zone: Option<JsString>,
    pub now: Option<JsDate>,
    pub max_days: Option<f64>,
}

/// `undefined` is a current subscription. JSON `null` is not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Undefined,
    Null,
    Text(JsString),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolarSubscriptionPeriod {
    pub status: SubscriptionStatus,
    pub current_period_start: Option<JsDate>,
    pub current_period_end: Option<JsDate>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolarCustomerState {
    pub active_subscriptions: Vec<PolarSubscriptionPeriod>,
}

#[derive(Debug)]
pub enum AiUsagePeriodError<E> {
    Receipt(AiUsageReceiptError),
    CustomerState(E),
    CustomerStateRequired,
}

impl<E: std::fmt::Display> std::fmt::Display for AiUsagePeriodError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Receipt(error) => write!(formatter, "{error}"),
            Self::CustomerState(error) => write!(formatter, "{error}"),
            Self::CustomerStateRequired => formatter.write_str(
                "AI usage period requires an injected Polar customer state reader",
            ),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for AiUsagePeriodError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Receipt(error) => Some(error),
            Self::CustomerState(error) => Some(error),
            Self::CustomerStateRequired => None,
        }
    }
}

pub(crate) fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() && right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if left > right { left } else { right }
}

pub(crate) fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if left < right { left } else { right }
}

pub(crate) fn js_ceil(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let truncated = value.trunc();
    if value == truncated {
        value
    } else if value > 0.0 {
        truncated + 1.0
    } else {
        truncated
    }
}

pub(crate) fn js_floor(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let truncated = value.trunc();
    if value == truncated {
        value
    } else if value > 0.0 {
        truncated
    } else {
        truncated - 1.0
    }
}

pub(crate) fn round_places(value: f64, places: i32) -> f64 {
    let multiplier = 10_f64.powi(places);
    js_round(value * multiplier) / multiplier
}

struct Civil {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
}

fn civil_from_millis(millis: i64) -> Civil {
    let days = millis.div_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let within = millis.rem_euclid(86_400_000);
    Civil {
        year,
        month,
        day,
        hour: within / 3_600_000,
        minute: (within / 60_000) % 60,
        second: (within / 1000) % 60,
        millis: within % 1000,
    }
}

fn days_from_civil(mut year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) {
        return None;
    }
    year = year.checked_sub(i64::from(month <= 2))?;
    let era = if year >= 0 {
        year / 400
    } else {
        year.checked_sub(399)? / 400
    };
    let yoe = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = yoe * 365 + yoe / 4 - yoe / 100 + day_of_year;
    let days = era as i128 * 146_097 + day_of_era as i128 - 719_468;
    i64::try_from(days).ok()
}

fn make_date_millis(
    year: i64,
    month_index: i64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
    millis: f64,
) -> Option<f64> {
    if ![day, hour, minute, second, millis].into_iter().all(f64::is_finite) {
        return None;
    }
    let ym = year.checked_add(month_index.div_euclid(12))?;
    let month = month_index.rem_euclid(12) + 1;
    let base = days_from_civil(ym, month, 1)?;
    let time = hour * 3_600_000.0 + minute * 60_000.0 + second * 1_000.0 + millis;
    Some((base as f64 + day - 1.0) * MILLISECONDS_PER_DAY + time)
}

fn finite_i64(value: f64) -> Option<i64> {
    if value.is_finite() && value.abs() <= i64::MAX as f64 {
        Some(value.trunc() as i64)
    } else {
        None
    }
}

fn format_civil_date(civil: &Civil) -> String {
    let year = if (0..=9999).contains(&civil.year) {
        format!("{:04}", civil.year)
    } else {
        format!("{:+07}", civil.year)
    };
    format!("{year}-{:02}-{:02}", civil.month, civil.day)
}

fn iso_day_prefix(millis: i64) -> Result<String, AiUsageReceiptError> {
    let iso = JsDate::from_millis(millis as f64)
        .to_iso_string()
        .map_err(|_| invalid_time())?;
    iso.get(..10)
        .map(str::to_string)
        .ok_or_else(invalid_time)
}

#[derive(Clone, Debug)]
struct PosixRule {
    kind: PosixRuleKind,
    time_ms: i64,
}

#[derive(Clone, Debug)]
enum PosixRuleKind {
    MonthWeekDay { month: i64, week: i64, day: i64 },
    Julian { day: i64, leap: bool },
}

#[derive(Clone, Debug)]
struct PosixZone {
    std_east_seconds: i32,
    dst_east_seconds: Option<i32>,
    start: Option<PosixRule>,
    end: Option<PosixRule>,
}

#[derive(Clone, Debug)]
struct ZoneInfo {
    transitions: Vec<(i64, i32)>,
    initial_offset: i32,
    posix: Option<PosixZone>,
}

fn zone_cache() -> &'static Mutex<HashMap<String, Arc<ZoneInfo>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<ZoneInfo>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn utc_zone() -> Arc<ZoneInfo> {
    static UTC: OnceLock<Arc<ZoneInfo>> = OnceLock::new();
    UTC.get_or_init(|| {
        Arc::new(ZoneInfo {
            transitions: Vec::new(),
            initial_offset: 0,
            posix: None,
        })
    })
    .clone()
}

fn is_safe_zone_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.ends_with('/') {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-'))
    })
}

fn load_zone(name: &str) -> Result<Arc<ZoneInfo>, AiUsageReceiptError> {
    if matches!(name, "UTC" | "Etc/UTC" | "Etc/GMT" | "GMT") {
        return Ok(utc_zone());
    }
    if !is_safe_zone_name(name) {
        return Err(AiUsageReceiptError::Validation("Invalid timezone".to_string()));
    }
    let cache = zone_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(zone) = cache.get(name) {
        return Ok(Arc::clone(zone));
    }
    drop(cache);
    let path = Path::new(ZONEINFO_ROOT).join(name);
    let bytes = fs::read(&path)
        .map_err(|_| AiUsageReceiptError::Validation("Invalid timezone".to_string()))?;
    let zone = Arc::new(
        parse_tzif(&bytes)
            .ok_or_else(|| AiUsageReceiptError::Validation("Invalid timezone".to_string()))?,
    );
    let mut cache = zone_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(Arc::clone(cache.entry(name.to_string()).or_insert(zone)))
}

fn take<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = offset.checked_add(len)?;
    let slice = data.get(*offset..end)?;
    *offset = end;
    Some(slice)
}

fn parse_tzif(data: &[u8]) -> Option<ZoneInfo> {
    if data.len() < 44 || &data[..4] != b"TZif" {
        return None;
    }
    let version = data[4];
    let mut offset = 0usize;
    let first = read_header(data, &mut offset)?;
    if version == 0 {
        let (transitions, initial_offset) = read_transitions(data, &mut offset, first, 4)?;
        return Some(ZoneInfo {
            transitions,
            initial_offset,
            posix: None,
        });
    }
    skip_body(data, &mut offset, first, 4)?;
    let header = read_header(data, &mut offset)?;
    let body_start = offset;
    skip_body(data, &mut offset, header, 8)?;
    let posix = read_posix_footer(data, &mut offset).and_then(|text| parse_posix(&text));
    offset = body_start;
    let (transitions, initial_offset) = read_transitions(data, &mut offset, header, 8)?;
    Some(ZoneInfo {
        transitions,
        initial_offset,
        posix,
    })
}

fn read_header(data: &[u8], offset: &mut usize) -> Option<[u32; 6]> {
    take(data, offset, 20)?;
    let mut counts = [0; 6];
    for slot in &mut counts {
        let bytes = take(data, offset, 4)?;
        *slot = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    Some(counts)
}

fn skip_body(data: &[u8], offset: &mut usize, header: [u32; 6], time_size: usize) -> Option<()> {
    let [ut, std_wall, leap, times, types, chars] = header;
    let leap_size = time_size.checked_add(4)?;
    let len = (times as usize)
        .checked_mul(time_size)?
        .checked_add(times as usize)?
        .checked_add((types as usize).checked_mul(6)?)?
        .checked_add(chars as usize)?
        .checked_add((leap as usize).checked_mul(leap_size)?)?
        .checked_add(std_wall as usize)?
        .checked_add(ut as usize)?;
    take(data, offset, len).map(|_| ())
}

fn read_posix_footer(data: &[u8], offset: &mut usize) -> Option<String> {
    let start = take(data, offset, 1)?;
    if start != b"\n" {
        return None;
    }
    let rest = data.get(*offset..)?;
    let end = rest.iter().position(|byte| *byte == b'\n')?;
    let text = std::str::from_utf8(rest.get(..end)?).ok()?.to_string();
    *offset += end + 1;
    Some(text)
}

fn read_transitions(
    data: &[u8],
    offset: &mut usize,
    header: [u32; 6],
    time_size: usize,
) -> Option<(Vec<(i64, i32)>, i32)> {
    let [_ut, _std, _leap, times, types, chars] = header;
    let time_count = times as usize;
    let type_count = types as usize;
    if type_count == 0 {
        return None;
    }
    let mut transitions = Vec::with_capacity(time_count);
    let mut stamps = Vec::with_capacity(time_count);
    for _ in 0..time_count {
        let bytes = take(data, offset, time_size)?;
        let stamp = if time_size == 8 {
            i64::from_be_bytes(bytes.try_into().ok()?)
        } else {
            i32::from_be_bytes(bytes.try_into().ok()?) as i64
        };
        stamps.push(stamp);
    }
    let indexes = take(data, offset, time_count)?.to_vec();
    let mut infos = Vec::with_capacity(type_count);
    for _ in 0..type_count {
        let raw = take(data, offset, 6)?;
        let east = i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
        let is_dst = raw[4] != 0;
        infos.push((east, is_dst));
    }
    take(data, offset, chars as usize)?;
    for (stamp, index) in stamps.into_iter().zip(indexes) {
        let info = infos.get(index as usize)?;
        transitions.push((stamp, info.0));
    }
    let initial = infos
        .iter()
        .find(|(_, is_dst)| !*is_dst)
        .or_else(|| infos.first())?
        .0;
    Some((transitions, initial))
}

struct PosixCursor<'a> {
    text: &'a str,
    index: usize,
}

impl<'a> PosixCursor<'a> {
    fn rest(&self) -> &'a str {
        &self.text[self.index..]
    }
    fn eat(&mut self, expected: char) -> Option<()> {
        let mut chars = self.rest().chars();
        if chars.next() == Some(expected) {
            self.index += expected.len_utf8();
            Some(())
        } else {
            None
        }
    }
    fn parse_name(&mut self) -> Option<&'a str> {
        let rest = self.rest();
        if rest.starts_with('<') {
            let end = rest.find('>')?;
            let name = &rest[1..end];
            self.index += end + 1;
            return Some(name);
        }
        let len = rest.bytes().take_while(|byte| byte.is_ascii_alphabetic()).count();
        if len == 0 {
            return None;
        }
        let name = &rest[..len];
        self.index += len;
        Some(name)
    }
    fn parse_int(&mut self) -> Option<i64> {
        let rest = self.rest();
        let len = rest.bytes().take_while(|byte| byte.is_ascii_digit()).count();
        if len == 0 {
            return None;
        }
        let value = rest[..len].parse().ok()?;
        self.index += len;
        Some(value)
    }
    fn parse_offset(&mut self) -> Option<i32> {
        let mut west = true;
        if self.rest().starts_with('+') {
            self.index += 1;
        } else if self.rest().starts_with('-') {
            west = false;
            self.index += 1;
        }
        let hours = self.parse_int()?;
        let mut minutes = 0;
        let mut seconds = 0;
        if self.rest().starts_with(':') {
            self.index += 1;
            minutes = self.parse_int()?;
            if self.rest().starts_with(':') {
                self.index += 1;
                seconds = self.parse_int()?;
            }
        }
        let magnitude = hours * 3600 + minutes * 60 + seconds;
        let east = if west { -magnitude } else { magnitude };
        i32::try_from(east).ok()
    }
    fn parse_clock(&mut self) -> Option<i64> {
        let mut sign = 1i64;
        if self.rest().starts_with('+') {
            self.index += 1;
        } else if self.rest().starts_with('-') {
            sign = -1;
            self.index += 1;
        }
        let hours = self.parse_int()?;
        let mut minutes = 0;
        let mut seconds = 0;
        if self.rest().starts_with(':') {
            self.index += 1;
            minutes = self.parse_int()?;
            if self.rest().starts_with(':') {
                self.index += 1;
                seconds = self.parse_int()?;
            }
        }
        Some(sign * (hours * 3_600_000 + minutes * 60_000 + seconds * 1_000))
    }
    fn parse_rule(&mut self) -> Option<PosixRule> {
        let kind = if self.rest().starts_with('M') {
            self.index += 1;
            let month = self.parse_int()?;
            self.eat('.')?;
            let week = self.parse_int()?;
            self.eat('.')?;
            let day = self.parse_int()?;
            PosixRuleKind::MonthWeekDay { month, week, day }
        } else if self.rest().starts_with('J') {
            self.index += 1;
            PosixRuleKind::Julian { day: self.parse_int()?, leap: false }
        } else {
            PosixRuleKind::Julian { day: self.parse_int()?, leap: true }
        };
        let time_ms = if self.rest().starts_with('/') {
            self.index += 1;
            self.parse_clock()?
        } else {
            7_200_000
        };
        Some(PosixRule { kind, time_ms })
    }
}

fn parse_posix(text: &str) -> Option<PosixZone> {
    let mut cursor = PosixCursor { text, index: 0 };
    cursor.parse_name()?;
    let std_east_seconds = cursor.parse_offset()?;
    if cursor.rest().is_empty() {
        return Some(PosixZone {
            std_east_seconds,
            dst_east_seconds: None,
            start: None,
            end: None,
        });
    }
    cursor.parse_name()?;
    let dst_east_seconds = if cursor
        .rest()
        .starts_with(['+', '-'])
        || cursor.rest().starts_with(|ch: char| ch.is_ascii_digit())
    {
        cursor.parse_offset()?
    } else {
        std_east_seconds.checked_add(3600)?
    };
    if cursor.rest().is_empty() {
        // A DST abbreviation without a rule stays on standard time.
        return Some(PosixZone {
            std_east_seconds,
            dst_east_seconds: None,
            start: None,
            end: None,
        });
    }
    cursor.eat(',')?;
    let start = cursor.parse_rule()?;
    cursor.eat(',')?;
    let end = cursor.parse_rule()?;
    if !cursor.rest().is_empty() {
        return None;
    }
    Some(PosixZone {
        std_east_seconds,
        dst_east_seconds: Some(dst_east_seconds),
        start: Some(start),
        end: Some(end),
    })
}

fn nth_weekday_epoch_day(year: i64, month: i64, week: i64, weekday: i64) -> Option<i64> {
    let first = days_from_civil(year, month, 1)?;
    let next = if month == 12 {
        days_from_civil(year + 1, 1, 1)?
    } else {
        days_from_civil(year, month + 1, 1)?
    };
    let length = next - first;
    let first_dow = (first + 4).rem_euclid(7);
    let delta = (weekday - first_dow).rem_euclid(7);
    let mut day = 1 + delta + (week - 1) * 7;
    if day > length {
        day -= 7;
    }
    Some(first + day - 1)
}

fn julian_epoch_day(year: i64, day: i64, leap: bool) -> Option<i64> {
    let start = days_from_civil(year, 1, 1)?;
    let leap_day = is_leap(year);
    let offset = if !leap && leap_day && day >= 60 {
        day
    } else {
        day - i64::from(!leap)
    };
    Some(start + offset)
}

fn is_leap(year: i64) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}

fn rule_epoch_day(year: i64, rule: &PosixRule) -> Option<i64> {
    match rule.kind {
        PosixRuleKind::MonthWeekDay { month, week, day } => {
            nth_weekday_epoch_day(year, month, week, day)
        }
        PosixRuleKind::Julian { day, leap } => julian_epoch_day(year, day, leap),
    }
}

fn rule_utc_ms(year: i64, rule: &PosixRule, offset_east_seconds: i32) -> Option<i128> {
    let day = rule_epoch_day(year, rule)?;
    Some(
        day as i128 * 86_400_000 + rule.time_ms as i128
            - offset_east_seconds as i128 * 1000,
    )
}

fn posix_offset_seconds(posix: &PosixZone, utc_ms: i64) -> Option<i32> {
    let (Some(dst), Some(start), Some(end)) = (
        posix.dst_east_seconds,
        posix.start.as_ref(),
        posix.end.as_ref(),
    ) else {
        return Some(posix.std_east_seconds);
    };
    let year = civil_from_millis(utc_ms).year;
    let mut transitions = Vec::with_capacity(6);
    for candidate in year - 1..=year + 1 {
        let start_at = rule_utc_ms(candidate, start, posix.std_east_seconds)?;
        let end_at = rule_utc_ms(candidate, end, dst)?;
        transitions.push((start_at, dst, posix.std_east_seconds));
        transitions.push((end_at, posix.std_east_seconds, dst));
    }
    transitions.sort_by_key(|transition| transition.0);
    let instant = utc_ms as i128;
    let mut offset = transitions.first()?.2;
    for (at, after, _) in transitions {
        if at <= instant {
            offset = after;
        } else {
            break;
        }
    }
    Some(offset)
}

fn zone_offset_east_ms(zone: &ZoneInfo, utc_ms: i64) -> i64 {
    let instant = utc_ms as i128;
    let mut offset = zone.initial_offset;
    let mut last = None;
    for (index, (stamp, east)) in zone.transitions.iter().enumerate() {
        if (*stamp as i128) * 1000 <= instant {
            offset = *east;
            last = Some(index);
        } else {
            break;
        }
    }
    if let Some(index) = last {
        if index + 1 == zone.transitions.len()
            && (zone.transitions[index].0 as i128) * 1000 < instant
            && let Some(posix) = &zone.posix
            && let Some(east) = posix_offset_seconds(posix, utc_ms)
        {
            return i64::from(east) * 1000;
        }
        return i64::from(offset) * 1000;
    }
    if zone.transitions.is_empty()
        && let Some(posix) = &zone.posix
        && let Some(east) = posix_offset_seconds(posix, utc_ms)
    {
        return i64::from(east) * 1000;
    }
    i64::from(zone.initial_offset) * 1000
}

fn format_local_date(utc_ms: i64, time_zone: &str) -> Result<String, AiUsageReceiptError> {
    let zone = load_zone(time_zone)?;
    let offset = zone_offset_east_ms(&zone, utc_ms);
    let local = i64::try_from(utc_ms as i128 + offset as i128).map_err(|_| invalid_time())?;
    Ok(format_civil_date(&civil_from_millis(local)))
}

fn resolve_time_zone(value: Option<&JsString>) -> Result<String, AiUsageReceiptError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok("UTC".to_string());
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok("UTC".to_string());
    }
    let Some(name) = trimmed.as_str() else {
        return Err(AiUsageReceiptError::Validation("Invalid timezone".to_string()));
    };
    load_zone(name)?;
    Ok(name.to_string())
}

fn parse_date_label(value: &str, field: &str) -> Result<(i64, i64, i64), AiUsageReceiptError> {
    let bytes = value.as_bytes();
    let digits = |slice: &[u8]| slice.iter().all(|byte| byte.is_ascii_digit());
    if bytes.len() != 10
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !digits(&bytes[..4])
        || !digits(&bytes[5..7])
        || !digits(&bytes[8..10])
    {
        return Err(AiUsageReceiptError::Validation(format!(
            "{field} must use YYYY-MM-DD"
        )));
    }
    let number = |slice: &str| {
        slice
            .bytes()
            .fold(0i64, |total, byte| total * 10 + i64::from(byte - b'0'))
    };
    let year = number(&value[..4]);
    let month = number(&value[5..7]);
    let day = number(&value[8..10]);
    let millis = make_date_millis(year, month - 1, day as f64, 0.0, 0.0, 0.0, 0.0)
        .ok_or_else(|| AiUsageReceiptError::Validation(format!("{field} is not a valid date")))?;
    let Some(millis) = finite_i64(millis) else {
        return Err(AiUsageReceiptError::Validation(format!(
            "{field} is not a valid date"
        )));
    };
    let civil = civil_from_millis(millis);
    if civil.year != year || civil.month != month || civil.day != day {
        return Err(AiUsageReceiptError::Validation(format!(
            "{field} is not a valid date"
        )));
    }
    Ok((year, month, day))
}

fn shift_date_label(value: &str, days: f64) -> Result<String, AiUsageReceiptError> {
    let (year, month, day) = parse_date_label(value, "date")?;
    let millis = make_date_millis(year, month - 1, day as f64 + days, 0.0, 0.0, 0.0, 0.0)
        .ok_or_else(invalid_time)?;
    let millis = finite_i64(millis).ok_or_else(invalid_time)?;
    iso_day_prefix(millis)
}

fn limit_message(max_days: f64, plan_limit: bool) -> AiUsageReceiptError {
    let days = number_string(max_days);
    if plan_limit {
        AiUsageReceiptError::Limit(format!(
            "Usage history for this plan is limited to {days} days"
        ))
    } else {
        AiUsageReceiptError::Limit(format!("Date range cannot exceed {days} days"))
    }
}

fn build_date_labels(from: &str, to: &str, max_days: f64) -> Result<Vec<String>, AiUsageReceiptError> {
    let mut dates = Vec::new();
    let mut current = from.to_string();
    while current.as_str() <= to {
        dates.push(current.clone());
        if dates.len() as f64 > max_days {
            return Err(limit_message(max_days, false));
        }
        current = shift_date_label(&current, 1.0)?;
    }
    Ok(dates)
}

fn zoned_start_of_day(label: &str, time_zone: &str) -> Result<JsDate, AiUsageReceiptError> {
    let (year, month, day) = parse_date_label(label, "date")?;
    let wall = finite_i64(
        make_date_millis(year, month - 1, day as f64, 0.0, 0.0, 0.0, 0.0).ok_or_else(invalid_time)?,
    )
    .ok_or_else(invalid_time)?;
    let zone = load_zone(time_zone)?;
    let mut guess = wall;
    for _ in 0..3 {
        let offset = zone_offset_east_ms(&zone, guess);
        let local = i64::try_from(guess as i128 + offset as i128).map_err(|_| invalid_time())?;
        let civil = civil_from_millis(local);
        let represented = finite_i64(
            make_date_millis(
                civil.year,
                civil.month - 1,
                civil.day as f64,
                civil.hour as f64,
                civil.minute as f64,
                civil.second as f64,
                0.0,
            )
            .ok_or_else(invalid_time)?,
        )
        .ok_or_else(invalid_time)?;
        let next = i64::try_from(wall as i128 - (represented as i128 - guess as i128))
            .map_err(|_| invalid_time())?;
        if next == guess {
            break;
        }
        guess = next;
    }
    let date = JsDate::from_millis(guess as f64);
    if date.timestamp_millis().is_none() {
        return Err(invalid_time());
    }
    Ok(date)
}

fn present(value: &Option<JsString>) -> bool {
    value.as_ref().is_some_and(|value| !value.is_empty())
}

fn effective_max_days(max_days: Option<f64>) -> f64 {
    let raw = match max_days {
        Some(value) if value != 0.0 && !value.is_nan() => value,
        _ => AI_USAGE_DEFAULT_MAX_RANGE_DAYS,
    };
    js_max(1.0, js_min(AI_USAGE_MAX_RANGE_DAYS, raw))
}

fn require_now(now: Option<JsDate>) -> JsDate {
    now.unwrap_or_else(super::ai_usage_ledger_queries::current_js_date)
}

pub fn resolve_ai_usage_window(
    input: &AiUsageWindowInput,
) -> Result<AiUsageWindow, AiUsageReceiptError> {
    let time_zone = resolve_time_zone(input.time_zone.as_ref())?;
    let now = require_now(input.now);
    let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
    let today = format_local_date(now_ms, &time_zone)?;
    let max_days = effective_max_days(input.max_days);
    if present(&input.from) != present(&input.to) {
        return Err(AiUsageReceiptError::Validation(
            "from and to must be provided together".to_string(),
        ));
    }
    let to = if let Some(value) = input.to.as_ref().filter(|value| !value.is_empty()) {
        value
            .as_str()
            .ok_or_else(|| AiUsageReceiptError::Validation("to must use YYYY-MM-DD".to_string()))?
            .to_string()
    } else {
        today
    };
    let from = if let Some(from) = input.from.as_ref().filter(|value| !value.is_empty()) {
        from.as_str()
            .ok_or_else(|| AiUsageReceiptError::Validation("from must use YYYY-MM-DD".to_string()))?
            .to_string()
    } else {
        shift_date_label(&to, -(AI_USAGE_DEFAULT_RANGE_DAYS - 1.0))?
    };
    parse_date_label(&from, "from")?;
    parse_date_label(&to, "to")?;
    if from > to {
        return Err(AiUsageReceiptError::Validation(
            "from must be on or before to".to_string(),
        ));
    }
    if to > today {
        return Err(AiUsageReceiptError::Validation(
            "to cannot be in the future".to_string(),
        ));
    }
    let earliest = shift_date_label(&today, -(max_days - 1.0))?;
    if from < earliest {
        return Err(limit_message(max_days, true));
    }
    let days = build_date_labels(&from, &to, max_days)?;
    let end_label = shift_date_label(&to, 1.0)?;
    Ok(AiUsageWindow {
        from: JsString::from(from.as_str()),
        to: JsString::from(to.as_str()),
        time_zone: JsString::from(time_zone.as_str()),
        start_timestamp: zoned_start_of_day(&from, &time_zone)?,
        end_timestamp_exclusive: zoned_start_of_day(&end_label, &time_zone)?,
        days: days.into_iter().map(|day| JsString::from(day.as_str())).collect(),
    })
}

fn add_utc_calendar_months(anchor_ms: i64, months: i64) -> Option<JsDate> {
    let civil = civil_from_millis(anchor_ms);
    let target = civil.month - 1 + months;
    let last = finite_i64(make_date_millis(
        civil.year,
        target + 1,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    )?)?;
    let last_day = civil_from_millis(last).day;
    let day = civil.day.min(last_day);
    let millis = finite_i64(make_date_millis(
        civil.year,
        target,
        day as f64,
        civil.hour as f64,
        civil.minute as f64,
        civil.second as f64,
        civil.millis as f64,
    )?)?;
    let date = JsDate::from_millis(millis as f64);
    date.timestamp_millis().map(|_| date)
}

pub fn resolve_free_credit_period(anchor: JsDate, now: JsDate) -> Option<(JsDate, JsDate)> {
    let anchor_ms = anchor.timestamp_millis()?;
    let now_ms = now.timestamp_millis()?;
    if anchor_ms > now_ms {
        return None;
    }
    let anchor_civil = civil_from_millis(anchor_ms);
    let now_civil = civil_from_millis(now_ms);
    let mut month_offset =
        (now_civil.year - anchor_civil.year) * 12 + (now_civil.month - anchor_civil.month);
    let mut start = add_utc_calendar_months(anchor_ms, month_offset)?;
    if start.timestamp_millis()? > now_ms {
        month_offset -= 1;
        start = add_utc_calendar_months(anchor_ms, month_offset)?;
    }
    let end = add_utc_calendar_months(anchor_ms, month_offset + 1)?;
    Some((start, end))
}

fn billing_period_from_window(
    window: &AiUsageWindow,
    source: AiUsagePeriodSource,
) -> Result<AiUsageBillingPeriod, AiUsageReceiptError> {
    Ok(AiUsageBillingPeriod {
        source,
        starts_at: window
            .start_timestamp
            .to_iso_string()
            .map_err(|_| invalid_time())?,
        ends_at: window
            .end_timestamp_exclusive
            .to_iso_string()
            .map_err(|_| invalid_time())?,
        end_exclusive: true,
        from: window.from.as_str().unwrap_or("").to_string(),
        to: window.to.as_str().unwrap_or("").to_string(),
        total_day_count: window.days.len(),
        elapsed_day_count: window.days.len(),
    })
}

fn usage_period_from_boundaries(
    source: AiUsagePeriodSource,
    start: JsDate,
    end: JsDate,
    now: JsDate,
    time_zone: &str,
) -> Result<AiUsagePeriodResolution, AiUsageReceiptError> {
    let start_ms = start.timestamp_millis().ok_or_else(invalid_time)?;
    let end_ms = end.timestamp_millis().ok_or_else(invalid_time)?;
    let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
    let from = format_local_date(start_ms, time_zone)?;
    let period_to = format_local_date(end_ms - 1, time_zone)?;
    let elapsed_instant = js_max(
        start_ms as f64,
        js_min(now_ms as f64, end_ms as f64) - 1.0,
    );
    let elapsed_ms = finite_i64(elapsed_instant).ok_or_else(invalid_time)?;
    let elapsed_to = format_local_date(elapsed_ms, time_zone)?;
    let days = build_date_labels(&from, &elapsed_to, AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS)?;
    let total = build_date_labels(&from, &period_to, AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS)?;
    Ok(AiUsagePeriodResolution {
        window: AiUsageWindow {
            from: JsString::from(from.as_str()),
            to: JsString::from(elapsed_to.as_str()),
            time_zone: JsString::from(time_zone),
            start_timestamp: start,
            end_timestamp_exclusive: end,
            days: days.iter().map(|day| JsString::from(day.as_str())).collect(),
        },
        billing_period: AiUsageBillingPeriod {
            source,
            starts_at: start.to_iso_string().map_err(|_| invalid_time())?,
            ends_at: end.to_iso_string().map_err(|_| invalid_time())?,
            end_exclusive: true,
            from,
            to: period_to,
            total_day_count: total.len(),
            elapsed_day_count: days.len(),
        },
    })
}

fn status_is_current(status: &SubscriptionStatus) -> bool {
    match status {
        SubscriptionStatus::Undefined => true,
        SubscriptionStatus::Null => false,
        SubscriptionStatus::Text(value) => {
            matches!(value.as_str(), Some("active") | Some("trialing"))
        }
    }
}

fn find_current_subscription(
    state: &PolarCustomerState,
    now_ms: i64,
) -> Option<(JsDate, JsDate)> {
    let mut candidates = Vec::new();
    for (index, subscription) in state.active_subscriptions.iter().enumerate() {
        let (Some(start), Some(end)) = (
            subscription.current_period_start,
            subscription.current_period_end,
        ) else {
            continue;
        };
        let (Some(start_ms), Some(end_ms)) = (start.timestamp_millis(), end.timestamp_millis())
        else {
            continue;
        };
        if status_is_current(&subscription.status)
            && start_ms <= now_ms
            && now_ms < end_ms
            && start_ms < end_ms
        {
            candidates.push((start_ms, index, start, end));
        }
    }
    // Latest start wins. Equal starts keep source order: `sort_by` is stable,
    // and the original index is the tie-break so this does not depend on that.
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    candidates
        .first()
        .map(|(_, _, start, end)| (*start, *end))
}

enum PeriodStep {
    Ready(AiUsagePeriodResolution),
    NeedCustomer { customer_id: JsString, time_zone: String, now: JsDate },
}

fn prepare_period(input: &AiUsagePeriodInput) -> Result<PeriodStep, AiUsageReceiptError> {
    let time_zone = resolve_time_zone(input.time_zone.as_ref())?;
    let now = require_now(input.now);
    if present(&input.from) || present(&input.to) {
        let window = resolve_ai_usage_window(&AiUsageWindowInput {
            from: input.from.clone(),
            to: input.to.clone(),
            time_zone: Some(JsString::from(time_zone.as_str())),
            now: Some(now),
            max_days: input.max_days,
        })?;
        let billing_period = billing_period_from_window(&window, AiUsagePeriodSource::Custom)?;
        return Ok(PeriodStep::Ready(AiUsagePeriodResolution { window, billing_period }));
    }
    if let Some(anchor) = input.free_period_anchor.and_then(|date| date.timestamp_millis().map(|_| date))
        && let Some((start, end)) = resolve_free_credit_period(anchor, now)
    {
        return usage_period_from_boundaries(
            AiUsagePeriodSource::FreeMonthly,
            start,
            end,
            now,
            &time_zone,
        )
        .map(PeriodStep::Ready);
    }
    if let Some(customer_id) = input.customer_id.clone().filter(|value| !value.is_empty()) {
        return Ok(PeriodStep::NeedCustomer { customer_id, time_zone, now });
    }
    let window = resolve_ai_usage_window(&AiUsageWindowInput {
        time_zone: Some(JsString::from(time_zone.as_str())),
        now: Some(now),
        ..AiUsageWindowInput::default()
    })?;
    let billing_period = billing_period_from_window(&window, AiUsagePeriodSource::Rolling30Day)?;
    Ok(PeriodStep::Ready(AiUsagePeriodResolution { window, billing_period }))
}

fn finish_customer_period(
    state: &PolarCustomerState,
    time_zone: &str,
    now: JsDate,
) -> Result<AiUsagePeriodResolution, AiUsageReceiptError> {
    let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
    if let Some((start, end)) = find_current_subscription(state, now_ms) {
        return usage_period_from_boundaries(
            AiUsagePeriodSource::Subscription,
            start,
            end,
            now,
            time_zone,
        );
    }
    let window = resolve_ai_usage_window(&AiUsageWindowInput {
        time_zone: Some(JsString::from(time_zone)),
        now: Some(now),
        ..AiUsageWindowInput::default()
    })?;
    let billing_period = billing_period_from_window(&window, AiUsagePeriodSource::Rolling30Day)?;
    Ok(AiUsagePeriodResolution { window, billing_period })
}

pub fn resolve_ai_usage_period_with_state<E>(
    input: &AiUsagePeriodInput,
    state: Option<Result<PolarCustomerState, E>>,
) -> Result<AiUsagePeriodResolution, AiUsagePeriodError<E>> {
    match prepare_period(input).map_err(AiUsagePeriodError::Receipt)? {
        PeriodStep::Ready(resolution) => Ok(resolution),
        PeriodStep::NeedCustomer { time_zone, now, .. } => {
            let state = state.ok_or(AiUsagePeriodError::CustomerStateRequired)?;
            let state = state.map_err(AiUsagePeriodError::CustomerState)?;
            finish_customer_period(&state, &time_zone, now).map_err(AiUsagePeriodError::Receipt)
        }
    }
}

pub async fn resolve_ai_usage_period<E, F, Fut>(
    input: AiUsagePeriodInput,
    get_customer_state: Option<F>,
) -> Result<AiUsagePeriodResolution, AiUsagePeriodError<E>>
where
    F: FnOnce(JsString) -> Fut,
    Fut: Future<Output = Result<PolarCustomerState, E>>,
{
    match prepare_period(&input).map_err(AiUsagePeriodError::Receipt)? {
        PeriodStep::Ready(resolution) => Ok(resolution),
        PeriodStep::NeedCustomer { customer_id, time_zone, now } => {
            let get_customer_state =
                get_customer_state.ok_or(AiUsagePeriodError::CustomerStateRequired)?;
            let state = get_customer_state(customer_id)
                .await
                .map_err(AiUsagePeriodError::CustomerState)?;
            finish_customer_period(&state, &time_zone, now).map_err(AiUsagePeriodError::Receipt)
        }
    }
}

fn json_field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(fields) => fields
            .iter()
            .find(|(name, _)| name.as_str() == Some(key))
            .map(|(_, field)| field),
        _ => None,
    }
}

fn coerced_number(value: Option<&JsonValue>) -> f64 {
    match value {
        Some(JsonValue::Number(number)) => *number,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(true)) => 1.0,
        Some(JsonValue::Bool(false)) => 0.0,
        _ => f64::NAN,
    }
}

pub struct AiUsagePacingInput<'a> {
    pub credits: &'a JsonValue,
    pub billing_period: &'a AiUsageBillingPeriod,
    pub history: Option<&'a AiUsagePacingHistory>,
    pub history_complete: Option<bool>,
    pub now: Option<JsDate>,
}

pub fn build_ai_usage_pacing(
    input: AiUsagePacingInput<'_>,
) -> Result<Option<AiUsagePacing>, AiUsageReceiptError> {
    let recurring = matches!(
        input.billing_period.source,
        AiUsagePeriodSource::Subscription | AiUsagePeriodSource::FreeMonthly
    );
    let available = json_field(input.credits, "available").is_some_and(super::lossless_json::truthy);
    if !recurring || !available {
        return Ok(None);
    }
    let now = require_now(input.now);
    let now_ms = match now.timestamp_millis() {
        Some(millis) => millis as f64,
        None => f64::NAN,
    };
    let start = super::js_date::parse_date(&input.billing_period.starts_at);
    let end = super::js_date::parse_date(&input.billing_period.ends_at);
    let (Some(start_ms), Some(end_ms)) = (start, end) else {
        return Ok(None);
    };
    if start_ms >= end_ms {
        return Ok(None);
    }
    let start_ms = start_ms as f64;
    let end_ms = end_ms as f64;
    let total_days = (end_ms - start_ms) / MILLISECONDS_PER_DAY;
    let elapsed_days = js_max(
        1.0,
        js_min(total_days, (js_min(now_ms, end_ms) - start_ms) / MILLISECONDS_PER_DAY),
    );
    let remaining_period_days = js_max(0.0, (end_ms - js_max(now_ms, start_ms)) / MILLISECONDS_PER_DAY);
    let raw_used = coerced_number(json_field(input.credits, "used"));
    let raw_limit = coerced_number(json_field(input.credits, "limit"));
    let raw_balance = coerced_number(json_field(input.credits, "balance"));
    let used = js_max(0.0, raw_used);
    let limit = js_max(0.0, raw_limit);
    let balance = js_max(0.0, raw_balance);
    let current_cycle_average = used / elapsed_days;
    let usable = input
        .history
        .filter(|history| history.day_count >= MINIMUM_PACING_HISTORY_DAYS);
    let forecast_daily = if let Some(history) = usable {
        js_max(0.0, history.average_daily_credits)
    } else {
        current_cycle_average
    };
    let projected_raw = used + forecast_daily * remaining_period_days;
    let available_for_forecast = js_max(limit, raw_used + balance);
    let projected_overage = js_max(0.0, js_ceil(projected_raw - available_for_forecast));
    let estimated_days = if balance <= 0.0 {
        Some(0.0)
    } else if forecast_daily > 0.0 {
        Some(balance / forecast_daily)
    } else {
        None
    };
    let expected = estimated_days.is_some_and(|days| days < remaining_period_days);
    let show_estimate = balance <= 0.0 || expected;
    let exhaustion = if show_estimate && let Some(days) = estimated_days {
        let at = JsDate::from_millis(now_ms + days * MILLISECONDS_PER_DAY);
        Some(at.to_iso_string().map_err(|_| invalid_time())?)
    } else {
        None
    };
    let status_text = json_field(input.credits, "status").and_then(|value| match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    });
    let status = if status_text == Some("exhausted") || balance <= 0.0 {
        PacingStatus::Exhausted
    } else if forecast_daily <= 0.0 {
        PacingStatus::NoUsage
    } else if expected {
        PacingStatus::OverPace
    } else {
        PacingStatus::WithinPace
    };
    let history_days = usable.map(|history| history.day_count).unwrap_or(elapsed_days);
    let active_days = usable
        .and_then(|history| history.active_day_count)
        .unwrap_or(0.0);
    let variability = usable
        .and_then(|history| history.coefficient_of_variation)
        .unwrap_or(f64::INFINITY);
    let mut reasons = Vec::new();
    if history_days < 7.0 {
        reasons.push("insufficient_history".to_string());
    }
    if active_days < 3.0 {
        reasons.push("limited_activity".to_string());
    }
    if variability.is_finite() && variability > 1.0 {
        reasons.push("variable_usage".to_string());
    }
    if input.history_complete == Some(false) {
        reasons.push("history_sync_pending".to_string());
    }
    let confidence = if input.history_complete == Some(false) || history_days < 7.0 || active_days < 3.0
    {
        PacingConfidence::Low
    } else if history_days >= 21.0 && active_days >= 7.0 && variability <= 1.0 {
        PacingConfidence::High
    } else {
        PacingConfidence::Medium
    };
    let recent_average = match input.history {
        Some(history) => history
            .recent_average_daily_credits
            .map(|value| round_places(value, 2)),
        None => None,
    };
    let recent_days = input
        .history
        .and_then(|history| history.recent_day_count)
        .filter(|value| *value != 0.0 && !value.is_nan())
        .unwrap_or(0.0);
    Ok(Some(AiUsagePacing {
        status,
        forecast_basis: if input.billing_period.source == AiUsagePeriodSource::Subscription {
            ForecastBasis::CurrentBillingPeriod
        } else {
            ForecastBasis::CurrentFreeCreditPeriod
        },
        forecast_rate_basis: if usable.is_some() {
            ForecastRateBasis::RetentionHistory
        } else {
            ForecastRateBasis::CurrentCycle
        },
        confidence,
        confidence_reasons: reasons,
        recent_average_daily_credits: recent_average,
        recent_history_days: recent_days,
        quota_used_percent: if limit > 0.0 {
            round_places((js_max(0.0, raw_used) / limit) * 100.0, 2)
        } else {
            0.0
        },
        average_daily_credits: round_places(forecast_daily, 2),
        current_cycle_average_daily_credits: round_places(current_cycle_average, 2),
        historical_average_daily_credits: usable
            .map(|history| round_places(history.average_daily_credits, 2)),
        forecast_history_days: usable
            .map(|history| round_places(history.day_count, 1))
            .unwrap_or(0.0),
        projected_period_credits: js_round(projected_raw),
        projected_quota_used_percent: if limit > 0.0 {
            round_places((projected_raw / limit) * 100.0, 2)
        } else {
            0.0
        },
        projected_overage_credits: projected_overage,
        remaining_period_days: round_places(remaining_period_days, 2),
        daily_credits_to_last_period: if remaining_period_days > 0.0 {
            round_places(balance / remaining_period_days, 2)
        } else {
            0.0
        },
        expected_to_exhaust_within_period: expected,
        estimated_days_until_exhaustion: if show_estimate {
            estimated_days.map(|days| round_places(days, 1))
        } else {
            None
        },
        estimated_exhaustion_at: exhaustion,
    }))
}

fn tx_str<'a>(transaction: &'a AiUsageTransaction, name: &str) -> Option<&'a str> {
    match transaction.get(name).and_then(LedgerField::as_bson) {
        Some(Bson::String(value)) => Some(value),
        _ => None,
    }
}

fn tx_f64(transaction: &AiUsageTransaction, name: &str) -> f64 {
    match transaction.get(name).and_then(LedgerField::as_bson) {
        Some(Bson::Double(value)) => *value,
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        _ => f64::NAN,
    }
}

fn collator() -> Result<CollatorBorrowed<'static>, AiUsageReceiptError> {
    Collator::try_new(Default::default(), Default::default()).map_err(|_| AiUsageReceiptError::Collation)
}

fn credit_desc(left: f64, right: f64) -> std::cmp::Ordering {
    let difference = right - left;
    if difference.is_finite() && difference != 0.0 {
        if difference > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        }
    } else {
        std::cmp::Ordering::Equal
    }
}

pub fn build_ai_usage_summary(
    transactions: &[AiUsageTransaction],
    window: &AiUsageWindow,
) -> Result<AiUsageSummary, AiUsageReceiptError> {
    let time_zone = window.time_zone.as_str().unwrap_or("UTC");
    let mut daily: Vec<(String, f64, f64)> = window
        .days
        .iter()
        .filter_map(|day| day.as_str().map(str::to_string))
        .map(|day| (day, 0.0, 0.0))
        .collect();
    let mut categories: Vec<(String, f64, f64)> = Vec::new();
    let mut spent = 0.0;
    let mut granted = 0.0;
    let mut count = 0.0;
    for transaction in transactions {
        let credits = tx_f64(transaction, "credits");
        let adjustment = tx_str(transaction, "entryKind") == Some("adjustment");
        if credits <= 0.0 || adjustment {
            if credits < 0.0 {
                granted += credits.abs();
            }
            continue;
        }
        spent += credits;
        count += 1.0;
        let occurred = tx_str(transaction, "occurredAt").ok_or_else(invalid_time)?;
        let occurred_ms = super::js_date::parse_date(occurred).ok_or_else(invalid_time)?;
        let label = format_local_date(occurred_ms, time_zone)?;
        if let Some(day) = daily.iter_mut().find(|(date, _, _)| *date == label) {
            day.1 += credits;
            day.2 += 1.0;
        }
        let category = tx_str(transaction, "category").unwrap_or("uncategorized");
        if let Some(row) = categories.iter_mut().find(|(name, _, _)| name == category) {
            row.1 += credits;
            row.2 += 1.0;
        } else {
            categories.push((category.to_string(), credits, 1.0));
        }
    }
    let collator = collator()?;
    categories.sort_by(|left, right| {
        credit_desc(left.1, right.1).then_with(|| collator.compare(&left.0, &right.0))
    });
    let day_count = daily.len();
    Ok(AiUsageSummary {
        schema_version: 1,
        itemization_started_at: AI_USAGE_ITEMIZATION_STARTED_AT.to_string(),
        period_from: window.from.as_str().unwrap_or("").to_string(),
        period_to: window.to.as_str().unwrap_or("").to_string(),
        period_time_zone: time_zone.to_string(),
        day_count,
        total_spent_credits: spent,
        average_daily_spent_credits: round_places(spent / day_count as f64, 2),
        granted_credits: granted,
        net_consumed_credits: spent - granted,
        transaction_count: count,
        daily: daily
            .into_iter()
            .map(|(date, credits, transaction_count)| AiUsageSummaryDay {
                date,
                credits,
                transaction_count,
            })
            .collect(),
        categories: categories
            .into_iter()
            .map(|(category, credits, transaction_count)| AiUsageSummaryCategory {
                percentage: if spent > 0.0 {
                    js_round(credits / spent * 10_000.0) / 100.0
                } else {
                    0.0
                },
                category,
                credits,
                transaction_count,
            })
            .collect(),
    })
}

pub(crate) fn base64url_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        let packed = (u32::from(data[index]) << 16)
            | (u32::from(data[index + 1]) << 8)
            | u32::from(data[index + 2]);
        for shift in [18, 12, 6, 0] {
            out.push(TABLE[((packed >> shift) & 63) as usize] as char);
        }
        index += 3;
    }
    let rest = data.len() - index;
    if rest == 1 {
        let packed = u32::from(data[index]) << 16;
        out.push(TABLE[((packed >> 18) & 63) as usize] as char);
        out.push(TABLE[((packed >> 12) & 63) as usize] as char);
    } else if rest == 2 {
        let packed = (u32::from(data[index]) << 16) | (u32::from(data[index + 1]) << 8);
        out.push(TABLE[((packed >> 18) & 63) as usize] as char);
        out.push(TABLE[((packed >> 12) & 63) as usize] as char);
        out.push(TABLE[((packed >> 6) & 63) as usize] as char);
    }
    out
}

pub(crate) fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let text = text.trim_end_matches('=');
    if text.len() % 4 == 1 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index + 4 <= bytes.len() {
        let packed = (u32::from(value(bytes[index])?) << 18)
            | (u32::from(value(bytes[index + 1])?) << 12)
            | (u32::from(value(bytes[index + 2])?) << 6)
            | u32::from(value(bytes[index + 3])?);
        out.push((packed >> 16) as u8);
        out.push((packed >> 8) as u8);
        out.push(packed as u8);
        index += 4;
    }
    match bytes.len() - index {
        0 => Some(out),
        2 => {
            let packed = (u32::from(value(bytes[index])?) << 18)
                | (u32::from(value(bytes[index + 1])?) << 12);
            out.push((packed >> 16) as u8);
            Some(out)
        }
        3 => {
            let packed = (u32::from(value(bytes[index])?) << 18)
                | (u32::from(value(bytes[index + 1])?) << 12)
                | (u32::from(value(bytes[index + 2])?) << 6);
            out.push((packed >> 16) as u8);
            out.push((packed >> 8) as u8);
            Some(out)
        }
        _ => None,
    }
}

fn encode_memory_cursor(transaction: &AiUsageTransaction) -> Result<String, AiUsageReceiptError> {
    let id = tx_str(transaction, "id").ok_or_else(|| {
        AiUsageReceiptError::Validation("transaction id and occurredAt must be strings".to_string())
    })?;
    let at = tx_str(transaction, "occurredAt").ok_or_else(|| {
        AiUsageReceiptError::Validation("transaction id and occurredAt must be strings".to_string())
    })?;
    let json = JsonValue::Object(vec![
        ("id".into(), JsonValue::String(id.into())),
        ("at".into(), JsonValue::String(at.into())),
    ]);
    Ok(base64url_encode(json.to_json_string().as_bytes()))
}

fn decode_memory_cursor(value: &str) -> Result<(String, String), AiUsageReceiptError> {
    let invalid = || AiUsageReceiptError::Validation("Invalid transaction cursor".to_string());
    let bytes = base64url_decode(value).ok_or_else(invalid)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let parsed = super::lossless_json::parse_json(text).map_err(|_| invalid())?;
    let id = match json_field(&parsed, "id") {
        Some(JsonValue::String(value)) => value.as_str().ok_or_else(invalid)?.to_string(),
        _ => return Err(invalid()),
    };
    let at = match json_field(&parsed, "at") {
        Some(JsonValue::String(value)) => value.as_str().ok_or_else(invalid)?.to_string(),
        _ => return Err(invalid()),
    };
    Ok((id, at))
}

pub struct PaginationInput<'a> {
    pub transactions: &'a [AiUsageTransaction],
    pub category: Option<&'a str>,
    pub cursor: Option<&'a str>,
    pub limit: Option<f64>,
}

pub fn paginate_ai_usage_transactions(
    input: PaginationInput<'_>,
) -> Result<AiUsagePage, AiUsageReceiptError> {
    let category = input.category.map(super::js_compat::trim).filter(|value| !value.is_empty());
    if let Some(category) = category
        && category != "uncategorized"
        && !RECEIPT_CATEGORIES.contains(&category)
    {
        return Err(AiUsageReceiptError::Validation(
            "Invalid usage category".to_string(),
        ));
    }
    let limit = input.limit.unwrap_or(25.0);
    if !is_js_integer(limit) || !(1.0..=100.0).contains(&limit) {
        return Err(AiUsageReceiptError::Validation(
            "limit must be between 1 and 100".to_string(),
        ));
    }
    let mut filtered: Vec<&AiUsageTransaction> = input
        .transactions
        .iter()
        .filter(|transaction| {
            category.is_none_or(|category| tx_str(transaction, "category") == Some(category))
        })
        .collect();
    let not_text = || {
        AiUsageReceiptError::Validation(
            "transaction id and occurredAt must be strings".to_string(),
        )
    };
    for transaction in &filtered {
        if tx_str(transaction, "occurredAt").is_none() || tx_str(transaction, "id").is_none() {
            return Err(not_text());
        }
    }
    let collator = collator()?;
    filtered.sort_by(|left, right| {
        let left_at = tx_str(left, "occurredAt").unwrap_or("");
        let right_at = tx_str(right, "occurredAt").unwrap_or("");
        let left_id = tx_str(left, "id").unwrap_or("");
        let right_id = tx_str(right, "id").unwrap_or("");
        collator
            .compare(right_at, left_at)
            .then_with(|| collator.compare(right_id, left_id))
    });
    let mut start = 0usize;
    if let Some(cursor) = input.cursor {
        let (id, at) = decode_memory_cursor(cursor)?;
        let index = filtered.iter().position(|transaction| {
            tx_str(transaction, "id") == Some(id.as_str())
                && tx_str(transaction, "occurredAt") == Some(at.as_str())
        });
        let Some(index) = index else {
            return Err(AiUsageReceiptError::Validation(
                "Transaction cursor is no longer available".to_string(),
            ));
        };
        start = index + 1;
    }
    let items: Vec<AiUsageTransaction> = filtered
        .iter()
        .skip(start)
        .take(limit as usize)
        .map(|transaction| (*transaction).clone())
        .collect();
    let has_next = start + items.len() < filtered.len();
    let next_cursor = if has_next && let Some(last) = items.last() {
        Some(encode_memory_cursor(last)?)
    } else {
        None
    };
    Ok(AiUsagePage { items, next_cursor })
}

fn is_js_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}


/// Benefit events are matched to meter credits inside this many milliseconds.
/// Same value as `ai_credit_sources::CREDIT_SOURCE_MATCH_MS`. That module is
/// not declared from `utils/mod.rs`, so this file does not import it.
const CREDIT_SOURCE_MATCH_MS: i64 = 5_000;

/// `instanceof Date` versus `new Date(String(value || ''))`.
#[derive(Clone, Debug, PartialEq)]
pub enum PolarTimestamp {
    Date(JsDate),
    Text(String),
}

impl PolarTimestamp {
    fn millis(&self) -> Option<i64> {
        match self {
            Self::Date(date) => date.timestamp_millis(),
            Self::Text(text) => super::js_date::parse_date(text),
        }
    }
}

/// One Polar event page item. Metadata is an ordinary JSON object when present.
#[derive(Clone, Debug, PartialEq)]
pub struct PolarUsageEvent {
    pub id: Option<JsonValue>,
    pub timestamp: Option<PolarTimestamp>,
    pub source: Option<JsonValue>,
    pub name: Option<JsonValue>,
    pub metadata: Option<JsonValue>,
}

/// Arguments passed to the injected `events.list` stand-in.
#[derive(Clone, Debug, PartialEq)]
pub struct PolarUsageListRequest {
    pub customer_id: String,
    pub name: &'static str,
    pub source: &'static str,
    pub start_timestamp: JsDate,
    pub end_timestamp: JsDate,
    pub page: u32,
    pub limit: i64,
    /// Always `"-timestamp"`, matching `sorting: ['-timestamp']`.
    pub sorting: &'static str,
}

/// `items` is already the array the source reads. A missing `max_page` is
/// `None` (`typeof !== 'number'`). `has_next_page` is `Some(true)` only for
/// the strict `=== true` check.
#[derive(Clone, Debug, PartialEq)]
pub struct PolarUsageEventsPage {
    pub items: Vec<PolarUsageEvent>,
    pub max_page: Option<f64>,
    pub has_next_page: Option<bool>,
}

/// List and classifier failures stay in `Caller`. Limit and validation failures
/// stay in `Receipt`. Decoding a normalized row uses the ledger reader's error.
#[derive(Debug)]
pub enum FetchAiUsageError<E> {
    Receipt(AiUsageReceiptError),
    Ledger(AiUsageLedgerReadError),
    Caller(E),
}

impl<E: std::fmt::Display> std::fmt::Display for FetchAiUsageError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Receipt(error) => write!(formatter, "{error}"),
            Self::Ledger(error) => write!(formatter, "{error}"),
            Self::Caller(error) => write!(formatter, "{error}"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for FetchAiUsageError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Receipt(error) => Some(error),
            Self::Ledger(error) => Some(error),
            Self::Caller(error) => Some(error),
        }
    }
}

struct DraftTransaction {
    id: String,
    request_id: Option<String>,
    occurred_at_ms: i64,
    occurred_at: String,
    entry_kind: &'static str,
    category: &'static str,
    operation: String,
    source: Option<String>,
    adjustment_type: Option<String>,
    provider: String,
    model: Option<String>,
    quantity: Option<f64>,
    unit: Option<&'static str>,
    credits: f64,
    resource_type: Option<&'static str>,
    resource_id: Option<String>,
    itemized: bool,
}

fn json_is(value: Option<&JsonValue>, expected: &str) -> bool {
    matches!(value, Some(JsonValue::String(text)) if text.as_str() == Some(expected))
}

fn event_meta<'a>(event: &'a PolarUsageEvent, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = event.metadata.as_ref()? else {
        return None;
    };
    fields
        .iter()
        .find(|(name, _)| name.as_str() == Some(key))
        .map(|(_, value)| value)
}

fn meta_or<'a>(event: &'a PolarUsageEvent, keys: &[&str]) -> Option<&'a JsonValue> {
    for key in keys {
        if let Some(value) = event_meta(event, key)
            && !matches!(value, JsonValue::Null)
        {
            return Some(value);
        }
    }
    None
}

fn polar_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'/' | b'-')
        })
}

fn clipped(value: &str, max_len: usize) -> String {
    value.chars().take(max_len).collect()
}

fn safe_text(value: Option<&JsonValue>, fallback: &str, max_len: usize) -> String {
    let Some(JsonValue::String(text)) = value else {
        return fallback.to_string();
    };
    let Some(text) = text.as_str() else {
        return fallback.to_string();
    };
    let normalized = js_trim(text);
    if !polar_token(&normalized) {
        return fallback.to_string();
    }
    clipped(&normalized, max_len)
}

fn optional_safe_text(value: Option<&JsonValue>, max_len: usize) -> Option<String> {
    let Some(JsonValue::String(text)) = value else {
        return None;
    };
    let text = text.as_str()?;
    let normalized = js_trim(text);
    if !polar_token(&normalized) {
        return None;
    }
    Some(clipped(&normalized, max_len))
}

fn finite_number(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        None | Some(JsonValue::Null) | Some(JsonValue::Bool(_)) => None,
        Some(JsonValue::String(text)) if text.is_empty() => None,
        Some(JsonValue::Number(number)) if number.is_finite() => Some(*number),
        Some(JsonValue::String(text)) => text
            .as_str()
            .and_then(|text| text.trim().parse::<f64>().ok())
            .filter(|number| number.is_finite()),
        _ => None,
    }
}

fn json_to_serde(value: &JsonValue) -> serde_json::Value {
    match value {
        JsonValue::Null => serde_json::Value::Null,
        JsonValue::Bool(value) => serde_json::Value::Bool(*value),
        JsonValue::Number(number) => serde_json::Number::from_f64(*number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        JsonValue::String(text) => serde_json::Value::String(text.to_utf8_lossy()),
        JsonValue::Array(items) => {
            serde_json::Value::Array(items.iter().map(json_to_serde).collect())
        }
        JsonValue::Object(fields) => {
            let mut object = serde_json::Map::new();
            for (key, value) in fields {
                if let Some(key) = key.as_str() {
                    object.insert(key.to_string(), json_to_serde(value));
                }
            }
            serde_json::Value::Object(object)
        }
    }
}

fn event_string_id(event: &PolarUsageEvent) -> Option<String> {
    match event.id.as_ref() {
        Some(JsonValue::String(id)) => id.as_str().map(str::to_string),
        _ => None,
    }
}

fn usage_draft(event: &PolarUsageEvent) -> Option<DraftTransaction> {
    if !json_is(event.name.as_ref(), "ai_usage") || !json_is(event.source.as_ref(), "user") {
        return None;
    }
    let occurred_at_ms = event.timestamp.as_ref().and_then(PolarTimestamp::millis)?;
    let occurred_at = JsDate::from_millis(occurred_at_ms as f64).to_iso_string().ok()?;
    let credits = finite_number(event_meta(event, "credits"))?;
    let itemized = finite_number(event_meta(event, "schema_version")) == Some(1.0);
    let entry_id = optional_safe_text(event_meta(event, "entry_id"), 128)
        .or_else(|| optional_safe_text(event.id.as_ref(), 128))
        .unwrap_or_else(|| format!("usage-{}", number_string(occurred_at_ms as f64)));
    let entry_kind = if json_is(event_meta(event, "entry_kind"), "adjustment") || credits < 0.0 {
        "adjustment"
    } else {
        "usage"
    };
    let unit = match event_meta(event, "unit").and_then(|value| match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    }) {
        Some("characters") => Some("characters"),
        Some("tokens") => Some("tokens"),
        Some("minutes") => Some("minutes"),
        _ => None,
    };
    let resource_type = match event_meta(event, "resource_type").and_then(|value| match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    }) {
        Some("speech") => Some("speech"),
        Some("voice_preview") => Some("voice_preview"),
        Some("llm_generation") => Some("llm_generation"),
        Some("vod_analysis") => Some("vod_analysis"),
        _ => None,
    };
    let operation_raw = event_meta(event, "operation").map(json_to_serde).unwrap_or(serde_json::Value::Null);
    let source_raw = event_meta(event, "usage_source").map(json_to_serde).unwrap_or(serde_json::Value::Null);
    let reason_raw = event_meta(event, "reason").map(json_to_serde).unwrap_or(serde_json::Value::Null);
    let adjustment = classify_adjustment(&serde_json::json!({
        "entryKind": entry_kind,
        "operation": operation_raw,
        "source": source_raw,
        "reason": reason_raw,
    }));
    Some(DraftTransaction {
        id: entry_id,
        request_id: optional_safe_text(event_meta(event, "request_id"), 128),
        occurred_at_ms,
        occurred_at,
        entry_kind,
        category: normalize_receipt_category(
            event_meta(event, "category").and_then(|value| match value {
                JsonValue::String(text) => text.as_str(),
                _ => None,
            }),
        ),
        operation: safe_text(event_meta(event, "operation"), "usage", 96),
        source: optional_safe_text(event_meta(event, "usage_source"), 128),
        adjustment_type: adjustment.map(str::to_string),
        provider: safe_text(event_meta(event, "provider"), "unknown", 96),
        model: optional_safe_text(event_meta(event, "model"), 128),
        quantity: finite_number(event_meta(event, "quantity")),
        unit,
        credits,
        resource_type,
        resource_id: optional_safe_text(event_meta(event, "resource_id"), 128),
        itemized,
    })
}

fn credit_draft(event: &PolarUsageEvent) -> Option<DraftTransaction> {
    if !json_is(event.name.as_ref(), "meter.credited") || !json_is(event.source.as_ref(), "system")
    {
        return None;
    }
    let id = optional_safe_text(event.id.as_ref(), 128)?;
    let occurred_at_ms = event.timestamp.as_ref().and_then(PolarTimestamp::millis)?;
    let occurred_at = JsDate::from_millis(occurred_at_ms as f64).to_iso_string().ok()?;
    let meter = meta_or(event, &["meterId", "meter_id"]).and_then(|value| match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    });
    let units = match meta_or(event, &["units"]) {
        Some(JsonValue::Number(units)) if units.is_finite() && *units > 0.0 => *units,
        _ => return None,
    };
    if meter != Some(AI_CREDITS_METER_ID) || !matches!(meta_or(event, &["rollover"]), Some(JsonValue::Bool(_)))
    {
        return None;
    }
    let permanent = matches!(meta_or(event, &["rollover"]), Some(JsonValue::Bool(true)));
    Some(DraftTransaction {
        id: format!("polar-credit:{id}"),
        request_id: None,
        occurred_at_ms,
        occurred_at,
        entry_kind: "adjustment",
        category: "credit_adjustment",
        operation: if permanent {
            "permanent_credit_grant"
        } else {
            "period_credit_grant"
        }
        .to_string(),
        source: Some("polar_meter_credit".to_string()),
        adjustment_type: Some("native_grant".to_string()),
        provider: "polar".to_string(),
        model: None,
        quantity: None,
        unit: None,
        credits: -units,
        resource_type: None,
        resource_id: None,
        itemized: true,
    })
}

fn upsert_draft(transactions: &mut Vec<DraftTransaction>, draft: DraftTransaction) {
    if let Some(existing) = transactions.iter_mut().find(|item| item.id == draft.id) {
        *existing = draft;
    } else {
        transactions.push(draft);
    }
}

fn draft_document(draft: &DraftTransaction) -> Document {
    let mut document = doc! {
        "entryId": &draft.id,
        "occurredAt": DateTime::from_millis(draft.occurred_at_ms),
        "entryKind": draft.entry_kind,
        "category": draft.category,
        "operation": &draft.operation,
        "provider": &draft.provider,
        "credits": js_number(draft.credits),
        "itemized": draft.itemized,
    };
    let text = |value: &Option<String>| match value {
        Some(value) => Bson::String(value.clone()),
        None => Bson::Null,
    };
    document.insert("requestId", text(&draft.request_id));
    document.insert("source", text(&draft.source));
    document.insert(
        "adjustmentType",
        draft
            .adjustment_type
            .as_ref()
            .map(|value| Bson::String(value.clone()))
            .unwrap_or(Bson::Null),
    );
    document.insert("model", text(&draft.model));
    document.insert(
        "quantity",
        draft
            .quantity
            .map(js_number)
            .unwrap_or(Bson::Null),
    );
    document.insert(
        "unit",
        draft
            .unit
            .map(|value| Bson::String(value.to_string()))
            .unwrap_or(Bson::Null),
    );
    document.insert(
        "resourceType",
        draft
            .resource_type
            .map(|value| Bson::String(value.to_string()))
            .unwrap_or(Bson::Null),
    );
    document.insert("resourceId", text(&draft.resource_id));
    document
}

fn shifted_bound(millis: i64, delta: i64) -> Result<JsDate, AiUsageReceiptError> {
    let shifted = millis.checked_add(delta).ok_or_else(invalid_time)?;
    let date = JsDate::from_millis(shifted as f64);
    if date.timestamp_millis().is_none() {
        return Err(invalid_time());
    }
    Ok(date)
}

/// `normalizePolarUsageEvent`. A row this builder cannot represent as a ledger
/// transaction is `Err`; a rejected Polar payload is `Ok(None)`.
pub fn normalize_polar_usage_event(
    event: &PolarUsageEvent,
) -> Result<Option<AiUsageTransaction>, AiUsageLedgerReadError> {
    match usage_draft(event) {
        Some(draft) => decode_ledger_transaction(&draft_document(&draft)).map(Some),
        None => Ok(None),
    }
}

/// `normalizePolarCreditEvent`. Reporting only. Never ingest the result as usage.
pub fn normalize_polar_credit_event(
    event: &PolarUsageEvent,
) -> Result<Option<AiUsageTransaction>, AiUsageLedgerReadError> {
    match credit_draft(event) {
        Some(draft) => decode_ledger_transaction(&draft_document(&draft)).map(Some),
        None => Ok(None),
    }
}

/// `fetchAiUsageTransactions`.
///
/// `list_events` replaces the default `getPolarShClient('fetchAiUsageTransactions')`
/// call. `classify_credit_sources` replaces `classifyPolarCreditSources`. Pass
/// `utils::ai_credit_sources::classify_polar_credit_sources` once that module is
/// declared. This function does not open a Polar HTTP client.
///
/// Signature:
/// `fetch_ai_usage_transactions(customer_id, window, list_events, classify_credit_sources)`.
pub async fn fetch_ai_usage_transactions<E, L, LFut, C, CFut>(
    customer_id: &str,
    window: &AiUsageWindow,
    list_events: L,
    classify_credit_sources: C,
) -> Result<Vec<AiUsageTransaction>, FetchAiUsageError<E>>
where
    L: Fn(PolarUsageListRequest) -> LFut,
    LFut: Future<Output = Result<PolarUsageEventsPage, E>>,
    C: FnOnce(&str, &[PolarUsageEvent]) -> CFut,
    CFut: Future<Output = Result<Vec<(String, String)>, E>>,
{
    let start_ms = window
        .start_timestamp
        .timestamp_millis()
        .ok_or_else(invalid_time)
        .map_err(FetchAiUsageError::Receipt)?;
    let end_ms = window
        .end_timestamp_exclusive
        .timestamp_millis()
        .ok_or_else(invalid_time)
        .map_err(FetchAiUsageError::Receipt)?;
    let streams: [(&str, &str, bool); 4] = [
        ("ai_usage", "user", true),
        ("meter.credited", "system", false),
        ("benefit.granted", "system", false),
        ("benefit.cycled", "system", false),
    ];
    let mut transactions = Vec::new();
    let mut source_events = Vec::new();
    for (name, source, usage) in streams {
        let (range_start, range_end) = if source == "system" {
            (
                shifted_bound(start_ms, -CREDIT_SOURCE_MATCH_MS).map_err(FetchAiUsageError::Receipt)?,
                shifted_bound(end_ms, CREDIT_SOURCE_MATCH_MS).map_err(FetchAiUsageError::Receipt)?,
            )
        } else {
            (window.start_timestamp, window.end_timestamp_exclusive)
        };
        let mut complete = false;
        for page in 1..=u32::try_from(AI_USAGE_MAX_POLAR_PAGES).unwrap_or(100) {
            let result = list_events(PolarUsageListRequest {
                customer_id: customer_id.to_string(),
                name,
                source,
                start_timestamp: range_start,
                end_timestamp: range_end,
                page,
                limit: AI_USAGE_PAGE_SIZE,
                sorting: "-timestamp",
            })
            .await
            .map_err(FetchAiUsageError::Caller)?;
            for item in &result.items {
                if source == "system" && event_string_id(item).is_some() {
                    source_events.push(item.clone());
                }
                let normalized = if usage {
                    usage_draft(item)
                } else if name == "meter.credited" {
                    credit_draft(item)
                } else {
                    None
                };
                if let Some(draft) = normalized
                    && draft.occurred_at_ms >= start_ms
                    && draft.occurred_at_ms < end_ms
                {
                    upsert_draft(&mut transactions, draft);
                }
            }
            let has_another = if let Some(max_page) = result.max_page {
                f64::from(page) < max_page
            } else {
                result.has_next_page == Some(true)
                    || result.items.len() == usize::try_from(AI_USAGE_PAGE_SIZE).unwrap_or(100)
            };
            if !has_another {
                complete = true;
                break;
            }
        }
        if !complete {
            return Err(FetchAiUsageError::Receipt(AiUsageReceiptError::Limit(
                "Usage history is too large for this date range".to_string(),
            )));
        }
    }
    let classified = classify_credit_sources(customer_id, &source_events)
        .await
        .map_err(FetchAiUsageError::Caller)?;
    for (event_id, adjustment_type) in classified {
        let receipt_id = format!("polar-credit:{event_id}");
        if let Some(receipt) = transactions.iter_mut().find(|item| item.id == receipt_id) {
            receipt.adjustment_type = Some(adjustment_type);
        }
    }
    let collator = collator().map_err(FetchAiUsageError::Receipt)?;
    transactions.sort_by(|left, right| {
        collator
            .compare(&right.occurred_at, &left.occurred_at)
            .then_with(|| collator.compare(&right.id, &left.id))
    });
    let mut decoded = Vec::with_capacity(transactions.len());
    for draft in &transactions {
        decoded.push(
            decode_ledger_transaction(&draft_document(draft)).map_err(FetchAiUsageError::Ledger)?,
        );
    }
    Ok(decoded)
}
