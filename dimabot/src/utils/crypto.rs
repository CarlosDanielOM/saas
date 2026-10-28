//! Legacy `dimabot/src/utils/crypto.ts` storage codec. Opt-in and explicitly initialized.
//! [`CredentialCipher::from_env`] snapshots `SECRET_KEY` at application startup;
//! importing this module never reads process configuration.
//!
//! AES-256-CTR with a full 128-bit big-endian counter preserves existing Mongo
//! envelopes. This format is unauthenticated, as in the source; it is not a new
//! general encryption format. Keys use JavaScript `padEnd(32)` (UTF-16 length),
//! then UTF-8 bytes, and must be exactly 32 bytes. Invalid keys fail at explicit
//! construction instead of at the source's first nonempty cipher operation.
//! Rust strings cannot represent lone UTF-16 surrogates; callers must perform
//! JavaScript's replacement conversion before passing such strings here.

use std::fmt;

use aes::cipher::{KeyIvInit, StreamCipher};
use serde::{Deserialize, Serialize};

type LegacyCtr = ctr::Ctr128BE<aes::Aes256>;

/// Both `{iv:null,content:null}` revocation and `{iv:"",content:""}` empty
/// encryption are retained, rather than collapsing their stored shapes.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCredential {
    #[serde(default)]
    pub iv: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}
impl fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredCredential(<redacted>)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialCryptoError {
    MissingKey,
    InvalidKeyLength,
    InvalidIvLength,
    EntropyUnavailable,
    CounterExhausted,
}
impl fmt::Display for CredentialCryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MissingKey => "Credential key is missing",
            Self::InvalidKeyLength => "Credential key must encode to 32 bytes after padding",
            Self::InvalidIvLength => "Credential IV must decode to 16 bytes",
            Self::EntropyUnavailable => "Credential entropy unavailable",
            Self::CounterExhausted => "Credential counter exhausted",
        })
    }
}
impl std::error::Error for CredentialCryptoError {}

#[derive(Clone)]
pub struct CredentialCipher {
    key: [u8; 32],
}
impl fmt::Debug for CredentialCipher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CredentialCipher(<redacted>)")
    }
}
impl CredentialCipher {
    /// Read the source module's `SECRET_KEY` once at an explicit application
    /// initialization boundary. Later environment changes do not affect this
    /// cipher. Missing/empty, non-UTF8, and invalid-length keys return redacted
    /// errors; invalid lengths retain the accepted eager-construction check.
    pub fn from_env() -> Result<Self, CredentialCryptoError> {
        let secret_key =
            std::env::var("SECRET_KEY").map_err(|_| CredentialCryptoError::MissingKey)?;
        Self::new(&secret_key)
    }

    pub fn new(secret_key: &str) -> Result<Self, CredentialCryptoError> {
        if secret_key.is_empty() {
            return Err(CredentialCryptoError::MissingKey);
        }
        let padding = 32_usize.saturating_sub(secret_key.encode_utf16().count());
        if secret_key.len().saturating_add(padding) != 32 {
            return Err(CredentialCryptoError::InvalidKeyLength);
        }
        let mut key = [b' '; 32];
        key[..secret_key.len()].copy_from_slice(secret_key.as_bytes());
        Ok(Self { key })
    }

    pub fn encrypt(&self, text: &str) -> Result<StoredCredential, CredentialCryptoError> {
        if text.is_empty() {
            return self.encrypt_with_iv(text, [0; 16]);
        }
        let mut iv = [0; 16];
        getrandom::fill(&mut iv).map_err(|_| CredentialCryptoError::EntropyUnavailable)?;
        self.encrypt_with_iv(text, iv)
    }

    /// Deterministic parity/test API. Production callers must use `encrypt`;
    /// reusing an IV with this legacy format exposes plaintext relationships.
    pub fn encrypt_with_iv(
        &self,
        text: &str,
        iv: [u8; 16],
    ) -> Result<StoredCredential, CredentialCryptoError> {
        if text.is_empty() {
            return Ok(StoredCredential {
                iv: Some(String::new()),
                content: Some(String::new()),
            });
        }
        let mut content = text.as_bytes().to_vec();
        self.apply(&iv, &mut content)?;
        Ok(StoredCredential {
            iv: Some(hex(&iv)),
            content: Some(hex(&content)),
        })
    }

    pub fn decrypt(
        &self,
        envelope: Option<&StoredCredential>,
    ) -> Result<Option<String>, CredentialCryptoError> {
        let Some(envelope) = envelope else {
            return Ok(None);
        };
        let (Some(iv), Some(content)) = (&envelope.iv, &envelope.content) else {
            return Ok(None);
        };
        if iv.is_empty() || content.is_empty() {
            return Ok(None);
        }
        let iv: [u8; 16] = node_hex(iv)
            .try_into()
            .map_err(|_| CredentialCryptoError::InvalidIvLength)?;
        let mut bytes = node_hex(content);
        self.apply(&iv, &mut bytes)?;
        // Buffer.toString('utf8') replaces malformed sequences instead of failing.
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn apply(&self, iv: &[u8; 16], bytes: &mut [u8]) -> Result<(), CredentialCryptoError> {
        let mut cipher = LegacyCtr::new(&self.key.into(), &(*iv).into());
        cipher
            .try_apply_keystream(bytes)
            .map_err(|_| CredentialCryptoError::CounterExhausted)
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

// Buffer.from(value, 'hex') stops before the first malformed pair and ignores
// an unmatched final nibble. This permissiveness is part of legacy decoding.
fn node_hex(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().as_chunks::<2>().0 {
        let (Some(hi), Some(lo)) = (nibble(pair[0]), nibble(pair[1])) else {
            break;
        };
        out.push(hi * 16 + lo);
    }
    out
}
