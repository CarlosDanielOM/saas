//! [`Private`]: a value that never appears in `Debug` output (logs, panics, error reports).

use serde::{Deserialize, Serialize};
use std::fmt;

/// A private value: an e-mail address, a token, a `select: false` path, anything a person would
/// not want in a log. It reads and writes exactly like `T` (serde transparent), compares like
/// `T`, and its `Debug` prints [`Private::PLACEHOLDER`] whatever it holds. Get the value with
/// [`Private::expose`] where it is really used, never to log it.
///
/// Wrap the field, not its `Option`: `Option<Private<String>>` still shows whether a value is
/// there (`Some(<private>)`), which logs may tell.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Private<T>(T);

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
