//! Property tests over seeded random inputs (no external crate: a SplitMix64 stream, so every
//! run checks the same cases and a failure names the seed that produced it).

use dima_text::*;
use serde_json::{Map, Value};

/// SplitMix64: small, fast and good enough to spread inputs over every class.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    /// A scalar value from a random class: ASCII, two-, three- and four-byte UTF-8, the edges.
    fn char(&mut self) -> char {
        let code = match self.below(6) {
            0 => self.below(0x80) as u32,
            1 => 0x80 + self.below(0x780) as u32,
            2 => 0x800 + self.below(0xd000) as u32,
            3 => 0xe000 + self.below(0x2000) as u32,
            4 => 0x1_0000 + self.below(0x10_0000) as u32,
            _ => *self.pick(&[
                0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x1_0000, 0x10_ffff,
            ]),
        };
        char::from_u32(code).unwrap_or('\u{fffd}')
    }

    fn string(&mut self, max: usize) -> String {
        let length = self.below(max + 1);
        (0..length).map(|_| self.char()).collect()
    }

    /// Text made of URI-ish pieces: escapes (good and broken), reserved characters, letters.
    fn uri_soup(&mut self, max: usize) -> String {
        const PIECES: &[&str] = &[
            "%",
            "%2",
            "%2F",
            "%2f",
            "%41",
            "%C3",
            "%A9",
            "%C3%A9",
            "%E2%82%AC",
            "%F0%9F%98%80",
            "%ED%A0%80",
            "%C0%80",
            "%FF",
            "%zz",
            "a",
            "Z",
            "0",
            " ",
            "+",
            "/",
            "?",
            "#",
            "é",
            "😀",
            "%25",
            "%%",
        ];
        let length = self.below(max + 1);
        (0..length).map(|_| *self.pick(PIECES)).collect()
    }
}

impl Rng {
    /// A finite double from a random class (small integers, fractions, any bit pattern).
    fn double(&mut self) -> f64 {
        match self.below(4) {
            0 => self.below(2000) as f64 - 1000.0,
            1 => (self.below(1 << 30) as f64) / 1000.0,
            2 => *self.pick(&[
                0.1,
                1e21,
                1e-7,
                5e-324,
                f64::MAX,
                9_007_199_254_740_993.0,
                2e53,
            ]),
            _ => {
                let double = f64::from_bits(self.next());
                if double.is_finite() { double } else { 0.5 }
            }
        }
    }

    /// A key, often an array index or a near miss, so ordering and duplicates get exercised.
    fn key(&mut self) -> String {
        match self.below(4) {
            0 => self.below(20).to_string(),
            1 => (*self.pick(&["01", "-1", "4294967294", "4294967295", "1.5", "", "a", "b"]))
                .to_owned(),
            _ => self.string(6),
        }
    }

    /// A value JavaScript round-trips through `JSON.stringify` and `JSON.parse`: numbers as
    /// `JSON.parse` stores them (no `-0`), keys in JavaScript's order.
    fn json(&mut self, depth: usize) -> Value {
        let kinds = if depth >= 5 { 4 } else { 7 };
        match self.below(kinds) {
            0 => Value::Null,
            1 => Value::Bool(self.below(2) == 0),
            2 => {
                let double = self.double();
                js_number_value(if double == 0.0 { 0.0 } else { double })
            }
            3 => Value::String(self.string(8)),
            4 => Value::Array((0..self.below(5)).map(|_| self.json(depth + 1)).collect()),
            _ => {
                let mut map = Map::new();
                for _ in 0..self.below(6) {
                    let key = self.key();
                    let value = self.json(depth + 1);
                    map.insert(key, value);
                }
                let mut value = Value::Object(map);
                js_key_order(&mut value);
                value
            }
        }
    }
}

const LIMITS: JsonLimits = JsonLimits {
    max_depth: 64,
    max_bytes: 1 << 20,
};

