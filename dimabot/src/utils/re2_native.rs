//! Experimental node-re2 adapter for the non-global `u`/`iu` exec path.
//! See migration-notes/re2-native-handoff.md before adopting this module.
//!
//! SDK preprocessing and native syntax/class/repetition policies are adapted
//! from node-re2 1.27.0 `lib/pattern.cc` (copyright Eugene Lazutkin and
//! contributors) and RE2 `re2/parse.cc` (copyright The RE2 Authors). Both are
//! BSD-3-Clause; retained notices and full license terms are in
//! `tests/fixtures/re2-source-licenses/node-re2-BSD-3-Clause.txt` and
//! `tests/fixtures/re2-source-licenses/RE2-BSD-3-Clause.txt`. Pinned-source
//! provenance and verification limits are recorded in the handoff note.

use super::{js_string::JsString, re2_string, re2_unicode, re2_unicode_data};
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
        let runes = sdk_pattern(source)?;
        let translated = Parser::new(runes, ignore_case).parse()?;
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

// Keep raw runes, including surrogate values, until emission. A placeholder
// scalar changes range ordering and can make [a-<surrogate>] match astral text.
const MAX_RUNE: u32 = 0x10ffff;
type Range = (u32, u32);

#[derive(Clone, Debug, Default)]
struct RuneSet(Vec<Range>);
impl RuneSet {
    fn new(ranges: impl IntoIterator<Item = Range>) -> Self {
        let mut ranges: Vec<_> = ranges.into_iter().collect();
        ranges.sort_unstable();
        let mut merged: Vec<Range> = Vec::new();
        for (lo, hi) in ranges {
            if let Some(last) = merged.last_mut()
                && lo <= last.1 + 1
            {
                last.1 = last.1.max(hi);
            } else {
                merged.push((lo, hi));
            }
        }
        Self(merged)
    }
    fn contains(&self, cp: u32) -> bool {
        let i = self.0.partition_point(|&(_, hi)| hi < cp);
        self.0.get(i).is_some_and(|&(lo, _)| lo <= cp)
    }
    fn complement(&self) -> Self {
        let mut result = Vec::new();
        let mut cursor = 0;
        for &(lo, hi) in &self.0 {
            if cursor < lo {
                result.push((cursor, lo - 1));
            }
            cursor = hi + 1;
        }
        if cursor <= MAX_RUNE {
            result.push((cursor, MAX_RUNE));
        }
        Self(result)
    }
    fn folded(mut self, insensitive: bool) -> Self {
        if insensitive {
            let mut extra = Vec::new();
            // Enumerate only mapped fold-table entries, never the full scalar
            // domain and never engine matches. The fixed pinned table bounds
            // this work independently of a class range's numeric width.
            for &(lo, hi, _) in re2_unicode_data::CASE_FOLD {
                for cp in lo..=hi {
                    if self.contains(cp) {
                        extra.extend(re2_unicode::equivalents(cp).map(|cp| (cp, cp)));
                    }
                }
            }
            self.0.extend(extra);
            self = Self::new(self.0);
        }
        self
    }
    fn emit(&self) -> String {
        let mut out = String::from("[");
        let mut any = false;
        for &(lo, hi) in &self.0 {
            // Surrogate rune atoms are accepted by native RE2, but cannot be
            // present in the SDK string-input UTF-8 matcher. Clip only here.
            for (start, end) in [(lo, hi.min(0xd7ff)), (lo.max(0xe000), hi)] {
                if start <= end {
                    emit_range(&mut out, start, end);
                    any = true;
                }
            }
        }
        if !any {
            out.push_str("a&&[^a]");
        }
        out.push(']');
        out
    }
}
fn emit_range(out: &mut String, lo: u32, hi: u32) {
    use std::fmt::Write;
    let _ = write!(out, "\\x{{{lo:x}}}");
    if lo != hi {
        let _ = write!(out, "-\\x{{{hi:x}}}");
    }
}
fn error(message: &str) -> CompileError {
    CompileError(message.into())
}
fn ascii(cp: u32) -> Option<char> {
    (cp < 128).then_some(cp as u8 as char)
}
fn text(runes: &[u32]) -> Result<String, CompileError> {
    runes
        .iter()
        .map(|&cp| char::from_u32(cp).ok_or_else(|| error("invalid name")))
        .collect()
}
fn hex(cp: u32) -> Option<u32> {
    ascii(cp)?.to_digit(16)
}
fn push_text(out: &mut Vec<u32>, value: &str) {
    out.extend(value.chars().map(u32::from));
}

