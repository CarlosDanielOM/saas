//! Media-type parsing exactly as the Node packages Express uses do it.
//!
//! Two parsers exist on purpose: `content-type` 1.0.5 (charset lookup in body-parser, `setCharset`
//! in `res.send`) and `media-typer` 0.3.0 (type matching in `type-is`). They accept slightly
//! different inputs, and requests that hit the difference behave differently in Express.
//! Header values are handled as Node sees them: each byte is one character (latin1).

use std::collections::HashMap;

/// JavaScript `\s` / `String.prototype.trim` whitespace.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JavaScript `String.prototype.trim`.
pub(crate) fn trim_js(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '!' | '#'
                | '$'
                | '%'
                | '&'
                | '\''
                | '*'
                | '+'
                | '.'
                | '^'
                | '_'
                | '`'
                | '|'
                | '~'
                | '-'
        )
}

#[derive(Clone, Copy)]
enum Flavor {
    /// `content-type` 1.0.5.
    ContentType,
    /// `media-typer` 0.3.0.
    MediaTyper,
}

impl Flavor {
    fn qdtext(self, c: char) -> bool {
        let u = u32::from(c);
        match self {
            Self::ContentType => {
                u == 0x0B
                    || u == 0x20
                    || u == 0x21
                    || (0x23..=0x5B).contains(&u)
                    || (0x5D..=0x7E).contains(&u)
                    || (0x80..=0xFF).contains(&u)
            }
            Self::MediaTyper => {
                u == 0x20
                    || u == 0x21
                    || (0x23..=0x5B).contains(&u)
                    || (0x5D..=0x7E).contains(&u)
                    || (0x80..=0xFF).contains(&u)
            }
        }
    }

    fn quoted_pair(self, c: char) -> bool {
        let u = u32::from(c);
        match self {
            Self::ContentType => u == 0x0B || (0x20..=0xFF).contains(&u),
            Self::MediaTyper => (0x20..=0x7E).contains(&u),
        }
    }

    fn unescapes(self, c: char) -> bool {
        let u = u32::from(c);
        match self {
            Self::ContentType => u == 0x0B || (0x20..=0xFF).contains(&u),
            Self::MediaTyper => u <= 0x7F,
        }
    }
}

/// One `; key=value` parameter matched exactly at `at` (a sticky regular-expression match).
/// Returns the lower-cased key, the unquoted value and the index after the match.
fn match_param(chars: &[char], at: usize, flavor: Flavor) -> Option<(String, String, usize)> {
    let mut i = at;
    if chars.get(i) != Some(&';') {
        return None;
    }
    i += 1;
    while chars.get(i) == Some(&' ') {
        i += 1;
    }
    let key_start = i;
    while chars.get(i).copied().is_some_and(is_token_char) {
        i += 1;
    }
    if i == key_start {
        return None;
    }
    let key: String = chars
        .get(key_start..i)?
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    while chars.get(i) == Some(&' ') {
        i += 1;
    }
    if chars.get(i) != Some(&'=') {
        return None;
    }
    i += 1;
    while chars.get(i) == Some(&' ') {
        i += 1;
    }
    let value = if chars.get(i) == Some(&'"') {
        let mut j = i + 1;
        let mut raw = String::new();
        loop {
            match chars.get(j).copied() {
                Some('"') => break,
                Some('\\')
                    if chars
                        .get(j + 1)
                        .copied()
                        .is_some_and(|c| flavor.quoted_pair(c)) =>
                {
                    raw.push('\\');
                    raw.push(chars.get(j + 1).copied()?);
                    j += 2;
                }
                Some(c) if flavor.qdtext(c) => {
                    raw.push(c);
                    j += 1;
                }
                _ => return None,
            }
        }
        i = j + 1;
        unescape(&raw, flavor)
    } else {
        let start = i;
        while chars.get(i).copied().is_some_and(is_token_char) {
            i += 1;
        }
        if i == start {
            return None;
        }
        chars.get(start..i)?.iter().collect()
    };
    while chars.get(i) == Some(&' ') {
        i += 1;
    }
    Some((key, value, i))
}

/// Removes `\x` escapes the way each package's replace regular expression does.
fn unescape(raw: &str, flavor: Flavor) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && flavor.unescapes(next)
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

/// Parameters one media type may carry. No client sends more; a header with more is treated as
/// malformed (the packages accept any number), which keeps parsing linear and bounded.
pub(crate) const MAX_PARAMS: usize = 128;

