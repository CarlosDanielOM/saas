#![cfg(feature = "referral-service")]
use dima_rust::utils::referral_ledger::*;
use mongodb::bson::{doc,oid::ObjectId};
#[test]
fn pagination_and_sort() {
    let page=paginate((0..20).collect::<Vec<_>>(),0);assert_eq!(page.items.len(),20);assert!(!page.has_more);
    let page=paginate((0..21).collect::<Vec<_>>(),1);assert_eq!(page.items.len(),20);assert!(page.has_more);
    assert_eq!(sort_order(),doc!{"created_at":-1,"_id":-1});assert_eq!(timeline_sort_order(),doc!{"at":-1,"_id":-1});
}
#[test]
fn aggregation_and_timeline_contract() {
    let owner=ObjectId::new();let user=ObjectId::new();let pipeline=earned_pipeline(owner,&[user]);
    assert_eq!(pipeline[1],doc!{"$group":{"_id":"$metadata.referredUserId","credits":{"$sum":"$amount"}}});
    assert_eq!(earned_for(&[doc!{"_id":user,"credits":150}],user),150.0);assert_eq!(earned_for(&[],user),0.0);
    assert_eq!(timeline_id("signup",user),format!("signup:{user}"));assert_eq!(timeline_id("reward",user),format!("reward:{user}"));
    assert_eq!(name_or_empty(None),"");assert_eq!(name_or_empty(Some("Ada")),"Ada");
    let timeline=timeline_pipeline(owner,1).unwrap();assert_eq!(timeline[4],doc!{"$skip":20_i64});assert_eq!(timeline[5],doc!{"$limit":21_i64});
    assert_eq!(timeline[1].get_document("$project").unwrap().get_document("kind").unwrap(),&doc!{"$literal":"signup"});
    let union=timeline[2].get_document("$unionWith").unwrap().get_array("pipeline").unwrap();
    assert_eq!(union[1].as_document().unwrap().get_document("$project").unwrap().get_document("kind").unwrap(),&doc!{"$literal":"reward"});
}
