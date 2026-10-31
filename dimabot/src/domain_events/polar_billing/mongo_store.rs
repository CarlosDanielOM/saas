//! Concrete MongoDB adapter for [`PolarBillingStore`].
//!
//! Source contract: the `IUsers` reads and writes in
//! `dimabot/src/domain_events/polar_billing_events.ts` —
//! `UsersSchema.findById`, `findOneAndUpdate(...).select(...).lean()` and
//! `updateOne(...)`, plus the `users` schema's hidden `polar_credit_snapshot`
//! field.
//!
//! Preserved behaviour: the owner document is read from the `users` collection
//! through the schema definition (so the schema's hidden-field projection and
//! collection name stay authoritative); the plan write returns the **after**
//! document; the credit writes drop the schema's exclusion of
//! `polar_credit_snapshot` exactly like Mongoose's `.select('+field')`; and the
//! owner projection filters `accounts` to `type == "twitch"`.
//!
//! Deliberately NOT here: the ordering fences (the caller builds the filter and
//! update documents in `plan_projection` / `credits_projection`), retention,
//! Redis, entitlement reads, or any schema change. Construction performs no IO;
//! the injected [`Database`] is used only when a method runs.

use super::{
    BillingFuture, PolarBillingError, PolarBillingStore, PolarCreditSnapshot,
    PolarCreditSnapshotRecord, PolarOwner,
};
use crate::schemas::users;
use crate::utils::ai_credit_projection::PlanTier;
use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
    options::ReturnDocument,
};

/// The hidden `polar_credit_snapshot` field, named once for both projections.
pub const CREDIT_SNAPSHOT_FIELD: &str = "polar_credit_snapshot";

/// Concrete `PolarBillingStore`. Construction performs no IO and reads no
/// environment; every operation uses the injected database handle.
#[derive(Clone)]
pub struct MongoPolarBillingStore {
    database: Database,
}

impl MongoPolarBillingStore {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    /// The `users` collection exactly as the schema definition names it.
    pub fn collection(&self) -> Collection<Document> {
        users::schema().native_collection(&self.database)
    }
}

/// Mongo failures are typed and never panic. The rendered message is for server
/// logs only; it is not a user-facing payload.
pub(crate) fn mongo_error(error: mongodb::error::Error) -> PolarBillingError {
    PolarBillingError::Runtime(format!("Polar billing MongoDB operation failed: {error}"))
}

fn schema_error(context: &'static str) -> PolarBillingError {
    PolarBillingError::Serialization(format!("Polar billing user document is missing {context}"))
}

/// `plan_tier` as stored, defaulting to `free` like the schema default.
pub(crate) fn stored_plan_tier(value: Option<&str>) -> PlanTier {
    match value {
        Some("premium") => PlanTier::Premium,
        Some("pro") => PlanTier::Pro,
        _ => PlanTier::Free,
    }
}

fn datetime_millis(value: Option<&Bson>) -> Option<i64> {
    match value? {
        Bson::DateTime(date) => Some(date.timestamp_millis()),
        _ => None,
    }
}

