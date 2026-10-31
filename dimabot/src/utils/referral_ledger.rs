//! Ports `referral_ledger.ts`: paginated MongoDB referral people and timeline
//! reads with the shared completed-reward filter. It opens no connection and
//! does not mutate data.
use crate::{schemas::{users,credit_transaction},utils::referral::{completed_referral_reward_filter,number,ReferralError}};
use mongodb::{Database,bson::{doc,DateTime,Document,oid::ObjectId}};
use futures_util::TryStreamExt;
use std::collections::HashMap;
pub const REFERRAL_LEDGER_PAGE_SIZE:usize=20;
#[derive(Debug)] pub struct ReferralLedgerPage<T> {pub items:Vec<T>,pub page:u64,pub has_more:bool}
#[derive(Debug)] pub struct ReferralPerson {pub id:String,pub name:String,pub code:String,pub signed_up_at:DateTime,pub tier:String,pub credits_earned:f64}
#[derive(Debug)] pub struct ReferralTimelineEvent {pub id:String,pub kind:String,pub user_id:String,pub name:String,pub code:String,pub at:DateTime,pub credits:f64}
pub fn paginate<T>(mut rows:Vec<T>,page:u64)->ReferralLedgerPage<T> {let has_more=rows.len()>REFERRAL_LEDGER_PAGE_SIZE;rows.truncate(REFERRAL_LEDGER_PAGE_SIZE);ReferralLedgerPage{items:rows,page,has_more}}
pub fn sort_order()->Document {doc!{"created_at":-1,"_id":-1}}
pub fn timeline_sort_order()->Document {doc!{"at":-1,"_id":-1}}
pub fn timeline_id(kind:&str,id:ObjectId)->String {format!("{kind}:{id}")}
pub fn name_or_empty(name:Option<&str>)->String {name.unwrap_or("").to_owned()}
pub fn earned_pipeline(owner:ObjectId,ids:&[ObjectId])->Vec<Document> {vec![doc!{"$match":{"user":owner,"amount":{"$gt":0},"metadata.referredUserId":{"$in":ids.to_vec()},"$or":completed_referral_reward_filter()}},doc!{"$group":{"_id":"$metadata.referredUserId","credits":{"$sum":"$amount"}}}]}
pub fn earned_for(rows:&[Document],id:ObjectId)->f64 {rows.iter().find(|row|row.get_object_id("_id").ok()==Some(id)).map_or(0.0,|r|number(r.get("credits")))}
pub fn timeline_pipeline(owner:ObjectId,page:u64)->Result<Vec<Document>,ReferralError> {
    let skip=page.checked_mul(REFERRAL_LEDGER_PAGE_SIZE as u64).and_then(|n|i64::try_from(n).ok()).ok_or(ReferralError::InvalidData("Invalid referral ledger page"))?;
    Ok(vec![doc!{"$match":{"referrerId":owner,"referralCodeUsed":{"$type":"string"}}},doc!{"$project":{"userId":"$_id","code":"$referralCodeUsed","at":{"$ifNull":["$created_at",{"$toDate":"$_id"}]},"kind":{"$literal":"signup"},"credits":{"$literal":0}}},doc!{"$unionWith":{"coll":credit_transaction::schema().collection,"pipeline":[{"$match":{"user":owner,"amount":{"$gt":0},"metadata.referredUserId":{"$type":"objectId"},"$or":completed_referral_reward_filter()}},{"$project":{"userId":"$metadata.referredUserId","code":"$metadata.referralCodeUsed","at":{"$ifNull":["$appliedAt","$createdAt"]},"kind":{"$literal":"reward"},"credits":"$amount"}}]}},doc!{"$sort":timeline_sort_order()},doc!{"$skip":skip},doc!{"$limit":(REFERRAL_LEDGER_PAGE_SIZE+1) as i64}])
}
#[derive(Clone)] pub struct ReferralLedger {database:Database}
impl ReferralLedger {
    pub fn new(database:Database)->Self {Self{database}}
    pub async fn get_referral_people_page(&self,owner:ObjectId,page:u64)->Result<ReferralLedgerPage<ReferralPerson>,ReferralError> {
        let skip=page.checked_mul(REFERRAL_LEDGER_PAGE_SIZE as u64).ok_or(ReferralError::InvalidData("Invalid referral ledger page"))?;
        let users=users::schema().repository(&self.database);let tx=credit_transaction::schema().repository(&self.database);
        let rows:Vec<Document>=users.collection.find(doc!{"referrerId":owner,"referralCodeUsed":{"$type":"string"}}).projection(doc!{"_id":1,"name":1,"plan_tier":1,"created_at":1,"referralCodeUsed":1}).sort(sort_order()).skip(skip).limit((REFERRAL_LEDGER_PAGE_SIZE+1) as i64).await?.try_collect().await?;
        let page_rows=paginate(rows,page);let mut ids=Vec::new();for row in &page_rows.items {ids.push(row.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Referral user id missing"))?);}
        let totals:Vec<Document>=if ids.is_empty(){vec![]}else{tx.collection.aggregate(earned_pipeline(owner,&ids)).await?.try_collect().await?};
        let mut items=Vec::new();for row in page_rows.items {let id=row.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Referral user id missing"))?;let date=*row.get_datetime("created_at").map_err(|_|ReferralError::InvalidData("Referral signup date missing"))?;items.push(ReferralPerson{id:id.to_hex(),name:row.get_str("name").unwrap_or("").into(),code:row.get_str("referralCodeUsed").unwrap_or("").into(),signed_up_at:date,tier:row.get_str("plan_tier").unwrap_or("free").into(),credits_earned:earned_for(&totals,id)});}
        Ok(ReferralLedgerPage{items,page,has_more:page_rows.has_more})
    }
    pub async fn get_referral_timeline_page(&self,owner:ObjectId,page:u64)->Result<ReferralLedgerPage<ReferralTimelineEvent>,ReferralError> {
        let users=users::schema().repository(&self.database);let rows:Vec<Document>=users.collection.aggregate(timeline_pipeline(owner,page)?).await?.try_collect().await?;let page_rows=paginate(rows,page);
        let mut ids=Vec::new();for row in &page_rows.items {ids.push(row.get_object_id("userId").map_err(|_|ReferralError::InvalidData("Referral event user id missing"))?);}
        let names:Vec<Document>=users.collection.find(doc!{"_id":{"$in":ids}}).projection(doc!{"_id":1,"name":1}).await?.try_collect().await?;
        let mut lookup=HashMap::new();for row in names {if let Ok(id)=row.get_object_id("_id") {lookup.insert(id,name_or_empty(row.get_str("name").ok()));}}
        let mut items=Vec::new();for row in page_rows.items {let id=row.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Referral event id missing"))?;let user_id=row.get_object_id("userId").map_err(|_|ReferralError::InvalidData("Referral event user id missing"))?;let kind=row.get_str("kind").map_err(|_|ReferralError::InvalidData("Referral event kind missing"))?;let at=*row.get_datetime("at").map_err(|_|ReferralError::InvalidData("Referral event date missing"))?;items.push(ReferralTimelineEvent{id:timeline_id(kind,id),kind:kind.into(),user_id:user_id.to_hex(),name:lookup.get(&user_id).cloned().unwrap_or_default(),code:row.get_str("code").unwrap_or("").into(),at,credits:number(row.get("credits"))});}
        Ok(ReferralLedgerPage{items,page,has_more:page_rows.has_more})
    }
}
