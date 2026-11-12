//! `credittransactions`: credits given to a user's token balance (referral bonuses, subscription
//! rewards, manual changes), each a permanent receipt.
//!
//! Reference: `dimabot/src/schemas/credit_transaction.schema.ts` (model `CreditTransaction`).
//! Camel-case timestamps, `__v`, no hooks. The live writer is `utils/paid_order_reward.ts`: it
//! awaits `CreditTransactionSchema.init()` ("the unique index must be ready before any
//! reservation can be created"), reserves with an upsert (`$setOnInsert`) on `idempotencyKey`,
//! credits `users.token_balance` with the receipt id, then sets `appliedAt` and `balanceAfter`
//! once (`appliedAt` missing). `utils/referral.ts` also creates receipts with `Model.create` and
//! sets `balanceAfter` with a bare update.
//!
//! Indexes: `user`, `type` (field level), `{user, createdAt: -1}`, the unique partial
//! `idempotencyKey` (strings only) and the sparse `metadata.subscriptionId`. The unique index is
//! required before the first write ([`crate::startup_policy`]): the reference waits for it, and
//! without it two deliveries of one paid order would credit the balance twice.
//!
//! Money: `amount` and `balanceAfter` keep their stored width ([`JsNumber`]). `balanceAfter`
//! defaults to `null` and stays `null` when a replay cannot know the balance (the reference says
//! so), and `metadata.referralCodeUsed` is `null` on 55 receipts (the create paths pass the
//! payer's `null` through), so both are `Option`s and the input takes a [`Nullable`] code.
//! Legacy shape: two receipts have no `__v` and no `balanceAfter`.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::empty;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::values::Nullable;
use bson::oid::ObjectId;
use bson::{Document, doc};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "credittransactions";

str_enum! {
    /// `type` (`TRANSACTION_TYPES`).
    pub enum TransactionType {
        /// A referrer's bonus for a referred subscription.
        ReferralBonus = "referral_bonus",
        /// A referral payout.
        ReferralPayout = "referral_payout",
        /// The reward for a paid subscription order.
        SubscriptionReward = "subscription_reward",
        /// Credits added by staff.
        ManualCredit = "manual_credit",
        /// Credits removed by staff.
        ManualDebit = "manual_debit",
    }
}

str_enum! {
    /// `metadata.rewardTargetType`.
    pub enum RewardTarget {
        /// The bot's account received the reward.
        Bot = "bot",
        /// The payer's referrer received it.
        Referrer = "referrer",
    }
}

const METADATA: &[Field] = &[
    Field::string("referralCodeUsed").default(D::Null),
    Field::object_id("referredUserId").default(D::Null),
    Field::string("subscriptionId").default(D::Null),
    Field::string("planId").default(D::Null),
    Field::string("description").default(D::Str("")),
    Field::string("externalReference").default(D::Null),
    Field::string("rewardTargetType"),
];

/// The schema, field by field as `credit_transaction.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("user"),
    Field::string("type"),
    Field::number("amount"),
    Field::number("balanceAfter").default(D::Null),
    Field::string("idempotencyKey"),
    Field::date("appliedAt"),
    Field::nested("metadata", METADATA),
])
.timestamps(Timestamps::CAMEL);

fn string_key() -> Document {
    doc! { "idempotencyKey": { "$type": "string" } }
}

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("user", 1)]),
    IndexSpec::on(&[("type", 1)]),
    IndexSpec::on(&[("user", 1), ("createdAt", -1)]),
    IndexSpec::on(&[("idempotencyKey", 1)])
        .unique()
        .partial(string_key),
    IndexSpec::on(&[("metadata.subscriptionId", 1)]).sparse(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("user"),
    Rule::required("type"),
    Rule::one_of("type", TransactionType::STRINGS),
    Rule::required("amount"),
    Rule::one_of("metadata.rewardTargetType", RewardTarget::STRINGS),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("user"),
    ReadNeed::value("type"),
    ReadNeed::value("amount"),
    ReadNeed::not_null("metadata"),
    ReadNeed::not_null("metadata.description"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "CreditTransaction",
    source: "dimabot/src/schemas/credit_transaction.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: &[],
    decode: decode_boxed::<CreditTransaction>,
};

/// A stored receipt.
#[derive(Clone, Debug, Deserialize)]
pub struct CreditTransaction {
    /// `_id` (also recorded in `users.applied_credit_transaction_ids` once applied).
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The credited user (`users._id`).
    pub user: ObjectId,
    /// The kind of credit.
    #[serde(rename = "type")]
    pub kind: Open<TransactionType>,
    /// Credits.
    pub amount: JsNumber,
    /// The balance right after (`null` when unknown).
    #[serde(default, rename = "balanceAfter")]
    pub balance_after: Option<JsNumber>,
    /// The idempotency key of a paid-order reward.
    #[serde(default, rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    /// When the credit reached the balance.
    #[serde(default, rename = "appliedAt")]
    pub applied_at: Option<JsDate>,
    /// Where it came from.
    #[serde(default)]
    pub metadata: CreditMetadata,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// `metadata`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct CreditMetadata {
    /// The referral code the payer used.
    #[serde(default, rename = "referralCodeUsed")]
    pub referral_code_used: Option<String>,
    /// The paying user.
    #[serde(default, rename = "referredUserId")]
    pub referred_user_id: Option<ObjectId>,
    /// The Polar subscription or order.
    #[serde(default, rename = "subscriptionId")]
    pub subscription_id: Option<String>,
    /// The Polar product.
    #[serde(default, rename = "planId")]
    pub plan_id: Option<String>,
    /// Description.
    #[serde(default = "empty")]
    pub description: String,
    /// The external reference (the idempotency key for paid orders).
    #[serde(default, rename = "externalReference")]
    pub external_reference: Option<String>,
    /// Who received the reward.
    #[serde(default, rename = "rewardTargetType")]
    pub reward_target_type: Option<Open<RewardTarget>>,
}

/// A new receipt (`CreditTransactionSchema.create` in `utils/referral.ts`, or the
/// `$setOnInsert` of the paid-order reservation).
#[derive(Clone, Debug, Serialize)]
pub struct NewCreditTransaction {
    /// The credited user.
    pub user: ObjectId,
    /// The kind of credit.
    #[serde(rename = "type")]
    pub kind: TransactionType,
    /// Credits.
    pub amount: JsNumber,
    /// The idempotency key (paid orders).
    #[serde(rename = "idempotencyKey", skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Where it came from.
    pub metadata: NewCreditMetadata,
}

/// `metadata` of a new receipt.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewCreditMetadata {
    /// The payer's referral code (the reference passes the payer's `null` through).
    #[serde(
        rename = "referralCodeUsed",
        skip_serializing_if = "Nullable::is_unset"
    )]
    pub referral_code_used: Nullable<String>,
    /// The paying user.
    #[serde(rename = "referredUserId", skip_serializing_if = "Option::is_none")]
    pub referred_user_id: Option<ObjectId>,
    /// The Polar subscription or order.
    #[serde(rename = "subscriptionId", skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    /// The Polar product.
    #[serde(rename = "planId", skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The external reference.
    #[serde(rename = "externalReference", skip_serializing_if = "Option::is_none")]
    pub external_reference: Option<String>,
    /// Who received the reward.
    #[serde(rename = "rewardTargetType", skip_serializing_if = "Option::is_none")]
    pub reward_target_type: Option<RewardTarget>,
}

impl NewCreditTransaction {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
