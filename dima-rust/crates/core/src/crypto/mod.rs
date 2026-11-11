//! Crypto that interoperates byte for byte with the TypeScript reference.
//!
//! - [`cipher`]: the stored-credential cipher (`utils/crypto.ts`).
//! - [`digest`]: SHA-256, SHA-1, MD5, HMAC-SHA256 with Node's encodings; constant-time equality.
//! - [`encoding`]: hex and base64 as `Buffer` writes and (leniently) reads them.
//! - [`jwt`]: `jsonwebtoken`-compatible HMAC JWTs and the DimaFX extension verifier.
//! - [`webhook`]: Twitch EventSub and Polar (standardwebhooks) signatures.
//! - [`keys`]: hashed lookup keys and `SECRET_KEY`-signed tokens.
//!
//! Key material is passed as [`SecretBytes`](crate::SecretBytes) or
//! [`SecretString`](crate::SecretString), whose `Debug` output is a placeholder; no error in this
//! module carries key material or token text.

pub mod cipher;
pub mod digest;
pub mod encoding;
pub mod jwt;
pub mod keys;
pub mod webhook;

pub use cipher::{CipherError, CredentialCipher, StoredCredential};
pub use digest::{Hash, constant_time_eq, hmac_sha256, md5, sha1, sha256};
