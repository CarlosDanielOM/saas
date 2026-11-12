//! Express 4 path matching: `path-to-regexp` 0.1.13 with Express's options.
//!
//! A pattern compiles to the same regular expression Express builds (case-insensitive,
//! optional trailing slash, `[^/]+?` parameters), run with the `regex` crate on bytes with
//! ASCII-only case folding (request paths are ASCII: hyper rejects other bytes). The one
//! construct the `regex` crate lacks, the `(?=/|$)` look-ahead of prefix layers, is emulated
//! with a final capture group whose length is subtracted from the match.
//!
//! Supported syntax (everything the reference uses, plus the common forms): literal text,
//! `/:name`, `/:name?`, `.:name`, `*`, and the bare `*` and `/` fast paths. Custom groups,
//! `:name*`, a parameter glued to preceding literal text, and regular-expression characters in
//! literal text are refused at registration, so nothing is silently matched differently.

use regex::bytes::{Regex, RegexBuilder};

use crate::error::{Error, RouteError};
use crate::uri::decode_uri_component;

/// A parameter name: a named `:param`, or the position of an unnamed `*` group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamKey {
    /// `:name`.
    Named(String),
    /// The n-th unnamed group (`*`), exposed as `"0"`, `"1"`, …
    Index(u32),
}

impl ParamKey {
    /// The key as JavaScript sees it (`req.params[key]`).
    pub fn as_key(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::Named(name) => std::borrow::Cow::Borrowed(name),
            Self::Index(i) => std::borrow::Cow::Owned(i.to_string()),
        }
    }
}

/// Route parameters in the order Express stores them; `None` is a key whose optional
/// group did not match (`undefined` in JavaScript, dropped by `JSON.stringify`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Params {
    entries: Vec<(String, Option<String>)>,
}

impl Params {
    /// The decoded value of `name`, if the key exists and matched.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.as_deref())
    }

    /// True when `name` is a key of `req.params` (even with an `undefined` value).
    pub fn contains_key(&self, name: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == name)
    }

    /// Keys and values in JavaScript enumeration order (array-index keys first).
    pub fn iter(&self) -> impl Iterator<Item = (&str, Option<&str>)> {
        let values: std::collections::HashMap<_, _> = self
            .entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_deref()))
            .collect();
        let keys = dima_text::js_property_order(
            self.entries.iter().map(|(key, _)| key.as_str()).collect(),
        );
        keys.into_iter()
            .map(move |key| (key, values.get(key).copied().flatten()))
    }

    /// `req.params` as JSON (`undefined` values omitted, like `JSON.stringify`).
    pub fn to_json(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self
            .iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_owned(), serde_json::Value::String(v.to_owned()))))
            .collect();
        serde_json::Value::Object(map)
    }

    /// Number of keys.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when there are no keys.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `params[key] = value` (an existing key keeps its position).
    pub(crate) fn set(&mut self, key: String, value: Option<String>) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }

    /// Express `mergeParams(params, parent)`: parent keys first, the layer's keys win; numeric
    /// keys of the layer are shifted past the parent's when both start at `0`.
    pub(crate) fn merged_over(mut self, parent: &Params) -> Params {
        if !self.contains_key("0") || !parent.contains_key("0") {
            let mut out = parent.clone();
            for (k, v) in self.entries {
                out.set(k, v);
            }
            return out;
        }
        let mut i = 0usize;
        while self.contains_key(&i.to_string()) {
            i += 1;
        }
        let mut o = 0usize;
        while parent.contains_key(&o.to_string()) {
            o += 1;
        }
        for index in (0..i).rev() {
            let value = self
                .entries
                .iter()
                .find(|(k, _)| *k == index.to_string())
                .and_then(|(_, v)| v.clone());
            self.set((index + o).to_string(), value);
            if index < o {
                self.remove(&index.to_string());
            }
        }
        let mut out = parent.clone();
        for (k, v) in self.entries {
            out.set(k, v);
        }
        out
    }
}

/// A successful match: the matched part of the path (for prefix layers) and the parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMatch {
    /// `layer.path`: the matched text, without the emulated look-ahead.
    pub path: String,
    /// `layer.params`.
    pub params: Params,
}

