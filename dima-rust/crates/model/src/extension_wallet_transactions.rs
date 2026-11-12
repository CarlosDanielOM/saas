//! `extensionwallettransactions`: the DimaFX ledger (every Bits purchase, credit purchase, use,
//! save, redemption, refund and gift), kept 365 days for privacy, then expired.
//!
//! Reference: `dimabot/src/schemas/extension_wallet_transaction.schema.ts` (model
//! `ExtensionWalletTransaction`), written by `server/routes/dimafx.route.ts` (`Model.create`, and
//! compare-and-set `$set`s of `metadata.fulfillment`). Camel-case timestamps, `__v`, no hooks.
//! Indexes: six field-level ones, the unique partial `twitchTransactionID` (strings only),
//! `{channelID, userID, createdAt: -1}` and the TTL on `createdAt` (365 days).
//!
//! **The unique `twitchTransactionID` index does not exist in production**: the copy has a plain
//! `twitchTransactionID_1` of the same name, so Mongoose's `createIndex` fails with
//! `IndexOptionsConflict` (logged, ignored) and nothing stops a Twitch transaction from being
//! recorded twice except the reference's `exists` check before the create
//! (`dimafx.route.ts:735`, not atomic). [`crate::preflight_indexes`] reports it. It stays best
//! effort here: requiring it would stop every wallet write at the cutover until the index is
//! rebuilt, which is an operator decision (ledger `mongo.md`, "Option conflict").
//!
//! Money: `amountBits` and `balanceDelta` keep their stored width (`balanceDelta` holds int32 and
//! double, [`JsNumber`]). `metadata` (`Mixed`, `{}` by default, so missing on one document) holds
//! the viewer's TTS text and is private. `userID`, `opaqueUserID`, `channelExtensionItemID`,
//! `twitchTransactionID` and `sku` are `null` by default and stored so.
//!
//! Client-fed writes (`null` from a request body): none. `server/routes/dimafx.route.ts` records
//! Twitch transactions and balances the server computed.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::user_extension_inventories::ExtensionPlatform;
use crate::validation::Rule;
use crate::values::Nullable;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "extensionwallettransactions";

/// How long an entry is kept (`DIMAFX_LOG_RETENTION_SECONDS`, 365 days).
pub const RETENTION_SECONDS: u64 = 365 * 24 * 60 * 60;

str_enum! {
    /// `type`.
    pub enum WalletTransactionType {
        /// An item bought with Bits.
        BitsPurchase = "bits_purchase",
        /// An item bought with credits.
        CreditPurchase = "credit_purchase",
        /// An item played at once.
        UseNow = "use_now",
        /// An item saved for later.
        SaveItem = "save_item",
        /// A saved item played.
        RedeemSaved = "redeem_saved",
        /// A refund as credit.
        RefundCredit = "refund_credit",
        /// A gift received.
        GiftIn = "gift_in",
        /// A gift given.
        GiftOut = "gift_out",
    }
}

/// The schema, field by field as `extension_wallet_transaction.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("platform").default(D::Str("twitch")),
    Field::string("userID").default(D::Null),
    Field::string("opaqueUserID").default(D::Null),
    Field::string("channelID"),
    Field::string("type"),
    Field::number("amountBits").default(D::Int(0)),
    Field::number("balanceDelta").default(D::Int(0)),
    Field::object_id("channelExtensionItemID").default(D::Null),
    Field::string("twitchTransactionID").default(D::Null),
    Field::string("sku").default(D::Null),
    // `default: {}`: Mongoose turns an object literal on a Mixed path into a function.
    Field::mixed("metadata").default_fn(D::EmptyDocument),
])
.timestamps(Timestamps::CAMEL);

