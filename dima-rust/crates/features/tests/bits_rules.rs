//! Bits rules against the recording of the reference (`bits_rules_reference.json`, made by
//! `bits_rules_record.mts`): matching and chat text over a table of amounts and rule sets,
//! `parseRule` (accepted values and messages), legacy tiers stored as BSON, the store's
//! documents step by step on a scratch database with the recorded clock, and the production
//! copy's channels (read only). Then the races: concurrent changes and concurrent first
//! creations, where no edit may be lost or applied twice.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "roulette_support/mod.rs"]
mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result};
use bson::{Bson, doc};
use dima_core::ManualClock;
use dima_features::bits_rules::{
    BitsRule, BitsRuleError, BitsRulesConfig, BitsRulesStore, LegacyTiers, bits_chat_message,
    match_bits_value, parse_rule, rules_from_legacy_tiers, valid_rule_id,
};
use serde_json::{Value, json};
use support::{documents, from_ejson, with_database};

fn recorded() -> Value {
    support::reference(include_str!("bits_rules_reference.json"))
}

fn rule_from_json(value: &Value) -> BitsRule {
    let bson = from_ejson(value).unwrap();
    BitsRule::from_bson(&bson).unwrap_or_else(|| panic!("rule {value}"))
}

fn sha(text: &str) -> String {
    dima_core::crypto::sha256(text).hex()
}

fn rule_set(name: &str) -> Vec<BitsRule> {
    let rule = |id: &str, min: i64, max: Option<i64>| BitsRule {
        id: id.into(),
        name: id.into(),
        enabled: true,
        min,
        max,
        chat: dima_features::bits_rules::BitsChat {
            mode: dima_features::bits_rules::BitsChatMode::Custom,
            message: format!("say {id}"),
        },
        alert: true,
    };
    use dima_features::bits_rules::BitsChatMode as M;
    let with = |mut r: BitsRule, f: &dyn Fn(&mut BitsRule)| {
        f(&mut r);
        r
    };
    match name {
        "ranges" => vec![
            rule("any", 1, None),
            rule("hundreds", 100, Some(999)),
            rule("thousand", 1000, None),
            rule("nice", 69, Some(69)),
            rule("wide", 50, Some(150)),
        ],
        "overlaps" => vec![
            rule("a", 10, Some(100)),
            rule("b", 50, Some(60)),
            rule("c", 50, Some(60)),
            rule("d", 55, Some(65)),
            rule("e", 1, Some(1_000_000)),
        ],
        "gaps" => vec![
            rule("low", 1, Some(9)),
            rule("mid", 20, Some(29)),
            rule("high", 100, Some(100)),
        ],
        "open" => vec![
            rule("ten", 10, None),
            rule("hundred", 100, None),
            rule("also-ten", 10, None),
            rule("one", 1, None),
        ],
        "disabled" => vec![
            with(rule("off", 1, None), &|r| r.enabled = false),
            rule("on", 5, Some(5)),
            with(rule("off2", 5, Some(5)), &|r| r.enabled = false),
        ],
        "modes" => vec![
            rule("custom", 1, Some(10)),
            with(rule("silent", 11, Some(20)), &|r| {
                r.chat.mode = M::Silent;
                r.chat.message = String::new();
            }),
            with(rule("default", 21, Some(30)), &|r| {
                r.chat.mode = M::Default;
                r.chat.message = "ignored".into();
            }),
            with(rule("chatless-alert", 31, Some(40)), &|r| r.alert = false),
        ],
        "empty" => vec![],
        "max" => vec![
            rule("top", 1_000_000, Some(1_000_000)),
            rule("all", 1, None),
        ],
        other => panic!("unknown set {other}"),
    }
}

