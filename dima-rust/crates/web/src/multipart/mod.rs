//! Multipart uploads equal to multer 1.4.5-lts.2 (over busboy 1.6.0) as the reference uses it:
//! `multer({ storage, fileFilter, limits }).single(field)`, with disk storage or a streaming
//! storage engine of the handler's own.
//!
//! ```
//! use std::time::Duration;
//!
//! use dima_web::multipart::{DiskStorage, Limits, Multer, UploadError};
//! use dima_web::{Envelope, Req, Response};
//! use serde_json::json;
//!
//! // POST /triggers/library/:channelID/upload (trigger.route.ts:482).
//! async fn upload(req: &mut Req) -> Response {
//!     let allowed = ["video/mp4", "image/png", "audio/mpeg"];
//!     let multer = Multer::new(DiskStorage::new(std::env::temp_dir().join("dimabot-trigger-uploads")))
//!         .file_filter(move |file| Ok(allowed.contains(&file.mimetype.as_str())))
//!         .limits(Limits { file_size: Some(5 * 1024 * 1024), ..Limits::default() });
//!     match multer.single("trigger").run(req).await {
//!         Err(_) => Envelope::fail(400, "Error uploading file").reply(),
//!         Ok(None) => Envelope::fail(400, "No file uploaded or invalid file type").reply(),
//!         Ok(Some(file)) => Envelope::ok("Uploaded")
//!             .data(json!({ "name": req.body()["name"], "size": file.size() }))
//!             .reply(),
//!     }
//! }
//! # let _ = (upload, Duration::ZERO, UploadError::TimedOut);
//! ```
//!
//! Behaviour, as in multer:
//!
//! - Only requests with a body and a `multipart/*` type are read; others continue untouched.
//!   `req.body` becomes the text fields (append-field rules), even when the upload then fails.
//! - Each file goes through the filter (`Ok(false)` drops it silently) and then to the storage
//!   as it arrives; a file part with an empty file name, and parts without `form-data`
//!   disposition, are skipped. A file under another field name, or a second one, is
//!   `LIMIT_UNEXPECTED_FILE`.
//! - Limits with multer's codes: `fileSize` (a file reaching it, even exactly, is
//!   `LIMIT_FILE_SIZE`), `files`, `fields`, `parts` (the n-th delimiter after the first, so
//!   `parts: 2` allows one part), `fieldSize` (1 MiB by default; reaching it is
//!   `LIMIT_FIELD_VALUE`), `fieldNameSize`; a field without a name is `MISSING_FIELD_NAME`.
//! - Not in multer, bounds of this crate ([`Budget`]): bytes on the wire
//!   ([`Limits::body_size`]), bytes of all text fields ([`Limits::fields_size`]), parts of any
//!   kind ([`Limits::max_parts`]), and field-name nesting and array slots
//!   ([`fields::MAX_DEPTH`], [`fields::MAX_SLOTS`]). Each is checked before the bytes or values
//!   it is about are buffered; multer has none of them and reads on until the request times out.
//! - busboy's own errors: `Malformed content type`, `Unsupported content type`,
//!   `Multipart: Boundary not found`, `Malformed part header`, `Unexpected end of form`.
//! - On any error every stored file is removed through the storage before the error is
//!   returned. Unlike multer, a partly written file (client gone, storage failure, deadline) is
//!   removed too, and so is every stored file when the upload's future is dropped before a file
//!   was handed over (the client went away and hyper dropped the handler, or the handler gave
//!   up): the removal then runs on a spawned task, which [`crate::serve`]'s shutdown waits for
//!   (up to its drain deadline). A removal that fails is reported, never dropped: to the route's
//!   [`Multer::on_cleanup_error`] hook and to the app's [`crate::Observer::on_cleanup_error`]
//!   (and counted in [`crate::ObserverQueue::cleanup_failures`]). A file already gone counts as
//!   removed.
//! - Field names and file names are header text, read as latin1 like multer does (no
//!   `defParamCharset`): a UTF-8 file name arrives as mojibake (`😀` becomes `ð\u{9f}\u{98}\u{80}`).
//!   `filename*=utf-8''…` is decoded. Field values are UTF-8.

pub mod fields;
mod parse;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use std::panic::AssertUnwindSafe;

use bytes::Bytes;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt as _;
use tokio_util::task::TaskTracker;

use crate::error::Error;
use crate::exchange::ObserverHub;
use crate::handler::{BoxFuture, Flow, Handler};
use crate::mediatype::type_is;
use crate::request::{BodyState, Req};
use parse::{Item, Part, ScanError, Scanner};

/// Bytes still read off a rejected upload so the client sees the answer (as body parsers do).
const DRAIN_BUDGET: u64 = 64 * 1024 * 1024;

/// multer's limits; `None` is unlimited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// `fieldNameSize`: longest field name, in UTF-16 units (multer checks only when set).
    pub field_name_size: Option<usize>,
    /// `fieldSize`: bytes of one text field (1 MiB by default).
    pub field_size: u64,
    /// `fields`: text fields.
    pub fields: Option<usize>,
    /// `fileSize`: bytes of one file.
    pub file_size: Option<u64>,
    /// `files`: file parts.
    pub files: Option<usize>,
    /// `parts`: delimiters after the first (so the number of parts must stay below it).
    pub parts: Option<usize>,
    /// Not in multer: bytes of the whole body on the wire. `None` allows the file size plus
    /// `fields_size` plus 1 MiB for part headers and delimiters, or [`DEFAULT_WIRE_BUDGET`]
    /// (32 MiB in all) when `file_size` is unset. Past it the rest is left unread and the upload
    /// fails with [`Budget::Body`]. A route that takes larger uploads states its limits.
    pub body_size: Option<u64>,
    /// Not in multer: bytes of all text fields together, names included ([`DEFAULT_FIELDS_SIZE`]
    /// by default), counted as the UTF-8 text that is kept: a value is charged as it is read and
    /// then again at its decoded size, which is larger for latin1 and for invalid UTF-8 (each
    /// bad byte becomes a three-byte U+FFFD). Past it the upload fails with [`Budget::Fields`].
    pub fields_size: u64,
    /// Not in multer: parts of any kind (text fields, files, skipped parts) one form may have
    /// ([`DEFAULT_MAX_PARTS`] by default). One more fails the upload with [`Budget::Parts`].
    pub max_parts: usize,
}

