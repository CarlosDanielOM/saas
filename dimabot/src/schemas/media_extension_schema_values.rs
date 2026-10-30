//! Inventory platform and quick-purchase values shared with the wallet schema.
//! Strict readers describe the TypeScript interfaces. The repository document
//! remains the raw BSON value, including nulls and Mixed extras.
use super::ordinary_model_values::{Reader, StrictDecodeError, bson_string};
use crate::utils::js_string::JsString;
use mongodb::bson::{Bson, DateTime, Document, oid::ObjectId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtensionPlatform {
    Twitch,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuickPurchasePriority {
    CreditsFirst,
    BitsFirst,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuickPurchaseAction {
    UseNow,
    Save,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryItemSource {
    BitsPurchase,
    CreditPurchase,
    RefundCredit,
    Gift,
    AdminAdjustment,
}

pub const EXTENSION_PLATFORMS: &[&str] = &["twitch"];
pub const QUICK_PURCHASE_PRIORITIES: &[&str] = &["credits_first", "bits_first"];
pub const QUICK_PURCHASE_ACTIONS: &[&str] = &["use_now", "save"];
pub const INVENTORY_ITEM_SOURCES: &[&str] = &[
    "bits_purchase",
    "credit_purchase",
    "refund_credit",
    "gift",
    "admin_adjustment",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IUserExtensionInventoryConfig {
    pub quick_purchase_priority: QuickPurchasePriority,
    pub quick_purchase_action: QuickPurchaseAction,
}

pub const DEFAULT_EXTENSION_INVENTORY_CONFIG: IUserExtensionInventoryConfig =
    IUserExtensionInventoryConfig {
        quick_purchase_priority: QuickPurchasePriority::CreditsFirst,
        quick_purchase_action: QuickPurchaseAction::UseNow,
    };

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
string_enum!(ExtensionPlatform { Twitch => "twitch" });
string_enum!(QuickPurchasePriority { CreditsFirst => "credits_first", BitsFirst => "bits_first" });
string_enum!(QuickPurchaseAction { UseNow => "use_now", Save => "save" });
string_enum!(InventoryItemSource {
    BitsPurchase => "bits_purchase",
    CreditPurchase => "credit_purchase",
    RefundCredit => "refund_credit",
    Gift => "gift",
    AdminAdjustment => "admin_adjustment",
});

pub fn path_of(reader: &Reader<'_>, key: &str) -> String {
    if reader.location().is_empty() {
        key.to_owned()
    } else {
        format!("{}.{key}", reader.location())
    }
}

pub fn strict_error(reader: &Reader<'_>, key: &str, kind: &'static str) -> StrictDecodeError {
    StrictDecodeError {
        path: path_of(reader, key),
        kind,
    }
}

pub fn parsed_enum<T>(
    reader: &Reader<'_>,
    key: &str,
    parse: impl FnOnce(&str) -> Option<T>,
) -> Result<T, StrictDecodeError> {
    let value = reader.require_string(key)?;
    parse(value.as_str().unwrap_or("")).ok_or_else(|| strict_error(reader, key, "enum"))
}

/// Missing and BSON null are both absent in the strict `T | null` view.
pub fn nullable_string(
    reader: &Reader<'_>,
    key: &str,
) -> Result<Option<JsString>, StrictDecodeError> {
    match reader.document().get(key) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::String(value)) => Ok(Some(JsString::from(value.as_str()))),
        Some(_) => Err(strict_error(reader, key, "type")),
    }
}

pub fn nullable_object_id(
    reader: &Reader<'_>,
    key: &str,
) -> Result<Option<ObjectId>, StrictDecodeError> {
    match reader.document().get(key) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::ObjectId(value)) => Ok(Some(*value)),
        Some(_) => Err(strict_error(reader, key, "type")),
    }
}

pub fn nullable_datetime(
    reader: &Reader<'_>,
    key: &str,
) -> Result<Option<DateTime>, StrictDecodeError> {
    match reader.document().get(key) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::DateTime(value)) => Ok(Some(*value)),
        Some(_) => Err(strict_error(reader, key, "type")),
    }
}

pub fn nullable_document<'a>(
    reader: &Reader<'a>,
    key: &str,
) -> Result<Option<Reader<'a>>, StrictDecodeError> {
    match reader.document().get(key) {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::Document(document)) => {
            Ok(Some(Reader::with_prefix(document, &path_of(reader, key))))
        }
        Some(_) => Err(strict_error(reader, key, "type")),
    }
}

/// Missing Mixed storage reads as an empty document. Explicit null is rejected.
pub fn mixed_document(reader: &Reader<'_>, key: &str) -> Result<Document, StrictDecodeError> {
    match reader.document().get(key) {
        None => Ok(Document::new()),
        Some(Bson::Document(document)) => Ok(document.clone()),
        Some(_) => Err(strict_error(reader, key, "type")),
    }
}

pub fn document_array<'a>(
    reader: &Reader<'a>,
    key: &str,
) -> Result<Vec<(&'a Document, String)>, StrictDecodeError> {
    let values = reader.require_array(key)?;
    let mut documents = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let path = format!("{}.{index}", path_of(reader, key));
        let Bson::Document(document) = value else {
            return Err(StrictDecodeError { path, kind: "type" });
        };
        documents.push((document, path));
    }
    Ok(documents)
}

pub fn require_string_array(
    reader: &Reader<'_>,
    key: &str,
) -> Result<Vec<JsString>, StrictDecodeError> {
    let values = reader.require_array(key)?;
    let mut strings = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        match value {
            Bson::String(value) => strings.push(JsString::from(value.as_str())),
            _ => {
                return Err(StrictDecodeError {
                    path: format!("{}.{index}", path_of(reader, key)),
                    kind: "type",
                });
            }
        }
    }
    Ok(strings)
}

pub fn insert_or_null_string(document: &mut Document, key: &str, value: &Option<JsString>) {
    match value {
        Some(value) => {
            document.insert(key, bson_string(value));
        }
        None => {
            document.insert(key, Bson::Null);
        }
    }
}

pub fn insert_or_null_object_id(document: &mut Document, key: &str, value: Option<ObjectId>) {
    match value {
        Some(value) => {
            document.insert(key, value);
        }
        None => {
            document.insert(key, Bson::Null);
        }
    }
}

pub fn insert_or_null_datetime(document: &mut Document, key: &str, value: Option<DateTime>) {
    match value {
        Some(value) => {
            document.insert(key, value);
        }
        None => {
            document.insert(key, Bson::Null);
        }
    }
}

pub fn insert_mixed(document: &mut Document, key: &str, value: &Document) {
    if !value.is_empty() {
        document.insert(key, value.clone());
    }
}

impl IUserExtensionInventoryConfig {
    pub fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            quick_purchase_priority: parsed_enum(
                reader,
                "quickPurchasePriority",
                QuickPurchasePriority::parse,
            )?,
            quick_purchase_action: parsed_enum(
                reader,
                "quickPurchaseAction",
                QuickPurchaseAction::parse,
            )?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert(
            "quickPurchasePriority",
            self.quick_purchase_priority.as_str(),
        );
        document.insert("quickPurchaseAction", self.quick_purchase_action.as_str());
        document
    }
}
