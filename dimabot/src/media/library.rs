//! Pure private-library rules from `assets/library.ts`. Ready assets are returned
//! newest first; uploads and deletes use GridFS, not the unrelated S3 schema.
//! Ranged reads use the GridFS `files` length/chunkSize and ordered chunk `n`
//! fields, assuming the specification's contiguous zero-based chunk sequence.
//! ffprobe stdout and stderr are drained concurrently, each with its own 64 KiB
//! limit. Both may total more than 64 KiB; only stdout is parsed.

use std::fmt;

/// Maximum upload size in bytes.
pub const MAX_ASSET_BYTES: u64 = 50_000_000;
/// Maximum number of assets in a private library.
pub const MAX_ASSETS: usize = 2_000;

/// The source's asset error code and HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetError {
    /// Stable source error code.
    pub code: &'static str,
    /// HTTP status associated with the error.
    pub status: u16,
}

impl fmt::Display for AssetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for AssetError {}

/// Private asset-library quota (100 MB / 500 MB / 5 GB), separate from media quotas.
pub fn quota_bytes(tier: &str) -> u64 {
    match tier {
        "premium" => 500_000_000,
        "pro" => 5_000_000_000,
        _ => 100_000_000,
    }
}

/// Return ready records in reverse insertion order, as `listAssets` does.
pub fn ready_newest_first<T>(assets: &[T], is_ready: impl Fn(&T) -> bool) -> Vec<&T> {
    assets.iter().filter(|asset| is_ready(asset)).rev().collect()
}

/// Whether an upload passes the source's size check.
pub fn validate_size(bytes: u64) -> Result<(), AssetError> {
    if bytes == 0 || bytes > MAX_ASSET_BYTES {
        Err(AssetError { code: "file_size", status: 413 })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiers_default_to_free() {
        assert_eq!(quota_bytes("unknown"), 100_000_000);
        assert_eq!(quota_bytes("premium"), 500_000_000);
        assert_eq!(quota_bytes("pro"), 5_000_000_000);
    }
    #[test]
    fn ready_records_are_reversed() {
        assert_eq!(ready_newest_first(&[(1, true), (2, false), (3, true)], |x| x.1), vec![&(3, true), &(1, true)]);
    }
    #[test]
    fn size_boundaries_are_inclusive() {
        assert!(validate_size(0).is_err());
        assert!(validate_size(MAX_ASSET_BYTES).is_ok());
        assert!(validate_size(MAX_ASSET_BYTES + 1).is_err());
    }
}

use std::{collections::HashMap, future::Future, path::{Path, PathBuf}, pin::Pin, sync::{Arc, Mutex}, time::Duration};
use futures_util::io::AsyncWriteExt as FuturesWriteExt;
use mongodb::{Database, bson::{doc, oid::ObjectId, Bson, DateTime, Document}, options::GridFsBucketOptions};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, sync::Mutex as AsyncMutex};

/// A lean Mongo embedded asset. Missing, null, and unknown fields are retained;
/// reading a document does not perform Mongoose's construction-time casting.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Asset(pub Document);
impl Asset {
    /// Retain a document exactly as returned by a lean Mongo query.
    pub fn from_document(document: Document) -> Self { Self(document) }
    /// Read an optional string without fabricating a default.
    pub fn string(&self, field: &str) -> Option<&str> { self.0.get_str(field).ok() }
}

/// Mongoose's inline embedded asset schema. All ten paths are optional; none
/// has a default, enum, required, range, or match validator, and `_id` is off.
/// This models construction and casting, not a Mongo `lean()` read.
pub fn embedded_asset_schema() -> crate::schemas::SchemaDefinition {
    use crate::schemas::{Field, FieldType as T, SchemaDefinition};
    SchemaDefinition {
        model: "AssetLibraryEmbeddedAsset", collection: "asset_libraries", string_id: true,
        version_key: false, write_concern_journaled: false, timestamps: None,
        save_clock_field: None, indexes: Vec::new(),
        fields: vec![Field::new("id", T::String), Field::new("name", T::String),
            Field::new("kind", T::String), Field::new("mime", T::String),
            Field::new("bytes", T::Number), Field::new("width", T::Number),
            Field::new("height", T::Number), Field::new("duration", T::Number),
            Field::new("createdAt", T::String), Field::new("state", T::String)],
    }
}

/// Source library schema: a string `_id`, zero usage, and an empty asset array.
pub fn asset_library_schema() -> crate::schemas::SchemaDefinition {
    use crate::schemas::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
    SchemaDefinition {
        model: "AssetLibrary", collection: "asset_libraries", string_id: true,
        version_key: false, write_concern_journaled: false, timestamps: None,
        save_clock_field: None, indexes: Vec::new(),
        fields: vec![
            Field::new("_id", T::String),
            Field::new("usedBytes", T::Number).default(D::Number(0.0)),
            Field::new("assets", T::Array(Box::new(T::Subdocument {
                fields: embedded_asset_schema().fields,
                generate_id: false,
            }))).default(D::Array),
        ],
    }
}

/// Source quota response.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetQuota {
    pub plan_tier: String,
    pub quota_bytes: u64,
    pub max_file_bytes: u64,
}

/// Source listing response.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetListing {
    #[serde(flatten)]
    pub quota: AssetQuota,
    pub used_bytes: i64,
    pub assets: Vec<Asset>,
}

/// A temporary upload supplied by the HTTP layer.
#[derive(Clone, Debug)]
pub struct UploadFile {
    pub path: PathBuf,
    pub original_name: String,
    pub size: u64,
}

