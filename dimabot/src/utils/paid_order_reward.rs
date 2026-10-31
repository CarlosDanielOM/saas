//! Ports `paid_order_reward.ts`: the paid-order reward adapter that reserves one
//! `subscription_reward` credit transaction per Polar order, credits the
//! resolved beneficiary, and finalizes the receipt exactly once.
//!
//! Source contract: `dimabot/src/utils/paid_order_reward.ts`
//! (`applyPaidOrderReward({ ownerUserId, orderId, productId, cadence })`).
//!
//! Deliberately NOT here: the reward table and product-id resolution
//! ([`crate::utils::referral`]), the collection definitions
//! ([`crate::schemas::credit_transaction`], [`crate::schemas::users`],
//! [`crate::schemas::referral_code`]), connection setup, and any import-time
//! work. Nothing in this module runs at load time; the caller supplies a
//! [`mongodb::Database`] and the credit-transaction indexes are installed
//! explicitly before the first reservation.
//!
//! Every write the source requests with `writeConcern: { w: 1, j: true }` uses
//! [`journaled_write_concern`] explicitly, because neither schema declares
//! `write_concern_journaled` and `native_collection()` therefore does not
//! journal for us.
//!
//! Usage from a domain-event consumer:
//!
//! ```
//! use dima_rust::utils::paid_order_reward::{
//!     PaidOrderRewardApplier, PaidOrderRewardInput, PaidOrderRewardService,
//! };
//!
//! async fn credit_paid_order(database: mongodb::Database, owner_user_id: &str) {
//!     let service = PaidOrderRewardService::new(database);
//!     let Ok(input) =
//!         PaidOrderRewardInput::from_cadence_str(owner_user_id, "order-1", "product-1", "monthly")
//!     else {
//!         return;
//!     };
//!     let _ = service.apply(&input).await;
//! }
//! ```

use crate::schemas::{credit_transaction, referral_code, users};
use crate::schemas::credit_transaction::{RewardTargetType, SUBSCRIPTION_REWARD};
use crate::utils::{
    bson_compat::js_number,
    js_compat::trim,
    referral::{
        PlanType, SubscriptionCadence, get_bot_subscription_reward_amount,
        get_plan_type_from_product_id,
    },
};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{ErrorKind, WriteFailure},
    options::{Acknowledgment, ReturnDocument, WriteConcern},
};
use std::{error::Error, fmt, future::Future, pin::Pin};

/// `polar:paid-order:{orderId}` — the reservation's idempotency key.
pub const IDEMPOTENCY_PREFIX: &str = "polar:paid-order:";

/// Login of the reward beneficiary account used when no referrer applies.
pub const BOT_ACCOUNT_LOGIN: &str = "domdimabot";

/// MongoDB duplicate-key error code. Duplicate reservations are detected by
/// this numeric code only, never by message text.
pub const DUPLICATE_KEY_CODE: i32 = 11000;

/// Node promotes BSON Long values through inclusive +/-2^53 to JS Numbers
/// (`crate::utils::bson_compat::normalize_js_numbers`). Larger Longs stay `Long`
/// objects and are outside every reward amount this adapter can produce.
const JS_MAX_PROMOTED_INTEGER: i64 = 9_007_199_254_740_992;

