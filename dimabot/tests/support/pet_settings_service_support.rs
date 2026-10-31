//! External, digest-pinned output from the isolated actual-TypeScript oracle.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
pub fn fixture() -> Value {
    let dir = PathBuf::from(std::env::var_os("DIMA_PET_SETTINGS_FIXTURE_DIR").expect("fixture dir"));
    assert!(dir.is_absolute());
    let dir = dir.canonicalize().expect("fixture dir exists");
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap().parent().unwrap().to_path_buf();
    assert!(!dir.starts_with(workspace));
    let expected = std::env::var("DIMA_PET_SETTINGS_FIXTURE_SHA256").expect("fixture digest");
    assert!(expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let file = dir.join("pet-settings-service-reference.json");
    assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_file());
    let data = std::fs::read(file).unwrap(); assert_eq!(format!("{:x}", Sha256::digest(&data)), expected);
    serde_json::from_slice(&data).unwrap()
}

use dima_rust::pet_settings_service::{Error, PetCoordination, PetFuture, PetSettingsStore};
use dima_rust::media::library::{AssetError, AssetFuture, AssetRecordRepository, GridFsRangeRepository, AssetReadStream};
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use std::{path::Path, sync::{Arc, Mutex}};

#[derive(Clone)]
pub struct Boundary { pub state: Arc<Mutex<State>> }
pub struct State { pub spec: Value, pub record: Option<Document>, pub calls: Vec<String> }
impl Boundary {
    pub fn new(spec: &Value) -> Self {
        let record = spec.get("record").map(|v| mongodb::bson::to_document(v).unwrap());
        Self { state: Arc::new(Mutex::new(State { spec: spec.clone(), record, calls: Vec::new() })) }
    }
    pub fn calls(&self) -> Vec<String> { self.state.lock().unwrap().calls.clone() }
    pub fn persisted(&self) -> bool { self.state.lock().unwrap().record.is_some() }
}
impl PetSettingsStore for Boundary {
    fn require_plan<'a>(&'a self, _u: &'a str, _c: &'a str) -> PetFuture<'a, Result<(), Error>> { Box::pin(async move { let s=self.state.lock().unwrap(); match s.spec["plan"].as_str() { Some("denied") => Err(Error::Settings("access_denied",403)), Some("free") => Err(Error::Settings("plan_required",403)), _ => Ok(()) } }) }
    fn record<'a>(&'a self, _u: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(async move { Ok(self.state.lock().unwrap().record.clone()) }) }
    fn personality<'a>(&'a self, _c: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(async move { Ok(self.state.lock().unwrap().spec.get("personality").filter(|v| !v.is_null()).map(|v| mongodb::bson::to_document(v).unwrap())) }) }
    fn runtime<'a>(&'a self, _u: &'a str) -> PetFuture<'a, Result<Option<Document>, Error>> { Box::pin(async move {
        let s=self.state.lock().unwrap(); let Some(value)=s.spec.get("runtime").filter(|v| !v.is_null()) else { return Ok(None) };
        let mut runtime = mongodb::bson::to_document(value).unwrap();
        if let Ok(lease)=runtime.get_document_mut("lease") { if lease.contains_key("expiresAt") { lease.insert("expiresAt", DateTime::from_millis(4_070_908_800_000)); } }
        Ok(Some(runtime))
    }) }
    fn profile_exists<'a>(&'a self, _c: &'a str, profile: &'a str) -> PetFuture<'a, Result<bool, Error>> { Box::pin(async move { Ok(self.state.lock().unwrap().spec["personality"]["profiles"].as_array().map_or(false, |p| p.iter().any(|x| x["profileID"] == profile))) }) }
    fn write<'a>(&'a self, _u: &'a str, revision: u64, settings: &'a Value, _n: DateTime) -> PetFuture<'a, Result<(), Error>> { Box::pin(async move {
        let mut s=self.state.lock().unwrap(); s.calls.push("index".into()); s.calls.push("write".into());
        if (revision == 0 && s.record.is_some()) || (revision != 0 && s.record.as_ref().and_then(|r| r.get("revision")).and_then(|v| match v { Bson::Int32(n)=>Some(*n as u64), Bson::Int64(n)=>Some(*n as u64), Bson::Double(n)=>Some(*n as u64), _=>None }) != Some(revision)) { return Err(Error::Settings("settings_conflict",409)); }
        s.record=Some(doc! {"revision":(revision+1) as f64,"settings":mongodb::bson::to_document(settings).unwrap(),"updatedAt":DateTime::now()}); Ok(())
    }) }
}
impl PetCoordination for Boundary {
    fn validate_sessions<'a>(&'a self, _o: &'a str, _p: &'a Value, _old: Option<&'a Value>) -> PetFuture<'a, Result<(), Error>> { Box::pin(async move { let mut s=self.state.lock().unwrap(); s.calls.push("sessions".into()); if s.spec["sessionError"] == true { Err(Error::Pet {code:"session_unavailable".into(),status:409}) } else { Ok(()) } }) }
    fn has_shared_vts_readiness<'a>(&'a self, _o: &'a str, _g: Option<Bson>, _r: u64, _id: Option<&'a str>) -> PetFuture<'a, Result<bool, Error>> { Box::pin(async move { let mut s=self.state.lock().unwrap(); s.calls.push("readiness".into()); Ok(s.spec["ready"] == true) }) }
    fn invalidate<'a>(&'a self, _o: &'a str, _r: &'a str) -> PetFuture<'a, Result<(), Error>> { Box::pin(async move { let mut s=self.state.lock().unwrap(); s.calls.push("invalidate".into()); if s.spec["invalidateError"] == true { Err(Error::Pet {code:"invalidate_failed".into(),status:503}) } else { Ok(()) } }) }
}
impl AssetRecordRepository for Boundary {
    fn find_user<'a>(&'a self, _o: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>> { Box::pin(async { Ok(None) }) }
    fn find<'a>(&'a self, _o: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>> { Box::pin(async move {
        let s=self.state.lock().unwrap(); let mut assets=Vec::new();
        if let Some(map)=s.spec["assets"].as_object() { for (id, asset) in map { let mut row=mongodb::bson::to_document(asset).unwrap(); row.insert("id",id.clone()); row.insert("state","ready"); assets.push(Bson::Document(row)); } }
        Ok(Some(doc! {"usedBytes":0,"assets":assets}))
    }) }
    fn update<'a>(&'a self, _f: Document, _u: Document, _up: bool) -> AssetFuture<'a, Result<u64, AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
}
// No GridFS operation is part of settings validation; unexpected calls fail.
pub struct NoGridFs;
impl GridFsRangeRepository for NoGridFs {
    fn length<'a>(&'a self, _id: ObjectId) -> AssetFuture<'a, Result<u64, AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
    fn read_window<'a>(&'a self, _id: ObjectId, _s: u64, _e: u64) -> AssetFuture<'a, Result<Vec<u8>, AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
    fn upload<'a>(&'a self, _id: ObjectId, _o: &'a str, _n: &'a str, _m: &'a str, _p: &'a Path) -> AssetFuture<'a, Result<(), AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
    fn remove<'a>(&'a self, _id: ObjectId) -> AssetFuture<'a, Result<(), AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
    fn open<'a>(&'a self, _id: ObjectId) -> AssetFuture<'a, Result<AssetReadStream, AssetError>> { Box::pin(async { Err(AssetError{code:"unused",status:500}) }) }
}
