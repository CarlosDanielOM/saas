//! Lossless JavaScript strings at UTF-16 slicing and encoding boundaries.
use super::js_compat::is_whitespace;

/// Valid Unicode stays UTF-8; only ill-formed UTF-16 needs the fallback.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct JsString(Repr);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Repr {
    // Cache ASCII classification once so repeated indexed slices do not scan
    // the entire source text for every emote.
    Utf8 { text: String, ascii: bool },
    Utf16(Vec<u16>),
}

/// Borrowed, allocation-free UTF-16 code units from either representation.
pub enum CodeUnits<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Utf16(std::iter::Copied<std::slice::Iter<'a, u16>>),
}
impl Iterator for CodeUnits<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        match self {
            Self::Utf8(iter) => iter.next(),
            Self::Utf16(iter) => iter.next(),
        }
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Self::Utf8(iter) => iter.size_hint(),
            Self::Utf16(iter) => iter.size_hint(),
        }
    }
}

impl JsString {
    fn utf8(text: String) -> Self {
        let ascii = text.is_ascii();
        Self(Repr::Utf8 { text, ascii })
    }
    pub fn from_units(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => Self::utf8(text),
            Err(_) => Self(Repr::Utf16(units)),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8 { text, .. } => Some(text),
            Repr::Utf16(_) => None,
        }
    }

    pub fn code_units(&self) -> CodeUnits<'_> {
        match &self.0 {
            Repr::Utf8 { text, .. } => CodeUnits::Utf8(text.encode_utf16()),
            Repr::Utf16(units) => CodeUnits::Utf16(units.iter().copied()),
        }
    }

    pub fn units(&self) -> Vec<u16> {
        self.code_units().collect()
    }

    pub fn len(&self) -> usize {
        match &self.0 {
            Repr::Utf8 { text, ascii: true } => text.len(),
            Repr::Utf8 { text, .. } => text.encode_utf16().count(),
            Repr::Utf16(units) => units.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Repr::Utf8 { text, .. } => text.is_empty(),
            Repr::Utf16(units) => units.is_empty(),
        }
    }

    /// JS slice with already integer indices, including negative offsets.
    pub fn slice(&self, start: i64, end: i64) -> Self {
        let len = self.len();
        let index = |i: i64| {
            if i < 0 {
                len.saturating_sub(i.unsigned_abs().min(usize::MAX as u64) as usize)
            } else {
                (i as u64).min(len as u64) as usize
            }
        };
        let start = index(start);
        let end = index(end).max(start);
        if let Repr::Utf8 { text, ascii } = &self.0 {
            if *ascii {
                return Self::utf8(text[start..end].to_owned());
            }
            let mut offset = 0;
            let mut first = None;
            let mut last = None;
            for (byte, ch) in text.char_indices() {
                if offset == start {
                    first = Some(byte);
                }
                if offset == end {
                    last = Some(byte);
                    break;
                }
                offset += ch.len_utf16();
            }
            if offset == start && first.is_none() {
                first = Some(text.len());
            }
            if offset == end && last.is_none() {
                last = Some(text.len());
            }
            if let (Some(a), Some(b)) = (first, last) {
                return Self::utf8(text[a..b].to_owned());
            }
        }
        Self::from_units(self.code_units().skip(start).take(end - start).collect())
    }

    pub fn trim(&self) -> Self {
        match &self.0 {
            Repr::Utf8 { text, .. } => Self::utf8(super::js_compat::trim(text).to_owned()),
            Repr::Utf16(units) => {
                let ws = |u: &u16| char::from_u32(*u as u32).is_some_and(is_whitespace);
                let start = units.iter().position(|u| !ws(u)).unwrap_or(units.len());
                let end = units.iter().rposition(|u| !ws(u)).map_or(start, |i| i + 1);
                Self::from_units(units[start..end].to_vec())
            }
        }
    }

    /// Node's UTF-8/BSON boundary replaces each unpaired code unit with U+FFFD.
    pub fn to_utf8_lossy(&self) -> String {
        match &self.0 {
            Repr::Utf8 { text, .. } => text.clone(),
            Repr::Utf16(units) => String::from_utf16_lossy(units),
        }
    }

    /// A complete JSON string literal matching well-formed JSON.stringify.
    /// This is deliberately not a generic Serde implementation.
    pub fn to_json_string(&self) -> String {
        let capacity = match &self.0 {
            Repr::Utf8 { text, .. } => text.len(),
            Repr::Utf16(units) => units.len(),
        };
        let mut out = String::with_capacity(capacity.saturating_add(2));
        self.write_json_string(&mut out);
        out
    }

    /// Append a complete JSON string literal without an intermediate buffer.
    pub fn write_json_string(&self, out: &mut String) {
        if let Repr::Utf8 { text, .. } = &self.0 {
            write_json_utf8(text, out);
            return;
        }
        out.push('"');
        for c in char::decode_utf16(self.code_units()) {
            match c {
                Err(e) => write_json_escape(e.unpaired_surrogate(), out),
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok('\u{0008}') => out.push_str("\\b"),
                Ok('\u{0009}') => out.push_str("\\t"),
                Ok('\u{000a}') => out.push_str("\\n"),
                Ok('\u{000c}') => out.push_str("\\f"),
                Ok('\u{000d}') => out.push_str("\\r"),
                Ok(c) if (c as u32) < 0x20 => write_json_escape(c as u16, out),
                Ok(c) => out.push(c),
            }
        }
        out.push('"');
    }
}