/// Wire-compatible failure modes of `applyPaidOrderReward`.
///
/// The variants that mirror a source `throw` carry that message verbatim in
/// [`fmt::Display`]. No variant contains a URI, credential, or connection
/// string: the MongoDB variants only wrap the driver's already-redacted error.
#[derive(Debug)]
pub enum PaidOrderRewardError {
    /// `throw new Error('Paid order reward requires an order ID')`.
    MissingOrderId,
    /// `throw new Error('Paid order reward requires a canonical owner user ID')`.
    InvalidOwnerUserId,
    /// `throw new Error('Paid order reward owner not found')`.
    OwnerNotFound,
    /// `throw new Error('Paid order reward beneficiary not found')`.
    BeneficiaryNotFound,
    /// `throw new Error('Paid order reward reservation not found')`.
    ReservationNotFound,
    /// `throw new Error('Paid order reward reserved beneficiary not found')`.
    ReservedBeneficiaryNotFound,
    /// Adapter boundary only. The TypeScript signature is the
    /// `'monthly' | 'yearly'` union, so this state is unreachable there; it
    /// exists for callers bridging that string union into the typed enum.
    InvalidCadence(String),
    /// Stored data the source never inspects because it trusts schema
    /// hydration (a reservation without `_id`, `user`, or a numeric `amount`).
    CorruptReservation(&'static str),
    /// `await CreditTransactionSchema.init()`, kept separate from a write
    /// failure because it is the source's explicit pre-reservation step.
    Index(mongodb::error::Error),
    /// Any other driver failure, which the source propagates unchanged.
    Mongo(mongodb::error::Error),
}

impl fmt::Display for PaidOrderRewardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingOrderId => formatter.write_str("Paid order reward requires an order ID"),
            Self::InvalidOwnerUserId => {
                formatter.write_str("Paid order reward requires a canonical owner user ID")
            }
            Self::OwnerNotFound => formatter.write_str("Paid order reward owner not found"),
            Self::BeneficiaryNotFound => {
                formatter.write_str("Paid order reward beneficiary not found")
            }
            Self::ReservationNotFound => {
                formatter.write_str("Paid order reward reservation not found")
            }
            Self::ReservedBeneficiaryNotFound => {
                formatter.write_str("Paid order reward reserved beneficiary not found")
            }
            Self::InvalidCadence(cadence) => write!(
                formatter,
                "Paid order reward cadence must be 'monthly' or 'yearly', received '{cadence}'"
            ),
            Self::CorruptReservation(reason) => {
                write!(formatter, "Paid order reward reservation is malformed: {reason}")
            }
            Self::Index(error) => {
                write!(formatter, "Credit transaction index install failed: {error}")
            }
            Self::Mongo(error) => {
                write!(formatter, "Paid order reward database operation failed: {error}")
            }
        }
    }
}

impl Error for PaidOrderRewardError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Index(error) | Self::Mongo(error) => Some(error),
            _ => None,
        }
    }
}

impl From<mongodb::error::Error> for PaidOrderRewardError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

/// The source's argument object, with the cadence typed instead of a string
/// union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaidOrderRewardInput {
    pub owner_user_id: String,
    pub order_id: String,
    pub product_id: String,
    pub cadence: SubscriptionCadence,
}

impl PaidOrderRewardInput {
    pub fn new(
        owner_user_id: impl Into<String>,
        order_id: impl Into<String>,
        product_id: impl Into<String>,
        cadence: SubscriptionCadence,
    ) -> Self {
        Self {
            owner_user_id: owner_user_id.into(),
            order_id: order_id.into(),
            product_id: product_id.into(),
            cadence,
        }
    }

    /// Bridge a TypeScript `'monthly' | 'yearly'` value into the typed input.
    pub fn from_cadence_str(
        owner_user_id: impl Into<String>,
        order_id: impl Into<String>,
        product_id: impl Into<String>,
        cadence: &str,
    ) -> Result<Self, PaidOrderRewardError> {
        Ok(Self {
            owner_user_id: owner_user_id.into(),
            order_id: order_id.into(),
            product_id: product_id.into(),
            cadence: parse_cadence(cadence)?,
        })
    }
}

/// Boxed future used by the injected seam so no caller needs the concrete type.
pub type PaidOrderRewardFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), PaidOrderRewardError>> + Send + 'a>>;

/// Injected seam for the Polar reward domain-event consumer
/// (`applyPolarRewardDomainEvent`). Implemented by [`PaidOrderRewardService`].
pub trait PaidOrderRewardApplier: Send + Sync {
    fn apply<'a>(&'a self, input: &'a PaidOrderRewardInput) -> PaidOrderRewardFuture<'a>;
}

/// Concrete adapter over one application database.
#[derive(Clone, Debug)]
pub struct PaidOrderRewardService {
    database: Database,
}