// node-re2's lib/pattern.cc runs before native parsing, even inside \Q...\E.
// In particular, binary/scx negation inside a class expands the complement
// before native folding; native \P folds its positive group before negation.
fn sdk_pattern(source: &JsString) -> Result<Vec<u32>, CompileError> {
    let runes: Vec<u32> = char::decode_utf16(source.code_units())
        .map(|r| r.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from))
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut in_class = false;
    while i < runes.len() {
        let cp = runes[i];
        if cp == u32::from(b'\\') && i + 1 < runes.len() {
            let next = runes[i + 1];
            if next == u32::from(b'c')
                && runes
                    .get(i + 2)
                    .and_then(|&cp| ascii(cp))
                    .is_some_and(|c| c.is_ascii_uppercase())
            {
                push_text(&mut out, &format!("\\x{:02X}", runes[i + 2] - 64));
                i += 3;
                continue;
            }
            if next == u32::from(b'u') {
                if runes.get(i + 2).and_then(|&cp| hex(cp)).is_some() {
                    let start = i + 2;
                    let mut end = start;
                    while end < runes.len() && end < start + 4 && hex(runes[end]).is_some() {
                        end += 1;
                    }
                    push_text(&mut out, "\\x{");
                    out.extend_from_slice(&runes[start..end]);
                    out.push(u32::from(b'}'));
                    i = end;
                    continue;
                }
                if runes.get(i + 2) == Some(&u32::from(b'{')) {
                    push_text(&mut out, "\\x");
                    i += 2;
                    continue;
                }
            }
            if matches!(ascii(next), Some('p' | 'P'))
                && runes.get(i + 2) == Some(&u32::from(b'{'))
                && let Some(end) = (i + 3..runes.len()).find(|&j| runes[j] == u32::from(b'}'))
            {
                let Ok(name) = text(&runes[i + 3..end]) else {
                    out.extend_from_slice(&runes[i..=end]);
                    i = end + 1;
                    continue;
                };
                let resolved = re2_unicode::resolve_braced(&name);
                if let Some(resolved) =
                    resolved.filter(|r| r.property.namespace != re2_unicode::Namespace::Builtin)
                {
                    let negative = next == u32::from(b'P');
                    let mut set = RuneSet::new(resolved.property.ranges.iter().copied());
                    if in_class && negative {
                        set = set.complement();
                    }
                    let mut expanded = String::new();
                    if !in_class {
                        expanded.push('[');
                        if negative {
                            expanded.push('^');
                        }
                    }
                    for (lo, hi) in set.0 {
                        use std::fmt::Write;
                        let _ = write!(expanded, "\\x{{{lo:X}}}");
                        if lo != hi {
                            let _ = write!(expanded, "-\\x{{{hi:X}}}");
                        }
                    }
                    if !in_class {
                        expanded.push(']');
                    }
                    push_text(&mut out, &expanded);
                } else {
                    // Preserve the wrapper's spelling as well as its meaning:
                    // quoted spans see these rewritten escapes as literal text.
                    let strip = |name: &str, prefix: &str| {
                        name.strip_prefix(prefix)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    };
                    let mut name = strip(&name, "General_Category=")
                        .or_else(|| strip(&name, "gc="))
                        .unwrap_or(name);
                    if let Ok(alias) = re2_unicode_data::CATEGORY_ALIASES
                        .binary_search_by_key(&name.as_str(), |&(key, _)| key)
                    {
                        name = re2_unicode_data::CATEGORY_ALIASES[alias].1.into();
                    } else {
                        name = strip(&name, "Script=")
                            .or_else(|| strip(&name, "sc="))
                            .unwrap_or(name);
                    }
                    out.extend([u32::from(b'\\'), next]);
                    if name.len() != 1 {
                        out.push(u32::from(b'{'));
                    }
                    push_text(&mut out, &name);
                    if name.len() != 1 {
                        out.push(u32::from(b'}'));
                    }
                }
                i = end + 1;
                continue;
            }
            out.extend_from_slice(&runes[i..i + 2]);
            i += 2;
            continue;
        }
        if cp == u32::from(b'/') {
            push_text(&mut out, "\\/");
            i += 1;
            continue;
        }
        if cp == u32::from(b'(')
            && runes.get(i + 1) == Some(&u32::from(b'?'))
            && runes.get(i + 2) == Some(&u32::from(b'<'))
            && !matches!(runes.get(i + 3).and_then(|&cp| ascii(cp)), Some('=' | '!'))
        {
            push_text(&mut out, "(?P<");
            i += 3;
            continue;
        }
        // This intentionally follows the wrapper's simple class tracking,
        // including its treatment of a leading literal ']' in a native class.
        if cp == u32::from(b'[') && !in_class {
            in_class = true;
        } else if cp == u32::from(b']') && in_class {
            in_class = false;
        }
        out.push(cp);
        i += 1;
    }
    Ok(out)
}

