//! `processCreditGift()` (`utils/credit_gifts.ts`): one bounded stage of one gift per call,
//! under the gift's lease. The cron package calls [`process_credit_gift`] in a loop with
//! [`super::WORKER_PAUSE`] between calls (`workers/credit_gifts.worker.ts`).
//!
//! The lease is the reference's: a claim sets `leaseToken` (a random UUID) and `leaseUntil`
//! (`now + 120 s`) on the gift whose `nextAttemptAt` is due, oldest first; every later write
//! is fenced by both (`leaseUntil > now`), and the stage ends by setting `nextAttemptAt` and
//! removing the lease. A stage runs under [`super::GiftConfig::stage_deadline`] (90 s, the
//! reference's watchdog): past it the stage is dropped and its lease left to expire, as the
//! reference's process exit left it.
//!
//! Pauses (the reference's): 5 s after a stage, 30 s while a checkout is unpaid, 60 s while a
//! checkout creation is unconfirmed, and after a failure `min(30 min, 15 s * 2^min(attempts -
//! 1, 7))`. A gift stays in rotation after `needs_support` (five failures), as in the
//! reference; the label is for support.

use super::checks::{FULFILLMENT_SOURCE, Owner, require_checkout, validate_gift_order};
use super::provider::{
    GiftValue, gift_checkout_order, gift_credit_grant, load_gift_pair, provider_error,
    recover_gift_checkout,
};
use super::requests::{interrupt, owner_of, verify_gift_customer};
use super::{Gift, GiftError, Gifts, twitch_account};
use crate::js::str_at;
use crate::mongo_ops::{self, journaled};
use bson::{Document, doc};
use dima_model::credit_gifts::{COLLECTION as GIFTS, INFO as GIFT_INFO};
use dima_model::users::{COLLECTION as USERS, INFO as USER_INFO, User};
use dima_store::mongo::date::date;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::{Returned, UpdateOptions};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

/// What `sendTwitchChatMessage` answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChatSend {
    /// Sent (`data.message_id`).
    Sent {
        /// The message id.
        message_id: Option<String>,
    },
    /// `{error, type: 'held_for_moderation'}`: announcing stops.
    HeldForModeration,
    /// Any other error: retried.
    Failed,
}

/// The chat side of a gift (the cron package wires it to Twitch).
pub trait GiftEffects: Send + Sync {
    /// `sendTwitchChatMessage(channelId, message)`.
    fn send_chat<'a>(&'a self, channel_id: &'a str, message: &'a str) -> BoxFuture<'a, ChatSend>;
}

/// The recipient's credits read again after delivery (`refreshRecipientCredits` after its
/// customer mapping: the cached balance dropped and `getAiCredits(user, channel,
/// {requireVerified: true})`). The actual meter is read, debt included; no local balance is
/// ever made up.
pub trait CreditRefresh: Send + Sync {
    /// Reads the balance again. An error fails the stage (it is retried).
    fn refresh<'a>(
        &'a self,
        recipient: &'a User,
        channel_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// [`CreditRefresh`] on the credit cache: drops `twitch:{id}:ai:credits` and reads the balance
/// from Polar again (the reference's `getAiCredits` never fails on a Polar error: it answers a
/// fallback; neither does this).
pub struct CacheRefresh<'a> {
    /// Dragonfly (the cached balance).
    pub dragonfly: &'a dima_store::dragonfly::Dragonfly,
    /// The credit cache.
    pub cache: &'a crate::plans::credits_cache::CreditsCache,
    /// The current plan of a user.
    pub plans: &'a dyn crate::plans::credits_cache::PlanLookup,
    /// Polar's customer state.
    pub polar: &'a dyn crate::plans::credits_cache::CustomerStateSource,
}