#[test]
fn json_parse_reads_back_what_every_writer_wrote() {
    let mut rng = Rng(0x0005_1a7e);
    let indents = [
        JsonIndent::Number(2.0),
        JsonIndent::Number(0.5),
        JsonIndent::Text("\t"),
        JsonIndent::Text(" \r\n"),
    ];
    for case in 0..CASES / 4 {
        let value = rng.json(0);
        let compact = to_js_json(&value);
        let indent = *rng.pick(&indents);
        let one_pass = to_js_json_from(&value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        let written = [
            Some(compact.clone()),
            Some(to_js_json_pretty(&value, indent)),
            one_pass,
        ];
        for text in written {
            let text = text.unwrap_or_default();
            let parsed = parse_js_json(&text, LIMITS);
            // `Map` equality ignores order, so the order is checked through the compact text.
            assert_eq!(parsed.as_ref(), Ok(&value), "case {case}: {text}");
            assert_eq!(
                parsed.map(|parsed| to_js_json(&parsed)).as_deref(),
                Ok(compact.as_str())
            );
        }
    }
}

#[test]
fn json_parse_never_panics_on_damaged_text() {
    const PIECES: &[&str] = &[
        "{", "}", "[", "]", ",", ":", "\"", "\\", "\\u", "\\ud800", "\\udc00", "0", "-", "1e",
        "e400", ".", "true", "nul", " ", "\n", "\u{1}", "é", "😀", "\"a\"", "1.5", "-0",
    ];
    let mut rng = Rng(0xbad_7e47);
    for case in 0..CASES {
        let text: String = if case % 2 == 0 {
            (0..rng.below(16)).map(|_| *rng.pick(PIECES)).collect()
        } else {
            // A valid document with one character removed or inserted.
            let mut chars: Vec<char> = to_js_json(&rng.json(0)).chars().collect();
            let at = rng.below(chars.len() + 1);
            if rng.below(2) == 0 && at < chars.len() {
                chars.remove(at);
            } else {
                let inserted = rng.char();
                chars.insert(at.min(chars.len()), inserted);
            }
            chars.into_iter().collect()
        };
        match parse_js_json(&text, LIMITS) {
            Ok(value) => {
                // Written and read again, it writes the same (`-0` is written as `0`, as in
                // JavaScript, so the values themselves may differ there).
                let written = to_js_json(&value);
                let again = parse_js_json(&written, LIMITS).map(|value| to_js_json(&value));
                assert_eq!(again.as_deref(), Ok(written.as_str()), "{text:?}");
            }
            Err(JsonParseError::Syntax { offset, found }) => {
                assert!(offset <= text.len(), "{text:?}");
                assert_eq!(
                    found,
                    text.get(offset..).and_then(|rest| rest.chars().next())
                );
            }
            Err(JsonParseError::NumberOutOfRange { offset }) => {
                assert!(matches!(
                    text.as_bytes().get(offset),
                    Some(b'-' | b'0'..=b'9')
                ));
            }
            Err(error) => panic!("{text:?}: {error:?}"),
        }
    }
}

#[test]
fn json_parse_limits_hold() {
    let mut rng = Rng(0x0001_1417);
    for _ in 0..2_000 {
        let depth = rng.below(80);
        let max_depth = rng.below(80);
        let open = if rng.below(2) == 0 { "[" } else { "{\"k\":[" };
        let close = if open == "[" { "]" } else { "]}" };
        let text = format!("{}0{}", open.repeat(depth), close.repeat(depth));
        let nesting = if open == "[" { depth } else { 2 * depth };
        let limits = JsonLimits {
            max_depth,
            max_bytes: 1 << 20,
        };
        let result = parse_js_json(&text, limits);
        assert_eq!(
            result.is_ok(),
            nesting <= max_depth,
            "{text} under {max_depth}"
        );
        if nesting > max_depth {
            assert!(matches!(result, Err(JsonParseError::TooDeep { .. })));
        }
        let limits = JsonLimits {
            max_depth: 1_000,
            max_bytes: rng.below(2 * text.len() + 1),
        };
        let result = parse_js_json(&text, limits);
        assert_eq!(
            matches!(result, Err(JsonParseError::TooLarge)),
            text.len() > limits.max_bytes
        );
    }
    // Far deeper than a recursive parser's call stack would allow: the explicit stack handles it.
    // (`serde_json::Value` drops recursively, so the result is taken apart by hand here; callers
    // keep `max_depth` to a few thousand at most.)
    let deep = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
    let limits = JsonLimits {
        max_depth: 200_000,
        max_bytes: deep.len(),
    };
    let mut value = parse_js_json(&deep, limits).unwrap_or_default();
    let mut levels = 0;
    while let Value::Array(mut items) = value {
        levels += 1;
        value = items.pop().unwrap_or_default();
    }
    assert_eq!(levels, 200_000);
}

const CASES: u64 = 20_000;

#[test]
fn uri_encoding_round_trips_every_string() {
    let mut rng = Rng(0x0e1c_0de5);
    for case in 0..CASES {
        let text = rng.string(24);
        let component = encode_uri_component(&text);
        assert_eq!(
            decode_uri_component(&component).as_deref(),
            Ok(text.as_str()),
            "case {case}"
        );
        let uri = encode_uri(&text);
        assert_eq!(
            decode_uri(&uri).as_deref(),
            Ok(text.as_str()),
            "case {case}"
        );
        // Only ASCII comes out of the encoders.
        assert!(component.is_ascii() && uri.is_ascii(), "case {case}");
    }
}

#[test]
fn uri_decoding_never_panics_and_errors_point_at_a_percent() {
    let mut rng = Rng(0xdec0_de00);
    for case in 0..CASES {
        let text = if case % 2 == 0 {
            rng.uri_soup(12)
        } else {
            rng.string(12)
        };
        for result in [decode_uri_component(&text), decode_uri(&text)] {
            if let Err(error) = result {
                assert_eq!(text.as_bytes().get(error.offset), Some(&b'%'), "{text:?}");
            }
        }
        // Both fail on exactly the same inputs; decodeURI only keeps some escapes as written.
        let (uri, component) = (decode_uri(&text), decode_uri_component(&text));
        assert_eq!(uri.is_ok(), component.is_ok(), "{text:?}");
        if let (Ok(uri), Ok(component)) = (uri, component) {
            assert!(uri.len() >= component.len(), "{text:?}");
        }
    }
}
