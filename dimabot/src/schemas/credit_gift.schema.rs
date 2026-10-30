use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use crate::utils::js_string::JsString;
use mongodb::bson::doc;
use std::sync::OnceLock;
pub const CREDIT_GIFT_STATUSES: &[&str] = &[
    "awaiting_payment",
    "payment_received",
    "delivering",
    "delivered",
    "needs_support",
];
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| {
        let mut fields = vec![
            Field::new("_id", T::String).required(),
            Field::new("buyerId", T::ObjectId).required(),
            Field::new("recipientId", T::ObjectId).required(),
        ];
        fields.extend(
            [
                "buyerLogin",
                "recipientLogin",
                "recipientName",
                "recipientChannelId",
                "productId",
                "fulfillmentProductId",
                "benefitId",
                "priceCurrency",
            ]
            .map(|name| Field::new(name, T::String).required()),
        );
        fields
            .extend(["credits", "priceAmount"].map(|name| Field::new(name, T::Number).required()));
        fields.push(
            Field::new("status", T::String)
                .required()
                .enumeration(CREDIT_GIFT_STATUSES),
        );
        fields.push(Field::new("noRefundsAcknowledgedAt", T::Date).required());
        fields.extend(
            [
                "purchaseCreateStartedAt",
                "paidAt",
                "fulfillmentCreateStartedAt",
                "deliveredAt",
                "announcedAt",
                "announcementStoppedAt",
                "leaseUntil",
            ]
            .map(|name| Field::new(name, T::Date)),
        );
        fields.extend(
            [
                "checkoutId",
                "paidOrderId",
                "buyerCustomerId",
                "fulfillmentCheckoutId",
                "fulfillmentOrderId",
                "recipientCustomerId",
                "grantId",
                "announcementMessageId",
                "lastError",
                "leaseToken",
            ]
            .map(|name| Field::new(name, T::String)),
        );
        fields.push(Field::new("checkoutUrl", T::String).hidden());
        fields.push(Field::new("announcementAttempts", T::Number).default(D::Number(0.0)));
        fields.push(Field::new("attempts", T::Number).default(D::Number(0.0)));
        fields.push(Field::new("nextAttemptAt", T::Date).required());
        SchemaDefinition {
            model: "CreditGift",
            collection: "creditgifts",
            string_id: true,
            version_key: true,
            write_concern_journaled: false,
            timestamps: Some(("createdAt", "updatedAt")),
            save_clock_field: None,
            indexes: vec![
                SchemaIndex::new(doc! {"nextAttemptAt":1,"leaseUntil":1}),
                SchemaIndex::new(doc! {"checkoutId":1}),
            ],
            fields,
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CreditGiftStatus {
    #[serde(rename = "awaiting_payment")]
    AwaitingPayment,
    #[serde(rename = "payment_received")]
    PaymentReceived,
    #[serde(rename = "delivering")]
    Delivering,
    #[serde(rename = "delivered")]
    Delivered,
    #[serde(rename = "needs_support")]
    NeedsSupport,
}
impl CreditGiftStatus {
    pub const ALL: [Self; 5] = [
        Self::AwaitingPayment,
        Self::PaymentReceived,
        Self::Delivering,
        Self::Delivered,
        Self::NeedsSupport,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingPayment => CREDIT_GIFT_STATUSES[0],
            Self::PaymentReceived => CREDIT_GIFT_STATUSES[1],
            Self::Delivering => CREDIT_GIFT_STATUSES[2],
            Self::Delivered => CREDIT_GIFT_STATUSES[3],
            Self::NeedsSupport => CREDIT_GIFT_STATUSES[4],
        }
    }
}
impl std::str::FromStr for CreditGiftStatus {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|entry| entry.as_str() == value)
            .ok_or(())
    }
}

