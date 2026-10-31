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

/// Event query updates reuse native schema casts, without validators/save hooks.
/// Array insertions materialize defaults/IDs; `$pull` uses query predicates.
fn update_field(path: &str) -> Option<Field> {
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
            T::Array(element) => {
                let positional =
                    parts[1].parse::<usize>().is_ok() || parts[1] == "$" || parts[1] == "$[]";
                let rest = if positional { &parts[2..] } else { &parts[1..] };
                if rest.is_empty() {
                    return Some(Field::new("value", *element.clone()));
                }
                if let T::Subdocument {
                    fields,
                    generate_id,
                } = element.as_ref()
                {
                    if *generate_id && rest == ["_id"] {
                        return Some(Field::new("_id", T::ObjectId));
                    }
                    lookup(fields, rest)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    match path {
        "_id" => Some(Field::new("_id", T::ObjectId)),
        "__v" => Some(Field::new("__v", T::Number)),
        _ => lookup(&schema().fields, &path.split('.').collect::<Vec<_>>()),
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
fn invalid() -> super::ValidationErrors {
    super::ValidationErrors(vec![super::FieldError {
        path: "update".into(),
        kind: "cast",
    }])
}
fn cast_field(field: Field, value: Bson) -> Result<Bson, super::ValidationErrors> {
    let field = unvalidated(field, false);
    // Mongoose document-array query casts retain subdocument cast errors rather
    // than running validation. Failed child setters leave their default/absence.
    let value = match (&field.kind, value) {
        (T::Subdocument { fields, .. }, Bson::Document(mut doc)) => {
            for child in fields {
                if let Some(raw) = doc.get(child.name).cloned()
                    && cast_field(child.clone(), raw).is_err()
                {
                    doc.remove(child.name);
                }
            }
            Bson::Document(doc)
        }
        (T::Array(element), Bson::Array(values))
            if matches!(element.as_ref(), T::Subdocument { .. }) =>
        {
            return values
                .into_iter()
                .map(|v| cast_field(Field::new("value", *element.clone()), v))
                .collect::<Result<Vec<_>, _>>()
                .map(Bson::Array);
        }
        (_, value) => value,
    };
    let name = field.name;
    let mut partial = schema().clone();
    partial.fields = vec![field];
    partial.string_id = true;
    partial.version_key = false;
    partial.timestamps = None;
    partial.save_clock_field = None;
    let mut input = mongodb::bson::Document::new();
    input.insert(name, value);
    Ok(partial
        .construct(&input, DateTime::now())?
        .remove(name)
        .unwrap_or(Bson::Null))
}
pub fn cast_update_value(path: &str, value: Bson) -> Result<Option<Bson>, super::ValidationErrors> {
    update_field(path).map(|f| cast_field(f, value)).transpose()
}
fn number(value: Bson) -> Result<Bson, super::ValidationErrors> {
    let value = cast_field(Field::new("value", T::Number), value)?;
    if let Bson::Double(n) = value
        && n.fract() == 0.0
        && n >= i32::MIN as f64
        && n <= i32::MAX as f64
    {
        return Ok(Bson::Int32(n as i32));
    }
    Ok(value)
}
fn truthy(value: &Bson) -> bool {
    match value {
        Bson::Null => false,
        Bson::Boolean(b) => *b,
        Bson::Int32(n) => *n != 0,
        Bson::Int64(n) => *n != 0,
        Bson::Double(n) => *n != 0.0,
        Bson::String(s) => !s.is_empty(),
        _ => true,
    }
}
/// Cast the bounded Event query predicate tree. Predicate fields have no insert
/// defaults or generated IDs. Mixed operands remain unmodified.
fn predicate(path: &str, value: Bson) -> Result<Bson, super::ValidationErrors> {
    use mongodb::bson::Document;
    let field = update_field(path);
    if field.as_ref().is_some_and(|f| matches!(f.kind, T::Mixed)) {
        return Ok(value);
    }
    let Bson::Document(entries) = value else {
        return cast_update_value(path, value)?.ok_or_else(invalid);
    };
    let mut out = Document::new();
    for (key, value) in entries {
        let value = if matches!(key.as_str(), "$or" | "$and" | "$nor") {
            let Bson::Array(values) = value else {
                return Err(invalid());
            };
            Bson::Array(
                values
                    .into_iter()
                    .map(|v| predicate(path, v))
                    .collect::<Result<_, _>>()?,
            )
        } else if matches!(key.as_str(), "$in" | "$nin" | "$all") {
            let values = match value {
                Bson::Array(v) => v,
                other => vec![other],
            };
            Bson::Array(
                values
                    .into_iter()
                    .map(|v| predicate(path, v))
                    .collect::<Result<_, _>>()?,
            )
        } else if key == "$not" || key == "$elemMatch" {
            predicate(path, value)?
        } else if key == "$exists" {
            cast_field(Field::new("value", T::Boolean), value)?
        } else if key == "$size" {
            number(value)?
        } else if key.starts_with('$') {
            if matches!(key.as_str(), "$regex" | "$options" | "$type") {
                value
            } else {
                cast_update_value(path, value)?.ok_or_else(invalid)?
            }
        } else {
            let child = format!("{path}.{key}");
            // Event has default strictQuery=false: unknown predicate keys
            // survive, while unknown update paths are stripped independently.
            if update_field(&child).is_some() {
                predicate(&child, value)?
            } else {
                value
            }
        };
        out.insert(key, value);
    }
    Ok(Bson::Document(out))
}
/// Mongoose 8.24.2 operator semantics for Event's declared paths. Unknown paths
/// are stripped before coercion. MongoDB remains responsible for path conflicts,
/// positional matching, numeric storage constraints and operator applicability.
pub fn cast_update_operand(
    op: &str,
    path: &str,
    value: Bson,
) -> Result<Option<Bson>, super::ValidationErrors> {
    use mongodb::bson::Document;
    let Some(field) = update_field(path) else {
        return Ok(None);
    };
    let value = match op {
        "$unset" => value,
        "$rename" => {
            if value == Bson::Null {
                return Err(invalid());
            }
            cast_field(Field::new("value", T::String), value)?
        }
        "$currentDate" => match value {
            Bson::Document(d) => {
                let mut out = Document::new();
                if let Some(v) = d.get("$type") {
                    out.insert("$type", v.clone());
                }
                Bson::Document(out)
            }
            other => Bson::Boolean(truthy(&other)),
        },
        "$pop" => {
            if value == Bson::Null {
                return Err(invalid());
            }
            number(value)?
        }
        "$inc" if value == Bson::Null => return Err(invalid()),
        "$bit" if matches!(field.kind, T::Number) => {
            let Bson::Document(d) = value else {
                return Err(invalid());
            };
            let mut out = Document::new();
            for (k, v) in d {
                out.insert(k, number(v)?);
            }
            Bson::Document(out)
        }
        "$pull" => predicate(path, value)?,
        "$push" | "$addToSet" if matches!(field.kind, T::Array(_)) => {
            let T::Array(element) = field.kind else {
                unreachable!()
            };
            let cast_element = |v| cast_field(Field::new("value", *element.clone()), v);
            match value {
                Bson::Document(mut d) if d.contains_key("$each") => {
                    let each = d.remove("$each").unwrap();
                    let values = match each {
                        Bson::Array(v) => v,
                        v => vec![v],
                    };
                    let mut out = Document::new();
                    out.insert(
                        "$each",
                        values
                            .into_iter()
                            .map(cast_element)
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                    if let Some(v) = d.remove("$slice").filter(|v| *v != Bson::Null) {
                        let n = match number(v)? {
                            Bson::Double(n) => n,
                            Bson::Int32(n) => n as f64,
                            Bson::Int64(n) => n as f64,
                            _ => 0.0,
                        };
                        let n = if n.is_finite() {
                            n.trunc().rem_euclid(4294967296.0) as u32 as i32
                        } else {
                            0
                        };
                        out.insert("$slice", n);
                    }
                    if let Some(v) = d.remove("$sort").filter(truthy) {
                        out.insert("$sort", v);
                    }
                    if let Some(v) = d.remove("$position").filter(|v| *v != Bson::Null) {
                        out.insert("$position", number(v)?);
                    }
                    Bson::Document(out)
                }
                Bson::Array(values) => {
                    let mut out = Document::new();
                    out.insert(
                        "$each",
                        values
                            .into_iter()
                            .map(cast_element)
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                    Bson::Document(out)
                }
                v => cast_element(v)?,
            }
        }
        _ => cast_field(field, value)?,
    };
    Ok(Some(value))
}