/// A media inspector's source-compatible result.
#[derive(Clone, Debug, PartialEq)]
pub struct Inspection {
    pub mime: &'static str,
    pub kind: &'static str,
    pub width: i64,
    pub height: i64,
    pub duration: Option<f64>,
}

/// Object-safe future for injected inspection and deletion consumers.
pub type AssetFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Application-specific consumer that can prevent deletion.
pub trait AssetConsumer: Send + Sync {
    fn in_use<'a>(&'a self, owner: &'a str, id: &'a str) -> AssetFuture<'a, Result<bool, AssetError>>;
}
/// Injectable media inspection seam; the production implementation is `FfprobeInspector`.
pub trait AssetInspector: Send + Sync {
    fn inspect<'a>(&'a self, path: &'a Path) -> AssetFuture<'a, Result<Inspection, AssetError>>;
}
/// Native magic-byte and ffprobe inspector; construction performs no I/O.
pub struct FfprobeInspector;
impl AssetInspector for FfprobeInspector {
    fn inspect<'a>(&'a self, path: &'a Path) -> AssetFuture<'a, Result<Inspection, AssetError>> {
        Box::pin(inspect_file(path))
    }
}

fn unavailable() -> AssetError { AssetError { code: "unavailable", status: 500 } }
fn invalid_media() -> AssetError { AssetError { code: "invalid_media", status: 415 } }
fn missing() -> AssetError { AssetError { code: "not_found", status: 404 } }

/// Identify media from the same first bytes and precedence as the TypeScript source.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[137,80,78,71,13,10,26,10]) { Some("image/png") }
    else if bytes.starts_with(&[255,216,255]) { Some("image/jpeg") }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some("image/gif") }
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { Some("image/webp") }
    else if bytes.get(4..8) == Some(b"ftyp") { Some("video/mp4") }
    else if bytes.starts_with(&[26,69,223,163]) { Some("video/webm") }
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") { Some("audio/wav") }
    else if bytes.starts_with(b"OggS") { Some("audio/ogg") }
    else if bytes.starts_with(b"ID3") || bytes.first() == Some(&255) && bytes.get(1).is_some_and(|b| b & 0xe0 == 0xe0) { Some("audio/mpeg") }
    else { None }
}

/// Validate an ffprobe JSON response; malformed or unsupported media is rejected.
pub fn parse_probe(mime: &'static str, json: &str) -> Result<Inspection, AssetError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| invalid_media())?;
    let streams = value.get("streams").and_then(|v| v.as_array()).ok_or_else(invalid_media)?;
    if mime.starts_with("audio/") {
        let audio = streams.iter().find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio")).ok_or_else(invalid_media)?;
        let codec = audio.get("codec_name").and_then(|v| v.as_str()).ok_or_else(invalid_media)?;
        let accepted = match mime {
            "audio/wav" => ["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"].contains(&codec),
            "audio/mpeg" => codec == "mp3",
            "audio/ogg" => ["opus", "vorbis"].contains(&codec),
            _ => false,
        };
        let duration = value.get("format").and_then(|v| v.get("duration")).and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64())).ok_or_else(invalid_media)?;
        if !accepted || !duration.is_finite() || duration <= 0.0 || duration > 600.0 || streams.iter().any(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("video")) { return Err(invalid_media()); }
        Ok(Inspection { mime, kind: "audio", width: 0, height: 0, duration: Some(duration) })
    } else {
        let stream = streams.first().ok_or_else(invalid_media)?;
        let dimension = |key: &str| stream.get(key).and_then(|v| v.as_f64()).filter(|value| value.is_finite() && value.fract() == 0.0 && (1.0..=16384.0).contains(value)).map(|value| value as i64).ok_or_else(invalid_media);
        let width = dimension("width")?;
        let height = dimension("height")?;
        let codec = stream.get("codec_name").and_then(|v| v.as_str()).unwrap_or("");
        if !(1..=16384).contains(&width) || !(1..=16384).contains(&height) || mime == "video/mp4" && !["h264", "hevc", "av1", "vp9"].contains(&codec) || mime == "video/webm" && !["vp8", "vp9", "av1"].contains(&codec) { return Err(invalid_media()); }
        Ok(Inspection { mime, kind: if mime.starts_with("image/") { "image" } else { "video" }, width, height, duration: None })
    }
}

/// Inspect a file with the source's file signatures and ffprobe arguments.
pub async fn inspect_file(path: &Path) -> Result<Inspection, AssetError> {
    let mut file = tokio::fs::File::open(path).await.map_err(|_| unavailable())?;
    let mut bytes = [0; 32];
    let read = file.read(&mut bytes).await.map_err(|_| unavailable())?;
    let mime = sniff_mime(&bytes[..read]).ok_or(AssetError { code: "unsupported_type", status: 415 })?;
    let mut command = tokio::process::Command::new("ffprobe");
    command.kill_on_drop(true).args(["-v", "error", "-protocol_whitelist", "file"]);
    if mime.starts_with("audio/") {
        command.args(["-show_entries", "stream=codec_type,codec_name:format=duration"]);
    } else {
        command.args(["-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name"]);
    }
    command.args(["-of", "json"]).arg(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut child = command.spawn().map_err(|_| invalid_media())?;
        let stdout = child.stdout.take().ok_or_else(invalid_media)?;
        let stderr = child.stderr.take().ok_or_else(invalid_media)?;
        let bytes = read_probe_streams(stdout, stderr, 65_536).await?;
        if !child.wait().await.map_err(|_| invalid_media())?.success() { return Err(invalid_media()); }
        Ok::<_, AssetError>(bytes)
    }).await.map_err(|_| invalid_media())??;
    let json = std::str::from_utf8(&output).map_err(|_| invalid_media())?;
    parse_probe(mime, json)
}

