//! `UserExtensionInventory` collection contract.
use super::media_extension_schema_values::{
    document_array, insert_or_null_string, nullable_string, parsed_enum, require_string_array,
};
use super::ordinary_model_values::{
    Reader, StrictDecodeError, bson_string, insert_datetime, insert_f64, insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub use super::media_extension_schema_values::{
    DEFAULT_EXTENSION_INVENTORY_CONFIG, EXTENSION_PLATFORMS, ExtensionPlatform,
    INVENTORY_ITEM_SOURCES, IUserExtensionInventoryConfig, InventoryItemSource,
    QUICK_PURCHASE_ACTIONS, QUICK_PURCHASE_PRIORITIES, QuickPurchaseAction, QuickPurchasePriority,
};

pub const MODEL_NAME: &str = "UserExtensionInventory";
pub const COLLECTION_NAME: &str = "userextensioninventories";
pub const EXPORT_NAME: &str = "UserExtensionInventorySchema";

fn inventory_item_fields() -> Vec<Field> {
    vec![
        Field::new("channelExtensionItemID", T::ObjectId).required(),
        Field::new("quantity", T::Number)
            .required()
            .min(0.0)
            .default(D::Number(0.0)),
        Field::new("purchasePriceBits", T::Number)
            .required()
            .min(0.0)
            .default(D::Number(0.0)),
        Field::new("acquiredAt", T::Date).default(D::Now),
        Field::new("source", T::String)
            .required()
            .enumeration(INVENTORY_ITEM_SOURCES)
            .default(D::String(InventoryItemSource::BitsPurchase.as_str())),
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
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! { "userID": 1 }),
            SchemaIndex::new(doc! { "channelID": 1 }),
            SchemaIndex::new(doc! { "platform": 1, "userID": 1, "channelID": 1 }).unique(),
        ],
        fields: vec![
            Field::new("platform", T::String)
                .required()
                .enumeration(EXTENSION_PLATFORMS)
                .default(D::String(ExtensionPlatform::Twitch.as_str())),
            Field::new("userID", T::String).required(),
            Field::new("channelID", T::String).required(),
            Field::new("displayName", T::String).default(D::Null),
            Field::new("balance", T::Number)
                .default(D::Number(0.0))
                .min(0.0),
            Field::new(
                "config",
                T::Object(vec![
                    Field::new("quickPurchasePriority", T::String)
                        .enumeration(QUICK_PURCHASE_PRIORITIES)
                        .default(D::String(QuickPurchasePriority::CreditsFirst.as_str())),
                    Field::new("quickPurchaseAction", T::String)
                        .enumeration(QUICK_PURCHASE_ACTIONS)
                        .default(D::String(QuickPurchaseAction::UseNow.as_str())),
                ]),
            ),
            Field::new(
                "items",
                T::Array(Box::new(T::Subdocument {
                    fields: inventory_item_fields(),
                    generate_id: false,
                })),
            )
            .default(D::Array),
            Field::new("dimafxReceipts", T::Array(Box::new(T::String))).default(D::Array),
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

#[derive(Clone, Debug, PartialEq)]
pub struct IUserExtensionInventoryItem {
    pub channel_extension_item_id: ObjectId,
    pub quantity: f64,
    pub purchase_price_bits: f64,
    pub acquired_at: DateTime,
    pub source: InventoryItemSource,
}

/// Source `IUserExtensionInventory`.
#[derive(Clone, Debug, PartialEq)]
pub struct IUserExtensionInventory {
    pub id: ObjectId,
    pub platform: ExtensionPlatform,
    pub user_id: JsString,
    pub channel_id: JsString,
    pub display_name: Option<JsString>,
    pub balance: f64,
    pub config: IUserExtensionInventoryConfig,
    pub items: Vec<IUserExtensionInventoryItem>,
    pub dimafx_receipts: Vec<JsString>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

impl IUserExtensionInventoryItem {
    fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            channel_extension_item_id: reader.require_object_id("channelExtensionItemID")?,
            quantity: reader.require_f64("quantity")?,
            purchase_price_bits: reader.require_f64("purchasePriceBits")?,
            acquired_at: reader.require_datetime("acquiredAt")?,
            source: parsed_enum(reader, "source", InventoryItemSource::parse)?,
        })
    }

    fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("channelExtensionItemID", self.channel_extension_item_id);
        insert_f64(&mut document, "quantity", self.quantity);
        insert_f64(&mut document, "purchasePriceBits", self.purchase_price_bits);
        insert_datetime(&mut document, "acquiredAt", self.acquired_at);
        document.insert("source", self.source.as_str());
        document
    }
}

impl IUserExtensionInventory {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        let mut items = Vec::new();
        for (document, path) in document_array(&reader, "items")? {
            items.push(IUserExtensionInventoryItem::from_reader(
                &Reader::with_prefix(document, &path),
            )?);
        }
        Ok(Self {
            id: reader.require_object_id("_id")?,
            platform: parsed_enum(&reader, "platform", ExtensionPlatform::parse)?,
            user_id: reader.require_string("userID")?,
            channel_id: reader.require_string("channelID")?,
            display_name: nullable_string(&reader, "displayName")?,
            balance: reader.require_f64("balance")?,
            config: IUserExtensionInventoryConfig::from_reader(
                &reader.require_document("config")?,
            )?,
            items,
            dimafx_receipts: require_string_array(&reader, "dimafxReceipts")?,
            created_at: reader.require_datetime("createdAt")?,
            updated_at: reader.require_datetime("updatedAt")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("_id", self.id);
        document.insert("platform", self.platform.as_str());
        insert_string(&mut document, "userID", &self.user_id);
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_or_null_string(&mut document, "displayName", &self.display_name);
        insert_f64(&mut document, "balance", self.balance);
        document.insert("config", self.config.to_document());
        document.insert(
            "items",
            Bson::Array(
                self.items
                    .iter()
                    .map(IUserExtensionInventoryItem::to_document)
                    .map(Bson::Document)
                    .collect(),
            ),
        );
        document.insert(
            "dimafxReceipts",
            Bson::Array(self.dimafx_receipts.iter().map(bson_string).collect()),
        );
        insert_datetime(&mut document, "createdAt", self.created_at);
        insert_datetime(&mut document, "updatedAt", self.updated_at);
        document
    }
}
