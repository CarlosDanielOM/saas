//! [`Private`]: a value that never appears in `Debug` output (logs, panics, error reports).

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// A private value: an e-mail address, a token, a `select: false` path, anything a person would
/// not want in a log. It reads and writes exactly like `T`, compares like `T`, and its `Debug`
/// prints [`Private::PLACEHOLDER`] whatever it holds. Get the value with [`Private::expose`]
/// where it is really used, never to log it.
///
/// A stored value that does not fit `T` fails to decode with an error that names the expected
/// type only (`invalid private value: expected String`): serde's own message would quote the
/// value (`invalid type: string "a@b.c"`), and a [`crate::DecodeError`] is printed in logs.
///
/// Wrap the field, not its `Option`: `Option<Private<String>>` still shows whether a value is
/// there (`Some(<private>)`), which logs may tell.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Private<T>(T);

impl<'de, T: DeserializeOwned> Deserialize<'de> for Private<T> {
    /// The value is read as BSON first, then as `T`; an error of the second step is replaced by
    /// one without the value (the decode error's path still names the field).
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = bson::Bson::deserialize(deserializer)?;
        bson::deserialize_from_bson::<T>(value)
            .map(Self)
            .map_err(|_| {
                D::Error::custom(format!(
                    "invalid private value: expected {}",
                    short_type_name(std::any::type_name::<T>())
                ))
            })
    }
}

/// `core::option::Option<alloc::string::String>` as `Option<String>`.
fn short_type_name(full: &str) -> String {
    let mut out = String::new();
    let mut ident = String::new();
    let mut chars = full.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' && chars.peek() == Some(&':') {
            chars.next();
            ident.clear();
        } else if c.is_alphanumeric() || c == '_' {
            ident.push(c);
        } else {
            out.push_str(&ident);
            ident.clear();
            out.push(c);
        }
    }
    out.push_str(&ident);
    out
}

impl<T> Private<T> {
    /// What `Debug` prints.
    pub const PLACEHOLDER: &'static str = "<private>";

    /// Wraps a value.
    pub const fn new(value: T) -> Self {
        Self(value)
    }

    /// The value, for the code that really uses it.
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// The value, unwrapped.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> From<T> for Private<T> {
    fn from(value: T) -> Self {
        Self(value)
    }
}

impl From<&str> for Private<String> {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl<T> fmt::Debug for Private<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(Self::PLACEHOLDER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[derive(Debug, Deserialize, Serialize)]
    struct Row {
        email: Option<Private<String>>,
        token: Private<String>,
    }

    #[test]
    fn errors_carry_no_value() -> Result<(), bson::error::Error> {
        let raw = bson::RawDocumentBuf::try_from(&doc! { "email": 12345, "token": "t0k" })?;
        let error = crate::decode::<Row>(&raw).err();
        assert_eq!(error.as_ref().map(|e| e.path.as_str()), Some("email"));
        let shown = error.as_ref().map(ToString::to_string).unwrap_or_default();
        assert!(
            shown.contains("invalid private value: expected String") && !shown.contains("12345"),
            "{shown}"
        );
        let raw = bson::RawDocumentBuf::try_from(&doc! { "token": { "secret": "s3cr3t" } })?;
        let shown = crate::decode::<Row>(&raw)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(
            !shown.contains("s3cr3t") && shown.starts_with("token:"),
            "{shown}"
        );
        assert_eq!(
            short_type_name("core::option::Option<alloc::string::String>"),
            "Option<String>"
        );
        Ok(())
    }

    #[test]
    fn transparent_but_never_printed() -> Result<(), bson::error::Error> {
        let row: Row = bson::deserialize_from_document(doc! { "email": "a@b.c", "token": "t0k" })?;
        let shown = format!("{row:?} {row:#?}");
        assert!(
            !shown.contains("a@b.c") && !shown.contains("t0k"),
            "{shown}"
        );
        assert!(shown.contains("Some(<private>)"));
        assert_eq!(
            row.email.as_ref().map(|e| e.expose().as_str()),
            Some("a@b.c")
        );
        assert_eq!(
            bson::serialize_to_document(&row)?,
            doc! { "email": "a@b.c", "token": "t0k" }
        );
        Ok(())
    }
}
