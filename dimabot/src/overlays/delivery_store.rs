//! MongoDB and GridFS delivery storage from `delivery-store.ts`.
//! Collection and bucket names, expiry metadata, and media limits follow the
//! source; the caller supplies an already configured database and clock.

use std::{fmt, path::Path};
use futures_util::{io::AsyncWriteExt, TryStreamExt};
use mongodb::{bson::{doc, Bson, DateTime, Document, oid::ObjectId}, gridfs::{GridFsBucket, GridFsDownloadStream}, options::GridFsBucketOptions, Collection, Database};
use tokio::io::AsyncReadExt;

/// Retained delivery lifetime in milliseconds.
pub const DELIVERY_TTL_MS: i64 = 30 * 60 * 1000;
/// Peer lease lifetime in milliseconds.
pub const LEASE_MS: i64 = 120_000;
/// Maximum pending deliveries per channel.
pub const MAX_PENDING: usize = 200;
/// Maximum size of one retained media file.
pub const MAX_MEDIA_BYTES: u64 = 100 * 1024 * 1024;
/// Maximum retained media bytes per channel.
pub const MAX_CHANNEL_BYTES: u64 = 512 * 1024 * 1024;
/// Collection containing persisted delivery documents.
pub const DELIVERY_COLLECTION: &str = "overlay_deliveries";
/// Collection containing persisted peer leases.
pub const LEASE_COLLECTION: &str = "overlay_source_leases";
/// GridFS bucket for retained playback files.
pub const MEDIA_BUCKET: &str = "overlay_media";
/// BSON delivery document, including its original field names and date types.
pub type SavedDelivery = Document;
/// BSON peer lease document, including its original field names and date types.
pub type SavedPeer = Document;
/// Delivery store operation failure, without captured credentials.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryStoreError { /// Error description.
    pub message: String }
impl fmt::Display for DeliveryStoreError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.message) } }
impl std::error::Error for DeliveryStoreError {}
fn failure(error: impl fmt::Display) -> DeliveryStoreError { DeliveryStoreError { message: error.to_string() } }
/// Whether a source file is within the source's inclusive media limit.
pub fn valid_media_size(bytes: u64) -> bool { bytes > 0 && bytes <= MAX_MEDIA_BYTES }
/// Whether a lease has reached its expiry instant.
pub fn lease_expired(expires_at_ms: i64, now_ms: i64) -> bool { expires_at_ms <= now_ms }
/// Result of retaining a media file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetainedFile { /// GridFS ObjectId hex.
    pub media_id: String, /// Number of bytes from the source stat.
    pub bytes: u64 }
/// A contiguous GridFS chunk, including its zero-based index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaChunk { /// Chunk index.
    pub index: u32, /// Unmodified chunk bytes.
    pub data: Vec<u8> }
