//! The admin's AI credit grant (`POST /admin-site/users/:channelID/ai-credits/grant`,
//! `server/routes/admin_site.route.ts:868`) without its HTTP layer: what the route calls.
//!
//! The reference granted with a fresh id per call (a retry after a lost answer granted twice),
//! then wrote `getAiCredits()` plus the credits to the cache (counted twice when Polar's figure
//! already held the grant). Item 2 of P2-BILLING-02c (re-check point S2) makes a grant the
//! outcome of **one request**, kept durably, so no retry, however late, grants twice.
//!
//! # Identity
//!
//! A grant's operation id (Polar's `external_id`, which Polar deduplicates) is derived from the
//! request, never drawn at random:
//!
//! - **With a request id** (the admin site sends one with each submission and repeats it on a
//!   retry; the route passes it as [`AdminGrantRequest::request_id`]; the site sends none
//!   today): `admin-grant-{sha256(admin, request id, fingerprint)}`. The same request id always
//!   names the same grant; a request id reused for a different request (another channel,
//!   amount or reason) names a different one, so Polar's deduplication can never swallow a
//!   different grant.
//! - **Without one**: the request's fingerprint, `sha256` of who grants, to whom (channel and
//!   customer), how many whole credits and the reason, with the number of its **window**:
//!   `admin-grant-{fingerprint}-{n}`. A window opens with the first request of a fingerprint and
//!   lasts [`REPEAT_WINDOW_MS`] (24 hours) after that grant was confirmed. The windows of one
//!   fingerprint are numbered 1, 2, 3...: window `n + 1` can open only once window `n`'s grant
//!   is confirmed and its 24 hours have passed. A fixed clock bucket was not used: it would make
//!   two identical requests a second apart across its boundary two grants.
//!
//! # The record
//!
//! Every request is a document of `credittransactions` (the collection of credit receipts, with
//! the unique partial index on `idempotencyKey` the paid-order reservations rely on: required
//! before the first write, as `CreditTransactionSchema.init()` made it), reserved **before**
//! anything is sent by an upsert (`$setOnInsert`) on its key, and kept:
//!
//! | Field | Value |
//! |---|---|
//! | `idempotencyKey` | `admin-ai-grant:req:{hash}` (request id) or `admin-ai-grant:fp:{fingerprint}:{n, 10 digits}` |
//! | `user` | the user the credits are for |
//! | `type` | `manual_credit` (credits added by staff) |
//! | `amount` | the whole credits granted |
//! | `metadata.description` | the reason |
//! | `metadata.externalReference` | the operation id sent to Polar |
//! | `appliedAt` | when Polar confirmed the grant (stored now, or already held); missing until then |
//!
//! These are **AI credits granted at Polar**, not `token_balance` credits: nothing touches
//! `users.token_balance` or `applied_credit_transaction_ids`, and the referral readers of the
//! collection (`COMPLETED_REFERRAL_REWARD_FILTER`: `referral_bonus`, referrer
//! `subscription_reward`) never select `manual_credit`, which nothing else writes.
//!
//! # A request
//!
//! 1. Its record is found or reserved (two identical requests at once reserve the same key and
//!    share it). A record whose grant is confirmed answers that first outcome again,
//!    marked with a [`Repeat`], and **nothing is sent**: a request id at any
//!    time, a fingerprint within its window.
//! 2. A record whose grant is not confirmed (never sent, refused, or its outcome unknown, however
//!    long ago) is **reconciled against Polar by its operation id**: the same grant is sent
//!    again, and Polar answers that it stored it now or already held it (`duplicates`). Nothing
//!    new is sent while it is unconfirmed.
//! 3. The balance is verified before the grant ([`CreditsCache::verified_balance`]), so its
//!    publication cannot already hold it.
//! 4. The grant is sent ([`Ingest::grant_ai_credits_report`]); once Polar confirms it, the record
//!    gets `appliedAt`.
//! 5. **The local top-up runs only when Polar stored the grant now** (`inserted`, no
//!    `duplicates`) and only on top of that verified publication ([`CreditsCache::top_up`]).
//!
//! A process killed after step 1 or 2 leaves the record unconfirmed: the retry reconciles it
//! (one grant at Polar). Killed after Polar stored the grant and before step 4: the same, Polar
//! answers it already held it, nothing is topped up twice. Killed after step 4: the retry is a
//! repeat. A lost or unreadable answer is [`AdminGrant::OutcomeUnknown`] (the route answers 502
//! as the reference did) and the retry reconciles it.
//!
//! # Granting the same twice on purpose
//!
//! Inside the window an identical request (same admin, channel, customer, credits and reason) is
//! a repeat. To grant the same amount to the same channel again on purpose, **give another
//! reason** (`"support, second batch"`): the reason is part of the identity, so it is a new
//! grant at once. Otherwise an identical request becomes a new grant once the window has passed
//! ([`Repeat::new_grant_from_ms`]). With a request id, a new submission (a new id) is a new
//! grant. The answer says so: [`Repeat::HOW_TO_GRANT_AGAIN`].

