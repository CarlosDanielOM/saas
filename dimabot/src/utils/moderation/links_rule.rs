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

pub fn evaluate_links_rule(
    rule: LinksRule<'_>,
    input: LinksEvaluationInput<'_>,
) -> LinksEvaluationResult {
    let allowlist: Vec<Vec<u16>> = rule
        .allowlist_domains
        .unwrap_or_default()
        .iter()
        .map(|s| js_unicode::lowercase(s).units())
        .collect();
    let empty = JsString::from_static("");
    let text = input.text.unwrap_or(&empty).units();
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
