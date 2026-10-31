#![cfg(all(feature = "polar-billing-events", feature = "paid-order-reward"))]

//! Coverage for the Polar paid-order reward bridge
//! (`domain_events/polar_billing/reward_bridge.rs`, contract tl1-c4).
//!
//! The pure tests pin the bridge's own logic: the string-cadence conversion and
//! the adapter-to-consumer error mapping. The disposable-fixture test runs the
//! real composition end to end — [`MongoPolarBillingStore`] owner resolution,
//! `PaidOrderRewardService` reservation/credit writes, and the canonical
//! `apply_polar_reward_domain_event` filters — including replay idempotency and
//! error propagation.
//!
//! Nothing here has been executed by the author. The fixture test is
//! `#[ignore]`d and **refuses** anything that is not an explicitly confirmed,
//! task-owned, disposable database; it never silently skips.
//!
//! Fixture contract:
//!
//! ```sh
//! POLAR_REWARD_BRIDGE_TEST_EXPECT=disposable \
//! POLAR_REWARD_BRIDGE_TEST_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//! POLAR_REWARD_BRIDGE_TEST_DATABASE='rust_polar_reward_bridge_fixture_<unique>' \
//!   cargo test --locked --test polar_reward_bridge -- --ignored \
//!     --exact the_bridge_dispatches_replays_and_propagates_errors_against_a_disposable_database
//! ```
//!
//! A non-loopback host (for example a task-owned container on a private test
//! network) is accepted only with
//! `POLAR_REWARD_BRIDGE_TEST_PRIVATE_NETWORK=1`.

use dima_rust::domain_event_contracts::polar_billing::{
    self, PaidOrderRewardInput, PolarBillingError, mongo_store::MongoPolarBillingStore,
    reward_bridge,
};
use dima_rust::domain_event_contracts::DomainEventEnvelope;
use dima_rust::utils::billing::{PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO};
use dima_rust::utils::paid_order_reward::{
    PaidOrderRewardError, PaidOrderRewardInput as TypedRewardInput,
};
use dima_rust::utils::referral::SubscriptionCadence;
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------
// Pure bridge logic: cadence conversion and error mapping.
// ---------------------------------------------------------------------------

fn seam_input(cadence: &str) -> PaidOrderRewardInput {
    PaidOrderRewardInput {
        owner_user_id: "0123456789abcdef01234567".into(),
        order_id: "order-1".into(),
        product_id: PLAN_PRODUCT_ID_PREMIUM.into(),
        cadence: cadence.into(),
    }
}

#[test]
fn supported_cadences_map_to_the_typed_reward_input() {
    for (text, cadence) in [
        ("monthly", SubscriptionCadence::Monthly),
        ("yearly", SubscriptionCadence::Yearly),
    ] {
        let typed = reward_bridge::typed_reward_input(&seam_input(text))
            .expect("a TypeScript-union cadence must convert");
        assert_eq!(
            typed,
            TypedRewardInput::new(
                "0123456789abcdef01234567",
                "order-1",
                PLAN_PRODUCT_ID_PREMIUM,
                cadence,
            )
        );
    }
}

#[test]
fn unsupported_cadences_are_business_errors_with_the_bridge_message() {
    for cadence in ["", "Monthly", "weekly", " yearly"] {
        let error = reward_bridge::typed_reward_input(&seam_input(cadence))
            .expect_err("a value outside the TypeScript union must fail");
        match &error {
            PolarBillingError::Business(message) => assert_eq!(
                message,
                &format!("{}: {}", reward_bridge::REWARD_CADENCE_UNSUPPORTED, cadence)
            ),
            other => panic!("expected a business error, got {other:?}"),
        }
    }
    assert_eq!(
        reward_bridge::REWARD_CADENCE_UNSUPPORTED,
        "Polar paid order has an unsupported billing cadence"
    );
}