impl CreditRefresh for CacheRefresh<'_> {
    fn refresh<'a>(
        &'a self,
        recipient: &'a User,
        channel_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let key = dima_store::dragonfly::plan_cache_fence::credits_cache_key(channel_id);
            self.dragonfly
                .del(&[&key])
                .await
                .map_err(|e| e.to_string())?;
            let owner = crate::plans::credits_cache::PlanOwner::of(recipient);
            self.cache
                .get_ai_credits(
                    &owner,
                    channel_id,
                    crate::plans::credits_cache::CreditOptions {
                        require_verified: true,
                    },
                    self.plans,
                    self.polar,
                )
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }
}

/// `giftAnnouncement(gift, language)`.
pub fn gift_announcement(gift: &Gift, spanish: bool) -> String {
    let login = |value: &str| -> String {
        value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(25)
            .collect()
    };
    let locale = if spanish {
        dima_text::NumberLocale::EsEs
    } else {
        dima_text::NumberLocale::EnUs
    };
    let credits = dima_text::to_locale_string(gift.credits, locale);
    let (buyer, recipient) = (login(&gift.buyer_login), login(&gift.recipient_login));
    if spanish {
        format!(
            "🎁 @{buyer} regaló {credits} créditos permanentes de IA a @{recipient}. ¡Ya están disponibles! ¡Gracias!"
        )
    } else {
        format!(
            "🎁 @{buyer} gifted {credits} permanent AI credits to @{recipient}. The credits are ready to use. Thank you!"
        )
    }
}

/// What one call did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageEnd {
    /// No gift was due (`false`).
    Idle,
    /// A gift was processed (`true`), whatever the outcome.
    Processed,
}

/// The leased gift and its stage.
struct Stage<'g, 'a> {
    gifts: &'g Gifts<'a>,
    gift: Gift,
    token: String,
    delay_ms: i64,
}

impl Stage<'_, '_> {
    fn fence(&self) -> Document {
        doc! {
            "_id": &self.gift.id,
            "leaseToken": &self.token,
            "leaseUntil": { "$gt": date(self.gifts.clock.now_ms()) },
        }
    }

    fn stop(&self, point: &'static str) -> Result<(), GiftError> {
        interrupt(self.gifts, point)
    }

    /// `update(values)`: a fenced `$set`; the lease lost is an error.
    async fn update(&mut self, set: Document) -> Result<(), GiftError> {
        let outcome = mongo_ops::update_one(
            self.gifts.mongo,
            &GIFT_INFO,
            &self.fence(),
            doc! { "$set": set.clone() },
            UpdateOptions::default(),
            Some(journaled()),
            self.gifts.clock.now_ms(),
        )
        .await?;
        if outcome.matched == 0 {
            return Err(GiftError::Failed("Gift processing lease lost".into()));
        }
        self.apply(&set);
        Ok(())
    }

    /// `Object.assign(gift, values)`.
    fn apply(&mut self, set: &Document) {
        let gift = &mut self.gift;
        for (key, value) in set {
            let text = value.as_str().map(str::to_owned);
            let time = value.as_datetime().map(|d| d.timestamp_millis());
            let number = dima_store::mongo::number::read_number(value);
            match key.as_str() {
                "checkoutId" => gift.checkout_id = text,
                "buyerCustomerId" => gift.buyer_customer_id = text,
                "paidOrderId" => gift.paid_order_id = text,
                "paidAt" => gift.paid_at = time,
                "status" => gift.status = text.unwrap_or_default(),
                "fulfillmentCreateStartedAt" => gift.fulfillment_create_started_at = time,
                "fulfillmentCheckoutId" => gift.fulfillment_checkout_id = text,
                "recipientCustomerId" => gift.recipient_customer_id = text,
                "fulfillmentOrderId" => gift.fulfillment_order_id = text,
                "grantId" => gift.grant_id = text,
                "deliveredAt" => gift.delivered_at = time,
                "announcedAt" => gift.announced_at = time,
                "announcementStoppedAt" => gift.announcement_stopped_at = time,
                "announcementAttempts" => gift.announcement_attempts = number.unwrap_or(0.0),
                "attempts" => gift.attempts = number.unwrap_or(0.0),
                _ => {}
            }
        }
    }

