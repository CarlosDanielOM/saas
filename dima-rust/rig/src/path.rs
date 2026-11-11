//! Paths into a capture (`steps[0].body.items[2].name`, `mongo.items[1].qty`,
//! `dragonfly["item:<oid:1>"].ttl`) and the patterns allowances use to address them.
//!
//! Pattern syntax: the same as a rendered path, plus `[*]` (any index), `*` as a whole
//! segment (any one key or index), `**` as a whole segment (any number of segments, including
//! none), and `*` inside a key (`created*`, `["timer:*"]`) matching any run of characters.
//! Inside a quoted segment, `\\*` (JSON-escaped backslash, then star) is a literal star.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Path(pub Vec<Seg>);

impl Path {
    pub fn root(first: &str) -> Self {
        Path(vec![Seg::Key(first.to_string())])
    }

    pub fn push_key(&mut self, k: impl Into<String>) {
        self.0.push(Seg::Key(k.into()));
    }

    pub fn push_index(&mut self, i: usize) {
        self.0.push(Seg::Index(i));
    }

    pub fn pop(&mut self) {
        self.0.pop();
    }

    pub fn with_key(&self, k: impl Into<String>) -> Path {
        let mut p = self.clone();
        p.push_key(k);
        p
    }

    pub fn with_index(&self, i: usize) -> Path {
        let mut p = self.clone();
        p.push_index(i);
        p
    }
}

