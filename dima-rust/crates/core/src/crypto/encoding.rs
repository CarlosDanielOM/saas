//! Byte encodings as Node's `Buffer` writes and reads them.
//!
//! Encoding is strict and canonical (`hex` lowercase, `base64` padded, `base64url` unpadded).
//! Decoding reproduces Node's leniency, which the reference relies on when it reads stored or
//! received text: see [`decode_hex_lenient`] and [`decode_base64_lenient`].

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

/// `buffer.toString('hex')`: lowercase.
pub fn encode_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// `buffer.toString('base64')`: standard alphabet with `=` padding.
pub fn encode_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// `buffer.toString('base64url')`: URL-safe alphabet, no padding.
pub fn encode_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `Buffer.from(text, 'hex')`: pairs of hex digits (either case) up to the first pair that is not
/// one; an unmatched final digit is ignored. Never fails.
pub fn decode_hex_lenient(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for &[high, low] in text.as_bytes().as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (nibble(high), nibble(low)) else {
            break;
        };
        out.push(high << 4 | low);
    }
    out
}

/// `Buffer.from(text, 'base64')`, which is the same decoder as `'base64url'`: both alphabets are
/// accepted, every other character is skipped, decoding stops at the first `=`, and a trailing
/// group of 2 or 3 characters yields 1 or 2 bytes (a single leftover character yields nothing).
/// Never fails.
pub fn decode_base64_lenient(text: &str) -> Vec<u8> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut group: u32 = 0;
    let mut count = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(sextet) = value(byte) else {
            continue;
        };
        group = group << 6 | sextet;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&group.to_be_bytes()[1..]);
            group = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((group >> 4) as u8),
        3 => out.extend_from_slice(&((group >> 2) as u16).to_be_bytes()),
        _ => {}
    }
    out
}

/// `buffer.toString('latin1')` (also `'binary'`): one character per byte.
pub fn latin1_to_string(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_decoders_follow_node() {
        assert_eq!(decode_hex_lenient("0aFfz1"), vec![0x0a, 0xff]);
        assert_eq!(decode_hex_lenient("abc"), vec![0xab]);
        assert_eq!(decode_base64_lenient("QU*JD"), b"ABC");
        assert_eq!(decode_base64_lenient("QUJ=D"), b"AB");
        assert_eq!(decode_base64_lenient("Q"), b"");
        assert_eq!(decode_base64_lenient("-_-_"), vec![0xfb, 0xff, 0xbf]);
        assert_eq!(encode_base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(encode_base64(&[0xfb, 0xff]), "+/8=");
        assert_eq!(latin1_to_string(&[0x41, 0xe9]), "Aé");
    }
}
