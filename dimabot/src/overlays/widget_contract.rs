//! Portable widget definitions and configuration from `widget-contract.ts`.
//! Definitions are data rather than a kind switch: each entry owns its
//! placements, palette visibility, defaults, module field rules and optional
//! state binding. Only registered fields and supported placements are accepted,
//! without JavaScript coercion.

use crate::utils::{js_string::JsString, lossless_json::JsonValue};

/// Registered interaction state source identifier.
pub const INTERACTION_SOURCE: &str = "twitch-interactions";

/// Largest revision JavaScript represents as a safe integer (2^53 - 1).
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

/// Return whether a revision satisfies the source's `Number.isSafeInteger` and
/// non-negative checks. The registry applies this policy only to selected keys,
/// so an invalid unselected aggregate does not fail a selected one.
pub fn valid_revision(revision: f64) -> bool {
    revision.is_finite()
        && revision.fract() == 0.0
        && revision >= 0.0
        && revision <= MAX_SAFE_REVISION as f64
}

/// Supported placement of a widget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetPlacement {
    /// A scene widget.
    Scene,
    /// A design widget.
    Design,
}

/// Delivery mode of a widget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetDelivery {
    /// Static content.
    Static,
    /// Snapshot state.
    State,
    /// Transient events.
    Event,
}

/// Creation-palette visibility. A hidden placement remains valid for saved
/// widgets; placement support is tracked separately by the definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidgetPalette {
    /// Whether the scene creation palette shows the module.
    pub scene: bool,
    /// Whether the design creation palette shows the module.
    pub design: bool,
}

impl WidgetPalette {
    /// Visible in both supported palettes, the source default.
    pub const VISIBLE: Self = Self { scene: true, design: true };

    /// Supported scene widgets are omitted from the scene creation palette.
    pub const HIDDEN_SCENE: Self = Self { scene: false, design: true };

    /// Whether the creation palette shows this placement.
    pub const fn visible(self, placement: WidgetPlacement) -> bool {
        match placement {
            WidgetPlacement::Scene => self.scene,
            WidgetPlacement::Design => self.design,
        }
    }
}

/// One exact value accepted by a registered module field. Object and array
/// values are not represented because a JSON-parsed input can never share their
/// identity, which is how the source's `values.includes` compares them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WidgetFieldValue {
    /// JSON null.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number compared with SameValueZero.
    Number(f64),
    /// A string compared by content.
    String(&'static str),
}

impl WidgetFieldValue {
    fn matches(self, value: &JsonValue) -> bool {
        match (self, value) {
            (Self::Null, JsonValue::Null) => true,
            (Self::Bool(expected), JsonValue::Bool(actual)) => expected == *actual,
            (Self::Number(expected), JsonValue::Number(actual)) => {
                same_value_zero(expected, *actual)
            }
            (Self::String(expected), JsonValue::String(actual)) => {
                actual.as_str() == Some(expected)
            }
            _ => false,
        }
    }
}

fn same_value_zero(left: f64, right: f64) -> bool {
    left == right || (left.is_nan() && right.is_nan())
}

/// Registered module-owned field validation rule.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WidgetFieldRule {
    /// No value is accepted (the source's untyped field rule).
    Never,
    /// Exact membership in the source's `values` list.
    OneOf(&'static [WidgetFieldValue]),
    /// Non-empty string within a UTF-16 length bound (default 2000).
    String { max_length: Option<usize> },
    /// Finite number within inclusive bounds (default ±Number.MAX_VALUE).
    Number { min: Option<f64>, max: Option<f64> },
    /// Strict boolean.
    Boolean,
}

/// One registered module-owned field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidgetConfigField {
    /// Field name.
    pub name: &'static str,
    /// Rule applied to the field value.
    pub rule: WidgetFieldRule,
}

impl WidgetConfigField {
    /// Construct a registered field rule.
    pub const fn new(name: &'static str, rule: WidgetFieldRule) -> Self {
        Self { name, rule }
    }
}

/// Validate one registered module field without JavaScript coercion.
pub fn valid_module_value(field: &WidgetConfigField, value: &JsonValue) -> bool {
    match field.rule {
        WidgetFieldRule::Never => false,
        WidgetFieldRule::OneOf(values) => {
            values.iter().any(|expected| expected.matches(value))
        }
        WidgetFieldRule::String { max_length } => matches!(
            value,
            JsonValue::String(text)
                if !text.is_empty() && text.len() <= max_length.unwrap_or(2000)
        ),
        WidgetFieldRule::Number { min, max } => matches!(
            value,
            JsonValue::Number(number)
                if number.is_finite()
                    && *number >= min.unwrap_or(-f64::MAX)
                    && *number <= max.unwrap_or(f64::MAX)
        ),
        WidgetFieldRule::Boolean => matches!(value, JsonValue::Bool(_)),
    }
}