use crate::gifts::Interrupt;
use crate::mongo_ops::{self, MongoOpError, journaled};
use crate::plans::credits::VerifiedBalance;
use crate::plans::credits_cache::{
    CreditsCache, CustomerStateSource, PlanLookup, PlanOwner, TopUp, UnverifiedBalance,
};
use crate::polar::{GrantInput, GrantRefused, Ingest, IngestOutcome, OperationId};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::Private;
use dima_model::credit_transactions::{COLLECTION as TRANSACTIONS, INFO as TRANSACTION_INFO};
use dima_store::mongo::MongoStore;
use dima_store::mongo::date::date;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::{Returned, UpdateOptions};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// How long after a grant was confirmed an identical request (no request id) is a repeat of it.
pub const REPEAT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// The deadline of the index check before the first reservation.
pub const INDEX_DEADLINE: Duration = Duration::from_secs(30);
/// The prefix of every admin grant's `idempotencyKey`.
pub const KEY_PREFIX: &str = "admin-ai-grant:";
/// Digits of a window number in a key (so keys sort by window).
const WINDOW_DIGITS: usize = 10;

/// What the admin asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct AdminGrantRequest {
    /// The user the credits are for (the route loaded it by the channel).
    pub user_id: ObjectId,
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
    /// The admin site's id of this submission, repeated on a retry (1 to 128 printable ASCII
    /// characters); `None` when it sends none (today).
    pub request_id: Option<String>,
}

impl AdminGrantRequest {
    fn admin(&self) -> &str {
        self.admin_login
            .as_ref()
            .map(|a| a.expose().as_str())
            .unwrap_or("")
    }

    /// `sha256(admin \0 channel \0 customer \0 whole credits \0 reason)`, hex: who grants, to
    /// whom, how much, why.
    pub fn fingerprint(&self) -> String {
        let text = format!(
            "{}\0{}\0{}\0{}\0{}",
            self.admin(),
            self.channel_id,
            self.customer_id.expose(),
            dima_text::number_to_string(self.credits.floor()),
            self.reason
        );
        hex::encode(Sha256::digest(text.as_bytes()))
    }

    /// The hash of a request id with its admin and fingerprint.
    fn request_hash(&self, request_id: &str) -> String {
        let text = format!("{}\0{request_id}\0{}", self.admin(), self.fingerprint());
        hex::encode(Sha256::digest(text.as_bytes()))
    }
}

/// Where the identity of a request comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Identity {
    /// A request id: one key forever.
    Request { hash: String },
    /// The fingerprint and its window `n`.
    Window { fingerprint: String, n: u64 },
}

impl Identity {
    fn key(&self) -> String {
        match self {
            Self::Request { hash } => format!("{KEY_PREFIX}req:{hash}"),
            Self::Window { fingerprint, n } => {
                format!("{KEY_PREFIX}fp:{fingerprint}:{n:0WINDOW_DIGITS$}")
            }
        }
    }

    fn operation_id(&self) -> String {
        match self {
            Self::Request { hash } => format!("admin-grant-{hash}"),
            Self::Window { fingerprint, n } => format!("admin-grant-{fingerprint}-{n}"),
        }
    }
}

/// A grant that was already confirmed when the request came.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repeat {
    /// When Polar confirmed the first grant (epoch ms).
    pub granted_at_ms: i64,
    /// From when an identical request is a new grant (the end of the window); `None` for a
    /// request id, which names this grant for ever.
    pub new_grant_from_ms: Option<i64>,
}

