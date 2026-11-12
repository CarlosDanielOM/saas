//! `referralcodes`: the campaign codes a user shares so that sign-ups and subscriptions are
//! credited to them.
//!
//! Reference: `dimabot/src/schemas/referral_code.schema.ts` (model `ReferralCode`). Camel-case
//! timestamps, `__v`. Unique `code` (field level, declared with both `unique` and `index`, which
//! Mongoose merges into one index), `owner`, `{owner, createdAt: -1}`; best effort (the create
//! path checks for a taken code first, and nothing awaits the index). `code` must match
//! `^[a-zA-Z0-9_]{1,16}$`, `label` is at most 50 characters (Mongoose counts UTF-16 units, here
//! characters).
//!
//! Hook: `pre('save')` lower-cases `code` when it was modified (creates included). Validation
//! runs before it, so the code it sees is ASCII and Rust's lower case is JavaScript's. Creates
//! go through [`NewReferralCode::prepare`] and saves through [`prepare_save`]; updates have no
//! hook (`active: false`, `$inc` of `stats.conversions`).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, yes, zero};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::writes::save_with_hooks;
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "referralcodes";

/// Longest label, in characters.
pub const LABEL_MAX_CHARS: usize = 50;

const STATS: &[Field] = &[Field::number("conversions").default(D::Int(0))];

/// The schema, field by field as `referral_code.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("code"),
    Field::object_id("owner"),
    Field::string("label").default(D::Str("")),
    Field::nested("stats", STATS),
    Field::boolean("active").default(D::Bool(true)),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes (field-level first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("code", 1)]).unique(),
    IndexSpec::on(&[("owner", 1)]),
    IndexSpec::on(&[("owner", 1), ("createdAt", -1)]),
];

/// `/^[a-zA-Z0-9_]{1,16}$/.test(v)`.
pub fn is_valid_code(code: &str) -> bool {
    let count = code.chars().count();
    (1..=16).contains(&count) && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_code(value: &Bson) -> bool {
    matches!(value, Bson::String(code) if is_valid_code(code))
}

fn code_message(value: &str) -> String {
    format!(
        "{value} is not a valid referral code. Must be 1-16 alphanumeric characters or underscores."
    )
}

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("code"),
    Rule::custom_with(
        "code",
        "props=>`${props.value} is not a valid referral code. Must be 1-16 alphanumeric characters or underscores.`",
        code_message,
        valid_code,
    ),
    Rule::required("owner"),
    Rule::max_length("label", LABEL_MAX_CHARS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("code"),
    ReadNeed::value("owner"),
    ReadNeed::not_null("label"),
    ReadNeed::not_null("stats"),
    ReadNeed::not_null("stats.conversions"),
    ReadNeed::not_null("active"),
];

/// The registry entry. Creates and saves go through this module (the lower-case hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ReferralCode",
    source: "dimabot/src/schemas/referral_code.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::Save,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<ReferralCode>,
};

/// A stored referral code.
#[derive(Clone, Debug, Deserialize)]
pub struct ReferralCode {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The code (lower case once saved).
    pub code: String,
    /// The owner (`users._id`).
    pub owner: ObjectId,
    /// The owner's label for the campaign.
    #[serde(default = "empty")]
    pub label: String,
    /// Counters.
    #[serde(default)]
    pub stats: ReferralStats,
    /// Active (deleted codes are deactivated).
    #[serde(default = "yes")]
    pub active: bool,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// `stats`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ReferralStats {
    /// Subscriptions credited through the code.
    #[serde(default = "zero")]
    pub conversions: JsNumber,
}

impl Default for ReferralStats {
    fn default() -> Self {
        Self {
            conversions: zero(),
        }
    }
}

/// A new code (`new ReferralCodeSchema({...}).save()` in `utils/referral.ts:80`).
#[derive(Clone, Debug, Serialize)]
pub struct NewReferralCode {
    /// The code (the hook lower-cases it).
    pub code: String,
    /// The owner.
    pub owner: ObjectId,
    /// The label (default `''`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Counters (the reference passes `{conversions: 0}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<NewReferralStats>,
    /// Active (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
}

/// `stats` of a new code.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct NewReferralStats {
    /// Conversions.
    pub conversions: JsNumber,
}

impl NewReferralCode {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends: validated as given, then the hook lower-cases `code`.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        let mut prepared = INFO.prepare_create(&self.to_document()?, ctx)?;
        if let Ok(code) = prepared.document.get_str("code") {
            let lower = code.to_lowercase();
            prepared.document.insert("code", lower);
        }
        Ok(prepared)
    }
}

/// `doc.save()` of a loaded code after `changes`, with the hook: a modified `code` is stored in
/// lower case.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
) -> Result<PreparedSave, ModelError> {
    save_with_hooks(
        &INFO,
        loaded,
        changes,
        |loaded, changes, _| {
            let set = changes.iter().rev().find_map(|change| match change {
                Change::Set(path, value) if path == "code" => Some(value),
                _ => None,
            });
            Ok(match set {
                Some(Bson::String(code))
                    if loaded.get("code") != Some(&Bson::String(code.clone())) =>
                {
                    vec![Change::set("code", Bson::String(code.to_lowercase()))]
                }
                _ => Vec::new(),
            })
        },
        ctx,
    )
}