#[test]
fn matching_and_chat_text_follow_the_recording() {
    let reference = recorded();
    let cases = reference["matches"].as_array().unwrap();
    for case in cases {
        let rules = rule_set(case["set"].as_str().unwrap());
        let bits = &case["bits"];
        let matched = match_bits_value(&rules, bits).map(|r| Value::from(r.id.clone()));
        assert_eq!(matched.unwrap_or(Value::Null), case["match"], "{case}");
        assert_eq!(
            bits_chat_message(&rules, "Default thanks", bits),
            case["chat"],
            "{case}"
        );
        assert_eq!(
            bits_chat_message(&rules, "", bits),
            case["chatEmptyDefault"],
            "{case}"
        );
    }
    assert_eq!(cases.len(), 264);
}

#[test]
fn parse_rule_follows_the_recording() {
    let reference = recorded();
    let previous = rule_from_json(&reference["previous"]);
    let check =
        |body: &Value, expected: &Value, id: &str, previous: Option<&BitsRule>| match parse_rule(
            body, id, previous,
        ) {
            Ok(rule) => assert_eq!(json!({"ok": rule.to_json()}), *expected, "{body}"),
            Err(BitsRuleError { message, status }) => {
                assert_eq!(expected["error"], Value::from(message), "{body}");
                assert_eq!(status, 400, "{body}");
            }
        };
    for case in reference["parses"].as_array().unwrap() {
        check(&case["body"], &case["created"], "r1", None);
    }
    for case in reference["merges"].as_array().unwrap() {
        check(&case["body"], &case["merged"], "prev", Some(&previous));
    }
    for case in reference["ids"].as_array().unwrap() {
        assert_eq!(
            valid_rule_id(case["id"].as_str().unwrap()),
            case["valid"],
            "{case}"
        );
    }
}

#[test]
fn legacy_tiers_follow_the_recording() {
    let reference = recorded();
    for case in reference["legacy"].as_array().unwrap() {
        let Bson::Array(tiers) = from_ejson(&case["tiers"]).unwrap() else {
            panic!("tiers")
        };
        let rules: Vec<Value> = rules_from_legacy_tiers(Some(&tiers))
            .iter()
            .map(BitsRule::to_json)
            .collect();
        let mut expected = case["rules"].clone();
        // Intended difference (MIGRATION.md section 4): a legacy message is cut at 1000
        // characters, not 1000 UTF-16 units, so 600 emoji stay 600 (the reference kept 500).
        for rule in expected.as_array_mut().unwrap() {
            if rule["chat"]["message"] == "👋".repeat(500) {
                rule["chat"]["message"] = Value::from("👋".repeat(600));
            }
        }
        assert_eq!(Value::from(rules), expected, "{}", case["tiers"]);
    }
    assert!(rules_from_legacy_tiers(None).is_empty());
}

fn store(mongo: &dima_store::mongo::MongoStore, clock: &ManualClock) -> BitsRulesStore {
    BitsRulesStore::new(
        mongo.clone(),
        Arc::new(clock.clone()),
        BitsRulesConfig {
            deadline: std::time::Duration::from_secs(60),
        },
    )
}

