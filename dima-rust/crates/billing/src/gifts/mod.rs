//! Credit gifts: one channel buys AI credits for another (`utils/credit_gifts.ts` and
//! `utils/credit_gift_provider.ts`; the route `server/routes/billing.route.ts:203-251`, the
//! domain-event consumer `domain_events/credit_gift_events.ts`, the cron worker
//! `workers/credit_gifts.worker.ts`).
//!
//! # How a gift moves
//!
//! A gift is **paid with money at Polar**, never taken from the giver's credit balance: the
//! buyer pays a one-time checkout of a gift product (which grants nothing), then the worker
//! creates and confirms a free checkout of the pack's *fulfillment* product for the recipient,
//! whose meter-credit benefit Polar grants. So no balance is debited here, and the race "a gift
//! larger than the balance" does not exist; the money-like risks are a second fulfillment (a
//! second grant), a fulfillment for an unpaid or changed order, and a paid gift never delivered.
//!
//! The steps, each persisted on the gift document (`creditgifts`) **before** the Polar call it
//! guards:
//!
//! 1. *Reservation* (route): the gift's identity is `_id = sha256(buyerId + ":" +
//!    lower(requestId))`, chosen by the client per purchase intent and inserted with every input
//!    (buyer, recipient and its channel, product, fulfillment product, benefit, credits, price)
//!    by an upsert with `$setOnInsert`. A repeat of the request finds the same document; a
//!    different recipient or pack for the same request id is refused.
//! 2. *Purchase checkout* (route): `purchaseCreateStartedAt` is claimed by compare-and-set
//!    before `POST /v1/checkouts/` (`Idempotency-Key: gift-purchase:{_id}`), then `checkoutId`,
//!    `checkoutUrl` and `buyerCustomerId` are stored. A lost answer is never a second create: a
//!    caller that lost the claim recovers the checkout by listing the buyer's checkouts.
//! 3. *Payment* (webhook or worker): the order of that checkout is read from Polar, checked
//!    against everything stored (identity, product, customer, price, no discount, no refund,
//!    metadata), and `paidAt`/`paidOrderId` are set once (`paidAt` missing).
//! 4. *Fulfillment checkout* (worker, under the gift's lease): the paid order and the
//!    recipient's Polar customer are checked again, `fulfillmentCreateStartedAt` is stored, then
//!    `POST /v1/checkouts/` (`Idempotency-Key: gift-fulfillment:{_id}`); later attempts only ever
//!    recover that checkout (never a second create), and a creation that cannot be recovered
//!    stops at `needs_support`.
//! 5. *Confirmation* (worker): only the persisted, zero-cost fulfillment checkout is confirmed,
//!    and only while Polar shows it `open`.
//! 6. *Delivery* (worker): the fulfillment order is checked, `fulfillmentOrderId` stored, the
//!    recipient's grant looked up by that order; once Polar shows it granted, the recipient's
//!    credits are read again from Polar and `deliveredAt`/`grantId` are set.
//! 7. *Announcement* (worker): one chat message in the recipient's channel, at most five
//!    attempts.
//!
//! What a kill leaves at each step is in `tests/gifts.rs` (`kill_*`): never a second checkout or
//! grant; at worst a gift that waits for support (`needs_support`).
//!
//! # Differences from the reference
//!
//! - Every Polar call keeps the reference's path, query, body and idempotency key; its error
//!   messages are the reference's except for an answer that is not JSON
//!   ([`provider::provider_message`]).
//! - A lease-holding stage runs under [`GiftConfig::stage_deadline`] (the reference's 90 s
//!   watchdog killed the process) and is dropped there; its lease then expires as before.
//! - A product whose `name` is truthy but not text, or whose `prices`/`benefits` are not
//!   arrays, is refused with the reference's messages for an invalid pack (it threw a
//!   `TypeError`).

pub mod checks;
pub mod provider;
pub mod requests;
pub mod worker;

pub use checks::{require_checkout, validate_gift_order};
pub use provider::{GiftOffer, GiftPair, GiftValue, gift_pack_catalog};
pub use requests::{
    CheckoutRequest, CheckoutResponse, GiftRecipient, accept_credit_gift_paid_order,
    apply_credit_gift_domain_event, create_credit_gift_checkout, find_gift_recipient,
    get_credit_gift, search_gift_recipients,
};
pub use worker::{ChatSend, CreditRefresh, GiftEffects, StageEnd, process_credit_gift};

use crate::Observer;
use crate::mongo_ops::MongoOpError;
use crate::polar::PolarClient;
use bson::oid::ObjectId;
use dima_core::{Clock, Random};
use dima_model::credit_gifts::CreditGift;
use dima_store::mongo::MongoStore;
use serde_json::Value;
use std::time::Duration;

