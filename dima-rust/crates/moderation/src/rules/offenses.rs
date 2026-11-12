//! Offense counting and the escalation ladder (reference `utils/moderation/offenses.ts`).
//!
//! # State
//!
//! - `moderation:{channel}:offenses:{rule}:{user}` (string, integer counter): incremented once
//!   per decision; its lifetime starts at the first offense and is the channel's offense window
//!   (`max(60, floor(offenseWindowSeconds))`), a fixed window: a viewer who stops offending is
//!   back at the first step once it ends.
//! - `moderation:offense-receipt:{decision}` (string, the count that decision was given):
//!   86,400 s. A decision counts once however many times it is processed.
//!
//! Both are written by one script (`lua/record_offense.lua`, the reference's text), which
//! Dragonfly runs atomically over its two declared keys: two messages racing on the same
//! viewer get consecutive counts, and the same decision delivered twice gets the same count
//! (`tests/state.rs` races both). The reference's other path (no decision id: `INCR`, then a
//! separate `EXPIRE`, which a crash between them leaves without a lifetime) has no caller and is
//! not ported.
//!
//! Bounds: one counter per (channel, rule, viewer) that offended inside the window, each a
//! small integer with a lifetime of at most 86,400 s; one receipt per decision for 86,400 s.
//! A flood of offending viewers creates one key per viewer and per decision, all expiring.
//! The window is clamped to 60–86,400 s (the settings service's own limits): a stored value
//! outside them, which the service cannot write, would otherwise set a lifetime of its own.
//!
//! Cutover: the family is rebuilt (Rust uses its own logical database), so every viewer starts
//! at the first step: one mid-escalation (say at their second offense) gets the first step
//! again, never a harsher one.

use dima_model::channel_moderation_settings::ChannelModerationSettingsRules;
use dima_store::dragonfly::Script;
use dima_store::dragonfly::commands::reply;

use super::store::{RulesStore, StoreError};

/// The reference's script, verbatim.
pub static RECORD_OFFENSE: Script =
    Script::new("recordOffense", include_str!("lua/record_offense.lua"));

/// The receipt's lifetime.
pub const OFFENSE_RECEIPT_SECONDS: i64 = 86_400;
/// The shortest offense window.
pub const MIN_OFFENSE_WINDOW_SECONDS: i64 = 60;
/// The longest offense window.
pub const MAX_OFFENSE_WINDOW_SECONDS: i64 = 86_400;

/// `IModerationOffenseStep.action`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModerationAction {
    /// Counted, nothing done.
    Off,
    /// A Twitch warning.
    Warn,
    /// The message deleted.
    Delete,
    /// A timeout of `timeoutSeconds`.
    Timeout,
    /// A ban.
    Ban,
    /// A value the schema does not list (the executor decides).
    Other(String),
}

impl ModerationAction {
    /// From the stored text.
    pub fn parse(text: &str) -> Self {
        match text {
            "off" => Self::Off,
            "warn" => Self::Warn,
            "delete" => Self::Delete,
            "timeout" => Self::Timeout,
            "ban" => Self::Ban,
            other => Self::Other(other.to_owned()),
        }
    }

    /// The stored text.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Off => "off",
            Self::Warn => "warn",
            Self::Delete => "delete",
            Self::Timeout => "timeout",
            Self::Ban => "ban",
            Self::Other(text) => text,
        }
    }
}

/// `IModerationOffenseStep`.
#[derive(Debug, Clone, PartialEq)]
pub struct OffenseStep {
    /// `action`.
    pub action: ModerationAction,
    /// `timeoutSeconds`.
    pub timeout_seconds: f64,
}

/// `offenseKey`.
pub fn offense_key(channel_id: &str, rule_id: &str, user_id: &str) -> String {
    format!("moderation:{channel_id}:offenses:{rule_id}:{user_id}")
}

/// The receipt key of a decision.
pub fn offense_receipt_key(decision_id: &str) -> String {
    format!("moderation:offense-receipt:{decision_id}")
}

/// `Math.max(60, Math.floor(windowSeconds))`, clamped to the service's maximum; a value that is
/// not a number is the minimum (the reference would send `NaN` and the script would fail).
pub fn offense_window_seconds(window: f64) -> i64 {
    if window.is_nan() {
        return MIN_OFFENSE_WINDOW_SECONDS;
    }
    #[allow(clippy::cast_possible_truncation)]
    let floored = window.floor().clamp(-1e15, 1e15) as i64;
    floored.clamp(MIN_OFFENSE_WINDOW_SECONDS, MAX_OFFENSE_WINDOW_SECONDS)
}

/// `resolveOffenseStep`: 1st (or less) → first, 2nd → second, 3rd and beyond → third.
pub fn resolve_offense_step(rule: &ChannelModerationSettingsRules, offense: i64) -> OffenseStep {
    let (action, timeout) = if offense <= 1 {
        (
            rule.first_offense.action.as_str(),
            rule.first_offense.timeout_seconds.0,
        )
    } else if offense == 2 {
        (
            rule.second_offense.action.as_str(),
            rule.second_offense.timeout_seconds.0,
        )
    } else {
        (
            rule.third_offense.action.as_str(),
            rule.third_offense.timeout_seconds.0,
        )
    };
    OffenseStep {
        action: ModerationAction::parse(action),
        timeout_seconds: timeout,
    }
}

impl RulesStore {
    /// `recordOffense(channel, rule, user, window, decisionID)`: the viewer's offense number
    /// for this decision (counted once per decision).
    pub async fn record_offense(
        &self,
        channel_id: &str,
        rule_id: &str,
        user_id: &str,
        window_seconds: f64,
        decision_id: &str,
    ) -> Result<i64, StoreError> {
        let keys = [
            self.key(&offense_key(channel_id, rule_id, user_id)),
            self.key(&offense_receipt_key(decision_id)),
        ];
        let window = offense_window_seconds(window_seconds).to_string();
        let value = RECORD_OFFENSE
            .run_value(&self.dragonfly, &keys, &[window])
            .await?;
        reply::int(value).map_err(|_| StoreError::Reply("recordOffense"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_bounds() {
        assert_eq!(offense_window_seconds(3600.0), 3600);
        assert_eq!(offense_window_seconds(59.9), 60);
        assert_eq!(offense_window_seconds(-5.0), 60);
        assert_eq!(offense_window_seconds(120.7), 120);
        assert_eq!(offense_window_seconds(f64::NAN), 60);
        assert_eq!(offense_window_seconds(1e12), 86_400);
    }

    #[test]
    fn script_is_bounded() {
        assert!(RECORD_OFFENSE.check().is_ok());
    }
}