/// One module-owned default value. Arrays and objects are represented
/// recursively so any JSON default remains expressible in a const definition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WidgetDefaultValue {
    /// JSON null.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number.
    Number(f64),
    /// A string.
    String(&'static str),
    /// An array.
    Array(&'static [WidgetDefaultValue]),
    /// An object in source order.
    Object(&'static [(&'static str, WidgetDefaultValue)]),
}

impl WidgetDefaultValue {
    fn to_json(self) -> JsonValue {
        match self {
            Self::Null => JsonValue::Null,
            Self::Bool(value) => JsonValue::Bool(value),
            Self::Number(value) => JsonValue::Number(value),
            Self::String(value) => JsonValue::String(JsString::from_static(value)),
            Self::Array(values) => JsonValue::Array(
                values
                    .iter()
                    .map(|value| value.to_json())
                    .collect(),
            ),
            Self::Object(fields) => JsonValue::Object(
                fields
                    .iter()
                    .map(|(name, value)| (JsString::from_static(*name), value.to_json()))
                    .collect(),
            ),
        }
    }
}

/// One module-owned default field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidgetDefaultField {
    /// Field name.
    pub name: &'static str,
    /// Default value.
    pub value: WidgetDefaultValue,
}

impl WidgetDefaultField {
    /// Construct a module-owned default field.
    pub const fn new(name: &'static str, value: WidgetDefaultValue) -> Self {
        Self { name, value }
    }
}

/// Source and state key selected by a state-backed module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidgetStateBinding {
    /// Registered source identifier.
    pub source: &'static str,
    /// State key inside the source's public snapshot.
    pub state_key: &'static str,
}

/// A portable module definition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidgetDefinition {
    /// Registered kind.
    pub kind: &'static str,
    /// Current configuration version.
    pub config_version: u8,
    /// Supported placements.
    pub placements: &'static [WidgetPlacement],
    /// Delivery mode.
    pub delivery: WidgetDelivery,
    /// Initial width and height.
    pub default_size: (u16, u16),
    /// Creation-palette visibility.
    pub palette: WidgetPalette,
    /// Module-owned default fields.
    pub default_fields: &'static [WidgetDefaultField],
    /// Accepted module-owned configuration fields.
    pub fields: &'static [WidgetConfigField],
    /// Optional state source and key.
    pub state: Option<WidgetStateBinding>,
}

impl WidgetDefinition {
    /// Whether this definition supports a placement, independent of palette
    /// visibility.
    pub fn supports(&self, placement: WidgetPlacement) -> bool {
        self.placements.contains(&placement)
    }

    /// Whether the creation palette shows a supported placement.
    pub fn palette_visible(&self, placement: WidgetPlacement) -> bool {
        self.palette.visible(placement)
    }

    /// Obtain the module-owned default data as a fresh lossless object.
    pub fn defaults(&self) -> JsonValue {
        JsonValue::Object(
            self.default_fields
                .iter()
                .map(|field| (JsString::from_static(field.name), field.value.to_json()))
                .collect(),
        )
    }

    /// Return a copy bound to another state source and key.
    pub const fn with_state(self, source: &'static str, state_key: &'static str) -> Self {
        Self {
            kind: self.kind,
            config_version: self.config_version,
            placements: self.placements,
            delivery: self.delivery,
            default_size: self.default_size,
            palette: self.palette,
            default_fields: self.default_fields,
            fields: self.fields,
            state: Some(WidgetStateBinding { source, state_key }),
        }
    }
}

const SCENE: &[WidgetPlacement] = &[WidgetPlacement::Scene];
const DESIGN: &[WidgetPlacement] = &[WidgetPlacement::Design];
const BOTH: &[WidgetPlacement] = &[WidgetPlacement::Scene, WidgetPlacement::Design];

const NO_FIELDS: &[WidgetConfigField] = &[];
const NO_DEFAULTS: &[WidgetDefaultField] = &[];

const INTERACTION_FIELDS: &[WidgetConfigField] = &[WidgetConfigField::new(
    "interactionDesign",
    WidgetFieldRule::OneOf(&[
        WidgetFieldValue::String("card"),
        WidgetFieldValue::String("compact"),
    ]),
)];

