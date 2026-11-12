//! RE2's parser (`re2/parse.cc` in the `re2` package, version 1.27.0) over what the package's
//! rewrite ([`super::js`]) hands it, writing `regex` syntax with the same meaning.
//!
//! Every literal is written escaped, and every literal inside a class as `\x{...}`, so `regex`'s
//! own class syntax (`&&`, `--`, `~~`, nested `[`) never comes into play. Perl classes are RE2's
//! ASCII ones, `\b` and `\B` are ASCII, Unicode groups are looked up by RE2's exact names, and
//! RE2's general category `C` has no unassigned code points (in `regex` it has).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use regex_syntax::hir::{Class, HirKind};

use super::js::{Expansion, PropertySet, Tok};
use super::re2_names::{RE2_POSIX_GROUPS, RE2_UNICODE_GROUPS};
use super::{MAX_REPEAT, PatternError};

/// ASCII class bodies RE2 uses for the Perl classes.
const DIGIT: &str = "0-9";
const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = r"\t\n\x0C\r ";
/// A class with nothing in it: a lone surrogate, which no UTF-8 text contains.
pub(super) const NOTHING: &str = r"[^\x{0}-\x{10FFFF}]";
const EVERYTHING: &str = r"[\x{0}-\x{10FFFF}]";
const MISPLACED: PatternError = PatternError::Unsupported(
    "Unicode property the re2 package writes where RE2 reads it differently",
);

/// The characters RE2 accepts in a group name: categories Lu, Ll, Lt, Lm, Lo, Nl, Mn, Mc, Nd, Pc.
static CAPTURE_NAME: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"\A[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]+\z").ok()
});

/// The translated pattern and its group names (in order).
pub(super) struct Translation {
    pub(super) regex: String,
    #[expect(
        dead_code,
        reason = "the combined variation rule arrives in the next commit"
    )]
    pub(super) names: Vec<String>,
}

