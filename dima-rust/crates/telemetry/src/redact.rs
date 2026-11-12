//! Secrets never reach a log destination.
//!
//! Two passes over the logged JSON, before it is queued anywhere:
//!
//! - **Secret field names.** A field whose name, lowercased with `_` and `-` removed, is one of
//!   [`SECRET_NAMES`] or ends with one of [`SECRET_SUFFIXES`] has its value replaced by
//!   [`REDACTED`] unless the value is a number, a boolean or null (`promptTokens: 120` stays).
//! - **Tokens inside text.** In every string: `Bearer`/`OAuth`/`Basic` credentials, JSON web
//!   tokens, `sk-...` API keys, credentials in URLs (`scheme://user:pass@`), and the values of
//!   secret query parameters (`?access_token=...`) are replaced by [`REDACTED`].
//!
//! The pass also bounds the record: strings are cut at [`MAX_STRING_CHARS`] characters (on a
//! character boundary), arrays at [`MAX_ARRAY_ITEMS`] items, objects at [`MAX_OBJECT_FIELDS`]
//! fields and nesting at [`MAX_DEPTH`]; it returns an estimate of the record's size in bytes.
//! A log call's data never reaches this pass unbounded: the logger serialises it under the same
//! limits (plus a total of [`MAX_RECORD_VALUES`] values and about [`MAX_RECORD_BYTES`] bytes)
//! while the value is walked, so these cuts only matter for a [`Value`] built elsewhere.

pub use crate::bounded::{MAX_RECORD_BYTES, MAX_RECORD_VALUES};
use regex::Regex;
use serde_json::Value;
use std::borrow::Cow;

/// What replaces a secret.
pub const REDACTED: &str = "[REDACTED]";
/// Longest string kept, in characters.
pub const MAX_STRING_CHARS: usize = 4096;
/// Most array items kept.
pub const MAX_ARRAY_ITEMS: usize = 100;
/// Most object fields kept.
pub const MAX_OBJECT_FIELDS: usize = 100;
/// Deepest nesting kept.
pub const MAX_DEPTH: usize = 12;

/// Field names that always hold secrets (normalised: lowercase, no `_` or `-`).
pub const SECRET_NAMES: [&str; 14] = [
    "password",
    "passwd",
    "secret",
    "authorization",
    "auth",
    "cookie",
    "setcookie",
    "apikey",
    "privatekey",
    "clientsecret",
    "secretkey",
    "credentials",
    "credential",
    "signature",
];
/// Field-name endings that hold secrets (`accessToken`, `refresh_token`, `webhookSecret`, ...).
pub const SECRET_SUFFIXES: [&str; 8] = [
    "token",
    "secret",
    "password",
    "apikey",
    "privatekey",
    "credential",
    "credentials",
    "cookie",
];

/// The compiled patterns. Build once per logger.
#[derive(Debug)]
pub struct Redactor {
    // `None` only if the fixed patterns failed to compile (a bug a unit test rules out); field
    // names are still redacted then.
    patterns: Option<Regex>,
    query: Option<Regex>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    /// Compiles the patterns.
    pub fn new() -> Self {
        Self {
            patterns: Regex::new(concat!(
                r"(?i)\b(?:bearer|oauth|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*",
                r"|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*",
                r"|\bsk-[A-Za-z0-9_-]{16,}",
                r"|\b(?:gh[pousr]|xox[abpr])_[A-Za-z0-9]{16,}",
            ))
            .ok(),
            // Credentials in a URL authority, and secret query parameters.
            query: Regex::new(concat!(
                r"(?i)(?P<auth>[a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@",
                r"|(?P<param>[?&](?:access_token|refresh_token|id_token|token|client_secret|secret|password|api_key|apikey|key|code|signature|sig)=)[^&#\s]+",
            ))
            .ok(),
        }
    }

    /// Whether both patterns compiled.
    pub fn complete(&self) -> bool {
        self.patterns.is_some() && self.query.is_some()
    }

    /// Redacts `value` in place and returns its approximate size in bytes.
    pub fn redact(&self, value: &mut Value) -> usize {
        self.walk(value, 0)
    }

    /// Redacts one string.
    pub fn redact_text<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let (Some(patterns), Some(query)) = (&self.patterns, &self.query) else {
            return Cow::Borrowed(text);
        };
        let first = patterns.replace_all(text, REDACTED);
        let replace = |captures: &regex::Captures<'_>| {
            let auth = captures.name("auth");
            let prefix = auth
                .or_else(|| captures.name("param"))
                .map(|group| group.as_str())
                .unwrap_or_default();
            format!(
                "{prefix}{REDACTED}{}",
                if auth.is_some() { "@" } else { "" }
            )
        };
        let second = match query.replace_all(&first, replace) {
            Cow::Borrowed(_) => None,
            Cow::Owned(text) => Some(text),
        };
        match (second, first) {
            (Some(text), _) => Cow::Owned(text),
            (None, Cow::Owned(text)) => Cow::Owned(text),
            (None, Cow::Borrowed(_)) => Cow::Borrowed(text),
        }
    }

    fn walk(&self, value: &mut Value, depth: usize) -> usize {
        match value {
            Value::Null | Value::Bool(_) => 5,
            Value::Number(_) => 12,
            Value::String(text) => {
                if let Some((cut, _)) = text.char_indices().nth(MAX_STRING_CHARS) {
                    text.truncate(cut);
                    text.push('…');
                }
                if let Cow::Owned(clean) = self.redact_text(text) {
                    *text = clean;
                }
                text.len() + 2
            }
            Value::Array(items) => {
                if depth >= MAX_DEPTH {
                    *value = Value::String("[depth]".to_owned());
                    return 9;
                }
                items.truncate(MAX_ARRAY_ITEMS);
                items
                    .iter_mut()
                    .map(|item| self.walk(item, depth + 1) + 1)
                    .sum::<usize>()
                    + 2
            }
            Value::Object(fields) => {
                if depth >= MAX_DEPTH {
                    *value = Value::String("[depth]".to_owned());
                    return 9;
                }
                if fields.len() > MAX_OBJECT_FIELDS {
                    let keep: Vec<String> =
                        fields.keys().take(MAX_OBJECT_FIELDS).cloned().collect();
                    fields.retain(|key, _| keep.contains(key));
                }
                let mut size = 2;
                for (key, item) in fields.iter_mut() {
                    size += key.len() + 4;
                    if is_secret_name(key)
                        && !matches!(item, Value::Number(_) | Value::Bool(_) | Value::Null)
                    {
                        *item = Value::String(REDACTED.to_owned());
                        size += REDACTED.len() + 2;
                    } else {
                        size += self.walk(item, depth + 1);
                    }
                }
                size
            }
        }
    }
}

