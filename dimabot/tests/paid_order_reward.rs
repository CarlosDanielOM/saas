#![cfg(feature = "paid-order-reward")]

//! Parity checks for the paid-order reward adapter
//! (`dimabot/src/utils/paid_order_reward.ts`).
//!
//! Everything below the ignored fixture test is pure: no MongoDB, Redis,
//! network, or filesystem. It pins the source's observable strings, filters, and
//! idempotency rules. The end-to-end adapter test is `#[ignore]`d and requires an
//! explicitly provided disposable database; nothing here has been executed by
//! the author.

use dima_rust::{
    schemas::credit_transaction::RewardTargetType,
    utils::{
        paid_order_reward::{
            BeneficiaryResolution, IDEMPOTENCY_PREFIX, PaidOrderRewardError, PaidOrderRewardInput,
            ReservationTerms, already_credited_filter, applied_filter, applied_update,
            beneficiary_resolution, bot_account_filter, idempotency_key, is_duplicate_key_code,
            journaled_write_concern, legacy_reward_filter, parse_cadence, referral_code_filter,
            referrer_candidate, reservation_applied, reservation_filter, reservation_update,
            reward_description, reward_plan_amount, stored_number, user_credit_filter,
            user_credit_update, validate_order_id,
        },
        referral::{
            PRODUCT_ID_FREE, PRODUCT_ID_PREMIUM, PRODUCT_ID_PRO, PlanType, SubscriptionCadence,
        },
    },
};
use mongodb::{
    bson::{Bson, DateTime, doc, oid::ObjectId},
    options::Acknowledgment,
};

const NOW: i64 = 1_900_000_000_000;

fn now() -> DateTime {
    DateTime::from_millis(NOW)
}

#[test]
fn idempotency_key_uses_the_source_prefix_and_raw_order_id() {
    assert_eq!(IDEMPOTENCY_PREFIX, "polar:paid-order:");
    assert_eq!(idempotency_key("ord_123"), "polar:paid-order:ord_123");
    // Only the emptiness gate trims; the key embeds the raw value.
    assert_eq!(idempotency_key(" ord_123 "), "polar:paid-order: ord_123 ");
}

#[test]
fn empty_and_whitespace_order_ids_fail_with_the_source_message() {
    // `\u{00a0}` and `\u{feff}` are JavaScript whitespace; `\u{0085}` is not.
    for order_id in ["", " ", "\t\n", "\u{00a0}", "\u{feff}"] {
        let error = validate_order_id(order_id).expect_err("must reject empty order id");
        assert!(matches!(&error, PaidOrderRewardError::MissingOrderId));
        assert_eq!(
            error.to_string(),
            "Paid order reward requires an order ID"
        );
    }
    assert!(validate_order_id("ord_123").is_ok());
    assert!(validate_order_id("  ord_123  ").is_ok());
    assert!(validate_order_id("\u{0085}").is_ok());
}

#[test]
fn a_zero_reward_plan_never_reaches_the_reservation() {
    // `PlanType::Free` yields `amount == 0`, so the source returns before any
    // lookup or upsert.
    assert_eq!(reward_plan_amount(PRODUCT_ID_FREE, SubscriptionCadence::Monthly), None);
    assert_eq!(reward_plan_amount(PRODUCT_ID_FREE, SubscriptionCadence::Yearly), None);
    // An unknown product id resolves to Free as well.
    assert_eq!(reward_plan_amount("not-a-plan-product", SubscriptionCadence::Monthly), None);
}

#[test]
fn paid_plans_use_the_shared_reward_table() {
    assert_eq!(
        reward_plan_amount(PRODUCT_ID_PREMIUM, SubscriptionCadence::Monthly),
        Some((PlanType::Premium, 50))
    );
    assert_eq!(
        reward_plan_amount(PRODUCT_ID_PREMIUM, SubscriptionCadence::Yearly),
        Some((PlanType::Premium, 500))
    );
    assert_eq!(
        reward_plan_amount(PRODUCT_ID_PRO, SubscriptionCadence::Monthly),
        Some((PlanType::Pro, 100))
    );
    assert_eq!(
        reward_plan_amount(PRODUCT_ID_PRO, SubscriptionCadence::Yearly),
        Some((PlanType::Pro, 1000))
    );
}

