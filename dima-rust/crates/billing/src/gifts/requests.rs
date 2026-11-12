//! The request side of a gift (`utils/credit_gifts.ts`): finding a recipient, the gift view,
//! the purchase checkout, and the paid order from a webhook.

use super::checks::{Owner, PURCHASE_SOURCE, require_checkout, validate_gift_order};
use super::provider::{
    GiftOffer, GiftValue, load_gift_pair, pair_of, provider_error, recover_gift_checkout,
};
use super::{
    DEFAULT_ALLOWED_HOSTS, DEFAULT_REDIRECT, Gift, GiftError, Gifts, is_object_id, is_uuid_v4,
    twitch_account,
};
use crate::js::str_at;
use crate::mongo_ops::{self, journaled};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::Private;
use dima_model::credit_gifts::{COLLECTION as GIFTS, INFO as GIFT_INFO};
use dima_model::users::{COLLECTION as USERS, User};
use dima_store::mongo::date::date;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// `GiftRecipient`: `{id, login, displayName, avatarUrl: null}`. `Debug` prints the id only.
#[derive(Clone, PartialEq, Eq)]
pub struct GiftRecipient {
    /// `users._id`.
    pub id: String,
    /// The Twitch login, lower case.
    pub login: String,
    /// The Twitch name as stored.
    pub display_name: String,
}

impl std::fmt::Debug for GiftRecipient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GiftRecipient")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl GiftRecipient {
    /// The JSON the route sends.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "login": self.login,
            "displayName": self.display_name,
            "avatarUrl": null,
        })
    }
}

/// `recipientView(user)`.
fn recipient_view(user: &User) -> Result<GiftRecipient, GiftError> {
    let Some((_, name)) = twitch_account(user) else {
        return Err(GiftError::request(
            "This account has no Twitch channel",
            404,
        ));
    };
    Ok(GiftRecipient {
        id: user.id.to_hex(),
        // Twitch logins are ASCII; JavaScript's and Rust's lower case agree there.
        login: name.to_lowercase(),
        display_name: name.to_owned(),
    })
}

/// `login.trim().replace(/^@/, '').toLowerCase()`.
fn normalize_login(login: &str) -> String {
    let trimmed = dima_text::trim(login);
    trimmed.strip_prefix('@').unwrap_or(trimmed).to_lowercase()
}

