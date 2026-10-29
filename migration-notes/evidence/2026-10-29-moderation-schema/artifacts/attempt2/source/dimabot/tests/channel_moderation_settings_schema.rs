#![cfg(feature = "channel-moderation-settings")]
use dima_rust::schemas::channel_moderation_settings::{
    MAX_ALLOWLIST_DOMAINS, MAX_BLACKLIST_TERMS, MAX_OFFENSE_WINDOW_SECONDS, MAX_RULES_PER_CHANNEL,
    MAX_TIMEOUT_SECONDS, MIN_OFFENSE_WINDOW_SECONDS, MODERATION_OFFENSE_DEFAULTS,
    MODERATION_RULE_DEFAULTS, MODERATION_SETTINGS_DEFAULTS, ModerationAction, ModerationRuleType,
    build_default_moderation_rules,
};
use std::{collections::HashSet, sync::Arc};

#[test]
fn builder_follows_source_order_ids_and_shared_base() {
    let rules = build_default_moderation_rules();
    let another = build_default_moderation_rules();
    assert_eq!(rules.len(), 4);
    assert_eq!(
        rules.iter().map(|r| r.rule_type).collect::<Vec<_>>(),
        vec![
            ModerationRuleType::Caps,
            ModerationRuleType::Links,
            ModerationRuleType::EmoteSpam,
            ModerationRuleType::Blacklist
        ]
    );
    assert_eq!(
        rules.iter().map(|r| r.enabled).collect::<Vec<_>>(),
        vec![true, true, true, false]
    );
    assert_eq!(
        rules
            .iter()
            .map(|r| r.reason.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "Please do not use so many caps",
            "Please do not post links",
            "Please do not spam emotes",
            "You used a blocked word or phrase"
        ]
    );
    let mut ids = HashSet::new();
    for rule in rules.iter().chain(&another) {
        let id = uuid::Uuid::parse_str(rule.id.as_str().unwrap()).unwrap();
        assert_eq!(id.get_version_num(), 4);
        assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
        assert!(ids.insert(id));
    }
    for rule in &rules {
        assert!(Arc::ptr_eq(&rule.first_offense, &rules[0].first_offense));
        assert!(Arc::ptr_eq(&rule.second_offense, &rules[0].second_offense));
        assert!(Arc::ptr_eq(&rule.third_offense, &rules[0].third_offense));
        assert!(Arc::ptr_eq(
            &rule.allowlist_domains,
            &rules[0].allowlist_domains
        ));
        assert!(Arc::ptr_eq(&rule.terms, &rules[0].terms));
    }
    assert!(!Arc::ptr_eq(
        &rules[0].first_offense,
        &another[0].first_offense
    ));
    assert!(!Arc::ptr_eq(
        &rules[0].allowlist_domains,
        &another[0].allowlist_domains
    ));
    rules[0].first_offense.lock().unwrap().timeout_seconds = 123.0;
    rules[0]
        .allowlist_domains
        .lock()
        .unwrap()
        .push("MUTATION".into());
    assert_eq!(
        rules[3].first_offense.lock().unwrap().timeout_seconds,
        123.0
    );
    assert_eq!(
        rules[3].allowlist_domains.lock().unwrap()[0].as_str(),
        Some("MUTATION")
    );
    assert_eq!(
        another[0].first_offense.lock().unwrap().timeout_seconds,
        60.0
    );
    assert!(another[0].allowlist_domains.lock().unwrap().is_empty());
}
#[test]
fn public_default_constants() {
    assert_eq!(
        [
            MODERATION_OFFENSE_DEFAULTS.first.action,
            MODERATION_OFFENSE_DEFAULTS.second.action,
            MODERATION_OFFENSE_DEFAULTS.third.action
        ],
        [
            ModerationAction::Warn,
            ModerationAction::Delete,
            ModerationAction::Timeout
        ]
    );
    assert_eq!(
        (
            MODERATION_RULE_DEFAULTS.min_caps_count,
            MODERATION_RULE_DEFAULTS.max_caps_percentage,
            MODERATION_RULE_DEFAULTS.min_message_length,
            MODERATION_RULE_DEFAULTS.max_emote_count
        ),
        (8.0, 70.0, 10.0, 10.0)
    );
    assert_eq!(
        (
            MODERATION_SETTINGS_DEFAULTS.enabled,
            MODERATION_SETTINGS_DEFAULTS.offense_window_seconds,
            MODERATION_SETTINGS_DEFAULTS.settings_version
        ),
        (false, 3600.0, 1.0)
    );
    assert_eq!(
        (
            MAX_TIMEOUT_SECONDS,
            MIN_OFFENSE_WINDOW_SECONDS,
            MAX_OFFENSE_WINDOW_SECONDS
        ),
        (1_209_600, 60, 86_400)
    );
    assert_eq!(
        (
            MAX_RULES_PER_CHANNEL,
            MAX_BLACKLIST_TERMS,
            MAX_ALLOWLIST_DOMAINS
        ),
        (20, 200, 50)
    );
}