#[derive(Debug)]
enum Matcher {
    /// `use('/')`: matches everything, consumes nothing.
    FastSlash,
    /// `'*'`: the whole path is parameter `0`.
    FastStar,
    Regex {
        regex: Regex,
        keys: Vec<ParamKey>,
        end: bool,
    },
}

/// A compiled layer path.
#[derive(Debug)]
pub struct PathPattern {
    source: String,
    matcher: Matcher,
}

impl PathPattern {
    /// Compiles `pattern` as a route (`end: true`) or as a prefix layer (`end: false`).
    pub fn compile(pattern: &str, end: bool) -> Result<Self, RouteError> {
        let refuse = |reason| RouteError {
            pattern: pattern.to_owned(),
            reason,
        };
        if pattern == "/" && !end {
            return Ok(Self {
                source: pattern.to_owned(),
                matcher: Matcher::FastSlash,
            });
        }
        if pattern == "*" {
            return Ok(Self {
                source: pattern.to_owned(),
                matcher: Matcher::FastStar,
            });
        }
        let chars: Vec<char> = pattern.chars().collect();
        let mut out = String::from("^");
        let mut keys = Vec::new();
        let mut unnamed = 0u32;
        let mut i = 0;
        // Whether the previous construct ended exactly here (path-to-regexp's empty `backtrack`).
        let mut at_boundary = true;
        while let Some(&c) = chars.get(i) {
            if let Some((consumed, piece, name)) = param_at(&chars, i) {
                let glued = !matches!(chars.get(i), Some('/' | '.'));
                if glued && !at_boundary {
                    return Err(refuse("a parameter must follow '/' or '.'"));
                }
                out.push_str(&piece);
                keys.push(ParamKey::Named(name));
                i += consumed;
                at_boundary = true;
                continue;
            }
            match c {
                '\\' => return Err(refuse("escapes are not supported")),
                '(' | ')' | '[' | ']' | '{' | '}' | '+' | '?' | '^' | '$' | '|' => {
                    return Err(refuse("regular-expression syntax is not supported"));
                }
                ':' => return Err(refuse("a ':' must start a parameter name")),
                '*' => {
                    out.push_str("(.*)");
                    keys.push(ParamKey::Index(unnamed));
                    unnamed += 1;
                    at_boundary = true;
                }
                '.' => {
                    out.push_str("\\.");
                    at_boundary = false;
                }
                _ => {
                    let mut buf = [0u8; 4];
                    out.push_str(&regex::escape(c.encode_utf8(&mut buf)));
                    at_boundary = false;
                }
            }
            i += 1;
        }
        // Non-strict: optional trailing slash.
        out.push_str(if out.ends_with('/') { "?" } else { "/?" });
        out.push_str(if end { "$" } else { "(/|$)" });
        let regex = RegexBuilder::new(&out)
            .case_insensitive(true)
            .unicode(false)
            .build()
            .map_err(|_| refuse("pattern does not compile"))?;
        Ok(Self {
            source: pattern.to_owned(),
            matcher: Matcher::Regex { regex, keys, end },
        })
    }

    /// The pattern as registered.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// `layer.match(path)`: `Ok(None)` when it does not match, `Err` (400) when a parameter
    /// does not decode.
    pub fn matches(&self, path: &str) -> Result<Option<PathMatch>, Error> {
        match &self.matcher {
            Matcher::FastSlash => Ok(Some(PathMatch {
                path: String::new(),
                params: Params::default(),
            })),
            Matcher::FastStar => {
                let mut params = Params::default();
                params.set("0".to_owned(), Some(decode_param(path)?));
                Ok(Some(PathMatch {
                    path: path.to_owned(),
                    params,
                }))
            }
            Matcher::Regex { regex, keys, end } => {
                let Some(captures) = regex.captures(path.as_bytes()) else {
                    return Ok(None);
                };
                let Some(whole) = captures.get(0) else {
                    return Ok(None);
                };
                let mut matched_len = whole.len();
                if !*end && let Some(lookahead) = captures.get(keys.len() + 1) {
                    matched_len -= lookahead.len();
                }
                let mut params = Params::default();
                for (i, key) in keys.iter().enumerate() {
                    let name = key.as_key().into_owned();
                    let value = match captures.get(i + 1) {
                        Some(m) => {
                            let raw = std::str::from_utf8(m.as_bytes())
                                .map_err(|_| Error::new(400, "Bad Request"))?;
                            Some(decode_param(raw)?)
                        }
                        None => None,
                    };
                    if value.is_some() || !params.contains_key(&name) {
                        params.set(name, value);
                    }
                }
                let matched = path.get(..matched_len).unwrap_or(path).to_owned();
                Ok(Some(PathMatch {
                    path: matched,
                    params,
                }))
            }
        }
    }
}

