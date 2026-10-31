//! Concrete composition for the Polar paid-order reward seam.
//!
//! [`super::apply_polar_reward_domain_event`] owns the event filters, the owner
//! resolution, and the cadence/payload validation. The reward write itself is
//! delegated to [`super::PolarRewardApplier`]; its application adapter is
//! `src/utils/paid_order_reward.ts`, ported to
//! [`crate::utils::paid_order_reward`] (owned by team2-api-data).
//!
//! This module is the single bridge between those two halves. It converts the
//! seam's string cadence into the adapter's typed
//! [`crate::utils::referral::SubscriptionCadence`] and maps adapter failures
//! onto [`PolarBillingError`], so no consumer restates the reward table, the
//! reservation/idempotency rules, the beneficiary policy, or the error
//! taxonomy. Nothing here runs at load time.
//!
//! Two equivalent compositions are provided:
//!
//! * [`PaidOrderRewardService`] implements [`PolarRewardApplier`], so a
//!   long-lived service can be passed straight to
//!   [`super::apply_polar_reward_domain_event`].
//! * [`dispatch_paid_order_reward_event`] builds that service from a
//!   [`Database`] and runs the canonical branch in one call. Construction only
//!   stores a cheap clone of the driver handle (the client pool is shared).
//!
//! Enabled only with feature `paid-order-reward`, beside the parent module's
//! `polar-billing-events` gate. The adapter's own module owns the reward policy
//! and the collection definitions; this file adds no table, filter, or write.

use super::{
    apply_polar_reward_domain_event, BillingFuture, PaidOrderRewardInput, PolarBillingError,
    PolarBillingStore, PolarOwnerResolver, PolarRewardApplier,
};
use crate::domain_event_contracts::DomainEventEnvelope;
use crate::utils::paid_order_reward::{
    PaidOrderRewardError, PaidOrderRewardInput as TypedRewardInput, PaidOrderRewardService,
};
use mongodb::Database;

/// Bridge-local message for a cadence value the TypeScript
/// `'monthly' | 'yearly'` union cannot express.
///
/// The event consumer only rejects a *missing* cadence with the source-authored
/// [`super::REWARD_CADENCE`]. An unexpected value reaches this bridge, where the
/// typed adapter rejects it instead of silently resolving to a zero reward, so
/// the failure is reported as a business error rather than a database error.
pub const REWARD_CADENCE_UNSUPPORTED: &str =
    "Polar paid order has an unsupported billing cadence";

/// Converts the seam input into the adapter's typed input.
///
/// Only the cadence can fail here: `PaidOrderRewardInput::from_cadence_str`
/// validates nothing else, and the event branch has already required a
/// non-empty order id and a plan product id.
pub fn typed_reward_input(
    input: &PaidOrderRewardInput,
) -> Result<TypedRewardInput, PolarBillingError> {
    TypedRewardInput::from_cadence_str(
        input.owner_user_id.as_str(),
        input.order_id.as_str(),
        input.product_id.as_str(),
        input.cadence.as_str(),
    )
    .map_err(map_reward_error)
}

/// Maps an adapter failure onto the consumer's error type.
///
/// Source-authored business messages are preserved verbatim. Driver failures
/// (index installation, reads/writes) are runtime failures: they are
/// infrastructure errors, not decisions about the order, and their rendered
/// message is already redacted by the driver.
pub fn map_reward_error(error: PaidOrderRewardError) -> PolarBillingError {
    let message = error.to_string();
    match error {
        PaidOrderRewardError::Index(_) | PaidOrderRewardError::Mongo(_) => {
            PolarBillingError::Runtime(message)
        }
        PaidOrderRewardError::InvalidCadence(cadence) => {
            PolarBillingError::Business(format!("{}: {}", REWARD_CADENCE_UNSUPPORTED, cadence))
        }
        _ => PolarBillingError::Business(message),
    }
}

impl PolarRewardApplier for PaidOrderRewardService {
    fn apply_paid_order_reward<'a>(
        &'a self,
        input: &'a PaidOrderRewardInput,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            let typed = typed_reward_input(input)?;
            PaidOrderRewardService::apply_paid_order_reward(self, &typed)
                .await
                .map_err(map_reward_error)
        })
    }
}

/// One-call composition: builds the concrete adapter for `database` and runs
/// [`super::apply_polar_reward_domain_event`] unchanged.
///
/// The event filters, owner resolution, and cadence checks stay in the canonical
/// branch; this helper adds no policy of its own.
pub async fn dispatch_paid_order_reward_event(
    event: &DomainEventEnvelope,
    store: &dyn PolarBillingStore,
    resolver: Option<&dyn PolarOwnerResolver>,
    database: Database,
) -> Result<(), PolarBillingError> {
    let rewards = PaidOrderRewardService::new(database);
    apply_polar_reward_domain_event(event, store, resolver, &rewards).await
}
