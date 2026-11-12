//! The stored-credential cipher of `dimabot/src/utils/crypto.ts`, byte for byte.
//!
//! - Algorithm `aes-256-ctr`, no authentication tag. The 16-byte IV is the whole initial counter
//!   block, incremented as one 128-bit big-endian number (OpenSSL CTR, wrapping at 2^128).
//! - Key: `Buffer.from(SECRET_KEY.padEnd(32), 'utf-8')`: the text right-padded with spaces to 32
//!   UTF-16 code units, then UTF-8 encoded; it must come to exactly 32 bytes.
//! - Stored shape `{ iv, content }`, both lowercase hex; the content has as many bytes as the
//!   UTF-8 plaintext. Encrypting `""` stores `{ iv: "", content: "" }`.
//! - Decrypting: an empty `iv` or `content` gives `None` (the reference's `null`); hex is read
//!   leniently, as `Buffer.from(x, 'hex')` does; an IV that does not come to 16 bytes is an error
//!   (Node throws `Invalid initialization vector`); the plaintext bytes are decoded as UTF-8 with
//!   replacement characters, as `buffer.toString()` does, so a wrong key yields garbage text, not
//!   an error.
//!
//! Deliberate difference: the reference throws `Invalid key length` on the first non-empty
//! encrypt or decrypt; here [`CredentialCipher::new`] rejects such a key up front.

use super::encoding::{decode_hex_lenient, encode_hex};
use crate::random::{RandomError, SecureRandom};
use crate::secret::SecretBytes;
use aes::cipher::{KeyIvInit, StreamCipher};
use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::Zeroize;

type Aes256Ctr = ctr::Ctr128BE<aes::Aes256>;

/// The `{ iv, content }` value stored in MongoDB. `Debug` hides both fields.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCredential {
    /// The IV as lowercase hex (32 characters), or `""` for an empty plaintext.
    pub iv: String,
    /// The ciphertext as lowercase hex, or `""` for an empty plaintext.
    pub content: String,
}

impl fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredCredential(<redacted>)")
    }
}

/// Why a credential could not be encrypted or decrypted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CipherError {
    /// `SECRET_KEY` is unset or empty (the reference throws `SECRET_KEY is not set` at import).
    #[error("SECRET_KEY is not set")]
    MissingKey,
    /// The padded key is not 32 bytes of UTF-8 (`Invalid key length` in Node).
    #[error("Invalid key length")]
    InvalidKeyLength,
    /// The stored IV does not decode to 16 bytes (`Invalid initialization vector` in Node).
    #[error("Invalid initialization vector")]
    InvalidIv,
    /// The keystream would run past the end of the counter space (needs ~2^132 bytes; unreachable).
    #[error("counter exhausted")]
    CounterExhausted,
    /// No random bytes for the IV.
    #[error(transparent)]
    Random(#[from] RandomError),
}

/// AES-256-CTR with the reference's key derivation. `Debug` hides the key.
#[derive(Clone)]
pub struct CredentialCipher {
    key: SecretBytes,
}

impl fmt::Debug for CredentialCipher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CredentialCipher(<redacted>)")
    }
}

impl CredentialCipher {
    /// Derives the key from `SECRET_KEY` exactly as `crypto.ts` does.
    pub fn new(secret_key: &str) -> Result<Self, CipherError> {
        if secret_key.is_empty() {
            return Err(CipherError::MissingKey);
        }
        let padding = 32_usize.saturating_sub(dima_text::utf16_len(secret_key));
        if secret_key.len() + padding != 32 {
            return Err(CipherError::InvalidKeyLength);
        }
        // Sized up front: growing the buffer would leave a copy of the key behind.
        let mut key = Vec::with_capacity(32);
        key.extend_from_slice(secret_key.as_bytes());
        key.resize(32, b' ');
        Ok(Self {
            key: SecretBytes::new(key),
        })
    }

    /// `encrypt(text)` with a fresh random IV from a generator fit for secrets.
    pub fn encrypt(
        &self,
        text: &str,
        random: &dyn SecureRandom,
    ) -> Result<StoredCredential, CipherError> {
        if text.is_empty() {
            return Ok(StoredCredential::default());
        }
        let mut iv = [0_u8; 16];
        random.fill(&mut iv)?;
        self.encrypt_iv(text, iv)
    }

    /// `encrypt(text)` with a chosen IV, for golden tests (feature `test-util`). Never reuse an IV
    /// with one key: this format has no authentication and a reused IV exposes both plaintexts.
    #[cfg(any(test, feature = "test-util"))]
    pub fn encrypt_with_iv(
        &self,
        text: &str,
        iv: [u8; 16],
    ) -> Result<StoredCredential, CipherError> {
        self.encrypt_iv(text, iv)
    }

    fn encrypt_iv(&self, text: &str, iv: [u8; 16]) -> Result<StoredCredential, CipherError> {
        if text.is_empty() {
            return Ok(StoredCredential::default());
        }
        let mut content = text.as_bytes().to_vec();
        self.apply(&iv, &mut content)?;
        Ok(StoredCredential {
            iv: encode_hex(&iv),
            content: encode_hex(&content),
        })
    }

    /// `decrypt(hash)`: `Ok(None)` when either field is empty, as the reference returns `null`.
    pub fn decrypt(&self, stored: &StoredCredential) -> Result<Option<String>, CipherError> {
        self.decrypt_fields(Some(&stored.iv), Some(&stored.content))
    }

