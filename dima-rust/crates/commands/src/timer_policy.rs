//! Timer interval rules per plan (reference: `utils/timer_policy.ts`).
//!
//! Numbers are `f64` because the stored values are JavaScript numbers: NaN, infinities and
//! `-0` behave as they do there. Frequency text is read with JavaScript `trim` and
//! `toLowerCase` ([`dima_text`]) and then ASCII digits only, as the reference's `\d` is.

/// The unit of current timers.
pub const TIMER_FREQUENCY_UNIT: &str = "minutes";
/// The longest interval of a grandfathered legacy timer, in minutes (one day).
pub const MAX_GRANDFATHERED_TIMER_MINUTES: f64 = 24.0 * 60.0;

const MAX_CURRENT_TIMER_MINUTES: f64 = 180.0;
/// Legacy frequencies count 5-minute ticks.
const MAX_LEGACY_FREQUENCY_TICKS: f64 = MAX_GRANDFATHERED_TIMER_MINUTES / 5.0;
const FREE_INTERVALS: [f64; 6] = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0];

/// A stored timer's frequency (`frequencyUnit` missing means legacy 5-minute ticks).
#[derive(Debug, Clone, Copy)]
pub struct TimerFrequencyValue<'a> {
    /// `frequency`.
    pub frequency: f64,
    /// `frequencyUnit`.
    pub frequency_unit: Option<&'a str>,
}

/// The outcome of a validation, with the reference's message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimerIntervalValidation {
    /// Whether the interval is allowed.
    pub valid: bool,
    /// Why not.
    pub error: Option<&'static str>,
}

/// [`validate_timer_edit_interval`]'s outcome: the interval it checked, and the result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimerEditIntervalValidation {
    /// The interval checked, in minutes.
    pub minutes: f64,
    /// The result.
    pub validation: TimerIntervalValidation,
}

fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// `convertLegacyTimerFrequency`: an integer tick count from 1 to 288 as minutes (`None` is
/// the reference's `null`; `frequency` is `None` for any value that is not a number).
pub fn convert_legacy_timer_frequency(frequency: Option<f64>) -> Option<f64> {
    frequency
        .filter(|ticks| is_integer(*ticks) && (1.0..=MAX_LEGACY_FREQUENCY_TICKS).contains(ticks))
        .map(|ticks| ticks * 5.0)
}

/// `getTimerIntervalMinutes`.
pub fn get_timer_interval_minutes(timer: TimerFrequencyValue<'_>) -> f64 {
    if timer.frequency_unit == Some(TIMER_FREQUENCY_UNIT) {
        timer.frequency
    } else {
        timer.frequency * 5.0
    }
}

/// `getTimerHeartbeatMinutes`: a stored heartbeat that is not a finite non-negative number is
/// 0; legacy heartbeats count ticks.
pub fn get_timer_heartbeat_minutes(
    timer: TimerFrequencyValue<'_>,
    stored_heartbeat: f64,
    heartbeat_unit: Option<&str>,
) -> f64 {
    let heartbeat = if stored_heartbeat.is_finite() && stored_heartbeat >= 0.0 {
        stored_heartbeat
    } else {
        0.0
    };
    if heartbeat_unit == Some(TIMER_FREQUENCY_UNIT)
        || timer.frequency_unit == Some(TIMER_FREQUENCY_UNIT)
    {
        heartbeat
    } else {
        heartbeat * 5.0
    }
}

/// `parseTimerFrequencyInput`: `N`, `Nm` or `Nh` (ASCII digits, after trim and lowercase), a
/// positive whole number of minutes. Hours are multiplied without a further check, as in the
/// reference.
pub fn parse_timer_frequency_input(raw: Option<&str>) -> Option<f64> {
    let raw = raw.filter(|raw| !raw.is_empty())?;
    let normalized = dima_text::to_lower(dima_text::trim(raw));
    let (digits, hours) = match normalized.strip_suffix('h') {
        Some(digits) => (digits, true),
        None => (normalized.strip_suffix('m').unwrap_or(&normalized), false),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let amount = dima_text::parse_int(digits, dima_text::Radix::Decimal);
    if !is_integer(amount) || amount <= 0.0 {
        return None;
    }
    Some(if hours { amount * 60.0 } else { amount })
}

/// `validateTimerInterval`: Pro 1 to 180 minutes; Premium 5 to 180 in steps of 5; Free (and
/// any other tier) 10, 20, 30, 40, 50 or 60.
pub fn validate_timer_interval(minutes: f64, tier: &str) -> TimerIntervalValidation {
    let error = if !is_integer(minutes) || minutes <= 0.0 {
        Some("Frequency must be a positive whole number of minutes")
    } else {
        match tier {
            "pro" if minutes > MAX_CURRENT_TIMER_MINUTES => {
                Some("Pro timers must be between 1 and 180 minutes")
            }
            "pro" => None,
            "premium"
                if !(5.0..=MAX_CURRENT_TIMER_MINUTES).contains(&minutes)
                    || minutes % 5.0 != 0.0 =>
            {
                Some("Premium timers must use 5-minute intervals from 5 to 180 minutes")
            }
            "premium" => None,
            _ if !FREE_INTERVALS.contains(&minutes) => {
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

/// `validateTimerEditInterval`: the requested interval (`None` is `null` or `undefined`), or
/// the timer's current one.
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