/// `/^[a-z0-9_]{min,25}$/`.
fn is_login(text: &str, min: usize) -> bool {
    (min..=25).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn decode_user(document: &Document) -> Result<User, GiftError> {
    dima_model::decode_document::<User>(document)
        .map_err(|e| GiftError::Mongo(mongo_ops::MongoOpError::from(e)))
}

/// `findGiftRecipient(login)`: the account of an exact Twitch login.
pub async fn find_gift_recipient(
    gifts: &Gifts<'_>,
    login: &str,
) -> Result<GiftRecipient, GiftError> {
    let normalized = normalize_login(login);
    if !is_login(&normalized, 1) {
        return Err(GiftError::request(
            "Enter an exact Twitch channel name",
            400,
        ));
    }
    let filter = doc! { "accounts": { "$elemMatch": {
        "type": "twitch",
        "name": { "$regex": format!("^{normalized}$"), "$options": "i" },
    } } };
    let Some(user) = mongo_ops::find_one(gifts.mongo, USERS, filter, None).await? else {
        return Err(GiftError::request(
            "This channel does not have a bot account",
            404,
        ));
    };
    recipient_view(&decode_user(&user)?)
}

/// `searchGiftRecipients(query, buyer)`: at most 15 accounts whose Twitch login contains the
/// query, the buyer left out.
pub async fn search_gift_recipients(
    gifts: &Gifts<'_>,
    query: &str,
    buyer_id: ObjectId,
) -> Result<Vec<GiftRecipient>, GiftError> {
    let normalized = normalize_login(query);
    if !is_login(&normalized, 3) {
        return Err(GiftError::request(
            "Enter at least 3 characters of a Twitch channel name",
            400,
        ));
    }
    let filter = doc! {
        "_id": { "$ne": buyer_id },
        "accounts": { "$elemMatch": {
            "type": "twitch",
            "id": { "$nin": [Bson::Null, ""] },
            "name": { "$regex": normalized, "$options": "i" },
        } },
    };
    let options = mongodb::options::FindOptions::builder()
        .projection(doc! { "accounts.type": 1, "accounts.id": 1, "accounts.name": 1 })
        .sort(doc! { "accounts.name": 1 })
        .limit(15)
        .build();
    let users = mongo_ops::find(gifts.mongo, USERS, filter, options).await?;
    users
        .iter()
        .map(|user| recipient_view(&decode_user(user)?))
        .collect()
}

/// `getCreditGift(id, user)`: the gift view, for its buyer or its recipient only.
pub async fn get_credit_gift(
    gifts: &Gifts<'_>,
    id: &str,
    user_id: ObjectId,
) -> Result<Value, GiftError> {
    let hex = id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex {
        return Err(GiftError::request("Gift not found", 404));
    }
    let filter = doc! { "_id": id, "$or": [{ "buyerId": user_id }, { "recipientId": user_id }] };
    let projection = doc! { "checkoutUrl": 0 };
    let Some(found) = mongo_ops::find_one(gifts.mongo, GIFTS, filter, Some(projection)).await?
    else {
        return Err(GiftError::request("Gift not found", 404));
    };
    Ok(Gift::decode(&found)?.view())
}

/// The allowed hosts: `(BILLING_ALLOWED_REDIRECT_HOSTS || default).split(',')`, trimmed and
/// lower-cased.
fn allowed_hosts(configured: Option<&str>) -> Vec<String> {
    configured
        .filter(|hosts| !hosts.is_empty())
        .unwrap_or(DEFAULT_ALLOWED_HOSTS)
        .split(',')
        .map(|host| dima_text::trim(host).to_lowercase())
        .collect()
}

/// `redirectUrl(raw, fallback)`: an https URL without credentials on an allowed host.
pub fn redirect_url(
    raw: Option<&str>,
    fallback: Option<&str>,
    hosts: Option<&str>,
) -> Result<url::Url, GiftError> {
    let value = raw
        .filter(|v| !v.is_empty())
        .or(fallback.filter(|v| !v.is_empty()))
        .unwrap_or(DEFAULT_REDIRECT);
    let invalid = || GiftError::request("Invalid return URL", 400);
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    // WHATWG `url.host`: the host name and a port that is not the scheme's default.
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        (None, _) => String::new(),
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !allowed_hosts(hosts).contains(&host.to_lowercase())
    {
        return Err(invalid());
    }
    Ok(url)
}

/// `url.searchParams.set(key, value)`: replaces the first pair of `key` (dropping the others)
/// or appends one; the query is serialised again as `application/x-www-form-urlencoded`.
fn set_search_param(url: &mut url::Url, key: &str, value: &str) {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match pairs.iter().position(|(k, _)| k == key) {
        Some(first) => {
            let mut index = 0;
            pairs.retain(|(k, _)| {
                let keep = k != key || index == first;
                index += 1;
                keep
            });
            if let Some(pair) = pairs.iter_mut().find(|(k, _)| k == key) {
                pair.1 = value.to_owned();
            }
        }
        None => pairs.push((key.to_owned(), value.to_owned())),
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

/// `customerPayload(user)`: the Polar customer of a checkout, refused unless the user's
/// customer id is a UUID. The e-mail and name are left out when the user has none, as
/// `JSON.stringify` leaves out `undefined`.
fn customer_payload(user: &User) -> Result<Map<String, Value>, GiftError> {
    let customer = user
        .polar_sh_customer_id
        .as_ref()
        .map(|id| id.expose().as_str())
        .filter(|id| is_uuid_v4(id));
    let Some(customer) = customer else {
        return Err(GiftError::request(
            "This billing account is not ready. Please sign in again or contact support.",
            409,
        ));
    };
    let mut payload = Map::new();
    payload.insert("customer_id".into(), Value::from(customer));
    payload.insert("external_customer_id".into(), Value::from(user.id.to_hex()));
    if let Some(email) = &user.email {
        payload.insert(
            "customer_email".into(),
            Value::from(email.expose().as_str()),
        );
    }
    if let Some(name) = &user.name {
        payload.insert("customer_name".into(), Value::from(name.as_str()));
    }
    Ok(payload)
}

/// `verifyGiftCustomer(user)`'s request: the customer must be this user's, and not deleted.
async fn verify_customer_answer(gifts: &Gifts<'_>, user: &User) -> Result<(), GiftError> {
    let Some(customer_id) = user.polar_sh_customer_id.as_ref().map(|c| c.expose()) else {
        return Err(GiftError::request(
            "This billing account is not ready. Please sign in again or contact support.",
            409,
        ));
    };
    let customer = gifts
        .polar
        .get_customer(customer_id)
        .await
        .map_err(|e| provider_error(&e))?;
    let external = customer.get("external_id");
    let user_id = user.id.to_hex();
    if str_at(&customer, "id") != Some(customer_id.as_str())
        || crate::js::truthy(customer.get("deleted_at"))
        || (crate::js::truthy(external) && str_at(&customer, "external_id") != Some(&user_id))
    {
        return Err(GiftError::request(
            "This billing account needs support before it can receive or buy gifts.",
            409,
        ));
    }
    Ok(())
}

/// `verifyGiftCustomer(user)`.
pub(crate) async fn verify_gift_customer(gifts: &Gifts<'_>, user: &User) -> Result<(), GiftError> {
    customer_payload(user)?;
    verify_customer_answer(gifts, user).await
}

/// The error `Promise.all([buyer, recipient])` rejects with: a payload refusal (immediate)
/// before a failed read, the buyer's before the recipient's.
fn first_rejection(
    buyer: Result<(), GiftError>,
    recipient: Result<(), GiftError>,
) -> Result<(), GiftError> {
    let immediate = |e: &GiftError| matches!(e, GiftError::Request { status: 409, message } if message.starts_with("This billing account is not ready"));
    match (buyer, recipient) {
        (Err(e), _) if immediate(&e) => Err(e),
        (_, Err(e)) if immediate(&e) => Err(e),
        (Err(e), _) | (_, Err(e)) => Err(e),
        (Ok(()), Ok(())) => Ok(()),
    }
}

/// The owner of a checkout or order: the user and its linked customer.
pub(crate) fn owner_of(user: &User) -> (String, Option<String>) {
    (
        user.id.to_hex(),
        user.polar_sh_customer_id
            .as_ref()
            .map(|id| id.expose().clone()),
    )
}

/// What `createCreditGiftCheckout` takes (the route checked the body's types).
#[derive(Clone, Copy, Debug)]
pub struct CheckoutRequest<'a> {
    /// The signed-in buyer.
    pub user: &'a User,
    /// `productId`.
    pub product_id: &'a str,
    /// `recipientId`.
    pub recipient_id: &'a str,
    /// `requestId`: the client's id for this purchase intent (a UUID).
    pub request_id: &'a str,
    /// `acknowledgeNoRefunds === true`.
    pub acknowledge_no_refunds: bool,
    /// `successUrl`.
    pub success_url: Option<&'a str>,
    /// `returnUrl`.
    pub return_url: Option<&'a str>,
}

/// The answer of `createCreditGiftCheckout`.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckoutResponse {
    /// `giftId`.
    pub gift_id: String,
    /// `checkoutId`.
    pub checkout_id: Option<String>,
    /// `checkoutUrl` (it carries the checkout's secret).
    pub checkout_url: Private<String>,
    /// `offer`.
    pub offer: GiftOffer,
    /// `recipient` (`{id, login, displayName}`).
    pub recipient: GiftRecipient,
}

impl CheckoutResponse {
    /// The JSON the route sends (`data`).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("giftId".into(), Value::from(self.gift_id.as_str()));
        if let Some(id) = &self.checkout_id {
            out.insert("checkoutId".into(), Value::from(id.as_str()));
        }
        out.insert(
            "checkoutUrl".into(),
            Value::from(self.checkout_url.expose().as_str()),
        );
        out.insert("offer".into(), self.offer.to_json());
        out.insert(
            "recipient".into(),
            serde_json::json!({
                "id": self.recipient.id,
                "login": self.recipient.login,
                "displayName": self.recipient.display_name,
            }),
        );
        Value::Object(out)
    }
}

