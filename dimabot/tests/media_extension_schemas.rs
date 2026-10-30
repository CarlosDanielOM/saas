#![cfg(feature = "media-extension-schemas")]
//! Native media and extension schema contracts.
//! Mongoose parity and private Mongo coverage are ignored until the parent supplies fixtures.
#[path = "support/sha256.rs"]
mod sha256;

use dima_rust::schemas::{
    FlatInsertError, PersistenceError, SchemaDefinition, SchemaIndex, channel_extension_item,
    dimafx_playback, extension_wallet_transaction, media_asset, user_extension_inventory,
    user_media_library_item,
};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};

const ID_A: &str = "507f1f77bcf86cd799439011";
const ID_B: &str = "507f1f77bcf86cd799439012";
const ID_C: &str = "507f1f77bcf86cd799439013";
const ID_D: &str = "507f1f77bcf86cd799439014";
const ID_E: &str = "507f1f77bcf86cd799439015";
const SOURCE_FILES: &[&str] = &[
    "src/schemas/media_asset.schema.ts",
    "src/schemas/user_media_library_item.schema.ts",
    "src/schemas/channel_extension_item.schema.ts",
    "src/schemas/user_extension_inventory.schema.ts",
    "src/schemas/extension_wallet_transaction.schema.ts",
    "src/schemas/dimafx_playback.schema.ts",
];
const LABELS: &[&str] = &[
    "media-minimal",
    "library-hex-asset",
    "channel-media-trim",
    "channel-tts",
    "inventory-item-defaults",
    "wallet-metadata",
    "wallet-empty-metadata",
    "playback-queue",
    "media-type-enum",
    "library-relation-enum",
    "channel-category-image",
    "inventory-source-enum",
    "inventory-config-enum",
    "wallet-type-enum",
    "playback-state-enum",
    "media-missing-s3",
    "library-missing-channel",
    "channel-missing-user",
    "channel-missing-channel",
    "channel-missing-bits",
    "inventory-missing-user",
    "channel-name-blank",
    "channel-name-whitespace",
    "channel-name-maxlength",
    "channel-tts-text-maxlength",
    "channel-volume-max",
    "channel-volume-min",
    "inventory-quantity-min",
    "inventory-balance-min",
    "library-asset-cast",
    "playback-missing-payload",
    "playback-missing-id",
    "channel-asset-required-video",
    "channel-asset-null-video",
    "channel-asset-required-default-category",
];

fn clock() -> DateTime {
    DateTime::from_millis(1_900_000_000_000)
}

fn later() -> DateTime {
    DateTime::from_millis(1_900_000_000_500)
}

fn oid(hex: &str) -> ObjectId {
    ObjectId::parse_str(hex).unwrap()
}

fn schemas() -> [&'static SchemaDefinition; 6] {
    [
        media_asset::schema(),
        user_media_library_item::schema(),
        channel_extension_item::schema(),
        user_extension_inventory::schema(),
        extension_wallet_transaction::schema(),
        dimafx_playback::schema(),
    ]
}

fn documents_eq(left: &Document, right: &Document) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .all(|(key, value)| right.get(key).is_some_and(|other| bson_eq(value, other)))
}

fn bson_eq(left: &Bson, right: &Bson) -> bool {
    match (left, right) {
        (Bson::Document(left), Bson::Document(right)) => documents_eq(left, right),
        (Bson::Array(left), Bson::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| bson_eq(left, right))
        }
        _ => left == right,
    }
}

fn ordered_doc_eq(left: &Document, right: &Document) -> bool {
    left.len() == right.len()
        && left.iter().zip(right.iter()).all(
            |((left_key, left_value), (right_key, right_value))| {
                left_key == right_key && ordered_bson_eq(left_value, right_value)
            },
        )
}

fn ordered_bson_eq(left: &Bson, right: &Bson) -> bool {
    match (left, right) {
        (Bson::Document(left), Bson::Document(right)) => ordered_doc_eq(left, right),
        (Bson::Array(left), Bson::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| ordered_bson_eq(left, right))
        }
        _ => left == right,
    }
}

fn index_wire(index: &SchemaIndex) -> Document {
    let mut document = Document::new();
    document.insert("keys", index.keys.clone());
    document.insert("unique", index.unique);
    document.insert("sparse", index.sparse);
    document.insert("ttl", Bson::Null);
    document.insert(
        "partial",
        index
            .partial
            .clone()
            .map(Bson::Document)
            .unwrap_or(Bson::Null),
    );
    document
}

fn prepared(schema: &SchemaDefinition, input: Document) -> Document {
    schema.prepare_insert(input, clock()).unwrap()
}

fn assert_clock(document: &Document) {
    assert_eq!(document.get_datetime("createdAt").unwrap(), &clock());
    assert_eq!(document.get_datetime("updatedAt").unwrap(), &clock());
    assert_eq!(document.get_i32("__v").unwrap(), 0);
}

fn assert_null(document: &Document, key: &str) {
    assert_eq!(document.get(key), Some(&Bson::Null), "{key}");
}

fn assert_i32(document: &Document, key: &str, value: i32) {
    assert_eq!(document.get_i32(key).unwrap(), value, "{key}");
}

fn assert_str(document: &Document, key: &str, value: &str) {
    assert_eq!(document.get_str(key).unwrap(), value, "{key}");
}

fn media_input(id: ObjectId, s3_key: &str) -> Document {
    doc! {
        "_id": id,
        "ownerUserID": "owner",
        "ownerChannelID": "channel",
        "ownerChannelName": "Channel",
        "uploadedByUserID": "uploader",
        "originalName": "airhorn.mp3",
        "displayName": "Airhorn",
        "fileName": "airhorn.mp3",
        "extension": "mp3",
        "mimeType": "audio/mpeg",
        "mediaType": "audio",
        "bytes": 12,
        "bucket": "bucket",
        "s3Key": s3_key,
        "storageUrl": "https://cdn.example/airhorn.mp3",
        "scope": "private",
    }
}

fn library_input(id: ObjectId, asset: Bson, active: Option<bool>) -> Document {
    let mut document = doc! {
        "_id": id,
        "channelID": "channel",
        "channelName": "Channel",
        "addedByUserID": "user",
        "assetID": asset,
        "relationType": "owner_upload",
        "quotaBytesCharged": 10,
        "assetScope": "private",
        "mediaType": "audio",
    };
    if let Some(active) = active {
        document.insert("isActive", active);
    }
    document
}

fn channel_input(id: ObjectId) -> Document {
    doc! {
        "_id": id,
        "channelID": "channel",
        "channelName": "Channel",
        "createdByUserID": "user",
        "assetID": oid(ID_B),
        "name": "Airhorn",
        "mediaType": "audio",
        "bitsPrice": 25,
        "sku": "airhorn",
    }
}

fn inventory_input(id: ObjectId) -> Document {
    doc! {
        "_id": id,
        "userID": "user",
        "channelID": "channel",
        "items": [{ "channelExtensionItemID": oid(ID_B) }],
    }
}

fn set_item(input: &mut Document, key: &str, value: impl Into<Bson>) {
    let items = input.get_array_mut("items").unwrap();
    let Bson::Document(item) = &mut items[0] else {
        panic!("inventory item");
    };
    item.insert(key, value);
}

fn wallet_input(id: ObjectId, transaction: Option<Bson>) -> Document {
    let mut document = doc! {
        "_id": id,
        "channelID": "channel",
        "type": "bits_purchase",
        "metadata": { "reason": "test" },
    };
    if let Some(transaction) = transaction {
        document.insert("twitchTransactionID", transaction);
    }
    document
}

