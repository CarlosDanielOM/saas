//! The reward for a paid subscription order (`utils/paid_order_reward.ts`, and the gate of
//! `applyPolarRewardDomainEvent` in `domain_events/polar_billing_events.ts`, consumer
//! `polar-rewards-v1`).
//!
//! A paid Premium or Pro order (not a trial, not a one-time pack) gives `token_balance` to the
//! payer's referrer (code still active, referrer still there) or else to the bot account:
//! 50/500 (Premium monthly/yearly) or 100/1000 (Pro). No Polar call is made.
//!
//! # Once and only once
//!
//! The operation id is `polar:paid-order:{orderId}` (`idempotencyKey`), stored with every input
//! (beneficiary, amount, payer, code, product, cadence) in a `credittransactions` reservation by
//! an upsert on that key **before** any balance moves; the unique partial index on
//! `idempotencyKey` (required before the first write, as `CreditTransactionSchema.init()` made
//! it) turns a racing second reservation into a read of the first. Then:
//!
//! 1. the beneficiary's `token_balance` is incremented in the same single-document write that
//!    adds the reservation's `_id` to `applied_credit_transaction_ids`, conditioned on its
//!    absence: a retry can never increment twice;
//! 2. the reservation gets `appliedAt` (and `balanceAfter` when step 1 ran in this call).
//!
//! A kill after the reservation leaves it unapplied: the next delivery of the event applies it
//! with the reserved inputs (changed settings are ignored). A kill after step 1 leaves the
//! receipt on the user: the next delivery sees it, does not increment, and marks the
//! reservation applied (without `balanceAfter`, which a replay cannot know). A reservation whose
//! beneficiary was deleted fails until it exists again, never marked applied.
//!
//! # What this crate assumes of the event
//!
//! The Polar webhook route verified the standard-webhooks signature (`webhook-id`,
//! `webhook-timestamp`, `webhook-signature` with `POLARSH_WEBHOOK_SECRET`, constant-time,
//! within the timestamp tolerance) and journaled the event under its `webhook-id`, and the
//! consumer resolved its owner. The payload's `orderId`, `productId`, `subscriptionId`,
//! `totalAmount` and `cadence` are trusted as Polar sent them; the order is not read again (the
//! reference does not). A replayed event is a no-op (the key), a forged one is the route's to
//! refuse.
//!
//! # Not handled (reference behaviour)
//!
//! A refund does not take a reward back (nothing in the reference reacts to `order.refunded`).
//! The balance is not spendable anywhere today, so this is bookkeeping, not money; listed for
//! the owner.

use crate::mongo_ops::{self, MongoOpError, journaled};
use crate::products::{PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};
use crate::referrals::{Cadence, PlanType, bot_subscription_reward_amount};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::credit_transactions::{COLLECTION as TRANSACTIONS, INFO as TRANSACTION_INFO};
use dima_model::referral_codes::COLLECTION as CODES;
use dima_model::users::{COLLECTION as USERS, INFO as USER_INFO};
use dima_store::mongo::MongoStore;
use dima_store::mongo::date::date;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::{Returned, UpdateOptions};
use serde_json::Value;
use std::time::Duration;

/// The bot account that receives rewards without a referrer.
pub const BOT_LOGIN: &str = "domdimabot";
/// The deadline of the index check before the first reservation.
pub const INDEX_DEADLINE: Duration = Duration::from_secs(30);

/// `polar:paid-order:{orderId}`.
pub fn idempotency_key(order_id: &str) -> String {
    format!("polar:paid-order:{order_id}")
}

/// Why a reward was not applied (the reference's messages).
#[derive(Debug, thiserror::Error)]
pub enum RewardError {
    /// `throw new Error(message)`: the event is retried.
    #[error("{0}")]
    Failed(String),
    /// The owner could not be resolved or no longer exists (`DomainEventPrerequisiteMissingError`).
    #[error("{0}")]
    PrerequisiteMissing(&'static str),
    /// The unique index on `idempotencyKey` is not there: nothing may be reserved.
    #[error("credittransactions unique index unavailable: {0}")]
    IndexUnavailable(String),
    /// MongoDB failed.
    #[error(transparent)]
    Mongo(#[from] MongoOpError),
}

fn failed(message: &str) -> RewardError {
    RewardError::Failed(message.to_owned())
}

/// The input of `applyPaidOrderReward`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaidOrder<'a> {
    /// `ownerUserId` (a 24-hex user id).
    pub owner_user_id: &'a str,
    /// `orderId`.
    pub order_id: &'a str,
    /// `productId`.
    pub product_id: &'a str,
    /// `cadence`.
    pub cadence: Cadence,
}

/// What a call did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewardOutcome {
    /// Nothing to reward (free or unknown product, or a legacy reward exists).
    Nothing,
    /// The reservation was applied by this call or an earlier one.
    Applied,
}

/// The rewards, with the readiness of their index (checked once per process, as Mongoose's
/// `init()` promise is).
#[derive(Debug)]
pub struct OrderRewards<'a> {
    store: &'a MongoStore,
    ready: tokio::sync::OnceCell<()>,
}

