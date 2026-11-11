//! URI and HTML text helpers with the exact JavaScript semantics Express relies on.

/// JavaScript `decodeURIComponent`: `None` where JavaScript throws `URIError`.
///
/// Every `%XX` escape is decoded (including reserved characters such as `%2F`). A multi-byte
/// sequence must be complete and well-formed UTF-8 (no overlong forms, no surrogates), exactly as
/// the ECMAScript `Decode` operation requires. Characters that are not escapes pass through.
pub fn decode_uri_component(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_owned());
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut k = 0;
    while k < bytes.len() {
        let byte = bytes.get(k).copied()?;
        if byte != b'%' {
            out.push(byte);
            k += 1;
            continue;
        }
        let first = escape_at(bytes, k)?;
        k += 3;
        if first & 0x80 == 0 {
            out.push(first);
            continue;
        }
        let n = first.leading_ones() as usize;
        if n == 1 || n > 4 {
            return None;
        }
        let mut octets = [first, 0, 0, 0];
        for slot in octets.iter_mut().take(n).skip(1) {
            let next = escape_at(bytes, k)?;
            if next & 0xC0 != 0x80 {
                return None;
            }
            *slot = next;
            k += 3;
        }
        let sequence = octets.get(..n)?;
        // `from_utf8` rejects exactly what the specification rejects: overlong forms,
        // surrogate code points and values above U+10FFFF.
        std::str::from_utf8(sequence).ok()?;
        out.extend_from_slice(sequence);
    }
    String::from_utf8(out).ok()
}

/// The byte of a `%XX` escape starting at `at`, or `None` when there is none.
fn escape_at(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    let high = hex_value(*bytes.get(at + 1)?)?;
    let low = hex_value(*bytes.get(at + 2)?)?;
    Some(high << 4 | low)
}

pub(crate) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `encodeurl` 2.0: percent-encode what is not allowed in a URL, keep valid escapes.
///
/// Used for `Location` headers (`res.location`, `res.redirect`) and the 404 page's path.
pub fn encode_url(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        if c == '%' {
            let next = chars.get(i + 1).copied();
            let bad_len = match next {
                None => 1,
                Some(n) if !n.is_ascii_hexdigit() => 2,
                Some(_) => match chars.get(i + 2).copied() {
                    Some(after) if !after.is_ascii_hexdigit() => 3,
                    _ => 0,
                },
            };
            if bad_len == 0 {
                out.push('%');
                i += 1;
            } else {
                for &bad in chars.iter().skip(i).take(bad_len) {
                    push_encode_uri(&mut out, bad);
                }
                i += bad_len;
            }
            continue;
        }
        if url_allowed(c) {
            out.push(c);
        } else {
            push_encode_uri(&mut out, c);
        }
        i += 1;
    }
    out
}

/// Characters `encodeurl` leaves alone (`\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E`).
fn url_allowed(c: char) -> bool {
    matches!(c, '\x21' | '\x23'..='\x3B' | '\x3D' | '\x3F'..='\x5F' | '\x61'..='\x7A' | '\x7C' | '\x7E')
}

/// JavaScript `encodeURI` for one character.
fn push_encode_uri(out: &mut String, c: char) {
    let keep = c.is_ascii_alphanumeric()
        || matches!(
            c,
            '-' | '_'
                | '.'
                | '!'
                | '~'
                | '*'
                | '\''
                | '('
                | ')'
                | ';'
                | ','
                | '/'
                | '?'
                | ':'
                | '@'
                | '&'
                | '='
                | '+'
                | '$'
                | '#'
        );
    if keep {
        out.push(c);
        return;
    }
    let mut buf = [0u8; 4];
    for byte in c.encode_utf8(&mut buf).bytes() {
        push_percent(out, byte);
    }
}

pub(crate) fn push_percent(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0F)]));
}

/// `escape-html`: `& < > " '`.
pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_javascript() {
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("%2F%3f").as_deref(), Some("/?"));
        assert_eq!(decode_uri_component("%F0%9F%98%80").as_deref(), Some("😀"));
        assert_eq!(decode_uri_component("caf%C3%A9").as_deref(), Some("café"));
        assert_eq!(decode_uri_component("ñ%41").as_deref(), Some("ñA"));
        assert_eq!(decode_uri_component("a+b").as_deref(), Some("a+b"));
        // Throws in JavaScript.
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%C3"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(decode_uri_component("%F4%90%80%80"), None);
        assert_eq!(decode_uri_component("%80"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C3%28"), None);
    }

    #[test]
    fn encodes_like_encodeurl() {
        assert_eq!(encode_url("/a b"), "/a%20b");
        assert_eq!(encode_url("/caf%C3%A9"), "/caf%C3%A9");
        assert_eq!(encode_url("/café"), "/caf%C3%A9");
        assert_eq!(encode_url("/😀"), "/%F0%9F%98%80");
        assert_eq!(encode_url("100%"), "100%25");
        assert_eq!(encode_url("%zz"), "%25zz");
        assert_eq!(encode_url("%4z"), "%254z");
        assert_eq!(encode_url("%4"), "%4");
        assert_eq!(encode_url("%%41"), "%25%2541");
        assert_eq!(encode_url("a\"<>`{}"), "a%22%3C%3E%60%7B%7D");
        assert_eq!(encode_url("http://x.y/p?q=1#h"), "http://x.y/p?q=1#h");
    }

    #[test]
    fn escapes_html() {
        assert_eq!(
            escape_html("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }
}
