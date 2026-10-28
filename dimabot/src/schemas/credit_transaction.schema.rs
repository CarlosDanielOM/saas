use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub const REFERRAL_BONUS: &str = "referral_bonus";
pub const REFERRAL_PAYOUT: &str = "referral_payout";
pub const SUBSCRIPTION_REWARD: &str = "subscription_reward";
pub const MANUAL_CREDIT: &str = "manual_credit";
pub const MANUAL_DEBIT: &str = "manual_debit";
pub const TRANSACTION_TYPES: &[&str] = &[
    REFERRAL_BONUS,
    REFERRAL_PAYOUT,
    SUBSCRIPTION_REWARD,
    MANUAL_CREDIT,
    MANUAL_DEBIT,
];
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "CreditTransaction",
        collection: "credittransactions",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![
            SchemaIndex::new(doc! {"user":1}),
            SchemaIndex::new(doc! {"type":1}),
            SchemaIndex::new(doc! {"user":1,"createdAt":-1}),
            SchemaIndex::new(doc! {"idempotencyKey":1})
                .unique()
                .partial(doc! {"idempotencyKey":{"$type":"string"}}),
            SchemaIndex::new(doc! {"metadata.subscriptionId":1}).sparse(),
        ],
        fields: vec![
            Field::new("user", T::ObjectId).required(),
            Field::new("type", T::String)
                .enumeration(TRANSACTION_TYPES)
                .required(),
            Field::new("amount", T::Number).required(),
            Field::new("balanceAfter", T::Number).default(D::Null),
            Field::new("idempotencyKey", T::String),
            Field::new("appliedAt", T::Date),
            Field::new(
                "metadata",
                T::Object(vec![
                    Field::new("referralCodeUsed", T::String).default(D::Null),
                    Field::new("referredUserId", T::ObjectId).default(D::Null),
                    Field::new("subscriptionId", T::String).default(D::Null),
                    Field::new("planId", T::String).default(D::Null),
                    Field::new("description", T::String).default(D::String("")),
                    Field::new("externalReference", T::String).default(D::Null),
                    Field::new("rewardTargetType", T::String).enumeration(&["bot", "referrer"]),
                ]),
            ),
        ],
    })
}
