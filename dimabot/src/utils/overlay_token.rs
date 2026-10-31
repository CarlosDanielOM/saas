//! Overlay link state machine ported from `dimabot/src/utils/overlay-token.ts`.
//!
//! The source owns four pieces of policy and this module keeps them in one
//! place so the widget, roulette, duel and pet services do not each grow their
//! own copy:
//!
//! * the link version is the SHA-256 hex digest of the token, so a document can
//!   be read without decrypting the token;
//! * the stored envelope is the existing legacy AES-256-CTR envelope from
//!   [`crate::utils::credential_crypto`] (the retired `utils/crypto.ts` port);
//! * creation is idempotent, replacement requires the version the user
//!   confirmed, and a link whose envelope is missing or unreadable must be
//!   saved again before it can be retrieved;
//! * every write is a compare-and-set on `_id` plus the stored `tokenHash`,
//!   retried at most eight times.
//!
//! ## Boundaries
//!
//! * Nothing here reads the environment at import. [`NativeOverlayTokenCodec`]
//!   takes an already-built [`CredentialCipher`]; [`NativeOverlayTokenCodec::from_env`]
//!   is the explicit application-startup boundary for `SECRET_KEY`.
//! * The four application stores stay owned by their services. The concrete
//!   [`MongoOverlayTokenStore`] adapter is reusable where the collection stores
//!   the token on the channel document itself; the pet runtime store differs
//!   (owner `_id`, no revision bump, a cache invalidation after a replace) and
//!   keeps its own thin wrapper. See the handoff note for each consumer's exact
//!   contract.
//! * A store failure keeps the driver's typed error rather than flattening it,
//!   so a caller can still distinguish a duplicate-key failure from a network
//!   failure.
//!
//! ## Source parity notes
//!
//! * `!!doc.tokenHash` is JavaScript truthiness, not Rust `Option` presence: a
//!   stored empty string counts as "no link" for branching but is still the
//!   value reported as `version` and used by the compare-and-set filter. The
//!   helpers [`is_linked`] and the view construction preserve both facts.
//! * `state()` swallows decryption failures on purpose: an OBS URL that already
//!   exists can be saved again. Every other crypto failure (entropy or
//!   encryption) propagates to the caller as [`OverlayTokenError::Crypto`].
//! * The native writer encrypts once per attempt and reuses that envelope for
//!   the returned view. The source encrypts once for the store update and once
//!   more for the view (`storedOverlayToken` in both places), so the two
//!   ciphertexts can use different IVs. Decryption, hashing, decisions and the
//!   persisted first envelope are identical; the envelope never leaves the
//!   server.
//! * Aborted requests are `OverlayTokenRejection` values carrying the exact
//!   source code, message and status. The roulette/duel/widget callers raise
//!   their existing `RouletteError`; the pet caller keeps only code and status.

use crate::utils::credential_crypto::{
    CredentialCipher, CredentialCryptoError, StoredCredential, hex,
};
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use mongodb::{
    Collection,
    bson::{Bson, Document, doc, from_bson, to_document},
    error::Error as MongoError,
};
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
};

/// Attempts before the source gives up with `overlay_link_conflict`.
pub const MAX_ATTEMPTS: usize = 8;
/// `randomBytes(32)`: 32 bytes encode to 43 unpadded base64url characters.
pub const TOKEN_BYTES: usize = 32;
/// `/^[\w-]{43}$/`.
pub const TOKEN_LENGTH: usize = 43;
/// `randomBytes(16)`: the legacy cipher's IV.
pub const IV_BYTES: usize = 16;
/// Stored link version field.
pub const TOKEN_HASH_FIELD: &str = "tokenHash";
/// Stored cipher envelope field, excluded from the default Mongoose projection.
pub const OVERLAY_TOKEN_FIELD: &str = "overlayToken";
/// Channel document revision bumped by a replacement, when the owner asks.
pub const REVISION_FIELD: &str = "revision";

// ---------------------------------------------------------------------------
// Rejections and errors
// ---------------------------------------------------------------------------