/// A parsed media type: lower-case `type/subtype` and its parameters in first-seen order
/// (a repeated key keeps its first position and takes the last value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContentType {
    pub(crate) essence: String,
    pub(crate) params: Vec<(String, String)>,
}

impl ContentType {
    pub(crate) fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Sets one parameter; `positions` indexes `params` by key while a header is parsed.
    fn set_param_indexed(
        &mut self,
        positions: &mut HashMap<String, usize>,
        key: String,
        value: String,
    ) {
        match positions.get(&key) {
            Some(&at) => {
                if let Some(slot) = self.params.get_mut(at) {
                    slot.1 = value;
                }
            }
            None => {
                positions.insert(key.clone(), self.params.len());
                self.params.push((key, value));
            }
        }
    }

    fn set_param(&mut self, key: String, value: String) {
        match self.params.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.params.push((key, value)),
        }
    }
}

fn is_type_token(s: &str) -> bool {
    match s.split_once('/') {
        Some((t, sub)) => {
            !t.is_empty()
                && !sub.is_empty()
                && t.chars().all(is_token_char)
                && sub.chars().all(is_token_char)
        }
        None => false,
    }
}

/// `contentType.parse(string)` from `content-type` 1.0.5; `None` where it throws.
pub(crate) fn parse_content_type(header: &str) -> Option<ContentType> {
    if header.is_empty() {
        return None;
    }
    let chars: Vec<char> = header.chars().collect();
    let semicolon = chars.iter().position(|&c| c == ';');
    let type_part: String = match semicolon {
        Some(at) => chars.get(..at)?.iter().collect(),
        None => header.to_owned(),
    };
    let type_part = trim_js(&type_part);
    if !is_type_token(type_part) {
        return None;
    }
    let mut parsed = ContentType {
        essence: type_part.to_ascii_lowercase(),
        params: Vec::new(),
    };
    if let Some(mut index) = semicolon {
        let mut positions = HashMap::new();
        while let Some((key, value, next)) = match_param(&chars, index, Flavor::ContentType) {
            parsed.set_param_indexed(&mut positions, key, value);
            if parsed.params.len() > MAX_PARAMS {
                return None;
            }
            index = next;
        }
        if index != chars.len() {
            return None;
        }
    }
    Some(parsed)
}

/// `contentType.format(obj)`; `None` where it throws.
fn format_content_type(parsed: &ContentType) -> Option<String> {
    if !is_type_token(&parsed.essence) {
        return None;
    }
    let mut out = parsed.essence.clone();
    let mut params: Vec<&(String, String)> = parsed.params.iter().collect();
    params.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, value) in params {
        if key.is_empty() || !key.chars().all(is_token_char) {
            return None;
        }
        out.push_str("; ");
        out.push_str(key);
        out.push('=');
        if !value.is_empty() && value.chars().all(is_token_char) {
            out.push_str(value);
        } else {
            let text_ok = value.chars().all(|c| {
                let u = u32::from(c);
                u == 0x0B || (0x20..=0x7E).contains(&u) || (0x80..=0xFF).contains(&u)
            });
            if !value.is_empty() && !text_ok {
                return None;
            }
            out.push('"');
            for c in value.chars() {
                if c == '\\' || c == '"' {
                    out.push('\\');
                }
                out.push(c);
            }
            out.push('"');
        }
    }
    Some(out)
}

/// Express `utils.setCharset(type, charset)`; `None` where `content-type` throws.
pub(crate) fn set_charset(content_type: &str, charset: &str) -> Option<String> {
    if content_type.is_empty() {
        return Some(String::new());
    }
    let mut parsed = parse_content_type(content_type)?;
    parsed.set_param("charset".to_owned(), charset.to_owned());
    format_content_type(&parsed)
}

/// body-parser's `getCharset(req)`: the lower-cased `charset` parameter, `Some("")` when the
/// header parses without one, `None` when it does not parse (callers then default to utf-8).
pub(crate) fn request_charset(content_type: Option<&str>) -> Option<String> {
    let parsed = parse_content_type(content_type?)?;
    Some(parsed.param("charset").unwrap_or("").to_lowercase())
}

