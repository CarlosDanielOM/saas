//! `creditgifts`: a gift of AI credits from one channel to another, from the buyer's checkout to
//! the delivery of the credits and the chat announcement (a permanent receipt: no TTL).
//!
//! Reference: `dimabot/src/schemas/credit_gift.schema.ts` (model `CreditGift`), written only by
//! `utils/credit_gifts.ts`: the reservation is an upsert with `$setOnInsert` on a deterministic
//! string `_id` (SHA-256 of buyer and request id), then compare-and-set `$set`s (`paidAt`
//! missing, `purchaseCreateStartedAt` missing) and a leased worker whose writes are fenced by
//! `leaseToken` and `leaseUntil` (`$unset` on release). Camel-case timestamps, `__v`, no hooks.
//! Indexes `{nextAttemptAt, leaseUntil}` and `checkoutId`; no unique index besides `_id`, which is
//! what makes the reservation idempotent. `checkoutUrl` is `select: false`.
//!
//! Money: `credits` and `priceAmount` keep their stored width ([`JsNumber`]). Private: the
//! checkout URL (it carries Polar's client secret) and both Polar customer ids.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there (every optional path is missing or set, never
//! `null`), so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "creditgifts";

str_enum! {
    /// `status`.
    pub enum GiftStatus {
        /// Reserved, checkout not paid yet.
        AwaitingPayment = "awaiting_payment",
        /// The buyer's order is paid.
        PaymentReceived = "payment_received",
        /// The credits are being granted.
        Delivering = "delivering",
        /// The credits were granted.
        Delivered = "delivered",
        /// Delivery failed five times.
        NeedsSupport = "needs_support",
    }
}

/// The schema, field by field as `credit_gift.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::object_id("buyerId"),
    Field::object_id("recipientId"),
    Field::string("buyerLogin"),
    Field::string("recipientLogin"),
    Field::string("recipientName"),
    Field::string("recipientChannelId"),
    Field::string("productId"),
    Field::string("fulfillmentProductId"),
    Field::string("benefitId"),
    Field::number("credits"),
    Field::number("priceAmount"),
    Field::string("priceCurrency"),
    Field::string("status"),
    Field::date("noRefundsAcknowledgedAt"),
    Field::date("purchaseCreateStartedAt"),
    Field::string("checkoutId"),
    Field::string("checkoutUrl"),
    Field::string("paidOrderId"),
    Field::string("buyerCustomerId"),
    Field::date("paidAt"),
    Field::date("fulfillmentCreateStartedAt"),
    Field::string("fulfillmentCheckoutId"),
    Field::string("fulfillmentOrderId"),
    Field::string("recipientCustomerId"),
    Field::string("grantId"),
    Field::date("deliveredAt"),
    Field::date("announcedAt"),
    Field::string("announcementMessageId"),
    Field::date("announcementStoppedAt"),
    Field::number("announcementAttempts").default(D::Int(0)),
    Field::number("attempts").default(D::Int(0)),
    Field::date("nextAttemptAt"),
    Field::string("lastError"),
    Field::string("leaseToken"),
    Field::date("leaseUntil"),
])
.declared_id()
.timestamps(Timestamps::CAMEL);

