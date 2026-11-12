//! Credit gifts against a stateful Polar mock and a real MongoDB: once and only once (the same
//! call twice, two at once), a process killed after each durable write and between a request
//! and its answer, answers lost or unreadable after Polar committed, and the abuse cases.
//!
//! What each kill leaves (the module docs of `dima_billing::gifts` list the steps):
//!
//! | Killed | Left | What follows |
//! |---|---|---|
//! | after the purchase claim, before the POST | `purchaseCreateStartedAt`, no checkout | the request answers 409 (being prepared), the worker waits; no money moved: the buyer starts a new gift |
//! | after the purchase POST, before storing it | a checkout at Polar, none stored | recovered by listing the buyer's checkouts (same gift id), never created again |
//! | after the fulfillment reservation, before the POST | `fulfillmentCreateStartedAt`, no checkout | never created again: after five failed recoveries the gift is `needs_support` (reference behaviour, see `kill_after_the_fulfillment_reservation_*`) |
//! | after the fulfillment POST, before storing it | a free checkout at Polar | recovered by listing, then confirmed once |
//! | after the confirmation was sent | an order and a grant at Polar | the next stage sees the checkout no longer open and delivers |
//! | after the credits were refreshed, before `deliveredAt` | a granted gift | the next stage finds the same grant and marks it delivered |
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::doc;
use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::gifts::{
    ChatSend, CheckoutRequest, CreditRefresh, GiftConfig, GiftEffects, GiftError, Gifts, Interrupt,
    StageEnd, accept_credit_gift_paid_order, create_credit_gift_checkout, process_credit_gift,
};
use dima_core::ManualClock;
use dima_http::testing::MockServer;
use dima_model::users::User;
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use gift_support::{Fault, PAIRS, World, user_document};
use serde_json::Value;
use std::sync::Mutex;

const CB: &str = "a1b2c3d4-0000-4000-8000-000000000001";
const CR: &str = "a1b2c3d4-0000-4000-8000-000000000002";
const NOW: i64 = 1_794_484_800_000;
const REQUEST: &str = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

/// Stops once at a point, as a killed process would.
struct StopAt(Mutex<Option<&'static str>>);

impl StopAt {
    fn new(point: &'static str) -> Self {
        Self(Mutex::new(Some(point)))
    }
}

impl Interrupt for StopAt {
    fn at(&self, point: &'static str) -> bool {
        let mut armed = self.0.lock().unwrap();
        if *armed == Some(point) {
            *armed = None;
            return true;
        }
        false
    }
}

struct Quiet;

impl GiftEffects for Quiet {
    fn send_chat<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, ChatSend> {
        Box::pin(async {
            ChatSend::Sent {
                message_id: Some("m".into()),
            }
        })
    }
}

/// Counts refreshes; never fails.
#[derive(Default)]
struct Refresh(Mutex<u32>);

impl CreditRefresh for Refresh {
    fn refresh<'a>(&'a self, _: &'a User, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            *self.0.lock().unwrap() += 1;
            Ok(())
        })
    }
}

struct Env {
    store: MongoStore,
    server: MockServer,
    world: World,
    clock: ManualClock,
    buyer: ObjectId,
    recipient: ObjectId,
    config: GiftConfig,
}

impl Env {
    async fn new(store: MongoStore) -> Self {
        let buyer = ObjectId::new();
        let recipient = ObjectId::new();
        store
            .documents("users")
            .insert_many([
                user_document(buyer, "9201", "Buyer", Some(CB)),
                user_document(recipient, "9202", "Receiver", Some(CR)),
            ])
            .await
            .unwrap();
        let world = World::new(&[(CB, &buyer.to_hex()), (CR, &recipient.to_hex())]);
        let server = MockServer::start().await.unwrap();
        world.install(&server);
        Self {
            store,
            server,
            world,
            clock: ManualClock::new(NOW),
            buyer,
            recipient,
            config: GiftConfig::default(),
        }
    }