    /// `decrypt(hash)` for fields that may be missing or `null` in the document.
    pub fn decrypt_fields(
        &self,
        iv: Option<&str>,
        content: Option<&str>,
    ) -> Result<Option<String>, CipherError> {
        let (Some(iv), Some(content)) = (iv, content) else {
            return Ok(None);
        };
        if iv.is_empty() || content.is_empty() {
            return Ok(None);
        }
        let iv: [u8; 16] = decode_hex_lenient(iv)
            .try_into()
            .map_err(|_| CipherError::InvalidIv)?;
        let mut bytes = decode_hex_lenient(content);
        self.apply(&iv, &mut bytes)?;
        // Valid UTF-8 becomes the result without a copy; otherwise the decrypted bytes are wiped
        // once the replacement text has been made from them.
        Ok(Some(match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(error) => {
                let mut bytes = error.into_bytes();
                let text = String::from_utf8_lossy(&bytes).into_owned();
                bytes.zeroize();
                text
            }
        }))
    }

    fn apply(&self, iv: &[u8; 16], bytes: &mut [u8]) -> Result<(), CipherError> {
        // Borrows the key (no copy on the stack); the expanded key schedule and the counter are
        // wiped when `cipher` drops (the `zeroize` features of `aes` and `ctr`).
        let mut cipher = Aes256Ctr::new_from_slices(self.key.expose(), iv)
            .map_err(|_| CipherError::InvalidKeyLength)?;
        cipher
            .try_apply_keystream(bytes)
            .map_err(|_| CipherError::CounterExhausted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_derivation_matches_pad_end() {
        assert!(CredentialCipher::new("short").is_ok());
        assert!(CredentialCipher::new(&"k".repeat(32)).is_ok());
        assert_eq!(
            CredentialCipher::new(&"k".repeat(33)).err(),
            Some(CipherError::InvalidKeyLength)
        );
        // 31 units padded to 32, but "é" is two bytes: 33 bytes.
        assert_eq!(
            CredentialCipher::new(&format!("{}é", "k".repeat(30))).err(),
            Some(CipherError::InvalidKeyLength)
        );
        // 16 two-byte characters: 16 units, padded with 16 spaces, 48 bytes.
        assert!(CredentialCipher::new(&"é".repeat(16)).is_err());
        // An astral character is 2 units and 4 bytes: 28 + 2 units = 30, padded 2: 28+4+2 = 34.
        assert!(CredentialCipher::new(&format!("{}😀", "k".repeat(28))).is_err());
        // 30 + 1 astral (2 units) = 32 units, 34 bytes.
        assert!(CredentialCipher::new(&format!("{}😀", "k".repeat(30))).is_err());
        assert_eq!(
            CredentialCipher::new("").err(),
            Some(CipherError::MissingKey)
        );
    }

    /// The golden vectors written by real Node (`tests/vectors/generate.mjs`): Rust encrypting
    /// with Node's IVs produces Node's bytes.
    #[test]
    fn encrypts_like_node() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/cipher.json");
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let cipher = CredentialCipher::new(file["key"].as_str().unwrap()).unwrap();
        let rows = file["encrypt"].as_array().unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            let iv: [u8; 16] = decode_hex_lenient(row["iv"].as_str().unwrap())
                .try_into()
                .unwrap();
            let stored = cipher
                .encrypt_with_iv(row["text"].as_str().unwrap(), iv)
                .unwrap();
            let expected: StoredCredential = serde_json::from_value(row["stored"].clone()).unwrap();
            assert_eq!(stored, expected, "{}", row["text"]);
        }
    }

    #[test]
    fn a_seeded_generator_gives_repeatable_ivs_in_tests() {
        let cipher = CredentialCipher::new("test-secret-key").unwrap();
        let first = cipher.encrypt("x", &crate::SeededRandom::new(5)).unwrap();
        let again = cipher.encrypt("x", &crate::SeededRandom::new(5)).unwrap();
        assert_eq!(first, again);
        assert_ne!(
            cipher.encrypt("x", &crate::SystemRandom).unwrap().iv,
            first.iv
        );
    }

    #[test]
    fn round_trips_and_handles_empty_values() {
        let cipher = CredentialCipher::new("test-secret-key").unwrap();
        let stored = cipher.encrypt_with_iv("token ✓", [7; 16]).unwrap();
        assert_eq!(stored.iv, "07".repeat(16));
        assert_eq!(stored.content.len(), "token ✓".len() * 2);
        assert_eq!(cipher.decrypt(&stored).unwrap().as_deref(), Some("token ✓"));
        assert_eq!(
            cipher.encrypt_with_iv("", [7; 16]).unwrap(),
            StoredCredential::default()
        );
        assert_eq!(cipher.decrypt(&StoredCredential::default()).unwrap(), None);
        assert_eq!(cipher.decrypt_fields(None, Some("00")).unwrap(), None);
        assert_eq!(
            cipher.decrypt_fields(Some("00"), Some("00")).err(),
            Some(CipherError::InvalidIv)
        );
        assert_eq!(format!("{stored:?}"), "StoredCredential(<redacted>)");
        assert_eq!(format!("{cipher:?}"), "CredentialCipher(<redacted>)");
    }
}