/// One `fail(code, message, status)` call from the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverlayTokenRejection {
    pub code: &'static str,
    pub message: &'static str,
    pub status: u16,
}

impl fmt::Display for OverlayTokenRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

/// `fail('invalid', 'Invalid overlay link request')`.
pub const INVALID_REQUEST: OverlayTokenRejection = OverlayTokenRejection {
    code: "invalid",
    message: "Invalid overlay link request",
    status: 400,
};
/// `fail('invalid', 'Invalid overlay token')`.
pub const INVALID_TOKEN: OverlayTokenRejection = OverlayTokenRejection {
    code: "invalid",
    message: "Invalid overlay token",
    status: 400,
};
/// A supplied token no longer matches the stored version.
pub const LINK_INVALID: OverlayTokenRejection = OverlayTokenRejection {
    code: "overlay_link_invalid",
    message: "This link is no longer active",
    status: 409,
};
/// The stored envelope is missing or unreadable, so the user must save again.
pub const RECOVERY_REQUIRED: OverlayTokenRejection = OverlayTokenRejection {
    code: "overlay_link_recovery_required",
    message: "Save the existing OBS link before retrieving it",
    status: 409,
};
/// A rotation lost the version race.
pub const LINK_CONFLICT_REPLACE: OverlayTokenRejection = OverlayTokenRejection {
    code: "overlay_link_conflict",
    message: "The overlay link changed; reload before replacing it",
    status: 409,
};
/// Every compare-and-set attempt lost.
pub const LINK_CONFLICT_RETRY: OverlayTokenRejection = OverlayTokenRejection {
    code: "overlay_link_conflict",
    message: "The overlay link changed; reload before trying again",
    status: 409,
};

/// Failure of one overlay-link operation.
#[derive(Debug)]
pub enum OverlayTokenError {
    /// A source `fail()` branch. Carries the client-facing code, text and status.
    Rejected(OverlayTokenRejection),
    /// Encryption, entropy or a strict key failure that the source lets escape.
    Crypto(CredentialCryptoError),
    /// A store read/write failure. The driver error is kept intact.
    Store(MongoError),
}

impl OverlayTokenError {
    /// The rejection branch, when this is a client-facing `fail()`.
    pub fn rejection(&self) -> Option<&OverlayTokenRejection> {
        match self {
            Self::Rejected(rejection) => Some(rejection),
            _ => None,
        }
    }

    /// `error.code` for a rejection, as the pet service needs.
    pub fn code(&self) -> Option<&'static str> {
        self.rejection().map(|rejection| rejection.code)
    }

    /// `error.status` for a rejection.
    pub fn status(&self) -> Option<u16> {
        self.rejection().map(|rejection| rejection.status)
    }
}

impl fmt::Display for OverlayTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(rejection) => fmt::Display::fmt(rejection, formatter),
            Self::Crypto(error) => fmt::Display::fmt(error, formatter),
            Self::Store(error) => fmt::Display::fmt(error, formatter),
        }
    }
}

impl Error for OverlayTokenError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Rejected(_) => None,
            Self::Crypto(error) => Some(error),
            Self::Store(error) => Some(error),
        }
    }
}

impl From<OverlayTokenRejection> for OverlayTokenError {
    fn from(rejection: OverlayTokenRejection) -> Self {
        Self::Rejected(rejection)
    }
}

impl From<CredentialCryptoError> for OverlayTokenError {
    fn from(error: CredentialCryptoError) -> Self {
        Self::Crypto(error)
    }
}

impl From<MongoError> for OverlayTokenError {
    fn from(error: MongoError) -> Self {
        Self::Store(error)
    }
}

