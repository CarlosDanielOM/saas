#![cfg(feature = "bits-rules")]
use dima_rust::bits_rules::{model::*, store::*};
use serde_json::{Value, json};

#[test]
fn model_matches_source_oracle() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/bits_rules_cases.json")).unwrap();
    let cases = fixture
        .as_array()
        .or_else(|| fixture["cases"].as_array())
        .unwrap();
    for case in cases {
        let result = match case["op"].as_str().unwrap() {
            "parse" => {
                let previous = if case["previous"].is_null() {
                    None
                } else {
                    Some(serde_json::from_value::<BitsRule>(case["previous"].clone()).unwrap())
                };
                match parse_rule(
                    &case["raw"],
                    case["id"].as_str().unwrap(),
                    previous.as_ref(),
                ) {
                    Ok(rule) => Ok(serde_json::to_value(rule).unwrap()),
                    Err(error) => Err(error.message),
                }
            }
            "legacy" => {
                Ok(serde_json::to_value(rules_from_legacy_tiers(&case["raw"]).unwrap()).unwrap())
            }
            "id" => Ok(json!(valid_rule_id(&case["raw"]))),
            "match" => {
                let rules: Vec<BitsRule> = serde_json::from_value(case["raw"].clone()).unwrap();
                Ok(json!(match_bits_rule(&rules, &case["bits"]).map(|r| &r.id)))
            }
            other => panic!("unknown operation {other}"),
        };
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.unwrap_err(), error, "{case}");
        } else {
            assert_eq!(result.unwrap(), case["expected"], "{case}");
        }
    }
}
#[test]
fn limits_unicode_and_ties() {
    assert!(parse_rule(&json!({"min":1,"name":"😀".repeat(30)}), "x", None).is_ok());
    assert!(parse_rule(&json!({"min":1,"name":"😀".repeat(31)}), "x", None).is_err());
    assert!(parse_rule(&json!({"min":1,"unknown":1}), "x", None).is_err());
    assert_eq!(
        rules_from_legacy_tiers(
            &json!([{"name":format!("{}😀", "a".repeat(59)),"minAmount":1,"maxAmount":1}])
        )
        .unwrap_err(),
        SplitSurrogate
    );
    let entries = (0..55)
        .map(|_| json!({"minAmount":1,"maxAmount":2}))
        .collect::<Vec<_>>();
    assert_eq!(rules_from_legacy_tiers(&json!(entries)).unwrap().len(), 50);
    let first = parse_rule(
        &json!({"min":1,"max":5,"chat":{"mode":"custom","message":"hello"}}),
        "first",
        None,
    )
    .unwrap();
    let second = parse_rule(
        &json!({"min":1,"max":5,"chat":{"mode":"silent"}}),
        "second",
        None,
    )
    .unwrap();
    let rules = vec![first, second];
    assert_eq!(match_bits_rule(&rules, &json!(3)).unwrap().id, "first");
    assert_eq!(bits_chat_message(&rules, "default", &json!(3)), "hello");
    assert_eq!(bits_chat_message(&rules, "default", &json!(30)), "default");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "lead-owned disposable MongoDB fixture only"]
