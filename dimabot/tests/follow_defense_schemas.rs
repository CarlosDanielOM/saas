#![cfg(feature = "follow-defense-schemas")]
use dima_rust::schemas::{
    SchemaDefinition, follow_attack_log, follow_defense_action, follow_hate_raid_source,
};
use mongodb::bson::{self, DateTime, Document, doc, oid::ObjectId};
#[path = "support/model_schema_source.rs"]
mod model_schema_source;
fn schemas() -> [&'static SchemaDefinition; 4] {
    [
        follow_attack_log::schema(),
        follow_defense_action::action_schema(),
        follow_defense_action::control_schema(),
        follow_hate_raid_source::schema(),
    ]
}
fn inputs() -> [Document; 4] {
    let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let t = DateTime::from_millis(1_700_000_000_000);
    [
        doc! {"_id":oid,"targetChannelID":"c","modeTriggered":"attack","triggeredBy":"manual","trackedFollows":[{"followerID":"u","followedAt":t,"eventID":"e"}]},
        doc! {"_id":"a","channelID":"c","eventID":"e","kind":"ban","mode":"attack","authorizedAt":t,"nextAttemptAt":t,"expiresAt":t,"purgeAt":t},
        doc! {"_id":"c"},
        doc! {"_id":oid,"targetChannelID":"c","raiderChannelID":"r","firstSeenAt":t,"lastSeenAt":t,"appliedLogIDs":[oid]},
    ]
}
#[test]
fn definitions_defaults_nested_and_ttl() {
    let defs = schemas();
    let input = inputs();
    let now = DateTime::from_millis(1_900_000_000_000);
    for (schema, input) in defs.iter().zip(input) {
        let result = schema.prepare_insert(input, now).unwrap();
        if schema.timestamps.is_some() {
            assert_eq!(result.get_datetime("createdAt").unwrap(), &now);
            assert_eq!(result.get_datetime("updatedAt").unwrap(), &now)
        }
    }
    assert!(
        defs[0].write_concern_journaled
            && defs[1].write_concern_journaled
            && defs[2].write_concern_journaled
            && !defs[3].write_concern_journaled
    );
    assert!(defs[0].indexes.iter().all(|i| i.ttl.is_none()));
    assert_eq!(
        defs[1].indexes.iter().filter(|i| i.ttl.is_some()).count(),
        1
    );
    assert_eq!(defs[1].indexes[4].keys, doc! {"purgeAt":1});
    assert_eq!(defs[1].indexes[4].ttl.unwrap().as_secs(), 0);
    assert!(defs[2].indexes.iter().all(|i| i.ttl.is_none()));
    assert_eq!(defs[3].default_projection(), doc! {"appliedLogIDs":0});
    assert!(defs[3].indexes[2].unique);
    let log = defs[0].construct(&inputs()[0], now).unwrap();
    let rows = log.get_array("trackedFollows").unwrap();
    assert!(!rows[0].as_document().unwrap().contains_key("_id"));
    assert!(!rows[0].as_document().unwrap().get_bool("banned").unwrap());
    assert_eq!(
        defs[2]
            .construct(&inputs()[2], now)
            .unwrap()
            .get_i32("ratePerSecond")
            .unwrap(),
        5
    );
    let mut left = defs[0].construct(&inputs()[0], now).unwrap();
    let right = defs[0].construct(&inputs()[0], now).unwrap();
    left.get_array_mut("trackedFollows").unwrap().clear();
    assert_eq!(right.get_array("trackedFollows").unwrap().len(), 1);
    let mut absent = inputs()[3].clone();
    absent.remove("appliedLogIDs");
    assert!(
        !defs[3]
            .construct(&absent, now)
            .unwrap()
            .contains_key("appliedLogIDs")
    );
    absent.insert("appliedLogIDs", bson::Bson::Null);
    assert_eq!(
        defs[3]
            .construct(&absent, now)
            .unwrap()
            .get("appliedLogIDs"),
        Some(&bson::Bson::Null)
    );
    let mut null_child = inputs()[0].clone();
    null_child.insert("raidInfo", bson::Bson::Null);
    assert_eq!(
        defs[0].construct(&null_child, now).unwrap().get("raidInfo"),
        Some(&bson::Bson::Null)
    );
}