/// A store boundary failure with a message only, e.g. an unexpected document
/// shape. Kept typed as a driver error so the store seam stays uniform.
fn store_error(message: impl Into<String>) -> OverlayTokenError {
    OverlayTokenError::Store(MongoError::custom(message.into()))
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/// Hash, encrypt, decrypt and draw the token. The native implementation reuses
/// the shared credential cipher, SHA-256 and the OS entropy source.
pub trait OverlayTokenCodec: Send + Sync {
    /// `overlayTokenHash`.
    fn hash(&self, token: &str) -> String;
    /// `encrypt` from the retired `utils/crypto.ts`.
    fn encrypt(&self, token: &str) -> Result<StoredCredential, CredentialCryptoError>;
    /// `decrypt`; an unreadable envelope is an error the caller may ignore.
    fn decrypt(
        &self,
        envelope: Option<&StoredCredential>,
    ) -> Result<Option<String>, CredentialCryptoError>;
    /// `randomBytes(32).toString('base64url')`.
    fn random_token(&self) -> Result<String, CredentialCryptoError>;
}

/// Production codec over [`CredentialCipher`], SHA-256 and `getrandom`.
#[derive(Clone)]
pub struct NativeOverlayTokenCodec {
    cipher: CredentialCipher,
}

impl fmt::Debug for NativeOverlayTokenCodec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeOverlayTokenCodec(<cipher>)")
    }
}

impl NativeOverlayTokenCodec {
    /// Stores an explicitly built cipher. Performs no I/O.
    pub fn new(cipher: CredentialCipher) -> Self {
        Self { cipher }
    }

    /// Explicit application-startup boundary for `SECRET_KEY`. Later
    /// environment changes do not affect this codec.
    pub fn from_env() -> Result<Self, CredentialCryptoError> {
        Ok(Self::new(CredentialCipher::from_env()?))
    }
}

impl OverlayTokenCodec for NativeOverlayTokenCodec {
    fn hash(&self, token: &str) -> String {
        sha256_hex(token)
    }

    fn encrypt(&self, token: &str) -> Result<StoredCredential, CredentialCryptoError> {
        self.cipher.encrypt(token)
    }

    fn decrypt(
        &self,
        envelope: Option<&StoredCredential>,
    ) -> Result<Option<String>, CredentialCryptoError> {
        self.cipher.decrypt(envelope)
    }

    fn random_token(&self) -> Result<String, CredentialCryptoError> {
        let mut bytes = [0_u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|_| CredentialCryptoError::EntropyUnavailable)?;
        Ok(base64url(&bytes))
    }
}

/// Lower-case SHA-256 hex, matching `createHash('sha256').digest('hex')`.
pub fn sha256_hex(value: &str) -> String {
    hex(Sha256::digest(value.as_bytes()).as_slice())
}

/// `Buffer.toString('base64url')`: URL-safe alphabet, no padding.
pub fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let packed = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        output.push(TABLE[((packed >> 18) & 63) as usize] as char);
        output.push(TABLE[((packed >> 12) & 63) as usize] as char);
        output.push(TABLE[((packed >> 6) & 63) as usize] as char);
        output.push(TABLE[(packed & 63) as usize] as char);
        index += 3;
    }
    if index < bytes.len() {
        let mut packed = (bytes[index] as u32) << 16;
        if index + 1 < bytes.len() {
            packed |= (bytes[index + 1] as u32) << 8;
        }
        output.push(TABLE[((packed >> 18) & 63) as usize] as char);
        output.push(TABLE[((packed >> 12) & 63) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(TABLE[((packed >> 6) & 63) as usize] as char);
        }
    }
    output
}

/// `/^[\w-]{43}$/` with JavaScript's ASCII `\w`.
pub fn token_shape(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == TOKEN_LENGTH
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

// ---------------------------------------------------------------------------
// Document and view
// ---------------------------------------------------------------------------

/// The token fields the state machine reads. `None` covers both an absent and
/// a stored `null`; `Some("")` is kept because the source reports it as the
/// version while treating it as an unlinked document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayTokenDocument {
    pub token_hash: Option<String>,
    pub overlay_token: Option<StoredCredential>,
}

/// `{ token, exists, version }` from `readOverlayToken`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct OverlayTokenView {
    pub token: Option<String>,
    pub exists: bool,
    pub version: Option<String>,
}

