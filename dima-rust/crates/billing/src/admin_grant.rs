//! The admin's AI credit grant (`POST /admin-site/users/:channelID/ai-credits/grant`,
//! `server/routes/admin_site.route.ts:868`) without its HTTP layer: what the route calls.
//!
//! The reference granted with a fresh id per call (a retry after a lost answer granted twice),
//! then wrote `getAiCredits()` plus the credits to the cache (counted twice when Polar's figure
//! already held the grant). Here:
//!
//! 1. **The operation id is persisted before the grant is sent**: a pending grant is keyed by
//!    what the admin asked for (channel, credits, reason, admin), `billing:admin-grant:pending:
//!    {sha256}` holding its operation id, 24 hours, set only if missing. An identical request
//!    while that grant's outcome is unknown reuses the id, so Polar (which deduplicates on the
//!    event's `external_id`) stores it once. A grant whose outcome is known (stored, or refused
//!    by Polar) releases the key, so a later identical request is a new grant.
//! 2. **The balance is verified before the grant** ([`CreditsCache::verified_balance`]), so its
//!    publication cannot already hold it.
//! 3. The grant is sent ([`Ingest::grant_ai_credits_report`]).
//! 4. **The local top-up runs only when Polar stored the grant now** (`inserted`, no
//!    `duplicates`) and only on top of that verified publication ([`CreditsCache::top_up`]); a
//!    grant Polar already held, a newer publication, or no verified balance tops up nothing:
//!    the grant shows when Polar's figure does (at worst after the 300 s cache).
//!
//! A kill after step 1 leaves the pending key: the admin's retry reuses the id. A kill after
//! the grant was sent: the same. An answer lost or unreadable: the outcome is unknown, the key
//! stays, and the admin's retry (the route answers 502 as the reference did) sends the same
//! grant again, which Polar deduplicates; the dead-letter report of the usage side lists what
//! never settles.
//!
//! The Dragonfly key is *rebuilt* at cutover (dropped): a pending grant lost with it can be
//! granted again by a retry, which is the reference's behaviour.

use crate::plans::credits::VerifiedBalance;
use crate::plans::credits_cache::{
    CreditsCache, CustomerStateSource, PlanLookup, PlanOwner, TopUp, UnverifiedBalance,
};
use crate::polar::{GrantInput, Ingest, IngestOutcome, OperationId};
use dima_core::Random;
use dima_model::Private;
use dima_store::dragonfly::commands::{SetCondition, SetExpiry, SetOptions, SetOutcome};
use dima_store::dragonfly::{Dragonfly, DragonflyError, Script};
use sha2::{Digest, Sha256};

/// How long an unsettled admin grant keeps its operation id.
pub const PENDING_TTL_SECONDS: u64 = 86_400;

static RELEASE: Script = Script::new(
    "ADMIN_GRANT_PENDING_RELEASE",
    include_str!("lua/admin_grant_release.lua"),
);

/// The scripts of this module, for the tests that check them.
pub fn scripts() -> [&'static Script; 1] {
    [&RELEASE]
}

/// What the admin asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct AdminGrantRequest {
    /// The channel.
    pub channel_id: String,
    /// The user's Polar customer.
    pub customer_id: Private<String>,
    /// `parseCreditGrantAmount(credits)` (checked by the route: above 0, at most the maximum).
    pub credits: f64,
    /// `reason` (trimmed, at most 180, by the route).
    pub reason: String,
    /// The admin's login.
    pub admin_login: Option<Private<String>>,
}

impl AdminGrantRequest {
    /// `billing:admin-grant:pending:{sha256(channel \0 credits \0 reason \0 admin)}`.
    pub fn pending_key(&self) -> String {
        let admin = self
            .admin_login
            .as_ref()
            .map(|a| a.expose().as_str())
            .unwrap_or("");
        let text = format!(
            "{}\0{}\0{}\0{}",
            self.channel_id,
            dima_text::number_to_string(self.credits.floor()),
            self.reason,
            admin
        );
        format!(
            "billing:admin-grant:pending:{}",
            hex::encode(Sha256::digest(text.as_bytes()))
        )
    }
}

