//! Scene and alert selection rules from `model.ts`.
//! Ordered subscription and raid variants choose the first match; Bits uses
//! the matched shared rule, and unrecognized or malformed input uses defaults.

use crate::utils::{js_string::JsString, lossless_json::JsonValue};

/// Available clip designs.
pub const CLIP_DESIGN_VARIANTS: [&str; 8] = ["classic", "third", "tile", "cinema", "orbit", "pill", "hud", "slash"];
/// Supported transition names.
pub const ALERT_TRANSITIONS: [&str; 10] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom", "bounce", "flip", "spin"];
/// Supported loop names.
pub const ALERT_LOOPS: [&str; 5] = ["none", "pulse", "float", "sway", "spin"];
/// Alert event names in source order.
pub const ALERT_EVENTS: [&str; 4] = ["sub", "bits", "follow", "raid"];
/// Overlay event names in source order.
pub const EVENT_KINDS: [&str; 7] = ["tts", "trigger", "clip", "sub", "bits", "follow", "raid"];
/// Legacy editor storage key.
pub const STORAGE_KEY: &str = "domdimabot-overlay-editor-mock-v2";
fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(key, value)| (key.into(), value)).collect())
}
fn text(value: &str) -> JsonValue { JsonValue::String(value.into()) }
fn number(value: f64) -> JsonValue { JsonValue::Number(value) }
fn widget(id: &str, kind: &str, x: f64, y: f64, width: f64, height: f64) -> JsonValue {
    object(vec![("id", text(id)), ("kind", text(kind)), ("x", number(x)), ("y", number(y)),
        ("width", number(width)), ("height", number(height)), ("visible", JsonValue::Bool(true)),
        ("locked", JsonValue::Bool(false))])
}
fn append_field(value: &mut JsonValue, key: &str, field: JsonValue) {
    if let JsonValue::Object(fields) = value { fields.push((key.into(), field)); }
}
/// Construct the source's starter alert design.
pub fn make_design(id: &str, name: &str) -> AlertDesign {
    let events = ALERT_EVENTS.iter().map(|event| {
        let art = widget(&format!("{event}-art"), "animation", 50.0, 50.0, 120.0, 120.0);
        let mut caption = widget(&format!("{event}-text"), "text", 190.0, 65.0, 530.0, 90.0);
        append_field(&mut caption, "text", text("$(user)"));
        ((*event).into(), object(vec![("duration", number(5.0)), ("widgets", JsonValue::Array(vec![art, caption]))]))
    }).collect();
    object(vec![("id", text(id)), ("name", text(name)), ("revision", number(1.0)),
        ("width", number(800.0)), ("height", number(240.0)), ("events", JsonValue::Object(events))])
}
/// Construct the source's starter scene and its four visible widgets.
pub fn make_scene(id: &str, name: &str, design_id: &str) -> OverlayScene {
    let tts = widget("tts-1", "tts", 670.0, 62.0, 580.0, 160.0);
    let trigger = widget("trigger-1", "trigger", 75.0, 755.0, 510.0, 230.0);
    let clip = widget("clip-1", "clip", 1410.0, 775.0, 430.0, 250.0);
    let mut alert = widget("alert-1", "alert", 640.0, 450.0, 640.0, 192.0);
    append_field(&mut alert, "designId", text(design_id));
    append_field(&mut alert, "events", JsonValue::Array(ALERT_EVENTS.iter().map(|item| text(item)).collect()));
    object(vec![("id", text(id)), ("name", text(name)), ("width", number(1920.0)),
        ("height", number(1080.0)), ("revision", number(0.0)), ("publicId", text(&format!("mock-{id}"))),
        ("waitFor", JsonValue::Array(["tts", "trigger", "bits", "follow"].iter().map(|item| text(item)).collect())),
        ("widgets", JsonValue::Array(vec![tts, trigger, clip, alert]))])
}
/// Lossless representation of a persisted overlay scene.
pub type OverlayScene = JsonValue;
/// Lossless representation of an alert design.
pub type AlertDesign = JsonValue;
/// Lossless representation of an alert layout.
pub type AlertLayout = JsonValue;
/// Lossless representation of a scene widget.
pub type OverlayWidget = JsonValue;
/// Alert event discriminator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertEvent { /// Subscription.
    Sub, /// Cheer.
    Bits, /// Follow.
    Follow, /// Raid.
    Raid }
