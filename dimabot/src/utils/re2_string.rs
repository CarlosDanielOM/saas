//! String boundaries observed for Node 24.22.1 and node-re2 1.27.0.
//!
//! These functions do not implement RE2 or a general Node string codec. The
//! malformed-input truncation rule is empirical: it matches the bounded probe
//! corpus, not an established contract for all strings or Node versions.

use std::borrow::Cow;

use super::js_string::JsString;

/// Pattern serialization via the SDK's default V8 `WriteUtf8V2` path.
/// Unpaired surrogate code units are emitted as three-byte WTF-8 sequences.
pub fn encode_pattern(value: &JsString) -> Cow<'_, [u8]> {
    if let Some(text) = value.as_str() {
        return Cow::Borrowed(text.as_bytes());
    }
    let mut bytes = Vec::new();
    for decoded in char::decode_utf16(value.code_units()) {
        match decoded {
            Ok(ch) => {
                let mut buf = [0; 4];
                bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            Err(err) => {
                let unit = err.unpaired_surrogate();
                bytes.extend_from_slice(&[
                    0xe0 | (unit >> 12) as u8,
                    0x80 | ((unit >> 6) & 0x3f) as u8,
                    0x80 | (unit & 0x3f) as u8,
                ]);
            }
        }
    }
    Cow::Owned(bytes)
}

/// Input serialization matching the observed `node::Buffer::New` results.
///
/// For malformed UTF-16, the corpus agrees with a capacity of default V8
/// UTF-8 byte length minus the number of unpaired units. Encode replacement
/// characters, stopping before a complete scalar would exceed that capacity.
/// This formula is an observation, not a claim about Node's implementation.
pub fn encode_input(value: &JsString) -> Cow<'_, [u8]> {
    if let Some(text) = value.as_str() {
        return Cow::Borrowed(text.as_bytes());
    }
    let capacity = char::decode_utf16(value.code_units())
        .map(|decoded| decoded.map_or(2, char::len_utf8))
        .sum();
    let mut result = Vec::with_capacity(capacity);
    for decoded in char::decode_utf16(value.code_units()) {
        let ch = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        let mut buf = [0; 4];
        let encoded = ch.encode_utf8(&mut buf).as_bytes();
        if encoded.len() > capacity - result.len() {
            break;
        }
        result.extend_from_slice(encoded);
    }
    Cow::Owned(result)
}

/// Count the SDK's UTF-16 index for a byte prefix, including partial UTF-8.
/// Returns `None` if `end` exceeds the provided byte string.
///
/// Derived from node-re2's `getUtf16Length`/`toUtf16Index`, copyright its
/// contributors, BSD-3-Clause; see
/// `tests/fixtures/re2-source-licenses/node-re2-BSD-3-Clause.txt`. A partial
/// four-byte lead counts as two UTF-16 units, even when only one byte is in
/// the prefix. Checked arithmetic replaces the original pointer overrun.
pub fn utf16_prefix_len(bytes: &[u8], end: usize) -> Option<usize> {
    if end > bytes.len() {
        return None;
    }
    let mut pos = 0;
    let mut count = 0;
    while pos < end {
        let byte = bytes[pos];
        let (width, units) = if byte < 0x80 {
            (1, 1)
        } else if byte < 0xe0 {
            (2, 1)
        } else if byte < 0xf0 {
            (3, 1)
        } else {
            (4, 2)
        };
        count += units;
        pos += width.min(end - pos);
    }
    Some(count)
}

/// Decode captured bytes as the SDK's V8 string constructor does for the
/// observed `\\C` first-byte captures. Arbitrary malformed byte sequences and
/// captures outside the probed string-input domain have not been established.
pub fn decode_capture(bytes: &[u8]) -> JsString {
    JsString::from(String::from_utf8_lossy(bytes).into_owned())
}