impl Repeat {
    /// What the answer tells the admin.
    pub const HOW_TO_GRANT_AGAIN: &'static str = "An identical grant (same admin, channel, credits and reason) was already made; nothing was granted again. To grant the same amount again now, use a different reason.";
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
        /// Set when this request repeats a grant already confirmed: nothing was sent now.
        repeat: Option<Repeat>,
    },
    /// Polar refused it, or it was never sent: nothing was granted. A retry sends the same
    /// grant again.
    Failed {
        /// The reference's message.
        message: String,
    },
    /// Polar may hold it: retry the same request (it is reconciled by the same operation id).
    OutcomeUnknown {
        /// The operation id kept for the retry.
        operation_id: OperationId,
        /// The reference's message.
        message: String,
    },
}

/// Why the grant could not start, or stopped.
#[derive(Debug, thiserror::Error)]
pub enum AdminGrantError {
    /// The request id is empty, too long or not printable ASCII.
    #[error("requestId must be 1 to 128 printable ASCII characters without spaces")]
    InvalidRequestId,
    /// The unique index on `idempotencyKey` is not there: nothing may be reserved.
    #[error("credittransactions unique index unavailable: {0}")]
    IndexUnavailable(String),
    /// MongoDB failed (before anything was sent, or while recording a confirmed grant: the
    /// retry reconciles it).
    #[error(transparent)]
    Mongo(#[from] MongoOpError),
    /// A stored record does not have the shape this module writes.
    #[error("admin grant record is malformed")]
    Malformed,
    /// A test interrupt stopped the call ([`Interrupt`]).
    #[error("interrupted at {0}")]
    Interrupted(&'static str),
}

/// The stores of the admin grant.
#[derive(Clone, Copy)]
pub struct AdminGrants<'a> {
    /// The records (`credittransactions`).
    pub store: &'a MongoStore,
    /// The grant flows (and their clock).
    pub ingest: &'a Ingest<'a>,
    /// The credit cache.
    pub cache: &'a CreditsCache,
    /// The current plan of a user.
    pub plans: &'a dyn PlanLookup,
    /// Polar's customer state.
    pub polar: &'a dyn CustomerStateSource,
    /// **Test seam**: stops at `admin-grant:reserved`, `admin-grant:sent` (Polar confirmed the
    /// grant, nothing recorded yet) and `admin-grant:recorded`, as if the process had died
    /// there. `None` in production.
    pub interrupt: Option<&'a dyn Interrupt>,
}

impl std::fmt::Debug for AdminGrants<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdminGrants")
    }
}

/// A record read back: its key, operation id and when its grant was confirmed.
struct Record {
    id: ObjectId,
    identity: Identity,
    operation_id: OperationId,
    applied_at_ms: Option<i64>,
}

