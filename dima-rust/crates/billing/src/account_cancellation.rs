//! `revokePolarSubscriptionsForAccount(userID)` (`utils/polar_account_cancellation.ts`),
//! called first by account deletion (`utils/account_deletion.ts:68`): every subscription Polar
//! can still bill is revoked (ended now, no further charge) before any data is removed; if one
//! stays billable the deletion stops and the user can retry.
//!
//! Subscriptions are found both by our user id as Polar's external customer id and by the
//! stored Polar customer id. A revoke that fails is checked: a subscription that already ended
//! (a concurrent cancel) is fine, one that can still bill fails the call.
//!
//! **Once and only once.** A revoke is idempotent at Polar: the second `DELETE` of an ended
//! subscription fails and the re-read shows it ended. A retry after a kill or a lost answer
//! lists again (ended subscriptions are no longer billable) and revokes only what is left. No
//! operation id is needed: no state of ours changes.
//!
//! Difference: the lists are read within [`crate::polar::MAX_LIST_PAGES`] pages; past that the
//! call fails (the deletion stops) instead of looping without end.

use crate::mongo_ops;
use crate::polar::{MAX_LIST_PAGES, PolarClient, PolarError, SubscriptionFilter};
use bson::doc;
use bson::oid::ObjectId;
use dima_store::mongo::MongoStore;
use serde_json::Value;

/// `BILLABLE_STATUSES`: what Polar can still bill or keep active.
pub const BILLABLE_STATUSES: [&str; 4] = ["active", "trialing", "past_due", "unpaid"];

/// Why the cancellation stopped.
#[derive(Debug, thiserror::Error)]
pub enum CancellationError {
    /// `Unexpected Polar subscription list response`.
    #[error("Unexpected Polar subscription list response")]
    UnexpectedList,
    /// A subscription list has more than [`MAX_LIST_PAGES`] pages.
    #[error("Polar subscription list exceeds {MAX_LIST_PAGES} pages")]
    TooManyPages,
    /// Polar failed (a revoke whose subscription can still bill, or a read).
    #[error(transparent)]
    Polar(#[from] PolarError),
    /// MongoDB failed.
    #[error(transparent)]
    Mongo(#[from] mongo_ops::MongoOpError),
}

fn billable(status: Option<&str>) -> bool {
    status.is_some_and(|s| BILLABLE_STATUSES.contains(&s))
}

/// `listBillableSubscriptionIds(filter, value)`.
async fn billable_ids(
    polar: &PolarClient,
    filter: SubscriptionFilter,
    value: &str,
) -> Result<Vec<String>, CancellationError> {
    let mut ids = Vec::new();
    for page in 1..=MAX_LIST_PAGES {
        let response = polar
            .list_subscriptions_page_by(filter, value, page)
            .await?;
        let Some(items) = response.get("items").and_then(Value::as_array) else {
            return Err(CancellationError::UnexpectedList);
        };
        ids.extend(items.iter().filter_map(|subscription| {
            let status = subscription.get("status").and_then(Value::as_str);
            billable(status)
                .then(|| subscription.get("id").and_then(Value::as_str))
                .flatten()
                .map(str::to_owned)
        }));
        // `page >= (response.pagination?.max_page ?? 1)`.
        let max = response
            .get("pagination")
            .and_then(|p| p.get("max_page"))
            .filter(|m| !m.is_null());
        let last = match max {
            None => f64::from(page) >= 1.0,
            Some(max) => crate::js::ge_number(f64::from(page), Some(max)),
        };
        if last {
            return Ok(ids);
        }
    }
    Err(CancellationError::TooManyPages)
}

/// `revokePolarSubscriptionsForAccount(userID)`: how many billable subscriptions were revoked
/// (0 for an unknown user).
pub async fn revoke_polar_subscriptions_for_account(
    store: &MongoStore,
    polar: &PolarClient,
    user_id: ObjectId,
) -> Result<usize, CancellationError> {
    let user = mongo_ops::find_one(
        store,
        dima_model::users::COLLECTION,
        doc! { "_id": user_id },
        Some(doc! { "polar_sh_customer_id": 1 }),
    )
    .await?;
    let Some(user) = user else {
        return Ok(0);
    };
    // A `Set` in insertion order.
    let mut ids: Vec<String> = Vec::new();
    let mut add = |found: Vec<String>| {
        for id in found {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    };
    add(billable_ids(
        polar,
        SubscriptionFilter::ExternalCustomerId,
        &user_id.to_hex(),
    )
    .await?);
    if let Some(customer) = user
        .get_str("polar_sh_customer_id")
        .ok()
        .filter(|c| !c.is_empty())
    {
        add(billable_ids(polar, SubscriptionFilter::CustomerId, customer).await?);
    }
    for id in &ids {
        if let Err(revoke) = polar.revoke_subscription(id).await {
            // A concurrent cancel may already have ended it; only fail if it can still bill.
            let current = polar.get_subscription_fetch(id).await?;
            if billable(current.get("status").and_then(Value::as_str))
                || !crate::js::truthy(current.get("status"))
            {
                return Err(revoke.into());
            }
        }
    }
    Ok(ids.len())
}
