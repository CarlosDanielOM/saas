//! The `dotenv` npm package's parser (version 16.6.1, `lib/main.js`), reproduced exactly.
//!
//! The package matches every line with one JavaScript regular expression (flags `m` and `g`):
//!
//! ```text
//! (?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)
//! ```
//!
//! The same grammar runs here on the same leftmost-first engine semantics (the `regex-automata`
//! meta engine reports the captures a backtracking engine would), with JavaScript's meaning of
//! each piece spelled out: `\s` is the ECMAScript whitespace set (including U+FEFF and the line
//! terminators), `\w` is ASCII, `.` excludes the four line terminators, and `^`/`$` in
//! multi-line mode treat LF, CR, U+2028 and U+2029 as line ends. `^` is applied by trying the
//! anchored grammar only at line starts; the final `$` consumes the terminator in a capture so the
//! next search starts where JavaScript's `lastIndex` would.
//!
//! After the match, as the package does: the value is trimmed (JavaScript `trim`), one matching
//! pair of surrounding quotes is removed (`/^(['"`])([\s\S]*)\1$/mg`), and in a value that started
//! with a double quote the two-character sequences `\n` and `\r` become a newline and a carriage
//! return. A later duplicate key replaces the earlier value. The key `__proto__` is dropped, since
//! assigning it on a plain JavaScript object does not create a property.

use regex_automata::meta::Regex;
use regex_automata::util::captures::Captures;
use regex_automata::{Anchored, Input};

/// ECMAScript `\s`.
const SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// The package's line grammar with JavaScript's `\s`, `\w`, `.` and `$` written out.
const LINE: &str = concat!(
    "<S>*(?:export<S>+)?([A-Za-z0-9_.\\-]+)(?:<S>*=<S>*?|:<S>+?)",
    "(<S>*'(?:\\\\'|[^'])*'|<S>*\"(?:\\\\\"|[^\"])*\"|<S>*`(?:\\\\`|[^`])*`|[^#\\r\\n]+)?",
    "<S>*(?:#[^\\n\\r\\x{2028}\\x{2029}]*)?(\\z|[\\n\\r\\x{2028}\\x{2029}])",
);

fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Byte offsets where multi-line `^` matches: the start and every position after a terminator.
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(
        text.char_indices()
            .filter(|(_, ch)| is_line_terminator(*ch))
            .map(|(index, ch)| index + ch.len_utf8()),
    );
    starts
}

fn sub(text: &str, start: usize, end: usize) -> &str {
    text.get(start..end).unwrap_or_default()
}

/// The dotenv grammar, compiled once per parse call.
struct Grammar {
    regex: Regex,
}

impl Grammar {
    fn new() -> Option<Self> {
        let pattern = LINE.replace("<S>", SPACE);
        Regex::new(&pattern).ok().map(|regex| Self { regex })
    }
}

/// `dotenv.parse(src)`: the key/value pairs of a file's text, in first-appearance order.
pub fn parse(src: &str) -> Vec<(String, String)> {
    let Some(grammar) = Grammar::new() else {
        // The pattern is a constant; failing to compile it is a build defect caught by the tests.
        return Vec::new();
    };
    let lines = normalize_line_breaks(src);
    let starts = line_starts(&lines);
    let mut caps: Captures = grammar.regex.create_captures();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut last_index = 0;
    'search: loop {
        let first = starts.partition_point(|start| *start < last_index);
        for start in starts.iter().skip(first).copied() {
            if start >= lines.len() {
                break;
            }
            let input = Input::new(&lines)
                .span(start..lines.len())
                .anchored(Anchored::Yes);
            grammar.regex.search_captures(&input, &mut caps);
            if !caps.is_match() {
                continue;
            }
            let (Some(key), Some(end)) = (caps.get_group(1), caps.get_group(3)) else {
                break 'search;
            };
            let key = sub(&lines, key.start, key.end);
            let value = caps
                .get_group(2)
                .map(|span| sub(&lines, span.start, span.end))
                .unwrap_or_default();
            insert(&mut out, key, finish_value(value));
            last_index = end.start;
            continue 'search;
        }
        break;
    }
    out
}

/// `src.toString().replace(/\r\n?/mg, '\n')`.
fn normalize_line_breaks(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            out.push('\n');
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn insert(out: &mut Vec<(String, String)>, key: &str, value: String) {
    if key == "__proto__" {
        return;
    }
    if let Some(entry) = out.iter_mut().find(|(existing, _)| existing == key) {
        entry.1 = value;
    } else {
        out.push((key.to_owned(), value));
    }
}

/// Trim, unquote, and expand `\n`/`\r` in double-quoted values, as the package does.
fn finish_value(raw: &str) -> String {
    let value = dima_text::trim(raw);
    let double_quoted = value.starts_with('"');
    let mut value = strip_quotes(value);
    if double_quoted {
        value = value.replace("\\n", "\n").replace("\\r", "\r");
    }
    value
}

/// `value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2')`.
fn strip_quotes(value: &str) -> String {
    let starts = line_starts(value);
    let mut out = String::with_capacity(value.len());
    let mut copied = 0;
    let mut search = 0;
    for start in starts {
        if start < search || start >= value.len() {
            continue;
        }
        let rest = sub(value, start, value.len());
        let Some(quote) = rest
            .chars()
            .next()
            .filter(|ch| matches!(ch, '\'' | '"' | '`'))
        else {
            continue;
        };
        let body_start = start + 1;
        // Greedy `[\s\S]*`: the last closing quote that is followed by a line end.
        let close = value
            .char_indices()
            .rev()
            .filter(|(index, ch)| *index >= body_start && *ch == quote)
            .map(|(index, _)| index)
            .find(|index| {
                sub(value, index + 1, value.len())
                    .chars()
                    .next()
                    .is_none_or(is_line_terminator)
            });
        if let Some(close) = close {
            out.push_str(sub(value, copied, start));
            out.push_str(sub(value, body_start, close));
            copied = close + 1;
            search = close + 1;
        }
    }
    out.push_str(sub(value, copied, value.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn grammar_compiles() {
        assert!(Grammar::new().is_some());
    }

    #[test]
    fn parses_the_common_forms() {
        let pairs = parse(
            "# comment\nexport A=1\nB = two # trailing\nC='single # kept'\nD=\"line\\nbreak\"\nE:  colon\nF=\nA=again\n",
        );
        assert_eq!(get(&pairs, "A"), Some("again"));
        assert_eq!(get(&pairs, "B"), Some("two"));
        assert_eq!(get(&pairs, "C"), Some("single # kept"));
        assert_eq!(get(&pairs, "D"), Some("line\nbreak"));
        assert_eq!(get(&pairs, "E"), Some("colon"));
        assert_eq!(get(&pairs, "F"), Some(""));
        assert_eq!(pairs.len(), 6);
    }

    #[test]
    fn multi_line_quoted_values_span_lines() {
        let pairs = parse("KEY=\"first\nsecond\"\nNEXT=1\r\n");
        assert_eq!(get(&pairs, "KEY"), Some("first\nsecond"));
        assert_eq!(get(&pairs, "NEXT"), Some("1"));
    }

    #[test]
    fn proto_is_not_an_own_key() {
        assert!(parse("__proto__=x\n").is_empty());
    }
}