/// The default [`Limits::fields_size`]: 4 MiB.
pub const DEFAULT_FIELDS_SIZE: u64 = 4 * 1024 * 1024;

/// The default [`Limits::max_parts`] (body-parser's `parameterLimit` for urlencoded forms).
pub const DEFAULT_MAX_PARTS: usize = 1000;

/// The wire budget ([`Limits::wire_budget`]) when neither `body_size` nor `file_size` is set:
/// 32 MiB.
pub const DEFAULT_WIRE_BUDGET: u64 = 32 * 1024 * 1024;

/// Earlier, the file size [`Limits::body_size`] assumed when `file_size` was unset (1 GiB). No
/// longer used: without a file size the wire budget is [`DEFAULT_WIRE_BUDGET`].
#[deprecated(note = "without a file size the wire budget is DEFAULT_WIRE_BUDGET")]
pub const DEFAULT_FILE_BUDGET: u64 = 1024 * 1024 * 1024;

/// What [`Limits::body_size`] adds for part headers and delimiters: 1 MiB.
const FRAMING_BUDGET: u64 = 1024 * 1024;

impl Default for Limits {
    fn default() -> Self {
        Self {
            field_name_size: None,
            field_size: 1024 * 1024,
            fields: None,
            file_size: None,
            files: None,
            parts: None,
            body_size: None,
            fields_size: DEFAULT_FIELDS_SIZE,
            max_parts: DEFAULT_MAX_PARTS,
        }
    }
}

impl Limits {
    /// The bytes allowed on the wire ([`Limits::body_size`] or its derived default).
    pub fn wire_budget(&self) -> u64 {
        self.body_size.unwrap_or_else(|| {
            self.file_size.map_or(DEFAULT_WIRE_BUDGET, |file_size| {
                file_size
                    .saturating_add(self.fields_size)
                    .saturating_add(FRAMING_BUDGET)
            })
        })
    }
}

/// multer's error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MulterCode {
    /// `LIMIT_PART_COUNT`: "Too many parts".
    LimitPartCount,
    /// `LIMIT_FILE_SIZE`: "File too large".
    LimitFileSize,
    /// `LIMIT_FILE_COUNT`: "Too many files".
    LimitFileCount,
    /// `LIMIT_FIELD_KEY`: "Field name too long".
    LimitFieldKey,
    /// `LIMIT_FIELD_VALUE`: "Field value too long".
    LimitFieldValue,
    /// `LIMIT_FIELD_COUNT`: "Too many fields".
    LimitFieldCount,
    /// `LIMIT_UNEXPECTED_FILE`: "Unexpected field".
    LimitUnexpectedFile,
    /// `MISSING_FIELD_NAME`: "Field name missing".
    MissingFieldName,
}

impl MulterCode {
    /// `err.code`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LimitPartCount => "LIMIT_PART_COUNT",
            Self::LimitFileSize => "LIMIT_FILE_SIZE",
            Self::LimitFileCount => "LIMIT_FILE_COUNT",
            Self::LimitFieldKey => "LIMIT_FIELD_KEY",
            Self::LimitFieldValue => "LIMIT_FIELD_VALUE",
            Self::LimitFieldCount => "LIMIT_FIELD_COUNT",
            Self::LimitUnexpectedFile => "LIMIT_UNEXPECTED_FILE",
            Self::MissingFieldName => "MISSING_FIELD_NAME",
        }
    }

    /// `err.message`.
    pub fn message(self) -> &'static str {
        match self {
            Self::LimitPartCount => "Too many parts",
            Self::LimitFileSize => "File too large",
            Self::LimitFileCount => "Too many files",
            Self::LimitFieldKey => "Field name too long",
            Self::LimitFieldValue => "Field value too long",
            Self::LimitFieldCount => "Too many fields",
            Self::LimitUnexpectedFile => "Unexpected field",
            Self::MissingFieldName => "Field name missing",
        }
    }
}

/// `MulterError`: a code and, for some codes, the field it is about.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", code.message())]
pub struct MulterError {
    /// `err.code`.
    pub code: MulterCode,
    /// `err.field`.
    pub field: Option<String>,
}

/// Why an upload failed. With `?` it becomes an [`Error`] without status, like Express's
/// `next(err)` (500 unless an error handler maps it), and stays reachable with
/// [`Error::downcast_ref`].
#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    /// A `MulterError` (`err instanceof multer.MulterError`).
    #[error(transparent)]
    Multer(#[from] MulterError),
    /// busboy refused the form (`Malformed part header`, `Unexpected end of form`, …): a plain
    /// `Error` in the reference.
    #[error("{0}")]
    Form(String),
    /// The file filter or the storage failed.
    #[error("{0}")]
    Handler(Error),
    /// The request body failed: the client went away (or the request deadline passed).
    #[error("Request aborted")]
    Aborted,
    /// The upload's own deadline ([`Multer::deadline`]) passed.
    #[error("upload deadline passed")]
    TimedOut,
    /// Not in multer: one of this crate's own bounds on a form was exceeded.
    #[error("{}", .0.message())]
    Budget(Budget),
}

/// This crate's bounds on a form, beyond multer's [`Limits`] (multer and append-field have none
/// of these and allocate their way through).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Budget {
    /// A field name nested deeper than [`fields::MAX_DEPTH`] bracket groups, or the form's names
    /// would build more than [`fields::MAX_SLOTS`] values (array holes included).
    FieldName,
    /// The body went past [`Limits::body_size`] on the wire. The rest is left unread: answer
    /// with `Connection: close`.
    Body,
    /// The text fields went past [`Limits::fields_size`].
    Fields,
    /// The form has more than [`Limits::max_parts`] parts.
    Parts,
}

