//! Blocks to command text (`to_source.ts`). Expects a normalized tree.
//!
//! Contexts follow the real grammar:
//! - top level: plain text is copied (start tokens escaped); anything else is one expression;
//! - "sequence" spots (function args, variable values, loop bodies) read single tokens, so math,
//!   if and loops need their own `*( … )`;
//! - "expression" spots (inside `*( … )`, sides of a check, list items, `${…}`) read full
//!   expressions; nested ones get parentheses.
//!
//! The writer streams into one buffer. It always walks the whole tree (so errors come in the
//! reference's order) and always counts characters, but stores nothing past its cap: a tree that
//! expands far beyond the command limit costs no more memory than the limit.

use super::names;
use super::{BlockAccessor, BlockKind, BlockNode, BlockRoot, BlocksError};
use crate::syntax::LoopMode;

/// Start tokens, longest first so `%del(` is seen before `%(`.
const START_TOKENS: [&str; 6] = ["%del(", "$(", "%(", "*(", "^(", "#("];

/// Words that would be read as syntax when bare.
const RESERVED_WORDS: [&str; 3] = ["for", "in", "random"];

pub(crate) struct Writer {
    text: String,
    chars: usize,
    cap: usize,
}

impl Writer {
    /// A writer that stores at most `cap` characters.
    pub fn new(cap: usize) -> Self {
        Self {
            text: String::new(),
            chars: 0,
            cap,
        }
    }

    /// Characters written, stored or not.
    pub fn chars(&self) -> usize {
        self.chars
    }

    /// The text, when everything written was stored.
    pub fn finish(self) -> Option<String> {
        (self.chars <= self.cap).then_some(self.text)
    }

    fn push(&mut self, piece: &str) {
        let count = dima_text::char_len(piece);
        if self.chars.saturating_add(count) <= self.cap {
            self.text.push_str(piece);
        }
        self.chars = self.chars.saturating_add(count);
    }

    fn push_char(&mut self, ch: char) {
        if self.chars < self.cap {
            self.text.push(ch);
        }
        self.chars = self.chars.saturating_add(1);
    }

    /// `rootToSource`.
    pub fn root(&mut self, root: &BlockRoot) -> Result<(), BlocksError> {
        for node in &root.children {
            match &node.kind {
                BlockKind::Literal { value } => self.chat_text(value),
                BlockKind::Raw { source } => self.push(source),
                _ => self.top_level(node)?,
            }
        }
        Ok(())
    }

    /// `topLevel`: one top-level expression.
    pub fn top_level(&mut self, node: &BlockNode) -> Result<(), BlocksError> {
        match &node.kind {
            BlockKind::Function { .. }
            | BlockKind::CommandRef { .. }
            | BlockKind::GetVar { .. }
            | BlockKind::SetVar { .. }
            | BlockKind::Exists { .. }
            | BlockKind::DeleteVar { .. }
            | BlockKind::ForLoop { .. } => self.seq(node),
            BlockKind::Literal { value } => {
                self.push("*(");
                self.literal(value);
                self.push(")");
                Ok(())
            }
            _ => {
                self.push("*(");
                self.expr(node)?;
                self.push(")");
                Ok(())
            }
        }
    }

    /// `escapeChatText`: a backslash before every start token, so chat shows it as text.
    fn chat_text(&mut self, text: &str) {
        for (at, ch) in text.char_indices() {
            let tail = text.get(at..).unwrap_or_default();
            if START_TOKENS.iter().any(|token| tail.starts_with(token)) {
                self.push_char('\\');
            }
            self.push_char(ch);
        }
    }

    /// `literal`: a text value inside an expression, bare when safe, otherwise quoted.
    fn literal(&mut self, value: &str) {
        if names::bare_word(value) && !reserved(value) {
            self.push(value);
        } else {
            self.push("\"");
            self.quoted(value);
            self.push("\"");
        }
    }

    /// `escapeQuoted`.
    fn quoted(&mut self, value: &str) {
        let mut plain = 0;
        for (at, ch) in value.char_indices() {
            let escaped = match ch {
                '\\' => "\\\\",
                '"' => "\\\"",
                '\n' => "\\n",
                '\t' => "\\t",
                _ => continue,
            };
            self.push(value.get(plain..at).unwrap_or_default());
            self.push(escaped);
            plain = at + ch.len_utf8();
        }
        self.push(value.get(plain..).unwrap_or_default());
    }

