//! V8's `JSON.parse` error messages, for the one place a client sees them: a Mongo document sent
//! as a JSON string (`decodeDocument` answers `400 <SyntaxError message>`). Positions are UTF-16
//! offsets, as V8 counts them. Only called on text `serde_json` already refused.

/// The message `JSON.parse(text)` throws.
pub fn json_parse_message(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut parser = Parser {
        source: text,
        chars: &chars,
        index: 0,
    };
    match parser.document() {
        Err(failure) => parser.message(failure),
        // serde_json refused something V8 accepts (nesting deeper than 128, numbers beyond the
        // double range): name it plainly.
        Ok(()) => "Invalid JSON".to_owned(),
    }
}

enum Failure {
    /// End of input where a token was needed.
    End,
    /// A token that cannot start or continue a value here.
    Token(usize),
    /// A message of its own at a position.
    At(&'static str, usize),
}

struct Parser<'a> {
    source: &'a str,
    chars: &'a [char],
    index: usize,
}

type Step = Result<(), Failure>;

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.index += 1;
        }
    }

    fn document(&mut self) -> Step {
        self.skip_space();
        self.value()?;
        self.skip_space();
        if self.peek().is_some() {
            return Err(Failure::At(
                "Unexpected non-whitespace character after JSON",
                self.index,
            ));
        }
        Ok(())
    }

    fn value(&mut self) -> Step {
        match self.peek() {
            None => Err(Failure::End),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => self.string(),
            Some('-' | '0'..='9') => self.number(),
            Some('t') => self.literal("true"),
            Some('f') => self.literal("false"),
            Some('n') => self.literal("null"),
            Some(_) => Err(Failure::Token(self.index)),
        }
    }

    fn object(&mut self) -> Step {
        self.index += 1;
        self.skip_space();
        if self.peek() == Some('}') {
            self.index += 1;
            return Ok(());
        }
        if self.peek() != Some('"') {
            return Err(Failure::At("Expected property name or '}'", self.index));
        }
        loop {
            self.string()?;
            self.skip_space();
            if self.peek() != Some(':') {
                return Err(Failure::At("Expected ':' after property name", self.index));
            }
            self.index += 1;
            self.skip_space();
            self.value()?;
            self.skip_space();
            match self.peek() {
                Some(',') => {
                    self.index += 1;
                    self.skip_space();
                    if self.peek() != Some('"') {
                        return Err(Failure::At(
                            "Expected double-quoted property name",
                            self.index,
                        ));
                    }
                }
                Some('}') => {
                    self.index += 1;
                    return Ok(());
                }
                _ => {
                    return Err(Failure::At(
                        "Expected ',' or '}' after property value",
                        self.index,
                    ));
                }
            }
        }
    }

    fn array(&mut self) -> Step {
        self.index += 1;
        self.skip_space();
        if self.peek() == Some(']') {
            self.index += 1;
            return Ok(());
        }
        loop {
            self.value()?;
            self.skip_space();
            match self.peek() {
                Some(',') => {
                    self.index += 1;
                    self.skip_space();
                }
                Some(']') => {
                    self.index += 1;
                    return Ok(());
                }
                _ => {
                    return Err(Failure::At(
                        "Expected ',' or ']' after array element",
                        self.index,
                    ));
                }
            }
        }
    }

    fn string(&mut self) -> Step {
        self.index += 1;
        loop {
            match self.peek() {
                None => return Err(Failure::At("Unterminated string", self.index)),
                Some('"') => {
                    self.index += 1;
                    return Ok(());
                }
                Some('\\') => {
                    self.index += 1;
                    match self.peek() {
                        None => return Err(Failure::End),
                        Some('"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't') => self.index += 1,
                        Some('u') => {
                            self.index += 1;
                            for _ in 0..4 {
                                if !self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                                    return Err(Failure::At("Bad Unicode escape", self.index));
                                }
                                self.index += 1;
                            }
                        }
                        Some(_) => return Err(Failure::At("Bad escaped character", self.index)),
                    }
                }
                Some(c) if u32::from(c) < 0x20 => {
                    return Err(Failure::At(
                        "Bad control character in string literal",
                        self.index,
                    ));
                }
                Some(_) => self.index += 1,
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.index;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.index += 1;
        }
        self.index - start
    }

    fn number(&mut self) -> Step {
        if self.peek() == Some('-') {
            self.index += 1;
            if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
                return Err(Failure::At("No number after minus sign", self.index));
            }
        }
        if self.peek() == Some('0') {
            self.index += 1;
            if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                return Err(Failure::At("Unexpected number", self.index));
            }
        } else {
            self.digits();
        }
        if self.peek() == Some('.') {
            self.index += 1;
            if self.digits() == 0 {
                return Err(Failure::At("Unterminated fractional number", self.index));
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.index += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.index += 1;
            }
            if self.digits() == 0 {
                return Err(Failure::At("Exponent part is missing a number", self.index));
            }
        }
        Ok(())
    }

    fn literal(&mut self, word: &str) -> Step {
        for expected in word.chars() {
            match self.peek() {
                None => return Err(Failure::End),
                Some(c) if c == expected => self.index += 1,
                Some(_) => return Err(Failure::Token(self.index)),
            }
        }
        Ok(())
    }

    /// UTF-16 offset of a character index.
    fn position(&self, index: usize) -> usize {
        self.chars.iter().take(index).map(|c| c.len_utf16()).sum()
    }

    fn message(&self, failure: Failure) -> String {
        match failure {
            Failure::End => "Unexpected end of JSON input".to_owned(),
            Failure::At(text, index) => {
                let position = self.position(index);
                let line = self
                    .chars
                    .iter()
                    .take(index)
                    .filter(|c| **c == '\n')
                    .count()
                    + 1;
                let line_start = self
                    .chars
                    .iter()
                    .take(index)
                    .rposition(|c| *c == '\n')
                    .map_or(0, |at| at + 1);
                let column = self.position(index) - self.position(line_start) + 1;
                // V8's one message that already ends in "JSON" does not repeat "in JSON".
                let place = if text.ends_with("JSON") {
                    ""
                } else {
                    " in JSON"
                };
                format!("{text}{place} at position {position} (line {line} column {column})")
            }
            Failure::Token(index) => {
                if matches!(
                    self.source,
                    "undefined" | "NaN" | "Infinity" | "[object Object]"
                ) {
                    return format!("\"{}\" is not valid JSON", self.source);
                }
                // A character outside the BMP is reported by its first UTF-16 unit, which
                // Rust text cannot hold (text rule 3: U+FFFD).
                let token = self
                    .chars
                    .get(index)
                    .map(|c| if c.len_utf16() > 1 { '\u{fffd}' } else { *c })
                    .unwrap_or('\u{fffd}');
                format!(
                    "Unexpected token '{token}', {} is not valid JSON",
                    self.context(index)
                )
            }
        }
    }

    /// The quoted source V8 shows: whole when short, else 10 UTF-16 units either side.
    fn context(&self, index: usize) -> String {
        const SIDE: usize = 10;
        let units: Vec<u16> = self.source.encode_utf16().collect();
        let length = units.len();
        let position = self.position(index);
        let slice = |start: usize, end: usize| {
            String::from_utf16_lossy(units.get(start..end.min(length)).unwrap_or_default())
        };
        if length < SIDE * 2 + 1 {
            format!("\"{}\"", self.source)
        } else if position < SIDE {
            format!("\"{}\"...", slice(0, position + SIDE))
        } else if position < length - SIDE {
            format!("...\"{}\"...", slice(position - SIDE, position + SIDE))
        } else {
            format!("...\"{}\"", slice(position - SIDE, length))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expectations from Node 26 `JSON.parse`.
    #[test]
    fn messages_match_v8() {
        let cases = [
            ("", "Unexpected end of JSON input"),
            (" ", "Unexpected end of JSON input"),
            ("xyz", "Unexpected token 'x', \"xyz\" is not valid JSON"),
            (
                "{bad",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"a\":1,}",
                "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
            ),
            (
                "{\"a\":1",
                "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)",
            ),
            (
                "[1,2",
                "Expected ',' or ']' after array element in JSON at position 4 (line 1 column 5)",
            ),
            (
                "{\"a\" 1}",
                "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
            ),
            (
                "\"abc",
                "Unterminated string in JSON at position 4 (line 1 column 5)",
            ),
            (
                "{} x",
                "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
            ),
            (
                "{\"a\":tru}",
                "Unexpected token '}', \"{\"a\":tru}\" is not valid JSON",
            ),
            ("nul", "Unexpected end of JSON input"),
            (
                "{\"a\":01}",
                "Unexpected number in JSON at position 6 (line 1 column 7)",
            ),
            ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
            (
                "{\"a\":\"\\x\"}",
                "Bad escaped character in JSON at position 7 (line 1 column 8)",
            ),
            (
                "-",
                "No number after minus sign in JSON at position 1 (line 1 column 2)",
            ),
            (
                "1e",
                "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "{\"a\":\"line\nbreak\"}",
                "Bad control character in string literal in JSON at position 10 (line 1 column 11)",
            ),
            (
                "{\"🍕\":1,x}",
                "Expected double-quoted property name in JSON at position 8 (line 1 column 9)",
            ),
            (
                "xxxxxxxxxxxxxxxxxxxxxxxxx",
                "Unexpected token 'x', \"xxxxxxxxxx\"... is not valid JSON",
            ),
            (
                "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,]",
                "Unexpected token ']', ...\",16,17,18,]\" is not valid JSON",
            ),
            ("undefined", "\"undefined\" is not valid JSON"),
            (
                "[1.]",
                "Unterminated fractional number in JSON at position 3 (line 1 column 4)",
            ),
            (
                "{\"a\":\"\\u12\"}",
                "Bad Unicode escape in JSON at position 10 (line 1 column 11)",
            ),
            ("{\"a\":", "Unexpected end of JSON input"),
            (
                "{",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            ("[\"x\\", "Unexpected end of JSON input"),
        ];
        for (text, expected) in cases {
            assert_eq!(json_parse_message(text), expected, "{text:?}");
        }
    }
}