fn playback_input(id: &str) -> Document {
    doc! {
        "_id": id,
        "channelID": "channel",
        "payload": {
            "triggerID": "trigger",
            "channelID": "channel",
            "itemID": "item",
            "name": "Airhorn",
            "category": "audio",
            "volume": 100,
            "durationMs": 1000,
            "source": "bits_purchase",
            "enqueuedAt": 1_900_000_000_000.0,
        },
    }
}

fn plain(keys: Document) -> SchemaIndex {
    SchemaIndex::new(keys)
}

fn unique(keys: Document) -> SchemaIndex {
    SchemaIndex::new(keys).unique()
}

fn unique_partial(keys: Document, partial: Document) -> SchemaIndex {
    SchemaIndex::new(keys).unique().partial(partial)
}

fn assert_index_list(schema: &SchemaDefinition, expected: &[SchemaIndex]) {
    assert_eq!(schema.indexes.len(), expected.len());
    for (actual, expected) in schema.indexes.iter().zip(expected) {
        assert_eq!(
            actual.keys.keys().collect::<Vec<_>>(),
            expected.keys.keys().collect::<Vec<_>>()
        );
        assert_eq!(actual.keys, expected.keys);
        assert_eq!(actual.unique, expected.unique);
        assert!(!actual.sparse);
        assert!(actual.ttl.is_none());
        assert_eq!(actual.partial, expected.partial);
    }
}

fn check_model(
    schema: &SchemaDefinition,
    model: &str,
    collection: &str,
    export_name: &str,
    string_id: bool,
) {
    assert_eq!(schema.model, model);
    assert_eq!(schema.collection, collection);
    assert!(!export_name.is_empty());
    assert_eq!(schema.string_id, string_id);
    assert!(schema.version_key);
    assert!(!schema.write_concern_journaled);
    assert_eq!(schema.timestamps, Some(("createdAt", "updatedAt")));
    assert!(schema.save_clock_field.is_none());
    assert!(matches!(
        schema.cast_flat_set_on_insert(&Document::new(), &Document::new(), clock()),
        Err(FlatInsertError::Unsupported(_))
    ));
}

fn same_type<T: 'static>() -> std::any::TypeId {
    std::any::TypeId::of::<T>()
}

fn assert_names(values: &[&str], rendered: &[&str]) {
    assert_eq!(values, rendered);
}