impl PaidOrderRewardService {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    /// `applyPaidOrderReward`. Steps are numbered as in the source.
    pub async fn apply_paid_order_reward(
        &self,
        input: &PaidOrderRewardInput,
    ) -> Result<(), PaidOrderRewardError> {
        // 1. Reject an empty or whitespace-only order id. JavaScript
        // `trim()` whitespace, not Rust's wider set.
        validate_order_id(&input.order_id)?;

        // 2. `await CreditTransactionSchema.init()`: the unique partial index on
        // `idempotencyKey` must exist before any reservation is created.
        // Mongoose memoizes `init()`; this repeat call is an idempotent
        // `createIndexes` command rather than a cached one-shot.
        credit_transaction::schema()
            .install_indexes(&self.database)
            .await
            .map_err(PaidOrderRewardError::Index)?;

        // 3. Existing reservation for this order short-circuits to the apply
        // half; a reservation that is already applied returns there.
        let idempotency_key = idempotency_key(&input.order_id);
        let transactions = credit_transaction::schema().native_collection(&self.database);
        let referral_codes = referral_code::schema().native_collection(&self.database);
        let users_schema = users::schema();
        let users_collection = users_schema.native_collection(&self.database);
        let mut reservation = transactions
            .find_one(reservation_filter(&idempotency_key))
            .await?;

        if reservation.is_none() {
            // 4. A plan whose reward is zero never creates a reservation.
            let Some((plan, amount)) = reward_plan_amount(&input.product_id, input.cadence) else {
                return Ok(());
            };

            // 5. Old paid-order rewards stored the order id in
            // `metadata.subscriptionId`. Exclude our own key: a concurrent
            // RESERVED row is not evidence that credit was applied.
            if exists(
                &transactions,
                legacy_reward_filter(&input.order_id, &idempotency_key),
            )
            .await?
            {
                return Ok(());
            }

            // 6. `Types.ObjectId.isValid(ownerUserId)`, then `findById`.
            let owner_id = ObjectId::parse_str(&input.owner_user_id)
                .map_err(|_| PaidOrderRewardError::InvalidOwnerUserId)?;
            let payer = users_schema
                .repository(&self.database)
                .find_one(doc! { "_id": owner_id })
                .await?
                .ok_or(PaidOrderRewardError::OwnerNotFound)?;

            // 8. Beneficiary resolution. The two lookups only run when the
            // payer has both a referrer and a non-empty code, as in the source.
            let mut code_matches = false;
            let mut referrer_exists = false;
            if let Some((referrer_id, code)) = referrer_candidate(&payer) {
                code_matches = exists(&referral_codes, referral_code_filter(code, referrer_id)).await?;
                if code_matches {
                    referrer_exists =
                        exists(&users_collection, doc! { "_id": referrer_id }).await?;
                }
            }
            let (beneficiary_id, reward_target_type) =
                match beneficiary_resolution(&payer, code_matches, referrer_exists) {
                    BeneficiaryResolution::Referrer(referrer_id) => {
                        (referrer_id, RewardTargetType::Referrer)
                    }
                    BeneficiaryResolution::Bot => {
                        let bot = users_schema
                            .repository(&self.database)
                            .find_one(bot_account_filter())
                            .await?
                            .ok_or(PaidOrderRewardError::BeneficiaryNotFound)?;
                        // A stored user without `_id` is impossible for the
                        // driver; treat it as an unresolved beneficiary.
                        let bot_id = bot
                            .get_object_id("_id")
                            .map_err(|_| PaidOrderRewardError::BeneficiaryNotFound)?;
                        (bot_id, RewardTargetType::Bot)
                    }
                };

            // 9. Reserve under the unique key. `new: true` is the post-image.
            let now = DateTime::now();
            let terms = ReservationTerms {
                idempotency_key: &idempotency_key,
                order_id: &input.order_id,
                product_id: &input.product_id,
                beneficiary_id,
                // `payer._id` is the value `findById` matched.
                payer_id: owner_id,
                referral_code_used: payer.get_str("referralCodeUsed").ok(),
                reward_target_type,
                plan,
                cadence: input.cadence,
                amount,
                created_at: now,
            };
            match transactions
                .find_one_and_update(
                    reservation_filter(&idempotency_key),
                    reservation_update(&terms),
                )
                .upsert(true)
                .return_document(ReturnDocument::After)
                .write_concern(journaled_write_concern())
                .await
            {
                Ok(document) => reservation = document,
                // A concurrent reservation won the unique index; re-read it.
                Err(error) if is_duplicate_key(&error) => {
                    reservation = transactions
                        .find_one(reservation_filter(&idempotency_key))
                        .await?;
                }
                Err(error) => return Err(error.into()),
            }
        }

        // 10. Reservation required; an applied receipt is an idempotent replay.
        let Some(reservation) = reservation else {
            return Err(PaidOrderRewardError::ReservationNotFound);
        };
        if reservation_applied(&reservation) {
            return Ok(());
        }
        let transaction_id = reservation
            .get_object_id("_id")
            .map_err(|_| PaidOrderRewardError::CorruptReservation("reservation is missing _id"))?;
        let beneficiary_id = reservation
            .get_object_id("user")
            .map_err(|_| PaidOrderRewardError::CorruptReservation("reservation is missing user"))?;
        let amount = stored_number(reservation.get("amount"))
            .ok_or(PaidOrderRewardError::CorruptReservation(
                "reservation amount is not a number",
            ))?;

        // 11. The increment and the receipt are one atomic user write, so a
        // retry is safe even when the successful response was lost.
        let now = DateTime::now();
        let credited = users_collection
            .find_one_and_update(
                user_credit_filter(beneficiary_id, transaction_id),
                user_credit_update(amount, transaction_id, now),
            )
            .return_document(ReturnDocument::After)
            .write_concern(journaled_write_concern())
            .await?;
        if credited.is_none()
            && !exists(
                &users_collection,
                already_credited_filter(beneficiary_id, transaction_id),
            )
            .await?
        {
            return Err(PaidOrderRewardError::ReservedBeneficiaryNotFound);
        }

        // 12. Finalize. A replay cannot reconstruct the historical post-credit
        // balance, so `balanceAfter` is written only when this call performed
        // the increment.
        let balance_after = credited
            .as_ref()
            .and_then(|user| stored_number(user.get("token_balance")));
        credit_transaction::schema()
            .native_collection(&self.database)
            .update_one(
                applied_filter(transaction_id),
                applied_update(balance_after, now),
            )
            .write_concern(journaled_write_concern())
            .await?;
        Ok(())
    }
}

