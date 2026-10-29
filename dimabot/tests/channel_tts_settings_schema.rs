#![cfg(feature = "channel-tts-settings")]
use dima_rust::{schemas::channel_tts_settings::schema, utils::tts::expressive_tags};
use mongodb::bson::{DateTime, doc};

#[test]
fn constructs_independent_defaults_and_unique_index() {
    let schema = schema();
    let now = DateTime::from_millis(1_900_000_000_000);
    let mut a = schema.construct(&doc! {"channelID": "a"}, now).unwrap();
    let b = schema.construct(&doc! {"channelID": "b"}, now).unwrap();
    assert_eq!(schema.collection, "channel_tts_settings");
    assert_eq!(schema.indexes.len(), 1);
    assert!(schema.indexes[0].unique);
    assert_eq!(schema.indexes[0].keys, doc! {"channelID": 1});
    let tags = b
        .get_document("filters")
        .unwrap()
        .get_document("expressiveTags")
        .unwrap();
    assert_eq!(tags.len(), expressive_tags().count());
    assert!(expressive_tags().all(|tag| tags.get_bool(tag).unwrap()));
    a.get_document_mut("filters")
        .unwrap()
        .get_document_mut("expressiveTags")
        .unwrap()
        .insert("happy", false);
    assert!(tags.get_bool("happy").unwrap());
    assert_eq!(
        b.get_document("voices")
            .unwrap()
            .get_str("kokoroDefault")
            .unwrap(),
        "ef_dora"
    );
    assert!(
        schema
            .construct(&doc! {"channelID": "x", "provider": "invalid"}, now)
            .is_err()
    );
    assert!(schema.construct(&doc! {}, now).is_err());
}

#[test]
#[ignore = "requires owner-generated actual Mongoose reference"]
fn actual_mongoose_model_metadata_casts_and_validation() {
    use mongodb::bson::{Bson, Document};
    use serde_json::{Value, json};
    fn as_json(value: &Bson) -> Value {
        match value {
            Bson::ObjectId(id) => json!(id.to_hex()),
            Bson::Document(doc) => {
                Value::Object(doc.iter().map(|(k, v)| (k.clone(), as_json(v))).collect())
            }
            Bson::Array(items) => Value::Array(items.iter().map(as_json).collect()),
            Bson::String(s) => json!(s),
            Bson::Boolean(b) => json!(b),
            Bson::Null => Value::Null,
            Bson::Int32(n) => json!(n),
            Bson::Int64(n) => json!(n),
            Bson::Double(n) => serde_json::from_str(&n.to_string()).unwrap(),
            other => panic!("unexpected BSON {other:?}"),
        }
    }
    let bytes = std::fs::read(
        std::env::var("CHANNEL_TTS_SETTINGS_REFERENCE").expect("source reference path required"),
    )
    .unwrap();
    assert!(!bytes.is_empty());
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let schema = schema();
    assert_eq!(schema.model, data["metadata"]["model"].as_str().unwrap());
    assert_eq!(
        schema.collection,
        data["metadata"]["collection"].as_str().unwrap()
    );
    assert_eq!(data["metadata"]["timestamps"], true);
    assert_eq!(
        schema.indexes.len(),
        data["metadata"]["indexes"].as_array().unwrap().len()
    );
    for (index, source) in schema
        .indexes
        .iter()
        .zip(data["metadata"]["indexes"].as_array().unwrap())
    {
        assert_eq!(as_json(&Bson::Document(index.keys.clone())), source["keys"]);
        assert_eq!(index.unique, source["unique"].as_bool().unwrap());
    }
    for (i, case) in data["schemaCases"].as_array().unwrap().iter().enumerate() {
        let mut input: Document = mongodb::bson::serialize_to_document(&case["input"]).unwrap();
        input.insert(
            "_id",
            mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
        );
        let result = schema.construct(&input, DateTime::from_millis(1_900_000_000_000));
        if let Some(expected) = case["expected"].get("document") {
            assert_eq!(
                as_json(&Bson::Document(result.unwrap())),
                *expected,
                "case {i}"
            );
        } else {
            let errors = result.unwrap_err();
            let mut actual: Vec<_> = errors
                .0
                .iter()
                .map(|e| (e.path.clone(), e.kind.to_owned()))
                .collect();
            actual.sort();
            let mut expected: Vec<_> = case["expected"]["errors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e["path"].as_str().unwrap().to_owned(),
                        if e["name"] == "CastError" {
                            "cast".to_owned()
                        } else {
                            e["kind"].as_str().unwrap().to_owned()
                        },
                    )
                })
                .collect();
            expected.sort();
            assert_eq!(actual, expected, "case {i}");
        }
    }
}