impl Budget {
    /// The error message.
    pub fn message(self) -> &'static str {
        match self {
            Self::FieldName => "Field names nest too deep or build too many values",
            Self::Body => "Request body too large",
            Self::Fields => "Fields too large",
            Self::Parts => "Too many parts",
        }
    }
}

/// What multer knows about a file before it is stored (`fieldname`, `originalname`,
/// `encoding`, `mimetype`): what the file filter and the storage see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    /// The form field name (latin1 text of the header bytes).
    pub fieldname: String,
    /// The client's file name after `basename` (latin1 text, or decoded `filename*`).
    pub originalname: String,
    /// `Content-Transfer-Encoding`, lower-cased (`7bit` by default).
    pub encoding: String,
    /// The part's `type/subtype` (`text/plain` when absent).
    pub mimetype: String,
}

/// What a storage reports for a stored file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredFile {
    /// Bytes stored.
    pub size: u64,
    /// Disk storage: the directory.
    pub destination: Option<PathBuf>,
    /// Disk storage: the file name in it.
    pub filename: Option<String>,
    /// The stored file's path, if there is one.
    pub path: Option<PathBuf>,
}

/// `req.file`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedFile {
    /// What was known before storing.
    pub info: FileInfo,
    /// What the storage reported.
    pub stored: StoredFile,
}

impl std::ops::Deref for UploadedFile {
    type Target = FileInfo;

    fn deref(&self) -> &FileInfo {
        &self.info
    }
}

impl UploadedFile {
    /// `file.size`.
    pub fn size(&self) -> u64 {
        self.stored.size
    }

    /// `file.path`.
    pub fn path(&self) -> Option<&std::path::Path> {
        self.stored.path.as_deref()
    }
}

/// A stored (or partly written) file that could not be removed after its upload failed or was
/// abandoned: it is left behind and someone should know.
#[derive(Debug)]
pub struct CleanupFailure {
    /// The form field name.
    pub fieldname: String,
    /// The client's file name.
    pub originalname: String,
    /// Where the file is, when the storage keeps it on disk.
    pub path: Option<PathBuf>,
    /// Why the removal failed.
    pub error: Error,
}

impl CleanupFailure {
    fn new(info: &FileInfo, path: Option<PathBuf>, error: Error) -> Self {
        Self {
            fieldname: info.fieldname.clone(),
            originalname: info.originalname.clone(),
            path,
            error,
        }
    }
}

type CleanupHook = dyn Fn(&CleanupFailure) + Send + Sync;

/// Where one upload's cleanup runs and reports: the server's drain (so shutdown waits for
/// removals spawned from `Drop`), the app's observer and the route's hook.
#[derive(Clone, Default)]
struct Cleanup {
    tracker: Option<TaskTracker>,
    observer: Option<Arc<ObserverHub>>,
    hook: Option<Arc<CleanupHook>>,
}

impl Cleanup {
    /// Runs `work` on the runtime, tracked by the server's drain when there is one. Outside a
    /// runtime there is nowhere to run it.
    fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        match &self.tracker {
            Some(tracker) => drop(runtime.spawn(tracker.track_future(work))),
            None => drop(runtime.spawn(work)),
        }
    }

    /// Reports a removal that failed.
    fn report(&self, failure: &CleanupFailure) {
        if let Some(hook) = &self.hook {
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| hook(failure)));
        }
        if let Some(observer) = &self.observer {
            observer.cleanup_failed(failure);
        }
    }
}

/// Removes a file from disk; one that is already gone counts as removed.
async fn remove_path(path: &std::path::Path) -> Result<(), Error> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// A file's bytes as they arrive. Read it to the end (`None`); a storage that stops early
/// leaves the rest to be skipped.
pub struct FileStream<'a> {
    scanner: &'a mut Scanner,
    cleanup: Cleanup,
    size: u64,
    limit: Option<u64>,
    /// The size limit was reached (multer then fails with `LIMIT_FILE_SIZE`).
    limited: bool,
    ended: bool,
    failure: Option<ScanError>,
}

impl std::fmt::Debug for FileStream<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileStream")
            .field("size", &self.size)
            .field("limited", &self.limited)
            .finish_non_exhaustive()
    }
}

impl FileStream<'_> {
    /// The next chunk, `None` at the end of the file, or an error when the form broke off.
    pub async fn chunk(&mut self) -> Option<Result<Bytes, Error>> {
        if self.ended {
            return None;
        }
        loop {
            match self.scanner.next().await {
                Ok(Item::Data(data)) => {
                    if self.limited {
                        continue;
                    }
                    let room = self.limit.map_or(data.len() as u64, |limit| {
                        (limit - self.size).min(data.len() as u64)
                    });
                    let piece = data.slice(..usize::try_from(room).unwrap_or(data.len()));
                    self.size += piece.len() as u64;
                    if self.limit == Some(self.size) {
                        // busboy pushes the last piece, then reports the limit and skips the rest.
                        self.limited = true;
                    }
                    if piece.is_empty() {
                        continue;
                    }
                    return Some(Ok(piece));
                }
                Ok(item @ (Item::Delimiter | Item::End)) => {
                    self.scanner.push_back(item);
                    self.ended = true;
                    return None;
                }
                Ok(Item::Headers(_)) => {
                    self.ended = true;
                    self.failure = Some(ScanError::MalformedHeader);
                    return Some(Err(Error::msg("Malformed part header")));
                }
                Err(error) => {
                    self.ended = true;
                    let message = form_message(&error);
                    self.failure = Some(error);
                    return Some(Err(Error::msg(message)));
                }
            }
        }
    }

    /// Bytes handed out so far.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// Skips what is left of the file.
    async fn finish(&mut self) {
        while let Some(chunk) = self.chunk().await {
            if chunk.is_err() {
                return;
            }
        }
    }
}

