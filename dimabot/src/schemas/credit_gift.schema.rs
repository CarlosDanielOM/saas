use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
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
