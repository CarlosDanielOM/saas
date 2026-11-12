//! The parser (`registry.ts` handlers and `parse` in `parser.ts`), over a token arena.
//!
//! Token positions are arena indexes; `Token::next` skips a token with everything nested in it.
//! Where the reference compares token strings, [`Parser::text`] gives the token as written and
//! [`Parser::name_token`] gives the reference's own token string (`__TEMPLATE__:…`,
//! `__ARRAY__:…`) where that string becomes data.

use super::lexer::{TokenKind, Tokens, tokenize, unescape_literal};
use super::source::Budget;
use super::{
    ArrayAccessor, AstNode, BinaryOp, Diagnostic, DiagnosticCode, LoopAssignOp, LoopMode,
    PreparedGrammar, Span, SyntaxHandler, TemplateSegment, UnaryOp, VariableStorage,
};
use crate::text::{byte, rest, sub};
use std::ops::Range;

type Parsed = Result<(Built, usize), Diagnostic>;

pub(crate) struct Built {
    pub node: AstNode,
    /// Height of the built subtree.
    pub depth: usize,
}

pub(crate) struct Parser<'a, 'b> {
    pub tokens: &'a Tokens,
    pub grammar: &'a PreparedGrammar,
    pub budget: &'b mut Budget,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VarMode {
    Variable,
    Exists,
    Delete,
}

impl Parser<'_, '_> {
    fn token_kind(&self, i: usize) -> Option<&TokenKind> {
        self.tokens.tokens.get(i).map(|t| &t.kind)
    }

    /// The token as written, or `""` past `end`.
    fn text(&self, i: usize, end: usize) -> &str {
        if i >= end {
            return "";
        }
        self.tokens
            .tokens
            .get(i)
            .map_or("", |t| sub(&self.tokens.view.text, t.bytes.clone()))
    }

    /// The reference's token string, used where a token becomes a name.
    fn name_token(&self, i: usize, end: usize) -> String {
        if i >= end {
            return String::new();
        }
        let Some(token) = self.tokens.tokens.get(i) else {
            return String::new();
        };
        let text = &self.tokens.view.text;
        match &token.kind {
            TokenKind::Quoted(content) => format!("__TEMPLATE__:{}", sub(text, content.clone())),
            TokenKind::Array(_) => format!(
                "__ARRAY__:{}",
                sub(
                    text,
                    token.bytes.start + 2..token.bytes.end.saturating_sub(1)
                )
            ),
            TokenKind::Raw | TokenKind::Start(_) => sub(text, token.bytes.clone()).to_owned(),
        }
    }

    fn next(&self, i: usize) -> usize {
        self.tokens
            .tokens
            .get(i)
            .map_or(i.saturating_add(1), |t| t.next)
    }

    fn span(&self, i: usize) -> Span {
        self.tokens.tokens.get(i).map_or_else(
            || {
                let len = self.tokens.view.text.len();
                self.tokens.view.span(len..len)
            },
            |t| self.tokens.view.span(t.bytes.clone()),
        )
    }

    fn make(&mut self, node: AstNode, child_depth: usize, i: usize) -> Result<Built, Diagnostic> {
        let depth = child_depth + 1;
        self.budget.node(depth, self.span(i))?;
        Ok(Built { node, depth })
    }

    fn literal(&mut self, value: impl Into<String>, i: usize) -> Result<Built, Diagnostic> {
        self.make(
            AstNode::Literal {
                value: value.into(),
            },
            0,
            i,
        )
    }

    /// `parse`: the top-level loop, with `)`, `;` and `}` skipped.
    pub fn root(&mut self, range: Range<usize>, depth: usize) -> Result<Built, Diagnostic> {
        let (children, child_depth) = self.nodes(range.clone(), depth)?;
        self.make(AstNode::Root { children }, child_depth, range.start)
    }

    /// `parseTokensToNodes`.
    fn nodes(
        &mut self,
        range: Range<usize>,
        depth: usize,
    ) -> Result<(Vec<AstNode>, usize), Diagnostic> {
        self.budget.depth(depth, self.span(range.start))?;
        let mut nodes = Vec::new();
        let mut max_depth = 0;
        let mut i = range.start;
        while i < range.end {
            if matches!(self.text(i, range.end), "" | ";" | "}" | ")") {
                i = self.next(i);
                continue;
            }
            let (built, next) = self.expression(i, range.end, depth)?;
            if !built.node.is_empty_literal() {
                max_depth = max_depth.max(built.depth);
                nodes.push(built.node);
            }
            i = if next > i { next } else { self.next(i) };
        }
        Ok((nodes, max_depth))
    }