impl AdminGrants<'_> {
    fn stop(&self, point: &'static str) -> Result<(), AdminGrantError> {
        match self.interrupt {
            Some(interrupt) if interrupt.at(point) => Err(AdminGrantError::Interrupted(point)),
            _ => Ok(()),
        }
    }

    fn now(&self) -> i64 {
        self.ingest.clock.now_ms()
    }

    async fn ensure_index(&self) -> Result<(), AdminGrantError> {
        dima_model::ensure_indexes(
            self.store,
            &TRANSACTION_INFO,
            dima_model::IndexPolicy::RequireUnique,
            INDEX_DEADLINE,
        )
        .await
        .require()
        .map_err(|e| AdminGrantError::IndexUnavailable(e.to_string()))
    }

    fn read(identity: Identity, document: &Document) -> Result<Record, AdminGrantError> {
        let id = document
            .get_object_id("_id")
            .map_err(|_| AdminGrantError::Malformed)?;
        let operation = document
            .get_document("metadata")
            .ok()
            .and_then(|m| m.get_str("externalReference").ok())
            .ok_or(AdminGrantError::Malformed)?;
        if operation != identity.operation_id() {
            return Err(AdminGrantError::Malformed);
        }
        let operation_id = OperationId::new(operation).map_err(|_| AdminGrantError::Malformed)?;
        let applied_at_ms = match document.get("appliedAt") {
            Some(Bson::DateTime(at)) => Some(at.timestamp_millis()),
            None | Some(Bson::Null) => None,
            Some(_) => return Err(AdminGrantError::Malformed),
        };
        Ok(Record {
            id,
            identity,
            operation_id,
            applied_at_ms,
        })
    }

    /// Finds or reserves the record of `identity` (an upsert on its key: two identical
    /// requests at once share one).
    async fn reserve(
        &self,
        request: &AdminGrantRequest,
        identity: Identity,
    ) -> Result<Record, AdminGrantError> {
        let key = identity.key();
        let insert = doc! { "$setOnInsert": {
            "idempotencyKey": &key,
            "user": request.user_id,
            "type": "manual_credit",
            "amount": js_number(request.credits.floor()),
            "metadata": {
                "description": &request.reason,
                "externalReference": identity.operation_id(),
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
            self.now(),
        )
        .await;
        let document = match reserved {
            Ok(document) => document,
            Err(error) if error.is_duplicate_key() => {
                mongo_ops::find_one(
                    self.store,
                    TRANSACTIONS,
                    doc! { "idempotencyKey": &key },
                    None,
                )
                .await?
            }
            Err(error) => return Err(error.into()),
        };
        Self::read(identity, &document.ok_or(AdminGrantError::Malformed)?)
    }

    /// The latest window of `fingerprint`, if any.
    async fn latest_window(&self, fingerprint: &str) -> Result<Option<Record>, AdminGrantError> {
        let prefix = format!("{KEY_PREFIX}fp:{fingerprint}:");
        let filter = doc! { "idempotencyKey": {
            "$gte": format!("{prefix}{}", "0".repeat(WINDOW_DIGITS)),
            "$lte": format!("{prefix}{}", "9".repeat(WINDOW_DIGITS)),
        } };
        let options = mongodb::options::FindOptions::builder()
            .sort(doc! { "idempotencyKey": -1 })
            .limit(1)
            .build();
        let found = mongo_ops::find(self.store, TRANSACTIONS, filter, options).await?;
        let Some(document) = found.first() else {
            return Ok(None);
        };
        let n = document
            .get_str("idempotencyKey")
            .ok()
            .and_then(|key| key.strip_prefix(prefix.as_str()))
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or(AdminGrantError::Malformed)?;
        Self::read(
            Identity::Window {
                fingerprint: fingerprint.to_owned(),
                n,
            },
            document,
        )
        .map(Some)
    }

    /// The record this request is about: its request id's, or the fingerprint's open window
    /// (a new one once the last one is confirmed and its window has passed).
    async fn record(&self, request: &AdminGrantRequest) -> Result<Record, AdminGrantError> {
        if let Some(request_id) = &request.request_id {
            let hash = request.request_hash(request_id);
            return self.reserve(request, Identity::Request { hash }).await;
        }
        let fingerprint = request.fingerprint();
        let n = match self.latest_window(&fingerprint).await? {
            // Unconfirmed (however old) or confirmed within its window: this request is about it.
            Some(latest) => match latest.applied_at_ms {
                None => return Ok(latest),
                Some(at) if self.now() < at.saturating_add(REPEAT_WINDOW_MS) => {
                    return Ok(latest);
                }
                Some(_) => match &latest.identity {
                    Identity::Window { n, .. } => n.saturating_add(1),
                    Identity::Request { .. } => return Err(AdminGrantError::Malformed),
                },
            },
            None => 1,
        };
        self.reserve(request, Identity::Window { fingerprint, n })
            .await
    }

    /// The answer to a request whose grant was already confirmed.
    fn repeat(record: Record, granted_at_ms: i64) -> AdminGrant {
        let new_grant_from_ms = match record.identity {
            Identity::Request { .. } => None,
            Identity::Window { .. } => Some(granted_at_ms.saturating_add(REPEAT_WINDOW_MS)),
        };
        AdminGrant::Granted {
            operation_id: record.operation_id,
            newly_stored: false,
            before: None,
            top_up: TopUp::Refused,
            repeat: Some(Repeat {
                granted_at_ms,
                new_grant_from_ms,
            }),
        }
    }

    /// The grant and the local top-up (see the module docs).
    pub async fn grant(
        &self,
        owner: &PlanOwner,
        request: &AdminGrantRequest,
    ) -> Result<AdminGrant, AdminGrantError> {
        if let Some(request_id) = &request.request_id {
            OperationId::new(request_id).map_err(|_| AdminGrantError::InvalidRequestId)?;
        }
        // What Polar would refuse before anything is sent is refused before anything is kept.
        if request.customer_id.expose().is_empty() {
            return Ok(AdminGrant::Failed {
                message: GrantRefused::MissingCustomer.to_string(),
            });
        }
        let whole = request.credits.floor();
        if !whole.is_finite() || whole <= 0.0 {
            return Ok(AdminGrant::Failed {
                message: GrantRefused::NotPositive.to_string(),
            });
        }
        self.ensure_index().await?;
        let record = self.record(request).await?;
        if let Some(at) = record.applied_at_ms {
            return Ok(Self::repeat(record, at));
        }
        self.stop("admin-grant:reserved")?;
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
            operation_id: record.operation_id.clone(),
            source: None,
        };
        let report = self.ingest.grant_ai_credits_report(&input).await;
        match report.outcome {
            IngestOutcome::Done { .. } => {
                self.stop("admin-grant:sent")?;
                mongo_ops::update_one(
                    self.store,
                    &TRANSACTION_INFO,
                    &doc! { "_id": record.id, "appliedAt": { "$exists": false } },
                    doc! { "$set": { "appliedAt": date(self.now()) } },
                    UpdateOptions::default(),
                    Some(journaled()),
                    self.now(),
                )
                .await?;
                self.stop("admin-grant:recorded")?;
                let newly_stored = report
                    .stored
                    .as_ref()
                    .is_some_and(|stored| stored.inserted >= 1.0 && stored.duplicates <= 0.0);
                let top_up = match (&verified, newly_stored) {
                    (Ok(verified), true) => self
                        .cache
                        .top_up(&request.channel_id, request.credits, verified)
                        .await
                        .unwrap_or(TopUp::Refused),
                    _ => TopUp::Refused,
                };
                Ok(AdminGrant::Granted {
                    operation_id: record.operation_id,
                    newly_stored,
                    before: verified.ok(),
                    top_up,
                    repeat: None,
                })
            }
            IngestOutcome::Failed { message } => Ok(AdminGrant::Failed { message }),
            IngestOutcome::OutcomeUnknown { message } => Ok(AdminGrant::OutcomeUnknown {
                operation_id: record.operation_id,
                message,
            }),
        }
    }
}