/// `!!doc.tokenHash` in JavaScript, where `''` is falsy.
pub fn is_linked(token_hash: &Option<String>) -> bool {
    token_hash.as_deref().is_some_and(|hash| !hash.is_empty())
}

/// `state(doc)`: decrypt, then require the plaintext to hash back to the stored
/// version. A decryption failure is swallowed so the link can be saved again.
pub fn token_state(
    codec: &dyn OverlayTokenCodec,
    document: &OverlayTokenDocument,
) -> OverlayTokenView {
    let decrypted = document
        .overlay_token
        .as_ref()
        .and_then(|envelope| codec.decrypt(Some(envelope)).ok().flatten());
    let token = decrypted.filter(|token| {
        !token.is_empty()
            && document.token_hash.as_deref() == Some(codec.hash(token).as_str())
    });
    OverlayTokenView {
        token,
        exists: is_linked(&document.token_hash),
        version: document.token_hash.clone(),
    }
}

// ---------------------------------------------------------------------------
// Store seam
// ---------------------------------------------------------------------------

/// Result of one store operation.
pub type StoreFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, OverlayTokenError>> + Send + 'a>>;

/// Channel-scoped reader and compare-and-set writer.
///
/// `save` receives the token the caller already hashed and encrypted, plus the
/// version the write expects. It returns `true` only when one document matched
/// and was updated (`matchedCount === 1`).
pub trait OverlayTokenStore: Send + Sync {
    fn read(&self) -> StoreFuture<'_, OverlayTokenDocument>;
    fn save(
        &self,
        expected_hash: Option<String>,
        token_hash: String,
        overlay_token: StoredCredential,
        replace: bool,
    ) -> StoreFuture<'_, bool>;
}

/// `readOverlayToken`.
pub async fn read_overlay_token(
    store: &dyn OverlayTokenStore,
    codec: &dyn OverlayTokenCodec,
) -> Result<OverlayTokenView, OverlayTokenError> {
    Ok(token_state(codec, &store.read().await?))
}

fn json_text(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}

/// `body.version !== (doc.tokenHash ?? null)`.
fn version_conflicts(version: Option<&JsonValue>, token_hash: Option<&str>) -> bool {
    match version {
        None => true,
        Some(JsonValue::Null) => token_hash.is_some(),
        // A version that cannot be represented as UTF-8 (a lone surrogate)
        // can never equal a stored ASCII digest.
        Some(JsonValue::String(value)) => {
            value
                .as_str()
                .is_none_or(|text| Some(text) != token_hash)
        }
        Some(_) => true,
    }
}

/// Validate the request body exactly as the source does, before any read.
fn parse_request(input: &JsonValue) -> Result<(bool, Option<&JsString>), OverlayTokenError> {
    let JsonValue::Object(fields) = input else {
        return Err(INVALID_REQUEST.into());
    };
    if fields.iter().any(|(key, _)| {
        key.as_str()
            .is_none_or(|key| !matches!(key, "rotate" | "version" | "token"))
    }) {
        return Err(INVALID_REQUEST.into());
    }
    let rotate = input.get("rotate");
    let token = input.get("token");
    if rotate.is_some_and(|value| !matches!(value, JsonValue::Bool(_)))
        || (matches!(rotate, Some(JsonValue::Bool(true))) && token.is_some())
    {
        return Err(INVALID_REQUEST.into());
    }
    let token = match token {
        None => None,
        Some(JsonValue::String(value)) => {
            if value.as_str().is_none_or(|text| !token_shape(text)) {
                return Err(INVALID_TOKEN.into());
            }
            Some(value)
        }
        Some(_) => return Err(INVALID_TOKEN.into()),
    };
    Ok((matches!(rotate, Some(JsonValue::Bool(true))), token))
}

