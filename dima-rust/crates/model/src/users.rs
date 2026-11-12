//! `users`: a person signed in to the site, with the platform accounts they connected (each with
//! its encrypted tokens), their plan, their credit balance and the monthly free-credit reset.
//!
//! Reference: `dimabot/src/schemas/users.schema.ts`. Snake-case timestamps, `__v`, no hooks and no
//! declared index (the reference queries `accounts.type` + `accounts.id` without one).
//! `polar_credit_snapshot` and `applied_credit_transaction_ids` are `select: false`.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::defaults::{yes, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocument, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};
use std::fmt;

/// The collection name.
pub const COLLECTION: &str = "users";

str_enum! {
    /// `accounts[].type`.
    pub enum AccountType {
        /// `twitch` (the default).
        Twitch = "twitch",
        /// `youtube`.
        Youtube = "youtube",
        /// `kick`.
        Kick = "kick",
        /// `tiktok`.
        Tiktok = "tiktok",
        /// `spotify`.
        Spotify = "spotify",
    }
}

str_enum! {
    /// `language`.
    pub enum Language {
        /// English.
        En = "en",
        /// Spanish.
        Es = "es",
    }
}

str_enum! {
    /// `tts_default_provider`.
    pub enum TtsProvider {
        /// Kokoro.
        Kokoro = "kokoro",
    }
}

str_enum! {
    /// A plan tier (`users.plan_tier`, `events.plan_tier`).
    pub enum PlanTier {
        /// `free` (the default).
        Free = "free",
        /// `premium`.
        Premium = "premium",
        /// `pro`.
        Pro = "pro",
    }
}

str_enum! {
    /// `free_credit_reset.status`.
    pub enum ResetStatus {
        /// The period was opened.
        Initialized = "initialized",
        /// The grant was sent and awaits confirmation.
        Pending = "pending",
        /// The grant was confirmed.
        Completed = "completed",
    }
}

const TOKEN: &[Field] = &[
    Field::string("iv").default(D::Null),
    Field::string("content").default(D::Null),
];

static ACCOUNT: Schema = Schema::subdocument(&[
    Field::string("type").default(D::Str("twitch")),
    Field::string("id").default(D::Null),
    Field::string("name").default(D::Null),
    Field::string("email").default(D::Null),
    Field::nested("refresh_token", TOKEN),
    Field::nested("access_token", TOKEN),
    Field::number("access_token_expires_at").default(D::Null),
    Field::boolean("actived").default(D::Bool(true)),
    Field::boolean("chat_enabled").default(D::Bool(true)),
    Field::boolean("has_permissions").default(D::Bool(true)),
    Field::boolean("up_to_date_permissions").default(D::Bool(true)),
]);

static CREDIT_SNAPSHOT: Schema = Schema::subdocument(&[
    Field::date("occurredAt"),
    Field::string("eventKey"),
    Field::mixed_array("meters"),
])
.no_id();

static FREE_CREDIT_RESET: Schema = Schema::subdocument(&[
    Field::date("periodStart"),
    Field::date("periodEnd"),
    Field::string("status"),
    Field::number("credits"),
    Field::string("externalId"),
    Field::date("updatedAt"),
    Field::date("completedAt").default(D::Null),
])
.no_id();

/// The schema, field by field as `users.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::string("email"),
    Field::document_array("accounts", &ACCOUNT),
    Field::string("language").default(D::Null),
    Field::string("tts_default_provider"),
    Field::string("polar_sh_customer_id").default(D::Null),
    Field::date("polar_plan_event_at"),
    Field::string("polar_plan_event_key"),
    Field::boolean("polar_plan_effects_pending"),
    Field::string("polar_plan_entitlement_fingerprint"),
    Field::subdocument("polar_credit_snapshot", &CREDIT_SNAPSHOT),
    Field::string("plan_tier").default(D::Str("free")),
    Field::date("plan_tier_until").default(D::Null),
    Field::date("last_app_activity_at").default(D::Null),
    Field::date("refreshed_at").default_fn(D::Now),
    Field::object_id("referrerId").default(D::Null),
    Field::string("referralCodeUsed").default(D::Null),
    Field::number("token_balance").default(D::Int(0)),
    Field::array("applied_credit_transaction_ids", ValueType::ObjectId).no_default(),
    Field::date("reminder_sent_at").default(D::Null),
    Field::subdocument("free_credit_reset", &FREE_CREDIT_RESET),
])
.timestamps(Timestamps::SNAKE);

/// The `select: false` paths.
pub const HIDDEN: &[&str] = &["polar_credit_snapshot", "applied_credit_transaction_ids"];

