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
//! - busboy's own errors: `Malformed content type`, `Unsupported content type`,
//!   `Multipart: Boundary not found`, `Malformed part header`, `Unexpected end of form`.
//! - On any error every stored file is removed through the storage before the error is
//!   returned. Unlike multer, a partly written file (client gone, storage failure, deadline) is
//!   removed too.
//! - Field names and file names are header text, read as latin1 like multer does (no
//!   `defParamCharset`): a UTF-8 file name arrives as mojibake (`😀` becomes `ð\u{9f}\u{98}\u{80}`).
//!   `filename*=utf-8''…` is decoded. Field values are UTF-8.

pub mod fields;
mod parse;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt as _;

use crate::error::Error;
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
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            field_name_size: None,
            field_size: 1024 * 1024,
            fields: None,
            file_size: None,
            files: None,
            parts: None,
        }
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
}

impl Budget {
    /// The error message.
    pub fn message(self) -> &'static str {
        match self {
            Self::FieldName => "Field names nest too deep or build too many values",
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

/// A file's bytes as they arrive. Read it to the end (`None`); a storage that stops early
/// leaves the rest to be skipped.
pub struct FileStream<'a> {
    scanner: &'a mut Scanner,
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
    }
}

fn scan_error(error: ScanError) -> UploadError {
    match error {
        ScanError::Aborted => UploadError::Aborted,
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
struct Partial(Option<PathBuf>);

impl Drop for Partial {
    fn drop(&mut self) {
        if let Some(path) = self.0.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = tokio::fs::remove_file(path).await;
            });
        }
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
            let mut partial = Partial(Some(path.clone()));
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
            partial.0 = None;
            let size = match written {
                Ok(size) => size,
                Err(error) => {
                    // multer leaves this partial file behind; it is removed before answering.
                    drop(output);
                    let _ = tokio::fs::remove_file(&path).await;
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
                tokio::fs::remove_file(path).await?;
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
        let mut scanner = Scanner::new(req.take_body_stream(), &boundary);
        let mut progress = Progress::default();
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
            for file in &mut progress.stored {
                let _ = self.multer.storage.remove_file(file).await;
            }
            if let Some(file) = progress.accepted.and_then(|at| progress.stored.get(at)) {
                req.extensions_mut().insert(file.clone());
            }
            if !matches!(error, UploadError::Aborted | UploadError::TimedOut) {
                scanner.drain(DRAIN_BUDGET).await;
            }
            return Err(error);
        }
        let file = progress
            .accepted
            .and_then(|at| progress.stored.get(at))
            .cloned();
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
                // Past the parts limit busboy no longer parses part headers: nothing after it
                // reaches req.body or the storage, even while multer reads on.
                Item::Headers(_)
                    if limits.parts.is_some_and(|parts| {
                        i64::try_from(parts).is_ok_and(|p| tally.delimiters >= p)
                    }) =>
                {
                    skip_part(scanner, progress).await?;
                }
                Item::Headers(headers) => {
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
                            let (bytes, truncated) =
                                read_field(scanner, limits.field_size, progress).await?;
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
                            progress
                                .fields
                                .append(&name, parse::decode_bytes(&bytes, &charset))
                                .map_err(|_| {
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
            size: 0,
            limit: self.multer.limits.file_size,
            limited: false,
            ended: false,
            failure: None,
        };
        let outcome = self.multer.storage.handle_file(&info, &mut stream).await;
        // Whatever the storage left unread is skipped up to the next delimiter.
        stream.finish().await;
        if let Some(failure) = stream.failure.take() {
            if let Ok(file) = outcome {
                progress.stored.push(UploadedFile { info, stored: file });
            }
            return Err(progress.settle(scan_error(failure)));
        }
        let stored = outcome.map_err(|error| progress.settle(UploadError::Handler(error)))?;
        let fieldname = info.fieldname.clone();
        progress.stored.push(UploadedFile { info, stored });
        if stream.limited {
            // The truncated file is removed later but never becomes `req.file`.
            return progress.fail(limit(MulterCode::LimitFileSize, Some(fieldname)));
        }
        progress.accepted = Some(progress.stored.len() - 1);
        Ok(())
    }
}

/// What one upload has produced so far.
#[derive(Default)]
struct Progress {
    fields: fields::Fields,
    stored: Vec<UploadedFile>,
    /// `req.file`, as an index into `stored`.
    accepted: Option<usize>,
    /// A file went to the storage. multer then gives up only once that write has finished, and
    /// busboy reads on meanwhile: fields after a failure still reach `req.body`.
    storage_used: bool,
    /// The first limit error, while reading on.
    first_error: Option<UploadError>,
}

impl Progress {
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
    limit: u64,
    progress: &mut Progress,
) -> Result<(Vec<u8>, bool), UploadError> {
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