/// Append a borrowed, valid UTF-8 string as a JSON literal. Every escape starts
/// at an ASCII byte, so copying clean spans preserves UTF-8 boundaries directly.
pub fn write_json_utf8(value: &str, out: &mut String) {
    out.push('"');
    let mut start = 0;
    for (index, byte) in value.bytes().enumerate() {
        if byte >= 0x20 && byte != b'"' && byte != b'\\' {
            continue;
        }
        out.push_str(&value[start..index]);
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            byte => write_json_escape(u16::from(byte), out),
        }
        start = index + 1;
    }
    out.push_str(&value[start..]);
    out.push('"');
}

fn write_json_escape(unit: u16, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\\u");
    for shift in [12, 8, 4, 0] {
        out.push(char::from(HEX[usize::from((unit >> shift) & 0xf)]));
    }
}

impl From<&str> for JsString {
    fn from(s: &str) -> Self {
        Self::utf8(s.to_owned())
    }
}
impl From<String> for JsString {
    fn from(s: String) -> Self {
        Self::utf8(s)
    }
}

#[cfg(test)]
mod tests {
    use super::{JsString, write_json_utf8};

    #[test]
    fn json_literals_append_and_escape_without_losing_unicode() {
        for text in [
            "",
            "plain / <>&'",
            "é😀\u{2028}\u{2029}",
            "\"\\\u{0008}\t\n\u{000c}\r\0\u{0001}\u{001f}",
            "a\n😀\r\"z",
        ] {
            let expected = format!("prefix{}", serde_json::to_string(text).unwrap());
            let mut borrowed = String::from("prefix");
            write_json_utf8(text, &mut borrowed);
            assert_eq!(borrowed, expected);
            let mut owned = String::from("prefix");
            JsString::from(text).write_json_string(&mut owned);
            assert_eq!(owned, expected);
        }
        let text = JsString::from_units(vec![0xd800, 0, 0xd83d, 0xde00, 0xdc00]);
        let mut out = String::from("prefix");
        text.write_json_string(&mut out);
        assert_eq!(out, "prefix\"\\ud800\\u0000😀\\udc00\"");
    }

    #[test]
    fn slicing_and_encoding_boundaries() {
        let s = JsString::from("a😀😀b");
        assert_eq!(s.len(), 6);
        assert_eq!(s.slice(1, 3).as_str(), Some("😀"));
        assert_eq!(s.slice(2, -2).units(), vec![0xde00, 0xd83d]);
        assert_eq!(s.slice(2, -2).to_json_string(), r#""\ude00\ud83d""#);
        assert_eq!(s.slice(2, -2).to_utf8_lossy(), "��");
        assert_eq!(s.slice(-99, 99), s);
        assert_eq!(
            JsString::from_units(vec![0xfeff, 0xd800, 0x20])
                .trim()
                .units(),
            vec![0xd800]
        );
    }
}