fn form_message(error: &ScanError) -> &'static str {
    match error {
        ScanError::MalformedHeader => "Malformed part header",
        ScanError::UnexpectedEnd => "Unexpected end of form",
        ScanError::Aborted => "Request aborted",
        ScanError::TooLarge => Budget::Body.message(),
    }
}

fn scan_error(error: ScanError) -> UploadError {
    match error {
        ScanError::Aborted => UploadError::Aborted,
        ScanError::TooLarge => UploadError::Budget(Budget::Body),
        other => UploadError::Form(form_message(&other).to_owned()),
    }
}

/// A multer storage engine (`_handleFile` / `_removeFile`).
///
/// `handle_file` may be dropped part-way (the client went away, the deadline passed): clean up
/// what it started in `Drop` (as [`DiskStorage`] does), not only on errors.
pub trait Storage: Send + Sync + 'static {
    /// Stores one file as it arrives.
    fn handle_file<'a>(
        &'a self,
        file: &'a FileInfo,
        data: &'a mut FileStream<'_>,
    ) -> BoxFuture<'a, Result<StoredFile, Error>>;

    /// Removes a stored file after the upload failed. Disk storage also clears the file's
    /// `destination`, `filename` and `path`, as multer's does.
    fn remove_file<'a>(&'a self, file: &'a mut UploadedFile) -> BoxFuture<'a, Result<(), Error>>;
}

type NameFn = dyn Fn(&FileInfo) -> String + Send + Sync;

/// `multer.diskStorage({ destination, filename })`: each file is written to `destination` (created
/// when missing) under a name from `filename` (by default 32 random hex characters, as multer's
/// `crypto.randomBytes(16)`).
#[derive(Clone)]
pub struct DiskStorage {
    destination: PathBuf,
    filename: Arc<NameFn>,
}

impl std::fmt::Debug for DiskStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiskStorage")
            .field("destination", &self.destination)
            .finish_non_exhaustive()
    }
}

impl DiskStorage {
    /// Files go to `destination`.
    pub fn new(destination: impl Into<PathBuf>) -> Self {
        Self {
            destination: destination.into(),
            filename: Arc::new(|_| random_name()),
        }
    }

    /// The `filename` option.
    #[must_use]
    pub fn filename(mut self, name: impl Fn(&FileInfo) -> String + Send + Sync + 'static) -> Self {
        self.filename = Arc::new(name);
        self
    }
}

fn random_name() -> String {
    use dima_core::Random as _;
    dima_core::SystemRandom
        .bytes(16)
        .map(|bytes| bytes.iter().map(|b| format!("{b:02x}")).collect())
        .unwrap_or_else(|_| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            format!("{nanos:032x}")
        })
}

/// Removes a partly written file unless the write completed.
struct Partial {
    path: Option<PathBuf>,
    info: FileInfo,
    cleanup: Cleanup,
}

impl Drop for Partial {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        let info = self.info.clone();
        let cleanup = self.cleanup.clone();
        self.cleanup.spawn(async move {
            if let Err(error) = remove_path(&path).await {
                cleanup.report(&CleanupFailure::new(&info, Some(path), error));
            }
        });
    }
}

impl Storage for DiskStorage {
    fn handle_file<'a>(
        &'a self,
        file: &'a FileInfo,
        data: &'a mut FileStream<'_>,
    ) -> BoxFuture<'a, Result<StoredFile, Error>> {
        Box::pin(async move {
            tokio::fs::create_dir_all(&self.destination).await?;
            let filename = (self.filename)(file);
            let path = self.destination.join(&filename);
            let mut output = tokio::fs::File::create(&path).await?;
            // Removes the file if this future is dropped half-way (deadline, client gone).
            let mut partial = Partial {
                path: Some(path.clone()),
                info: file.clone(),
                cleanup: data.cleanup.clone(),
            };
            let written: Result<u64, Error> = async {
                let mut size = 0u64;
                while let Some(chunk) = data.chunk().await {
                    let chunk = chunk?;
                    output.write_all(&chunk).await?;
                    size += chunk.len() as u64;
                }
                output.flush().await?;
                Ok(size)
            }
            .await;
            partial.path = None;
            let size = match written {
                Ok(size) => size,
                Err(error) => {
                    // multer leaves this partial file behind; it is removed before answering.
                    drop(output);
                    if let Err(failure) = remove_path(&path).await {
                        data.cleanup
                            .report(&CleanupFailure::new(file, Some(path), failure));
                    }
                    return Err(error);
                }
            };
            Ok(StoredFile {
                size,
                destination: Some(self.destination.clone()),
                filename: Some(filename),
                path: Some(path),
            })
        })
    }

    fn remove_file<'a>(&'a self, file: &'a mut UploadedFile) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            file.stored.destination = None;
            file.stored.filename = None;
            if let Some(path) = file.stored.path.take() {
                remove_path(&path).await?;
            }
            Ok(())
        })
    }
}

type FilterFn = dyn Fn(&FileInfo) -> Result<bool, Error> + Send + Sync;

/// `multer(options)`.
#[derive(Clone)]
pub struct Multer {
    storage: Arc<dyn Storage>,
    limits: Limits,
    filter: Option<Arc<FilterFn>>,
    preserve_path: bool,
    deadline: Option<Duration>,
    cleanup_hook: Option<Arc<CleanupHook>>,
}

impl std::fmt::Debug for Multer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Multer")
            .field("limits", &self.limits)
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

impl Multer {
    /// `multer({ storage })`.
    pub fn new(storage: impl Storage) -> Self {
        Self {
            storage: Arc::new(storage),
            limits: Limits::default(),
            filter: None,
            preserve_path: false,
            deadline: None,
            cleanup_hook: None,
        }
    }