/// `LEASE_MS`.
pub const LEASE: Duration = Duration::from_secs(120);
/// The worker's watchdog (`setTimeout(() => process.exit(1), 90_000)`).
pub const STAGE_DEADLINE: Duration = Duration::from_secs(90);
/// The pause between worker steps (`credit_gifts.worker.ts`: 1 s), for the cron package.
pub const WORKER_PAUSE: Duration = Duration::from_secs(1);
/// `'https://domdimabot.com'`: the redirect fallback when nothing is configured.
pub const DEFAULT_REDIRECT: &str = "https://domdimabot.com";
/// `'domdimabot.com,www.domdimabot.com'`: the gift flow's hosts when none are configured.
pub const DEFAULT_ALLOWED_HOSTS: &str = "domdimabot.com,www.domdimabot.com";

/// What the gift flows read from the environment (filled by the binary).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GiftConfig {
    /// `BILLING_SUCCESS_URL`.
    pub success_url: Option<String>,
    /// `BILLING_RETURN_URL`.
    pub return_url: Option<String>,
    /// `BILLING_ALLOWED_REDIRECT_HOSTS` (unset or empty: [`DEFAULT_ALLOWED_HOSTS`]; unlike the
    /// plan checkout, the gift flow always restricts hosts).
    pub allowed_hosts: Option<String>,
    /// The worker's lease ([`LEASE`]).
    pub lease: Duration,
    /// The deadline of one worker stage ([`STAGE_DEADLINE`]); shorter than the lease.
    pub stage_deadline: Duration,
}

impl Default for GiftConfig {
    fn default() -> Self {
        Self {
            success_url: None,
            return_url: None,
            allowed_hosts: None,
            lease: LEASE,
            stage_deadline: STAGE_DEADLINE,
        }
    }
}

impl GiftConfig {
    /// The gift settings of the billing configuration.
    pub fn from_redirects(redirects: &crate::config::RedirectConfig) -> Self {
        Self {
            success_url: redirects.success_url.clone(),
            return_url: redirects.return_url.clone(),
            allowed_hosts: redirects.allowed_hosts.clone(),
            ..Self::default()
        }
    }
}

/// The stores and clients of the gift flows.
#[derive(Clone, Copy)]
pub struct Gifts<'a> {
    /// MongoDB (`creditgifts`, `users`).
    pub mongo: &'a MongoStore,
    /// Polar.
    pub polar: &'a PolarClient,
    /// Time.
    pub clock: &'a dyn Clock,
    /// Lease tokens.
    pub random: &'a dyn Random,
    /// Failures the flows log and survive.
    pub observer: &'a dyn Observer,
    /// Settings.
    pub config: &'a GiftConfig,
    /// Where a test stops a step as if the process had died ([`Interrupt`]); `None` in
    /// production.
    pub interrupt: Option<&'a dyn Interrupt>,
}

impl std::fmt::Debug for Gifts<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Gifts")
    }
}

