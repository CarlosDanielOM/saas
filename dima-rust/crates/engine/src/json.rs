//! The command language's JSON reader: `JSON.parse` of the stored values commands read as lists
//! (`%(list[0])`, loops over a stored list, list writes and removals).
//!
//! It reads what `JSON.parse` reads, as V8 does: a number beyond the double range is
//! `Infinity` (or `-Infinity`), a repeated key keeps its first position and its last value,
//! and lone surrogate escapes become U+FFFD (text rule 3, the one intended difference).
//! Containers nest up to [`MAX_JSON_NESTING`], read without recursion; V8's reader has no
//! depth limit of its own, and deeper text reads as invalid JSON here.
//!
//! The evaluator reads with a budget ([`parse_within`]): every value node costs
//! [`JSON_NODE_BYTES`], every text and object key its bytes on top (a key also a node), charged
//! as the value is built, so a short text of many small containers (`[[],[],…]`: three bytes a
//! node) cannot become a value many times its size.
//!
//! It is separate from the web crate's request-body parser, which is stricter on purpose.

use crate::value::Value;

/// The deepest nesting of lists and objects the reader accepts. The values it builds are
/// cloned, compared, written and dropped by recursive code; the evaluator's stack contract
/// (`crate::stack`) leaves room for a value this deep.
pub const MAX_JSON_NESTING: usize = 256;

/// What [`parse_within`] charges for every value node (and every object key), on top of the
/// bytes of its text: a [`Value`] is 32 bytes on a 64-bit target and an object entry is a key
/// (a 24-byte `String`) beside its value, so this is a floor for what a node takes.
pub const JSON_NODE_BYTES: usize = 32;

const _: () = assert!(std::mem::size_of::<Value>() <= JSON_NODE_BYTES);

/// The value [`parse_within`] was reading needs more than its budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the JSON value needs more memory than its budget")]
pub struct OverBudget;

/// A container being read.
enum Frame {
    List(Vec<Value>),
    /// The entries so far and the key of the value being read.
    Object(Vec<(String, Value)>, String),
}

struct Reader<'a> {
    text: &'a str,
    at: usize,
    /// Bytes of the budget left.
    left: usize,
    /// Set when the budget ran out (the read then ends as `None`).
    over: bool,
}

/// `JSON.parse(text)`, or `None` where it throws (or the nesting is over the bound).
pub fn parse(text: &str) -> Option<Value> {
    parse_within(text, usize::MAX).unwrap_or_default()
}

/// [`parse`] within a budget of `budget` bytes, charged as the value is built
/// ([`JSON_NODE_BYTES`] a node plus the bytes of its text): [`OverBudget`] as soon as the value
/// read so far needs more, before anything more is built.
pub fn parse_within(text: &str, budget: usize) -> Result<Option<Value>, OverBudget> {
    let mut reader = Reader {
        text,
        at: 0,
        left: budget,
        over: false,
    };
    let value = read(&mut reader);
    if reader.over {
        return Err(OverBudget);
    }
    Ok(value)
}

