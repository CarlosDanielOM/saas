#![cfg(feature = "command-reward-schemas")]
//! Command and redemption-reward schema checks.
//!
//! Ignored tests need the parent wiring and, for the oracle, a fixture written
//! outside this checkout. The private Mongo test is ownership-guarded.

use dima_rust::schemas::commands::{
    BlocksInspection, ICommands, inspect_blocks, inspect_permission_expression,
};
use dima_rust::schemas::redemption_reward::IRedemptionReward;
use dima_rust::schemas::{
    FieldDefault, FieldType, PersistenceError, SchemaDefinition, commands, redemption_reward,
};
use dima_rust::utils::availability::{
    AvailabilityClock, AvailabilityWriteError, DriverUpdate, FIXED_STATE_KEYS, QueryUpdate,
    WriteOrigin, availability_key, availability_state, driver_update, enabled_save_replaces,
    js_boolean, prepare_availability_update,
};
use dima_rust::utils::permissions::{ExpressionState, ValidationErrorCode};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const FIXED_MS: i64 = 1_900_000_000_000;
const TOKEN: &str = "11111111-1111-4111-8111-111111111111";
const COMMANDS_TS: &str = "1a6ed070b37a850b9d358a86b2f97ff0a5e6b977f41ac7b51f2b01e0d9bb7da3";
const REWARDS_TS: &str = "acc13c1d532d1078bbbb3d8260c7815565e63cae003fbad00564930b6b53e5a2";
const AVAILABILITY_TS: &str = "98785af1992534d8d723cd429626d4da268aa8bf41023b3e12b01b2bdc4a2b26";

fn fixed_now() -> DateTime {
    DateTime::from_millis(FIXED_MS)
}

fn clock(tokens: impl IntoIterator<Item = impl Into<String>>) -> AvailabilityClock {
    AvailabilityClock::fixed(fixed_now(), tokens)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn field<'a>(schema: &'a SchemaDefinition, name: &str) -> &'a dima_rust::schemas::Field {
    schema
        .fields
        .iter()
        .find(|field| field.name == name)
        .expect(name)
}

fn hook(
    update: Document,
    field_name: &str,
    origin: WriteOrigin,
    clock: &AvailabilityClock,
) -> Document {
    match prepare_availability_update(QueryUpdate::Document(update), field_name, origin, clock)
        .unwrap()
    {
        QueryUpdate::Document(document) => document,
        other => panic!("expected a document update, got {other:?}"),
    }
}

fn driven(
    update: Document,
    field_name: &str,
    origin: WriteOrigin,
    clock: &AvailabilityClock,
) -> Document {
    match driver_update(QueryUpdate::Document(update), field_name, origin, clock).unwrap() {
        DriverUpdate::Document(document) => document,
        other => panic!("expected a document driver update, got {other:?}"),
    }
}

fn assert_state(value: &Bson, token: &str, previous: bool) {
    let state = value.as_document().expect("availability state");
    assert_eq!(
        state.keys().map(String::as_str).collect::<Vec<_>>(),
        FIXED_STATE_KEYS
    );
    assert_eq!(state.get_str("token").unwrap(), token);
    assert_eq!(state.get_bool("previousEnabled").unwrap(), previous);
    assert!(matches!(state.get("restoreAt"), Some(Bson::Null)));
    assert!(state.get_bool("pending").unwrap());
    assert_eq!(
        state.get_datetime("nextAt").unwrap().timestamp_millis(),
        FIXED_MS
    );
}

fn error_map(schema: &SchemaDefinition, input: Document) -> BTreeMap<String, String> {
    schema
        .construct(&input, fixed_now())
        .expect_err("validation")
        .0
        .into_iter()
        .map(|error| (error.path, error.kind.to_owned()))
        .collect()
}

#[test]
fn source_pins() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (path, pin) in [
        ("src/schemas/commands.schema.ts", COMMANDS_TS),
        ("src/schemas/redemption_reward.schema.ts", REWARDS_TS),
        ("src/utils/availability/schema.ts", AVAILABILITY_TS),
    ] {
        let bytes = std::fs::read(root.join(path)).unwrap();
        assert_eq!(sha256_hex(&bytes), pin, "{path}");
    }
}