impl PaidOrderRewardApplier for PaidOrderRewardService {
    fn apply<'a>(&'a self, input: &'a PaidOrderRewardInput) -> PaidOrderRewardFuture<'a> {
        let future: PaidOrderRewardFuture<'a> = Box::pin(async move {
            self.apply_paid_order_reward(input).await
        });
        future
    }
}

/// Convenience entry point over the injected seam. Accepts both a concrete
/// implementation and `&dyn PaidOrderRewardApplier`.
pub async fn apply_paid_order_reward<A: PaidOrderRewardApplier + ?Sized>(
    applier: &A,
    input: &PaidOrderRewardInput,
) -> Result<(), PaidOrderRewardError> {
    applier.apply(input).await
}

/// `writeConcern: { w: 1, j: true }`, applied per operation because the schemas
/// are not configured to journal.
pub fn journaled_write_concern() -> WriteConcern {
    WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build()
}

/// `polar:paid-order:{orderId}` from the raw order id.
pub fn idempotency_key(order_id: &str) -> String {
    format!("{IDEMPOTENCY_PREFIX}{order_id}")
}

/// `if (!orderId?.trim()) throw ...` using JavaScript whitespace.
pub fn validate_order_id(order_id: &str) -> Result<(), PaidOrderRewardError> {
    if trim(order_id).is_empty() {
        Err(PaidOrderRewardError::MissingOrderId)
    } else {
        Ok(())
    }
}

/// `'monthly' | 'yearly'` for callers bridging the TypeScript union.
pub fn parse_cadence(cadence: &str) -> Result<SubscriptionCadence, PaidOrderRewardError> {
    match cadence {
        "monthly" => Ok(SubscriptionCadence::Monthly),
        "yearly" => Ok(SubscriptionCadence::Yearly),
        other => Err(PaidOrderRewardError::InvalidCadence(other.to_owned())),
    }
}

/// `planType` plus `amount`, with the source's `amount <= 0` early return folded
/// into `None`. The reward table stays in [`crate::utils::referral`].
pub fn reward_plan_amount(
    product_id: &str,
    cadence: SubscriptionCadence,
) -> Option<(PlanType, i64)> {
    let plan = get_plan_type_from_product_id(product_id);
    let amount = get_bot_subscription_reward_amount(plan, cadence);
    (amount > 0).then_some((plan, amount))
}

/// `Subscription reward for ${planType} (${cadence})`.
pub fn reward_description(plan: PlanType, cadence: SubscriptionCadence) -> String {
    format!(
        "Subscription reward for {} ({})",
        plan.as_str(),
        cadence_name(cadence)
    )
}