#[tokio::test]
async fn store_writes_the_recorded_documents() -> Result<()> {
    let reference = recorded();
    with_database(|mongo, _| async move {
        let collection = mongo.documents("eventsubs");
        for seed in reference["eventsubSeeds"].as_array().unwrap() {
            let Bson::Document(seed) = from_ejson(seed)? else {
                anyhow::bail!("seed")
            };
            collection.insert_one(seed).await?;
        }
        let clock = ManualClock::new(0);
        let rules = store(&mongo, &clock);
        for found in reference["found"].as_array().unwrap() {
            let channel = found["channel"].as_str().unwrap();
            let eventsub = rules.find_bits_eventsub(channel).await?;
            assert_eq!(
                eventsub.as_ref().and_then(|e| e.id.clone()).map(Value::from).unwrap_or(Value::Null),
                found["id"],
                "{channel}"
            );
        }
        let created = parse_rule(
            &json!({"name": "Hype", "min": 100, "max": 999, "chat": {"mode": "custom", "message": "Hype $(user)!"}}),
            "rule-aaaaaaaaaaaa",
            None,
        )?;
        let tiers = reference["eventsubSeeds"][0]["cheerTiers"].clone();
        let Bson::Array(tiers) = from_ejson(&tiers)? else { anyhow::bail!("tiers") };
        let second = vec![tiers[1].clone()];
        let first = vec![tiers[0].clone()];
        for step in reference["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            clock.set(step["now"].as_i64().unwrap());
            let result = match name {
                "load-empty" => rules.load_bits_rules("400", LegacyTiers::Lookup).await,
                "load-legacy-lookup" => rules.load_bits_rules("100", LegacyTiers::Lookup).await,
                "load-legacy-given-null" => rules.load_bits_rules("100", LegacyTiers::Given(None)).await,
                "load-legacy-given" => rules.load_bits_rules("100", LegacyTiers::Given(Some(&second))).await,
                "load-legacy-type" => rules.load_bits_rules("200", LegacyTiers::Lookup).await,
                "load-canonical-wins" => rules.load_bits_rules("300", LegacyTiers::Lookup).await,
                "create-copies-legacy" => rules.change_bits_rules("100", "editor-1", |mut r| { r.push(created.clone()); Ok(r) }).await,
                "update" => rules.change_bits_rules("100", "editor-2", |mut r| {
                    let i = r.iter().position(|x| x.id == "rule-aaaaaaaaaaaa").unwrap();
                    r[i] = parse_rule(&json!({"enabled": false, "max": null}), &r[i].id.clone(), Some(&r[i]))?;
                    Ok(r)
                }).await,
                "delete" => rules.change_bits_rules("100", "editor-1", |r| Ok(r.into_iter().filter(|x| x.id != "tier-1").collect())).await,
                "refused-404" => rules.change_bits_rules("100", "editor-1", |r| {
                    if !r.iter().any(|x| x.id == "gone") {
                        return Err(BitsRuleError::with_status("This rule was already deleted.", 404));
                    }
                    Ok(r)
                }).await,
                "create-empty-channel" => rules.change_bits_rules("400", "editor-3", |_| Ok(vec![parse_rule(&json!({"min": 1, "chat": {"mode": "silent"}}), "only", None)?])).await,
                "load-stored" => rules.load_bits_rules("100", LegacyTiers::Given(Some(&first))).await,
                "clear-all" => rules.change_bits_rules("400", "editor-3", |_| Ok(Vec::new())).await,
                "load-cleared" => rules.load_bits_rules("400", LegacyTiers::Lookup).await,
                other => anyhow::bail!("unknown step {other}"),
            };
            let result = match result {
                Ok(state) => json!({"ok": state.to_json()}),
                Err(error) => json!({"error": error.to_string(), "status": error.status()}),
            };
            assert_eq!(result, step["result"], "{name}");
            assert_eq!(
                Value::from(documents(&mongo, "bits_rules").await?),
                step["documents"],
                "{name} documents"
            );
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn production_copy_reads_as_the_reference_read_it() -> Result<()> {
    let reference = recorded();
    let Some(mongo) = support::production().await? else {
        return Ok(());
    };
    let rules = store(&mongo, &ManualClock::new(0));
    let real = reference["real"].as_array().unwrap();
    assert!(!real.is_empty(), "the recording has production channels");
    for case in real {
        let channel = case["channel"].as_str().context("channel")?;
        let eventsub = rules.find_bits_eventsub(channel).await?;
        assert_eq!(
            eventsub
                .as_ref()
                .map(|e| e.object_id.to_hex())
                .map(Value::from)
                .unwrap_or(Value::Null),
            case["eventsub"]
        );
        let tiers = eventsub
            .as_ref()
            .and_then(|e| e.cheer_tiers.as_ref())
            .map(|t| t.0.as_slice());
        let state = rules
            .load_bits_rules(channel, LegacyTiers::Given(tiers))
            .await?;
        let lookup = rules.load_bits_rules(channel, LegacyTiers::Lookup).await?;
        let view = |r: &BitsRule| {
            json!({"id": r.id, "enabled": r.enabled, "min": r.min, "max": r.max,
            "mode": r.chat.mode.as_str(), "alert": r.alert, "name": sha(&r.name), "message": sha(&r.chat.message)})
        };
        assert_eq!(Value::from(state.revision), case["revision"]);
        assert_eq!(
            Value::from(state.rules.iter().map(view).collect::<Vec<_>>()),
            case["rules"]
        );
        assert_eq!(Value::from(lookup.revision), case["lookupRevision"]);
        assert_eq!(
            Value::from(lookup.rules.iter().map(view).collect::<Vec<_>>()),
            case["lookupRules"]
        );
        let default = eventsub
            .as_ref()
            .map(|e| e.message_text().to_owned())
            .unwrap_or_default();
        for row in case["table"].as_array().unwrap() {
            let bits = &row["bits"];
            let matched = match_bits_value(&state.rules, bits).map(|r| Value::from(r.id.clone()));
            assert_eq!(
                matched.unwrap_or(Value::Null),
                row["match"],
                "{channel} {bits}"
            );
            assert_eq!(
                Value::from(sha(&bits_chat_message(&state.rules, &default, bits))),
                row["chat"]
            );
        }
    }
    Ok(())
}

/// Many editors change one channel at once (several of them racing the first creation): every
/// edit lands exactly once, the revision counts them, and no edit is lost.
#[tokio::test]
async fn concurrent_changes_lose_no_edit_and_apply_none_twice() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(1_794_355_200_000);
        let rules = store(&mongo, &clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for n in 0..12_i64 {
            let rules = rules.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                // Each editor retries a 409 the way a person presses save again.
                loop {
                    let id = format!("rule-{n}");
                    let result = rules
                        .change_bits_rules("500", &format!("editor-{n}"), |mut r| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            assert!(!r.iter().any(|x| x.id == id), "an edit applied twice");
                            r.push(parse_rule(&json!({"min": n + 1, "max": n + 1}), &id, None)?);
                            Ok(r)
                        })
                        .await;
                    match result {
                        Ok(_) => return Ok::<_, anyhow::Error>(()),
                        Err(error) if error.status() == 409 => continue,
                        Err(error) => return Err(error.into()),
                    }
                }
            }));
        }
        for task in tasks {
            task.await??;
        }
        let state = rules.load_bits_rules("500", LegacyTiers::Lookup).await?;
        assert_eq!(state.revision, 12);
        let mut ids: Vec<_> = state.rules.iter().map(|r| r.id.clone()).collect();
        ids.sort();
        let mut expected: Vec<_> = (0..12).map(|n| format!("rule-{n}")).collect();
        expected.sort();
        assert_eq!(ids, expected);
        assert!(calls.load(Ordering::SeqCst) >= 12);
        Ok(())
    })
    .await
}