#[derive(Clone, Copy, Default)]
struct Flags {
    insensitive: bool,
    multiline: bool,
    dot_nl: bool,
    ungreedy: bool,
}
struct Atom {
    text: String,
    repeat_product: usize,
    unary: bool,
}
impl Atom {
    fn new(text: String) -> Self {
        Self {
            text,
            repeat_product: 1,
            unary: false,
        }
    }
}
#[derive(Default)]
struct Frame {
    output: String,
    last: Option<Atom>,
    repeat_product: usize,
}
impl Frame {
    fn flush(&mut self) {
        if let Some(atom) = self.last.take() {
            self.output.push_str(&atom.text);
            self.repeat_product = self.repeat_product.max(atom.repeat_product);
        }
    }
    fn push(&mut self, atom: Atom) {
        self.flush();
        self.last = Some(atom);
    }
    fn finish(mut self) -> (String, usize) {
        self.flush();
        (self.output, self.repeat_product.max(1))
    }
    fn reset_unary(&mut self) {
        if let Some(last) = &mut self.last {
            last.unary = false;
        }
    }
}
struct Group {
    parent: Frame,
    flags: Flags,
    capture: bool,
}
struct Parser {
    runes: Vec<u32>,
    i: usize,
    flags: Flags,
    frame: Frame,
    groups: Vec<Group>,
    names: std::collections::BTreeSet<String>,
}
impl Parser {
    fn new(runes: Vec<u32>, insensitive: bool) -> Self {
        Self {
            runes,
            i: 0,
            flags: Flags {
                insensitive,
                ..Flags::default()
            },
            frame: Frame::default(),
            groups: Vec::new(),
            names: Default::default(),
        }
    }
    fn peek(&self) -> Option<char> {
        self.runes.get(self.i).and_then(|&cp| ascii(cp))
    }
    fn at(&self, offset: usize, ch: char) -> bool {
        self.runes.get(self.i + offset) == Some(&(ch as u32))
    }
    fn literal(&self, cp: u32) -> Atom {
        let set = if self.flags.insensitive {
            RuneSet::new(re2_unicode::equivalents(cp).map(|cp| (cp, cp)))
        } else {
            RuneSet::new([(cp, cp)])
        };
        Atom::new(set.emit())
    }
    fn parse(mut self) -> Result<String, CompileError> {
        while self.i < self.runes.len() {
            match self.peek() {
                Some('(') => self.group()?,
                Some(')') => {
                    self.i += 1;
                    let group = self
                        .groups
                        .pop()
                        .ok_or_else(|| error("unexpected closing group"))?;
                    let (body, repeat_product) = std::mem::take(&mut self.frame).finish();
                    self.frame = group.parent;
                    self.flags = group.flags;
                    self.frame.push(Atom {
                        text: format!("{}{})", if group.capture { "(" } else { "(?:" }, body),
                        repeat_product,
                        unary: false,
                    });
                }
                Some('|') => {
                    self.i += 1;
                    self.frame.flush();
                    self.frame.output.push('|');
                }
                Some('*' | '+' | '?') => {
                    let op = self.peek().unwrap();
                    self.i += 1;
                    self.repeat(op.to_string(), None)?;
                }
                Some('{') => {
                    if let Some((end, lo, hi)) = self.repetition() {
                        if lo > 1000 || hi.is_some_and(|n| n > 1000 || n < lo) {
                            return Err(error("invalid repetition size"));
                        }
                        let spelling = text(&self.runes[self.i..end])?;
                        self.i = end;
                        self.repeat(spelling, Some(hi.unwrap_or(lo).max(1)))?;
                    } else {
                        self.i += 1;
                        self.frame.push(self.literal(u32::from(b'{')));
                    }
                }
                Some('[') => {
                    let set = self.class()?;
                    self.frame.push(Atom::new(set.emit()));
                }
                Some('\\') if self.at(1, 'Q') => {
                    self.i += 2;
                    self.frame.reset_unary();
                    while self.i < self.runes.len() {
                        if self.at(0, '\\') && self.at(1, 'E') {
                            self.i += 2;
                            break;
                        }
                        let cp = self.runes[self.i];
                        self.i += 1;
                        self.frame.push(self.literal(cp));
                    }
                }
                Some('\\') => {
                    let atom = match self.runes.get(self.i + 1).and_then(|&cp| ascii(cp)) {
                        Some('b' | 'B') => {
                            let op = self.runes[self.i + 1] as u8 as char;
                            self.i += 2;
                            Atom::new(format!("(?-u:\\{op})"))
                        }
                        Some('A' | 'z') => {
                            let op = self.runes[self.i + 1] as u8 as char;
                            self.i += 2;
                            Atom::new(format!("\\{op}"))
                        }
                        Some('C') => {
                            self.i += 2;
                            Atom::new("(?s-u:.)".into())
                        }
                        _ => {
                            if let Some(set) = self.group_class()? {
                                Atom::new(set.emit())
                            } else {
                                let cp = self.escape()?;
                                self.literal(cp)
                            }
                        }
                    };
                    self.frame.push(atom);
                }
                Some('.' | '^' | '$') => {
                    let op = self.peek().unwrap();
                    self.i += 1;
                    let atom = match op {
                        '.' => Atom::new(if self.flags.dot_nl {
                            RuneSet::new([(0, MAX_RUNE)]).emit()
                        } else {
                            RuneSet::new([(0, 9), (11, MAX_RUNE)]).emit()
                        }),
                        '^' => Atom::new(
                            if self.flags.multiline {
                                "(?m:^)"
                            } else {
                                "\\A"
                            }
                            .into(),
                        ),
                        '$' => Atom::new(
                            if self.flags.multiline {
                                "(?m:$)"
                            } else {
                                "\\z"
                            }
                            .into(),
                        ),
                        _ => unreachable!(),
                    };
                    self.frame.push(atom);
                }
                _ => {
                    let cp = self.runes[self.i];
                    self.i += 1;
                    self.frame.push(self.literal(cp));
                }
            }
        }
        if !self.groups.is_empty() {
            return Err(error("unclosed group"));
        }
        Ok(self.frame.finish().0)
    }
    fn repeat(&mut self, spelling: String, factor: Option<usize>) -> Result<(), CompileError> {
        let atom = self
            .frame
            .last
            .as_mut()
            .ok_or_else(|| error("missing repetition argument"))?;
        if atom.unary {
            return Err(error("stacked repetition operators"));
        }
        if let Some(factor) = factor {
            atom.repeat_product = atom.repeat_product.saturating_mul(factor);
            if atom.repeat_product > 1000 {
                return Err(error("nested repetition size"));
            }
        }
        let explicit_lazy = self.peek() == Some('?');
        if explicit_lazy {
            self.i += 1;
        }
        let lazy = explicit_lazy ^ self.flags.ungreedy;
        let atom = self.frame.last.as_mut().unwrap();
        atom.text = format!("(?:{}){spelling}{}", atom.text, if lazy { "?" } else { "" });
        atom.unary = true;
        Ok(())
    }
    fn repetition(&self) -> Option<(usize, usize, Option<usize>)> {
        let integer = |mut i: usize| -> Option<(usize, usize)> {
            let start = i;
            if self.runes.get(i) == Some(&u32::from(b'0'))
                && self
                    .runes
                    .get(i + 1)
                    .and_then(|&cp| ascii(cp))
                    .is_some_and(|c| c.is_ascii_digit())
            {
                return None;
            }
            let mut value = 0;
            while let Some(digit) = self
                .runes
                .get(i)
                .and_then(|&cp| ascii(cp))
                .and_then(|c| c.to_digit(10))
            {
                if value >= 100_000_000 {
                    return None;
                }
                value = value * 10 + digit as usize;
                i += 1;
            }
            (i != start).then_some((i, value))
        };
        let (mut end, lo) = integer(self.i + 1)?;
        let hi = if self.runes.get(end) == Some(&u32::from(b',')) {
            end += 1;
            if self.runes.get(end) == Some(&u32::from(b'}')) {
                None
            } else {
                let (next, hi) = integer(end)?;
                end = next;
                Some(hi)
            }
        } else {
            Some(lo)
        };
        (self.runes.get(end) == Some(&u32::from(b'}'))).then_some((end + 1, lo, hi))
    }
    fn group(&mut self) -> Result<(), CompileError> {
        self.i += 1;
        let saved = self.flags;
        let mut capture = true;
        if self.peek() == Some('?') {
            self.i += 1;
            if self.peek() == Some('<') || (self.peek() == Some('P') && self.at(1, '<')) {
                self.i += if self.peek() == Some('P') { 2 } else { 1 };
                let start = self.i;
                while self.i < self.runes.len() && self.peek() != Some('>') {
                    self.i += 1;
                }
                let name = text(&self.runes[start..self.i])?;
                let valid = !name.is_empty()
                    && name.chars().all(|ch| {
                        ["Lu", "Ll", "Lt", "Lm", "Lo", "Nl", "Mn", "Mc", "Nd", "Pc"]
                            .iter()
                            .any(|name| {
                                re2_unicode::lookup(re2_unicode::Namespace::Builtin, name)
                                    .is_some_and(|p| p.contains(ch as u32))
                            })
                    });
                if !valid || self.peek() != Some('>') || !self.names.insert(name) {
                    return Err(error("invalid or duplicate capture name"));
                }
                self.i += 1;
            } else {
                capture = false;
                let mut negative = false;
                let mut saw_flags = false;
                loop {
                    let Some(ch) = self.peek() else {
                        return Err(error("invalid inline flags"));
                    };
                    self.i += 1;
                    match ch {
                        'i' | 'm' | 's' | 'U' => {
                            saw_flags = true;
                            let value = !negative;
                            match ch {
                                'i' => self.flags.insensitive = value,
                                'm' => self.flags.multiline = value,
                                's' => self.flags.dot_nl = value,
                                'U' => self.flags.ungreedy = value,
                                _ => unreachable!(),
                            }
                        }
                        '-' if !negative => {
                            negative = true;
                            saw_flags = false;
                        }
                        ':' | ')' => {
                            if negative && !saw_flags {
                                return Err(error("missing disabled inline flag"));
                            }
                            if ch == ')' {
                                self.frame.reset_unary();
                                return Ok(());
                            }
                            break;
                        }
                        _ => return Err(error("unsupported inline group")),
                    }
                }
            }
        }
        self.groups.push(Group {
            parent: std::mem::take(&mut self.frame),
            flags: saved,
            capture,
        });
        Ok(())
    }
    fn escape(&mut self) -> Result<u32, CompileError> {
        if self.peek() != Some('\\') {
            return Err(error("expected escape"));
        }
        self.i += 1;
        let next = self
            .peek()
            .ok_or_else(|| error("invalid or trailing escape"))?;
        self.i += 1;
        match next {
            '0'..='7' => {
                if next != '0' && !matches!(self.peek(), Some('0'..='7')) {
                    return Err(error("backreferences are unsupported"));
                }
                let mut cp = next as u32 - u32::from(b'0');
                for _ in 0..2 {
                    if let Some(ch @ '0'..='7') = self.peek() {
                        cp = cp * 8 + ch as u32 - u32::from(b'0');
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                Ok(cp)
            }
            'x' => {
                if self.peek() == Some('{') {
                    self.i += 1;
                    let start = self.i;
                    let mut cp: u32 = 0;
                    while let Some(digit) = self.runes.get(self.i).and_then(|&cp| hex(cp)) {
                        cp = cp
                            .checked_mul(16)
                            .and_then(|n| n.checked_add(digit))
                            .filter(|&cp| cp <= MAX_RUNE)
                            .ok_or_else(|| error("invalid hex rune"))?;
                        self.i += 1;
                    }
                    if self.i == start || self.peek() != Some('}') {
                        return Err(error("invalid braced hex escape"));
                    }
                    self.i += 1;
                    Ok(cp)
                } else {
                    let high = self.runes.get(self.i).and_then(|&cp| hex(cp));
                    let low = self.runes.get(self.i + 1).and_then(|&cp| hex(cp));
                    self.i += 2;
                    high.zip(low)
                        .map(|(a, b)| a * 16 + b)
                        .ok_or_else(|| error("invalid hex escape"))
                }
            }
            'a' => Ok(7),
            'f' => Ok(12),
            'n' => Ok(10),
            'r' => Ok(13),
            't' => Ok(9),
            'v' => Ok(11),
            ch if !ch.is_ascii_alphanumeric() => Ok(ch as u32),
            _ => Err(error("unsupported escape")),
        }
    }
    fn group_class(&mut self) -> Result<Option<RuneSet>, CompileError> {
        if self.peek() != Some('\\') {
            return Ok(None);
        }
        let Some(next) = self.runes.get(self.i + 1).and_then(|&cp| ascii(cp)) else {
            return Ok(None);
        };
        if matches!(next, 'd' | 'D' | 's' | 'S' | 'w' | 'W') {
            self.i += 2;
            let set = match next {
                'd' | 'D' => RuneSet::new([(48, 57)]),
                's' | 'S' => RuneSet::new([(9, 10), (12, 13), (32, 32)]),
                _ => RuneSet::new([(48, 57), (65, 90), (95, 95), (97, 122)]),
            }
            .folded(self.flags.insensitive);
            return Ok(Some(if next.is_ascii_uppercase() {
                set.complement()
            } else {
                set
            }));
        }
        if !matches!(next, 'p' | 'P') {
            return Ok(None);
        }
        self.i += 2;
        let name = if self.peek() == Some('{') {
            self.i += 1;
            let start = self.i;
            while self.i < self.runes.len() && self.peek() != Some('}') {
                self.i += 1;
            }
            if self.peek() != Some('}') {
                return Err(error("unterminated Unicode property"));
            }
            let name = text(&self.runes[start..self.i])?;
            self.i += 1;
            name
        } else {
            let cp = *self
                .runes
                .get(self.i)
                .ok_or_else(|| error("missing Unicode property"))?;
            self.i += 1;
            text(&[cp])?
        };
        let (name, inverted) = name
            .strip_prefix('^')
            .map_or((name.as_str(), false), |n| (n, true));
        let property = re2_unicode::lookup(re2_unicode::Namespace::Builtin, name)
            .ok_or_else(|| error("unknown native Unicode property"))?;
        let set = RuneSet::new(property.ranges.iter().copied()).folded(self.flags.insensitive);
        Ok(Some(if (next == 'P') ^ inverted {
            set.complement()
        } else {
            set
        }))
    }
    fn class_rune(&mut self) -> Result<u32, CompileError> {
        if self.peek() == Some('\\') {
            self.escape()
        } else {
            let cp = *self
                .runes
                .get(self.i)
                .ok_or_else(|| error("unclosed character class"))?;
            self.i += 1;
            Ok(cp)
        }
    }
    fn class(&mut self) -> Result<RuneSet, CompileError> {
        self.i += 1;
        let negative = self.peek() == Some('^');
        if negative {
            self.i += 1;
        }
        let mut first = true;
        let mut members = Vec::new();
        let mut explicit = Vec::new();
        while self.i < self.runes.len() && (first || self.peek() != Some(']')) {
            first = false;
            if self.peek() == Some('[')
                && self.at(1, ':')
                && let Some(end) = (self.i + 2..self.runes.len().saturating_sub(1)).find(|&j| {
                    self.runes[j] == u32::from(b':') && self.runes[j + 1] == u32::from(b']')
                })
            {
                let name = text(&self.runes[self.i + 2..end])?;
                self.i = end + 2;
                let (name, negative) = name
                    .strip_prefix('^')
                    .map_or((name.as_str(), false), |n| (n, true));
                let set = posix(name)
                    .ok_or_else(|| error("unknown POSIX class"))?
                    .folded(self.flags.insensitive);
                members.extend(if negative { set.complement().0 } else { set.0 });
                continue;
            }
            if let Some(set) = self.group_class()? {
                members.extend(set.0);
                continue;
            }
            let lo = self.class_rune()?;
            let hi =
                if self.peek() == Some('-') && !self.at(1, ']') && self.i + 1 < self.runes.len() {
                    self.i += 1;
                    self.class_rune()?
                } else {
                    lo
                };
            if hi < lo {
                return Err(error("reversed character range"));
            }
            explicit.push((lo, hi));
        }
        if self.peek() != Some(']') {
            return Err(error("unclosed character class"));
        }
        self.i += 1;
        members.extend(RuneSet::new(explicit).folded(self.flags.insensitive).0);
        let result = RuneSet::new(members);
        Ok(if negative {
            result.complement()
        } else {
            result
        })
    }
}
fn posix(name: &str) -> Option<RuneSet> {
    Some(RuneSet::new(match name {
        "alnum" => vec![(48, 57), (65, 90), (97, 122)],
        "alpha" => vec![(65, 90), (97, 122)],
        "ascii" => vec![(0, 127)],
        "blank" => vec![(9, 9), (32, 32)],
        "cntrl" => vec![(0, 31), (127, 127)],
        "digit" => vec![(48, 57)],
        "graph" => vec![(33, 126)],
        "lower" => vec![(97, 122)],
        "print" => vec![(32, 126)],
        "punct" => vec![(33, 47), (58, 64), (91, 96), (123, 126)],
        "space" => vec![(9, 13), (32, 32)],
        "upper" => vec![(65, 90)],
        "word" => vec![(48, 57), (65, 90), (95, 95), (97, 122)],
        "xdigit" => vec![(48, 57), (65, 70), (97, 102)],
        _ => return None,
    }))
}