    /// `limits`.
    #[must_use]
    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// `fileFilter`: `Ok(true)` keeps the file, `Ok(false)` drops it silently, `Err` fails the
    /// upload with that error.
    #[must_use]
    pub fn file_filter(
        mut self,
        filter: impl Fn(&FileInfo) -> Result<bool, Error> + Send + Sync + 'static,
    ) -> Self {
        self.filter = Some(Arc::new(filter));
        self
    }

    /// `preservePath`: keep the directories of the client's file name.
    #[must_use]
    pub fn preserve_path(mut self, preserve: bool) -> Self {
        self.preserve_path = preserve;
        self
    }

    /// Not in multer: a hard deadline for reading the whole upload (the asset library's 120 s
    /// `req.destroy()` timer). When it passes, stored and partly written files are removed and
    /// the upload fails with [`UploadError::TimedOut`]; answer it with `Connection: close` to end
    /// the connection as the reference does.
    #[must_use]
    pub fn deadline(mut self, deadline: Duration) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// Not in multer: called when a stored or partly written file could not be removed after
    /// the upload failed or was abandoned (multer passes such errors on as `storageErrors` or
    /// drops them). Runs on the task doing the removal: keep it short. The app's
    /// [`crate::Observer::on_cleanup_error`] is told as well.
    #[must_use]
    pub fn on_cleanup_error(
        mut self,
        hook: impl Fn(&CleanupFailure) + Send + Sync + 'static,
    ) -> Self {
        self.cleanup_hook = Some(Arc::new(hook));
        self
    }

    /// `.single(field)`: at most one file, under `field`.
    pub fn single(self, field: impl Into<String>) -> Single {
        Single {
            multer: self,
            field: field.into(),
        }
    }
}

/// `multer(...).single(field)`, used two ways: [`Single::run`] inside a handler (the
/// reference's `upload(req, res, callback)`), or as middleware, which stores the file in the
/// request's extensions (`req.extensions().get::<UploadedFile>()`) and continues, or sends the
/// error down the error path.
#[derive(Clone, Debug)]
pub struct Single {
    multer: Multer,
    field: String,
}

/// Counters busboy and multer keep for one form.
struct Tally {
    delimiters: i64,
    files: usize,
    fields: usize,
    files_left: usize,
    /// Parts of any kind, for [`Limits::max_parts`].
    parts: usize,
}

impl Single {
    /// Reads the upload: `Ok(Some(file))` for the stored file, `Ok(None)` when there was none (or
    /// the request is not multipart). `req.body` holds the text fields afterwards, and the file
    /// is also in the request's extensions (`req.file`), where multer leaves it even after an
    /// error (with the disk paths removed).
    pub async fn run<S>(&self, req: &mut Req<S>) -> Result<Option<UploadedFile>, UploadError> {
        let content_type = req.header("content-type").map(|v| v.into_owned());
        if !req.has_body() || !type_is(content_type.as_deref(), &["multipart".to_owned()]) {
            return Ok(None);
        }
        req.body = BodyState::Value(Value::Object(Map::new()));
        let boundary = parse::boundary(content_type.as_deref().unwrap_or("")).map_err(
            |message| match message {
                "Unsupported content type" => UploadError::Form(format!(
                    "Unsupported content type: {}",
                    content_type.as_deref().unwrap_or("")
                )),
                other => UploadError::Form(other.to_owned()),
            },
        )?;
        let mut scanner =
            Scanner::new(req.take_body_stream(), &boundary).limit(self.multer.limits.wire_budget());
        let cleanup = Cleanup {
            tracker: req
                .extensions()
                .get::<crate::server::ServerLink>()
                .map(|link| link.cleanup().clone()),
            observer: req.observer.clone(),
            hook: self.multer.cleanup_hook.clone(),
        };
        // Every stored file is removed if this future is dropped before the file is handed over.
        let mut progress =
            Progress::new(StoredFiles::new(Arc::clone(&self.multer.storage), cleanup));
        let outcome = {
            let read = self.read(&mut scanner, &mut progress);
            match self.multer.deadline {
                Some(deadline) => tokio::time::timeout(deadline, read)
                    .await
                    .unwrap_or(Err(UploadError::TimedOut)),
                None => read.await,
            }
        };
        req.body = BodyState::Value(std::mem::take(&mut progress.fields).into_value());
        if let Err(error) = outcome {
            progress.stored.remove_all().await;
            if let Some(file) = progress
                .accepted
                .and_then(|at| progress.stored.files.get(at))
            {
                req.extensions_mut().insert(file.clone());
            }
            if !matches!(
                error,
                UploadError::Aborted | UploadError::TimedOut | UploadError::Budget(Budget::Body)
            ) {
                scanner.drain(DRAIN_BUDGET).await;
            }
            return Err(error);
        }
        let file = progress
            .accepted
            .and_then(|at| progress.stored.hand_over(at));
        if let Some(file) = &file {
            req.extensions_mut().insert(file.clone());
        }
        Ok(file)
    }