/// The TypeScript cadence text. Source of truth is
/// [`crate::utils::referral::SubscriptionCadence`]; its `as_str` is private to
/// that module, which this adapter must not edit, so the mapping is restated.
fn cadence_name(cadence: SubscriptionCadence) -> &'static str {
    match cadence {
        SubscriptionCadence::Monthly => "monthly",
        SubscriptionCadence::Yearly => "yearly",
    }
}

/// Which user receives the reward credit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeneficiaryResolution {
    Referrer(ObjectId),
    Bot,
}

/// `payer.referrerId && payer.referralCodeUsed`, as a candidate pair.
pub fn referrer_candidate(payer: &Document) -> Option<(ObjectId, &str)> {
    let referrer_id = payer.get_object_id("referrerId").ok()?;
    let code = payer.get_str("referralCodeUsed").ok()?;
    if code.is_empty() {
        return None;
    }
    Some((referrer_id, code))
}

/// Pure beneficiary decision table. `code_matches` and `referrer_exists` are the
/// two lookups the source only runs when a candidate exists.
pub fn beneficiary_resolution(
    payer: &Document,
    code_matches: bool,
    referrer_exists: bool,
) -> BeneficiaryResolution {
    match referrer_candidate(payer) {
        Some((referrer_id, _)) if code_matches && referrer_exists => {
            BeneficiaryResolution::Referrer(referrer_id)
        }
        _ => BeneficiaryResolution::Bot,
    }
}

/// `{ code: code.toLowerCase(), owner, active: true }`. Referral codes are
/// validated as 1-16 ASCII alphanumerics or underscores, so `to_lowercase`
/// matches `String.prototype.toLowerCase` for every reachable code.
pub fn referral_code_filter(code: &str, owner: ObjectId) -> Document {
    doc! {
        "code": code.to_lowercase(),
        "owner": owner,
        "active": true,
    }
}

/// `{ accounts: { $elemMatch: { type: 'twitch', name: 'domdimabot' } } }`.
pub fn bot_account_filter() -> Document {
    doc! {
        "accounts": { "$elemMatch": { "type": "twitch", "name": BOT_ACCOUNT_LOGIN } },
    }
}

/// Inputs of the reservation `$setOnInsert` document.
#[derive(Debug, Clone)]
pub struct ReservationTerms<'a> {
    pub idempotency_key: &'a str,
    pub order_id: &'a str,
    pub product_id: &'a str,
    pub beneficiary_id: ObjectId,
    pub payer_id: ObjectId,
    pub referral_code_used: Option<&'a str>,
    pub reward_target_type: RewardTargetType,
    pub plan: PlanType,
    pub cadence: SubscriptionCadence,
    pub amount: i64,
    pub created_at: DateTime,
}

/// `{ idempotencyKey }`.
pub fn reservation_filter(idempotency_key: &str) -> Document {
    doc! { "idempotencyKey": idempotency_key }
}

/// The reservation upsert: `$setOnInsert` from the source plus the defaults and
/// timestamp Mongoose adds for `upsert: true`.
///
/// `setDefaultsOnInsert` contributes `balanceAfter: null`; the timestamps hook
/// puts `createdAt` in `$setOnInsert` and `updatedAt` in `$set`. No `_id` is
/// written (`setDefaultsOnInsert` skips the automatic `_id` path and MongoDB
/// generates it), and no `__v` (`__v` is not a schema path in an update).
/// `appliedAt` stays absent so the finalizing filter's `$exists: false` matches.
pub fn reservation_update(terms: &ReservationTerms<'_>) -> Document {
    doc! {
        "$setOnInsert": {
            "idempotencyKey": terms.idempotency_key,
            "user": terms.beneficiary_id,
            "type": SUBSCRIPTION_REWARD,
            "amount": js_number(terms.amount as f64),
            "metadata": {
                // The payer's raw value, not the lowercased lookup value, and
                // null rather than an empty string when unset.
                "referralCodeUsed": nullable_string(terms.referral_code_used),
                "referredUserId": terms.payer_id,
                "subscriptionId": terms.order_id,
                "planId": terms.product_id,
                "description": reward_description(terms.plan, terms.cadence),
                "externalReference": terms.idempotency_key,
                "rewardTargetType": terms.reward_target_type.as_str(),
            },
            "balanceAfter": Bson::Null,
            "createdAt": terms.created_at,
        },
        "$set": { "updatedAt": terms.created_at },
    }
}

