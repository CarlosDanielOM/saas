//! Experimental node-re2 adapter for the non-global `u`/`iu` exec path.
//! See migration-notes/re2-native-handoff.md before adopting this module.

use super::{js_string::JsString, re2_compat, re2_string, re2_unicode};
use regex::bytes::{Regex, RegexBuilder};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError(pub String);
impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CompileError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    pub text: JsString,
    pub byte_start: usize,
    pub byte_end: usize,
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecMatch {
    pub index: usize,
    pub captures: Vec<Option<Capture>>,
    pub has_indices: bool,
}
#[derive(Clone, Debug)]
pub struct Re2Native {
    regex: Regex,
    has_indices: bool,
}

impl Re2Native {
    /// Compile a JS UTF-16 pattern. The caller chooses the `i` and `d` flags;
    /// Unicode mode is always enabled, as in the moderation source.
    pub fn compile(
        source: &JsString,
        ignore_case: bool,
        has_indices: bool,
    ) -> Result<Self, CompileError> {
        let bytes = re2_string::encode_pattern(source);
        // Preserve invalid UTF-16 as a never-matching rune, not U+FFFD. It is
        // represented by an impossible Unicode class and remains an atom.
        let sentinel = (0xf0000..=0xffffd)
            .filter_map(char::from_u32)
            .find(|c| {
                !source
                    .code_units()
                    .collect::<Vec<_>>()
                    .windows(2)
                    .any(|u| char::decode_utf16(u.iter().copied()).next() == Some(Ok(*c)))
            })
            .ok_or_else(|| CompileError("no surrogate placeholder available".into()))?;
        let mut pattern = String::new();
        let mut index = 0;
        while index < bytes.len() {
            match std::str::from_utf8(&bytes[index..]) {
                Ok(tail) => {
                    pattern.push_str(tail);
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    pattern.push_str(std::str::from_utf8(&bytes[index..index + valid]).unwrap());
                    index += valid;
                    pattern.push(sentinel);
                    // One WTF-8 surrogate consists of three bytes.
                    index += 3.min(bytes.len() - index);
                }
            }
        }
        let translated =
            re2_compat::translate(&pattern).map_err(|e| CompileError(e.to_string()))?;
        let translated = expand(&translated, ignore_case, sentinel)?;
        let regex = RegexBuilder::new(&translated)
            .build()
            .map_err(|e| CompileError(e.to_string()))?;
        Ok(Self { regex, has_indices })
    }

    /// Execute once on a string input. Offsets and decoded captures follow the
    /// SDK's string path, including partial-byte `\\C` captures.
    pub fn exec(&self, input: &JsString) -> Option<ExecMatch> {
        let bytes = re2_string::encode_input(input);
        let captures = self.regex.captures(&bytes)?;
        let mut result = Vec::with_capacity(captures.len());
        for found in captures.iter() {
            result.push(found.map(|item| {
                let start = re2_string::utf16_prefix_len(&bytes, item.start()).unwrap();
                let length = re2_string::utf16_prefix_len(item.as_bytes(), item.len()).unwrap();
                Capture {
                    text: re2_string::decode_capture(item.as_bytes()),
                    byte_start: item.start(),
                    byte_end: item.end(),
                    start,
                    end: start + length,
                }
            }));
        }
        Some(ExecMatch {
            index: result[0].as_ref().unwrap().start,
            captures: result,
            has_indices: self.has_indices,
        })
    }
}

