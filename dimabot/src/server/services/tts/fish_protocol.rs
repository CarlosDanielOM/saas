//! The installed fish-audio 0.1.0 HTTP subset, without its unused WebSocket API.
use crate::utils::{
    js_compat, js_string::JsString, json_number::number_string, tts::reinforce_fish_tts_tags,
};

pub(super) fn reinforce_js(text: &JsString) -> JsString {
    if let Some(text) = text.as_str() {
        return JsString::from(reinforce_fish_tts_tags(text));
    }
    // A lone surrogate is neither an ASCII cue character nor JS whitespace, so
    // no match can span it. Preserve it while reusing the existing cue helper.
    let mut output = Vec::new();
    let mut chunk = Vec::new();
    let mut units = text.code_units().peekable();
    while let Some(unit) = units.next() {
        if (0xd800..=0xdbff).contains(&unit)
            && units.peek().is_some_and(|u| (0xdc00..=0xdfff).contains(u))
        {
            chunk.push(unit);
            chunk.push(units.next().expect("peeked low surrogate"));
        } else if (0xd800..=0xdfff).contains(&unit) {
            output
                .extend(reinforce_fish_tts_tags(&String::from_utf16_lossy(&chunk)).encode_utf16());
            chunk.clear();
            output.push(unit);
        } else {
            chunk.push(unit);
        }
    }
    output.extend(reinforce_fish_tts_tags(&String::from_utf16_lossy(&chunk)).encode_utf16());
    JsString::from_units(output)
}