/// Translates RE2 pattern text. `colon_bracket_after` says whether text after `toks` (in a
/// combined pattern) contains `:]`, which RE2's class-name lookup would reach.
pub(super) fn translate(
    toks: &[Tok],
    colon_bracket_after: bool,
) -> Result<Translation, PatternError> {
    let mut parser = Parser {
        toks,
        index: 0,
        out: String::with_capacity(toks.len() + 16),
        quantifier: Quantifier::None,
        frames: vec![Frame { product: 1 }],
        last_atom: None,
        names: Vec::new(),
        seen: HashSet::new(),
        boundary_depth: None,
        colon_bracket_after,
    };
    parser.run()?;
    Ok(Translation {
        regex: parser.out,
        names: parser.names,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quantifier {
    None,
    Greedy,
    Lazy,
}

/// One group level, for RE2's nested repetition limit.
#[derive(Debug, Clone, Copy)]
struct Frame {
    /// The largest product of repetition counts on any path inside the group.
    product: u64,
}

struct Parser<'a> {
    toks: &'a [Tok],
    index: usize,
    out: String,
    quantifier: Quantifier,
    frames: Vec<Frame>,
    /// The product of the most recent atom, which a following quantifier applies to.
    last_atom: Option<u64>,
    names: Vec<String>,
    seen: HashSet<String>,
    /// The group depth at the first component boundary; every boundary must be at it.
    boundary_depth: Option<usize>,
    colon_bracket_after: bool,
}

const fn stacked() -> PatternError {
    PatternError::Unsupported("stacked repetition operators")
}

/// A RE2 rune as `regex` text inside a class.
fn class_rune(out: &mut String, rune: u32) {
    out.push_str(&format!("\\x{{{rune:X}}}"));
}

/// The range `lo..=hi` without surrogates (they never match UTF-8 text).
fn class_range(out: &mut String, lo: u32, hi: u32) {
    let mut push = |lo: u32, hi: u32| {
        if lo > hi {
            return;
        }
        class_rune(out, lo);
        if hi > lo {
            out.push('-');
            class_rune(out, hi);
        }
    };
    push(lo, hi.min(0xD7FF));
    push(lo.max(0xE000), hi);
}

/// `regex` text for one of RE2's Unicode groups (without brackets), by RE2's exact name.
fn unicode_group(name: &str) -> Option<String> {
    if name == "Any" {
        return Some(r"\p{Any}".into());
    }
    let name = RE2_UNICODE_GROUPS.iter().find(|group| **group == name)?;
    Some(match *name {
        // RE2's C has no unassigned code points; `regex`'s does. Cs (surrogates) is empty.
        "C" => r"\p{gc=Cc}\p{gc=Cf}\p{gc=Co}".into(),
        "Cs" => NOTHING.into(),
        // General categories are one or two letters starting with C, L, M, N, P, S or Z
        // (`Yi` is a script).
        category
            if category.len() <= 2 && category.starts_with(['C', 'L', 'M', 'N', 'P', 'S', 'Z']) =>
        {
            format!(r"\p{{gc={category}}}")
        }
        script => format!(r"\p{{sc={script}}}"),
    })
}

/// The ranges of a class `regex` knows by `text` (`\p{...}`), as class items, complemented.
fn complement(text: &str) -> Option<String> {
    let hir = regex_syntax::ParserBuilder::new()
        .build()
        .parse(text)
        .ok()?;
    let HirKind::Class(Class::Unicode(class)) = hir.kind() else {
        return None;
    };
    let mut class = class.clone();
    class.negate();
    let mut out = String::new();
    for range in class.ranges() {
        class_range(&mut out, u32::from(range.start()), u32::from(range.end()));
    }
    Some(out)
}

/// A set the package expands itself (`\p{Emoji}`, `\P{scx=Greek}`), as `regex` text: a class
/// outside a class, class items inside one.
///
/// Outside a class the package writes `[ranges]` or `[^ranges]`, which RE2 case-folds and then
/// negates, as `regex` does with `\P{...}`. Inside a class it writes the complement ranges
/// themselves, which RE2 then case-folds like any other ranges (`[(?i)\P{ASCII}]` matches `k`
/// through the Kelvin sign), so they are written out.
fn expansion_text(expansion: Expansion, in_class: bool) -> Result<String, PatternError> {
    let positive = match expansion.set {
        PropertySet::Binary(name) => format!(r"\p{{{name}}}"),
        PropertySet::ScriptExtension(name) => format!(r"\p{{scx={name}}}"),
    };
    let complemented = complement(&positive).ok_or(PatternError::Unsupported(
        "Unicode property this Unicode version lacks",
    ))?;
    Ok(match (in_class, expansion.negated) {
        (true, true) => complemented,
        (true, false) => positive,
        (false, negated) => bracket(&positive, negated),
    })
}

/// A whole class: never empty in `regex` syntax.
fn bracket(items: &str, negated: bool) -> String {
    match (items.is_empty(), negated) {
        (true, false) => NOTHING.into(),
        (true, true) => EVERYTHING.into(),
        (false, false) => format!("[{items}]"),
        (false, true) => format!("[^{items}]"),
    }
}

/// One literal character in `regex` syntax.
pub(super) fn push_literal(out: &mut String, ch: char) {
    if regex_syntax::is_meta_character(ch) {
        out.push('\\');
    }
    out.push(ch);
}

impl Parser<'_> {
    fn tok(&self, offset: usize) -> Option<Tok> {
        self.toks.get(self.index + offset).copied()
    }

    fn char_at(&self, offset: usize) -> Option<char> {
        match self.tok(offset)? {
            Tok::Char(ch) => Some(ch),
            Tok::Expansion(_) | Tok::Boundary => None,
        }
    }

    /// The next character; text that is not a character (an expansion, a component edge) ends
    /// the construct being read: invalid.
    fn next_char(&mut self) -> Result<char, PatternError> {
        let ch = self.char_at(0).ok_or(PatternError::Invalid)?;
        self.index += 1;
        Ok(ch)
    }

    fn atom(&mut self) {
        self.last_atom = Some(1);
        self.quantifier = Quantifier::None;
    }

    /// Records a path product in the innermost group (the root frame is never popped).
    fn raise(&mut self, product: u64) {
        if let Some(top) = self.frames.last_mut() {
            top.product = top.product.max(product);
        }
    }

    fn run(&mut self) -> Result<(), PatternError> {
        while let Some(tok) = self.tok(0) {
            self.index += 1;
            let ch = match tok {
                Tok::Boundary => {
                    self.boundary()?;
                    continue;
                }
                Tok::Expansion(expansion) => {
                    if !expansion.bracketed {
                        return Err(MISPLACED);
                    }
                    self.out.push_str(&expansion_text(expansion, false)?);
                    self.atom();
                    continue;
                }
                Tok::Char(ch) => ch,
            };
            match ch {
                '*' | '+' | '?' => self.simple_quantifier(ch)?,
                '{' => match self.repetition() {
                    Some(repetition) => self.counted_repetition(repetition)?,
                    None => {
                        self.out.push_str(r"\{");
                        self.atom();
                    }
                },
                '\\' => self.escape_outside()?,
                '[' => self.class()?,
                '(' => self.open_group()?,
                ')' => self.close_group(),
                '|' => {
                    self.out.push('|');
                    self.last_atom = None;
                    self.quantifier = Quantifier::None;
                }
                '^' | '$' | '.' => {
                    self.out.push(ch);
                    self.atom();
                }
                _ => {
                    push_literal(&mut self.out, ch);
                    self.atom();
                }
            }
        }
        Ok(())
    }

    /// A component edge of a combined pattern: each component must close what it opens.
    fn boundary(&mut self) -> Result<(), PatternError> {
        match self.boundary_depth {
            None => self.boundary_depth = Some(self.frames.len()),
            Some(depth) if depth == self.frames.len() => {}
            Some(_) => return Err(PatternError::Invalid),
        }
        Ok(())
    }

    fn simple_quantifier(&mut self, ch: char) -> Result<(), PatternError> {
        self.quantifier = match (ch, self.quantifier) {
            ('?', Quantifier::Greedy) => Quantifier::Lazy,
            (_, Quantifier::None) => Quantifier::Greedy,
            _ => return Err(stacked()),
        };
        self.out.push(ch);
        Ok(())
    }

    /// `ParseInteger` at `offset`: digits without a leading zero, below 100,000,000.
    fn integer(&self, offset: &mut usize) -> Option<u64> {
        let first = self.char_at(*offset)?.to_digit(10)?;
        if first == 0
            && self
                .char_at(*offset + 1)
                .is_some_and(|ch| ch.is_ascii_digit())
        {
            return None;
        }
        let mut value = 0_u64;
        while let Some(digit) = self.char_at(*offset).and_then(|ch| ch.to_digit(10)) {
            if value >= 100_000_000 {
                return None;
            }
            value = value * 10 + u64::from(digit);
            *offset += 1;
        }
        Some(value)
    }

    /// `MaybeParseRepetition` after a `{`: `(min, max, length)`, `max` `None` when unbounded.
    fn repetition(&self) -> Option<(u64, Option<u64>, usize)> {
        let mut offset = 0;
        let min = self.integer(&mut offset)?;
        let max = if self.char_at(offset) == Some(',') {
            offset += 1;
            if self.char_at(offset) == Some('}') {
                None
            } else {
                Some(self.integer(&mut offset)?)
            }
        } else {
            Some(min)
        };
        (self.char_at(offset) == Some('}')).then_some((min, max, offset + 1))
    }

    fn counted_repetition(
        &mut self,
        (min, max, len): (u64, Option<u64>, usize),
    ) -> Result<(), PatternError> {
        if self.quantifier != Quantifier::None {
            return Err(stacked());
        }
        self.index += len;
        if min > MAX_REPEAT || max.is_some_and(|max| max > MAX_REPEAT) {
            return Err(PatternError::Unsupported("repetition count above 1000"));
        }
        if max.is_some_and(|max| max < min) {
            return Err(PatternError::Invalid);
        }
        // RE2 divides its budget by each nested count (the maximum, or the minimum when
        // unbounded) and refuses when it reaches zero: the product must stay within 1,000.
        let factor = max.unwrap_or(min).max(1);
        let product = self.last_atom.unwrap_or(1).saturating_mul(factor);
        if (min >= 2 || max.is_some_and(|max| max >= 2)) && product > MAX_REPEAT {
            return Err(PatternError::Unsupported(
                "nested repetition counts above 1000",
            ));
        }
        self.raise(product);
        self.last_atom = Some(product);
        self.quantifier = Quantifier::Greedy;
        match max {
            Some(max) if max == min => self.out.push_str(&format!("{{{min}}}")),
            Some(max) => self.out.push_str(&format!("{{{min},{max}}}")),
            None => self.out.push_str(&format!("{{{min},}}")),
        }
        Ok(())
    }

    fn open_group(&mut self) -> Result<(), PatternError> {
        self.quantifier = Quantifier::None;
        if self.char_at(0) != Some('?') {
            self.out.push('(');
            self.push_frame();
            return Ok(());
        }
        match (self.char_at(1), self.char_at(2)) {
            (Some('=' | '!'), _) | (Some('<'), Some('=' | '!')) => {
                Err(PatternError::Unsupported("lookaround"))
            }
            (Some('P'), Some('<')) => {
                self.index += 3;
                self.named_group()
            }
            (Some('<'), _) => {
                self.index += 2;
                self.named_group()
            }
            _ => {
                self.index += 1;
                self.flags()
            }
        }
    }

    /// A named group, after `(?P<` or `(?<`: RE2 takes the name up to the first `>`, checks
    /// its characters and that it is not used twice, and numbers the group like any other;
    /// `regex` gets a plain group (its own name rules differ, and nothing reads groups by name).
    fn named_group(&mut self) -> Result<(), PatternError> {
        let mut name = String::new();
        loop {
            match self.next_char()? {
                '>' => break,
                ch => name.push(ch),
            }
        }
        if !CAPTURE_NAME
            .as_ref()
            .is_some_and(|valid| valid.is_match(&name))
        {
            return Err(PatternError::Invalid);
        }
        if !self.seen.insert(name.clone()) {
            return Err(PatternError::Unsupported("duplicate capture group name"));
        }
        self.names.push(name);
        self.out.push('(');
        self.push_frame();
        Ok(())
    }

    /// `(?flags)` or `(?flags:`, after `(?`.
    fn flags(&mut self) -> Result<(), PatternError> {
        const FLAGS: [char; 4] = ['i', 'm', 's', 'U'];
        // The final state of each flag set in the group: Some(true) on, Some(false) off.
        let mut state: [Option<bool>; 4] = [None; 4];
        let mut negated = false;
        let mut saw_flag = false;
        let opens_group = loop {
            match self.next_char()? {
                ')' => break false,
                ':' => break true,
                '-' if !negated => {
                    negated = true;
                    saw_flag = false;
                }
                flag => {
                    let Some(position) = FLAGS.iter().position(|known| *known == flag) else {
                        return Err(PatternError::Unsupported("flag other than i, m, s, U"));
                    };
                    state[position] = Some(!negated);
                    saw_flag = true;
                }
            }
        };
        if negated && !saw_flag {
            return Err(PatternError::Unsupported("empty negated flags"));
        }
        let pick = |wanted: bool| -> String {
            FLAGS
                .iter()
                .zip(state)
                .filter(|(_, state)| *state == Some(wanted))
                .map(|(flag, _)| *flag)
                .collect()
        };
        let (on, off) = (pick(true), pick(false));
        let flags = if off.is_empty() {
            on
        } else {
            format!("{on}-{off}")
        };
        if opens_group {
            self.out.push_str("(?");
            self.out.push_str(&flags);
            self.out.push(':');
            self.push_frame();
        } else {
            if !flags.is_empty() {
                self.out.push_str("(?");
                self.out.push_str(&flags);
                self.out.push(')');
            }
            // A flag group is not an atom: a quantifier after it has nothing to repeat.
            self.last_atom = None;
        }
        Ok(())
    }

    fn push_frame(&mut self) {
        self.frames.push(Frame { product: 1 });
        self.last_atom = None;
    }

    fn close_group(&mut self) {
        self.out.push(')');
        if self.frames.len() > 1 {
            let inner = self.frames.pop().map_or(1, |frame| frame.product);
            self.raise(inner);
            self.last_atom = Some(inner);
        } else {
            // An unopened `)`: `regex` refuses the result.
            self.last_atom = None;
        }
        self.quantifier = Quantifier::None;
    }

    /// After a `\` outside a class.
    fn escape_outside(&mut self) -> Result<(), PatternError> {
        let next = match self.tok(0) {
            Some(Tok::Char(next)) => next,
            // RE2 would read the expansion's first character (`[` or `\`) as escaped.
            Some(Tok::Expansion(_)) => return Err(MISPLACED),
            // A trailing `\`.
            None | Some(Tok::Boundary) => return Err(PatternError::Invalid),
        };
        match next {
            'b' | 'B' => {
                self.index += 1;
                self.out.push_str(if next == 'b' {
                    r"(?-u:\b)"
                } else {
                    r"(?-u:\B)"
                });
            }
            'A' | 'z' => {
                self.index += 1;
                self.out.push('\\');
                self.out.push(next);
            }
            'C' => return Err(PatternError::Unsupported(r"\C (one byte)")),
            'Q' => {
                self.index += 1;
                return self.quoted();
            }
            'p' | 'P' => {
                self.index += 1;
                let items = self.unicode_group_items(next)?;
                self.out.push_str(&items);
            }
            'd' | 'D' | 's' | 'S' | 'w' | 'W' => {
                self.index += 1;
                self.out.push_str(&perl_class(next, false));
            }
            _ => {
                let rune = self.escape()?;
                match char::from_u32(rune) {
                    Some(ch) => push_literal(&mut self.out, ch),
                    None => self.out.push_str(NOTHING),
                }
            }
        }
        self.atom();
        Ok(())
    }

    /// `\Q...\E`: literal text up to `\E` or the end.
    fn quoted(&mut self) -> Result<(), PatternError> {
        loop {
            match self.tok(0) {
                None => return Ok(()),
                Some(Tok::Char('\\')) if self.char_at(1) == Some('E') => {
                    self.index += 2;
                    return Ok(());
                }
                Some(Tok::Char(ch)) => {
                    self.index += 1;
                    push_literal(&mut self.out, ch);
                    self.atom();
                }
                // The package's expansion would be read as literal text by RE2.
                Some(Tok::Expansion(_)) => return Err(MISPLACED),
                Some(Tok::Boundary) => return Err(PatternError::Invalid),
            }
        }
    }

    /// `ParseEscape` after the `\`: the escaped rune (which may be a surrogate).
    fn escape(&mut self) -> Result<u32, PatternError> {
        let c = self.next_char()?;
        let octal = |ch: Option<char>| {
            ch.filter(|ch| ('0'..='7').contains(ch))
                .and_then(|ch| ch.to_digit(8))
        };
        match c {
            '1'..='7' | '0' => {
                if c != '0' && octal(self.char_at(0)).is_none() {
                    return Err(PatternError::Unsupported("backreference"));
                }
                let mut value = c.to_digit(8).unwrap_or(0);
                for _ in 0..2 {
                    let Some(digit) = octal(self.char_at(0)) else {
                        break;
                    };
                    self.index += 1;
                    value = value * 8 + digit;
                }
                Ok(value)
            }
            'x' => {
                let first = self.next_char()?;
                if first == '{' {
                    let mut value = 0_u32;
                    let mut digits = 0;
                    loop {
                        let ch = self.next_char()?;
                        if let Some(digit) = ch.to_digit(16) {
                            digits += 1;
                            value = value * 16 + digit;
                            if value > 0x10_FFFF {
                                return Err(PatternError::Invalid);
                            }
                        } else if ch == '}' && digits > 0 {
                            return Ok(value);
                        } else {
                            return Err(PatternError::Invalid);
                        }
                    }
                }
                let second = self.next_char()?;
                match (first.to_digit(16), second.to_digit(16)) {
                    (Some(high), Some(low)) => Ok(high * 16 + low),
                    _ => Err(PatternError::Invalid),
                }
            }
            'n' => Ok(0x0A),
            'r' => Ok(0x0D),
            't' => Ok(0x09),
            'a' => Ok(0x07),
            'f' => Ok(0x0C),
            'v' => Ok(0x0B),
            // Escaped punctuation is itself.
            other if other.is_ascii() && !other.is_ascii_alphanumeric() => Ok(u32::from(other)),
            _ => Err(PatternError::Invalid),
        }
    }

    /// `ParseUnicodeGroup` after `\p` or `\P` (`letter`): a bracketed `regex` class.
    fn unicode_group_items(&mut self, letter: char) -> Result<String, PatternError> {
        let mut negated = letter == 'P';
        let mut name = String::new();
        match self.next_char()? {
            '{' => loop {
                match self.next_char()? {
                    '}' => break,
                    ch => name.push(ch),
                }
            },
            ch => name.push(ch),
        }
        let name = match name.strip_prefix('^') {
            Some(rest) => {
                negated = !negated;
                rest
            }
            None => name.as_str(),
        };
        let items = unicode_group(name).ok_or(PatternError::Invalid)?;
        Ok(bracket(&items, negated))
    }

    /// `ParseCCName` at `[:`: the POSIX class text, `None` when no `:]` follows anywhere.
    fn posix_class(&mut self) -> Result<Option<String>, PatternError> {
        let mut offset = 2;
        let mut crossed = false;
        let end = loop {
            match self.tok(offset) {
                None if self.colon_bracket_after => return Err(PatternError::Invalid),
                None => return Ok(None),
                Some(Tok::Char(':')) if self.char_at(offset + 1) == Some(']') => break offset + 2,
                Some(Tok::Char(_)) => {}
                Some(Tok::Expansion(_) | Tok::Boundary) => crossed = true,
            }
            offset += 1;
        };
        if crossed {
            return Err(PatternError::Invalid);
        }
        let name: String = (0..end).filter_map(|offset| self.char_at(offset)).collect();
        if !RE2_POSIX_GROUPS.contains(&name.as_str()) {
            return Err(PatternError::Invalid);
        }
        self.index += end;
        Ok(Some(name))
    }

    /// `ParseCCCharacter`: one rune of a class.
    fn class_char(&mut self) -> Result<u32, PatternError> {
        match self.tok(0) {
            Some(Tok::Char('\\')) => {
                self.index += 1;
                self.escape()
            }
            Some(Tok::Char(ch)) => {
                self.index += 1;
                Ok(u32::from(ch))
            }
            Some(Tok::Expansion(_)) => Err(MISPLACED),
            None | Some(Tok::Boundary) => Err(PatternError::Invalid),
        }
    }

    /// A range ahead (`-` and something other than `]`).
    fn range_ahead(&self) -> bool {
        self.char_at(0) == Some('-') && self.tok(1).is_some_and(|tok| tok != Tok::Char(']'))
    }

    /// `ParseCharClass` after its `[`.
    fn class(&mut self) -> Result<(), PatternError> {
        self.quantifier = Quantifier::None;
        let negated = self.char_at(0) == Some('^');
        if negated {
            self.index += 1;
        }
        let mut items = String::new();
        let mut first = true;
        loop {
            match self.tok(0) {
                None | Some(Tok::Boundary) => return Err(PatternError::Invalid),
                Some(Tok::Char(']')) if !first => {
                    self.index += 1;
                    break;
                }
                Some(Tok::Expansion(expansion)) => {
                    // The package believed it was outside a class and added brackets.
                    if expansion.bracketed {
                        return Err(MISPLACED);
                    }
                    self.index += 1;
                    first = false;
                    // A `-` after the bare ranges would join the last one.
                    if self.range_ahead() {
                        return Err(MISPLACED);
                    }
                    items.push_str(&expansion_text(expansion, true)?);
                    continue;
                }
                Some(Tok::Char(_)) => {}
            }
            first = false;
            if self.char_at(0) == Some('[')
                && self.char_at(1) == Some(':')
                && let Some(posix) = self.posix_class()?
            {
                items.push_str(&posix);
                continue;
            }
            if self.char_at(0) == Some('\\')
                && let Some(letter) = self.char_at(1)
            {
                if matches!(letter, 'p' | 'P') {
                    self.index += 2;
                    items.push_str(&self.unicode_group_items(letter)?);
                    continue;
                }
                if matches!(letter, 'd' | 'D' | 's' | 'S' | 'w' | 'W') {
                    self.index += 2;
                    items.push_str(&perl_class(letter, true));
                    continue;
                }
            }
            let lo = self.class_char()?;
            let hi = if self.range_ahead() {
                self.index += 1;
                let hi = self.class_char()?;
                if hi < lo {
                    return Err(PatternError::Invalid);
                }
                hi
            } else {
                lo
            };
            class_range(&mut items, lo, hi);
        }
        self.out.push_str(&bracket(&items, negated));
        self.atom();
        Ok(())
    }
}

/// `\d`, `\s`, `\w` and their negations, ASCII as RE2 has them.
fn perl_class(letter: char, in_class: bool) -> String {
    let body = match letter.to_ascii_lowercase() {
        'd' => DIGIT,
        's' => SPACE,
        _ => WORD,
    };
    match (letter.is_ascii_uppercase(), in_class) {
        (false, true) => body.to_owned(),
        (true, _) => format!("[^{body}]"),
        (false, false) => format!("[{body}]"),
    }
}

#[cfg(test)]
mod tests {
    use super::super::js::Rewriter;
    use super::super::re2_names::{JS_BINARY_PROPERTIES, JS_SCRIPT_EXTENSIONS};
    use super::*;

    fn translated(source: &str) -> Result<String, PatternError> {
        translate(&Rewriter::whole(source), false).map(|translation| translation.regex)
    }

    #[test]
    fn the_constant_pattern_compiles() {
        assert!(CAPTURE_NAME.is_some());
        assert!(Regex::new(NOTHING).is_ok());
        assert!(Regex::new(EVERYTHING).is_ok());
    }

    #[test]
    fn every_re2_group_name_has_a_regex_class() {
        for name in RE2_UNICODE_GROUPS {
            let items = unicode_group(name).unwrap();
            assert!(
                Regex::new(&bracket(&items, false)).is_ok(),
                "{name}: {items}"
            );
            assert!(
                Regex::new(&bracket(&items, true)).is_ok(),
                "{name}: {items}"
            );
        }
    }

    #[test]
    fn package_property_names_missing_from_regex_are_few_and_listed() {
        let missing: Vec<String> = JS_BINARY_PROPERTIES
            .iter()
            .map(|name| (PropertySet::Binary(name), *name))
            .chain(
                JS_SCRIPT_EXTENSIONS
                    .iter()
                    .map(|name| (PropertySet::ScriptExtension(name), *name)),
            )
            .filter(|(set, _)| {
                expansion_text(
                    Expansion {
                        set: *set,
                        negated: false,
                        bracketed: true,
                    },
                    false,
                )
                .is_err()
            })
            .map(|(_, name)| name.to_owned())
            .collect();
        // Unicode 17 additions the `regex` crate's tables (Unicode 16) do not have yet.
        assert!(missing.len() < 20, "{missing:?}");
    }

    #[test]
    fn names_become_numbers_and_literals_are_escaped() {
        assert_eq!(translated("(?P<a>x)(?<b>y)").unwrap(), "(x)(y)");
        assert_eq!(
            translated("(?P<w>spam)|(?P<w>scam)"),
            Err(PatternError::Unsupported("duplicate capture group name"))
        );
        assert_eq!(
            translated("[a-c&&~]").unwrap(),
            r"[\x{61}-\x{63}\x{26}\x{26}\x{7E}]"
        );
        assert_eq!(translated(r"\uD83D").unwrap(), NOTHING);
        assert_eq!(translated(r"[\uD800-\uE000]").unwrap(), r"[\x{E000}]");
    }
}