/// The declared indexes (none).
pub const INDEXES: &[IndexSpec] = &[];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::one_of("accounts.$.type", AccountType::STRINGS),
    Rule::one_of("language", Language::STRINGS),
    Rule::one_of("tts_default_provider", TtsProvider::STRINGS),
    Rule::required("polar_credit_snapshot.occurredAt"),
    Rule::required("polar_credit_snapshot.eventKey"),
    Rule::required("polar_credit_snapshot.meters"),
    Rule::one_of("plan_tier", PlanTier::STRINGS),
    Rule::required("free_credit_reset.periodStart"),
    Rule::required("free_credit_reset.periodEnd"),
    Rule::required("free_credit_reset.status"),
    Rule::one_of("free_credit_reset.status", ResetStatus::STRINGS),
    Rule::required("free_credit_reset.credits"),
    Rule::min("free_credit_reset.credits", 0.0),
    Rule::required("free_credit_reset.externalId"),
    Rule::required("free_credit_reset.updatedAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "users",
    source: "dimabot/src/schemas/users.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    hooks: Hooks::None,
    decode: |raw: &RawDocument| decode::<User>(raw).map(drop),
};

// ------------------------------------------------------------------------------------- reading

/// A stored user, as a hydrated Mongoose document shows it (defaults filled in for missing paths).
/// Unknown fields are ignored. The hidden paths are `None` unless the read selected them.
#[derive(Clone, Debug, Deserialize)]
pub struct User {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// Display name (the Twitch login at sign-up).
    #[serde(default)]
    pub name: Option<String>,
    /// E-mail address.
    #[serde(default)]
    pub email: Option<String>,
    /// Connected platform accounts.
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// Site language.
    #[serde(default)]
    pub language: Option<Open<Language>>,
    /// Default TTS provider.
    #[serde(default)]
    pub tts_default_provider: Option<Open<TtsProvider>>,
    /// Polar customer id.
    #[serde(default)]
    pub polar_sh_customer_id: Option<String>,
    /// When the last Polar plan event was applied.
    #[serde(default)]
    pub polar_plan_event_at: Option<JsDate>,
    /// The key of the last Polar plan event applied.
    #[serde(default)]
    pub polar_plan_event_key: Option<String>,
    /// Plan side effects still to run.
    #[serde(default)]
    pub polar_plan_effects_pending: Option<bool>,
    /// Fingerprint of the entitlements last applied.
    #[serde(default)]
    pub polar_plan_entitlement_fingerprint: Option<String>,
    /// The last Polar credit meter snapshot (`select: false`).
    #[serde(default)]
    pub polar_credit_snapshot: Option<CreditSnapshot>,
    /// Plan tier.
    #[serde(default = "free")]
    pub plan_tier: Open<PlanTier>,
    /// End of a time-limited plan.
    #[serde(default)]
    pub plan_tier_until: Option<JsDate>,
    /// Last activity in the desktop app or site.
    #[serde(default)]
    pub last_app_activity_at: Option<JsDate>,
    /// When the tokens were last refreshed (`default: Date.now`, not applied on read).
    #[serde(default)]
    pub refreshed_at: Option<JsDate>,
    /// The user who referred this one.
    #[serde(default, rename = "referrerId")]
    pub referrer_id: Option<ObjectId>,
    /// The referral code used at sign-up.
    #[serde(default, rename = "referralCodeUsed")]
    pub referral_code_used: Option<String>,
    /// Credit balance.
    #[serde(default = "zero")]
    pub token_balance: JsNumber,
    /// Credit transactions already applied (`select: false`; absent on most users).
    #[serde(default)]
    pub applied_credit_transaction_ids: Option<Vec<ObjectId>>,
    /// When the activation reminder was sent.
    #[serde(default)]
    pub reminder_sent_at: Option<JsDate>,
    /// State of the monthly free-credit reset.
    #[serde(default)]
    pub free_credit_reset: Option<FreeCreditReset>,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

fn free() -> Open<PlanTier> {
    Open::Known(PlanTier::Free)
}

fn twitch() -> Open<AccountType> {
    Open::Known(AccountType::Twitch)
}

impl User {
    /// The first account of `kind` (the reference's `user.accounts.find(a => a.type === kind)`).
    pub fn account(&self, kind: AccountType) -> Option<&Account> {
        self.accounts.iter().find(|account| account.kind.is(kind))
    }