async fn read_probe_stream<R: tokio::io::AsyncRead + Unpin>(mut stream: R, limit: usize) -> Result<Vec<u8>, AssetError> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = stream.read(&mut buffer).await.map_err(|_| invalid_media())?;
        if count == 0 { return Ok(result); }
        if result.len().saturating_add(count) > limit { return Err(invalid_media()); }
        result.extend_from_slice(&buffer[..count]);
    }
}

async fn read_probe_streams<O: tokio::io::AsyncRead + Unpin, E: tokio::io::AsyncRead + Unpin>(stdout: O, stderr: E, limit: usize) -> Result<Vec<u8>, AssetError> {
    let (stdout, _stderr) = tokio::try_join!(read_probe_stream(stdout, limit), read_probe_stream(stderr, limit))?;
    Ok(stdout)
}

/// Replace source-disallowed filename characters; truncation is UTF-16 based.
pub fn sanitize_name_js(name: &crate::utils::js_string::JsString) -> crate::utils::js_string::JsString {
    use crate::utils::js_string::JsString;
    let units = name.code_units().map(|unit| if unit <= 0x1f || unit == 0x7f || unit == b'/' as u16 || unit == b'\\' as u16 { b'_' as u16 } else { unit }).collect();
    JsString::from_units(units).slice(0, 120)
}

/// Convert the source name to BSON UTF-8, replacing unpaired code units as Node does.
pub fn sanitize_name(name: &str) -> String {
    sanitize_name_js(&name.into()).to_utf8_lossy()
}

/// Largest current usage that can accept the given reservation.
pub fn reservation_ceiling(quota: u64, size: u64) -> i64 { quota as i64 - size as i64 }

/// Concrete MongoDB/GridFS private-library adapter with per-owner serialization.
#[derive(Clone)]
pub struct AssetLibrary {
    records: Arc<dyn AssetRecordRepository>,
    ranges: Arc<dyn GridFsRangeRepository>,
    inspector: Arc<dyn AssetInspector>,
    locks: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    consumers: Arc<Mutex<HashMap<String, Arc<dyn AssetConsumer>>>>,
}

