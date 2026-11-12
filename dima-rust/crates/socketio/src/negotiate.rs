//! `accepts(req).encodings(provided)` of `accepts` 1.3.8 over `negotiator` 0.6.3
//! (`lib/encoding.js`): which content coding to use for a response, or none.
//!
//! The reference uses it twice: Engine.IO picks `gzip` or `deflate` for polling responses of 1024
//! bytes or more, and Socket.IO picks `br`, `gzip` or `deflate` for the client files.

/// One entry of `Accept-Encoding`.
struct Spec<'a> {
    encoding: &'a str,
    q: f64,
    /// Position in the header.
    index: usize,
}

/// The priority of one provided encoding (`getEncodingPriority`).
#[derive(Clone, Copy)]
struct Priority {
    q: f64,
    s: u8,
    o: i64,
    i: usize,
}

/// The preferred encoding among `provided`, or `None` (`encodings(provided)[0] || false`).
pub fn preferred<'p>(accept: Option<&str>, provided: &[&'p str]) -> Option<&'p str> {
    let accepts = parse(accept.unwrap_or(""));
    let mut priorities: Vec<(Priority, &'p str)> = provided
        .iter()
        .enumerate()
        .map(|(index, encoding)| (priority(encoding, &accepts, index), *encoding))
        .filter(|(priority, _)| priority.q > 0.0)
        .collect();
    // `compareSpecs`: q descending, then specificity, then header order, then provided order.
    // NaN comparisons are false in JavaScript; a NaN q never passes the filter above.
    priorities.sort_by(|(a, _), (b, _)| {
        b.q.partial_cmp(&a.q)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.s.cmp(&a.s))
            .then(a.o.cmp(&b.o))
            .then(a.i.cmp(&b.i))
    });
    priorities.first().map(|(_, encoding)| *encoding)
}

/// `parseAcceptEncoding`, including the implicit `identity` at the lowest quality.
fn parse(accept: &str) -> Vec<Spec<'_>> {
    let parts: Vec<&str> = accept.split(',').collect();
    let mut specs = Vec::with_capacity(parts.len() + 1);
    let mut has_identity = false;
    let mut min_quality: f64 = 1.0;
    for (index, part) in parts.iter().enumerate() {
        if let Some(spec) = parse_one(dima_text::trim(part), index) {
            has_identity = has_identity || spec.encoding.eq_ignore_ascii_case("identity");
            // `encoding.q || 1`: a q of 0 (or NaN) counts as 1 here.
            let q = if spec.q == 0.0 || spec.q.is_nan() {
                1.0
            } else {
                spec.q
            };
            min_quality = min_quality.min(q);
            specs.push(spec);
        }
    }
    if !has_identity {
        specs.push(Spec {
            encoding: "identity",
            q: min_quality,
            index: parts.len(),
        });
    }
    specs
}

/// `/^\s*([^\s;]+)\s*(?:;(.*))?$/` and the `q` parameter.
fn parse_one(text: &str, index: usize) -> Option<Spec<'_>> {
    let text = dima_text::trim(text);
    let end = text
        .find(|c: char| c == ';' || dima_text::is_js_whitespace(c))
        .unwrap_or(text.len());
    let encoding = text.get(..end).filter(|e| !e.is_empty())?;
    let rest = dima_text::trim_start(text.get(end..).unwrap_or_default());
    let mut q = 1.0;
    if !rest.is_empty() {
        // After the token only whitespace, then optionally `;params`.
        let params = rest.strip_prefix(';')?;
        for param in params.split(';') {
            let mut pair = dima_text::trim(param).split('=');
            if pair.next() == Some("q") {
                q = dima_text::parse_float(pair.next().unwrap_or(""));
                break;
            }
        }
    }
    Some(Spec { encoding, q, index })
}

/// `getEncodingPriority` with `specify`.
fn priority(encoding: &str, accepts: &[Spec<'_>], index: usize) -> Priority {
    let mut best = Priority {
        q: 0.0,
        s: 0,
        o: -1,
        i: index,
    };
    for spec in accepts {
        let s = if spec.encoding.eq_ignore_ascii_case(encoding) {
            1
        } else if spec.encoding == "*" {
            0
        } else {
            continue;
        };
        let candidate = Priority {
            q: spec.q,
            s,
            o: i64::try_from(spec.index).unwrap_or(i64::MAX),
            i: index,
        };
        // `(priority.s - spec.s || priority.q - spec.q || priority.o - spec.o) < 0`
        let ds = i64::from(best.s) - i64::from(candidate.s);
        let better = if ds != 0 {
            ds < 0
        } else {
            let dq = best.q - candidate.q;
            if dq != 0.0 && !dq.is_nan() {
                dq < 0.0
            } else {
                best.o - candidate.o < 0
            }
        };
        if better {
            best = candidate;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::preferred;

    const CLIENT: [&str; 3] = ["br", "gzip", "deflate"];
    const POLLING: [&str; 2] = ["gzip", "deflate"];

    #[test]
    fn picks_like_negotiator() {
        assert_eq!(preferred(None, &CLIENT), None);
        assert_eq!(preferred(Some(""), &CLIENT), None);
        assert_eq!(preferred(Some("identity"), &CLIENT), None);
        // Browsers: equal q, header order decides.
        assert_eq!(
            preferred(Some("gzip, deflate, br, zstd"), &CLIENT),
            Some("gzip")
        );
        assert_eq!(preferred(Some("br, gzip"), &CLIENT), Some("br"));
        assert_eq!(preferred(Some("deflate, gzip"), &POLLING), Some("deflate"));
        assert_eq!(preferred(Some("gzip;q=0.5, br"), &CLIENT), Some("br"));
        assert_eq!(preferred(Some("gzip;q=0"), &CLIENT), None);
        assert_eq!(preferred(Some("*"), &CLIENT), Some("br"));
        assert_eq!(
            preferred(Some("*;q=0.1, gzip;q=0.2"), &CLIENT),
            Some("gzip")
        );
        assert_eq!(preferred(Some("*, gzip;q=0"), &CLIENT), Some("br"));
        assert_eq!(preferred(Some("GZIP"), &POLLING), Some("gzip"));
        assert_eq!(preferred(Some("br"), &POLLING), None);
        assert_eq!(preferred(Some("gzip;q=abc"), &POLLING), None);
        assert_eq!(
            preferred(Some("gzip ;q=0.8, deflate;q=0.9"), &POLLING),
            Some("deflate")
        );
        assert_eq!(preferred(Some("gzip x"), &POLLING), None);
        assert_eq!(preferred(Some(" , gzip"), &POLLING), Some("gzip"));
    }
}
