//! `JSON.parse`: text to the `serde_json::Value` JavaScript would hold afterwards.

use crate::json::{array_index, index_keys_first};
use serde_json::{Map, Number, Value};
use std::fmt;

/// Limits for [`parse_js_json`]. `JSON.parse` has none of its own; the caller states them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct JsonLimits {
    /// The most arrays and objects that may be open at once (`[[1]]` needs 2). `serde_json`'s
    /// default recursion limit corresponds to 127. The parser itself needs no call stack for
    /// depth, but dropping a `serde_json::Value` recurses once per level, so keep this to a few
    /// thousand at most.
    pub max_depth: usize,
    /// The longest accepted text, in bytes.
    pub max_bytes: usize,
}

/// Why [`parse_js_json`] refused a text. Offsets are byte offsets into the text.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum JsonParseError {
    /// Where `JSON.parse` throws a `SyntaxError`: `found` is the unexpected character, `None` at
    /// the end of the text.
    Syntax {
        /// Byte offset of the unexpected character (the text length at the end).
        offset: usize,
        /// The unexpected character.
        found: Option<char>,
    },
    /// A number beyond the double range (`1e400`), which JavaScript reads as `Infinity` and a
    /// `Value` cannot hold (an allowed difference, `MIGRATION.md` decision log).
    NumberOutOfRange {
        /// Byte offset of the number.
        offset: usize,
    },
    /// More than [`JsonLimits::max_depth`] containers open at once.
    TooDeep {
        /// Byte offset of the bracket that went too deep.
        offset: usize,
    },
    /// The text is longer than [`JsonLimits::max_bytes`].
    TooLarge,
}

impl fmt::Display for JsonParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax { found: None, .. } => formatter.write_str("Unexpected end of JSON input"),
            Self::Syntax {
                offset,
                found: Some(found),
            } => write!(
                formatter,
                "Unexpected token '{found}' in JSON at byte {offset}"
            ),
            Self::NumberOutOfRange { offset } => {
                write!(formatter, "Number out of range in JSON at byte {offset}")
            }
            Self::TooDeep { offset } => {
                write!(formatter, "JSON nested too deeply at byte {offset}")
            }
            Self::TooLarge => formatter.write_str("JSON text too large"),
        }
    }
}

impl std::error::Error for JsonParseError {}