async fn mongo_migration_canonical_precedence_and_cas() {
    use mongodb::{
        Client,
        bson::{Document, doc, oid::ObjectId},
    };
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")
            .ok()
            .as_deref(),
        Some("dimabot-migration")
    );
    let uri = std::env::var("DIMA_TEST_MONGO_URI").expect("isolated fixture URI");
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&format!("bits_rules_{}", ObjectId::new().to_hex()));
    let events = db.collection::<Document>("eventsubs");
    events.insert_one(doc! {"channelID":"c", "type":"channel.cheer", "cheerTiers":[{"minAmount":1,"maxAmount":10,"message":"old"}]}).await.unwrap();
    assert_eq!(
        load_bits_rules(&db, "c", None).await.unwrap().rules[0]["chat"]["message"],
        "old"
    );
    events.insert_one(doc! {"channelID":"c", "type":"channel.bits.use", "cheerTiers":[{"minAmount":5,"maxAmount":6,"message":"new"}]}).await.unwrap();
    assert_eq!(
        load_bits_rules(&db, "c", None).await.unwrap().rules[0]["chat"]["message"],
        "new"
    );
    assert!(
        load_bits_rules(&db, "c", Some(&Value::Null))
            .await
            .unwrap()
            .rules
            .is_empty()
    );
    let first = change_bits_rules(&db, "c", "user", |mut rules| {
        rules[0]["extra"] = json!("preserved");
        Ok(rules)
    })
    .await
    .unwrap();
    assert_eq!(first.revision, 1.0);
    let second = change_bits_rules(&db, "c", "user2", |mut rules| {
        rules.push(json!({"id":"new"}));
        Ok(rules)
    })
    .await
    .unwrap();
    assert_eq!(second.revision, 2.0);
    let reloaded = load_bits_rules(&db, "c", None).await.unwrap();
    assert_eq!(reloaded.rules[0]["extra"], "preserved");
    assert_eq!(reloaded.rules[1]["id"], "new");
    let stored = db
        .collection::<Document>("bits_rules")
        .find_one(doc! {"_id":"c"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.get_str("updatedBy").unwrap(), "user2");
    db.collection::<Document>("bits_rules")
        .insert_one(doc! {"_id":"stuck", "revision":0_i32, "rules":[]})
        .await
        .unwrap();
    let mut stuck_attempts = 0;
    let error = change_bits_rules(&db, "stuck", "user", |rules| {
        stuck_attempts += 1;
        Ok(rules)
    })
    .await
    .unwrap_err();
    assert_eq!(stuck_attempts, 4);
    assert!(matches!(
        error,
        StoreError::InvalidRule(BitsRuleError { status: 409, .. })
    ));
    let collection = db.collection::<Document>("bits_rules");
    for (channel, revision) in [
        ("zero-i64", mongodb::bson::Bson::Int64(0)),
        ("zero-double", mongodb::bson::Bson::Double(0.0)),
        ("negative-zero", mongodb::bson::Bson::Double(-0.0)),
    ] {
        collection
            .insert_one(doc! {"_id":channel, "revision":revision, "rules":[]})
            .await
            .unwrap();
        let mut attempts = 0;
        let error = change_bits_rules(&db, channel, "user", |rules| {
            attempts += 1;
            Ok(rules)
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 4);
        assert!(matches!(
            error,
            StoreError::InvalidRule(BitsRuleError { status: 409, .. })
        ));
    }
    for (channel, revision) in [
        ("integer-32", mongodb::bson::Bson::Int32(4)),
        ("integer-64", mongodb::bson::Bson::Int64(4)),
        ("integer-double", mongodb::bson::Bson::Double(4.0)),
    ] {
        collection
            .insert_one(doc! {"_id":channel, "revision":revision, "rules":[]})
            .await
            .unwrap();
        assert_eq!(
            load_bits_rules(&db, channel, None).await.unwrap().revision,
            4.0
        );
        assert_eq!(
            change_bits_rules(&db, channel, "user", Ok)
                .await
                .unwrap()
                .revision,
            5.0
        );
    }
    collection
        .insert_one(doc! {"_id":"fraction", "revision":1.5_f64, "rules":[]})
        .await
        .unwrap();
    assert_eq!(
        load_bits_rules(&db, "fraction", None)
            .await
            .unwrap()
            .revision,
        1.5
    );
    let fractional = change_bits_rules(&db, "fraction", "user", Ok)
        .await
        .unwrap();
    assert_eq!(fractional.revision, 2.5);
    assert_eq!(
        collection
            .find_one(doc! {"_id":"fraction"})
            .await
            .unwrap()
            .unwrap()
            .get_f64("revision")
            .unwrap(),
        2.5
    );

    let large_revision = 9_007_199_254_740_992.0_f64;
    collection
        .insert_one(doc! {"_id":"large", "revision":large_revision, "rules":[]})
        .await
        .unwrap();
    assert_eq!(
        change_bits_rules(&db, "large", "user", Ok)
            .await
            .unwrap()
            .revision,
        large_revision
    );
    assert_eq!(
        collection
            .find_one(doc! {"_id":"large"})
            .await
            .unwrap()
            .unwrap()
            .get_f64("revision")
            .unwrap(),
        large_revision
    );

    collection
        .insert_one(doc! {"_id":"contenders", "revision":1_i32, "rules":[]})
        .await
        .unwrap();
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut release = Vec::new();
    let mut tasks = Vec::new();
    for name in ["one", "two"] {
        let db = db.clone();
        let ready = ready_tx.clone();
        let attempts = attempts.clone();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        release.push(release_tx);
        tasks.push(tokio::spawn(async move {
            let mut first = true;
            change_bits_rules(&db, "contenders", name, move |mut rules| {
                attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if first {
                    first = false;
                    ready.send(()).expect("coordination receiver");
                    tokio::task::block_in_place(|| {
                        release_rx.recv_timeout(std::time::Duration::from_secs(5))
                    })
                    .expect("contender coordination timed out");
                }
                rules.push(json!({"id":name}));
                Ok(rules)
            })
            .await
        }));
    }
    drop(ready_tx);
    for _ in 0..2 {
        tokio::time::timeout(std::time::Duration::from_secs(5), ready_rx.recv())
            .await
            .expect("contender readiness timed out")
            .expect("contender exited early");
    }
    for signal in release {
        signal.send(()).expect("contender exited early");
    }
    for task in tasks {
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("contender completion timed out")
            .unwrap()
            .unwrap();
    }
    let concurrent = load_bits_rules(&db, "contenders", None).await.unwrap();
    assert_eq!(concurrent.revision, 3.0);
    assert_eq!(concurrent.rules.len(), 2);
    assert!(concurrent.rules.iter().any(|rule| rule["id"] == "one"));
    assert!(concurrent.rules.iter().any(|rule| rule["id"] == "two"));
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);

    collection
        .insert_one(doc! {"_id":"conflicts", "revision":1_i32, "rules":[]})
        .await
        .unwrap();
    let (request_tx, mut request_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let interferer = tokio::spawn(async move {
        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(5), request_rx.recv())
                .await
                .expect("conflict request timed out")
                .expect("caller exited early");
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                collection
                    .update_one(doc! {"_id":"conflicts"}, doc! {"$inc":{"revision":1.0_f64}})
                    .await
            })
            .await
            .expect("conflict update timed out")
            .unwrap();
            done_tx.send(()).expect("caller exited early");
        }
    });
    let mut conflict_attempts = 0;
    let conflict = change_bits_rules(&db, "conflicts", "user", |rules| {
        conflict_attempts += 1;
        request_tx
            .send(())
            .expect("conflict controller exited early");
        tokio::task::block_in_place(|| done_rx.recv_timeout(std::time::Duration::from_secs(5)))
            .expect("conflict update acknowledgement timed out");
        Ok(rules)
    })
    .await
    .unwrap_err();
    tokio::time::timeout(std::time::Duration::from_secs(5), interferer)
        .await
        .expect("conflict controller timed out")
        .unwrap();
    assert_eq!(conflict_attempts, 4);
    assert!(matches!(
        conflict,
        StoreError::InvalidRule(BitsRuleError { status: 409, .. })
    ));
    assert_eq!(
        load_bits_rules(&db, "conflicts", None)
            .await
            .unwrap()
            .revision,
        5.0
    );
    db.drop().await.unwrap();
}

