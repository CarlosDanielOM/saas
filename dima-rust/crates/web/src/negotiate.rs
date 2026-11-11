//! `Accept` negotiation as `accepts` 1.3 / `negotiator` 0.6.3 do it for `res.format`.

use crate::mediatype::trim_js;

struct Spec {
    kind: String,
    subtype: String,
    params: Vec<(String, String)>,
    q: f64,
    index: usize,
}

#[derive(Clone, Copy)]
struct Priority {
    order: f64,
    q: f64,
    specificity: f64,
    provided: usize,
}

/// Index into `provided` (full media types such as `text/plain`) of the type `req.accepts`
/// picks, or `None` when none is acceptable. A missing or empty `Accept` picks the first.
pub(crate) fn preferred(accept: Option<&str>, provided: &[&str]) -> Option<usize> {
    let Some(accept) = accept.filter(|value| !value.is_empty()) else {
        return if provided.is_empty() { None } else { Some(0) };
    };
    let accepts: Vec<Spec> = split_quoted(accept, ',')
        .iter()
        .enumerate()
        .filter_map(|(i, part)| parse_media_type(trim_js(part), i))
        .collect();
    let mut priorities: Vec<Priority> = provided
        .iter()
        .enumerate()
        .map(|(index, kind)| priority(kind, &accepts, index))
        .filter(|p| p.q > 0.0)
        .collect();
    // Array.prototype.sort is stable; NaN comparisons count as equal.
    priorities.sort_by(|a, b| {
        let diff = js_or(
            js_or(
                js_or(b.q - a.q, b.specificity - a.specificity),
                a.order - b.order,
            ),
            {
                let (a, b) = (a.provided as f64, b.provided as f64);
                a - b
            },
        );
        diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    priorities.first().map(|p| p.provided)
}

/// JavaScript `a || b` on numbers (`0` and `NaN` are falsy).
fn js_or(a: f64, b: f64) -> f64 {
    if a != 0.0 && !a.is_nan() { a } else { b }
}

fn priority(kind: &str, accepts: &[Spec], index: usize) -> Priority {
    let mut best = Priority {
        order: -1.0,
        q: 0.0,
        specificity: 0.0,
        provided: index,
    };
    let Some(provided) = parse_media_type(kind, 0) else {
        return best;
    };
    for spec in accepts {
        let Some(candidate) = specify(&provided, spec, index) else {
            continue;
        };
        let diff = js_or(
            js_or(
                best.specificity - candidate.specificity,
                best.q - candidate.q,
            ),
            best.order - candidate.order,
        );
        if diff < 0.0 {
            best = candidate;
        }
    }
    best
}

fn specify(provided: &Spec, spec: &Spec, index: usize) -> Option<Priority> {
    let mut s = 0.0;
    if spec.kind.to_lowercase() == provided.kind.to_lowercase() {
        s += 4.0;
    } else if spec.kind != "*" {
        return None;
    }
    if spec.subtype.to_lowercase() == provided.subtype.to_lowercase() {
        s += 2.0;
    } else if spec.subtype != "*" {
        return None;
    }
    if !spec.params.is_empty() {
        let all = spec.params.iter().all(|(key, value)| {
            let theirs = provided
                .params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
                .unwrap_or("");
            value == "*" || value.to_lowercase() == theirs.to_lowercase()
        });
        if !all {
            return None;
        }
        s += 1.0;
    }
    Some(Priority {
        order: spec.index as f64,
        q: spec.q,
        specificity: s,
        provided: index,
    })
}

/// `/^\s*([^\s\/;]+)\/([^;\s]+)\s*(?:;(.*))?$/` plus parameter parsing.
fn parse_media_type(value: &str, index: usize) -> Option<Spec> {
    let rest = value.trim_start_matches(crate::mediatype::is_js_whitespace);
    let (head, params) = match rest.split_once(';') {
        Some((head, params)) => (head, Some(params)),
        None => (rest, None),
    };
    let head = head.trim_end_matches(crate::mediatype::is_js_whitespace);
    let (kind, subtype) = head.split_once('/')?;
    let bad = |c: char| crate::mediatype::is_js_whitespace(c) || c == ';';
    if kind.is_empty()
        || kind.contains(bad)
        || kind.contains('/')
        || subtype.is_empty()
        || subtype.contains(bad)
    {
        return None;
    }
    let mut spec = Spec {
        kind: kind.to_owned(),
        subtype: subtype.to_owned(),
        params: Vec::new(),
        q: 1.0,
        index,
    };
    if let Some(params) = params {
        for pair in split_quoted(params, ';') {
            let pair = trim_js(&pair).to_owned();
            let (key, value) = match pair.split_once('=') {
                Some((k, v)) => (k.to_lowercase(), Some(v.to_owned())),
                None => (pair.to_lowercase(), None),
            };
            let value = value.map(|v| {
                if v.starts_with('"') && v.ends_with('"') {
                    v.get(1..v.len().saturating_sub(1)).unwrap_or("").to_owned()
                } else {
                    v
                }
            });
            if key == "q" {
                spec.q = value.as_deref().map(js_parse_float).unwrap_or(f64::NAN);
                break;
            }
            spec.params.push((key, value.unwrap_or_default()));
        }
    }
    Some(spec)
}

/// Splits on `separator`, re-joining pieces while a piece holds an odd number of quotes.
fn split_quoted(value: &str, separator: char) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in value.split(separator) {
        match out.last_mut() {
            Some(last) if last.matches('"').count() % 2 == 1 => {
                last.push(separator);
                last.push_str(piece);
            }
            _ => out.push(piece.to_owned()),
        }
    }
    out
}

/// JavaScript `parseFloat`: the longest numeric prefix after leading whitespace, or NaN.
fn js_parse_float(value: &str) -> f64 {
    let s = value.trim_start_matches(crate::mediatype::is_js_whitespace);
    let bytes = s.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if s.get(end..)
        .is_some_and(|rest| rest.starts_with("Infinity"))
    {
        return if bytes.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits_start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let mut mantissa_digits = end - digits_start;
    if bytes.get(end) == Some(&b'.') {
        let mut after = end + 1;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        mantissa_digits += after - end - 1;
        if mantissa_digits > 0 {
            end = after;
        }
    }
    if mantissa_digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut after = end + 1;
        if matches!(bytes.get(after), Some(b'+' | b'-')) {
            after += 1;
        }
        let exp_start = after;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        if after > exp_start {
            end = after;
        }
    }
    s.get(..end)
        .and_then(|n| n.parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPES: [&str; 2] = ["text/plain", "text/html"];

    #[test]
    fn picks_like_accepts() {
        assert_eq!(preferred(None, &TYPES), Some(0));
        assert_eq!(preferred(Some(""), &TYPES), Some(0));
        assert_eq!(preferred(Some("*/*"), &TYPES), Some(0));
        assert_eq!(preferred(Some("text/html"), &TYPES), Some(1));
        assert_eq!(
            preferred(
                Some("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                &TYPES
            ),
            Some(1)
        );
        assert_eq!(preferred(Some("application/json"), &TYPES), None);
        assert_eq!(
            preferred(Some("text/*;q=0.5, text/html;q=0.4"), &TYPES),
            Some(0)
        );
        assert_eq!(preferred(Some("text/plain;q=0, */*"), &TYPES), Some(1));
    }

    #[test]
    fn parses_floats_like_javascript() {
        assert_eq!(js_parse_float("0.5"), 0.5);
        assert_eq!(js_parse_float(" 1e1x"), 10.0);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert!(js_parse_float("x").is_nan());
        assert!(js_parse_float(".").is_nan());
    }
}