    /// `alive()`: the lease is still held.
    async fn alive(&self) -> Result<(), GiftError> {
        if mongo_ops::exists(self.gifts.mongo, GIFTS, self.fence()).await? {
            Ok(())
        } else {
            Err(GiftError::Failed("Gift processing lease lost".into()))
        }
    }

    async fn user(&self, id: bson::oid::ObjectId) -> Result<Option<User>, GiftError> {
        mongo_ops::find_one(self.gifts.mongo, USERS, doc! { "_id": id }, None)
            .await?
            .map(|d| {
                dima_model::decode_document::<User>(&d)
                    .map_err(|e| GiftError::Mongo(mongo_ops::MongoOpError::from(e)))
            })
            .transpose()
    }

    async fn buyer(&self) -> Result<User, GiftError> {
        self.user(self.gift.buyer_id)
            .await?
            .ok_or_else(|| GiftError::Failed("Gift buyer no longer exists".into()))
    }

    async fn paid_order(&self) -> Result<Value, GiftError> {
        let id = self.gift.paid_order_id.clone().unwrap_or_default();
        self.gifts
            .polar
            .get_order(&id)
            .await
            .map_err(|e| provider_error(&e))
    }

    /// The body of the stage (`try { ... }`).
    async fn run(
        &mut self,
        effects: &dyn GiftEffects,
        credits: &dyn CreditRefresh,
    ) -> Result<(), GiftError> {
        let recipient = self.user(self.gift.recipient_id).await?;
        let recipient = match recipient {
            Some(user)
                if twitch_account(&user).map(|(id, _)| id)
                    == Some(self.gift.recipient_channel_id.as_str()) =>
            {
                user
            }
            _ => {
                return Err(GiftError::Failed(
                    "Gift recipient account changed or disappeared".into(),
                ));
            }
        };
        let (recipient_id, recipient_customer) = owner_of(&recipient);
        let recipient_owner = Owner {
            user_id: &recipient_id,
            customer_id: recipient_customer.as_deref(),
        };
        if self.gift.delivered_at.is_some() {
            return self.announce(effects, &recipient).await;
        }
        if self.gift.paid_at.is_none() {
            return self.reconcile_payment().await;
        }
        if self.gift.fulfillment_checkout_id.is_none() {
            return self.create_fulfillment(&recipient, recipient_owner).await;
        }
        self.deliver(&recipient, recipient_owner, credits).await
    }

    /// A delivered gift: the chat announcement (no online gate: Helix chat works offline).
    async fn announce(
        &mut self,
        effects: &dyn GiftEffects,
        recipient: &User,
    ) -> Result<(), GiftError> {
        if self.gift.announced_at.is_some() || self.gift.announcement_stopped_at.is_some() {
            return Ok(());
        }
        self.alive().await?;
        let attempts = self.gift.announcement_attempts + 1.0;
        self.update(doc! { "announcementAttempts": js_number(attempts) })
            .await?;
        let spanish = recipient
            .language
            .as_ref()
            .is_some_and(|language| language.as_str() == "es");
        let message = gift_announcement(&self.gift, spanish);
        let result = effects
            .send_chat(&self.gift.recipient_channel_id, &message)
            .await;
        self.stop("announce:sent")?;
        match result {
            ChatSend::HeldForModeration => {
                self.update(doc! {
                    "announcementStoppedAt": date(self.gifts.clock.now_ms()),
                    "lastError": "Gift announcement held for moderation",
                })
                .await
            }
            ChatSend::Failed => Err(GiftError::Failed("Gift chat announcement failed".into())),
            ChatSend::Sent { message_id } => {
                let mut set = doc! { "announcedAt": date(self.gifts.clock.now_ms()) };
                if let Some(id) = message_id {
                    set.insert("announcementMessageId", id);
                }
                set.insert("lastError", "");
                self.update(set).await
            }
        }
    }

