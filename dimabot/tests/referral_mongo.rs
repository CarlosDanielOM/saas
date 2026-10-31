#![cfg(feature = "referral-service")]
//! Ignored integration coverage using a unique disposable MongoDB database.
use dima_rust::{schemas::{users,referral_code,credit_transaction},utils::{referral::{ReferralService,PRODUCT_ID_PREMIUM},referral_ledger::ReferralLedger}};
use mongodb::{Client,bson::{doc,DateTime,oid::ObjectId}};
use futures_util::{FutureExt,TryStreamExt};
#[test]
#[ignore = "explicit pinned source oracle required"]
fn referral_source_oracle() {
    use dima_rust::utils::{referral::{check_code_limit,get_bot_subscription_reward_amount,PlanType,SubscriptionCadence},referral_ledger::REFERRAL_LEDGER_PAGE_SIZE};
    let value=referral_golden();assert_eq!(value["ledgerPageSize"].as_u64().unwrap(),REFERRAL_LEDGER_PAGE_SIZE as u64);
    compare_schema(&value);
    let mut code=doc!{"code":"MiXeD"};referral_code::apply_save_rules(&mut code,true).unwrap();assert_eq!(code.get_str("code").unwrap(),value["lowercase"].as_str().unwrap());
    for case in value["pages"].as_array().unwrap(){let count=case["count"].as_u64().unwrap() as usize;let page=dima_rust::utils::referral_ledger::paginate(vec![0;count],0);assert_eq!(page.items.len() as u64,case["items"].as_u64().unwrap());assert_eq!(page.has_more,case["hasMore"].as_bool().unwrap());}
    assert_eq!(referral_code::validate_code("bad-code").unwrap_err().to_string(),value["errorMessage"].as_str().unwrap());
    for case in value["limits"].as_array().unwrap() {let plan=match case["plan"].as_str().unwrap(){"pro"=>PlanType::Pro,"premium"=>PlanType::Premium,_=>PlanType::Free};assert_eq!(check_code_limit(plan,case["limit"].as_u64().unwrap() as usize).unwrap_err().to_string(),case["error"].as_str().unwrap());}
    for case in value["rewards"].as_array().unwrap() {let plan=match case["plan"].as_str().unwrap(){"PRO"=>PlanType::Pro,"PREMIUM"=>PlanType::Premium,_=>PlanType::Free};let cadence=if case["cadence"]=="yearly"{SubscriptionCadence::Yearly}else{SubscriptionCadence::Monthly};assert_eq!(get_bot_subscription_reward_amount(plan,cadence),case["amount"].as_i64().unwrap());}
}
fn referral_golden()->serde_json::Value {let hint="Set DIMA_REFERRAL_REFERENCE_DIR to the directory containing referral_reference.json; generate it in the capped pinned Node 24.22.1 image through validate.py: node dimabot/tests/fixtures/referral_reference.cjs --write DIR";let dir=std::env::var_os("DIMA_REFERRAL_REFERENCE_DIR").unwrap_or_else(||panic!("{hint}"));let path=std::path::Path::new(&dir).join("referral_reference.json");let raw=std::fs::read_to_string(&path).unwrap_or_else(|e|panic!("{}: {e}. {hint}",path.display()));assert!(!raw.trim().is_empty(),"{} empty. {hint}",path.display());let value:serde_json::Value=serde_json::from_str(&raw).unwrap_or_else(|e|panic!("{} invalid JSON: {e}. {hint}",path.display()));assert!(value.as_object().is_some_and(|v|!v.is_empty()),"{} empty oracle. {hint}",path.display());value}
fn compare_schema(value:&serde_json::Value) {
    use dima_rust::schemas::{Field,FieldDefault as D,FieldType as T};
    fn walk<'a>(fields:&'a [Field],prefix:&str,out:&mut Vec<(String,&'a Field)>) {for f in fields {let name=if prefix.is_empty(){f.name.to_owned()}else{format!("{prefix}.{}",f.name)};if let T::Object(children)=&f.kind {walk(children,&name,out)}else{out.push((name,f));}}}
    let mut native=Vec::new();walk(&referral_code::schema().fields,"",&mut native);let source=value["fields"].as_object().unwrap();assert_eq!(source.len(),native.len()+2,"timestamps are added by framework");
    for (name,f) in native {let s=source.get(&name).unwrap_or_else(||panic!("missing source path {name}"));let ty=match &f.kind {T::String=>"String",T::Number=>"Number",T::Boolean=>"Boolean",T::ObjectId=>"ObjectId",_=>panic!("unsupported {name}")};assert_eq!(s["type"],ty);assert_eq!(s["required"].as_bool(),Some(f.required));let enums:Vec<_>=s["enum"].as_array().unwrap().iter().map(|x|x.as_str().unwrap()).collect();assert_eq!(enums,f.enum_values);match &f.default {D::String(v)=>assert_eq!(s["default"],*v),D::Boolean(v)=>assert_eq!(s["default"].as_bool(),Some(*v)),D::Number(v)=>assert_eq!(s["default"].as_f64(),Some(*v)),D::Missing=>assert!(s["default"].is_null()),other=>panic!("unsupported default {name}: {other:?}")};if let Some(max)=f.max_utf16 {assert_eq!(s["maxLength"].as_u64(),Some(max as u64));}let mut expected=Vec::new();if f.required {expected.push("required")}if f.max_utf16.is_some(){expected.push("maxlength")}if name=="code" {expected.push("user defined")}let mut observed:Vec<_>=s["validators"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();observed.sort();expected.sort();assert_eq!(observed,expected,"validators {name}");}
    assert_eq!(referral_code::schema().timestamps,Some(("createdAt","updatedAt")));for name in ["createdAt","updatedAt"] {assert_eq!(source[name]["type"],"Date");assert!(!source[name]["required"].as_bool().unwrap());assert!(source[name]["default"].is_null());assert!(source[name]["validators"].as_array().unwrap().is_empty());assert!(source[name]["enum"].as_array().unwrap().is_empty());}
    assert!(source["code"]["validators"].as_array().unwrap().iter().any(|v|v=="user defined"));
    let source_indexes=value["indexes"].as_array().unwrap();let native_indexes=&referral_code::schema().indexes;assert_eq!(source_indexes.len(),native_indexes.len());for native in native_indexes {let found=source_indexes.iter().any(|entry|{let Some(keys)=entry[0].as_object() else{return false};keys.len()==native.keys.len()&&keys.iter().all(|(k,v)|native.keys.get_i32(k).ok().map(i64::from)==v.as_i64())&&entry[1]["unique"].as_bool().unwrap_or(false)==native.unique});assert!(found,"missing index {:?}",native.keys);}
}
#[tokio::test]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn referral_lifecycle_and_ledgers() {
    assert_eq!(std::env::var("MONGO_TEST_EXPECT").as_deref(),Ok("success"));let uri=std::env::var("MONGO_URI").expect("explicit isolated MongoDB URI required");assert!(!uri.trim().is_empty());
    let client=Client::with_uri_str(uri).await.unwrap();let db=client.database(&format!("dima_referral_test_{}",ObjectId::new().to_hex()));
    let result=std::panic::AssertUnwindSafe(async {
    let model=referral_code::schema();for index in &model.indexes {model.repository(&db).collection.create_index(index.model()).await.unwrap();}
    let service=ReferralService::new(db.clone());let now=DateTime::from_millis(1_700_000_000_000);
    for (tier,limit) in [("free",1),("premium",5),("pro",15)] {
        let owner=ObjectId::new();users::schema().repository(&db).insert(doc!{"_id":owner,"name":tier,"plan_tier":tier},now).await.unwrap();
        for n in 0..limit {let code=format!("{tier}{n}");let saved=service.create_campaign_code(owner,&code,"").await.unwrap();assert_eq!(saved.get_str("code").unwrap(),code);}
        let error=service.create_campaign_code(owner,"over","").await.unwrap_err();assert_eq!(error.to_string(),format!("Referral code limit reached for {} plan. Maximum {limit} codes allowed.",tier.to_uppercase()));
    }
    assert_eq!(service.create_campaign_code(ObjectId::new(),"valid","").await.unwrap_err().to_string(),"User not found");
    assert!(referral_code::validate_code("not-valid").is_err());
    let owner=ObjectId::new();users::schema().repository(&db).insert(doc!{"_id":owner,"name":"owner","plan_tier":"pro"},now).await.unwrap();
    let code=service.create_campaign_code(owner,"MiXeD","").await.unwrap();assert_eq!(code.get_str("code").unwrap(),"mixed");assert!(referral_code::find_by_code(&db,"MIXED").await.unwrap().is_some());
    assert!(service.create_campaign_code(owner,"MIXED","").await.is_err());
    assert!(referral_code::save(&db,doc!{"code":"MIXED","owner":owner},true,true,now).await.is_err());
    let indexes:Vec<mongodb::IndexModel>=model.repository(&db).collection.list_indexes().await.unwrap().try_collect().await.unwrap();assert!(indexes.iter().any(|x|x.keys==doc!{"code":1} && x.options.as_ref().and_then(|o|o.unique)==Some(true)));assert!(indexes.iter().any(|x|x.keys==doc!{"owner":1,"createdAt":-1}));
    let mut people=Vec::new();for n in 0..21 {let id=ObjectId::new();people.push(id);users::schema().repository(&db).insert(doc!{"_id":id,"name":format!("person{n}"),"plan_tier":"free","created_at":DateTime::from_millis(now.timestamp_millis()+n as i64)},now).await.unwrap();assert!(service.apply_referral_code(id,"MIXED").await.unwrap());}
    let newest=people[20];let payer=ObjectId::new();users::schema().repository(&db).insert(doc!{"_id":payer,"name":"payer","polar_sh_customer_id":"fixture-payer","referrerId":owner,"referralCodeUsed":"mixed"},now).await.unwrap();
    let tx=credit_transaction::schema().repository(&db);for (id,amount) in [(newest,40),(newest,60)] {tx.insert(doc!{"user":owner,"type":"referral_bonus","amount":amount,"metadata":{"referredUserId":id,"referralCodeUsed":"mixed"}},now).await.unwrap();}
    let ledger=ReferralLedger::new(db.clone());let page=ledger.get_referral_people_page(owner,0).await.unwrap();assert_eq!(page.items.len(),20);assert!(page.has_more);assert_eq!(page.items[0].id,newest.to_hex());assert_eq!(page.items[0].credits_earned,100.0);assert!(page.items.iter().any(|x|x.credits_earned==0.0));
    let timeline=ledger.get_referral_timeline_page(owner,0).await.unwrap();assert_eq!(timeline.items.len(),20);assert!(timeline.has_more);assert!(timeline.items.iter().all(|e|e.id.starts_with(&format!("{}:",e.kind))));assert!(timeline.items.iter().all(|e|e.kind=="signup"||e.kind=="reward"));
    assert!(timeline.items.windows(2).all(|pair|pair[0].at.timestamp_millis()>=pair[1].at.timestamp_millis()));
    let later=ledger.get_referral_timeline_page(owner,1).await.unwrap();assert!(timeline.items.iter().chain(&later.items).any(|e|e.kind=="signup"));assert!(timeline.items.iter().chain(&later.items).any(|e|e.kind=="reward"));
    let all:Vec<_>=timeline.items.iter().chain(&later.items).collect();assert!(all.windows(2).any(|w|w[0].at==w[1].at));for pair in all.windows(2).filter(|w|w[0].at==w[1].at) {assert!(pair[0].id.split_once(':').unwrap().1>=pair[1].id.split_once(':').unwrap().1);}
    let next=ledger.get_referral_people_page(owner,1).await.unwrap();let all:Vec<_>=page.items.iter().chain(&next.items).collect();assert!(all.windows(2).any(|w|w[0].signed_up_at==w[1].signed_up_at));for pair in all.windows(2).filter(|w|w[0].signed_up_at==w[1].signed_up_at) {assert!(pair[0].id>=pair[1].id);}
    let reward=service.process_subscription_reward("fixture-payer",PRODUCT_ID_PREMIUM,"fixture-subscription").await.unwrap().unwrap();assert_eq!(reward.amount,100);assert!(service.process_subscription_reward("fixture-payer",PRODUCT_ID_PREMIUM,"fixture-subscription").await.unwrap().is_none());
    assert!(service.delete_campaign_code(owner,code.get_object_id("_id").unwrap()).await.unwrap());assert!(referral_code::find_by_code(&db,"mixed").await.unwrap().is_none());
    }).catch_unwind().await;
    let cleanup=db.drop().await;
    if let Err(error)=result {if let Err(e)=cleanup {eprintln!("fixture cleanup failed: {e}");}std::panic::resume_unwind(error)}
    cleanup.expect("drop task-owned fixture database");
}
#[tokio::test]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn referral_lifecycle_source_replay() {
    let golden=referral_golden();assert_eq!(std::env::var("MONGO_TEST_EXPECT").as_deref(),Ok("success"));let uri=std::env::var("MONGO_URI").expect("explicit isolated MongoDB URI required");assert!(!uri.trim().is_empty());let client=Client::with_uri_str(uri).await.unwrap();let db=client.database(&format!("dima_referral_source_{}",ObjectId::new().to_hex()));
    let result=std::panic::AssertUnwindSafe(async {
        let now=DateTime::from_millis(1_700_000_000_000);let owner=ObjectId::new();let viewer=ObjectId::new();let other=ObjectId::new();let users=users::schema().repository(&db);
        users.insert(doc!{"_id":owner,"name":"Owner","plan_tier":"pro","token_balance":42},now).await.unwrap();users.insert(doc!{"_id":viewer,"name":"Viewer"},now).await.unwrap();users.insert(doc!{"_id":other,"name":"Other"},now).await.unwrap();
        let service=ReferralService::new(db.clone());let expected=&golden["lifecycle"];let created=service.create_campaign_code(owner,"MiXeD","label").await.unwrap();assert_eq!(created.get_str("code").unwrap(),expected["createdCode"].as_str().unwrap());
        for case in expected["successByPlan"].as_array().unwrap() {let plan=case["plan"].as_str().unwrap();let id=ObjectId::new();users.insert(doc!{"_id":id,"name":plan,"plan_tier":plan},now).await.unwrap();let created=service.create_campaign_code(id,&format!("{plan}Code"),"label").await.unwrap();assert_eq!(created.get_str("code").unwrap(),case["code"].as_str().unwrap());assert_eq!(created.get_str("label").unwrap(),case["label"].as_str().unwrap());}
        assert_eq!(service.apply_referral_code(viewer,"mixed").await.unwrap(),expected["applied"].as_bool().unwrap());assert!(service.apply_referral_code(other,"mixed").await.unwrap());
        let codes=service.get_user_codes(owner).await.unwrap();let actual:Vec<_>=codes.iter().map(|d|d.get_str("code").unwrap()).collect();let expected_codes:Vec<_>=expected["listCodes"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();assert_eq!(actual,expected_codes);
        credit_transaction::schema().repository(&db).insert(doc!{"user":owner,"type":"referral_bonus","amount":100,"metadata":{"referredUserId":viewer,"referralCodeUsed":"mixed"}},now).await.unwrap();let stats=service.get_referral_stats(owner).await.unwrap();assert_eq!(stats.total_signups,expected["totalSignups"].as_f64().unwrap());assert_eq!(stats.total_conversions,expected["totalConversions"].as_f64().unwrap());assert_eq!(stats.total_earned,expected["totalEarned"].as_f64().unwrap());assert_eq!(stats.current_balance,expected["currentBalance"].as_f64().unwrap());
        let ledger=ReferralLedger::new(db.clone());let timeline=ledger.get_referral_timeline_page(owner,0).await.unwrap();for sample in golden["timelineSummary"].as_array().unwrap(){let event=timeline.items.iter().find(|e|e.kind==sample["kind"].as_str().unwrap()&&e.name==sample["name"].as_str().unwrap()).unwrap();assert!(event.id.starts_with(&format!("{}:",event.kind)));assert_eq!(event.code,sample["code"].as_str().unwrap());assert_eq!(event.credits,sample["credits"].as_f64().unwrap());}
        assert_eq!(service.delete_campaign_code(owner,created.get_object_id("_id").unwrap()).await.unwrap(),expected["deleted"].as_bool().unwrap());assert_eq!(service.get_user_codes(owner).await.unwrap().len() as u64,expected["remaining"].as_u64().unwrap());
    }).catch_unwind().await;let cleanup=db.drop().await;if let Err(error)=result {if let Err(e)=cleanup {eprintln!("fixture cleanup failed: {e}");}std::panic::resume_unwind(error)}cleanup.expect("drop task-owned source fixture database");
}