const INTERACTION_DEFAULTS: &[WidgetDefaultField] = &[WidgetDefaultField::new(
    "interactionDesign",
    WidgetDefaultValue::String("card"),
)];

const ALERT_DEFAULTS: &[WidgetDefaultField] = &[WidgetDefaultField::new(
    "events",
    WidgetDefaultValue::Array(&[
        WidgetDefaultValue::String("sub"),
        WidgetDefaultValue::String("bits"),
        WidgetDefaultValue::String("follow"),
        WidgetDefaultValue::String("raid"),
    ]),
)];

const TEXT_DEFAULTS: &[WidgetDefaultField] = &[WidgetDefaultField::new(
    "text",
    WidgetDefaultValue::String("$(user)"),
)];

/// Poll widget definition.
pub const POLL_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "poll",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::State,
    default_size: (560, 360),
    palette: WidgetPalette::VISIBLE,
    default_fields: INTERACTION_DEFAULTS,
    fields: INTERACTION_FIELDS,
    state: Some(WidgetStateBinding {
        source: INTERACTION_SOURCE,
        state_key: "poll",
    }),
};

/// Prediction widget definition.
pub const PREDICTION_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "prediction",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::State,
    default_size: (560, 460),
    palette: WidgetPalette::VISIBLE,
    default_fields: INTERACTION_DEFAULTS,
    fields: INTERACTION_FIELDS,
    state: Some(WidgetStateBinding {
        source: INTERACTION_SOURCE,
        state_key: "prediction",
    }),
};

/// Text-to-speech widget definition.
pub const TTS_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "tts",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::Event,
    default_size: (580, 160),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Trigger widget definition.
pub const TRIGGER_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "trigger",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::Event,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Clip widget definition.
pub const CLIP_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "clip",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::Event,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Alert widget definition.
pub const ALERT_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "alert",
    config_version: 1,
    placements: SCENE,
    delivery: WidgetDelivery::Event,
    default_size: (640, 192),
    palette: WidgetPalette::VISIBLE,
    default_fields: ALERT_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Text widget definition. Its scene palette entry is hidden but saved scene
/// widgets remain valid.
pub const TEXT_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "text",
    config_version: 1,
    placements: BOTH,
    delivery: WidgetDelivery::Static,
    default_size: (400, 80),
    palette: WidgetPalette::HIDDEN_SCENE,
    default_fields: TEXT_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Image widget definition.
pub const IMAGE_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "image",
    config_version: 1,
    placements: BOTH,
    delivery: WidgetDelivery::Static,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Video widget definition.
pub const VIDEO_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "video",
    config_version: 1,
    placements: BOTH,
    delivery: WidgetDelivery::Static,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Animation widget definition.
pub const ANIMATION_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "animation",
    config_version: 1,
    placements: DESIGN,
    delivery: WidgetDelivery::Static,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// Shape widget definition.
pub const SHAPE_DEFINITION: WidgetDefinition = WidgetDefinition {
    kind: "shape",
    config_version: 1,
    placements: BOTH,
    delivery: WidgetDelivery::Static,
    default_size: (300, 180),
    palette: WidgetPalette::VISIBLE,
    default_fields: NO_DEFAULTS,
    fields: NO_FIELDS,
    state: None,
};

/// All registered built-in widget definitions, in source order.
pub static WIDGET_DEFINITIONS: [WidgetDefinition; 11] = [
    POLL_DEFINITION,
    PREDICTION_DEFINITION,
    TTS_DEFINITION,
    TRIGGER_DEFINITION,
    CLIP_DEFINITION,
    ALERT_DEFINITION,
    TEXT_DEFINITION,
    IMAGE_DEFINITION,
    VIDEO_DEFINITION,
    ANIMATION_DEFINITION,
    SHAPE_DEFINITION,
];

/// Find a registered definition by exact kind.
pub fn get_widget_definition(kind: &str) -> Option<&'static WidgetDefinition> {
    WIDGET_DEFINITIONS
        .iter()
        .find(|definition| definition.kind == kind)
}

/// Return the source's default module-owned fields for a known kind.
pub fn widget_defaults(kind: &str) -> Option<JsonValue> {
    get_widget_definition(kind).map(|definition| definition.defaults())
}

/// List kinds supporting a placement, including hidden palette entries.
pub fn widget_kinds(placement: WidgetPlacement) -> Vec<&'static str> {
    WIDGET_DEFINITIONS
        .iter()
        .filter(|definition| definition.supports(placement))
        .map(|definition| definition.kind)
        .collect()
}