/// Why no verified balance was read (for the route's log).
pub fn unverified_reason(error: &UnverifiedBalance) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AdminGrantRequest {
        AdminGrantRequest {
            user_id: ObjectId::from_bytes([7; 12]),
            channel_id: "12".into(),
            customer_id: Private::from("cust".to_owned()),
            credits: 500.9,
            reason: "support 😃".into(),
            admin_login: Some(Private::from("admin".to_owned())),
            request_id: None,
        }
    }

    #[test]
    fn identities_name_the_request_and_fit_an_operation_id() {
        let request = request();
        let fingerprint = request.fingerprint();
        assert_eq!(fingerprint.len(), 64);
        let window = Identity::Window {
            fingerprint: fingerprint.clone(),
            n: 3,
        };
        assert_eq!(
            window.key(),
            format!("admin-ai-grant:fp:{fingerprint}:0000000003")
        );
        assert!(OperationId::new(&window.operation_id()).is_ok());
        // Whole credits: 500.9 and 500 are the same request; another reason is not.
        let same = AdminGrantRequest {
            credits: 500.0,
            ..request.clone()
        };
        assert_eq!(same.fingerprint(), fingerprint);
        let other = AdminGrantRequest {
            reason: "support, second batch".into(),
            ..request.clone()
        };
        assert_ne!(other.fingerprint(), fingerprint);
        // A request id reused for another request names another grant.
        assert_ne!(request.request_hash("r1"), other.request_hash("r1"));
        let by_id = Identity::Request {
            hash: request.request_hash("r1"),
        };
        assert!(OperationId::new(&by_id.operation_id()).is_ok());
        assert!(by_id.key().starts_with("admin-ai-grant:req:"));
    }
}