#[test]
fn declared_names_indexes_and_shared_constants() {
    check_model(
        media_asset::schema(),
        media_asset::MODEL_NAME,
        media_asset::COLLECTION_NAME,
        media_asset::EXPORT_NAME,
        false,
    );
    check_model(
        user_media_library_item::schema(),
        user_media_library_item::MODEL_NAME,
        user_media_library_item::COLLECTION_NAME,
        user_media_library_item::EXPORT_NAME,
        false,
    );
    check_model(
        channel_extension_item::schema(),
        channel_extension_item::MODEL_NAME,
        channel_extension_item::COLLECTION_NAME,
        channel_extension_item::EXPORT_NAME,
        false,
    );
    check_model(
        user_extension_inventory::schema(),
        user_extension_inventory::MODEL_NAME,
        user_extension_inventory::COLLECTION_NAME,
        user_extension_inventory::EXPORT_NAME,
        false,
    );
    check_model(
        extension_wallet_transaction::schema(),
        extension_wallet_transaction::MODEL_NAME,
        extension_wallet_transaction::COLLECTION_NAME,
        extension_wallet_transaction::EXPORT_NAME,
        false,
    );
    check_model(
        dimafx_playback::schema(),
        dimafx_playback::MODEL_NAME,
        dimafx_playback::COLLECTION_NAME,
        dimafx_playback::EXPORT_NAME,
        true,
    );
    assert_eq!(media_asset::MODEL_NAME, "MediaAsset");
    assert_eq!(media_asset::COLLECTION_NAME, "mediaassets");
    assert_eq!(media_asset::EXPORT_NAME, "MediaAssetSchema");
    assert_eq!(user_media_library_item::MODEL_NAME, "UserMediaLibraryItem");
    assert_eq!(
        user_media_library_item::COLLECTION_NAME,
        "usermedialibraryitems"
    );
    assert_eq!(
        user_media_library_item::EXPORT_NAME,
        "UserMediaLibraryItemSchema"
    );
    assert_eq!(channel_extension_item::MODEL_NAME, "ChannelExtensionItem");
    assert_eq!(
        channel_extension_item::COLLECTION_NAME,
        "channelextensionitems"
    );
    assert_eq!(
        channel_extension_item::EXPORT_NAME,
        "ChannelExtensionItemSchema"
    );
    assert_eq!(
        user_extension_inventory::MODEL_NAME,
        "UserExtensionInventory"
    );
    assert_eq!(
        user_extension_inventory::COLLECTION_NAME,
        "userextensioninventories"
    );
    assert_eq!(
        user_extension_inventory::EXPORT_NAME,
        "UserExtensionInventorySchema"
    );
    assert_eq!(
        extension_wallet_transaction::MODEL_NAME,
        "ExtensionWalletTransaction"
    );
    assert_eq!(
        extension_wallet_transaction::COLLECTION_NAME,
        "extensionwallettransactions"
    );
    assert_eq!(
        extension_wallet_transaction::EXPORT_NAME,
        "ExtensionWalletTransactionSchema"
    );
    assert_eq!(dimafx_playback::MODEL_NAME, "DimafxPlayback");
    assert_eq!(dimafx_playback::COLLECTION_NAME, "dimafxplaybacks");
    assert_eq!(dimafx_playback::EXPORT_NAME, "DimafxPlaybackSchema");

    assert_index_list(
        media_asset::schema(),
        &[
            plain(doc! { "legacyTriggerFileID": 1 }),
            plain(doc! { "ownerUserID": 1 }),
            plain(doc! { "ownerChannelID": 1 }),
            plain(doc! { "mediaType": 1 }),
            unique(doc! { "s3Key": 1 }),
            plain(doc! { "scope": 1 }),
            plain(doc! { "marketplaceStatus": 1 }),
            plain(doc! { "thumbnailAssetID": 1 }),
            plain(doc! { "thumbnailStatus": 1 }),
            plain(doc! { "deletedAt": 1 }),
            plain(doc! { "scope": 1, "marketplaceStatus": 1, "mediaType": 1, "createdAt": -1 }),
        ],
    );
    assert_index_list(
        user_media_library_item::schema(),
        &[
            plain(doc! { "channelID": 1 }),
            plain(doc! { "assetID": 1 }),
            plain(doc! { "assetScope": 1 }),
            plain(doc! { "mediaType": 1 }),
            plain(doc! { "isActive": 1 }),
            plain(doc! { "deletedAt": 1 }),
            unique_partial(
                doc! { "channelID": 1, "assetID": 1, "isActive": 1 },
                doc! { "isActive": true },
            ),
        ],
    );
    assert_index_list(
        channel_extension_item::schema(),
        &[
            plain(doc! { "channelID": 1 }),
            plain(doc! { "createdByUserID": 1 }),
            plain(doc! { "assetID": 1 }),
            plain(doc! { "category": 1 }),
            plain(doc! { "mediaType": 1 }),
            plain(doc! { "sku": 1 }),
            plain(doc! { "isEnabled": 1 }),
            plain(doc! { "sortOrder": 1 }),
            plain(doc! { "deletedAt": 1 }),
            plain(doc! { "channelID": 1, "isEnabled": 1, "deletedAt": 1 }),
            plain(doc! { "channelID": 1, "sortOrder": 1 }),
        ],
    );
    assert_index_list(
        user_extension_inventory::schema(),
        &[
            plain(doc! { "userID": 1 }),
            plain(doc! { "channelID": 1 }),
            unique(doc! { "platform": 1, "userID": 1, "channelID": 1 }),
        ],
    );
    assert_index_list(
        extension_wallet_transaction::schema(),
        &[
            plain(doc! { "platform": 1 }),
            plain(doc! { "userID": 1 }),
            plain(doc! { "opaqueUserID": 1 }),
            plain(doc! { "channelID": 1 }),
            plain(doc! { "type": 1 }),
            plain(doc! { "channelExtensionItemID": 1 }),
            unique_partial(
                doc! { "twitchTransactionID": 1 },
                doc! { "twitchTransactionID": { "$type": "string" } },
            ),
            plain(doc! { "channelID": 1, "userID": 1, "createdAt": -1 }),
        ],
    );
    assert_index_list(
        dimafx_playback::schema(),
        &[plain(doc! { "channelID": 1, "state": 1, "createdAt": 1 })],
    );

    assert_eq!(
        same_type::<user_extension_inventory::ExtensionPlatform>(),
        same_type::<extension_wallet_transaction::ExtensionPlatform>()
    );
    assert_eq!(
        same_type::<user_extension_inventory::QuickPurchasePriority>(),
        same_type::<extension_wallet_transaction::QuickPurchasePriority>()
    );
    assert_eq!(
        same_type::<user_extension_inventory::QuickPurchaseAction>(),
        same_type::<extension_wallet_transaction::QuickPurchaseAction>()
    );
    assert_eq!(
        same_type::<user_extension_inventory::IUserExtensionInventoryConfig>(),
        same_type::<extension_wallet_transaction::IUserExtensionInventoryConfig>()
    );
    assert_eq!(
        same_type::<channel_extension_item::MediaAssetType>(),
        same_type::<media_asset::MediaAssetType>()
    );
    assert_eq!(
        user_extension_inventory::DEFAULT_EXTENSION_INVENTORY_CONFIG,
        extension_wallet_transaction::DEFAULT_EXTENSION_INVENTORY_CONFIG
    );
    assert_eq!(
        user_extension_inventory::DEFAULT_EXTENSION_INVENTORY_CONFIG.quick_purchase_priority,
        user_extension_inventory::QuickPurchasePriority::CreditsFirst
    );
    assert_eq!(
        user_extension_inventory::DEFAULT_EXTENSION_INVENTORY_CONFIG.quick_purchase_action,
        user_extension_inventory::QuickPurchaseAction::UseNow
    );
    assert_eq!(
        user_extension_inventory::EXTENSION_PLATFORMS,
        extension_wallet_transaction::EXTENSION_PLATFORMS
    );
    assert_names(
        media_asset::MEDIA_ASSET_TYPES,
        &[
            media_asset::MediaAssetType::Video.as_str(),
            media_asset::MediaAssetType::Audio.as_str(),
            media_asset::MediaAssetType::Image.as_str(),
            media_asset::MediaAssetType::Gif.as_str(),
        ],
    );
    assert_names(
        media_asset::MEDIA_ASSET_SCOPES,
        &[
            media_asset::MediaAssetScope::Public.as_str(),
            media_asset::MediaAssetScope::Private.as_str(),
            media_asset::MediaAssetScope::System.as_str(),
        ],
    );
    assert_names(
        media_asset::MEDIA_ASSET_MARKETPLACE_STATUSES,
        &[
            media_asset::MediaAssetMarketplaceStatus::NotListed.as_str(),
            media_asset::MediaAssetMarketplaceStatus::Published.as_str(),
            media_asset::MediaAssetMarketplaceStatus::PendingReview.as_str(),
            media_asset::MediaAssetMarketplaceStatus::Hidden.as_str(),
            media_asset::MediaAssetMarketplaceStatus::Removed.as_str(),
        ],
    );
    assert_names(
        media_asset::MEDIA_ASSET_THUMBNAIL_STATUSES,
        &[
            media_asset::MediaAssetThumbnailStatus::Pending.as_str(),
            media_asset::MediaAssetThumbnailStatus::Ready.as_str(),
            media_asset::MediaAssetThumbnailStatus::Failed.as_str(),
            media_asset::MediaAssetThumbnailStatus::Skipped.as_str(),
        ],
    );
    assert_names(
        user_media_library_item::USER_MEDIA_LIBRARY_RELATION_TYPES,
        &[
            user_media_library_item::UserMediaLibraryRelationType::OwnerUpload.as_str(),
            user_media_library_item::UserMediaLibraryRelationType::PublicLibraryAdd.as_str(),
        ],
    );
    assert_names(
        user_media_library_item::USER_MEDIA_LIBRARY_ASSET_SCOPES,
        &[
            user_media_library_item::UserMediaLibraryAssetScope::Public.as_str(),
            user_media_library_item::UserMediaLibraryAssetScope::Private.as_str(),
        ],
    );
    assert_names(
        channel_extension_item::CHANNEL_EXTENSION_ITEM_CATEGORIES,
        &[
            channel_extension_item::ChannelExtensionItemCategory::Video.as_str(),
            channel_extension_item::ChannelExtensionItemCategory::Audio.as_str(),
            channel_extension_item::ChannelExtensionItemCategory::Gif.as_str(),
            channel_extension_item::ChannelExtensionItemCategory::Tts.as_str(),
        ],
    );
    assert_names(
        channel_extension_item::CHANNEL_EXTENSION_ITEM_TTS_MODES,
        &[
            channel_extension_item::ChannelExtensionItemTtsMode::Fixed.as_str(),
            channel_extension_item::ChannelExtensionItemTtsMode::Custom.as_str(),
        ],
    );
    assert_names(
        channel_extension_item::CHANNEL_EXTENSION_ITEM_TTS_LANGUAGES,
        &[
            channel_extension_item::ChannelExtensionItemTtsLanguage::En.as_str(),
            channel_extension_item::ChannelExtensionItemTtsLanguage::Es.as_str(),
        ],
    );
    assert_names(
        user_extension_inventory::EXTENSION_PLATFORMS,
        &[user_extension_inventory::ExtensionPlatform::Twitch.as_str()],
    );
    assert_names(
        user_extension_inventory::QUICK_PURCHASE_PRIORITIES,
        &[
            user_extension_inventory::QuickPurchasePriority::CreditsFirst.as_str(),
            user_extension_inventory::QuickPurchasePriority::BitsFirst.as_str(),
        ],
    );
    assert_names(
        user_extension_inventory::QUICK_PURCHASE_ACTIONS,
        &[
            user_extension_inventory::QuickPurchaseAction::UseNow.as_str(),
            user_extension_inventory::QuickPurchaseAction::Save.as_str(),
        ],
    );
    assert_names(
        user_extension_inventory::INVENTORY_ITEM_SOURCES,
        &[
            user_extension_inventory::InventoryItemSource::BitsPurchase.as_str(),
            user_extension_inventory::InventoryItemSource::CreditPurchase.as_str(),
            user_extension_inventory::InventoryItemSource::RefundCredit.as_str(),
            user_extension_inventory::InventoryItemSource::Gift.as_str(),
            user_extension_inventory::InventoryItemSource::AdminAdjustment.as_str(),
        ],
    );
    assert_names(
        extension_wallet_transaction::EXTENSION_WALLET_TRANSACTION_TYPES,
        &[
            extension_wallet_transaction::ExtensionWalletTransactionType::BitsPurchase.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::CreditPurchase.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::UseNow.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::SaveItem.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::RedeemSaved.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::RefundCredit.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::GiftIn.as_str(),
            extension_wallet_transaction::ExtensionWalletTransactionType::GiftOut.as_str(),
        ],
    );
    assert_names(
        dimafx_playback::DIMAFX_PLAYBACK_STATES,
        &[
            dimafx_playback::DimafxPlaybackState::Queued.as_str(),
            dimafx_playback::DimafxPlaybackState::Playing.as_str(),
            dimafx_playback::DimafxPlaybackState::Refunding.as_str(),
            dimafx_playback::DimafxPlaybackState::Completed.as_str(),
            dimafx_playback::DimafxPlaybackState::Refunded.as_str(),
        ],
    );
    assert_names(
        dimafx_playback::DIMAFX_QUEUE_SOURCES,
        &[
            dimafx_playback::DimafxQueueSource::BitsPurchase.as_str(),
            dimafx_playback::DimafxQueueSource::CreditPurchase.as_str(),
            dimafx_playback::DimafxQueueSource::RedeemSaved.as_str(),
            dimafx_playback::DimafxQueueSource::Test.as_str(),
        ],
    );
    assert_names(
        dimafx_playback::DIMAFX_QUEUE_LANGUAGES,
        &[
            dimafx_playback::DimafxQueueLanguage::En.as_str(),
            dimafx_playback::DimafxQueueLanguage::Es.as_str(),
        ],
    );
}

