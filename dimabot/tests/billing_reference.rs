#![cfg(feature = "billing-service")]

//! Actual-source parity for the billing policy in `utils::billing`,
//! `utils::credit_gift_provider`, `utils::credit_packs`, and
//! `utils::ai_credit_sources`.
//!
//! The oracle (`tests/fixtures/billing_reference.cjs`) extracts the real
//! TypeScript declarations, typechecks them in a virtual file, evaluates their
//! real bodies in a `vm` realm with stubbed I/O, and records every expected
//! value. This test decodes that golden file and recomputes each case with the
//! native port, so a policy drift fails here instead of silently shipping.
//!
//! Required external directory (parent supplies it):
//! `DIMA_BILLING_REFERENCE_DIR`. Optional binary-binding hooks mirror the
//! canonical projection oracle: `DIMA_BILLING_NODE_BINARY`,
//! `DIMA_BILLING_TYPESCRIPT_IMPLEMENTATION`, `DIMA_BILLING_TYPESCRIPT_PACKAGE`.

use dima_rust::utils::{
    ai_credit_sources::{
        self, CreditGrant, CreditOrder, CreditSourceError, CreditSourceEvent, CreditSourceReads,
        EventTimestamp, grant_list_path, order_path,
    },
    billing::{
        self, BillingAction, BillingConfig, DefaultUrl, DiscountCandidate, DiscountLike,
        DiscountReason, PaidPlanTier, PolarSubscription, credit_pack_billing_context_cache_key,
        plan_tier_name,
    },
    credit_gift_provider::{self, GiftProduct},
    js_date::parse_date,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn fixture() -> Value {
    let dir = std::env::var("DIMA_BILLING_REFERENCE_DIR")
        .expect("external actual-source billing oracle directory");
    let raw = std::fs::read_to_string(std::path::Path::new(&dir).join("billing_reference.json"))
        .expect("billing_reference.json");
    assert!(!raw.is_empty());
    serde_json::from_str(&raw).expect("golden JSON")
}

/// Resolves the oracle's `{$f64}`, `{$array}`, `{$object}` and `{$undefined}`
/// encodings into plain JSON so numbers keep their exact binary64 value.
fn decode(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    if object.get("$undefined") == Some(&Value::Bool(true)) {
        return Value::Null;
    }
    if let Some(bits) = object.get("$f64").and_then(Value::as_str) {
        let raw = u64::from_str_radix(bits, 16).expect("binary64 bits");
        let number = serde_json::Number::from_f64(f64::from_bits(raw))
            .unwrap_or_else(|| serde_json::Number::from(0));
        return Value::Number(number);
    }
    if let Some(items) = object.get("$array").and_then(Value::as_array) {
        return Value::Array(items.iter().map(decode).collect());
    }
    if let Some(items) = object.get("$object").and_then(Value::as_array) {
        let mut map = Map::new();
        for pair in items {
            let pair = pair.as_array().expect("object entry");
            let key = pair[0].as_str().expect("object key");
            map.insert(key.to_owned(), decode(&pair[1]));
        }
        return Value::Object(map);
    }
    value.clone()
}

fn expected(case: &Value) -> Value {
    decode(case.get("expected").expect("expected"))
}

fn input<'a>(case: &'a Value, key: &str) -> &'a Value {
    case.get("input")
        .and_then(|input| input.get(key))
        .unwrap_or(&Value::Null)
}

fn input_str<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    input(case, key).as_str()
}

fn input_array<'a>(case: &'a Value, key: &str) -> &'a [Value] {
    input(case, key).as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn input_f64(case: &Value, key: &str) -> f64 {
    input(case, key).as_f64().unwrap_or(f64::NAN)
}

