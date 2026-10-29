//! Borrowed, whole-input-validated JSON for selectively reading unbounded data.
//!
//! Unlike the deliberately bounded owned service reader, this document stores
//! only a flat span index. Validation, indexing, array coercion and destruction
//! do not recurse. Unknown descendants are neither decoded nor materialized.
//! Memory remains proportional to input tokens/depth; no resource-limit or
//! parity claim is made for JS engine stack exhaustion during String(array).
//!
//! serde_json 1.0.154 RawValue uses de.rs::ignore_value's iterative scratch
//! stack, ignore_integer and read.rs::ignore_str/ignore_escape. It validates
//! syntax (including ignored data and lone-surrogate escapes), without the
//! owned Value deserializer's recursion or finite-number restrictions.
use super::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    tts::settings::{self, SettingsError},
};

#[derive(Debug)]
struct Span {
    start: usize,
    end: usize,
    // Index immediately after this entire subtree, including object key tokens.
    next: usize,
}

/// Retains the caller's JSON bytes; dropping even a deeply nested document
/// drops one flat vector, never a recursively owned JSON value.
#[derive(Debug)]
pub struct JsonDocument<'a> {
    raw: &'a str,
    spans: Vec<Span>,
}

impl<'a> JsonDocument<'a> {
    pub fn parse(raw: &'a str) -> Result<Self, String> {
        // from_str also calls Deserializer::end: BOM and trailing data fail.
        // Do not replace with a prefix-only streaming parse.
        let validated: &serde_json::value::RawValue =
            serde_json::from_str(raw).map_err(|error| format!("Invalid JSON: {error}"))?;
        let raw = validated.get();
        let bytes = raw.as_bytes();
        let mut spans: Vec<Span> = Vec::new();
        let mut containers = Vec::new();
        let mut pos = 0;
        // This is an indexer over validated bytes, not a second JSON grammar.
        // Token delimiters inside strings are skipped with their escapes.
        while pos < bytes.len() {
            match bytes[pos] {
                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' => pos += 1,
                b'[' | b'{' => {
                    containers.push(spans.len());
                    spans.push(Span {
                        start: pos,
                        end: 0,
                        next: 0,
                    });
                    pos += 1;
                }
                b']' | b'}' => {
                    let index = containers.pop().expect("validated closing delimiter");
                    spans[index].end = pos + 1;
                    spans[index].next = spans.len();
                    pos += 1;
                }
                _ => {
                    let start = pos;
                    if bytes[pos] == b'"' {
                        pos += 1;
                        while bytes[pos] != b'"' {
                            if bytes[pos] == b'\\' {
                                pos += 1; // skip escaped quote/backslash (or escape tag)
                            }
                            pos += 1;
                        }
                        pos += 1;
                    } else {
                        while pos < bytes.len()
                            && !matches!(
                                bytes[pos],
                                b' ' | b'\t' | b'\n' | b'\r' | b',' | b':' | b']' | b'}'
                            )
                        {
                            pos += 1;
                        }
                    }
                    let next = spans.len() + 1;
                    spans.push(Span {
                        start,
                        end: pos,
                        next,
                    });
                }
            }
        }
        Ok(Self { raw, spans })
    }

    pub fn root(&self) -> JsonView<'_> {
        JsonView {
            raw: self.raw,
            spans: &self.spans,
            index: 0,
        }
    }
}

/// Copyable handle whose bytes and span index are borrowed from a document.
#[derive(Clone, Copy, Debug)]
pub struct JsonView<'a> {
    raw: &'a str,
    spans: &'a [Span],
    index: usize,
}