#[test]
fn declared_dtos_are_strict_and_preserve_bson_boundaries() {
    use dima_rust::schemas::follow_defense_schema_values::{
        FollowDefenseAction, IFollowAttackLog, IFollowAttackTrackedFollow, IFollowHateRaidSource,
    };
    use dima_rust::utils::js_string::JsString;
    let now = DateTime::from_millis(1_900_000_000_000);
    let defs = schemas();
    let source = inputs();
    let mut attack = defs[0].prepare_insert(source[0].clone(), now).unwrap();
    let _ = attack.remove("_id");
    let _ = attack.remove("__v");
    let typed = IFollowAttackLog::from_bson_document(&attack).unwrap();
    assert_eq!(typed.to_bson_document(), attack);
    let tracked = &typed.tracked_follows[0];
    assert_eq!(tracked.ban_status, None);
    let mut bad = tracked.to_bson_document();
    bad.insert("banStatus", bson::Bson::Null);
    assert!(IFollowAttackTrackedFollow::from_bson_document(&bad).is_err());
    let mut hate = defs[3].prepare_insert(source[3].clone(), now).unwrap();
    hate.remove("_id");
    hate.remove("__v");
    let typed = IFollowHateRaidSource::from_bson_document(&hate).unwrap();
    assert_eq!(typed.to_bson_document(), hate);
    hate.insert("appliedLogIDs", bson::Bson::Null);
    assert!(IFollowHateRaidSource::from_bson_document(&hate).is_err());
    let action = defs[1].prepare_insert(source[1].clone(), now).unwrap();
    let typed = FollowDefenseAction::from_bson_document(&action).unwrap();
    assert_eq!(typed.to_bson_document(), action);
    let mut changed = action.clone();
    changed.insert("followedAt", bson::Bson::Null);
    let typed = FollowDefenseAction::from_bson_document(&changed).unwrap();
    assert_eq!(typed.followed_at, Some(None));
    assert_eq!(typed.to_bson_document(), changed);
    changed.remove("followedAt");
    changed.remove("completedAt");
    let typed = FollowDefenseAction::from_bson_document(&changed).unwrap();
    assert_eq!(typed.followed_at, None);
    assert_eq!(typed.completed_at, None);
    assert_eq!(typed.to_bson_document(), changed);
    let mut tracked = tracked.clone();
    tracked.ban_message = Some(JsString::from_units(vec![0xd800]));
    let bson = tracked.to_bson_document();
    assert_eq!(bson.get_str("banMessage").unwrap(), "�");
}
fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
#[ignore = "requires independent pinned source fixture for current TZ"]
fn replay_actual_source() {
    use std::{fs, path::PathBuf};
    let path = PathBuf::from(std::env::var("FOLLOW_DEFENSE_SCHEMA_ORACLE").unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(
        path.is_absolute()
            && fs::canonicalize(&path).unwrap() == path
            && !path.starts_with(root.parent().unwrap())
    );
    assert!(fs::symlink_metadata(&path).unwrap().is_file());
    let bytes = fs::read(path).unwrap();
    assert_eq!(
        model_schema_source::sha256(&bytes),
        std::env::var("FOLLOW_DEFENSE_SCHEMA_ORACLE_SHA256").unwrap()
    );
    let f: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        f["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(f["zone"], std::env::var("TZ").unwrap());
    assert_eq!(
        f["versions"],
        serde_json::json!({"node":"24.22.1","v8":"13.6.233.17-node.58","icu":"78.3","unicode":"17.0","typescript":"5.9.3","mongoose":"8.24.2","bson":"6.10.4"})
    );
    let files = [
        "src/schemas/follow_attack_log.schema.rs",
        "src/schemas/follow_defense_action.schema.rs",
        "src/schemas/follow_hate_raid_source.schema.rs",
        "src/schemas/follow_defense_schema_values.rs",
        "src/schemas/ordinary_model_values.rs",
        "src/schemas/schema.rs",
        "src/utils/bson_compat.rs",
        "src/utils/mongoose_date.rs",
        "src/utils/js_string.rs",
        "tests/follow_defense_schemas.rs",
        "tests/support/model_schema_source.rs",
        "tests/fixtures/model_schema_source.cjs",
        "tests/fixtures/follow_defense_schemas_reference.cjs",
        "tests/support/sha256.rs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "package.json",
        "package-lock.json",
    ];
    assert_eq!(f["hashes"].as_object().unwrap().len(), files.len());
    for file in files {
        assert_eq!(
            f["hashes"][file].as_str().unwrap(),
            model_schema_source::sha256(&fs::read(root.join(file)).unwrap())
        );
    }
    for (file, pin) in [
        (
            "src/schemas/follow_attack_log.schema.ts",
            "418077f7dae3dbfbea4e800eb1444920de2c202828dbe97b87c3e074cea0b032",
        ),
        (
            "src/schemas/follow_defense_action.schema.ts",
            "0b56200c8aa2ad0c29668c82da87354517774c2e523e448868daf4c7fafc9cf4",
        ),
        (
            "src/schemas/follow_hate_raid_source.schema.ts",
            "8b2321fcf3eed917304bd3d2e03bf975b5351a3a37494cbe1e8ad54947c1215e",
        ),
    ] {
        let bytes = model_schema_source::archived(&root, file);
        assert_eq!(model_schema_source::sha256(&bytes), pin);
        assert_eq!(f["sourceHashes"][file], pin);
        assert_eq!(
            f["sourceProvenance"][file],
            model_schema_source::provenance(file)
        );
    }
    let defs = schemas();
    let metadata = f["metadata"].as_array().unwrap();
    assert_eq!(metadata.len(), 4);
    for (schema, meta) in defs.iter().zip(metadata) {
        assert_eq!(meta["model"], schema.model);
        assert_eq!(meta["collection"], schema.collection);
        assert_eq!(meta["timestamps"], schema.timestamps.is_some());
        assert_eq!(
            meta["versionKey"],
            if schema.version_key {
                serde_json::json!("__v")
            } else {
                serde_json::json!(false)
            }
        );
        assert_eq!(
            meta["writeConcern"],
            if schema.write_concern_journaled {
                serde_json::json!({"w":1,"j":true})
            } else {
                serde_json::Value::Null
            }
        );
        let indexes = meta["indexes"].as_array().unwrap();
        assert_eq!(indexes.len(), schema.indexes.len());
        for (actual, expected) in indexes.iter().zip(&schema.indexes) {
            assert_eq!(
                actual["keys"],
                serde_json::to_value(&expected.keys).unwrap()
            );
            assert_eq!(actual["unique"], expected.unique);
            assert_eq!(
                actual["ttl"],
                serde_json::json!(expected.ttl.map(|v| v.as_secs()))
            );
        }
        let hidden = schema
            .fields
            .iter()
            .filter(|field| field.hidden)
            .map(|field| field.name)
            .collect::<Vec<_>>();
        assert_eq!(meta["hidden"], serde_json::json!(hidden));
    }
    let ast = f["astEvidence"].as_array().unwrap();
    assert_eq!(ast.len(), 3);
    for (item, expected) in ast.iter().zip([
        vec!["FollowAttackLogSchema"],
        vec!["FollowDefenseActionSchema", "FollowDefenseControlSchema"],
        vec!["FollowHateRaidSourceSchema"],
    ]) {
        assert_eq!(item["exports"], serde_json::json!(expected));
    }
    let type_evidence = f["typeEvidence"].as_array().unwrap();
    for name in [
        "FollowDefenseMode",
        "FollowDefenseTriggerSource",
        "IFollowAttackTrackedFollow",
        "IFollowAttackRaidInfo",
        "IFollowAttackLog",
        "FollowDefenseAction",
        "IFollowHateRaidSource",
    ] {
        assert_eq!(
            type_evidence.iter().filter(|v| v["name"] == name).count(),
            1,
            "missing source type {name}"
        );
    }
    for (name, fields) in [
        (
            "IFollowAttackTrackedFollow",
            vec![
                "followerID",
                "followerLogin",
                "followerName",
                "followedAt",
                "eventID",
                "banned",
                "banStatus",
                "banMessage",
            ],
        ),
        (
            "IFollowAttackRaidInfo",
            vec![
                "raiderChannelID",
                "raiderChannelLogin",
                "raiderChannelName",
                "raidViewers",
            ],
        ),
        (
            "IFollowAttackLog",
            vec![
                "targetChannelID",
                "targetChannelLogin",
                "targetChannelName",
                "modeTriggered",
                "triggeredBy",
                "totalFollows",
                "velocity",
                "durationSeconds",
                "isRaid",
                "raidInfo",
                "trackedFollows",
                "isHateRaid",
                "createdAt",
                "updatedAt",
            ],
        ),
        (
            "IFollowHateRaidSource",
            vec![
                "targetChannelID",
                "targetChannelLogin",
                "targetChannelName",
                "raiderChannelID",
                "raiderChannelLogin",
                "raiderChannelName",
                "count",
                "appliedLogIDs",
                "firstSeenAt",
                "lastSeenAt",
                "createdAt",
                "updatedAt",
            ],
        ),
    ] {
        let t = type_evidence.iter().find(|v| v["name"] == name).unwrap();
        let actual = t["properties"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(actual, fields);
    }
    for (name, optional) in [
        (
            "IFollowAttackTrackedFollow",
            vec!["banStatus", "banMessage"],
        ),
        ("IFollowAttackLog", vec!["raidInfo"]),
        ("IFollowHateRaidSource", vec!["appliedLogIDs"]),
        ("FollowDefenseAction", vec!["followedAt", "completedAt"]),
    ] {
        let t = type_evidence.iter().find(|v| v["name"] == name).unwrap();
        let actual = t["properties"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["optional"] == true)
            .map(|v| v["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(actual, optional, "{name} optional properties");
    }
    let inferred = type_evidence
        .iter()
        .find(|v| v["name"] == "FollowDefenseAction")
        .unwrap();
    for name in ["followedAt", "completedAt"] {
        let p = inferred["properties"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap();
        let ty = p["type"].as_str().unwrap();
        assert!(
            ty.contains("null") && ty.contains("undefined"),
            "{name}: {ty}"
        );
    }
    let mut fields = inferred["properties"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    fields.sort_unstable();
    let mut expected = vec![
        "_id",
        "channelID",
        "eventID",
        "kind",
        "followerID",
        "authorization",
        "raidSessionID",
        "raidFollowerID",
        "raidRequestID",
        "reason",
        "message",
        "mode",
        "authorizedAt",
        "followedAt",
        "status",
        "nextAttemptAt",
        "lockedUntil",
        "leaseToken",
        "attempts",
        "failures",
        "lastStatus",
        "lastMessage",
        "completedAt",
        "expiresAt",
        "purgeAt",
        "auditPending",
        "createdAt",
        "updatedAt",
    ];
    expected.sort_unstable();
    assert_eq!(fields, expected);
    assert_eq!(
        f["sdkHashes"]["typescript"],
        "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675"
    );
    assert_eq!(
        f["sdkHashes"]["typescriptPackage"],
        "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6"
    );
    let typed = f["typedCases"].as_array().unwrap();
    assert_eq!(typed.len(), 3);
    for item in typed {
        let model = item["model"].as_u64().unwrap();
        let expected: Document =
            bson::deserialize_from_slice(&decode_hex(item["outputHex"].as_str().unwrap())).unwrap();
        let actual=match model {0=>dima_rust::schemas::follow_defense_schema_values::IFollowAttackLog::from_bson_document(&expected).unwrap().to_bson_document(),1=>dima_rust::schemas::follow_defense_schema_values::FollowDefenseAction::from_bson_document(&expected).unwrap().to_bson_document(),3=>dima_rust::schemas::follow_defense_schema_values::IFollowHateRaidSource::from_bson_document(&expected).unwrap().to_bson_document(),_=>panic!("unexpected typed model")};
        assert_eq!(actual, expected);
    }
    let required = [
        "0:targetChannelID",
        "0:modeTriggered",
        "0:triggeredBy",
        "0:trackedFollows.0.followerID",
        "0:trackedFollows.0.followedAt",
        "0:trackedFollows.0.eventID",
        "0:raidInfo.raiderChannelID",
        "1:_id",
        "1:channelID",
        "1:eventID",
        "1:kind",
        "1:mode",
        "1:authorizedAt",
        "1:status",
        "1:nextAttemptAt",
        "1:expiresAt",
        "1:purgeAt",
        "2:_id",
        "3:targetChannelID",
        "3:raiderChannelID",
        "3:firstSeenAt",
        "3:lastSeenAt",
    ];
    let optional = [
        "0:raidInfo",
        "0:trackedFollows.0.banStatus",
        "0:trackedFollows.0.banMessage",
        "1:followedAt",
        "1:completedAt",
        "3:appliedLogIDs",
    ];
    let dates = [
        "0:trackedFollows.0.followedAt",
        "0:createdAt",
        "0:updatedAt",
        "1:authorizedAt",
        "1:followedAt",
        "1:nextAttemptAt",
        "1:lockedUntil",
        "1:completedAt",
        "1:expiresAt",
        "1:purgeAt",
        "1:createdAt",
        "1:updatedAt",
        "2:cancelledThrough",
        "2:pendingUntil",
        "2:nextAllowedAt",
        "2:lastServedAt",
        "2:lockedUntil",
        "3:firstSeenAt",
        "3:lastSeenAt",
        "3:createdAt",
        "3:updatedAt",
    ];
    let date_tags = [
        "zero",
        "fraction",
        "negative",
        "utc",
        "invalid",
        "spring",
        "autumn",
        "apia",
        "lord-howe",
    ];
    assert_eq!(f["coverage"]["required"], serde_json::json!(required));
    assert_eq!(f["coverage"]["optional"], serde_json::json!(optional));
    assert_eq!(f["coverage"]["dates"], serde_json::json!(dates));
    assert_eq!(f["coverage"]["dateTags"], serde_json::json!(date_tags));
    let cases = f["cases"].as_array().unwrap();
    for (prefix, fields, tags) in [
        (
            "required",
            required.as_slice(),
            ["missing", "null", "empty"].as_slice(),
        ),
        (
            "optional",
            optional.as_slice(),
            ["missing", "null", "present"].as_slice(),
        ),
        ("date", dates.as_slice(), date_tags.as_slice()),
    ] {
        for field in fields {
            let (model, path) = field.split_once(':').unwrap();
            for tag in tags {
                let label = format!("{prefix}-{model}-{path}-{tag}");
                assert_eq!(
                    cases.iter().filter(|case| case["label"] == label).count(),
                    1,
                    "{label}"
                );
            }
        }
    }
    assert_eq!(cases.len(), 321);
    assert_eq!(f["caseCount"], 321);
    let mut mismatches = Vec::new();
    for case in cases {
        let index = case["model"].as_u64().unwrap() as usize;
        let input: Document =
            bson::deserialize_from_slice(&decode_hex(case["inputHex"].as_str().unwrap())).unwrap();
        let actual = defs[index].construct(&input, DateTime::from_millis(1_900_000_000_000));
        let expected_errors = case["errors"].as_array().unwrap();
        if expected_errors.is_empty() {
            let expected: Document =
                bson::deserialize_from_slice(&decode_hex(case["outputHex"].as_str().unwrap()))
                    .unwrap();
            match actual {
                Ok(value) if value == expected => (),
                other => mismatches.push(format!(
                    "{}: expected {expected:?}, actual {other:?}",
                    case["label"]
                )),
            }
        } else {
            let expected = expected_errors
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            match actual {
                Err(errors) => {
                    let mut paths = errors.0.into_iter().map(|e| e.path).collect::<Vec<_>>();
                    paths.sort();
                    if paths != expected {
                        mismatches.push(format!(
                            "{}: expected {expected:?}, actual {paths:?}",
                            case["label"]
                        ));
                    }
                }
                Ok(value) => mismatches.push(format!(
                    "{}: expected errors {expected:?}, actual {value:?}",
                    case["label"]
                )),
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
#[tokio::test]
#[ignore = "requires isolated owner-labelled private keyword Mongo"]
async fn private_mongo_repositories_indexes_and_projection() {
    use futures_util::{FutureExt, TryStreamExt};
    use std::panic::AssertUnwindSafe;
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("FOLLOW_DEFENSE_SCHEMA_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let ns = std::env::var("FOLLOW_DEFENSE_SCHEMA_NAMESPACE").unwrap();
    let token = ns
        .strip_prefix("keyword-fixture-")
        .and_then(|v| v.strip_suffix(':'))
        .unwrap();
    assert!((6..=32).contains(&token.len()) && token.bytes().all(|v| v.is_ascii_alphanumeric()));
    let client = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("follow_defense_schema_{token}"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let test = AssertUnwindSafe(async {
        let marker = db.collection::<Document>("__fixture_owner");
        marker
            .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","namespace":&ns})
            .await
            .unwrap();
        let repos = [
            follow_attack_log::get_follow_attack_log_model(&db),
            follow_defense_action::get_follow_defense_action_model(&db),
            follow_defense_action::get_follow_defense_control_model(&db),
            follow_hate_raid_source::get_follow_hate_raid_source_model(&db),
        ];
        let now = DateTime::from_millis(1_900_000_000_000);
        for (i, (repo, input)) in repos.iter().zip(inputs()).enumerate() {
            repo.schema.install_indexes(&db).await.unwrap();
            assert_eq!(repo.collection.write_concern().is_some(), i != 3);
            if i != 3 {
                let concern = repo.collection.write_concern().unwrap();
                assert!(matches!(
                    concern.w.as_ref(),
                    Some(mongodb::options::Acknowledgment::Nodes(1))
                ));
                assert_eq!(concern.journal, Some(true));
            }
            let indexes: Vec<_> = repo
                .collection
                .list_indexes()
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            for expected in &repo.schema.indexes {
                assert!(indexes.iter().any(|index| {
                    index.keys == expected.keys
                        && index
                            .options
                            .as_ref()
                            .and_then(|v| v.unique)
                            .unwrap_or(false)
                            == expected.unique
                        && index.options.as_ref().and_then(|v| v.expire_after) == expected.ttl
                }));
            }
            let id = input.get("_id").unwrap().clone();
            repo.insert(input, now).await.unwrap();
            repo.collection
                .update_one(
                    doc! {"_id":id.clone()},
                    doc! {"$set":{"fixtureSentinel":"changed"}},
                )
                .await
                .unwrap();
            assert_eq!(
                repo.find_one_with_hidden(doc! {"_id":id})
                    .await
                    .unwrap()
                    .unwrap()
                    .get_str("fixtureSentinel")
                    .unwrap(),
                "changed"
            );
        }
        let found = repos[3]
            .find_one(doc! {"targetChannelID":"c"})
            .await
            .unwrap()
            .unwrap();
        assert!(!found.contains_key("appliedLogIDs"));
        let found = repos[3]
            .find_one_with_hidden(doc! {"targetChannelID":"c"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.get_array("appliedLogIDs").unwrap().len(), 1);
        let mut duplicate = inputs()[3].clone();
        duplicate.insert("_id", ObjectId::new());
        assert!(repos[3].insert(duplicate, now).await.is_err());
        let controls = repos[2].find_one(doc! {"_id":"c"}).await.unwrap().unwrap();
        assert_eq!(controls.get_i32("ratePerSecond").unwrap(), 5);
        for (repo, input) in repos.iter().zip(inputs()) {
            let id = input.get("_id").unwrap();
            let deleted = repo
                .collection
                .delete_one(doc! {"_id":id.clone()})
                .await
                .unwrap();
            assert_eq!(deleted.deleted_count, 1);
            assert!(
                repo.find_one_with_hidden(doc! {"_id":id.clone()})
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    })
    .catch_unwind()
    .await;
    let marker = db
        .collection::<Document>("__fixture_owner")
        .find_one(doc! {"_id":"owner","owner":"dimabot-migration","namespace":&ns})
        .await
        .unwrap();
    if marker.is_some() {
        db.drop().await.unwrap();
    }
    if let Err(error) = test {
        std::panic::resume_unwind(error)
    }
    assert!(marker.is_some(), "fixture ownership marker missing");
}
