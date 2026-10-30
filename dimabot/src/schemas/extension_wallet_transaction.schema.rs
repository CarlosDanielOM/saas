//! `ExtensionWalletTransaction` collection contract.
//! The partial unique `twitchTransactionID` index ignores null and missing ids.
use super::media_extension_schema_values::{
    insert_mixed, insert_or_null_object_id, insert_or_null_string, mixed_document,
    nullable_object_id, nullable_string, parsed_enum,
};
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_datetime, insert_f64, insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub use super::media_extension_schema_values::{
    DEFAULT_EXTENSION_INVENTORY_CONFIG, EXTENSION_PLATFORMS, ExtensionPlatform,
    IUserExtensionInventoryConfig, QuickPurchaseAction, QuickPurchasePriority,
};

pub const MODEL_NAME: &str = "ExtensionWalletTransaction";
pub const COLLECTION_NAME: &str = "extensionwallettransactions";
pub const EXPORT_NAME: &str = "ExtensionWalletTransactionSchema";
pub const EXTENSION_WALLET_TRANSACTION_TYPES: &[&str] = &[
    "bits_purchase",
    "credit_purchase",
    "use_now",
    "save_item",
    "redeem_saved",
    "refund_credit",
    "gift_in",
    "gift_out",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtensionWalletTransactionType {
    BitsPurchase,
    CreditPurchase,
    UseNow,
    SaveItem,
    RedeemSaved,
    RefundCredit,
    GiftIn,
    GiftOut,
}

macro_rules! string_enum {
    ($ty:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        impl $ty {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }
            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}
string_enum!(ExtensionWalletTransactionType {
    BitsPurchase => "bits_purchase",
    CreditPurchase => "credit_purchase",
    UseNow => "use_now",
    SaveItem => "save_item",
    RedeemSaved => "redeem_saved",
    RefundCredit => "refund_credit",
    GiftIn => "gift_in",
    GiftOut => "gift_out",
});

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! { "platform": 1 }),
            SchemaIndex::new(doc! { "userID": 1 }),
            SchemaIndex::new(doc! { "opaqueUserID": 1 }),
            SchemaIndex::new(doc! { "channelID": 1 }),
            SchemaIndex::new(doc! { "type": 1 }),
            SchemaIndex::new(doc! { "channelExtensionItemID": 1 }),
            SchemaIndex::new(doc! { "twitchTransactionID": 1 })
                .unique()
                .partial(doc! { "twitchTransactionID": { "$type": "string" } }),
            SchemaIndex::new(doc! { "channelID": 1, "userID": 1, "createdAt": -1 }),
        ],
        fields: vec![
            Field::new("platform", T::String)
                .required()
                .enumeration(EXTENSION_PLATFORMS)
                .default(D::String(ExtensionPlatform::Twitch.as_str())),
            Field::new("userID", T::String).default(D::Null),
            Field::new("opaqueUserID", T::String).default(D::Null),
            Field::new("channelID", T::String).required(),
            Field::new("type", T::String)
                .required()
                .enumeration(EXTENSION_WALLET_TRANSACTION_TYPES),
            Field::new("amountBits", T::Number).default(D::Number(0.0)),
            Field::new("balanceDelta", T::Number).default(D::Number(0.0)),
            Field::new("channelExtensionItemID", T::ObjectId).default(D::Null),
            Field::new("twitchTransactionID", T::String).default(D::Null),
            Field::new("sku", T::String).default(D::Null),
            Field::new("metadata", T::Mixed)
                .default(D::Object)
                .minimize(),
        ],
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source `IExtensionWalletTransaction`.
#[derive(Clone, Debug, PartialEq)]
pub struct IExtensionWalletTransaction {
    pub id: ObjectId,
    pub platform: ExtensionPlatform,
    pub user_id: Option<JsString>,
    pub opaque_user_id: Option<JsString>,
    pub channel_id: JsString,
    pub transaction_type: ExtensionWalletTransactionType,
    pub amount_bits: f64,
    pub balance_delta: f64,
    pub channel_extension_item_id: Option<ObjectId>,
    pub twitch_transaction_id: Option<JsString>,
    pub sku: Option<JsString>,
    pub metadata: Document,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl IExtensionWalletTransaction {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        Ok(Self {
            id: reader.require_object_id("_id")?,
            platform: parsed_enum(&reader, "platform", ExtensionPlatform::parse)?,
            user_id: nullable_string(&reader, "userID")?,
            opaque_user_id: nullable_string(&reader, "opaqueUserID")?,
            channel_id: reader.require_string("channelID")?,
            transaction_type: parsed_enum(&reader, "type", ExtensionWalletTransactionType::parse)?,
            amount_bits: reader.require_f64("amountBits")?,
            balance_delta: reader.require_f64("balanceDelta")?,
            channel_extension_item_id: nullable_object_id(&reader, "channelExtensionItemID")?,
            twitch_transaction_id: nullable_string(&reader, "twitchTransactionID")?,
            sku: nullable_string(&reader, "sku")?,
            metadata: mixed_document(&reader, "metadata")?,
            created_at: reader.require_datetime("createdAt")?,
            updated_at: reader.require_datetime("updatedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        document.insert("platform", self.platform.as_str());
        insert_or_null_string(&mut document, "userID", &self.user_id);
        insert_or_null_string(&mut document, "opaqueUserID", &self.opaque_user_id);
        insert_string(&mut document, "channelID", &self.channel_id);
        document.insert("type", self.transaction_type.as_str());
        insert_f64(&mut document, "amountBits", self.amount_bits);
        insert_f64(&mut document, "balanceDelta", self.balance_delta);
        insert_or_null_object_id(
            &mut document,
            "channelExtensionItemID",
            self.channel_extension_item_id,
        );
        insert_or_null_string(
            &mut document,
            "twitchTransactionID",
            &self.twitch_transaction_id,
        );
        insert_or_null_string(&mut document, "sku", &self.sku);
        insert_mixed(&mut document, "metadata", &self.metadata);
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