#[test]
fn schema_metadata_defaults_and_projection() {
    let commands_schema = commands::schema();
    let rewards = redemption_reward::schema();
    assert_eq!(commands::MODEL_NAME, "Commands");
    assert_eq!(commands::COLLECTION_NAME, "commands");
    assert_eq!(commands::EXPORT_NAME, "CommandsSchema");
    assert_eq!(commands::ENABLED_FIELD, "enabled");
    assert_eq!(commands_schema.model, commands::MODEL_NAME);
    assert_eq!(commands_schema.collection, commands::COLLECTION_NAME);
    assert!(commands_schema.version_key);
    assert!(commands_schema.timestamps.is_none());
    assert!(!commands_schema.string_id);
    assert!(!commands_schema.write_concern_journaled);
    assert_eq!(commands_schema.indexes.len(), 1);
    assert!(commands_schema.indexes[0].sparse);
    assert!(commands_schema.indexes[0].ttl.is_none());
    assert!(!commands_schema.indexes[0].unique);
    assert_eq!(
        commands_schema.indexes[0].keys,
        doc! {"availability.nextAt": 1}
    );
    assert_eq!(
        commands_schema
            .default_projection()
            .get_i32("blocks")
            .unwrap(),
        0
    );
    assert_eq!(
        commands_schema
            .default_projection()
            .get_i32("availability")
            .unwrap(),
        0
    );
    assert_eq!(
        commands_schema
            .default_projection()
            .get_i32("availabilityLease")
            .unwrap(),
        0
    );
    assert_eq!(commands_schema.default_projection().len(), 3);
    assert!(field(commands_schema, "blocks").hidden);
    assert!(field(commands_schema, "availability").hidden);
    assert!(field(commands_schema, "availabilityLease").hidden);
    assert!(matches!(
        field(commands_schema, "blocks").default,
        FieldDefault::Null
    ));
    assert!(matches!(
        field(commands_schema, "keywordSettings").default,
        FieldDefault::Missing
    ));
    match &field(commands_schema, "keywordSettings").kind {
        FieldType::Subdocument {
            generate_id,
            fields,
        } => {
            assert!(!*generate_id);
            assert!(matches!(fields[0].default, FieldDefault::String("start")));
            assert_eq!(fields[0].enum_values, ["start", "anywhere", "exact"]);
        }
        other => panic!("keywordSettings {other:?}"),
    }
    match &field(commands_schema, "date").kind {
        FieldType::Object(children) => {
            assert!(matches!(
                children
                    .iter()
                    .find(|field| field.name == "day")
                    .unwrap()
                    .default,
                FieldDefault::LocalDay
            ));
            assert!(matches!(
                children
                    .iter()
                    .find(|field| field.name == "month")
                    .unwrap()
                    .default,
                FieldDefault::LocalMonth
            ));
            assert!(matches!(
                children
                    .iter()
                    .find(|field| field.name == "year")
                    .unwrap()
                    .default,
                FieldDefault::LocalYear
            ));
        }
        other => panic!("date {other:?}"),
    }
    assert!(matches!(
        field(commands_schema, "permissions").default,
        FieldDefault::Object
    ));
    assert!(matches!(
        &field(commands_schema, "variables").kind,
        FieldType::Map(_)
    ));
    assert!(matches!(
        field(commands_schema, "createdAt").default,
        FieldDefault::Now
    ));
    assert!(field(commands_schema, "channelID").required);

    let now = fixed_now();
    let built = commands_schema
        .construct(&doc! {"channelID": "c"}, now)
        .unwrap();
    assert_eq!(built.get_str("activation").unwrap(), "command");
    assert_eq!(built.get_str("message").unwrap(), "");
    assert_eq!(built.get_str("authoring").unwrap(), "text");
    assert!(built.get("keywordSettings").is_none());
    assert_eq!(built.get("blocks"), Some(&Bson::Null));
    assert!(built.get_array("responses").unwrap().is_empty());
    assert!(built.get_document("variables").unwrap().is_empty());
    assert_eq!(built.get_str("type").unwrap(), "command");
    assert_eq!(built.get_str("platform").unwrap(), "twitch");
    assert!(!built.get_bool("reserved").unwrap());
    assert_eq!(
        built.get_str("description").unwrap(),
        "No description provided."
    );
    assert_eq!(built.get_i32("cooldown").unwrap(), 20);
    assert_eq!(built.get_i32("count").unwrap(), 0);
    assert_eq!(built.get_str("userLevelName").unwrap(), "everyone");
    assert_eq!(built.get_i32("userLevel").unwrap(), 0);
    assert_eq!(built.get("permissionExpression"), Some(&Bson::Null));
    assert!(built.get("permissions").is_none());
    assert!(built.get_bool("enabled").unwrap());
    assert!(!built.get_bool("paused").unwrap());
    assert!(built.get("channel").is_none());
    assert!(!built.get_bool("premiumRequired").unwrap());
    assert_eq!(built.get_i32("premiumLevelRequired").unwrap(), 0);
    assert_eq!(built.get_datetime("createdAt").unwrap(), &now);
    let date = built.get_document("date").unwrap();
    assert!((1..=31).contains(&date.get_i32("day").unwrap()));
    assert!((1..=12).contains(&date.get_i32("month").unwrap()));
    assert!(date.get_i32("year").unwrap() >= 1970);
    assert!(built.get("availability").is_none());
    assert!(built.get("availabilityLease").is_none());
    assert!(!built.contains_key("__v"));
    assert!(!built.contains_key("name"));
    assert_eq!(
        commands_schema
            .prepare_insert(doc! {"channelID": "c"}, now)
            .unwrap()
            .get_i32("__v")
            .unwrap(),
        0
    );
    let responses = commands_schema
        .construct(&doc! {"channelID": "c", "responses": [1, "a"]}, now)
        .unwrap();
    assert_eq!(responses.get_array("responses").unwrap()[0], Bson::Int32(1));
    assert_eq!(
        responses.get_array("responses").unwrap()[1],
        Bson::String("a".into())
    );
    let keyword = commands_schema
        .construct(&doc! {"channelID": "c", "keywordSettings": {}}, now)
        .unwrap();
    let settings = keyword.get_document("keywordSettings").unwrap();
    assert_eq!(settings.get_str("matchMode").unwrap(), "start");
    assert!(!settings.contains_key("_id"));
    assert!(
        !commands_schema
            .construct(&doc! {"channelID": "c", "notAField": 1}, now)
            .unwrap()
            .contains_key("notAField")
    );
    assert_eq!(
        error_map(commands_schema, doc! {}),
        BTreeMap::from([("channelID".to_owned(), "required".to_owned())])
    );
    assert_eq!(
        error_map(
            commands_schema,
            doc! {"channelID": "c", "activation": "nope"}
        ),
        BTreeMap::from([("activation".to_owned(), "enum".to_owned())])
    );

    assert_eq!(redemption_reward::MODEL_NAME, "redemptionreward");
    assert_eq!(redemption_reward::COLLECTION_NAME, "redemptionrewards");
    assert_eq!(redemption_reward::EXPORT_NAME, "RedemptionRewardSchema");
    assert_eq!(redemption_reward::ENABLED_FIELD, "isEnabled");
    assert_eq!(rewards.collection, "redemptionrewards");
    assert!(rewards.version_key && rewards.timestamps.is_none());
    assert_eq!(rewards.indexes.len(), 1);
    assert!(rewards.indexes[0].sparse && rewards.indexes[0].ttl.is_none());
    assert_eq!(rewards.default_projection().len(), 2);
    assert!(field(rewards, "availability").hidden);
    assert!(matches!(
        field(rewards, "backgroundColor").default,
        FieldDefault::Missing
    ));
    let reward = rewards
        .construct(
            &doc! {
                "eventsubID": "e", "channelID": "c", "channel": "name",
                "rewardID": "r", "title": "t", "originalCost": 10, "cost": 4
            },
            now,
        )
        .unwrap();
    assert_eq!(reward.get_str("type").unwrap(), "custom");
    assert_eq!(reward.get_str("prompt").unwrap(), "");
    assert!(reward.get_bool("isEnabled").unwrap());
    assert_eq!(reward.get_str("message").unwrap(), "");
    assert_eq!(reward.get_i32("costChange").unwrap(), 0);
    assert!(!reward.get_bool("returnToOriginalCost").unwrap());
    assert_eq!(reward.get_i32("duration").unwrap(), 0);
    assert_eq!(reward.get_i32("cooldown").unwrap(), 0);
    assert_eq!(reward.get_str("createdFrom").unwrap(), "domdimabot");
    assert_eq!(reward.get_str("createdFor").unwrap(), "twitch");
    assert!(reward.get("backgroundColor").is_none());
    assert!(reward.get("availability").is_none());
    assert!(!reward.contains_key("__v"));
    assert_eq!(
        error_map(
            rewards,
            doc! {
                "eventsubID": "e", "channelID": "c", "channel": "name",
                "rewardID": "r", "originalCost": 10, "cost": 4
            },
        ),
        BTreeMap::from([("title".to_owned(), "required".to_owned())])
    );
}

