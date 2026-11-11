//! ETags (`etag` 1.8) and freshness (`fresh` 0.5) as Express computes them.

use base64::Engine as _;
use sha1::{Digest as _, Sha1};

use crate::mediatype::is_js_whitespace;

/// Express's default weak ETag for a response body: `W/"<hex length>-<27 chars of base64 sha1>"`.
pub fn weak_etag(body: &[u8]) -> String {
    let digest = Sha1::digest(body);
    let encoded = base64::engine::general_purpose::STANDARD.encode(digest);
    let hash: String = encoded.chars().take(27).collect();
    format!("W/\"{:x}-{hash}\"", body.len())
}

/// `fresh(reqHeaders, resHeaders)`.
///
/// `if_none_match`, `if_modified_since` and `cache_control` are the request headers as Node
/// presents them (duplicates joined with `", "`); `etag` and `last_modified` are the response
/// headers.
pub(crate) fn fresh(
    if_none_match: Option<&str>,
    if_modified_since: Option<&str>,
    cache_control: Option<&str>,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> bool {
    let none_match = if_none_match.filter(|v| !v.is_empty());
    let modified_since = if_modified_since.filter(|v| !v.is_empty());
    if none_match.is_none() && modified_since.is_none() {
        return false;
    }
    if cache_control.is_some_and(has_no_cache) {
        return false;
    }
    if let Some(none_match) = none_match.filter(|v| *v != "*") {
        let Some(etag) = etag.filter(|v| !v.is_empty()) else {
            return false;
        };
        let matched = parse_token_list(none_match).into_iter().any(|candidate| {
            candidate == etag
                || candidate == format!("W/{etag}")
                || format!("W/{candidate}") == etag
        });
        if !matched {
            return false;
        }
    }
    if let Some(modified_since) = modified_since {
        let since = parse_http_date(modified_since);
        let modified = last_modified.filter(|v| !v.is_empty()).map(parse_http_date);
        match (modified, since) {
            (Some(Some(modified)), Some(since)) if modified <= since => {}
            _ => return false,
        }
    }
    true
}

/// `/(?:^|,)\s*?no-cache\s*?(?:,|$)/`.
fn has_no_cache(value: &str) -> bool {
    value
        .split(',')
        .any(|part| part.trim_matches(is_js_whitespace) == "no-cache")
}

/// `fresh`'s `parseTokenList`: splits on commas, trimming spaces (only U+0020).
fn parse_token_list(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut list = Vec::new();
    let (mut start, mut end) = (0usize, 0usize);
    for (i, &byte) in bytes.iter().enumerate() {
        match byte {
            b' ' => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            b',' => {
                list.push(value.get(start..end).unwrap_or(""));
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    list.push(value.get(start..end).unwrap_or(""));
    list
}

/// `Date.parse(value)` as `fresh` and `send` use it (`NaN` as `None`): the IMF-fixdate browsers
/// echo back, the obsolete RFC 850 and asctime forms, and ISO dates, with range-checked
/// arithmetic on any year a client sends.
pub(crate) fn parse_http_date(value: &str) -> Option<i64> {
    dima_text::parse_date(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_matches_express() {
        assert_eq!(weak_etag(b""), "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"");
        // node -e "console.log(require('etag')(Buffer.from('{\"ok\":true}'),{weak:true}))"
        assert_eq!(
            weak_etag(b"{\"ok\":true}"),
            "W/\"b-Ai2R8hgEarLmHKwesT1qcY913ys\""
        );
    }

    #[test]
    fn freshness_rules() {
        let tag = "W/\"b-Ai2R8hgEarLmHKwesT1qcY913ys\"";
        assert!(fresh(Some(tag), None, None, Some(tag), None));
        assert!(fresh(
            Some("\"b-Ai2R8hgEarLmHKwesT1qcY913ys\""),
            None,
            None,
            Some(tag),
            None
        ));
        assert!(fresh(
            Some("\"x\", W/\"b-Ai2R8hgEarLmHKwesT1qcY913ys\""),
            None,
            None,
            Some(tag),
            None
        ));
        assert!(fresh(Some("*"), None, None, None, None));
        assert!(!fresh(Some(tag), None, Some("no-cache"), Some(tag), None));
        assert!(!fresh(
            Some(tag),
            None,
            Some("max-age=0, no-cache"),
            Some(tag),
            None
        ));
        assert!(fresh(Some(tag), None, Some("no-cache-x"), Some(tag), None));
        assert!(!fresh(Some("\"other\""), None, None, Some(tag), None));
        assert!(!fresh(None, None, None, Some(tag), None));
        let date = "Sun, 06 Nov 1994 08:49:37 GMT";
        assert_eq!(parse_http_date(date), Some(784_111_777_000));
        assert!(fresh(None, Some(date), None, None, Some(date)));
        assert!(!fresh(None, Some(date), None, None, None));
    }

    /// Review finding: the hand-written parser did unchecked arithmetic on the client's year and
    /// knew only the IMF-fixdate form.
    #[test]
    fn dates_parse_like_date_parse() {
        let modified = "Sun, 06 Nov 1994 08:49:37 GMT";
        for huge in [
            "Sun, 06 Nov 99999999999999999 08:49:37 GMT",
            "Sun, 06 Nov 9223372036854775807 08:49:37 GMT",
            "Sun, 06 Nov -99999999999999999 08:49:37 GMT",
        ] {
            assert_eq!(parse_http_date(huge), None, "{huge}");
            assert!(!fresh(None, Some(huge), None, None, Some(modified)));
        }
        // The obsolete forms Express accepts through Date.parse.
        for obsolete in [
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun Nov  6 08:49:37 1994",
            "1994-11-06T08:49:37Z",
        ] {
            assert_eq!(
                parse_http_date(obsolete),
                Some(784_111_777_000),
                "{obsolete}"
            );
            assert!(fresh(None, Some(obsolete), None, None, Some(modified)));
        }
        assert!(!fresh(
            None,
            Some("Sun, 06 Nov 1994 08:49:36 GMT"),
            None,
            None,
            Some(modified)
        ));
        assert!(!fresh(None, Some("garbage"), None, None, Some(modified)));
    }
}
