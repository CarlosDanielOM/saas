//! Owned JSON.parse/JSON.stringify values shared by Fish HTTP services.
//! Escaped lone UTF-16 units, binary64 numbers and object property order survive
//! parsing. Duplicate properties replace their value without moving their key.
use crate::utils::{js_string::JsString, json_number::number_string};

#[derive(Clone, Debug, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonValue>),
    Object(Vec<(JsString, JsonValue)>),
}

fn json_space(value: &str) -> &str {
    value.trim_start_matches([' ', '\t', '\n', '\r'])
}

fn prefix(value: &str) -> Result<(&str, usize), String> {
    let mut stream =
        serde_json::Deserializer::from_str(value).into_iter::<&serde_json::value::RawValue>();
    let raw = stream
        .next()
        .expect("validated container has a value")
        .map_err(|error| error.to_string())?;
    Ok((raw.get(), stream.byte_offset()))
}

fn json_string(raw: &str) -> JsString {
    // RawValue already checked escape syntax and disallowed control characters.
    let mut units = Vec::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            let mut buffer = [0; 2];
            units.extend_from_slice(ch.encode_utf16(&mut buffer));
            continue;
        }
        match chars.next().expect("validated escape") {
            'u' => {
                let unit = (0..4).fold(0, |unit, _| {
                    (unit << 4)
                        | chars
                            .next()
                            .expect("validated hex escape")
                            .to_digit(16)
                            .expect("validated hex digit") as u16
                });
                units.push(unit);
            }
            'b' => units.push(8),
            't' => units.push(9),
            'n' => units.push(10),
            'f' => units.push(12),
            'r' => units.push(13),
            ch => units.push(ch as u16),
        }
    }
    JsString::from_units(units)
}

pub fn parse_json(text: &str) -> Result<JsonValue, String> {
    parse_with_depth_error(text, "JSON nesting exceeds limit")
}

pub(super) fn parse_with_depth_error(text: &str, depth_error: &str) -> Result<JsonValue, String> {
    let raw: &serde_json::value::RawValue =
        serde_json::from_str(text).map_err(|error| format!("Invalid JSON response: {error}"))?;
    parse_validated(raw.get(), 0, depth_error)
}

fn parse_validated(raw: &str, depth: usize, depth_error: &str) -> Result<JsonValue, String> {
    // Bound recursive error formatting as well as its HTTP body allocation.
    if depth > 128 {
        return Err(depth_error.into());
    }
    Ok(match raw.as_bytes()[0] {
        b'n' => JsonValue::Null,
        b't' => JsonValue::Bool(true),
        b'f' => JsonValue::Bool(false),
        b'"' => JsonValue::String(json_string(raw)),
        b'[' => {
            let mut values = Vec::new();
            let mut rest = json_space(&raw[1..raw.len() - 1]);
            while !rest.is_empty() {
                let (value, offset) = prefix(rest)?;
                values.push(parse_validated(value, depth + 1, depth_error)?);
                rest = json_space(&rest[offset..]);
                if rest.starts_with(',') {
                    rest = json_space(&rest[1..]);
                }
            }
            JsonValue::Array(values)
        }
        b'{' => {
            let mut values: Vec<(JsString, JsonValue)> = Vec::new();
            let mut key_positions: std::collections::HashMap<JsString, usize> =
                std::collections::HashMap::new();
            let mut rest = json_space(&raw[1..raw.len() - 1]);
            while !rest.is_empty() {
                let (key, offset) = prefix(rest)?;
                let key = json_string(key);
                rest = json_space(&rest[offset..]);
                rest = json_space(&rest[1..]); // validated colon
                let (value, offset) = prefix(rest)?;
                let value = parse_validated(value, depth + 1, depth_error)?;
                if let Some(&index) = key_positions.get(&key) {
                    values[index].1 = value;
                } else {
                    key_positions.insert(key.clone(), values.len());
                    values.push((key, value));
                }
                rest = json_space(&rest[offset..]);
                if rest.starts_with(',') {
                    rest = json_space(&rest[1..]);
                }
            }
            JsonValue::Object(values)
        }
        _ => JsonValue::Number(raw.parse::<f64>().expect("validated JSON number")),
    })
}

fn array_index(key: &JsString) -> Option<u32> {
    let key = key.as_str()?;
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

impl JsonValue {
    pub fn pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    /// Compact, well-formed JSON.stringify output with ECMAScript key order.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_compact(&mut out);
        out
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields
                .iter()
                .rev()
                .find(|(name, _)| name.as_str() == Some(key))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    fn write_compact(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) => out.push_str(&if value.is_finite() {
                number_string(*value)
            } else {
                "null".into()
            }),
            Self::String(value) => out.push_str(&value.to_json_string()),
            Self::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write_compact(out);
                }
                out.push(']');
            }
            Self::Object(values) => {
                let mut entries: Vec<_> = values.iter().collect();
                entries.sort_by_key(|(key, _)| array_index(key).map_or((1, 0), |index| (0, index)));
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&key.to_json_string());
                    out.push(':');
                    value.write_compact(out);
                }
                out.push('}');
            }
        }
    }

    fn write(&self, out: &mut String, depth: usize) {
        let indent = |out: &mut String, depth| {
            out.push('\n');
            out.push_str(&"  ".repeat(depth));
        };
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) => {
                if value.is_finite() {
                    out.push_str(&number_string(*value));
                } else {
                    out.push_str("null");
                }
            }
            Self::String(value) => out.push_str(&value.to_json_string()),
            Self::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    indent(out, depth + 1);
                    value.write(out, depth + 1);
                }
                if !values.is_empty() {
                    indent(out, depth);
                }
                out.push(']');
            }
            Self::Object(values) => {
                let mut entries: Vec<_> = values.iter().collect();
                // JS own properties enumerate canonical array indices first,
                // then all other string keys in their original insertion order.
                entries.sort_by_key(|(key, _)| array_index(key).map_or((1, 0), |index| (0, index)));
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    indent(out, depth + 1);
                    out.push_str(&key.to_json_string());
                    out.push_str(": ");
                    value.write(out, depth + 1);
                }
                if !entries.is_empty() {
                    indent(out, depth);
                }
                out.push('}');
            }
        }
    }
}