/// `media-typer` 0.3.0 `parse` + `format` without parameters, as `type-is` uses it.
fn normalize_actual(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let chars: Vec<char> = value.chars().collect();
    let semicolon = chars.iter().position(|&c| c == ';');
    let type_part: String = match semicolon {
        Some(at) => chars.get(..at)?.iter().collect(),
        None => value.to_owned(),
    };
    let (kind, subtype, suffix) = split_media_type(&type_part.to_lowercase())?;
    if let Some(mut index) = semicolon {
        let mut count = 0usize;
        while let Some((_, _, next)) = match_param(&chars, index, Flavor::MediaTyper) {
            count += 1;
            if count > MAX_PARAMS {
                return None;
            }
            index = next;
        }
        if index != chars.len() {
            return None;
        }
    }
    let type_name_ok = |s: &str| {
        name_ok(s, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '!' | '#' | '$' | '&' | '^' | '_' | '-')
        })
    };
    let subtype_ok = |s: &str| {
        name_ok(s, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '!' | '#' | '$' | '&' | '^' | '_' | '.' | '-')
        })
    };
    if !type_name_ok(&kind) || !subtype_ok(&subtype) {
        return None;
    }
    let mut out = format!("{kind}/{subtype}");
    if let Some(suffix) = suffix.filter(|s| !s.is_empty()) {
        if !type_name_ok(&suffix) {
            return None;
        }
        out.push('+');
        out.push_str(&suffix);
    }
    Some(out)
}

/// A media-typer name: first character alphanumeric, then up to 126 allowed characters.
fn name_ok(s: &str, allowed: impl Fn(char) -> bool) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut count = 0usize;
    for c in chars {
        if !allowed(c) {
            return false;
        }
        count += 1;
    }
    count <= 126
}

/// media-typer `splitType`: `/^ *(type)\/(subtype) *$/` on the lower-cased type part.
fn split_media_type(lower: &str) -> Option<(String, String, Option<String>)> {
    let body = lower.trim_start_matches(' ').trim_end_matches(' ');
    let (kind, subtype) = body.split_once('/')?;
    let kind_ok = name_ok(kind, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '!' | '#' | '$' | '&' | '^' | '_' | '-')
    });
    let subtype_ok = name_ok(subtype, |c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-')
    });
    if !kind_ok || !subtype_ok {
        return None;
    }
    match subtype.rsplit_once('+') {
        Some((sub, suffix)) => Some((kind.to_owned(), sub.to_owned(), Some(suffix.to_owned()))),
        None => Some((kind.to_owned(), subtype.to_owned(), None)),
    }
}

/// `type-is` `normalize(type)` for the expected side.
fn normalize_expected(expected: &str) -> Option<String> {
    match expected {
        "urlencoded" => return Some("application/x-www-form-urlencoded".to_owned()),
        "multipart" => return Some("multipart/*".to_owned()),
        _ => {}
    }
    if expected.starts_with('+') {
        return Some(format!("*/*{expected}"));
    }
    if expected.contains('/') {
        Some(expected.to_owned())
    } else {
        lookup_extension(expected).map(str::to_owned)
    }
}

/// `type-is` `mimeMatch(expected, actual)`.
fn mime_match(expected: &str, actual: &str) -> bool {
    let actual_parts: Vec<&str> = actual.split('/').collect();
    let expected_parts: Vec<&str> = expected.split('/').collect();
    let ([actual_type, actual_sub], [expected_type, expected_sub]) =
        (actual_parts.as_slice(), expected_parts.as_slice())
    else {
        return false;
    };
    if *expected_type != "*" && expected_type != actual_type {
        return false;
    }
    if let Some(suffix) = expected_sub.strip_prefix("*+") {
        let wanted = format!("+{suffix}");
        return actual_sub.chars().count() + 1 >= expected_sub.chars().count()
            && actual_sub.ends_with(&wanted);
    }
    if *expected_sub != "*" && expected_sub != actual_sub {
        return false;
    }
    true
}

/// `typeis(req, types)` after `hasBody` passed: does the request's `Content-Type` match?
pub(crate) fn type_is(content_type: Option<&str>, types: &[String]) -> bool {
    let Some(actual) = content_type.and_then(normalize_actual) else {
        return false;
    };
    types.iter().any(|expected| {
        normalize_expected(expected).is_some_and(|expected| mime_match(&expected, &actual))
    })
}