#[test]
fn descriptions_match_the_typescript_template() {
    for (plan, plan_text) in [
        (PlanType::Free, "FREE"),
        (PlanType::Premium, "PREMIUM"),
        (PlanType::Pro, "PRO"),
    ] {
        assert_eq!(
            reward_description(plan, SubscriptionCadence::Monthly),
            format!("Subscription reward for {plan_text} (monthly)")
        );
        assert_eq!(
            reward_description(plan, SubscriptionCadence::Yearly),
            format!("Subscription reward for {plan_text} (yearly)")
        );
    }
    assert_eq!(
        reward_description(PlanType::Premium, SubscriptionCadence::Monthly),
        "Subscription reward for PREMIUM (monthly)"
    );
}

#[test]
fn legacy_guard_filter_excludes_our_own_idempotency_key() {
    let key = idempotency_key("ord_9");
    let filter = legacy_reward_filter("ord_9", &key);
    assert_eq!(
        filter,
        doc! {
            "type": "subscription_reward",
            "metadata.subscriptionId": "ord_9",
            "idempotencyKey": { "$ne": key.as_str() },
        }
    );
    // The `$ne` value is our own key, so a concurrent RESERVED row for this
    // order cannot count as evidence that credit was already applied.
    let excluded = filter
        .get_document("idempotencyKey")
        .expect("idempotencyKey condition");
    assert_eq!(excluded.get_str("$ne"), Ok(key.as_str()));
    assert!(!excluded.contains_key("$eq"));
    assert!(!excluded.contains_key("$exists"));
}

#[test]
fn beneficiary_table_prefers_a_live_referrer_only() {
    let referrer = ObjectId::new();
    let payer_with_referral = doc! {
        "_id": ObjectId::new(),
        "referrerId": referrer,
        "referralCodeUsed": "promo_1",
    };
    let payer_without_referrer_id = doc! {
        "_id": ObjectId::new(),
        "referrerId": Bson::Null,
        "referralCodeUsed": "promo_1",
    };
    let payer_without_code = doc! {
        "_id": ObjectId::new(),
        "referrerId": referrer,
        "referralCodeUsed": Bson::Null,
    };
    let payer_with_empty_code = doc! {
        "_id": ObjectId::new(),
        "referrerId": referrer,
        "referralCodeUsed": "",
    };

    assert_eq!(referrer_candidate(&payer_with_referral), Some((referrer, "promo_1")));
    assert_eq!(
        beneficiary_resolution(&payer_with_referral, true, true),
        BeneficiaryResolution::Referrer(referrer)
    );
    // The lookup has to match and the referrer has to still exist.
    assert_eq!(
        beneficiary_resolution(&payer_with_referral, false, true),
        BeneficiaryResolution::Bot
    );
    assert_eq!(
        beneficiary_resolution(&payer_with_referral, true, false),
        BeneficiaryResolution::Bot
    );
    // Both payer fields are required for the referrer path.
    assert_eq!(
        beneficiary_resolution(&payer_without_referrer_id, true, true),
        BeneficiaryResolution::Bot
    );
    assert_eq!(
        beneficiary_resolution(&payer_without_code, true, true),
        BeneficiaryResolution::Bot
    );
    assert_eq!(
        beneficiary_resolution(&payer_with_empty_code, true, true),
        BeneficiaryResolution::Bot
    );
    assert_eq!(referrer_candidate(&payer_without_code), None);
    assert_eq!(referrer_candidate(&payer_with_empty_code), None);
}

