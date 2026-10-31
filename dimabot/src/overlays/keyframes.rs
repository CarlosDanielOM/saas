//! Portable overlay animation validation from `keyframes.ts`.
//! Only bounded known properties, ordered points, and closed loops are accepted;
//! arbitrary CSS and executable values are not interpreted.

use crate::utils::lossless_json::JsonValue;

/// Accepted animation phases.
pub const MOTION_PHASES: [&str; 3] = ["enter", "loop", "exit"];
/// Accepted animated properties.
pub const MOTION_PROPERTIES: [&str; 5] = ["x", "y", "scale", "rotation", "opacity"];
/// Accepted interpolation names.
pub const MOTION_EASINGS: [&str; 9] = ["linear", "smooth", "ease-in", "ease-out", "soft", "snappy", "sine-in", "sine-out", "hold"];

/// Resting value of a known property, or `None` for an unknown property.
pub fn neutral_value(property: &str) -> Option<f64> {
    match property {
        "opacity" | "scale" => Some(1.0),
        "x" | "y" | "rotation" => Some(0.0),
        _ => None,
    }
}

fn object(value: &JsonValue) -> Option<&[(crate::utils::js_string::JsString, JsonValue)]> {
    match value { JsonValue::Object(fields) => Some(fields), _ => None }
}
fn field<'a>(fields: &'a [(crate::utils::js_string::JsString, JsonValue)], name: &str) -> Option<&'a JsonValue> {
    fields.iter().find(|(key, _)| key.as_str() == Some(name)).map(|(_, value)| value)
}
fn string(value: &JsonValue) -> Option<&str> {
    match value { JsonValue::String(value) => value.as_str(), _ => None }
}
fn number(value: &JsonValue) -> Option<f64> {
    match value { JsonValue::Number(value) if value.is_finite() => Some(*value), _ => None }
}

/// Validate an untrusted animation value using the source's bounds and ordering.
pub fn valid_keyframes(value: &JsonValue) -> bool {
    let Some(phases) = object(value) else { return false };
    for (phase, sequence) in phases {
        let Some(phase) = phase.as_str() else { return false };
        if !MOTION_PHASES.contains(&phase) { return false; }
        let Some(sequence) = object(sequence) else { return false };
        let Some(JsonValue::Array(tracks)) = field(sequence, "tracks") else { return false };
        if !(1..=5).contains(&tracks.len()) { return false; }
        let mut seen = Vec::new();
        for track in tracks {
            let Some(track) = object(track) else { return false };
            let Some(property) = field(track, "property").and_then(string) else { return false };
            let limits = match property {
                "x" | "y" => (-400.0, 400.0),
                "scale" => (0.0, 4.0),
                "rotation" => (-1440.0, 1440.0),
                "opacity" => (0.0, 1.0),
                _ => return false,
            };
            if seen.contains(&property) { return false; }
            seen.push(property);
            let Some(JsonValue::Array(points)) = field(track, "points") else { return false };
            if !(2..=24).contains(&points.len()) { return false; }
            let mut previous = -1.0;
            let mut first_value = 0.0;
            let mut last_value = 0.0;
            for (index, point) in points.iter().enumerate() {
                let Some(point) = object(point) else { return false };
                let Some(offset) = field(point, "offset").and_then(number) else { return false };
                let Some(value) = field(point, "value").and_then(number) else { return false };
                let Some(easing) = field(point, "easing").and_then(string) else { return false };
                if !(0.0..=1.0).contains(&offset) || offset - previous < 0.000999
                    || !(limits.0..=limits.1).contains(&value) || !MOTION_EASINGS.contains(&easing)
                    || (index == 0 && offset != 0.0) || (index == points.len() - 1 && offset != 1.0) {
                    return false;
                }
                if index == 0 { first_value = value; }
                last_value = value;
                previous = offset;
            }
            if phase == "loop" && first_value != last_value { return false; }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn point(offset: f64, value: f64) -> JsonValue {
        JsonValue::Object(vec![("offset".into(), JsonValue::Number(offset)), ("value".into(), JsonValue::Number(value)), ("easing".into(), JsonValue::String("linear".into()))])
    }
    fn sequence(phase: &str, end: f64) -> JsonValue {
        JsonValue::Object(vec![(phase.into(), JsonValue::Object(vec![("tracks".into(), JsonValue::Array(vec![JsonValue::Object(vec![("property".into(), JsonValue::String("opacity".into())), ("points".into(), JsonValue::Array(vec![point(0.0, 0.0), point(1.0, end)]))])]))]))])
    }
    #[test]
    fn validates_bounded_animation_and_closed_loop() {
        assert!(valid_keyframes(&sequence("enter", 1.0)));
        assert!(valid_keyframes(&sequence("loop", 0.0)));
        assert!(!valid_keyframes(&sequence("loop", 1.0)));
        assert!(!valid_keyframes(&sequence("enter", 2.0)));
        assert!(!valid_keyframes(&sequence("unknown", 0.0)));
    }
    #[test]
    fn neutral_values_match_source() {
        assert_eq!(neutral_value("scale"), Some(1.0));
        assert_eq!(neutral_value("x"), Some(0.0));
        assert_eq!(neutral_value("unknown"), None);
    }
}