/// **Test seam.** Called at each named point of a gift step (after each durable write, before
/// and after each Polar request); `true` stops the step there as if the process had been killed:
/// nothing after it runs, not even the failure bookkeeping or the lease release. Production
/// passes no interrupt.
pub trait Interrupt: Send + Sync {
    /// Whether to stop at `point`.
    fn at(&self, point: &'static str) -> bool;
}

/// Why a gift call failed.
#[derive(Debug, thiserror::Error)]
pub enum GiftError {
    /// `CreditGiftRequestError`: answered to the client with its status and message.
    #[error("{message}")]
    Request {
        /// The message.
        message: String,
        /// The HTTP status.
        status: u16,
    },
    /// A Polar call failed (`GiftProviderError` and its siblings): the route answers its
    /// generic 502; the worker records the message.
    #[error("{message}")]
    Provider {
        /// The reference's message.
        message: String,
        /// Polar may have applied a write whose answer was lost.
        outcome_unknown: bool,
    },
    /// Any other failure (`throw new Error(...)` with the reference's message).
    #[error("{0}")]
    Failed(String),
    /// MongoDB failed.
    #[error(transparent)]
    Mongo(#[from] MongoOpError),
    /// A test interrupt stopped the step ([`Interrupt`]).
    #[error("interrupted at {0}")]
    Interrupted(&'static str),
}

impl GiftError {
    pub(crate) fn request(message: &str, status: u16) -> Self {
        Self::Request {
            message: message.to_owned(),
            status,
        }
    }

    /// The text the reference stored as `lastError` and logged.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
pub fn is_uuid_v4(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => *b == b'-',
        14 => *b == b'4',
        19 => matches!(b.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => b.is_ascii_hexdigit(),
    })
}

/// `Types.ObjectId.isValid(text)` for a string (bson 6: 24 hex digits).
pub fn is_object_id(text: &str) -> bool {
    text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A gift as the flows read it (the stored document, private values exposed inside the crate
/// only; `Debug` prints the id and status).
#[derive(Clone, PartialEq)]
pub struct Gift {
    /// `_id`.
    pub id: String,
    /// `buyerId`.
    pub buyer_id: ObjectId,
    /// `recipientId`.
    pub recipient_id: ObjectId,
    /// `buyerLogin`.
    pub buyer_login: String,
    /// `recipientLogin`.
    pub recipient_login: String,
    /// `recipientName`.
    pub recipient_name: String,
    /// `recipientChannelId`.
    pub recipient_channel_id: String,
    /// `productId`.
    pub product_id: String,
    /// `fulfillmentProductId`.
    pub fulfillment_product_id: String,
    /// `benefitId`.
    pub benefit_id: String,
    /// `credits`.
    pub credits: f64,
    /// `priceAmount`.
    pub price_amount: f64,
    /// `priceCurrency`.
    pub price_currency: String,
    /// `status`.
    pub status: String,
    /// `purchaseCreateStartedAt`.
    pub purchase_create_started_at: Option<i64>,
    /// `checkoutId`.
    pub checkout_id: Option<String>,
    /// `checkoutUrl` (when selected).
    pub checkout_url: Option<String>,
    /// `paidOrderId`.
    pub paid_order_id: Option<String>,
    /// `buyerCustomerId`.
    pub buyer_customer_id: Option<String>,
    /// `paidAt`.
    pub paid_at: Option<i64>,
    /// `fulfillmentCreateStartedAt`.
    pub fulfillment_create_started_at: Option<i64>,
    /// `fulfillmentCheckoutId`.
    pub fulfillment_checkout_id: Option<String>,
    /// `fulfillmentOrderId`.
    pub fulfillment_order_id: Option<String>,
    /// `recipientCustomerId`.
    pub recipient_customer_id: Option<String>,
    /// `grantId`.
    pub grant_id: Option<String>,
    /// `deliveredAt`.
    pub delivered_at: Option<i64>,
    /// `announcedAt`.
    pub announced_at: Option<i64>,
    /// `announcementStoppedAt`.
    pub announcement_stopped_at: Option<i64>,
    /// `announcementAttempts`.
    pub announcement_attempts: f64,
    /// `attempts`.
    pub attempts: f64,
}

impl std::fmt::Debug for Gift {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gift")
            .field("id", &self.id)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl Gift {
    /// The stored document.
    pub fn of(stored: CreditGift) -> Self {
        let text = |value: Option<dima_model::Private<String>>| value.map(|v| v.into_inner());
        Self {
            id: stored.id,
            buyer_id: stored.buyer_id,
            recipient_id: stored.recipient_id,
            buyer_login: stored.buyer_login,
            recipient_login: stored.recipient_login,
            recipient_name: stored.recipient_name,
            recipient_channel_id: stored.recipient_channel_id,
            product_id: stored.product_id,
            fulfillment_product_id: stored.fulfillment_product_id,
            benefit_id: stored.benefit_id,
            credits: stored.credits.0,
            price_amount: stored.price_amount.0,
            price_currency: stored.price_currency,
            status: stored.status.as_str().to_owned(),
            purchase_create_started_at: stored.purchase_create_started_at.map(|d| d.0),
            checkout_id: stored.checkout_id,
            checkout_url: text(stored.checkout_url),
            paid_order_id: stored.paid_order_id,
            buyer_customer_id: text(stored.buyer_customer_id),
            paid_at: stored.paid_at.map(|d| d.0),
            fulfillment_create_started_at: stored.fulfillment_create_started_at.map(|d| d.0),
            fulfillment_checkout_id: stored.fulfillment_checkout_id,
            fulfillment_order_id: stored.fulfillment_order_id,
            recipient_customer_id: text(stored.recipient_customer_id),
            grant_id: stored.grant_id,
            delivered_at: stored.delivered_at.map(|d| d.0),
            announced_at: stored.announced_at.map(|d| d.0),
            announcement_stopped_at: stored.announcement_stopped_at.map(|d| d.0),
            announcement_attempts: stored.announcement_attempts.0,
            attempts: stored.attempts.0,
        }
    }

    /// Decodes a stored document.
    pub fn decode(document: &bson::Document) -> Result<Self, GiftError> {
        Ok(Self::of(
            dima_model::decode_document::<CreditGift>(document).map_err(MongoOpError::from)?,
        ))
    }

    /// `giftView(gift)`: `{id, status, recipient: {id, login, displayName}, credits, paidAt,
    /// deliveredAt}` (dates as ISO text or `null`).
    pub fn view(&self) -> Value {
        let iso = |ms: Option<i64>| {
            ms.and_then(dima_text::to_iso_string)
                .map_or(Value::Null, Value::String)
        };
        serde_json::json!({
            "id": self.id,
            "status": self.status,
            "recipient": {
                "id": self.recipient_id.to_hex(),
                "login": self.recipient_login,
                "displayName": self.recipient_name,
            },
            "credits": crate::js::json_number(self.credits),
            "paidAt": iso(self.paid_at),
            "deliveredAt": iso(self.delivered_at),
        })
    }
}

/// `twitchAccount(user)`: the first Twitch account with an id and a name (truthy both).
pub(crate) fn twitch_account(user: &dima_model::users::User) -> Option<(&str, &str)> {
    user.accounts.iter().find_map(|account| {
        let twitch = account
            .kind
            .known()
            .is_some_and(|k| k == dima_model::users::AccountType::Twitch);
        let id = account.id.as_deref().filter(|id| !id.is_empty())?;
        let name = account.name.as_deref().filter(|name| !name.is_empty())?;
        twitch.then_some((id, name))
    })
}
