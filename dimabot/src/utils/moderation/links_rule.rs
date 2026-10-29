//! Pure link moderation using the source's permissive, non-Unicode JS regex.
use crate::utils::{js_compat, js_string::JsString, js_unicode};

pub struct LinksRule<'a> {
    /// None models the source's nullish allowlist fallback.
    pub allowlist_domains: Option<&'a [JsString]>,
}

pub struct LinksEvaluationInput<'a> {
    /// None models the source's `input.text ?? ''` fallback.
    pub text: Option<&'a JsString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinksEvaluationResult {
    pub triggered: bool,
    pub urls: Vec<JsString>,
    pub blocked_url: Option<JsString>,
}

fn word(c: u16) -> bool {
    matches!(c, 0x30..=0x39 | 0x41..=0x5a | 0x5f | 0x61..=0x7a | 0x2d)
}
fn letter(c: u16) -> bool {
    matches!(c, 0x41..=0x5a | 0x61..=0x7a)
}
fn whitespace(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(js_compat::is_whitespace)
}
fn ascii_prefix(units: &[u16], prefix: &[u8]) -> bool {
    units.len() >= prefix.len()
        && units
            .iter()
            .zip(prefix)
            .all(|(&unit, &byte)| unit <= 127 && (unit as u8).to_ascii_lowercase() == byte)
}

// Precompute the second alternative's greedy result at every UTF-16 unit.
// A dotted continuation is preferred whenever it can eventually reach a
// terminal dot + at least two ASCII letters; otherwise the current dot is the
// terminal. This captures greedy group backtracking without rescanning long
// no-match prefixes at each global search position.
fn matches(text: &[u16]) -> Vec<(usize, usize)> {
    let n = text.len();
    let mut word_end = vec![n; n + 1];
    let mut letter_end = vec![n; n + 1];
    let mut nonspace_end = vec![n; n + 1];
    let mut best = vec![None; n + 1];
    for i in (0..n).rev() {
        word_end[i] = if word(text[i]) { word_end[i + 1] } else { i };
        letter_end[i] = if letter(text[i]) {
            letter_end[i + 1]
        } else {
            i
        };
        nonspace_end[i] = if !whitespace(text[i]) {
            nonspace_end[i + 1]
        } else {
            i
        };
        if word(text[i]) {
            let dot = word_end[i];
            if dot < n && text[dot] == b'.' as u16 {
                let start = dot + 1;
                let continued = best[start];
                let terminal = if letter_end[start] - start >= 2 {
                    let end = letter_end[start];
                    Some(if end < n && text[end] == b'/' as u16 {
                        nonspace_end[end + 1]
                    } else {
                        end
                    })
                } else {
                    None
                };
                best[i] = continued.or(terminal);
            }
        }
    }
    let mut output = Vec::new();
    let mut i = 0;
    while i < n {
        let rest = &text[i..];
        let prefix = if ascii_prefix(rest, b"https://") {
            8
        } else if ascii_prefix(rest, b"http://") {
            7
        } else if ascii_prefix(rest, b"www.") {
            4
        } else {
            0
        };
        let prefixed = if prefix != 0 && i + prefix < n && !whitespace(text[i + prefix]) {
            Some(nonspace_end[i + prefix])
        } else {
            None
        };
        if let Some(end) = prefixed.or(best[i]) {
            output.push((i, end));
            i = end;
        } else {
            i += 1;
        }
    }
    output
}

fn hostname(raw: &[u16]) -> Option<JsString> {
    let trimmed = JsString::from_units(raw.to_vec()).trim();
    // Lowercase the entire URL first: path/query characters can affect Final_Sigma.
    let lower = js_unicode::lowercase(&trimmed);
    let units = lower.units();
    let mut start = if units.starts_with(&[104, 116, 116, 112, 115, 58, 47, 47]) {
        8
    } else if units.starts_with(&[104, 116, 116, 112, 58, 47, 47]) {
        7
    } else {
        0
    };
    if units[start..].starts_with(&[119, 119, 119, 46]) {
        start += 4;
    }
    let end = units[start..]
        .iter()
        .position(|u| matches!(*u, 47 | 63 | 35 | 58))
        .map_or(units.len(), |i| start + i);
    let host = &units[start..end];
    if host.is_empty() || !host.contains(&(b'.' as u16)) {
        None
    } else {
        Some(JsString::from_units(host.to_vec()))
    }
}

// Short ASCII messages use bounded stack tables and borrowed byte slices. The
// same greedy recurrence as the UTF-16 scanner is retained; a length cap keeps
// the stack bounded and leaves long-input behavior on the existing path.
const ASCII_STACK_LIMIT: usize = 256;

fn ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}
fn ascii_space(byte: u8) -> bool {
    matches!(byte, b'\t'..=b'\r' | b' ')
}
fn ascii_starts(value: &[u8], prefix: &[u8]) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn ascii_allowed(host: &[u8], domains: &[JsString]) -> bool {
    domains.iter().any(|domain| {
        // Non-ASCII case mappings (for example Kelvin sign) may produce ASCII.
        // Use the shared lowercasing table for these and for lone surrogates.
        let lowered;
        let bytes = match domain.as_str() {
            Some(s) if s.is_ascii() => s.as_bytes(),
            _ => {
                lowered = js_unicode::lowercase(domain);
                match lowered.as_str() {
                    Some(s) => s.as_bytes(),
                    None => return false,
                }
            }
        };
        host.eq_ignore_ascii_case(bytes)
            || (host.len() > bytes.len()
                && host[host.len() - bytes.len() - 1] == b'.'
                && host[host.len() - bytes.len()..].eq_ignore_ascii_case(bytes))
    })
}