impl AssetLibrary {
    /// Construct the native adapter with concrete database and ffprobe implementation.
    pub fn native(database: Database) -> Self {
        let mut consumers: HashMap<String, Arc<dyn AssetConsumer>> = HashMap::new();
        consumers.insert("pet".to_owned(), Arc::new(MongoPetConsumer::new(database.clone())));
        consumers.insert("overlay-studio".to_owned(), Arc::new(MongoOverlayConsumer::new(database.clone())));
        let records = Arc::new(MongoAssetRecordRepository::new(database.clone()));
        let ranges = Arc::new(MongoGridFsRangeRepository::new(database.clone()));
        Self { records, ranges, inspector: Arc::new(FfprobeInspector), locks: Arc::new(Mutex::new(HashMap::new())), consumers: Arc::new(Mutex::new(consumers)) }
    }
    /// Construct with an injectable inspector and the real Mongo/GridFS adapter.
    pub fn with_adapters(database: Database, inspector: Arc<dyn AssetInspector>) -> Self {
        let records = Arc::new(MongoAssetRecordRepository::new(database.clone()));
        let ranges = Arc::new(MongoGridFsRangeRepository::new(database.clone()));
        Self::with_repositories(inspector, records, ranges)
    }
    /// Inject record and ranged-read repositories while retaining the native GridFS writer.
    pub fn with_repositories(inspector: Arc<dyn AssetInspector>, records: Arc<dyn AssetRecordRepository>, ranges: Arc<dyn GridFsRangeRepository>) -> Self {
        Self { records, ranges, inspector, locks: Arc::new(Mutex::new(HashMap::new())), consumers: Arc::new(Mutex::new(HashMap::new())) }
    }
    /// Serialize an owner-scoped reference update with uploads and deletes.
    pub async fn with_asset_library<T, F, Fut>(&self, owner: &str, operation: F) -> Result<T, AssetError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AssetError>>,
    {
        let lock = self.owner_lock(owner)?;
        let _guard = lock.lock().await;
        operation().await
    }
    fn owner_lock(&self, owner: &str) -> Result<Arc<AsyncMutex<()>>, AssetError> {
        let mut locks = self.locks.lock().map_err(|_| unavailable())?;
        Ok(locks.entry(owner.to_owned()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone())
    }
    /// Register or replace a named deletion consumer.
    pub fn register_asset_consumer(&self, name: String, consumer: Arc<dyn AssetConsumer>) -> Result<(), AssetError> {
        self.consumers.lock().map_err(|_| unavailable())?.insert(name, consumer);
        Ok(())
    }
    /// Read an owner's tier from the existing users collection.
    pub async fn asset_quota(&self, owner: &str) -> Result<AssetQuota, AssetError> {
        let user = self.records.find_user(owner).await?.ok_or(AssetError { code: "owner_missing", status: 404 })?;
        let tier = match user.get_str("plan_tier").ok() { Some("pro") => "pro", Some("premium") => "premium", _ => "free" };
        Ok(AssetQuota { plan_tier: tier.to_owned(), quota_bytes: quota_bytes(tier), max_file_bytes: MAX_ASSET_BYTES })
    }
    async fn assets(&self, owner: &str) -> Result<(i64, Vec<Asset>), AssetError> {
        let Some(row) = find_library_with(self.records.as_ref(), owner).await? else { return Ok((0, Vec::new())); };
        let used = row.get_i64("usedBytes").or_else(|_| row.get_i32("usedBytes").map(i64::from)).or_else(|_| row.get_f64("usedBytes").map(|value| value as i64)).unwrap_or(0);
        let mut assets = Vec::new();
        if let Ok(values) = row.get_array("assets") {
            for value in values {
                let document = value.as_document().ok_or_else(unavailable)?.clone();
                assets.push(Asset::from_document(document));
            }
        }
        Ok((used, assets))
    }
    /// Return a ready asset belonging to the owner.
    pub async fn find_asset(&self, owner: &str, id: &str) -> Result<Asset, AssetError> {
        self.assets(owner).await?.1.into_iter().find(|asset| asset.string("id") == Some(id) && asset.string("state") == Some("ready")).ok_or_else(missing)
    }
    async fn remove_bytes(&self, owner: &str, asset: &Asset) -> Result<(), AssetError> {
        let asset_id = asset.string("id").ok_or_else(unavailable)?;
        let id = ObjectId::parse_str(asset_id).map_err(|_| unavailable())?;
        self.ranges.remove(id).await?;
        let charge = match asset.0.get("bytes") {
            Some(Bson::Int32(value)) => -(f64::from(*value)),
            Some(Bson::Int64(value)) => -(*value as f64),
            Some(Bson::Double(value)) => -*value,
            Some(Bson::Null) => 0.0,
            _ => f64::NAN,
        };
        self.records.update(doc! { "_id": owner, "assets.id": asset_id }, doc! { "$pull": { "assets": { "id": asset_id } }, "$inc": { "usedBytes": crate::utils::bson_compat::js_number(charge) } }, false).await?;
        Ok(())
    }
    async fn recover(&self, owner: &str) -> Result<(), AssetError> {
        let cutoff = DateTime::now().timestamp_millis() - 3_600_000;
        for asset in self.assets(owner).await?.1 {
            if asset.string("state") == Some("deleting") || asset.string("state") == Some("uploading") && asset.string("createdAt").and_then(crate::utils::js_date::parse_date).is_some_and(|date| date < cutoff) { self.remove_bytes(owner, &asset).await?; }
        }
        Ok(())
    }
    /// Recover interrupted operations and list ready assets newest first.
    pub async fn list_assets(&self, owner: &str) -> Result<AssetListing, AssetError> {
        let quota = self.asset_quota(owner).await?;
        let lock = self.owner_lock(owner)?;
        let _guard = lock.lock().await;
        self.recover(owner).await?;
        let (used_bytes, assets) = self.assets(owner).await?;
        let assets = assets.into_iter().filter(|asset| asset.string("state") == Some("ready")).rev().collect();
        Ok(AssetListing { quota, used_bytes, assets })
    }
    /// Upload a file after atomic quota reservation and mark it ready.
    pub async fn upload_asset(&self, owner: &str, file: &UploadFile) -> Result<Asset, AssetError> {
        validate_size(file.size)?;
        let media = self.inspector.inspect(&file.path).await?;
        let lock = self.owner_lock(owner)?;
        let _guard = lock.lock().await;
        let quota = self.asset_quota(owner).await?;
        self.records.update(doc! { "_id": owner }, doc! { "$setOnInsert": { "usedBytes": 0, "assets": [] } }, true).await?;
        self.recover(owner).await?;
        let id = ObjectId::new();
        let mut name = sanitize_name(&file.original_name);
        if name.is_empty() { name = uuid::Uuid::new_v4().to_string(); }
        let now = DateTime::now();
        let timestamp = now.try_to_rfc3339_string().map_err(|_| unavailable())?.replace("+00:00", "Z");
        let whole_seconds = timestamp.split('.').next().unwrap_or(&timestamp).trim_end_matches('Z');
        let created_at = format!("{whole_seconds}.{:03}Z", now.timestamp_millis().rem_euclid(1000));
        let asset_id = id.to_hex();
        let mut document = doc! { "id": &asset_id, "name": &name, "kind": media.kind, "mime": media.mime, "bytes": file.size as i64, "width": media.width, "height": media.height, "createdAt": created_at, "state": "uploading" };
        if let Some(duration) = media.duration { document.insert("duration", duration); }
        let mut asset = Asset::from_document(document.clone());
        let reserved = self.records.update(doc! { "_id": owner, "usedBytes": { "$lte": reservation_ceiling(quota.quota_bytes, file.size) }, "assets.1999": { "$exists": false } }, doc! { "$inc": { "usedBytes": file.size as i64 }, "$push": { "assets": document } }, false).await?;
        if reserved == 0 { return Err(AssetError { code: "quota_exceeded", status: 413 }); }
        let result = async {
            self.ranges.upload(id, owner, &name, media.mime, &file.path).await?;
            self.records.update(doc! { "_id": owner, "assets.id": &asset_id }, doc! { "$set": { "assets.$.state": "ready" } }, false).await?;
            Ok::<(), AssetError>(())
        }.await;
        if let Err(error) = result { self.remove_bytes(owner, &asset).await?; return Err(error); }
        asset.0.insert("state", "ready");
        Ok(asset)
    }
    /// Delete a ready asset after all registered consumers approve it.
    pub async fn delete_asset(&self, owner: &str, id: &str) -> Result<(), AssetError> {
        let lock = self.owner_lock(owner)?;
        let _guard = lock.lock().await;
        let asset = self.find_asset(owner, id).await?;
        let consumers: Vec<_> = {
            let registry = self.consumers.lock().map_err(|_| unavailable())?;
            if !registry.contains_key("overlay-studio") || !registry.contains_key("pet") { return Err(unavailable()); }
            registry.values().cloned().collect()
        };
        for consumer in consumers { if consumer.in_use(owner, id).await? { return Err(AssetError { code: "in_use", status: 409 }); } }
        self.records.update(doc! { "_id": owner, "assets.id": id }, doc! { "$set": { "assets.$.state": "deleting" } }, false).await?;
        self.remove_bytes(owner, &asset).await
    }
    /// Open a GridFS stream for a ready, owner-scoped asset.
    pub async fn read_asset(&self, owner: &str, id: &str) -> Result<(Asset, AssetReadStream), AssetError> {
        let asset = self.find_asset(owner, id).await?;
        let id = ObjectId::parse_str(id).map_err(|_| unavailable())?;
        let stream = self.ranges.open(id).await?;
        Ok((asset, stream))
    }
}

#[cfg(test)]
mod adapter_policy_tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn probe_rejects_oversized_stdout() {
        let error = read_probe_streams(Cursor::new(vec![1; 65_537]), Cursor::new(Vec::<u8>::new()), 65_536).await.expect_err("stdout overflow");
        assert_eq!((error.code, error.status), ("invalid_media", 415));
    }

