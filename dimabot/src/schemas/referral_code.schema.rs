//! Ports `referral_code.schema.ts`: fields, indexes, code validation and the
//! explicit save-time lowercase rule. It does not install indexes or connect.
use super::{Field,FieldDefault as D,FieldType as T,SchemaDefinition,SchemaIndex};
use mongodb::{Database,bson::{doc,Document}};
use std::{fmt,sync::OnceLock};
pub fn schema()->&'static SchemaDefinition {
    static DEF:OnceLock<SchemaDefinition>=OnceLock::new();
    DEF.get_or_init(||SchemaDefinition {model:"ReferralCode",collection:"referralcodes",string_id:false,version_key:true,write_concern_journaled:false,timestamps:Some(("createdAt","updatedAt")),save_clock_field:None,indexes:vec![SchemaIndex::new(doc!{"code":1}).unique(),SchemaIndex::new(doc!{"owner":1}),SchemaIndex::new(doc!{"owner":1,"createdAt":-1})],fields:vec![Field::new("code",T::String).required(),Field::new("owner",T::ObjectId).required(),Field::new("label",T::String).default(D::String("")).max_utf16(50),Field::new("stats",T::Object(vec![Field::new("conversions",T::Number).default(D::Number(0.0))])),Field::new("active",T::Boolean).default(D::Boolean(true))]})
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct InvalidReferralCode(pub String);
impl fmt::Display for InvalidReferralCode {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {write!(f,"{} is not a valid referral code. Must be 1-16 alphanumeric characters or underscores.",self.0)}}
impl std::error::Error for InvalidReferralCode {}
pub fn valid_code(code:&str)->bool {!code.is_empty() && code.len()<=16 && code.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_')}
pub fn validate_code(code:&str)->Result<(),InvalidReferralCode> {if valid_code(code) {Ok(())} else {Err(InvalidReferralCode(code.into()))}}
/// Validate first, matching Mongoose pre-validation before pre-save lowercase.
pub fn apply_save_rules(doc:&mut Document,code_modified:bool)->Result<(),InvalidReferralCode> {
    if let Ok(code)=doc.get_str("code") {validate_code(code)?;if code_modified {let lower=code.to_lowercase();doc.insert("code",lower);}} Ok(())
}
pub fn find_by_code_filter(code:&str)->Document {doc!{"code":code.to_lowercase(),"active":true}}
pub async fn find_by_code(database:&Database,code:&str)->mongodb::error::Result<Option<Document>> {schema().repository(database).find_one(find_by_code_filter(code)).await}
#[derive(Debug)]
pub enum ReferralCodeSaveError {InvalidCode(InvalidReferralCode),Persistence(super::PersistenceError)}
impl fmt::Display for ReferralCodeSaveError {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {match self {Self::InvalidCode(e)=>e.fmt(f),Self::Persistence(e)=>e.fmt(f)}}}
impl std::error::Error for ReferralCodeSaveError {}
/// Persist with the explicit custom validator and the save-time lowercase hook.
pub async fn save(database:&Database,mut doc:Document,is_new:bool,code_modified:bool,now:mongodb::bson::DateTime)->Result<Document,ReferralCodeSaveError> {
    apply_save_rules(&mut doc,code_modified).map_err(ReferralCodeSaveError::InvalidCode)?;
    let repo=schema().repository(database);
    (if is_new {repo.insert(doc,now).await} else {repo.save(doc,now).await}).map_err(ReferralCodeSaveError::Persistence)
}