impl<'a> JsonView<'a> {
    pub fn raw(self) -> &'a str {
        let span = &self.spans[self.index];
        &self.raw[span.start..span.end]
    }

    fn tag(self) -> u8 {
        self.raw.as_bytes()[self.spans[self.index].start]
    }

    /// Decode only a leaf with the existing binary64/UTF-16 policy. Validated
    /// unescaped strings can copy their UTF-8 directly; escaped strings retain
    /// the existing decoder. Containers have no owned-tree conversion here.
    pub fn scalar(self) -> Option<JsonValue> {
        if matches!(self.tag(), b'[' | b'{') {
            None
        } else if self.tag() == b'"'
            && let Some(value) = self.unescaped_string()
        {
            Some(JsonValue::String(JsString::from(value)))
        } else {
            Some(parse_json(self.raw()).expect("validated scalar token"))
        }
    }

    pub fn as_string(self) -> Option<JsString> {
        if self.tag() != b'"' {
            return None;
        }
        match self.scalar() {
            Some(JsonValue::String(value)) => Some(value),
            _ => unreachable!("validated string token"),
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self.tag() {
            b't' => Some(true),
            b'f' => Some(false),
            _ => None,
        }
    }

    pub fn is_null(self) -> bool {
        self.tag() == b'n'
    }

    /// Own, last-key-wins lookup with exact UTF-16 name equality. Unescaped
    /// names compare borrowed UTF-8; escaped names use the existing decoder.
    /// JSON's __proto__ is an ordinary own field, never a prototype mutation.
    /// Non-objects yield missing for this plain-own-property API.
    pub fn get(self, key: &str) -> Option<Self> {
        self.find_key(|name| match name.unescaped_string() {
            Some(name) => name == key,
            None => name.as_string().expect("validated object key").as_str() == Some(key),
        })
    }

    pub fn get_key(self, key: &JsString) -> Option<Self> {
        if let Some(key) = key.as_str() {
            return self.get(key);
        }
        self.find_key(|name| {
            // Unescaped input is valid UTF-8 and cannot contain an unpaired
            // UTF-16 unit. Escaped input still uses the established decoder.
            name.unescaped_string().is_none()
                && name.as_string().expect("validated object key") == *key
        })
    }

    /// Called only for validated string tokens, including object keys. Without
    /// escapes, removing the ASCII quotes leaves the exact UTF-8 text at valid
    /// byte boundaries. Escaped UTF-16 text stays on the existing decoder path.
    fn unescaped_string(self) -> Option<&'a str> {
        debug_assert_eq!(self.tag(), b'"');
        let raw = self.raw();
        let body = &raw[1..raw.len() - 1];
        (!body.as_bytes().contains(&b'\\')).then_some(body)
    }

    fn find_key(self, mut matches: impl FnMut(Self) -> bool) -> Option<Self> {
        if self.tag() != b'{' {
            return None;
        }
        let mut index = self.index + 1;
        let end = self.spans[self.index].next;
        let mut found = None;
        while index < end {
            let name = Self { index, ..self };
            let value = Self {
                index: index + 1,
                ..self
            };
            if matches(name) {
                found = Some(value);
            }
            index = self.spans[value.index].next;
        }
        found
    }

    pub fn array(self) -> Option<ArrayIter<'a>> {
        (self.tag() == b'[').then(|| ArrayIter {
            view: self,
            next: self.index + 1,
            end: self.spans[self.index].next,
        })
    }

    pub fn truthy(self) -> bool {
        if self.tag() == b'"' {
            // Only the validated token "" is empty. Every valid escape emits
            // at least one UTF-16 unit, including NUL and lone surrogates.
            return self.raw().len() != 2;
        }
        // Both container kinds are truthy BEFORE String/Number conversion.
        settings::truthy(
            &self
                .scalar()
                .unwrap_or_else(|| JsonValue::Object(Vec::new())),
        )
    }

    fn shallow_coercion_value(self) -> JsonValue {
        self.scalar().unwrap_or_else(|| {
            // Plain JSON cannot supply callables or custom prototypes. Only
            // presence of own toString matters to the existing object policy;
            // neither its value nor any other descendant needs materializing.
            debug_assert_eq!(self.tag(), b'{');
            JsonValue::Object(if self.get("toString").is_some() {
                vec![(JsString::from("toString"), JsonValue::Null)]
            } else {
                Vec::new()
            })
        })
    }

    fn non_array_string(self) -> Result<JsString, SettingsError> {
        debug_assert_ne!(self.tag(), b'[');
        if let Some(value) = self.as_string() {
            // String(string) is identity. Return this owned decode directly
            // instead of cloning it again through the settings helper.
            Ok(value)
        } else {
            settings::js_string(&self.shallow_coercion_value())
        }
    }

    /// JSON-data String(value), using a heap stack for nested Array.join.
    /// Each separator belongs to its own array; null elements contribute empty
    /// text, nested empty arrays retain their parent's separators. Primitive
    /// strings retain identity; other scalar and ordinary object
    /// conversions delegate to the established settings policy.
    pub fn js_string(self) -> Result<JsString, SettingsError> {
        let Some(elements) = self.array() else {
            return self.non_array_string();
        };
        let mut stack = vec![(elements, true)];
        let mut units = Vec::new();
        while let Some((elements, first)) = stack.last_mut() {
            if let Some(value) = elements.next() {
                if !*first {
                    units.push(u16::from(b','));
                }
                *first = false;
                if let Some(nested) = value.array() {
                    stack.push((nested, true));
                } else if !value.is_null() {
                    units.extend(value.non_array_string()?.code_units());
                }
            } else {
                stack.pop();
            }
        }
        Ok(JsString::from_units(units))
    }
}

pub struct ArrayIter<'a> {
    view: JsonView<'a>,
    next: usize,
    end: usize,
}

