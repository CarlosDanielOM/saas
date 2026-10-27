use super::lexer::{TokenKind, Tokens, next_char, tokenize, unescape_literal};
use super::source::Budget;
use super::{
    ArrayAccessor, AstNode, Diagnostic, DiagnosticCode, PreparedGrammar, SourceSpan, SyntaxHandler,
    SyntaxProfile, TemplateSegment, VariableStorage,
};
use std::ops::Range;

type Parsed = Result<(Built, usize), Diagnostic>;
pub(crate) struct Built {
    pub node: AstNode,
    pub depth: usize,
}
pub(crate) struct Parser<'a, 'b> {
    pub tokens: &'a Tokens,
    pub grammar: &'a PreparedGrammar,
    pub profile: SyntaxProfile,
    pub budget: &'b mut Budget,
}
impl Parser<'_, '_> {
    fn text(&self, i: usize, end: usize) -> &str {
        if i >= end {
            return "";
        }
        self.tokens
            .tokens
            .get(i)
            .map_or("", |t| &self.tokens.view.text[t.bytes.clone()])
    }
    fn name_token(&self, i: usize, end: usize) -> String {
        if i >= end {
            return String::new();
        }
        let token = &self.tokens.tokens[i];
        match &token.kind {
            TokenKind::Quoted(content) => {
                format!("__TEMPLATE__:{}", &self.tokens.view.text[content.clone()])
            }
            TokenKind::Array(_) => format!(
                "__ARRAY__:{}",
                &self.tokens.view.text[token.bytes.start + 2..token.bytes.end - 1]
            ),
            _ => self.text(i, end).to_owned(),
        }
    }
    fn next(&self, i: usize) -> usize {
        self.tokens
            .tokens
            .get(i)
            .map_or(i.saturating_add(1), |t| t.next)
    }
    fn span(&self, i: usize) -> SourceSpan {
        self.tokens.tokens.get(i).map_or_else(
            || {
                self.tokens
                    .view
                    .span(self.tokens.view.text.len()..self.tokens.view.text.len())
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
    pub fn root(&mut self, range: Range<usize>, depth: usize) -> Result<Built, Diagnostic> {
        let (children, child_depth) = self.nodes(range.clone(), depth)?;
        self.make(AstNode::Root { children }, child_depth, range.start)
    }
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
            if !built.node.is_empty() {
                max_depth = max_depth.max(built.depth);
                nodes.push(built.node);
            }
            i = if next > i { next } else { self.next(i) };
        }
        Ok((nodes, max_depth))
    }
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
        let mut children = vec![first.node];
        children.extend(rest);
        self.make(AstNode::Root { children }, max, range.start)
    }
    fn expression(&mut self, i: usize, end: usize, depth: usize) -> Parsed {
        self.budget.depth(depth, self.span(i))?;
        let token = self.text(i, end);
        if i >= end {
            return Ok((self.literal("", i)?, self.next(i)));
        }
        if matches!(token, ";" | "}" | ")") {
            let next = if token == ")" { i } else { self.next(i) };
            return Ok((self.literal("", i)?, next));
        }
        if loop_var(token) {
            return self.loop_variable(i, end, depth);
        }
        match &self.tokens.tokens[i].kind {
            TokenKind::Start(def) => self.definition(i, end, *def, depth + 1),
            TokenKind::Quoted(content) => {
                let content = content.clone();
                let node = self.template(content, i, depth + 1)?;
                Ok((node, self.next(i)))
            }
            TokenKind::Array(items) => {
                let items = items.clone();
                self.array(items, i, end, depth + 1)
            }
            TokenKind::Raw => Ok((self.literal(unescape_literal(token), i)?, self.next(i))),
        }
    }
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
        if token == "+" || token == "-" {
            let operator = token.to_owned();
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
            let Some(precedence) = precedence(token) else {
                break;
            };
            if precedence < minimum {
                break;
            }
            let operator = token.to_owned();
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
        match self.grammar.definitions[def].handler {
            SyntaxHandler::Function => self.call(i, end, depth, false),
            SyntaxHandler::CommandRef => self.call(i, end, depth, true),
            SyntaxHandler::Variable => self.variable(i, end, depth, SyntaxHandler::Variable),
            SyntaxHandler::Exists => self.variable(i, end, depth, SyntaxHandler::Exists),
            SyntaxHandler::Delete => self.variable(i, end, depth, SyntaxHandler::Delete),
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
            if !arg.node.is_empty() {
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
    fn loop_variable(&mut self, i: usize, end: usize, depth: usize) -> Parsed {
        let name = self.text(i, end)[1..].to_owned();
        let op_at = self.next(i);
        let op = self.text(op_at, end).to_owned();
        if matches!(
            op.as_str(),
            "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "++" | "--"
        ) {
            if op == "++" || op == "--" {
                return Ok((
                    self.make(
                        AstNode::LoopAssign {
                            name,
                            operator: op,
                            value: None,
                        },
                        0,
                        i,
                    )?,
                    self.next(op_at),
                ));
            }
            let (value, next) = self.star(self.next(op_at), end, 0, depth + 1)?;
            let child = value.depth;
            return Ok((
                self.make(
                    AstNode::LoopAssign {
                        name,
                        operator: op,
                        value: Some(Box::new(value.node)),
                    },
                    child,
                    i,
                )?,
                next,
            ));
        }
        Ok((self.make(AstNode::LoopVar { name }, 0, i)?, self.next(i)))
    }
    fn array(
        &mut self,
        ranges: Vec<Range<usize>>,
        start: usize,
        end: usize,
        depth: usize,
    ) -> Parsed {
        self.budget.depth(depth, self.span(start))?;
        let mut items = Vec::new();
        let mut max_depth = 0;
        for range in ranges {
            let item = if range.is_empty() {
                self.literal("", start)?
            } else {
                let (item, next) = self.star(range.start, range.end, 0, depth)?;
                if self.profile == SyntaxProfile::Improved && next < range.end {
                    return Err(self.unconsumed(next, range.end));
                }
                item
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
    fn unconsumed(&self, i: usize, end: usize) -> Diagnostic {
        Diagnostic::new(
            DiagnosticCode::UnexpectedToken,
            format!(
                "Unexpected token {} in nested expression",
                serde_json::Value::String(self.name_token(i, end))
            ),
            self.span(i),
        )
    }
    fn variable(
        &mut self,
        start: usize,
        end: usize,
        depth: usize,
        handler: SyntaxHandler,
    ) -> Parsed {
        let name_at = self.next(start);
        let name = self.name_token(name_at, end);
        if name_at >= end {
            return Err(Diagnostic::new(
                DiagnosticCode::MissingVariableName,
                "Missing variable name",
                self.span(start),
            ));
        }
        let storage = if name.starts_with("**") {
            VariableStorage::DbUser
        } else if name.starts_with('*') {
            VariableStorage::Db
        } else if name.starts_with("##") {
            VariableStorage::CacheUser
        } else if name.starts_with('#') {
            VariableStorage::Cache
        } else {
            VariableStorage::Memory
        };
        let mut i = self.next(name_at);
        let mut user_selector = None;
        let mut max_depth = 0;
        if matches!(
            storage,
            VariableStorage::CacheUser | VariableStorage::DbUser
        ) && self.text(i, end) == "("
        {
            let (selector, next) = self.expression(self.next(i), end, depth)?;
            max_depth = max_depth.max(selector.depth);
            user_selector = Some(Box::new(selector.node));
            i = next;
            if self.text(i, end) == ")" {
                i = self.next(i);
            }
        }
        let delete = handler == SyntaxHandler::Delete;
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
        let assignment = handler == SyntaxHandler::Variable
            && !next.is_empty()
            && next != ")"
            && match &accessor {
                None => true,
                Some(ArrayAccessor::Array) => next != ".",
                Some(ArrayAccessor::Index { .. }) => true,
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
            match handler {
                SyntaxHandler::Exists => AstNode::Exists {
                    name,
                    storage,
                    accessor,
                    user_selector,
                },
                SyntaxHandler::Delete => AstNode::DeleteVar {
                    name,
                    storage,
                    accessor,
                    user_selector,
                },
                _ => AstNode::GetVar {
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
    fn top_level(&self, target: &str, start: usize, end: usize) -> Option<usize> {
        let (mut parens, mut brackets, mut braces) = (0usize, 0usize, 0usize);
        let mut i = start;
        while i < end {
            let token = self.text(i, end);
            if parens == 0 && brackets == 0 && braces == 0 && token == target {
                return Some(i);
            }
            let opens = match &self.tokens.tokens[i].kind {
                TokenKind::Start(_) => true,
                TokenKind::Quoted(content) => self.tokens.view.text[content.clone()].ends_with('('),
                TokenKind::Array(_) => {
                    let bytes = &self.tokens.tokens[i].bytes;
                    self.tokens.view.text[bytes.start + 2..bytes.end - 1].ends_with('(')
                }
                TokenKind::Raw => token.ends_with('('),
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
            if self.text(body_end, end) == "{" {
                braces += 1;
            } else if self.text(body_end, end) == "}" {
                braces -= 1;
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
            "foreach"
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
            "range"
        };
        if self.text(body_end, end) == ")" {
            body_end = self.next(body_end);
        }
        let node = AstNode::ForLoop {
            loop_var: raw_name[1..].into(),
            mode: mode.into(),
            init,
            condition,
            update,
            iterable,
            body,
        };
        Ok((self.make(node, max_depth, start)?, body_end))
    }
    fn template(
        &mut self,
        content: Range<usize>,
        at: usize,
        depth: usize,
    ) -> Result<Built, Diagnostic> {
        self.budget.depth(depth, self.span(at))?;
        let view = self.tokens.view.decoded(content);
        let text = view.text.clone();
        let mut segments = Vec::new();
        let mut i = 0;
        let mut max_depth = 0;
        while i < text.len() {
            let Some(relative) = text[i..].find("${") else {
                segments.push(TemplateSegment::Text {
                    value: text[i..].into(),
                });
                break;
            };
            let opening = i + relative;
            if opening > i {
                segments.push(TemplateSegment::Text {
                    value: text[i..opening].into(),
                });
            }
            let mut braces = 1usize;
            let mut end = opening + 2;
            while end < text.len() && braces > 0 {
                match text.as_bytes()[end] {
                    b'{' => braces += 1,
                    b'}' => braces -= 1,
                    _ => {}
                }
                self.budget
                    .depth(depth + braces, view.span(opening..next_char(&text, end)))?;
                end = next_char(&text, end);
            }
            if braces != 0 {
                segments.push(TemplateSegment::Text {
                    value: text[opening..].into(),
                });
                break;
            }
            let result = tokenize(
                view.clone(),
                opening + 2..end - 1,
                self.grammar,
                self.profile,
                self.budget,
                depth,
            );
            match result {
                Err(error)
                    if self.profile == SyntaxProfile::TypeScriptCompatible
                        && !error.is_resource_limit() =>
                {
                    segments.push(TemplateSegment::Text {
                        value: format!("[Parse error: {}]", error.message),
                    })
                }
                Err(error) => return Err(error),
                Ok(tokens) if tokens.range.is_empty() => segments.push(TemplateSegment::Text {
                    value: String::new(),
                }),
                Ok(tokens) => {
                    let mut inner = Parser {
                        tokens: &tokens,
                        grammar: self.grammar,
                        profile: self.profile,
                        budget: self.budget,
                    };
                    match inner.star(tokens.range.start, tokens.range.end, 0, depth) {
                        Err(error)
                            if self.profile == SyntaxProfile::TypeScriptCompatible
                                && !error.is_resource_limit() =>
                        {
                            segments.push(TemplateSegment::Text {
                                value: format!("[Parse error: {}]", &text[opening + 2..end - 1]),
                            });
                        }
                        Err(error) => return Err(error),
                        Ok((node, next)) => {
                            if self.profile == SyntaxProfile::Improved && next < tokens.range.end {
                                return Err(inner.unconsumed(next, tokens.range.end));
                            }
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
fn identifier(text: &str) -> bool {
    let mut chars = text.bytes();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn loop_var(text: &str) -> bool {
    text.strip_prefix('#').is_some_and(identifier)
}
fn precedence(token: &str) -> Option<u8> {
    match token {
        "==" | "!=" | ">=" | "<=" | "~=" | "<>" | ">" | "<" | "=" => Some(2),
        "+" | "-" => Some(3),
        "*" | "/" | "%" => Some(4),
        _ => None,
    }
}