#[test]
fn beneficiary_lookups_keep_the_source_filters() {
    let owner = ObjectId::new();
    assert_eq!(
        referral_code_filter("PROMO_1", owner),
        doc! { "code": "promo_1", "owner": owner, "active": true }
    );
    assert_eq!(
        bot_account_filter(),
        doc! {
            "accounts": { "$elemMatch": { "type": "twitch", "name": "domdimabot" } },
        }
    );
}

#[test]
fn reservation_upsert_reproduces_defaults_and_timestamps() {
    let beneficiary = ObjectId::new();
    let payer = ObjectId::new();
    let key = idempotency_key("ord_7");
    let update = reservation_update(&ReservationTerms {
        idempotency_key: &key,
        order_id: "ord_7",
        product_id: PRODUCT_ID_PREMIUM,
        beneficiary_id: beneficiary,
        payer_id: payer,
        referral_code_used: None,
        reward_target_type: RewardTargetType::Bot,
        plan: PlanType::Premium,
        cadence: SubscriptionCadence::Monthly,
        amount: 50,
        created_at: now(),
    });

    let insert = update.get_document("$setOnInsert").expect("$setOnInsert");
    assert_eq!(
        insert,
        &doc! {
            "idempotencyKey": key.as_str(),
            "user": beneficiary,
            "type": "subscription_reward",
            // Node's BSON writer encodes an integral reward amount as Int32.
            "amount": 50,
            "metadata": {
                "referralCodeUsed": Bson::Null,
                "referredUserId": payer,
                "subscriptionId": "ord_7",
                "planId": PRODUCT_ID_PREMIUM,
                "description": "Subscription reward for PREMIUM (monthly)",
                "externalReference": key.as_str(),
                "rewardTargetType": "bot",
            },
            // `setDefaultsOnInsert` writes the declared default.
            "balanceAfter": Bson::Null,
            "createdAt": now(),
        }
    );
    // `applyTimestampsToUpdate`: `updatedAt` goes to `$set`, `createdAt` above.
    assert_eq!(update.get_document("$set").expect("$set"), &doc! { "updatedAt": now() });
    // MongoDB generates `_id`; `$setOnInsert` skips the automatic path and
    // `__v` is not a schema path for update documents.
    assert!(!insert.contains_key("_id"));
    assert!(!insert.contains_key("__v"));
    // The finalizing filter relies on `appliedAt` being absent.
    assert!(!insert.contains_key("appliedAt"));
    assert_eq!(reservation_filter(&key), doc! { "idempotencyKey": key.as_str() });
}

#[test]
fn reservation_upsert_keeps_the_referrer_target_and_raw_code_case() {
    let key = idempotency_key("ord_8");
    let update = reservation_update(&ReservationTerms {
        idempotency_key: &key,
        order_id: "ord_8",
        product_id: PRODUCT_ID_PRO,
        beneficiary_id: ObjectId::new(),
        payer_id: ObjectId::new(),
        referral_code_used: Some("Promo_1"),
        reward_target_type: RewardTargetType::Referrer,
        plan: PlanType::Pro,
        cadence: SubscriptionCadence::Yearly,
        amount: 1000,
        created_at: now(),
    });
    let metadata = update
        .get_document("$setOnInsert")
        .and_then(|insert| insert.get_document("metadata"))
        .expect("metadata");
    // `payer.referralCodeUsed` is stored verbatim, not the lowercased lookup key.
    assert_eq!(metadata.get_str("referralCodeUsed"), Ok("Promo_1"));
    assert_eq!(metadata.get_str("rewardTargetType"), Ok("referrer"));
    assert_eq!(metadata.get_str("description"), Ok("Subscription reward for PRO (yearly)"));
}

