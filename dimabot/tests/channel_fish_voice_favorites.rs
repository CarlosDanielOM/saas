#![cfg(feature = "channel-fish-voice-favorites")]
use dima_rust::{
    schemas::channel_fish_voice_favorites::{self as favorites, FavoritesError},
    utils::{js_string::JsString, lossless_json::JsonValue},
};
use mongodb::bson::doc;

#[test]
fn alias_rules_and_utf16_boundaries() {
    let text = |s: &str| JsonValue::String(s.into());
    assert_eq!(
        favorites::normalize_favorite_alias(&text("\u{feff} Bill \u{2028}")).unwrap(),
        "bill"
    );
    for s in ["", "bill cypher", "_bill", "İ", &"a".repeat(41)] {
        let e = favorites::normalize_favorite_alias(&text(s)).unwrap_err();
        assert_eq!((e.status, e.code.as_str()), (400.0, Some("invalid_alias")));
    }
    assert_eq!(
        favorites::normalize_favorite_alias(&text("RIAS_GREMORY"))
            .unwrap_err()
            .code
            .as_str(),
        Some("alias_taken")
    );
    assert_eq!(
        favorites::normalize_favorite_alias(&JsonValue::Number(3.0))
            .unwrap_err()
            .code
            .as_str(),
        Some("invalid_alias")
    );
    assert_eq!(
        favorites::make_favorite_alias(
            &JsString::from("Café Voice"),
            &[JsString::from("cafe_voice")]
        ),
        "cafe_voice_2"
    );
    assert_eq!(
        favorites::make_favorite_alias(&JsString::from_units(vec![97, 0xd800, 98]), &[]),
        "a_b"
    );
    assert_eq!(
        favorites::make_favorite_alias(&JsString::from("gojo"), &[]),
        "gojo_2"
    );
}

#[test]
fn alias_ascii_fast_path_and_borrowed_collision_set() {
    let alias = |s: &str| favorites::normalize_favorite_alias(&JsonValue::String(s.into()));
    assert_eq!(alias("\t AbC_09\r").unwrap(), "abc_09");
    assert_eq!(
        alias("\u{000b}GOJO\u{000c}").unwrap_err().code.as_str(),
        Some("alias_taken")
    );
    assert_eq!(alias("\u{feff}KEY\u{2028}").unwrap(), "key");
    assert_eq!(
        alias("A-B").unwrap_err().code.as_str(),
        Some("invalid_alias")
    );
    assert_eq!(alias(&"K".repeat(40)).unwrap(), "k".repeat(40));
    assert_eq!(
        alias(&"K".repeat(41)).unwrap_err().code.as_str(),
        Some("invalid_alias")
    );
    for text in ["İ", "Σ", "abc\0", "0abc", "😀"] {
        assert_eq!(
            alias(text).unwrap_err().code.as_str(),
            Some("invalid_alias")
        );
    }
    let malformed = JsonValue::String(JsString::from_units(vec![0xfeff, 0xd800, 0x20]));
    assert_eq!(
        favorites::normalize_favorite_alias(&malformed)
            .unwrap_err()
            .code
            .as_str(),
        Some("invalid_alias")
    );
    let mut used: Vec<JsString> = (2..=12)
        .map(|n| JsString::from(format!("voice_{n}")))
        .collect();
    used.push(JsString::from("voice"));
    used.push(JsString::from_units(vec![0xd800]));
    assert_eq!(
        favorites::make_favorite_alias(&JsString::from("Voice"), &used),
        "voice_13"
    );
    assert_eq!(
        favorites::make_favorite_alias(
            &JsString::from("gojo"),
            &[JsString::from_units(vec![0xd800]), JsString::from("gojo_2")]
        ),
        "gojo_3"
    );
    let long = "a".repeat(40);
    assert_eq!(
        favorites::make_favorite_alias(
            &JsString::from(long.as_str()),
            &[JsString::from(long.as_str())]
        ),
        format!("{long}_2")
    );
}

#[test]
fn alias_error_constructor_preserves_number_bits_and_utf16() {
    let code = JsString::from_units(vec![0xd800, 65]);
    let message = JsString::from_units(vec![0xdc00, 66]);
    let error = favorites::FavoriteAliasError::new(-0.0, code.clone(), message.clone());
    assert_eq!(error.status.to_bits(), (-0.0_f64).to_bits());
    assert_eq!(error.code, code);
    assert_eq!(error.message, message);
    assert_eq!(error.name(), "Error");
    assert_eq!(error.to_string(), "�B");
}