impl<'a> Iterator for ArrayIter<'a> {
    type Item = JsonView<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.end {
            return None;
        }
        let value = JsonView {
            index: self.next,
            ..self.view
        };
        self.next = value.spans[value.index].next;
        Some(value)
    }
}

/// Missing is Number(undefined), distinct from present null. Array conversion
/// uses the iterative join, then reuses the existing whitespace/radix/rounding
/// and nonfinite policies by feeding only the resulting scalar to settings.
pub fn js_number(value: Option<JsonView<'_>>) -> Result<f64, SettingsError> {
    match value {
        None => settings::js_number(None),
        Some(value) if value.tag() == b'[' => {
            settings::js_number(Some(&JsonValue::String(value.js_string()?)))
        }
        Some(value) => settings::js_number(Some(&value.shallow_coercion_value())),
    }
}

#[cfg(test)]
mod tests {
    use super::{JsonDocument, JsonValue, js_number, parse_json, settings};

    #[test]
    fn leaf_and_join_observations_match_existing_owned_settings_policy() {
        for raw in [
            r#""""#,
            r#""ascii""#,
            r#""a\u0073cii""#,
            r#""é😀é""#,
            r#""\u00e9\ud83d\ude00e\u0301""#,
            r#"" \t\n\r""#,
            r#""\u0000""#,
            r#""\"\\\/\b\f\n\r\t""#,
            r#""\ud800""#,
            r#""\udc00\ud800""#,
            r#""\ud800\ud83d\ude00\udc00""#,
            r#""\ufeff0x20000000000003\u3000""#,
            r#""-0""#,
            "null",
            "false",
            "true",
            "0",
            "-0",
            "1e-4000",
            "-1e-4000",
            "5e-324",
            "1e9999",
            "-1e9999",
            "[]",
            "[null,[]]",
            r#"["",["a",null],"\ud800","😀"]"#,
            r#"[[" -0 "]]"#,
            r#"["ok",{"toString":null},"\ud800"]"#,
            "{}",
            r#"{"toString":null}"#,
            r#"{"to\u0053tring":0,"toString":false}"#,
            r#"{"__proto__":{"toString":null},"valueOf":""}"#,
        ] {
            let owned = parse_json(raw).unwrap();
            let doc = JsonDocument::parse(raw).unwrap();
            let view = doc.root();
            assert_eq!(view.truthy(), settings::truthy(&owned), "{raw}");
            assert_eq!(view.js_string(), settings::js_string(&owned), "{raw}");
            match (js_number(Some(view)), settings::js_number(Some(&owned))) {
                (Ok(actual), Ok(expected)) if expected.is_nan() => assert!(actual.is_nan()),
                (Ok(actual), Ok(expected)) => {
                    assert_eq!(actual.to_bits(), expected.to_bits(), "{raw}")
                }
                (Err(actual), Err(expected)) => assert_eq!(actual, expected, "{raw}"),
                values => panic!("number policy mismatch {raw}: {values:?}"),
            }
            if !matches!(owned, JsonValue::Array(_) | JsonValue::Object(_)) {
                assert_eq!(view.scalar(), Some(owned), "{raw}");
            }
        }
        assert!(js_number(None).unwrap().is_nan());
        assert!(settings::js_number(None).unwrap().is_nan());
    }

    #[test]
    fn deep_singleton_arrays_match_the_existing_shallow_owned_join_policy() {
        for leaf in [
            r#""""#,
            r#"" -0 ""#,
            r#""\ud800😀\udc00""#,
            r#""\ufeff0x20000000000003\u3000""#,
            "null",
            "false",
            "-0",
            "1e9999",
            r#"[null,[],"",["a",null],"\u0000","😀"]"#,
            "{}",
            r#"{"toString":null}"#,
        ] {
            // Wrapping a value in more singleton arrays preserves the first
            // array's join result, including its null-to-empty treatment.
            let owned = parse_json(&format!("[{leaf}]")).unwrap();
            for depth in [128, 256] {
                let raw = format!("{}{leaf}{}", "[".repeat(depth), "]".repeat(depth));
                let doc = JsonDocument::parse(&raw).unwrap();
                let view = doc.root();
                assert!(view.truthy());
                assert_eq!(
                    view.js_string(),
                    settings::js_string(&owned),
                    "{depth} {leaf}"
                );
                match (js_number(Some(view)), settings::js_number(Some(&owned))) {
                    (Ok(actual), Ok(expected)) if expected.is_nan() => assert!(actual.is_nan()),
                    (Ok(actual), Ok(expected)) => {
                        assert_eq!(actual.to_bits(), expected.to_bits(), "{depth} {leaf}")
                    }
                    (Err(actual), Err(expected)) => assert_eq!(actual, expected, "{depth} {leaf}"),
                    values => panic!("deep number policy mismatch {depth} {leaf}: {values:?}"),
                }
            }
        }
    }
}
