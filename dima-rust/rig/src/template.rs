//! Two small template languages.
//!
//! - Target files: `{name}` placeholders (`{port}`, `{mongo_uri}`, `{var.fixture}` ...); `{{` and
//!   `}}` are literal braces.
//! - Scenario strings: `${name}` inserts a value saved by an earlier step, `${now_ms}`,
//!   `${now_s}` and `${now_iso}` insert the current time, optionally shifted (`${now_ms+60s}`).
//!   `$${` is a literal `${`.

use std::collections::BTreeMap;

use crate::timefmt;

/// Render a target template. Unknown placeholders are errors that list the known names.
pub fn render(tpl: &str, vars: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = String::new();
    for piece in braces(tpl)? {
        match piece {
            Brace::Lit(s) => out.push_str(&s),
            Brace::Var(name) => match vars.get(&name) {
                Some(v) => out.push_str(v),
                None => {
                    let known: Vec<&str> = vars.keys().map(String::as_str).collect();
                    return Err(format!("unknown placeholder {{{name}}} in `{tpl}`; known: {}", known.join(", ")));
                }
            },
        }
    }
    Ok(out)
}

/// The placeholder names a target template uses.
pub fn placeholders(tpl: &str) -> Result<Vec<String>, String> {
    Ok(braces(tpl)?
        .into_iter()
        .filter_map(|p| match p {
            Brace::Var(n) => Some(n),
            Brace::Lit(_) => None,
        })
        .collect())
}

enum Brace {
    Lit(String),
    Var(String),
}

fn braces(tpl: &str) -> Result<Vec<Brace>, String> {
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut chars = tpl.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                lit.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                lit.push('}');
            }
            '{' => {
                let mut name = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some(c) if c.is_alphanumeric() || matches!(c, '_' | '.' | '-') => name.push(c),
                        Some(c) => return Err(format!("unexpected `{c}` inside a placeholder in `{tpl}` (write `{{{{` for a literal brace)")),
                        None => return Err(format!("unclosed placeholder in `{tpl}`")),
                    }
                }
                if name.is_empty() {
                    return Err(format!("empty placeholder `{{}}` in `{tpl}`"));
                }
                if !lit.is_empty() {
                    out.push(Brace::Lit(std::mem::take(&mut lit)));
                }
                out.push(Brace::Var(name));
            }
            '}' => return Err(format!("unmatched `}}` in `{tpl}` (write `}}}}` for a literal brace)")),
            c => lit.push(c),
        }
    }
    if !lit.is_empty() {
        out.push(Brace::Lit(lit));
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NowFmt {
    Ms,
    S,
    Iso,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    Lit(String),
    Saved(String),
    Now { offset_ms: i64, fmt: NowFmt },
}

/// Parse a scenario string into literal pieces and `${...}` expressions.
pub fn parse_interp(s: &str) -> Result<Vec<Piece>, String> {
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut rest = s;
    while let Some(pos) = rest.find('$') {
        let (before, after) = rest.split_at(pos);
        lit.push_str(before);
        if let Some(tail) = after.strip_prefix("$${") {
            lit.push_str("${");
            rest = tail;
        } else if let Some(tail) = after.strip_prefix("${") {
            let end = tail.find('}').ok_or_else(|| format!("unclosed `${{` in `{s}`"))?;
            let (expr, tail2) = tail.split_at(end);
            if !lit.is_empty() {
                out.push(Piece::Lit(std::mem::take(&mut lit)));
            }
            out.push(parse_expr(expr).map_err(|e| format!("{e} in `{s}`"))?);
            rest = tail2.strip_prefix('}').unwrap_or(tail2);
        } else {
            lit.push('$');
            rest = after.strip_prefix('$').unwrap_or(after);
        }
    }
    lit.push_str(rest);
    if !lit.is_empty() {
        out.push(Piece::Lit(lit));
    }
    Ok(out)
}

fn parse_expr(expr: &str) -> Result<Piece, String> {
    let e = expr.trim();
    for (name, fmt) in [("now_ms", NowFmt::Ms), ("now_s", NowFmt::S), ("now_iso", NowFmt::Iso)] {
        if let Some(rest) = e.strip_prefix(name) {
            if rest.is_empty() {
                return Ok(Piece::Now { offset_ms: 0, fmt });
            }
            if rest.starts_with('+') || rest.starts_with('-') {
                let offset_ms = timefmt::parse_offset(rest).ok_or_else(|| format!("bad offset `{rest}` (use +60s, -5m, 150ms, +2d)"))?;
                return Ok(Piece::Now { offset_ms, fmt });
            }
        }
    }
    let mut chars = e.chars();
    let ok_first = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if !ok_first || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') || e.starts_with("now") {
        return Err(format!(
            "bad expression `${{{expr}}}`: use a saved name (letters, digits, _) or now_ms / now_s / now_iso with an optional offset such as +60s"
        ));
    }
    Ok(Piece::Saved(e.to_string()))
}

