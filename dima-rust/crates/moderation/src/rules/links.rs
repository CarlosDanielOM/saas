//! The links rule (reference `utils/moderation/rules/links.rule.ts`).
//!
//! The reference's expression has the flags `gi` and no `u`:
//! `(?:https?:\/\/|www\.)[^\s]+|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?`. Without `u`, `\w` and
//! the case-insensitive `[a-z]` are ASCII only, and `\s` is JavaScript's whitespace set; a
//! UTF-16 unit and a character behave the same here because every run that can contain an
//! astral character (`[^\s]+`, `\S*`) is greedy over non-space and every other token is ASCII.
//! It is written below for the `regex` crate with explicit ASCII classes; leftmost-first
//! matching gives the same matches as the backtracking engine.
//!
//! What it does not catch, recorded as is: a domain written with spaces or brackets
//! (`example . com`, `example[.]com`), a non-ASCII host without a protocol or `www.`
//! (`пример.рф`, `ex\u{0430}mple.com` stops at the Cyrillic `а`), a one-letter top-level label
//! (`a.b`), an IP address (`127.0.0.1`), and full-width dots (`example．com`).

use std::sync::OnceLock;

use regex::Regex;

use super::unicode::JS_NON_SPACE_CLASS;

/// `evaluateLinksRule`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinksResult {
    /// A host not on the allowlist was found.
    pub triggered: bool,
    /// Every host found, in order.
    pub urls: Vec<String>,
    /// The first host not on the allowlist.
    pub blocked_url: Option<String>,
}

fn url_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            let source = format!(
                r"(?:[hH][tT][tT][pP][sS]?://|[wW][wW][wW]\.){JS_NON_SPACE_CLASS}+|[0-9A-Za-z_-]+(?:\.[0-9A-Za-z_-]+)*\.[A-Za-z]{{2,}}(?:/{JS_NON_SPACE_CLASS}*)?"
            );
            Regex::new(&source).ok()
        })
        .as_ref()
}

/// `extractHostname`.
fn extract_hostname(raw: &str) -> Option<String> {
    let lower = dima_text::to_lower(dima_text::trim(raw));
    let mut value = lower.as_str();
    value = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    value = value.strip_prefix("www.").unwrap_or(value);
    let host = value.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.split(':').next().unwrap_or_default();
    (!host.is_empty() && host.contains('.')).then(|| host.to_owned())
}

/// `isAllowlisted`: the host is a listed domain or ends with `.` and one.
fn is_allowlisted(hostname: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|domain| {
        hostname == domain
            || hostname
                .strip_suffix(domain.as_str())
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// `evaluateLinksRule`. `allowlist` holds the rule's domains lowercased (the reference lowercases
/// them on every call; [`lowercase_allowlist`] does it once).
pub fn evaluate_links(allowlist: &[String], text: &str) -> LinksResult {
    let mut urls = Vec::new();
    let mut blocked_url = None;
    if let Some(pattern) = url_pattern() {
        for found in pattern.find_iter(text) {
            let Some(hostname) = extract_hostname(found.as_str()) else {
                continue;
            };
            if blocked_url.is_none() && !is_allowlisted(&hostname, allowlist) {
                blocked_url = Some(hostname.clone());
            }
            urls.push(hostname);
        }
    }
    LinksResult {
        triggered: blocked_url.is_some(),
        urls,
        blocked_url,
    }
}

/// The allowlist as the reference compares it (`domain.toLowerCase()`).
pub fn lowercase_allowlist<'a>(domains: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    domains.into_iter().map(dima_text::to_lower).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(allow: &[&str], text: &str) -> Option<String> {
        evaluate_links(&lowercase_allowlist(allow.iter().copied()), text).blocked_url
    }

    // Reference: rules/links.rule.test.ts.
    #[test]
    fn reference_cases() {
        assert_eq!(
            blocked(&[], "check out cool-site.com now").as_deref(),
            Some("cool-site.com")
        );
        assert_eq!(
            blocked(&[], "go to https://example.com/path?q=1 please").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            blocked(&[], "visit www.example.org today").as_deref(),
            Some("example.org")
        );
        for text in [
            "hello everyone how is it going",
            "v1.2 was great",
            "e.g. this",
            "",
        ] {
            assert_eq!(blocked(&[], text), None, "{text}");
        }
        assert_eq!(
            blocked(
                &["twitch.tv"],
                "nice clip https://www.twitch.tv/dima/clip/abc"
            ),
            None
        );
        assert_eq!(
            blocked(&["twitch.tv"], "clips.twitch.tv/awesome-clip"),
            None
        );
        assert_eq!(
            blocked(&["twitch.tv"], "twitch.tv/dima but also scam.xyz/free").as_deref(),
            Some("scam.xyz")
        );
        assert!(blocked(&["twitch.tv"], "nottwitch.tv.evil.com").is_some());
    }

    #[test]
    fn disguises() {
        assert_eq!(
            blocked(&[], "HTTPS://EXAMPLE.COM:8080/x").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            blocked(&[], "https://пример.рф/путь").as_deref(),
            Some("пример.рф")
        );
        assert_eq!(blocked(&[], "пример.рф"), None);
        assert_eq!(blocked(&[], "example . com"), None);
        assert_eq!(blocked(&[], "127.0.0.1"), None);
        assert_eq!(
            blocked(&[], "😀example.com😀").as_deref(),
            Some("example.com")
        );
        assert_eq!(blocked(&["Example.COM"], "example.com"), None);
        assert_eq!(blocked(&[], "a.b"), None);
    }
}
