//! Key material that never shows up in `Debug` output or error messages, and is wiped when
//! dropped.
//!
//! Wiping uses the `zeroize` crate, whose volatile writes the compiler cannot remove as dead
//! stores. It covers the value's own buffer; copies the caller made (or a buffer that grew and
//! moved before it was wrapped) are the caller's.

use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Secret bytes (keys, shared secrets). `Debug` prints a placeholder; equality is constant-time
/// for equal lengths; the bytes are overwritten with zeros when the value is dropped, or on
/// [`Zeroize::zeroize`], which also empties it.
#[derive(Clone, Eq, Default)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Wraps the given bytes.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// The UTF-8 bytes of `text`, as Node's `Buffer.from(text)` and `createHmac(alg, text)` use them.
    pub fn from_text(text: &str) -> Self {
        Self(text.as_bytes().to_vec())
    }

    /// The raw bytes. Call only where the bytes are handed to a primitive.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// Whether there are no bytes (JavaScript treats an empty secret string as unset).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl PartialEq for SecretBytes {
    fn eq(&self, other: &Self) -> bool {
        crate::crypto::digest::constant_time_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes(<redacted>)")
    }
}

impl Zeroize for SecretBytes {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl ZeroizeOnDrop for SecretBytes {}

/// A secret text value (for example `SECRET_KEY`). `Debug` prints a placeholder; equality is
/// constant-time for equal lengths; the text is overwritten with zeros when the value is dropped,
/// or on [`Zeroize::zeroize`], which also empties it.
#[derive(Clone, Eq, Default)]
pub struct SecretString(String);

impl SecretString {
    /// Wraps the given text.
    pub fn new(text: String) -> Self {
        Self(text)
    }

    /// The text. Call only where it is handed to a primitive.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether the text is empty (JavaScript treats `""` as unset).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The UTF-8 bytes as key material.
    pub fn to_bytes(&self) -> SecretBytes {
        SecretBytes::from_text(&self.0)
    }
}

impl From<&str> for SecretString {
    fn from(text: &str) -> Self {
        Self(text.to_owned())
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        crate::crypto::digest::constant_time_eq(self.0.as_bytes(), other.0.as_bytes())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl Zeroize for SecretString {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl ZeroizeOnDrop for SecretString {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_secret_types_are_wiped_by_zeroize() {
        fn wiped_on_drop<T: ZeroizeOnDrop>() {}
        wiped_on_drop::<SecretBytes>();
        wiped_on_drop::<SecretString>();
        let mut bytes = SecretBytes::from_text("hunter2");
        let mut text = SecretString::from("hunter2");
        bytes.zeroize();
        text.zeroize();
        assert!(bytes.is_empty() && text.is_empty());
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let bytes = SecretBytes::from_text("hunter2");
        let text = SecretString::from("hunter2");
        assert_eq!(format!("{bytes:?}"), "SecretBytes(<redacted>)");
        assert_eq!(format!("{text:?}"), "SecretString(<redacted>)");
        assert_eq!(bytes.expose(), b"hunter2");
        assert_eq!(text.to_bytes(), bytes);
    }
}
