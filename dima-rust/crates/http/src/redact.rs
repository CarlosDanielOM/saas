//! What may be printed about a request or response.

use http::{HeaderMap, HeaderName};
use std::fmt;

/// Header names whose values are never printed, in requests or responses.
const SENSITIVE: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-dimafx-service-token",
    "x-observability-signature",
    "x-amz-security-token",
];

/// Response headers a [`crate::StatusError`] keeps (everything else is dropped).
const KEPT: &[&str] = &[
    "content-type",
    "content-length",
    "retry-after",
    "retry-after-ms",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-should-retry",
    "x-request-id",
    "request-id",
    "x-amz-request-id",
    "cf-ray",
];

/// Whether a header's value must never be printed.
pub fn is_sensitive(name: &HeaderName) -> bool {
    SENSITIVE.contains(&name.as_str())
}

/// The allow-listed subset of response headers for an error.
pub(crate) fn kept_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        if KEPT.contains(&name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

/// The query of `url` with the values of `secrets` (case-insensitive names) replaced.
pub(crate) fn query(url: &url::Url, secrets: &[&'static str]) -> Option<Box<str>> {
    let raw = url.query()?;
    if raw.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(raw.len());
    for (index, pair) in raw.split('&').enumerate() {
        if index > 0 {
            out.push('&');
        }
        let (name, has_value) = match pair.split_once('=') {
            Some((name, _)) => (name, true),
            None => (pair, false),
        };
        let decoded = percent_encoding::percent_decode_str(name).decode_utf8_lossy();
        let secret = secrets.iter().any(|s| s.eq_ignore_ascii_case(&decoded))
            || SENSITIVE_QUERY
                .iter()
                .any(|s| s.eq_ignore_ascii_case(&decoded));
        if secret {
            out.push_str(name);
            out.push_str("=<redacted>");
        } else if has_value {
            out.push_str(pair);
        } else {
            out.push_str(name);
        }
    }
    Some(out.into_boxed_str())
}

/// Query parameter names that are redacted for every provider.
const SENSITIVE_QUERY: &[&str] = &[
    "access_token",
    "refresh_token",
    "client_secret",
    "api_key",
    "apikey",
    "key",
    "token",
    "secret",
    "password",
    "signature",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
];

/// Prints a header map with sensitive values replaced.
pub(crate) struct HeadersDebug<'a>(pub &'a HeaderMap);

impl fmt::Debug for HeadersDebug<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut map = f.debug_map();
        for (name, value) in self.0 {
            if is_sensitive(name) || value.is_sensitive() {
                map.entry(&name.as_str(), &"<redacted>");
            } else {
                map.entry(&name.as_str(), &String::from_utf8_lossy(value.as_bytes()));
            }
        }
        map.finish()
    }
}

/// Prints an error and its sources on one line.
pub(crate) struct ErrorChain<'a>(pub &'a (dyn std::error::Error + 'static));

impl fmt::Debug for ErrorChain<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "\"{}", self.0)?;
        let mut source = self.0.source();
        while let Some(cause) = source {
            write!(f, ": {cause}")?;
            source = cause.source();
        }
        f.write_str("\"")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_redacts_provider_and_common_secrets() {
        let url =
            url::Url::parse("https://x.test/p?id=1&key=abc&Sig=s3&flag&client_secret=zz").unwrap();
        let out = query(&url, &["sig"]).unwrap();
        assert_eq!(
            &*out,
            "id=1&key=<redacted>&Sig=<redacted>&flag&client_secret=<redacted>"
        );
        let encoded = url::Url::parse("https://x.test/p?%6Bey=abc").unwrap();
        assert_eq!(&*query(&encoded, &[]).unwrap(), "%6Bey=<redacted>");
    }

    #[test]
    fn headers_debug_hides_sensitive_values() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer SECRET".parse().unwrap());
        headers.insert("x-api-key", "SECRET2".parse().unwrap());
        let mut flagged: http::HeaderValue = "SECRET3".parse().unwrap();
        flagged.set_sensitive(true);
        headers.insert("x-custom", flagged);
        headers.insert("accept", "application/json".parse().unwrap());
        let text = format!("{:?}", HeadersDebug(&headers));
        assert!(!text.contains("SECRET"), "{text}");
        assert!(text.contains("application/json"));
    }
}