fn read(reader: &mut Reader<'_>) -> Option<Value> {
    let text = reader.text;
    let mut stack: Vec<Frame> = Vec::new();
    'value: loop {
        reader.skip_space();
        reader.charge(JSON_NODE_BYTES)?;
        let mut value = match reader.peek()? {
            open @ (b'[' | b'{') => {
                reader.at += 1;
                if stack.len() >= MAX_JSON_NESTING {
                    return None;
                }
                reader.skip_space();
                if open == b'[' {
                    if reader.eat(b']') {
                        Value::List(Vec::new())
                    } else {
                        stack.push(Frame::List(Vec::new()));
                        continue 'value;
                    }
                } else if reader.eat(b'}') {
                    Value::object(Vec::new())
                } else {
                    let key = reader.key()?;
                    stack.push(Frame::Object(Vec::new(), key));
                    continue 'value;
                }
            }
            b'"' => {
                let text = reader.string()?;
                reader.charge(text.len())?;
                Value::Text(text)
            }
            b't' => reader.word("true", Value::Bool(true))?,
            b'f' => reader.word("false", Value::Bool(false))?,
            b'n' => reader.word("null", Value::Null)?,
            b'-' | b'0'..=b'9' => Value::Number(reader.number()?),
            _ => return None,
        };
        // A value is complete: give it to its container, closing every container it ends.
        loop {
            reader.skip_space();
            match stack.last_mut() {
                None => return (reader.at == text.len()).then_some(value),
                Some(Frame::List(items)) => {
                    items.push(value);
                    if reader.eat(b',') {
                        continue 'value;
                    }
                    if !reader.eat(b']') {
                        return None;
                    }
                    let Some(Frame::List(items)) = stack.pop() else {
                        return None;
                    };
                    value = Value::List(items);
                }
                Some(Frame::Object(entries, key)) => {
                    entries.push((std::mem::take(key), value));
                    if reader.eat(b',') {
                        reader.skip_space();
                        *key = reader.key()?;
                        continue 'value;
                    }
                    if !reader.eat(b'}') {
                        return None;
                    }
                    let Some(Frame::Object(entries, _)) = stack.pop() else {
                        return None;
                    };
                    value = Value::object(entries);
                }
            }
        }
    }
}