/// The `select: false` paths.
pub const HIDDEN: &[&str] = &["checkoutUrl"];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("nextAttemptAt", 1), ("leaseUntil", 1)]),
    IndexSpec::on(&[("checkoutId", 1)]),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("buyerId"),
    Rule::required("recipientId"),
    Rule::required("buyerLogin"),
    Rule::required("recipientLogin"),
    Rule::required("recipientName"),
    Rule::required("recipientChannelId"),
    Rule::required("productId"),
    Rule::required("fulfillmentProductId"),
    Rule::required("benefitId"),
    Rule::required("credits"),
    Rule::required("priceAmount"),
    Rule::required("priceCurrency"),
    Rule::required("status"),
    Rule::one_of("status", GiftStatus::STRINGS),
    Rule::required("noRefundsAcknowledgedAt"),
    Rule::required("nextAttemptAt"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["checkoutUrl", "buyerCustomerId", "recipientCustomerId"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("buyerId"),
    ReadNeed::value("recipientId"),
    ReadNeed::value("buyerLogin"),
    ReadNeed::value("recipientLogin"),
    ReadNeed::value("recipientName"),
    ReadNeed::value("recipientChannelId"),
    ReadNeed::value("productId"),
    ReadNeed::value("fulfillmentProductId"),
    ReadNeed::value("benefitId"),
    ReadNeed::value("credits"),
    ReadNeed::value("priceAmount"),
    ReadNeed::value("priceCurrency"),
    ReadNeed::value("status"),
    ReadNeed::value("noRefundsAcknowledgedAt"),
    ReadNeed::not_null("announcementAttempts"),
    ReadNeed::not_null("attempts"),
    ReadNeed::value("nextAttemptAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "CreditGift",
    source: "dimabot/src/schemas/credit_gift.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<CreditGift>,
};

/// A stored gift. `checkout_url` is `None` unless the read selected it.
#[derive(Clone, Debug, Deserialize)]
pub struct CreditGift {
    /// `_id`: SHA-256 (hex) of the buyer's id and the request id.
    #[serde(rename = "_id")]
    pub id: String,
    /// The buyer (`users._id`).
    #[serde(rename = "buyerId")]
    pub buyer_id: ObjectId,
    /// The recipient (`users._id`).
    #[serde(rename = "recipientId")]
    pub recipient_id: ObjectId,
    /// The buyer's login.
    #[serde(rename = "buyerLogin")]
    pub buyer_login: String,
    /// The recipient's login.
    #[serde(rename = "recipientLogin")]
    pub recipient_login: String,
    /// The recipient's display name.
    #[serde(rename = "recipientName")]
    pub recipient_name: String,
    /// The recipient's Twitch channel id.
    #[serde(rename = "recipientChannelId")]
    pub recipient_channel_id: String,
    /// The Polar product bought.
    #[serde(rename = "productId")]
    pub product_id: String,
    /// The Polar product that delivers the credits.
    #[serde(rename = "fulfillmentProductId")]
    pub fulfillment_product_id: String,
    /// The Polar benefit granted.
    #[serde(rename = "benefitId")]
    pub benefit_id: String,
    /// Credits given.
    pub credits: JsNumber,
    /// Price, in the currency's minor unit.
    #[serde(rename = "priceAmount")]
    pub price_amount: JsNumber,
    /// The currency.
    #[serde(rename = "priceCurrency")]
    pub price_currency: String,
    /// Where it is.
    pub status: Open<GiftStatus>,
    /// When the buyer accepted that gifts are not refunded.
    #[serde(rename = "noRefundsAcknowledgedAt")]
    pub no_refunds_acknowledged_at: JsDate,
    /// The checkout reservation (set before the checkout is created).
    #[serde(default, rename = "purchaseCreateStartedAt")]
    pub purchase_create_started_at: Option<JsDate>,
    /// The buyer's checkout.
    #[serde(default, rename = "checkoutId")]
    pub checkout_id: Option<String>,
    /// The checkout URL (`select: false`).
    #[serde(default, rename = "checkoutUrl")]
    pub checkout_url: Option<Private<String>>,
    /// The buyer's paid order.
    #[serde(default, rename = "paidOrderId")]
    pub paid_order_id: Option<String>,
    /// The buyer's Polar customer.
    #[serde(default, rename = "buyerCustomerId")]
    pub buyer_customer_id: Option<Private<String>>,
    /// When the order was paid.
    #[serde(default, rename = "paidAt")]
    pub paid_at: Option<JsDate>,
    /// The fulfillment reservation.
    #[serde(default, rename = "fulfillmentCreateStartedAt")]
    pub fulfillment_create_started_at: Option<JsDate>,
    /// The fulfillment checkout.
    #[serde(default, rename = "fulfillmentCheckoutId")]
    pub fulfillment_checkout_id: Option<String>,
    /// The fulfillment order.
    #[serde(default, rename = "fulfillmentOrderId")]
    pub fulfillment_order_id: Option<String>,
    /// The recipient's Polar customer.
    #[serde(default, rename = "recipientCustomerId")]
    pub recipient_customer_id: Option<Private<String>>,
    /// The benefit grant.
    #[serde(default, rename = "grantId")]
    pub grant_id: Option<String>,
    /// When the credits were granted.
    #[serde(default, rename = "deliveredAt")]
    pub delivered_at: Option<JsDate>,
    /// When the gift was announced in chat.
    #[serde(default, rename = "announcedAt")]
    pub announced_at: Option<JsDate>,
    /// The announcement's chat message.
    #[serde(default, rename = "announcementMessageId")]
    pub announcement_message_id: Option<String>,
    /// When announcing was given up.
    #[serde(default, rename = "announcementStoppedAt")]
    pub announcement_stopped_at: Option<JsDate>,
    /// Announcement attempts.
    #[serde(default = "zero", rename = "announcementAttempts")]
    pub announcement_attempts: JsNumber,
    /// Delivery attempts.
    #[serde(default = "zero")]
    pub attempts: JsNumber,
    /// When the worker looks at it next.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
    /// The last failure.
    #[serde(default, rename = "lastError")]
    pub last_error: Option<String>,
    /// The worker's lease fence.
    #[serde(default, rename = "leaseToken")]
    pub lease_token: Option<String>,
    /// Lease expiry.
    #[serde(default, rename = "leaseUntil")]
    pub lease_until: Option<JsDate>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// The reservation (`$setOnInsert` of `utils/credit_gifts.ts:149`, with the `_id` of its filter).
#[derive(Clone, Debug, Serialize)]
pub struct NewCreditGift {
    /// SHA-256 (hex) of the buyer's id and the request id.
    #[serde(rename = "_id")]
    pub id: String,
    /// The buyer.
    #[serde(rename = "buyerId")]
    pub buyer_id: ObjectId,
    /// The recipient.
    #[serde(rename = "recipientId")]
    pub recipient_id: ObjectId,
    /// The buyer's login (lower case).
    #[serde(rename = "buyerLogin")]
    pub buyer_login: String,
    /// The recipient's login.
    #[serde(rename = "recipientLogin")]
    pub recipient_login: String,
    /// The recipient's display name.
    #[serde(rename = "recipientName")]
    pub recipient_name: String,
    /// The recipient's Twitch channel id.
    #[serde(rename = "recipientChannelId")]
    pub recipient_channel_id: String,
    /// The product bought.
    #[serde(rename = "productId")]
    pub product_id: String,
    /// The fulfillment product.
    #[serde(rename = "fulfillmentProductId")]
    pub fulfillment_product_id: String,
    /// The benefit.
    #[serde(rename = "benefitId")]
    pub benefit_id: String,
    /// Credits given.
    pub credits: JsNumber,
    /// Price.
    #[serde(rename = "priceAmount")]
    pub price_amount: JsNumber,
    /// The currency.
    #[serde(rename = "priceCurrency")]
    pub price_currency: String,
    /// `awaiting_payment`.
    pub status: GiftStatus,
    /// The reservation time.
    #[serde(rename = "noRefundsAcknowledgedAt")]
    pub no_refunds_acknowledged_at: JsDate,
    /// The reservation time.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
}

impl NewCreditGift {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends for `Model.create` (the reference upserts: pass the document
    /// without `_id` as `$setOnInsert`, filtered on `_id`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
