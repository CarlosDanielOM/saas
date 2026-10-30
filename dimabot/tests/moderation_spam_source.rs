#![cfg(feature = "moderation-spam")]
//! Actual TypeScript oracle replay; private protocol fixtures only.
#[path = "support/moderation_spam.rs"]
mod support;
use dima_rust::utils::moderation::spam::*;
use serde_json::json;
use support::*;

#[test]
#[ignore = "independently hashed actual-source fixture"]
fn all_pure_source_records() {
    let fixture = reference();
    let cases = fixture["cases"].as_array().unwrap();
    let mut visited = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(visited.insert(id));
        check_result(Prepared::from_case(case).run(), &case["result"], id);
    }
    assert_eq!(visited.len(), cases.len());
    // Replay the disconnected actual Mongoose document through the native
    // descriptor as well as exercising raw update/upsert storage below.
    let source_chatter = decode(&fixture["schemaEvidence"]["chatterDocument"]).unwrap();
    let id = match source_chatter.get("_id").unwrap() {
        dima_rust::utils::lossless_json::JsonValue::String(id) => id.to_utf8_lossy(),
        _ => panic!("source chatter ID must be a string"),
    };
    let milliseconds = match source_chatter.get("firstSeenAt").unwrap() {
        dima_rust::utils::lossless_json::JsonValue::Number(ms) => *ms as i64,
        _ => panic!("source chatter Date must have milliseconds"),
    };
    let at = mongodb::bson::DateTime::from_millis(milliseconds);
    let chatter = dima_rust::schemas::moderation_chatter::schema()
        .construct(&mongodb::bson::doc! {"_id": &id,"firstSeenAt":at}, at)
        .unwrap();
    assert_eq!(chatter.get_str("_id").unwrap(), id);
    assert_eq!(chatter.get_datetime("firstSeenAt").unwrap(), &at);
    assert_eq!(
        chatter.len(),
        match &source_chatter {
            dima_rust::utils::lossless_json::JsonValue::Object(fields) => fields.len(),
            _ => unreachable!(),
        }
    );
    let constants = decode(&fixture["constants"]).unwrap();
    assert_eq!(
        constants.get("SPAM_RULE_ID"),
        Some(&dima_rust::utils::lossless_json::JsonValue::String(
            SPAM_RULE_ID.into()
        ))
    );
    assert_eq!(
        constants.get("SPAM_CHANNEL_REVIEWS_PER_MINUTE"),
        Some(&dima_rust::utils::lossless_json::JsonValue::Number(
            f64::from(SPAM_CHANNEL_REVIEWS_PER_MINUTE)
        ))
    );
    assert_eq!(
        constants.get("SPAM_GLOBAL_REVIEWS_PER_MINUTE"),
        Some(&dima_rust::utils::lossless_json::JsonValue::Number(
            f64::from(SPAM_GLOBAL_REVIEWS_PER_MINUTE)
        ))
    );
    assert_eq!(
        encode(&native_template()),
        encode(constants.get("spamRule").unwrap())
    );
    let a = spam_rule_for_context(&[], None);
    let b = spam_rule_for_context(&[], None);
    assert_eq!(
        std::sync::Arc::ptr_eq(&a.first_offense, &b.first_offense),
        fixture["identity"]["offenseShared"].as_bool().unwrap()
    );
    assert_eq!(
        std::sync::Arc::ptr_eq(&a.terms, &b.terms),
        fixture["identity"]["termsShared"].as_bool().unwrap()
    );
    assert_eq!(
        std::sync::Arc::ptr_eq(&a.allowlist_domains, &b.allowlist_domains),
        fixture["identity"]["allowlistShared"].as_bool().unwrap()
    );
    // Native owned JSON has no JS reference identity. A separate native structural
    // test covers fresh output values; source identity evidence remains explicit.
    for (key, expected) in [
        ("ruleFresh", true),
        ("semanticFresh", true),
        ("categoriesFresh", true),
        ("examplesShared", true),
        ("defaultDatesFresh", true),
    ] {
        assert_eq!(fixture["identity"][key], expected);
    }
    println!(
        "{}",
        json!({"pureRecords":cases.len(),"runtimeExports":14,"identityBoundary":"owned JSON cannot expose JS reference identity"})
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "fresh private Mongo enableTestCommands and source fixture"]
async fn all_async_source_records_through_private_protocols() {
    let source = reference();
    let fixture = StorageFixture::new().await;
    let mut checked = 0;
    let mut adaptations = Vec::new();
    for case in source["claims"].as_array().unwrap() {
        let adaptation = fixture.replay(case).await;
        if let Some(reason) = adaptation {
            adaptations.push(json!({"id":case["id"],"adaptation":reason}));
        }
        checked += 1;
    }
    assert_eq!(checked, source["claims"].as_array().unwrap().len());
    fixture.cleanup().await;
    println!(
        "{}",
        json!({"claimRecordsVisited":checked,"syntheticBoundaryAdapters":adaptations,"clockAdapter":"source fixed Date; native date bounded by command start/end wall clock"})
    );
}