#[test]
fn prepare_insert_defaults_casts_and_nested_values() {
    let media = prepared(
        media_asset::schema(),
        media_input(oid(ID_A), "media/airhorn.mp3"),
    );
    assert_clock(&media);
    assert_null(&media, "legacyTriggerFileID");
    assert_null(&media, "proxyPath");
    assert_null(&media, "checksumSha256");
    assert_null(&media, "thumbnailAssetID");
    assert_null(&media, "thumbnailLastError");
    assert_null(&media, "deletedAt");
    assert_str(&media, "marketplaceStatus", "not_listed");
    assert_str(&media, "thumbnailStatus", "pending");
    assert_str(&media, "scope", "private");
    assert_i32(&media, "thumbnailAttempts", 0);
    assert_i32(&media, "libraryCount", 0);
    assert_i32(&media, "triggerReferenceCount", 0);
    assert_i32(&media, "alertReferenceCount", 0);
    assert_i32(&media, "extensionReferenceCount", 0);
    assert_i32(&media, "bytes", 12);

    let library = prepared(
        user_media_library_item::schema(),
        library_input(oid(ID_A), Bson::String(ID_A.to_owned()), None),
    );
    assert_clock(&library);
    assert_eq!(library.get_object_id("assetID").unwrap(), oid(ID_A));
    assert!(library.get_bool("isActive").unwrap());
    assert_null(&library, "localAlias");
    assert_null(&library, "deletedAt");
    assert_str(&library, "assetScope", "private");

    let mut trim = channel_input(oid(ID_A));
    trim.insert("name", "  Airhorn  ");
    trim.insert("bitsPrice", "100");
    let channel = prepared(channel_extension_item::schema(), trim);
    assert_clock(&channel);
    assert_str(&channel, "name", "Airhorn");
    assert_i32(&channel, "bitsPrice", 100);
    assert_str(&channel, "category", "video");
    assert_str(&channel, "description", "");
    assert_str(&channel, "thumbnailUrl", "");
    assert_i32(&channel, "durationMs", 0);
    assert_i32(&channel, "volume", 100);
    assert!(channel.get_bool("isEnabled").unwrap());
    assert_i32(&channel, "sortOrder", 0);
    assert_null(&channel, "tts");
    assert_null(&channel, "deletedAt");
    assert_eq!(channel.get_object_id("assetID").unwrap(), oid(ID_B));

    let tts = prepared(
        channel_extension_item::schema(),
        doc! {
            "_id": oid(ID_A),
            "channelID": "channel",
            "channelName": "Channel",
            "createdByUserID": "user",
            "assetID": Bson::Null,
            "name": "Hello",
            "category": "tts",
            "mediaType": "audio",
            "bitsPrice": 50,
            "sku": "hello",
            "tts": { "text": "  hello  ", "language": "es" },
        },
    );
    assert_null(&tts, "assetID");
    assert_str(&tts, "category", "tts");
    assert_i32(&tts, "volume", 100);
    let tts_config = tts.get_document("tts").unwrap();
    assert!(!tts_config.contains_key("_id"));
    assert_str(tts_config, "mode", "custom");
    assert_str(tts_config, "text", "hello");
    assert_str(tts_config, "voice", "");
    assert_str(tts_config, "language", "es");

    let mut gap = channel_input(oid(ID_A));
    gap.remove("assetID");
    gap.insert("category", "video");
    let errors = channel_extension_item::schema()
        .prepare_insert(gap.clone(), clock())
        .unwrap_err();
    assert!(
        errors
            .0
            .iter()
            .any(|error| error.path == "assetID" && error.kind == "required")
    );
    gap.insert("assetID", Bson::Null);
    assert!(
        channel_extension_item::schema()
            .prepare_insert(gap.clone(), clock())
            .is_err()
    );
    gap.remove("category");
    assert!(
        channel_extension_item::schema()
            .prepare_insert(gap, clock())
            .is_err()
    );

    let inventory = prepared(
        user_extension_inventory::schema(),
        inventory_input(oid(ID_A)),
    );
    assert_clock(&inventory);
    assert_str(&inventory, "platform", "twitch");
    assert_i32(&inventory, "balance", 0);
    assert_null(&inventory, "displayName");
    assert!(inventory.get_array("dimafxReceipts").unwrap().is_empty());
    let config = inventory.get_document("config").unwrap();
    assert_str(config, "quickPurchasePriority", "credits_first");
    assert_str(config, "quickPurchaseAction", "use_now");
    let item = inventory.get_array("items").unwrap()[0]
        .as_document()
        .unwrap();
    assert!(!item.contains_key("_id"));
    assert_i32(item, "quantity", 0);
    assert_i32(item, "purchasePriceBits", 0);
    assert_str(item, "source", "bits_purchase");
    assert_eq!(item.get_datetime("acquiredAt").unwrap(), &clock());

    let wallet = prepared(
        extension_wallet_transaction::schema(),
        wallet_input(oid(ID_A), None),
    );
    assert_clock(&wallet);
    assert_str(&wallet, "platform", "twitch");
    assert_null(&wallet, "userID");
    assert_null(&wallet, "opaqueUserID");
    assert_str(&wallet, "type", "bits_purchase");
    assert_i32(&wallet, "amountBits", 0);
    assert_i32(&wallet, "balanceDelta", 0);
    assert_null(&wallet, "channelExtensionItemID");
    assert_null(&wallet, "twitchTransactionID");
    assert_null(&wallet, "sku");
    assert_str(wallet.get_document("metadata").unwrap(), "reason", "test");
    let mut empty_metadata = wallet_input(oid(ID_A), None);
    empty_metadata.insert("metadata", doc! {});
    assert!(
        !prepared(extension_wallet_transaction::schema(), empty_metadata).contains_key("metadata")
    );
    let mut omitted_metadata = wallet_input(oid(ID_A), None);
    omitted_metadata.remove("metadata");
    assert!(
        !prepared(extension_wallet_transaction::schema(), omitted_metadata)
            .contains_key("metadata")
    );

    let playback = prepared(dimafx_playback::schema(), playback_input("bits-ledger-1"));
    assert_clock(&playback);
    assert_str(&playback, "_id", "bits-ledger-1");
    assert_str(&playback, "state", "queued");
    assert_str(&playback, "leaseOwner", "");
    assert_eq!(
        playback.get_datetime("leaseUntil").unwrap(),
        &DateTime::from_millis(0)
    );
    assert!(!playback.contains_key("failure"));
    let payload = playback.get_document("payload").unwrap();
    assert!(matches!(
        payload.get("enqueuedAt"),
        Some(Bson::Double(value)) if *value == 1_900_000_000_000.0
    ));
    assert_i32(payload, "volume", 100);
}