/// Emits the same stable fields as bits_rules_store_reference.mjs. The lead
/// compares snapshots after removing the TS sourceHashes field.
#[tokio::test]
#[ignore = "lead-owned disposable MongoDB fixture only"]
async fn mongo_source_parity_snapshot() {
    use mongodb::{
        Client,
        bson::{Bson, Document, doc, oid::ObjectId},
    };
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")
            .ok()
            .as_deref(),
        Some("dimabot-migration")
    );
    let client =
        Client::with_uri_str(std::env::var("DIMA_TEST_MONGO_URI").expect("isolated fixture URI"))
            .await
            .unwrap();
    let db = client.database(&format!("bits_rule_native_{}", ObjectId::new().to_hex()));
    let events = db.collection::<Document>("eventsubs");
    events.insert_many([
        doc! {"channelID":"c","type":"channel.cheer","cheerTiers":[{"minAmount":1,"maxAmount":10,"message":"old"}]},
        doc! {"channelID":"c","type":"channel.bits.use","cheerTiers":[{"minAmount":5,"maxAmount":6,"message":"new"}]},
    ]).await.unwrap();
    let initial = load_bits_rules(&db, "c", None).await.unwrap();
    let explicit_null = load_bits_rules(&db, "c", Some(&Value::Null)).await.unwrap();
    let created = change_bits_rules(&db, "c", "user", |mut rules| {
        rules[0]["extra"] =
            json!({"number":4,"decimal":1.5,"large":2147483648_i64,"nested":[2,2.5]});
        Ok(rules)
    })
    .await
    .unwrap();
    let stored = db
        .collection::<Document>("bits_rules")
        .find_one(doc! {"_id":"c"})
        .await
        .unwrap()
        .unwrap();
    fn type_name(value: &Bson) -> &'static str {
        match value {
            Bson::Int32(_) => "int",
            Bson::Int64(_) => "long",
            Bson::Double(_) => "double",
            _ => panic!("unexpected numeric BSON type"),
        }
    }
    let extra = stored.get_array("rules").unwrap()[0]
        .as_document()
        .unwrap()
        .get_document("extra")
        .unwrap();
    let types = json!({"revision":type_name(stored.get("revision").unwrap()),"number":type_name(extra.get("number").unwrap()),"decimal":type_name(extra.get("decimal").unwrap()),"large":type_name(extra.get("large").unwrap()),"nested":extra.get_array("nested").unwrap().iter().map(type_name).collect::<Vec<_>>()});
    let persisted = load_bits_rules(&db, "c", None).await.unwrap();
    let collection = db.collection::<Document>("bits_rules");
    collection
        .insert_one(doc! {"_id":"fraction","revision":1.5_f64,"rules":[]})
        .await
        .unwrap();
    let fraction = change_bits_rules(&db, "fraction", "user", Ok)
        .await
        .unwrap();
    let fraction_doc = collection
        .find_one(doc! {"_id":"fraction"})
        .await
        .unwrap()
        .unwrap();
    let fraction_type = json!({"revision":type_name(fraction_doc.get("revision").unwrap())});
    collection
        .insert_one(doc! {"_id":"stuck","revision":0_i32,"rules":[]})
        .await
        .unwrap();
    let mut attempts = 0;
    let error = change_bits_rules(&db, "stuck", "user", |rules| {
        attempts += 1;
        Ok(rules)
    })
    .await
    .unwrap_err();
    let StoreError::InvalidRule(error) = error else {
        panic!("unexpected conflict error")
    };
    let state = |s: BitsRulesState| json!({"revision":s.revision,"rules":s.rules});
    let snapshot = json!({"initial":state(initial),"explicitNull":state(explicit_null),"created":state(created),"persisted":state(persisted),"createdTypes":types,"fraction":state(fraction),"fractionType":fraction_type,"conflict":{"message":error.message,"status":error.status,"attempts":attempts}});
    println!("BITS_RULES_STORE_SNAPSHOT={snapshot}");
    db.drop().await.unwrap();
}
