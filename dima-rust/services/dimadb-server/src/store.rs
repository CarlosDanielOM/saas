//! The data directory (`store.mjs`): `users.json`, `sessions.json`, `connections.json` and
//! `secret`, plus the password hash and the connection-password cipher.
//!
//! Formats are the production data's (`/data` is a persistent volume shared with the Node
//! release this one would roll back to):
//!
//! - Lists are JSON arrays written as `JSON.stringify(rows, null, 2) + "\n"` to `<file>.tmp`,
//!   then renamed over the file. Missing, unreadable, invalid or non-array files read as `[]`.
//!   Rows are kept whole (unknown fields survive a rewrite).
//! - `secret`: `DIMADB_SECRET` when set (not trimmed); else the file's text, trimmed; else 32
//!   random bytes as hex plus `\n`, created with mode 0600.
//! - Passwords: `scrypt:<salt>:<hash>`, the salt 16 random bytes as 32 hex characters whose
//!   **ASCII text** is the scrypt salt, Node's `scryptSync` defaults (N=16384, r=8, p=1), 64-byte
//!   key as hex. Verification compares in constant time.
//! - Connection passwords: AES-256-GCM, key = SHA-256 of the secret text, 12-byte IV, stored as
//!   `ivhex:taghex:datahex`.
//!
//! Every request re-reads the files, as the reference does. Read-modify-write sequences hold
//! [`Store::lock`], which gives the serial order Node's single thread gave them.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes_gcm::aead::AeadInPlace as _;
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce, Tag};
use dima_core::crypto::encoding::{decode_hex_lenient, encode_hex};
use dima_core::{Random, SecretString};
use serde_json::Value;
use tokio::sync::{Mutex, MutexGuard, Semaphore};

use crate::error::{ApiError, ApiResult};

/// Largest data file read (users, sessions, connections). The reference has no limit; these
/// files hold a handful of rows.
pub const MAX_DATA_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// scrypt runs at most this many at once on blocking threads (the reference ran them on its
/// only thread, `scryptSync`, so everything waited).
const SCRYPT_CONCURRENCY: usize = 4;

/// The four files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum List {
    /// `users.json`.
    Users,
    /// `sessions.json`.
    Sessions,
    /// `connections.json`.
    Connections,
}

impl List {
    fn file_name(self) -> &'static str {
        match self {
            Self::Users => "users.json",
            Self::Sessions => "sessions.json",
            Self::Connections => "connections.json",
        }
    }
}

/// Why the store could not start.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The data directory could not be created.
    #[error("cannot create the data directory {path}: {source}")]
    DataDir {
        /// The directory.
        path: String,
        /// The cause.
        source: std::io::Error,
    },
    /// The secret file exists but cannot be read, or cannot be created.
    #[error("cannot use the secret file {path}: {source}")]
    Secret {
        /// The file.
        path: String,
        /// The cause.
        source: std::io::Error,
    },
    /// No randomness for a new secret.
    #[error("cannot generate a secret: {0}")]
    Random(String),
}

/// The data directory and the keys derived from the secret.
pub struct Store {
    dir: PathBuf,
    key: Aes256Gcm,
    random: Arc<dyn Random>,
    lock: Mutex<()>,
    scrypt: Semaphore,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

impl Store {
    /// `createStore(dataDir)`: creates the directory and loads or creates the secret.
    pub fn open(
        dir: &Path,
        env_secret: Option<&SecretString>,
        random: Arc<dyn Random>,
    ) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(|source| StoreError::DataDir {
            path: dir.display().to_string(),
            source,
        })?;
        let secret = load_secret(&dir.join("secret"), env_secret, random.as_ref())?;
        let digest = dima_core::crypto::sha256(secret.expose().as_bytes());
        let key = Aes256Gcm::new(digest.bytes().into());
        Ok(Self {
            dir: dir.to_path_buf(),
            key,
            random,
            lock: Mutex::new(()),
            scrypt: Semaphore::new(SCRYPT_CONCURRENCY),
        })
    }