impl<'a> OrderRewards<'a> {
    /// Over `store`.
    pub fn new(store: &'a MongoStore) -> Self {
        Self {
            store,
            ready: tokio::sync::OnceCell::new(),
        }
    }

    /// `CreditTransactionSchema.init()`: the unique index on `idempotencyKey` must exist before
    /// any reservation.
    async fn ensure_index(&self) -> Result<(), RewardError> {
        self.ready
            .get_or_try_init(|| async {
                let report = dima_model::ensure_indexes(
                    self.store,
                    &TRANSACTION_INFO,
                    dima_model::IndexPolicy::RequireUnique,
                    INDEX_DEADLINE,
                )
                .await;
                report
                    .require()
                    .map_err(|e| RewardError::IndexUnavailable(e.to_string()))
            })
            .await
            .map(|_| ())
    }

    async fn reservation(&self, key: &str) -> Result<Option<Document>, RewardError> {
        Ok(mongo_ops::find_one(
            self.store,
            TRANSACTIONS,
            doc! { "idempotencyKey": key },
            None,
        )
        .await?)
    }

    /// `applyPaidOrderReward({ownerUserId, orderId, productId, cadence})`.
    pub async fn apply_paid_order_reward(
        &self,
        order: &PaidOrder<'_>,
        now_ms: i64,
    ) -> Result<RewardOutcome, RewardError> {
        if dima_text::trim(order.order_id).is_empty() {
            return Err(failed("Paid order reward requires an order ID"));
        }
        self.ensure_index().await?;
        let key = idempotency_key(order.order_id);
        let mut reservation = self.reservation(&key).await?;
        if reservation.is_none() {
            let plan = PlanType::of_product(order.product_id);
            let amount = bot_subscription_reward_amount(plan, order.cadence);
            if amount <= 0.0 {
                return Ok(RewardOutcome::Nothing);
            }
            // Old paid-order rewards stored the order id here; a concurrent reservation under
            // our own key is not evidence that credit was applied.
            let legacy = doc! {
                "type": "subscription_reward",
                "metadata.subscriptionId": order.order_id,
                "idempotencyKey": { "$ne": &key },
            };
            if mongo_ops::exists(self.store, TRANSACTIONS, legacy).await? {
                return Ok(RewardOutcome::Nothing);
            }
            let Ok(owner) = ObjectId::parse_str(order.owner_user_id) else {
                return Err(failed(
                    "Paid order reward requires a canonical owner user ID",
                ));
            };
            let Some(payer) =
                mongo_ops::find_one(self.store, USERS, doc! { "_id": owner }, None).await?
            else {
                return Err(failed("Paid order reward owner not found"));
            };
            // A hydrated payer reads a missing `referrerId`/`referralCodeUsed` as `null`.
            let referrer = payer.get_object_id("referrerId").ok();
            let code = payer
                .get_str("referralCodeUsed")
                .ok()
                .filter(|c| !c.is_empty());
            let mut beneficiary = None;
            let mut target = "bot";
            if let (Some(referrer), Some(code)) = (referrer, code) {
                let active =
                    doc! { "code": code.to_lowercase(), "owner": referrer, "active": true };
                if mongo_ops::exists(self.store, CODES, active).await?
                    && mongo_ops::exists(self.store, USERS, doc! { "_id": referrer }).await?
                {
                    beneficiary = Some(referrer);
                    target = "referrer";
                }
            }
            let beneficiary = match beneficiary {
                Some(id) => id,
                None => {
                    let bot = doc! { "accounts": { "$elemMatch": { "type": "twitch", "name": BOT_LOGIN } } };
                    let found =
                        mongo_ops::find_one(self.store, USERS, bot, Some(doc! { "_id": 1 }))
                            .await?
                            .and_then(|d| d.get_object_id("_id").ok());
                    found.ok_or_else(|| failed("Paid order reward beneficiary not found"))?
                }
            };
            let code_used = match payer.get("referralCodeUsed") {
                Some(Bson::String(code)) => Bson::String(code.clone()),
                _ => Bson::Null,
            };
            let insert = doc! { "$setOnInsert": {
                "idempotencyKey": &key,
                "user": beneficiary,
                "type": "subscription_reward",
                "amount": js_number(amount),
                "metadata": {
                    "referralCodeUsed": code_used,
                    "referredUserId": owner,
                    "subscriptionId": order.order_id,
                    "planId": order.product_id,
                    "description": format!("Subscription reward for {} ({})", plan.as_str(), order.cadence.as_str()),
                    "externalReference": &key,
                    "rewardTargetType": target,
                },
            } };
            let reserved = mongo_ops::find_one_and_update(
                self.store,
                &TRANSACTION_INFO,
                &doc! { "idempotencyKey": &key },
                insert,
                UpdateOptions::upsert(),
                Returned::After,
                None,
                Some(journaled()),
                now_ms,
            )
            .await;
            reservation = match reserved {
                Ok(found) => found,
                Err(error) if error.is_duplicate_key() => self.reservation(&key).await?,
                Err(error) => return Err(error.into()),
            };
        }
        let Some(reservation) = reservation else {
            return Err(failed("Paid order reward reservation not found"));
        };
        if reservation
            .get("appliedAt")
            .is_some_and(|v| !matches!(v, Bson::Null))
        {
            return Ok(RewardOutcome::Applied);
        }
        let (Ok(id), Ok(user)) = (
            reservation.get_object_id("_id"),
            reservation.get_object_id("user"),
        ) else {
            return Err(failed("Paid order reward reservation not found"));
        };
        let amount = reservation
            .get("amount")
            .and_then(dima_store::mongo::number::read_number)
            .unwrap_or(f64::NAN);
        // The increment and its receipt are one write: a retry after a lost answer cannot add
        // the reward twice.
        let credited = mongo_ops::find_one_and_update(
            self.store,
            &USER_INFO,
            &doc! { "_id": user, "applied_credit_transaction_ids": { "$ne": id } },
            doc! {
                "$inc": { "token_balance": js_number(amount) },
                "$addToSet": { "applied_credit_transaction_ids": id },
            },
            UpdateOptions::default(),
            Returned::After,
            None,
            Some(journaled()),
            now_ms,
        )
        .await?;
        if credited.is_none()
            && !mongo_ops::exists(
                self.store,
                USERS,
                doc! { "_id": user, "applied_credit_transaction_ids": id },
            )
            .await?
        {
            return Err(failed("Paid order reward reserved beneficiary not found"));
        }
        // A replay cannot know the balance right after the credit: `balanceAfter` stays null.
        let mut set = doc! { "appliedAt": date(now_ms) };
        // `creditedUser.token_balance` is a JavaScript number, written back as Node writes one.
        if let Some(balance) = credited
            .as_ref()
            .and_then(|u| u.get("token_balance"))
            .and_then(dima_store::mongo::number::read_number)
        {
            set.insert("balanceAfter", js_number(balance));
        }
        mongo_ops::update_one(
            self.store,
            &TRANSACTION_INFO,
            &doc! { "_id": id, "appliedAt": { "$exists": false } },
            doc! { "$set": set },
            UpdateOptions::default(),
            Some(journaled()),
            now_ms,
        )
        .await?;
        Ok(RewardOutcome::Applied)
    }