fn faults(schema: &SchemaDefinition, input: Document) -> Vec<(String, String)> {
    let mut pairs = schema
        .prepare_insert(input, clock())
        .unwrap_err()
        .0
        .into_iter()
        .map(|error| (error.path, error.kind.to_owned()))
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
}

fn one(path: &str, kind: &str) -> Vec<(String, String)> {
    vec![(path.to_owned(), kind.to_owned())]
}

#[test]
fn validation_errors_use_source_kinds() {
    let mut media = media_input(oid(ID_A), "media/airhorn.mp3");
    media.insert("mediaType", "nope");
    assert_eq!(
        faults(media_asset::schema(), media),
        one("mediaType", "enum")
    );
    let mut media = media_input(oid(ID_A), "media/airhorn.mp3");
    media.remove("s3Key");
    assert_eq!(
        faults(media_asset::schema(), media),
        one("s3Key", "required")
    );

    let mut library = library_input(oid(ID_A), oid(ID_B).into(), None);
    library.insert("relationType", "nope");
    assert_eq!(
        faults(user_media_library_item::schema(), library),
        one("relationType", "enum")
    );
    let mut library = library_input(oid(ID_A), oid(ID_B).into(), None);
    library.remove("channelID");
    assert_eq!(
        faults(user_media_library_item::schema(), library),
        one("channelID", "required")
    );
    assert_eq!(
        faults(
            user_media_library_item::schema(),
            library_input(oid(ID_A), Bson::String("not-an-objectid".into()), None),
        ),
        one("assetID", "cast")
    );

    let mut channel = channel_input(oid(ID_A));
    channel.insert("category", "image");
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("category", "enum")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.remove("createdByUserID");
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("createdByUserID", "required")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.remove("channelID");
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("channelID", "required")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.remove("bitsPrice");
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("bitsPrice", "required")
    );
    assert_eq!(
        faults(
            channel_extension_item::schema(),
            doc! { "_id": oid(ID_A), "channelID": "channel", "channelName": "Channel", "createdByUserID": "user", "assetID": oid(ID_B), "name": "", "mediaType": "audio", "bitsPrice": 25, "sku": "airhorn" },
        ),
        one("name", "required")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.insert("name", "   ");
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("name", "required")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.insert("name", "a".repeat(81));
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("name", "maxlength")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.insert("category", "tts");
    channel.insert("tts", doc! { "text": "a".repeat(501) });
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("tts.text", "maxlength")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.insert("volume", 101);
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("volume", "max")
    );
    let mut channel = channel_input(oid(ID_A));
    channel.insert("volume", -1);
    assert_eq!(
        faults(channel_extension_item::schema(), channel),
        one("volume", "min")
    );

    let mut inventory = inventory_input(oid(ID_A));
    set_item(&mut inventory, "source", "nope");
    assert_eq!(
        faults(user_extension_inventory::schema(), inventory),
        one("items.0.source", "enum")
    );
    let mut inventory = inventory_input(oid(ID_A));
    inventory.insert("config", doc! { "quickPurchasePriority": "nope" });
    assert_eq!(
        faults(user_extension_inventory::schema(), inventory),
        one("config.quickPurchasePriority", "enum")
    );
    let mut inventory = inventory_input(oid(ID_A));
    set_item(&mut inventory, "quantity", -1);
    assert_eq!(
        faults(user_extension_inventory::schema(), inventory),
        one("items.0.quantity", "min")
    );
    let mut inventory = inventory_input(oid(ID_A));
    inventory.insert("balance", -1);
    assert_eq!(
        faults(user_extension_inventory::schema(), inventory),
        one("balance", "min")
    );
    let mut inventory = inventory_input(oid(ID_A));
    inventory.remove("userID");
    assert_eq!(
        faults(user_extension_inventory::schema(), inventory),
        one("userID", "required")
    );

    let mut wallet = wallet_input(oid(ID_A), None);
    wallet.insert("type", "nope");
    assert_eq!(
        faults(extension_wallet_transaction::schema(), wallet),
        one("type", "enum")
    );

    let mut playback = playback_input("bits-ledger-1");
    playback.insert("state", "nope");
    assert_eq!(
        faults(dimafx_playback::schema(), playback),
        one("state", "enum")
    );
    let mut playback = playback_input("bits-ledger-1");
    playback.remove("payload");
    assert_eq!(
        faults(dimafx_playback::schema(), playback),
        one("payload", "required")
    );
    let mut playback = playback_input("bits-ledger-1");
    playback.remove("_id");
    assert_eq!(
        faults(dimafx_playback::schema(), playback),
        one("_id", "required")
    );
}

fn without_version(document: &Document) -> Document {
    let mut document = document.clone();
    document.remove("__v");
    document
}

fn assert_round_trip(prepared: &Document, typed: Document) {
    let stored = without_version(prepared);
    assert!(
        documents_eq(&stored, &typed),
        "stored {stored:?}\ntyped {typed:?}"
    );
}

