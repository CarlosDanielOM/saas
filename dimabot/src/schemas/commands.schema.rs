//! Native `Commands` document contract.
//!
//! Collection `commands` is Mongoose's pluralization of model `Commands`.
//! `date.month` is one-based (`getMonth() + 1`). `blocks`, `availability`,
//! and `availabilityLease` are hidden from the default projection. Mixed
//! `permissionExpression` and `blocks` stay raw BSON; inspection fails closed
//! and does not drop a value it rejects. Constructors do not connect or
//! install indexes.
use super::command_schema_values;
pub use super::command_schema_values::CommandsRepository;
use super::ordinary_model_values::{
    CalendarDate, Reader, StrictDecodeError, insert_f64, insert_optional_string, insert_string,
};
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use crate::utils::ast_blocks::StoredBlocks;
use crate::utils::availability::AvailabilityClock;
use crate::utils::js_string::JsString;
use crate::utils::keywords::KeywordMatchMode;
use crate::utils::permissions::{
    ExpressionState, ValidationError, ValidationErrorCode, inspect_expression,
};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, oid::ObjectId},
};
use serde_json::{Map, Number, Value};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "Commands";
pub const COLLECTION_NAME: &str = "commands";
pub const EXPORT_NAME: &str = "CommandsSchema";
pub const ENABLED_FIELD: &str = CommandsRepository::ENABLED_FIELD;

const ACTIVATION: &[&str] = &["command", "keyword"];
const MATCH_MODE: &[&str] = &["start", "anywhere", "exact"];
const AUTHORING: &[&str] = &["text", "blocks"];

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut fields = vec![
            Field::new("name", T::String),
            Field::new("cmd", T::String),
            Field::new("activation", T::String)
                .enumeration(ACTIVATION)
                .default(D::String("command")),
            Field::new(
                "keywordSettings",
                T::Subdocument {
                    fields: vec![
                        Field::new("matchMode", T::String)
                            .enumeration(MATCH_MODE)
                            .default(D::String("start")),
                    ],
                    generate_id: false,
                },
            ),
            Field::new("func", T::String),
            Field::new("message", T::String).default(D::String("")),
            Field::new("authoring", T::String)
                .enumeration(AUTHORING)
                .default(D::String("text")),
            Field::new("blocks", T::Mixed).default(D::Null).hidden(),
            Field::new("responses", T::Array(Box::new(T::Mixed))).default(D::Array),
            Field::new("variables", T::Map(Box::new(T::String))).default(D::Object),
            Field::new("type", T::String).default(D::String("command")),
            Field::new("platform", T::String).default(D::String("twitch")),
            Field::new("reserved", T::Boolean).default(D::Boolean(false)),
            Field::new("description", T::String).default(D::String("No description provided.")),
            Field::new("cooldown", T::Number).default(D::Number(20.0)),
            Field::new("count", T::Number).default(D::Number(0.0)),
            Field::new("userLevelName", T::String).default(D::String("everyone")),
            Field::new("userLevel", T::Number).default(D::Number(0.0)),
            Field::new("permissionExpression", T::Mixed).default(D::Null),
            Field::new("permissions", T::Mixed).default(D::Object),
            Field::new("enabled", T::Boolean).default(D::Boolean(true)),
            Field::new("paused", T::Boolean).default(D::Boolean(false)),
            Field::new("channel", T::String),
            Field::new("channelID", T::String).required(),
            Field::new("premiumRequired", T::Boolean).default(D::Boolean(false)),
            Field::new("premiumLevelRequired", T::Number).default(D::Number(0.0)),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new(
                "date",
                T::Object(vec![
                    Field::new("day", T::Number).default(D::LocalDay),
                    Field::new("month", T::Number).default(D::LocalMonth),
                    Field::new("year", T::Number).default(D::LocalYear),
                ]),
            ),
        ];
        fields.extend(command_schema_values::availability_fields());
        SchemaDefinition {
            model: MODEL_NAME,
            collection: COLLECTION_NAME,
            string_id: false,
            version_key: true,
            write_concern_journaled: false,
            timestamps: None,
            save_clock_field: None,
            fields,
            indexes: vec![command_schema_values::availability_index()],
        }
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> CommandsRepository {
    repository_with_clock(database, AvailabilityClock::live())
}

pub fn repository_with_clock(database: &Database, clock: AvailabilityClock) -> CommandsRepository {
    CommandsRepository::new(schema(), database, clock)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandActivation {
    Command,
    Keyword,
}

impl CommandActivation {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "command" => Some(Self::Command),
            "keyword" => Some(Self::Keyword),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Keyword => "keyword",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandAuthoring {
    Text,
    Blocks,
}

impl CommandAuthoring {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "blocks" => Some(Self::Blocks),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Blocks => "blocks",
        }
    }
}

/// Nested `keywordSettings`. `matchMode` is the native keyword enum.
/// An unrecognized stored mode is a strict decode error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeywordSettings {
    pub match_mode: KeywordMatchMode,
}