#[test]
fn adapter_errors_keep_their_source_messages_and_driver_failures_stay_runtime() {
    for (error, message) in [
        (
            PaidOrderRewardError::MissingOrderId,
            "Paid order reward requires an order ID",
        ),
        (
            PaidOrderRewardError::InvalidOwnerUserId,
            "Paid order reward requires a canonical owner user ID",
        ),
        (
            PaidOrderRewardError::OwnerNotFound,
            "Paid order reward owner not found",
        ),
        (
            PaidOrderRewardError::BeneficiaryNotFound,
            "Paid order reward beneficiary not found",
        ),
        (
            PaidOrderRewardError::ReservationNotFound,
            "Paid order reward reservation not found",
        ),
        (
            PaidOrderRewardError::ReservedBeneficiaryNotFound,
            "Paid order reward reserved beneficiary not found",
        ),
        (
            PaidOrderRewardError::CorruptReservation("missing user"),
            "Paid order reward reservation is malformed: missing user",
        ),
    ] {
        match reward_bridge::map_reward_error(error) {
            PolarBillingError::Business(mapped) => assert_eq!(mapped, message),
            other => panic!("expected a business error, got {other:?}"),
        }
    }

    let invalid =
        reward_bridge::map_reward_error(PaidOrderRewardError::InvalidCadence("Weekly".into()));
    assert_eq!(
        invalid.to_string(),
        format!("{}: Weekly", reward_bridge::REWARD_CADENCE_UNSUPPORTED)
    );

    let index = reward_bridge::map_reward_error(PaidOrderRewardError::Index(
        mongodb::error::Error::custom("index fixture failure"),
    ));
    match index {
        PolarBillingError::Runtime(message) => assert!(
            message.starts_with("Credit transaction index install failed"),
            "unexpected message: {message}"
        ),
        other => panic!("expected a runtime error, got {other:?}"),
    }

    let mongo = reward_bridge::map_reward_error(PaidOrderRewardError::Mongo(
        mongodb::error::Error::custom("mongo fixture failure"),
    ));
    match mongo {
        PolarBillingError::Runtime(message) => assert!(
            message.starts_with("Paid order reward database operation failed"),
            "unexpected message: {message}"
        ),
        other => panic!("expected a runtime error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Fixture guard. Refusal is testable without a database.
// ---------------------------------------------------------------------------

const EXPECT_ENV: &str = "POLAR_REWARD_BRIDGE_TEST_EXPECT";
const URI_ENV: &str = "POLAR_REWARD_BRIDGE_TEST_MONGO_URI";
const DB_ENV: &str = "POLAR_REWARD_BRIDGE_TEST_DATABASE";
const PRIVATE_NETWORK_ENV: &str = "POLAR_REWARD_BRIDGE_TEST_PRIVATE_NETWORK";
const DB_PREFIX: &str = "rust_polar_reward_bridge_fixture_";

/// Host portion of a MongoDB URI, without credentials, port, or path.
fn uri_host(uri: &str) -> &str {
    let rest = uri.split_once("://").map_or(uri, |(_, rest)| rest);
    let rest = rest.split(['/', '?']).next().unwrap_or(rest);
    let host_port = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    if let Some(stripped) = host_port.strip_prefix('[') {
        return stripped.split_once(']').map_or(stripped, |(host, _)| host);
    }
    host_port.split_once(':').map_or(host_port, |(host, _)| host)
}

fn check_fixture_contract(
    expect: Option<&str>,
    uri: Option<&str>,
    database: Option<&str>,
    private_network: Option<&str>,
) -> Result<(), String> {
    if expect != Some("disposable") {
        return Err(format!(
            "{}=disposable must be set; refusing an unconfirmed database",
            EXPECT_ENV
        ));
    }
    let uri = uri.ok_or_else(|| format!("{} must name a disposable MongoDB fixture", URI_ENV))?;
    if !uri.starts_with("mongodb://") {
        return Err("use a direct mongodb:// URI for the disposable fixture".into());
    }
    let authority = uri["mongodb://".len()..].split(['/', '?']).next().unwrap_or("");
    let hosts = authority.rsplit_once('@').map_or(authority, |(_, hosts)| hosts);
    if hosts.contains(',') || !uri.split_once('?').is_some_and(|(_, query)| {
        query.split('&').any(|part| part.eq_ignore_ascii_case("directConnection=true"))
    }) {
        return Err("fixture URI must select one host with directConnection=true".into());
    }
    let host = uri_host(uri);
    if host.is_empty() {
        return Err(format!("{} must include an explicit host", URI_ENV));
    }
    let database = database.ok_or_else(|| format!("{} must name a task-owned database", DB_ENV))?;
    if !database.starts_with(DB_PREFIX) {
        return Err(format!("{} must start with `{}`", DB_ENV, DB_PREFIX));
    }
    if database.len() > 60
        || !database
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("{} must be a simple task-owned identifier", DB_ENV));
    }
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") && private_network != Some("1") {
        return Err(format!(
            "refusing a non-loopback MongoDB host `{}` unless {}=1 \
             confirms a task-owned isolated network",
            host, PRIVATE_NETWORK_ENV
        ));
    }
    Ok(())
}