/// `sha256(userId + ":" + requestId.toLowerCase())` as hex: the gift's identity.
pub fn gift_id(user_id: &ObjectId, request_id: &str) -> String {
    let digest = Sha256::digest(format!(
        "{}:{}",
        user_id.to_hex(),
        request_id.to_lowercase()
    ));
    hex::encode(digest)
}

async fn load_gift(gifts: &Gifts<'_>, id: &str) -> Result<Option<Gift>, GiftError> {
    mongo_ops::find_one(gifts.mongo, GIFTS, doc! { "_id": id }, None)
        .await?
        .map(|document| Gift::decode(&document))
        .transpose()
}

/// `createCreditGiftCheckout(request)`: reserves the gift and returns the buyer's checkout,
/// creating it at most once per gift.
pub async fn create_credit_gift_checkout(
    gifts: &Gifts<'_>,
    request: CheckoutRequest<'_>,
) -> Result<CheckoutResponse, GiftError> {
    if !request.acknowledge_no_refunds {
        return Err(GiftError::request(
            "Confirm the recipient and gift refund policy",
            400,
        ));
    }
    if !is_uuid_v4(request.request_id)
        || !is_object_id(request.recipient_id)
        || pair_of(request.product_id).is_none()
    {
        return Err(GiftError::request("Invalid gift purchase", 400));
    }
    let user = request.user;
    if user.id.to_hex() == request.recipient_id {
        return Err(GiftError::request(
            "Choose another channel to receive the gift",
            400,
        ));
    }
    let recipient_oid = ObjectId::parse_str(request.recipient_id)
        .map_err(|_| GiftError::request("Invalid gift purchase", 400))?;
    let recipient = mongo_ops::find_one(gifts.mongo, USERS, doc! { "_id": recipient_oid }, None)
        .await?
        .map(|d| decode_user(&d))
        .transpose()?;
    let Some(recipient) = recipient else {
        return Err(GiftError::request(
            "Recipient account no longer exists",
            404,
        ));
    };
    let recipient_info = recipient_view(&recipient)?;
    let Some((_, buyer_name)) = twitch_account(user) else {
        return Err(GiftError::request("A bot account is required", 403));
    };
    let Some((recipient_channel, _)) = twitch_account(&recipient) else {
        return Err(GiftError::request(
            "This account has no Twitch channel",
            404,
        ));
    };
    let id = gift_id(&user.id, request.request_id);
    let hosts = gifts.config.allowed_hosts.as_deref();
    let mut success = redirect_url(
        request.success_url,
        gifts.config.success_url.as_deref(),
        hosts,
    )?;
    set_search_param(&mut success, "gift_id", &id);
    set_search_param(&mut success, "gift", "return");
    let back = redirect_url(
        request.return_url,
        gifts.config.return_url.as_deref(),
        hosts,
    )?;
    let pair = load_gift_pair(gifts.polar, request.product_id).await?;
    // Refuse payment until both identities already exist in Polar; never resolve the recipient
    // by e-mail. `Promise.all` of two checks: each sends its read unless its own payload check
    // threw, and the call fails with the first rejection in time (a payload check throws at
    // once, before any read answers).
    let (buyer_check, recipient_check) = futures_util::future::join(
        verify_gift_customer(gifts, user),
        verify_gift_customer(gifts, &recipient),
    )
    .await;
    first_rejection(buyer_check, recipient_check)?;

    let now = gifts.clock.now_ms();
    let insert = doc! { "$setOnInsert": {
        "buyerId": user.id,
        "recipientId": recipient.id,
        "buyerLogin": buyer_name.to_lowercase(),
        "recipientLogin": &recipient_info.login,
        "recipientName": &recipient_info.display_name,
        "recipientChannelId": recipient_channel,
        "productId": &pair.offer.id,
        "fulfillmentProductId": &pair.fulfillment_product_id,
        "benefitId": &pair.benefit_id,
        "credits": js_number(pair.offer.credits),
        "priceAmount": js_number(pair.offer.price_amount),
        "priceCurrency": &pair.offer.price_currency,
        "status": "awaiting_payment",
        "noRefundsAcknowledgedAt": date(now),
        "nextAttemptAt": date(now),
    } };
    mongo_ops::update_one(
        gifts.mongo,
        &GIFT_INFO,
        &doc! { "_id": &id },
        insert,
        UpdateOptions::upsert(),
        Some(journaled()),
        now,
    )
    .await?;
    let Some(mut gift) = load_gift(gifts, &id).await? else {
        return Err(GiftError::Failed("Gift reservation missing".into()));
    };
    if gift.product_id != request.product_id || gift.recipient_id.to_hex() != request.recipient_id {
        return Err(GiftError::request(
            "A gift request cannot change recipient or pack; start a new gift",
            409,
        ));
    }
    let response = |gift: &Gift, url: String| CheckoutResponse {
        gift_id: id.clone(),
        checkout_id: gift.checkout_id.clone(),
        checkout_url: Private::from(url),
        offer: GiftOffer {
            id: gift.product_id.clone(),
            name: pair.offer.name.clone(),
            credits: gift.credits,
            price_amount: gift.price_amount,
            price_currency: gift.price_currency.clone(),
        },
        recipient: GiftRecipient {
            id: gift.recipient_id.to_hex(),
            login: gift.recipient_login.clone(),
            display_name: gift.recipient_name.clone(),
        },
    };
    if gift.paid_at.is_some() {
        return Err(GiftError::request(
            "This gift has already been paid for",
            409,
        ));
    }
    if let (Some(_), Some(url)) = (
        gift.checkout_id.as_ref().filter(|c| !c.is_empty()),
        gift.checkout_url.as_ref().filter(|u| !u.is_empty()),
    ) {
        return Ok(response(&gift, url.clone()));
    }
    // A persisted reservation precedes the external POST: a lost answer cannot make another
    // checkout.
    let claimed = mongo_ops::update_one(
        gifts.mongo,
        &GIFT_INFO,
        &doc! { "_id": &id, "purchaseCreateStartedAt": { "$exists": false } },
        doc! { "$set": { "purchaseCreateStartedAt": date(now) } },
        UpdateOptions::default(),
        Some(journaled()),
        now,
    )
    .await?;
    interrupt(gifts, "purchase:claimed")?;
    let checkout = if claimed.modified == 1 {
        let mut body = Map::new();
        body.insert(
            "products".into(),
            Value::Array(vec![Value::from(gift.product_id.as_str())]),
        );
        body.extend(customer_payload(user)?);
        body.insert("allow_discount_codes".into(), Value::Bool(false));
        body.insert("success_url".into(), Value::from(success.as_str()));
        body.insert("return_url".into(), Value::from(back.as_str()));
        body.insert(
            "metadata".into(),
            serde_json::json!({
                "source": PURCHASE_SOURCE,
                "gift_id": id,
                "recipient_id": gift.recipient_id.to_hex(),
                "credits": crate::js::json_number(gift.credits),
                "rollover": true,
                "no_automatic_refunds": true,
            }),
        );
        let created = gifts
            .polar
            .create_gift_checkout(&Value::Object(body), &format!("gift-purchase:{id}"))
            .await;
        interrupt(gifts, "purchase:answered")?;
        GiftValue(created.map_err(|e| provider_error(&e))?)
    } else {
        match recover_gift_checkout(gifts.polar, &id, &gift.product_id, &gift.buyer_id.to_hex())
            .await?
        {
            Some(checkout) => checkout,
            None => {
                return Err(GiftError::request(
                    "Checkout is being prepared; retry this same gift shortly",
                    409,
                ));
            }
        }
    };
    let (user_id, customer) = owner_of(user);
    let owner = Owner {
        user_id: &user_id,
        customer_id: customer.as_deref(),
    };
    require_checkout(&checkout.0, &gift, owner, false)?;
    if checkout.text("status") != Some("open") {
        return Err(GiftError::request(
            "This checkout is no longer open; check the gift delivery status",
            409,
        ));
    }
    let checkout_id = checkout.text("id").unwrap_or_default().to_owned();
    let url = checkout.text("url").unwrap_or_default().to_owned();
    let mut set = Document::new();
    set.insert("checkoutId", checkout_id.as_str());
    if !url.is_empty() {
        set.insert("checkoutUrl", url.as_str());
    }
    // `checkout.customer_id || undefined`: Mongoose leaves an undefined key out of `$set`.
    if let Some(customer) = checkout.text("customer_id").filter(|c| !c.is_empty()) {
        set.insert("buyerCustomerId", customer);
    }
    set.insert("nextAttemptAt", date(gifts.clock.now_ms()));
    mongo_ops::update_one(
        gifts.mongo,
        &GIFT_INFO,
        &doc! { "_id": &id, "paidAt": { "$exists": false } },
        doc! { "$set": set },
        UpdateOptions::default(),
        Some(journaled()),
        gifts.clock.now_ms(),
    )
    .await?;
    interrupt(gifts, "purchase:stored")?;
    gift.checkout_id = Some(checkout_id);
    Ok(response(&gift, url))
}