impl KeywordSettings {
    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        let mode = reader.require_string("matchMode")?;
        let text = mode.to_utf8_lossy();
        let match_mode = match text.as_str() {
            "start" => KeywordMatchMode::Start,
            "anywhere" => KeywordMatchMode::Anywhere,
            "exact" => KeywordMatchMode::Exact,
            _ => {
                return Err(StrictDecodeError {
                    path: format!("{}.matchMode", reader.location()),
                    kind: "enum",
                });
            }
        };
        Ok(Self { match_mode })
    }

    fn to_document(self) -> Document {
        let mut document = Document::new();
        let mode = match self.match_mode {
            KeywordMatchMode::Start => "start",
            KeywordMatchMode::Anywhere => "anywhere",
            KeywordMatchMode::Exact => "exact",
        };
        document.insert("matchMode", mode);
        document
    }
}

/// `blocks` inspection. `Empty` is absent or JSON null. `Invalid` keeps the
/// caller-owned BSON; this enum does not replace it.
#[derive(Clone, Debug)]
pub enum BlocksInspection {
    Empty,
    Valid(StoredBlocks),
    Invalid,
}

/// Source `ICommands`. Absent `permissions` decodes as an empty object and is
/// omitted again on write. `responses` keeps every BSON element.
#[derive(Clone, Debug, PartialEq)]
pub struct ICommands {
    pub id: ObjectId,
    pub name: Option<JsString>,
    pub cmd: Option<JsString>,
    pub activation: CommandActivation,
    pub keyword_settings: Option<KeywordSettings>,
    pub func: Option<JsString>,
    pub message: JsString,
    pub authoring: CommandAuthoring,
    pub blocks: Option<Bson>,
    pub responses: Vec<Bson>,
    pub variables: Document,
    pub type_name: JsString,
    pub platform: JsString,
    pub reserved: bool,
    pub description: JsString,
    pub cooldown: f64,
    pub count: f64,
    pub user_level_name: JsString,
    pub user_level: f64,
    pub permission_expression: Option<Bson>,
    pub permissions: Document,
    pub enabled: bool,
    pub paused: bool,
    pub channel: Option<JsString>,
    pub channel_id: JsString,
    pub premium_required: bool,
    pub premium_level_required: f64,
    pub created_at: DateTime,
    pub date: CalendarDate,
    pub availability: Option<Bson>,
    pub availability_lease: Option<Bson>,
}