/// Old paid-order rewards stored the order id in `metadata.subscriptionId`.
/// `$ne` against our own key keeps a concurrent RESERVED row out of the guard.
pub fn legacy_reward_filter(order_id: &str, idempotency_key: &str) -> Document {
    doc! {
        "type": SUBSCRIPTION_REWARD,
        "metadata.subscriptionId": order_id,
        "idempotencyKey": { "$ne": idempotency_key },
    }
}

/// `if (reservation.appliedAt) return;` — absent or null is not applied.
pub fn reservation_applied(reservation: &Document) -> bool {
    matches!(reservation.get("appliedAt"), Some(value) if !matches!(value, Bson::Null | Bson::Undefined))
}

/// `{ _id, appliedAt: { $exists: false } }`.
pub fn applied_filter(transaction_id: ObjectId) -> Document {
    doc! {
        "_id": transaction_id,
        "appliedAt": { "$exists": false },
    }
}

/// The finalizing `$set`. `balanceAfter` is present only when this call
/// performed the increment, so a replay never rewrites it.
pub fn applied_update(balance_after: Option<Bson>, now: DateTime) -> Document {
    let mut set = doc! { "appliedAt": now };
    if let Some(balance) = balance_after {
        set.insert("balanceAfter", balance);
    }
    set.insert("updatedAt", now);
    doc! { "$set": set }
}

/// `{ _id: user, applied_credit_transaction_ids: { $ne: transaction } }`.
/// Against an array, `$ne` matches when the array does not contain the value.
pub fn user_credit_filter(user_id: ObjectId, transaction_id: ObjectId) -> Document {
    doc! {
        "_id": user_id,
        "applied_credit_transaction_ids": { "$ne": transaction_id },
    }
}

/// `{ _id: user, applied_credit_transaction_ids: transaction }`.
pub fn already_credited_filter(user_id: ObjectId, transaction_id: ObjectId) -> Document {
    doc! {
        "_id": user_id,
        "applied_credit_transaction_ids": transaction_id,
    }
}

/// One atomic user write: increment, receipt, and the timestamp Mongoose adds.
pub fn user_credit_update(amount: Bson, transaction_id: ObjectId, now: DateTime) -> Document {
    doc! {
        "$inc": { "token_balance": amount },
        "$addToSet": { "applied_credit_transaction_ids": transaction_id },
        "$set": { "updated_at": now },
    }
}

/// The Node read/write number round trip for a stored amount or balance: Longs
/// within the promoted range and Doubles are re-encoded by the Node BSON writer.
pub fn stored_number(value: Option<&Bson>) -> Option<Bson> {
    match value? {
        Bson::Int32(value) => Some(js_number(f64::from(*value))),
        Bson::Int64(value) if (-JS_MAX_PROMOTED_INTEGER..=JS_MAX_PROMOTED_INTEGER).contains(value) => {
            Some(js_number(*value as f64))
        }
        Bson::Double(value) => Some(js_number(*value)),
        _ => None,
    }
}

/// Duplicate-key detection by numeric code.
pub fn is_duplicate_key_code(code: i32) -> bool {
    code == DUPLICATE_KEY_CODE
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Command(command) => is_duplicate_key_code(command.code),
        // A single find-and-modify write reports its failure here.
        ErrorKind::Write(WriteFailure::WriteError(write)) => is_duplicate_key_code(write.code),
        ErrorKind::Write(WriteFailure::WriteConcernError(_)) => false,
        ErrorKind::BulkWrite(bulk) => bulk
            .write_errors
            .values()
            .any(|write| is_duplicate_key_code(write.code)),
        ErrorKind::InsertMany(batch) => batch
            .write_errors
            .as_ref()
            .is_some_and(|errors| errors.iter().any(|write| is_duplicate_key_code(write.code))),
        _ => false,
    }
}

fn nullable_string(value: Option<&str>) -> Bson {
    match value {
        Some(value) => Bson::String(value.to_owned()),
        None => Bson::Null,
    }
}

/// `Model.exists(filter)` — an existence probe, not a document read.
async fn exists(
    collection: &Collection<Document>,
    filter: Document,
) -> mongodb::error::Result<bool> {
    Ok(collection
        .find_one(filter)
        .projection(doc! { "_id": 1 })
        .await?
        .is_some())
}
