#![cfg(feature = "channel-ai-personality")]
//! Ignored integration coverage against a unique disposable fixture database.
use dima_rust::{schemas::{channel_ai_personality as p,users},utils::credit_policy::JsDate};
use mongodb::{Client,bson::{doc,Bson,DateTime,oid::ObjectId}};
use futures_util::FutureExt;
async fn with_cleanup<F,T>(db:&mongodb::Database,body:F)->std::thread::Result<T> where F:std::future::Future<Output=T> {
    let result=std::panic::AssertUnwindSafe(body).catch_unwind().await;let cleanup=db.drop().await;if let Err(error)=cleanup {if result.is_ok(){panic!("fixture cleanup failed: {error}")}eprintln!("fixture cleanup failed: {error}");}result
}
#[test]
#[ignore = "explicit pinned source oracle required"]
fn personality_schema_source_oracle() {
    let value=golden("DIMA_AI_PERSONALITY_REFERENCE_DIR","channel_ai_personality_reference.json","channel_ai_personality_reference.cjs");let fields=value["fields"].as_object().expect("oracle fields missing");
    for name in ["channelID","channel","profiles","activeProfileId","personality","personaMode","personaReference","tonePreset","language","voiceProfile","learningConfig","memoryPolicy","rules","knownUsers","contextWindow","createdAt","updatedAt"] {
        assert!(fields.contains_key(name),"source field {name}");assert!(p::schema().fields.iter().any(|f|f.name==name),"native field {name}");
    }
    compare_fields(fields,&p::schema().fields,"root");assert_eq!(value["indexes"].as_array().unwrap().len(),p::schema().indexes.len());
    assert_eq!(value["metadata"]["hashes"]["source"],"781eed0d3590ca022b843f7e46cc4d86a0b76ac7466b87799b3f31f7569a04aa");
}
fn compare_fields(source:&serde_json::Map<String,serde_json::Value>,native:&[dima_rust::schemas::Field],path:&str) {
    use dima_rust::schemas::{FieldDefault as D,FieldType as T};
    assert_eq!(source.len(),native.len(),"field count {path}");
    for field in native {let at=format!("{path}.{}",field.name);let s=source.get(field.name).unwrap_or_else(||panic!("missing {at}"));assert_eq!(s["required"].as_bool(),Some(field.required),"required {at}");
        let expected=match &field.kind {T::String=>"String",T::Number=>"Number",T::Boolean=>"Boolean",T::Date=>"Date",T::Array(_)|T::ArrayElement(_)=>"Array",T::Subdocument{..}=>"Embedded",other=>panic!("unsupported field {at}: {other:?}")};assert_eq!(s["type"].as_str(),Some(expected),"type {at}");
        let enums:Vec<_>=s["enum"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();assert_eq!(enums,field.enum_values,"enum {at}");
        match &field.default {D::String(v)=>assert_eq!(s["default"],*v,"default {at}"),D::Number(v)=>assert_eq!(s["default"].as_f64(),Some(*v),"default {at}"),D::Boolean(v)=>assert_eq!(s["default"].as_bool(),Some(*v),"default {at}"),D::Null=>assert!(s["default"].is_null(),"default {at}"),D::Now|D::Array|D::Object=>assert_eq!(s["default"],"function","default {at}"),D::Missing if field.name=="profileID"=>assert_eq!(s["default"],"function","generated {at}"),D::Missing=>assert!(s["default"].is_null(),"default {at}"),other=>panic!("unsupported default {at}: {other:?}")}
        let sub=match &field.kind {T::Subdocument{fields,generate_id}=>Some((fields,*generate_id)),T::Array(inner)=>match inner.as_ref(){T::Subdocument{fields,generate_id}=>Some((fields,*generate_id)),_=>None},_=>None};if let Some((children,id))=sub {assert_eq!(s["subdocumentId"].as_bool(),Some(id),"_id {at}");compare_fields(s["children"].as_object().unwrap(),children,&at);}
        match &field.default {D::Now=>assert_eq!(s["defaultResult"],"dateNow","clock {at}"),D::Array=>assert_eq!(s["defaultResult"],serde_json::json!([]),"array default {at}"),D::Missing if field.name=="profileID"=>assert_eq!(s["defaultResult"],"objectIdHex","generated {at}"),D::Object=>{let defaults=s["defaultResult"].as_object().expect("object default");let (children,_)=sub.expect("object child schema");for (key,value) in defaults {let child=children.iter().find(|f|f.name==key).unwrap_or_else(||panic!("unknown default {at}.{key}"));match &child.default {D::String(x)=>assert_eq!(value,*x),D::Number(x)=>assert_eq!(value.as_f64(),Some(*x)),D::Boolean(x)=>assert_eq!(value.as_bool(),Some(*x)),D::Array=>assert_eq!(value,&serde_json::json!([])),D::Null=>assert!(value.is_null()),other=>panic!("unsupported object default {at}.{key}: {other:?}")}}},_=>{}}
        let validators=s["validators"].as_array().unwrap();assert_eq!(validators.iter().any(|v|v=="required"),field.required,"required validator {at}");assert_eq!(validators.iter().any(|v|v=="enum"),!field.enum_values.is_empty(),"enum validator {at}");assert_eq!(validators.len(),usize::from(field.required)+usize::from(!field.enum_values.is_empty()),"unexpected validator {at}");
        if let T::ArrayElement(element)=&field.kind {let e=&s["element"];assert_eq!(e["type"],"String");assert_eq!(e["required"].as_bool(),Some(element.required));let validators=e["validators"].as_array().unwrap();assert_eq!(validators.iter().any(|v|v=="required"),element.required);assert_eq!(validators.len(),usize::from(element.required)+usize::from(!element.enum_values.is_empty()));let enums:Vec<_>=e["enum"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();assert_eq!(enums,element.enum_values);if let D::String(default)=&element.default {assert_eq!(e["default"],*default);}}
        if matches!(&field.kind,T::Array(inner) if matches!(inner.as_ref(),T::String)) {let e=&s["element"];assert_eq!(e["type"],"String");assert_eq!(e["required"].as_bool(),Some(false));assert!(e["default"].is_null());assert!(e["validators"].as_array().unwrap().is_empty());assert!(e["enum"].as_array().unwrap().is_empty());}
    }
}
#[test]
#[ignore = "explicit pinned source oracle required"]
fn personality_save_source_oracle() {
    let value=golden("DIMA_AI_PERSONALITY_MONGO_REFERENCE_DIR","channel_ai_personality_mongo_reference.json","channel_ai_personality_mongo_reference.cjs");
    let cases=value["cases"].as_array().expect("oracle cases missing");assert!(!cases.is_empty(),"oracle cases empty");
    for case in cases {let count=case["count"].as_u64().unwrap();let profiles:Vec<Bson>=(0..count).map(|n|Bson::Document(doc!{"profileID":n.to_string(),"personality":"x","personaMode":"original"})).collect();let rules=vec![Bson::String("x".into());case["rules"].as_u64().unwrap() as usize];let known=vec![Bson::Document(doc!{});case["knownUsers"].as_u64().unwrap() as usize];let mut d=doc!{"profiles":profiles,"rules":rules,"knownUsers":known};let result=p::apply_save_rules(&mut d,case["plan"].as_str().unwrap(),JsDate::from_millis(1000.0));match case["error"].as_str() {Some(error)=>assert_eq!(result.unwrap_err().to_string(),error),None=>{result.unwrap();assert_eq!(d.get_i32("contextWindow").unwrap() as i64,case["contextWindow"].as_i64().unwrap());}}}
}
fn golden(env:&str,file:&str,script:&str)->serde_json::Value {let hint=format!("Set {env} to the output directory containing {file}; generate it inside the capped pinned Node 24.22.1 image via validate.py with: node dimabot/tests/fixtures/{script} --write DIR");let dir=std::env::var_os(env).unwrap_or_else(||panic!("{hint}"));let path=std::path::Path::new(&dir).join(file);let raw=std::fs::read_to_string(&path).unwrap_or_else(|e|panic!("{}: {e}. {hint}",path.display()));assert!(!raw.trim().is_empty(),"{} is empty. {hint}",path.display());let value:serde_json::Value=serde_json::from_str(&raw).unwrap_or_else(|e|panic!("{} invalid JSON: {e}. {hint}",path.display()));assert!(value.as_object().is_some_and(|v|!v.is_empty()),"{} empty or invalid oracle. {hint}",path.display());value}
#[tokio::test]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn cleanup_after_assertion_failure() {
    assert_eq!(std::env::var("MONGO_TEST_EXPECT").as_deref(),Ok("success"));let uri=std::env::var("MONGO_URI").expect("explicit isolated MongoDB URI required");assert!(!uri.trim().is_empty());let client=Client::with_uri_str(uri).await.unwrap();let db=client.database(&format!("dima_personality_cleanup_{}",ObjectId::new().to_hex()));
    let result=with_cleanup(&db,async {db.collection::<mongodb::bson::Document>("marker").insert_one(doc!{"owned":true}).await.unwrap();assert!(false,"intentional fixture failure");}).await;
    assert!(result.is_err(),"expected intentional assertion failure");assert!(db.list_collection_names().await.unwrap().is_empty(),"fixture collections survived cleanup");
}
#[tokio::test]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn personality_repository_and_plan_rules() {
    assert_eq!(std::env::var("MONGO_TEST_EXPECT").as_deref(),Ok("success"));
    let uri=std::env::var("MONGO_URI").expect("explicit isolated MongoDB URI required");assert!(!uri.trim().is_empty());
    let client=Client::with_uri_str(uri).await.unwrap();let db=client.database(&format!("dima_personality_test_{}",ObjectId::new().to_hex()));
    let result=with_cleanup(&db,async {
    for (tier,cap,window) in [("free",1,7),("premium",2,15),("pro",3,35)] {
        let channel=format!("test-{tier}");users::schema().repository(&db).insert(doc!{"name":channel.clone(),"plan_tier":tier,"accounts":[{"type":"twitch","id":channel.clone()}]},DateTime::from_millis(1000)).await.unwrap();
        let saved=p::save_personality(&db,doc!{"channelID":channel.clone(),"channel":"test"},true,JsDate::from_millis(2000.0)).await.unwrap();
        let id=saved.get_object_id("_id").unwrap();let read=p::schema().repository(&db).find_one(doc!{"_id":id}).await.unwrap().unwrap();
        let profile=read.get_array("profiles").unwrap()[0].as_document().unwrap();assert_eq!(profile.get_str("profileID").unwrap().len(),24);assert!(!profile.contains_key("_id"));assert_eq!(read.get_str("activeProfileId").unwrap(),profile.get_str("profileID").unwrap());
        assert_eq!(read.get_f64("contextWindow").unwrap(),window as f64);
        let profiles:Vec<Bson>=(0..=cap).map(|n|Bson::Document(doc!{"profileID":format!("p{n}"),"personality":"hello","personaMode":"original"})).collect();
        let err=p::save_personality(&db,doc!{"channelID":channel.clone(),"channel":"test","profiles":profiles},true,JsDate::from_millis(3000.0)).await.unwrap_err();
        assert_eq!(err.to_string(),format!("Current plan allows up to {cap} personality profile{}",if cap>1 {"s"} else {""}));
        let mut existing=read.clone();let profile=existing.get_array_mut("profiles").unwrap()[0].as_document_mut().unwrap();profile.insert("createdAt",DateTime::from_millis(500));existing.insert("activeProfileId","invalid");
        let updated=p::save_personality(&db,existing,false,JsDate::from_millis(4000.0)).await.unwrap();let profile=updated.get_array("profiles").unwrap()[0].as_document().unwrap();assert_eq!(profile.get_datetime("createdAt").unwrap().timestamp_millis(),500);assert_eq!(profile.get_datetime("updatedAt").unwrap().timestamp_millis(),4000);assert_eq!(updated.get_str("activeProfileId").unwrap(),profile.get_str("profileID").unwrap());
        if tier!="pro" {let (r,u)=if tier=="free" {(3,3)} else {(5,10)};let rules=vec![Bson::String("rule".into());r+1];let err=p::save_personality(&db,doc!{"channelID":channel.clone(),"channel":"test","rules":rules},true,JsDate::from_millis(5000.0)).await.unwrap_err();assert!(err.to_string().contains("rules"));let known=vec![Bson::Document(doc!{"username":"viewer"});u+1];let err=p::save_personality(&db,doc!{"channelID":channel,"channel":"test","knownUsers":known},true,JsDate::from_millis(5000.0)).await.unwrap_err();assert!(err.to_string().contains("known users"));}
    }
    }).await;
    if let Err(error)=result {std::panic::resume_unwind(error)}
}
