//! Ports `referral.ts`: referral code policy, reward filters and Mongo-backed
//! lifecycle. It uses existing schema repositories and does not open a client.
use crate::schemas::{users,credit_transaction,referral_code};
use mongodb::{Database,bson::{doc,Bson,DateTime,Document,oid::ObjectId}};
use futures_util::TryStreamExt;
use std::{fmt,sync::OnceLock};
pub use crate::utils::billing::{PLAN_PRODUCT_ID_FREE as PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM as PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO as PRODUCT_ID_PRO};
#[derive(Debug,Clone,Copy,PartialEq,Eq)] pub enum PlanType {Free,Premium,Pro}
impl PlanType {pub fn as_str(self)->&'static str {match self {Self::Free=>"FREE",Self::Premium=>"PREMIUM",Self::Pro=>"PRO"}}}
#[derive(Debug,Clone,Copy,PartialEq,Eq)] pub enum SubscriptionCadence {Monthly,Yearly}
impl SubscriptionCadence {fn as_str(self)->&'static str {match self {Self::Monthly=>"monthly",Self::Yearly=>"yearly"}}}
pub const REFERRAL_CODE_LIMITS:[usize;3]=[1,5,15];
pub const REFERRAL_REWARDS:[i64;3]=[0,100,250];
pub const BOT_SUBSCRIPTION_REWARDS:[[i64;2];2]=[[50,500],[100,1000]];
fn index(plan:PlanType)->usize {match plan {PlanType::Free=>0,PlanType::Premium=>1,PlanType::Pro=>2}}
pub fn get_user_plan_type(user:&Document)->PlanType {match user.get_str("plan_tier").unwrap_or("") {"pro"=>PlanType::Pro,"premium"=>PlanType::Premium,_=>PlanType::Free}}
pub fn get_plan_type_from_product_id(id:&str)->PlanType {match id {PRODUCT_ID_PRO=>PlanType::Pro,PRODUCT_ID_PREMIUM=>PlanType::Premium,_=>PlanType::Free}}
pub fn get_bot_subscription_reward_amount(plan:PlanType,cadence:SubscriptionCadence)->i64 {match plan {PlanType::Free=>0,_=>BOT_SUBSCRIPTION_REWARDS[index(plan)-1][match cadence {SubscriptionCadence::Monthly=>0,SubscriptionCadence::Yearly=>1}]}}
pub static COMPLETED_REFERRAL_REWARD_FILTER:OnceLock<Vec<Bson>>=OnceLock::new();
pub fn completed_referral_reward_filter()->Vec<Bson> {COMPLETED_REFERRAL_REWARD_FILTER.get_or_init(||vec![Bson::Document(doc!{"type":credit_transaction::REFERRAL_BONUS}),Bson::Document(doc!{"type":credit_transaction::SUBSCRIPTION_REWARD,"metadata.rewardTargetType":"referrer","$or":[{"appliedAt":{"$type":"date"}},{"idempotencyKey":{"$exists":false}}]})]).clone()}
#[derive(Debug)] pub enum ReferralError {UserNotFound,CodeLimit(PlanType,usize),InvalidFormat,CodeTaken,Schema(crate::schemas::PersistenceError),Mongo(mongodb::error::Error),InvalidData(&'static str),TaskFailed(String)}
impl fmt::Display for ReferralError {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {match self {Self::UserNotFound=>f.write_str("User not found"),Self::CodeLimit(p,n)=>write!(f,"Referral code limit reached for {} plan. Maximum {n} codes allowed.",p.as_str()),Self::InvalidFormat=>f.write_str("Invalid code format. Must be 1-16 alphanumeric characters or underscores."),Self::CodeTaken=>f.write_str("This referral code is already taken."),Self::Schema(e)=>e.fmt(f),Self::Mongo(e)=>e.fmt(f),Self::InvalidData(s)=>f.write_str(s),Self::TaskFailed(s)=>write!(f,"Reward task failed: {s}")}}}
impl std::error::Error for ReferralError {}
impl From<mongodb::error::Error> for ReferralError {fn from(e:mongodb::error::Error)->Self {Self::Mongo(e)}}
impl From<crate::schemas::PersistenceError> for ReferralError {fn from(e:crate::schemas::PersistenceError)->Self {Self::Schema(e)}}
pub fn check_code_limit(plan:PlanType,count:usize)->Result<(),ReferralError> {let limit=REFERRAL_CODE_LIMITS[index(plan)];if count>=limit {Err(ReferralError::CodeLimit(plan,limit))}else{Ok(())}}
#[derive(Clone)] pub struct ReferralService {database:Database}
impl ReferralService {
    pub fn new(database:Database)->Self {Self{database}}
    pub async fn create_campaign_code(&self,user_id:ObjectId,code:&str,label:&str)->Result<Document,ReferralError> {
        let user=users::schema().repository(&self.database).find_one(doc!{"_id":user_id}).await?.ok_or(ReferralError::UserNotFound)?;
        let repo=referral_code::schema().repository(&self.database); let count=repo.collection.count_documents(doc!{"owner":user_id,"active":true}).await?;
        check_code_limit(get_user_plan_type(&user),count as usize)?;
        if !referral_code::valid_code(code) {return Err(ReferralError::InvalidFormat)}
        let code=code.to_lowercase(); if repo.find_one(doc!{"code":code.as_str()}).await?.is_some() {return Err(ReferralError::CodeTaken)}
        let label=crate::utils::js_string::JsString::from(label).slice(0,50).to_utf8_lossy();
        Ok(repo.insert(doc!{"code":code,"owner":user_id,"label":label,"stats":{"conversions":0}},DateTime::now()).await?)
    }
    pub async fn get_user_codes(&self,user_id:ObjectId)->Result<Vec<Document>,ReferralError> {Ok(referral_code::schema().repository(&self.database).collection.find(doc!{"owner":user_id,"active":true}).sort(doc!{"createdAt":-1}).await?.try_collect().await?)}
    pub async fn delete_campaign_code(&self,user_id:ObjectId,code_id:ObjectId)->Result<bool,ReferralError> {Ok(referral_code::schema().repository(&self.database).collection.update_one(doc!{"_id":code_id,"owner":user_id},doc!{"$set":{"active":false,"updatedAt":DateTime::now()}}).await?.modified_count>0)}
    pub async fn apply_referral_code(&self,user_id:ObjectId,code:&str)->Result<bool,ReferralError> {
        let Some(r)=referral_code::find_by_code(&self.database,code).await? else {return Ok(false)};
        let owner=r.get_object_id("owner").map_err(|_|ReferralError::InvalidData("Referral code owner is missing"))?;
        if owner==user_id {return Ok(false)} let code=r.get_str("code").map_err(|_|ReferralError::InvalidData("Referral code is missing"))?;
        Ok(users::schema().repository(&self.database).collection.update_one(doc!{"_id":user_id,"referrerId":Bson::Null},doc!{"$set":{"referrerId":owner,"referralCodeUsed":code,"updated_at":DateTime::now()}}).await?.modified_count>0)
    }
    pub async fn process_subscription_reward(&self,payer_polar_id:&str,plan_id:&str,subscription_id:&str)->Result<Option<ProcessRewardResult>,ReferralError> {
        let users=users::schema().repository(&self.database); let transactions=credit_transaction::schema().repository(&self.database); let codes=referral_code::schema().repository(&self.database);
        let Some(payer)=users.find_one(doc!{"polar_sh_customer_id":payer_polar_id}).await? else {return Ok(None)};
        let (Ok(referrer),Ok(code))=(payer.get_object_id("referrerId"),payer.get_str("referralCodeUsed")) else {return Ok(None)};
        if code.is_empty() || transactions.find_one(doc!{"metadata.subscriptionId":subscription_id}).await?.is_some() {return Ok(None)}
        let plan=get_plan_type_from_product_id(plan_id);let amount=REFERRAL_REWARDS[index(plan)]; if amount<=0{return Ok(None)}
        let payer_id=payer.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Payer id missing"))?;
        let txn=doc!{"user":referrer,"type":credit_transaction::REFERRAL_BONUS,"amount":amount,"metadata":{"referralCodeUsed":code,"referredUserId":payer_id,"subscriptionId":subscription_id,"planId":plan_id,"description":format!("Referral bonus for {} subscription",plan.as_str())}};
        let transaction_repo=transactions.clone();let user_repo=users.clone();let code_repo=codes.clone();let owned_code=code.to_owned();
        let tasks=vec![
            tokio::spawn(async move {Ok(RewardWrite::Transaction(transaction_repo.insert(txn,DateTime::now()).await?))}),
            tokio::spawn(async move {Ok(RewardWrite::User(user_repo.collection.find_one_and_update(doc!{"_id":referrer},doc!{"$inc":{"token_balance":amount},"$set":{"updated_at":DateTime::now()}}).return_document(mongodb::options::ReturnDocument::After).await?))}),
            tokio::spawn(async move {code_repo.collection.update_one(doc!{"code":owned_code},doc!{"$inc":{"stats.conversions":1},"$set":{"updatedAt":DateTime::now()}}).await?;Ok(RewardWrite::Code)}),
        ];
        let (txn,updated)=await_reward_writes(tasks).await?;
        let transaction_id=txn.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Transaction id missing"))?;
        if let Some(user)=updated {if let Some(balance)=user.get("token_balance") {transactions.collection.update_one(doc!{"_id":transaction_id},doc!{"$set":{"balanceAfter":balance.clone(),"updatedAt":DateTime::now()}}).await?;}}
        Ok(Some(ProcessRewardResult{transaction_id,referrer_id:referrer,amount,code_used:code.into()}))
    }
    pub async fn process_bot_subscription_reward(&self,options:BotRewardOptions<'_>)->Result<Option<ProcessBotRewardResult>,ReferralError> {
        let users=users::schema().repository(&self.database); let transactions=credit_transaction::schema().repository(&self.database); let codes=referral_code::schema().repository(&self.database);
        let Some(payer)=users.find_one(doc!{"polar_sh_customer_id":options.payer_polar_id}).await? else {return Ok(None)};
        if transactions.find_one(doc!{"metadata.externalReference":options.external_reference}).await?.is_some() {return Ok(None)}
        let plan=get_plan_type_from_product_id(options.plan_id); let amount=get_bot_subscription_reward_amount(plan,options.cadence); if amount<=0 {return Ok(None)}
        let Some(bot)=users.find_one(doc!{"accounts":{"$elemMatch":{"type":"twitch","name":options.bot_login.unwrap_or("domdimabot")}}}).await? else{return Ok(None)};
        let mut target=bot.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Bot id missing"))?;let mut target_type="bot";
        if let (Ok(referrer),Ok(code))=(payer.get_object_id("referrerId"),payer.get_str("referralCodeUsed")) {if !code.is_empty() && codes.find_one(doc!{"code":code.to_lowercase(),"owner":referrer,"active":true}).await?.is_some() && users.find_one(doc!{"_id":referrer}).await?.is_some() {target=referrer;target_type="referrer";}}
        let payer_id=payer.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Payer id missing"))?;
        let code=payer.get("referralCodeUsed").cloned().unwrap_or(Bson::Null);
        let txn=doc!{"user":target,"type":credit_transaction::SUBSCRIPTION_REWARD,"amount":amount,"metadata":{"referralCodeUsed":code,"referredUserId":payer_id,"subscriptionId":options.subscription_id,"planId":options.plan_id,"description":format!("Subscription reward for {} ({})",plan.as_str(),options.cadence.as_str()),"externalReference":options.external_reference,"rewardTargetType":target_type}};
        let transaction_repo=transactions.clone();let user_repo=users.clone();
        let tasks=vec![
            tokio::spawn(async move {Ok(RewardWrite::Transaction(transaction_repo.insert(txn,DateTime::now()).await?))}),
            tokio::spawn(async move {Ok(RewardWrite::User(user_repo.collection.find_one_and_update(doc!{"_id":target},doc!{"$inc":{"token_balance":amount},"$set":{"updated_at":DateTime::now()}}).return_document(mongodb::options::ReturnDocument::After).await?))}),
        ];
        let (txn,updated)=await_reward_writes(tasks).await?;
        let Some(updated)=updated else {return Ok(None)}; let id=txn.get_object_id("_id").map_err(|_|ReferralError::InvalidData("Transaction id missing"))?;
        if let Some(balance)=updated.get("token_balance") {transactions.collection.update_one(doc!{"_id":id},doc!{"$set":{"balanceAfter":balance.clone(),"updatedAt":DateTime::now()}}).await?;}
        Ok(Some(ProcessBotRewardResult {transaction_id:id,bot_user_id:target,amount,external_reference:options.external_reference.into()}))
    }
    pub async fn get_referral_stats(&self,user_id:ObjectId)->Result<ReferralStats,ReferralError> {
        let users=users::schema().repository(&self.database);let tx=credit_transaction::schema().repository(&self.database);
        let user=users.find_one(doc!{"_id":user_id}).await?.ok_or(ReferralError::UserNotFound)?;let plan=get_user_plan_type(&user);let limit=REFERRAL_CODE_LIMITS[index(plan)];let mut codes=self.get_user_codes(user_id).await?;
        let names:Vec<String>=codes.iter().filter_map(|d|d.get_str("code").ok().map(str::to_owned)).collect();
        let signups:Vec<Document>=users.collection.aggregate(vec![doc!{"$match":{"referrerId":user_id,"referralCodeUsed":{"$in":names.clone()}}},doc!{"$group":{"_id":"$referralCodeUsed","total":{"$sum":1}}}]).await?.try_collect().await?;
        let conversions:Vec<Document>=tx.collection.aggregate(vec![doc!{"$match":{"user":user_id,"metadata.referralCodeUsed":{"$in":names.clone()},"metadata.referredUserId":{"$type":"objectId"},"$or":completed_referral_reward_filter()}},doc!{"$group":{"_id":{"code":"$metadata.referralCodeUsed","referredUserId":"$metadata.referredUserId"}}},doc!{"$group":{"_id":"$_id.code","total":{"$sum":1}}}]).await?.try_collect().await?;
        let totals:Vec<Document>=tx.collection.aggregate(vec![doc!{"$match":{"user":user_id,"$or":completed_referral_reward_filter()}},doc!{"$group":{"_id":Bson::Null,"total":{"$sum":"$amount"}}}]).await?.try_collect().await?;
        let mut total_signups=0.0;let mut total_conversions=0.0;
        for code in &mut codes {let name=code.get_str("code").unwrap_or("").to_owned();let a=group_total(&signups,&name);let b=group_total(&conversions,&name);total_signups+=a;total_conversions+=b;let mut stats=code.get_document("stats").cloned().unwrap_or_default();stats.insert("signups",a);stats.insert("conversions",b);code.insert("stats",stats);}
        let used=codes.len();Ok(ReferralStats {plan_type:plan,code_limit:limit,codes_used:used,codes_remaining:limit as i64-used as i64,codes,total_signups,total_conversions,total_earned:totals.first().map_or(0.0,|d|number(d.get("total"))),current_balance:number(user.get("token_balance"))})
    }
}
enum RewardWrite {Transaction(Document),User(Option<Document>),Code}
async fn await_reward_writes(tasks:Vec<tokio::task::JoinHandle<Result<RewardWrite,ReferralError>>>)->Result<(Document,Option<Document>),ReferralError> {
    // Dropping a Tokio JoinHandle detaches its task: unlike dropping ordinary
    // futures, this keeps sibling database operations running after rejection.
    let writes=futures_util::future::try_join_all(tasks.into_iter().map(|task|async move {task.await.map_err(|e|ReferralError::TaskFailed(e.to_string()))?})).await?;
    let mut transaction=None;let mut user=None;
    for write in writes {match write {RewardWrite::Transaction(value)=>transaction=Some(value),RewardWrite::User(value)=>user=Some(value),RewardWrite::Code=>{}}}
    Ok((transaction.ok_or(ReferralError::InvalidData("Reward transaction result missing"))?,user.ok_or(ReferralError::InvalidData("Reward user result missing"))?))
}
pub fn number(value:Option<&Bson>)->f64 {match value {Some(Bson::Int32(x))=>f64::from(*x),Some(Bson::Int64(x))=>*x as f64,Some(Bson::Double(x))=>*x,_=>0.0}}
fn group_total(rows:&[Document],key:&str)->f64 {rows.iter().find(|r|r.get_str("_id").ok()==Some(key)).map_or(0.0,|r|number(r.get("total")))}
#[derive(Debug)] pub struct ProcessRewardResult {pub transaction_id:ObjectId,pub referrer_id:ObjectId,pub amount:i64,pub code_used:String}
#[derive(Debug)] pub struct ProcessBotRewardResult {pub transaction_id:ObjectId,pub bot_user_id:ObjectId,pub amount:i64,pub external_reference:String}
pub struct BotRewardOptions<'a> {pub payer_polar_id:&'a str,pub plan_id:&'a str,pub subscription_id:&'a str,pub cadence:SubscriptionCadence,pub external_reference:&'a str,pub bot_login:Option<&'a str>}
#[derive(Debug)] pub struct ReferralStats {pub plan_type:PlanType,pub code_limit:usize,pub codes_used:usize,pub codes_remaining:i64,pub codes:Vec<Document>,pub total_signups:f64,pub total_conversions:f64,pub total_earned:f64,pub current_balance:f64}