    /// Sequence spot: function args, variable values, user selectors, loop bodies.
    fn seq(&mut self, node: &BlockNode) -> Result<(), BlocksError> {
        match &node.kind {
            BlockKind::Literal { value } => self.literal(value),
            BlockKind::LoopVar { name } => {
                self.push("#");
                self.push(name);
            }
            BlockKind::Function { name, args } => self.call("$(", name, args)?,
            BlockKind::CommandRef { command_name, args } => self.call("#(", command_name, args)?,
            BlockKind::GetVar {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                self.push("%(");
                self.var_target(storage.prefix(), name, user_selector.as_deref())?;
                self.read_accessor(accessor.as_ref())?;
                self.push(")");
            }
            BlockKind::Exists {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                self.push("^(");
                self.var_target(storage.prefix(), name, user_selector.as_deref())?;
                self.read_accessor(accessor.as_ref())?;
                self.push(")");
            }
            BlockKind::DeleteVar {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                self.push("%del(");
                self.var_target(storage.prefix(), name, user_selector.as_deref())?;
                match accessor {
                    Some(BlockAccessor::Clear) => self.push("[]"),
                    Some(BlockAccessor::Remove { index }) => self.bracketed(index)?,
                    _ => {}
                }
                self.push(")");
            }
            BlockKind::SetVar {
                name,
                storage,
                value,
                accessor,
                user_selector,
            } => {
                self.push("%(");
                self.var_target(storage.prefix(), name, user_selector.as_deref())?;
                match accessor {
                    Some(BlockAccessor::Append) => self.push("[]"),
                    Some(BlockAccessor::SetIndex { index }) => self.bracketed(index)?,
                    _ => {}
                }
                self.push(" ");
                self.seq(value)?;
                self.push(")");
            }
            BlockKind::ArrayLiteral { items, accessor } => self.array(items, accessor.as_ref())?,
            BlockKind::Template { parts } => self.template(parts)?,
            BlockKind::ForLoop { .. } => {
                self.push("*(");
                self.for_loop(node)?;
                self.push(")");
            }
            BlockKind::Raw { .. } => {
                return Err(node.error("Advanced pieces can only be used at the top level."));
            }
            BlockKind::Group { .. } => {
                return Err(node.error("A group was not saved correctly."));
            }
            BlockKind::Binary { .. }
            | BlockKind::Unary { .. }
            | BlockKind::Ternary { .. }
            | BlockKind::LoopAssign { .. } => {
                self.push("*(");
                self.expr(node)?;
                self.push(")");
            }
        }
        Ok(())
    }

    fn call(&mut self, open: &str, name: &str, args: &[BlockNode]) -> Result<(), BlocksError> {
        self.push(open);
        self.push(name);
        for arg in args {
            self.push(" ");
            self.seq(arg)?;
        }
        self.push(")");
        Ok(())
    }

    /// Expression spot: inside `*( … )`.
    fn expr(&mut self, node: &BlockNode) -> Result<(), BlocksError> {
        match &node.kind {
            BlockKind::Binary {
                operator,
                left,
                right,
            } => {
                self.operand(left)?;
                self.push(" ");
                self.push(operator.as_str());
                self.push(" ");
                self.operand(right)
            }
            BlockKind::Unary { operator, argument } => {
                self.push(operator.as_str());
                self.push("(");
                self.expr(argument)?;
                self.push(")");
                Ok(())
            }
            BlockKind::Ternary {
                test,
                consequent,
                alternate,
            } => {
                self.operand(test)?;
                self.push(" ? ");
                self.operand(consequent)?;
                self.push(" : ");
                self.operand(alternate)
            }
            BlockKind::LoopAssign {
                name,
                operator,
                value,
            } => {
                self.push("#");
                self.push(name);
                if operator.takes_value() {
                    self.push(" ");
                    self.push(operator.as_str());
                    self.push(" ");
                    match value {
                        Some(value) => self.operand(value)?,
                        None => self.literal(""),
                    }
                } else {
                    self.push(operator.as_str());
                }
                Ok(())
            }
            _ => self.seq(node),
        }
    }

    /// Nested expressions keep their shape with parentheses.
    fn operand(&mut self, node: &BlockNode) -> Result<(), BlocksError> {
        if matches!(
            node.kind,
            BlockKind::Binary { .. }
                | BlockKind::Ternary { .. }
                | BlockKind::Unary { .. }
                | BlockKind::LoopAssign { .. }
        ) {
            self.push("(");
            self.expr(node)?;
            self.push(")");
            return Ok(());
        }
        self.expr(node)
    }

