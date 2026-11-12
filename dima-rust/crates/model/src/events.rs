//! `events`: the catalogue of chat events the site offers (stream online, follow...), each with
//! its EventSub template, plan tier and configuration controls.
//!
//! Reference: `dimabot/src/schemas/event.schema.ts` (model `Event`). No timestamps option:
//! hand-written `createdAt`/`updatedAt` with `Date.now`, and a `pre('save')` hook that sets
//! `updatedAt = new Date()` on every save. Many strings are trimmed. `config[]` elements carry
//! their own `_id`. `__v`, no index.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::hooks::{save_stamping, stamp_insert};
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::users::PlanTier;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "events";

str_enum! {
    /// `releaseStage`.
    pub enum ReleaseStage {
        /// Stable (the default).
        Stable = "stable",
        /// Beta.
        Beta = "beta",
        /// Alpha.
        Alpha = "alpha",
        /// Under maintenance.
        Maintenance = "maintenance",
        /// Announced.
        ComingSoon = "coming_soon",
        /// Not offered.
        Unavailable = "unavailable",
        /// Being removed.
        Deprecated = "deprecated",
    }
}

str_enum! {
    /// `config[].type`: the control the site shows.
    pub enum ControlType {
        /// A text field (the default).
        Text = "text",
        /// A number field.
        Number = "number",
        /// A checkbox.
        Checkbox = "checkbox",
        /// A select.
        Select = "select",
        /// Messages per tier.
        MessageTiers = "message-tiers",
    }
}

const LOCALIZED: &[Field] = &[Field::string("EN").trim(), Field::string("ES").trim()];

static SHOW_IF: Schema =
    Schema::subdocument(&[Field::string("controlId"), Field::mixed("is")]).no_id();

static CONFIG: Schema = Schema::subdocument(&[
    Field::string("id").trim(),
    Field::string("dbId").trim(),
    Field::nested("label", LOCALIZED),
    Field::string("type").default(D::Str("text")),
    Field::mixed("value"),
    Field::boolean("canDisable").default(D::Bool(false)),
    Field::string("placeholder").trim(),
    Field::subdocument("showIf", &SHOW_IF),
]);

static SCHEMA: Schema = Schema::new(&[
    Field::string("name").trim(),
    Field::string("type").trim(),
    Field::string("version").default(D::Str("1")),
    Field::mixed("condition"),
    Field::string("icon").trim(),
    Field::string("color").trim(),
    Field::string("textColor").trim(),
    Field::string("releaseStage").default(D::Str("stable")),
    Field::boolean("enabled").default(D::Bool(false)),
    Field::string("plan_tier").default(D::Str("free")),
    Field::nested("description", LOCALIZED),
    Field::document_array("config", &CONFIG),
    Field::nested(
        "tierLimits",
        &[
            Field::number("free").default(D::Int(0)),
            Field::number("premium").default(D::Int(2)),
            Field::number("pro").default(D::Int(5)),
        ],
    ),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("updatedAt").default_fn(D::Now),
]);

/// The `showIf` validator's message.
pub const SHOW_IF_MESSAGE: &str = "If showIf is provided, both controlId and is must be defined";

fn show_if_complete(value: &Bson) -> bool {
    match value {
        Bson::Document(show_if) => show_if.contains_key("controlId") && show_if.contains_key("is"),
        _ => true,
    }
}

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("name"),
    Rule::required("type"),
    Rule::required("version"),
    Rule::required("condition"),
    Rule::required("icon"),
    Rule::required("color"),
    Rule::required("textColor"),
    Rule::one_of("releaseStage", ReleaseStage::STRINGS),
    Rule::one_of("plan_tier", PlanTier::STRINGS),
    Rule::required("description.EN"),
    Rule::required("description.ES"),
    Rule::required("config.$.id"),
    Rule::required("config.$.label.EN"),
    Rule::required("config.$.label.ES"),
    Rule::required("config.$.type"),
    Rule::one_of("config.$.type", ControlType::STRINGS),
    Rule::required("config.$.value"),
    Rule::custom("config.$.showIf", SHOW_IF_MESSAGE, show_if_complete),
    Rule::required("config.$.showIf.controlId"),
    Rule::required("config.$.showIf.is"),
];

/// The registry entry. Creates and saves go through [`NewEvent::prepare`] and [`prepare_save`]
/// (the `updatedAt` hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Event",
    source: "dimabot/src/schemas/event.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[] as &[IndexSpec],
    rules: RULES,
    hooks: Hooks::Save,
    decode: |raw: &RawDocument| decode::<Event>(raw).map(drop),
};