    /// `applyPolarRewardDomainEvent(event)`: the gate on a `billing.order.paid` event from the
    /// Polar webhook, then the reward. `owner` is what the consumer resolved
    /// (`event.ownerUserId` or the producer's owner lookup); `None` is a prerequisite missing.
    pub async fn apply_polar_reward_domain_event(
        &self,
        source: &str,
        kind: &str,
        payload: &Value,
        owner: Option<ObjectId>,
        now_ms: i64,
    ) -> Result<RewardOutcome, RewardError> {
        if source != "polar-webhook" || kind != "billing.order.paid" {
            return Ok(RewardOutcome::Nothing);
        }
        let order_id = payload.get("orderId");
        if payload.get("paid") != Some(&Value::Bool(true)) || !crate::js::truthy(order_id) {
            return Err(failed("Polar rewards require a confirmed paid order"));
        }
        // Polar also emits order.paid for $0 trial starts; one-time orders have no
        // subscription; older journal rows without an amount fail closed.
        let total = payload.get("totalAmount");
        if !crate::js::truthy(payload.get("subscriptionId"))
            || !crate::js::truthy(total)
            || crate::js::le_number(total, 0.0)
        {
            return Ok(RewardOutcome::Nothing);
        }
        let product = payload.get("productId").and_then(Value::as_str);
        if product != Some(PREMIUM_PRODUCT_ID) && product != Some(PRO_PRODUCT_ID) {
            return Ok(RewardOutcome::Nothing);
        }
        let cadence = payload.get("cadence");
        if !crate::js::truthy(cadence) {
            return Err(failed("Polar paid order is missing its billing cadence"));
        }
        // Intended difference: a cadence other than monthly or yearly (the producer makes no
        // other) is refused; the reference would reserve an `undefined` amount.
        let Some(cadence) = cadence.and_then(Value::as_str).and_then(Cadence::parse) else {
            return Err(failed("Polar paid order is missing its billing cadence"));
        };
        let Some(owner) = owner else {
            return Err(RewardError::PrerequisiteMissing(
                "owner:polar customer mapping unresolved",
            ));
        };
        if !mongo_ops::exists(self.store, USERS, doc! { "_id": owner }).await? {
            return Err(RewardError::PrerequisiteMissing(
                "owner:Polar owner no longer exists",
            ));
        }
        let (Some(order_id), Some(product)) = (order_id.and_then(Value::as_str), product) else {
            return Err(failed("Polar rewards require a confirmed paid order"));
        };
        let owner = owner.to_hex();
        self.apply_paid_order_reward(
            &PaidOrder {
                owner_user_id: &owner,
                order_id,
                product_id: product,
                cadence,
            },
            now_ms,
        )
        .await
    }
}