    /// `parseTokensToSingleNode`: one expression, or a root of several.
    fn single(&mut self, range: Range<usize>, depth: usize) -> Result<Built, Diagnostic> {
        if range.is_empty() {
            return self.literal("", range.start);
        }
        let (first, mut i) = self.star(range.start, range.end, 0, depth)?;
        while i < range.end && matches!(self.text(i, range.end), ";" | ")" | "}") {
            i = self.next(i);
        }
        if i >= range.end {
            return Ok(first);
        }
        let (rest, rest_depth) = self.nodes(i..range.end, depth)?;
        let max = first.depth.max(rest_depth);
        let mut children = Vec::with_capacity(rest.len() + 1);
        children.push(first.node);
        children.extend(rest);
        self.make(AstNode::Root { children }, max, range.start)
    }

    /// `parseExpression`.
    fn expression(&mut self, i: usize, end: usize, depth: usize) -> Parsed {
        self.budget.depth(depth, self.span(i))?;
        if i >= end {
            // The reference throws a TypeError here (`unescapeLiteral(undefined)`); only a user
            // selector left open at the end of an array item gets here.
            return Ok((self.literal("", i)?, self.next(i)));
        }
        let token = self.text(i, end);
        if matches!(token, ";" | "}" | ")") {
            let next = if token == ")" { i } else { self.next(i) };
            return Ok((self.literal("", i)?, next));
        }
        if loop_var(token) {
            return self.loop_variable(i, end, depth);
        }
        match self.token_kind(i).cloned() {
            Some(TokenKind::Start(def)) => self.definition(i, end, def, depth + 1),
            Some(TokenKind::Quoted(content)) => {
                let quoted = self
                    .tokens
                    .tokens
                    .get(i)
                    .map_or(content.clone(), |t| t.bytes.clone());
                let node = self.template(quoted, content, i, depth + 1)?;
                Ok((node, self.next(i)))
            }
            Some(TokenKind::Array(items)) => self.array(items, i, end, depth + 1),
            Some(TokenKind::Raw) | None => {
                let value = unescape_literal(token);
                Ok((self.literal(value, i)?, self.next(i)))
            }
        }
    }

    /// `parseAtom`.
    fn atom(&mut self, i: usize, end: usize, depth: usize) -> Parsed {
        self.budget.depth(depth, self.span(i))?;
        let token = self.text(i, end);
        if i >= end || matches!(token, ")" | ";" | "}") {
            return Ok((self.literal("", i)?, i));
        }
        if loop_var(token) {
            return self.loop_variable(i, end, depth);
        }
        if token == "(" {
            let (inner, mut next) = self.star(self.next(i), end, 0, depth + 1)?;
            if self.text(next, end) == ")" {
                next = self.next(next);
            }
            return Ok((inner, next));
        }
        if let Some(operator) = UnaryOp::parse(token) {
            let (argument, next) = self.atom(self.next(i), end, depth + 1)?;
            let child = argument.depth;
            let built = self.make(
                AstNode::Unary {
                    operator,
                    argument: Box::new(argument.node),
                },
                child,
                i,
            )?;
            return Ok((built, next));
        }
        self.expression(i, end, depth)
    }