    /// Not paid yet: the buyer's checkout and its order, reconciled from Polar.
    async fn reconcile_payment(&mut self) -> Result<(), GiftError> {
        let buyer = self.buyer().await?;
        let (buyer_id, buyer_customer) = owner_of(&buyer);
        let owner = Owner {
            user_id: &buyer_id,
            customer_id: buyer_customer.as_deref(),
        };
        if self.gift.checkout_id.is_none() {
            if self.gift.purchase_create_started_at.is_none() {
                self.delay_ms = 60_000;
                return Ok(());
            }
            let recovered = recover_gift_checkout(
                self.gifts.polar,
                &self.gift.id,
                &self.gift.product_id,
                &self.gift.buyer_id.to_hex(),
            )
            .await?;
            let Some(recovered) = recovered else {
                self.delay_ms = 60_000;
                return Ok(());
            };
            require_checkout(&recovered.0, &self.gift, owner, false)?;
            let mut set = Document::new();
            if let Some(id) = recovered.text("id") {
                set.insert("checkoutId", id);
            }
            if let Some(customer) = recovered.text("customer_id").filter(|c| !c.is_empty()) {
                set.insert("buyerCustomerId", customer);
            }
            self.update(set).await?;
        }
        let checkout_id = self.gift.checkout_id.clone().unwrap_or_default();
        let order = gift_checkout_order(self.gifts.polar, &checkout_id).await?;
        let Some(order) = order.filter(|o| crate::js::truthy(o.get("paid"))) else {
            self.delay_ms = 30_000;
            return Ok(());
        };
        let checkout = self
            .gifts
            .polar
            .get_checkout(&checkout_id)
            .await
            .map_err(|e| provider_error(&e))?;
        require_checkout(&checkout, &self.gift, owner, false)?;
        let mut checked = self.gift.clone();
        checked.buyer_customer_id = str_at(&checkout, "customer_id")
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        validate_gift_order(&order.0, &checked, owner, false)?;
        let mut set = Document::new();
        if let Some(id) = order.text("id") {
            set.insert("paidOrderId", id);
        }
        if let Some(customer) = order.text("customer_id") {
            set.insert("buyerCustomerId", customer);
        }
        set.insert("paidAt", date(self.gifts.clock.now_ms()));
        set.insert("status", "payment_received");
        set.insert("lastError", "");
        self.update(set).await
    }

    /// Paid: the free fulfillment checkout, created once.
    async fn create_fulfillment(
        &mut self,
        recipient: &User,
        recipient_owner: Owner<'_>,
    ) -> Result<(), GiftError> {
        let pair = load_gift_pair(self.gifts.polar, &self.gift.product_id).await?;
        if pair.fulfillment_product_id != self.gift.fulfillment_product_id
            || pair.benefit_id != self.gift.benefit_id
            || pair.offer.credits != self.gift.credits
            || pair.offer.price_amount != self.gift.price_amount
            || pair.offer.price_currency != self.gift.price_currency
        {
            return Err(GiftError::Failed(
                "Gift pack configuration changed after purchase".into(),
            ));
        }
        let checkout = if self.gift.fulfillment_create_started_at.is_some() {
            // An earlier attempt reserved the creation: recover it, never create a second one.
            recover_gift_checkout(
                self.gifts.polar,
                &self.gift.id,
                &self.gift.fulfillment_product_id,
                &self.gift.recipient_id.to_hex(),
            )
            .await?
            .ok_or_else(|| {
                GiftError::Failed(
                    "Gift fulfillment checkout creation is uncertain; reconciliation required"
                        .into(),
                )
            })?
        } else {
            // Recheck payment before the first benefit-bearing checkout is created.
            let buyer = self.buyer().await?;
            let paid = self.paid_order().await?;
            let (buyer_id, buyer_customer) = owner_of(&buyer);
            let buyer_owner = Owner {
                user_id: &buyer_id,
                customer_id: buyer_customer.as_deref(),
            };
            validate_gift_order(&paid, &self.gift, buyer_owner, false)?;
            verify_gift_customer(self.gifts, recipient).await?;
            self.update(doc! {
                "fulfillmentCreateStartedAt": date(self.gifts.clock.now_ms()),
                "status": "delivering",
            })
            .await?;
            self.stop("fulfillment:reserved")?;
            self.alive().await?;
            let mut body = Map::new();
            body.insert(
                "products".into(),
                Value::Array(vec![Value::from(self.gift.fulfillment_product_id.as_str())]),
            );
            body.extend(fulfillment_customer(recipient)?);
            body.insert("allow_discount_codes".into(), Value::Bool(false));
            let mut metadata = Map::new();
            metadata.insert("source".into(), Value::from(FULFILLMENT_SOURCE));
            metadata.insert("gift_id".into(), Value::from(self.gift.id.as_str()));
            if let Some(parent) = &self.gift.paid_order_id {
                metadata.insert("parent_order_id".into(), Value::from(parent.as_str()));
            }
            metadata.insert("credits".into(), crate::js::json_number(self.gift.credits));
            metadata.insert("rollover".into(), Value::Bool(true));
            body.insert("metadata".into(), Value::Object(metadata));
            let created = self
                .gifts
                .polar
                .create_gift_checkout(
                    &Value::Object(body),
                    &format!("gift-fulfillment:{}", self.gift.id),
                )
                .await;
            self.stop("fulfillment:answered")?;
            GiftValue(created.map_err(|e| provider_error(&e))?)
        };
        require_checkout(&checkout.0, &self.gift, recipient_owner, true)?;
        let mut set = Document::new();
        if let Some(id) = checkout.text("id") {
            set.insert("fulfillmentCheckoutId", id);
        }
        if let Some(customer) = checkout.text("customer_id").filter(|c| !c.is_empty()) {
            set.insert("recipientCustomerId", customer);
        }
        set.insert("status", "delivering");
        set.insert("lastError", "");
        self.update(set).await
    }