/// Whether a field name holds a secret (see the module documentation).
pub fn is_secret_name(name: &str) -> bool {
    let mut normal = [0_u8; 48];
    let mut len = 0;
    for byte in name.bytes() {
        if byte == b'_' || byte == b'-' {
            continue;
        }
        if len == normal.len() {
            // Longer than any secret name: only the suffix can match.
            normal.copy_within(1.., 0);
            len -= 1;
        }
        normal[len] = byte.to_ascii_lowercase();
        len += 1;
    }
    let normal = normal.get(..len).unwrap_or_default();
    SECRET_NAMES
        .iter()
        .any(|secret| normal == secret.as_bytes())
        || SECRET_SUFFIXES
            .iter()
            .any(|suffix| normal.ends_with(suffix.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn redactor() -> Redactor {
        let redactor = Redactor::new();
        assert!(redactor.complete());
        redactor
    }

    #[test]
    fn secret_field_names_are_redacted_but_counts_stay() {
        let mut value = json!({
            "access_token": "abc", "refreshToken": "def", "Authorization": "Bearer x",
            "client-secret": "s", "password": {"nested": 1}, "promptTokens": 120,
            "tokenCount": 3, "user": "alice", "cookie": ["a"], "api_key": null,
            "nested": {"webhookSecret": "w", "list": [{"PASSWORD": "p"}]},
            "keyword": "kept", "secretary": "kept"
        });
        redactor().redact(&mut value);
        assert_eq!(value["access_token"], REDACTED);
        assert_eq!(value["refreshToken"], REDACTED);
        assert_eq!(value["Authorization"], REDACTED);
        assert_eq!(value["client-secret"], REDACTED);
        assert_eq!(value["password"], REDACTED);
        assert_eq!(value["cookie"], REDACTED);
        assert_eq!(value["promptTokens"], 120);
        assert_eq!(value["tokenCount"], 3);
        assert_eq!(value["api_key"], Value::Null);
        assert_eq!(value["user"], "alice");
        assert_eq!(value["nested"]["webhookSecret"], REDACTED);
        assert_eq!(value["nested"]["list"][0]["PASSWORD"], REDACTED);
        assert_eq!(value["keyword"], "kept");
        assert_eq!(value["secretary"], "kept");
    }

    #[test]
    fn tokens_inside_text_are_redacted() {
        let r = redactor();
        let cases = [
            (
                "Authorization: Bearer abcdefghijkl1234",
                "Authorization: [REDACTED]",
            ),
            ("header OAuth 0123456789abcdefghij", "header [REDACTED]"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end",
                "jwt [REDACTED] end",
            ),
            ("key sk-or-v1-0123456789abcdef0123", "key [REDACTED]"),
            (
                "GET https://id.twitch.tv/oauth2/token?client_id=x&client_secret=hunter2&grant=1",
                "GET https://id.twitch.tv/oauth2/token?client_id=x&client_secret=[REDACTED]&grant=1",
            ),
            (
                "redis://user:hunter2@dragonfly:6379",
                "redis://[REDACTED]@dragonfly:6379",
            ),
            (
                "mongodb://root:p%40ss@mongo/db",
                "mongodb://[REDACTED]@mongo/db",
            ),
            (
                "https://x.test/cb?code=abc123#frag",
                "https://x.test/cb?code=[REDACTED]#frag",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(r.redact_text(input), expected, "{input}");
        }
        // Ordinary text, emoji, combining marks and right-to-left text are untouched.
        for text in [
            "hello 😀 world",
            "e\u{301}cole",
            "שלום עולם",
            "token budget exceeded",
        ] {
            assert!(matches!(r.redact_text(text), Cow::Borrowed(_)), "{text}");
        }
    }

    #[test]
    fn records_are_bounded() {
        let r = redactor();
        let mut value = json!({"text": "😀".repeat(MAX_STRING_CHARS + 10), "list": (0..500).collect::<Vec<_>>()});
        let size = r.redact(&mut value);
        assert_eq!(
            value["text"].as_str().map(|t| t.chars().count()),
            Some(MAX_STRING_CHARS + 1)
        );
        assert_eq!(
            value["list"].as_array().map(Vec::len),
            Some(MAX_ARRAY_ITEMS)
        );
        assert!(size > MAX_STRING_CHARS * 4);
        let mut deep = json!(1);
        for _ in 0..50 {
            deep = json!([deep]);
        }
        r.redact(&mut deep);
        assert!(
            serde_json::to_string(&deep)
                .unwrap_or_default()
                .contains("[depth]")
        );
    }

    #[test]
    fn long_names_still_match_by_suffix() {
        assert!(is_secret_name(&format!("{}_access_token", "x".repeat(100))));
        assert!(!is_secret_name(&"x".repeat(100)));
    }
}
