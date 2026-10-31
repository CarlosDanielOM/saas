#![cfg(feature = "pet-settings-service")]
#[path = "support/pet_settings_service_support.rs"] mod support;
use dima_rust::pet_settings_service::{validate_pet_settings, Error};
#[test]
#[ignore = "requires pinned isolated actual-source oracle fixture"]
fn actual_source_validation_oracle() {
    let fixture = support::fixture();
    let cases = fixture["cases"].as_array().unwrap();
    let names: Vec<_> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["defaults","trim","legacy","invalid_voice","disabled_independent_voice","invalid_rules","missing_asset_id","bad_queue","extra_key","utf16_length","fish_custom"]);
    for case in cases {
        match validate_pet_settings(&case["input"]) {
            Ok(value) => assert_eq!(value, case["result"], "{}", case["name"]),
            Err(Error::Settings(code,status)) => { assert_eq!(code, case["error"]["code"]); assert_eq!(status as u64, case["error"]["status"].as_u64().unwrap()); },
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
}

#[tokio::test]
#[ignore = "requires task-owned disposable MongoDB and explicit fixture guard"]
async fn private_mongo_plan_and_revision_conflicts() {
    use dima_rust::pet_settings_service::{default_pet_settings, MongoPetSettings};
    use mongodb::{bson::{doc, oid::ObjectId, DateTime}, Client};
    assert_eq!(std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(), Ok("dimabot-migration"));
    assert_eq!(std::env::var("PET_SETTINGS_TEST_MONGO_ACK").as_deref(), Ok("disposable"));
    let name = std::env::var("PET_SETTINGS_TEST_MONGO_DATABASE").expect("unique task database");
    assert!(name.starts_with("rust_pet_settings_fixture_") && name.len() > "rust_pet_settings_fixture_".len());
    let client = Client::with_uri_str(std::env::var("PET_SETTINGS_TEST_MONGO_URI").expect("private Mongo URI")).await.unwrap();
    let db = client.database(&name);
    assert!(db.list_collection_names().await.unwrap().is_empty(), "fixture database must be empty");
    let store = MongoPetSettings::new(db.clone());
    let owner = ObjectId::new(); let owner_string = owner.to_hex();
    assert!(matches!(store.require_plan(&owner_string,"chan").await, Err(Error::Settings("access_denied",403))));
    db.collection::<mongodb::bson::Document>("users").insert_one(doc! {"_id":owner,"plan_tier":"free","accounts":[{"type":"twitch","id":"chan"}]}).await.unwrap();
    assert!(matches!(store.require_plan(&owner_string,"chan").await, Err(Error::Settings("plan_required",403))));
    db.collection::<mongodb::bson::Document>("users").update_one(doc! {"_id":owner},doc! {"$set":{"plan_tier":"premium"}}).await.unwrap();
    assert!(store.require_plan(&owner_string,"chan").await.is_ok());
    assert!(matches!(store.require_plan(&owner_string,"other").await, Err(Error::Settings("access_denied",403))));
    // The type and id must belong to the same account, and another owner is denied.
    let other=ObjectId::new();
    db.collection::<mongodb::bson::Document>("users").insert_one(doc! {"_id":other,"plan_tier":"pro","accounts":[{"type":"twitch","id":"other"},{"type":"youtube","id":"chan"}]}).await.unwrap();
    assert!(matches!(store.require_plan(&other.to_hex(),"chan").await, Err(Error::Settings("access_denied",403))));
    let settings = default_pet_settings();
    store.write(&owner_string,0,&settings,DateTime::now()).await.unwrap();
    assert!(matches!(store.write(&owner_string,0,&settings,DateTime::now()).await, Err(Error::Settings("settings_conflict",409))));
    assert!(matches!(store.write(&owner_string,2,&settings,DateTime::now()).await, Err(Error::Settings("settings_conflict",409))));
    store.write(&owner_string,1,&settings,DateTime::now()).await.unwrap();
    let record = store.record(&owner_string).await.unwrap().unwrap();
    assert_eq!(record.get_f64("revision").unwrap(),2.0);
    assert_eq!(record.get_document("settings").unwrap().get_str("name").unwrap(),"Dima");
    assert!(matches!(store.write(&owner_string,1,&settings,DateTime::now()).await, Err(Error::Settings("settings_conflict",409))));
    assert_eq!(store.record(&owner_string).await.unwrap().unwrap().get_f64("revision").unwrap(),2.0);
    assert!(store.profile_exists("chan","absent").await.unwrap() == false);
    assert!(store.runtime(&owner_string).await.unwrap().is_none());
    // Exercise the orchestration with the concrete Mongo store and native shared library.
    use std::sync::Arc;
    use dima_rust::{media::library::AssetLibrary, pet_settings_service::PetSettingsService};
    let asset_id = "507f1f77bcf86cd799439011";
    db.collection::<mongodb::bson::Document>("asset_libraries").insert_one(doc! {"_id":"chan","usedBytes":0,"assets":[{"id":asset_id,"kind":"image","mime":"image/png","state":"ready"}]}).await.unwrap();
    let coord = support::Boundary::new(&serde_json::json!({}));
    let service = PetSettingsService::new(store.clone(),Arc::new(AssetLibrary::native(db.clone())),coord.clone());
    let mut next=settings.clone();
    next["appearance"]["idleAssetId"]=serde_json::json!(asset_id);
    next["appearance"]["talkingAssetId"]=serde_json::json!(asset_id);
    let saved=service.save(&owner_string,"chan",&serde_json::json!({"revision":2,"settings":next})).await.unwrap();
    assert_eq!(saved["revision"],3);
    assert_eq!(store.record(&owner_string).await.unwrap().unwrap().get_f64("revision").unwrap(),3.0);
    assert!(matches!(service.save(&owner_string,"chan",&serde_json::json!({"revision":2,"settings":settings})).await,Err(Error::Settings("settings_conflict",409))));
    let mut missing=settings.clone(); missing["appearance"]["idleAssetId"]=serde_json::json!("507f1f77bcf86cd799439013");
    assert!(matches!(service.save(&owner_string,"chan",&serde_json::json!({"revision":3,"settings":missing})).await,Err(Error::Asset(_))));
    assert_eq!(store.record(&owner_string).await.unwrap().unwrap().get_f64("revision").unwrap(),3.0);
    assert!(matches!(service.save(&other.to_hex(),"chan",&serde_json::json!({"invalid":true})).await,Err(Error::Settings("access_denied",403))));
    db.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires pinned isolated actual-source oracle fixture"]
async fn actual_source_read_save_oracle() {
    use std::sync::Arc;
    use dima_rust::{media::library::{AssetLibrary, FfprobeInspector}, pet_settings_service::PetSettingsService};
    let fixture = support::fixture();
    let cases=fixture["serviceCases"].as_array().unwrap();
    let names: Vec<_> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names,["read_default","read_legacy","read_profile_ready_lease","read_missing_profile_vts","read_png","save_first","save_session_error","save_missing_asset","save_invalid_asset","save_conflict","save_missing_profile_before_session","save_invalidation_failure","denied_before_validation"]);
    for case in cases {
        let boundary=support::Boundary::new(case);
        let library=Arc::new(AssetLibrary::with_repositories(Arc::new(FfprobeInspector),Arc::new(boundary.clone()),Arc::new(support::NoGridFs)));
        let service=PetSettingsService::new(boundary.clone(),library,boundary.clone());
        let result=if case["operation"] == "get" { service.get("507f1f77bcf86cd799439012","chan").await } else { service.save("507f1f77bcf86cd799439012","chan",&case["input"]).await };
        match result {
            Ok(mut value) => { if !value["updatedAt"].is_null() { value["updatedAt"] = serde_json::json!("<date>"); } assert_eq!(value,case["result"],"{}",case["name"]); },
            Err(error) => { let (code,status)=match error { Error::Settings(c,s) => (c.to_owned(),s), Error::Pet{code,status} => (code,status), Error::Asset(e) => (e.code.to_owned(),e.status), other => panic!("unexpected {other:?}") }; assert_eq!(code,case["error"]["code"],"{}",case["name"]); assert_eq!(status as u64,case["error"]["status"].as_u64().unwrap()); }
        }
        // The actual AssetLibrary provides the lock and finds assets via its repository;
        // its repository seam receives only the owner, so asset-ID/lock trace entries
        // from the TypeScript boundary are compared through results, not call names.
        let source_calls: Vec<&str> = case["calls"].as_array().unwrap().iter().filter_map(|v| v.as_str()).filter(|s| *s != "lock" && *s != "unlock" && !s.starts_with("asset:")).collect();
        assert_eq!(boundary.calls(),source_calls,"{}",case["name"]);
        assert_eq!(boundary.persisted(),case["persisted"].as_bool().unwrap(),"{}",case["name"]);
    }
}

#[tokio::test]
async fn read_formats_updated_at_like_javascript_date_json() {
    use std::sync::Arc;
    use dima_rust::{media::library::{AssetLibrary, FfprobeInspector}, pet_settings_service::{default_pet_settings, PetSettingsService}};
    use mongodb::bson::{doc, DateTime};
    let boundary = support::Boundary::new(&serde_json::json!({}));
    boundary.state.lock().unwrap().record = Some(doc! {
        "revision": 1,
        "settings": mongodb::bson::to_document(&default_pet_settings()).unwrap(),
        "updatedAt": DateTime::from_millis(1_767_225_600_000_i64)
    });
    let library = Arc::new(AssetLibrary::with_repositories(Arc::new(FfprobeInspector), Arc::new(boundary.clone()), Arc::new(support::NoGridFs)));
    let service = PetSettingsService::new(boundary.clone(), library, boundary);
    let value = service.get("507f1f77bcf86cd799439012", "chan").await.unwrap();
    assert_eq!(value["updatedAt"], "2026-01-01T00:00:00.000Z");
}