impl Reader<'_> {
    /// Takes `bytes` from the budget; `None` (and the flag) when they are not left.
    fn charge(&mut self, bytes: usize) -> Option<()> {
        match self.left.checked_sub(bytes) {
            Some(left) => {
                self.left = left;
                Some(())
            }
            None => {
                self.over = true;
                None
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    /// JSON whitespace: space, tab, line feed, carriage return.
    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn word(&mut self, word: &str, value: Value) -> Option<Value> {
        let rest = self.text.get(self.at..)?;
        if !rest.starts_with(word) {
            return None;
        }
        self.at += word.len();
        Some(value)
    }

    /// An object key and its colon, charged as a node and its bytes.
    fn key(&mut self) -> Option<String> {
        if self.peek() != Some(b'"') {
            return None;
        }
        let key = self.string()?;
        self.charge(JSON_NODE_BYTES.saturating_add(key.len()))?;
        self.skip_space();
        self.eat(b':').then_some(key)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, read as the nearest double;
    /// beyond the double range it is infinite, as in V8.
    fn number(&mut self) -> Option<f64> {
        let start = self.at;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return None;
            }
        }
        self.text.get(start..self.at)?.parse::<f64>().ok()
    }

    /// Four hexadecimal digits of a `\u` escape.
    fn hex4(&mut self) -> Option<u16> {
        let hex = self.text.get(self.at..self.at.checked_add(4)?)?;
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u16::from_str_radix(hex, 16).ok()
    }

    /// A string, the opening quote next.
    fn string(&mut self) -> Option<String> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // The stops are ASCII, so the run ends on a character boundary.
            out.push_str(self.text.get(start..self.at)?);
            match self.peek()? {
                b'"' => {
                    self.at += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek()?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            out.push(self.code_point(unit));
                        }
                        _ => return None,
                    }
                }
                // A raw control character.
                _ => return None,
            }
        }
    }

    /// The character of a `\u` escape: a high surrogate pairs with a `\u` low surrogate that
    /// follows it; a surrogate without its pair is U+FFFD.
    fn code_point(&mut self, unit: u16) -> char {
        if (0xD800..0xDC00).contains(&unit) {
            let rest = self.text.get(self.at..).unwrap_or_default();
            if rest.starts_with("\\u") {
                let saved = self.at;
                self.at += 2;
                if let Some(low) = self.hex4().filter(|low| (0xDC00..0xE000).contains(low)) {
                    let code =
                        0x10000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
                    return char::from_u32(code).unwrap_or('\u{fffd}');
                }
                self.at = saved;
            }
            return '\u{fffd}';
        }
        char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Option<String> {
        parse(text).and_then(|value| value.to_json())
    }

    #[test]
    fn reads_what_json_parse_reads() {
        assert_eq!(
            json(" [1, -0, 1.5e3, 1E+2, 0.5] "),
            Some("[1,0,1500,100,0.5]".into())
        );
        let infinite = parse("[1e400,-1e400,1e-400]").unwrap();
        assert_eq!(
            infinite,
            Value::List(vec![
                Value::Number(f64::INFINITY),
                Value::Number(f64::NEG_INFINITY),
                Value::Number(0.0),
            ])
        );
        assert_eq!(
            json(r#"{"b":1,"10":10,"2":2,"a":3,"b":4}"#),
            Some(r#"{"2":2,"10":10,"b":4,"a":3}"#.into())
        );
        assert_eq!(
            parse(r#"["\u00e9\ud83d\ude00\/\b\f\n\r\t\"\\"]"#),
            Some(Value::List(vec![Value::text("é😀/\u{8}\u{c}\n\r\t\"\\")]))
        );
        assert_eq!(
            parse(r#"["\ud800","\udc00x","\ud800\u0041","\ud800\ud800"]"#),
            Some(Value::List(vec![
                Value::text("\u{fffd}"),
                Value::text("\u{fffd}x"),
                Value::text("\u{fffd}A"),
                Value::text("\u{fffd}\u{fffd}"),
            ]))
        );
        assert_eq!(parse("\"😀\u{2028}\""), Some(Value::text("😀\u{2028}")));
        assert_eq!(parse("true"), Some(Value::Bool(true)));
        assert_eq!(parse("null"), Some(Value::Null));
        for invalid in [
            "",
            " ",
            "[",
            "[1,]",
            "[01]",
            "[1.]",
            "[.5]",
            "[+1]",
            "[1e]",
            "-",
            "[\"\t\"]",
            "[1] x",
            "{\"a\" 1}",
            "{a:1}",
            "{\"a\":1,}",
            "[\"\\x\"]",
            "[\"\\u12\"]",
            "tru",
            "nul",
            "[1 2]",
            "{\"a\":1 \"b\":2}",
            "\"open",
        ] {
            assert_eq!(parse(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn a_budget_is_charged_per_node_and_text_byte() {
        // A list of two texts: three nodes and three bytes.
        let cost = 3 * JSON_NODE_BYTES + 3;
        assert_eq!(
            parse_within(r#"["ab","c"]"#, cost),
            Ok(parse(r#"["ab","c"]"#))
        );
        assert_eq!(parse_within(r#"["ab","c"]"#, cost - 1), Err(OverBudget));
        // An object entry: the object, the key (a node and its byte) and the value.
        assert!(parse_within(r#"{"k":1}"#, 3 * JSON_NODE_BYTES + 1).is_ok());
        assert_eq!(
            parse_within(r#"{"k":1}"#, 3 * JSON_NODE_BYTES),
            Err(OverBudget)
        );
        // Invalid text within the budget is still `None`.
        assert_eq!(parse_within("[1,", 1024), Ok(None));
    }

    #[test]
    fn nesting_is_read_without_recursion_up_to_the_bound() {
        let nested = |depth: usize, inner: &str| {
            format!("{}{inner}{}", "[".repeat(depth), "]".repeat(depth))
        };
        assert!(parse(&nested(MAX_JSON_NESTING, "1")).is_some());
        assert!(parse(&nested(MAX_JSON_NESTING, "")).is_some());
        assert_eq!(parse(&nested(MAX_JSON_NESTING + 1, "1")), None);
        assert_eq!(parse(&nested(MAX_JSON_NESTING + 1, "")), None);
        let objects = format!(
            "{}1{}",
            "{\"a\":".repeat(MAX_JSON_NESTING),
            "}".repeat(MAX_JSON_NESTING)
        );
        assert!(parse(&objects).is_some());
        // Far deeper text is refused without using the stack.
        assert_eq!(parse(&nested(1_000_000, "1")), None);
    }
}