impl ICommands {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        let activation = reader.require_string("activation")?;
        let activation =
            CommandActivation::parse(&activation.to_utf8_lossy()).ok_or_else(|| {
                StrictDecodeError {
                    path: "activation".to_owned(),
                    kind: "enum",
                }
            })?;
        let authoring = reader.require_string("authoring")?;
        let authoring = CommandAuthoring::parse(&authoring.to_utf8_lossy()).ok_or_else(|| {
            StrictDecodeError {
                path: "authoring".to_owned(),
                kind: "enum",
            }
        })?;
        Ok(Self {
            id: reader.require_object_id("_id")?,
            name: reader.optional_string("name")?,
            cmd: reader.optional_string("cmd")?,
            activation,
            keyword_settings: match reader.optional_document("keywordSettings")? {
                Some(nested) => Some(KeywordSettings::from_reader(&nested)?),
                None => None,
            },
            func: reader.optional_string("func")?,
            message: reader.require_string("message")?,
            authoring,
            blocks: raw_field(document, "blocks"),
            responses: reader.require_array("responses")?.clone(),
            variables: string_map(&reader)?,
            type_name: reader.require_string("type")?,
            platform: reader.require_string("platform")?,
            reserved: reader.require_bool("reserved")?,
            description: reader.require_string("description")?,
            cooldown: reader.require_f64("cooldown")?,
            count: reader.require_f64("count")?,
            user_level_name: reader.require_string("userLevelName")?,
            user_level: reader.require_f64("userLevel")?,
            permission_expression: raw_field(document, "permissionExpression"),
            permissions: permission_map(&reader)?,
            enabled: reader.require_bool("enabled")?,
            paused: reader.require_bool("paused")?,
            channel: reader.optional_string("channel")?,
            channel_id: reader.require_string("channelID")?,
            premium_required: reader.require_bool("premiumRequired")?,
            premium_level_required: reader.require_f64("premiumLevelRequired")?,
            created_at: reader.require_datetime("createdAt")?,
            date: CalendarDate::from_reader(&reader.require_document("date")?)?,
            availability: raw_field(document, "availability"),
            availability_lease: raw_field(document, "availabilityLease"),
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        insert_optional_string(&mut document, "name", &self.name);
        insert_optional_string(&mut document, "cmd", &self.cmd);
        document.insert("activation", self.activation.as_str());
        if let Some(settings) = self.keyword_settings {
            document.insert("keywordSettings", settings.to_document());
        }
        insert_optional_string(&mut document, "func", &self.func);
        insert_string(&mut document, "message", &self.message);
        document.insert("authoring", self.authoring.as_str());
        if let Some(blocks) = &self.blocks {
            document.insert("blocks", blocks.clone());
        }
        document.insert("responses", self.responses.clone());
        document.insert("variables", self.variables.clone());
        insert_string(&mut document, "type", &self.type_name);
        insert_string(&mut document, "platform", &self.platform);
        document.insert("reserved", self.reserved);
        insert_string(&mut document, "description", &self.description);
        insert_f64(&mut document, "cooldown", self.cooldown);
        insert_f64(&mut document, "count", self.count);
        insert_string(&mut document, "userLevelName", &self.user_level_name);
        insert_f64(&mut document, "userLevel", self.user_level);
        if let Some(expression) = &self.permission_expression {
            document.insert("permissionExpression", expression.clone());
        }
        if !self.permissions.is_empty() {
            document.insert("permissions", self.permissions.clone());
        }
        document.insert("enabled", self.enabled);
        document.insert("paused", self.paused);
        insert_optional_string(&mut document, "channel", &self.channel);
        insert_string(&mut document, "channelID", &self.channel_id);
        document.insert("premiumRequired", self.premium_required);
        insert_f64(
            &mut document,
            "premiumLevelRequired",
            self.premium_level_required,
        );
        document.insert("createdAt", self.created_at);
        document.insert("date", self.date.to_document());
        if let Some(availability) = &self.availability {
            document.insert("availability", availability.clone());
        }
        if let Some(lease) = &self.availability_lease {
            document.insert("availabilityLease", lease.clone());
        }
        document
    }
}

/// `null` and absent select legacy level mode. A non-JSON BSON value is
/// invalid and is left untouched for the caller that still holds it.
pub fn inspect_permission_expression(value: Option<&Bson>) -> ExpressionState {
    match value {
        None | Some(Bson::Null) => ExpressionState::Level,
        Some(value) => match bson_json(value) {
            Some(json) => inspect_expression(Some(&json)),
            None => ExpressionState::Invalid {
                error: ValidationError {
                    message: "permission expression is not a JSON value".to_owned(),
                    code: ValidationErrorCode::NodeMustBeObject,
                    path: "$".to_owned(),
                },
            },
        },
    }
}

pub fn inspect_blocks(value: Option<&Bson>) -> BlocksInspection {
    match value {
        None | Some(Bson::Null) => BlocksInspection::Empty,
        Some(value) => {
            match bson_json(value)
                .and_then(|json| serde_json::from_value::<StoredBlocks>(json).ok())
            {
                Some(blocks) => BlocksInspection::Valid(blocks),
                None => BlocksInspection::Invalid,
            }
        }
    }
}

fn raw_field(document: &Document, key: &str) -> Option<Bson> {
    document.get(key).cloned()
}

fn string_map(reader: &Reader<'_>) -> Result<Document, StrictDecodeError> {
    let nested = reader.require_document("variables")?;
    for (key, value) in nested.document() {
        if !matches!(value, Bson::String(_)) {
            return Err(StrictDecodeError {
                path: format!("variables.{key}"),
                kind: if matches!(value, Bson::Null) {
                    "null"
                } else {
                    "type"
                },
            });
        }
    }
    Ok(nested.document().clone())
}

fn permission_map(reader: &Reader<'_>) -> Result<Document, StrictDecodeError> {
    match reader.document().get("permissions") {
        None => Ok(Document::new()),
        Some(Bson::Document(document)) => {
            for (key, value) in document {
                if !matches!(value, Bson::Boolean(_)) {
                    return Err(StrictDecodeError {
                        path: format!("permissions.{key}"),
                        kind: if matches!(value, Bson::Null) {
                            "null"
                        } else {
                            "type"
                        },
                    });
                }
            }
            Ok(document.clone())
        }
        Some(Bson::Null) => Err(StrictDecodeError {
            path: "permissions".to_owned(),
            kind: "null",
        }),
        Some(_) => Err(StrictDecodeError {
            path: "permissions".to_owned(),
            kind: "type",
        }),
    }
}

/// JSON conversion that fails on BSON types JSON cannot represent.
/// This is not `compiler_bson_json`: non-JSON values are rejected, not rewritten.
fn bson_json(value: &Bson) -> Option<Value> {
    match value {
        Bson::Null => Some(Value::Null),
        Bson::Boolean(value) => Some(Value::Bool(*value)),
        Bson::Int32(value) => Some(Value::Number((*value).into())),
        Bson::Int64(value) => Some(Value::Number(Number::from(*value))),
        Bson::Double(value) => Number::from_f64(*value).map(Value::Number),
        Bson::String(value) => Some(Value::String(value.clone())),
        Bson::Array(values) => values
            .iter()
            .map(bson_json)
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Bson::Document(document) => {
            let mut object = Map::new();
            for (key, value) in document {
                object.insert(key.clone(), bson_json(value)?);
            }
            Some(Value::Object(object))
        }
        _ => None,
    }
}