#[test]
fn the_disposable_fixture_contract_refuses_non_disposable_resources() {
    let loopback = Some("mongodb://127.0.0.1:27017/?directConnection=true");
    let name = Some("rust_polar_reward_bridge_fixture_smoke");
    assert!(check_fixture_contract(Some("disposable"), loopback, name, None).is_ok());

    assert!(check_fixture_contract(None, loopback, name, None).is_err());
    assert!(check_fixture_contract(Some("production"), loopback, name, None).is_err());
    assert!(check_fixture_contract(Some("disposable"), None, name, None).is_err());
    assert!(
        check_fixture_contract(
            Some("disposable"),
            Some("mongodb+srv://cluster.example.net/app"),
            name,
            None
        )
        .is_err()
    );
    assert!(check_fixture_contract(Some("disposable"), loopback, None, None).is_err());
    assert!(
        check_fixture_contract(Some("disposable"), loopback, Some("dimabot"), None).is_err()
    );
    assert!(
        check_fixture_contract(
            Some("disposable"),
            loopback,
            Some("rust_polar_reward_bridge_fixture_bad name"),
            None
        )
        .is_err()
    );
    // A container on a private test network is allowed only when acknowledged.
    assert!(check_fixture_contract(Some("disposable"), Some("mongodb://127.0.0.1:27017,other:27017/?directConnection=true"), name, None).is_err());
    assert!(check_fixture_contract(Some("disposable"), Some("mongodb://127.0.0.1:27017/"), name, None).is_err());
    let private = Some("mongodb://mongo-fixture:27017/?directConnection=true");
    assert!(check_fixture_contract(Some("disposable"), private, name, None).is_err());
    assert!(check_fixture_contract(Some("disposable"), private, name, Some("1")).is_ok());
}

// ---------------------------------------------------------------------------
// Disposable-fixture coverage: real composition, real dispatch, real writes.
// ---------------------------------------------------------------------------

const EVENT_KEY: &str = "polar-webhook:delivery-1";
const OCCURRED_AT: &str = "2026-09-04T10:00:00Z";

fn event(
    source: &str,
    event_type: &str,
    owner: Option<&str>,
    payload: Value,
) -> DomainEventEnvelope {
    let mut document = Map::new();
    document.insert("_id".into(), json!("65e000000000000000000000"));
    document.insert("eventKey".into(), json!(EVENT_KEY));
    document.insert("sourceEventId".into(), json!("delivery-1"));
    document.insert("source".into(), json!(source));
    document.insert("type".into(), json!(event_type));
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    if let Some(owner) = owner {
        document.insert("ownerUserId".into(), json!(owner));
    }
    document.insert("occurredAt".into(), json!(OCCURRED_AT));
    document.insert("journaledAt".into(), json!("2026-09-05T10:00:00.000Z"));
    document.insert("expiresAt".into(), json!("2026-10-05T10:00:00.000Z"));
    document.insert("payload".into(), payload);
    document.insert("metadata".into(), json!({}));
    DomainEventEnvelope::from_document(&document)
}

fn paid_order_event(
    owner: Option<&str>,
    order_id: &str,
    product_id: &str,
    total_amount: i64,
    cadence: &str,
) -> DomainEventEnvelope {
    event(
        "polar-webhook",
        "billing.order.paid",
        owner,
        json!({
            "paid": true,
            "orderId": order_id,
            "subscriptionId": "sub-1",
            "totalAmount": total_amount,
            "productId": product_id,
            "cadence": cadence,
        }),
    )
}

