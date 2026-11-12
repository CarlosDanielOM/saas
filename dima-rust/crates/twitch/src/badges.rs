//! Chat badges as the AI and the command engine see them (`utils/badges.ts`, `formatBadges`).
//!
//! Role: `[STREAMER]` (broadcaster), else `[MOD]`, else `[VIP]`; subscription: `[FOUNDER nM]`,
//! else `[SUB nM]` with `n = parseInt(info) || 0`; then `[PRIME]`, `[PARTNER]`, `[STAFF]`,
//! `[TURBO]`, `[SUB-GIFTER]` in that order. Each badge is looked up by its first `set_id`.
//! The text is the labels joined by spaces plus one trailing space, or empty.

use serde::{Deserialize, Serialize};

/// One badge of a chat message (`IBadge`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Badge {
    /// The badge set (`subscriber`, `moderator`...).
    pub set_id: String,
    /// The version within the set.
    pub id: String,
    /// Extra data (months for `subscriber` and `founder`).
    #[serde(default)]
    pub info: String,
}

/// `FormatBadgesResponse`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FormattedBadges {
    /// The labels joined with spaces, plus a trailing space; empty without labels.
    pub formatted_badges: String,
    /// The labels.
    pub badge_list: Vec<String>,
    /// Broadcaster or moderator.
    pub is_mod: bool,
    /// Founder or subscriber.
    pub is_sub: bool,
    /// The months of the founder or subscriber badge (`parseInt(info) || 0`).
    pub sub_months: f64,
}

/// `formatBadges({badges})`.
pub fn format_badges(badges: &[Badge]) -> FormattedBadges {
    if badges.is_empty() {
        return FormattedBadges::default();
    }
    let find = |set_id: &str| badges.iter().find(|badge| badge.set_id == set_id);
    let months = |badge: &Badge| {
        let parsed = dima_text::parse_int(&badge.info, dima_text::Radix::Auto);
        // `parseInt(x) || 0`: NaN and -0 are falsy.
        if parsed.is_nan() || parsed == 0.0 {
            0.0
        } else {
            parsed
        }
    };
    let mut labels: Vec<String> = Vec::new();
    let mut result = FormattedBadges::default();
    if find("broadcaster").is_some() {
        labels.push("[STREAMER]".to_owned());
        result.is_mod = true;
    } else if find("moderator").is_some() {
        labels.push("[MOD]".to_owned());
        result.is_mod = true;
    } else if find("vip").is_some() {
        labels.push("[VIP]".to_owned());
    }
    if let Some(founder) = find("founder") {
        result.sub_months = months(founder);
        labels.push(format!(
            "[FOUNDER {}M]",
            dima_text::number_to_string(result.sub_months)
        ));
        result.is_sub = true;
    } else if let Some(subscriber) = find("subscriber") {
        result.sub_months = months(subscriber);
        labels.push(format!(
            "[SUB {}M]",
            dima_text::number_to_string(result.sub_months)
        ));
        result.is_sub = true;
    }
    for (set_id, label) in [
        ("premium", "[PRIME]"),
        ("partner", "[PARTNER]"),
        ("staff", "[STAFF]"),
        ("turbo", "[TURBO]"),
        ("sub-gifter", "[SUB-GIFTER]"),
    ] {
        if find(set_id).is_some() {
            labels.push(label.to_owned());
        }
    }
    result.formatted_badges = if labels.is_empty() {
        String::new()
    } else {
        format!("{} ", labels.join(" "))
    };
    result.badge_list = labels;
    result
}