/// A writer that always changes the document between the read and the write: four attempts,
/// then the reference's 409, and nothing of the losing edit is stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_that_always_loses_gives_up_after_four_attempts() -> Result<()> {
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(1_794_355_200_000);
        let rules = store(&mongo, &clock);
        rules
            .change_bits_rules("600", "a", |_| Ok(Vec::new()))
            .await?;
        let attempts = Arc::new(AtomicUsize::new(0));
        let collection = mongo.documents("bits_rules");
        let result = rules
            .change_bits_rules("600", "b", |r| {
                attempts.fetch_add(1, Ordering::SeqCst);
                // The other editor saves between our read and our write.
                let collection = collection.clone();
                std::thread::spawn(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    runtime
                        .block_on(
                            collection
                                .update_one(doc! {"_id": "600"}, doc! {"$inc": {"revision": 1}})
                                .into_future(),
                        )
                        .unwrap();
                })
                .join()
                .unwrap();
                let mut r = r;
                r.push(parse_rule(&json!({"min": 1}), "lost", None)?);
                Ok(r)
            })
            .await;
        let error = result.expect_err("409");
        assert_eq!(
            (error.status(), error.to_string()),
            (
                409,
                "Your Bits rules were changed somewhere else at the same time. Try again."
                    .to_owned()
            )
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
        let state = rules.load_bits_rules("600", LegacyTiers::Lookup).await?;
        assert!(state.rules.is_empty());
        assert_eq!(state.revision, 5);
        Ok(())
    })
    .await
}
