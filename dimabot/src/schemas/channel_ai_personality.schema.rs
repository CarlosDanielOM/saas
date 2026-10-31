//! Ports `channel_ai_personality.schema.ts`: document shape, profile projection
//! and plan-dependent save rules. Callers must invoke the hooks explicitly;
//! repository writes do not automatically enforce them or resolve the user.
use super::{users, Field, FieldDefault as D, FieldType as T, SchemaDefinition, PersistenceError, ValidationErrors};
use crate::utils::credit_policy::JsDate;
use mongodb::{bson::{doc, oid::ObjectId, Bson, DateTime, Document}, Database};
use std::{fmt, sync::OnceLock};
const PERSONALITY: &str = "You are a friendly Twitch chat moderator who speaks in Spanish by default but can adapt to other languages. You have a good sense of humor and can be playful with chat users.";
const MODES: &[&str] = &["original", "inspired", "strict_roleplay"];
const TONES: &[&str] = &["family_friendly", "balanced", "dark_humor"];
fn sub(fields: Vec<Field>) -> T { T::Subdocument { fields, generate_id: false } }
fn array(kind: T) -> T { T::Array(Box::new(kind)) }
fn voice() -> Vec<Field> { vec![
    Field::new("tone", T::String).default(D::String("friendly and playful")),
    Field::new("cadence", T::String).default(D::String("short and dynamic")),
    Field::new("style", T::String).default(D::String("chat-native and expressive")),
    Field::new("catchphrases", array(T::String)).default(D::Array),
] }
fn persona_fields() -> Vec<Field> { vec![
    Field::new("personality", T::String).required().default(D::String(PERSONALITY)),
    Field::new("personaMode", T::String).enumeration(MODES).default(D::String("original")),
    Field::new("personaReference", T::String).default(D::String("")),
    Field::new("tonePreset", T::String).enumeration(TONES).default(D::String("balanced")),
    Field::new("voiceProfile", sub(voice())).default(D::Object),
] }
fn profile() -> Vec<Field> {
    let mut f = vec![Field::new("profileID", T::String).required(), Field::new("name", T::String).required().default(D::String("Default Personality"))];
    f.extend(persona_fields());
    f.extend([Field::new("createdAt", T::Date).default(D::Now), Field::new("updatedAt", T::Date).default(D::Now)]); f
}
fn learning() -> Vec<Field> {
    let mut f = Vec::new();
    for name in ["enabled", "autoConfirmEnabled", "postStreamSummaryEnabled", "weeklyMaintenanceEnabled", "monthlyMaintenanceEnabled", "autoApplyCreates", "autoApplyEdits", "autoApplyArchives", "autoApplyPermanentDeletes", "semanticChatHistoryEnabled"] { f.push(Field::new(name,T::Boolean).default(D::Boolean(true))); }
    for (name, value) in [("autoConfirmThreshold",0.82),("minMessageLength",12.0),("maxPendingMemories",250.0),("maxConfirmedMemories",2000.0),("summaryMinDurationMinutes",20.0),("summaryMinChatMessages",30.0),("createMinConfidence",0.72),("editMinConfidence",0.74),("archiveMinConfidence",0.8),("deleteMinConfidence",0.88),("maxActionsPerRun",20.0),("maxDeletesPerRun",5.0),("minMemoryAgeDaysForDelete",30.0),("minUnusedDaysForDelete",21.0),("semanticChatHistoryPrimaryMinScore",0.75),("semanticChatHistoryFallbackMinScore",0.69)] { f.push(Field::new(name,T::Number).default(D::Number(value))); }
    f.push(Field::new("semanticChatHistoryLimit",T::Number).default(D::Null)); f
}
pub fn schema() -> &'static SchemaDefinition {
    static DEF: OnceLock<SchemaDefinition> = OnceLock::new();
    DEF.get_or_init(|| {
        let mut fields = vec![Field::new("channelID",T::String).required(),Field::new("channel",T::String).required()];
        for name in ["enabled", "streamSummariesEnabled", "recommendationsEnabled"] { fields.push(Field::new(name,T::Boolean).default(D::Boolean(true))); }
        fields.push(Field::new("profiles",array(sub(profile()))).default(D::Array));
        fields.push(Field::new("activeProfileId",T::String).default(D::String("")));
        fields.extend(persona_fields());
        fields.push(Field::new("language",T::String).enumeration(&["en","es"]).default(D::Null));
        fields.push(Field::new("learningConfig",sub(learning())).default(D::Object));
        fields.push(Field::new("memoryPolicy",sub(vec![Field::new("prioritizeRecentChat",T::Boolean).default(D::Boolean(true)),Field::new("allowSensitiveMemories",T::Boolean).default(D::Boolean(false)),Field::new("allowUserPreferenceMemories",T::Boolean).default(D::Boolean(true)),Field::new("allowRunningJokes",T::Boolean).default(D::Boolean(true))])).default(D::Object));
        fields.push(Field::new("rules",T::ArrayElement(Box::new(Field::new("",T::String).required().default(D::String("Be respectful and friendly with users"))))).default(D::Array));
        fields.push(Field::new("knownUsers",array(sub(vec![Field::new("username",T::String).default(D::String("")),Field::new("description",T::String).default(D::String("")),Field::new("lastInteraction",T::Date).default(D::Now),Field::new("relationship",T::String).default(D::String(""))]))).default(D::Array));
        fields.push(Field::new("contextWindow",T::Number).required().default(D::Number(7.0)));
        fields.push(Field::new("createdAt",T::Date).default(D::Now)); fields.push(Field::new("updatedAt",T::Date).default(D::Now));
        SchemaDefinition { model:"ChannelAIPersonality", collection:"channel_aipersonalities", string_id:false, version_key:true, write_concern_journaled:false, timestamps:None, save_clock_field:None, indexes:vec![], fields }
    })
}
#[derive(Debug)]
pub struct PersonalityValidationError(pub &'static str);
impl fmt::Display for PersonalityValidationError { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { f.write_str(self.0) } }
impl std::error::Error for PersonalityValidationError {}
#[derive(Debug)]
pub enum PersonalitySaveError { Validation(PersonalityValidationError), Schema(ValidationErrors), Persistence(PersistenceError), UserNotFound, ProfileLimit(usize), NoProfiles, RulesLimit(&'static str,usize), KnownUsersLimit(&'static str,usize), InvalidDate, Mongo(mongodb::error::Error) }
impl fmt::Display for PersonalitySaveError { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { match self {
    Self::Validation(e)=>e.fmt(f), Self::Schema(e)=>e.fmt(f), Self::Persistence(e)=>e.fmt(f), Self::UserNotFound=>f.write_str("User not found for channel"), Self::ProfileLimit(n)=>write!(f,"Current plan allows up to {n} personality profile{}",if *n>1 {"s"} else {""}), Self::NoProfiles=>f.write_str("At least one personality profile is required"), Self::RulesLimit(t,n)=>write!(f,"{t} channels can only have up to {n} rules"), Self::KnownUsersLimit(t,n)=>write!(f,"{t} channels can only have up to {n} known users"), Self::InvalidDate=>f.write_str("Invalid time value"), Self::Mongo(e)=>e.fmt(f) } } }
impl std::error::Error for PersonalitySaveError {}
fn fallback_string(d:&Document, key:&str, default:&str)->String { d.get_str(key).ok().filter(|s| !s.is_empty()).unwrap_or(default).to_owned() }
fn voice_value(d:&Document)->Document { let empty=Document::new(); let v=d.get_document("voiceProfile").unwrap_or(&empty); doc! {"tone":fallback_string(v,"tone","friendly and playful"),"cadence":fallback_string(v,"cadence","short and dynamic"),"style":fallback_string(v,"style","chat-native and expressive"),"catchphrases":v.get_array("catchphrases").cloned().unwrap_or_default()} }
pub fn ensure_profiles(doc:&mut Document)->Result<(),PersonalityValidationError> {
    // Mongoose applies the profileID default to each newly constructed child.
    if let Ok(profiles)=doc.get_array_mut("profiles") { for profile in profiles { if let Some(p)=profile.as_document_mut() { if !p.contains_key("profileID") {p.insert("profileID",ObjectId::new().to_hex());} } } }
    if !matches!(doc.get("profiles"),Some(Bson::Array(a)) if !a.is_empty()) {
        let now=DateTime::now();
        let p=doc! {"profileID":ObjectId::new().to_hex(),"name":"Default Personality","personality":fallback_string(doc,"personality",PERSONALITY),"personaMode":fallback_string(doc,"personaMode","original"),"personaReference":fallback_string(doc,"personaReference",""),"tonePreset":fallback_string(doc,"tonePreset","balanced"),"voiceProfile":voice_value(doc),"createdAt":now,"updatedAt":now};
        doc.insert("profiles",vec![Bson::Document(p)]);
    }
    let profiles=doc.get_array("profiles").map_err(|_|PersonalityValidationError("Invalid profiles"))?;
    let first=profiles.first().and_then(Bson::as_document).ok_or(PersonalityValidationError("Invalid profile"))?;
    let active=doc.get_str("activeProfileId").unwrap_or("");
    let selected=profiles.iter().filter_map(Bson::as_document).find(|p| !active.is_empty() && p.get_str("profileID").ok()==Some(active)).unwrap_or(first).clone();
    let id=selected.get_str("profileID").map_err(|_|PersonalityValidationError("Invalid profileID"))?.to_owned();
    doc.insert("activeProfileId",id);
    for key in ["personality","personaMode"] { if let Some(value)=selected.get(key) { doc.insert(key,value.clone()); } else { doc.remove(key); } }
    doc.insert("personaReference",fallback_string(&selected,"personaReference",""));
    doc.insert("tonePreset",fallback_string(&selected,"tonePreset","balanced"));
    doc.insert("voiceProfile",voice_value(&selected)); Ok(())
}
pub fn apply_save_rules(doc:&mut Document, plan_tier:&str, now:JsDate)->Result<(),PersonalitySaveError> {
    ensure_profiles(doc).map_err(PersonalitySaveError::Validation)?;
    let limit=match plan_tier { "pro"=>3,"premium"=>2,_=>1 };
    let profiles=doc.get_array_mut("profiles").map_err(|_|PersonalitySaveError::NoProfiles)?;
    if profiles.len()>limit { return Err(PersonalitySaveError::ProfileLimit(limit)); }
    // Kept from the source, although ensure_profiles repairs empty arrays first.
    if profiles.is_empty() { return Err(PersonalitySaveError::NoProfiles); }
    let now=DateTime::from_millis(now.timestamp_millis().ok_or(PersonalitySaveError::InvalidDate)?);
    for profile in profiles { let p=profile.as_document_mut().ok_or(PersonalitySaveError::Validation(PersonalityValidationError("Invalid profile")))?; if !matches!(p.get("createdAt"),Some(Bson::DateTime(_))) { p.insert("createdAt",now); } p.insert("updatedAt",now); }
    let (label,rules,users,window)=match plan_tier { "pro"=>{doc.insert("contextWindow",35);return Ok(())},"premium"=>("Premium",5,10,15),_=>("Free",3,3,7) };
    if doc.get_array("rules").map_or(0,Vec::len)>rules { return Err(PersonalitySaveError::RulesLimit(label,rules)); }
    if doc.get_array("knownUsers").map_or(0,Vec::len)>users { return Err(PersonalitySaveError::KnownUsersLimit(label,users)); }
    doc.insert("contextWindow",window); Ok(())
}
pub async fn resolve_plan_tier(database:&Database, channel_id:&str)->Result<String,PersonalitySaveError> {
    let user=users::schema().repository(database).find_one(doc! {"accounts.type":"twitch","accounts.id":channel_id}).await.map_err(PersonalitySaveError::Mongo)?.ok_or(PersonalitySaveError::UserNotFound)?;
    Ok(user.get_str("plan_tier").unwrap_or("free").to_owned())
}
// Materialize Mongoose defaults and casts without executing validators before
// the pre-validation projection. Validation runs against the projected result.
fn without_validators(field:&Field)->Field {
    let mut f=field.clone(); f.required=false; f.required_when=None; f.required_unless=None; f.enum_values=&[]; f.min=None; f.max=None; f.max_utf16=None; f.integer=false;
    fn kind(t:&T)->T {match t {
        T::Object(fields)=>T::Object(fields.iter().map(without_validators).collect()),
        T::Subdocument{fields,generate_id}=>T::Subdocument{fields:fields.iter().map(without_validators).collect(),generate_id:*generate_id},
        T::Array(inner)=>T::Array(Box::new(kind(inner))),
        T::ArrayElement(inner)=>T::ArrayElement(Box::new(without_validators(inner))),
        T::Map(inner)=>T::Map(Box::new(kind(inner))),
        other=>other.clone(),
    }}
    f.kind=kind(&f.kind); f
}
/// Apply child defaults, pre-validation projection, then normal validation.
pub fn prepare_personality_validation(mut input:Document, now:DateTime)->Result<Document,PersonalitySaveError> {
    if let Ok(profiles)=input.get_array_mut("profiles") {for profile in profiles {if let Some(p)=profile.as_document_mut() {if !p.contains_key("profileID") {p.insert("profileID",ObjectId::new().to_hex());}}}}
    // ArrayElement casts and validates elements, but its caster does not
    // resolve defaults for explicit BSON Undefined; materialize that default.
    if let Ok(rules)=input.get_array_mut("rules") {for rule in rules {if matches!(rule,Bson::Undefined) {*rule=Bson::String("Be respectful and friendly with users".into());}}}
    let mut hydration=schema().clone(); hydration.fields=hydration.fields.iter().map(without_validators).collect();
    let mut document=hydration.construct(&input,now).map_err(PersonalitySaveError::Schema)?;
    ensure_profiles(&mut document).map_err(PersonalitySaveError::Validation)?;
    schema().construct(&document,now).map_err(PersonalitySaveError::Schema)
}
/// Perform the source's validation, user lookup and plan save hook before
/// persisting through the native schema repository. `is_new` selects insert;
/// updates must supply an existing `_id`. The caller supplies the save clock.
pub async fn save_personality(database:&Database, mut input:Document, is_new:bool, now:JsDate)->Result<Document,PersonalitySaveError> {
    let millis=now.timestamp_millis().ok_or(PersonalitySaveError::InvalidDate)?;
    let clock=DateTime::from_millis(millis);
    let repository=schema().repository(database);
    if !is_new {
        let id=input.get("_id").cloned().ok_or(PersonalitySaveError::Persistence(PersistenceError::MissingId))?;
        let mut current=repository.find_one(doc! {"_id":id}).await.map_err(PersonalitySaveError::Mongo)?.ok_or(PersonalitySaveError::Persistence(PersistenceError::NotFound))?;
        current.extend(input); input=current;
    }
    let mut document=prepare_personality_validation(input,clock)?;
    let channel=document.get_str("channelID").map_err(|_|PersonalitySaveError::Validation(PersonalityValidationError("Invalid channelID")))?;
    let tier=resolve_plan_tier(database,channel).await?;
    apply_save_rules(&mut document,&tier,now)?;
    if is_new {repository.insert(document,clock).await.map_err(PersonalitySaveError::Persistence)} else {repository.save(document,clock).await.map_err(PersonalitySaveError::Persistence)}
}
