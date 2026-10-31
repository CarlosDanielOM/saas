//! Concrete `PolarOwnerResolver` over the `users` collection.
//!
//! Source contract: `polarWebhookProducer.resolveOwner` in
//! `dimabot/src/domain_events/polar_events.ts` and
//! `resolveDomainEventOwner` in `src/domain_events/domain_event_identity.ts`.
//!
//! Preserved resolution order for a `polar`/`customer` subject:
//! 1. a user whose `polar_sh_customer_id` equals the subject id;
//! 2. otherwise, when the event metadata carries an ObjectId-shaped
//!    `externalCustomerId`, that user when its customer link is absent or matches;
//! 3. otherwise, when the metadata carries `legacyTwitchChannelId`, a user with a
//!    `twitch` account of that id whose customer link is absent, empty, or matches.
//!
//! A subject that is not a Polar customer returns no owner (the source returns
//! `undefined`). A Polar customer with no matching owner is the source's
//! `owner:polar customer mapping unresolved` prerequisite, not a generic failure.
//!
//! Deliberately NOT here: streaming-account/integration lookups (their adapters
//! own them), event normalization, entitlement reads, or any write.
//! Construction performs no IO.

use super::{
    BillingFuture, OWNER_MAPPING_UNRESOLVED, PolarBillingError, PolarOwner, PolarOwnerResolver,
    mongo_store::{mongo_error, owner_from_document},
};
use crate::domain_event_contracts::DomainEventEnvelope;
use crate::schemas::users;
use mongodb::{
    Database,
    bson::{Document, doc, oid::ObjectId},
};
use serde_json::Value;

/// Concrete owner resolver. Construction performs no IO and reads no environment.
#[derive(Clone)]
pub struct MongoPolarOwnerResolver {
    database: Database,
}

impl MongoPolarOwnerResolver {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    /// The full owner record (id, plan tier, Polar customer id, twitch accounts).
    /// `Ok(None)` means "this event is not owned by a user" (non-customer
    /// subject); an unresolvable Polar customer is the prerequisite error.
    pub async fn resolve_owner(
        &self,
        event: &DomainEventEnvelope,
    ) -> Result<Option<PolarOwner>, PolarBillingError> {
        let subject = event.get("subject").and_then(Value::as_object);
        let kind = subject.and_then(|subject| subject.get("kind")).and_then(Value::as_str);
        let provider = subject
            .and_then(|subject| subject.get("provider"))
            .and_then(Value::as_str);
        let subject_id = subject
            .and_then(|subject| subject.get("id"))
            .and_then(Value::as_str);
        if kind != Some("customer") || provider != Some("polar") {
            // The source returns `undefined` before any query for other subjects.
            return Ok(None);
        }
        let Some(subject_id) = subject_id.filter(|id| !id.is_empty()) else {
            return Err(PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED));
        };
        let metadata = event.metadata().and_then(Value::as_object);
        let external = metadata
            .and_then(|metadata| metadata.get("externalCustomerId"))
            .and_then(Value::as_str);
        let legacy = metadata
            .and_then(|metadata| metadata.get("legacyTwitchChannelId"))
            .and_then(Value::as_str);

        // 1. The pinned customer link is authoritative.
        if let Some(owner) = self
            .lookup(doc! {"polar_sh_customer_id": subject_id})
            .await?
        {
            return Ok(Some(owner));
        }
        // 2. A provider-verified external user id, checked against the link.
        if let Some(external) = external {
            if is_object_id_hex(external) {
                let owner_id = ObjectId::parse_str(external)
                    .map_err(|_| PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED))?;
                let Some(owner) = self.lookup(doc! {"_id": owner_id}).await? else {
                    return Ok(None);
                };
                // Copy the comparison result so the borrow ends before the move.
                let link_matches = match owner.pinned_customer_id() {
                    None => true,
                    Some(customer) => customer == subject_id,
                };
                return Ok(if link_matches { Some(owner) } else { None });
            }
        }
        // 3. The retained legacy Twitch channel id.
        if let Some(legacy) = legacy.filter(|id| !id.is_empty()) {
            let owner = self
                .lookup(doc! {
                    "accounts": {"$elemMatch": {"type": "twitch", "id": legacy}},
                    "$or": [
                        {"polar_sh_customer_id": mongodb::bson::Bson::Null},
                        {"polar_sh_customer_id": ""},
                        {"polar_sh_customer_id": subject_id},
                    ],
                })
                .await?;
            return Ok(owner);
        }
        Err(PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED))
    }

    async fn lookup(&self, filter: Document) -> Result<Option<PolarOwner>, PolarBillingError> {
        let document = users::schema()
            .native_collection(&self.database)
            .find_one(filter)
            .projection(users::schema().default_projection())
            .await
            .map_err(mongo_error)?;
        document.as_ref().map(owner_from_document).transpose()
    }
}

fn is_object_id_hex(value: &str) -> bool {
    value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl PolarOwnerResolver for MongoPolarOwnerResolver {
    fn resolve_owner_user_id<'a>(
        &'a self,
        event: &'a DomainEventEnvelope,
    ) -> BillingFuture<'a, Option<String>> {
        Box::pin(async move {
            Ok(self
                .resolve_owner(event)
                .await?
                .map(|owner| owner.owner_id.to_hex()))
        })
    }
}
