//! Pure timer interval rules; no cache, rendering, worker, or AST behavior.
//! Opt-in `timer-policy` feature; reuse ECMAScript whitespace trimming.
//!
//! Number inputs use f64, preserving JS overflow, NaN, and signed zero. The
//! unknown legacy input is `Option<f64>`: None means any non-number JS value,
//! including numeric strings (which Number.isInteger deliberately rejects).

use super::js_compat::trim as js_trim;
use serde::Serialize;

pub const TIMER_FREQUENCY_UNIT: &str = "minutes";
pub const MAX_GRANDFATHERED_TIMER_MINUTES: f64 = 1440.0;

#[derive(Debug, Clone, Copy)]
pub struct TimerFrequencyValue<'a> {
    pub frequency: f64,
    pub frequency_unit: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TimerIntervalValidation {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TimerEditIntervalValidation {
    pub minutes: f64,
    #[serde(flatten)]
    pub validation: TimerIntervalValidation,
}

pub fn convert_legacy_timer_frequency(frequency: Option<f64>) -> Option<f64> {
    frequency
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 288.0)
        .map(|n| n * 5.0)
}

pub fn get_timer_interval_minutes(timer: TimerFrequencyValue<'_>) -> f64 {
    if timer.frequency_unit == Some(TIMER_FREQUENCY_UNIT) {
        timer.frequency
    } else {
        timer.frequency * 5.0
    }
}

pub fn get_timer_heartbeat_minutes(
    timer: TimerFrequencyValue<'_>,
    stored_heartbeat: f64,
    heartbeat_unit: Option<&str>,
) -> f64 {
    let safe = if stored_heartbeat.is_finite() && stored_heartbeat >= 0.0 {
        stored_heartbeat
    } else {
        0.0
    };
    if heartbeat_unit == Some(TIMER_FREQUENCY_UNIT)
        || timer.frequency_unit == Some(TIMER_FREQUENCY_UNIT)
    {
        safe
    } else {
        safe * 5.0
    }
}

pub fn parse_timer_frequency_input(raw_value: Option<&str>) -> Option<f64> {
    let normalized = js_trim(raw_value?).to_ascii_lowercase();
    let (digits, hours) = if let Some(digits) = normalized.strip_suffix('h') {
        (digits, true)
    } else {
        (normalized.strip_suffix('m').unwrap_or(&normalized), false)
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let amount = digits.parse::<f64>().ok()?;
    if !amount.is_finite() || amount.fract() != 0.0 || amount <= 0.0 {
        return None;
    }
    // The source does not recheck overflow after converting hours to minutes.
    Some(if hours { amount * 60.0 } else { amount })
}

pub fn validate_timer_interval(minutes: f64, tier: &str) -> TimerIntervalValidation {
    let error = if !minutes.is_finite() || minutes.fract() != 0.0 || minutes <= 0.0 {
        Some("Frequency must be a positive whole number of minutes")
    } else {
        match tier {
            "pro" if minutes > 180.0 => Some("Pro timers must be between 1 and 180 minutes"),
            "pro" => None,
            "premium" if !(5.0..=180.0).contains(&minutes) || minutes % 5.0 != 0.0 => {
                Some("Premium timers must use 5-minute intervals from 5 to 180 minutes")
            }
            "premium" => None,
            _ if ![10.0, 20.0, 30.0, 40.0, 50.0, 60.0].contains(&minutes) => {
                Some("Free timers must use 10, 20, 30, 40, 50, or 60 minutes")
            }
            _ => None,
        }
    };
    TimerIntervalValidation {
        valid: error.is_none(),
        error,
    }
}

/// None corresponds to nullish requestedMinutes; NaN remains an explicit edit.
pub fn validate_timer_edit_interval(
    timer: TimerFrequencyValue<'_>,
    requested_minutes: Option<f64>,
    tier: &str,
) -> TimerEditIntervalValidation {
    let minutes = requested_minutes.unwrap_or_else(|| get_timer_interval_minutes(timer));
    TimerEditIntervalValidation {
        minutes,
        validation: validate_timer_interval(minutes, tier),
    }
}