/// A key that can be written as `.key` rather than `["key"]`.
fn is_plain_key(k: &str) -> bool {
    !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

fn quote(k: &str) -> String {
    serde_json::to_string(k).unwrap_or_else(|_| format!("\"{k}\""))
}

impl fmt::Display for Path {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, seg) in self.0.iter().enumerate() {
            match seg {
                Seg::Key(k) if is_plain_key(k) => {
                    if i > 0 {
                        f.write_str(".")?;
                    }
                    f.write_str(k)?;
                }
                Seg::Key(k) => write!(f, "[{}]", quote(k))?,
                Seg::Index(n) => write!(f, "[{n}]")?,
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum GlobPart {
    Lit(String),
    Star,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Glob(Vec<GlobPart>);

impl Glob {
    fn parse(raw: &str, star_escapes: bool) -> Glob {
        let mut parts = Vec::new();
        let mut lit = String::new();
        let mut chars = raw.chars().peekable();
        while let Some(c) = chars.next() {
            if star_escapes && c == '\\' && chars.peek() == Some(&'*') {
                lit.push('*');
                chars.next();
            } else if c == '*' {
                if !lit.is_empty() {
                    parts.push(GlobPart::Lit(std::mem::take(&mut lit)));
                }
                if parts.last() != Some(&GlobPart::Star) {
                    parts.push(GlobPart::Star);
                }
            } else {
                lit.push(c);
            }
        }
        if !lit.is_empty() {
            parts.push(GlobPart::Lit(lit));
        }
        Glob(parts)
    }

    fn matches(&self, s: &str) -> bool {
        glob_match(&self.0, s)
    }
}

fn glob_match(parts: &[GlobPart], s: &str) -> bool {
    match parts.split_first() {
        None => s.is_empty(),
        Some((GlobPart::Lit(l), rest)) => s.strip_prefix(l.as_str()).is_some_and(|tail| glob_match(rest, tail)),
        Some((GlobPart::Star, rest)) => {
            if rest.is_empty() {
                return true;
            }
            let mut tail = s;
            loop {
                if glob_match(rest, tail) {
                    return true;
                }
                let mut it = tail.chars();
                if it.next().is_none() {
                    return false;
                }
                tail = it.as_str();
            }
        }
    }
}

/// Glob matching for names (Dragonfly keys, header names, collection names): `*` any run, `?` one character.
pub fn name_glob(pattern: &str, s: &str) -> bool {
    fn go(p: &[char], s: &[char]) -> bool {
        match p.split_first() {
            None => s.is_empty(),
            Some(('*', rest)) => (0..=s.len()).any(|i| s.get(i..).is_some_and(|t| go(rest, t))),
            Some(('?', rest)) => s.split_first().is_some_and(|(_, t)| go(rest, t)),
            Some((c, rest)) => s.split_first().is_some_and(|(h, t)| h == c && go(rest, t)),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = s.chars().collect();
    go(&p, &s)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PatSeg {
    Key(Glob),
    Index(usize),
    AnyIndex,
    AnyOne,
    AnyDepth,
}

#[derive(Clone, Debug)]
pub struct Pattern {
    segs: Vec<PatSeg>,
    source: String,
}

impl Pattern {
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn parse(src: &str) -> Result<Pattern, String> {
        let chars: Vec<char> = src.chars().collect();
        let mut segs = Vec::new();
        let mut i = 0;
        let err = |msg: &str, at: usize| format!("bad path `{src}` at character {}: {msg}", at + 1);
        let mut first = true;
        while i < chars.len() {
            let c = chars.get(i).copied().unwrap_or('\0');
            if c == '[' {
                let close = find_bracket_end(&chars, i).ok_or_else(|| err("unclosed `[`", i))?;
                let inner: String = chars.get(i + 1..close).unwrap_or(&[]).iter().collect();
                let inner_t = inner.trim();
                if inner_t == "*" {
                    segs.push(PatSeg::AnyIndex);
                } else if inner_t.starts_with('"') {
                    let key: String =
                        serde_json::from_str(inner_t).map_err(|e| err(&format!("bad quoted key: {e}"), i))?;
                    segs.push(PatSeg::Key(Glob::parse(&key, true)));
                } else {
                    let n: usize = inner_t
                        .parse()
                        .map_err(|_| err("expected a number, `*` or a quoted key inside `[...]`", i))?;
                    segs.push(PatSeg::Index(n));
                }
                i = close + 1;
                first = false;
                continue;
            }
            if !first {
                if c != '.' {
                    return Err(err("expected `.` or `[`", i));
                }
                i += 1;
            }
            let start = i;
            while i < chars.len() && !matches!(chars.get(i), Some('.' | '[')) {
                if matches!(chars.get(i), Some(']' | '"')) {
                    return Err(err("unexpected character in a key; quote it as [\"...\"]", i));
                }
                i += 1;
            }
            let key: String = chars.get(start..i).unwrap_or(&[]).iter().collect();
            if key.is_empty() {
                return Err(err("empty key", start));
            }
            segs.push(match key.as_str() {
                "**" => PatSeg::AnyDepth,
                "*" => PatSeg::AnyOne,
                _ => PatSeg::Key(Glob::parse(&key, false)),
            });
            first = false;
        }
        if segs.is_empty() {
            return Err(format!("bad path `{src}`: empty"));
        }
        Ok(Pattern { segs, source: src.to_string() })
    }

    /// The pattern matches this exact path.
    pub fn matches(&self, path: &Path) -> bool {
        match_segs(&self.segs, &path.0, false)
    }

    /// The pattern matches this path or one of its ancestors.
    pub fn matches_self_or_ancestor(&self, path: &Path) -> bool {
        match_segs(&self.segs, &path.0, true)
    }

    /// Fixed segments only (used to read a value out of a response for `save`).
    pub fn literal_segments(&self) -> Option<Vec<Seg>> {
        self.segs
            .iter()
            .map(|s| match s {
                PatSeg::Index(n) => Some(Seg::Index(*n)),
                PatSeg::Key(Glob(parts)) => match parts.as_slice() {
                    [GlobPart::Lit(l)] => Some(Seg::Key(l.clone())),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }
}

fn find_bracket_end(chars: &[char], open: usize) -> Option<usize> {
    let mut i = open + 1;
    let mut in_str = false;
    while let Some(&c) = chars.get(i) {
        if in_str {
            if c == '\\' {
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
        } else if c == ']' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn seg_matches(p: &PatSeg, s: &Seg) -> bool {
    match (p, s) {
        (PatSeg::AnyOne, _) => true,
        (PatSeg::AnyIndex, Seg::Index(_)) => true,
        (PatSeg::Index(a), Seg::Index(b)) => a == b,
        (PatSeg::Key(g), Seg::Key(k)) => g.matches(k),
        _ => false,
    }
}

fn match_segs(pat: &[PatSeg], path: &[Seg], allow_prefix: bool) -> bool {
    match pat.split_first() {
        None => path.is_empty() || allow_prefix,
        Some((PatSeg::AnyDepth, rest)) => (0..=path.len()).any(|skip| match_segs(rest, path.get(skip..).unwrap_or(&[]), allow_prefix)),
        Some((p, rest)) => match path.split_first() {
            None => false,
            Some((s, tail)) => seg_matches(p, s) && match_segs(rest, tail, allow_prefix),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(segs: &[Seg]) -> Path {
        Path(segs.to_vec())
    }

    fn k(s: &str) -> Seg {
        Seg::Key(s.to_string())
    }

    #[test]
    fn renders_plain_and_quoted_keys() {
        let p = path(&[k("mongo"), k("items"), Seg::Index(2), k("qty")]);
        assert_eq!(p.to_string(), "mongo.items[2].qty");
        let p = path(&[k("dragonfly"), k("item:<oid:1>"), k("ttl")]);
        assert_eq!(p.to_string(), "dragonfly[\"item:<oid:1>\"].ttl");
        let p = path(&[k("steps"), Seg::Index(0), k("body"), k("ñandú"), k("🍕 pizza")]);
        assert_eq!(p.to_string(), "steps[0].body.ñandú[\"🍕 pizza\"]");
    }

    #[test]
    fn patterns_round_trip_rendered_paths() {
        let p = path(&[k("dragonfly"), k("item:<oid:1>"), k("ttl")]);
        assert!(Pattern::parse(&p.to_string()).unwrap().matches(&p));
        let p = path(&[k("steps"), Seg::Index(0), k("body"), k("🍕 pizza")]);
        assert!(Pattern::parse(&p.to_string()).unwrap().matches(&p));
    }

    #[test]
    fn wildcards() {
        let doc = path(&[k("mongo"), k("items"), Seg::Index(3), k("createdAt")]);
        assert!(Pattern::parse("mongo.items[*].createdAt").unwrap().matches(&doc));
        assert!(Pattern::parse("mongo.*[*].created*").unwrap().matches(&doc));
        assert!(Pattern::parse("**.createdAt").unwrap().matches(&doc));
        assert!(Pattern::parse("mongo.**").unwrap().matches(&doc));
        assert!(!Pattern::parse("mongo.items[2].createdAt").unwrap().matches(&doc));
        assert!(!Pattern::parse("mongo.items.createdAt").unwrap().matches(&doc));
        let key = path(&[k("dragonfly"), k("timer:<oid:1>:lock"), k("ttl")]);
        assert!(Pattern::parse("dragonfly[\"timer:*\"].ttl").unwrap().matches(&key));
        assert!(!Pattern::parse("dragonfly[\"timer:\\\\*\"].ttl").unwrap().matches(&key));
        let star = path(&[k("dragonfly"), k("a*b"), k("ttl")]);
        assert!(Pattern::parse("dragonfly[\"a\\\\*b\"].ttl").unwrap().matches(&star));
    }

    #[test]
    fn ancestor_matching() {
        let deep = path(&[k("dragonfly"), k("x"), k("value"), k("a")]);
        assert!(Pattern::parse("dragonfly").unwrap().matches_self_or_ancestor(&deep));
        assert!(!Pattern::parse("dragonfly").unwrap().matches(&deep));
        assert!(!Pattern::parse("mongo").unwrap().matches_self_or_ancestor(&deep));
    }

    #[test]
    fn parse_errors_are_specific() {
        assert!(Pattern::parse("mongo.items[").unwrap_err().contains("unclosed"));
        assert!(Pattern::parse("mongo..x").unwrap_err().contains("empty key"));
        assert!(Pattern::parse("mongo[x]").unwrap_err().contains("expected a number"));
        assert!(Pattern::parse("").is_err());
    }

    #[test]
    fn name_globs() {
        assert!(name_glob("item:*", "item:65f0"));
        assert!(name_glob("access-control-*", "access-control-allow-origin"));
        assert!(name_glob("a?c", "a🍕c"));
        assert!(!name_glob("item:*", "items:1"));
    }

    #[test]
    fn literal_segments_for_save() {
        let p = Pattern::parse("body.items[0].id").unwrap();
        assert_eq!(p.literal_segments().unwrap(), vec![k("body"), k("items"), Seg::Index(0), k("id")]);
        assert!(Pattern::parse("body.*").unwrap().literal_segments().is_none());
    }
}