#[test]
fn query_hook_strips_and_replaces_enabled() {
    assert!(availability_key("availability"));
    assert!(availability_key("availability.nextAt"));
    assert!(availability_key("availabilityLease"));
    assert!(availability_key("availabilityLease.token"));
    assert!(!availability_key("availabilityX"));
    assert!(!availability_key("availabilityLeases"));
    assert!(!availability_key("enabled"));

    let same = hook(
        doc! {"enabled": true},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["same"]),
    );
    assert!(same.get_bool("enabled").unwrap());
    assert_state(
        same.get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "same",
        true,
    );
    let sugared = driven(
        doc! {"enabled": true},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["sugar"]),
    );
    assert_eq!(sugared.len(), 1);
    let set = sugared.get_document("$set").unwrap();
    assert!(set.get_bool("enabled").unwrap());
    assert_state(set.get("availability").unwrap(), "sugar", true);

    let disabled = hook(
        doc! {"$set": {"enabled": false, "message": "m"}},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["off"]),
    );
    assert_eq!(
        disabled
            .get_document("$set")
            .unwrap()
            .get_str("message")
            .unwrap(),
        "m"
    );
    assert_state(
        disabled
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "off",
        false,
    );

    let fallthrough = hook(
        doc! {"enabled": true, "$set": {"enabled": Bson::Null}},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["fall"]),
    );
    assert_state(
        fallthrough
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "fall",
        true,
    );
    // `$set.enabled ?? enabled`: a null `$set` value falls through. With no root
    // value the result is undefined, so the hook does not install a state.
    let only_null = hook(
        doc! {"$set": {"enabled": Bson::Null}},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["null"]),
    );
    assert!(matches!(
        only_null.get_document("$set").unwrap().get("enabled"),
        Some(Bson::Null)
    ));
    assert!(
        only_null
            .get_document("$set")
            .unwrap()
            .get("availability")
            .is_none()
    );
    let root_null = hook(
        doc! {"enabled": Bson::Null},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["root-null"]),
    );
    assert!(matches!(root_null.get("enabled"), Some(Bson::Null)));
    assert_state(
        root_null
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "root-null",
        false,
    );
    let text = hook(
        doc! {"enabled": "false"},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["text"]),
    );
    assert_state(
        text.get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "text",
        true,
    );
    assert!(js_boolean(&Bson::String("false".into())));
    assert!(!js_boolean(&Bson::Boolean(false)));
    assert!(!js_boolean(&Bson::String(String::new())));

    let stripped = hook(
        doc! {
            "enabled": true,
            "availability": {"token": "no"},
            "availabilityX": "keep",
            "availabilityLeases": "keep",
            "$set": {"availability.nextAt": 1, "availabilityLease.token": "x", "message": "m"},
            "$unset": {"availability.token": 1, "description": 1},
            "$setOnInsert": {"availabilityLease": {"token": "z"}, "channel": "c"}
        },
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["strip"]),
    );
    assert!(stripped.get("availability").is_none());
    assert_eq!(stripped.get_str("availabilityX").unwrap(), "keep");
    assert_eq!(stripped.get_str("availabilityLeases").unwrap(), "keep");
    let set = stripped.get_document("$set").unwrap();
    assert_eq!(set.get_str("message").unwrap(), "m");
    assert!(!set.contains_key("availability.nextAt"));
    assert!(!set.contains_key("availabilityLease.token"));
    assert_state(set.get("availability").unwrap(), "strip", true);
    assert_eq!(
        stripped
            .get_document("$unset")
            .unwrap()
            .get_i32("description")
            .unwrap(),
        1
    );
    assert!(
        !stripped
            .get_document("$unset")
            .unwrap()
            .contains_key("availability.token")
    );
    let insert = stripped.get_document("$setOnInsert").unwrap();
    assert_eq!(insert.get_str("channel").unwrap(), "c");
    assert!(!insert.contains_key("availabilityLease"));
    let insert_only = hook(
        doc! {"$setOnInsert": {"enabled": true, "availability": {"token": "x"}}},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["unused"]),
    );
    assert!(insert_only.get("$set").is_none());
    assert!(
        insert_only
            .get_document("$setOnInsert")
            .unwrap()
            .get_bool("enabled")
            .unwrap()
    );
    assert!(
        !insert_only
            .get_document("$setOnInsert")
            .unwrap()
            .contains_key("availability")
    );

    let internal = doc! {"enabled": true, "availability": {"token": "keep"}};
    assert_eq!(
        hook(
            internal.clone(),
            "enabled",
            WriteOrigin::Internal,
            &clock(["nope"])
        ),
        internal
    );
    let internal_set = driven(internal, "enabled", WriteOrigin::Internal, &clock(["nope"]));
    let set = internal_set.get_document("$set").unwrap();
    assert!(set.get_bool("enabled").unwrap());
    assert_eq!(
        set.get_document("availability")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "keep"
    );

    let payload = hook(
        doc! {"enabled": false, "internalAvailabilityWrite": true},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["payload"]),
    );
    assert!(payload.get_bool("internalAvailabilityWrite").unwrap());
    assert_state(
        payload
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "payload",
        false,
    );

    let empty_unset = driven(
        doc! {"$unset": {"availability.token": 1}, "enabled": true},
        "enabled",
        WriteOrigin::Ordinary,
        &clock(["empty-unset"]),
    );
    assert!(empty_unset.get_document("$unset").unwrap().is_empty());
    assert_state(
        empty_unset
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "empty-unset",
        true,
    );

    let pipeline = QueryUpdate::Pipeline(vec![Bson::Document(
        doc! {"$set": {"enabled": false, "availability": {"token": "pipe"}}},
    )]);
    assert_eq!(
        prepare_availability_update(
            pipeline.clone(),
            "enabled",
            WriteOrigin::Ordinary,
            &clock(["nope"])
        )
        .unwrap(),
        pipeline
    );
    assert!(matches!(
        driver_update(
            QueryUpdate::Absent,
            "enabled",
            WriteOrigin::Ordinary,
            &clock(["nope"])
        )
        .unwrap(),
        DriverUpdate::Skipped
    ));
    assert!(matches!(
        driver_update(
            QueryUpdate::Document(doc! {}),
            "enabled",
            WriteOrigin::Ordinary,
            &clock(["nope"])
        )
        .unwrap(),
        DriverUpdate::Skipped
    ));
    assert!(matches!(
        driver_update(
            QueryUpdate::Pipeline(Vec::new()),
            "isEnabled",
            WriteOrigin::Ordinary,
            &clock(["nope"])
        )
        .unwrap(),
        DriverUpdate::Skipped
    ));
    let reward = hook(
        doc! {"isEnabled": true},
        "isEnabled",
        WriteOrigin::Ordinary,
        &clock(["reward"]),
    );
    assert_state(
        reward
            .get_document("$set")
            .unwrap()
            .get("availability")
            .unwrap(),
        "reward",
        true,
    );
}