/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICreditGift {
    pub id: JsString,
    pub buyer_id: mongodb::bson::oid::ObjectId,
    pub recipient_id: mongodb::bson::oid::ObjectId,
    pub buyer_login: JsString,
    pub recipient_login: JsString,
    pub recipient_name: JsString,
    pub recipient_channel_id: JsString,
    pub product_id: JsString,
    pub fulfillment_product_id: JsString,
    pub benefit_id: JsString,
    pub credits: f64,
    pub price_amount: f64,
    pub price_currency: JsString,
    pub status: CreditGiftStatus,
    pub no_refunds_acknowledged_at: mongodb::bson::DateTime,
    pub purchase_create_started_at: Option<mongodb::bson::DateTime>,
    pub checkout_id: Option<JsString>,
    pub checkout_url: Option<JsString>,
    pub paid_order_id: Option<JsString>,
    pub buyer_customer_id: Option<JsString>,
    pub paid_at: Option<mongodb::bson::DateTime>,
    pub fulfillment_create_started_at: Option<mongodb::bson::DateTime>,
    pub fulfillment_checkout_id: Option<JsString>,
    pub fulfillment_order_id: Option<JsString>,
    pub recipient_customer_id: Option<JsString>,
    pub grant_id: Option<JsString>,
    pub delivered_at: Option<mongodb::bson::DateTime>,
    pub announced_at: Option<mongodb::bson::DateTime>,
    pub announcement_message_id: Option<JsString>,
    pub announcement_stopped_at: Option<mongodb::bson::DateTime>,
    pub announcement_attempts: f64,
    pub attempts: f64,
    pub next_attempt_at: mongodb::bson::DateTime,
    pub last_error: Option<JsString>,
    pub lease_token: Option<JsString>,
    pub lease_until: Option<mongodb::bson::DateTime>,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICreditGiftBson {
    #[serde(rename = "_id")]
    pub id: String,
    pub buyer_id: mongodb::bson::oid::ObjectId,
    pub recipient_id: mongodb::bson::oid::ObjectId,
    pub buyer_login: String,
    pub recipient_login: String,
    pub recipient_name: String,
    pub recipient_channel_id: String,
    pub product_id: String,
    pub fulfillment_product_id: String,
    pub benefit_id: String,
    pub credits: f64,
    pub price_amount: f64,
    pub price_currency: String,
    pub status: CreditGiftStatus,
    pub no_refunds_acknowledged_at: mongodb::bson::DateTime,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub purchase_create_started_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub checkout_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub checkout_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub paid_order_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub buyer_customer_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub paid_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub fulfillment_create_started_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub fulfillment_checkout_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub fulfillment_order_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub recipient_customer_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub grant_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub delivered_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub announced_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub announcement_message_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub announcement_stopped_at: Option<mongodb::bson::DateTime>,
    pub announcement_attempts: f64,
    pub attempts: f64,
    pub next_attempt_at: mongodb::bson::DateTime,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_error: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub lease_token: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub lease_until: Option<mongodb::bson::DateTime>,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

impl From<&ICreditGift> for ICreditGiftBson {
    fn from(value: &ICreditGift) -> Self {
        Self {
            id: value.id.to_utf8_lossy(),
            buyer_id: value.buyer_id,
            recipient_id: value.recipient_id,
            buyer_login: value.buyer_login.to_utf8_lossy(),
            recipient_login: value.recipient_login.to_utf8_lossy(),
            recipient_name: value.recipient_name.to_utf8_lossy(),
            recipient_channel_id: value.recipient_channel_id.to_utf8_lossy(),
            product_id: value.product_id.to_utf8_lossy(),
            fulfillment_product_id: value.fulfillment_product_id.to_utf8_lossy(),
            benefit_id: value.benefit_id.to_utf8_lossy(),
            credits: value.credits,
            price_amount: value.price_amount,
            price_currency: value.price_currency.to_utf8_lossy(),
            status: value.status,
            no_refunds_acknowledged_at: value.no_refunds_acknowledged_at,
            purchase_create_started_at: value.purchase_create_started_at,
            checkout_id: value.checkout_id.as_ref().map(JsString::to_utf8_lossy),
            checkout_url: value.checkout_url.as_ref().map(JsString::to_utf8_lossy),
            paid_order_id: value.paid_order_id.as_ref().map(JsString::to_utf8_lossy),
            buyer_customer_id: value
                .buyer_customer_id
                .as_ref()
                .map(JsString::to_utf8_lossy),
            paid_at: value.paid_at,
            fulfillment_create_started_at: value.fulfillment_create_started_at,
            fulfillment_checkout_id: value
                .fulfillment_checkout_id
                .as_ref()
                .map(JsString::to_utf8_lossy),
            fulfillment_order_id: value
                .fulfillment_order_id
                .as_ref()
                .map(JsString::to_utf8_lossy),
            recipient_customer_id: value
                .recipient_customer_id
                .as_ref()
                .map(JsString::to_utf8_lossy),
            grant_id: value.grant_id.as_ref().map(JsString::to_utf8_lossy),
            delivered_at: value.delivered_at,
            announced_at: value.announced_at,
            announcement_message_id: value
                .announcement_message_id
                .as_ref()
                .map(JsString::to_utf8_lossy),
            announcement_stopped_at: value.announcement_stopped_at,
            announcement_attempts: value.announcement_attempts,
            attempts: value.attempts,
            next_attempt_at: value.next_attempt_at,
            last_error: value.last_error.as_ref().map(JsString::to_utf8_lossy),
            lease_token: value.lease_token.as_ref().map(JsString::to_utf8_lossy),
            lease_until: value.lease_until,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<ICreditGiftBson> for ICreditGift {
    fn from(value: ICreditGiftBson) -> Self {
        Self {
            id: value.id.into(),
            buyer_id: value.buyer_id,
            recipient_id: value.recipient_id,
            buyer_login: value.buyer_login.into(),
            recipient_login: value.recipient_login.into(),
            recipient_name: value.recipient_name.into(),
            recipient_channel_id: value.recipient_channel_id.into(),
            product_id: value.product_id.into(),
            fulfillment_product_id: value.fulfillment_product_id.into(),
            benefit_id: value.benefit_id.into(),
            credits: value.credits,
            price_amount: value.price_amount,
            price_currency: value.price_currency.into(),
            status: value.status,
            no_refunds_acknowledged_at: value.no_refunds_acknowledged_at,
            purchase_create_started_at: value.purchase_create_started_at,
            checkout_id: value.checkout_id.map(JsString::from),
            checkout_url: value.checkout_url.map(JsString::from),
            paid_order_id: value.paid_order_id.map(JsString::from),
            buyer_customer_id: value.buyer_customer_id.map(JsString::from),
            paid_at: value.paid_at,
            fulfillment_create_started_at: value.fulfillment_create_started_at,
            fulfillment_checkout_id: value.fulfillment_checkout_id.map(JsString::from),
            fulfillment_order_id: value.fulfillment_order_id.map(JsString::from),
            recipient_customer_id: value.recipient_customer_id.map(JsString::from),
            grant_id: value.grant_id.map(JsString::from),
            delivered_at: value.delivered_at,
            announced_at: value.announced_at,
            announcement_message_id: value.announcement_message_id.map(JsString::from),
            announcement_stopped_at: value.announcement_stopped_at,
            announcement_attempts: value.announcement_attempts,
            attempts: value.attempts,
            next_attempt_at: value.next_attempt_at,
            last_error: value.last_error.map(JsString::from),
            lease_token: value.lease_token.map(JsString::from),
            lease_until: value.lease_until,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl ICreditGift {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICreditGiftBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICreditGiftBson>(document).map(Into::into)
    }
}

// Missing optional fields are accepted, but an explicit null is not a TypeScript value.
fn present_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
