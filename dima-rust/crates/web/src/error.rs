//! The error value that travels down the error path (`next(err)` in Express).

use std::borrow::Cow;
use std::fmt;

type Source = Box<dyn std::error::Error + Send + Sync + 'static>;

/// An error passed down the layer stack, like the `err` of Express's `next(err)`.
///
/// It carries what Express and its default error handler read from a JavaScript error: an
/// optional HTTP status (`err.status`), the body-parser `type` string, a message and extra
/// headers (`err.headers`, honoured only when the status is 400..=599). Any `std::error::Error`
/// converts into it with `?` and has no status, so it ends as a 500 unless a router-level error
/// handler maps it. Error handlers recover the original value with [`Error::downcast_ref`].
///
/// This type deliberately does not implement `std::error::Error` itself, so the blanket `From`
/// conversion can exist (the same design as `anyhow::Error`).
pub struct Error {
    inner: Box<Inner>,
}

struct Inner {
    status: Option<u16>,
    kind: Option<Cow<'static, str>>,
    message: Cow<'static, str>,
    headers: Vec<(String, String)>,
    source: Option<Source>,
}

impl Error {
    /// An error with an HTTP status, like `createError(status, message)` from `http-errors`.
    pub fn new(status: u16, message: impl Into<Cow<'static, str>>) -> Self {
        Self::build(Some(status), message.into(), None)
    }

    /// An error without a status (a plain JavaScript `Error`): the default handler answers 500.
    pub fn msg(message: impl Into<Cow<'static, str>>) -> Self {
        Self::build(None, message.into(), None)
    }

    /// Wraps any error value, keeping it for [`Error::downcast_ref`].
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        let message = source.to_string();
        Self::build(None, Cow::Owned(message), Some(Box::new(source)))
    }

    fn build(status: Option<u16>, message: Cow<'static, str>, source: Option<Source>) -> Self {
        Self {
            inner: Box::new(Inner {
                status,
                kind: None,
                message,
                headers: Vec::new(),
                source,
            }),
        }
    }

    /// Sets or replaces the status (`err.status = …`).
    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.inner.status = Some(status);
        self
    }

    /// Sets the `type` string body-parser and raw-body attach (`entity.parse.failed`, …).
    #[must_use]
    pub fn with_kind(mut self, kind: impl Into<Cow<'static, str>>) -> Self {
        self.inner.kind = Some(kind.into());
        self
    }

    /// Adds a header the default error handler sends (`err.headers`).
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner.headers.push((name.into(), value.into()));
        self
    }

    /// The status the error carries, if any (`err.status`).
    pub fn status(&self) -> Option<u16> {
        self.inner.status
    }

    /// The body-parser / raw-body `type` string, if any.
    pub fn kind(&self) -> Option<&str> {
        self.inner.kind.as_deref()
    }

    /// The message (`err.message`).
    pub fn message(&self) -> &str {
        &self.inner.message
    }

    /// Extra headers for the default error response (`err.headers`).
    pub fn headers(&self) -> &[(String, String)] {
        &self.inner.headers
    }

    /// `err.expose` as `http-errors` defines it: client errors are safe to show.
    pub fn expose(&self) -> bool {
        self.inner.status.is_some_and(|status| status < 500)
    }

    /// The wrapped error value, when it is of type `T`.
    pub fn downcast_ref<T>(&self) -> Option<&T>
    where
        T: std::error::Error + 'static,
    {
        self.inner
            .source
            .as_deref()
            .and_then(|source| source.downcast_ref::<T>())
    }

    /// True when the wrapped error value is of type `T`.
    pub fn is<T>(&self) -> bool
    where
        T: std::error::Error + 'static,
    {
        self.downcast_ref::<T>().is_some()
    }

    /// The status the default error handler (finalhandler) uses for this error, given the
    /// status already set on the response.
    pub(crate) fn response_status(&self, current: u16) -> (u16, bool) {
        match self.inner.status {
            Some(status) if (400..600).contains(&status) => (status, true),
            _ if (400..600).contains(&current) => (current, false),
            _ => (500, false),
        }
    }

    /// The error a panicking handler turns into.
    pub(crate) fn panicked() -> Self {
        Self::msg("handler panicked")
    }
}

impl<E> From<E> for Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    fn from(source: E) -> Self {
        Self::from_source(source)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner.message)
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Error")
            .field("status", &self.inner.status)
            .field("kind", &self.inner.kind)
            .field("message", &self.inner.message)
            .field("source", &self.inner.source)
            .finish()
    }
}

/// `Result` with [`Error`] as the error type.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A route pattern or router configuration that the framework cannot honour exactly.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unsupported route pattern {pattern:?}: {reason}")]
pub struct RouteError {
    /// The pattern as registered.
    pub pattern: String,
    /// Why it was refused.
    pub reason: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("widget failed")]
    struct WidgetError;

    #[test]
    fn keeps_the_source_for_downcasting() {
        let err: Error = WidgetError.into();
        assert!(err.is::<WidgetError>());
        assert_eq!(err.status(), None);
        assert_eq!(err.message(), "widget failed");
    }

    #[test]
    fn picks_the_status_like_finalhandler() {
        assert_eq!(Error::new(418, "x").response_status(200), (418, true));
        assert_eq!(Error::new(302, "x").response_status(403), (403, false));
        assert_eq!(Error::msg("x").response_status(200), (500, false));
        assert!(Error::new(404, "x").expose());
        assert!(!Error::new(503, "x").expose());
    }
}