/// A catalogue event.
#[derive(Clone, Debug, Deserialize)]
pub struct Event {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// Display name.
    pub name: String,
    /// The EventSub type (`stream.online`).
    #[serde(rename = "type")]
    pub kind: String,
    /// The EventSub version.
    #[serde(default = "one")]
    pub version: String,
    /// The EventSub condition template (`{broadcaster_user_id: "user"}`; missing when it was
    /// created as `{}`, which `minimize` removed).
    #[serde(default)]
    pub condition: Option<EventCondition>,
    /// Icon name.
    pub icon: String,
    /// Colour.
    pub color: String,
    /// Text colour.
    #[serde(rename = "textColor")]
    pub text_color: String,
    /// Release stage.
    #[serde(default = "stable", rename = "releaseStage")]
    pub release_stage: Open<ReleaseStage>,
    /// Offered.
    #[serde(default)]
    pub enabled: bool,
    /// Lowest plan that can use it.
    #[serde(default = "free")]
    pub plan_tier: Open<PlanTier>,
    /// Description per language.
    pub description: Localized,
    /// Configuration controls.
    #[serde(default)]
    pub config: Vec<Control>,
    /// How many each plan may enable.
    #[serde(default, rename = "tierLimits")]
    pub tier_limits: TierLimits,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last save.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn one() -> String {
    "1".to_owned()
}

fn stable() -> Open<ReleaseStage> {
    Open::Known(ReleaseStage::Stable)
}

fn free() -> Open<PlanTier> {
    Open::Known(PlanTier::Free)
}

/// The EventSub condition template, kept as stored until the EventSub package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct EventCondition(pub Bson);

/// English and Spanish text.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Localized {
    /// English.
    #[serde(rename = "EN")]
    pub en: String,
    /// Spanish.
    #[serde(rename = "ES")]
    pub es: String,
}

/// `tierLimits`.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct TierLimits {
    /// Free plan.
    #[serde(default = "crate::defaults::zero")]
    pub free: JsNumber,
    /// Premium plan.
    #[serde(default = "two")]
    pub premium: JsNumber,
    /// Pro plan.
    #[serde(default = "five")]
    pub pro: JsNumber,
}

impl Default for TierLimits {
    fn default() -> Self {
        Self {
            free: JsNumber(0.0),
            premium: two(),
            pro: five(),
        }
    }
}

fn two() -> JsNumber {
    JsNumber(2.0)
}

fn five() -> JsNumber {
    JsNumber(5.0)
}

/// `config[]`: one control of the event's settings form.
#[derive(Clone, Debug, Deserialize)]
pub struct Control {
    /// The element `_id`.
    #[serde(default, rename = "_id")]
    pub object_id: Option<ObjectId>,
    /// The control id.
    pub id: String,
    /// The settings field it writes.
    #[serde(default, rename = "dbId")]
    pub db_id: Option<String>,
    /// Label per language.
    pub label: Localized,
    /// The control kind.
    #[serde(default = "text", rename = "type")]
    pub kind: Open<ControlType>,
    /// The default value, as stored (text, number, flag or list).
    #[serde(default)]
    pub value: Option<ControlValue>,
    /// The user may switch it off.
    #[serde(default, rename = "canDisable")]
    pub can_disable: bool,
    /// Placeholder text.
    #[serde(default)]
    pub placeholder: Option<String>,
    /// Shown only when another control has a value.
    #[serde(default, rename = "showIf")]
    pub show_if: Option<ShowIf>,
}

fn text() -> Open<ControlType> {
    Open::Known(ControlType::Text)
}

/// A control's value (`Mixed`), kept as stored.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ControlValue(pub Bson);

/// `config[].showIf`.
#[derive(Clone, Debug, Deserialize)]
pub struct ShowIf {
    /// The control that decides.
    #[serde(rename = "controlId")]
    pub control_id: String,
    /// The value it must have.
    #[serde(default)]
    pub is: Bson,
}

/// A new catalogue event (`new EventSchema(eventData).save()` in `site.route.ts`).
#[derive(Clone, Debug, Serialize)]
pub struct NewEvent {
    /// Display name (trimmed).
    pub name: String,
    /// The EventSub type (trimmed).
    #[serde(rename = "type")]
    pub kind: String,
    /// The condition template.
    pub condition: Document,
    /// Icon (trimmed).
    pub icon: String,
    /// Colour (trimmed).
    pub color: String,
    /// Text colour (trimmed).
    #[serde(rename = "textColor")]
    pub text_color: String,
    /// Description per language (trimmed).
    pub description: Localized,
    /// Controls.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub config: Vec<NewControl>,
    /// Version (default `1`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Release stage (default `stable`).
    #[serde(rename = "releaseStage", skip_serializing_if = "Option::is_none")]
    pub release_stage: Option<ReleaseStage>,
    /// Offered (default `false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Lowest plan (default `free`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<PlanTier>,
}

/// A new control.
#[derive(Clone, Debug, Serialize)]
pub struct NewControl {
    /// The control id (trimmed).
    pub id: String,
    /// The settings field it writes (trimmed).
    #[serde(rename = "dbId", skip_serializing_if = "Option::is_none")]
    pub db_id: Option<String>,
    /// Label per language.
    pub label: Localized,
    /// The control kind (default `text`).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<ControlType>,
    /// The default value.
    pub value: Bson,
    /// The user may switch it off (default `false`).
    #[serde(rename = "canDisable", skip_serializing_if = "Option::is_none")]
    pub can_disable: Option<bool>,
    /// Placeholder (trimmed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Visibility rule: the control and the value it must have.
    #[serde(rename = "showIf", skip_serializing_if = "Option::is_none")]
    pub show_if: Option<Document>,
}

impl NewEvent {
    /// The values given to the constructor (before defaults and `trim`).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends (the hook stamps `updatedAt`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        let mut prepared = INFO.prepare_create(&self.to_document()?, ctx)?;
        stamp_insert(&mut prepared.document, "updatedAt", ctx);
        Ok(prepared)
    }
}

/// `doc.save()` of a loaded event after `changes`, with the hook's `updatedAt = new Date()`.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    save_stamping(&INFO, loaded, changes, "updatedAt", ctx)
}