#[test]
fn schema_defaults_validators_and_independent_documents() {
    use dima_rust::schemas::channel_moderation_settings::schema;
    use mongodb::bson::{DateTime, doc};
    let schema = schema();
    let now = DateTime::from_millis(1_900_000_000_000);
    assert_eq!(schema.model, "channel_moderation_settings");
    assert_eq!(schema.collection, "channel_moderation_settings");
    assert_eq!(schema.timestamps, Some(("createdAt", "updatedAt")));
    assert_eq!(schema.indexes.len(), 1);
    assert!(schema.indexes[0].unique);
    assert_eq!(schema.indexes[0].keys, doc! {"channelID":1});
    let mut first = schema
        .construct(
            &doc! {"channelID":"a","rules":[{"id":"1","type":"caps"}]},
            now,
        )
        .unwrap();
    let second = schema
        .construct(
            &doc! {"channelID":"b","rules":[{"id":"2","type":"caps"}]},
            now,
        )
        .unwrap();
    let spam = second.get_document("spamProtection").unwrap();
    assert_eq!(
        spam.get_array("categories").unwrap(),
        &vec!["spam".into(), "ads".into(), "self_promotion".into()]
    );
    assert_eq!(
        spam.get_array("exemptTags").unwrap(),
        &vec!["mod".into(), "editor".into(), "admin".into()]
    );
    let rule = second.get_array("rules").unwrap()[0].as_document().unwrap();
    assert_eq!(
        rule.get_document("secondOffense")
            .unwrap()
            .get_str("action")
            .unwrap(),
        "delete"
    );
    assert_eq!(
        rule.get_document("thirdOffense")
            .unwrap()
            .get_str("action")
            .unwrap(),
        "timeout"
    );
    assert_eq!(
        rule.get_document("variations").unwrap(),
        &doc! {"mode":"off","entries":[]}
    );
    first
        .get_document_mut("spamProtection")
        .unwrap()
        .get_array_mut("categories")
        .unwrap()
        .clear();
    assert_eq!(spam.get_array("categories").unwrap().len(), 3);
    let bad=schema.construct(&doc!{"channelID":"x","spamProtection":{"categories":["invalid"],"exemptTags":["bad"]}},now).unwrap_err();
    assert!(
        bad.0
            .iter()
            .any(|e| e.path == "spamProtection.categories.0" && e.kind == "enum")
    );
    assert!(
        bad.0
            .iter()
            .any(|e| e.path == "spamProtection.exemptTags.0" && e.kind == "enum")
    );
    assert!(schema.construct(&doc! {}, now).is_err());
}