impl AlertEvent {
    /// Wire spelling of the event.
    pub fn as_str(self) -> &'static str {
        match self { Self::Sub => "sub", Self::Bits => "bits", Self::Follow => "follow", Self::Raid => "raid" }
    }
}
fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value { JsonValue::Object(fields) => fields.iter().find(|(key, _)| key.as_str() == Some(name)).map(|(_, value)| value), _ => None }
}
fn str_field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsString> {
    match field(value, name) { Some(JsonValue::String(value)) => Some(value), _ => None }
}
/// An absent trigger selection means all; an explicit empty list means none.
pub fn matches_trigger(widget: &OverlayWidget, trigger_id: Option<&JsString>) -> bool {
    match field(widget, "triggerIds") {
        None => true,
        Some(JsonValue::Array(ids)) => trigger_id.is_some_and(|id| !id.is_empty() && ids.iter().any(|value| matches!(value, JsonValue::String(selected) if selected == id))),
        _ => false,
    }
}
/// Find the first applicable variant, returning no match for malformed input.
pub fn matching_variant<'a>(design: &'a AlertDesign, kind: AlertEvent, raw: &JsonValue, bits_rule_id: Option<&JsString>) -> Option<&'a JsonValue> {
    if kind == AlertEvent::Follow { return None; }
    let JsonValue::Array(variants) = field(field(design, "variants")?, kind.as_str())? else { return None };
    variants.iter().find(|variant| match kind {
        AlertEvent::Bits => bits_rule_id.is_some_and(|id| str_field(variant, "ruleId") == Some(id)),
        AlertEvent::Sub => matches!(field(variant, "enabled"), Some(JsonValue::Bool(true))) && str_field(variant, "tier").is_some_and(|tier| !tier.is_empty() && Some(tier) == str_field(raw, "tier")),
        AlertEvent::Raid => {
            if !matches!(field(variant, "enabled"), Some(JsonValue::Bool(true))) { return false; }
            let Some(JsonValue::Number(amount)) = field(raw, "viewers") else { return false };
            if !amount.is_finite() || amount.fract() != 0.0 || *amount < 0.0 || *amount > 9_007_199_254_740_991.0 { return false; }
            let min = match field(variant, "min") { None | Some(JsonValue::Null) => 0.0, Some(JsonValue::Number(n)) => *n, _ => return false };
            let max = match field(variant, "max") { None => f64::INFINITY, Some(JsonValue::Number(n)) => *n, _ => return false };
            *amount >= min && *amount <= max
        }
        AlertEvent::Follow => false,
    })
}
/// Select a variant layout or the default layout for an alert.
pub fn select_alert_layout<'a>(design: &'a AlertDesign, kind: AlertEvent, raw: &JsonValue, bits_rule_id: Option<&JsString>) -> Option<&'a AlertLayout> {
    matching_variant(design, kind, raw, bits_rule_id).and_then(|variant| field(variant, "layout")).or_else(|| field(field(design, "events")?, kind.as_str()))
}
/// Gather default and variant layouts in source object order.
pub fn design_layouts(design: &AlertDesign) -> Vec<&AlertLayout> {
    let mut result = Vec::new();
    if let Some(JsonValue::Object(events)) = field(design, "events") { result.extend(events.iter().map(|(_, value)| value)); }
    if let Some(JsonValue::Object(variants)) = field(design, "variants") {
        for (_, value) in variants {
            if let JsonValue::Array(items) = value { result.extend(items.iter().filter_map(|variant| field(variant, "layout"))); }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn obj(items: Vec<(&str, JsonValue)>) -> JsonValue { JsonValue::Object(items.into_iter().map(|(k, v)| (k.into(), v)).collect()) }
    fn s(value: &str) -> JsonValue { JsonValue::String(value.into()) }
    #[test]
    fn trigger_selection_distinguishes_missing_and_empty() {
        assert!(matches_trigger(&obj(vec![]), None));
        assert!(!matches_trigger(&obj(vec![("triggerIds", JsonValue::Array(vec![]))]), Some(&"x".into())));
        assert!(matches_trigger(&obj(vec![("triggerIds", JsonValue::Array(vec![s("x")]))]), Some(&"x".into())));
    }
    #[test]
    fn bits_uses_shared_rule_even_if_variant_disabled() {
        let variant = obj(vec![("ruleId", s("r")), ("enabled", JsonValue::Bool(false)), ("layout", s("chosen"))]);
        let design = obj(vec![("events", obj(vec![("bits", s("default"))])), ("variants", obj(vec![("bits", JsonValue::Array(vec![variant]))]))]);
        assert_eq!(select_alert_layout(&design, AlertEvent::Bits, &obj(vec![]), Some(&"r".into())), Some(&s("chosen")));
        assert_eq!(select_alert_layout(&design, AlertEvent::Bits, &obj(vec![]), None), Some(&s("default")));
    }
    #[test]
    fn raid_rejects_noninteger_amount() {
        let variant = obj(vec![("enabled", JsonValue::Bool(true)), ("layout", s("chosen"))]);
        let design = obj(vec![("events", obj(vec![("raid", s("default"))])), ("variants", obj(vec![("raid", JsonValue::Array(vec![variant]))]))]);
        assert_eq!(select_alert_layout(&design, AlertEvent::Raid, &obj(vec![("viewers", JsonValue::Number(1.5))]), None), Some(&s("default")));
    }
    #[test]
    fn starter_scene_and_design_have_source_defaults() {
        let design = make_design("starter", "My alerts");
        let scene = make_scene("main", "My overlay", "starter");
        assert_eq!(field(&design, "width"), Some(&JsonValue::Number(800.0)));
        assert_eq!(field(&scene, "publicId"), Some(&s("mock-main")));
        assert_eq!(field(&scene, "waitFor"), Some(&JsonValue::Array(vec![s("tts"), s("trigger"), s("bits"), s("follow")])));
    }
}