    /// The fulfillment checkout exists: confirm it while open, then deliver once granted.
    async fn deliver(
        &mut self,
        recipient: &User,
        recipient_owner: Owner<'_>,
        credits: &dyn CreditRefresh,
    ) -> Result<(), GiftError> {
        let fulfillment = self
            .gift
            .fulfillment_checkout_id
            .clone()
            .unwrap_or_default();
        let checkout = self
            .gifts
            .polar
            .get_checkout(&fulfillment)
            .await
            .map_err(|e| provider_error(&e))?;
        require_checkout(&checkout, &self.gift, recipient_owner, true)?;
        match str_at(&checkout, "status") {
            Some("open") => {
                // Confirm only a known, persisted, zero-cost checkout. Never a replacement.
                let buyer = self.buyer().await?;
                let paid = self.paid_order().await?;
                let (buyer_id, buyer_customer) = owner_of(&buyer);
                let buyer_owner = Owner {
                    user_id: &buyer_id,
                    customer_id: buyer_customer.as_deref(),
                };
                validate_gift_order(&paid, &self.gift, buyer_owner, false)?;
                self.alive().await?;
                let Some(secret) = str_at(&checkout, "client_secret").filter(|s| !s.is_empty())
                else {
                    return Err(GiftError::Failed(
                        "Gift fulfillment checkout secret missing".into(),
                    ));
                };
                self.stop("confirm:sending")?;
                let confirmed = self.gifts.polar.confirm_checkout(secret).await;
                self.stop("confirm:answered")?;
                confirmed.map_err(|e| provider_error(&e))?;
                return Ok(());
            }
            Some("failed" | "expired") => {
                return Err(GiftError::Failed(
                    "Gift fulfillment checkout failed or expired".into(),
                ));
            }
            _ => {}
        }
        let order = gift_checkout_order(self.gifts.polar, &fulfillment).await?;
        let Some(order) = order.filter(|o| crate::js::truthy(o.get("paid"))) else {
            return Ok(());
        };
        // The customer id may only become available after the confirmation.
        if self.gift.recipient_customer_id.is_none()
            && let Some(customer) = str_at(&checkout, "customer_id").filter(|c| !c.is_empty())
        {
            self.update(doc! { "recipientCustomerId": customer })
                .await?;
        }
        validate_gift_order(&order.0, &self.gift, recipient_owner, true)?;
        let order_id = order.text("id").unwrap_or_default().to_owned();
        self.update(doc! { "fulfillmentOrderId": &order_id })
            .await?;
        let customer = order.text("customer_id").unwrap_or_default().to_owned();
        let grant = gift_credit_grant(
            self.gifts.polar,
            &order_id,
            &customer,
            &self.gift.benefit_id,
            self.gift.credits,
        )
        .await?;
        let Some(grant) = grant else {
            return Ok(());
        };
        self.refresh_recipient_credits(recipient, credits).await?;
        self.stop("deliver:refreshed")?;
        let mut set = Document::new();
        if let Some(id) = grant.text("id") {
            set.insert("grantId", id);
        }
        set.insert("deliveredAt", date(self.gifts.clock.now_ms()));
        set.insert("status", "delivered");
        set.insert("lastError", "");
        self.update(set).await
    }