/// Encode the direct SDK's request, before any provider-specific cue expansion.
///
/// Keys retain the source insertion order. Both string values use the exact
/// @msgpack/msgpack short-string versus TextEncoder boundary (UTF-16 length 50).
#[doc(hidden)]
pub fn encode_fish_msgpack(text: &JsString, reference: &JsString) -> Vec<u8> {
    fn string(out: &mut Vec<u8>, bytes: &[u8]) {
        let len = bytes.len();
        if len < 32 {
            out.push(0xa0 | len as u8);
        } else if len <= 255 {
            out.extend_from_slice(&[0xd9, len as u8]);
        } else if len <= 65535 {
            out.push(0xda);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            out.push(0xdb);
            out.extend_from_slice(
                &u32::try_from(len)
                    .expect("MessagePack string length exceeds u32")
                    .to_be_bytes(),
            );
        }
        out.extend_from_slice(bytes);
    }
    fn js_string(out: &mut Vec<u8>, value: &JsString) {
        if let Some(value) = value.as_str() {
            string(out, value.as_bytes());
            return;
        }
        if value.len() > 50 {
            string(out, value.to_utf8_lossy().as_bytes());
            return;
        }
        // utf8Count and utf8EncodeJs preserve lone UTF-16 code units as their
        // three-byte encoding. The TextEncoder branch above replaces them.
        let mut bytes = Vec::new();
        for decoded in char::decode_utf16(value.code_units()) {
            match decoded {
                Ok(ch) => {
                    let mut buf = [0; 4];
                    bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                Err(error) => {
                    let unit = error.unpaired_surrogate();
                    bytes.extend_from_slice(&[
                        (0xe0 | (unit >> 12)) as u8,
                        (0x80 | ((unit >> 6) & 0x3f)) as u8,
                        (0x80 | (unit & 0x3f)) as u8,
                    ]);
                }
            }
        }
        string(out, &bytes);
    }
    let mut out = vec![0x83];
    string(&mut out, b"text");
    js_string(&mut out, text);
    string(&mut out, b"reference_id");
    js_string(&mut out, reference);
    string(&mut out, b"format");
    string(&mut out, b"mp3");
    out
}

/// JavaScript parseInt(value, 10) is a binary64 number, not an i64. In
/// particular enormous positive digit prefixes become +Infinity and still
/// select the capped server-specified delay rather than exponential fallback.
fn parse_int(value: &str) -> Option<f64> {
    let value = value.trim_start_matches(js_compat::is_whitespace);
    let digits = value.strip_prefix(['-', '+']).unwrap_or(value);
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let end = value.len() - digits.len() + end;
    value[..end].parse::<f64>().ok()
}

pub(super) fn retry_delay_millis(
    retry_after: Option<&str>,
    reset: Option<&str>,
    retry: u32,
    now: f64,
    random: f64,
) -> u64 {
    if let Some(value) = retry_after.filter(|value| !value.is_empty()) {
        if let Some(seconds) = parse_int(value).filter(|value| *value > 0.0) {
            return (seconds * 1000.0).min(60000.0) as u64;
        }
        if let Some(date) = crate::utils::js_date::parse_date(value) {
            let delay = date as f64 - now;
            if delay > 0.0 {
                return delay.min(60000.0) as u64;
            }
        }
    }
    if let Some(reset) = reset.filter(|value| !value.is_empty()).and_then(parse_int) {
        let delay = reset * 1000.0 - now;
        if delay > 0.0 {
            return (delay.min(60000.0) * (1.0 + random * 0.2)) as u64;
        }
    }
    ((1000.0 * 2.0_f64.powf(f64::from(retry))).min(60000.0) * (1.0 + (random - 0.5) * 0.2)) as u64
}

/// JSON.parse/JSON.stringify behavior needed solely for SDK error messages.
/// RawValue validates JSON syntax without rejecting escaped lone surrogates;
/// this small walker preserves string code units and object insertion order.
enum ErrorJson {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<ErrorJson>),
    Object(Vec<(JsString, ErrorJson)>),
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

fn parse_json(text: &str) -> Result<ErrorJson, String> {
    let raw: &serde_json::value::RawValue =
        serde_json::from_str(text).map_err(|error| format!("Invalid JSON response: {error}"))?;
    parse_validated(raw.get(), 0)
}

fn parse_validated(raw: &str, depth: usize) -> Result<ErrorJson, String> {
    // Bound recursive error formatting as well as its HTTP body allocation.
    if depth > 128 {
        return Err("Fish Audio error JSON nesting exceeds limit".into());
    }
    Ok(match raw.as_bytes()[0] {
        b'n' => ErrorJson::Null,
        b't' => ErrorJson::Bool(true),
        b'f' => ErrorJson::Bool(false),
        b'"' => ErrorJson::String(json_string(raw)),
        b'[' => {
            let mut values = Vec::new();
            let mut rest = json_space(&raw[1..raw.len() - 1]);
            while !rest.is_empty() {
                let (value, offset) = prefix(rest)?;
                values.push(parse_validated(value, depth + 1)?);
                rest = json_space(&rest[offset..]);
                if rest.starts_with(',') {
                    rest = json_space(&rest[1..]);
                }
            }
            ErrorJson::Array(values)
        }
        b'{' => {
            let mut values: Vec<(JsString, ErrorJson)> = Vec::new();
            let mut key_positions: std::collections::HashMap<JsString, usize> =
                std::collections::HashMap::new();
            let mut rest = json_space(&raw[1..raw.len() - 1]);
            while !rest.is_empty() {
                let (key, offset) = prefix(rest)?;
                let key = json_string(key);
                rest = json_space(&rest[offset..]);
                rest = json_space(&rest[1..]); // validated colon
                let (value, offset) = prefix(rest)?;
                let value = parse_validated(value, depth + 1)?;
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
            ErrorJson::Object(values)
        }
        _ => ErrorJson::Number(raw.parse::<f64>().expect("validated JSON number")),
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

impl ErrorJson {
    fn pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
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

pub(super) fn fish_error_message(status: u16, content_type: Option<&str>, bytes: &[u8]) -> String {
    // Fetch's UTF-8 text decoder replaces malformed bytes and consumes a BOM.
    let decoded = String::from_utf8_lossy(bytes);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    let content_type = content_type.map(str::to_ascii_lowercase);
    let missing_type = content_type.as_ref().is_none_or(String::is_empty);
    let kind = content_type.as_deref().unwrap_or("");
    // The SDK trims only when stripping parameters, not the bare header value.
    let kind = kind
        .split_once(';')
        .map_or(kind, |(kind, _)| js_compat::trim(kind));
    let json_type = matches!(
        kind,
        "application/hal+json"
            | "application/json"
            | "application/ld+json"
            | "application/problem+json"
            | "application/vnd.api+json"
            | "text/json"
    ) || (kind.starts_with("application/vnd.") && kind.ends_with("+json"));
    let body = if missing_type || json_type {
        if text.is_empty() {
            None
        } else {
            match parse_json(text) {
                Ok(ErrorJson::Null) => None,
                Ok(value) => Some(value),
                Err(_) if missing_type => {
                    // getResponseBody returns this object on invalid untyped
                    // JSON; getErrorResponseBody then nests it as the body.
                    Some(ErrorJson::Object(vec![
                        ("ok".into(), ErrorJson::Bool(false)),
                        (
                            "error".into(),
                            ErrorJson::Object(vec![
                                ("reason".into(), ErrorJson::String("non-json".into())),
                                ("statusCode".into(), ErrorJson::Number(f64::from(status))),
                                ("rawBody".into(), ErrorJson::String(text.into())),
                            ]),
                        ),
                    ]))
                }
                Err(error) => return error,
            }
        }
    } else {
        Some(ErrorJson::String(text.into()))
    };
    let mut result = if status == 422 {
        format!("UnprocessableEntityError\nStatus code: {status}")
    } else {
        format!("Status code: {status}")
    };
    if let Some(body) = body {
        result.push_str("\nBody: ");
        result.push_str(&body.pretty());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_and_long_lone_surrogates_and_map_order() {
        for (units, expected) in [
            (vec![0xd800], vec![0xed, 0xa0, 0x80]),
            (vec![0xdc00], vec![0xed, 0xb0, 0x80]),
            (vec![0xd800, 0xdc00], vec![0xf0, 0x90, 0x80, 0x80]),
        ] {
            let payload = encode_fish_msgpack(&JsString::from_units(units), &"id".into());
            assert_eq!(&payload[7..7 + expected.len()], &expected);
        }
        for length in [50, 51] {
            let mut units = vec![b'x' as u16; length - 1];
            units.push(0xd800);
            let payload = encode_fish_msgpack(&JsString::from_units(units), &"id".into());
            let expected = if length == 50 {
                [0xed, 0xa0, 0x80]
            } else {
                [0xef, 0xbf, 0xbd]
            };
            assert!(payload.windows(3).any(|bytes| bytes == expected));
        }
        assert_eq!(
            encode_fish_msgpack(&"".into(), &"".into()),
            b"\x83\xa4text\xa0\xacreference_id\xa0\xa6format\xa3mp3"
        );
        assert_eq!(
            reinforce_js(&JsString::from_units(vec![
                91, 104, 97, 112, 112, 121, 93, 0xd800
            ]))
            .to_json_string(),
            "\"[happy] [happy]\\ud800\""
        );
    }

    #[test]
    fn genuine_backoff_headers_and_jitter_bounds() {
        let now = 1_700_000_000_000.0;
        assert_eq!(
            retry_delay_millis(Some("  +2.5seconds"), None, 0, now, 0.5),
            2000
        );
        assert_eq!(
            retry_delay_millis(
                Some("99999999999999999999999999999999999999999999999999999999"),
                None,
                0,
                now,
                0.5
            ),
            60000
        );
        assert_eq!(
            retry_delay_millis(Some(&"9".repeat(400)), None, 0, now, 0.5),
            60000
        );
        assert_eq!(retry_delay_millis(Some("0x10"), None, 1, now, 0.5), 2000);
        assert_eq!(
            retry_delay_millis(None, Some("1700000001"), 0, now, 0.5),
            1100
        );
        assert_eq!(
            retry_delay_millis(None, Some(&"9".repeat(400)), 0, now, 0.5),
            66000
        );
        assert_eq!(retry_delay_millis(None, None, 0, now, 0.0), 900);
        assert_eq!(retry_delay_millis(None, None, 1, now, 0.999999), 2199);
        assert_eq!(
            retry_delay_millis(Some("Tue, 14 Nov 2023 22:13:22 GMT"), None, 0, now, 0.5),
            2000
        );
    }

    #[test]
    fn sdk_error_body_rules_and_json_property_order() {
        assert_eq!(
            fish_error_message(
                422,
                Some("application/json"),
                br#"{"z":1,"2":2,"a":"\ud800","1":3,"z":4,"n":1e400}"#
            ),
            "UnprocessableEntityError\nStatus code: 422\nBody: {\n  \"1\": 3,\n  \"2\": 2,\n  \"z\": 4,\n  \"a\": \"\\ud800\",\n  \"n\": null\n}"
        );
        assert_eq!(
            fish_error_message(400, Some("application/json"), b"null"),
            "Status code: 400"
        );
        assert_eq!(
            fish_error_message(400, Some("text/plain"), b""),
            "Status code: 400\nBody: \"\""
        );
        assert_eq!(
            fish_error_message(400, Some("application/json"), b""),
            "Status code: 400"
        );
        assert_eq!(fish_error_message(400, None, b""), "Status code: 400");
        assert!(fish_error_message(400, None, b"broken").contains("\"reason\": \"non-json\""));
        assert!(
            fish_error_message(400, Some("application/json"), b"broken")
                .starts_with("Invalid JSON response: ")
        );
        assert_eq!(
            fish_error_message(
                400,
                Some("APPLICATION/VND.TEST+JSON; charset=UTF-8"),
                b"\xef\xbb\xbftrue"
            ),
            "Status code: 400\nBody: true"
        );
        assert_eq!(
            parse_json("[-0,0.0000001,1000000000000000000000]")
                .unwrap()
                .pretty(),
            "[\n  0,\n  1e-7,\n  1e+21\n]"
        );
    }
}