#[test]
fn user_credit_write_is_one_atomic_update() {
    let user = ObjectId::new();
    let transaction = ObjectId::new();
    assert_eq!(
        user_credit_filter(user, transaction),
        doc! {
            "_id": user,
            "applied_credit_transaction_ids": { "$ne": transaction },
        }
    );
    assert_eq!(
        already_credited_filter(user, transaction),
        doc! {
            "_id": user,
            "applied_credit_transaction_ids": transaction,
        }
    );
    assert_eq!(
        user_credit_update(Bson::Int32(50), transaction, now()),
        doc! {
            "$inc": { "token_balance": 50 },
            "$addToSet": { "applied_credit_transaction_ids": transaction },
            // `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }`.
            "$set": { "updated_at": now() },
        }
    );
}

#[test]
fn applied_receipts_short_circuit_and_replays_never_write_balance_after() {
    assert!(!reservation_applied(&doc! { "idempotencyKey": "k" }));
    assert!(!reservation_applied(&doc! { "appliedAt": Bson::Null }));
    assert!(reservation_applied(&doc! { "appliedAt": now() }));

    let transaction = ObjectId::new();
    assert_eq!(
        applied_filter(transaction),
        doc! { "_id": transaction, "appliedAt": { "$exists": false } }
    );

    // A replay credits nothing, so the finalizing `$set` omits `balanceAfter`.
    let replay = applied_update(None, now());
    let replay_set = replay.get_document("$set").expect("$set");
    assert!(!replay_set.contains_key("balanceAfter"));
    assert_eq!(replay_set, &doc! { "appliedAt": now(), "updatedAt": now() });

    // The crediting call records the post-increment balance.
    let credited = applied_update(Some(Bson::Int32(150)), now());
    assert_eq!(
        credited.get_document("$set").expect("$set"),
        &doc! { "appliedAt": now(), "balanceAfter": 150, "updatedAt": now() }
    );
}

#[test]
fn stored_numbers_round_trip_through_the_node_writer() {
    assert_eq!(stored_number(Some(&Bson::Int32(50))), Some(Bson::Int32(50)));
    assert_eq!(stored_number(Some(&Bson::Int64(500))), Some(Bson::Int32(500)));
    assert_eq!(stored_number(Some(&Bson::Double(100.0))), Some(Bson::Int32(100)));
    assert_eq!(stored_number(Some(&Bson::Double(12.5))), Some(Bson::Double(12.5)));
    assert_eq!(stored_number(Some(&Bson::Null)), None);
    assert_eq!(stored_number(None), None);
}

#[test]
fn duplicate_keys_are_detected_by_the_numeric_code_only() {
    assert!(is_duplicate_key_code(11000));
    for code in [0, 2, 11001, 11601, -1] {
        assert!(!is_duplicate_key_code(code));
    }
}

#[test]
fn every_source_journaled_write_is_journaled() {
    let concern = journaled_write_concern();
    assert_eq!(concern.journal, Some(true));
    assert_eq!(concern.w, Some(Acknowledgment::Nodes(1)));
}

#[test]
fn cadence_bridge_accepts_only_the_typescript_union() {
    assert!(matches!(parse_cadence("monthly"), Ok(SubscriptionCadence::Monthly)));
    assert!(matches!(parse_cadence("yearly"), Ok(SubscriptionCadence::Yearly)));
    for invalid in ["Monthly", "MONTHLY", "", "weekly"] {
        let error = parse_cadence(invalid).expect_err("must reject");
        assert!(matches!(error, PaidOrderRewardError::InvalidCadence(_)));
    }
    let bridged =
        PaidOrderRewardInput::from_cadence_str("owner", "ord_1", PRODUCT_ID_PRO, "yearly")
            .expect("valid cadence");
    assert_eq!(
        bridged,
        PaidOrderRewardInput::new("owner", "ord_1", PRODUCT_ID_PRO, SubscriptionCadence::Yearly)
    );
}

#[test]
fn source_error_messages_are_preserved() {
    let cases = [
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
    ];
    for (error, message) in cases {
        assert_eq!(error.to_string(), message);
    }
}