// Emit only scalar ranges: RE2's UTF-8 matcher never sees a surrogate rune.
fn emit_ranges(out: &mut String, bits: &[bool]) {
    let mut cp = 0usize;
    while cp < bits.len() {
        if !bits[cp] {
            cp += 1;
            continue;
        }
        let start = cp;
        while cp + 1 < bits.len() && bits[cp + 1] {
            cp += 1;
        }
        use std::fmt::Write;
        let _ = write!(out, "\\x{{{start:x}}}");
        if cp != start {
            let _ = write!(out, "-\\x{{{cp:x}}}");
        }
        cp += 1;
    }
}
fn empty_bits() -> Vec<bool> {
    vec![false; 0x110000]
}
fn fold(bits: &mut [bool]) {
    // Only add members of cycles already represented by the class.
    let mut additions = Vec::new();
    for cp in 0..bits.len() {
        if bits[cp] {
            additions.extend(re2_unicode::equivalents(cp as u32).map(|x| x as usize));
        }
    }
    for cp in additions {
        if cp < bits.len() {
            bits[cp] = true;
        }
    }
}
fn bits_class(bits: &[bool], negate: bool) -> String {
    let mut out = String::from(if negate { "[^" } else { "[" });
    // The regex parser rejects an empty class; an intersection encodes it.
    if !bits.iter().any(|x| *x) {
        out.push_str("a&&[^a]");
    } else {
        emit_ranges(&mut out, bits);
    }
    out.push(']');
    out
}
fn property(name: &str, inverted: bool, insensitive: bool) -> Result<String, CompileError> {
    let resolved = re2_unicode::resolve_braced(name)
        .ok_or_else(|| CompileError(format!("unknown Unicode property {name}")))?;
    let mut bits = empty_bits();
    for &(start, end) in resolved.property.ranges {
        for cp in start..=end.min(0x10ffff) {
            if !(0xd800..=0xdfff).contains(&cp) {
                bits[cp as usize] = true;
            }
        }
    }
    if insensitive {
        fold(&mut bits);
    }
    Ok(bits_class(&bits, inverted ^ resolved.inverted))
}
fn folded_literal(ch: char) -> String {
    use std::fmt::Write;
    let mut out = String::from("[");
    for cp in re2_unicode::equivalents(ch as u32) {
        let _ = write!(out, "\\x{{{cp:x}}}");
    }
    out.push(']');
    out
}

// Class evaluation uses regex only without its Unicode case-fold or property
// tables. The output is then folded with the native RE2 cycle table.
fn folded_class(class: &str) -> Result<String, CompileError> {
    let (negative, body) = if let Some(rest) = class.strip_prefix("[^") {
        (true, rest)
    } else {
        (false, &class[1..])
    };
    let positive = format!("[{}", body);
    let matcher =
        Regex::new(&format!("^(?:{positive})$")).map_err(|e| CompileError(e.to_string()))?;
    let mut bits = empty_bits();
    let mut buf = [0; 4];
    for cp in 0..=0x10ffff {
        if let Some(ch) = char::from_u32(cp) {
            if matcher.is_match(ch.encode_utf8(&mut buf).as_bytes()) {
                bits[cp as usize] = true;
            }
        }
    }
    fold(&mut bits);
    Ok(bits_class(&bits, negative))
}