/// The `Value` for a JavaScript number, as [`parse_js_json`] stores numbers: an integral value
/// within ±2^53 is an integer (it prints without a fraction and maps to an integer BSON type
/// downstream, and JavaScript cannot tell `1` from `1.0`), anything else a double, `-0`
/// included. `NaN` and infinities are `null`, as `JSON.stringify` writes them.
pub fn js_number_value(n: f64) -> Value {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    if n.fract() == 0.0 && n.abs() <= EXACT && !(n == 0.0 && n.is_sign_negative()) {
        return Value::from(n as i64);
    }
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `JSON.parse(text)`, holding what JavaScript holds afterwards:
///
/// - object keys in JavaScript's property order: array-index keys (`"0"` to `"4294967294"`)
///   first in ascending order, then the others in the order they first appear;
/// - a duplicate key keeps the position of its first appearance and the value of its last;
/// - numbers are the nearest double to the text (integers beyond 2^53 round as JavaScript
///   rounds them, `-0` stays negative), stored as [`js_number_value`] stores them;
/// - a `\uD800`–`\uDFFF` escape that is not part of a valid pair becomes U+FFFD (text rule 3).
///
/// The grammar is JSON's, exactly as `JSON.parse` reads it (whitespace is space, tab, line feed
/// and carriage return; any value may stand at the top level). It runs on an explicit stack, so
/// `limits.max_depth` is the only bound on nesting.
pub fn parse_js_json(text: &str, limits: JsonLimits) -> Result<Value, JsonParseError> {
    if text.len() > limits.max_bytes {
        return Err(JsonParseError::TooLarge);
    }
    Parser {
        text,
        bytes: text.as_bytes(),
        at: 0,
    }
    .document(limits.max_depth)
}

/// An open container.
enum Frame {
    Array(Vec<Value>),
    Object {
        map: Map<String, Value>,
        /// The key whose value is being read.
        key: String,
        /// Whether any key so far is an array index (the map then needs reordering).
        indexed: bool,
    },
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn document(&mut self, max_depth: usize) -> Result<Value, JsonParseError> {
        let mut stack: Vec<Frame> = Vec::new();
        'values: loop {
            self.skip_whitespace();
            let mut value = match self.peek() {
                Some(open @ (b'[' | b'{')) => {
                    if stack.len() >= max_depth {
                        return Err(JsonParseError::TooDeep { offset: self.at });
                    }
                    self.at += 1;
                    self.skip_whitespace();
                    if open == b'[' {
                        if self.eat(b']') {
                            Value::Array(Vec::new())
                        } else {
                            stack.push(Frame::Array(Vec::new()));
                            continue 'values;
                        }
                    } else if self.eat(b'}') {
                        Value::Object(Map::new())
                    } else {
                        let key = self.key()?;
                        stack.push(Frame::Object {
                            map: Map::new(),
                            indexed: array_index(&key).is_some(),
                            key,
                        });
                        continue 'values;
                    }
                }
                Some(b'"') => Value::String(self.string()?),
                Some(b't') => self.literal("true", Value::Bool(true))?,
                Some(b'f') => self.literal("false", Value::Bool(false))?,
                Some(b'n') => self.literal("null", Value::Null)?,
                Some(b'-' | b'0'..=b'9') => self.number()?,
                _ => return Err(self.unexpected()),
            };
            // Hand the finished value to its container, closing every container it completes.
            loop {
                self.skip_whitespace();
                match stack.last_mut() {
                    None => {
                        return if self.at < self.bytes.len() {
                            Err(self.unexpected())
                        } else {
                            Ok(value)
                        };
                    }
                    Some(Frame::Array(items)) => {
                        items.push(value);
                        if self.eat(b',') {
                            continue 'values;
                        }
                        if !self.eat(b']') {
                            return Err(self.unexpected());
                        }
                    }
                    Some(Frame::Object { map, key, indexed }) => {
                        // `insert` keeps the first position of a duplicate key and takes the new
                        // value, as JavaScript's property assignment does.
                        map.insert(std::mem::take(key), value);
                        if self.eat(b',') {
                            self.skip_whitespace();
                            *key = self.key()?;
                            *indexed |= array_index(key).is_some();
                            continue 'values;
                        }
                        if !self.eat(b'}') {
                            return Err(self.unexpected());
                        }
                    }
                }
                value = match stack.pop() {
                    Some(Frame::Array(items)) => Value::Array(items),
                    Some(Frame::Object {
                        mut map, indexed, ..
                    }) => {
                        if indexed {
                            index_keys_first(&mut map);
                        }
                        Value::Object(map)
                    }
                    None => return Err(self.unexpected()),
                };
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn unexpected(&self) -> JsonParseError {
        JsonParseError::Syntax {
            offset: self.at,
            found: self
                .text
                .get(self.at..)
                .and_then(|rest| rest.chars().next()),
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, JsonParseError> {
        for expected in word.bytes() {
            if !self.eat(expected) {
                return Err(self.unexpected());
            }
        }
        Ok(value)
    }

    /// An object key and the `:` after it.
    fn key(&mut self) -> Result<String, JsonParseError> {
        if self.peek() != Some(b'"') {
            return Err(self.unexpected());
        }
        let key = self.string()?;
        self.skip_whitespace();
        if !self.eat(b':') {
            return Err(self.unexpected());
        }
        Ok(key)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - start
    }

    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, rounded to the nearest double.
    fn number(&mut self) -> Result<Value, JsonParseError> {
        let start = self.at;
        self.eat(b'-');
        if !self.eat(b'0') && self.digits() == 0 {
            return Err(self.unexpected());
        }
        if self.eat(b'.') && self.digits() == 0 {
            return Err(self.unexpected());
        }
        if self.eat(b'e') || self.eat(b'E') {
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return Err(self.unexpected());
            }
        }
        // Rust's float parsing is correctly rounded (ties to even), as ECMAScript requires.
        let double = self
            .text
            .get(start..self.at)
            .and_then(|number| number.parse::<f64>().ok())
            .filter(|double| double.is_finite())
            .ok_or(JsonParseError::NumberOutOfRange { offset: start })?;
        Ok(js_number_value(double))
    }

    /// A string literal, the opening quote at the cursor.
    fn string(&mut self) -> Result<String, JsonParseError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let run = self
                .bytes
                .get(self.at..)
                .and_then(|rest| {
                    rest.iter()
                        .position(|byte| matches!(byte, b'"' | b'\\' | 0..=0x1f))
                })
                .map_or(self.bytes.len(), |offset| self.at + offset);
            // The run stops at ASCII bytes only, so it ends on a character boundary.
            out.push_str(self.text.get(self.at..run).unwrap_or_default());
            self.at = run;
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    self.escape(&mut out)?;
                }
                // A raw control character, or the end of the text.
                _ => return Err(self.unexpected()),
            }
        }
    }

    /// The escape after a backslash.
    fn escape(&mut self, out: &mut String) -> Result<(), JsonParseError> {
        let Some(byte) = self.peek() else {
            return Err(self.unexpected());
        };
        let simple = match byte {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                self.at += 1;
                let unit = self.hex4()?;
                out.push(self.code_point(unit));
                return Ok(());
            }
            _ => return Err(self.unexpected()),
        };
        self.at += 1;
        out.push(simple);
        Ok(())
    }

    /// Four hex digits at the cursor.
    fn hex4(&mut self) -> Result<u32, JsonParseError> {
        let mut unit = 0;
        for _ in 0..4 {
            let digit = self
                .peek()
                .and_then(|byte| char::from(byte).to_digit(16))
                .ok_or_else(|| self.unexpected())?;
            unit = (unit << 4) | digit;
            self.at += 1;
        }
        Ok(unit)
    }

    /// The character of a `\uXXXX` escape already read; a high surrogate takes a following
    /// `\uDC00`–`\uDFFF` escape with it. A lone surrogate is U+FFFD.
    fn code_point(&mut self, unit: u32) -> char {
        if (0xd800..=0xdbff).contains(&unit) {
            let low = match self.bytes.get(self.at..self.at + 6) {
                Some([b'\\', b'u', hex @ ..]) => hex.iter().try_fold(0, |unit, byte| {
                    char::from(*byte)
                        .to_digit(16)
                        .map(|digit| (unit << 4) | digit)
                }),
                _ => None,
            };
            if let Some(low) = low.filter(|low| (0xdc00..=0xdfff).contains(low)) {
                self.at += 6;
                let code = 0x1_0000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                return char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER);
            }
        }
        char::from_u32(unit).unwrap_or(char::REPLACEMENT_CHARACTER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LIMITS: JsonLimits = JsonLimits {
        max_depth: 64,
        max_bytes: 1 << 16,
    };

    #[test]
    fn holds_what_javascript_holds() {
        let value = parse_js_json(
            r#"{"b":1.0,"2":9007199254740993,"z":-0,"s":"\ud83d","b":[1e2]}"#,
            LIMITS,
        );
        assert_eq!(
            value.as_ref().map(crate::to_js_json),
            Ok(r#"{"2":9007199254740992,"b":[100],"z":0,"s":"�"}"#.to_owned())
        );
        let negative_zero = value.ok().and_then(|value| value["z"].as_f64());
        assert!(negative_zero.is_some_and(|zero| zero == 0.0 && zero.is_sign_negative()));
        assert_eq!(parse_js_json(" \"x\" ", LIMITS), Ok(json!("x")));
    }

    #[test]
    fn refuses_what_javascript_refuses_and_the_limits() {
        let error = |text: &str| parse_js_json(text, LIMITS).err();
        assert_eq!(
            error("[1,]"),
            Some(JsonParseError::Syntax {
                offset: 3,
                found: Some(']')
            })
        );
        assert_eq!(
            error("[1"),
            Some(JsonParseError::Syntax {
                offset: 2,
                found: None
            })
        );
        assert_eq!(
            error("1e400"),
            Some(JsonParseError::NumberOutOfRange { offset: 0 })
        );
        let deep = format!("{}{}", "[".repeat(64), "]".repeat(64));
        assert!(parse_js_json(&deep, LIMITS).is_ok());
        let deeper = format!("[{deep}]");
        assert_eq!(error(&deeper), Some(JsonParseError::TooDeep { offset: 64 }));
        let large = " ".repeat((1 << 16) + 1);
        assert_eq!(error(&large), Some(JsonParseError::TooLarge));
        assert_eq!(
            error("\u{feff}1").map(|error| error.to_string()),
            Some("Unexpected token '\u{feff}' in JSON at byte 0".to_owned())
        );
    }
}