#[tokio::test]
#[ignore = "requires a task-owned disposable MongoDB fixture"]
async fn the_bridge_dispatches_replays_and_propagates_errors_against_a_disposable_database() {
    use dima_rust::schemas::{credit_transaction, referral_code, users};
    use mongodb::bson::{Bson, doc, oid::ObjectId};
    use std::env;

    check_fixture_contract(
        env::var(EXPECT_ENV).ok().as_deref(),
        env::var(URI_ENV).ok().as_deref(),
        env::var(DB_ENV).ok().as_deref(),
        env::var(PRIVATE_NETWORK_ENV).ok().as_deref(),
    )
    .unwrap_or_else(|reason| panic!("{reason}"));

    let uri = env::var(URI_ENV).expect("validated fixture URI");
    let name = env::var(DB_ENV).expect("validated fixture database");
    let client = mongodb::Client::with_uri_str(&uri)
        .await
        .expect("fixture client");
    let database = client.database(&name);
    assert!(
        database
            .list_collection_names()
            .await
            .expect("list fixture collections")
            .is_empty(),
        "the task database must be fresh before the fixture writes"
    );

    let payer = ObjectId::new();
    let referral_payer = ObjectId::new();
    let referrer = ObjectId::new();
    let bot = ObjectId::new();
    let people = users::schema().native_collection(&database);
    people
        .insert_one(doc! {
            "_id": payer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
            "referrerId": Bson::Null,
            "referralCodeUsed": Bson::Null,
        })
        .await
        .expect("bot-path payer fixture");
    people
        .insert_one(doc! {
            "_id": bot,
            "accounts": [{ "type": "twitch", "name": "domdimabot" }],
            "token_balance": 0,
        })
        .await
        .expect("bot fixture");
    people
        .insert_one(doc! {
            "_id": referral_payer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
            "referrerId": referrer,
            "referralCodeUsed": "promo_1",
        })
        .await
        .expect("referrer-path payer fixture");
    people
        .insert_one(doc! {
            "_id": referrer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
        })
        .await
        .expect("referrer fixture");
    referral_code::schema()
        .native_collection(&database)
        .insert_one(doc! { "code": "promo_1", "owner": referrer, "active": true })
        .await
        .expect("referral code fixture");

    let store = MongoPolarBillingStore::new(database.clone());
    let transactions = credit_transaction::schema().native_collection(&database);

    // 1. Bot path: the canonical branch resolves the owner, the bridge converts
    //    the cadence, and the concrete service reserves + credits + finalizes.
    let bot_event = paid_order_event(
        Some(&payer.to_hex()),
        "order-1",
        PLAN_PRODUCT_ID_PREMIUM,
        600,
        "monthly",
    );
    reward_bridge::dispatch_paid_order_reward_event(
        &bot_event,
        &store,
        None,
        database.clone(),
    )
    .await
    .expect("bot reward dispatch");

    let reservation = transactions
        .find_one(doc! { "idempotencyKey": "polar:paid-order:order-1" })
        .await
        .expect("read reservation")
        .expect("reservation exists");
    assert_eq!(
        reservation.get_str("type").expect("type"),
        "subscription_reward"
    );
    assert_eq!(reservation.get_i32("amount").expect("amount"), 50);
    assert_eq!(reservation.get_i32("balanceAfter").expect("balanceAfter"), 50);
    let first_applied_at = reservation
        .get_datetime("appliedAt")
        .expect("appliedAt")
        .timestamp_millis();
    let metadata = reservation.get_document("metadata").expect("metadata");
    assert_eq!(metadata.get_str("rewardTargetType").expect("target"), "bot");
    assert_eq!(
        metadata.get_str("externalReference").expect("reference"),
        "polar:paid-order:order-1"
    );
    assert_eq!(
        metadata.get_str("subscriptionId").expect("order id"),
        "order-1"
    );
    assert_eq!(
        metadata.get_str("description").expect("description"),
        "Subscription reward for PREMIUM (monthly)"
    );
    let credited_bot = people
        .find_one(doc! { "_id": bot })
        .await
        .expect("read bot")
        .expect("bot exists");
    assert_eq!(credited_bot.get_i32("token_balance").expect("balance"), 50);

    // 2. Replay: the same event writes nothing new and never reconstructs the
    //    historical post-credit balance.
    reward_bridge::dispatch_paid_order_reward_event(
        &bot_event,
        &store,
        None,
        database.clone(),
    )
    .await
    .expect("replay dispatch");
    assert_eq!(
        transactions
            .count_documents(doc! { "type": "subscription_reward" })
            .await
            .expect("count rewards"),
        1
    );
    let replayed = transactions
        .find_one(doc! { "idempotencyKey": "polar:paid-order:order-1" })
        .await
        .expect("read replayed reservation")
        .expect("reservation exists");
    assert_eq!(
        replayed
            .get_datetime("appliedAt")
            .expect("appliedAt")
            .timestamp_millis(),
        first_applied_at
    );
    assert_eq!(replayed.get_i32("balanceAfter").expect("balanceAfter"), 50);
    let replayed_bot = people
        .find_one(doc! { "_id": bot })
        .await
        .expect("read bot")
        .expect("bot exists");
    assert_eq!(
        replayed_bot.get_i32("token_balance").expect("balance"),
        50,
        "a replay must not credit twice"
    );

    // 3. Referrer path: the bridge delegates the whole beneficiary policy.
    reward_bridge::dispatch_paid_order_reward_event(
        &paid_order_event(
            Some(&referral_payer.to_hex()),
            "order-2",
            PLAN_PRODUCT_ID_PRO,
            1200,
            "yearly",
        ),
        &store,
        None,
        database.clone(),
    )
    .await
    .expect("referrer reward dispatch");
    let credited_referrer = people
        .find_one(doc! { "_id": referrer })
        .await
        .expect("read referrer")
        .expect("referrer exists");
    assert_eq!(
        credited_referrer.get_i32("token_balance").expect("balance"),
        1000
    );
    let referrer_reservation = transactions
        .find_one(doc! { "idempotencyKey": "polar:paid-order:order-2" })
        .await
        .expect("read referrer reservation")
        .expect("referrer reservation exists");
    let referrer_metadata = referrer_reservation
        .get_document("metadata")
        .expect("metadata");
    assert_eq!(
        referrer_metadata.get_str("rewardTargetType").expect("target"),
        "referrer"
    );
    assert_eq!(
        referrer_metadata
            .get_str("referralCodeUsed")
            .expect("code"),
        "promo_1"
    );
    assert_eq!(
        referrer_metadata.get_str("description").expect("description"),
        "Subscription reward for PRO (yearly)"
    );
    assert_eq!(
        transactions
            .count_documents(doc! { "type": "subscription_reward" })
            .await
            .expect("count rewards"),
        2
    );

    // 4. Filters stay in the canonical branch: these events never reach the
    //    concrete adapter and never write.
    for filtered in [
        // Wrong event type.
        event(
            "polar-webhook",
            "billing.customer.state.changed",
            Some(&payer.to_hex()),
            json!({
                "paid": true, "orderId": "order-filter-type", "subscriptionId": "sub-1",
                "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"
            }),
        ),
        // Wrong source.
        event(
            "twitch-eventsub",
            "billing.order.paid",
            Some(&payer.to_hex()),
            json!({
                "paid": true, "orderId": "order-filter-source", "subscriptionId": "sub-1",
                "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"
            }),
        ),
        // One-time order: no subscription id.
        event(
            "polar-webhook",
            "billing.order.paid",
            Some(&payer.to_hex()),
            json!({
                "paid": true, "orderId": "order-filter-one-time",
                "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"
            }),
        ),
        // $0 trial start.
        paid_order_event(
            Some(&payer.to_hex()),
            "order-filter-zero",
            PLAN_PRODUCT_ID_PREMIUM,
            0,
            "monthly",
        ),
        // Non-plan product.
        paid_order_event(
            Some(&payer.to_hex()),
            "order-filter-free",
            PLAN_PRODUCT_ID_FREE,
            600,
            "monthly",
        ),
    ] {
        reward_bridge::dispatch_paid_order_reward_event(
            &filtered,
            &store,
            None,
            database.clone(),
        )
        .await
        .expect("a filtered event must succeed without a reward");
    }
    assert_eq!(
        transactions
            .count_documents(doc! { "type": "subscription_reward" })
            .await
            .expect("count rewards"),
        2
    );
    assert!(
        transactions
            .find_one(doc! { "idempotencyKey": "polar:paid-order:order-filter-free" })
            .await
            .expect("read filtered reservation")
            .is_none()
    );

    // 5. Error propagation through the real composition.
    //    An unpaid order fails closed in the canonical branch.
    let unpaid = event(
        "polar-webhook",
        "billing.order.paid",
        Some(&payer.to_hex()),
        json!({
            "paid": false, "orderId": "order-unpaid", "subscriptionId": "sub-1",
            "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"
        }),
    );
    let error = reward_bridge::dispatch_paid_order_reward_event(
        &unpaid,
        &store,
        None,
        database.clone(),
    )
    .await
    .expect_err("an unpaid order must fail closed");
    assert_eq!(error.to_string(), polar_billing::REWARD_PAYLOAD);

    //    A missing cadence is the source-authored event error.
    let error = reward_bridge::dispatch_paid_order_reward_event(
        &paid_order_event(
            Some(&payer.to_hex()),
            "order-cadence-missing",
            PLAN_PRODUCT_ID_PREMIUM,
            600,
            "",
        ),
        &store,
        None,
        database.clone(),
    )
    .await
    .expect_err("a missing cadence must fail closed");
    assert_eq!(error.to_string(), polar_billing::REWARD_CADENCE);

    //    An unexpected cadence is rejected by the bridge, not the database.
    let error = reward_bridge::dispatch_paid_order_reward_event(
        &paid_order_event(
            Some(&payer.to_hex()),
            "order-cadence",
            PLAN_PRODUCT_ID_PREMIUM,
            600,
            "Monthly",
        ),
        &store,
        None,
        database.clone(),
    )
    .await
    .expect_err("an unsupported cadence must fail");
    assert_eq!(
        error.to_string(),
        format!("{}: Monthly", reward_bridge::REWARD_CADENCE_UNSUPPORTED)
    );
    assert!(
        transactions
            .find_one(doc! { "idempotencyKey": "polar:paid-order:order-cadence" })
            .await
            .expect("read rejected reservation")
            .is_none()
    );

    //    Owner resolution failures come from the canonical branch, before the
    //    adapter runs.
    let error = reward_bridge::dispatch_paid_order_reward_event(
        &paid_order_event(None, "order-no-owner", PLAN_PRODUCT_ID_PREMIUM, 600, "monthly"),
        &store,
        None,
        database.clone(),
    )
    .await
    .expect_err("a missing owner mapping must fail");
    assert_eq!(
        error.to_string(),
        format!(
            "Missing prerequisite: {}",
            polar_billing::OWNER_MAPPING_UNRESOLVED
        )
    );

    let unknown_owner = ObjectId::new().to_hex();
    let error = reward_bridge::dispatch_paid_order_reward_event(
        &paid_order_event(
            Some(&unknown_owner),
            "order-unknown-owner",
            PLAN_PRODUCT_ID_PREMIUM,
            600,
            "monthly",
        ),
        &store,
        None,
        database.clone(),
    )
    .await
    .expect_err("an unknown owner must fail");
    assert_eq!(
        error.to_string(),
        format!("Missing prerequisite: {}", polar_billing::OWNER_MISSING)
    );

    // Nothing above changed the credited state.
    assert_eq!(
        transactions
            .count_documents(doc! { "type": "subscription_reward" })
            .await
            .expect("count rewards"),
        2
    );
    let final_bot = people
        .find_one(doc! { "_id": bot })
        .await
        .expect("read bot")
        .expect("bot exists");
    assert_eq!(final_bot.get_i32("token_balance").expect("balance"), 50);
    let final_referrer = people
        .find_one(doc! { "_id": referrer })
        .await
        .expect("read referrer")
        .expect("referrer exists");
    assert_eq!(
        final_referrer.get_i32("token_balance").expect("balance"),
        1000
    );

    // The fixture owns this database; remove only that database.
    database.drop().await.expect("drop task-owned fixture database");
}
