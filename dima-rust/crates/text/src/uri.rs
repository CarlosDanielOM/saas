//! `encodeURIComponent`, `encodeURI`, `decodeURIComponent` and `decodeURI`.
//!
//! The ECMAScript `Encode` and `Decode` operations on UTF-8 text. JavaScript encodes the UTF-8 of
//! each code point, so working on the bytes gives the same text; the only input JavaScript
//! encodes differently, a lone surrogate (where it throws), cannot occur in a Rust string.

use std::borrow::Cow;
use std::fmt;

/// `URIError: URI malformed`: a `%` not followed by two hex digits, or escapes that do not spell
/// one well-formed UTF-8 sequence (truncated, overlong, a surrogate or beyond U+10FFFF).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct UriError {
    /// Byte offset of the `%` that starts the malformed escape.
    pub offset: usize,
}

impl fmt::Display for UriError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // V8's message.
        formatter.write_str("URI malformed")
    }
}

impl std::error::Error for UriError {}

/// ASCII characters `encodeURIComponent` leaves alone: letters, digits and `-_.!~*'()`.
fn component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte)
}

/// ASCII characters `encodeURI` leaves alone: those of [`component_unescaped`] plus the reserved
/// set `;/?:@&=+$,` and `#`.
fn uri_unescaped(byte: u8) -> bool {
    component_unescaped(byte) || b";/?:@&=+$,#".contains(&byte)
}

/// What `decodeURI` keeps escaped: the reserved set and `#`.
const URI_RESERVED: &[u8] = b";/?:@&=+$,#";

/// `encodeURIComponent(text)`: every byte except ASCII letters, digits and `-_.!~*'()` as `%XX`
/// (upper-case hex). Borrows when nothing needs escaping.
pub fn encode_uri_component(text: &str) -> Cow<'_, str> {
    encode(text, component_unescaped)
}

/// `encodeURI(text)`: as [`encode_uri_component`], but the reserved characters `;/?:@&=+$,` and
/// `#` stay as they are. `%` is always escaped, so an existing escape is escaped again.
pub fn encode_uri(text: &str) -> Cow<'_, str> {
    encode(text, uri_unescaped)
}

/// `decodeURIComponent(text)`: every `%XX` escape decoded, reserved characters included. An
/// error where JavaScript throws `URIError`; never a replacement character.
pub fn decode_uri_component(text: &str) -> Result<Cow<'_, str>, UriError> {
    decode(text, b"")
}

/// `decodeURI(text)`: as [`decode_uri_component`], except that an escape of a reserved character
/// (`;/?:@&=+$,#`) is kept as written (`%2F` and `%2f` stay as they are).
pub fn decode_uri(text: &str) -> Result<Cow<'_, str>, UriError> {
    decode(text, URI_RESERVED)
}

fn encode(text: &str, unescaped: fn(u8) -> bool) -> Cow<'_, str> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let Some(first) = text.bytes().position(|byte| !unescaped(byte)) else {
        return Cow::Borrowed(text);
    };
    let mut out = String::with_capacity(text.len() + 16);
    out.push_str(text.get(..first).unwrap_or_default());
    for byte in text.bytes().skip(first) {
        if unescaped(byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    Cow::Owned(out)
}

/// The byte of a `%XX` escape at `at`, if there is one.
fn escape_at(bytes: &[u8], at: usize) -> Option<u8> {
    match bytes.get(at..at + 3)? {
        [b'%', high, low] => {
            let digit = |byte: &u8| char::from(*byte).to_digit(16);
            Some(((digit(high)? << 4) | digit(low)?) as u8)
        }
        _ => None,
    }
}

/// The ECMAScript `Decode(string, preserveEscapeSet)` operation.
fn decode<'a>(text: &'a str, preserve: &[u8]) -> Result<Cow<'a, str>, UriError> {
    let bytes = text.as_bytes();
    let Some(first) = bytes.iter().position(|byte| *byte == b'%') else {
        return Ok(Cow::Borrowed(text));
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(text.get(..first).unwrap_or_default());
    let mut at = first;
    while at < bytes.len() {
        // Copy the run up to the next escape as it is.
        let run = bytes
            .get(at..)
            .and_then(|rest| rest.iter().position(|byte| *byte == b'%'))
            .map_or(bytes.len(), |offset| at + offset);
        out.push_str(text.get(at..run).unwrap_or_default());
        at = run;
        if at >= bytes.len() {
            break;
        }
        let error = UriError { offset: at };
        let lead = escape_at(bytes, at).ok_or(error)?;
        if lead < 0x80 {
            if preserve.contains(&lead) {
                out.push_str(text.get(at..at + 3).unwrap_or_default());
            } else {
                out.push(char::from(lead));
            }
            at += 3;
            continue;
        }
        let length = lead.leading_ones() as usize;
        if !(2..=4).contains(&length) {
            return Err(error);
        }
        let mut sequence = [lead, 0, 0, 0];
        for index in 1..length {
            let continuation = escape_at(bytes, at + 3 * index)
                .filter(|byte| byte & 0xc0 == 0x80)
                .ok_or(error)?;
            if let Some(slot) = sequence.get_mut(index) {
                *slot = continuation;
            }
        }
        // `from_utf8` rejects exactly what `Decode` rejects: overlong forms, surrogate code
        // points and values above U+10FFFF.
        let decoded = sequence
            .get(..length)
            .and_then(|sequence| std::str::from_utf8(sequence).ok())
            .ok_or(error)?;
        out.push_str(decoded);
        at += 3 * length;
    }
    Ok(Cow::Owned(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_escape_reserved_characters_and_uris_keep_them() {
        assert_eq!(
            encode_uri_component("a b/c?d=é😀"),
            "a%20b%2Fc%3Fd%3D%C3%A9%F0%9F%98%80"
        );
        assert_eq!(encode_uri("a b/c?d=é#x"), "a%20b/c?d=%C3%A9#x");
        assert_eq!(encode_uri("%41"), "%2541");
        assert!(matches!(
            encode_uri_component("plain-text_1.0"),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn decoding_throws_where_javascript_throws() {
        assert_eq!(decode_uri_component("a%2Fb%C3%A9").as_deref(), Ok("a/bé"));
        assert_eq!(decode_uri("a%2Fb%2f%20").as_deref(), Ok("a%2Fb%2f "));
        assert_eq!(decode_uri_component("%"), Err(UriError { offset: 0 }));
        assert_eq!(
            decode_uri_component("ab%E2%82"),
            Err(UriError { offset: 2 })
        );
        assert_eq!(
            decode_uri_component("%ED%A0%80"),
            Err(UriError { offset: 0 })
        );
        assert_eq!(decode_uri_component("%C0%80"), Err(UriError { offset: 0 }));
        assert_eq!(decode_uri_component("ключ+").as_deref(), Ok("ключ+"));
        assert_eq!(UriError { offset: 0 }.to_string(), "URI malformed");
    }
}