/// End-to-end adapter coverage in a disposable database.
///
/// Contract: the test never runs by default and never touches production.
/// Set both variables to a task-owned instance and a fresh database whose name
/// carries the required prefix; the test refuses anything else.
///
/// * `PAID_ORDER_REWARD_TEST_MONGO_URI` — isolated MongoDB URI
/// * `PAID_ORDER_REWARD_TEST_DATABASE` — fresh database named
///   `rust_paid_order_reward_fixture_*`
#[tokio::test]
#[ignore = "requires a task-owned disposable MongoDB fixture"]
async fn paid_order_reward_adapter_against_a_disposable_database() {
    use dima_rust::{
        schemas::{credit_transaction, referral_code, users},
        utils::paid_order_reward::PaidOrderRewardService,
    };
    use mongodb::Client;
    use std::env;

    let uri = env::var("PAID_ORDER_REWARD_TEST_MONGO_URI")
        .expect("explicit task-owned MongoDB URI");
    let name = env::var("PAID_ORDER_REWARD_TEST_DATABASE")
        .expect("explicit task-owned MongoDB database");
    assert!(
        name.starts_with("rust_paid_order_reward_fixture_"),
        "task database must be task-owned"
    );
    let client = Client::with_uri_str(&uri).await.expect("connect");
    let database = client.database(&name);
    assert!(
        database.list_collection_names().await.expect("list").is_empty(),
        "task database must be fresh"
    );

    let service = PaidOrderRewardService::new(database.clone());
    credit_transaction::schema()
        .install_indexes(&database)
        .await
        .expect("credit transaction indexes");

    let payer = ObjectId::new();
    let referrer = ObjectId::new();
    let bot = ObjectId::new();
    let people = users::schema().native_collection(&database);
    people
        .insert_one(doc! {
            "_id": payer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
            "referrerId": referrer,
            "referralCodeUsed": "promo_1",
        })
        .await
        .expect("payer fixture");
    people
        .insert_one(doc! {
            "_id": referrer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
        })
        .await
        .expect("referrer fixture");
    people
        .insert_one(doc! {
            "_id": bot,
            "accounts": [{ "type": "twitch", "name": "domdimabot" }],
            "token_balance": 0,
        })
        .await
        .expect("bot fixture");
    referral_code::schema()
        .native_collection(&database)
        .insert_one(doc! { "code": "promo_1", "owner": referrer, "active": true })
        .await
        .expect("referral code fixture");

    let transactions = credit_transaction::schema().native_collection(&database);

    // Referrer path: reserve, credit once, and finalize the receipt.
    let paid = PaidOrderRewardInput::new(
        payer.to_hex(),
        "order-1",
        PRODUCT_ID_PREMIUM,
        SubscriptionCadence::Monthly,
    );
    service.apply_paid_order_reward(&paid).await.expect("first apply");
    let reservation = transactions
        .find_one(doc! { "idempotencyKey": idempotency_key("order-1") })
        .await
        .expect("read reservation")
        .expect("reservation exists");
    assert_eq!(reservation.get_str("type").expect("type"), "subscription_reward");
    assert_eq!(reservation.get_i32("amount").expect("amount"), 50);
    assert_eq!(reservation.get_i32("balanceAfter").expect("balanceAfter"), 50);
    assert!(reservation_applied(&reservation));
    let metadata = reservation.get_document("metadata").expect("metadata");
    assert_eq!(metadata.get_str("rewardTargetType").expect("target"), "referrer");
    assert_eq!(metadata.get_str("externalReference").expect("reference"), "polar:paid-order:order-1");
    let credited = people
        .find_one(doc! { "_id": referrer })
        .await
        .expect("read referrer")
        .expect("referrer exists");
    assert_eq!(credited.get_i32("token_balance").expect("balance"), 50);

    // Replay: no second credit and no reconstructed balance.
    service.apply_paid_order_reward(&paid).await.expect("replay");
    let replayed = people
        .find_one(doc! { "_id": referrer })
        .await
        .expect("read referrer")
        .expect("referrer exists");
    assert_eq!(replayed.get_i32("token_balance").expect("balance"), 50);
    assert_eq!(
        transactions
            .count_documents(doc! { "type": "subscription_reward" })
            .await
            .expect("count"),
        1
    );

    // Free plan: the source returns before creating a reservation.
    let free = PaidOrderRewardInput::new(
        payer.to_hex(),
        "order-free",
        PRODUCT_ID_FREE,
        SubscriptionCadence::Yearly,
    );
    service.apply_paid_order_reward(&free).await.expect("free plan");
    assert!(
        transactions
            .find_one(doc! { "idempotencyKey": idempotency_key("order-free") })
            .await
            .expect("read free reservation")
            .is_none()
    );

    // Legacy guard: an old row carrying the order id blocks a reservation.
    transactions
        .insert_one(doc! {
            "_id": ObjectId::new(),
            "user": bot,
            "type": "subscription_reward",
            "amount": 50,
            "metadata": { "subscriptionId": "order-legacy" },
        })
        .await
        .expect("legacy fixture");
    let legacy = PaidOrderRewardInput::new(
        payer.to_hex(),
        "order-legacy",
        PRODUCT_ID_PRO,
        SubscriptionCadence::Monthly,
    );
    service.apply_paid_order_reward(&legacy).await.expect("legacy guard");
    assert!(
        transactions
            .find_one(doc! { "idempotencyKey": idempotency_key("order-legacy") })
            .await
            .expect("read legacy reservation")
            .is_none()
    );

    // Bot path: a payer without a referral code credits the bot account.
    let bot_payer = ObjectId::new();
    people
        .insert_one(doc! {
            "_id": bot_payer,
            "accounts": Bson::Array(Vec::new()),
            "token_balance": 0,
            "referrerId": Bson::Null,
            "referralCodeUsed": Bson::Null,
        })
        .await
        .expect("bot payer fixture");
    let bot_input = PaidOrderRewardInput::new(
        bot_payer.to_hex(),
        "order-bot",
        PRODUCT_ID_PRO,
        SubscriptionCadence::Yearly,
    );
    service
        .apply_paid_order_reward(&bot_input)
        .await
        .expect("bot path");
    let bot_user = people
        .find_one(doc! { "_id": bot })
        .await
        .expect("read bot")
        .expect("bot exists");
    assert_eq!(bot_user.get_i32("token_balance").expect("balance"), 1000);
    let bot_reservation = transactions
        .find_one(doc! { "idempotencyKey": idempotency_key("order-bot") })
        .await
        .expect("read bot reservation")
        .expect("bot reservation exists");
    assert_eq!(
        bot_reservation
            .get_document("metadata")
            .expect("metadata")
            .get_str("rewardTargetType")
            .expect("target"),
        "bot"
    );

    // Source error messages.
    let canonical = PaidOrderRewardInput::new(
        "not-an-object-id",
        "order-2",
        PRODUCT_ID_PRO,
        SubscriptionCadence::Monthly,
    );
    assert_eq!(
        service.apply_paid_order_reward(&canonical).await.expect_err("invalid owner").to_string(),
        "Paid order reward requires a canonical owner user ID"
    );
    let unknown = PaidOrderRewardInput::new(
        ObjectId::new().to_hex(),
        "order-3",
        PRODUCT_ID_PRO,
        SubscriptionCadence::Monthly,
    );
    assert_eq!(
        service.apply_paid_order_reward(&unknown).await.expect_err("missing owner").to_string(),
        "Paid order reward owner not found"
    );
    let blank = PaidOrderRewardInput::new(
        payer.to_hex(),
        "   ",
        PRODUCT_ID_PRO,
        SubscriptionCadence::Monthly,
    );
    assert_eq!(
        service.apply_paid_order_reward(&blank).await.expect_err("blank order").to_string(),
        "Paid order reward requires an order ID"
    );
}