    /// `refreshRecipientCredits(gift)`: link the recipient to the customer the credits went to
    /// (only from no customer or the same one), then read the actual balance again.
    async fn refresh_recipient_credits(
        &self,
        recipient: &User,
        credits: &dyn CreditRefresh,
    ) -> Result<(), GiftError> {
        let Some(customer) = self.gift.recipient_customer_id.clone() else {
            return Err(GiftError::Failed(
                "Gift recipient customer mapping changed".into(),
            ));
        };
        let filter = doc! {
            "_id": self.gift.recipient_id,
            "$or": [
                { "polar_sh_customer_id": bson::Bson::Null },
                { "polar_sh_customer_id": "" },
                { "polar_sh_customer_id": &customer },
            ],
        };
        let outcome = mongo_ops::update_one(
            self.gifts.mongo,
            &USER_INFO,
            &filter,
            doc! { "$set": { "polar_sh_customer_id": &customer } },
            UpdateOptions::default(),
            Some(journaled()),
            self.gifts.clock.now_ms(),
        )
        .await?;
        if outcome.matched == 0 {
            return Err(GiftError::Failed(
                "Gift recipient customer mapping changed".into(),
            ));
        }
        let Some(user) = self.user(self.gift.recipient_id).await? else {
            return Err(GiftError::Failed(
                "Gift recipient account disappeared".into(),
            ));
        };
        let _ = recipient;
        credits
            .refresh(&user, &self.gift.recipient_channel_id)
            .await
            .map_err(GiftError::Failed)
    }

    /// The `catch`: count the failure, back off, mark support or stop announcing.
    async fn record_failure(&mut self, error: &GiftError) -> Result<(), GiftError> {
        let message = error.message();
        self.gifts.observer.error(
            "processCreditGift",
            &format!(
                "Credit gift processing failed ({}): {message}",
                self.gift.status
            ),
        );
        let attempts = self.gift.attempts + 1.0;
        let exponent = crate::js::min(attempts - 1.0, 7.0);
        self.delay_ms = backoff_ms(exponent);
        let now = self.gifts.clock.now_ms();
        let mut set = doc! { "attempts": js_number(attempts), "lastError": message };
        if self.gift.delivered_at.is_some() {
            if self.gift.announcement_attempts >= 5.0 {
                set.insert("announcementStoppedAt", date(now));
            }
        } else if attempts >= 5.0 {
            set.insert("status", "needs_support");
        }
        self.update(set).await
    }

    /// The `finally`: next attempt and lease released, fenced.
    async fn release(&self) -> Result<(), GiftError> {
        let now = self.gifts.clock.now_ms();
        mongo_ops::update_one(
            self.gifts.mongo,
            &GIFT_INFO,
            &self.fence(),
            doc! {
                "$set": { "nextAttemptAt": date(now + self.delay_ms) },
                "$unset": { "leaseToken": "", "leaseUntil": "" },
            },
            UpdateOptions::default(),
            Some(journaled()),
            now,
        )
        .await?;
        Ok(())
    }
}

/// `Math.min(30 * 60_000, 15_000 * 2 ** exponent)`.
fn backoff_ms(exponent: f64) -> i64 {
    let delay = crate::js::min(30.0 * 60_000.0, 15_000.0 * 2f64.powf(exponent));
    #[allow(clippy::cast_possible_truncation)]
    let delay = delay as i64;
    delay
}

