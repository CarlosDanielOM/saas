//! Pet settings validation and Mongo persistence. Construction performs no I/O.
//! Runtime coordination is owned by the pets and asset-library modules.
use mongodb::{bson::{doc, oid::ObjectId, Bson, DateTime, Document}, Database};
use serde_json::{json, Value};
use crate::schemas::{pet_runtime, pet_settings};
use crate::utils::tts::KOKORO_VOICES;
use crate::tts_services::fish_tts::FISH_VOICES;

#[derive(Debug)]
pub enum Error { Settings(&'static str, u16), Pet { code: String, status: u16 }, Asset(AssetError), Mongo(mongodb::error::Error), InvalidUserId, MalformedStoredData }
impl From<mongodb::error::Error> for Error { fn from(e: mongodb::error::Error) -> Self { Self::Mongo(e) } }
fn invalid() -> Error { Error::Settings("invalid_settings", 400) }
fn object<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a serde_json::Map<String, Value>, Error> {
    let o = v.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) { return Err(invalid()); }
    Ok(o)
}
fn field<'a>(v: &'a serde_json::Map<String, Value>, key: &str) -> &'a Value { v.get(key).unwrap_or(&Value::Null) }
fn text(v: &Value, max: usize, empty: bool) -> Result<String, Error> {
    let s = v.as_str().ok_or_else(invalid)?;
    if s.encode_utf16().count() > max || (!empty && s.trim().is_empty()) || s.chars().any(|c| matches!(c as u32, 0..=8 | 11..=12 | 14..=31)) { return Err(invalid()); }
    Ok(s.trim().to_owned())
}
fn boolean(v: &Value) -> Result<bool, Error> { v.as_bool().ok_or_else(invalid) }
fn integer(v: &Value, min: u64, max: u64) -> Result<u64, Error> {
    let n = v.as_f64().ok_or_else(invalid)?;
    if !n.is_finite() || n.fract() != 0.0 || n < min as f64 || n > max as f64 { return Err(invalid()); }
    Ok(n as u64)
}
fn choice<'a>(v: &'a Value, options: &[&str]) -> Result<&'a str, Error> {
    let s = v.as_str().ok_or_else(invalid)?; if !options.contains(&s) { return Err(invalid()); } Ok(s)
}
fn nullable_id(v: &Value) -> Result<Value, Error> {
    if v.is_null() { return Ok(Value::Null); }
    let s = v.as_str().ok_or_else(invalid)?;
    if s.len() != 24 || !s.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(invalid()); }
    Ok(json!(s))
}
fn title(s: &str) -> String { let mut chars = s.chars(); match chars.next() { Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(), None => String::new() } }
pub fn pet_voices() -> Vec<Value> {
    let mut result = vec![json!({"provider":"piper","id":"en_US-ryan-medium","name":"Ryan","language":"en"}), json!({"provider":"piper","id":"es_MX-ald-medium","name":"Ald","language":"es"})];
    result.extend(KOKORO_VOICES.iter().map(|id| json!({"provider":"kokoro","id":id,"name":title(id.split('_').nth(1).unwrap_or("")),"language":if id.starts_with('e') {"es"} else if id.starts_with('a') || id.starts_with('b') {"en"} else {"other"}})));
    result.extend(FISH_VOICES.iter().map(|(name,id)| json!({"provider":"fish","id":id,"name":name.split('_').map(title).collect::<Vec<_>>().join(" "),"language":"any"})));
    result
}
pub fn default_pet_settings() -> Value { json!({"sources":{"independent":true,"readTts":false},"ttsAudio":"pet","appearance":{"kind":"png","idleAssetId":null,"talkingAssetId":null},"playback":{"target":"browser","desktopSessionId":null,"vtsSessionId":null},"enabled":false,"name":"Dima","tts":{"enabled":true,"provider":"piper","language":"es","voice":"es_MX-ald-medium"},"personality":{"source":"custom","profileId":"","prompt":"You are a friendly, playful virtual companion. Keep replies short and respectful."},"rules":[],"behavior":{"respondToChat":true,"respondToEvents":true,"cooldownSeconds":15,"maxReplyLength":280,"queueSize":5,"askLane":"independent"}}) }
/// Preserves the source's error ordering and UTF-16 length checks.
pub fn validate_pet_settings(input: &Value) -> Result<Value, Error> {
    let v = object(input, &["enabled","name","tts","personality","rules","behavior","appearance","playback","sources","ttsAudio"])?;
    let defaults = default_pet_settings();
    let sources = object(v.get("sources").filter(|x| !x.is_null()).unwrap_or(&defaults["sources"]), &["independent","readTts"])?;
    let audio = choice(v.get("ttsAudio").filter(|x| !x.is_null()).unwrap_or(&defaults["ttsAudio"]), &["pet","overlay"])?;
    let appearance = object(v.get("appearance").filter(|x| !x.is_null()).unwrap_or(&defaults["appearance"]), &["kind","idleAssetId","talkingAssetId"])?;
    let playback = object(v.get("playback").filter(|x| !x.is_null()).unwrap_or(&defaults["playback"]), &["target","desktopSessionId","vtsSessionId"])?;
    let kind = choice(field(appearance,"kind"), &["png","vts"])?;
    let target = choice(field(playback,"target"), &["browser","desktop"])?;
    let tts = object(field(v,"tts"), &["enabled","provider","language","voice"])?;
    let personality = object(field(v,"personality"), &["source","profileId","prompt"])?;
    let behavior = object(field(v,"behavior"), &["respondToChat","respondToEvents","cooldownSeconds","maxReplyLength","queueSize","askLane"])?;
    let lane = choice(behavior.get("askLane").filter(|x| !x.is_null()).unwrap_or(&defaults["behavior"]["askLane"]), &["independent","tts"])?;
    let provider = choice(field(tts,"provider"), &["piper","kokoro","fish"])?;
    let language = choice(field(tts,"language"), &["en","es"])?;
    let source = choice(field(personality,"source"), &["custom","profile"])?;
    let voice = text(field(tts,"voice"),100,false)?;
    let voice_valid = if provider == "fish" { voice.len() == 32 && voice.bytes().all(|b| b.is_ascii_hexdigit()) } else { pet_voices().iter().any(|item| item["provider"] == provider && item["id"] == voice && item["language"] == language) };
    if field(sources,"independent") != &Value::Bool(false) && !voice_valid { return Err(Error::Settings("invalid_voice",400)); }
    let rules = field(v,"rules").as_array().filter(|r| r.len() <= 20).ok_or(Error::Settings("invalid_rules",400))?;
    // Evaluate in the same order as the source object literal.
    let independent = boolean(field(sources,"independent"))?; let read_tts = boolean(field(sources,"readTts"))?;
    let idle = nullable_id(appearance.get("idleAssetId").ok_or_else(invalid)?)?; let talking = nullable_id(appearance.get("talkingAssetId").ok_or_else(invalid)?)?;
    let desktop = nullable_id(playback.get("desktopSessionId").ok_or_else(invalid)?)?; let vts = nullable_id(playback.get("vtsSessionId").ok_or_else(invalid)?)?;
    let enabled = boolean(field(v,"enabled"))?; let name = text(field(v,"name"),40,false)?; let tts_enabled = boolean(field(tts,"enabled"))?;
    let profile = text(field(personality,"profileId"),100,source == "custom")?; let prompt = text(field(personality,"prompt"),4000,source == "profile")?;
    let rules = rules.iter().map(|r| text(r,300,false)).collect::<Result<Vec<_>,_>>()?;
    let chat = boolean(field(behavior,"respondToChat"))?; let events = boolean(field(behavior,"respondToEvents"))?;
    let cooldown = integer(field(behavior,"cooldownSeconds"),0,3600)?; let length = integer(field(behavior,"maxReplyLength"),30,500)?;
    let queue = integer(behavior.get("queueSize").filter(|x| !x.is_null()).unwrap_or(&defaults["behavior"]["queueSize"]),1,10)?;
    Ok(json!({"sources":{"independent":independent,"readTts":read_tts},"ttsAudio":audio,"appearance":{"kind":kind,"idleAssetId":idle,"talkingAssetId":talking},"playback":{"target":target,"desktopSessionId":desktop,"vtsSessionId":vts},"enabled":enabled,"name":name,"tts":{"enabled":tts_enabled,"provider":provider,"language":language,"voice":voice},"personality":{"source":source,"profileId":profile,"prompt":prompt},"rules":rules,"behavior":{"respondToChat":chat,"respondToEvents":events,"cooldownSeconds":cooldown,"maxReplyLength":length,"queueSize":queue,"askLane":lane}}))
}
/// Mongo operations use existing collection schemas; caller supplies an isolated or production database explicitly.
#[derive(Clone)]
pub struct MongoPetSettings { db: Database }
impl MongoPetSettings {
    pub fn new(db: Database) -> Self { Self { db } }
    fn id(user: &str) -> Result<ObjectId, Error> { ObjectId::parse_str(user).map_err(|_| Error::InvalidUserId) }
    pub async fn require_plan(&self, user: &str, channel: &str) -> Result<(), Error> {
        let row = self.db.collection::<Document>("users").find_one(doc! {"_id":Self::id(user)?,"accounts":{"$elemMatch":{"type":"twitch","id":channel}}}).projection(doc! {"plan_tier":1}).await?;
        let row = row.ok_or(Error::Settings("access_denied",403))?;
        if !matches!(row.get_str("plan_tier"), Ok("premium" | "pro")) { return Err(Error::Settings("plan_required",403)); } Ok(())
    }
    pub async fn record(&self, user: &str) -> Result<Option<Document>, Error> { Ok(pet_settings::collection(&self.db).find_one(doc! {"userId":Self::id(user)?}).await?) }
    pub async fn personality(&self, channel: &str) -> Result<Option<Document>, Error> { Ok(self.db.collection::<Document>("channelaipersonalities").find_one(doc! {"channelID":channel}).projection(doc! {"profiles":1,"rules":1}).await?) }
    pub async fn runtime(&self, user: &str) -> Result<Option<Document>, Error> { Ok(pet_runtime::runtime_collection(&self.db).find_one(doc! {"_id":user}).await?) }
    pub async fn profile_exists(&self, channel: &str, profile: &str) -> Result<bool, Error> { Ok(self.db.collection::<Document>("channelaipersonalities").find_one(doc! {"channelID":channel,"profiles.profileID":profile}).await?.is_some()) }
    /// Install the unique index before the initial insert, just as Model.init() does.
    pub async fn write(&self, user: &str, revision: u64, settings: &Value, now: DateTime) -> Result<(), Error> {
        let user = Self::id(user)?;
        let settings = mongodb::bson::to_document(settings).map_err(|_| invalid())?;
        pet_settings::install_indexes(&self.db).await?;
        let update = doc! {"settings":settings,"revision":Bson::Double((revision + 1) as f64),"updatedAt":now};
        if revision == 0 {
            let mut row = update; row.insert("userId",user);
            match pet_settings::collection(&self.db).insert_one(row).await {
                Ok(_) => Ok(()),
                Err(e) if matches!(e.kind.as_ref(), mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(w)) if w.code == 11000) => Err(Error::Settings("settings_conflict",409)),
                Err(e) => Err(e.into()),
            }
        } else {
            let row = pet_settings::collection(&self.db).find_one_and_update(doc! {"userId":user,"revision":Bson::Double(revision as f64)},doc! {"$set":update}).await?;
            if row.is_none() { Err(Error::Settings("settings_conflict",409)) } else { Ok(()) }
        }
    }
}

