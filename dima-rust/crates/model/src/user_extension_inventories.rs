//! `userextensioninventories`: a viewer's DimaFX wallet in one channel (credit balance in Bits,
//! saved items, purchase preferences and the receipts that make refunds and saves idempotent).
//!
//! Reference: `dimabot/src/schemas/user_extension_inventory.schema.ts` (model
//! `UserExtensionInventory`), written by `server/routes/dimafx.route.ts` (an upsert with
//! `$setOnInsert` on the viewer's identity, conditional `$inc`s of `balance` and
//! `items.$.quantity`, `$push` of items, `$set` of `config`, and `doc.save()` when a deleted item
//! is refunded) and `server/services/dimafx-fulfillment.service.ts` (`$inc` with `$addToSet` of a
//! receipt, filtered on the receipt being absent). Camel-case timestamps, `__v`, no hooks.
//!
//! Indexes `userID`, `channelID` and the unique `{platform, userID, channelID}`, which is required
//! before the first write ([`crate::startup_policy`]): every write finds the wallet by that
//! identity and the first one upserts it, so without the index two concurrent first purchases
//! would create two wallets and split the viewer's balance. `items` elements have no `_id`.
//!
//! Money: `balance`, `items[].quantity` and `items[].purchasePriceBits` keep their stored width
//! ([`JsNumber`]). `displayName` is `null` by default (stored so).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "userextensioninventories";

str_enum! {
    /// `platform` (also `extensionwallettransactions.platform`).
    pub enum ExtensionPlatform {
        /// Twitch (the only one).
        Twitch = "twitch",
    }
}

str_enum! {
    /// `config.quickPurchasePriority`.
    pub enum QuickPurchasePriority {
        /// Spend credits before Bits (the default).
        CreditsFirst = "credits_first",
        /// Spend Bits before credits.
        BitsFirst = "bits_first",
    }
}

str_enum! {
    /// `config.quickPurchaseAction`.
    pub enum QuickPurchaseAction {
        /// Play it now (the default).
        UseNow = "use_now",
        /// Keep it for later.
        Save = "save",
    }
}

str_enum! {
    /// `items[].source`.
    pub enum ItemSource {
        /// Bought with Bits (the default).
        BitsPurchase = "bits_purchase",
        /// Bought with credits.
        CreditPurchase = "credit_purchase",
        /// A refund as credit.
        RefundCredit = "refund_credit",
        /// A gift.
        Gift = "gift",
        /// Added by staff.
        AdminAdjustment = "admin_adjustment",
    }
}

const CONFIG: &[Field] = &[
    Field::string("quickPurchasePriority").default(D::Str("credits_first")),
    Field::string("quickPurchaseAction").default(D::Str("use_now")),
];

static ITEM: Schema = Schema::subdocument(&[
    Field::object_id("channelExtensionItemID"),
    Field::number("quantity").default(D::Int(0)),
    Field::number("purchasePriceBits").default(D::Int(0)),
    Field::date("acquiredAt").default_fn(D::Now),
    Field::string("source").default(D::Str("bits_purchase")),
])
.no_id();