/// Names of saved values a scenario string refers to.
pub fn saved_names(s: &str) -> Result<Vec<String>, String> {
    Ok(parse_interp(s)?
        .into_iter()
        .filter_map(|p| match p {
            Piece::Saved(n) => Some(n),
            _ => None,
        })
        .collect())
}

/// Format the time `now + offset` the way a `$rigNow` value or `${now_*}` asks for.
pub fn format_now(now_ms: i64, offset_ms: i64, fmt: NowFmt) -> String {
    let t = now_ms + offset_ms;
    match fmt {
        NowFmt::Ms => t.to_string(),
        NowFmt::S => t.div_euclid(1000).to_string(),
        NowFmt::Iso => timefmt::format_iso_ms(t).unwrap_or_else(|| t.to_string()),
    }
}

/// Fill in a scenario string.
pub fn interpolate(s: &str, saved: &BTreeMap<String, String>, now_ms: i64) -> Result<String, String> {
    let mut out = String::new();
    for p in parse_interp(s)? {
        match p {
            Piece::Lit(l) => out.push_str(&l),
            Piece::Saved(n) => match saved.get(&n) {
                Some(v) => out.push_str(v),
                None => return Err(format!("`${{{n}}}` has no saved value (save it in an earlier step with \"save\")")),
            },
            Piece::Now { offset_ms, fmt } => out.push_str(&format_now(now_ms, offset_ms, fmt)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn target_templates() {
        let v = vars(&[("port", "4100"), ("var.fixture", "/bin/fx")]);
        assert_eq!(render("http://127.0.0.1:{port}/x", &v).unwrap(), "http://127.0.0.1:4100/x");
        assert_eq!(render("{var.fixture}", &v).unwrap(), "/bin/fx");
        assert_eq!(render("{{literal}} {port}", &v).unwrap(), "{literal} 4100");
        let e = render("{prot}", &v).unwrap_err();
        assert!(e.contains("unknown placeholder {prot}") && e.contains("port"), "{e}");
        assert!(render("{port", &v).is_err());
        assert!(render("a}b", &v).is_err());
        assert_eq!(placeholders("{a}-{b.c}").unwrap(), vec!["a", "b.c"]);
    }

    #[test]
    fn scenario_interpolation() {
        let saved = vars(&[("item_id", "65f0"), ("ñ", "x")]);
        assert_eq!(interpolate("/items/${item_id}", &saved, 0).unwrap(), "/items/65f0");
        assert_eq!(interpolate("cost $5 and $${literal}", &saved, 0).unwrap(), "cost $5 and ${literal}");
        assert_eq!(interpolate("${now_ms+60s}", &saved, 1000).unwrap(), "61000");
        assert_eq!(interpolate("${now_s-1s}", &saved, 5500).unwrap(), "4");
        assert_eq!(interpolate("${now_iso}", &saved, 0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert!(interpolate("${missing}", &saved, 0).unwrap_err().contains("no saved value"));
        assert!(parse_interp("${now_ms+5w}").is_err());
        assert!(parse_interp("${ñ}").is_err());
        assert!(parse_interp("${now}").is_err());
        assert!(parse_interp("${oops").is_err());
        assert_eq!(saved_names("/a/${x}/${now_ms}/${y}").unwrap(), vec!["x", "y"]);
    }
}