// Rewrite properties, case folding, byte escape, and scoped inline `i` flags.
fn expand(source: &str, initial_i: bool, sentinel: char) -> Result<String, CompileError> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut insensitive = initial_i;
    let mut stack = Vec::new();
    while i < chars.len() {
        let ch = chars[i];
        if ch == sentinel {
            out.push_str("[a&&[^a]]");
            i += 1;
            continue;
        }
        if ch == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            if next == 'p' || next == 'P' {
                let (name, end) = if chars.get(i + 2) == Some(&'{') {
                    let end = (i + 3..chars.len())
                        .find(|&x| chars[x] == '}')
                        .ok_or_else(|| CompileError("unterminated property".into()))?;
                    (chars[i + 3..end].iter().collect::<String>(), end + 1)
                } else if let Some(&c) = chars.get(i + 2) {
                    (c.to_string(), i + 3)
                } else {
                    return Err(CompileError("missing property".into()));
                };
                out.push_str(&property(&name, next == 'P', insensitive)?);
                i = end;
                continue;
            }
            if next == 'C' {
                out.push_str("(?s-u:.)");
                i += 2;
                continue;
            }
            if next == 'u' && chars.get(i + 2).is_some_and(|c| c.is_ascii_hexdigit()) {
                let mut end = i + 2;
                while end < chars.len() && end < i + 6 && chars[end].is_ascii_hexdigit() {
                    end += 1;
                }
                let digits: String = chars[i + 2..end].iter().collect();
                let cp = u32::from_str_radix(&digits, 16).unwrap();
                if let Some(value) = char::from_u32(cp) {
                    if insensitive {
                        out.push_str(&folded_literal(value));
                    } else {
                        out.push_str(&format!("\\x{{{cp:x}}}"));
                    }
                } else {
                    out.push_str("[a&&[^a]]");
                }
                i = end;
                continue;
            }
            // Hex, escaped literals and other escapes are left to the engine;
            // escaped literal folding remains a documented gap.
            out.push(ch);
            out.push(next);
            i += 2;
            if matches!(next, 'x' | 'u') && chars.get(i) == Some(&'{') {
                while i < chars.len() {
                    let c = chars[i];
                    out.push(c);
                    i += 1;
                    if c == '}' {
                        break;
                    }
                }
            }
            continue;
        }
        if ch == '[' {
            let mut depth = 1usize;
            let mut end = i + 1;
            while end < chars.len() && depth > 0 {
                if chars[end] == '\\' {
                    end = (end + 2).min(chars.len());
                    continue;
                }
                if chars[end] == '[' {
                    depth += 1;
                } else if chars[end] == ']' {
                    depth -= 1;
                }
                end += 1;
            }
            if depth != 0 {
                return Err(CompileError("unclosed class".into()));
            }
            let part: String = chars[i..end].iter().collect();
            // Recursively expand properties before folding the complete class.
            let expanded = expand_class_properties(&part)?;
            out.push_str(&if insensitive {
                folded_class(&expanded)?
            } else {
                expanded
            });
            i = end;
            continue;
        }
        if ch == '(' {
            // Inline flags alter the current scope, but must never enable the
            // regex crate's Unicode case folding.
            if chars.get(i + 1) == Some(&'?') {
                let mut j = i + 2;
                while j < chars.len() && matches!(chars[j], 'i' | 'm' | 's' | 'U' | 'u' | '-') {
                    j += 1;
                }
                if j > i + 2 && matches!(chars.get(j), Some(':' | ')')) {
                    let mut enable = true;
                    let mut other_on = String::new();
                    let mut other_off = String::new();
                    let old = insensitive;
                    for &flag in &chars[i + 2..j] {
                        if flag == '-' {
                            enable = false;
                        } else if flag == 'i' {
                            insensitive = enable;
                        } else if enable {
                            other_on.push(flag);
                        } else {
                            other_off.push(flag);
                        }
                    }
                    let scoped = chars[j] == ':';
                    if scoped {
                        stack.push(old);
                    }
                    if other_on.is_empty() && other_off.is_empty() {
                        if scoped {
                            out.push_str("(?:");
                        }
                    } else {
                        out.push_str("(?");
                        out.push_str(&other_on);
                        if !other_off.is_empty() {
                            out.push('-');
                            out.push_str(&other_off);
                        }
                        out.push(if scoped { ':' } else { ')' });
                    }
                    i = j + 1;
                    continue;
                }
                if chars.get(i + 2) == Some(&':') {
                    out.push_str("(?:");
                    stack.push(insensitive);
                    i += 3;
                    continue;
                }
                // Preserve named group headers without folding their names.
                if chars.get(i + 2) == Some(&'P') && chars.get(i + 3) == Some(&'<') {
                    let end = (i + 4..chars.len())
                        .find(|&x| chars[x] == '>')
                        .ok_or_else(|| CompileError("unclosed group name".into()))?;
                    out.extend(chars[i..=end].iter());
                    stack.push(insensitive);
                    i = end + 1;
                    continue;
                }
                if chars.get(i + 2) == Some(&'<') && !matches!(chars.get(i + 3), Some('=' | '!')) {
                    let end = (i + 3..chars.len())
                        .find(|&x| chars[x] == '>')
                        .ok_or_else(|| CompileError("unclosed group name".into()))?;
                    out.push_str("(?P<");
                    out.extend(chars[i + 3..=end].iter());
                    stack.push(insensitive);
                    i = end + 1;
                    continue;
                }
            }
            stack.push(insensitive);
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == ')' {
            if let Some(old) = stack.pop() {
                insensitive = old;
            }
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '{' {
            if let Some(end) = (i + 1..chars.len()).find(|&x| chars[x] == '}') {
                out.extend(chars[i..=end].iter());
                i = end + 1;
                continue;
            }
        }
        if insensitive && !matches!(ch, '.' | '^' | '$' | '*' | '+' | '?' | '|') {
            out.push_str(&folded_literal(ch));
        } else {
            out.push(ch);
        }
        i += 1;
    }
    Ok(out)
}
fn expand_class_properties(source: &str) -> Result<String, CompileError> {
    let c: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' && i + 1 < c.len() {
            if (c[i + 1] == 'p' || c[i + 1] == 'P') && c.get(i + 2) == Some(&'{') {
                let end = (i + 3..c.len())
                    .find(|&x| c[x] == '}')
                    .ok_or_else(|| CompileError("unterminated property".into()))?;
                let name: String = c[i + 3..end].iter().collect();
                out.push_str(&property(&name, c[i + 1] == 'P', false)?);
                i = end + 1;
                continue;
            }
            out.push(c[i]);
            out.push(c[i + 1]);
            i += 2;
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    Ok(out)
}