    /// The first Twitch account.
    pub fn twitch(&self) -> Option<&Account> {
        self.account(AccountType::Twitch)
    }
}

/// `accounts[]`: one connected platform account.
#[derive(Clone, Debug, Deserialize)]
pub struct Account {
    /// The sub-document `_id` (generated on insert; `None` only if a writer left it out).
    #[serde(default, rename = "_id")]
    pub object_id: Option<ObjectId>,
    /// The platform.
    #[serde(default = "twitch", rename = "type")]
    pub kind: Open<AccountType>,
    /// The platform's user id.
    #[serde(default)]
    pub id: Option<String>,
    /// The platform login.
    #[serde(default)]
    pub name: Option<String>,
    /// The platform e-mail.
    #[serde(default)]
    pub email: Option<String>,
    /// Encrypted refresh token.
    #[serde(default)]
    pub refresh_token: EncryptedToken,
    /// Encrypted access token.
    #[serde(default)]
    pub access_token: EncryptedToken,
    /// Access token expiry (epoch milliseconds).
    #[serde(default)]
    pub access_token_expires_at: Option<JsNumber>,
    /// The account is active.
    #[serde(default = "yes")]
    pub actived: bool,
    /// The bot may chat in this channel.
    #[serde(default = "yes")]
    pub chat_enabled: bool,
    /// The bot has the permissions it needs.
    #[serde(default = "yes")]
    pub has_permissions: bool,
    /// The granted scopes are current.
    #[serde(default = "yes")]
    pub up_to_date_permissions: bool,
}

/// A token encrypted by `utils/crypto.ts` (`{iv, content}`). `Debug` never prints the content.
#[derive(Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct EncryptedToken {
    /// Initialisation vector (hex).
    #[serde(default)]
    pub iv: Option<String>,
    /// Ciphertext (hex).
    #[serde(default)]
    pub content: Option<String>,
}

impl fmt::Debug for EncryptedToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncryptedToken")
            .field("iv", &self.iv.as_ref().map(|_| "<set>"))
            .field("content", &self.content.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// `polar_credit_snapshot`.
#[derive(Clone, Debug, Deserialize)]
pub struct CreditSnapshot {
    /// When Polar measured the meters.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// The event that carried the snapshot.
    #[serde(rename = "eventKey")]
    pub event_key: String,
    /// The meters, as Polar sent them.
    #[serde(default)]
    pub meters: PolarMeters,
}

/// Polar credit meters (`{meter_id, consumed_units, credited_units, balance}` objects), kept as
/// stored until the billing package types them.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PolarMeters(pub Vec<Bson>);

/// `free_credit_reset`: the monthly free-credit grant of the current period.
#[derive(Clone, Debug, Deserialize)]
pub struct FreeCreditReset {
    /// Period start.
    #[serde(rename = "periodStart")]
    pub period_start: JsDate,
    /// Period end.
    #[serde(rename = "periodEnd")]
    pub period_end: JsDate,
    /// Progress of the grant.
    pub status: Open<ResetStatus>,
    /// Credits granted.
    pub credits: JsNumber,
    /// Idempotency id sent to Polar.
    #[serde(rename = "externalId")]
    pub external_id: String,
    /// Last change.
    #[serde(rename = "updatedAt")]
    pub updated_at: JsDate,
    /// Completion time.
    #[serde(default, rename = "completedAt")]
    pub completed_at: Option<JsDate>,
}

/// The filter of the user who owns the `kind` account `id`
/// (`{accounts: {$elemMatch: {type, id}}}`, the reference's usual lookup).
pub fn by_account(kind: AccountType, id: &str) -> Document {
    doc! { "accounts": { "$elemMatch": { "type": kind.as_str(), "id": id } } }
}

// ------------------------------------------------------------------------------------ creating

/// A new user (`new UsersSchema({...})` at sign-up). Unset fields take the schema defaults.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewUser {
    /// Display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// E-mail address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Connected accounts.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<NewAccount>,
    /// Site language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
    /// Default TTS provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts_default_provider: Option<TtsProvider>,
    /// Polar customer id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polar_sh_customer_id: Option<String>,
    /// Plan tier (default `free`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<PlanTier>,
    /// End of a time-limited plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_tier_until: Option<JsDate>,
    /// Last activity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_app_activity_at: Option<JsDate>,
    /// The referring user.
    #[serde(rename = "referrerId", skip_serializing_if = "Option::is_none")]
    pub referrer_id: Option<ObjectId>,
    /// The referral code used.
    #[serde(rename = "referralCodeUsed", skip_serializing_if = "Option::is_none")]
    pub referral_code_used: Option<String>,
    /// Credit balance (default 0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_balance: Option<JsNumber>,
}

/// A new connected account.
#[derive(Clone, Debug, Serialize)]
pub struct NewAccount {
    /// The platform.
    #[serde(rename = "type")]
    pub kind: AccountType,
    /// The platform's user id.
    pub id: String,
    /// The platform login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The platform e-mail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Encrypted refresh token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<EncryptedToken>,
    /// Encrypted access token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<EncryptedToken>,
    /// Access token expiry (epoch milliseconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token_expires_at: Option<JsNumber>,
    /// Active (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actived: Option<bool>,
    /// The bot may chat (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_enabled: Option<bool>,
    /// Permissions granted (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_permissions: Option<bool>,
    /// Scopes current (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_to_date_permissions: Option<bool>,
}

impl NewAccount {
    /// An account of `kind` with the platform id `id`; everything else defaulted.
    pub fn new(kind: AccountType, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            name: None,
            email: None,
            refresh_token: None,
            access_token: None,
            access_token_expires_at: None,
            actived: None,
            chat_enabled: None,
            has_permissions: None,
            up_to_date_permissions: None,
        }
    }
}

impl NewUser {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends for this user (its `_id` is in the prepared document).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