    /// `parseStarExpression`: precedence climbing with the ternary at the lowest level.
    fn star(&mut self, i: usize, end: usize, minimum: u8, depth: usize) -> Parsed {
        self.budget.depth(depth, self.span(i))?;
        let (mut left, mut current) = self.atom(i, end, depth)?;
        loop {
            let token = self.text(current, end);
            if token.is_empty() || matches!(token, ")" | ":" | ";" | "}") {
                break;
            }
            if token == "?" {
                if minimum > 1 {
                    break;
                }
                current = self.next(current);
                let (consequent, has_alternate) = if self.text(current, end) == ":" {
                    let empty = self.literal("", current)?;
                    current = self.next(current);
                    (empty, true)
                } else {
                    let (consequent, next) = self.star(current, end, 0, depth + 1)?;
                    current = next;
                    let has = self.text(current, end) == ":";
                    if has {
                        current = self.next(current);
                    }
                    (consequent, has)
                };
                let alternate = if has_alternate {
                    let (alternate, next) = self.star(current, end, 0, depth + 1)?;
                    current = next;
                    alternate
                } else {
                    self.literal("", current)?
                };
                let child = left.depth.max(consequent.depth).max(alternate.depth);
                left = self.make(
                    AstNode::Ternary {
                        test: Box::new(left.node),
                        consequent: Box::new(consequent.node),
                        alternate: Box::new(alternate.node),
                    },
                    child,
                    i,
                )?;
                continue;
            }
            let Some(operator) = BinaryOp::parse(token) else {
                break;
            };
            let precedence = operator.precedence();
            if precedence < minimum {
                break;
            }
            let (right, next) = self.star(self.next(current), end, precedence + 1, depth + 1)?;
            let child = left.depth.max(right.depth);
            left = self.make(
                AstNode::Binary {
                    operator,
                    left: Box::new(left.node),
                    right: Box::new(right.node),
                },
                child,
                i,
            )?;
            current = next;
        }
        Ok((left, current))
    }

    fn definition(&mut self, i: usize, end: usize, def: usize, depth: usize) -> Parsed {
        self.budget.depth(depth, self.span(i))?;
        match self.grammar.handler(def) {
            SyntaxHandler::Function => self.call(i, end, depth, false),
            SyntaxHandler::CommandRef => self.call(i, end, depth, true),
            SyntaxHandler::Variable => self.variable(i, end, depth, VarMode::Variable),
            SyntaxHandler::Exists => self.variable(i, end, depth, VarMode::Exists),
            SyntaxHandler::Delete => self.variable(i, end, depth, VarMode::Delete),
            SyntaxHandler::Compute => {
                let start = self.next(i);
                if self.text(start, end).eq_ignore_ascii_case("for") {
                    return self.for_loop(i, end, depth);
                }
                let (node, mut next) = self.star(start, end, 0, depth)?;
                if self.text(next, end) == ")" {
                    next = self.next(next);
                }
                Ok((node, next))
            }
        }
    }