    fn var_target(
        &mut self,
        prefix: &str,
        name: &str,
        selector: Option<&BlockNode>,
    ) -> Result<(), BlocksError> {
        self.push(prefix);
        self.push(name);
        if let Some(selector) = selector {
            self.push("(");
            self.seq(selector)?;
            self.push(")");
        }
        Ok(())
    }

    fn bracketed(&mut self, index: &BlockNode) -> Result<(), BlocksError> {
        self.push("[");
        self.expr(index)?;
        self.push("]");
        Ok(())
    }

    /// `readAccessor`.
    fn read_accessor(&mut self, accessor: Option<&BlockAccessor>) -> Result<(), BlocksError> {
        match accessor {
            Some(BlockAccessor::Array) => self.push("[]"),
            Some(BlockAccessor::Random) => self.push("[random]"),
            Some(BlockAccessor::Length) => self.push("[].length"),
            Some(BlockAccessor::Index { index }) => self.bracketed(index)?,
            _ => {}
        }
        Ok(())
    }

    fn array(
        &mut self,
        items: &[BlockNode],
        accessor: Option<&BlockAccessor>,
    ) -> Result<(), BlocksError> {
        self.push("%[");
        for (i, item) in items.iter().enumerate() {
            if i > 0 {
                self.push(", ");
            }
            match &item.kind {
                BlockKind::Literal { value } => self.literal(value),
                _ => self.expr(item)?,
            }
        }
        self.push("]");
        self.read_accessor(accessor)
    }

    fn template(&mut self, parts: &[BlockNode]) -> Result<(), BlocksError> {
        self.push("\"");
        for part in parts {
            match &part.kind {
                BlockKind::Literal { value } => self.quoted(value),
                _ => {
                    self.push("${");
                    self.expr(part)?;
                    self.push("}");
                }
            }
        }
        self.push("\"");
        Ok(())
    }

    fn for_loop(&mut self, node: &BlockNode) -> Result<(), BlocksError> {
        let BlockKind::ForLoop {
            loop_var,
            mode,
            init,
            condition,
            update,
            iterable,
            body,
        } = &node.kind
        else {
            return Ok(());
        };
        self.push("for ");
        // A validated tree always has the parts of its mode; a missing one is written empty.
        let part = |writer: &mut Self, part: &Option<Box<BlockNode>>| match part {
            Some(part) => writer.expr(part),
            None => {
                writer.literal("");
                Ok(())
            }
        };
        match mode {
            LoopMode::Foreach => {
                self.push("#");
                self.push(loop_var);
                self.push(" in ");
                part(self, iterable)?;
            }
            LoopMode::Range => {
                part(self, init)?;
                self.push("; ");
                part(self, condition)?;
                self.push("; ");
                part(self, update)?;
            }
        }
        self.push(" { ");
        for (i, child) in body.iter().enumerate() {
            if i > 0 {
                self.push(" ");
            }
            self.seq(child)?;
        }
        self.push(" }");
        Ok(())
    }
}

/// `RESERVED_WORDS.has(value.toLowerCase())`. Lowercasing never shortens a string, so only
/// short values need the (JavaScript-exact) lowercase.
fn reserved(value: &str) -> bool {
    value.chars().nth(6).is_none() && RESERVED_WORDS.contains(&dima_text::to_lower(value).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_writer_counts_everything_but_stores_only_up_to_its_cap() {
        let mut writer = Writer::new(5);
        writer.push("ab");
        writer.push("😀😀");
        writer.push("xy");
        writer.push_char('z');
        assert_eq!(writer.chars(), 7);
        assert_eq!(writer.text, "ab😀😀");
        assert_eq!(writer.finish(), None);
        let mut writer = Writer::new(4);
        writer.push("😀😀😀😀");
        assert_eq!(writer.finish().as_deref(), Some("😀😀😀😀"));
    }

    #[test]
    fn chat_text_escapes_every_start_token() {
        let mut writer = Writer::new(usize::MAX);
        writer.chat_text("type $(user) or %del(x) 😀 %(y)");
        assert_eq!(
            writer.finish().as_deref(),
            Some("type \\$(user) or \\%del(x) 😀 \\%(y)")
        );
    }

    #[test]
    fn reserved_words_are_quoted_in_any_case() {
        for word in ["for", "FOR", "In", "rAnDoM"] {
            let mut writer = Writer::new(usize::MAX);
            writer.literal(word);
            assert_eq!(writer.finish(), Some(format!("\"{word}\"")));
        }
        let mut writer = Writer::new(usize::MAX);
        writer.literal("ʀandom");
        assert_eq!(writer.finish().as_deref(), Some("ʀandom"));
    }
}
