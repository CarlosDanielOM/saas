//! Integration tests for schema named types and an optional pinned source oracle.
//! The oracle is generated separately and passed as SCHEMA_NAMED_TYPES_FIXTURE and
//! SCHEMA_NAMED_TYPES_SHA256; this test never starts Node or accesses a database.
#![cfg(feature = "application-schemas")]
#[path = "support/schema_source.rs"]
mod schema_source;
use dima_rust::schemas::{accounts, admin, credit_gift, credit_transaction};
use dima_rust::utils::js_string::JsString;
use mongodb::bson::{self, DateTime, doc, oid::ObjectId};
use std::{path::Path, str::FromStr};

#[test]
fn named_type_sources_are_archived_and_pinned() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (logical, _) in schema_source::PINS.iter().skip(5) {
        schema_source::archived(root, logical);
    }
}

#[test]
#[ignore = "requires pinned external source fixture and SHA-256"]
fn source_oracle_and_catalogs() {
    let fixture =
        std::env::var("SCHEMA_NAMED_TYPES_FIXTURE").expect("absolute oracle fixture path");
    let fixture_path = Path::new(&fixture);
    assert!(fixture_path.is_absolute());
    assert_eq!(fixture_path.canonicalize().unwrap(), fixture_path);
    assert!(
        !fixture_path.starts_with(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let bytes = std::fs::read(fixture).unwrap();
    assert_eq!(
        schema_source::sha256(&bytes),
        std::env::var("SCHEMA_NAMED_TYPES_SHA256").unwrap()
    );
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources = value["sources"].as_object().unwrap();
    assert_eq!(sources.len(), 4);
    for (logical, pin) in schema_source::PINS.iter().skip(5) {
        let source = schema_source::archived(root, logical);
        assert_eq!(sources[*logical], *pin);
        assert_eq!(schema_source::sha256(&source), *pin);
        assert_eq!(
            value["provenance"][*logical],
            schema_source::provenance(logical)
        );
    }
    let hashes = value["hashes"].as_object().unwrap();
    let expected_hashes = [
        "src/schemas/admin.schema.rs",
        "src/schemas/accounts.schema.rs",
        "src/schemas/credit_gift.schema.rs",
        "src/schemas/credit_transaction.schema.rs",
        "src/schemas/schema.rs",
        "src/utils/js_string.rs",
        "tests/fixtures/schema_named_types_reference.cjs",
        "tests/fixtures/schema_source_resolver.cjs",
        "tests/schema_named_types.rs",
        "tests/support/schema_source.rs",
        "tests/support/sha256.rs",
    ];
    assert_eq!(hashes.len(), expected_hashes.len());
    for path in expected_hashes {
        assert_eq!(
            schema_source::sha256(&std::fs::read(root.join(path)).unwrap()),
            hashes[path].as_str().unwrap(),
            "{path}"
        );
    }
    // Every source property, spelling, declaration type and optional marker is checked.
    type MemberSpec = (&'static str, &'static str, bool);
    type InterfaceSpec = (&'static str, &'static [MemberSpec]);
    let expected: &[InterfaceSpec] = &[
        (
            "IAdmin",
            &[
                ("_id", "Types.ObjectId", false),
                ("adminName", "string", false),
                ("adminID", "string", false),
                ("channelName", "string", false),
                ("channelID", "string", false),
                (
                    "role",
                    "'creator' | 'super' | 'support' | 'billing' | 'channel'",
                    true,
                ),
                ("actived", "boolean", false),
                ("permissions", "string[]", false),
                ("createdAt", "Date", false),
                ("updatedAt", "Date", false),
            ],
        ),
        (
            "IAccounts",
            &[
                ("_id", "Types.ObjectId", false),
                ("user_id", "string", false),
                ("user_login", "string", false),
                ("user_email", "string", false),
                ("channelID", "string", false),
                ("channelName", "string", false),
                ("user_type", "string", false),
                ("user_token", "{ iv: string; content: string }", false),
                (
                    "user_refresh_token",
                    "{ iv: string; content: string }",
                    false,
                ),
                ("createdAt", "Date", false),
            ],
        ),
        (
            "ICreditGift",
            &[
                ("_id", "string", false),
                ("buyerId", "Types.ObjectId", false),
                ("recipientId", "Types.ObjectId", false),
                ("buyerLogin", "string", false),
                ("recipientLogin", "string", false),
                ("recipientName", "string", false),
                ("recipientChannelId", "string", false),
                ("productId", "string", false),
                ("fulfillmentProductId", "string", false),
                ("benefitId", "string", false),
                ("credits", "number", false),
                ("priceAmount", "number", false),
                ("priceCurrency", "string", false),
                ("status", "CreditGiftStatus", false),
                ("noRefundsAcknowledgedAt", "Date", false),
                ("purchaseCreateStartedAt", "Date", true),
                ("checkoutId", "string", true),
                ("checkoutUrl", "string", true),
                ("paidOrderId", "string", true),
                ("buyerCustomerId", "string", true),
                ("paidAt", "Date", true),
                ("fulfillmentCreateStartedAt", "Date", true),
                ("fulfillmentCheckoutId", "string", true),
                ("fulfillmentOrderId", "string", true),
                ("recipientCustomerId", "string", true),
                ("grantId", "string", true),
                ("deliveredAt", "Date", true),
                ("announcedAt", "Date", true),
                ("announcementMessageId", "string", true),
                ("announcementStoppedAt", "Date", true),
                ("announcementAttempts", "number", false),
                ("attempts", "number", false),
                ("nextAttemptAt", "Date", false),
                ("lastError", "string", true),
                ("leaseToken", "string", true),
                ("leaseUntil", "Date", true),
                ("createdAt", "Date", false),
                ("updatedAt", "Date", false),
            ],
        ),
        (
            "ICreditTransactionMetadata",
            &[
                ("referralCodeUsed", "string", true),
                ("referredUserId", "Types.ObjectId", true),
                ("subscriptionId", "string", true),
                ("planId", "string", true),
                ("description", "string", true),
                ("externalReference", "string", true),
                ("rewardTargetType", "'bot' | 'referrer'", true),
            ],
        ),
        (
            "ICreditTransaction",
            &[
                ("_id", "Types.ObjectId", false),
                ("user", "Types.ObjectId", false),
                ("type", "TransactionType", false),
                ("amount", "number", false),
                ("idempotencyKey", "string", true),
                ("appliedAt", "Date", true),
                ("balanceAfter", "number", true),
                ("metadata", "ICreditTransactionMetadata", false),
                ("createdAt", "Date", false),
                ("updatedAt", "Date", false),
            ],
        ),
    ];
    for (name, members) in expected {
        let actual = value["declarations"][name]["members"].as_array().unwrap();
        assert_eq!(actual.len(), members.len(), "{name}");
        for (item, (field, ty, optional)) in actual.iter().zip(members.iter()) {
            assert_eq!(item["name"].as_str(), Some(*field));
            assert_eq!(item["type"].as_str(), Some(*ty));
            assert_eq!(item["optional"].as_bool(), Some(*optional));
        }
        assert_eq!(
            value["signatures"][name].as_array().unwrap().len(),
            members.len()
        );
    }
    let strings = |key: &str| -> Vec<String> {
        value["catalogs"][key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        strings("adminRoles"),
        admin::ADMIN_ROLES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        strings("giftStatuses"),
        credit_gift::CREDIT_GIFT_STATUSES
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        strings("rewardTargets"),
        vec!["bot".to_owned(), "referrer".to_owned()]
    );
    let transaction_values: Vec<_> = value["catalogs"]["transactionTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["value"].as_str().unwrap())
        .collect();
    assert_eq!(transaction_values, credit_transaction::TRANSACTION_TYPES);
    let transaction_keys: Vec<_> = value["catalogs"]["transactionTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        transaction_keys,
        vec![
            "REFERRAL_BONUS",
            "REFERRAL_PAYOUT",
            "SUBSCRIPTION_REWARD",
            "MANUAL_CREDIT",
            "MANUAL_DEBIT"
        ]
    );
    for case in value["bsonStrings"].as_array().unwrap() {
        let units: Vec<u16> = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();
        let value = JsString::from_units(units.clone());
        assert_eq!(value.units(), units);
        let bytes = bson::serialize_to_vec(&doc! { "value": value.to_utf8_lossy() }).unwrap();
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["bsonHex"].as_str().unwrap());
        let expected: Vec<u16> = case["outputUnits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u16)
            .collect();
        assert_eq!(JsString::from(value.to_utf8_lossy()).units(), expected);
    }
    for case in value["bsonNumbers"].as_array().unwrap() {
        let number = match case["name"].as_str().unwrap() {
            "nan" => f64::NAN,
            "positiveInfinity" => f64::INFINITY,
            "negativeInfinity" => f64::NEG_INFINITY,
            "negativeZero" => -0.0,
            "fraction" => 1.5,
            other => panic!("unexpected numeric case {other}"),
        };
        let bytes = bson::serialize_to_vec(&doc! { "value": number }).unwrap();
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["bsonHex"].as_str().unwrap());
    }
    assert_eq!(admin::AdminRole::ALL.len(), admin::ADMIN_ROLES.len());
    assert_eq!(
        credit_gift::CreditGiftStatus::ALL.len(),
        credit_gift::CREDIT_GIFT_STATUSES.len()
    );
    assert_eq!(
        credit_transaction::TransactionType::ALL.len(),
        credit_transaction::TRANSACTION_TYPES.len()
    );
    for (value, wire) in admin::AdminRole::ALL.into_iter().zip(admin::ADMIN_ROLES) {
        assert_eq!(value.as_str(), *wire);
        assert_eq!(admin::AdminRole::from_str(wire), Ok(value));
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(encoded, format!("\"{wire}\""));
        assert_eq!(
            serde_json::from_str::<admin::AdminRole>(&encoded).unwrap(),
            value
        );
    }
    for (value, wire) in credit_gift::CreditGiftStatus::ALL
        .into_iter()
        .zip(credit_gift::CREDIT_GIFT_STATUSES)
    {
        assert_eq!(value.as_str(), *wire);
        assert_eq!(credit_gift::CreditGiftStatus::from_str(wire), Ok(value));
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(encoded, format!("\"{wire}\""));
        assert_eq!(
            serde_json::from_str::<credit_gift::CreditGiftStatus>(&encoded).unwrap(),
            value
        );
    }
    for (value, wire) in credit_transaction::TransactionType::ALL
        .into_iter()
        .zip(credit_transaction::TRANSACTION_TYPES)
    {
        assert_eq!(value.as_str(), *wire);
        assert_eq!(
            credit_transaction::TransactionType::from_str(wire),
            Ok(value)
        );
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(encoded, format!("\"{wire}\""));
        assert_eq!(
            serde_json::from_str::<credit_transaction::TransactionType>(&encoded).unwrap(),
            value
        );
    }
    for value in credit_transaction::RewardTargetType::ALL {
        assert_eq!(
            credit_transaction::RewardTargetType::from_str(value.as_str()),
            Ok(value)
        );
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            format!("\"{}\"", value.as_str())
        );
    }
    assert!(admin::AdminRole::from_str("invalid").is_err());
    assert!(credit_gift::CreditGiftStatus::from_str("invalid").is_err());
    assert!(credit_transaction::TransactionType::from_str("invalid").is_err());
    assert!(credit_transaction::RewardTargetType::from_str("invalid").is_err());
}

#[test]
fn declared_and_stored_document_types_round_trip() {
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let date = DateTime::from_millis(1_900_000_000_000);
    let admin = admin::IAdmin {
        id,
        admin_name: "管理者".into(),
        admin_id: "a".into(),
        channel_name: "c".into(),
        channel_id: "42".into(),
        role: Some(admin::AdminRole::Creator),
        actived: true,
        permissions: vec!["read".into()],
        created_at: date,
        updated_at: date,
    };
    let doc = admin.to_bson_document().unwrap();
    assert_eq!(doc.get_str("adminID").unwrap(), "a");
    assert_eq!(admin::IAdmin::from_bson_document(doc).unwrap(), admin);
    let mut unusual = admin.clone();
    unusual.admin_name = JsString::from_units(vec![0xd800, 0x41, 0xdc00]);
    assert_eq!(unusual.admin_name.units(), vec![0xd800, 0x41, 0xdc00]);
    let unusual_doc = unusual.to_bson_document().unwrap();
    assert_eq!(unusual_doc.get_str("adminName").unwrap(), "�A�");
    assert_eq!(
        admin::IAdmin::from_bson_document(unusual_doc)
            .unwrap()
            .admin_name
            .units(),
        vec![0xfffd, 0x41, 0xfffd]
    );
    let mut missing_role = admin.to_bson_document().unwrap();
    missing_role.remove("role");
    assert_eq!(
        admin::IAdmin::from_bson_document(missing_role)
            .unwrap()
            .role,
        None
    );
    let mut null_role = admin.to_bson_document().unwrap();
    null_role.insert("role", bson::Bson::Null);
    assert!(admin::IAdmin::from_bson_document(null_role).is_err());
    let account_doc = doc! {"_id":id,"user_id":null,"user_login":null,"user_email":null,"channelID":null,"channelName":null,"user_type":"", "createdAt":date};
    let stored: accounts::StoredAccounts =
        bson::deserialize_from_document(account_doc.clone()).unwrap();
    assert_eq!(bson::serialize_to_document(&stored).unwrap(), account_doc);
    assert!(accounts::IAccounts::from_bson_document(account_doc).is_err());
    let token = accounts::AccountToken {
        iv: "iv".into(),
        content: "secret".into(),
    };
    let account = accounts::IAccounts {
        id,
        user_id: "u".into(),
        user_login: "名".into(),
        user_email: "e".into(),
        channel_id: "c".into(),
        channel_name: "n".into(),
        user_type: "".into(),
        user_token: token.clone(),
        user_refresh_token: token,
        created_at: date,
    };
    assert_eq!(
        accounts::IAccounts::from_bson_document(account.to_bson_document().unwrap()).unwrap(),
        account
    );
    let gift = credit_gift::ICreditGift {
        id: "gift".into(),
        buyer_id: id,
        recipient_id: id,
        buyer_login: "buyer".into(),
        recipient_login: "受取人".into(),
        recipient_name: "name".into(),
        recipient_channel_id: "42".into(),
        product_id: "p".into(),
        fulfillment_product_id: "f".into(),
        benefit_id: "b".into(),
        credits: 10.0,
        price_amount: 2.5,
        price_currency: "USD".into(),
        status: credit_gift::CreditGiftStatus::AwaitingPayment,
        no_refunds_acknowledged_at: date,
        purchase_create_started_at: None,
        checkout_id: None,
        checkout_url: Some("private".into()),
        paid_order_id: None,
        buyer_customer_id: None,
        paid_at: None,
        fulfillment_create_started_at: None,
        fulfillment_checkout_id: None,
        fulfillment_order_id: None,
        recipient_customer_id: None,
        grant_id: None,
        delivered_at: None,
        announced_at: None,
        announcement_message_id: None,
        announcement_stopped_at: None,
        announcement_attempts: 0.0,
        attempts: 0.0,
        next_attempt_at: date,
        last_error: None,
        lease_token: None,
        lease_until: None,
        created_at: date,
        updated_at: date,
    };
    let mut gift_doc = gift.to_bson_document().unwrap();
    assert_eq!(gift_doc.get_str("checkoutUrl").unwrap(), "private");
    assert_eq!(
        credit_gift::ICreditGift::from_bson_document(gift_doc.clone()).unwrap(),
        gift
    );
    for field in [
        "purchaseCreateStartedAt",
        "checkoutId",
        "checkoutUrl",
        "paidOrderId",
        "buyerCustomerId",
        "paidAt",
        "fulfillmentCreateStartedAt",
        "fulfillmentCheckoutId",
        "fulfillmentOrderId",
        "recipientCustomerId",
        "grantId",
        "deliveredAt",
        "announcedAt",
        "announcementMessageId",
        "announcementStoppedAt",
        "lastError",
        "leaseToken",
        "leaseUntil",
    ] {
        let mut candidate = gift_doc.clone();
        candidate.remove(field);
        assert!(
            credit_gift::ICreditGift::from_bson_document(candidate.clone()).is_ok(),
            "missing {field}"
        );
        candidate.insert(field, bson::Bson::Null);
        assert!(
            credit_gift::ICreditGift::from_bson_document(candidate).is_err(),
            "null {field}"
        );
    }
    gift_doc.insert("checkoutUrl", bson::Bson::Null);
    assert!(credit_gift::ICreditGift::from_bson_document(gift_doc.clone()).is_err());
    gift_doc.remove("checkoutUrl");
    assert_eq!(
        credit_gift::ICreditGift::from_bson_document(gift_doc)
            .unwrap()
            .checkout_url,
        None
    );
    let stored_tx = doc! {"_id":id, "user":id, "type":"manual_credit", "amount":1.5, "balanceAfter":null, "metadata":{"referralCodeUsed":null, "referredUserId":null, "subscriptionId":null, "planId":null, "description":"", "externalReference":null}, "createdAt":date, "updatedAt":date};
    let stored: credit_transaction::StoredCreditTransaction =
        bson::deserialize_from_document(stored_tx.clone()).unwrap();
    assert_eq!(bson::serialize_to_document(&stored).unwrap(), stored_tx);
    assert!(credit_transaction::ICreditTransaction::from_bson_document(stored_tx).is_err());
    let tx = credit_transaction::ICreditTransaction {
        id,
        user: id,
        transaction_type: credit_transaction::TransactionType::ManualCredit,
        amount: 1.5,
        idempotency_key: None,
        applied_at: None,
        balance_after: None,
        metadata: credit_transaction::ICreditTransactionMetadata {
            referral_code_used: None,
            referred_user_id: Some(id),
            subscription_id: None,
            plan_id: None,
            description: Some("描述".into()),
            external_reference: None,
            reward_target_type: Some(credit_transaction::RewardTargetType::Bot),
        },
        created_at: date,
        updated_at: date,
    };
    let mut tx_doc = tx.to_bson_document().unwrap();
    assert_eq!(
        credit_transaction::ICreditTransaction::from_bson_document(tx_doc.clone()).unwrap(),
        tx
    );
    for field in ["idempotencyKey", "appliedAt", "balanceAfter"] {
        let mut candidate = tx_doc.clone();
        candidate.remove(field);
        assert!(
            credit_transaction::ICreditTransaction::from_bson_document(candidate.clone()).is_ok()
        );
        candidate.insert(field, bson::Bson::Null);
        assert!(
            credit_transaction::ICreditTransaction::from_bson_document(candidate).is_err(),
            "{field}"
        );
    }
    let meta_doc = tx.metadata.to_bson_document().unwrap();
    for field in [
        "referralCodeUsed",
        "referredUserId",
        "subscriptionId",
        "planId",
        "description",
        "externalReference",
        "rewardTargetType",
    ] {
        let mut candidate = meta_doc.clone();
        candidate.remove(field);
        assert!(
            credit_transaction::ICreditTransactionMetadata::from_bson_document(candidate.clone())
                .is_ok()
        );
        candidate.insert(field, bson::Bson::Null);
        assert!(
            credit_transaction::ICreditTransactionMetadata::from_bson_document(candidate).is_err(),
            "{field}"
        );
    }
    tx_doc.insert("balanceAfter", bson::Bson::Null);
    assert!(credit_transaction::ICreditTransaction::from_bson_document(tx_doc).is_err());
    // TypeScript number includes non-finite values even if schema validation rejects NaN.
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0] {
        let mut special = tx.clone();
        special.amount = number;
        let restored = credit_transaction::ICreditTransaction::from_bson_document(
            special.to_bson_document().unwrap(),
        )
        .unwrap();
        if number.is_nan() {
            assert!(restored.amount.is_nan());
        } else {
            assert_eq!(restored.amount.to_bits(), number.to_bits());
        }
    }
}

#[test]
fn descriptor_identity_and_boundaries_stay_intact() {
    use dima_rust::schemas::FieldDefault;
    assert_eq!(admin::schema().save_clock_field, Some("updatedAt"));
    assert_eq!(accounts::schema().collection, "accounts");
    for field in [
        "user_id",
        "user_login",
        "user_email",
        "channelID",
        "channelName",
    ] {
        assert!(matches!(
            &accounts::schema()
                .fields
                .iter()
                .find(|f| f.name == field)
                .unwrap()
                .default,
            FieldDefault::Null
        ));
    }
    assert!(
        credit_gift::schema()
            .fields
            .iter()
            .find(|f| f.name == "checkoutUrl")
            .unwrap()
            .hidden
    );
    assert_eq!(credit_gift::schema().indexes.len(), 2);
    assert_eq!(credit_transaction::schema().indexes.len(), 5);
}