fn cases<'a>(root: &'a Value, kind: &str) -> Vec<&'a Value> {
    root.get("cases")
        .and_then(Value::as_array)
        .expect("cases")
        .iter()
        .filter(|case| case.get("kind").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn metadata(root: &Value) {
    let metadata = root.get("metadata").expect("metadata");
    assert_eq!(metadata.get("schema").and_then(Value::as_u64), Some(1));
    assert_eq!(metadata.get("node").and_then(Value::as_str), Some("v24.22.1"));
    assert_eq!(
        metadata.get("v8").and_then(Value::as_str),
        Some("13.6.233.17-node.58")
    );
    assert_eq!(metadata.get("typescript").and_then(Value::as_str), Some("5.9.3"));
    let diagnostics = metadata
        .get("typeDiagnostics")
        .and_then(Value::as_array)
        .expect("typeDiagnostics");
    assert!(diagnostics.is_empty(), "extracted sources must typecheck");
    let hashes = metadata.get("hashes").expect("hashes");
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (key, file, pin) in [
        (
            "billing",
            "src/utils/billing.ts",
            "a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d",
        ),
        (
            "packs",
            "src/utils/credit_packs.ts",
            "0c2214abf807730f16a89fa9aadd94b68bd851613f923c7041a6ca783d829471",
        ),
        (
            "gift",
            "src/utils/credit_gift_provider.ts",
            "611f71d10265cc250f6cf50c80c8fe280de88d3c7e27ef8580af050f049121bc",
        ),
        (
            "sources",
            "src/utils/ai_credit_sources.ts",
            "2f6a3f438799306f72e61aab56612a7dbfb177fe5065e83d478e90da06fa9350",
        ),
        (
            "package",
            "package.json",
            "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef",
        ),
        (
            "lock",
            "package-lock.json",
            "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7",
        ),
    ] {
        assert_eq!(hashes.get(key).and_then(Value::as_str), Some(pin), "{key}");
        assert_eq!(hash(std::fs::read(base.join(file)).unwrap()), pin, "{key}");
    }
    assert_eq!(
        hashes.get("typescript").and_then(Value::as_str),
        Some("3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675")
    );
    assert_eq!(
        hashes.get("typescriptPackage").and_then(Value::as_str),
        Some("822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6")
    );
    assert_eq!(
        hashes["oracle"],
        json!(hash(
            std::fs::read(base.join("tests/fixtures/billing_reference.cjs")).unwrap()
        ))
    );
    // Optional binary binding hooks: when the parent mounts the exact runtime,
    // the pinned hash must match the mounted file rather than trusting metadata.
    for (key, env) in [
        ("node", "DIMA_BILLING_NODE_BINARY"),
        ("typescript", "DIMA_BILLING_TYPESCRIPT_IMPLEMENTATION"),
        ("typescriptPackage", "DIMA_BILLING_TYPESCRIPT_PACKAGE"),
    ] {
        if let Ok(path) = std::env::var(env) {
            assert_eq!(
                hashes[key],
                json!(hash(std::fs::read(path).unwrap())),
                "{env}"
            );
        }
    }
    let dir = std::path::PathBuf::from(
        std::env::var("DIMA_BILLING_REFERENCE_DIR").expect("reference dir"),
    );
    for (key, file) in [
        ("extractionSha256", "billing_reference_extracted.ts"),
        ("typecheckSourceSha256", "billing_reference_typecheck.ts"),
        ("transpiledSha256", "billing_reference_compiled.cjs"),
    ] {
        let pinned = metadata.get(key).and_then(Value::as_str).expect(key);
        assert_eq!(hash(std::fs::read(dir.join(file)).unwrap()), pinned, "{key}");
    }
    let constants = metadata.get("constants").expect("constants");
    assert_eq!(
        constants.get("meterId").and_then(Value::as_str),
        Some(dima_rust::utils::ai_credit_projection::AI_CREDITS_METER_ID)
    );
    assert_eq!(
        constants.get("winbackMonths").and_then(Value::as_f64),
        Some(billing::WINBACK_MONTHS)
    );
    assert_eq!(
        constants.get("cacheVersion").and_then(Value::as_f64),
        Some(f64::from(
            billing::CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION
        ))
    );
    let product_ids = constants.get("productIds").expect("productIds");
    for (key, native) in [
        ("FREE", billing::PLAN_PRODUCT_ID_FREE),
        ("PREMIUM", billing::PLAN_PRODUCT_ID_PREMIUM),
        ("PRO", billing::PLAN_PRODUCT_ID_PRO),
    ] {
        assert_eq!(product_ids.get(key).and_then(Value::as_str), Some(native));
    }
    let packs = constants.get("packs").and_then(Value::as_array).expect("packs");
    assert_eq!(packs.len(), dima_rust::utils::credit_packs::CREDIT_PACK_DEFINITIONS.len());
    for (pack, native) in packs
        .iter()
        .zip(dima_rust::utils::credit_packs::CREDIT_PACK_DEFINITIONS)
    {
        assert_eq!(pack.get("id").and_then(Value::as_str), Some(native.id));
        assert_eq!(
            pack.get("kind").and_then(Value::as_str),
            Some(native.kind.as_str())
        );
        assert_eq!(
            pack.get("size").and_then(Value::as_str),
            Some(native.size.as_str())
        );
        assert_eq!(
            pack.get("order").and_then(Value::as_u64),
            Some(u64::from(native.order))
        );
    }
    let pairs = constants.get("giftPairs").and_then(Value::as_array).expect("giftPairs");
    assert_eq!(pairs.len(), credit_gift_provider::GIFT_PACK_PAIRS.len());
    for (pair, native) in pairs
        .iter()
        .zip(credit_gift_provider::GIFT_PACK_PAIRS)
    {
        assert_eq!(
            pair.get("productId").and_then(Value::as_str),
            Some(native.product_id)
        );
        assert_eq!(
            pair.get("fulfillmentProductId").and_then(Value::as_str),
            Some(native.fulfillment_product_id)
        );
        assert_eq!(
            pair.get("credits").and_then(Value::as_f64),
            Some(native.credits as f64)
        );
    }
    assert_eq!(
        constants.get("eventTypes").and_then(Value::as_f64),
        Some(ai_credit_sources::CREDIT_SOURCE_MATCH_MS as f64)
    );
    assert_eq!(
        metadata.get("total").and_then(Value::as_u64),
        root.get("cases").and_then(Value::as_array).map(|c| c.len() as u64)
    );
}

fn discount_like(value: &Value) -> DiscountLike {
    DiscountLike {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        code: value.get("code").and_then(Value::as_str).map(str::to_owned),
        discount_type: value.get("type").and_then(Value::as_str).map(str::to_owned),
        basis_points: value.get("basis_points").and_then(Value::as_f64),
        amount: value.get("amount").and_then(Value::as_f64),
        products: value.get("products").and_then(Value::as_array).map(|products| {
            products
                .iter()
                .map(|product| billing::DiscountProduct {
                    id: product.get("id").and_then(Value::as_str).map(str::to_owned),
                })
                .collect()
        }),
    }
}

#[test]
fn metadata_pins_the_actual_sources_and_runtime() {
    metadata(&fixture());
}

#[test]
fn discount_estimation_applicability_and_selection_match_the_source() {
    let root = fixture();
    for case in cases(&root, "estimate") {
        let discount = DiscountLike {
            id: "d".into(),
            code: None,
            discount_type: input_str(case, "type").map(str::to_owned),
            basis_points: input(case, "basisPoints").as_f64(),
            amount: input(case, "amount").as_f64(),
            products: None,
        };
        let base = input_f64(case, "base");
        assert_eq!(
            json!(billing::estimate_discount_value(&discount, base)),
            expected(case),
            "{}",
            case.get("id").and_then(Value::as_str).unwrap_or_default()
        );
    }
    for case in cases(&root, "applicable") {
        let discount = DiscountLike {
            id: "d".into(),
            code: None,
            discount_type: Some("fixed".into()),
            basis_points: None,
            amount: Some(1.0),
            products: input(case, "products").as_array().map(|products| {
                products
                    .iter()
                    .map(|product| billing::DiscountProduct {
                        id: product.get("id").and_then(Value::as_str).map(str::to_owned),
                    })
                    .collect()
            }),
        };
        let product_id = input_str(case, "productId").unwrap_or_default();
        assert_eq!(
            json!(billing::is_discount_applicable_to_product(&discount, product_id)),
            expected(case)
        );
    }
    for case in cases(&root, "select") {
        let candidates: Vec<DiscountCandidate> = input_array(case, "candidates")
            .iter()
            .map(|candidate| DiscountCandidate {
                reason: match candidate.get("reason").and_then(Value::as_str) {
                    Some("referral") => DiscountReason::Referral,
                    Some("promo") => DiscountReason::Promo,
                    Some("winback") => DiscountReason::Winback,
                    Some("upgrade") => DiscountReason::Upgrade,
                    Some("change") => DiscountReason::Change,
                    other => panic!("unexpected reason {other:?}"),
                },
                discount: discount_like(candidate.get("discount").expect("discount")),
            })
            .collect();
        let best = billing::select_best_discount(&candidates, input_f64(case, "base"));
        let actual = best.map_or(Value::Null, |best| {
            json!({"reason": best.reason.as_str(), "id": best.discount.id})
        });
        assert_eq!(actual, expected(case));
    }
}

#[test]
fn scenario_and_plan_mapping_match_the_source() {
    let root = fixture();
    for case in cases(&root, "scenario") {
        let action = match input_str(case, "action") {
            Some("auto") => BillingAction::Auto,
            Some("new") => BillingAction::New,
            Some("upgrade") => BillingAction::Upgrade,
            Some("change") => BillingAction::Change,
            Some("reactivate") => BillingAction::Reactivate,
            other => panic!("unexpected action {other:?}"),
        };
        let target = match input_str(case, "target") {
            Some("premium") => PaidPlanTier::Premium,
            Some("pro") => PaidPlanTier::Pro,
            other => panic!("unexpected target {other:?}"),
        };
        let current = match input_str(case, "current") {
            Some("free") => dima_rust::utils::ai_credit_projection::PlanTier::Free,
            Some("premium") => dima_rust::utils::ai_credit_projection::PlanTier::Premium,
            Some("pro") => dima_rust::utils::ai_credit_projection::PlanTier::Pro,
            other => panic!("unexpected current {other:?}"),
        };
        let scenario = billing::infer_scenario(
            action,
            input(case, "active").as_bool().unwrap_or(false),
            target,
            current,
            input(case, "winback").as_bool().unwrap_or(false),
            input(case, "history").as_bool().unwrap_or(false),
        );
        assert_eq!(json!(scenario.as_str()), expected(case));
    }
    for case in cases(&root, "currentPlan") {
        let user_plan = match input_str(case, "userPlan") {
            Some("free") => dima_rust::utils::ai_credit_projection::PlanTier::Free,
            Some("premium") => dima_rust::utils::ai_credit_projection::PlanTier::Premium,
            Some("pro") => dima_rust::utils::ai_credit_projection::PlanTier::Pro,
            other => panic!("unexpected user plan {other:?}"),
        };
        let plan = billing::get_current_plan_from_active_subscription(
            user_plan,
            input_str(case, "activeProductId"),
        );
        assert_eq!(json!(plan_tier_name(plan)), expected(case));
    }
    for case in cases(&root, "paidPlan") {
        let subscriptions: Vec<PolarSubscription> = input_array(case, "subscriptions")
            .iter()
            .map(|subscription| PolarSubscription {
                id: subscription
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                product_id: subscription
                    .get("product_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                ..PolarSubscription::default()
            })
            .collect();
        let plan = billing::get_paid_plan_from_subscriptions(&subscriptions);
        assert_eq!(
            plan.map_or(Value::Null, |plan| json!(plan.as_str())),
            expected(case)
        );
    }
}

#[test]
fn redirect_sanitising_matches_the_source() {
    let root = fixture();
    for case in cases(&root, "redirect") {
        let env = input(case, "env").as_object().cloned().unwrap_or_default();
        let config = BillingConfig::from_lookup(|name| {
            env.get(name).and_then(Value::as_str).map(str::to_owned)
        });
        let raw = input_str(case, "rawUrl");
        let actual = billing::sanitize_redirect_url(&config, raw, DefaultUrl::Success);
        assert_eq!(
            actual.map_or(Value::Null, Value::String),
            expected(case),
            "{}",
            case.get("id").and_then(Value::as_str).unwrap_or_default()
        );
    }
}

#[test]
fn uuid_cache_key_and_cached_context_match_the_source() {
    let root = fixture();
    for case in cases(&root, "uuid") {
        assert_eq!(
            json!(billing::is_uuid_v4(input_str(case, "value"))),
            expected(case)
        );
    }
    for case in cases(&root, "cacheKey") {
        assert_eq!(
            json!(credit_pack_billing_context_cache_key(
                input_str(case, "customerId").unwrap_or_default()
            )),
            expected(case)
        );
    }
    for case in cases(&root, "cached") {
        let value = input(case, "value");
        let now = input_f64(case, "nowMs");
        let normalized = billing::valid_cached_billing_context(value, now);
        let actual = normalized.map_or(Value::Null, |context| {
            json!({
                "planTier": plan_tier_name(context.plan_tier),
                "expiresAt": context.expires_at,
                "version": context.version,
            })
        });
        assert_eq!(actual, expected(case));
    }
}

#[test]
fn month_differences_match_the_source() {
    let root = fixture();
    for case in cases(&root, "months") {
        let from = parse_date(input_str(case, "from").expect("from")).expect("from date");
        let to = parse_date(input_str(case, "to").expect("to")).expect("to date");
        let actual = billing::diff_months(
            dima_rust::utils::credit_policy::JsDate::from_millis(from as f64),
            dima_rust::utils::credit_policy::JsDate::from_millis(to as f64),
        );
        assert_eq!(json!(actual), expected(case));
    }
}

#[test]
fn metadata_compaction_matches_the_source() {
    let root = fixture();
    for case in cases(&root, "compact") {
        let entries: Vec<(&str, Option<Value>)> = input_array(case, "entries")
            .iter()
            .map(|entry| {
                let pair = entry.as_array().expect("entry");
                let key = pair[0].as_str().expect("key");
                let value = match &pair[1] {
                    Value::Null => None,
                    value => Some(decode(value)),
                };
                (key, value)
            })
            .collect();
        let compacted = billing::compact_metadata(&entries);
        let pairs: Vec<Value> = compacted
            .iter()
            .map(|(key, value)| json!([key, value]))
            .collect();
        assert_eq!(Value::Array(pairs), expected(case));
    }
}

#[test]
fn gift_pair_validation_matches_the_source() {
    let root = fixture();
    for case in cases(&root, "gift") {
        let paid: GiftProduct =
            serde_json::from_value(input(case, "paid").clone()).expect("paid product");
        let free: GiftProduct =
            serde_json::from_value(input(case, "free").clone()).expect("free product");
        let actual = match credit_gift_provider::validate_gift_pair(&paid, &free) {
            Ok(validation) => json!({
                "ok": true,
                "value": {
                    "offer": {
                        "id": validation.offer.id,
                        "name": validation.offer.name,
                        "credits": validation.offer.credits,
                        "rollover": validation.offer.rollover,
                        "priceAmount": validation.offer.price_amount,
                        "priceCurrency": validation.offer.price_currency,
                    },
                    "fulfillmentProductId": validation.fulfillment_product_id,
                    "benefitId": validation.benefit_id,
                },
            }),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
        assert_eq!(actual, expected(case));
    }
}

struct MemoryReads {
    grants: BTreeMap<String, CreditGrant>,
    orders: BTreeMap<String, CreditOrder>,
}

impl CreditSourceReads for MemoryReads {
    async fn grant(&mut self, id: &str) -> Result<Option<CreditGrant>, CreditSourceError> {
        Ok(self.grants.get(id).cloned())
    }

    async fn order(&mut self, id: &str) -> Result<CreditOrder, CreditSourceError> {
        Ok(self.orders.get(id).cloned().unwrap_or_default())
    }
}

fn source_event(value: &Value) -> CreditSourceEvent {
    CreditSourceEvent {
        id: value.get("id").and_then(Value::as_str).map(str::to_owned),
        name: value.get("name").and_then(Value::as_str).map(str::to_owned),
        timestamp: value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(EventTimestamp::Text),
        metadata: value.get("metadata").and_then(Value::as_object).cloned(),
    }
}

#[tokio::test]
async fn credit_source_classification_matches_the_source() {
    let root = fixture();
    for case in cases(&root, "classify") {
        let events: Vec<CreditSourceEvent> = input_array(case, "events")
            .iter()
            .map(source_event)
            .collect();
        let grants: BTreeMap<String, CreditGrant> = input_array(case, "grants")
            .iter()
            .map(|grant| {
                let grant: CreditGrant =
                    serde_json::from_value(grant.clone()).expect("grant fixture");
                (grant.id.clone(), grant)
            })
            .collect();
        let orders: BTreeMap<String, CreditOrder> = input_array(case, "orders")
            .iter()
            .map(|order| {
                let order: CreditOrder =
                    serde_json::from_value(order.clone()).expect("order fixture");
                (order.id.clone(), order)
            })
            .collect();
        let mut reads = MemoryReads { grants, orders };
        let result = ai_credit_sources::classify_polar_credit_sources(
            input_str(case, "customerId").expect("customer"),
            &events,
            &mut reads,
        )
        .await
        .expect("classification");
        let pairs: Vec<Value> = result
            .iter()
            .map(|(credit, label)| json!([credit, label]))
            .collect();
        assert_eq!(json!({"ok": true, "value": pairs}), expected(case));
    }
}

#[test]
fn credit_source_read_paths_match_the_source() {
    let root = fixture();
    let paths: Vec<&Value> = cases(&root, "grantPath");
    assert_eq!(paths.len(), 2, "one grant walk and one order read");
    for case in paths {
        let recorded: Vec<String> = expected(case)
            .get("paths")
            .and_then(Value::as_array)
            .expect("paths")
            .iter()
            .map(|path| path.as_str().expect("path").to_owned())
            .collect();
        let customer = input_str(case, "customerId").expect("customer");
        let actual: Vec<String> = if input_str(case, "orderId").is_some() {
            vec![order_path(input_str(case, "orderId").expect("order id"))]
        } else {
            (1..=recorded.len() as u32)
                .map(|page| grant_list_path(customer, page))
                .collect()
        };
        assert_eq!(actual, recorded);
    }
}

#[test]
fn the_golden_file_is_not_empty_and_covers_every_kind() {
    let root = fixture();
    for kind in [
        "estimate",
        "applicable",
        "select",
        "scenario",
        "currentPlan",
        "paidPlan",
        "redirect",
        "uuid",
        "cacheKey",
        "cached",
        "months",
        "compact",
        "gift",
        "classify",
        "grantPath",
    ] {
        assert!(!cases(&root, kind).is_empty(), "{kind} cases");
    }
}
