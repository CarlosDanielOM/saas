//! Digests, HMAC and constant-time comparison (`createHash`, `createHmac`, `timingSafeEqual`).
//!
//! Text input is hashed as its UTF-8 bytes, which is what `hash.update(string)` does.

use super::encoding::{encode_base64, encode_base64url, encode_hex};
use crate::secret::SecretBytes;
use hmac::{Hmac, Mac};
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq;

/// A digest or MAC value with Node's text encodings (`digest('hex')`, `'base64'`, `'base64url'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Hash<const N: usize>(pub [u8; N]);

impl<const N: usize> Hash<N> {
    /// The raw bytes (`digest()`).
    pub fn bytes(&self) -> &[u8; N] {
        &self.0
    }

    /// `digest('hex')`.
    pub fn hex(&self) -> String {
        encode_hex(&self.0)
    }

    /// `digest('base64')`.
    pub fn base64(&self) -> String {
        encode_base64(&self.0)
    }

    /// `digest('base64url')`.
    pub fn base64url(&self) -> String {
        encode_base64url(&self.0)
    }
}

/// `createHash('sha256').update(data).digest()`.
pub fn sha256(data: impl AsRef<[u8]>) -> Hash<32> {
    Hash(Sha256::digest(data.as_ref()).into())
}

/// `createHash('sha1').update(data).digest()`.
pub fn sha1(data: impl AsRef<[u8]>) -> Hash<20> {
    Hash(Sha1::digest(data.as_ref()).into())
}

/// `createHash('md5').update(data).digest()`.
pub fn md5(data: impl AsRef<[u8]>) -> Hash<16> {
    Hash(Md5::digest(data.as_ref()).into())
}

/// `createHmac('sha256', key)` updated with each part in order, then `digest()`.
pub fn hmac_sha256_parts(key: &SecretBytes, parts: &[&[u8]]) -> Hash<32> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.expose())
        .unwrap_or_else(|_| unreachable_hmac_key());
    for part in parts {
        mac.update(part);
    }
    Hash(mac.finalize().into_bytes().into())
}

/// `createHmac('sha256', key).update(data).digest()`.
pub fn hmac_sha256(key: &SecretBytes, data: impl AsRef<[u8]>) -> Hash<32> {
    hmac_sha256_parts(key, &[data.as_ref()])
}

/// HMAC accepts keys of any length, so `new_from_slice` cannot fail; this keeps the call total.
fn unreachable_hmac_key() -> Hmac<Sha256> {
    // An HMAC over an empty key is still a valid (if useless) MAC; it is never reached.
    Hmac::<Sha256>::new(&Default::default())
}

/// Constant-time equality for secrets and signatures.
///
/// When the lengths differ the answer is `false` at once: only the length is revealed, never
/// the content. Every reference site checks the length before `crypto.timingSafeEqual` (which
/// throws on unequal lengths), so `false` is also the reference's result, except where the
/// reference compared JavaScript string lengths and then threw on unequal byte lengths; those
/// sites are listed in this crate's report and answer `false` here.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_answers() {
        assert_eq!(
            sha256("abc").hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha1("abc").hex(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(md5("abc").hex(), "900150983cd24fb0d6963f7d28e17f72");
        let key = SecretBytes::from_text("key");
        assert_eq!(
            hmac_sha256(&key, "The quick brown fox jumps over the lazy dog").hex(),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        assert_eq!(
            hmac_sha256_parts(&key, &[b"The quick ", b"brown fox jumps over the lazy dog"]),
            hmac_sha256(&key, "The quick brown fox jumps over the lazy dog")
        );
    }

    #[test]
    fn constant_time_eq_rejects_length_mismatch() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }
}
