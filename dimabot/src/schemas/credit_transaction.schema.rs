use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use crate::utils::js_string::JsString;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TransactionType {
    #[serde(rename = "referral_bonus")]
    ReferralBonus,
    #[serde(rename = "referral_payout")]
    ReferralPayout,
    #[serde(rename = "subscription_reward")]
    SubscriptionReward,
    #[serde(rename = "manual_credit")]
    ManualCredit,
    #[serde(rename = "manual_debit")]
    ManualDebit,
}
impl TransactionType {
    pub const ALL: [Self; 5] = [
        Self::ReferralBonus,
        Self::ReferralPayout,
        Self::SubscriptionReward,
        Self::ManualCredit,
        Self::ManualDebit,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReferralBonus => TRANSACTION_TYPES[0],
            Self::ReferralPayout => TRANSACTION_TYPES[1],
            Self::SubscriptionReward => TRANSACTION_TYPES[2],
            Self::ManualCredit => TRANSACTION_TYPES[3],
            Self::ManualDebit => TRANSACTION_TYPES[4],
        }
    }
}
impl std::str::FromStr for TransactionType {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|entry| entry.as_str() == value)
            .ok_or(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RewardTargetType {
    #[serde(rename = "bot")]
    Bot,
    #[serde(rename = "referrer")]
    Referrer,
}
impl RewardTargetType {
    pub const ALL: [Self; 2] = [Self::Bot, Self::Referrer];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bot => "bot",
            Self::Referrer => "referrer",
        }
    }
}
impl std::str::FromStr for RewardTargetType {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "bot" => Ok(Self::Bot),
            "referrer" => Ok(Self::Referrer),
            _ => Err(()),
        }
    }
}

/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICreditTransactionMetadata {
    pub referral_code_used: Option<JsString>,
    pub referred_user_id: Option<mongodb::bson::oid::ObjectId>,
    pub subscription_id: Option<JsString>,
    pub plan_id: Option<JsString>,
    pub description: Option<JsString>,
    pub external_reference: Option<JsString>,
    pub reward_target_type: Option<RewardTargetType>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICreditTransactionMetadataBson {
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub referral_code_used: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub referred_user_id: Option<mongodb::bson::oid::ObjectId>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub subscription_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub plan_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_reference: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub reward_target_type: Option<RewardTargetType>,
}

impl From<&ICreditTransactionMetadata> for ICreditTransactionMetadataBson {
    fn from(value: &ICreditTransactionMetadata) -> Self {
        Self {
            referral_code_used: value
                .referral_code_used
                .as_ref()
                .map(JsString::to_utf8_lossy),
            referred_user_id: value.referred_user_id,
            subscription_id: value.subscription_id.as_ref().map(JsString::to_utf8_lossy),
            plan_id: value.plan_id.as_ref().map(JsString::to_utf8_lossy),
            description: value.description.as_ref().map(JsString::to_utf8_lossy),
            external_reference: value
                .external_reference
                .as_ref()
                .map(JsString::to_utf8_lossy),
            reward_target_type: value.reward_target_type,
        }
    }
}

impl From<ICreditTransactionMetadataBson> for ICreditTransactionMetadata {
    fn from(value: ICreditTransactionMetadataBson) -> Self {
        Self {
            referral_code_used: value.referral_code_used.map(JsString::from),
            referred_user_id: value.referred_user_id,
            subscription_id: value.subscription_id.map(JsString::from),
            plan_id: value.plan_id.map(JsString::from),
            description: value.description.map(JsString::from),
            external_reference: value.external_reference.map(JsString::from),
            reward_target_type: value.reward_target_type,
        }
    }
}

impl ICreditTransactionMetadata {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICreditTransactionMetadataBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICreditTransactionMetadataBson>(document)
            .map(Into::into)
    }
}

/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct ICreditTransaction {
    pub id: mongodb::bson::oid::ObjectId,
    pub user: mongodb::bson::oid::ObjectId,
    pub transaction_type: TransactionType,
    pub amount: f64,
    pub idempotency_key: Option<JsString>,
    pub applied_at: Option<mongodb::bson::DateTime>,
    pub balance_after: Option<f64>,
    pub metadata: ICreditTransactionMetadata,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICreditTransactionBson {
    #[serde(rename = "_id")]
    pub id: mongodb::bson::oid::ObjectId,
    pub user: mongodb::bson::oid::ObjectId,
    #[serde(rename = "type")]
    pub transaction_type: TransactionType,
    pub amount: f64,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub idempotency_key: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub applied_at: Option<mongodb::bson::DateTime>,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub balance_after: Option<f64>,
    pub metadata: ICreditTransactionMetadataBson,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

impl From<&ICreditTransaction> for ICreditTransactionBson {
    fn from(value: &ICreditTransaction) -> Self {
        Self {
            id: value.id,
            user: value.user,
            transaction_type: value.transaction_type,
            amount: value.amount,
            idempotency_key: value.idempotency_key.as_ref().map(JsString::to_utf8_lossy),
            applied_at: value.applied_at,
            balance_after: value.balance_after,
            metadata: (&value.metadata).into(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<ICreditTransactionBson> for ICreditTransaction {
    fn from(value: ICreditTransactionBson) -> Self {
        Self {
            id: value.id,
            user: value.user,
            transaction_type: value.transaction_type,
            amount: value.amount,
            idempotency_key: value.idempotency_key.map(JsString::from),
            applied_at: value.applied_at,
            balance_after: value.balance_after,
            metadata: value.metadata.into(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl ICreditTransaction {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&ICreditTransactionBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<ICreditTransactionBson>(document).map(Into::into)
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

/// Stored values include null defaults absent from the TypeScript interface.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCreditTransactionMetadata {
    pub referral_code_used: Option<String>,
    pub referred_user_id: Option<mongodb::bson::oid::ObjectId>,
    pub subscription_id: Option<String>,
    pub plan_id: Option<String>,
    pub description: Option<String>,
    pub external_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reward_target_type: Option<RewardTargetType>,
}

/// Stored projection; nullable defaults are distinct from the declared interface.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCreditTransaction {
    #[serde(rename = "_id")]
    pub id: mongodb::bson::oid::ObjectId,
    pub user: mongodb::bson::oid::ObjectId,
    #[serde(rename = "type")]
    pub transaction_type: TransactionType,
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<mongodb::bson::DateTime>,
    pub balance_after: Option<f64>,
    pub metadata: StoredCreditTransactionMetadata,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}