/// Stops at `point` when a test interrupt asks to.
pub(crate) fn interrupt(gifts: &Gifts<'_>, point: &'static str) -> Result<(), GiftError> {
    match gifts.interrupt {
        Some(interrupt) if interrupt.at(point) => Err(GiftError::Interrupted(point)),
        _ => Ok(()),
    }
}

/// `acceptCreditGiftPaidOrder(orderId)`: the fast path from a signed, journaled paid order. The
/// order is read from Polar (nothing of the webhook but its id is trusted) and checked against
/// the stored gift and its checkout; `paidAt` is set once. The worker's reconciliation also
/// handles a missed webhook.
pub async fn accept_credit_gift_paid_order(
    gifts: &Gifts<'_>,
    order_id: &str,
) -> Result<(), GiftError> {
    let order = gifts
        .polar
        .get_order(order_id)
        .await
        .map_err(|e| provider_error(&e))?;
    let metadata = order.get("metadata").filter(|m| !m.is_null());
    let Some(gift_id) = metadata
        .filter(|m| str_at(m, "source") == Some(PURCHASE_SOURCE))
        .and_then(|m| str_at(m, "gift_id"))
    else {
        return Ok(());
    };
    let Some(gift) = load_gift(gifts, gift_id).await? else {
        return Err(GiftError::Failed(
            "Gift reservation missing for paid order".into(),
        ));
    };
    // API response-loss recovery owns the checkout identity; the worker will reconcile it.
    let Some(checkout_id) = gift.checkout_id.clone().filter(|c| !c.is_empty()) else {
        return Ok(());
    };
    let buyer = mongo_ops::find_one(gifts.mongo, USERS, doc! { "_id": gift.buyer_id }, None)
        .await?
        .map(|d| decode_user(&d))
        .transpose()?;
    let Some(buyer) = buyer else {
        return Err(GiftError::Failed("Gift buyer no longer exists".into()));
    };
    let checkout = gifts
        .polar
        .get_checkout(&checkout_id)
        .await
        .map_err(|e| provider_error(&e))?;
    let (user_id, customer) = owner_of(&buyer);
    let owner = Owner {
        user_id: &user_id,
        customer_id: customer.as_deref(),
    };
    require_checkout(&checkout, &gift, owner, false)?;
    let mut checked = gift.clone();
    checked.buyer_customer_id = str_at(&checkout, "customer_id")
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    validate_gift_order(&order, &checked, owner, false)?;
    let now = gifts.clock.now_ms();
    let mut set = Document::new();
    // `undefined` values are left out of `$set` by Mongoose.
    if let Some(order_id) = str_at(&order, "id") {
        set.insert("paidOrderId", order_id);
    }
    if let Some(customer) = str_at(&order, "customer_id") {
        set.insert("buyerCustomerId", customer);
    }
    set.insert("paidAt", date(now));
    set.insert("status", "payment_received");
    set.insert("nextAttemptAt", date(now));
    mongo_ops::update_one(
        gifts.mongo,
        &GIFT_INFO,
        &doc! { "_id": &gift.id, "paidAt": { "$exists": false } },
        doc! { "$set": set },
        UpdateOptions::default(),
        Some(journaled()),
        now,
    )
    .await?;
    Ok(())
}

/// `applyCreditGiftDomainEvent(event)` (consumer `polar-gifts-v1`): a paid order of a gift
/// product from the Polar webhook journal. Anything else is ignored.
pub async fn apply_credit_gift_domain_event(
    gifts: &Gifts<'_>,
    source: &str,
    kind: &str,
    payload: &Value,
) -> Result<(), GiftError> {
    if source != "polar-webhook" || kind != "billing.order.paid" {
        return Ok(());
    }
    if str_at(payload, "productId").and_then(pair_of).is_none() {
        return Ok(());
    }
    let order_id = payload.get("orderId").and_then(Value::as_str);
    let (Some(order_id), Some(true)) = (order_id, payload.get("paid").and_then(Value::as_bool))
    else {
        return Err(GiftError::Failed("Gift requires a paid order".into()));
    };
    accept_credit_gift_paid_order(gifts, order_id).await
}