/// `customerPayload(recipient)` of the fulfillment checkout.
fn fulfillment_customer(recipient: &User) -> Result<Map<String, Value>, GiftError> {
    let customer = recipient
        .polar_sh_customer_id
        .as_ref()
        .map(|id| id.expose().as_str())
        .filter(|id| super::is_uuid_v4(id));
    let Some(customer) = customer else {
        return Err(GiftError::request(
            "This billing account is not ready. Please sign in again or contact support.",
            409,
        ));
    };
    let mut payload = Map::new();
    payload.insert("customer_id".into(), Value::from(customer));
    payload.insert(
        "external_customer_id".into(),
        Value::from(recipient.id.to_hex()),
    );
    if let Some(email) = &recipient.email {
        payload.insert(
            "customer_email".into(),
            Value::from(email.expose().as_str()),
        );
    }
    if let Some(name) = &recipient.name {
        payload.insert("customer_name".into(), Value::from(name.as_str()));
    }
    Ok(payload)
}

/// `processCreditGift()`: claims the oldest due gift and runs one stage of it.
pub async fn process_credit_gift(
    gifts: &Gifts<'_>,
    effects: &dyn GiftEffects,
    credits: &dyn CreditRefresh,
) -> Result<StageEnd, GiftError> {
    match tokio::time::timeout(
        gifts.config.stage_deadline,
        process_leased(gifts, effects, credits),
    )
    .await
    {
        Ok(result) => result,
        // The stage is dropped here (nothing of it runs on); its lease expires on its own,
        // as the reference's watchdog exit left it.
        Err(_) => Err(GiftError::Failed(
            "Gift processing stage passed its deadline".into(),
        )),
    }
}

async fn process_leased(
    gifts: &Gifts<'_>,
    effects: &dyn GiftEffects,
    credits: &dyn CreditRefresh,
) -> Result<StageEnd, GiftError> {
    let now = gifts.clock.now_ms();
    let token = gifts
        .random
        .uuid_v4()
        .map_err(|e| GiftError::Failed(e.to_string()))?;
    let lease_ms = i64::try_from(gifts.config.lease.as_millis()).unwrap_or(120_000);
    let filter = doc! {
        "nextAttemptAt": { "$lte": date(now) },
        "$and": [
            { "$or": [{ "leaseUntil": { "$exists": false } }, { "leaseUntil": { "$lte": date(now) } }] },
            { "$or": [
                { "status": { "$ne": "delivered" } },
                { "announcedAt": { "$exists": false }, "announcementStoppedAt": { "$exists": false } },
            ] },
        ],
    };
    let claimed = mongo_ops::find_one_and_update(
        gifts.mongo,
        &GIFT_INFO,
        &filter,
        doc! { "$set": { "leaseToken": &token, "leaseUntil": date(now + lease_ms) } },
        UpdateOptions::default(),
        Returned::After,
        Some(doc! { "nextAttemptAt": 1 }),
        Some(journaled()),
        now,
    )
    .await?;
    let Some(claimed) = claimed else {
        return Ok(StageEnd::Idle);
    };
    interrupt(gifts, "claimed")?;
    let mut stage = Stage {
        gifts,
        gift: Gift::decode(&claimed)?,
        token,
        delay_ms: 5_000,
    };
    let outcome = stage.run(effects, credits).await;
    let failure = match outcome {
        Ok(()) => None,
        // A test's "process killed here": nothing else runs.
        Err(GiftError::Interrupted(point)) => return Err(GiftError::Interrupted(point)),
        Err(error) => Some(stage.record_failure(&error).await),
    };
    if let Some(Err(GiftError::Interrupted(point))) = failure {
        return Err(GiftError::Interrupted(point));
    }
    let released = stage.release().await;
    if let Some(Err(error)) = failure {
        return Err(error);
    }
    released?;
    Ok(StageEnd::Processed)
}
