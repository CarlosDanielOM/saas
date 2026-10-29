//! The installed fish-audio 0.1.0 HTTP subset, without its unused WebSocket API.
use super::super::lossless_json::{JsonValue as ErrorJson, parse_with_depth_error};
use crate::utils::{js_compat, js_string::JsString, tts::reinforce_fish_tts_tags_js};

fn parse_json(text: &str) -> Result<ErrorJson, String> {
    parse_with_depth_error(text, "Fish Audio error JSON nesting exceeds limit")
}

pub(super) fn reinforce_js(text: &JsString) -> JsString {
    reinforce_fish_tts_tags_js(text)
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
    fn reinforcement_reuses_lossless_cue_groups_before_encoding() {
        let text = JsString::from_units(
            "[happy]\u{a0}[happy]😀"
                .encode_utf16()
                .chain([0xd800])
                .chain("[pause]".encode_utf16())
                .collect(),
        );
        let expected = JsString::from_units(
            "[happy]\u{a0}[happy]😀"
                .encode_utf16()
                .chain([0xd800])
                .chain("[pause] [pause]".encode_utf16())
                .collect(),
        );
        assert_eq!(reinforce_js(&text), expected);
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