    #[tokio::test]
    async fn probe_rejects_oversized_stderr() {
        let error = read_probe_streams(Cursor::new(Vec::<u8>::new()), Cursor::new(vec![1; 65_537]), 65_536).await.expect_err("stderr overflow");
        assert_eq!((error.code, error.status), ("invalid_media", 415));
    }

    #[tokio::test]
    async fn probe_accepts_independent_streams_above_combined_limit() {
        let stdout = vec![0x61; 40_000];
        let result = read_probe_streams(Cursor::new(stdout.clone()), Cursor::new(vec![0x62; 40_000]), 65_536).await.expect("independent caps");
        assert_eq!(result, stdout);
    }

    #[tokio::test]
    async fn probe_stream_limit_is_inclusive() {
        let output = vec![0x31; 65_536];
        assert_eq!(read_probe_streams(Cursor::new(output.clone()), Cursor::new(vec![0; 65_536]), 65_536).await.expect("exact limits"), output);
        assert!(read_probe_stream(Cursor::new(vec![0; 65_537]), 65_536).await.is_err());
    }
    #[test]
    fn recognizes_source_signatures() {
        assert_eq!(sniff_mime(&[137,80,78,71,13,10,26,10]), Some("image/png"));
        assert_eq!(sniff_mime(&[255,216,255]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF....WEBP"), Some("image/webp"));
        assert_eq!(sniff_mime(b"....ftyp"), Some("video/mp4"));
        assert_eq!(sniff_mime(&[26,69,223,163]), Some("video/webm"));
        assert_eq!(sniff_mime(b"RIFF....WAVE"), Some("audio/wav"));
        assert_eq!(sniff_mime(b"OggS"), Some("audio/ogg"));
        assert_eq!(sniff_mime(b"ID3"), Some("audio/mpeg"));
        assert_eq!(sniff_mime(b"unknown"), None);
    }
    #[test]
    fn validates_audio_probe() {
        assert!(parse_probe("audio/ogg", r#"{"streams":[{"codec_type":"audio","codec_name":"opus"}],"format":{"duration":"1.5"}}"#).is_ok());
        for probe in [r#"{"streams":[],"format":{"duration":"1"}}"#, r#"{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"1"}}"#, r#"{"streams":[{"codec_type":"audio","codec_name":"opus"}],"format":{"duration":"0"}}"#, r#"{"streams":[{"codec_type":"audio","codec_name":"opus"}],"format":{"duration":"601"}}"#, r#"{"streams":[{"codec_type":"audio","codec_name":"opus"},{"codec_type":"video"}],"format":{"duration":"2"}}"#] { assert!(parse_probe("audio/ogg", probe).is_err()); }
    }
    #[test]
    fn validates_video_probe() {
        assert!(parse_probe("video/mp4", r#"{"streams":[{"width":640,"height":480,"codec_name":"h264"}]}"#).is_ok());
        assert!(parse_probe("video/mp4", r#"{"streams":[{"width":0,"height":480,"codec_name":"h264"}]}"#).is_err());
        assert!(parse_probe("video/webm", r#"{"streams":[{"width":640,"height":480,"codec_name":"h264"}]}"#).is_err());
        for probe in [r#"{}"#, r#"{"streams":[]}"#, r#"{"streams":[{"width":2.5,"height":4}]}"#, r#"{"streams":[{"width":1,"height":16385}]}"#] {
            assert!(parse_probe("image/png", probe).is_err());
        }
        assert!(parse_probe("video/webm", r#"{"streams":[{"width":1,"height":1,"codec_name":"vp9"}]}"#).is_ok());
        assert!(parse_probe("video/mp4", r#"{"streams":[{"width":1,"height":1,"codec_name":"vp8"}]}"#).is_err());
    }
    #[test]
    fn audio_probe_rejects_nonfinite_missing_and_bad_streams() {
        for probe in [
            r#"not json"#,
            r#"{"streams":[{"codec_type":"audio","codec_name":"mp3"}]}"#,
            r#"{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"NaN"}}"#,
            r#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"1"}}"#,
            r#"{"streams":[{"codec_type":"video","codec_name":"mp3"}],"format":{"duration":"1"}}"#,
        ] { assert!(parse_probe("audio/mpeg", probe).is_err()); }
        assert!(parse_probe("audio/wav", r#"{"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}],"format":{"duration":"600"}}"#).is_ok());
    }
    #[test]
    fn cleans_names_and_computes_ceiling() {
        assert_eq!(sanitize_name("a/b\\c\u{7f}"), "a_b_c_");
        assert_eq!(sanitize_name(&"a".repeat(121)).len(), 120);
        assert_eq!(reservation_ceiling(100, 101), -1);
        assert_eq!(reservation_ceiling(100, 1), 99);
    }
}

/// Native consumer for pet appearance references in the application's Mongo data.
pub struct MongoPetConsumer { database: Database }
impl MongoPetConsumer {
    /// Construct from an existing database.
    pub fn new(database: Database) -> Self { Self { database } }
}
impl AssetConsumer for MongoPetConsumer {
    fn in_use<'a>(&'a self, owner: &'a str, id: &'a str) -> AssetFuture<'a, Result<bool, AssetError>> {
        Box::pin(async move {
            let user = self.database.collection::<Document>("users").find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": owner } } }).projection(doc! { "_id": 1 }).await.map_err(|_| unavailable())?;
            let Some(user_id) = user.and_then(|row| row.get("_id").cloned()) else { return Ok(false); };
            Ok(self.database.collection::<Document>("pet_settings").find_one(doc! { "userId": user_id, "$or": [{ "settings.appearance.idleAssetId": id }, { "settings.appearance.talkingAssetId": id }] }).await.map_err(|_| unavailable())?.is_some())
        })
    }
}

/// Native consumer for overlay scene, design and published snapshot references.
pub struct MongoOverlayConsumer { database: Database }
impl MongoOverlayConsumer {
    /// Construct from an existing database.
    pub fn new(database: Database) -> Self { Self { database } }
}
fn document_array<'a>(document: &'a Document, key: &str) -> impl Iterator<Item = &'a Document> {
    document.get_array(key).ok().into_iter().flatten().filter_map(Bson::as_document)
}
fn widget_ref(document: &Document, id: &str) -> bool { document.get_str("assetId").ok() == Some(id) }
fn layout_ref(document: &Document, id: &str) -> bool {
    document_array(document, "widgets").any(|widget| widget_ref(widget, id)) || document.get_document("sound").ok().is_some_and(|sound| widget_ref(sound, id))
}
fn design_ref(design: &Document, id: &str) -> bool {
    design.get_document("events").ok().is_some_and(|events| events.values().filter_map(Bson::as_document).any(|layout| layout_ref(layout, id))) ||
    design.get_document("variants").ok().is_some_and(|variants| variants.values().filter_map(Bson::as_array).flatten().filter_map(Bson::as_document).any(|variant| variant.get_document("layout").ok().is_some_and(|layout| layout_ref(layout, id))))
}
fn overlay_ref(state: &Document, id: &str) -> bool {
    document_array(state, "designs").any(|design| design_ref(design, id)) || document_array(state, "scenes").any(|scene| {
        document_array(scene, "widgets").any(|widget| widget_ref(widget, id)) || scene.get_document("published").ok().is_some_and(|published| {
            document_array(published, "widgets").any(|widget| widget_ref(widget, id)) || document_array(published, "designs").any(|design| design_ref(design, id))
        })
    })
}
impl AssetConsumer for MongoOverlayConsumer {
    fn in_use<'a>(&'a self, owner: &'a str, id: &'a str) -> AssetFuture<'a, Result<bool, AssetError>> {
        Box::pin(async move {
            let state = self.database.collection::<Document>("overlay_studios").find_one(doc! { "_id": owner }).await.map_err(|_| unavailable())?;
            Ok(state.as_ref().is_some_and(|state| overlay_ref(state, id)))
        })
    }
}

/// Inclusive chunk index bounds for a nonempty half-open byte interval.
pub fn chunk_bounds(start: u64, end: u64, chunk_size: u64) -> Result<(u64, u64), AssetError> {
    if chunk_size == 0 || start >= end { return Err(unavailable()); }
    Ok((start / chunk_size, (end - 1) / chunk_size))
}

/// Assemble a byte window from ordered, contiguous GridFS chunks.
pub fn assemble_chunk_window(start: u64, end: u64, chunk_size: u64, chunks: &[(u64, Vec<u8>)]) -> Result<Vec<u8>, AssetError> {
    let (first, last) = chunk_bounds(start, end, chunk_size)?;
    let mut out = Vec::new();
    for index in first..=last {
        let data = chunks.iter().find(|(number, _)| *number == index).map(|(_, bytes)| bytes).ok_or_else(unavailable)?;
        let chunk_start = index.checked_mul(chunk_size).ok_or_else(unavailable)?;
        let left = start.saturating_sub(chunk_start) as usize;
        let right = end.saturating_sub(chunk_start).min(chunk_size) as usize;
        if left > right || right > data.len() { return Err(unavailable()); }
        out.extend_from_slice(&data[left..right]);
    }
    if out.len() as u64 != end - start { return Err(unavailable()); }
    Ok(out)
}

/// An owned asynchronous GridFS byte reader.
pub type AssetReadStream = Pin<Box<dyn futures_util::io::AsyncRead + Send>>;

/// Injectable GridFS repository, backed in production by MongoDB.
pub trait GridFsRangeRepository: Send + Sync {
    /// Read the actual GridFS file length.
    fn length<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<u64, AssetError>>;
    /// Fetch one source window from an existing file.
    fn read_window<'a>(&'a self, id: ObjectId, start: u64, end: u64) -> AssetFuture<'a, Result<Vec<u8>, AssetError>>;
    /// Upload an asset file to the bucket.
    fn upload<'a>(&'a self, id: ObjectId, owner: &'a str, name: &'a str, mime: &'a str, path: &'a Path) -> AssetFuture<'a, Result<(), AssetError>>;
    /// Remove the file and any orphaned chunks.
    fn remove<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<(), AssetError>>;
    /// Open a full download stream.
    fn open<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<AssetReadStream, AssetError>>;
}
/// Concrete GridFS file and chunk collection reader.
pub struct MongoGridFsRangeRepository { database: Database }
impl MongoGridFsRangeRepository {
    /// Construct from an existing database without I/O.
    pub fn new(database: Database) -> Self { Self { database } }
}
impl GridFsRangeRepository for MongoGridFsRangeRepository {
    fn length<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<u64, AssetError>> {
        Box::pin(async move {
            let file = self.database.collection::<Document>("private_assets.files").find_one(doc! { "_id": id }).await.map_err(|_| unavailable())?.ok_or_else(unavailable)?;
            let length = file.get_i64("length").or_else(|_| file.get_i32("length").map(i64::from)).map_err(|_| unavailable())?;
            let length = u64::try_from(length).map_err(|_| unavailable())?;
            if length > MAX_ASSET_BYTES { return Err(unavailable()); }
            Ok(length)
        })
    }
    fn upload<'a>(&'a self, id: ObjectId, owner: &'a str, name: &'a str, mime: &'a str, path: &'a Path) -> AssetFuture<'a, Result<(), AssetError>> {
        Box::pin(async move {
            let bucket = self.database.gridfs_bucket(GridFsBucketOptions::builder().bucket_name("private_assets".to_owned()).build());
            let mut stream = bucket.open_upload_stream(name).id(Bson::ObjectId(id)).metadata(doc! { "owner": owner, "mime": mime }).await.map_err(|_| unavailable())?;
            let mut input = tokio::fs::File::open(path).await.map_err(|_| unavailable())?;
            let mut buffer = [0u8; 65536];
            loop {
                let count = input.read(&mut buffer).await.map_err(|_| unavailable())?;
                if count == 0 { break; }
                stream.write_all(&buffer[..count]).await.map_err(|_| unavailable())?;
            }
            stream.close().await.map_err(|_| unavailable())
        })
    }
    fn remove<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<(), AssetError>> {
        Box::pin(async move {
            self.database.collection::<Document>("private_assets.chunks").delete_many(doc! { "files_id": id }).await.map_err(|_| unavailable())?;
            self.database.collection::<Document>("private_assets.files").delete_one(doc! { "_id": id }).await.map_err(|_| unavailable())?;
            Ok(())
        })
    }
    fn open<'a>(&'a self, id: ObjectId) -> AssetFuture<'a, Result<AssetReadStream, AssetError>> {
        Box::pin(async move {
            let bucket = self.database.gridfs_bucket(GridFsBucketOptions::builder().bucket_name("private_assets".to_owned()).build());
            let stream = bucket.open_download_stream(Bson::ObjectId(id)).await.map_err(|_| unavailable())?;
            Ok(Box::pin(stream) as AssetReadStream)
        })
    }
    fn read_window<'a>(&'a self, id: ObjectId, start: u64, end: u64) -> AssetFuture<'a, Result<Vec<u8>, AssetError>> {
        Box::pin(async move {
            use futures_util::TryStreamExt;
            let file = self.database.collection::<Document>("private_assets.files").find_one(doc! { "_id": id }).await.map_err(|_| unavailable())?.ok_or_else(unavailable)?;
            let number = |key| file.get_i64(key).or_else(|_| file.get_i32(key).map(i64::from)).map_err(|_| unavailable());
            let length = u64::try_from(number("length")?).map_err(|_| unavailable())?;
            let size = u64::try_from(number("chunkSize")?).map_err(|_| unavailable())?;
            if length > MAX_ASSET_BYTES || size == 0 || size > MAX_ASSET_BYTES { return Err(unavailable()); }
            if start >= end || end > length { return Err(AssetError { code: "invalid_range", status: 416 }); }
            let (first, last) = chunk_bounds(start, end, size)?;
            let mut cursor = self.database.collection::<Document>("private_assets.chunks")
                .find(doc! { "files_id": id, "n": { "$gte": first as i64, "$lte": last as i64 } })
                .sort(doc! { "n": 1 }).await.map_err(|_| unavailable())?;
            let allocation = usize::try_from((end - start).min(length - start)).map_err(|_| unavailable())?;
            let mut output = Vec::with_capacity(allocation);
            let mut expected = first;
            while let Some(row) = cursor.try_next().await.map_err(|_| unavailable())? {
                let index = row.get_i64("n").or_else(|_| row.get_i32("n").map(i64::from)).map_err(|_| unavailable())?;
                let index = u64::try_from(index).map_err(|_| unavailable())?;
                if index != expected { return Err(unavailable()); }
                let data = row.get_binary_generic("data").map_err(|_| unavailable())?;
                let offset = index.checked_mul(size).ok_or_else(unavailable)?;
                let left = start.saturating_sub(offset) as usize;
                let right = end.saturating_sub(offset).min(size) as usize;
                if left > right || right > data.len() { return Err(unavailable()); }
                output.extend_from_slice(&data[left..right]);
                expected += 1;
            }
            if expected != last + 1 || output.len() != allocation { return Err(unavailable()); }
            Ok(output)
        })
    }
}

/// Validate ownership and fetch a selected byte interval using an injected reader.
pub async fn read_range_with<R: GridFsRangeRepository + ?Sized>(library: &AssetLibrary, repository: &R, owner: &str, id: &str, start: u64, end: u64) -> Result<Vec<u8>, AssetError> {
    library.find_asset(owner, id).await?;
    repository.read_window(ObjectId::parse_str(id).map_err(|_| unavailable())?, start, end).await
}

impl AssetLibrary {
    /// Read the actual GridFS length after owner-scoped access validation.
    pub async fn real_length(&self, owner: &str, id: &str) -> Result<u64, AssetError> {
        self.find_asset(owner, id).await?;
        self.ranges.length(ObjectId::parse_str(id).map_err(|_| unavailable())?).await
    }
    /// Read a half-open byte interval from only its GridFS chunks.
    pub async fn read_range(&self, owner: &str, id: &str, start: u64, end: u64) -> Result<Vec<u8>, AssetError> {
        read_range_with(self, self.ranges.as_ref(), owner, id, start, end).await
    }
}

/// Injectable record access for the source's `asset_libraries` collection.
pub trait AssetRecordRepository: Send + Sync {
    /// Find the user's quota tier through a Twitch account ID.
    fn find_user<'a>(&'a self, owner: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>>;
    /// Find an owner's library.
    fn find<'a>(&'a self, owner: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>>;
    /// Perform the source's atomic Mongo update and return its modified count.
    fn update<'a>(&'a self, filter: Document, update: Document, upsert: bool) -> AssetFuture<'a, Result<u64, AssetError>>;
}
/// Native Mongo-backed asset-library records.
pub struct MongoAssetRecordRepository { database: Database }
impl MongoAssetRecordRepository {
    /// Construct from an existing database without I/O.
    pub fn new(database: Database) -> Self { Self { database } }
}
impl AssetRecordRepository for MongoAssetRecordRepository {
    fn find_user<'a>(&'a self, owner: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>> {
        Box::pin(async move { self.database.collection::<Document>("users").find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": owner } } }).projection(doc! { "plan_tier": 1 }).await.map_err(|_| unavailable()) })
    }
    fn find<'a>(&'a self, owner: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>> {
        Box::pin(async move { self.database.collection::<Document>("asset_libraries").find_one(doc! { "_id": owner }).await.map_err(|_| unavailable()) })
    }
    fn update<'a>(&'a self, filter: Document, update: Document, upsert: bool) -> AssetFuture<'a, Result<u64, AssetError>> {
        Box::pin(async move { self.database.collection::<Document>("asset_libraries").update_one(filter, update).upsert(upsert).await.map(|result| result.modified_count).map_err(|_| unavailable()) })
    }
}

/// Find one raw library through a caller-supplied repository.
pub async fn find_library_with<R: AssetRecordRepository + ?Sized>(repository: &R, owner: &str) -> Result<Option<Document>, AssetError> {
    repository.find(owner).await
}

#[cfg(test)]
mod interval_and_utf16_tests {
    use super::*;
    use crate::utils::js_string::JsString;
    #[test]
    fn ranged_chunks_cover_the_requested_window() {
        assert_eq!(chunk_bounds(3, 7, 4).expect("range"), (0, 1));
        let chunks = vec![(0, b"abcd".to_vec()), (1, b"efgh".to_vec())];
        assert_eq!(assemble_chunk_window(3, 7, 4, &chunks).expect("chunks"), b"defg");
        assert!(assemble_chunk_window(3, 7, 4, &chunks[..1]).is_err());
    }
    #[test]
    fn names_slice_javascript_utf16_units() {
        let mut units = vec![b'a' as u16; 119];
        units.extend([0xd83d, 0xde00]);
        let sliced = sanitize_name_js(&JsString::from_units(units));
        assert_eq!(sliced.len(), 120);
        assert_eq!(sliced.units()[119], 0xd83d);
        let broken = JsString::from_units(vec![0xd800, b'/' as u16, b'a' as u16]);
        assert_eq!(sanitize_name_js(&broken).units(), vec![0xd800, b'_' as u16, b'a' as u16]);
    }
    #[test]
    fn recovery_iso_timestamp_and_invalid_dates() {
        assert_eq!(crate::utils::js_date::parse_date("2024-01-01T00:00:00.000Z"), Some(1_704_067_200_000));
        assert_eq!(crate::utils::js_date::parse_date("invalid"), None);
    }
}

#[cfg(test)]
mod embedded_asset_schema_tests {
    use super::*;
    #[test]
    fn partial_asset_is_accepted_without_invented_fields() {
        let empty = embedded_asset_schema().construct(&doc! {}, DateTime::from_millis(0)).expect("empty asset is valid");
        assert!(empty.is_empty());
        let input = doc! { "name": "fixture" };
        let cast = embedded_asset_schema().construct(&input, DateTime::from_millis(0)).expect("source schema accepts partial assets");
        assert_eq!(cast, input);
        assert_eq!(Asset::from_document(input.clone()).0, input);
        let lean = doc! { "name": Bson::Null, "unexpected": true };
        assert_eq!(Asset::from_document(lean.clone()).0, lean);
    }
    #[test]
    fn full_asset_is_accepted_and_casts_source_fields() {
        let input = doc! { "id":"asset", "name":"a.png", "kind":"image", "mime":"image/png", "bytes":"19", "width":1, "height":1, "duration":1.5, "createdAt":"2030-01-01T00:00:00.000Z", "state":"ready" };
        let cast = embedded_asset_schema().construct(&input, DateTime::from_millis(0)).expect("source asset casts");
        assert_eq!(cast.get_str("id").expect("id"), "asset");
        assert_eq!(cast.get_i32("bytes").expect("number cast"), 19);
        assert_eq!(Asset::from_document(cast.clone()).0, cast);
    }
    #[test]
    fn embedded_paths_are_optional_and_have_no_enum_validator() {
        let input = doc! { "id":Bson::Null, "kind":"other", "state":"other" };
        assert!(embedded_asset_schema().construct(&input, DateTime::from_millis(0)).is_ok());
        assert!(embedded_asset_schema().construct(&doc! { "bytes":"invalid" }, DateTime::from_millis(0)).is_err());
    }
}