    /// The form, part by part.
    async fn read(
        &self,
        scanner: &mut Scanner,
        progress: &mut Progress,
    ) -> Result<(), UploadError> {
        let limits = &self.multer.limits;
        let mut tally = Tally {
            // busboy counts from -1 to account for the first delimiter.
            delimiters: -1,
            files: 0,
            fields: 0,
            files_left: 1,
            parts: 0,
        };
        loop {
            let item = match scanner.next().await {
                Ok(item) => item,
                Err(error) => return Err(progress.settle(scan_error(error))),
            };
            match item {
                Item::End => {
                    return match progress.first_error.take() {
                        Some(error) => Err(error),
                        None => Ok(()),
                    };
                }
                Item::Data(_) => {}
                Item::Delimiter => {
                    tally.delimiters += 1;
                    if limits.parts.is_some_and(|parts| {
                        i64::try_from(parts).is_ok_and(|p| p == tally.delimiters)
                    }) {
                        progress.fail(limit(MulterCode::LimitPartCount, None))?;
                    }
                }
                Item::Headers(_) if tally.parts >= limits.max_parts => {
                    return Err(progress.settle(UploadError::Budget(Budget::Parts)));
                }
                // Past the parts limit busboy no longer parses part headers: nothing after it
                // reaches req.body or the storage, even while multer reads on.
                Item::Headers(_)
                    if limits.parts.is_some_and(|parts| {
                        i64::try_from(parts).is_ok_and(|p| tally.delimiters >= p)
                    }) =>
                {
                    tally.parts += 1;
                    skip_part(scanner, progress).await?;
                }
                Item::Headers(headers) => {
                    tally.parts += 1;
                    match parse::classify(&headers, self.multer.preserve_path) {
                        Part::Skip => skip_part(scanner, progress).await?,
                        Part::File {
                            name,
                            filename,
                            encoding,
                            mime,
                        } => {
                            if limits.files == Some(tally.files) {
                                progress.fail(limit(MulterCode::LimitFileCount, None))?;
                                skip_part(scanner, progress).await?;
                                continue;
                            }
                            tally.files += 1;
                            let Some(filename) = filename.filter(|f| !f.is_empty()) else {
                                skip_part(scanner, progress).await?;
                                continue;
                            };
                            let fieldname = name.unwrap_or_default();
                            if let Some(max) = limits.field_name_size
                                && dima_text::utf16_len(&fieldname) > max
                            {
                                progress.fail(limit(MulterCode::LimitFieldKey, None))?;
                                skip_part(scanner, progress).await?;
                                continue;
                            }
                            if fieldname != self.field || tally.files_left == 0 {
                                // `if (field) this.field = field`: no field for a nameless part.
                                let field = Some(fieldname).filter(|f| !f.is_empty());
                                progress.fail(limit(MulterCode::LimitUnexpectedFile, field))?;
                                skip_part(scanner, progress).await?;
                                continue;
                            }
                            tally.files_left -= 1;
                            let info = FileInfo {
                                fieldname,
                                originalname: filename,
                                encoding,
                                mimetype: mime,
                            };
                            let keep = match &self.multer.filter {
                                Some(filter) => filter(&info).map_err(|error| {
                                    progress.settle(UploadError::Handler(error))
                                })?,
                                None => true,
                            };
                            if !keep {
                                skip_part(scanner, progress).await?;
                                continue;
                            }
                            self.store(scanner, info, progress).await?;
                        }
                        Part::Field { name, charset } => {
                            if limits.fields == Some(tally.fields) {
                                progress.fail(limit(MulterCode::LimitFieldCount, None))?;
                                skip_part(scanner, progress).await?;
                                continue;
                            }
                            tally.fields += 1;
                            // The name is kept too: it counts before the value is read.
                            let name_bytes = name.as_ref().map_or(0, |n| n.len() as u64);
                            progress.charge_fields(name_bytes, limits.fields_size)?;
                            let (bytes, truncated) = read_field(scanner, limits, progress).await?;
                            let Some(name) = name else {
                                progress.fail(limit(MulterCode::MissingFieldName, None))?;
                                continue;
                            };
                            if truncated {
                                progress.fail(limit(MulterCode::LimitFieldValue, Some(name)))?;
                                continue;
                            }
                            if let Some(max) = limits.field_name_size
                                && dima_text::utf16_len(&name) > max
                            {
                                progress.fail(limit(MulterCode::LimitFieldKey, None))?;
                                continue;
                            }
                            // What is kept is the decoded text, which can be larger than the
                            // bytes read (latin1 doubles, invalid UTF-8 triples).
                            let text = parse::decode_bytes(&bytes, &charset);
                            progress.recharge_fields(
                                bytes.len() as u64,
                                text.len() as u64,
                                limits.fields_size,
                            )?;
                            drop(bytes);
                            progress.fields.append(&name, text).map_err(|_| {
                                progress.settle(UploadError::Budget(Budget::FieldName))
                            })?;
                        }
                    }
                }
            }
        }
    }

    /// One accepted file through the storage.
    async fn store(
        &self,
        scanner: &mut Scanner,
        info: FileInfo,
        progress: &mut Progress,
    ) -> Result<(), UploadError> {
        progress.storage_used = true;
        let mut stream = FileStream {
            scanner,
            cleanup: progress.stored.cleanup.clone(),
            size: 0,
            limit: self.multer.limits.file_size,
            limited: false,
            ended: false,
            failure: None,
        };
        let outcome = self.multer.storage.handle_file(&info, &mut stream).await;
        let fieldname = info.fieldname.clone();
        // Guarded before anything else is awaited: the client may go away while the rest of the
        // part is skipped.
        let failed = match outcome {
            Ok(stored) => {
                progress.stored.files.push(UploadedFile { info, stored });
                None
            }
            Err(error) => Some(error),
        };
        // Whatever the storage left unread is skipped up to the next delimiter.
        stream.finish().await;
        if let Some(failure) = stream.failure.take() {
            return Err(progress.settle(scan_error(failure)));
        }
        if let Some(error) = failed {
            return Err(progress.settle(UploadError::Handler(error)));
        }
        if stream.limited {
            // The truncated file is removed later but never becomes `req.file`.
            return progress.fail(limit(MulterCode::LimitFileSize, Some(fieldname)));
        }
        progress.accepted = progress.stored.files.len().checked_sub(1);
        Ok(())
    }
}

/// The files a storage holds for one upload until one is handed to the handler: when the upload
/// fails, or its future is dropped (the client went away, the handler gave up), they are removed
/// through the storage, from a spawned task if need be.
struct StoredFiles {
    storage: Arc<dyn Storage>,
    cleanup: Cleanup,
    files: Vec<UploadedFile>,
    /// Files at the front already removed.
    removed: usize,
    /// One was handed over (or all were removed): nothing left to do on drop.
    settled: bool,
}

impl StoredFiles {
    fn new(storage: Arc<dyn Storage>, cleanup: Cleanup) -> Self {
        Self {
            storage,
            cleanup,
            files: Vec::new(),
            removed: 0,
            settled: false,
        }
    }