    /// Serialises read-modify-write sequences on the files.
    pub async fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().await
    }

    /// The randomness source (ids, IVs, salts).
    pub fn random(&self) -> &dyn Random {
        self.random.as_ref()
    }

    fn path(&self, list: List) -> PathBuf {
        self.dir.join(list.file_name())
    }

    /// `readList(file)`: the rows, or `[]` when the file is missing, unreadable, not JSON or
    /// not an array. Keys enumerate as `JSON.parse` leaves them.
    pub async fn read(&self, list: List) -> Vec<Value> {
        read_list(&self.path(list)).await
    }

    /// `writeList(file, rows)`: pretty JSON to `<file>.tmp`, then rename.
    pub async fn write(&self, list: List, rows: &[Value]) -> ApiResult<()> {
        let path = self.path(list);
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        let text = format!("{}\n", pretty_json(&Value::Array(rows.to_vec())));
        tokio::fs::write(&tmp, text)
            .await
            .map_err(|error| io_error(&error, "open", &PathBuf::from(&tmp)))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|error| io_error(&error, "rename", &PathBuf::from(&tmp)))
    }

    /// `hashPassword(password)`: `scrypt:<salt>:<hash>`.
    pub async fn hash_password(&self, password: Vec<u8>) -> ApiResult<String> {
        let salt = self
            .random
            .hex_token(16)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let hash = self.scrypt(password, salt.clone().into_bytes()).await?;
        Ok(format!("scrypt:{salt}:{}", encode_hex(&hash)))
    }

    /// `verifyPassword(password, stored)`: the same scrypt over the stored salt, compared in
    /// constant time; a malformed stored value is a mismatch.
    pub async fn verify_password(&self, password: Vec<u8>, stored: &str) -> ApiResult<bool> {
        let mut parts = stored.split(':');
        let (Some(algo), Some(salt), Some(hash)) = (parts.next(), parts.next(), parts.next())
        else {
            return Ok(false);
        };
        if algo != "scrypt" || salt.is_empty() || hash.is_empty() {
            return Ok(false);
        }
        let actual = self.scrypt(password, salt.as_bytes().to_vec()).await?;
        let expected = decode_hex_lenient(hash);
        Ok(dima_core::crypto::constant_time_eq(&actual, &expected))
    }

    async fn scrypt(&self, password: Vec<u8>, salt: Vec<u8>) -> ApiResult<Vec<u8>> {
        let _permit = self
            .scrypt
            .acquire()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        tokio::task::spawn_blocking(move || scrypt_node(&password, &salt))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
    }

    /// `encrypt(value)`: `''` for empty text, else `ivhex:taghex:datahex`.
    pub fn encrypt(&self, value: &str) -> ApiResult<String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        let iv = self
            .random
            .bytes(12)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut data = value.as_bytes().to_vec();
        let tag = self
            .key
            .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut data)
            .map_err(|_| ApiError::internal("encryption failed"))?;
        Ok(format!(
            "{}:{}:{}",
            encode_hex(&iv),
            encode_hex(&tag),
            encode_hex(&data)
        ))
    }

    /// `decrypt(payload)`. Failures carry Node's messages (they reach the client as 500s).
    pub fn decrypt(&self, payload: &str) -> ApiResult<String> {
        if payload.is_empty() {
            return Ok(String::new());
        }
        let mut parts = payload.split(':');
        let iv = decode_hex_lenient(parts.next().unwrap_or_default());
        let tag = parts.next().map(decode_hex_lenient);
        let data = parts.next().map(decode_hex_lenient);
        let (Some(tag), Some(mut data)) = (tag, data) else {
            return Err(ApiError::internal(
                "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined",
            ));
        };
        if iv.is_empty() {
            return Err(ApiError::internal("Invalid initialization vector"));
        }
        if !matches!(tag.len(), 4 | 8 | 12..=16) {
            return Err(ApiError::internal(format!(
                "Invalid authentication tag length: {}",
                tag.len()
            )));
        }
        // Only the 12-byte IV and 16-byte tag this service writes can authenticate here; Node
        // also accepts other lengths, which no stored value uses.
        let unauthenticated =
            || ApiError::internal("Unsupported state or unable to authenticate data");
        if iv.len() != 12 || tag.len() != 16 {
            return Err(unauthenticated());
        }
        self.key
            .decrypt_in_place_detached(
                Nonce::from_slice(&iv),
                b"",
                &mut data,
                Tag::from_slice(&tag),
            )
            .map_err(|_| unauthenticated())?;
        Ok(String::from_utf8_lossy(&data).into_owned())
    }
}