/// The schema, field by field as `user_extension_inventory.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("platform").default(D::Str("twitch")),
    Field::string("userID"),
    Field::string("channelID"),
    Field::string("displayName").default(D::Null),
    Field::number("balance").default(D::Int(0)),
    Field::nested("config", CONFIG),
    Field::document_array("items", &ITEM).default(D::EmptyArray),
    Field::array("dimafxReceipts", ValueType::String).default(D::EmptyArray),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("userID", 1)]),
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("platform", 1), ("userID", 1), ("channelID", 1)]).unique(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("platform"),
    Rule::one_of("platform", ExtensionPlatform::STRINGS),
    Rule::required("userID"),
    Rule::required("channelID"),
    Rule::min("balance", 0.0),
    Rule::one_of(
        "config.quickPurchasePriority",
        QuickPurchasePriority::STRINGS,
    ),
    Rule::one_of("config.quickPurchaseAction", QuickPurchaseAction::STRINGS),
    Rule::required("items.$.channelExtensionItemID"),
    Rule::required("items.$.quantity"),
    Rule::min("items.$.quantity", 0.0),
    Rule::required("items.$.purchasePriceBits"),
    Rule::min("items.$.purchasePriceBits", 0.0),
    Rule::required("items.$.source"),
    Rule::one_of("items.$.source", ItemSource::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("platform"),
    ReadNeed::value("userID"),
    ReadNeed::value("channelID"),
    ReadNeed::not_null("balance"),
    ReadNeed::not_null("config"),
    ReadNeed::not_null("config.quickPurchasePriority"),
    ReadNeed::not_null("config.quickPurchaseAction"),
    ReadNeed::not_null("items"),
    ReadNeed::value("items.$.channelExtensionItemID"),
    ReadNeed::not_null("items.$.quantity"),
    ReadNeed::not_null("items.$.purchasePriceBits"),
    ReadNeed::not_null("items.$.source"),
    ReadNeed::not_null("dimafxReceipts"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "UserExtensionInventory",
    source: "dimabot/src/schemas/user_extension_inventory.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<UserExtensionInventory>,
};

/// A stored wallet.
#[derive(Clone, Debug, Deserialize)]
pub struct UserExtensionInventory {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The platform.
    #[serde(default = "twitch")]
    pub platform: Open<ExtensionPlatform>,
    /// The viewer's Twitch id.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The viewer's display name.
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    /// Credit balance, in Bits.
    #[serde(default = "zero")]
    pub balance: JsNumber,
    /// Purchase preferences.
    #[serde(default)]
    pub config: InventoryConfig,
    /// Saved items.
    #[serde(default)]
    pub items: Vec<InventoryItem>,
    /// Receipts of applied refunds and saves (`refund:<id>`, `save:<id>`).
    #[serde(default, rename = "dimafxReceipts")]
    pub dimafx_receipts: Vec<String>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn twitch() -> Open<ExtensionPlatform> {
    Open::Known(ExtensionPlatform::Twitch)
}

/// `config`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct InventoryConfig {
    /// What a quick purchase spends first.
    #[serde(default = "credits_first", rename = "quickPurchasePriority")]
    pub quick_purchase_priority: Open<QuickPurchasePriority>,
    /// What a quick purchase does.
    #[serde(default = "use_now", rename = "quickPurchaseAction")]
    pub quick_purchase_action: Open<QuickPurchaseAction>,
}

impl Default for InventoryConfig {
    fn default() -> Self {
        Self {
            quick_purchase_priority: credits_first(),
            quick_purchase_action: use_now(),
        }
    }
}

fn credits_first() -> Open<QuickPurchasePriority> {
    Open::Known(QuickPurchasePriority::CreditsFirst)
}

fn use_now() -> Open<QuickPurchaseAction> {
    Open::Known(QuickPurchaseAction::UseNow)
}

/// `items[]`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct InventoryItem {
    /// The item (`channelextensionitems._id`).
    #[serde(rename = "channelExtensionItemID")]
    pub channel_extension_item_id: ObjectId,
    /// How many are saved.
    #[serde(default = "zero")]
    pub quantity: JsNumber,
    /// The Bits paid for each.
    #[serde(default = "zero", rename = "purchasePriceBits")]
    pub purchase_price_bits: JsNumber,
    /// When it was acquired (`default: Date.now`, not applied on read).
    #[serde(default, rename = "acquiredAt")]
    pub acquired_at: Option<JsDate>,
    /// How it was acquired.
    #[serde(default = "bits_purchase")]
    pub source: Open<ItemSource>,
}

fn bits_purchase() -> Open<ItemSource> {
    Open::Known(ItemSource::BitsPurchase)
}

/// A new wallet (the reference upserts it with these values in `$setOnInsert`).
#[derive(Clone, Debug, Serialize)]
pub struct NewUserExtensionInventory {
    /// The platform.
    pub platform: ExtensionPlatform,
    /// The viewer's Twitch id.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The viewer's display name.
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Credit balance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<JsNumber>,
    /// Purchase preferences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<NewInventoryConfig>,
    /// Saved items.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<NewInventoryItem>>,
}

/// `config` of a new wallet.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct NewInventoryConfig {
    /// What a quick purchase spends first.
    #[serde(rename = "quickPurchasePriority")]
    pub quick_purchase_priority: QuickPurchasePriority,
    /// What a quick purchase does.
    #[serde(rename = "quickPurchaseAction")]
    pub quick_purchase_action: QuickPurchaseAction,
}

/// A saved item (the `$push` of `addInventoryItem`).
#[derive(Clone, Debug, Serialize)]
pub struct NewInventoryItem {
    /// The item.
    #[serde(rename = "channelExtensionItemID")]
    pub channel_extension_item_id: ObjectId,
    /// How many.
    pub quantity: JsNumber,
    /// The Bits paid for each.
    #[serde(rename = "purchasePriceBits")]
    pub purchase_price_bits: JsNumber,
    /// When it was acquired.
    #[serde(rename = "acquiredAt", skip_serializing_if = "Option::is_none")]
    pub acquired_at: Option<JsDate>,
    /// How it was acquired.
    pub source: ItemSource,
}

impl NewUserExtensionInventory {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