#[test]
fn strict_dtos_round_trip_raw_bson() {
    let media = prepared(
        media_asset::schema(),
        media_input(oid(ID_A), "media/airhorn.mp3"),
    );
    let typed = media_asset::IMediaAsset::from_document(&without_version(&media)).unwrap();
    assert_eq!(
        typed.marketplace_status,
        media_asset::MediaAssetMarketplaceStatus::NotListed
    );
    assert_eq!(
        typed.thumbnail_status,
        media_asset::MediaAssetThumbnailStatus::Pending
    );
    assert!(typed.proxy_path.is_none());
    assert_eq!(typed.bytes, 12.0);
    assert_round_trip(&media, typed.to_document());

    let library = prepared(
        user_media_library_item::schema(),
        library_input(oid(ID_C), Bson::String(ID_A.to_owned()), None),
    );
    let typed =
        user_media_library_item::IUserMediaLibraryItem::from_document(&without_version(&library))
            .unwrap();
    assert_eq!(typed.asset_id, oid(ID_A));
    assert_eq!(typed.media_type, media_asset::MediaAssetType::Audio);
    assert!(typed.local_alias.is_none());
    assert!(typed.is_active);
    assert_round_trip(&library, typed.to_document());

    let mut trim = channel_input(oid(ID_A));
    trim.insert("name", "  Airhorn  ");
    trim.insert("bitsPrice", "100");
    let channel = prepared(channel_extension_item::schema(), trim);
    let typed =
        channel_extension_item::IChannelExtensionItem::from_document(&without_version(&channel))
            .unwrap();
    assert_eq!(typed.name.as_str(), Some("Airhorn"));
    assert_eq!(typed.bits_price, 100.0);
    assert!(typed.tts.is_none());
    assert_eq!(typed.asset_id, Some(oid(ID_B)));
    assert_round_trip(&channel, typed.to_document());

    let tts = prepared(
        channel_extension_item::schema(),
        doc! {
            "_id": oid(ID_A),
            "channelID": "channel",
            "channelName": "Channel",
            "createdByUserID": "user",
            "assetID": Bson::Null,
            "name": "Hello",
            "category": "tts",
            "mediaType": "audio",
            "bitsPrice": 50,
            "sku": "hello",
            "tts": { "text": "  hello  ", "language": "es" },
        },
    );
    let typed =
        channel_extension_item::IChannelExtensionItem::from_document(&without_version(&tts))
            .unwrap();
    assert!(typed.asset_id.is_none());
    assert_eq!(
        typed.category,
        channel_extension_item::ChannelExtensionItemCategory::Tts
    );
    let config = typed.tts.clone().unwrap();
    assert_eq!(
        config.mode,
        channel_extension_item::ChannelExtensionItemTtsMode::Custom
    );
    assert_eq!(config.text.as_str(), Some("hello"));
    assert_eq!(config.voice.as_str(), Some(""));
    assert_eq!(
        config.language,
        channel_extension_item::ChannelExtensionItemTtsLanguage::Es
    );
    assert_round_trip(&tts, typed.to_document());

    let inventory = prepared(
        user_extension_inventory::schema(),
        inventory_input(oid(ID_A)),
    );
    let typed = user_extension_inventory::IUserExtensionInventory::from_document(&without_version(
        &inventory,
    ))
    .unwrap();
    assert_eq!(
        typed.platform,
        user_extension_inventory::ExtensionPlatform::Twitch
    );
    assert_eq!(
        typed.config,
        user_extension_inventory::DEFAULT_EXTENSION_INVENTORY_CONFIG
    );
    assert!(typed.display_name.is_none());
    assert_eq!(typed.items.len(), 1);
    assert_eq!(typed.items[0].quantity, 0.0);
    assert_eq!(
        typed.items[0].source,
        user_extension_inventory::InventoryItemSource::BitsPurchase
    );
    assert_round_trip(&inventory, typed.to_document());

    let wallet = prepared(
        extension_wallet_transaction::schema(),
        wallet_input(oid(ID_A), None),
    );
    let typed = extension_wallet_transaction::IExtensionWalletTransaction::from_document(
        &without_version(&wallet),
    )
    .unwrap();
    assert!(typed.user_id.is_none());
    assert_eq!(typed.amount_bits, 0.0);
    assert_eq!(typed.metadata.get_str("reason").unwrap(), "test");
    assert_eq!(
        typed.transaction_type,
        extension_wallet_transaction::ExtensionWalletTransactionType::BitsPurchase
    );
    assert_round_trip(&wallet, typed.to_document());
    let mut open = wallet.clone();
    open.get_document_mut("metadata")
        .unwrap()
        .insert("viewerText", "hi");
    let typed =
        extension_wallet_transaction::IExtensionWalletTransaction::from_document(&open).unwrap();
    assert_eq!(typed.metadata.get_str("viewerText").unwrap(), "hi");
    assert_eq!(typed.metadata.get_str("reason").unwrap(), "test");
    assert_eq!(
        typed
            .to_document()
            .get_document("metadata")
            .unwrap()
            .get_str("viewerText")
            .unwrap(),
        "hi"
    );

    let playback = prepared(dimafx_playback::schema(), playback_input("bits-ledger-1"));
    let typed =
        dimafx_playback::IDimafxPlayback::from_document(&without_version(&playback)).unwrap();
    assert_eq!(typed.id.as_str(), Some("bits-ledger-1"));
    assert!(typed.failure.is_none());
    assert_eq!(typed.state, dimafx_playback::DimafxPlaybackState::Queued);
    assert_eq!(typed.payload.enqueued_at, 1_900_000_000_000.0);
    assert_eq!(
        typed.payload.source,
        dimafx_playback::DimafxQueueSource::BitsPurchase
    );
    assert!(typed.payload.media_url.is_none());
    assert!(typed.payload.refund_on_failure.is_none());
    assert_round_trip(&playback, typed.to_document());

    let mut extra = playback_input("bits-ledger-1");
    extra
        .get_document_mut("payload")
        .unwrap()
        .insert("bonus", "kept");
    let extra = prepared(dimafx_playback::schema(), extra);
    assert_eq!(
        extra
            .get_document("payload")
            .unwrap()
            .get_str("bonus")
            .unwrap(),
        "kept"
    );
    let typed = dimafx_playback::IDimafxPlayback::from_document(&extra).unwrap();
    assert!(!typed.payload.to_document().contains_key("bonus"));

    let mut rejected = playback.clone();
    rejected.insert("failure", Bson::Null);
    assert!(dimafx_playback::IDimafxPlayback::from_document(&rejected).is_err());
}

fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn error_pairs(value: &serde_json::Value) -> Vec<(String, String)> {
    let mut pairs = value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_owned(),
                item["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
}

#[test]
#[ignore = "requires MEDIA_EXTENSION_SCHEMA_ORACLE and MEDIA_EXTENSION_SCHEMA_ORACLE_SHA256"]
fn replay_actual_mongoose_source() {
    use std::{fs, path::PathBuf};
    let path = PathBuf::from(std::env::var("MEDIA_EXTENSION_SCHEMA_ORACLE").unwrap());
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let checkout = manifest.parent().unwrap();
    assert!(path.is_absolute());
    assert_eq!(fs::canonicalize(&path).unwrap(), path);
    assert!(!path.starts_with(checkout));
    assert!(fs::symlink_metadata(&path).unwrap().is_file());
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        sha256::sha256_hex(&bytes),
        std::env::var("MEDIA_EXTENSION_SCHEMA_ORACLE_SHA256").unwrap()
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["schemaVersion"], 1);
    assert_eq!(
        fixture["versions"],
        serde_json::json!({"typescript": "5.9.3", "mongoose": "8.24.2", "bson": "6.10.4"})
    );
    let sources = fixture["sources"].as_object().unwrap();
    assert_eq!(sources.len(), SOURCE_FILES.len());
    for relative in SOURCE_FILES {
        let bytes = fs::read(manifest.join(*relative)).unwrap();
        assert_eq!(
            sources[*relative].as_str().unwrap(),
            sha256::sha256_hex(&bytes),
            "{relative}"
        );
    }
    let models = fixture["models"].as_array().unwrap();
    let schemas = schemas();
    assert_eq!(models.len(), schemas.len());
    for (model, schema) in models.iter().zip(schemas) {
        assert_eq!(model["model"], schema.model);
        assert_eq!(model["collection"], schema.collection);
        assert_eq!(model["versionKey"], true);
        assert!(schema.version_key);
        assert_eq!(model["createdAt"], "createdAt");
        assert_eq!(model["updatedAt"], "updatedAt");
        assert_eq!(schema.timestamps, Some(("createdAt", "updatedAt")));
        assert!(
            schema
                .indexes
                .iter()
                .all(|index| index.ttl.is_none() && !index.sparse)
        );
        let expected_indexes = model["indexes"].as_array().unwrap();
        let actual_indexes = schema.indexes.iter().map(index_wire).collect::<Vec<_>>();
        assert_eq!(actual_indexes.len(), expected_indexes.len());
        for (actual, expected_hex) in actual_indexes.iter().zip(expected_indexes) {
            let expected: Document =
                mongodb::bson::deserialize_from_slice(&decode_hex(expected_hex.as_str().unwrap()))
                    .unwrap();
            assert!(
                ordered_doc_eq(actual, &expected),
                "index {actual:?} vs {expected:?}"
            );
        }
    }
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(
        fixture["caseCount"].as_u64().unwrap() as usize,
        LABELS.len()
    );
    assert_eq!(
        cases
            .iter()
            .map(|case| case["label"].as_str().unwrap())
            .collect::<Vec<_>>(),
        LABELS
    );
    let mut mismatches = Vec::new();
    for case in cases {
        let label = case["label"].as_str().unwrap();
        let model = case["model"].as_u64().unwrap() as usize;
        let input: Document =
            mongodb::bson::deserialize_from_slice(&decode_hex(case["inputHex"].as_str().unwrap()))
                .unwrap();
        let actual = schemas[model].prepare_insert(input, clock());
        let expected_errors = error_pairs(&case["errors"]);
        if expected_errors.is_empty() {
            let expected: Document = mongodb::bson::deserialize_from_slice(&decode_hex(
                case["outputHex"].as_str().unwrap(),
            ))
            .unwrap();
            match actual {
                Ok(document) if documents_eq(&expected, &document) => {}
                Ok(document) => mismatches.push(format!(
                    "{label}: expected {expected:?}, actual {document:?}"
                )),
                Err(errors) => {
                    mismatches.push(format!("{label}: expected document, actual {errors:?}"))
                }
            }
        } else {
            match actual {
                Err(errors) => {
                    let mut actual_errors = errors
                        .0
                        .into_iter()
                        .map(|error| (error.path, error.kind.to_owned()))
                        .collect::<Vec<_>>();
                    actual_errors.sort();
                    if actual_errors != expected_errors {
                        mismatches.push(format!(
                            "{label}: expected {expected_errors:?}, actual {actual_errors:?}"
                        ));
                    }
                }
                Ok(document) => mismatches.push(format!(
                    "{label}: expected {expected_errors:?}, actual {document:?}"
                )),
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

fn duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(error)) => {
            error.code == 11000
        }
        mongodb::error::ErrorKind::Command(error) => error.code == 11000,
        _ => false,
    }
}

fn assert_duplicate(result: Result<Document, PersistenceError>) {
    match result {
        Err(PersistenceError::Mongo(error)) => {
            assert!(
                duplicate_key(&error),
                "expected duplicate key 11000, got {error:?}"
            );
        }
        other => panic!("expected duplicate key, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires isolated owner-labelled private keyword Mongo"]
async fn private_mongo_models_indexes_and_defaults() {
    use futures_util::{FutureExt, TryStreamExt};
    use std::panic::AssertUnwindSafe;
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("MEDIA_EXTENSION_SCHEMA_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let ns = std::env::var("MEDIA_EXTENSION_SCHEMA_NAMESPACE").unwrap();
    let token = ns
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .unwrap();
    assert!(
        (6..=32).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    );
    let client = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("media_extension_schema_{token}"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let test = AssertUnwindSafe(async {
        let marker = db.collection::<Document>("__fixture_owner");
        marker
            .insert_one(doc! {"_id": "owner", "owner": "dimabot-migration", "namespace": &ns})
            .await
            .unwrap();
        let repos = [
            media_asset::repository(&db),
            user_media_library_item::repository(&db),
            channel_extension_item::repository(&db),
            user_extension_inventory::repository(&db),
            extension_wallet_transaction::repository(&db),
            dimafx_playback::repository(&db),
        ];
        let schemas = schemas();
        assert!(std::ptr::eq(repos[0].schema, schemas[0]));
        assert!(std::ptr::eq(repos[1].schema, schemas[1]));
        assert!(std::ptr::eq(repos[2].schema, schemas[2]));
        assert!(std::ptr::eq(repos[3].schema, schemas[3]));
        assert!(std::ptr::eq(repos[4].schema, schemas[4]));
        assert!(std::ptr::eq(repos[5].schema, schemas[5]));
        for (repo, collection_name) in repos.iter().zip([
            media_asset::COLLECTION_NAME,
            user_media_library_item::COLLECTION_NAME,
            channel_extension_item::COLLECTION_NAME,
            user_extension_inventory::COLLECTION_NAME,
            extension_wallet_transaction::COLLECTION_NAME,
            dimafx_playback::COLLECTION_NAME,
        ]) {
            assert_eq!(repo.collection.name(), collection_name);
            assert!(repo.collection.write_concern().is_none());
        }
        assert_eq!(media_asset::collection(&db).name(), media_asset::COLLECTION_NAME);
        assert!(media_asset::collection(&db).write_concern().is_none());
        assert_eq!(
            user_media_library_item::collection(&db).name(),
            user_media_library_item::COLLECTION_NAME
        );
        assert_eq!(
            channel_extension_item::collection(&db).name(),
            channel_extension_item::COLLECTION_NAME
        );
        assert_eq!(
            user_extension_inventory::collection(&db).name(),
            user_extension_inventory::COLLECTION_NAME
        );
        assert_eq!(
            extension_wallet_transaction::collection(&db).name(),
            extension_wallet_transaction::COLLECTION_NAME
        );
        assert_eq!(
            dimafx_playback::collection(&db).name(),
            dimafx_playback::COLLECTION_NAME
        );
        media_asset::install_indexes(&db).await.unwrap();
        user_media_library_item::install_indexes(&db).await.unwrap();
        channel_extension_item::install_indexes(&db).await.unwrap();
        user_extension_inventory::install_indexes(&db).await.unwrap();
        extension_wallet_transaction::install_indexes(&db)
            .await
            .unwrap();
        dimafx_playback::install_indexes(&db).await.unwrap();
        for repo in &repos {
            let listed: Vec<mongodb::IndexModel> = repo
                .collection
                .list_indexes()
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            assert_eq!(listed.len(), repo.schema.indexes.len() + 1);
            for index in &listed {
                assert!(
                    index
                        .options
                        .as_ref()
                        .and_then(|options| options.expire_after)
                        .is_none()
                );
                assert!(!index.options.as_ref().and_then(|options| options.sparse).unwrap_or(false));
            }
            for expected in &repo.schema.indexes {
                assert!(
                    listed.iter().any(|index| {
                        index.keys.keys().collect::<Vec<_>>() == expected.keys.keys().collect::<Vec<_>>()
                            && index.keys == expected.keys
                            && index.options.as_ref().and_then(|options| options.unique).unwrap_or(false)
                                == expected.unique
                            && index
                                .options
                                .as_ref()
                                .and_then(|options| options.partial_filter_expression.as_ref())
                                == expected.partial.as_ref()
                    }),
                    "missing {:?} in {listed:?}",
                    expected.keys
                );
            }
        }

        let inventory_filter = doc! {"platform": "twitch", "userID": "upsert-user", "channelID": "upsert-channel"};
        let inventory_insert = doc! {"platform": "twitch", "userID": "upsert-user", "channelID": "upsert-channel", "balance": 0, "config": {"quickPurchasePriority": "credits_first", "quickPurchaseAction": "use_now"}, "items": []};
        let inventory_upsert = repos[3].upsert_equality(&inventory_filter, &inventory_insert, &doc! {"displayName": "First"}, clock()).await.unwrap();
        assert_eq!(inventory_upsert.get_str("displayName").unwrap(), "First");
        assert_eq!(inventory_upsert.get_i32("__v").unwrap(), 0);
        assert!(inventory_upsert.get_array("dimafxReceipts").unwrap().is_empty());
        repos[3].collection.update_one(inventory_filter.clone(), doc! {"$set": {"balance": 7}}).await.unwrap();
        let inventory_again = repos[3].upsert_equality(&inventory_filter, &inventory_insert, &doc! {"displayName": "Second"}, later()).await.unwrap();
        assert_eq!(inventory_again.get_i32("balance").unwrap(), 7);
        assert_eq!(inventory_again.get_str("displayName").unwrap(), "Second");
        assert_eq!(inventory_again.get_datetime("createdAt").unwrap(), &clock());
        assert_eq!(inventory_again.get_datetime("updatedAt").unwrap(), &later());
        let playback_filter = doc! {"_id": "source-upsert"};
        let playback_insert = doc! {"channelID": "upsert-channel", "payload": {"triggerID": "source-upsert"}, "state": "queued", "leaseOwner": "", "leaseUntil": DateTime::from_millis(0)};
        let playback = repos[5].upsert_equality(&playback_filter, &playback_insert, &Document::new(), clock()).await.unwrap();
        assert_eq!(playback.get_i32("__v").unwrap(), 0);
        repos[5].collection.update_one(playback_filter.clone(), doc! {"$set": {"state": "playing"}}).await.unwrap();
        let playback_again = repos[5].upsert_equality(&playback_filter, &playback_insert, &Document::new(), later()).await.unwrap();
        assert_eq!(playback_again.get_str("state").unwrap(), "playing");
        assert_eq!(playback_again.get_document("payload").unwrap().get_str("triggerID").unwrap(), "source-upsert");
        assert_eq!(playback_again.get_datetime("createdAt").unwrap(), &clock());
        assert_eq!(playback_again.get_datetime("updatedAt").unwrap(), &later());
        assert!(repos[3].schema.prepare_equality_upsert(&inventory_filter, &doc! {"balance": 0}, &doc! {"balance": 1}, clock()).is_err());
        assert!(repos[3].schema.prepare_equality_upsert(&doc! {"userID": {"$ne": "x"}}, &Document::new(), &Document::new(), clock()).is_err());

        repos[0]
            .insert(media_input(oid(ID_A), "media/one"), clock())
            .await
            .unwrap();
        let media = repos[0]
            .find_one(doc! {"_id": oid(ID_A)})
            .await
            .unwrap()
            .unwrap();
        assert_str(&media, "marketplaceStatus", "not_listed");
        assert_duplicate(
            repos[0]
                .insert(media_input(oid(ID_C), "media/one"), clock())
                .await,
        );
        let library = repos[1]
            .insert(library_input(oid(ID_A), oid(ID_B).into(), Some(true)), clock())
            .await
            .unwrap();
        assert!(library.get_bool("isActive").unwrap());
        assert_duplicate(
            repos[1]
                .insert(library_input(oid(ID_C), oid(ID_B).into(), Some(true)), clock())
                .await,
        );
        repos[1]
            .insert(library_input(oid(ID_D), oid(ID_B).into(), Some(false)), clock())
            .await
            .unwrap();
        repos[1]
            .insert(library_input(oid(ID_E), oid(ID_B).into(), Some(false)), clock())
            .await
            .unwrap();
        let inactive = repos[1]
            .find_one(doc! {"_id": oid(ID_D)})
            .await
            .unwrap()
            .unwrap();
        assert!(!inactive.get_bool("isActive").unwrap());

        let channel = repos[2]
            .insert(
                doc! {
                    "_id": oid(ID_A),
                    "channelID": "channel",
                    "channelName": "Channel",
                    "createdByUserID": "user",
                    "assetID": oid(ID_B),
                    "name": "Airhorn",
                    "mediaType": "audio",
                    "bitsPrice": 25,
                    "sku": "airhorn",
                    "tts": { "text": "  hello  ", "language": "es" },
                },
                clock(),
            )
            .await
            .unwrap();
        assert_i32(&channel, "volume", 100);
        repos[2]
            .save(doc! {"_id": oid(ID_A), "name": "Renamed"}, later())
            .await
            .unwrap();
        let channel = repos[2]
            .find_one(doc! {"_id": oid(ID_A)})
            .await
            .unwrap()
            .unwrap();
        assert_str(&channel, "name", "Renamed");
        assert_i32(&channel, "volume", 100);
        assert_eq!(channel.get_datetime("createdAt").unwrap(), &clock());
        assert_eq!(channel.get_datetime("updatedAt").unwrap(), &later());
        let tts = channel.get_document("tts").unwrap();
        assert!(!tts.contains_key("_id"));
        assert_str(tts, "text", "hello");
        assert_str(tts, "mode", "custom");
        assert_str(tts, "voice", "");
        assert_str(tts, "language", "es");

        let inventory = repos[3]
            .insert(inventory_input(oid(ID_A)), clock())
            .await
            .unwrap();
        assert_i32(&inventory, "balance", 0);
        assert_duplicate(repos[3].insert(inventory_input(oid(ID_C)), clock()).await);
        repos[3]
            .save(doc! {"_id": oid(ID_A), "displayName": "Ada"}, later())
            .await
            .unwrap();
        let inventory = repos[3]
            .find_one(doc! {"_id": oid(ID_A)})
            .await
            .unwrap()
            .unwrap();
        assert_str(&inventory, "displayName", "Ada");
        assert_i32(&inventory, "balance", 0);
        assert_eq!(inventory.get_datetime("createdAt").unwrap(), &clock());
        assert_eq!(inventory.get_datetime("updatedAt").unwrap(), &later());
        let item = inventory.get_array("items").unwrap()[0]
            .as_document()
            .unwrap();
        assert!(!item.contains_key("_id"));
        assert_i32(item, "quantity", 0);
        assert_eq!(item.get_datetime("acquiredAt").unwrap(), &clock());

        repos[4]
            .insert(wallet_input(oid(ID_A), None), clock())
            .await
            .unwrap();
        let explicit_null = repos[4]
            .insert(wallet_input(oid(ID_C), Some(Bson::Null)), clock())
            .await
            .unwrap();
        assert_null(&explicit_null, "twitchTransactionID");
        repos[4]
            .insert(wallet_input(oid(ID_D), Some(Bson::String("tx-1".into()))), clock())
            .await
            .unwrap();
        assert_duplicate(
            repos[4]
                .insert(wallet_input(oid(ID_E), Some(Bson::String("tx-1".into()))), clock())
                .await,
        );

        let playback = repos[5]
            .insert(playback_input("bits-ledger-1"), clock())
            .await
            .unwrap();
        assert_str(&playback, "state", "queued");
        let playback = repos[5]
            .find_one(doc! {"_id": "bits-ledger-1"})
            .await
            .unwrap()
            .unwrap();
        assert_str(&playback, "state", "queued");
        assert_str(&playback, "leaseOwner", "");
        assert_eq!(
            playback.get_datetime("leaseUntil").unwrap(),
            &DateTime::from_millis(0)
        );
        assert_eq!(playback.get_datetime("createdAt").unwrap(), &clock());
        assert!(!playback.get_document("payload").unwrap().contains_key("_id"));

        for (repo, id) in [
            (&repos[0], Bson::ObjectId(oid(ID_A))),
            (&repos[1], Bson::ObjectId(oid(ID_A))),
            (&repos[2], Bson::ObjectId(oid(ID_A))),
            (&repos[3], Bson::ObjectId(oid(ID_A))),
            (&repos[4], Bson::ObjectId(oid(ID_A))),
            (&repos[5], Bson::String("bits-ledger-1".into())),
        ] {
            let deleted = repo
                .collection
                .delete_one(doc! {"_id": id.clone()})
                .await
                .unwrap();
            assert_eq!(deleted.deleted_count, 1);
            assert!(repo.find_one(doc! {"_id": id}).await.unwrap().is_none());
        }
    })
    .catch_unwind()
    .await;
    let marker = db
        .collection::<Document>("__fixture_owner")
        .find_one(doc! {"_id": "owner", "owner": "dimabot-migration", "namespace": &ns})
        .await
        .unwrap();
    if marker.is_some() {
        db.drop().await.unwrap();
    }
    if let Err(error) = test {
        std::panic::resume_unwind(error);
    }
    assert!(marker.is_some(), "fixture ownership marker missing");
}