// I/O-only emulator: executes the operations built by the production core.
// It contains no retry loop, alias policy, capacity decision or rename policy.
#[derive(Default)]
struct ReplayState {
    calls: Vec<serde_json::Value>,
    settings: Vec<serde_json::Value>,
    events: Vec<&'static str>,
    stored: Option<serde_json::Value>,
    force_miss: bool,
    fail_cas: bool,
    fail_settings: bool,
    miss_change: Option<&'static str>,
}
#[derive(Default)]
struct ReplayRepo(std::sync::Mutex<ReplayState>);
impl favorites::FavoritesRepository for ReplayRepo {
    async fn execute(
        &self,
        op: favorites::FavoritesOperation,
    ) -> Result<Option<mongodb::bson::Document>, FavoritesError> {
        use favorites::FavoritesOperation as Op;
        use serde_json::{Value, json};
        let mut state = self.0.lock().unwrap();
        let val = |v: mongodb::bson::Document| serde_json::to_value(v).unwrap();
        let bson = |v: Value| mongodb::bson::serialize_to_document(&v).unwrap();
        match op {
            Op::Find(filter) => {
                state.events.push("findOne");
                state.calls.push(json!(["findOne", val(filter)]));
                Ok(state.stored.clone().map(bson))
            }
            Op::SettingsUpdate { filter, update } => {
                state.events.push("settingsUpdate");
                state.settings.push(json!([val(filter), val(update)]));
                if state.fail_settings {
                    return Err(FavoritesError::BsonBoundary("injected settings write"));
                }
                Ok(None)
            }
            Op::Update {
                filter,
                update,
                options,
            } => {
                let (filter, update, options) = (val(filter), val(update), options.map(val));
                state.events.push("updateOne");
                state
                    .calls
                    .push(json!(["updateOne", filter, update, options]));
                if let Some(insert) = update.get("$setOnInsert") {
                    if state.stored.is_none() {
                        state.stored = Some(insert.clone());
                    }
                } else if let Some(pull) = update.get("$pull")
                    && let Some(stored) = &mut state.stored
                {
                    stored["favorites"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|v| v["id"] != pull["favorites"]["id"]);
                }
                Ok(None)
            }
            Op::FindAndUpdate {
                filter,
                update,
                options,
            } => {
                let (filter, update, options) = (val(filter), val(update), val(options));
                state.events.push("findOneAndUpdate");
                state
                    .calls
                    .push(json!(["findOneAndUpdate", filter, update, options]));
                if state.fail_cas {
                    return Err(FavoritesError::BsonBoundary("injected uncertain write"));
                }
                if state.force_miss {
                    return Ok(None);
                }
                if let Some(mode) = state.miss_change.take() {
                    if let Some(stored) = &mut state.stored {
                        let rows = stored["favorites"].as_array_mut().unwrap();
                        if mode == "remove" {
                            rows.clear();
                        }
                        if mode == "same" {
                            rows[0]["alias"] = update["$set"]["favorites.$[target].alias"].clone();
                        }
                    }
                    return Ok(None);
                }
                let Some(stored) = &mut state.stored else {
                    return Ok(None);
                };
                let rows = stored["favorites"].as_array_mut().unwrap();
                if let Some(push) = update.get("$push") {
                    let row = &push["favorites"];
                    let limit = filter["$expr"]["$lt"][1].as_u64().unwrap() as usize;
                    let id = &filter["favorites.id"]["$ne"];
                    let alias = &filter["favorites.alias"]["$ne"];
                    if rows.len() >= limit
                        || rows.iter().any(|v| &v["id"] == id || &v["alias"] == alias)
                    {
                        return Ok(None);
                    }
                    rows.push(row.clone());
                } else {
                    let id = &filter["favorites.id"];
                    let alias = &filter["favorites.alias"]["$ne"];
                    if rows.iter().any(|v| &v["alias"] == alias) {
                        return Ok(None);
                    }
                    let Some(row) = rows.iter_mut().find(|v| &v["id"] == id) else {
                        return Ok(None);
                    };
                    row["alias"] = update["$set"]["favorites.$[target].alias"].clone();
                }
                Ok(Some(bson(stored.clone())))
            }
        }
    }
}
fn wire_favorite(value: favorites::Favorite) -> serde_json::Value {
    serde_json::json!({"id":value.id.to_utf8_lossy(),"name":value.name.to_utf8_lossy(),"alias":value.alias.to_utf8_lossy()})
}
fn wire_result(result: Result<serde_json::Value, FavoritesError>) -> serde_json::Value {
    match result {
        Ok(value) => serde_json::json!({"value":value}),
        Err(FavoritesError::Alias(e)) => {
            serde_json::json!({"error":{"status":e.status as u16,"code":e.code.as_str().unwrap(),"message":e.message.as_str().unwrap()}})
        }
        Err(e) => serde_json::json!({"error":{"status":null,"code":null,"message":e.to_string()}}),
    }
}