/// Copied module fields, excluding unrelated host styling and media fields.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedWidgetModuleConfig {
    /// Explicit version, if supplied.
    pub config_version: Option<u8>,
    /// Explicit config, if supplied.
    pub config: Option<Vec<(JsString, JsonValue)>>,
    /// Accepted flattened module fields.
    pub legacy: Vec<(JsString, JsonValue)>,
}

fn field<'a>(raw: &'a [(JsString, JsonValue)], name: &str) -> Option<&'a JsonValue> {
    raw.iter()
        .rev()
        .find(|(key, _)| key.as_str() == Some(name))
        .map(|(_, value)| value)
}

fn registered_field_names() -> Vec<&'static str> {
    let mut names = Vec::new();
    for definition in &WIDGET_DEFINITIONS {
        for field in definition.fields {
            if !names.contains(&field.name) {
                names.push(field.name);
            }
        }
    }
    names
}

fn field_rule<'a>(
    definition: &'a WidgetDefinition,
    name: &str,
) -> Option<&'a WidgetConfigField> {
    definition.fields.iter().find(|field| field.name == name)
}

/// Validate and copy the registered module-owned configuration fields.
pub fn parse_widget_module_config(
    raw: &[(JsString, JsonValue)],
    placement: WidgetPlacement,
) -> Option<ParsedWidgetModuleConfig> {
    let JsonValue::String(kind) = field(raw, "kind")? else {
        return None;
    };
    let definition = get_widget_definition(kind.as_str()?)?;
    parse_widget_module_config_for(definition, raw, placement)
}

fn parse_widget_module_config_for(
    definition: &WidgetDefinition,
    raw: &[(JsString, JsonValue)],
    placement: WidgetPlacement,
) -> Option<ParsedWidgetModuleConfig> {
    if !definition.supports(placement) {
        return None;
    }
    // An omitted version means the legacy v1 shape, not "the current version".
    // A future definition at v2 therefore requires an explicit configVersion.
    let supplied_version = field(raw, "configVersion");
    let effective_version = match supplied_version {
        None => 1.0,
        Some(JsonValue::Number(version)) => *version,
        Some(_) => return None,
    };
    if effective_version != f64::from(definition.config_version) {
        return None;
    }
    let config_version = supplied_version.map(|_| definition.config_version);
    // The source validates every key registered by any definition, using this
    // definition's rule. A field owned by another module is rejected.
    let mut legacy = Vec::new();
    for name in registered_field_names() {
        let Some(value) = field(raw, name) else {
            continue;
        };
        let Some(rule) = field_rule(definition, name) else {
            return None;
        };
        if !valid_module_value(rule, value) {
            return None;
        }
        legacy.push((JsString::from_static(name), value.clone()));
    }
    let config = match field(raw, "config") {
        None => None,
        Some(JsonValue::Object(fields)) => {
            let mut copied = Vec::with_capacity(fields.len());
            for (key, value) in fields {
                let name = key.as_str()?;
                let Some(rule) = field_rule(definition, name) else {
                    return None;
                };
                if !valid_module_value(rule, value) {
                    return None;
                }
                copied.push((key.clone(), value.clone()));
            }
            Some(copied)
        }
        _ => return None,
    };
    Some(ParsedWidgetModuleConfig {
        config_version,
        config,
        legacy,
    })
}

/// Return whether module configuration is valid at this placement.
pub fn valid_widget_module_config(
    raw: &[(JsString, JsonValue)],
    placement: WidgetPlacement,
) -> bool {
    parse_widget_module_config(raw, placement).is_some()
}

/// A missing key is unavailable; `Null` clears a state explicitly.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetStateEntry {
    /// Source revision. The registry validates this for selected keys.
    pub revision: f64,
    /// Public aggregate state.
    pub state: JsonValue,
}

impl WidgetStateEntry {
    /// The source's explicit clear value: revision 0 and JSON null.
    pub fn cleared() -> Self {
        Self {
            revision: 0.0,
            state: JsonValue::Null,
        }
    }

    /// Serialize the public `{ revision, state }` entry.
    pub fn to_json(&self) -> JsonValue {
        JsonValue::Object(vec![
            (
                JsString::from_static("revision"),
                JsonValue::Number(self.revision),
            ),
            (JsString::from_static("state"), self.state.clone()),
        ])
    }
}

/// Public widget states by state key.
pub type WidgetStates = std::collections::BTreeMap<String, WidgetStateEntry>;

