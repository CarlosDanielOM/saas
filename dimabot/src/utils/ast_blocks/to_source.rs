use std::collections::VecDeque;

use super::{
    types::*,
    validate::{Rules, units},
};
use crate::utils::ast_syntax::JsString;

// Valid UTF8 needs at most three bytes per retained UTF16 code unit.
const MAX_OUTPUT_BYTES: usize = MAX_COMMAND_TEXT * 3;

fn literal_like(kind: &BlockKind) -> bool {
    matches!(
        kind,
        BlockKind::Literal { .. } | BlockKind::LiteralUtf16 { .. }
    )
}

#[derive(Clone, Copy)]
enum RunItem<'a> {
    Char(&'a BlockNode, usize, char),
    Unit(&'a BlockNode, usize, u16),
}
impl RunItem<'_> {
    fn token_char(self, expected: char) -> bool {
        match self {
            Self::Char(_, _, ch) => ch == expected,
            Self::Unit(_, _, unit) => unit == expected as u16,
        }
    }
}

/// One lazy output buffer. After the first excess append it only counts UTF16
/// units. Requested capacity grows explicitly up to MAX_OUTPUT_BYTES instead
/// of relying on String's automatic geometric growth.
pub(crate) struct Writer<'a> {
    text: String,
    /// Created only when a value contains unpaired UTF-16 units. Until then the
    /// existing UTF-8 buffer and its capacity behavior are untouched.
    lossless: Option<Vec<u16>>,
    bounded: bool,
    pub units: usize,
    pub retained: usize,
    culprit: Option<BlocksError>,
    boundary: Option<BlocksError>,
    rules: &'a Rules,
    pub(crate) contributions: Option<Vec<usize>>,
}
impl<'a> Writer<'a> {
    pub(crate) fn new(rules: &'a Rules) -> Self {
        Self {
            text: String::new(),
            lossless: None,
            bounded: true,
            units: 0,
            retained: 0,
            culprit: None,
            boundary: None,
            rules,
            contributions: None,
        }
    }
    fn standalone(rules: &'a Rules) -> Self {
        let mut writer = Self::new(rules);
        writer.bounded = false;
        writer
    }
    pub(crate) fn with_contributions(rules: &'a Rules, sources: usize) -> Self {
        let mut writer = Self::new(rules);
        writer.contributions = Some(vec![0; sources]);
        writer
    }
    fn retain(&mut self, s: &str) {
        if self.lossless.is_some() {
            let bounded = self.bounded;
            let units = self.lossless.as_mut().expect("checked");
            if bounded {
                let required = units.len() + s.encode_utf16().count();
                if required > units.capacity() {
                    let capacity = units
                        .capacity()
                        .saturating_mul(2)
                        .clamp(64, MAX_COMMAND_TEXT)
                        .max(required);
                    units.reserve_exact(capacity - units.len());
                }
            }
            units.extend(s.encode_utf16());
            return;
        }
        if !self.bounded {
            self.text.push_str(s);
            return;
        }
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
    /// Switch to exact units only at the first unpaired surrogate. Existing
    /// UTF-8 text already written is encoded without normalization.
    fn initialize_lossless(&mut self, n: &BlockNode, field: Option<&str>) {
        if self.lossless.is_some() {
            return;
        }
        self.lossless = Some(self.text.encode_utf16().collect());
        self.text.clear();
        if self.boundary.is_none() {
            self.boundary = Some(n.error(
                BlocksErrorCode::UnpairedSurrogate,
                "This command contains an unpaired UTF-16 surrogate and cannot be written as UTF-8 text.",
                field,
            ));
        }
    }
    fn retain_units(&mut self, value: &[u16], n: &BlockNode, field: Option<&str>) {
        self.initialize_lossless(n, field);
        let bounded = self.bounded;
        let units = self.lossless.as_mut().expect("initialized");
        if bounded {
            let required = units.len() + value.len();
            if required > units.capacity() {
                let capacity = units
                    .capacity()
                    .saturating_mul(2)
                    .clamp(64, MAX_COMMAND_TEXT)
                    .max(required);
                units.reserve_exact(capacity - units.len());
            }
        }
        units.extend_from_slice(value);
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
        // Standalone exported writers return text only: no output cap,
        // provenance, contribution accounting or UTF16 error budget applies.
        if !self.bounded {
            self.retain(s);
            return;
        }
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
            if !self.bounded || self.units <= MAX_COMMAND_TEXT {
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
    fn append_units_at(
        &mut self,
        value: &[u16],
        n: &BlockNode,
        field: Option<&str>,
        literal: Option<usize>,
    ) {
        // Standalone exported writers return units only: no output cap,
        // provenance, contribution accounting or UTF16 error budget applies.
        if !self.bounded {
            self.retain_units(value, n, field);
            return;
        }
        let added = value.len();
        let remaining = MAX_COMMAND_TEXT.saturating_sub(self.units);
        self.units = self.units.saturating_add(added);
        if let Some(contributions) = &mut self.contributions {
            let origin = literal
                .and_then(|offset| n.text_origin(offset))
                .map_or(&n.origin, |piece| &piece.origin);
            if let Some(index) = origin.source_index() {
                contributions[index] = contributions[index].saturating_add(added);
            }
        }
        if self.culprit.is_none() {
            if self.units <= MAX_COMMAND_TEXT {
                self.retain_units(value, n, field);
                self.retained = self.units;
            } else if let Some(start) = literal {
                let offset = start.saturating_add(remaining.min(value.len()));
                self.culprit = Some(n.text_error(BlocksErrorCode::OutputLimit, "", offset));
            } else {
                self.culprit = Some(n.error(BlocksErrorCode::OutputLimit, "", field));
            }
        }
    }
    fn literal_append_units(&mut self, value: &[u16], n: &BlockNode, offset: usize) {
        self.append_units_at(value, n, Some("value"), Some(offset));
    }
    fn quoted_inner_units(&mut self, value: &JsString, n: &BlockNode, field: &str) {
        for (offset, &unit) in value.units().iter().enumerate() {
            match unit {
                unit if unit == u16::from(b'\\') => {
                    self.append_units_at(&[u16::from(b'\\'), u16::from(b'\\')], n, Some(field), Some(offset))
                }
                unit if unit == u16::from(b'"') => {
                    self.append_units_at(&[u16::from(b'\\'), u16::from(b'"')], n, Some(field), Some(offset))
                }
                unit if unit == u16::from(b'\n') => {
                    self.append_units_at(&[u16::from(b'\\'), u16::from(b'n')], n, Some(field), Some(offset))
                }
                unit if unit == u16::from(b'\t') => {
                    self.append_units_at(&[u16::from(b'\\'), u16::from(b't')], n, Some(field), Some(offset))
                }
                unit => self.append_units_at(&[unit], n, Some(field), Some(offset)),
            }
        }
    }
    fn quoted_inner_value(&mut self, value: &JsString, n: &BlockNode, field: &str) {
        match value.to_utf8() {
            Ok(text) => self.quoted_inner(&text, n, field),
            Err(_) => self.quoted_inner_units(value, n, field),
        }
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
    fn starts_units(units: &[u16], token: &str) -> bool {
        units.len() >= token.len()
            && units
                .iter()
                .zip(token.as_bytes())
                .all(|(unit, byte)| *unit == u16::from(*byte))
    }
    fn chat_units(&mut self, value: &JsString, n: &BlockNode) {
        let units = value.units();
        for (i, &unit) in units.iter().enumerate() {
            if ["%del(", "$(", "%(", "*(", "^(", "#("]
                .iter()
                .any(|token| Self::starts_units(&units[i..], token))
            {
                self.literal_append_units(&[u16::from(b'\\')], n, i);
            }
            self.literal_append_units(&[unit], n, i);
        }
    }
    fn chat_value(&mut self, value: &JsString, n: &BlockNode) {
        match value.to_utf8() {
            Ok(text) => self.chat(&text, n),
            Err(_) => self.chat_units(value, n),
        }
    }
    fn literal_value(&mut self, value: &JsString, n: &BlockNode) {
        match value.to_utf8() {
            Ok(text) => self.literal(&text, n),
            Err(_) => {
                self.literal_append_units(&[u16::from(b'"')], n, 0);
                self.quoted_inner_units(value, n, "value");
                self.literal_append_units(
                    &[u16::from(b'"')],
                    n,
                    value.len().saturating_sub(1),
                );
            }
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
    /// Mixed UTF-8/lossless literal runs. Each item keeps its own node and
    /// native offset (bytes for `Literal`, units for `LiteralUtf16`) so error
    /// provenance stays exact. The stream is bounded by MAX_COMMAND_TEXT.
    fn chat_run_lossless(&mut self, nodes: &[&BlockNode]) {
        let mut stream: Vec<RunItem<'_>> = Vec::new();
        for node in nodes {
            match &node.kind {
                BlockKind::Literal { value } => stream.extend(
                    value
                        .char_indices()
                        .map(|(offset, ch)| RunItem::Char(*node, offset, ch)),
                ),
                BlockKind::LiteralUtf16 { value } => stream.extend(
                    value
                        .0
                        .units()
                        .iter()
                        .enumerate()
                        .map(|(offset, unit)| RunItem::Unit(*node, offset, *unit)),
                ),
                _ => unreachable!("literal run"),
            }
        }
        let mut lookahead = VecDeque::with_capacity(5);
        let mut at = 0;
        loop {
            while lookahead.len() < 5 && at < stream.len() {
                lookahead.push_back(stream[at]);
                at += 1;
            }
            let Some(&item) = lookahead.front() else {
                break;
            };
            if ["%del(", "$(", "%(", "*(", "^(", "#("]
                .iter()
                .any(|token| {
                    lookahead.len() >= token.len()
                        && lookahead
                            .iter()
                            .zip(token.chars())
                            .all(|(item, expected)| (*item).token_char(expected))
                })
            {
                match item {
                    RunItem::Char(node, offset, _) => self.literal_append("\\", node, offset),
                    RunItem::Unit(node, offset, _) => {
                        self.literal_append_units(&[u16::from(b'\\')], node, offset)
                    }
                }
            }
            match item {
                RunItem::Char(node, offset, ch) => {
                    self.literal_append(ch.encode_utf8(&mut [0; 4]), node, offset);
                }
                RunItem::Unit(node, offset, unit) => {
                    self.literal_append_units(&[unit], node, offset)
                }
            }
            lookahead.pop_front();
        }
    }
    pub(crate) fn root_nodes(&mut self, nodes: &[&BlockNode]) -> Result<(), BlocksError> {
        let mut i = 0;
        while i < nodes.len() {
            if literal_like(&nodes[i].kind) {
                let start = i;
                while i < nodes.len() && literal_like(&nodes[i].kind) {
                    i += 1;
                }
                if nodes[start..i]
                    .iter()
                    .all(|node| matches!(&node.kind, BlockKind::Literal { .. }))
                {
                    self.chat_run(&nodes[start..i]);
                } else {
                    self.chat_run_lossless(&nodes[start..i]);
                }
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
        // Preserve the exact historical path for UTF-8-only roots. A lossless
        // root uses the same adjacent-run escaping as imported chat text so a
        // syntax start split across two literals is still protected.
        if root
            .children
            .iter()
            .any(|node| matches!(&node.kind, BlockKind::LiteralUtf16 { .. }))
        {
            return self.root_nodes(&root.children.iter().collect::<Vec<_>>());
        }
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
            LiteralUtf16 { value } => self.literal_value(&value.0, n),
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
                let allowed = if matches!(&n.kind, DeleteVar { .. }) {
                    matches!(
                        accessor,
                        Some(BlockAccessor::Clear | BlockAccessor::Remove { .. })
                    )
                } else {
                    matches!(
                        accessor,
                        Some(
                            BlockAccessor::Array
                                | BlockAccessor::Random
                                | BlockAccessor::Length
                                | BlockAccessor::Index { .. }
                        )
                    )
                };
                if allowed {
                    self.accessor(accessor, n)?;
                }
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
                if matches!(
                    accessor,
                    Some(BlockAccessor::Append | BlockAccessor::SetIndex { .. })
                ) {
                    self.accessor(accessor, n)?;
                }
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
                if matches!(
                    accessor,
                    Some(
                        BlockAccessor::Array
                            | BlockAccessor::Random
                            | BlockAccessor::Length
                            | BlockAccessor::Index { .. }
                    )
                ) {
                    self.accessor(accessor, n)?;
                }
            }
            Template { parts } => {
                self.append("\"", n, None);
                for part in parts {
                    match &part.kind {
                        Literal { value } => self.quoted_inner(value, part, "value"),
                        LiteralUtf16 { value } => self.quoted_inner_value(&value.0, part, "value"),
                        _ => {
                            self.append("${", part, None);
                            self.expr(part)?;
                            self.append("}", part, None);
                        }
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
                    self.expr(iterable.as_ref().ok_or_else(|| {
                        n.error(
                            BlocksErrorCode::MissingField,
                            "Fill in the repeat.",
                            Some("iterable"),
                        )
                    })?)?;
                } else {
                    self.expr(init.as_ref().ok_or_else(|| {
                        n.error(
                            BlocksErrorCode::MissingField,
                            "Fill in the repeat.",
                            Some("init"),
                        )
                    })?)?;
                    self.append("; ", n, None);
                    self.expr(condition.as_ref().ok_or_else(|| {
                        n.error(
                            BlocksErrorCode::MissingField,
                            "Fill in the repeat.",
                            Some("condition"),
                        )
                    })?)?;
                    self.append("; ", n, None);
                    self.expr(update.as_ref().ok_or_else(|| {
                        n.error(
                            BlocksErrorCode::MissingField,
                            "Fill in the repeat.",
                            Some("update"),
                        )
                    })?)?;
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
        if let Some(e) = self.boundary {
            // A programmatic or non-normalized lossless value can still form
            // valid UTF-8 after adjacent units combine. In that case the UTF-8
            // boundary is representable and the original text is returned.
            if let Some(units) = self.lossless.as_ref()
                && let Ok(text) = String::from_utf16(units)
            {
                return Ok(text);
            }
            return Err(e);
        }
        Ok(self.text)
    }
    /// Exact-unit output boundary. The UTF-8-only `finish` above reports the
    /// same unpaired-surrogate boundary as a structured error instead.
    pub(crate) fn finish_utf16(self, stats: &mut BlocksStats) -> Result<JsString, BlocksError> {
        stats.output_units = self.units;
        stats.retained_output_units = stats.retained_output_units.max(self.retained);
        if let Some(mut e) = self.culprit {
            e.message = format!(
                "This command is too long ({} of {MAX_COMMAND_TEXT} characters).",
                self.units
            );
            return Err(e);
        }
        Ok(match self.lossless {
            Some(units) => JsString::from_units(units),
            None => JsString::from(self.text),
        })
    }
}

/// Serialize an already normalized root without parsing or normalizing again.
/// Like the original standalone writer this imposes no command-output ceiling;
/// `compile_blocks` remains the bounded application validation boundary.
pub fn root_to_source(root: &BlockRoot) -> Result<String, BlocksError> {
    let mut writer = Writer::standalone(super::validate::rules());
    writer.root(root)?;
    writer.finish(&mut BlocksStats::default())
}

/// Exact-unit counterpart of `root_to_source`. Values with unpaired surrogates
/// are written as their original units; the UTF-8 entry point above returns a
/// structured error instead of replacing them.
pub fn root_to_source_utf16(root: &BlockRoot) -> Result<JsString, BlocksError> {
    let mut writer = Writer::standalone(super::validate::rules());
    writer.root(root)?;
    writer.finish_utf16(&mut BlocksStats::default())
}

/// Serialize one expression in the top-level command context.
pub fn top_level(node: &BlockNode) -> Result<String, BlocksError> {
    let mut writer = Writer::standalone(super::validate::rules());
    writer.top(node)?;
    writer.finish(&mut BlocksStats::default())
}

/// Exact-unit counterpart of `top_level`.
pub fn top_level_utf16(node: &BlockNode) -> Result<JsString, BlocksError> {
    let mut writer = Writer::standalone(super::validate::rules());
    writer.top(node)?;
    writer.finish_utf16(&mut BlocksStats::default())
}

/// Protect each command-syntax start inside plain chat text.
pub fn escape_chat_text(text: &str) -> String {
    let node = BlockNode::new(
        "",
        BlockKind::Literal {
            value: String::new(),
        },
    );
    let mut writer = Writer::standalone(super::validate::rules());
    writer.chat(text, &node);
    writer.text
}

/// Render one expression literal, quoting syntax words and unsafe text.
pub fn literal(value: &str) -> String {
    let node = BlockNode::new(
        "",
        BlockKind::Literal {
            value: String::new(),
        },
    );
    let mut writer = Writer::standalone(super::validate::rules());
    writer.literal(value, &node);
    writer.text
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