#[test]
#[ignore = "requires pinned actual Mongoose reference"]
fn replay_actual_mongoose_schema() {
    use dima_rust::schemas::channel_moderation_settings::schema;
    use mongodb::bson::{Bson, DateTime, Document};
    use serde_json::{Value, json};
    fn as_json(v: &Bson) -> Value {
        match v {
            Bson::ObjectId(id) => json!(id.to_hex()),
            Bson::Document(d) => {
                Value::Object(d.iter().map(|(k, v)| (k.clone(), as_json(v))).collect())
            }
            Bson::Array(a) => Value::Array(a.iter().map(as_json).collect()),
            Bson::String(s) => json!(s),
            Bson::Boolean(b) => json!(b),
            Bson::Null => Value::Null,
            Bson::Int32(n) => json!(n),
            Bson::Int64(n) => json!(n),
            Bson::Double(n) => json!(n),
            other => panic!("unsupported JSON oracle BSON {other:?}"),
        }
    }
    let dir = std::env::var("DIMA_MODERATION_SCHEMA_REFERENCE_DIR").expect("reference directory");
    let bytes = std::fs::read(
        std::path::Path::new(&dir).join("channel-moderation-settings-reference.json"),
    )
    .unwrap();
    assert_eq!(
        sha256_hex(&bytes),
        std::env::var("DIMA_MODERATION_SCHEMA_REFERENCE_SHA256")
            .expect("independent reference SHA")
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    for (file, content) in [
        (
            "src/schemas/channel_moderation_settings.schema.rs",
            include_bytes!("../src/schemas/channel_moderation_settings.schema.rs").as_slice(),
        ),
        (
            "src/schemas/schema.rs",
            include_bytes!("../src/schemas/schema.rs").as_slice(),
        ),
        (
            "src/utils/moderation/spam_categories.rs",
            include_bytes!("../src/utils/moderation/spam_categories.rs").as_slice(),
        ),
        (
            "src/utils/moderation/caps.rs",
            include_bytes!("../src/utils/moderation/caps.rs").as_slice(),
        ),
        (
            "tests/channel_moderation_settings_schema.rs",
            include_bytes!("channel_moderation_settings_schema.rs").as_slice(),
        ),
        (
            "tests/channel_moderation_settings_store.rs",
            include_bytes!("channel_moderation_settings_store.rs").as_slice(),
        ),
        (
            "tests/fixtures/channel_moderation_settings_reference.cjs",
            include_bytes!("fixtures/channel_moderation_settings_reference.cjs").as_slice(),
        ),
        ("Cargo.toml", include_bytes!("../Cargo.toml").as_slice()),
        ("Cargo.lock", include_bytes!("../Cargo.lock").as_slice()),
    ] {
        assert_eq!(
            sha256_hex(content),
            data["metadata"]["hashes"][file].as_str().unwrap(),
            "{file}"
        );
    }
    assert_eq!(
        data["metadata"]["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(
        data["metadata"]["pins"]["src/schemas/channel_moderation_settings.schema.ts"],
        "e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653"
    );
    let built = build_default_moderation_rules();
    assert_eq!(built.len(), 4);
    let actions = |value: ModerationAction| match value {
        ModerationAction::Off => "off",
        ModerationAction::Warn => "warn",
        ModerationAction::Delete => "delete",
        ModerationAction::Timeout => "timeout",
        ModerationAction::Ban => "ban",
    };
    let types = |value: ModerationRuleType| match value {
        ModerationRuleType::Caps => "caps",
        ModerationRuleType::Links => "links",
        ModerationRuleType::EmoteSpam => "emote_spam",
        ModerationRuleType::Blacklist => "blacklist",
    };
    let mut ids = std::collections::HashSet::new();
    for (i, r) in built.iter().enumerate() {
        let uuid = uuid::Uuid::parse_str(r.id.as_str().unwrap()).unwrap();
        assert_eq!(uuid.get_version_num(), 4);
        assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
        assert!(ids.insert(uuid));
        let step = |v: &std::sync::Mutex<
            dima_rust::schemas::channel_moderation_settings::IModerationOffenseStep,
        >| {
            let x = v.lock().unwrap();
            json!({"action":actions(x.action),"timeoutSeconds":x.timeout_seconds as i64})
        };
        let actual = json!({"id":format!("<UUID:{i}>"),"type":types(r.rule_type),"enabled":r.enabled,"firstOffense":step(&r.first_offense),"secondOffense":step(&r.second_offense),"thirdOffense":step(&r.third_offense),"reason":r.reason.as_str().unwrap(),"exemptUserLevel":r.exempt_user_level as i64,"capsThresholdMode":"count","minCapsCount":r.min_caps_count as i64,"maxCapsPercentage":r.max_caps_percentage as i64,"minMessageLength":r.min_message_length as i64,"allowlistDomains":[],"maxEmoteCount":r.max_emote_count as i64,"terms":[]});
        assert_eq!(actual, data["defaults"]["builder"][i], "builder {i}");
    }
    let schema = schema();
    assert_eq!(schema.model, data["metadata"]["model"].as_str().unwrap());
    assert_eq!(
        schema.collection,
        data["metadata"]["collection"].as_str().unwrap()
    );
    assert_eq!(schema.timestamps, Some(("createdAt", "updatedAt")));
    assert_eq!(schema.indexes.len(), 1);
    assert!(schema.indexes[0].unique);
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(
        data["metadata"]["cases"].as_u64().unwrap() as usize,
        cases.len()
    );
    assert!(cases.len() > 40);
    for (i, case) in cases.iter().enumerate() {
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        input.insert(
            "_id",
            mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
        );
        let actual = schema.construct(&input, DateTime::from_millis(1_900_000_000_000));
        let expected_errors = case["errors"].as_array().unwrap();
        if expected_errors.is_empty() {
            assert_eq!(
                as_json(&Bson::Document(actual.unwrap())),
                case["document"],
                "case {i}"
            );
        } else {
            let errors = actual.unwrap_err();
            let mut got = errors
                .0
                .iter()
                .map(|e| (e.path.clone(), e.kind.to_string()))
                .collect::<Vec<_>>();
            let mut expected = expected_errors
                .iter()
                .map(|e| {
                    (
                        e["path"].as_str().unwrap().to_string(),
                        e["kind"].as_str().unwrap().to_string(),
                    )
                })
                .collect::<Vec<_>>();
            got.sort();
            expected.sort();
            assert_eq!(got, expected, "case {i}");
        }
    }
}

// Existing independent test helper, copied to avoid a new dependency.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[index] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let a = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let b = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let x = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(x);
            d = c;
            c = b;
            b = a;
            a = x.wrapping_add(y);
        }
        for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(word);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}