#[test]
fn save_replaces_only_when_enabled_changes() {
    let enabled = Bson::Boolean(true);
    let disabled = Bson::Boolean(false);
    assert!(!enabled_save_replaces(true, None, Some(&enabled)));
    assert!(!enabled_save_replaces(
        false,
        Some(&enabled),
        Some(&enabled)
    ));
    assert!(!enabled_save_replaces(
        false,
        Some(&enabled),
        Some(&Bson::Int32(1))
    ));
    assert!(!enabled_save_replaces(
        false,
        Some(&Bson::String("false".into())),
        Some(&disabled)
    ));
    assert!(enabled_save_replaces(false, None, Some(&enabled)));
    assert!(enabled_save_replaces(
        false,
        Some(&enabled),
        Some(&disabled)
    ));
    assert!(!enabled_save_replaces(false, Some(&enabled), None));
}

#[test]
fn dto_preserves_mixed_and_fails_closed() {
    let now = fixed_now();
    let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let stored = commands::schema()
        .construct(&doc! {"_id": id, "channelID": "c"}, now)
        .unwrap();
    let typed = ICommands::from_document(&stored).unwrap();
    assert!(same_doc(&typed.to_document(), &stored));
    assert!(matches!(
        inspect_permission_expression(typed.permission_expression.as_ref()),
        ExpressionState::Level
    ));
    assert!(matches!(
        inspect_blocks(typed.blocks.as_ref()),
        BlocksInspection::Empty
    ));

    let mut valid = stored.clone();
    valid.insert("permissionExpression", doc! {"role": "everyone"});
    valid.insert(
        "blocks",
        doc! {"v": 1, "root": {"id": "r", "type": "root", "children": []}},
    );
    valid.insert("permissions", doc! {"vip": true});
    let typed = ICommands::from_document(&valid).unwrap();
    assert!(matches!(
        inspect_permission_expression(typed.permission_expression.as_ref()),
        ExpressionState::Tags { .. }
    ));
    match inspect_blocks(typed.blocks.as_ref()) {
        BlocksInspection::Valid(blocks) => {
            assert_eq!(blocks.v, 1);
            assert_eq!(blocks.root.id, "r");
        }
        BlocksInspection::Empty | BlocksInspection::Invalid => panic!("valid blocks rejected"),
    }
    assert!(typed.permissions.get_bool("vip").unwrap());

    let mut invalid = stored.clone();
    invalid.insert("permissionExpression", doc! {"nope": 1});
    invalid.insert("blocks", doc! {"nope": 1});
    let typed = ICommands::from_document(&invalid).unwrap();
    assert_eq!(
        typed.permission_expression,
        Some(Bson::Document(doc! {"nope": 1}))
    );
    assert_eq!(typed.blocks, Some(Bson::Document(doc! {"nope": 1})));
    assert!(matches!(
        inspect_permission_expression(typed.permission_expression.as_ref()),
        ExpressionState::Invalid { error } if error.code == ValidationErrorCode::MissingOperator
    ));
    assert!(matches!(
        inspect_blocks(typed.blocks.as_ref()),
        BlocksInspection::Invalid
    ));

    let mut dated = stored.clone();
    dated.insert("permissionExpression", now);
    let typed = ICommands::from_document(&dated).unwrap();
    assert_eq!(typed.permission_expression, Some(Bson::DateTime(now)));
    assert!(matches!(
        inspect_permission_expression(typed.permission_expression.as_ref()),
        ExpressionState::Invalid { error } if error.code == ValidationErrorCode::NodeMustBeObject
    ));

    let mut bad_mode = stored.clone();
    bad_mode.insert("keywordSettings", doc! {"matchMode": "nope"});
    assert!(ICommands::from_document(&bad_mode).is_err());
    let mut bad_variable = stored.clone();
    bad_variable.insert("variables", doc! {"a": 1});
    assert!(ICommands::from_document(&bad_variable).is_err());
    let mut bad_permission = stored.clone();
    bad_permission.insert("permissions", doc! {"ok": 1});
    assert!(ICommands::from_document(&bad_permission).is_err());

    let reward_id = ObjectId::parse_str("507f1f77bcf86cd799439012").unwrap();
    let reward = redemption_reward::schema()
        .construct(
            &doc! {
                "_id": reward_id, "eventsubID": "e", "channelID": "c", "channel": "name",
                "rewardID": "r", "title": "t", "originalCost": 10, "cost": 4
            },
            now,
        )
        .unwrap();
    let typed = IRedemptionReward::from_document(&reward).unwrap();
    assert!(same_doc(&typed.to_document(), &reward));
    assert!(typed.background_color.is_none());
    assert!(typed.is_enabled);
}

#[test]
fn live_and_fixed_clock() {
    let first = availability_state(true, None);
    let second = availability_state(false, Some(fixed_now()));
    assert_ne!(first.token, second.token);
    assert_eq!(first.token.len(), 36);
    assert_eq!(first.token.as_bytes()[14], b'4');
    assert_eq!(second.token.as_bytes()[14], b'4');
    assert!(first.pending && second.pending);
    assert!(first.previous_enabled);
    assert!(!second.previous_enabled);
    assert!(first.restore_at.is_none());
    assert_eq!(second.restore_at, Some(fixed_now()));
    let drift = (DateTime::now().timestamp_millis() - first.next_at.timestamp_millis()).abs();
    assert!(drift < 60_000, "{drift}");
    let fixed = clock(["queued"]);
    assert_eq!(fixed.next_token(), "queued");
    let fallback = fixed.next_token();
    assert_eq!(fallback.len(), 36);
    assert_eq!(fallback.as_bytes()[14], b'4');
    assert_ne!(fallback, "queued");
}

fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn unpack_bson(hex: &str) -> Bson {
    let document: Document =
        mongodb::bson::deserialize_from_slice(&decode_hex(hex)).expect("oracle bson");
    document.get("value").cloned().expect("oracle value")
}

fn same_doc(left: &Document, right: &Document) -> bool {
    same_bson(
        &Bson::Document(left.clone()),
        &Bson::Document(right.clone()),
    )
}

fn same_bson(left: &Bson, right: &Bson) -> bool {
    if let (Some(left), Some(right)) = (number(left), number(right)) {
        return left == right;
    }
    match (left, right) {
        (Bson::Document(left), Bson::Document(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same_bson(value, other)))
        }
        (Bson::Array(left), Bson::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_bson(left, right))
        }
        _ => left == right,
    }
}

fn number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) if value.is_finite() => Some(*value),
        _ => None,
    }
}

fn same_update(actual: &QueryUpdate, expected: &QueryUpdate) -> bool {
    match (actual, expected) {
        (QueryUpdate::Absent, QueryUpdate::Absent) => true,
        (QueryUpdate::Document(left), QueryUpdate::Document(right)) => same_doc(left, right),
        (QueryUpdate::Pipeline(left), QueryUpdate::Pipeline(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_bson(left, right))
        }
        _ => false,
    }
}