    /// Removes every file through the storage (multer's error path).
    async fn remove_all(&mut self) {
        let storage = Arc::clone(&self.storage);
        while let Some(file) = self.files.get_mut(self.removed) {
            remove_reporting(storage.as_ref(), file, &self.cleanup).await;
            self.removed += 1;
        }
        self.settled = true;
    }

    /// The upload succeeded: file `at` goes to the handler and the guard stands down.
    fn hand_over(&mut self, at: usize) -> Option<UploadedFile> {
        self.settled = true;
        self.files.get(at).cloned()
    }
}

impl Drop for StoredFiles {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // A removal that was in progress when the future was dropped is attempted again.
        let mut pending = self.files.split_off(self.removed.min(self.files.len()));
        if pending.is_empty() {
            return;
        }
        let storage = Arc::clone(&self.storage);
        let cleanup = self.cleanup.clone();
        self.cleanup.spawn(async move {
            for file in &mut pending {
                remove_reporting(storage.as_ref(), file, &cleanup).await;
            }
        });
    }
}

/// Removes one stored file through the storage, reporting a failure.
async fn remove_reporting(storage: &dyn Storage, file: &mut UploadedFile, cleanup: &Cleanup) {
    // The storage may clear the paths it removes; the report names the file as it was.
    let path = file.stored.path.clone();
    if let Err(error) = storage.remove_file(file).await {
        cleanup.report(&CleanupFailure::new(&file.info, path, error));
    }
}

/// What one upload has produced so far.
struct Progress {
    fields: fields::Fields,
    stored: StoredFiles,
    /// `req.file`, as an index into `stored`.
    accepted: Option<usize>,
    /// A file went to the storage. multer then gives up only once that write has finished, and
    /// busboy reads on meanwhile: fields after a failure still reach `req.body`.
    storage_used: bool,
    /// The first limit error, while reading on.
    first_error: Option<UploadError>,
    /// Text field bytes read so far (names and values), for [`Limits::fields_size`].
    fields_bytes: u64,
}

impl Progress {
    fn new(stored: StoredFiles) -> Self {
        Self {
            fields: fields::Fields::default(),
            stored,
            accepted: None,
            storage_used: false,
            first_error: None,
            fields_bytes: 0,
        }
    }

    /// A limit error: fatal at once, or (once a file went to the storage) remembered while the
    /// rest of the form is read, as multer only reports its first error.
    fn fail(&mut self, error: UploadError) -> Result<(), UploadError> {
        if !self.storage_used {
            return Err(error);
        }
        if self.first_error.is_none() {
            self.first_error = Some(error);
        }
        Ok(())
    }

    /// A fatal error, unless an earlier one is waiting to be reported.
    fn settle(&mut self, error: UploadError) -> UploadError {
        self.first_error.take().unwrap_or(error)
    }

    /// Replaces the charge for `read` bytes buffered with the `kept` bytes of their decoded text.
    fn recharge_fields(&mut self, read: u64, kept: u64, budget: u64) -> Result<(), UploadError> {
        self.fields_bytes = self.fields_bytes.saturating_sub(read);
        self.charge_fields(kept, budget)
    }

    /// Counts text field bytes before they are buffered.
    fn charge_fields(&mut self, bytes: u64, budget: u64) -> Result<(), UploadError> {
        let total = self.fields_bytes.saturating_add(bytes);
        if total > budget {
            return Err(self.settle(UploadError::Budget(Budget::Fields)));
        }
        self.fields_bytes = total;
        Ok(())
    }
}

fn limit(code: MulterCode, field: Option<String>) -> UploadError {
    UploadError::Multer(MulterError { code, field })
}

/// Skips a part's data up to the next delimiter.
async fn skip_part(scanner: &mut Scanner, progress: &mut Progress) -> Result<(), UploadError> {
    loop {
        match scanner.next().await {
            Ok(Item::Data(_)) => {}
            Ok(item) => {
                scanner.push_back(item);
                return Ok(());
            }
            Err(error) => return Err(progress.settle(scan_error(error))),
        }
    }
}

/// A text field's bytes, at most `limit` of them, and whether it reached the limit (busboy then
/// marks the value truncated, even when it is exactly that long).
async fn read_field(
    scanner: &mut Scanner,
    limits: &Limits,
    progress: &mut Progress,
) -> Result<(Vec<u8>, bool), UploadError> {
    let limit = limits.field_size;
    let mut value: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        match scanner
            .next()
            .await
            .map_err(|error| progress.settle(scan_error(error)))?
        {
            Item::Data(data) => {
                if truncated {
                    continue;
                }
                let room = limit.saturating_sub(value.len() as u64);
                let take = usize::try_from(room.min(data.len() as u64)).unwrap_or(data.len());
                progress.charge_fields(take as u64, limits.fields_size)?;
                value.extend_from_slice(data.get(..take).unwrap_or(&[]));
                if value.len() as u64 == limit {
                    truncated = true;
                }
            }
            item => {
                scanner.push_back(item);
                return Ok((value, truncated));
            }
        }
    }
}