/// Node's `scryptSync(password, salt, 64)` with default cost.
pub fn scrypt_node(password: &[u8], salt: &[u8]) -> ApiResult<Vec<u8>> {
    let params =
        scrypt::Params::new(14, 8, 1, 64).map_err(|error| ApiError::internal(error.to_string()))?;
    let mut out = vec![0_u8; 64];
    scrypt::scrypt(password, salt, &params, &mut out)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(out)
}

fn load_secret(
    file: &Path,
    env_secret: Option<&SecretString>,
    random: &dyn Random,
) -> Result<SecretString, StoreError> {
    if let Some(secret) = env_secret.filter(|secret| !secret.is_empty()) {
        return Ok(secret.clone());
    }
    let failed = |source| StoreError::Secret {
        path: file.display().to_string(),
        source,
    };
    match std::fs::read(file) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            return Ok(SecretString::new(dima_text::trim(&text).to_owned()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(failed(error)),
    }
    let generated = random
        .hex_token(32)
        .map_err(|error| StoreError::Random(error.to_string()))?;
    write_new_secret(file, &format!("{generated}\n")).map_err(failed)?;
    Ok(SecretString::new(generated))
}

fn write_new_secret(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    handle.write_all(text.as_bytes())
}

async fn read_list(path: &Path) -> Vec<Value> {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return Vec::new();
    };
    if metadata.len() > MAX_DATA_FILE_BYTES {
        return Vec::new();
    }
    let Ok(bytes) = tokio::fs::read(path).await else {
        return Vec::new();
    };
    // `readFileSync(file, 'utf8')` replaces invalid bytes; a BOM stays and fails JSON.parse.
    let text = String::from_utf8_lossy(&bytes);
    match crate::js::parse_json(text.as_bytes()) {
        Some(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

/// A failed file operation as Node words it (`EACCES: permission denied, open '<path>'`).
fn io_error(error: &std::io::Error, syscall: &str, path: &Path) -> ApiError {
    let code = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "EACCES: permission denied",
        std::io::ErrorKind::NotFound => "ENOENT: no such file or directory",
        std::io::ErrorKind::StorageFull => "ENOSPC: no space left on device",
        std::io::ErrorKind::ReadOnlyFilesystem => "EROFS: read-only file system",
        _ => "EIO: i/o error",
    };
    ApiError::internal(format!("{code}, {syscall} '{}'", path.display()))
}

/// `JSON.stringify(value, null, 2)`.
pub fn pretty_json(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, depth: usize, out: &mut String) {
    let indent = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                write_pretty(item, depth + 1, out);
            }
            indent(out, depth);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                out.push_str(&dima_text::to_js_json(&Value::String(key.clone())));
                out.push_str(": ");
                write_pretty(item, depth + 1, out);
            }
            indent(out, depth);
            out.push('}');
        }
        other => out.push_str(&dima_text::to_js_json(other)),
    }
}

/// Node's `ERR_INVALID_ARG_TYPE` text for a `password` argument that is not a string (the
/// reference passes request values straight to `scryptSync`).
pub fn password_bytes(value: Option<&Value>) -> ApiResult<Vec<u8>> {
    let received = match value {
        Some(Value::String(text)) => return Ok(text.as_bytes().to_vec()),
        None => "Received undefined".to_owned(),
        Some(Value::Null) => "Received null".to_owned(),
        Some(Value::Bool(flag)) => format!("Received type boolean ({flag})"),
        Some(Value::Number(number)) => format!(
            "Received type number ({})",
            inspect_number(number.as_f64().unwrap_or(f64::NAN))
        ),
        Some(Value::Array(_)) => "Received an instance of Array".to_owned(),
        Some(Value::Object(_)) => "Received an instance of Object".to_owned(),
    };
    Err(ApiError::internal(format!(
        "The \"password\" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. {received}"
    )))
}