#[test]
#[ignore = "requires the pinned source oracle outside this checkout and the same TZ"]
fn replay_actual_source() {
    let path = std::path::PathBuf::from(std::env::var("COMMAND_REWARD_SCHEMA_ORACLE").unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    assert!(path.is_absolute() && canonical == path);
    assert!(!canonical.starts_with(root.parent().unwrap()));
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(
        sha256_hex(&bytes),
        std::env::var("COMMAND_REWARD_SCHEMA_ORACLE_SHA256").unwrap()
    );
    let oracle: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        oracle["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(oracle["zone"], std::env::var("TZ").unwrap());
    assert_eq!(
        oracle["versions"],
        serde_json::json!({
            "node": "24.22.1",
            "v8": "13.6.233.17-node.58",
            "icu": "78.3",
            "unicode": "17.0",
            "typescript": "5.9.3",
            "mongoose": "8.24.2",
            "bson": "6.10.4"
        })
    );
    assert_eq!(
        oracle["sourceHashes"]["src/schemas/commands.schema.ts"],
        COMMANDS_TS
    );
    assert_eq!(
        oracle["sourceHashes"]["src/schemas/redemption_reward.schema.ts"],
        REWARDS_TS
    );
    assert_eq!(
        oracle["sourceHashes"]["src/utils/availability/schema.ts"],
        AVAILABILITY_TS
    );
    assert_eq!(oracle["typecheckDiagnostics"], 0);
    assert_eq!(oracle["phase"], "pre-update-before-castUpdate");
    assert_eq!(oracle["operationsMatch"], true);
    assert_eq!(
        oracle["metadata"]["commands"]["model"],
        commands::MODEL_NAME
    );
    assert_eq!(
        oracle["metadata"]["commands"]["collection"],
        commands::COLLECTION_NAME
    );
    assert_eq!(
        oracle["metadata"]["rewards"]["model"],
        redemption_reward::MODEL_NAME
    );
    assert_eq!(
        oracle["metadata"]["rewards"]["collection"],
        redemption_reward::COLLECTION_NAME
    );
    assert_eq!(oracle["metadata"]["commands"]["versionKey"], "__v");
    for (schema, key) in [
        (commands::schema(), "commands"),
        (redemption_reward::schema(), "rewards"),
    ] {
        let mut hidden: Vec<_> = schema
            .fields
            .iter()
            .filter(|field| field.hidden)
            .map(|field| field.name)
            .collect();
        hidden.sort_unstable();
        let expected: Vec<_> = oracle["metadata"][key]["hidden"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(hidden, expected);
    }

    let oracle_clock = clock(std::iter::repeat_n(TOKEN, 64));
    for case in oracle["construct"].as_array().unwrap() {
        let schema = match case["model"].as_str().unwrap() {
            "commands" => commands::schema(),
            "rewards" => redemption_reward::schema(),
            other => panic!("{other}"),
        };
        let input = unpack_bson(case["inputHex"].as_str().unwrap())
            .as_document()
            .unwrap()
            .clone();
        if case["errors"].is_null() {
            let actual = schema.construct(&input, fixed_now()).unwrap();
            let expected = unpack_bson(case["outputHex"].as_str().unwrap())
                .as_document()
                .unwrap()
                .clone();
            assert!(
                same_doc(&actual, &expected),
                "{} actual={actual:?} expected={expected:?}",
                case["name"]
            );
        } else {
            let actual = error_map(schema, input);
            let expected: BTreeMap<_, _> = case["errors"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(path, kind)| (path.clone(), kind.as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
    for case in oracle["query"].as_array().unwrap() {
        let origin = match case["origin"].as_str().unwrap() {
            "ordinary" => WriteOrigin::Ordinary,
            "internal" => WriteOrigin::Internal,
            other => panic!("{other}"),
        };
        let actual = prepare_availability_update(
            QueryUpdate::from_bson(Some(unpack_bson(case["beforeHex"].as_str().unwrap()))).unwrap(),
            case["field"].as_str().unwrap(),
            origin,
            &oracle_clock,
        )
        .unwrap();
        let expected =
            QueryUpdate::from_bson(Some(unpack_bson(case["afterHex"].as_str().unwrap()))).unwrap();
        assert!(same_update(&actual, &expected), "{}", case["name"]);
    }
    for case in oracle["save"].as_array().unwrap() {
        let stored = if case["storedPresent"].as_bool().unwrap() {
            Some(unpack_bson(case["storedHex"].as_str().unwrap()))
        } else {
            None
        };
        let assigned = unpack_bson(case["assignedHex"].as_str().unwrap());
        let replaced = case["replaced"].as_bool().unwrap();
        let is_new = case["isNew"].as_bool().unwrap();
        assert_eq!(
            enabled_save_replaces(is_new, stored.as_ref(), Some(&assigned)),
            replaced,
            "{}",
            case["name"]
        );
        if !is_new {
            assert_eq!(
                case["enabledModified"].as_bool().unwrap(),
                replaced,
                "{}",
                case["name"]
            );
        }
        if replaced {
            let availability = unpack_bson(case["availabilityHex"].as_str().unwrap())
                .as_document()
                .unwrap()
                .clone();
            assert_state(&Bson::Document(availability), TOKEN, js_boolean(&assigned));
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "ownership-guarded disposable MongoDB fixture required"]
async fn private_mongo_command_reward_schemas() {
    use futures_util::FutureExt;
    use mongodb::{Client, options::ClientOptions};
    use std::panic::{AssertUnwindSafe, resume_unwind};

    let (uri, database_name, namespace) = mongo_env();
    let mut options = ClientOptions::parse(&uri).await.expect("fixture uri");
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let client = Client::with_options(options).unwrap();
    let database = client.database(&database_name);
    assert_eq!(database.name(), database_name);
    let names = database.list_collection_names().await.unwrap();
    assert!(
        names.is_empty(),
        "refusing a non-empty database {database_name}: {names:?}"
    );
    database
        .collection::<Document>("__fixture_owner")
        .insert_one(doc! {
            "_id": "owner",
            "owner": "dimabot-migration",
            "namespace": &namespace,
            "database": &database_name
        })
        .await
        .expect("owner marker");
    let exercise_db = database.clone();
    let namespace_for_body = namespace.clone();
    let database_for_body = database_name.clone();
    let outcome = AssertUnwindSafe(async move {
        exercise(exercise_db, &namespace_for_body, &database_for_body).await;
    })
    .catch_unwind()
    .await;
    let marker = database
        .collection::<Document>("__fixture_owner")
        .find_one(doc! {"_id": "owner"})
        .await;
    let marker_ok = matches!(
        &marker,
        Ok(Some(document))
            if document.get_str("owner").ok() == Some("dimabot-migration")
                && document.get_str("namespace").ok() == Some(namespace.as_str())
                && document.get_str("database").ok() == Some(database_name.as_str())
    );
    let dropped = if marker_ok {
        database.drop().await.is_ok()
    } else {
        false
    };
    match (marker_ok, dropped, outcome) {
        (true, true, Ok(())) => {}
        (true, true, Err(panic)) => resume_unwind(panic),
        _ => panic!(
            "fixture cleanup failed for {database_name}; marker_ok={marker_ok} dropped={dropped}"
        ),
    }
}

fn mongo_env() -> (String, String, String) {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    let uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").unwrap();
    assert_eq!(uri, "mongodb://keyword-mongo:27017");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let token = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|rest| rest.strip_suffix(':'))
        .expect("keyword-fixture-12hex:");
    assert_eq!(token.len(), 12, "{namespace}");
    assert!(
        token.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{namespace}"
    );
    let database = format!("command_reward_schema_{token}");
    assert!(!database.contains("prod"));
    assert!(database != "admin" && database != "local" && database != "config");
    (uri, database, namespace)
}

async fn exercise(database: mongodb::Database, namespace: &str, database_name: &str) {
    let marker = database
        .collection::<Document>("__fixture_owner")
        .find_one(doc! {"_id": "owner"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker.get_str("namespace").unwrap(), namespace);
    assert_eq!(marker.get_str("database").unwrap(), database_name);
    let tokens = [
        "token-same",
        "token-disable",
        "token-payload",
        "token-missing",
        "token-reward-same",
        "token-reward-off",
        "token-race",
    ];
    let fixture_clock = clock(tokens);
    let commands_repo = commands::repository_with_clock(&database, fixture_clock.clone());
    let rewards = redemption_reward::repository_with_clock(&database, fixture_clock);
    assert_eq!(commands_repo.enabled_field(), commands::ENABLED_FIELD);
    assert_eq!(rewards.enabled_field(), redemption_reward::ENABLED_FIELD);
    assert_eq!(commands_repo.collection().name(), commands::COLLECTION_NAME);
    assert_eq!(
        rewards.collection().name(),
        redemption_reward::COLLECTION_NAME
    );
    commands::install_indexes(&database).await.unwrap();
    redemption_reward::install_indexes(&database).await.unwrap();
    assert!(sparse_next_at(&listed(commands_repo.collection()).await));
    assert!(sparse_next_at(&listed(rewards.collection()).await));

    let now = fixed_now();
    let blocks = doc! {"v": 1, "root": {"id": "r", "type": "root", "children": []}};
    let missing = commands_repo.insert(doc! {}, now).await.unwrap_err();
    assert!(matches!(
        missing,
        AvailabilityWriteError::Persistence(PersistenceError::Validation(_))
    ));
    let inserted = commands_repo
        .insert(doc! {"channelID": "c", "blocks": blocks.clone()}, now)
        .await
        .unwrap();
    let id = inserted.get_object_id("_id").unwrap();
    assert!(inserted.get("availability").is_none());
    assert_eq!(inserted.get_i32("__v").unwrap(), 0);
    let hidden_filter = doc! {"_id": id};
    let visible = commands_repo
        .find_one(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(visible.get("blocks").is_none());
    assert!(visible.get("availability").is_none());
    assert!(visible.get("availabilityLease").is_none());
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        hidden.get_document("blocks").unwrap().get_i32("v").unwrap(),
        1
    );
    assert!(hidden.get("availability").is_none());

    let same = commands_repo
        .update_one(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {"enabled": true}),
        )
        .await
        .unwrap();
    assert!(same.wrote && same.result.unwrap().matched_count == 1);
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_state(hidden.get("availability").unwrap(), "token-same", true);
    let saved = save_changes(&commands_repo, doc! {"_id": id, "enabled": true}, now)
        .await
        .unwrap();
    assert!(saved.get("availability").is_none());
    assert!(saved.get_bool("enabled").unwrap());
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_state(hidden.get("availability").unwrap(), "token-same", true);
    assert_eq!(hidden.get_i32("__v").unwrap(), 0);
    save_changes(&commands_repo, doc! {"_id": id, "message": "kept"}, now)
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hidden.get_str("message").unwrap(), "kept");
    assert_state(hidden.get("availability").unwrap(), "token-same", true);
    assert_eq!(
        hidden
            .get_document("blocks")
            .unwrap()
            .get_document("root")
            .unwrap()
            .get_str("id")
            .unwrap(),
        "r"
    );
    save_changes(&commands_repo, doc! {"_id": id, "enabled": false}, now)
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(!hidden.get_bool("enabled").unwrap());
    assert_eq!(hidden.get_str("message").unwrap(), "kept");
    assert_state(hidden.get("availability").unwrap(), "token-disable", false);

    commands_repo
        .update_one_internal(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {
                "$set": {
                    "availability.token": "sched",
                    "availability.pending": false,
                    "availability.nextAt": now,
                    "availabilityLease": {"token": "lease-1", "until": now}
                }
            }),
        )
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        hidden
            .get_document("availability")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "sched"
    );
    assert!(
        !hidden
            .get_document("availability")
            .unwrap()
            .get_bool("pending")
            .unwrap()
    );
    assert_eq!(
        hidden
            .get_document("availabilityLease")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "lease-1"
    );
    let found = commands_repo
        .find_one_and_update(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {"message": "from-find"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.get_str("message").unwrap(), "from-find");
    assert!(found.get("availability").is_none());
    assert!(found.get("blocks").is_none());
    let found = commands_repo
        .find_one_and_update_internal(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {"$set": {"availability.pending": true}}),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        found
            .get_document("availability")
            .unwrap()
            .get_bool("pending")
            .unwrap()
    );
    assert_eq!(
        found
            .get_document("availability")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "sched"
    );
    assert_eq!(
        found.get_document("blocks").unwrap().get_i32("v").unwrap(),
        1
    );
    let many = commands_repo
        .update_many(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {"paused": true}),
        )
        .await
        .unwrap();
    assert_eq!(many.result.unwrap().modified_count, 1);
    commands_repo
        .update_one(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {
                "func": "f",
                "availability.token": "hack",
                "availabilityX": "keep-x",
                "$set": {"availability.nextAt": now, "cmd": "kept-cmd"},
                "$unset": {"availabilityLease.token": "", "description": ""},
                "$setOnInsert": {"availabilityLease": {"token": "nope"}, "name": "n"}
            }),
        )
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        hidden
            .get_document("availability")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "sched"
    );
    assert_eq!(
        hidden
            .get_document("availabilityLease")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "lease-1"
    );
    assert_eq!(hidden.get_str("func").unwrap(), "f");
    assert_eq!(hidden.get_str("cmd").unwrap(), "kept-cmd");
    assert!(hidden.get("availabilityX").is_none());
    assert!(hidden.get("description").is_none());
    assert!(hidden.get("name").is_none());
    let skipped = commands_repo
        .update_one(hidden_filter.clone(), QueryUpdate::Document(doc! {}))
        .await
        .unwrap();
    assert!(!skipped.wrote && skipped.result.is_none());
    let skipped = commands_repo
        .update_many(hidden_filter.clone(), QueryUpdate::Pipeline(Vec::new()))
        .await
        .unwrap();
    assert!(!skipped.wrote);
    commands_repo
        .update_one(
            hidden_filter.clone(),
            QueryUpdate::Pipeline(vec![Bson::Document(
                doc! {"$set": {"enabled": true, "availability": {"token": "pipe"}}},
            )]),
        )
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(hidden.get_bool("enabled").unwrap());
    assert_eq!(
        hidden
            .get_document("availability")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "pipe"
    );
    assert_eq!(
        hidden
            .get_document("availabilityLease")
            .unwrap()
            .get_str("token")
            .unwrap(),
        "lease-1"
    );
    commands_repo
        .update_one(
            hidden_filter.clone(),
            QueryUpdate::Document(doc! {"enabled": true, "internalAvailabilityWrite": true}),
        )
        .await
        .unwrap();
    let hidden = commands_repo
        .find_one_with_hidden(hidden_filter.clone())
        .await
        .unwrap()
        .unwrap();
    assert_state(hidden.get("availability").unwrap(), "token-payload", true);

    let raw_id = ObjectId::new();
    commands_repo
        .collection()
        .insert_one(doc! {"_id": raw_id, "channelID": "raw", "blocks": blocks.clone()})
        .await
        .unwrap();
    save_changes(&commands_repo, doc! {"_id": raw_id, "enabled": true}, now)
        .await
        .unwrap();
    let raw = commands_repo
        .find_one_with_hidden(doc! {"_id": raw_id})
        .await
        .unwrap()
        .unwrap();
    assert_state(raw.get("availability").unwrap(), "token-missing", true);
    assert_eq!(raw.get_document("blocks").unwrap().get_i32("v").unwrap(), 1);

    let reward_missing = rewards
        .insert(
            doc! {
                "eventsubID": "e", "channelID": "c", "channel": "name",
                "rewardID": "r", "originalCost": 10, "cost": 4
            },
            now,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        reward_missing,
        AvailabilityWriteError::Persistence(PersistenceError::Validation(_))
    ));
    let reward = rewards
        .insert(
            doc! {
                "eventsubID": "e", "channelID": "c", "channel": "name",
                "rewardID": "r", "title": "t", "originalCost": 10, "cost": 4
            },
            now,
        )
        .await
        .unwrap();
    let reward_id = reward.get_object_id("_id").unwrap();
    assert!(reward.get("availability").is_none());
    assert!(reward.get_bool("isEnabled").unwrap());
    rewards
        .update_one(
            doc! {"_id": reward_id},
            QueryUpdate::Document(doc! {"isEnabled": true}),
        )
        .await
        .unwrap();
    let stored = rewards
        .find_one_with_hidden(doc! {"_id": reward_id})
        .await
        .unwrap()
        .unwrap();
    assert_state(
        stored.get("availability").unwrap(),
        "token-reward-same",
        true,
    );
    assert!(
        rewards
            .find_one(doc! {"_id": reward_id})
            .await
            .unwrap()
            .unwrap()
            .get("availability")
            .is_none()
    );
    save_changes(&rewards, doc! {"_id": reward_id, "isEnabled": true}, now)
        .await
        .unwrap();
    let stored = rewards
        .find_one_with_hidden(doc! {"_id": reward_id})
        .await
        .unwrap()
        .unwrap();
    assert_state(
        stored.get("availability").unwrap(),
        "token-reward-same",
        true,
    );
    save_changes(&rewards, doc! {"_id": reward_id, "isEnabled": false}, now)
        .await
        .unwrap();
    let stored = rewards
        .find_one_with_hidden(doc! {"_id": reward_id})
        .await
        .unwrap()
        .unwrap();
    assert!(!stored.get_bool("isEnabled").unwrap());
    assert_state(
        stored.get("availability").unwrap(),
        "token-reward-off",
        false,
    );

    let raced = commands_repo
        .insert(doc! {"channelID": "race", "blocks": blocks}, now)
        .await
        .unwrap();
    let race_id = raced.get_object_id("_id").unwrap();
    let left = commands_repo.clone();
    let right = commands_repo.clone();
    let (message_save, enabled_save) = tokio::join!(
        save_changes(&left, doc! {"_id": race_id, "message": "raced"}, now),
        save_changes(&right, doc! {"_id": race_id, "enabled": false}, now),
    );
    message_save.expect("message save");
    enabled_save.expect("enabled save");
    let raced = commands_repo
        .find_one_with_hidden(doc! {"_id": race_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raced.get_str("message").unwrap(), "raced");
    assert!(!raced.get_bool("enabled").unwrap());
    assert_state(raced.get("availability").unwrap(), "token-race", false);
    assert_eq!(
        raced.get_document("blocks").unwrap().get_i32("v").unwrap(),
        1
    );
    assert_eq!(raced.get_i32("__v").unwrap(), 0);

    let fresh_clock = clock(["hook-before-cast", "remote-change", "upsert-reward"]);
    let commands = commands::repository_with_clock(&database, fresh_clock.clone());
    let rewards = redemption_reward::repository_with_clock(&database, fresh_clock);
    let selected = commands
        .find_one_and_update_select(
            doc! {"_id": race_id.to_hex()},
            QueryUpdate::Document(
                doc! {"enabled": "false", "cooldown": "12", "internalAvailabilityWrite": true},
            ),
            &["blocks"],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!selected.get_bool("enabled").unwrap());
    assert_eq!(selected.get_i32("cooldown").unwrap(), 12);
    assert!(selected.get("blocks").is_some());
    assert!(selected.get("availability").is_none());
    assert!(selected.get("internalAvailabilityWrite").is_none());
    let stored = commands
        .find_one_with_hidden(doc! {"_id": race_id})
        .await
        .unwrap()
        .unwrap();
    assert_state(
        stored.get("availability").unwrap(),
        "hook-before-cast",
        true,
    );
    let mut stale = commands
        .load(doc! {"_id": race_id}, &[])
        .await
        .unwrap()
        .unwrap();
    commands
        .update_one(
            doc! {"_id": race_id},
            QueryUpdate::Document(doc! {"enabled": true}),
        )
        .await
        .unwrap();
    stale.document.insert("enabled", false);
    commands.save(&mut stale, now).await.unwrap();
    let stored = commands
        .find_one_with_hidden(doc! {"_id": race_id})
        .await
        .unwrap()
        .unwrap();
    assert!(stored.get_bool("enabled").unwrap());
    assert_state(stored.get("availability").unwrap(), "remote-change", true);
    let mut tracked = commands
        .load(doc! {"_id": race_id}, &[])
        .await
        .unwrap()
        .unwrap();
    tracked.append_array("responses", "one".into()).unwrap();
    commands.save(&mut tracked, now).await.unwrap();
    let stored = commands
        .find_one_with_hidden(doc! {"_id": race_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.get_i32("__v").unwrap(), 1);
    assert_eq!(
        stored.get_array("responses").unwrap(),
        &vec![Bson::String("one".into())]
    );
    let mut left = commands
        .load(doc! {"_id": race_id}, &[])
        .await
        .unwrap()
        .unwrap();
    let mut right = commands
        .load(doc! {"_id": race_id}, &[])
        .await
        .unwrap()
        .unwrap();
    let mut replacement = commands
        .load(doc! {"_id": race_id}, &[])
        .await
        .unwrap()
        .unwrap();
    left.append_array("responses", "left".into()).unwrap();
    right.append_array("responses", "right".into()).unwrap();
    replacement
        .document
        .get_array_mut("responses")
        .unwrap()
        .push("replacement".into());
    commands.save(&mut left, now).await.unwrap();
    commands.save(&mut right, now).await.unwrap();
    assert!(commands.save(&mut replacement, now).await.is_err());
    let stored = commands
        .find_one_with_hidden(doc! {"_id": race_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.get_i32("__v").unwrap(), 3);
    assert_eq!(
        stored.get_array("responses").unwrap(),
        &vec![
            Bson::String("one".into()),
            Bson::String("left".into()),
            Bson::String("right".into())
        ]
    );
    let empty = commands
        .update_one(
            doc! {"_id": race_id},
            QueryUpdate::Document(doc! {"$unset": {"availability.token": 1}, "unknown": 1}),
        )
        .await
        .unwrap();
    assert!(!empty.wrote);
    let upserted = rewards
        .upsert_with_defaults(
            doc! {"channelID": "upsert-channel", "rewardID": "upsert-reward"},
            QueryUpdate::Document(
                doc! {"title": "Created", "isEnabled": "false", "cost": "12", "unknown": true},
            ),
            now,
        )
        .await
        .unwrap();
    assert!(!upserted.get_bool("isEnabled").unwrap());
    assert_eq!(upserted.get_i32("cost").unwrap(), 12);
    assert_eq!(upserted.get_str("type").unwrap(), "custom");
    assert_eq!(upserted.get_i32("__v").unwrap(), 0);
    assert!(upserted.get("unknown").is_none());
    let stored = rewards
        .find_one_with_hidden(doc! {"_id": upserted.get_object_id("_id").unwrap()})
        .await
        .unwrap()
        .unwrap();
    assert_state(stored.get("availability").unwrap(), "upsert-reward", true);
}

async fn save_changes(
    repository: &dima_rust::schemas::command_schema_values::CommandRewardRepository,
    input: Document,
    now: DateTime,
) -> Result<Document, AvailabilityWriteError> {
    let id = input.get("_id").unwrap().clone();
    let mut tracked = repository.load(doc! {"_id": id}, &[]).await?.unwrap();
    tracked.document.extend(input);
    repository.save(&mut tracked, now).await
}

async fn listed(collection: &mongodb::Collection<Document>) -> Vec<mongodb::IndexModel> {
    use futures_util::TryStreamExt;
    collection
        .list_indexes()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap()
}

fn sparse_next_at(indexes: &[mongodb::IndexModel]) -> bool {
    let matched = indexes.iter().filter(|index| {
        index.keys.get("availability.nextAt").is_some()
            && index.options.as_ref().and_then(|options| options.sparse) == Some(true)
            && index
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                .is_none()
    });
    matched.count() == 1 && indexes.len() == 2
}
