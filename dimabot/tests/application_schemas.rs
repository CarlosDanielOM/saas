#![cfg(feature = "application-schemas")]
use dima_rust::schemas::{self, SchemaDefinition};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/application_schemas_cases.json")).unwrap()
}
fn bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::String(value) => Bson::String(value.clone()),
        Value::Number(value) => dima_rust::utils::bson_compat::js_number(value.as_f64().unwrap()),
        Value::Array(values) => Bson::Array(values.iter().map(bson).collect()),
        Value::Object(object) => Bson::Document(
            object
                .iter()
                .map(|(key, value)| (key.clone(), bson(value)))
                .collect(),
        ),
    }
}
fn input(value: &Value) -> Document {
    bson(value).as_document().unwrap().clone()
}
fn normalized(value: &Bson, input: Option<&Value>) -> Value {
    match value {
        Bson::ObjectId(id) => {
            json!({"$oid":if input.is_none(){"generated".to_owned()}else{id.to_hex()}})
        }
        Bson::DateTime(value) => json!({"$date":value.timestamp_millis()}),
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        normalized(value, input.and_then(|input| input.get(key))),
                    )
                })
                .collect(),
        ),
        Bson::Array(values) => Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| normalized(value, input.and_then(|input| input.get(index))))
                .collect(),
        ),
        Bson::Null => Value::Null,
        Bson::Boolean(value) => json!(value),
        Bson::String(value) => json!(value),
        Bson::Int32(value) => json!(value),
        Bson::Int64(value) => json!(value),
        Bson::Double(value) => json!(value),
        other => panic!("unexpected fixture BSON {other:?}"),
    }
}
fn definition(name: &str) -> &'static SchemaDefinition {
    schemas::definitions()
        .into_iter()
        .find(|definition| match name {
            "users" => definition.model == "users",
            "accounts" => definition.model == "Account",
            "admin" => definition.model == "Admin",
            "app_config" => definition.model == "app_config",
            "channel_config" => definition.model == "channelconfig",
            "oauth_client" => definition.model == "OAuthClient",
            "oauth_grant" => definition.model == "OAuthGrant",
            "oauth_refresh_token" => definition.model == "OAuthRefreshToken",
            "oauth_session" => definition.model == "OAuthSession",
            "credit_gift" => definition.model == "CreditGift",
            "credit_transaction" => definition.model == "CreditTransaction",
            _ => false,
        })
        .unwrap()
}
#[test]
fn native_schema_defaults_casts_and_validation_match_mongoose() {
    let data = fixture();
    let now = DateTime::from_millis(data["fixedNow"].as_i64().unwrap());
    for (index, case) in data["cases"].as_array().unwrap().iter().enumerate() {
        let schema = definition(case["schema"].as_str().unwrap());
        let input_value = &case["input"];
        let result = if case["operation"] == "insert" {
            schema.prepare_insert(input(input_value), now)
        } else {
            schema.construct(&input(input_value), now)
        };
        let actual = match result {
            Ok(document) => {
                json!({"document":normalized(&Bson::Document(document),Some(input_value))})
            }
            Err(errors) => {
                let mut errors: Vec<_> = errors
                    .0
                    .into_iter()
                    .map(|error| json!({"path":error.path,"kind":error.kind}))
                    .collect();
                errors.sort_by(|a, b| a["path"].as_str().unwrap().cmp(b["path"].as_str().unwrap()));
                json!({"errors":errors})
            }
        };
        assert_eq!(
            actual, case["expected"],
            "schema {} case {index}",
            case["schema"]
        );
    }
}
#[test]
fn collection_names_indexes_and_default_selections_match_source() {
    let data = fixture();
    for (name, expected) in data["definitions"].as_object().unwrap() {
        let schema = definition(name);
        assert_eq!(schema.model, expected["model"]);
        assert_eq!(schema.collection, expected["collection"]);
        let mut hidden: Vec<_> = schema.default_projection().keys().cloned().collect();
        hidden.sort();
        assert_eq!(json!(hidden), expected["hidden"]);
        let indexes:Vec<_>=schema.indexes.iter().map(|index|json!({"keys":normalized(&Bson::Document(index.keys.clone()),None),"unique":index.unique,"sparse":index.sparse,"ttl":index.ttl.map(|duration|duration.as_secs()),"partial":index.partial.as_ref().map(|document|normalized(&Bson::Document(document.clone()),None))})).collect();
        assert_eq!(json!(indexes), expected["indexes"], "{name}");
    }
}
#[test]
fn save_hooks_preserve_creation_and_refresh_only_source_clock_fields() {
    let first = DateTime::from_millis(1000);
    let next = DateTime::from_millis(2000);
    let admin = schemas::admin::schema()
        .prepare_save(doc! {"createdAt":first,"updatedAt":first}, next)
        .unwrap();
    assert_eq!(admin.get_datetime("createdAt").unwrap(), &first);
    assert_eq!(admin.get_datetime("updatedAt").unwrap(), &next);
    let app = schemas::app_config::schema()
        .prepare_save(doc! {"refreshed_at":first}, next)
        .unwrap();
    assert_eq!(app.get_datetime("refreshed_at").unwrap(), &next);
    let user = schemas::users::schema()
        .prepare_save(
            doc! {"created_at":first,"updated_at":first,"refreshed_at":first},
            next,
        )
        .unwrap();
    assert_eq!(user.get_datetime("created_at").unwrap(), &first);
    assert_eq!(user.get_datetime("updated_at").unwrap(), &next);
    assert_eq!(user.get_datetime("refreshed_at").unwrap(), &first);
}
#[test]
#[ignore = "explicit isolated release comparison only"]
fn benchmark_application_schemas() {
    use std::{hint::black_box, time::Instant};
    let data = fixture();
    let now = DateTime::from_millis(data["fixedNow"].as_i64().unwrap());
    let mut runs = Vec::new();
    for workload in data["workloads"].as_array().unwrap() {
        let schema = definition(workload["schema"].as_str().unwrap());
        let input_value = &workload["input"];
        let input = input(input_value);
        let iterations = workload["iterations"].as_u64().unwrap() as usize;
        for operation in ["constructValidate", "constructValidateSerialize"] {
            let run = || -> usize {
                let document = black_box(schema.construct(black_box(&input), now).unwrap());
                if operation == "constructValidateSerialize" {
                    black_box(
                        serde_json::to_string(&normalized(
                            &Bson::Document(document),
                            Some(input_value),
                        ))
                        .unwrap(),
                    )
                    .len()
                } else {
                    document.len()
                }
            };
            for _ in 0..100 {
                black_box(run());
            }
            let mut samples = Vec::new();
            let mut sink = 0;
            for _ in 0..7 {
                let start = Instant::now();
                for _ in 0..iterations {
                    sink += black_box(run());
                }
                samples.push(start.elapsed().as_nanos() as f64 / iterations as f64);
            }
            let mut sorted = samples.clone();
            sorted.sort_by(f64::total_cmp);
            runs.push(json!({"workload":workload["name"],"operation":operation,"iterations":iterations,"samplesNsPerOp":samples,"medianNsPerOp":sorted[3],"sink":sink}));
        }
    }
    let report = json!({"implementation":"rust-native-application-schemas","profile":"release","samples":7,"runs":runs});
    if let Ok(path) = std::env::var("APPLICATION_SCHEMAS_BENCHMARK_OUTPUT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
    println!("APPLICATION_SCHEMAS_BENCHMARK={report}");
}

/// Must receive task-owned fixture addresses and a uniquely named disposable
/// database. No application defaults, env files or production clients are used.
#[tokio::test]
#[ignore = "requires explicitly supplied isolated MongoDB fixture"]
async fn native_schema_persistence_indexes_and_hooks() {
    use futures_util::TryStreamExt;
    use mongodb::{Client, bson::oid::ObjectId};
    let uri = std::env::var("APPLICATION_SCHEMAS_TEST_MONGO_URI")
        .expect("task-owned fixture URI required");
    let database_name =
        std::env::var("APPLICATION_SCHEMAS_TEST_DATABASE").expect("task-owned database required");
    assert!(database_name.starts_with("rust_schema_fixture_"));
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&database_name);
    let first = DateTime::from_millis(1_900_000_000_000);
    let next = DateTime::from_millis(first.timestamp_millis() + 1000);
    for definition in schemas::definitions() {
        definition.install_indexes(&db).await.unwrap();
    }
    let users = schemas::users::schema().repository(&db);
    let user = users
        .insert(
            doc! {"name":"fixture","applied_credit_transaction_ids":[ObjectId::new()]},
            first,
        )
        .await
        .unwrap();
    let id = user.get("_id").unwrap().clone();
    let public = users
        .find_one(doc! {"_id":id.clone()})
        .await
        .unwrap()
        .unwrap();
    assert!(!public.contains_key("applied_credit_transaction_ids"));
    assert!(
        users
            .find_one_with_hidden(doc! {"_id":id.clone()})
            .await
            .unwrap()
            .unwrap()
            .contains_key("applied_credit_transaction_ids")
    );
    let saved = users
        .save(doc! {"_id":id.clone(),"name":"updated"}, next)
        .await
        .unwrap();
    assert_eq!(saved.get_datetime("updated_at").unwrap(), &next);
    assert!(!saved.contains_key("applied_credit_transaction_ids"));
    assert!(
        users
            .find_one_with_hidden(doc! {"_id":id.clone()})
            .await
            .unwrap()
            .unwrap()
            .contains_key("applied_credit_transaction_ids")
    );
    assert_eq!(saved.get_datetime("created_at").unwrap(), &first);
    let client_repo = schemas::oauth_client::schema().repository(&db);
    let client_input = doc! {"client_id":"fixture-client","name":"fixture","type":"public"};
    client_repo
        .insert(client_input.clone(), first)
        .await
        .unwrap();
    assert!(client_repo.insert(client_input, first).await.is_err());
    let grants = schemas::oauth_grant::schema().repository(&db);
    let grant = doc! {"user_id":id,"client_id":"fixture-client","channel_id":"fixture-channel"};
    grants.insert(grant.clone(), first).await.unwrap();
    assert!(grants.insert(grant, first).await.is_err());
    let transactions = schemas::credit_transaction::schema().repository(&db);
    let tx = doc! {"user":ObjectId::new(),"type":"manual_credit","amount":1,"idempotencyKey":"fixture-once"};
    transactions.insert(tx.clone(), first).await.unwrap();
    assert!(transactions.insert(tx, first).await.is_err());
    for _ in 0..2 {
        transactions
            .insert(
                doc! {"user":ObjectId::new(),"type":"manual_credit","amount":1},
                first,
            )
            .await
            .unwrap();
    }
    let admin = schemas::admin::schema().repository(&db);
    let document = admin
        .insert(doc! {"adminName":"fixture"}, first)
        .await
        .unwrap();
    let saved = admin.save(document, next).await.unwrap();
    assert_eq!(saved.get_datetime("updatedAt").unwrap(), &next);
    let app = schemas::app_config::schema().repository(&db);
    let document = app.insert(doc! {"name":"fixture"}, first).await.unwrap();
    let saved = app.save(document, next).await.unwrap();
    assert_eq!(saved.get_datetime("refreshed_at").unwrap(), &next);
    for definition in [
        schemas::oauth_refresh_token::schema(),
        schemas::oauth_session::schema(),
    ] {
        let indexes: Vec<_> = db
            .collection::<Document>(definition.collection)
            .list_indexes()
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        assert!(indexes.iter().any(|index| {
            index.keys == doc! {"expires_at":1}
                && index
                    .options
                    .as_ref()
                    .and_then(|options| options.expire_after)
                    == Some(std::time::Duration::ZERO)
        }));
    }
    // Cleanup is restricted to the explicit task-owned fixture database.
    db.drop().await.unwrap();
}
