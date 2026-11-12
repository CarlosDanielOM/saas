//! `custom_timers`: a channel's repeating chat message (`!timer` and the dashboard).
//!
//! Reference: `dimabot/src/schemas/custom_timer.schema.ts`. Snake-case timestamps, `__v`, no
//! hooks; `name` and `message` are trimmed. Unique `{channelID, name}`. The validators (lengths,
//! a whole frequency of 1 to 1440 minutes) are the only ones in this package with ranges, so the
//! input type checks them in its constructor.

use crate::collection::CollectionInfo;
use crate::decode::decode;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::{Rule, ValidationError};
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::{JsNumber, read_number};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "custom_timers";

str_enum! {
    /// `frequencyUnit`.
    pub enum FrequencyUnit {
        /// Minutes (the only unit).
        Minutes = "minutes",
    }
}

/// The schema, field by field as `custom_timer.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("name").trim(),
    Field::string("message").trim(),
    Field::number("frequency"),
    Field::string("frequencyUnit"),
    Field::string("channel"),
    Field::string("channelID"),
    Field::boolean("active").default(D::Bool(true)),
])
.timestamps(Timestamps::SNAKE);

/// The `select: false` paths (none).
pub const HIDDEN: &[&str] = &[];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("channelID", 1), ("name", 1)]).unique(),
];

/// Longest name, in characters.
pub const NAME_MAX_CHARS: usize = 30;
/// Longest message, in characters.
pub const MESSAGE_MAX_CHARS: usize = 350;

fn is_integer(value: &Bson) -> bool {
    read_number(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0)
}

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("name"),
    Rule::max_length("name", NAME_MAX_CHARS),
    Rule::required("message"),
    Rule::max_length("message", MESSAGE_MAX_CHARS),
    Rule::required("frequency"),
    Rule::min("frequency", 1.0),
    Rule::max("frequency", 1440.0),
    Rule::custom(
        "frequency",
        "Timer frequency must be a whole number",
        is_integer,
    ),
    Rule::one_of("frequencyUnit", FrequencyUnit::STRINGS),
    Rule::required("channel"),
    Rule::required("channelID"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "custom_timer",
    source: "dimabot/src/schemas/custom_timer.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    decode: |raw: &RawDocument| decode::<CustomTimer>(raw).map(drop),
};

/// A stored timer.
#[derive(Clone, Debug, Deserialize)]
pub struct CustomTimer {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The timer's name, unique in the channel.
    pub name: String,
    /// The chat message.
    pub message: String,
    /// The interval.
    pub frequency: JsNumber,
    /// The interval's unit (absent on old documents: minutes).
    #[serde(default, rename = "frequencyUnit")]
    pub frequency_unit: Option<Open<FrequencyUnit>>,
    /// The channel login.
    pub channel: String,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The timer runs.
    #[serde(default = "crate::defaults::yes")]
    pub active: bool,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

/// A new timer (`CustomTimerSchema.create` in `timer_manager.command.ts`). Built with
/// [`NewCustomTimer::new`], which refuses what Mongoose's validation refuses.
#[derive(Clone, Debug, Serialize)]
pub struct NewCustomTimer {
    name: String,
    message: String,
    frequency: u32,
    #[serde(rename = "frequencyUnit", skip_serializing_if = "Option::is_none")]
    frequency_unit: Option<FrequencyUnit>,
    channel: String,
    #[serde(rename = "channelID")]
    channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<bool>,
}

impl NewCustomTimer {
    /// A timer; `name` and `message` are trimmed, then checked (required, at most 30 and 350
    /// characters), and `frequency` must be 1 to 1440.
    pub fn new(
        name: impl Into<String>,
        message: impl Into<String>,
        frequency: u32,
        frequency_unit: Option<FrequencyUnit>,
        channel: impl Into<String>,
        channel_id: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let timer = Self {
            name: name.into(),
            message: message.into(),
            frequency,
            frequency_unit,
            channel: channel.into(),
            channel_id: channel_id.into(),
            active: None,
        };
        timer.check()?;
        Ok(timer)
    }

    /// Sets `active` (default `true`).
    pub fn active(mut self, active: bool) -> Self {
        self.active = Some(active);
        self
    }

    fn check(&self) -> Result<(), ValidationError> {
        match self.prepare(&mut WriteContext::new(0)) {
            Ok(_) => Ok(()),
            Err(ModelError::Validation(error)) => Err(error),
            // Plain strings and numbers always encode and prepare.
            Err(_) => Ok(()),
        }
    }

    /// The values given to the constructor (before defaults and `trim`).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