/// `mime-types` 2.1 `lookup(extension)`, as `type-is` resolves an extension given as a parser
/// `type` option (the common extensions only; parsers here are configured with full types).
pub(crate) fn lookup_extension(ext: &str) -> Option<&'static str> {
    let ext = ext.rsplit('.').next().unwrap_or(ext).to_ascii_lowercase();
    let mime = match ext.as_str() {
        "txt" | "text" | "conf" | "def" | "list" | "log" | "in" | "ini" => "text/plain",
        "html" | "htm" | "shtml" => "text/html",
        "json" | "map" => "application/json",
        "bin" | "exe" | "dll" | "so" | "dmg" | "iso" | "img" | "msi" | "deb" => {
            "application/octet-stream"
        }
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "xml" | "xsl" | "xsd" | "rng" => "application/xml",
        "svg" | "svgz" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wave",
        "ogg" | "oga" | "spx" | "opus" => "audio/ogg",
        "mp4" | "mp4v" | "mpg4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => return None,
    };
    Some(mime)
}

/// mime 1.6 `lookup(path)`, which Express 4 uses through `send.mime` (`res.type`, `sendFile`,
/// `express.static`): the text after the last `.`, `/` or `\\` of the first line (the
/// expression `^.*[./\\]` does not cross a line break), lower-cased, looked up in the generated
/// table; anything unknown is `application/octet-stream`.
pub(crate) fn mime_lookup(path: &str) -> &'static str {
    let first_line_end = path
        .find(['\n', '\r', '\u{2028}', '\u{2029}'])
        .unwrap_or(path.len());
    let first_line = path.get(..first_line_end).unwrap_or(path);
    let extension = match first_line.rfind(['.', '/', '\\']) {
        Some(at) => path.get(at + 1..).unwrap_or(""),
        None => path,
    };
    let lower = dima_text::to_lower(extension);
    crate::mime_table::TYPES
        .binary_search_by(|(known, _)| known.as_bytes().cmp(lower.as_bytes()))
        .ok()
        .and_then(|at| crate::mime_table::TYPES.get(at))
        .map_or("application/octet-stream", |(_, kind)| kind)
}

/// mime 1.6 `charsets.lookup(type)`: `/^text\/|^application\/(javascript|json)/`, case-sensitive
/// and unanchored at the end (`application/json-seq` has one too).
pub(crate) fn mime_charset(content_type: &str) -> Option<&'static str> {
    let utf8 = content_type.starts_with("text/")
        || content_type.starts_with("application/javascript")
        || content_type.starts_with("application/json");
    utf8.then_some("UTF-8")
}

/// `/;\s*charset\s*=/` as `res.set` tests it.
pub(crate) fn has_charset_param(value: &str) -> bool {
    let mut rest = value;
    while let Some(at) = rest.find(';') {
        let after = rest.get(at + 1..).unwrap_or("");
        let trimmed = after.trim_start_matches(is_js_whitespace);
        if let Some(tail) = trimmed.strip_prefix("charset")
            && tail.trim_start_matches(is_js_whitespace).starts_with('=')
        {
            return true;
        }
        rest = after;
    }
    false
}

/// The value `res.set('Content-Type', value)` stores: adds `; charset=…` from mime 1.6.
pub(crate) fn express_content_type(value: &str) -> String {
    if has_charset_param(value) {
        return value.to_owned();
    }
    let essence = value.split(';').next().unwrap_or("");
    match mime_charset(essence) {
        Some(charset) => format!("{value}; charset={}", charset.to_lowercase()),
        None => value.to_owned(),
    }
}