    async fn run<T>(
        &self,
        interrupt: Option<&dyn Interrupt>,
        f: impl AsyncFnOnce(&Gifts<'_>) -> T,
    ) -> T {
        let polar = gift_support::polar(&self.server);
        let random = dima_core::SystemRandom;
        let gifts = Gifts {
            mongo: &self.store,
            polar: &polar,
            clock: &self.clock,
            random: &random,
            observer: &NoopObserver,
            config: &self.config,
            interrupt,
        };
        f(&gifts).await
    }

    async fn user(&self, id: ObjectId) -> User {
        let document = self
            .store
            .documents("users")
            .find_one(doc! { "_id": id })
            .await
            .unwrap()
            .unwrap();
        dima_model::decode_document(&document).unwrap()
    }

    async fn create(&self, interrupt: Option<&dyn Interrupt>) -> Result<Value, GiftError> {
        let buyer = self.user(self.buyer).await;
        let recipient = self.recipient.to_hex();
        self.run(interrupt, async |gifts| {
            create_credit_gift_checkout(
                gifts,
                CheckoutRequest {
                    user: &buyer,
                    product_id: PAIRS[0].0,
                    recipient_id: &recipient,
                    request_id: REQUEST,
                    acknowledge_no_refunds: true,
                    success_url: None,
                    return_url: None,
                },
            )
            .await
            .map(|r| r.to_json())
        })
        .await
    }

    async fn work(
        &self,
        interrupt: Option<&dyn Interrupt>,
        refresh: &Refresh,
    ) -> Result<StageEnd, GiftError> {
        self.run(interrupt, async |gifts| {
            process_credit_gift(gifts, &Quiet, refresh).await
        })
        .await
    }

    async fn gift(&self) -> bson::Document {
        self.store
            .documents("creditgifts")
            .find_one(doc! {})
            .await
            .unwrap()
            .unwrap()
    }

    fn gift_id(&self) -> String {
        dima_billing::gifts::requests::gift_id(&self.buyer, REQUEST)
    }

    /// Runs worker stages, moving the clock past each pause, until `done` or `limit` stages.
    async fn work_until(
        &self,
        refresh: &Refresh,
        limit: usize,
        done: impl Fn(&bson::Document) -> bool,
    ) {
        for _ in 0..limit {
            if done(&self.gift().await) {
                return;
            }
            self.clock.advance(31 * 60_000);
            let _ = self.work(None, refresh).await;
        }
        assert!(
            done(&self.gift().await),
            "not reached: {:?}",
            self.gift().await.get("status")
        );
    }
}

fn purchase_posts(world: &World) -> usize {
    world
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.target == "/v1/checkouts/")
        .filter(|r| r.body.as_ref().unwrap()["metadata"]["source"] == "dimabot_gift_purchase")
        .count()
}

fn fulfillment_posts(world: &World) -> usize {
    world
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.target == "/v1/checkouts/")
        .filter(|r| r.body.as_ref().unwrap()["metadata"]["source"] == "dimabot_gift_fulfillment")
        .count()
}

async fn delivered(env: &Env, refresh: &Refresh) {
    env.work_until(refresh, 12, |g| {
        g.get_str("status").ok() == Some("delivered")
    })
    .await;
}