#[path = "support/schema_source.rs"]
mod schema_source;
#[tokio::test]
#[ignore = "requires separately generated external source oracle"]
async fn source_oracle_pure_and_protocol() {
    let path = std::path::PathBuf::from(std::env::var("FISH_FAVORITES_ORACLE").unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(
        path.is_absolute()
            && std::fs::canonicalize(&path).unwrap() == path
            && !path.starts_with(root.parent().unwrap())
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        schema_source::sha256(&bytes),
        std::env::var("FISH_FAVORITES_ORACLE_SHA256").unwrap()
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["schema"], 1);
    assert_eq!(
        fixture["versions"],
        serde_json::json!({"node":"24.22.1","v8":"13.6.233.17-node.58","icu":"78.3","unicode":"17.0","typescript":"5.9.3"})
    );
    assert_eq!(
        fixture["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    let files = [
        "src/schemas/channel_fish_voice_favorites.schema.ts",
        "src/schemas/channel_fish_voice_favorites.schema.test.ts",
        "src/schemas/channel_tts_settings.schema.ts",
        "src/server/services/tts/fish_tts.service.ts",
        "src/schemas/channel_fish_voice_favorites.schema.rs",
        "src/schemas/channel_tts_settings.schema.rs",
        "src/schemas/schema.rs",
        "src/server/services/tts/fish_tts.rs",
        "src/utils/js_string.rs",
        "src/utils/js_compat.rs",
        "src/utils/js_unicode.rs",
        "src/utils/js_unicode_data.rs",
        "src/utils/lossless_json.rs",
        "tests/channel_fish_voice_favorites.rs",
        "tests/support/schema_source.rs",
        "tests/fixtures/schema_source_resolver.cjs",
        "tests/fixtures/channel_fish_voice_favorites_reference.cjs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "package.json",
        "package-lock.json",
    ];
    assert_eq!(fixture["hashes"].as_object().unwrap().len(), files.len());
    let archived_sources = [
        "src/schemas/channel_fish_voice_favorites.schema.ts",
        "src/schemas/channel_fish_voice_favorites.schema.test.ts",
        "src/schemas/channel_tts_settings.schema.ts",
    ];
    assert_eq!(
        fixture["sourcePaths"].as_object().unwrap().len(),
        files.len()
    );
    for file in files {
        let archived = archived_sources.contains(&file);
        let resolved = if archived {
            format!("../{}", schema_source::provenance(file))
        } else {
            file.to_owned()
        };
        let bytes = if archived {
            schema_source::archived(&root, file)
        } else {
            std::fs::read(root.join(&resolved)).unwrap()
        };
        assert_eq!(fixture["sourcePaths"][file], resolved);
        assert_eq!(
            fixture["hashes"][file].as_str().unwrap(),
            schema_source::sha256(&bytes)
        );
    }
    assert_eq!(fixture["mongoose"], "8.24.2");
    assert_eq!(
        fixture["sdkHashes"]["settingsReference"].as_str().unwrap(),
        schema_source::sha256(
            &std::fs::read(root.join("tests/fixtures/channel_tts_settings_reference.mjs")).unwrap()
        )
    );
    assert_eq!(
        fixture["metadata"],
        serde_json::json!({"model":"channel_fish_voice_favorites","collection":"channel_fish_voice_favorites","versionKey":"__v","timestamps":false,"indexes":[{"keys":{"channelID":1},"unique":true}],"subdocumentId":false,"paths":{"channelID":"String","favorites":"Array"},"favoritePaths":{"id":"String","name":"String","alias":"String"}})
    );
    let schema = favorites::schema();
    assert_eq!(schema.model, "channel_fish_voice_favorites");
    assert_eq!(schema.collection, "channel_fish_voice_favorites");
    assert!(schema.version_key && schema.timestamps.is_none());
    assert_eq!(schema.indexes.len(), 1);
    assert!(schema.indexes[0].unique);
    assert_eq!(schema.indexes[0].keys, doc! {"channelID":1});
    let expected_cases = serde_json::json!([
        {"input":{"channelID":"channel"},"output":{"channelID":"channel","favorites":[]},"error":null},
        {"input":{"channelID":42,"favorites":[{"id":123,"name":456,"alias":789}]},"output":{"channelID":"42","favorites":[{"id":"123","name":"456","alias":"789"}]},"error":null},
        {"input":{"channelID":"channel","favorites":[{"id":"x","name":"Voice","alias":"voice","extra":"ignored"}]},"output":{"channelID":"channel","favorites":[{"id":"x","name":"Voice","alias":"voice"}]},"error":null}
    ]);
    assert_eq!(fixture["schemaCases"], expected_cases);
    let inputs = [
        doc! {"channelID":"channel"},
        doc! {"channelID":42,"favorites":[{"id":123,"name":456,"alias":789}]},
        doc! {"channelID":"channel","favorites":[{"id":"x","name":"Voice","alias":"voice","extra":"ignored"}]},
    ];
    let outputs = [
        doc! {"channelID":"channel","favorites":[]},
        doc! {"channelID":"42","favorites":[{"id":"123","name":"456","alias":"789"}]},
        doc! {"channelID":"channel","favorites":[{"id":"x","name":"Voice","alias":"voice"}]},
    ];
    for (input, expected) in inputs.into_iter().zip(outputs) {
        let mut actual = schema
            .construct(&input, mongodb::bson::DateTime::from_millis(1900000000000))
            .unwrap();
        actual.remove("_id");
        assert_eq!(actual, expected);
    }
    let middleware = &fixture["settingsMiddleware"];
    assert_eq!(middleware["clock"], 1900000000000_i64);
    let ops = middleware["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(
        ops[0]["filter"],
        serde_json::json!({"channelID":"channel","voices.cloneDefault":"old"})
    );
    assert_eq!(ops[0]["update"]["$set"]["voices.cloneDefault"], "id");
    assert_eq!(
        ops[0]["update"]["$set"]["updatedAt"],
        "2030-03-17T17:46:40.000Z"
    );
    assert_eq!(
        ops[0]["update"]["$setOnInsert"]["createdAt"],
        "2030-03-17T17:46:40.000Z"
    );
    assert_eq!(fixture["max"], favorites::MAX_FISH_VOICE_FAVORITES);
    assert_eq!(
        fixture["exports"],
        serde_json::json!([
            "ChannelFishVoiceFavoritesSchema",
            "FavoriteAliasError",
            "MAX_FISH_VOICE_FAVORITES",
            "addFishVoiceFavorite",
            "getFishVoiceFavorites",
            "makeFavoriteAlias",
            "normalizeFavoriteAlias",
            "removeFishVoiceFavorite",
            "renameFishVoiceFavorite"
        ])
    );
    assert_eq!(
        fixture["typeDeclarations"],
        serde_json::json!([
            {"name":"FishVoiceFavorite","exported":true,"fields":[{"name":"id","type":"string"},{"name":"name","type":"string"},{"name":"alias","type":"string"}]},
            {"name":"ChannelFishVoiceFavorites","exported":false,"fields":[{"name":"channelID","type":"string"},{"name":"favorites","type":"FishVoiceFavorite[]"}]}
        ])
    );
    assert_eq!(unicode_normalization::UNICODE_VERSION, (18, 0, 0));
    let fish = fixture["fish"].as_object().unwrap();
    let native = dima_rust::tts_services::fish_tts::FISH_VOICES;
    assert_eq!(fish.len(), native.len());
    for (name, id) in native {
        assert_eq!(fish[*name], *id);
    }
    let units = |value: &serde_json::Value| {
        JsString::from_units(
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect(),
        )
    };
    assert_eq!(
        fixture["errorClassDeclaration"],
        serde_json::json!({"name":"FavoriteAliasError","base":"Error","parameters":[{"name":"status","type":"number","public":true},{"name":"code","type":"string","public":true},{"name":"message","type":"string","public":false}]})
    );
    let error_cases = fixture["errorCases"].as_array().unwrap();
    assert_eq!(error_cases.len(), 9);
    for case in error_cases {
        let bits = u64::from_str_radix(case["statusBits"].as_str().unwrap(), 16).unwrap();
        let error = favorites::FavoriteAliasError::new(
            f64::from_bits(bits),
            units(&case["codeUnits"]),
            units(&case["messageUnits"]),
        );
        assert_eq!(error.status.to_bits(), bits);
        assert_eq!(error.code, units(&case["codeUnits"]));
        assert_eq!(error.message, units(&case["messageUnits"]));
        assert_eq!(case["name"], error.name());
        assert_eq!(case["isError"], true);
        assert_eq!(case["isFavorite"], true);
        let error_name = error.name();
        let wire = JsonValue::Object(vec![
            ("status".into(), JsonValue::Number(error.status)),
            ("code".into(), JsonValue::String(error.code)),
            ("message".into(), JsonValue::String(error.message)),
            ("name".into(), JsonValue::String(error_name.into())),
        ])
        .to_json_string();
        assert_eq!(case["wire"], wire);
    }
    assert_eq!(fixture["mongoBson"]["mongodbVersion"], "6.20.0");
    assert_eq!(fixture["mongoBson"]["bsonVersion"], "6.10.4");
    for key in ["mongodbEntry", "bsonEntry", "mongodbPackage", "bsonPackage"] {
        let hash = fixture["mongoBson"][key].as_str().unwrap();
        assert_eq!(hash.len(), 64);
        assert!(
            hash.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }
    let bson_cases = fixture["bsonCases"].as_array().unwrap();
    assert_eq!(bson_cases.len(), 8);
    for case in bson_cases {
        let source = units(&case["units"]);
        let value = source.to_utf8_lossy();
        let doc = doc! {"channelID": &value, "id": &value, "name": &value};
        let encoded = mongodb::bson::serialize_to_vec(&doc).unwrap();
        let hex: String = encoded.iter().map(|v| format!("{v:02x}")).collect();
        assert_eq!(case["hex"], hex);
        let decoded: mongodb::bson::Document =
            mongodb::bson::deserialize_from_slice(&encoded).unwrap();
        for key in ["channelID", "id", "name"] {
            assert_eq!(
                JsString::from(decoded.get_str(key).unwrap()),
                units(&case["output"][key])
            );
        }
    }
    let normalization = fixture["normalization"].as_array().unwrap();
    assert_eq!(normalization.len(), 19);
    // U+0085 is Rust whitespace but must survive JavaScript trim and fail the
    // alias grammar. Preserve these actual-source regression cases explicitly.
    for case in &normalization[15..] {
        assert!(
            case["input"]["units"]
                .as_array()
                .unwrap()
                .iter()
                .any(|unit| unit.as_u64() == Some(0x85))
        );
        assert!(case["error"].is_object());
    }
    for case in normalization {
        let input = if case["input"].is_object() {
            JsonValue::String(units(&case["input"]["units"]))
        } else if let Some(n) = case["input"].as_f64() {
            JsonValue::Number(n)
        } else {
            JsonValue::Null
        };
        match favorites::normalize_favorite_alias(&input) {
            Ok(value) => assert_eq!(case["value"], value),
            Err(e) => assert_eq!(
                case["error"],
                serde_json::json!({"status":e.status as u16,"code":e.code.as_str().unwrap(),"message":e.message.as_str().unwrap()})
            ),
        }
    }
    for case in fixture["aliases"].as_array().unwrap() {
        let used: Vec<_> = case["used"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| JsString::from(v.as_str().unwrap()))
            .collect();
        assert_eq!(
            case["alias"],
            favorites::make_favorite_alias(&units(&case["units"]), &used)
        );
    }
    // Exercise the same production operations against a recording I/O adapter.
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    let channel = JsString::from("channel");
    let id = JsString::from("id");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let repo = ReplayRepo::default();
        let result: Result<serde_json::Value, FavoritesError> = match name {
            "get_missing" => favorites::get_with(&repo, &channel)
                .await
                .map(|v| serde_json::json!(v.into_iter().map(wire_favorite).collect::<Vec<_>>())),
            "add" => favorites::add_with(&repo, &channel, &id, &JsString::from("Café Voice"))
                .await
                .map(wire_favorite),
            "existing" => {
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .unwrap();
                favorites::add_with(&repo, &channel, &id, &JsString::from("ignored"))
                    .await
                    .map(wire_favorite)
            }
            "remove" => {
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .unwrap();
                favorites::remove_with(&repo, &channel, &id).await.unwrap();
                favorites::get_with(&repo, &channel).await.map(|v| {
                    serde_json::json!(v.into_iter().map(wire_favorite).collect::<Vec<_>>())
                })
            }
            "rename" => {
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .unwrap();
                favorites::rename_with(&repo, &channel, &id, &JsonValue::String(" New ".into()))
                    .await
                    .map(wire_favorite)
            }
            "rename_missing" => {
                favorites::rename_with(&repo, &channel, &id, &JsonValue::String("new".into()))
                    .await
                    .map(wire_favorite)
            }
            "rename_taken" => {
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .unwrap();
                favorites::add_with(
                    &repo,
                    &channel,
                    &JsString::from("other"),
                    &JsString::from("Other"),
                )
                .await
                .unwrap();
                favorites::rename_with(&repo, &channel, &id, &JsonValue::String("other".into()))
                    .await
                    .map(wire_favorite)
            }
            "rename_fallthrough_remove"
            | "rename_fallthrough_same"
            | "rename_fallthrough_conflict" => {
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .unwrap();
                repo.0.lock().unwrap().miss_change = Some(match name {
                    "rename_fallthrough_remove" => "remove",
                    "rename_fallthrough_same" => "same",
                    _ => "conflict",
                });
                favorites::rename_with(&repo, &channel, &id, &JsonValue::String("new".into()))
                    .await
                    .map(wire_favorite)
            }
            "full" => {
                for i in 0..20 {
                    favorites::add_with(
                        &repo,
                        &channel,
                        &JsString::from(i.to_string()),
                        &JsString::from("Name"),
                    )
                    .await
                    .unwrap();
                }
                favorites::add_with(
                    &repo,
                    &channel,
                    &JsString::from("extra"),
                    &JsString::from("Name"),
                )
                .await
                .map(wire_favorite)
            }
            "conflict" => {
                repo.0.lock().unwrap().force_miss = true;
                favorites::add_with(&repo, &channel, &id, &JsString::from("Name"))
                    .await
                    .map(wire_favorite)
            }
            _ => panic!("unexpected scenario {name}"),
        };
        let state = repo.0.lock().unwrap();
        assert_eq!(
            *case,
            serde_json::json!({"name":name,"result":wire_result(result),"calls":state.calls,"settings":state.settings,"stored":state.stored}),
            "{name}"
        );
    }
}

#[tokio::test]
async fn actual_core_handles_cas_fallthrough_and_uncertain_errors() {
    let channel = JsString::from("channel");
    let id = JsString::from("id");
    let name = JsString::from("Name");
    let alias = JsonValue::String("new".into());
    for (mode, code) in [
        ("remove", "favorite_not_found"),
        ("same", "success"),
        ("conflict", "alias_taken"),
    ] {
        let repo = ReplayRepo::default();
        favorites::add_with(&repo, &channel, &id, &name)
            .await
            .unwrap();
        {
            let mut state = repo.0.lock().unwrap();
            state.calls.clear();
            state.settings.clear();
            state.events.clear();
            state.miss_change = Some(mode);
        }
        let result = favorites::rename_with(&repo, &channel, &id, &alias).await;
        if code == "success" {
            assert_eq!(result.unwrap().alias, JsString::from("new"));
        } else {
            assert!(
                matches!(result,Err(FavoritesError::Alias(e)) if e.code.as_str() == Some(code))
            );
        }
        let state = repo.0.lock().unwrap();
        assert_eq!(state.calls.len(), 3);
        assert_eq!(state.calls[0][0], "findOne");
        assert_eq!(state.calls[1][0], "findOneAndUpdate");
        assert_eq!(state.calls[2][0], "findOne");
        assert_eq!(state.settings.len(), 1);
        assert_eq!(
            state.events,
            ["findOne", "settingsUpdate", "findOneAndUpdate", "findOne"]
        );
    }
    let repo = ReplayRepo::default();
    repo.0.lock().unwrap().force_miss = true;
    assert!(matches!(
        favorites::add_with(&repo, &channel, &id, &name).await,
        Err(FavoritesError::Conflict)
    ));
    {
        let state = repo.0.lock().unwrap();
        assert_eq!(
            state
                .calls
                .iter()
                .filter(|c| c[0] == "findOneAndUpdate")
                .count(),
            21
        );
    }
    let repo = ReplayRepo::default();
    repo.0.lock().unwrap().fail_cas = true;
    assert!(matches!(
        favorites::add_with(&repo, &channel, &id, &name).await,
        Err(FavoritesError::BsonBoundary("injected uncertain write"))
    ));
    {
        let state = repo.0.lock().unwrap();
        assert_eq!(state.calls.len(), 3);
        assert_eq!(state.calls[2][0], "findOneAndUpdate");
    }
    let repo = ReplayRepo::default();
    favorites::add_with(&repo, &channel, &id, &name)
        .await
        .unwrap();
    {
        let mut state = repo.0.lock().unwrap();
        state.calls.clear();
        state.settings.clear();
        state.events.clear();
        state.fail_cas = true;
    }
    assert!(matches!(
        favorites::rename_with(&repo, &channel, &id, &alias).await,
        Err(FavoritesError::BsonBoundary("injected uncertain write"))
    ));
    {
        let state = repo.0.lock().unwrap();
        assert_eq!(state.calls.len(), 2);
        assert_eq!(state.settings.len(), 1);
        assert_eq!(
            state.events,
            ["findOne", "settingsUpdate", "findOneAndUpdate"]
        );
    }
    let repo = ReplayRepo::default();
    favorites::add_with(&repo, &channel, &id, &name)
        .await
        .unwrap();
    {
        let mut state = repo.0.lock().unwrap();
        state.calls.clear();
        state.settings.clear();
        state.events.clear();
        state.fail_settings = true;
    }
    assert!(matches!(
        favorites::rename_with(&repo, &channel, &id, &alias).await,
        Err(FavoritesError::BsonBoundary("injected settings write"))
    ));
    {
        let state = repo.0.lock().unwrap();
        assert_eq!(state.calls.len(), 1);
        assert_eq!(state.settings.len(), 1);
    }
}

#[tokio::test]
#[ignore = "requires task-owned private keyword-mongo"]
async fn concrete_mongo_favorites_and_legacy_default() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("fish-voice-favorites")
    );
    assert_eq!(
        std::env::var("FISH_FAVORITES_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    let namespace = std::env::var("FISH_FAVORITES_NAMESPACE").unwrap();
    let token = namespace
        .strip_prefix("fish-favorites-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert!((6..=32).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric()));
    let client = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("fish_favorites_{token}"));
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let test = AssertUnwindSafe(async {
        favorites::install_indexes(&db).await.unwrap();
        let channel = JsString::from("channel"); let id = JsString::from("id");
        assert!(favorites::get_fish_voice_favorites(&db, &channel).await.unwrap().is_empty());
        let first = favorites::add_fish_voice_favorite(&db, &channel, &id, &JsString::from("Bill Cypher")).await.unwrap();
        assert_eq!(first.alias, JsString::from("bill_cypher"));
        let duplicate = favorites::schema().native_collection(&db).insert_one(doc! {"channelID":"channel","favorites":[]}).await;
        assert!(duplicate.is_err(), "explicit initializer must enforce channel uniqueness");
        assert_eq!(favorites::add_fish_voice_favorite(&db, &channel, &id, &JsString::from("ignored")).await.unwrap(), first);
        let settings = dima_rust::schemas::channel_tts_settings::schema().native_collection(&db);
        settings.insert_one(doc! {"channelID":"channel","voices":{"cloneDefault":"bill_cypher","en":"keep"}}).await.unwrap();
        let before_update = mongodb::bson::DateTime::now();
        let renamed = favorites::rename_fish_voice_favorite(&db, &channel, &id, &JsonValue::String(" Bill ".into())).await.unwrap();
        let after_update = mongodb::bson::DateTime::now();
        assert_eq!(renamed.alias, JsString::from("bill"));
        let stored = settings.find_one(doc! {"channelID":"channel"}).await.unwrap().unwrap();
        let voices = stored.get_document("voices").unwrap();
        assert_eq!(voices.get_str("cloneDefault").unwrap(), "id");
        assert_eq!(voices.get_str("en").unwrap(), "keep");
        let stamp = stored.get_datetime("updatedAt").unwrap().timestamp_millis();
        assert!(stamp >= before_update.timestamp_millis() && stamp <= after_update.timestamp_millis());
        assert!(!stored.contains_key("createdAt"));
        favorites::add_fish_voice_favorite(&db, &channel, &JsString::from("other"), &JsString::from("Other")).await.unwrap();
        assert!(matches!(favorites::rename_fish_voice_favorite(&db, &channel, &id, &JsonValue::String("other".into())).await, Err(FavoritesError::Alias(e)) if e.code.as_str() == Some("alias_taken") && e.status == 409.0));
        assert!(matches!(favorites::rename_fish_voice_favorite(&db, &channel, &JsString::from("missing"), &JsonValue::String("new".into())).await, Err(FavoritesError::Alias(e)) if e.code.as_str() == Some("favorite_not_found") && e.status == 404.0));
        for i in 2..20 { favorites::add_fish_voice_favorite(&db, &channel, &JsString::from(format!("id{i}")), &JsString::from("Voice")).await.unwrap(); }
        assert!(matches!(favorites::add_fish_voice_favorite(&db, &channel, &JsString::from("overflow"), &JsString::from("Voice")).await, Err(FavoritesError::Full)));
        favorites::remove_fish_voice_favorite(&db, &channel, &id).await.unwrap();
        assert_eq!(favorites::get_fish_voice_favorites(&db, &channel).await.unwrap().len(), 19);
        // The first settings migration precedes a later alias collision.
        let failure_channel = JsString::from("migration-failure");
        let left = JsString::from("left-id"); let right = JsString::from("right-id");
        favorites::add_fish_voice_favorite(&db, &failure_channel, &left, &JsString::from("Left")).await.unwrap();
        favorites::add_fish_voice_favorite(&db, &failure_channel, &right, &JsString::from("Right")).await.unwrap();
        settings.insert_one(doc! {"channelID":"migration-failure","voices":{"cloneDefault":"left"}}).await.unwrap();
        assert!(matches!(favorites::rename_fish_voice_favorite(&db, &failure_channel, &left, &JsonValue::String("right".into())).await, Err(FavoritesError::Alias(e)) if e.code.as_str() == Some("alias_taken")));
        let settings_after = settings.find_one(doc! {"channelID":"migration-failure"}).await.unwrap().unwrap();
        assert_eq!(settings_after.get_document("voices").unwrap().get_str("cloneDefault").unwrap(), "left-id");
        assert_eq!(favorites::get_fish_voice_favorites(&db, &failure_channel).await.unwrap()[0].alias, JsString::from("left"));

        let race = JsString::from("race");
        // Seed the document to avoid conflating unique-index upsert races with CAS behavior.
        favorites::add_fish_voice_favorite(&db, &race, &JsString::from("seed"), &JsString::from("Seed")).await.unwrap();
        let same = JsString::from("same"); let same_name = JsString::from("Same");
        let (a, b) = tokio::join!(favorites::add_fish_voice_favorite(&db, &race, &same, &same_name), favorites::add_fish_voice_favorite(&db, &race, &same, &same_name));
        assert_eq!(a.unwrap(), b.unwrap());
        let one = JsString::from("one"); let two = JsString::from("two"); let shared_name = JsString::from("Shared Name");
        let (a, b) = tokio::join!(favorites::add_fish_voice_favorite(&db, &race, &one, &shared_name), favorites::add_fish_voice_favorite(&db, &race, &two, &shared_name));
        let (a, b) = (a.unwrap(), b.unwrap()); assert_ne!(a.alias, b.alias);
        let target_alias = JsonValue::String("contended".into());
        let (a, b) = tokio::join!(favorites::rename_fish_voice_favorite(&db, &race, &one, &target_alias), favorites::rename_fish_voice_favorite(&db, &race, &two, &target_alias));
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert!(matches!(a, Err(FavoritesError::Alias(ref e)) if e.code.as_str() == Some("alias_taken")) || matches!(b, Err(FavoritesError::Alias(ref e)) if e.code.as_str() == Some("alias_taken")));
        let capacity = JsString::from("capacity-race");
        for i in 0..19 { favorites::add_fish_voice_favorite(&db, &capacity, &JsString::from(format!("n{i}")), &JsString::from("Voice")).await.unwrap(); }
        let a_id = JsString::from("a"); let b_id = JsString::from("b"); let voice = JsString::from("Voice");
        let (a, b) = tokio::join!(favorites::add_fish_voice_favorite(&db, &capacity, &a_id, &voice), favorites::add_fish_voice_favorite(&db, &capacity, &b_id, &voice));
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert!(matches!(a, Err(FavoritesError::Full)) || matches!(b, Err(FavoritesError::Full)));
        assert_eq!(favorites::get_fish_voice_favorites(&db, &capacity).await.unwrap().len(), 20);

        // BSON encodes lone surrogates as replacement characters. Reads compare
        // the decoded stored ID to the original JS string before issuing CAS.
        let replacement_channel = JsString::from("replacement");
        let lone_id = JsString::from_units(vec![0xd800]);
        let added = favorites::add_fish_voice_favorite(&db, &replacement_channel, &lone_id, &voice).await.unwrap();
        assert_eq!(added.id, lone_id);
        assert_eq!(favorites::get_fish_voice_favorites(&db, &replacement_channel).await.unwrap()[0].id, JsString::from("�"));
        assert!(matches!(favorites::add_fish_voice_favorite(&db, &replacement_channel, &lone_id, &voice).await, Err(FavoritesError::Conflict)));
        assert!(matches!(favorites::rename_fish_voice_favorite(&db, &replacement_channel, &lone_id, &JsonValue::String("new".into())).await, Err(FavoritesError::Alias(e)) if e.code.as_str() == Some("favorite_not_found")));
        favorites::remove_fish_voice_favorite(&db, &replacement_channel, &lone_id).await.unwrap();
        assert!(favorites::get_fish_voice_favorites(&db, &replacement_channel).await.unwrap().is_empty());
        let coll = favorites::schema().native_collection(&db);
        coll.insert_one(doc! {"channelID":"malformed", "favorites": [42]}).await.unwrap();
        assert!(matches!(favorites::get_fish_voice_favorites(&db, &JsString::from("malformed")).await, Err(FavoritesError::BsonBoundary(_))));
    }).catch_unwind().await;
    db.drop().await.unwrap();
    if let Err(panic) = test {
        std::panic::resume_unwind(panic);
    }
}
