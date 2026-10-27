use std::collections::VecDeque;

use super::{
    types::*,
    validate::{Rules, units},
};

// Valid UTF8 needs at most three bytes per retained UTF16 code unit.
const MAX_OUTPUT_BYTES: usize = MAX_COMMAND_TEXT * 3;

/// One lazy output buffer. After the first excess append it only counts UTF16
/// units. Requested capacity grows explicitly up to MAX_OUTPUT_BYTES instead
/// of relying on String's automatic geometric growth.
pub(crate) struct Writer<'a> {
    text: String,
    pub units: usize,
    pub retained: usize,
    culprit: Option<BlocksError>,
    rules: &'a Rules,
    pub(crate) contributions: Option<Vec<usize>>,
}
impl<'a> Writer<'a> {
    pub(crate) fn new(rules: &'a Rules) -> Self {
        Self {
            text: String::new(),
            units: 0,
            retained: 0,
            culprit: None,
            rules,
            contributions: None,
        }
    }
    pub(crate) fn with_contributions(rules: &'a Rules, sources: usize) -> Self {
        let mut writer = Self::new(rules);
        writer.contributions = Some(vec![0; sources]);
        writer
    }
    fn retain(&mut self, s: &str) {
        let required = self.text.len() + s.len();
        debug_assert!(required <= MAX_OUTPUT_BYTES);
        if required > self.text.capacity() {
            let capacity = self
                .text
                .capacity()
                .saturating_mul(2)
                .clamp(64, MAX_OUTPUT_BYTES)
                .max(required);
            // reserve_exact takes additional bytes relative to length, not
            // capacity. push_str then has room and cannot trigger its own grow.
            self.text.reserve_exact(capacity - self.text.len());
        }
        debug_assert!(self.text.capacity() <= MAX_OUTPUT_BYTES);
        self.text.push_str(s);
    }
    fn append(&mut self, s: &str, n: &BlockNode, field: Option<&str>) {
        self.append_at(s, n, field, None);
    }
    fn append_at(
        &mut self,
        s: &str,
        n: &BlockNode,
        field: Option<&str>,
        literal: Option<(usize, bool)>,
    ) {
        let added = units(s);
        let remaining = MAX_COMMAND_TEXT.saturating_sub(self.units);
        self.units = self.units.saturating_add(added);
        if let Some(contributions) = &mut self.contributions {
            let origin = literal
                .and_then(|(offset, _)| n.text_origin(offset))
                .map_or(&n.origin, |piece| &piece.origin);
            if let Some(index) = origin.source_index() {
                contributions[index] = contributions[index].saturating_add(added);
            }
        }
        if self.culprit.is_none() {
            if self.units <= MAX_COMMAND_TEXT {
                self.retain(s);
                self.retained = self.units;
            } else if let Some((start, direct)) = literal {
                let mut offset = start;
                if direct {
                    let mut counted = 0;
                    for (byte, ch) in s.char_indices() {
                        counted += ch.len_utf16();
                        if counted > remaining {
                            offset += byte;
                            break;
                        }
                    }
                }
                self.culprit = Some(n.text_error(BlocksErrorCode::OutputLimit, "", offset));
            } else {
                self.culprit = Some(n.error(BlocksErrorCode::OutputLimit, "", field));
            }
        }
    }
    fn literal_append(&mut self, text: &str, n: &BlockNode, offset: usize) {
        self.append_at(text, n, Some("value"), Some((offset, false)));
    }
    fn quoted_inner(&mut self, s: &str, n: &BlockNode, field: &str) {
        for (offset, ch) in s.char_indices() {
            let mut encoded = [0; 4];
            let escaped = match ch {
                '\\' => "\\\\",
                '"' => "\\\"",
                '\n' => "\\n",
                '\t' => "\\t",
                _ => ch.encode_utf8(&mut encoded),
            };
            self.append_at(escaped, n, Some(field), Some((offset, false)));
        }
    }
    fn literal(&mut self, s: &str, n: &BlockNode) {
        if self.rules.bare(s) {
            self.append_at(s, n, Some("value"), Some((0, true)));
        } else {
            self.literal_append("\"", n, 0);
            self.quoted_inner(s, n, "value");
            self.literal_append("\"", n, s.char_indices().next_back().map_or(0, |(i, _)| i));
        }
    }
    fn chat(&mut self, s: &str, n: &BlockNode) {
        for (i, ch) in s.char_indices() {
            if ["%del(", "$(", "%(", "*(", "^(", "#("]
                .iter()
                .any(|token| s[i..].starts_with(token))
            {
                self.literal_append("\\", n, i);
            }
            self.literal_append(ch.encode_utf8(&mut [0; 4]), n, i);
        }
    }
    /// Stream adjacent literal pieces as a single chat-text run, including
    /// syntax starts split across pieces. Five characters of lookahead suffice;
    /// no joined text buffer or child strings are created.
    fn chat_run(&mut self, nodes: &[&BlockNode]) {
        let mut chars = nodes.iter().flat_map(|node| {
            let BlockKind::Literal { value } = &node.kind else {
                unreachable!("literal run")
            };
            value
                .char_indices()
                .map(move |(offset, ch)| (*node, offset, ch))
        });
        let mut lookahead = VecDeque::with_capacity(5);
        loop {
            while lookahead.len() < 5 {
                let Some(item) = chars.next() else {
                    break;
                };
                lookahead.push_back(item);
            }
            let Some(&(node, offset, ch)) = lookahead.front() else {
                break;
            };
            if ["%del(", "$(", "%(", "*(", "^(", "#("].iter().any(|token| {
                lookahead.len() >= token.len()
                    && lookahead
                        .iter()
                        .zip(token.chars())
                        .all(|(item, expected)| item.2 == expected)
            }) {
                self.literal_append("\\", node, offset);
            }
            self.literal_append(ch.encode_utf8(&mut [0; 4]), node, offset);
            lookahead.pop_front();
        }
    }
    pub(crate) fn root_nodes(&mut self, nodes: &[&BlockNode]) -> Result<(), BlocksError> {
        let mut i = 0;
        while i < nodes.len() {
            if matches!(&nodes[i].kind, BlockKind::Literal { .. }) {
                let start = i;
                while i < nodes.len() && matches!(&nodes[i].kind, BlockKind::Literal { .. }) {
                    i += 1;
                }
                self.chat_run(&nodes[start..i]);
            } else {
                let node = nodes[i];
                match &node.kind {
                    BlockKind::Raw { source } => self.append(source, node, Some("source")),
                    _ => self.top(node)?,
                }
                i += 1;
            }
        }
        Ok(())
    }
    pub(crate) fn root(&mut self, root: &BlockRoot) -> Result<(), BlocksError> {
        for n in &root.children {
            match &n.kind {
                BlockKind::Literal { value } => self.chat(value, n),
                BlockKind::Raw { source } => self.append(source, n, Some("source")),
                _ => self.top(n)?,
            }
        }
        Ok(())
    }
    pub(crate) fn top(&mut self, n: &BlockNode) -> Result<(), BlocksError> {
        match &n.kind {
            BlockKind::Function { .. }
            | BlockKind::CommandRef { .. }
            | BlockKind::GetVar { .. }
            | BlockKind::SetVar { .. }
            | BlockKind::Exists { .. }
            | BlockKind::DeleteVar { .. }
            | BlockKind::ForLoop { .. } => self.seq(n),
            _ => {
                self.append("*(", n, None);
                self.expr(n)?;
                self.append(")", n, None);
                Ok(())
            }
        }
    }
    fn sequence(
        &mut self,
        nodes: &[BlockNode],
        n: &BlockNode,
        separator: &str,
    ) -> Result<(), BlocksError> {
        for (i, child) in nodes.iter().enumerate() {
            if i > 0 {
                self.append(separator, n, None);
            }
            self.seq(child)?;
        }
        Ok(())
    }
    fn target(
        &mut self,
        name: &str,
        storage: BlockStorage,
        selector: &Option<Box<BlockNode>>,
        n: &BlockNode,
    ) -> Result<(), BlocksError> {
        self.append(storage.prefix(), n, Some("storage"));
        self.append(name, n, Some("name"));
        if let Some(selector) = selector {
            self.append("(", n, None);
            self.seq(selector)?;
            self.append(")", n, None);
        }
        Ok(())
    }
    fn accessor(&mut self, a: &Option<BlockAccessor>, n: &BlockNode) -> Result<(), BlocksError> {
        match a {
            Some(BlockAccessor::Array | BlockAccessor::Append | BlockAccessor::Clear) => {
                self.append("[]", n, Some("accessor"))
            }
            Some(BlockAccessor::Random) => self.append("[random]", n, Some("accessor")),
            Some(BlockAccessor::Length) => self.append("[].length", n, Some("accessor")),
            Some(
                BlockAccessor::Index { index }
                | BlockAccessor::SetIndex { index }
                | BlockAccessor::Remove { index },
            ) => {
                self.append("[", n, Some("accessor"));
                self.expr(index)?;
                self.append("]", n, Some("accessor"));
            }
            _ => {}
        }
        Ok(())
    }
    fn seq(&mut self, n: &BlockNode) -> Result<(), BlocksError> {
        use BlockKind::*;
        match &n.kind {
            Literal { value } => self.literal(value, n),
            LoopVar { name } => {
                self.append("#", n, Some("name"));
                self.append(name, n, Some("name"));
            }
            Function { name, args }
            | CommandRef {
                command_name: name,
                args,
            } => {
                self.append(
                    if matches!(&n.kind, Function { .. }) {
                        "$("
                    } else {
                        "#("
                    },
                    n,
                    None,
                );
                self.append(
                    name,
                    n,
                    Some(if matches!(&n.kind, Function { .. }) {
                        "name"
                    } else {
                        "commandName"
                    }),
                );
                if !args.is_empty() {
                    self.append(" ", n, None);
                    self.sequence(args, n, " ")?;
                }
                self.append(")", n, None);
            }
            GetVar {
                name,
                storage,
                accessor,
                user_selector,
            }
            | Exists {
                name,
                storage,
                accessor,
                user_selector,
            }
            | DeleteVar {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                self.append(
                    match &n.kind {
                        Exists { .. } => "^(",
                        DeleteVar { .. } => "%del(",
                        _ => "%(",
                    },
                    n,
                    None,
                );
                self.target(name, *storage, user_selector, n)?;
                self.accessor(accessor, n)?;
                self.append(")", n, None);
            }
            SetVar {
                name,
                storage,
                value,
                accessor,
                user_selector,
            } => {
                self.append("%(", n, None);
                self.target(name, *storage, user_selector, n)?;
                self.accessor(accessor, n)?;
                self.append(" ", n, None);
                self.seq(value)?;
                self.append(")", n, None);
            }
            ArrayLiteral { items, accessor } => {
                self.append("%[", n, None);
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.append(", ", n, None);
                    }
                    self.expr(item)?;
                }
                self.append("]", n, None);
                self.accessor(accessor, n)?;
            }
            Template { parts } => {
                self.append("\"", n, None);
                for part in parts {
                    if let Literal { value } = &part.kind {
                        self.quoted_inner(value, part, "value");
                    } else {
                        self.append("${", part, None);
                        self.expr(part)?;
                        self.append("}", part, None);
                    }
                }
                self.append("\"", n, None);
            }
            ForLoop {
                loop_var,
                mode,
                init,
                condition,
                update,
                iterable,
                body,
            } => {
                self.append("*(for ", n, None);
                if *mode == BlockLoopMode::Foreach {
                    self.append("#", n, Some("loopVar"));
                    self.append(loop_var, n, Some("loopVar"));
                    self.append(" in ", n, None);
                    self.expr(iterable.as_ref().expect("validated foreach iterable"))?;
                } else {
                    self.expr(init.as_ref().expect("validated loop init"))?;
                    self.append("; ", n, None);
                    self.expr(condition.as_ref().expect("validated loop condition"))?;
                    self.append("; ", n, None);
                    self.expr(update.as_ref().expect("validated loop update"))?;
                }
                self.append(" { ", n, None);
                self.sequence(body, n, " ")?;
                self.append(" })", n, None);
            }
            Raw { .. } => {
                return Err(n.error(
                    BlocksErrorCode::RawNotTopLevel,
                    "Advanced pieces can only be used at the top level.",
                    None,
                ));
            }
            Group { .. } => {
                return Err(n.error(
                    BlocksErrorCode::BrokenBlock,
                    "A group was not saved correctly.",
                    None,
                ));
            }
            _ => {
                self.append("*(", n, None);
                self.expr(n)?;
                self.append(")", n, None);
            }
        }
        Ok(())
    }
    fn expr(&mut self, n: &BlockNode) -> Result<(), BlocksError> {
        match &n.kind {
            BlockKind::Binary {
                operator,
                left,
                right,
            } => {
                self.operand(left)?;
                self.append(" ", n, None);
                self.append(operator.as_str(), n, Some("operator"));
                self.append(" ", n, None);
                self.operand(right)?;
            }
            BlockKind::Unary { operator, argument } => {
                self.append(operator.as_str(), n, Some("operator"));
                self.append("(", n, None);
                self.expr(argument)?;
                self.append(")", n, None);
            }
            BlockKind::Ternary {
                test,
                consequent,
                alternate,
            } => {
                self.operand(test)?;
                self.append(" ? ", n, None);
                self.operand(consequent)?;
                self.append(" : ", n, None);
                self.operand(alternate)?;
            }
            BlockKind::LoopAssign {
                name,
                operator,
                value,
            } => {
                self.append("#", n, Some("name"));
                self.append(name, n, Some("name"));
                if operator.increment() {
                    self.append(operator.as_str(), n, Some("operator"));
                } else {
                    self.append(" ", n, None);
                    self.append(operator.as_str(), n, Some("operator"));
                    self.append(" ", n, None);
                    if let Some(value) = value {
                        self.operand(value)?;
                    } else {
                        self.append("\"\"", n, Some("value"));
                    }
                }
            }
            _ => self.seq(n)?,
        }
        Ok(())
    }
    fn operand(&mut self, n: &BlockNode) -> Result<(), BlocksError> {
        let parens = matches!(
            &n.kind,
            BlockKind::Binary { .. }
                | BlockKind::Unary { .. }
                | BlockKind::Ternary { .. }
                | BlockKind::LoopAssign { .. }
        );
        if parens {
            self.append("(", n, None);
        }
        self.expr(n)?;
        if parens {
            self.append(")", n, None);
        }
        Ok(())
    }
    pub(crate) fn finish(self, stats: &mut BlocksStats) -> Result<String, BlocksError> {
        stats.output_units = self.units;
        stats.retained_output_units = stats.retained_output_units.max(self.retained);
        if let Some(mut e) = self.culprit {
            e.message = format!(
                "This command is too long ({} of {MAX_COMMAND_TEXT} characters).",
                self.units
            );
            return Err(e);
        }
        Ok(self.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::ast_blocks::validate::rules;

    #[test]
    fn lazy_capacity_growth_stays_bounded_and_stops_after_overflow() {
        let node = BlockNode::new(
            "actual",
            BlockKind::Literal {
                value: String::new(),
            },
        );
        let mut writer = Writer::new(rules());
        assert_eq!(writer.text.capacity(), 0);
        writer.chat("x", &node);
        assert!(writer.text.capacity() <= 64);
        writer.chat(&"界".repeat(MAX_COMMAND_TEXT - 1), &node);
        assert_eq!(writer.units, MAX_COMMAND_TEXT);
        assert_eq!(writer.retained, MAX_COMMAND_TEXT);
        assert_eq!(writer.text.len(), MAX_OUTPUT_BYTES - 2);
        assert!(writer.text.capacity() <= MAX_OUTPUT_BYTES);
        let capacity = writer.text.capacity();
        let length = writer.text.len();
        writer.chat(&"x".repeat(1000), &node);
        assert_eq!(writer.text.capacity(), capacity);
        assert_eq!(writer.text.len(), length);
        assert_eq!(writer.units, MAX_COMMAND_TEXT + 1000);
        let mut stats = BlocksStats::default();
        assert_eq!(
            writer.finish(&mut stats).unwrap_err().code,
            BlocksErrorCode::OutputLimit
        );
        assert_eq!(stats.retained_output_units, MAX_COMMAND_TEXT);
        assert_eq!(stats.output_units, MAX_COMMAND_TEXT + 1000);
    }
}