/// Public snapshot returned to a browser source.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetStateSnapshot {
    /// Selected states.
    pub widget_states: WidgetStates,
    /// Snapshot timestamp.
    pub server_time: i64,
    /// Failed provider names.
    pub failed_sources: Vec<String>,
}

impl WidgetStateSnapshot {
    /// Serialize the `{ widgetStates, serverTime, failedSources }` envelope.
    /// Keys follow this map's deterministic order rather than JavaScript
    /// insertion order; object key order is not significant to clients.
    pub fn to_json(&self) -> JsonValue {
        JsonValue::Object(vec![
            (
                JsString::from_static("widgetStates"),
                JsonValue::Object(
                    self.widget_states
                        .iter()
                        .map(|(key, entry)| (JsString::from(key.as_str()), entry.to_json()))
                        .collect(),
                ),
            ),
            (
                JsString::from_static("serverTime"),
                JsonValue::Number(self.server_time as f64),
            ),
            (
                JsString::from_static("failedSources"),
                JsonValue::Array(
                    self.failed_sources
                        .iter()
                        .map(|source| JsonValue::String(JsString::from(source.as_str())))
                        .collect(),
                ),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::lossless_json::parse_json;

    fn raw(kind: &str) -> Vec<(JsString, JsonValue)> {
        vec![(
            JsString::from_static("kind"),
            JsonValue::String(JsString::from(kind)),
        )]
    }

    fn put(fields: &mut Vec<(JsString, JsonValue)>, name: &'static str, value: JsonValue) {
        let key = JsString::from_static(name);
        if let Some(existing) = fields.iter_mut().find(|(candidate, _)| *candidate == key) {
            existing.1 = value;
        } else {
            fields.push((key, value));
        }
    }

    fn with_field(
        mut fields: Vec<(JsString, JsonValue)>,
        name: &'static str,
        value: JsonValue,
    ) -> Vec<(JsString, JsonValue)> {
        put(&mut fields, name, value);
        fields
    }

    #[test]
    fn definitions_match_the_portable_registry() {
        assert_eq!(WIDGET_DEFINITIONS.len(), 11);
        let unique: std::collections::BTreeSet<_> = WIDGET_DEFINITIONS
            .iter()
            .map(|definition| definition.kind)
            .collect();
        assert_eq!(unique.len(), WIDGET_DEFINITIONS.len());
        assert_eq!(
            widget_kinds(WidgetPlacement::Scene),
            vec![
                "poll",
                "prediction",
                "tts",
                "trigger",
                "clip",
                "alert",
                "text",
                "image",
                "video",
                "shape",
            ]
        );
        assert_eq!(
            widget_kinds(WidgetPlacement::Design),
            vec!["text", "image", "video", "animation", "shape"]
        );
        assert!(get_widget_definition("constructor").is_none());
        assert!(get_widget_definition("unregistered").is_none());
        assert_eq!(
            get_widget_definition("poll").expect("poll").delivery,
            WidgetDelivery::State
        );
        assert_eq!(
            get_widget_definition("text").expect("text").delivery,
            WidgetDelivery::Static
        );
        assert_eq!(
            get_widget_definition("alert").expect("alert").delivery,
            WidgetDelivery::Event
        );
    }

    #[test]
    fn palette_visibility_is_independent_from_placement_support() {
        let text = get_widget_definition("text").expect("text");
        assert!(text.supports(WidgetPlacement::Scene));
        assert!(!text.palette_visible(WidgetPlacement::Scene));
        assert!(text.supports(WidgetPlacement::Design));
        assert!(text.palette_visible(WidgetPlacement::Design));

        let animation = get_widget_definition("animation").expect("animation");
        assert!(!animation.supports(WidgetPlacement::Scene));
        assert!(animation.supports(WidgetPlacement::Design));

        assert!(widget_kinds(WidgetPlacement::Scene).contains(&"text"));
        assert!(!widget_kinds(WidgetPlacement::Scene).contains(&"animation"));
        assert!(widget_kinds(WidgetPlacement::Design).contains(&"animation"));
        assert!(!widget_kinds(WidgetPlacement::Design).contains(&"poll"));
    }

    #[test]
    fn definitions_own_their_defaults_sizes_and_state_bindings() {
        let interaction = parse_json(r#"{"interactionDesign":"card"}"#).expect("json");
        assert_eq!(POLL_DEFINITION.defaults(), interaction);
        assert_eq!(PREDICTION_DEFINITION.defaults(), interaction);
        assert_eq!(
            ALERT_DEFINITION.defaults(),
            parse_json(r#"{"events":["sub","bits","follow","raid"]}"#).expect("json")
        );
        assert_eq!(
            TEXT_DEFINITION.defaults(),
            parse_json(r#"{"text":"$(user)"}"#).expect("json")
        );
        for kind in [
            "tts", "trigger", "clip", "image", "video", "animation", "shape",
        ] {
            assert_eq!(
                get_widget_definition(kind).expect("definition").defaults(),
                JsonValue::Object(Vec::new())
            );
        }
        assert_eq!(POLL_DEFINITION.default_size, (560, 360));
        assert_eq!(PREDICTION_DEFINITION.default_size, (560, 460));
        assert_eq!(ALERT_DEFINITION.default_size, (640, 192));
        assert_eq!(TEXT_DEFINITION.default_size, (400, 80));
        assert_eq!(
            POLL_DEFINITION.state,
            Some(WidgetStateBinding {
                source: INTERACTION_SOURCE,
                state_key: "poll",
            })
        );
        assert_eq!(
            PREDICTION_DEFINITION.state,
            Some(WidgetStateBinding {
                source: INTERACTION_SOURCE,
                state_key: "prediction",
            })
        );
        assert_eq!(TEXT_DEFINITION.state, None);
        assert_eq!(widget_defaults("unregistered"), None);
    }

    #[test]
    fn with_state_preserves_every_other_definition_field() {
        const CUSTOM: WidgetDefinition = POLL_DEFINITION.with_state("custom", "value");
        assert_eq!(CUSTOM.kind, POLL_DEFINITION.kind);
        assert_eq!(CUSTOM.config_version, POLL_DEFINITION.config_version);
        assert_eq!(CUSTOM.placements, POLL_DEFINITION.placements);
        assert_eq!(CUSTOM.delivery, POLL_DEFINITION.delivery);
        assert_eq!(CUSTOM.default_size, POLL_DEFINITION.default_size);
        assert_eq!(CUSTOM.palette, POLL_DEFINITION.palette);
        assert_eq!(CUSTOM.default_fields, POLL_DEFINITION.default_fields);
        assert_eq!(CUSTOM.fields, POLL_DEFINITION.fields);
        assert_eq!(
            CUSTOM.state,
            Some(WidgetStateBinding {
                source: "custom",
                state_key: "value",
            })
        );
    }

    #[test]
    fn generic_field_rules_match_source_coercion_rules() {
        let one_of = WidgetConfigField::new(
            "design",
            WidgetFieldRule::OneOf(&[
                WidgetFieldValue::String("card"),
                WidgetFieldValue::String("compact"),
                WidgetFieldValue::Number(1.0),
                WidgetFieldValue::Bool(true),
                WidgetFieldValue::Null,
            ]),
        );
        assert!(valid_module_value(
            &one_of,
            &JsonValue::String("card".into())
        ));
        assert!(valid_module_value(
            &one_of,
            &JsonValue::Number(1.0)
        ));
        assert!(valid_module_value(&one_of, &JsonValue::Bool(true)));
        assert!(valid_module_value(&one_of, &JsonValue::Null));
        assert!(!valid_module_value(
            &one_of,
            &JsonValue::String("1".into())
        ));
        assert!(!valid_module_value(&one_of, &JsonValue::Number(2.0)));
        assert!(!valid_module_value(&one_of, &JsonValue::Bool(false)));

        let text = WidgetConfigField::new(
            "text",
            WidgetFieldRule::String {
                max_length: Some(2),
            },
        );
        assert!(valid_module_value(&text, &JsonValue::String("ab".into())));
        assert!(!valid_module_value(&text, &JsonValue::String("".into())));
        assert!(!valid_module_value(
            &text,
            &JsonValue::String("abc".into())
        ));
        // The source measures UTF-16 code units, so an emoji counts twice.
        assert!(!valid_module_value(&text, &JsonValue::String("a😀".into())));
        let default_text = WidgetConfigField::new(
            "text",
            WidgetFieldRule::String { max_length: None },
        );
        assert!(valid_module_value(
            &default_text,
            &JsonValue::String("a".repeat(2000).into())
        ));
        assert!(!valid_module_value(
            &default_text,
            &JsonValue::String("a".repeat(2001).into())
        ));

        let number = WidgetConfigField::new(
            "number",
            WidgetFieldRule::Number {
                min: Some(0.0),
                max: Some(2.0),
            },
        );
        assert!(valid_module_value(&number, &JsonValue::Number(0.0)));
        assert!(valid_module_value(&number, &JsonValue::Number(2.0)));
        assert!(!valid_module_value(&number, &JsonValue::Number(-0.1)));
        assert!(!valid_module_value(&number, &JsonValue::Number(2.1)));
        assert!(!valid_module_value(&number, &JsonValue::Number(f64::NAN)));
        assert!(!valid_module_value(
            &number,
            &JsonValue::Number(f64::INFINITY)
        ));
        assert!(!valid_module_value(
            &number,
            &JsonValue::String("1".into())
        ));

        let boolean = WidgetConfigField::new("enabled", WidgetFieldRule::Boolean);
        assert!(valid_module_value(&boolean, &JsonValue::Bool(false)));
        assert!(!valid_module_value(&boolean, &JsonValue::Number(0.0)));

        let never = WidgetConfigField::new("untyped", WidgetFieldRule::Never);
        assert!(!valid_module_value(&never, &JsonValue::Null));
        assert!(!valid_module_value(
            &never,
            &JsonValue::String("x".into())
        ));
    }

    #[test]
    fn generic_default_values_serialize() {
        for (value, expected) in [
            (WidgetDefaultValue::Null, JsonValue::Null),
            (WidgetDefaultValue::Bool(true), JsonValue::Bool(true)),
            (WidgetDefaultValue::Number(2.0), JsonValue::Number(2.0)),
            (
                WidgetDefaultValue::String("x"),
                JsonValue::String("x".into()),
            ),
            (
                WidgetDefaultValue::Array(&[
                    WidgetDefaultValue::String("a"),
                    WidgetDefaultValue::String("b"),
                ]),
                JsonValue::Array(vec![
                    JsonValue::String("a".into()),
                    JsonValue::String("b".into()),
                ]),
            ),
            (
                WidgetDefaultValue::Object(&[(
                    "nested",
                    WidgetDefaultValue::Array(&[WidgetDefaultValue::Number(1.0)]),
                )]),
                parse_json(r#"{"nested":[1]}"#).expect("json"),
            ),
        ] {
            assert_eq!(value.to_json(), expected);
        }
    }

    #[test]
    fn accepts_registered_legacy_and_nested_config() {
        for value in [
            raw("poll"),
            with_field(raw("poll"), "configVersion", JsonValue::Number(1.0)),
            with_field(
                raw("poll"),
                "interactionDesign",
                JsonValue::String("compact".into()),
            ),
            with_field(
                raw("poll"),
                "config",
                parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
            ),
            with_field(
                raw("alert"),
                "config",
                JsonValue::Object(Vec::new()),
            ),
        ] {
            assert!(
                valid_widget_module_config(&value, WidgetPlacement::Scene),
                "{value:?}"
            );
        }
    }

    #[test]
    fn rejects_wrong_versions_placements_and_unregistered_fields() {
        let invalid = [
            with_field(
                raw("poll"),
                "interactionDesign",
                JsonValue::String("script".into()),
            ),
            with_field(
                raw("poll"),
                "config",
                parse_json(r#"{"goalID":"private"}"#).expect("json"),
            ),
            with_field(
                raw("poll"),
                "config",
                parse_json(r#"{"interactionDesign":"script"}"#).expect("json"),
            ),
            with_field(
                raw("poll"),
                "config",
                parse_json(r#"{"interactionDesign":"card","goalID":"x"}"#).expect("json"),
            ),
            with_field(raw("poll"), "config", JsonValue::Array(Vec::new())),
            with_field(raw("poll"), "config", JsonValue::Null),
            with_field(
                raw("poll"),
                "config",
                JsonValue::String("card".into()),
            ),
            with_field(raw("poll"), "configVersion", JsonValue::Number(2.0)),
            with_field(raw("poll"), "configVersion", JsonValue::Number(0.0)),
            with_field(raw("poll"), "configVersion", JsonValue::Number(1.5)),
            with_field(raw("poll"), "configVersion", JsonValue::Null),
            with_field(
                raw("poll"),
                "configVersion",
                JsonValue::String("1".into()),
            ),
        ];
        for value in invalid {
            assert!(
                !valid_widget_module_config(&value, WidgetPlacement::Scene),
                "{value:?}"
            );
        }
        assert!(!valid_widget_module_config(
            &raw("poll"),
            WidgetPlacement::Design
        ));
        assert!(!valid_widget_module_config(
            &raw("animation"),
            WidgetPlacement::Scene
        ));
        assert!(valid_widget_module_config(
            &raw("animation"),
            WidgetPlacement::Design
        ));
        assert!(valid_widget_module_config(
            &raw("text"),
            WidgetPlacement::Scene
        ));

        let mut text = with_field(raw("poll"), "kind", JsonValue::String("text".into()));
        put(
            &mut text,
            "interactionDesign",
            JsonValue::String("card".into()),
        );
        assert!(!valid_widget_module_config(&text, WidgetPlacement::Scene));

        let mut nested = raw("tts");
        put(
            &mut nested,
            "config",
            parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
        );
        assert!(!valid_widget_module_config(&nested, WidgetPlacement::Scene));
    }

    #[test]
    fn parsed_module_config_is_an_exact_independent_copy() {
        let mut value = raw("poll");
        put(&mut value, "configVersion", JsonValue::Number(1.0));
        put(
            &mut value,
            "interactionDesign",
            JsonValue::String("compact".into()),
        );
        put(
            &mut value,
            "config",
            parse_json(r#"{"interactionDesign":"card"}"#).expect("json"),
        );
        put(
            &mut value,
            "discarded",
            JsonValue::String("secret".into()),
        );
        let parsed = parse_widget_module_config(&value, WidgetPlacement::Scene).expect("valid poll");
        assert_eq!(
            parsed,
            ParsedWidgetModuleConfig {
                config_version: Some(1),
                config: Some(vec![(
                    JsString::from_static("interactionDesign"),
                    JsonValue::String("card".into()),
                )]),
                legacy: vec![(
                    JsString::from_static("interactionDesign"),
                    JsonValue::String("compact".into()),
                )],
            }
        );
        if let Some((_, JsonValue::Object(fields))) = value
            .iter_mut()
            .find(|(key, _)| key.as_str() == Some("config"))
        {
            fields[0].1 = JsonValue::String("compact".into());
        }
        assert_eq!(
            parsed.config,
            Some(vec![(
                JsString::from_static("interactionDesign"),
                JsonValue::String("card".into()),
            )])
        );
        assert_eq!(
            parse_widget_module_config(&raw("poll"), WidgetPlacement::Scene)
                .expect("missing version")
                .config_version,
            None
        );
    }

    #[test]
    fn revision_policy_matches_safe_integer_and_non_negative() {
        for revision in [0.0, -0.0, 1.0, MAX_SAFE_REVISION as f64] {
            assert!(valid_revision(revision), "{revision}");
        }
        for revision in [
            -1.0,
            0.5,
            MAX_SAFE_REVISION as f64 + 1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert!(!valid_revision(revision), "{revision}");
        }
    }

    #[test]
    fn an_omitted_version_is_only_the_legacy_v1_shape() {
        let mut version_two = POLL_DEFINITION;
        version_two.config_version = 2;
        assert!(parse_widget_module_config_for(
            &version_two,
            &raw("poll"),
            WidgetPlacement::Scene
        )
        .is_none());

        let mut explicit = raw("poll");
        put(
            &mut explicit,
            "configVersion",
            JsonValue::Number(2.0),
        );
        assert_eq!(
            parse_widget_module_config_for(
                &version_two,
                &explicit,
                WidgetPlacement::Scene
            )
            .expect("v2")
            .config_version,
            Some(2)
        );

        let mut legacy = raw("poll");
        put(&mut legacy, "configVersion", JsonValue::Number(1.0));
        assert!(parse_widget_module_config_for(
            &version_two,
            &legacy,
            WidgetPlacement::Scene
        )
        .is_none());
    }

    #[test]
    fn widget_state_entries_and_snapshots_serialize_the_source_envelope() {
        assert_eq!(
            WidgetStateEntry::cleared(),
            WidgetStateEntry {
                revision: 0.0,
                state: JsonValue::Null,
            }
        );
        let mut states = WidgetStates::new();
        states.insert(
            "poll".into(),
            WidgetStateEntry {
                revision: MAX_SAFE_REVISION as f64,
                state: JsonValue::String("paid".into()),
            },
        );
        let snapshot = WidgetStateSnapshot {
            widget_states: states,
            server_time: 42,
            failed_sources: vec![INTERACTION_SOURCE.to_owned()],
        };
        assert_eq!(
            snapshot.to_json(),
            parse_json(
                r#"{"widgetStates":{"poll":{"revision":9007199254740991,"state":"paid"}},"serverTime":42,"failedSources":["twitch-interactions"]}"#
            )
            .expect("json")
        );
    }
}
