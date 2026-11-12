//! Media thumbnails, ported from `utils/thumbnail_generator.ts` (`generateAndStoreThumbnail`,
//! `scheduleThumbnailGeneration`).
//!
//! [`Thumbnails::generate_and_store`] does what the reference does, in its order: read the
//! parent asset (missing: nothing); already `ready` with a thumbnail id: nothing; audio: `$set`
//! `skipped` unless `ready`; otherwise `$inc` the attempts and `$set` `pending`, fetch the source,
//! run ffmpeg, check the output, upload `library/thumbnails/<16 hex>.jpg` (`image/jpeg`,
//! `public-read`, `public, max-age=31536000, immutable`), create the `media_assets` document
//! (`scope: system`, `<originalName>.thumb.jpg`, `<displayName> (thumbnail)`...) and `$set` the
//! parent `ready` with its id. A failure in that last part `$set`s the parent `failed` with the
//! message; reads and writes before it propagate as errors, as the reference's did. The upload
//! request and the documents are compared with recordings of the reference
//! (`tests/thumbnails-reference.json`, `tests/record-thumbnails.mts`).
//!
//! `scheduleThumbnailGeneration` is not a separate function: callers (`trigger.route.ts:602`,
//! `dimafx.route.ts:113`) spawn this future on a task they own, and the migration script awaits
//! it. There is no hidden background task.
//!
//! Concurrency: the reference's `p-limit(2)` becomes `concurrency` slots, and its unbounded wait
//! a bounded queue: a call beyond `max_waiting` waiting callers is refused with [`Error::Busy`]
//! and changes nothing (the parent keeps its status, so a later call can do it).
//!
//! Differences on purpose (security and bounds):
//! - The source is read through the S3 client by the parent's `s3Key` (the configured bucket must
//!   match the stored `bucket`), not by fetching the stored `storageUrl`: no stored URL is
//!   requested. In the production copy every `storageUrl` is the public URL of its `s3Key`.
//!   Its size limit (200 MiB, the reference's) is enforced on the body, not only on
//!   `content-length`; the S3 time limit is `s3_timeout` (the reference had none).
//! - ffmpeg is a [`Program`] at a configured absolute path, with an empty environment, a private
//!   run directory `thumb-<24 hex>` (mode 0700) in the configured temporary directory as working
//!   directory, the reference's 30 s limit and 8 MiB output cap (on both streams together; the
//!   reference's was per stream), and the group killed at the limits or when the caller drops
//!   the future. Arguments: video `-y -protocol_whitelist file -ss 00:00:01 -i file:in -vframes 1
//!   -vf scale=480:-1 -q:v 5 file:out.jpg`; image and GIF the same without `-ss 00:00:01` and
//!   `-vframes 1`. Nothing from outside reaches them: the names are fixed and `file:` stops ffmpeg
//!   reading a name as another protocol or an option. `-protocol_whitelist file` keeps an
//!   uploaded playlist (HLS, concat) from making ffmpeg open network URLs.
//! - The output must be a regular file of 256 bytes (the reference's floor) to
//!   `max_thumbnail_bytes`, starting with the JPEG signature; anything else, a missing file
//!   included (the reference stored the `stat` ENOENT message there), is "ffmpeg produced an
//!   empty/invalid output".
//! - A failed ffmpeg run stores `Command failed: ffmpeg <args>\n<stderr>` as Node's `execFile`
//!   did, with the Rust arguments and at most the last 16 KiB of stderr (the reference stored up
//!   to 8 MiB); a time or output limit stores the reason instead of stderr.
//! - No half-written asset: when the upload succeeds and the document create fails, the object
//!   is deleted; when the parent's final `$set` fails, the parent is read again and, unless it
//!   already points at the new thumbnail, the thumbnail document and object are deleted (best
//!   effort, under the deadlines) before the failure is recorded. When that `$set` matches no
//!   document (the parent was deleted meanwhile; the reference left an orphan thumbnail), the
//!   thumbnail is deleted the same way and the outcome is `Failed`.
//!
//! Quirk kept: two calls for the same parent at once both generate (the reference's comment says
//! otherwise; nothing fences it), and the last `$set` wins, leaving the other thumbnail unused.
//!
//! Callers supply typed configuration, the store, the S3 client, the clock and the randomness.
use crate::process::{self, Invocation, Program, RunDir};
use crate::s3;
use bson::{Bson, Document, doc, oid::ObjectId};
use bytes::Bytes;
use dima_core::{Clock, Random};
use dima_model::channel_extension_items::MediaType;
use dima_model::media_assets::{
    AssetScope, INFO, MarketplaceStatus, MediaAsset, NewMediaAsset, ThumbnailStatus,
};
use dima_model::values::Nullable;
use dima_model::{Open, UpdateOptions};
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::write::UpdateOutcome;
use dima_store::mongo::{MongoStore, WriteContext};
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const THUMB_WIDTH: u32 = 480;
const THUMB_JPEG_QUALITY: u32 = 5;
const MIN_OUTPUT_BYTES: u64 = 256;
const MAX_STORED_STDERR: usize = 16 * 1024;
const INVALID_OUTPUT: &str = "ffmpeg produced an empty/invalid output";
const INPUT: &str = "in";
const OUTPUT: &str = "out.jpg";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid thumbnail configuration: {0}")]
    Config(&'static str),
    #[error("thumbnail queue is full")]
    Busy,
    #[error("thumbnail store operation exceeded its deadline")]
    Timeout,
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    #[error(transparent)]
    Decode(#[from] dima_model::DecodeError),
    #[error(transparent)]
    Write(#[from] dima_store::mongo::write::WriteError),
    #[error(transparent)]
    Mongo(#[from] mongodb::error::Error),
}

/// Startup configuration (from the process's typed settings, never read here).
#[derive(Clone, Debug)]
pub struct Config {
    /// Absolute path of `ffmpeg`.
    pub ffmpeg: PathBuf,
    /// Where each run gets its private directory (reference: `os.tmpdir()`).
    pub temp_dir: PathBuf,
    /// The bucket the S3 client uses, stored in `bucket` (reference: `S3_BUCKET || ''`).
    pub bucket: String,
    /// ffmpeg time limit; reference 30 s.
    pub timeout: Duration,
    /// ffmpeg captured output; reference 8 MiB (per stream there, both together here).
    pub max_output: usize,
    /// Largest source; reference 200 MiB.
    pub max_input_bytes: u64,
    /// Largest thumbnail accepted from ffmpeg (a 480 px JPEG is tens of KiB).
    pub max_thumbnail_bytes: u64,
    /// Thumbnails generated at once; reference `p-limit(2)`.
    pub concurrency: usize,
    /// Callers that may wait for a slot before [`Error::Busy`]; the reference had no bound.
    pub max_waiting: usize,
    /// Each S3 request (source read, upload, cleanup); the reference had none.
    pub s3_timeout: Duration,
    /// Each MongoDB operation; the reference had none.
    pub store_deadline: Duration,
}

impl Config {
    /// The reference's limits with the stated defaults for what it lacked.
    pub fn new(ffmpeg: PathBuf, temp_dir: PathBuf, bucket: String) -> Self {
        Self {
            ffmpeg,
            temp_dir,
            bucket,
            timeout: Duration::from_secs(30),
            max_output: 8 * 1024 * 1024,
            max_input_bytes: 200 * 1024 * 1024,
            max_thumbnail_bytes: 10 * 1024 * 1024,
            concurrency: 2,
            max_waiting: 256,
            s3_timeout: Duration::from_secs(120),
            store_deadline: Duration::from_secs(10),
        }
    }
}

/// What a call did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No asset with that id.
    NotFound,
    /// The asset already has a ready thumbnail.
    AlreadyReady,
    /// Audio: marked `skipped`.
    Skipped,
    /// Generated and linked.
    Ready { thumbnail_id: ObjectId },
    /// Generation failed; the parent is `failed` with this message (the reference logged it).
    Failed { message: String },
}

#[derive(Clone, Debug)]
pub struct Thumbnails {
    store: MongoStore,
    s3: Arc<s3::Client>,
    ffmpeg: Program,
    temp_dir: PathBuf,
    config: Config,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    admission: Arc<Semaphore>,
    slots: Arc<Semaphore>,
}

impl Thumbnails {
    /// Checks the configuration at startup: ffmpeg (absolute, executable regular file), the
    /// temporary directory (absolute, an existing directory, symlinks resolved now) and limits.
    pub fn new(
        store: MongoStore,
        s3: Arc<s3::Client>,
        config: Config,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
    ) -> Result<Self, Error> {
        if config.timeout.is_zero()
            || config.max_output == 0
            || config.max_input_bytes == 0
            || config.max_thumbnail_bytes < MIN_OUTPUT_BYTES
            || config.concurrency == 0
            || config.s3_timeout.is_zero()
            || config.store_deadline.is_zero()
        {
            return Err(Error::Config("limits must be non-zero"));
        }
        let ffmpeg = Program::new(&config.ffmpeg).map_err(|_| Error::Config("ffmpeg"))?;
        if !config.temp_dir.is_absolute() {
            return Err(Error::Config("temporary directory must be absolute"));
        }
        let temp_dir = std::fs::canonicalize(&config.temp_dir)
            .map_err(|_| Error::Config("temporary directory"))?;
        if !std::fs::metadata(&temp_dir).is_ok_and(|m| m.is_dir()) {
            return Err(Error::Config("temporary directory"));
        }
        let admission = config
            .concurrency
            .checked_add(config.max_waiting)
            .filter(|n| *n <= Semaphore::MAX_PERMITS)
            .ok_or(Error::Config("queue bound"))?;
        Ok(Self {
            store,
            s3,
            ffmpeg,
            temp_dir,
            admission: Arc::new(Semaphore::new(admission)),
            slots: Arc::new(Semaphore::new(config.concurrency)),
            config,
            clock,
            random,
        })
    }

    /// `generateAndStoreThumbnail` (see the module documentation). Await it, or spawn it on a
    /// task the caller owns where the reference called `scheduleThumbnailGeneration`.
    pub async fn generate_and_store(&self, parent_id: ObjectId) -> Result<Outcome, Error> {
        let _admitted = self.admission.try_acquire().map_err(|_| Error::Busy)?;
        let _slot = self.slots.acquire().await.map_err(|_| Error::Busy)?;
        self.run(parent_id).await
    }

    async fn run(&self, parent_id: ObjectId) -> Result<Outcome, Error> {
        let Some(parent) = self.find(parent_id).await? else {
            return Ok(Outcome::NotFound);
        };
        if matches!(parent.thumbnail_status, Open::Known(ThumbnailStatus::Ready))
            && parent.thumbnail_asset_id.is_some()
        {
            return Ok(Outcome::AlreadyReady);
        }
        if matches!(parent.media_type, Open::Known(MediaType::Audio)) {
            self.update(
                doc! { "_id": parent.id, "thumbnailStatus": { "$ne": "ready" } },
                doc! { "$set": { "thumbnailStatus": "skipped", "thumbnailLastError": Bson::Null } },
            )
            .await?;
            return Ok(Outcome::Skipped);
        }
        self.update(
            doc! { "_id": parent.id },
            doc! { "$inc": { "thumbnailAttempts": 1 }, "$set": { "thumbnailStatus": "pending" } },
        )
        .await?;
        let generated = match RunDir::create(&self.temp_dir, "thumb", self.random.as_ref()).await {
            Ok(run) => {
                let generated = self.generate(&run, &parent).await;
                run.remove().await;
                generated
            }
            Err(e) => Err(e.to_string()),
        };
        match generated {
            Ok(thumbnail_id) => Ok(Outcome::Ready { thumbnail_id }),
            Err(message) => {
                self.update(
                    doc! { "_id": parent.id },
                    doc! { "$set": { "thumbnailStatus": "failed", "thumbnailLastError": &message } },
                )
                .await?;
                Ok(Outcome::Failed { message })
            }
        }
    }

    /// The reference's `try` block: everything that marks the parent `failed` on error.
    async fn generate(&self, run: &RunDir, parent: &MediaAsset) -> Result<ObjectId, String> {
        self.fetch_source(run, parent).await?;
        let thumbnail = self.render(run, parent).await?;
        let key = format!(
            "library/thumbnails/{}.jpg",
            self.random.hex_token(8).map_err(|e| e.to_string())?
        );
        let length = thumbnail.len();
        self.s3
            .put(
                &key,
                thumbnail,
                s3::PutOptions {
                    content_type: "image/jpeg",
                    cache_control: Some("public, max-age=31536000, immutable"),
                    public_read: true,
                },
                self.s3_limits(self.config.max_thumbnail_bytes),
            )
            .await
            .map_err(|e| e.to_string())?;
        let thumbnail_id = match self.create_asset(parent, &key, length).await {
            Ok(id) => id,
            Err(message) => {
                self.delete_object(&key).await;
                return Err(message);
            }
        };
        let linked = self
            .update(
                doc! { "_id": parent.id },
                doc! { "$set": {
                    "thumbnailAssetID": thumbnail_id,
                    "thumbnailStatus": "ready",
                    "thumbnailLastError": Bson::Null,
                } },
            )
            .await;
        let failure = match linked {
            Ok(outcome) if outcome.matched > 0 => return Ok(thumbnail_id),
            // Deleted while its thumbnail was made: the reference left an orphan thumbnail.
            Ok(_) => "Parent asset no longer exists".to_owned(),
            Err(error) => {
                // The write may have landed before the error (a deadline, a lost reply).
                if let Ok(Some(now)) = self.find(parent.id).await
                    && now.thumbnail_asset_id == Some(thumbnail_id)
                {
                    return Ok(thumbnail_id);
                }
                error.to_string()
            }
        };
        let _ = self
            .bounded(async {
                self.store
                    .documents(INFO.name)
                    .delete_one(doc! { "_id": thumbnail_id })
                    .await
                    .map_err(Error::from)
            })
            .await;
        self.delete_object(&key).await;
        Err(failure)
    }

    async fn fetch_source(&self, run: &RunDir, parent: &MediaAsset) -> Result<(), String> {
        if parent.bucket != self.config.bucket {
            return Err("Source is not in the configured bucket".into());
        }
        let response = match self
            .s3
            .get(&parent.s3_key, self.s3_limits(self.config.max_input_bytes))
            .await
        {
            Ok(response) => response,
            Err(s3::Error::NotFound) => return Err("Failed to fetch source: HTTP 404".into()),
            Err(s3::Error::AccessDenied) => return Err("Failed to fetch source: HTTP 403".into()),
            Err(s3::Error::Service { status, .. }) => {
                return Err(format!("Failed to fetch source: HTTP {status}"));
            }
            Err(e) => return Err(e.to_string()),
        };
        let too_large = |n: u64| format!("Source too large for thumbnail ({n} bytes)");
        if let Some(n) = response.content_length()
            && n > self.config.max_input_bytes
        {
            return Err(too_large(n));
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(run.path.join(INPUT))
            .await
            .map_err(|e| e.to_string())?;
        match response.write_to(&mut file).await {
            Ok(_) => Ok(()),
            Err(dima_http::Error::BodyTooLarge { limit, .. }) => Err(format!(
                "Source too large for thumbnail (over {limit} bytes)"
            )),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn render(&self, run: &RunDir, parent: &MediaAsset) -> Result<Bytes, String> {
        let scale = format!("scale={THUMB_WIDTH}:-1");
        let quality = THUMB_JPEG_QUALITY.to_string();
        let input = format!("file:{INPUT}");
        let output = format!("file:{OUTPUT}");
        let args: Vec<&str> = if matches!(parent.media_type, Open::Known(MediaType::Video)) {
            vec![
                "-y",
                "-protocol_whitelist",
                "file",
                "-ss",
                "00:00:01",
                "-i",
                &input,
                "-vframes",
                "1",
                "-vf",
                &scale,
                "-q:v",
                &quality,
                &output,
            ]
        } else {
            vec![
                "-y",
                "-protocol_whitelist",
                "file",
                "-i",
                &input,
                "-vf",
                &scale,
                "-q:v",
                &quality,
                &output,
            ]
        };
        let command = format!("Command failed: ffmpeg {}", args.join(" "));
        let invocation = Invocation {
            args: args.iter().map(OsString::from).collect(),
            env: Vec::new(),
            cwd: &run.path,
            timeout: self.config.timeout,
            max_output: self.config.max_output,
        };
        match self.ffmpeg.run(invocation).await {
            Ok(_) => {}
            Err(process::Error::Failed { stderr, .. }) => {
                return Err(format!(
                    "{command}\n{}",
                    process::tail_text(&stderr, MAX_STORED_STDERR)
                ));
            }
            Err(e) => return Err(format!("{command}\n{e}")),
        }
        let path = run.path.join(OUTPUT);
        let fits = |n: u64| (MIN_OUTPUT_BYTES..=self.config.max_thumbnail_bytes).contains(&n);
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| INVALID_OUTPUT.to_owned())?;
        if !meta.file_type().is_file() || !fits(meta.len()) {
            return Err(INVALID_OUTPUT.into());
        }
        // The run directory is private and ffmpeg's group is dead: nothing can swap the file.
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        if !fits(bytes.len() as u64) || !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            return Err(INVALID_OUTPUT.into());
        }
        Ok(Bytes::from(bytes))
    }

    async fn create_asset(
        &self,
        parent: &MediaAsset,
        key: &str,
        length: usize,
    ) -> Result<ObjectId, String> {
        let asset = NewMediaAsset {
            legacy_trigger_file_id: Nullable::Unset,
            owner_user_id: parent.owner_user_id.clone(),
            owner_channel_id: parent.owner_channel_id.clone(),
            owner_channel_name: parent.owner_channel_name.clone(),
            uploaded_by_user_id: parent.uploaded_by_user_id.clone(),
            original_name: format!("{}.thumb.jpg", parent.original_name),
            display_name: format!("{} (thumbnail)", parent.display_name),
            file_name: format!("{}.thumb.jpg", parent.file_name),
            extension: "jpg".into(),
            mime_type: "image/jpeg".into(),
            media_type: MediaType::Image,
            bytes: JsNumber(length as f64),
            bucket: self.config.bucket.clone(),
            s3_key: key.into(),
            storage_url: self.s3.public_object_url(key),
            proxy_path: Nullable::Null,
            scope: AssetScope::System,
            marketplace_status: Some(MarketplaceStatus::NotListed),
            checksum_sha256: Nullable::Null,
            thumbnail_asset_id: Nullable::Unset,
            thumbnail_status: None,
            thumbnail_attempts: None,
            thumbnail_last_error: Nullable::Unset,
            library_count: Some(JsNumber(0.0)),
            trigger_reference_count: Some(JsNumber(0.0)),
            alert_reference_count: Some(JsNumber(0.0)),
            extension_reference_count: Some(JsNumber(0.0)),
            deleted_at: Nullable::Null,
        };
        let prepared = asset
            .prepare(&mut WriteContext::new(self.clock.now_ms()))
            .map_err(|e| e.to_string())?;
        let id = prepared
            .document
            .get_object_id("_id")
            .map_err(|e| e.to_string())?;
        self.bounded(async { Ok(self.store.writes(INFO.name).insert_one(&prepared).await?) })
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    async fn find(&self, id: ObjectId) -> Result<Option<MediaAsset>, Error> {
        let found = self
            .bounded(async {
                Ok(self
                    .store
                    .documents(INFO.name)
                    .find_one(doc! { "_id": id })
                    .await?)
            })
            .await?;
        Ok(match found {
            Some(document) => Some(dima_model::decode_document(&document)?),
            None => None,
        })
    }

    async fn update(&self, filter: Document, update: Document) -> Result<UpdateOutcome, Error> {
        let prepared = INFO.prepare_update(
            &filter,
            update,
            UpdateOptions::default(),
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        self.bounded(async { Ok(self.store.writes(INFO.name).update_one(&prepared).await?) })
            .await
    }

    async fn delete_object(&self, key: &str) {
        let _ = self.s3.delete(key, self.s3_limits(65536)).await;
    }

    async fn bounded<T>(&self, work: impl Future<Output = Result<T, Error>>) -> Result<T, Error> {
        tokio::time::timeout(self.config.store_deadline, work)
            .await
            .map_err(|_| Error::Timeout)?
    }

    fn s3_limits(&self, max_bytes: u64) -> s3::Limits {
        s3::Limits {
            max_bytes,
            timeout: self.config.s3_timeout,
        }
    }
}