/// What the grant did.
#[derive(Clone, Debug, PartialEq)]
pub enum AdminGrant {
    /// Polar holds the grant.
    Granted {
        /// The operation id the grant carries.
        operation_id: OperationId,
        /// Whether Polar stored it with this call (`false`: it already held it).
        newly_stored: bool,
        /// The balance verified before the grant, when there was one: Polar's figures
        /// ([`VerifiedBalance::polar_reported`]) and the spending figures the cache held
        /// ([`VerifiedBalance::for_spending`], what the reference answered as `before`).
        before: Option<VerifiedBalance>,
        /// The local top-up.
        top_up: TopUp,
    },
    /// Polar refused it, or it was never sent: nothing was granted.
    Failed {
        /// The reference's message.
        message: String,
    },
    /// Polar may hold it: retry the same request (it reuses the operation id).
    OutcomeUnknown {
        /// The operation id kept for the retry.
        operation_id: OperationId,
        /// The reference's message.
        message: String,
    },
}

/// Why the grant could not start.
#[derive(Debug, thiserror::Error)]
pub enum AdminGrantError {
    /// Dragonfly failed before anything was sent.
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
    /// No operation id could be drawn.
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
}

/// The stores of the admin grant.
#[derive(Clone, Copy)]
pub struct AdminGrants<'a> {
    /// The pending grants.
    pub dragonfly: &'a Dragonfly,
    /// The grant flows.
    pub ingest: &'a Ingest<'a>,
    /// The credit cache.
    pub cache: &'a CreditsCache,
    /// The current plan of a user.
    pub plans: &'a dyn PlanLookup,
    /// Polar's customer state.
    pub polar: &'a dyn CustomerStateSource,
    /// Operation ids.
    pub random: &'a dyn Random,
}

impl std::fmt::Debug for AdminGrants<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdminGrants")
    }
}

impl AdminGrants<'_> {
    /// The operation id of this request: the pending one, or a new one stored first.
    pub async fn begin(&self, request: &AdminGrantRequest) -> Result<OperationId, AdminGrantError> {
        let key = request.pending_key();
        let fresh = format!("admin-grant-{}", self.random.uuid_v4()?);
        let outcome = self
            .dragonfly
            .set(
                &key,
                fresh.as_bytes(),
                SetOptions {
                    condition: SetCondition::IfMissing,
                    expiry: SetExpiry::Seconds(PENDING_TTL_SECONDS),
                    get: true,
                },
            )
            .await?;
        let id = match outcome {
            SetOutcome::Previous(Some(previous)) => {
                String::from_utf8(previous).map_err(|_| DragonflyError::NotUtf8)?
            }
            _ => fresh,
        };
        OperationId::new(&id).map_err(|_| DragonflyError::NotUtf8.into())
    }

    /// Forgets the pending grant once its outcome is known.
    async fn settle(&self, request: &AdminGrantRequest, id: &OperationId) {
        let key = request.pending_key();
        let _ = RELEASE
            .run_value(self.dragonfly, &[key.as_str()], &[id.as_str()])
            .await;
    }

    /// The grant and the local top-up (see the module docs).
    pub async fn grant(
        &self,
        owner: &PlanOwner,
        request: &AdminGrantRequest,
    ) -> Result<AdminGrant, AdminGrantError> {
        let operation_id = self.begin(request).await?;
        let verified = self
            .cache
            .verified_balance(owner, &request.channel_id, self.plans, self.polar)
            .await;
        let input = GrantInput {
            customer_id: request.customer_id.clone(),
            channel_id: Some(request.channel_id.clone()),
            credits: request.credits,
            reason: request.reason.clone(),
            admin_login: request.admin_login.clone(),
            operation_id: operation_id.clone(),
            source: None,
        };
        let report = self.ingest.grant_ai_credits_report(&input).await;
        match report.outcome {
            IngestOutcome::Done { .. } => {
                let newly_stored = report
                    .stored
                    .as_ref()
                    .is_some_and(|stored| stored.inserted >= 1.0 && stored.duplicates <= 0.0);
                let before = verified.as_ref().ok().cloned();
                let top_up = match (&verified, newly_stored) {
                    (Ok(verified), true) => self
                        .cache
                        .top_up(&request.channel_id, request.credits, verified)
                        .await
                        .unwrap_or(TopUp::Refused),
                    _ => TopUp::Refused,
                };
                self.settle(request, &operation_id).await;
                Ok(AdminGrant::Granted {
                    operation_id,
                    newly_stored,
                    before,
                    top_up,
                })
            }
            IngestOutcome::Failed { message } => {
                self.settle(request, &operation_id).await;
                Ok(AdminGrant::Failed { message })
            }
            IngestOutcome::OutcomeUnknown { message } => Ok(AdminGrant::OutcomeUnknown {
                operation_id,
                message,
            }),
        }
    }
}

/// Why no verified balance was read (for the route's log).
pub fn unverified_reason(error: &UnverifiedBalance) -> String {
    error.to_string()
}