/// `decode_param`: `decodeURIComponent`, with a 400 error when the value is malformed.
fn decode_param(value: &str) -> Result<String, Error> {
    if value.is_empty() {
        return Ok(String::new());
    }
    decode_uri_component(value)
        .ok_or_else(|| Error::new(400, format!("Failed to decode param '{value}'")))
}

/// A `(/)?(.)?:name(?)?` parameter at `i`: (chars consumed, regex piece, name).
fn param_at(chars: &[char], i: usize) -> Option<(usize, String, String)> {
    let mut j = i;
    let slash = chars.get(j) == Some(&'/');
    if slash {
        j += 1;
    }
    let format = chars.get(j) == Some(&'.');
    if format {
        j += 1;
    }
    if chars.get(j) != Some(&':') {
        return None;
    }
    j += 1;
    let name_start = j;
    while chars
        .get(j)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
    {
        j += 1;
    }
    if j == name_start {
        return None;
    }
    let name: String = chars.get(name_start..j)?.iter().collect();
    // `:name(regex)` and `:name*` are not supported: leave them to the caller's refusal.
    if matches!(chars.get(j), Some('(' | '*')) {
        return None;
    }
    let optional = chars.get(j) == Some(&'?');
    if optional {
        j += 1;
    }
    let capture = if format { "([^/.]+?)" } else { "([^/]+?)" };
    let mut piece = String::from("(?:");
    if format {
        piece.push_str("\\.");
    }
    if slash {
        piece.push('/');
    }
    piece.push_str(capture);
    piece.push(')');
    if optional {
        piece.push('?');
    }
    Some((j - i, piece, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(pattern: &str) -> PathPattern {
        PathPattern::compile(pattern, true).expect("pattern compiles")
    }

    fn prefix(pattern: &str) -> PathPattern {
        PathPattern::compile(pattern, false).expect("pattern compiles")
    }

    fn params(m: &PathMatch) -> Vec<(String, Option<String>)> {
        m.params
            .iter()
            .map(|(k, v)| (k.to_owned(), v.map(str::to_owned)))
            .collect()
    }

    #[test]
    fn parameter_keys_follow_shared_property_order() {
        let mut params = Params::default();
        for key in ["b", "4294967295", "2", "01", "0", "4294967294", "😀"] {
            params.set(key.to_owned(), None);
        }
        let entries: Vec<_> = params.iter().collect();
        assert_eq!(
            entries.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            ["0", "2", "4294967294", "b", "4294967295", "01", "😀"]
        );
        assert!(entries.iter().all(|(_, value)| value.is_none()));
        assert_eq!(params.to_json(), serde_json::json!({}));
    }

    #[test]
    fn literal_routes_are_case_insensitive_with_optional_slash() {
        let p = route("/users/me");
        assert!(p.matches("/users/me").expect("ok").is_some());
        assert!(p.matches("/USERS/Me/").expect("ok").is_some());
        assert!(p.matches("/users/me//").expect("ok").is_none());
        assert!(p.matches("/users/mex").expect("ok").is_none());
        assert!(
            route("/.well-known/oauth")
                .matches("/.well-known/oauth")
                .expect("ok")
                .is_some()
        );
        assert!(
            route("/.well-known/oauth")
                .matches("/xwell-known/oauth")
                .expect("ok")
                .is_none()
        );
        assert!(route("/").matches("/").expect("ok").is_some());
        assert!(route("/").matches("").expect("ok").is_some());
    }

    #[test]
    fn params_decode_and_keep_case() {
        let p = route("/users/:channelID");
        let m = p.matches("/Users/AbC%20d").expect("ok").expect("matches");
        assert_eq!(
            params(&m),
            [("channelID".to_owned(), Some("AbC d".to_owned()))]
        );
        let m = p
            .matches("/users/%F0%9F%98%80")
            .expect("ok")
            .expect("matches");
        assert_eq!(m.params.get("channelID"), Some("😀"));
        let m = p
            .matches("/users/%D7%A9%D7%9C%D7%95%D7%9D")
            .expect("ok")
            .expect("matches");
        assert_eq!(m.params.get("channelID"), Some("שלום"));
        let m = p.matches("/users/e%CC%81").expect("ok").expect("matches");
        assert_eq!(m.params.get("channelID"), Some("e\u{301}"));
        let err = p.matches("/users/%E0%A4%A").expect_err("malformed");
        assert_eq!(err.status(), Some(400));
        assert_eq!(err.message(), "Failed to decode param '%E0%A4%A'");
        assert!(p.matches("/users").expect("ok").is_none());
        assert!(p.matches("/users/a/b").expect("ok").is_none());
    }

    #[test]
    fn optional_params() {
        let p = route("/opt/:a/:b?");
        let m = p.matches("/opt/x").expect("ok").expect("matches");
        assert_eq!(
            params(&m),
            [
                ("a".to_owned(), Some("x".to_owned())),
                ("b".to_owned(), None)
            ]
        );
        let m = p.matches("/opt/x/y/").expect("ok").expect("matches");
        assert_eq!(m.params.get("b"), Some("y"));
        assert!(p.matches("/opt").expect("ok").is_none());
    }

    #[test]
    fn stars_and_formats() {
        let m = route("/files/*")
            .matches("/files/a/b%20c")
            .expect("ok")
            .expect("matches");
        assert_eq!(m.params.get("0"), Some("a/b c"));
        let m = route("*")
            .matches("/any/thing")
            .expect("ok")
            .expect("matches");
        assert_eq!(m.params.get("0"), Some("/any/thing"));
        let m = route("/f/:name.:ext")
            .matches("/f/report.pdf")
            .expect("ok")
            .expect("matches");
        assert_eq!(m.params.get("name"), Some("report"));
        assert_eq!(m.params.get("ext"), Some("pdf"));
    }

    #[test]
    fn prefixes_match_whole_segments() {
        let p = prefix("/users");
        assert_eq!(
            p.matches("/users/1").expect("ok").map(|m| m.path),
            Some("/users".to_owned())
        );
        assert_eq!(
            p.matches("/users").expect("ok").map(|m| m.path),
            Some("/users".to_owned())
        );
        assert_eq!(
            p.matches("/users/").expect("ok").map(|m| m.path),
            Some("/users/".to_owned())
        );
        assert_eq!(
            p.matches("/USERS//x").expect("ok").map(|m| m.path),
            Some("/USERS/".to_owned())
        );
        assert!(p.matches("/usersx").expect("ok").is_none());
        assert!(p.matches("/users.json").expect("ok").is_none());
        let p = prefix("/:channelID/duel");
        let m = p.matches("/abc/duel/start").expect("ok").expect("matches");
        assert_eq!(m.path, "/abc/duel");
        assert_eq!(m.params.get("channelID"), Some("abc"));
        assert_eq!(
            prefix("/")
                .matches("/anything")
                .expect("ok")
                .map(|m| m.path),
            Some(String::new())
        );
    }

    #[test]
    fn refuses_what_it_cannot_reproduce() {
        for bad in [
            "/a+b",
            "/user/:id(\\d+)",
            "/a/:b*",
            "/foo-:id",
            "/(a)",
            "/a?",
            "/a:",
        ] {
            assert!(PathPattern::compile(bad, true).is_err(), "{bad}");
        }
        assert!(PathPattern::compile(":id", true).is_ok());
    }

    #[test]
    fn merge_params_like_express() {
        let mut parent = Params::default();
        parent.set("channelID".into(), Some("p".into()));
        let mut child = Params::default();
        child.set("action".into(), Some("c".into()));
        child.set("channelID".into(), Some("override".into()));
        let merged = child.merged_over(&parent);
        let keys: Vec<(&str, Option<&str>)> = merged.iter().collect();
        assert_eq!(
            keys,
            [("channelID", Some("override")), ("action", Some("c"))]
        );
        let mut parent = Params::default();
        parent.set("0".into(), Some("a".into()));
        let mut child = Params::default();
        child.set("0".into(), Some("b".into()));
        let merged = child.merged_over(&parent);
        assert_eq!(merged.get("0"), Some("a"));
        assert_eq!(merged.get("1"), Some("b"));
    }
}
