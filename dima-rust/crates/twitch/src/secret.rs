//! Twitch credentials as values that never print: [`AccessToken`] and [`RefreshToken`].
//!
//! Both wrap [`dima_core::SecretString`] (wiped on drop, constant-time equality, `Debug` prints a
//! placeholder). Reading the text is explicit ([`AccessToken::expose`]), and the only place the
//! crate does it is where the token goes on the wire or into the store.

use dima_core::SecretString;
use dima_core::crypto::{CredentialCipher, StoredCredential};
use dima_http::HeaderValue;
use dima_model::users::EncryptedToken;
use std::fmt;

/// A Twitch user or app access token.
#[derive(Clone, PartialEq, Eq)]
pub struct AccessToken(SecretString);

/// A Twitch refresh token.
#[derive(Clone, PartialEq, Eq)]
pub struct RefreshToken(SecretString);

macro_rules! token_type {
    ($name:ident) => {
        impl $name {
            /// Wraps the token text.
            pub fn new(text: impl Into<String>) -> Self {
                Self(SecretString::new(text.into()))
            }

            /// Wraps a secret without copying it.
            pub(crate) fn from_secret(secret: SecretString) -> Self {
                Self(secret)
            }

            /// The text. Call only where it goes on the wire or into the store.
            pub fn expose(&self) -> &str {
                self.0.expose()
            }

            /// Whether the text is empty (JavaScript treats `""` as no token).
            pub fn is_empty(&self) -> bool {
                self.0.is_empty()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }
    };
}

token_type!(AccessToken);
token_type!(RefreshToken);

impl AccessToken {
    /// `Authorization: Bearer <token>`, marked sensitive for the HTTP stack. `None` when the
    /// token holds characters a header cannot carry.
    pub fn bearer(&self) -> Option<HeaderValue> {
        let mut value = HeaderValue::try_from(format!("Bearer {}", self.expose())).ok()?;
        value.set_sensitive(true);
        Some(value)
    }

    /// The token inside a `Bearer` header value: the reference's
    /// `Authorization.replace(/^Bearer\s+/i, '')` (no match leaves the value as it is).
    pub(crate) fn from_bearer(value: &HeaderValue) -> Option<Self> {
        let text = value.to_str().ok()?;
        let stripped = match text.get(..6) {
            Some(scheme) if scheme.eq_ignore_ascii_case("bearer") => {
                let rest = text.get(6..).unwrap_or_default();
                let trimmed = rest.trim_start_matches(|c: char| dima_text::is_js_whitespace(c));
                if trimmed.len() < rest.len() {
                    trimmed
                } else {
                    text
                }
            }
            _ => text,
        };
        Some(Self::new(stripped))
    }
}

/// A token as Dragonfly holds it (Rust's own encoding; `keys` family *rebuilt*): the `{iv,
/// content}` envelope MongoDB holds, as JSON text, or `""` for no token. The cache never holds
/// a token in plain text (the reference does).
pub(crate) fn cache_text(envelope: &StoredCredential) -> String {
    if envelope.iv.is_empty() || envelope.content.is_empty() {
        return String::new();
    }
    serde_json::to_string(envelope).unwrap_or_default()
}

/// [`cache_text`] of MongoDB's stored envelope, copied as it is (no decryption).
pub(crate) fn cache_text_of(envelope: &EncryptedToken) -> String {
    match (envelope.iv.as_deref(), envelope.content.as_deref()) {
        (Some(iv), Some(content)) if !iv.is_empty() && !content.is_empty() => {
            cache_text(&StoredCredential {
                iv: iv.to_owned(),
                content: content.to_owned(),
            })
        }
        _ => String::new(),
    }
}

/// Encrypts `token` for the cache.
pub(crate) fn seal(
    cipher: &CredentialCipher,
    random: &dyn dima_core::SecureRandom,
    token: &str,
) -> Result<String, dima_core::crypto::CipherError> {
    Ok(cache_text(&cipher.encrypt(token, random)?))
}

/// The token in a cached value: `None` for `""`, for text that is not an envelope, or for an
/// envelope that does not decrypt (each is treated as "no cached token": MongoDB decides).
pub(crate) fn open_cached(cipher: &CredentialCipher, text: &str) -> Option<SecretString> {
    if text.is_empty() {
        return None;
    }
    let envelope: StoredCredential = serde_json::from_str(text).ok()?;
    cipher
        .decrypt(&envelope)
        .ok()
        .flatten()
        .filter(|token| !token.is_empty())
        .map(SecretString::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_tokens_are_envelopes() {
        let cipher = CredentialCipher::new("test-secret-key").unwrap();
        let sealed = seal(&cipher, &dima_core::SystemRandom, "live-access-1").unwrap();
        assert!(!sealed.contains("live-access-1"));
        let envelope: StoredCredential = serde_json::from_str(&sealed).unwrap();
        assert_eq!(envelope.iv.len(), 32);
        assert_eq!(
            open_cached(&cipher, &sealed)
                .as_ref()
                .map(SecretString::expose),
            Some("live-access-1")
        );
        assert_eq!(seal(&cipher, &dima_core::SystemRandom, "").unwrap(), "");
        assert!(open_cached(&cipher, "").is_none());
        assert!(
            open_cached(&cipher, "live-access-1").is_none(),
            "plain text is no token"
        );
        assert!(open_cached(&cipher, r#"{"iv":"00","content":"ab"}"#).is_none());
        let empty = EncryptedToken {
            iv: None,
            content: None,
        };
        assert_eq!(cache_text_of(&empty), "");
    }

    #[test]
    fn tokens_never_print() {
        let access = AccessToken::new("live-access-1");
        let refresh = RefreshToken::new("live-refresh-1");
        assert_eq!(format!("{access:?}"), "AccessToken(<redacted>)");
        assert_eq!(format!("{refresh:?}"), "RefreshToken(<redacted>)");
        let header = access.bearer().unwrap();
        assert!(header.is_sensitive());
        assert_eq!(format!("{header:?}"), "Sensitive");
    }

    #[test]
    fn bearer_prefix_is_stripped_like_the_reference_regex() {
        let strip = |text: &str| {
            AccessToken::from_bearer(&HeaderValue::from_str(text).unwrap())
                .unwrap()
                .expose()
                .to_owned()
        };
        assert_eq!(strip("Bearer abc"), "abc");
        assert_eq!(strip("bearer   abc"), "abc");
        assert_eq!(strip("BEARER\tabc"), "abc");
        // `\s+` needs at least one space; without it the value is left as it is.
        assert_eq!(strip("Bearerabc"), "Bearerabc");
        assert_eq!(strip("OAuth abc"), "OAuth abc");
    }
}