impl<S: Send + Sync + 'static> Handler<S> for Single {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, Error>> {
        Box::pin(async move {
            self.run(req).await?;
            Ok(Flow::Next)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Body;

    const BOUNDARY: &str = "b0undary";

    fn field(name: &str, value: &[u8]) -> Vec<u8> {
        let mut part =
            format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n")
                .into_bytes();
        part.extend_from_slice(value);
        part.extend_from_slice(b"\r\n");
        part
    }

    fn file(name: &str, filename: &str, data: &[u8]) -> Vec<u8> {
        let mut part = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        part.extend_from_slice(data);
        part.extend_from_slice(b"\r\n");
        part
    }

    fn form(parts: &[Vec<u8>]) -> Vec<u8> {
        let mut body = parts.concat();
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        body
    }

    fn request(body: Body) -> Req<()> {
        let (parts, ()) = http::Request::builder()
            .method("POST")
            .uri("/upload")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .header("transfer-encoding", "chunked")
            .body(())
            .expect("request")
            .into_parts();
        Req::new(Arc::new(()), parts, body)
    }

    /// A storage that keeps nothing.
    struct Discard;

    impl Storage for Discard {
        fn handle_file<'a>(
            &'a self,
            _file: &'a FileInfo,
            data: &'a mut FileStream<'_>,
        ) -> BoxFuture<'a, Result<StoredFile, Error>> {
            Box::pin(async move {
                let mut size = 0;
                while let Some(chunk) = data.chunk().await {
                    size += chunk?.len() as u64;
                }
                Ok(StoredFile {
                    size,
                    ..StoredFile::default()
                })
            })
        }

        fn remove_file<'a>(
            &'a self,
            _file: &'a mut UploadedFile,
        ) -> BoxFuture<'a, Result<(), Error>> {
            Box::pin(async { Ok(()) })
        }
    }

    async fn upload(limits: Limits, body: Vec<u8>) -> Result<Option<UploadedFile>, UploadError> {
        let mut req = request(Body::from(body));
        Multer::new(Discard)
            .limits(limits)
            .single("file")
            .run(&mut req)
            .await
    }

    fn budget(outcome: Result<Option<UploadedFile>, UploadError>) -> Option<Budget> {
        match outcome {
            Err(UploadError::Budget(budget)) => Some(budget),
            _ => None,
        }
    }

    /// Review finding: with default limits every permitted field was kept and the number of
    /// fields and parts was unlimited, so a route with only a file-size limit took arbitrarily
    /// many small fields until the request timed out.
    #[tokio::test]
    async fn many_small_fields_hit_the_parts_budget() {
        let limits = Limits {
            file_size: Some(1024),
            ..Limits::default()
        };
        let parts: Vec<Vec<u8>> = (0..DEFAULT_MAX_PARTS)
            .map(|i| field(&format!("f{i}"), b"v"))
            .collect();
        assert!(upload(limits.clone(), form(&parts)).await.is_ok());
        let parts: Vec<Vec<u8>> = (0..=DEFAULT_MAX_PARTS)
            .map(|i| field(&format!("f{i}"), b"v"))
            .collect();
        assert_eq!(
            budget(upload(limits, form(&parts)).await),
            Some(Budget::Parts)
        );
    }

    #[tokio::test]
    async fn retained_fields_have_a_total_budget() {
        let value = vec![b'x'; 1024 * 1024 - 1];
        let parts: Vec<Vec<u8>> = (0..5).map(|i| field(&format!("f{i}"), &value)).collect();
        assert_eq!(
            budget(upload(Limits::default(), form(&parts)).await),
            Some(Budget::Fields)
        );
        let parts: Vec<Vec<u8>> = (0..3).map(|i| field(&format!("f{i}"), &value)).collect();
        assert!(upload(Limits::default(), form(&parts)).await.is_ok());
    }

    /// Review finding: fields were charged before decoding, and invalid UTF-8 decodes to three
    /// bytes per byte (U+FFFD), so accepted fields held nearly three times the budget.
    #[tokio::test]
    async fn the_fields_budget_counts_decoded_text() {
        let value = vec![0xFF; 1024 * 1024 - 1];
        let parts: Vec<Vec<u8>> = (0..2).map(|i| field(&format!("f{i}"), &value)).collect();
        assert_eq!(
            budget(upload(Limits::default(), form(&parts)).await),
            Some(Budget::Fields)
        );
        // One such field decodes to 3 MiB and fits.
        assert!(
            upload(Limits::default(), form(&[field("f", &value)]))
                .await
                .is_ok()
        );
    }

    /// Review finding: with no file-size limit the default wire budget was about 1 GiB.
    #[tokio::test]
    async fn without_a_file_size_the_wire_budget_is_32_mib() {
        assert_eq!(Limits::default().wire_budget(), 32 * 1024 * 1024);
        let big = vec![7; 33 * 1024 * 1024];
        assert_eq!(
            budget(upload(Limits::default(), form(&[file("file", "a.bin", &big)])).await),
            Some(Budget::Body)
        );
        let fits = vec![7; 30 * 1024 * 1024];
        let stored = upload(Limits::default(), form(&[file("file", "a.bin", &fits)])).await;
        assert_eq!(
            stored.ok().flatten().map(|f| f.size()),
            Some(30 * 1024 * 1024)
        );
    }

    #[tokio::test]
    async fn the_wire_has_a_budget() {
        // Parts that are skipped (no form-data disposition) cost nothing but wire bytes.
        let mut skipped = format!("--{BOUNDARY}\r\nX-Other: 1\r\n\r\n").into_bytes();
        skipped.extend(std::iter::repeat_n(b'z', 6 * 1024 * 1024));
        skipped.extend_from_slice(b"\r\n");
        let limits = Limits {
            file_size: Some(1024),
            ..Limits::default()
        };
        assert_eq!(limits.wire_budget(), 1024 + 5 * 1024 * 1024);
        assert_eq!(
            budget(upload(limits, form(&[skipped])).await),
            Some(Budget::Body)
        );
        let explicit = Limits {
            body_size: Some(10_000),
            ..Limits::default()
        };
        assert_eq!(
            budget(
                upload(
                    explicit.clone(),
                    form(&[file("file", "a.bin", &[7; 20_000])])
                )
                .await
            ),
            Some(Budget::Body)
        );
        let small = upload(explicit, form(&[file("file", "a.bin", &[7; 2_000])])).await;
        assert_eq!(small.ok().flatten().map(|f| f.size()), Some(2_000));
    }

    #[tokio::test]
    async fn hostile_field_names_fail_the_upload() {
        let name = format!("a{}", "[10000]".repeat(2000));
        assert_eq!(
            budget(upload(Limits::default(), form(&[field(&name, b"x")])).await),
            Some(Budget::FieldName)
        );
    }
}