/// Assemble the half-open `[start, end)` window from ordered GridFS chunks.
/// Missing, duplicated, truncated, or oversized chunks are rejected.
pub fn assemble_window(length: u64, chunk_size: u32, start: u64, end: u64, chunks: &[MediaChunk]) -> Result<Vec<u8>, DeliveryStoreError> {
    if chunk_size == 0 || start > end || end > length || length > MAX_MEDIA_BYTES {
        return Err(failure("Invalid GridFS byte range"));
    }
    if start == end { return Ok(Vec::new()); }
    let size = u64::from(chunk_size);
    let first = start / size;
    let last = (end - 1) / size;
    if chunks.len() as u64 != last - first + 1 { return Err(failure("Missing GridFS chunk")); }
    let mut output = Vec::with_capacity((end - start) as usize);
    for (offset, chunk) in chunks.iter().enumerate() {
        let index = first + offset as u64;
        if u64::from(chunk.index) != index { return Err(failure("Unexpected GridFS chunk")); }
        let chunk_start = index * size;
        let expected = (length - chunk_start).min(size) as usize;
        if chunk.data.len() != expected { return Err(failure("Invalid GridFS chunk length")); }
        let from = start.saturating_sub(chunk_start) as usize;
        let until = (end - chunk_start).min(size) as usize;
        output.extend_from_slice(&chunk.data[from..until]);
    }
    Ok(output)
}
/// Repository seam whose production implementation uses the concrete Mongo adapter.
pub trait DeliveryRepository: Sync {
    /// Read a bounded byte range.
    fn read_range(&self, id: &str, start: u64, end: Option<u64>) -> impl std::future::Future<Output = Result<Vec<u8>, DeliveryStoreError>> + Send;
    /// Retain a local file with the supplied clock.
    fn retain(&self, path: &Path, now_ms: i64) -> impl std::future::Future<Output = Result<RetainedFile, DeliveryStoreError>> + Send;
    /// Release a retained file.
    fn release(&self, id: &str) -> impl std::future::Future<Output = Result<(), DeliveryStoreError>> + Send;
    /// Sweep expired files and orphan chunks.
    fn sweep(&self, now_ms: i64) -> impl std::future::Future<Output = Result<(), DeliveryStoreError>> + Send;
    /// Read one delivery or source lease by ID.
    fn get_record(&self, lease: bool, id: &str) -> impl std::future::Future<Output = Result<Option<Document>, DeliveryStoreError>> + Send;
    /// List nonexpired delivery or lease documents for restoration.
    fn list_records(&self, lease: bool, now_ms: i64) -> impl std::future::Future<Output = Result<Vec<Document>, DeliveryStoreError>> + Send;
    /// Replace one delivery or lease, creating it when absent.
    fn put_record(&self, lease: bool, id: &str, value: Document) -> impl std::future::Future<Output = Result<(), DeliveryStoreError>> + Send;
    /// Delete one delivery or lease by ID.
    fn delete_record(&self, lease: bool, id: &str) -> impl std::future::Future<Output = Result<(), DeliveryStoreError>> + Send;
}
/// Read a range through an injected repository.
pub async fn read_range_with<R: DeliveryRepository>(repo: &R, id: &str, start: u64, end: Option<u64>) -> Result<Vec<u8>, DeliveryStoreError> {
    repo.read_range(id, start, end).await
}
/// Retain a file through an injected repository.
pub async fn retain_with<R: DeliveryRepository>(repo: &R, path: &Path, now_ms: i64) -> Result<RetainedFile, DeliveryStoreError> { repo.retain(path, now_ms).await }
/// Release a file through an injected repository.
pub async fn release_with<R: DeliveryRepository>(repo: &R, id: &str) -> Result<(), DeliveryStoreError> { repo.release(id).await }
/// Sweep files through an injected repository.
pub async fn sweep_with<R: DeliveryRepository>(repo: &R, now_ms: i64) -> Result<(), DeliveryStoreError> { repo.sweep(now_ms).await }
/// Read a delivery or lease through an injected repository.
pub async fn get_record_with<R: DeliveryRepository>(repo: &R, lease: bool, id: &str) -> Result<Option<Document>, DeliveryStoreError> { repo.get_record(lease, id).await }
/// List nonexpired deliveries or leases through an injected repository.
pub async fn list_records_with<R: DeliveryRepository>(repo: &R, lease: bool, now_ms: i64) -> Result<Vec<Document>, DeliveryStoreError> { repo.list_records(lease, now_ms).await }
/// Store a delivery or lease through an injected repository.
pub async fn put_record_with<R: DeliveryRepository>(repo: &R, lease: bool, id: &str, value: Document) -> Result<(), DeliveryStoreError> { repo.put_record(lease, id, value).await }
/// Delete a delivery or lease through an injected repository.
pub async fn delete_record_with<R: DeliveryRepository>(repo: &R, lease: bool, id: &str) -> Result<(), DeliveryStoreError> { repo.delete_record(lease, id).await }
/// Read a range through a concrete Mongo database.
pub async fn read_range(database: &Database, id: &str, start: u64, end: Option<u64>) -> Result<Vec<u8>, DeliveryStoreError> {
    read_range_with(&MongoDeliveryStore::new(database.clone()), id, start, end).await
}
/// Concrete Mongo and GridFS adapter, constructed without I/O.
#[derive(Clone)]
pub struct MongoDeliveryStore { database: Database, bucket: GridFsBucket }
impl MongoDeliveryStore {
    /// Use the supplied application database and the `overlay_media` bucket.
    pub fn new(database: Database) -> Self {
        let options = GridFsBucketOptions::builder().bucket_name(MEDIA_BUCKET.to_owned()).build();
        let bucket = database.gridfs_bucket(options);
        Self { database, bucket }
    }
    /// Access persisted delivery documents.
    pub fn deliveries(&self) -> Collection<Document> { self.database.collection(DELIVERY_COLLECTION) }
    /// Access persisted peer lease documents.
    pub fn leases(&self) -> Collection<Document> { self.database.collection(LEASE_COLLECTION) }
    /// Upload a bounded source file with its source-compatible expiry metadata.
    pub async fn retain_file(&self, path: &Path, now_ms: i64) -> Result<RetainedFile, DeliveryStoreError> {
        let bytes = tokio::fs::metadata(path).await.map_err(failure)?.len();
        if !valid_media_size(bytes) { return Err(DeliveryStoreError { message: "Overlay media exceeds the 100 MB playback limit".into() }); }
        let expires_at = now_ms.checked_add(DELIVERY_TTL_MS).ok_or_else(|| DeliveryStoreError { message: "Invalid expiry".into() })?;
        let mut file = tokio::fs::File::open(path).await.map_err(failure)?;
        let mut target = self.bucket.open_upload_stream("overlay-playback").metadata(doc! { "expiresAt": DateTime::from_millis(expires_at) }).await.map_err(failure)?;
        let id = match target.id() { Bson::ObjectId(id) => id.to_hex(), _ => { let _ = target.abort().await; return Err(DeliveryStoreError { message: "GridFS upload ID is not an ObjectId".into() }); } };
        let result: Result<(), DeliveryStoreError> = async {
            let mut buffer = [0_u8; 65536];
            loop {
                let count = file.read(&mut buffer).await.map_err(failure)?;
                if count == 0 { break; }
                target.write_all(&buffer[..count]).await.map_err(failure)?;
            }
            target.close().await.map_err(failure)
        }.await;
        if let Err(error) = result { let _ = target.abort().await; return Err(error); }
        Ok(RetainedFile { media_id: id, bytes })
    }
    /// Open a complete retained file; byte-range streaming is a separate integration task.
    pub async fn read_file_stream(&self, id: &str) -> Result<GridFsDownloadStream, DeliveryStoreError> {
        let id = ObjectId::parse_str(id).map_err(failure)?;
        self.bucket.open_download_stream(Bson::ObjectId(id)).await.map_err(failure)
    }
    /// Delete an upload and its chunks; a missing file is already released.
    pub async fn release_file(&self, id: &str) -> Result<(), DeliveryStoreError> {
        let id = ObjectId::parse_str(id).map_err(failure)?;
        match self.bucket.delete(Bson::ObjectId(id)).await {
            Ok(()) => Ok(()),
            Err(error) if matches!(error.kind.as_ref(), mongodb::error::ErrorKind::GridFs(mongodb::error::GridFsErrorKind::FileNotFound { .. })) => Ok(()),
            Err(error) => Err(failure(error)),
        }
    }
    /// Remove old orphan chunks and expired uploads, using the supplied clock.
    pub async fn sweep_files(&self, now_ms: i64) -> Result<(), DeliveryStoreError> {
        let files = self.database.collection::<Document>("overlay_media.files");
        let chunks = self.database.collection::<Document>("overlay_media.chunks");
        let seconds = now_ms.saturating_sub(DELIVERY_TTL_MS).div_euclid(1000).clamp(0, i64::from(u32::MAX)) as u32;
        let cutoff = ObjectId::from_parts(seconds, [0; 5], [0; 3]);
        let candidates = chunks.distinct("files_id", doc! { "files_id": { "$lt": cutoff } }).await.map_err(failure)?;
        for id in candidates {
            if files.find_one(doc! { "_id": id.clone() }).await.map_err(failure)?.is_none() {
                chunks.delete_many(doc! { "files_id": id }).await.map_err(failure)?;
            }
        }
        let mut cursor = files.find(doc! { "metadata.expiresAt": { "$lte": DateTime::from_millis(now_ms) } }).await.map_err(failure)?;
        while let Some(file) = cursor.try_next().await.map_err(failure)? {
            if let Ok(id) = file.get_object_id("_id") { self.release_file(&id.to_hex()).await?; }
        }
        Ok(())
    }
}
impl DeliveryRepository for MongoDeliveryStore {
    async fn retain(&self, path: &Path, now_ms: i64) -> Result<RetainedFile, DeliveryStoreError> { self.retain_file(path, now_ms).await }
    async fn release(&self, id: &str) -> Result<(), DeliveryStoreError> { self.release_file(id).await }
    async fn sweep(&self, now_ms: i64) -> Result<(), DeliveryStoreError> { self.sweep_files(now_ms).await }
    async fn get_record(&self, lease: bool, id: &str) -> Result<Option<Document>, DeliveryStoreError> {
        let collection = if lease { self.leases() } else { self.deliveries() };
        collection.find_one(doc! { "_id": id }).await.map_err(failure)
    }
    async fn list_records(&self, lease: bool, now_ms: i64) -> Result<Vec<Document>, DeliveryStoreError> {
        let collection = if lease { self.leases() } else { self.deliveries() };
        let mut cursor = collection.find(doc! { "expiresAt": { "$gt": DateTime::from_millis(now_ms) } }).sort(doc! { "expiresAt": 1 }).await.map_err(failure)?;
        let mut result = Vec::new();
        while let Some(value) = cursor.try_next().await.map_err(failure)? { result.push(value); }
        Ok(result)
    }
    async fn put_record(&self, lease: bool, id: &str, value: Document) -> Result<(), DeliveryStoreError> {
        if value.get_str("_id").ok() != Some(id) { return Err(failure("Record ID mismatch")); }
        let collection = if lease { self.leases() } else { self.deliveries() };
        collection.replace_one(doc! { "_id": id }, value).upsert(true).await.map_err(failure)?;
        Ok(())
    }
    async fn delete_record(&self, lease: bool, id: &str) -> Result<(), DeliveryStoreError> {
        let collection = if lease { self.leases() } else { self.deliveries() };
        collection.delete_one(doc! { "_id": id }).await.map_err(failure)?;
        Ok(())
    }
    async fn read_range(&self, id: &str, start: u64, end: Option<u64>) -> Result<Vec<u8>, DeliveryStoreError> {
        let id = ObjectId::parse_str(id).map_err(failure)?;
        let files = self.database.collection::<Document>("overlay_media.files");
        let file = files.find_one(doc! { "_id": id }).await.map_err(failure)?.ok_or_else(|| failure("GridFS file not found"))?;
        let length = match file.get("length") { Some(Bson::Int64(n)) if *n >= 0 => *n as u64, Some(Bson::Int32(n)) if *n >= 0 => *n as u64, _ => return Err(failure("Invalid GridFS length")) };
        let size = file.get_i32("chunkSize").map_err(failure)?;
        if size <= 0 { return Err(failure("Invalid GridFS chunk size")); }
        let end = end.unwrap_or(length);
        if start > end || end > length || length > MAX_MEDIA_BYTES { return Err(failure("Invalid GridFS byte range")); }
        if start == end { return Ok(Vec::new()); }
        let first = start / size as u64;
        let last = (end - 1) / size as u64;
        let first = i32::try_from(first).map_err(failure)?;
        let last = i32::try_from(last).map_err(failure)?;
        let collection = self.database.collection::<Document>("overlay_media.chunks");
        let mut cursor = collection.find(doc! { "files_id": id, "n": { "$gte": first, "$lte": last } }).sort(doc! { "n": 1 }).await.map_err(failure)?;
        let mut chunks = Vec::new();
        while let Some(row) = cursor.try_next().await.map_err(failure)? {
            let index = u32::try_from(row.get_i32("n").map_err(failure)?).map_err(failure)?;
            let data = row.get_binary_generic("data").map_err(failure)?.clone();
            chunks.push(MediaChunk { index, data });
        }
        assemble_window(length, size as u32, start, end, &chunks)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};
    #[derive(Default)]
    struct Fixture { rows: Mutex<BTreeMap<(bool, String), Document>> }
    impl DeliveryRepository for Fixture {
        async fn retain(&self, _: &Path, _: i64) -> Result<RetainedFile, DeliveryStoreError> { Ok(RetainedFile { media_id: "file".into(), bytes: 4 }) }
        async fn release(&self, _: &str) -> Result<(), DeliveryStoreError> { Ok(()) }
        async fn sweep(&self, _: i64) -> Result<(), DeliveryStoreError> { Ok(()) }
        async fn get_record(&self, lease: bool, id: &str) -> Result<Option<Document>, DeliveryStoreError> { Ok(self.rows.lock().map_err(|_| failure("fixture lock"))?.get(&(lease, id.into())).cloned()) }
        async fn list_records(&self, lease: bool, _: i64) -> Result<Vec<Document>, DeliveryStoreError> { Ok(self.rows.lock().map_err(|_| failure("fixture lock"))?.iter().filter(|((kind, _), _)| *kind == lease).map(|(_, value)| value.clone()).collect()) }
        async fn put_record(&self, lease: bool, id: &str, value: Document) -> Result<(), DeliveryStoreError> { self.rows.lock().map_err(|_| failure("fixture lock"))?.insert((lease, id.into()), value); Ok(()) }
        async fn delete_record(&self, lease: bool, id: &str) -> Result<(), DeliveryStoreError> { self.rows.lock().map_err(|_| failure("fixture lock"))?.remove(&(lease, id.into())); Ok(()) }
        async fn read_range(&self, _: &str, start: u64, end: Option<u64>) -> Result<Vec<u8>, DeliveryStoreError> {
            let end = end.unwrap_or(4); assemble_window(4, 4, start, end, &[MediaChunk { index: 0, data: b"abcd".to_vec() }])
        }
    }
    #[test]
    fn media_size_boundaries_match_source() {
        assert!(!valid_media_size(0)); assert!(valid_media_size(1));
        assert!(valid_media_size(MAX_MEDIA_BYTES)); assert!(!valid_media_size(MAX_MEDIA_BYTES + 1));
    }
    #[test]
    fn leases_expire_at_boundary() {
        assert!(!lease_expired(10, 9)); assert!(lease_expired(10, 10));
    }
    #[test]
    fn reads_a_window_inside_one_chunk() {
        let chunks = vec![MediaChunk { index: 0, data: b"abcd".to_vec() }];
        assert_eq!(assemble_window(8, 4, 1, 3, &chunks).expect("valid range"), b"bc");
    }
    #[test]
    fn reads_a_window_across_a_chunk_boundary() {
        let chunks = vec![MediaChunk { index: 0, data: b"abcd".to_vec() }, MediaChunk { index: 1, data: b"efgh".to_vec() }];
        assert_eq!(assemble_window(8, 4, 2, 6, &chunks).expect("valid range"), b"cdef");
        assert!(assemble_window(8, 4, 2, 6, &chunks[..1]).is_err());
    }
    #[tokio::test]
    async fn generic_repository_operations_use_the_supplied_adapter() {
        let repo = Fixture::default();
        let retained = retain_with(&repo, Path::new("fixture"), 0).await.expect("retain");
        assert_eq!(retained.bytes, 4);
        assert_eq!(read_range_with(&repo, "file", 1, Some(3)).await.expect("range"), b"bc");
        put_record_with(&repo, false, "a", doc! { "_id": "a" }).await.expect("put delivery");
        put_record_with(&repo, true, "a", doc! { "_id": "a" }).await.expect("put lease");
        assert!(get_record_with(&repo, false, "a").await.expect("get").is_some());
        assert_eq!(list_records_with(&repo, true, 0).await.expect("list").len(), 1);
        delete_record_with(&repo, false, "a").await.expect("delete");
        assert!(get_record_with(&repo, false, "a").await.expect("get").is_none());
        release_with(&repo, "file").await.expect("release");
        sweep_with(&repo, 0).await.expect("sweep");
    }
}