    /// `parseFunction` and `parseCommandRef`.
    fn call(&mut self, start: usize, end: usize, depth: usize, command: bool) -> Parsed {
        let mut i = self.next(start);
        let mut names = Vec::new();
        if command {
            let name = self.name_token(i, end);
            if name.is_empty() || name == ")" {
                return Ok((self.literal("", start)?, self.next(i)));
            }
            names.push(name);
            i = self.next(i);
        } else {
            while i < end {
                let token = self.text(i, end);
                if token == ")" || token == "(" {
                    break;
                }
                if token == "." {
                    i = self.next(i);
                    continue;
                }
                if identifier(token) {
                    names.push(token.to_owned());
                    i = self.next(i);
                    if self.text(i, end) != "." {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        let mut args = Vec::new();
        let mut max_depth = 0;
        let mut parens = 0usize;
        while i < end {
            let token = self.text(i, end);
            if token == ")" {
                if parens == 0 {
                    break;
                }
                // A balanced inner `(…)` keeps its closer as an argument.
                parens -= 1;
                let literal = self.literal(")", i)?;
                max_depth = max_depth.max(literal.depth);
                args.push(literal.node);
                i = self.next(i);
                continue;
            }
            if token == "(" {
                parens += 1;
            }
            let (arg, next) = self.expression(i, end, depth)?;
            if !arg.node.is_empty_literal() {
                max_depth = max_depth.max(arg.depth);
                args.push(arg.node);
            }
            i = if next > i { next } else { self.next(i) };
        }
        if self.text(i, end) == ")" {
            i = self.next(i);
        }
        let name = names.join(".");
        let node = if command {
            AstNode::CommandRef {
                command_name: name,
                args,
            }
        } else {
            AstNode::Function { name, args }
        };
        Ok((self.make(node, max_depth, start)?, i))
    }

    /// `parseLoopVarOrAssignment`.
    fn loop_variable(&mut self, i: usize, end: usize, depth: usize) -> Parsed {
        let name = rest(self.text(i, end), 1).to_owned();
        let op_at = self.next(i);
        let Some(operator) = LoopAssignOp::parse(self.text(op_at, end)) else {
            return Ok((self.make(AstNode::LoopVar { name }, 0, i)?, self.next(i)));
        };
        if !operator.takes_value() {
            let built = self.make(
                AstNode::LoopAssign {
                    name,
                    operator,
                    value: None,
                },
                0,
                i,
            )?;
            return Ok((built, self.next(op_at)));
        }
        let (value, next) = self.star(self.next(op_at), end, 0, depth + 1)?;
        let child = value.depth;
        let built = self.make(
            AstNode::LoopAssign {
                name,
                operator,
                value: Some(Box::new(value.node)),
            },
            child,
            i,
        )?;
        Ok((built, next))
    }

    /// `parseArrayLiteralToken`: the items, then an optional accessor.
    fn array(
        &mut self,
        ranges: Vec<Range<usize>>,
        start: usize,
        end: usize,
        depth: usize,
    ) -> Parsed {
        self.budget.depth(depth, self.span(start))?;
        let mut items = Vec::with_capacity(ranges.len());
        let mut max_depth = 0;
        for range in ranges {
            let item = if range.is_empty() {
                self.literal("", start)?
            } else {
                self.star(range.start, range.end, 0, depth)?.0
            };
            max_depth = max_depth.max(item.depth);
            items.push(item.node);
        }
        let mut next = self.next(start);
        let mut accessor = None;
        if self.text(next, end) == "[" {
            let bracket = next;
            next = self.next(next);
            if self.text(next, end) == "]" {
                next = self.next(next);
                if self.text(next, end) == "." && self.text(self.next(next), end) == "length" {
                    accessor = Some(ArrayAccessor::Length);
                    next = self.next(self.next(next));
                } else {
                    // A bare `[]` is no accessor; the tokens stay for the caller.
                    next = bracket;
                }
            } else if self.text(next, end) == "random" {
                next = self.next(next);
                if self.text(next, end) == "]" {
                    next = self.next(next);
                }
                accessor = Some(ArrayAccessor::Random);
            } else {
                let (index, after) = self.star(next, end, 0, depth)?;
                max_depth = max_depth.max(index.depth);
                next = after;
                if self.text(next, end) == "]" {
                    next = self.next(next);
                }
                accessor = Some(ArrayAccessor::Index {
                    index: Box::new(index.node),
                });
            }
        }
        Ok((
            self.make(AstNode::ArrayLiteral { items, accessor }, max_depth, start)?,
            next,
        ))
    }

    /// `parseVariable`, `parseExists` and `parseDelete` with `parseVarTarget`.
    fn variable(&mut self, start: usize, end: usize, depth: usize, mode: VarMode) -> Parsed {
        let name_at = self.next(start);
        if name_at >= end {
            // The reference throws a TypeError (`parseVarName(undefined)`).
            return Err(Diagnostic::new(
                DiagnosticCode::MissingVariableName,
                "Missing variable name",
                self.span(start),
            ));
        }
        let name = self.name_token(name_at, end);
        let storage = VariableStorage::from_name(&name);
        let mut i = self.next(name_at);
        let mut user_selector = None;
        let mut max_depth = 0;
        if storage.is_user_scoped() && self.text(i, end) == "(" {
            let (selector, next) = self.expression(self.next(i), end, depth)?;
            max_depth = max_depth.max(selector.depth);
            user_selector = Some(Box::new(selector.node));
            i = next;
            if self.text(i, end) == ")" {
                i = self.next(i);
            }
        }
        let delete = mode == VarMode::Delete;
        let mut accessor = None;
        if self.text(i, end) == "[" {
            i = self.next(i);
            if self.text(i, end) == "]" {
                i = self.next(i);
                accessor = Some(if delete {
                    ArrayAccessor::Clear
                } else {
                    ArrayAccessor::Array
                });
            } else if !delete && self.text(i, end) == "random" {
                i = self.next(i);
                if self.text(i, end) == "]" {
                    i = self.next(i);
                }
                accessor = Some(ArrayAccessor::Random);
            } else {
                let (index, next) = self.star(i, end, 0, depth)?;
                max_depth = max_depth.max(index.depth);
                i = next;
                if self.text(i, end) == "]" {
                    i = self.next(i);
                }
                let index = Box::new(index.node);
                accessor = Some(if delete {
                    ArrayAccessor::Remove { index }
                } else {
                    ArrayAccessor::Index { index }
                });
            }
        }
        if !delete && self.text(i, end) == "." {
            i = self.next(i);
            if self.text(i, end) == "length" {
                i = self.next(i);
                accessor = Some(ArrayAccessor::Length);
            }
        }
        let next = self.text(i, end);
        let assignment = mode == VarMode::Variable
            && !next.is_empty()
            && next != ")"
            && match &accessor {
                None | Some(ArrayAccessor::Index { .. }) => true,
                Some(ArrayAccessor::Array) => next != ".",
                _ => false,
            };
        let node = if assignment {
            let (value, after) = self.expression(i, end, depth)?;
            max_depth = max_depth.max(value.depth);
            i = after;
            accessor = match accessor {
                Some(ArrayAccessor::Array) => Some(ArrayAccessor::Append),
                Some(ArrayAccessor::Index { index }) => Some(ArrayAccessor::SetIndex { index }),
                other => other,
            };
            AstNode::SetVar {
                name,
                storage,
                value: Box::new(value.node),
                accessor,
                user_selector,
            }
        } else {
            match mode {
                VarMode::Exists => AstNode::Exists {
                    name,
                    storage,
                    accessor,
                    user_selector,
                },
                VarMode::Delete => AstNode::DeleteVar {
                    name,
                    storage,
                    accessor,
                    user_selector,
                },
                VarMode::Variable => AstNode::GetVar {
                    name,
                    storage,
                    accessor,
                    user_selector,
                },
            }
        };
        if self.text(i, end) == ")" {
            i = self.next(i);
        }
        Ok((self.make(node, max_depth, start)?, i))
    }

    /// `findTopLevelToken`: the first `target` outside parentheses, brackets and braces. A token
    /// whose reference string ends with `(` opens a parenthesis.
    fn top_level(&self, target: &str, start: usize, end: usize) -> Option<usize> {
        let (mut parens, mut brackets, mut braces) = (0usize, 0usize, 0usize);
        let mut i = start;
        while i < end {
            let token = self.text(i, end);
            if parens == 0 && brackets == 0 && braces == 0 && token == target {
                return Some(i);
            }
            let text = &self.tokens.view.text;
            let opens = match self.tokens.tokens.get(i) {
                Some(t) => match &t.kind {
                    TokenKind::Start(_) => true,
                    TokenKind::Quoted(content) => sub(text, content.clone()).ends_with('('),
                    TokenKind::Array(_) => {
                        sub(text, t.bytes.start + 2..t.bytes.end.saturating_sub(1)).ends_with('(')
                    }
                    TokenKind::Raw => token.ends_with('('),
                },
                None => false,
            };
            if opens {
                parens += 1;
            } else if token == ")" {
                parens = parens.saturating_sub(1);
            } else if token == "[" {
                brackets += 1;
            } else if token == "]" {
                brackets = brackets.saturating_sub(1);
            } else if token == "{" {
                braces += 1;
            } else if token == "}" {
                braces = braces.saturating_sub(1);
            }
            i = self.next(i);
        }
        None
    }

    /// `parseForLoop`. Malformed loops become `[Loop error: …]` text.
    fn for_loop(&mut self, start: usize, end: usize, depth: usize) -> Parsed {
        let for_at = self.next(start);
        let name_at = self.next(for_at);
        let raw_name = self.text(name_at, end).to_owned();
        let error = |message: &str| format!("[Loop error: {message}]");
        if !loop_var(&raw_name) {
            return Ok((
                self.literal(error("invalid loop variable"), start)?,
                self.next(start),
            ));
        }
        let mode_at = self.next(name_at);
        let Some(body_start) = self.top_level("{", mode_at, end) else {
            return Ok((
                self.literal(error("missing loop body"), start)?,
                self.next(start),
            ));
        };
        let mut braces = 1usize;
        let mut body_end = self.next(body_start);
        let mut closing = body_end;
        while body_end < end && braces > 0 {
            match self.text(body_end, end) {
                "{" => braces += 1,
                "}" => braces -= 1,
                _ => {}
            }
            closing = body_end;
            body_end = self.next(body_end);
        }
        if braces != 0 {
            return Ok((
                self.literal(error("unclosed loop body"), start)?,
                self.next(start),
            ));
        }
        let (body, mut max_depth) = self.nodes(self.next(body_start)..closing, depth)?;
        let (mut init, mut condition, mut update, mut iterable) = (None, None, None, None);
        let mode = if self.text(mode_at, end).eq_ignore_ascii_case("in") {
            let value = self.single(self.next(mode_at)..body_start, depth)?;
            max_depth = max_depth.max(value.depth);
            iterable = Some(Box::new(value.node));
            LoopMode::Foreach
        } else {
            let first = self.top_level(";", mode_at, body_start);
            let second = first.and_then(|first| self.top_level(";", self.next(first), body_start));
            let (Some(first), Some(second)) = (first, second) else {
                return Ok((
                    self.literal(error("invalid range loop syntax"), start)?,
                    self.next(start),
                ));
            };
            let a = self.single(name_at..first, depth)?;
            let b = self.single(self.next(first)..second, depth)?;
            let c = self.single(self.next(second)..body_start, depth)?;
            max_depth = max_depth.max(a.depth).max(b.depth).max(c.depth);
            init = Some(Box::new(a.node));
            condition = Some(Box::new(b.node));
            update = Some(Box::new(c.node));
            LoopMode::Range
        };
        if self.text(body_end, end) == ")" {
            body_end = self.next(body_end);
        }
        let node = AstNode::ForLoop {
            loop_var: rest(&raw_name, 1).to_owned(),
            mode,
            init,
            condition,
            update,
            iterable,
            body,
        };
        Ok((self.make(node, max_depth, start)?, body_end))
    }

    /// `parseTemplateString` over a quoted token's content.
    fn template(
        &mut self,
        quoted: Range<usize>,
        content: Range<usize>,
        at: usize,
        depth: usize,
    ) -> Result<Built, Diagnostic> {
        self.budget.depth(depth, self.span(at))?;
        let (view, range) = self.tokens.view.decoded(quoted, content);
        let text = view.text.clone();
        let mut segments = Vec::new();
        let mut i = range.start;
        let mut max_depth = 0;
        while i < range.end {
            let Some(relative) = sub(&text, i..range.end).find("${") else {
                segments.push(TemplateSegment::Text {
                    value: sub(&text, i..range.end).into(),
                });
                break;
            };
            let opening = i + relative;
            if opening > i {
                segments.push(TemplateSegment::Text {
                    value: sub(&text, i..opening).into(),
                });
            }
            // Braces balance by bytes; `{` and `}` are ASCII, so the end is a boundary.
            let mut braces = 1usize;
            let mut end = opening + 2;
            while end < range.end && braces > 0 {
                match byte(&text, end) {
                    b'{' => {
                        braces += 1;
                        self.budget
                            .depth(depth + braces, view.span(opening..end + 1))?;
                    }
                    b'}' => braces -= 1,
                    _ => {}
                }
                end += 1;
            }
            if braces != 0 {
                segments.push(TemplateSegment::Text {
                    value: sub(&text, opening..range.end).into(),
                });
                break;
            }
            let inner = opening + 2..end - 1;
            match tokenize(
                view.clone(),
                inner.clone(),
                self.grammar,
                self.budget,
                depth,
            ) {
                Err(error) if error.is_resource_limit() => return Err(error),
                Err(error) => segments.push(TemplateSegment::Text {
                    value: format!("[Parse error: {}]", error.message),
                }),
                Ok(tokens) if tokens.range.is_empty() => segments.push(TemplateSegment::Text {
                    value: String::new(),
                }),
                Ok(tokens) => {
                    let mut parser = Parser {
                        tokens: &tokens,
                        grammar: self.grammar,
                        budget: self.budget,
                    };
                    match parser.star(tokens.range.start, tokens.range.end, 0, depth) {
                        Err(error) if error.is_resource_limit() => return Err(error),
                        // The reference catches the throw and shows the expression's text.
                        Err(_) => segments.push(TemplateSegment::Text {
                            value: format!("[Parse error: {}]", sub(&text, inner)),
                        }),
                        Ok((node, _)) => {
                            max_depth = max_depth.max(node.depth);
                            segments.push(TemplateSegment::Expr { node: node.node });
                        }
                    }
                }
            }
            i = end;
        }
        if segments.is_empty() {
            segments.push(TemplateSegment::Text {
                value: String::new(),
            });
        }
        self.make(AstNode::Template { segments }, max_depth, at)
    }
}

/// `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
fn identifier(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// `isLoopVarToken`: `#` and an identifier.
fn loop_var(text: &str) -> bool {
    text.strip_prefix('#').is_some_and(identifier)
}
