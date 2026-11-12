//! `vips`: reference `dimabot/src/schemas/vip.schema.ts`.
//! add_vip.command.ts:119 and moderation.functions.ts:328 build checked role records; vip.redemption.ts:113 saves a new document. Quirk: that redemption omits required expireTimestamp and fails validation. Calendar months are zero-based here. No declared indexes.
//! No hooks, no runValidators calls; client-fed null paths: none.
//! Legacy: missing optional values and __v are accepted; numeric widths use JsNumber.
//! Intended difference: server-only nulls/removals in READ_NEEDS are refused.
//! No timestamps option; createdAt defaults to Date.now; version key __v.
//! The production copy is empty. Startup imports: API, bot and cron.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::{
    WriteContext,
    date::JsDate,
    id::IdType,
    insert::PreparedInsert,
    number::JsNumber,
    schema::{DefaultValue as D, Field, Schema},
};
use serde::{Deserialize, Serialize};
fn default_vip() -> bool {
    true
}
fn utc_month_zero(now: i64) -> bson::Bson {
    bson::Bson::Int32(dima_text::utc_fields(now).map_or(0, |f| f.month as i32))
}
/// `date`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct VipDate {
    /// `date.day`.
    #[serde(rename = "day", default, skip_serializing_if = "Option::is_none")]
    pub day: Option<JsNumber>,
    /// `date.month`.
    #[serde(rename = "month", default, skip_serializing_if = "Option::is_none")]
    pub month: Option<JsNumber>,
    /// `date.year`.
    #[serde(rename = "year", default, skip_serializing_if = "Option::is_none")]
    pub year: Option<JsNumber>,
}
/// `expireDate`.
#[derive(Clone, Debug, Deserialize)]
pub struct VipExpiredate {
    /// `expireDate.day`.
    #[serde(rename = "day")]
    pub day: JsNumber,
    /// `expireDate.month`.
    #[serde(rename = "month")]
    pub month: JsNumber,
    /// `expireDate.year`.
    #[serde(rename = "year")]
    pub year: JsNumber,
}
/// Collection name.
pub const COLLECTION: &str = "vips";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("username"),
    Field::string("userID"),
    Field::string("channel"),
    Field::string("channelID"),
    Field::number("duration"),
    Field::boolean("vip").default(D::Bool(true)),
    Field::nested(
        "date",
        &[
            Field::number("day").default_fn(D::With(crate::defaults::utc_day)),
            Field::number("month").default_fn(D::With(utc_month_zero)),
            Field::number("year").default_fn(D::With(crate::defaults::utc_year)),
        ],
    ),
    Field::date("createdAt").default_fn(D::Now),
    Field::nested(
        "expireDate",
        &[
            Field::number("day"),
            Field::number("month"),
            Field::number("year"),
        ],
    ),
    Field::date("expireTimestamp"),
]);
/// Hidden paths (none).
pub const HIDDEN: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[];
/// Validators in schema order.
pub const RULES: &[Rule] = &[
    Rule::required("username"),
    Rule::required("userID"),
    Rule::required("channel"),
    Rule::required("channelID"),
    Rule::required("duration"),
    Rule::required("expireDate.day"),
    Rule::required("expireDate.month"),
    Rule::required("expireDate.year"),
    Rule::required("expireTimestamp"),
];
/// Strict read requirements; server-only paths refuse null.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("username"),
    ReadNeed::value("userID"),
    ReadNeed::value("channel"),
    ReadNeed::value("channelID"),
    ReadNeed::value("duration"),
    ReadNeed::not_null("vip"),
    ReadNeed::not_null("date"),
    ReadNeed::value("expireDate.day"),
    ReadNeed::value("expireDate.month"),
    ReadNeed::value("expireDate.year"),
    ReadNeed::value("expireDate"),
    ReadNeed::value("expireTimestamp"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "vip",
    source: "dimabot/src/schemas/vip.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<Vip>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct Vip {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `username`.
    #[serde(rename = "username")]
    pub username: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `duration`.
    #[serde(rename = "duration")]
    pub duration: JsNumber,
    /// `vip`.
    #[serde(rename = "vip", default = "default_vip")]
    pub vip: bool,
    /// `date`.
    #[serde(rename = "date", default)]
    pub date: VipDate,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `expireDate`.
    #[serde(rename = "expireDate")]
    pub expire_date: VipExpiredate,
    /// `expireTimestamp`.
    #[serde(rename = "expireTimestamp")]
    pub expire_timestamp: JsDate,
}
/// New document. Optional values are omitted so defaults apply.
#[derive(Clone, Debug, Serialize)]
pub struct NewVip {
    /// `username`.
    #[serde(rename = "username")]
    pub username: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `duration`.
    #[serde(rename = "duration")]
    pub duration: JsNumber,
    /// `vip`.
    #[serde(rename = "vip", skip_serializing_if = "Option::is_none")]
    pub vip: Option<bool>,

    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `expireDate`.
    #[serde(rename = "expireDate")]
    pub expire_date: NewVipExpireDate,
    /// `expireTimestamp`.
    #[serde(rename = "expireTimestamp")]
    pub expire_timestamp: JsDate,
}
impl NewVip {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

/// Expiration calendar supplied by the role writer (zero-based month).
#[derive(Clone, Debug, Serialize)]
pub struct NewVipExpireDate {
    /// Day.
    pub day: JsNumber,
    /// Month.
    pub month: JsNumber,
    /// Year.
    pub year: JsNumber,
}