/// `util.inspect(number)`: `-0` keeps its sign.
fn inspect_number(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() {
        "-0".to_owned()
    } else {
        dima_text::number_to_string(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::SeededRandom;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dimadb-store-{name}-{}-{}",
            std::process::id(),
            dima_core::SystemRandom.hex_token(4).unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn pretty_json_is_json_stringify_with_two_spaces() {
        let value = json!([{"id": "a", "n": 1.5, "e": [], "o": {}, "l": [1, {"x": null}], "t": "é😀\u{1}"}]);
        let expected = [
            "[",
            "  {",
            "    \"id\": \"a\",",
            "    \"n\": 1.5,",
            "    \"e\": [],",
            "    \"o\": {},",
            "    \"l\": [",
            "      1,",
            "      {",
            "        \"x\": null",
            "      }",
            "    ],",
            "    \"t\": \"é😀\\u0001\"",
            "  }",
            "]",
        ]
        .join("\n");
        assert_eq!(pretty_json(&value), expected);
        assert_eq!(pretty_json(&json!([])), "[]");
    }

    /// `scryptSync('correct horse 🐴', 'a1b2...', 64)` from Node 26.
    #[test]
    fn scrypt_matches_node() -> Result<(), ApiError> {
        let hash = scrypt_node(
            "correct horse 🐴".as_bytes(),
            b"00112233445566778899aabbccddeeff",
        )?;
        assert_eq!(
            encode_hex(&hash),
            "15ab3385f4c3644c234753144d67a61542411fde51c749b65cea826000414623287b594ea487415bc7fa537fe347c4e383a78fed1c333aafacddabe4483c70d2"
        );
        Ok(())
    }

    #[tokio::test]
    async fn secret_and_cipher_round_trip() -> Result<(), String> {
        let dir = scratch("secret");
        let random: Arc<dyn Random> = Arc::new(SeededRandom::new(7));
        let store = Store::open(&dir, None, Arc::clone(&random)).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(dir.join("secret")).map_err(|e| e.to_string())?;
        assert_eq!(text.len(), 65);
        assert!(text.ends_with('\n'));
        let sealed = store.encrypt("p@ss 🔑").map_err(|e| e.message)?;
        assert_eq!(sealed.split(':').count(), 3);
        assert_eq!(store.decrypt(&sealed).map_err(|e| e.message)?, "p@ss 🔑");
        // A second start reads the same secret.
        let again = Store::open(&dir, None, random).map_err(|e| e.to_string())?;
        assert_eq!(again.decrypt(&sealed).map_err(|e| e.message)?, "p@ss 🔑");
        let mut tampered = sealed.clone();
        tampered.pop();
        tampered.push(if sealed.ends_with('0') { '1' } else { '0' });
        assert_eq!(again.decrypt(&tampered).map_err(|e| e.status), Err(500));
        assert_eq!(store.encrypt("").map_err(|e| e.message)?, "");
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[tokio::test]
    async fn lists_read_leniently_and_write_atomically() -> Result<(), String> {
        let dir = scratch("lists");
        let store = Store::open(
            &dir,
            Some(&SecretString::new("k".into())),
            Arc::new(SeededRandom::new(1)),
        )
        .map_err(|e| e.to_string())?;
        assert!(!dir.join("secret").exists());
        assert!(store.read(List::Users).await.is_empty());
        std::fs::write(dir.join("users.json"), "{\"not\":\"a list\"}")
            .map_err(|e| e.to_string())?;
        assert!(store.read(List::Users).await.is_empty());
        std::fs::write(dir.join("users.json"), "not json").map_err(|e| e.to_string())?;
        assert!(store.read(List::Users).await.is_empty());
        let rows = vec![json!({"id": "u1", "extra": {"2": 1, "a": 2}})];
        store
            .write(List::Users, &rows)
            .await
            .map_err(|e| e.message)?;
        assert_eq!(store.read(List::Users).await, rows);
        assert!(!dir.join("users.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn password_argument_errors_match_node() {
        let message = |value: Option<&Value>| password_bytes(value).err().map(|e| e.message);
        assert_eq!(
            message(Some(&json!(123_456_789))).as_deref(),
            Some(
                "The \"password\" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received type number (123456789)"
            )
        );
        assert!(message(None).is_some_and(|m| m.ends_with("Received undefined")));
        assert!(
            message(Some(&json!([1])))
                .is_some_and(|m| m.ends_with("Received an instance of Array"))
        );
        assert_eq!(
            password_bytes(Some(&json!("ok"))).ok(),
            Some(b"ok".to_vec())
        );
    }
}