use std::{future::Future, pin::Pin, sync::Arc};
use crate::media::library::{Asset, AssetError, AssetLibrary};

pub type PetFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Team4 must supply the real peer, readiness and invalidation implementations.
/// Failure is propagated; no fallback or fabricated readiness is provided.
pub trait PetCoordination: Send + Sync {
    fn validate_sessions<'a>(&'a self, owner: &'a str, playback: &'a Value, previous: Option<&'a Value>) -> PetFuture<'a, Result<(), Error>>;
    fn has_shared_vts_readiness<'a>(&'a self, owner: &'a str, generation: Option<Bson>, revision: u64, session: Option<&'a str>) -> PetFuture<'a, Result<bool, Error>>;
    fn invalidate<'a>(&'a self, owner: &'a str, reason: &'a str) -> PetFuture<'a, Result<(), Error>>;
}

/// The supplied library must be the same instance used by asset uploads and deletions.
pub trait PetSettingsStore: Send + Sync {
    fn require_plan<'a>(&'a self, user: &'a str, channel: &'a str) -> PetFuture<'a, Result<(), Error>>;
    fn record<'a>(&'a self, user: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>>;
    fn personality<'a>(&'a self, channel: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>>;
    fn runtime<'a>(&'a self, user: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>>;
    fn profile_exists<'a>(&'a self, channel: &'a str, profile: &'a str) -> PetFuture<'a, Result<bool, Error>>;
    fn write<'a>(&'a self, user: &'a str, revision: u64, settings: &'a Value, now: DateTime) -> PetFuture<'a, Result<(), Error>>;
}
impl PetSettingsStore for MongoPetSettings {
    fn require_plan<'a>(&'a self, u: &'a str, c: &'a str) -> PetFuture<'a, Result<(), Error>> { Box::pin(MongoPetSettings::require_plan(self,u,c)) }
    fn record<'a>(&'a self, u: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(MongoPetSettings::record(self,u)) }
    fn personality<'a>(&'a self, c: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(MongoPetSettings::personality(self,c)) }
    fn runtime<'a>(&'a self, u: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(MongoPetSettings::runtime(self,u)) }
    fn profile_exists<'a>(&'a self, c: &'a str, p: &'a str) -> PetFuture<'a, Result<bool, Error>> { Box::pin(MongoPetSettings::profile_exists(self,c,p)) }
    fn write<'a>(&'a self, u: &'a str, r: u64, s: &'a Value, n: DateTime) -> PetFuture<'a, Result<(), Error>> { Box::pin(MongoPetSettings::write(self,u,r,s,n)) }
}
pub struct PetSettingsService<C, S = MongoPetSettings> { pub mongo: S, pub assets: Arc<AssetLibrary>, pub coordination: C }
fn image_asset(asset: &Asset) -> bool {
    asset.string("kind") == Some("image") && matches!(asset.string("mime"), Some("image/png" | "image/jpeg" | "image/gif" | "image/webp"))
}
fn bson_number(value: Option<&Bson>) -> u64 {
    match value { Some(Bson::Int32(n)) if *n >= 0 => *n as u64, Some(Bson::Int64(n)) if *n >= 0 => *n as u64, Some(Bson::Double(n)) if *n >= 0.0 => *n as u64, _ => 0 }
}
fn json_bson(value: &Bson) -> Result<Value, Error> { mongodb::bson::from_bson(value.clone()).map_err(|_| Error::MalformedStoredData) }
fn normalize_settings(record: Option<&Document>) -> Result<Value, Error> {
    let defaults = default_pet_settings();
    let mut settings = match record.and_then(|r| r.get("settings")) { Some(Bson::Null) | None => defaults.clone(), Some(v) => json_bson(v)? };
    let obj = settings.as_object_mut().ok_or(Error::MalformedStoredData)?;
    let sources = obj.get("sources").and_then(Value::as_object);
    let independent = sources.and_then(|s| s.get("independent")).filter(|v| !v.is_null()).cloned().unwrap_or(json!(true));
    let read_tts = sources.and_then(|s| s.get("readTts")).filter(|v| !v.is_null()).cloned().unwrap_or(json!(false));
    obj.insert("sources".into(), json!({"independent":independent,"readTts":read_tts}));
    for key in ["ttsAudio", "appearance", "playback"] { if obj.get(key).map_or(true, Value::is_null) { obj.insert(key.into(), defaults[key].clone()); } }
    // Object spread in the source preserves other behavior properties.
    let behavior = obj.entry("behavior").or_insert_with(|| json!({}));
    if behavior.is_null() { *behavior = json!({}); }
    let behavior = behavior.as_object_mut().ok_or(Error::MalformedStoredData)?;
    if behavior.get("queueSize").map_or(true, Value::is_null) { behavior.insert("queueSize".into(), json!(5)); }
    if behavior.get("askLane").map_or(true, Value::is_null) { behavior.insert("askLane".into(), json!("independent")); }
    Ok(settings)
}
impl<C: PetCoordination, S: PetSettingsStore> PetSettingsService<C, S> {
    pub fn new(mongo: S, assets: Arc<AssetLibrary>, coordination: C) -> Self { Self { mongo, assets, coordination } }
    pub async fn get(&self, user: &str, channel: &str) -> Result<Value, Error> {
        self.mongo.require_plan(user, channel).await?;
        // The source issues these three independent reads concurrently.
        let (record, personality, runtime) = tokio::try_join!(self.mongo.record(user), self.mongo.personality(channel), self.mongo.runtime(user))?;
        let settings = normalize_settings(record.as_ref())?;
        let revision = bson_number(record.as_ref().and_then(|r| r.get("revision")));
        let profiles = personality.as_ref().and_then(|p| p.get_array("profiles").ok()).cloned().unwrap_or_default();
        let profile = if settings["personality"]["source"] == "profile" { profiles.iter().filter_map(Bson::as_document).find(|p| p.get_str("profileID").ok() == settings["personality"]["profileId"].as_str()) } else { None };
        let profiles_json: Vec<Value> = profiles.iter().filter_map(Bson::as_document).map(|p| json!({"id":p.get_str("profileID").ok(),"name":p.get_str("name").ok()})).collect();
        let independent = settings["sources"]["independent"] == true;
        let mut issues: Vec<&str> = Vec::new();
        if independent && settings["personality"]["source"] == "profile" && profile.is_none() { issues.push("personality_unavailable"); }
        if settings["appearance"]["kind"] == "png" {
            let mut available = ["idleAssetId", "talkingAssetId"].iter().all(|key| settings["appearance"][*key].as_str().map_or(false, |id| !id.is_empty()));
            for key in ["idleAssetId", "talkingAssetId"] {
                if !available { break; }
                match settings["appearance"][key].as_str() {
                    Some(id) if !id.is_empty() => match self.assets.find_asset(channel,id).await { Ok(asset) if image_asset(&asset) => {}, _ => { available = false; break; } },
                    _ => { available = false; break; }
                }
            }
            if !available { issues.push("appearance_unavailable"); }
        } else {
            let generation = runtime.as_ref().and_then(|r| r.get("generation")).cloned();
            if !self.coordination.has_shared_vts_readiness(user,generation,revision,settings["playback"]["vtsSessionId"].as_str()).await? { issues.push("vts_unavailable"); }
        }
        let rules = settings["rules"].clone();
        let resolved = if let Some(p) = profile {
            let mut merged = personality.as_ref().and_then(|d| d.get_array("rules").ok()).cloned().unwrap_or_default().iter().map(json_bson).collect::<Result<Vec<_>,_>>()?;
            merged.extend(rules.as_array().ok_or(Error::MalformedStoredData)?.iter().cloned());
            let mut out = serde_json::Map::new();
            for (target, source) in [("prompt","personality"),("personaMode","personaMode"),("personaReference","personaReference"),("tonePreset","tonePreset"),("voiceProfile","voiceProfile")] { if let Some(value) = p.get(source) { out.insert(target.into(),json_bson(value)?); } }
            out.insert("rules".into(),json!(merged)); Value::Object(out)
        } else { json!({"prompt":settings["personality"]["prompt"],"rules":rules}) };
        let updated = match record.as_ref().and_then(|r| r.get_datetime("updatedAt").ok()) { Some(date) => Value::String(crate::utils::credit_policy::JsDate::from_millis(date.timestamp_millis() as f64).to_iso_string().map_err(|_| Error::MalformedStoredData)?), None => Value::Null };
        let playback = runtime.as_ref().and_then(|r| r.get_document("lease").ok()).and_then(|l| l.get_datetime("expiresAt").ok()).map_or(false, |expiry| expiry.timestamp_millis() > DateTime::now().timestamp_millis());
        let enabled = settings["enabled"] == true;
        let read_tts_enabled = enabled && settings["sources"]["readTts"] == true && issues.iter().all(|i| *i == "personality_unavailable");
        let runtime_enabled = enabled && issues.is_empty();
        Ok(json!({"schemaVersion":3,"revision":revision,"updatedAt":updated,"settings":settings,"profiles":profiles_json,"voices":pet_voices(),"runtime":{"enabled":runtime_enabled,"issues":issues,"readTtsEnabled":read_tts_enabled,"personality":resolved,"playbackAvailable":playback}}))
    }
    pub async fn save(&self, user: &str, channel: &str, input: &Value) -> Result<Value, Error> {
        self.mongo.require_plan(user,channel).await?;
        let request = object(input,&["revision","settings"])?;
        let revision = integer(field(request,"revision"),0,9_007_199_254_740_990)?;
        let settings = validate_pet_settings(field(request,"settings"))?;
        if settings["sources"]["independent"] == true && settings["personality"]["source"] == "profile" && !self.mongo.profile_exists(channel,settings["personality"]["profileId"].as_str().ok_or_else(invalid)?).await? { return Err(Error::Settings("personality_unavailable",400)); }
        let previous = self.mongo.record(user).await?;
        let previous_playback = previous.as_ref().and_then(|r| r.get_document("settings").ok()).and_then(|s| s.get("playback")).map(json_bson).transpose()?;
        self.coordination.validate_sessions(user,&settings["playback"],previous_playback.as_ref()).await?;
        // Keep the typed operation error inside the AssetError-only owner-lock result.
        let result: Result<Result<Value, Error>, AssetError> = self.assets.with_asset_library(channel, || async {
            Ok(async {
                for key in ["idleAssetId","talkingAssetId"] {
                    if let Some(id) = settings["appearance"][key].as_str().filter(|s| !s.is_empty()) {
                        let asset = self.assets.find_asset(channel,id).await.map_err(Error::Asset)?;
                        if !image_asset(&asset) { return Err(Error::Settings("invalid_asset",400)); }
                    }
                }
                self.mongo.write(user,revision,&settings,DateTime::now()).await?;
                self.coordination.invalidate(user,"settings_changed").await?;
                self.get(user,channel).await
            }.await)
        }).await;
        result.map_err(Error::Asset)?
    }
}