/// `res.type(type)`: without a `/` the value goes through mime 1.6 `lookup` first.
pub(crate) fn express_type(value: &str) -> String {
    let resolved = if value.contains('/') {
        value.to_owned()
    } else {
        mime_lookup(value).to_owned()
    };
    express_content_type(&resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn parses_content_type_like_the_package() {
        let parsed = parse_content_type("Application/JSON; Charset=\"UTF-8\"").expect("valid");
        assert_eq!(parsed.essence, "application/json");
        assert_eq!(parsed.param("charset"), Some("UTF-8"));
        assert!(parse_content_type("application/json;").is_none());
        assert!(parse_content_type("application/json; charset").is_none());
        assert!(parse_content_type("text").is_none());
        assert_eq!(
            request_charset(Some("application/json")),
            Some(String::new())
        );
        assert_eq!(
            request_charset(Some("application/json; charset=UTF-16")),
            Some("utf-16".to_owned())
        );
        assert_eq!(request_charset(Some("bogus")), None);
    }

    #[test]
    fn sets_charset_like_express() {
        assert_eq!(
            set_charset("text/html", "utf-8").as_deref(),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            set_charset("text/plain; format=flowed; charset=latin1", "utf-8").as_deref(),
            Some("text/plain; charset=utf-8; format=flowed")
        );
        assert_eq!(
            express_content_type("application/json"),
            "application/json; charset=utf-8"
        );
        assert_eq!(
            express_content_type("text/plain; charset=utf-8"),
            "text/plain; charset=utf-8"
        );
        assert_eq!(express_content_type("image/png"), "image/png");
        assert_eq!(express_type("txt"), "text/plain; charset=utf-8");
        assert_eq!(express_type("bin"), "application/octet-stream");
    }

    #[test]
    fn matches_types_like_type_is() {
        assert!(type_is(
            Some("application/json"),
            &types(&["application/json"])
        ));
        assert!(type_is(
            Some("application/json; charset=utf-8"),
            &types(&["application/json"])
        ));
        assert!(type_is(
            Some("APPLICATION/JSON"),
            &types(&["application/json"])
        ));
        assert!(!type_is(
            Some("application/vnd.api+json"),
            &types(&["application/json"])
        ));
        assert!(type_is(
            Some("application/vnd.api+json"),
            &types(&["+json"])
        ));
        assert!(type_is(
            Some("application/x-www-form-urlencoded"),
            &types(&["urlencoded"])
        ));
        assert!(type_is(Some("text/plain"), &types(&["text/*"])));
        assert!(!type_is(Some("text/plain"), &types(&["application/json"])));
        assert!(!type_is(None, &types(&["application/json"])));
        assert!(!type_is(
            Some("application/json;"),
            &types(&["application/json"])
        ));
        assert!(type_is(
            Some(" application/json "),
            &types(&["application/json"])
        ));
    }

    /// Review finding: each parameter searched all earlier names, quadratic in the header.
    #[test]
    fn parameter_parsing_is_linear_and_bounded() {
        let params: String = (0..MAX_PARAMS).map(|i| format!("; p{i}=v")).collect();
        let parsed = parse_content_type(&format!("text/plain{params}; p0=w")).expect("parses");
        assert_eq!(parsed.params.len(), MAX_PARAMS);
        assert_eq!(parsed.param("p0"), Some("w"));
        assert_eq!(parsed.params.first().map(|(k, _)| k.as_str()), Some("p0"));
        assert!(parse_content_type(&format!("text/plain{params}; extra=1")).is_none());
        assert!(type_is(
            Some(&format!("application/json{params}")),
            &types(&["application/json"])
        ));
        assert!(!type_is(
            Some(&format!("application/json{params}; extra=1")),
            &types(&["application/json"])
        ));
        let huge: String = (0..200_000).map(|i| format!("; k{i}=v")).collect();
        let started = std::time::Instant::now();
        assert!(parse_content_type(&format!("text/plain{huge}")).is_none());
        assert!(request_charset(Some(&format!("text/plain{huge}"))).is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn detects_charset_parameter() {
        assert!(has_charset_param("text/html; charset=utf-8"));
        assert!(has_charset_param("text/html;charset =x"));
        assert!(!has_charset_param("text/html"));
        assert_eq!(mime_charset("text/anything"), Some("UTF-8"));
        assert_eq!(mime_charset("image/svg+xml"), None);
        // mime 1.6, not mime-db: no charset for +json types, one for any application/json… prefix.
        assert_eq!(mime_charset("application/manifest+json"), None);
        assert_eq!(mime_charset("application/json-seq"), Some("UTF-8"));
        assert_eq!(mime_charset("Text/plain"), None);
    }

    /// Expectations from `require('send').mime` in the reference's node_modules.
    #[test]
    fn looks_up_types_like_mime_1() {
        for (path, kind) in [
            ("a.mp3", "audio/mpeg"),
            ("/x/y/clip.MP4", "video/mp4"),
            ("speech.wav", "audio/wav"),
            ("voice.opus", "application/octet-stream"),
            ("index.html", "text/html"),
            ("html", "text/html"),
            (".json", "application/json"),
            ("README", "application/octet-stream"),
            (".hidden", "application/octet-stream"),
            ("dir\\file.css", "text/css"),
            ("a.b\nc.txt", "application/octet-stream"),
            ("file.\u{212A}ml", "application/vnd.google-earth.kml+xml"),
            ("😀.png", "image/png"),
            ("archive.tar.gz", "application/gzip"),
        ] {
            assert_eq!(mime_lookup(path), kind, "{path}");
        }
        assert_eq!(express_type("wav"), "audio/wav");
        assert_eq!(express_type("unknownext"), "application/octet-stream");
        assert_eq!(express_type("js"), "application/javascript; charset=utf-8");
        assert_eq!(
            express_content_type("application/manifest+json"),
            "application/manifest+json"
        );
    }
}
