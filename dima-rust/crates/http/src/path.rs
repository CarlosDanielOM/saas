//! Request paths: a static template for telemetry and errors, and the rendered path for the wire.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use std::borrow::Cow;

/// Characters escaped in a path segment argument: everything except the RFC 3986 unreserved set.
/// `/`, `?`, `#` and `%` are escaped, so an argument can never add a segment, a query or an
/// escape of its own.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// A request path relative to the provider's base URL.
///
/// The template is what telemetry and errors show; it is `'static`, so naming it costs nothing.
/// Each `{}` in the template is replaced by one percent-encoded argument.
///
/// ```
/// use dima_http::Path;
/// let path = Path::template("/v1/customers/{}/state", &["a b/c"]).unwrap();
/// assert_eq!(path.as_str(), "/v1/customers/a%20b%2Fc/state");
/// assert_eq!(path.template_str(), "/v1/customers/{}/state");
/// assert_eq!(Path::fixed("/helix/users").as_str(), "/helix/users");
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct Path {
    template: &'static str,
    rendered: Cow<'static, str>,
}

/// Only the template: a rendered argument may be an id or a secret (Polar's checkout client
/// secret travels in a path).
impl std::fmt::Debug for Path {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Path({:?})", self.template)
    }
}

/// Why a path could not be built.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PathError {
    /// The template does not start with `/`.
    #[error("path template must start with '/'")]
    Relative,
    /// The number of arguments differs from the number of `{}` placeholders.
    #[error("path template placeholder count differs from the argument count")]
    Arity,
    /// An argument is empty, `.` or `..` (it would collapse or climb a segment).
    #[error("path argument is empty, '.' or '..'")]
    Segment,
}

impl Path {
    /// A path with no arguments.
    pub const fn fixed(template: &'static str) -> Self {
        Self {
            template,
            rendered: Cow::Borrowed(template),
        }
    }

    /// Renders path arguments with strict RFC 3986 escaping, including `!*'()`.
    /// Use this default for request signing or a provider requiring canonical escaping.
    pub fn template(template: &'static str, args: &[&str]) -> Result<Self, PathError> {
        Self::render(template, args, false)
    }

    /// Renders arguments exactly as JavaScript's `encodeURIComponent` (leaves `!*'()` alone).
    /// Use when reproducing a URL built by TypeScript. Segment validation remains the same.
    pub fn template_encode_uri_component(
        template: &'static str,
        args: &[&str],
    ) -> Result<Self, PathError> {
        Self::render(template, args, true)
    }

    fn render(template: &'static str, args: &[&str], javascript: bool) -> Result<Self, PathError> {
        if !template.starts_with('/') {
            return Err(PathError::Relative);
        }
        let pieces = template.split("{}");
        if pieces.clone().count() != args.len() + 1 {
            return Err(PathError::Arity);
        }
        if args.is_empty() {
            return Ok(Self::fixed(template));
        }
        let mut out =
            String::with_capacity(template.len() + args.iter().map(|a| a.len()).sum::<usize>());
        for (index, piece) in pieces.enumerate() {
            out.push_str(piece);
            if let Some(arg) = args.get(index) {
                if arg.is_empty() || *arg == "." || *arg == ".." {
                    return Err(PathError::Segment);
                }
                if javascript {
                    out.push_str(&dima_text::encode_uri_component(arg));
                } else {
                    out.extend(utf8_percent_encode(arg, SEGMENT));
                }
            }
        }
        Ok(Self {
            template,
            rendered: Cow::Owned(out),
        })
    }

    /// The rendered path.
    pub fn as_str(&self) -> &str {
        &self.rendered
    }

    /// The template.
    pub fn template_str(&self) -> &'static str {
        self.template
    }
}

impl From<&'static str> for Path {
    fn from(template: &'static str) -> Self {
        Self::fixed(template)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_arguments_match_shared_encoder() {
        for arg in ["!*'()~", "café 😀 مرحبا e\u{301}", "a/b?c#d%20+", "\0"] {
            let path = Path::template_encode_uri_component("/{}", &[arg]).unwrap();
            assert_eq!(
                path.as_str(),
                format!("/{}", dima_text::encode_uri_component(arg))
            );
            assert_eq!(path.template_str(), "/{}");
        }
        for arg in ["", ".", ".."] {
            assert_eq!(
                Path::template_encode_uri_component("/{}", &[arg]),
                Err(PathError::Segment)
            );
        }
        assert_eq!(
            Path::template_encode_uri_component("/{}", &[]),
            Err(PathError::Arity)
        );
        assert_eq!(
            Path::template_encode_uri_component("relative", &[]),
            Err(PathError::Relative)
        );
    }

    #[test]
    fn signing_escapes_javascript_punctuation() {
        assert_eq!(
            Path::template("/{}", &["!*'()"]).unwrap().as_str(),
            "/%21%2A%27%28%29"
        );
    }

    #[test]
    fn arguments_cannot_escape_their_segment() {
        let path = Path::template("/a/{}/b/{}", &["../x?y#z", "é%2F"]).unwrap();
        assert_eq!(path.as_str(), "/a/..%2Fx%3Fy%23z/b/%C3%A9%252F");
        assert_eq!(
            Path::template("/a/{}", &[".."]).unwrap_err(),
            PathError::Segment
        );
        assert_eq!(
            Path::template("/a/{}", &[""]).unwrap_err(),
            PathError::Segment
        );
        assert_eq!(Path::template("/a/{}", &[]).unwrap_err(), PathError::Arity);
        assert_eq!(Path::template("a", &[]).unwrap_err(), PathError::Relative);
    }
}