fn string_transaction_id() -> Document {
    doc! { "twitchTransactionID": { "$type": "string" } }
}

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("platform", 1)]),
    IndexSpec::on(&[("userID", 1)]),
    IndexSpec::on(&[("opaqueUserID", 1)]),
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("type", 1)]),
    IndexSpec::on(&[("channelExtensionItemID", 1)]),
    IndexSpec::on(&[("twitchTransactionID", 1)])
        .unique()
        .partial(string_transaction_id),
    IndexSpec::on(&[("channelID", 1), ("userID", 1), ("createdAt", -1)]),
    IndexSpec::on(&[("createdAt", 1)]).expire_after_seconds(RETENTION_SECONDS),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("platform"),
    Rule::one_of("platform", ExtensionPlatform::STRINGS),
    Rule::required("channelID"),
    Rule::required("type"),
    Rule::one_of("type", WalletTransactionType::STRINGS),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["metadata"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("platform"),
    ReadNeed::value("channelID"),
    ReadNeed::value("type"),
    ReadNeed::not_null("amountBits"),
    ReadNeed::not_null("balanceDelta"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ExtensionWalletTransaction",
    source: "dimabot/src/schemas/extension_wallet_transaction.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ExtensionWalletTransaction>,
};

/// A stored ledger entry.
#[derive(Clone, Debug, Deserialize)]
pub struct ExtensionWalletTransaction {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The platform.
    #[serde(default = "twitch")]
    pub platform: Open<ExtensionPlatform>,
    /// The viewer's Twitch id (when they shared it).
    #[serde(default, rename = "userID")]
    pub user_id: Option<String>,
    /// The viewer's opaque extension id.
    #[serde(default, rename = "opaqueUserID")]
    pub opaque_user_id: Option<String>,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// What happened.
    #[serde(rename = "type")]
    pub kind: Open<WalletTransactionType>,
    /// Bits involved.
    #[serde(default = "zero", rename = "amountBits")]
    pub amount_bits: JsNumber,
    /// Change of the credit balance.
    #[serde(default = "zero", rename = "balanceDelta")]
    pub balance_delta: JsNumber,
    /// The item.
    #[serde(default, rename = "channelExtensionItemID")]
    pub channel_extension_item_id: Option<ObjectId>,
    /// The Twitch Bits transaction.
    #[serde(default, rename = "twitchTransactionID")]
    pub twitch_transaction_id: Option<String>,
    /// The extension SKU.
    #[serde(default)]
    pub sku: Option<String>,
    /// Details (`action`, `fulfillment`, `viewerText`, `reason`...), as stored.
    #[serde(default)]
    pub metadata: Private<WalletMetadata>,
    /// Creation time (the TTL counts from it).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn twitch() -> Open<ExtensionPlatform> {
    Open::Known(ExtensionPlatform::Twitch)
}

/// The entry's details, kept as stored until the DimaFX package types them. The path is
/// `Mixed`; missing reads as the default `{}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct WalletMetadata(pub Bson);

impl Default for WalletMetadata {
    fn default() -> Self {
        Self(Bson::Document(Document::new()))
    }
}

/// A new ledger entry (`ExtensionWalletTransactionSchema.create` in `dimafx.route.ts`). The Bits
/// purchase passes `userID`, `opaqueUserID` and `twitchTransactionID` as `null` when it has none.
#[derive(Clone, Debug, Serialize)]
pub struct NewExtensionWalletTransaction {
    /// The platform.
    pub platform: ExtensionPlatform,
    /// The viewer's Twitch id.
    #[serde(rename = "userID", skip_serializing_if = "Nullable::is_unset")]
    pub user_id: Nullable<String>,
    /// The viewer's opaque id.
    #[serde(rename = "opaqueUserID", skip_serializing_if = "Nullable::is_unset")]
    pub opaque_user_id: Nullable<String>,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// What happened.
    #[serde(rename = "type")]
    pub kind: WalletTransactionType,
    /// Bits involved.
    #[serde(rename = "amountBits")]
    pub amount_bits: JsNumber,
    /// Change of the credit balance.
    #[serde(rename = "balanceDelta")]
    pub balance_delta: JsNumber,
    /// The item.
    #[serde(
        rename = "channelExtensionItemID",
        skip_serializing_if = "Option::is_none"
    )]
    pub channel_extension_item_id: Option<ObjectId>,
    /// The Twitch Bits transaction.
    #[serde(
        rename = "twitchTransactionID",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub twitch_transaction_id: Nullable<String>,
    /// The SKU.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sku: Option<String>,
    /// Details.
    pub metadata: Private<Document>,
}

impl NewExtensionWalletTransaction {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
