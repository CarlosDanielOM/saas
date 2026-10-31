//! Native definition of the `Event` model from `event.schema.ts`.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use mongodb::bson::{Bson, DateTime, oid::ObjectId};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "Event";
pub const COLLECTION_NAME: &str = "events";
pub const RELEASE_STAGES: &[&str] = &[
    "stable",
    "beta",
    "alpha",
    "maintenance",
    "coming_soon",
    "unavailable",
    "deprecated",
];
pub const PLAN_TIERS: &[&str] = &["free", "premium", "pro"];
pub const CONFIG_TYPES: &[&str] = &["text", "number", "checkbox", "select", "message-tiers"];

fn translated_fields() -> Vec<Field> {
    vec![
        Field::new("EN", T::String).required().trim(),
        Field::new("ES", T::String).required().trim(),
    ]
}

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: Some("updatedAt"),
        indexes: vec![],
        fields: vec![
            Field::new("name", T::String).required().trim(),
            Field::new("type", T::String).required().trim(),
            Field::new("version", T::String)
                .required()
                .default(D::String("1")),
            Field::new("condition", T::Mixed).required().minimize(),
            Field::new("icon", T::String).required().trim(),
            Field::new("color", T::String).required().trim(),
            Field::new("textColor", T::String).required().trim(),
            Field::new("releaseStage", T::String)
                .enumeration(RELEASE_STAGES)
                .default(D::String("stable")),
            Field::new("enabled", T::Boolean).default(D::Boolean(false)),
            Field::new("plan_tier", T::String)
                .enumeration(PLAN_TIERS)
                .default(D::String("free")),
            Field::new("description", T::Object(translated_fields())),
            Field::new(
                "config",
                T::Array(Box::new(T::Subdocument {
                    generate_id: true,
                    fields: vec![
                        Field::new("id", T::String).required().trim(),
                        Field::new("dbId", T::String).trim(),
                        Field::new("label", T::Object(translated_fields())),
                        Field::new("type", T::String)
                            .required()
                            .enumeration(CONFIG_TYPES)
                            .default(D::String("text")),
                        Field::new("value", T::Mixed).required().minimize(),
                        Field::new("canDisable", T::Boolean).default(D::Boolean(false)),
                        Field::new("placeholder", T::String).trim(),
                        Field::new(
                            "showIf",
                            T::Subdocument {
                                generate_id: false,
                                fields: vec![
                                    Field::new("controlId", T::String).required(),
                                    Field::new("is", T::Mixed).required().minimize(),
                                ],
                            },
                        ),
                    ],
                })),
            )
            .default(D::Array),
            Field::new(
                "tierLimits",
                T::Object(vec![
                    Field::new("free", T::Number).default(D::Number(0.0)),
                    Field::new("premium", T::Number).default(D::Number(2.0)),
                    Field::new("pro", T::Number).default(D::Number(5.0)),
                ]),
            ),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new("updatedAt", T::Date).default(D::Now),
        ],
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct IEventConfigLabel {
    pub en: String,
    pub es: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IEventConfigShowIf {
    pub control_id: String,
    pub is: Bson,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IEventConfig {
    pub id: String,
    pub db_id: Option<String>,
    pub label: IEventConfigLabel,
    pub kind: String,
    pub value: Bson,
    pub can_disable: bool,
    pub placeholder: Option<String>,
    pub show_if: Option<IEventConfigShowIf>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IEventTierLimits {
    pub free: f64,
    pub premium: f64,
    pub pro: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IEventDescription {
    pub en: String,
    pub es: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IEvent {
    pub id: ObjectId,
    pub name: String,
    pub kind: String,
    pub version: String,
    pub condition: Bson,
    pub icon: String,
    pub color: String,
    pub text_color: String,
    pub release_stage: String,
    pub enabled: bool,
    pub plan_tier: String,
    pub description: IEventDescription,
    pub config: Vec<IEventConfig>,
    pub tier_limits: IEventTierLimits,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

/// Cast one ordinary update path through the shared schema framework. Query
/// updates do not run save hooks, required checks, or enum validators.
pub fn cast_update_value(path: &str, value: Bson) -> Result<Option<Bson>, super::ValidationErrors> {
    fn lookup(fields: &[Field], parts: &[&str]) -> Option<Field> {
        let field = fields.iter().find(|f| f.name == parts[0])?;
        if parts.len() == 1 {
            return Some(field.clone());
        }
        match &field.kind {
            T::Mixed => Some(Field::new("value", T::Mixed)),
            T::Object(children)
            | T::Subdocument {
                fields: children, ..
            } => lookup(children, &parts[1..]),
            T::Array(element) if parts[1].parse::<usize>().is_ok() || parts[1] == "$" => {
                if parts.len() == 2 {
                    Some(Field::new("value", *element.clone()))
                } else if let T::Subdocument { fields, .. } = element.as_ref() {
                    lookup(fields, &parts[2..])
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    fn unvalidated(mut field: Field, defaults: bool) -> Field {
        field.required = false;
        field.required_when = None;
        field.required_unless = None;
        field.enum_values = &[];
        field.min = None;
        field.max = None;
        field.max_utf16 = None;
        field.integer = false;
        field.minimize = false;
        if !defaults {
            field.default = D::Missing;
        }
        fn kind(value: T) -> T {
            match value {
                T::Object(fields) => {
                    T::Object(fields.into_iter().map(|f| unvalidated(f, false)).collect())
                }
                T::Subdocument {
                    fields,
                    generate_id,
                } => T::Subdocument {
                    fields: fields.into_iter().map(|f| unvalidated(f, true)).collect(),
                    generate_id,
                },
                T::Array(element) => T::Array(Box::new(kind(*element))),
                other => other,
            }
        }
        field.kind = kind(field.kind);
        field
    }
    let field = if path == "_id" {
        Some(Field::new("_id", T::ObjectId))
    } else if path == "__v" {
        Some(Field::new("__v", T::Number))
    } else {
        lookup(&schema().fields, &path.split('.').collect::<Vec<_>>())
    };
    let Some(field) = field else {
        return Ok(None);
    };
    let name = field.name;
    let mut partial = schema().clone();
    partial.fields = vec![unvalidated(field, false)];
    partial.string_id = true;
    partial.version_key = false;
    partial.timestamps = None;
    partial.save_clock_field = None;
    let mut input = mongodb::bson::Document::new();
    input.insert(name, value);
    Ok(partial.construct(&input, DateTime::now())?.remove(name))
}