/// `accounts.filter(a => a.type === 'twitch').map(a => a.id)`.
fn twitch_account_ids(document: &Document) -> Vec<String> {
    document
        .get_array("accounts")
        .ok()
        .map(|accounts| {
            accounts
                .iter()
                .filter_map(|account| {
                    let account = account.as_document()?;
                    if account.get_str("type").ok() != Some("twitch") {
                        return None;
                    }
                    account.get_str("id").ok().map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `IUsers` projection every Polar consumer reads.
pub(crate) fn owner_from_document(document: &Document) -> Result<PolarOwner, PolarBillingError> {
    let owner_id = document
        .get_object_id("_id")
        .map_err(|_| schema_error("_id"))?;
    Ok(PolarOwner {
        owner_id,
        plan_tier: stored_plan_tier(document.get_str("plan_tier").ok()),
        plan_tier_until: datetime_millis(document.get("plan_tier_until")),
        polar_sh_customer_id: document
            .get_str("polar_sh_customer_id")
            .ok()
            .map(str::to_owned),
        polar_plan_event_at: datetime_millis(document.get("polar_plan_event_at")),
        polar_plan_event_key: document
            .get_str("polar_plan_event_key")
            .ok()
            .map(str::to_owned),
        polar_plan_effects_pending: document
            .get_bool("polar_plan_effects_pending")
            .ok()
            .unwrap_or(false),
        polar_plan_entitlement_fingerprint: document
            .get_str("polar_plan_entitlement_fingerprint")
            .ok()
            .map(str::to_owned),
        twitch_account_ids: twitch_account_ids(document),
    })
}

/// `polar_credit_snapshot` plus the fields the credits consumer needs.
pub(crate) fn credit_record_from_document(
    document: &Document,
) -> Result<PolarCreditSnapshotRecord, PolarBillingError> {
    let snapshot = match document.get_document(CREDIT_SNAPSHOT_FIELD) {
        Ok(snapshot) => {
            let occurred_at = snapshot
                .get_datetime("occurredAt")
                .map_err(|_| schema_error("polar_credit_snapshot.occurredAt"))?
                .timestamp_millis();
            let event_key = snapshot
                .get_str("eventKey")
                .map_err(|_| schema_error("polar_credit_snapshot.eventKey"))?
                .to_owned();
            let meters = snapshot
                .get_array("meters")
                .ok()
                .map(|meters| {
                    meters
                        .iter()
                        .filter_map(|meter| meter.as_document().cloned())
                        .collect()
                })
                .unwrap_or_default();
            Some(PolarCreditSnapshot {
                occurred_at,
                event_key,
                meters,
            })
        }
        Err(_) => None,
    };
    Ok(PolarCreditSnapshotRecord {
        owner_id: document
            .get_object_id("_id")
            .map_err(|_| schema_error("_id"))?,
        plan_tier: stored_plan_tier(document.get_str("plan_tier").ok()),
        polar_plan_event_at: datetime_millis(document.get("polar_plan_event_at")),
        polar_plan_event_key: document
            .get_str("polar_plan_event_key")
            .ok()
            .map(str::to_owned),
        twitch_account_ids: twitch_account_ids(document),
        snapshot,
    })
}

/// The schema's default projection (hidden fields excluded, as Mongoose does for
/// `.lean()` without an explicit `+field`).
pub(crate) fn default_projection() -> Document {
    users::schema().default_projection()
}

/// `.select('+polar_credit_snapshot')`: remove the snapshot from the hidden-field
/// exclusion so the returned document still carries every other default field.
pub(crate) fn credit_snapshot_projection() -> Document {
    let mut projection = default_projection();
    projection.remove(CREDIT_SNAPSHOT_FIELD);
    projection
}

impl PolarBillingStore for MongoPolarBillingStore {
    fn find_owner<'a>(&'a self, owner_id: ObjectId) -> BillingFuture<'a, Option<PolarOwner>> {
        Box::pin(async move {
            let document = self
                .collection()
                .find_one(doc! {"_id": owner_id})
                .projection(default_projection())
                .await
                .map_err(mongo_error)?;
            document.as_ref().map(owner_from_document).transpose()
        })
    }

    fn plan_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarOwner>> {
        Box::pin(async move {
            let document = self
                .collection()
                .find_one_and_update(filter.clone(), update.clone())
                .return_document(ReturnDocument::After)
                .projection(default_projection())
                .await
                .map_err(mongo_error)?;
            document.as_ref().map(owner_from_document).transpose()
        })
    }

    fn unset_plan_effects_pending<'a>(
        &'a self,
        owner_id: ObjectId,
        event_key: &'a str,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.collection()
                .update_one(
                    doc! {"_id": owner_id, "polar_plan_event_key": event_key},
                    doc! {"$unset": {"polar_plan_effects_pending": ""}},
                )
                .await
                .map_err(mongo_error)?;
            Ok(())
        })
    }

    fn credit_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>> {
        Box::pin(async move {
            let document = self
                .collection()
                .find_one_and_update(filter.clone(), update.clone())
                .return_document(ReturnDocument::After)
                .projection(credit_snapshot_projection())
                .await
                .map_err(mongo_error)?;
            document.as_ref().map(credit_record_from_document).transpose()
        })
    }

    fn credit_find_by_id<'a>(
        &'a self,
        owner_id: ObjectId,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>> {
        Box::pin(async move {
            let document = self
                .collection()
                .find_one(doc! {"_id": owner_id})
                .projection(credit_snapshot_projection())
                .await
                .map_err(mongo_error)?;
            document.as_ref().map(credit_record_from_document).transpose()
        })
    }
}