#[tokio::test]
async fn a_gift_is_delivered_once_whatever_runs_after_it() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        env.create(None).await.unwrap();
        assert_eq!(
            purchase_posts(&env.world),
            1,
            "the same request twice: one checkout"
        );
        env.world.pay(&env.gift_id());
        let refresh = Refresh::default();
        delivered(&env, &refresh).await;
        for _ in 0..6 {
            env.clock.advance(31 * 60_000);
            env.work(None, &refresh).await.unwrap();
        }
        assert_eq!(fulfillment_posts(&env.world), 1);
        assert_eq!(env.world.grants_for(CR), 1, "one grant at Polar");
        assert_eq!(
            env.world.count("POST", "/v1/checkouts/client/"),
            1,
            "one confirmation"
        );
        assert_eq!(*refresh.0.lock().unwrap(), 1);
        let gift = env.gift().await;
        assert!(gift.get_datetime("announcedAt").is_ok());
        assert_eq!(env.work(None, &refresh).await.unwrap(), StageEnd::Idle);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn two_purchases_of_one_gift_at_once_make_one_checkout() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        let (a, b) = futures_util::future::join(env.create(None), env.create(None)).await;
        assert_eq!(purchase_posts(&env.world), 1);
        // The loser either sees the stored checkout, recovers it, or is told to retry.
        for result in [a, b] {
            match result {
                Ok(answer) => assert_eq!(answer["checkoutId"], "chk_1"),
                Err(GiftError::Request {
                    status: 409,
                    message,
                }) => {
                    assert!(message.starts_with("Checkout is being prepared"));
                }
                Err(other) => panic!("{other}"),
            }
        }
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn kill_after_the_purchase_claim_never_creates_a_checkout_later() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        let stop = StopAt::new("purchase:claimed");
        assert!(matches!(
            env.create(Some(&stop)).await,
            Err(GiftError::Interrupted(_))
        ));
        let again = env.create(None).await;
        assert!(
            matches!(again, Err(GiftError::Request { status: 409, .. })),
            "{again:?}"
        );
        let refresh = Refresh::default();
        env.clock.advance(60_000);
        env.work(None, &refresh).await.unwrap();
        assert_eq!(
            purchase_posts(&env.world),
            0,
            "nothing was created: no money can move"
        );
        let gift = env.gift().await;
        assert_eq!(gift.get_str("status").ok(), Some("awaiting_payment"));
        assert_eq!(
            gift.get_datetime("nextAttemptAt")
                .unwrap()
                .timestamp_millis(),
            NOW + 120_000
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_lost_or_unreadable_purchase_answer_is_recovered_not_created_again() {
    for fault in [Fault::LoseAnswerAfterCommit, Fault::GarbleAnswerAfterCommit] {
        support::with_mongo(|store| async move {
            let env = Env::new(store).await;
            env.world.fault("POST", "/v1/checkouts/", fault);
            let first = env.create(None).await;
            assert!(
                matches!(
                    first,
                    Err(GiftError::Provider {
                        outcome_unknown: true,
                        ..
                    })
                ),
                "{first:?}"
            );
            let second = env.create(None).await.unwrap();
            assert_eq!(second["checkoutId"], "chk_1");
            assert_eq!(purchase_posts(&env.world), 1);
            // Killed after the POST and before the checkout was stored: the worker recovers it.
            env.world.pay(&env.gift_id());
            let refresh = Refresh::default();
            delivered(&env, &refresh).await;
            assert_eq!(env.world.grants_for(CR), 1);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn the_worker_reconciles_a_checkout_whose_answer_was_lost() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        let stop = StopAt::new("purchase:answered");
        assert!(matches!(
            env.create(Some(&stop)).await,
            Err(GiftError::Interrupted(_))
        ));
        assert!(env.gift().await.get_str("checkoutId").is_err());
        env.world.pay(&env.gift_id());
        let refresh = Refresh::default();
        delivered(&env, &refresh).await;
        assert_eq!(purchase_posts(&env.world), 1);
        assert_eq!(env.world.grants_for(CR), 1);
        Ok(())
    })
    .await
    .unwrap();
}

/// Reference behaviour, kept: a fulfillment whose creation was reserved but cannot be found is
/// never created again; after five failed recoveries the gift is labelled `needs_support` (and
/// keeps being retried every 30 minutes). The buyer paid and the recipient got nothing until
/// support acts: a broken promise, not a double grant. Open question for the owner: re-sending
/// the POST with the same `Idempotency-Key` once the lease has expired would deliver it, if
/// Polar's checkout list is read-after-write consistent.
#[tokio::test]
async fn kill_after_the_fulfillment_reservation_waits_for_support_without_a_second_create() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        env.world.pay(&env.gift_id());
        let refresh = Refresh::default();
        env.work_until(&refresh, 4, |g| g.get_datetime("paidAt").is_ok())
            .await;
        env.clock.advance(60_000);
        let stop = StopAt::new("fulfillment:reserved");
        assert!(matches!(
            env.work(Some(&stop), &refresh).await,
            Err(GiftError::Interrupted(_))
        ));
        // The lease is still held: nobody else takes the gift before it expires.
        env.clock.advance(60_000);
        assert_eq!(env.work(None, &refresh).await.unwrap(), StageEnd::Idle);
        env.work_until(&refresh, 8, |g| {
            g.get_str("status").ok() == Some("needs_support")
        })
        .await;
        let gift = env.gift().await;
        assert_eq!(
            gift.get_str("lastError").ok(),
            Some("Gift fulfillment checkout creation is uncertain; reconciliation required")
        );
        assert_eq!(fulfillment_posts(&env.world), 0);
        assert_eq!(env.world.grants_for(CR), 0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_lost_fulfillment_answer_or_a_kill_after_it_is_recovered_once() {
    for (fault, stop) in [
        (Some(Fault::LoseAnswerAfterCommit), None),
        (Some(Fault::GarbleAnswerAfterCommit), None),
        (None, Some("fulfillment:answered")),
    ] {
        support::with_mongo(|store| async move {
            let env = Env::new(store).await;
            env.create(None).await.unwrap();
            env.world.pay(&env.gift_id());
            let refresh = Refresh::default();
            env.work_until(&refresh, 4, |g| g.get_datetime("paidAt").is_ok())
                .await;
            if let Some(fault) = fault {
                env.world.fault("POST", "/v1/checkouts/", fault);
            }
            env.clock.advance(60_000);
            let stop = stop.map(StopAt::new);
            let _ = env
                .work(stop.as_ref().map(|s| s as &dyn Interrupt), &refresh)
                .await;
            delivered(&env, &refresh).await;
            assert_eq!(fulfillment_posts(&env.world), 1);
            assert_eq!(env.world.grants_for(CR), 1);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn a_kill_around_the_confirmation_or_the_delivery_grants_once() {
    for (fault, stop) in [
        (Some(Fault::LoseAnswerAfterCommit), None),
        (None, Some("confirm:answered")),
        (None, Some("deliver:refreshed")),
        (Some(Fault::Status(502)), None),
    ] {
        support::with_mongo(|store| async move {
            let env = Env::new(store).await;
            env.create(None).await.unwrap();
            env.world.pay(&env.gift_id());
            let refresh = Refresh::default();
            env.work_until(&refresh, 6, |g| g.get_str("fulfillmentCheckoutId").is_ok())
                .await;
            if let Some(fault) = fault {
                env.world.fault("POST", "/v1/checkouts/client/", fault);
            }
            let stop = stop.map(StopAt::new);
            for _ in 0..3 {
                env.clock.advance(31 * 60_000);
                let _ = env
                    .work(stop.as_ref().map(|s| s as &dyn Interrupt), &refresh)
                    .await;
            }
            delivered(&env, &refresh).await;
            assert_eq!(env.world.grants_for(CR), 1);
            assert!(env.world.count("POST", "/v1/checkouts/client/") <= 2);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn two_workers_at_once_take_one_gift() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        env.world.pay(&env.gift_id());
        let refresh = Refresh::default();
        for _ in 0..8 {
            env.clock.advance(31 * 60_000);
            let (a, b) =
                futures_util::future::join(env.work(None, &refresh), env.work(None, &refresh))
                    .await;
            let taken = [a, b]
                .into_iter()
                .filter(|r| matches!(r, Ok(StageEnd::Processed)))
                .count();
            assert!(taken <= 1, "both workers took the gift");
        }
        delivered(&env, &refresh).await;
        assert_eq!(fulfillment_posts(&env.world), 1);
        assert_eq!(env.world.grants_for(CR), 1);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_stage_past_its_deadline_is_dropped_and_its_lease_expires() {
    support::with_mongo(|store| async move {
        let mut env = Env::new(store).await;
        env.config.stage_deadline = std::time::Duration::from_millis(300);
        env.create(None).await.unwrap();
        env.world.pay(&env.gift_id());
        // Polar hangs on the order lookup: the stage is dropped at its deadline.
        env.server.push(
            dima_http::testing::MockResponse::json(200, "{}")
                .delay(std::time::Duration::from_secs(5)),
        );
        let refresh = Refresh::default();
        env.clock.advance(60_000);
        let late = env.work(None, &refresh).await;
        assert!(
            matches!(late, Err(GiftError::Failed(ref m)) if m.contains("deadline")),
            "{late:?}"
        );
        assert!(
            env.gift().await.get_str("leaseToken").is_ok(),
            "the lease stays until it expires"
        );
        env.clock.advance(60_000);
        assert_eq!(env.work(None, &refresh).await.unwrap(), StageEnd::Idle);
        env.clock.advance(61_000);
        assert_eq!(env.work(None, &refresh).await.unwrap(), StageEnd::Processed);
        Ok(())
    })
    .await
    .unwrap();
}

// ------------------------------------------------------------------------------------- abuse

/// A forged or foreign paid order is never trusted: the webhook gives only an order id, the
/// order is read from Polar and checked against the stored gift and its checkout.
#[tokio::test]
async fn a_paid_order_that_does_not_match_the_gift_is_refused() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        let order = env.world.pay(&env.gift_id());
        let id = order["id"].as_str().unwrap().to_owned();
        for (field, value) in [
            ("refunded_amount", serde_json::json!(999)),
            ("discount_amount", serde_json::json!(500)),
            ("customer_id", serde_json::json!("a1b2c3d4-0000-4000-8000-0000000000ff")),
            ("total_amount", serde_json::json!(0)),
            ("checkout_id", serde_json::json!("chk_other")),
            ("subscription_id", serde_json::json!("sub_1")),
            ("currency", serde_json::json!("eur")),
        ] {
            {
                let mut state = env.world.state.lock().unwrap();
                let stored = state.orders.iter_mut().find(|o| o["id"] == id.as_str()).unwrap();
                *stored = order.clone();
                stored[field] = value;
            }
            let refused = env
                .run(None, async |gifts| accept_credit_gift_paid_order(gifts, &id).await)
                .await;
            assert!(
                matches!(refused, Err(GiftError::Failed(ref m)) if m == "Gift paid order identity or payment mismatch"),
                "{field}: {refused:?}"
            );
            assert!(env.gift().await.get_datetime("paidAt").is_err(), "{field}");
        }
        Ok(())
    })
    .await
    .unwrap();
}

/// An order refunded after payment is not fulfilled: the paid order is checked again before
/// the first benefit-bearing checkout is created.
#[tokio::test]
async fn an_order_refunded_before_fulfillment_is_not_fulfilled() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        let order = env.world.pay(&env.gift_id());
        let refresh = Refresh::default();
        env.work_until(&refresh, 4, |g| g.get_datetime("paidAt").is_ok())
            .await;
        {
            let mut state = env.world.state.lock().unwrap();
            let stored = state
                .orders
                .iter_mut()
                .find(|o| o["id"] == order["id"])
                .unwrap();
            stored["refunded_amount"] = serde_json::json!(999);
        }
        for _ in 0..6 {
            env.clock.advance(31 * 60_000);
            env.work(None, &refresh).await.unwrap();
        }
        assert_eq!(fulfillment_posts(&env.world), 0);
        assert_eq!(
            env.gift().await.get_str("status").ok(),
            Some("needs_support")
        );
        Ok(())
    })
    .await
    .unwrap();
}

/// A gift request id cannot be reused to send the paid gift to someone else, and the buyer
/// cannot gift to themselves.
#[tokio::test]
async fn a_gift_cannot_change_recipient_or_go_to_the_buyer() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        env.create(None).await.unwrap();
        let other = ObjectId::new();
        env.store
            .documents("users")
            .insert_one(user_document(
                other,
                "9203",
                "Other",
                Some("a1b2c3d4-0000-4000-8000-000000000003"),
            ))
            .await
            .unwrap();
        env.world.state.lock().unwrap().customers.push((
            "a1b2c3d4-0000-4000-8000-000000000003".into(),
            other.to_hex(),
        ));
        let buyer = env.user(env.buyer).await;
        for (recipient, status) in [(other.to_hex(), 409_u16), (env.buyer.to_hex(), 400)] {
            let result = env
                .run(None, async |gifts| {
                    create_credit_gift_checkout(
                        gifts,
                        CheckoutRequest {
                            user: &buyer,
                            product_id: PAIRS[0].0,
                            recipient_id: &recipient,
                            request_id: REQUEST,
                            acknowledge_no_refunds: true,
                            success_url: None,
                            return_url: None,
                        },
                    )
                    .await
                })
                .await;
            assert!(
                matches!(result, Err(GiftError::Request { status: s, .. }) if s == status),
                "{result:?}"
            );
        }
        assert_eq!(purchase_posts(&env.world), 1);
        Ok(())
    })
    .await
    .unwrap();
}

/// Reference behaviour, kept: a gift to another account the buyer controls is a normal gift
/// (paid with money at the gift pack's price); only the same account is refused.
#[tokio::test]
async fn a_gift_to_a_second_account_is_a_normal_paid_gift() {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await;
        // The recipient shares the buyer's e-mail: nothing in the reference links them.
        env.store
            .documents("users")
            .update_one(
                doc! { "_id": env.recipient },
                doc! { "$set": { "email": "buyer@example.test" } },
            )
            .await
            .unwrap();
        assert!(env.create(None).await.is_ok());
        Ok(())
    })
    .await
    .unwrap();
}

#[test]
fn gift_values_never_print_secrets() {
    let value = dima_billing::gifts::GiftValue(serde_json::json!({
        "client_secret": "polar_c_secret1", "url": "https://x/polar_c_secret1", "customer_email": "a@b.c",
    }));
    let printed = format!("{value:?}");
    assert!(!printed.contains("secret") || printed.contains("redacted"));
    assert!(!printed.contains("a@b.c") && !printed.contains("polar_c_secret1"));
    let response = dima_billing::gifts::CheckoutResponse {
        gift_id: "g".into(),
        checkout_id: Some("chk".into()),
        checkout_url: dima_model::Private::from("https://x/polar_c_secret1".to_owned()),
        offer: dima_billing::gifts::GiftOffer {
            id: "p".into(),
            name: "n".into(),
            credits: 1.0,
            price_amount: 1.0,
            price_currency: "usd".into(),
        },
        recipient: dima_billing::gifts::GiftRecipient {
            id: "r".into(),
            login: "l".into(),
            display_name: "d".into(),
        },
    };
    assert!(!format!("{response:?}").contains("polar_c_secret1"));
}