/// `manageOverlayToken`. Creation is idempotent; replacement requires the
/// version the user confirmed and retries the compare-and-set at most
/// [`MAX_ATTEMPTS`] times.
pub async fn manage_overlay_token(
    store: &dyn OverlayTokenStore,
    codec: &dyn OverlayTokenCodec,
    input: &JsonValue,
) -> Result<OverlayTokenView, OverlayTokenError> {
    let (rotate, token) = parse_request(input)?;
    for _ in 0..MAX_ATTEMPTS {
        let document = store.read().await?;
        if let Some(token) = token {
            let token = token.as_str().ok_or(INVALID_TOKEN)?;
            let hash = codec.hash(token);
            if !is_linked(&document.token_hash)
                || document.token_hash.as_deref() != Some(hash.as_str())
            {
                return Err(LINK_INVALID.into());
            }
            let envelope = codec.encrypt(token)?;
            if store
                .save(document.token_hash.clone(), hash.clone(), envelope.clone(), false)
                .await?
            {
                return Ok(token_state(
                    codec,
                    &OverlayTokenDocument {
                        token_hash: Some(hash),
                        overlay_token: Some(envelope),
                    },
                ));
            }
            continue;
        }
        if !rotate && is_linked(&document.token_hash) {
            let current = token_state(codec, &document);
            if current.token.is_none() {
                return Err(RECOVERY_REQUIRED.into());
            }
            return Ok(current);
        }
        if rotate && version_conflicts(input.get("version"), document.token_hash.as_deref()) {
            return Err(LINK_CONFLICT_REPLACE.into());
        }
        let token = codec.random_token()?;
        let envelope = codec.encrypt(&token)?;
        let hash = codec.hash(&token);
        if store
            .save(document.token_hash.clone(), hash.clone(), envelope.clone(), true)
            .await?
        {
            return Ok(token_state(
                codec,
                &OverlayTokenDocument {
                    token_hash: Some(hash),
                    overlay_token: Some(envelope),
                },
            ));
        }
        if rotate {
            return Err(LINK_CONFLICT_REPLACE.into());
        }
    }
    Err(LINK_CONFLICT_RETRY.into())
}

/// `rememberOverlayToken`: upgrade a hash-only legacy link after successful
/// overlay authentication. The save's boolean is deliberately ignored, as in
/// the source; a save failure still propagates.
pub async fn remember_overlay_token(
    store: &dyn OverlayTokenStore,
    codec: &dyn OverlayTokenCodec,
    token: &str,
) -> Result<(), OverlayTokenError> {
    let document = store.read().await?;
    let hash = codec.hash(token);
    if document.token_hash.as_deref() == Some(hash.as_str())
        && token_state(codec, &document).token.is_none()
    {
        let envelope = codec.encrypt(token)?;
        store
            .save(document.token_hash.clone(), hash, envelope, false)
            .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reusable MongoDB adapter
// ---------------------------------------------------------------------------

/// Owner-supplied step that guarantees the channel document exists before the
/// token fields are read. Widget, roulette and duel each keep their own
/// `load`/create path, including its duplicate-key tolerance.
pub trait EnsureOverlayTokenDocument: Send + Sync {
    fn ensure<'a>(
        &'a self,
        collection: &'a Collection<Document>,
        id: &'a str,
    ) -> StoreFuture<'a, ()>;
}

/// One document's `tokenHash`/`overlayToken` compare-and-set store.
///
/// Construction resolves a collection handle only: it does not connect, create
/// a collection, install an index, read data or start a task.
#[derive(Clone)]
pub struct MongoOverlayTokenStore {
    collection: Collection<Document>,
    id: String,
    revision_on_replace: bool,
    ensure: Option<Arc<dyn EnsureOverlayTokenDocument>>,
}

impl fmt::Debug for MongoOverlayTokenStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MongoOverlayTokenStore")
            .field("collection", &self.collection.name())
            .field("id", &self.id)
            .field("revision_on_replace", &self.revision_on_replace)
            .field("ensure", &self.ensure.is_some())
            .finish()
    }
}