fn evaluate_ascii(text: &str, domains: &[JsString]) -> LinksEvaluationResult {
    let bytes = text.as_bytes();
    let n = bytes.len();
    debug_assert!(text.is_ascii() && n <= ASCII_STACK_LIMIT);
    // Zero means no candidate: a valid match always ends beyond its start.
    let mut terminal = [0usize; ASCII_STACK_LIMIT + 1];
    let mut best = [0usize; ASCII_STACK_LIMIT + 1];
    let mut word_end = n;
    let mut letter_end = n;
    let mut next_space = n;
    for i in (0..n).rev() {
        let byte = bytes[i];
        if ascii_space(byte) {
            next_space = i;
        }
        if byte == b'.' && letter_end.saturating_sub(i + 1) >= 2 {
            terminal[i] = if letter_end < n && bytes[letter_end] == b'/' {
                next_space
            } else {
                letter_end
            };
        }
        if !byte.is_ascii_alphabetic() {
            letter_end = i;
        }
        if !ascii_word(byte) {
            word_end = i;
        } else if word_end < n && bytes[word_end] == b'.' {
            let continued = best[word_end + 1];
            best[i] = if continued != 0 {
                continued
            } else {
                terminal[word_end]
            };
        }
    }
    let mut urls = Vec::new();
    let mut blocked_url = None;
    let mut i = 0;
    while i < n {
        let rest = &bytes[i..];
        let prefix = if ascii_starts(rest, b"https://") {
            8
        } else if ascii_starts(rest, b"http://") {
            7
        } else if ascii_starts(rest, b"www.") {
            4
        } else {
            0
        };
        let prefixed = if prefix != 0 && i + prefix < n && !ascii_space(bytes[i + prefix]) {
            let start = i + prefix;
            Some(
                bytes[start..]
                    .iter()
                    .position(|&b| ascii_space(b))
                    .map_or(n, |offset| start + offset),
            )
        } else {
            None
        };
        let end = prefixed.or_else(|| (best[i] != 0).then_some(best[i]));
        if let Some(end) = end {
            let raw = &bytes[i..end];
            let mut start = if ascii_starts(raw, b"https://") {
                8
            } else if ascii_starts(raw, b"http://") {
                7
            } else {
                0
            };
            if ascii_starts(&raw[start..], b"www.") {
                start += 4;
            }
            let host_end = raw[start..]
                .iter()
                .position(|b| matches!(*b, b'/' | b'?' | b'#' | b':'))
                .map_or(raw.len(), |offset| start + offset);
            let host = &raw[start..host_end];
            if !host.is_empty() && host.contains(&b'.') {
                let blocked = blocked_url.is_none() && !ascii_allowed(host, domains);
                // Matching cannot cross an ASCII/non-ASCII boundary on this
                // path, so the host's ASCII lowercase equals whole-match JS lowercase.
                let host = JsString::from(
                    std::str::from_utf8(host)
                        .expect("ASCII")
                        .to_ascii_lowercase(),
                );
                if blocked {
                    blocked_url = Some(host.clone());
                }
                urls.push(host);
            }
            i = end;
        } else {
            i += 1;
        }
    }
    LinksEvaluationResult {
        triggered: blocked_url.is_some(),
        urls,
        blocked_url,
    }
}

pub fn evaluate_links_rule(
    rule: LinksRule<'_>,
    input: LinksEvaluationInput<'_>,
) -> LinksEvaluationResult {
    let empty = JsString::from_static("");
    let text = input.text.unwrap_or(&empty);
    if let Some(ascii) = text
        .as_str()
        .filter(|s| s.len() <= ASCII_STACK_LIMIT && s.is_ascii())
    {
        return evaluate_ascii(ascii, rule.allowlist_domains.unwrap_or_default());
    }
    let allowlist: Vec<Vec<u16>> = rule
        .allowlist_domains
        .unwrap_or_default()
        .iter()
        .map(|s| js_unicode::lowercase(s).units())
        .collect();
    let text = text.units();
    let mut urls = Vec::new();
    let mut blocked_url = None;
    for (start, end) in matches(&text) {
        let Some(host) = hostname(&text[start..end]) else {
            continue;
        };
        if blocked_url.is_none() {
            let h = host.units();
            let allowed = allowlist.iter().any(|domain| {
                let d = domain.as_slice();
                h.as_slice() == d
                    || (h.len() > d.len()
                        && h.ends_with(d)
                        && h[h.len() - d.len() - 1] == b'.' as u16)
            });
            if !allowed {
                blocked_url = Some(host.clone());
            }
        }
        urls.push(host);
    }
    LinksEvaluationResult {
        triggered: blocked_url.is_some(),
        urls,
        blocked_url,
    }
}
