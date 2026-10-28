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
        use std::fmt::Write;
        let mut out = String::from("\"");
        for c in char::decode_utf16(self.code_units()) {
            match c {
                Err(e) => {
                    write!(out, "\\u{:04x}", e.unpaired_surrogate()).unwrap();
                }
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok('\u{0008}') => out.push_str("\\b"),
                Ok('\u{0009}') => out.push_str("\\t"),
                Ok('\u{000a}') => out.push_str("\\n"),
                Ok('\u{000c}') => out.push_str("\\f"),
                Ok('\u{000d}') => out.push_str("\\r"),
                Ok(c) if (c as u32) < 0x20 => {
                    write!(out, "\\u{:04x}", c as u32).unwrap();
                }
                Ok(c) => out.push(c),
            }
        }
        out.push('"');
        out
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
    use super::JsString;
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