impl MongoOverlayTokenStore {
    /// No revision bump on replace, and no document guard.
    pub fn new(collection: Collection<Document>, id: impl Into<String>) -> Self {
        Self {
            collection,
            id: id.into(),
            revision_on_replace: false,
            ensure: None,
        }
    }

    /// Adds `$inc: {revision: 1}` to a replacing save. Widget, roulette and duel
    /// channel documents use this; the pet runtime document has no revision.
    pub fn incrementing_revision(mut self) -> Self {
        self.revision_on_replace = true;
        self
    }

    /// Runs the owner's create-if-missing step before every read.
    pub fn ensuring(mut self, ensure: Arc<dyn EnsureOverlayTokenDocument>) -> Self {
        self.ensure = Some(ensure);
        self
    }

    /// The guarded document id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The collection this store reads and writes.
    pub fn collection(&self) -> &Collection<Document> {
        &self.collection
    }
}

fn decode_token_document(document: Document) -> Result<OverlayTokenDocument, OverlayTokenError> {
    let token_hash = match document.get(TOKEN_HASH_FIELD) {
        None | Some(Bson::Null) => None,
        Some(Bson::String(value)) => Some(value.clone()),
        Some(_) => return Err(store_error("Invalid overlay token hash")),
    };
    let overlay_token = match document.get(OVERLAY_TOKEN_FIELD) {
        None | Some(Bson::Null) => None,
        Some(Bson::Document(envelope)) => Some(
            from_bson::<StoredCredential>(Bson::Document(envelope.clone()))
                .map_err(|error| store_error(error.to_string()))?,
        ),
        Some(_) => return Err(store_error("Invalid overlay token envelope")),
    };
    Ok(OverlayTokenDocument {
        token_hash,
        overlay_token,
    })
}

impl OverlayTokenStore for MongoOverlayTokenStore {
    fn read(&self) -> StoreFuture<'_, OverlayTokenDocument> {
        Box::pin(async move {
            if let Some(ensure) = &self.ensure {
                ensure.ensure(&self.collection, &self.id).await?;
            }
            let document = self
                .collection
                .find_one(doc! { "_id": &self.id })
                .projection(doc! { "tokenHash": 1, "overlayToken": 1 })
                .await?
                .ok_or_else(|| {
                    store_error("Overlay token document disappeared during read")
                })?;
            decode_token_document(document)
        })
    }

    fn save(
        &self,
        expected_hash: Option<String>,
        token_hash: String,
        overlay_token: StoredCredential,
        replace: bool,
    ) -> StoreFuture<'_, bool> {
        Box::pin(async move {
            let envelope = to_document(&overlay_token)
                .map_err(|error| store_error(error.to_string()))?;
            let mut update = doc! {
                "$set": {
                    "tokenHash": token_hash,
                    "overlayToken": envelope,
                },
            };
            if replace && self.revision_on_replace {
                update.insert("$inc", doc! { "revision": 1_i32 });
            }
            let expected = match expected_hash {
                Some(hash) => Bson::String(hash),
                None => Bson::Null,
            };
            let saved = self
                .collection
                .update_one(doc! { "_id": &self.id, "tokenHash": expected }, update)
                .await?;
            Ok(saved.matched_count == 1)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape_matches_the_javascript_regex() {
        assert!(token_shape(&"A".repeat(43)));
        assert!(token_shape(&format!("{}{}", "a".repeat(42), "_")));
        assert!(token_shape(&format!("{}{}", "a".repeat(42), "-")));
        assert!(!token_shape(&"A".repeat(42)));
        assert!(!token_shape(&"A".repeat(44)));
        assert!(!token_shape(&format!("{}{}", "a".repeat(42), "+")));
        assert!(!token_shape(&format!("{}{}", "a".repeat(42), "é")));
    }

    #[test]
    fn base64url_has_no_padding_and_uses_the_url_alphabet() {
        assert_eq!(base64url(&[]), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
        assert_eq!(base64url(&[0_u8; TOKEN_BYTES]).len(), TOKEN_LENGTH);
    }
}
