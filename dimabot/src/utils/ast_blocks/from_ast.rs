use super::{
    types::*,
    validate::{Rules, units},
};
use crate::utils::ast_syntax::{ArrayAccessor, AstNode, TemplateSegment, VariableStorage};

/// No ID maker is present when building a transient comparison tree.
pub(crate) struct Materializer<'a> {
    pub rules: &'a Rules,
    pub next_id: Option<&'a mut dyn FnMut() -> String>,
    pub nodes: usize,
}
impl Materializer<'_> {
    fn fail<T>(&self, code: BlocksErrorCode, message: &str, p: &Origin) -> Result<T, BlocksError> {
        Err(BlocksError::at(code, message, None, p))
    }
    fn string(
        &self,
        value: &str,
        limit: usize,
        label: &str,
        p: &Origin,
    ) -> Result<(), BlocksError> {
        if units(value) > limit {
            self.fail(
                BlocksErrorCode::StringLimit,
                &format!("{label} is too long."),
                p,
            )
        } else {
            Ok(())
        }
    }
    fn counter(&self, name: &str, p: &Origin) -> Result<(), BlocksError> {
        self.string(name, 32, "The counter name", p)?;
        if !self.rules.counter_name(name) {
            return self.fail(
                BlocksErrorCode::InvalidName,
                "Counter names start with a letter.",
                p,
            );
        }
        Ok(())
    }
    fn storage(s: VariableStorage) -> BlockStorage {
        match s {
            VariableStorage::Memory => BlockStorage::Memory,
            VariableStorage::Cache => BlockStorage::Cache,
            VariableStorage::CacheUser => BlockStorage::CacheUser,
            VariableStorage::Db => BlockStorage::Db,
            VariableStorage::DbUser => BlockStorage::DbUser,
        }
    }
    fn variable(
        &self,
        name: &str,
        storage: BlockStorage,
        p: &Origin,
    ) -> Result<String, BlocksError> {
        let name = name.strip_prefix(storage.prefix()).unwrap_or(name);
        self.string(name, 64, "The variable name", p)?;
        if !self.rules.var_name(name) {
            return self.fail(
                BlocksErrorCode::InvalidName,
                "Variable names use only letters, numbers and _.",
                p,
            );
        }
        Ok(name.to_owned())
    }
    fn list(
        &mut self,
        nodes: &[AstNode],
        depth: usize,
        p: &Origin,
    ) -> Result<Vec<BlockNode>, BlocksError> {
        nodes
            .iter()
            .enumerate()
            .map(|(i, n)| self.node(n, depth + 1, p.child(i.to_string())))
            .collect()
    }
    fn optional(
        &mut self,
        node: &Option<Box<AstNode>>,
        depth: usize,
        p: &Origin,
    ) -> Result<Option<Box<BlockNode>>, BlocksError> {
        node.as_ref()
            .map(|n| self.node(n, depth + 1, p.clone()).map(Box::new))
            .transpose()
    }
    fn accessor(
        &mut self,
        accessor: &Option<ArrayAccessor>,
        allowed: &[&str],
        depth: usize,
        p: &Origin,
    ) -> Result<Option<BlockAccessor>, BlocksError> {
        let Some(a) = accessor else {
            return Ok(None);
        };
        let a = match a {
            ArrayAccessor::Array => BlockAccessor::Array,
            ArrayAccessor::Append => BlockAccessor::Append,
            ArrayAccessor::Random => BlockAccessor::Random,
            ArrayAccessor::Length => BlockAccessor::Length,
            ArrayAccessor::Clear => BlockAccessor::Clear,
            ArrayAccessor::Index { index } => BlockAccessor::Index {
                index: Box::new(self.node(index, depth + 1, p.child("index"))?),
            },
            ArrayAccessor::SetIndex { index } => BlockAccessor::SetIndex {
                index: Box::new(self.node(index, depth + 1, p.child("index"))?),
            },
            ArrayAccessor::Remove { index } => BlockAccessor::Remove {
                index: Box::new(self.node(index, depth + 1, p.child("index"))?),
            },
        };
        if !allowed.contains(&a.name()) {
            return self.fail(
                BlocksErrorCode::InvalidAccessor,
                "This list option is not available here.",
                &p.child("type"),
            );
        }
        Ok(Some(a))
    }
    pub(crate) fn node(
        &mut self,
        ast: &AstNode,
        depth: usize,
        p: Origin,
    ) -> Result<BlockNode, BlocksError> {
        // Syntax templates have transient text/expr wrappers. Bound their
        // conversion independently, then enforce block quotas after canonical
        // normalization removes those wrappers (the JSON Reader stays strict).
        if depth > crate::utils::ast_syntax::HARD_NESTING_CEILING {
            return self.fail(
                BlocksErrorCode::DepthLimit,
                "Blocks are nested too deeply.",
                &p,
            );
        }
        self.nodes += 1;
        if self.nodes > super::SYNTAX_NODES {
            return self.fail(
                BlocksErrorCode::NodeLimit,
                &format!("Too many blocks (limit {MAX_BLOCK_NODES})."),
                &p,
            );
        }
        let id = self.next_id.as_mut().map(|f| f()).unwrap_or_default();
        let kind = match ast {
            AstNode::Literal { value } => {
                self.string(value, MAX_COMMAND_TEXT, "Text", &p.child("value"))?;
                BlockKind::Literal {
                    value: value.clone(),
                }
            }
            AstNode::Function { name, args } => {
                self.string(name, 80, "The function name", &p.child("name"))?;
                if !self.rules.function_name(name) {
                    return self.fail(
                        BlocksErrorCode::InvalidName,
                        "That function name is not valid.",
                        &p.child("name"),
                    );
                }
                BlockKind::Function {
                    name: name.clone(),
                    args: self.list(args, depth, &p.child("args"))?,
                }
            }
            AstNode::CommandRef { command_name, args } => {
                self.string(
                    command_name,
                    60,
                    "The command name",
                    &p.child("commandName"),
                )?;
                let name = command_name.strip_prefix('!').unwrap_or(command_name);
                if !self.rules.command_name(name) {
                    return self.fail(
                        BlocksErrorCode::InvalidName,
                        "Type the command to run, like so.",
                        &p.child("commandName"),
                    );
                }
                BlockKind::CommandRef {
                    command_name: name.to_owned(),
                    args: self.list(args, depth, &p.child("args"))?,
                }
            }
            AstNode::GetVar {
                name,
                storage,
                accessor,
                user_selector,
            }
            | AstNode::Exists {
                name,
                storage,
                accessor,
                user_selector,
            }
            | AstNode::DeleteVar {
                name,
                storage,
                accessor,
                user_selector,
            } => {
                let storage = Self::storage(*storage);
                let name = self.variable(name, storage, &p.child("name"))?;
                let accessor = self.accessor(
                    accessor,
                    if matches!(ast, AstNode::DeleteVar { .. }) {
                        &["clear", "remove"]
                    } else {
                        &["array", "index", "random", "length"]
                    },
                    depth,
                    &p.child("accessor"),
                )?;
                let user_selector = if storage.user_scoped() {
                    self.optional(user_selector, depth, &p.child("userSelector"))?
                } else {
                    None
                };
                match ast {
                    AstNode::Exists { .. } => BlockKind::Exists {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    AstNode::DeleteVar { .. } => BlockKind::DeleteVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                    _ => BlockKind::GetVar {
                        name,
                        storage,
                        accessor,
                        user_selector,
                    },
                }
            }
            AstNode::SetVar {
                name,
                storage,
                value,
                accessor,
                user_selector,
            } => {
                let storage = Self::storage(*storage);
                let name = self.variable(name, storage, &p.child("name"))?;
                let value = Box::new(self.node(value, depth + 1, p.child("value"))?);
                let accessor = self.accessor(
                    accessor,
                    &["append", "setIndex"],
                    depth,
                    &p.child("accessor"),
                )?;
                let user_selector = if storage.user_scoped() {
                    self.optional(user_selector, depth, &p.child("userSelector"))?
                } else {
                    None
                };
                BlockKind::SetVar {
                    name,
                    storage,
                    value,
                    accessor,
                    user_selector,
                }
            }
            AstNode::Binary {
                operator,
                left,
                right,
            } => {
                let operator = BlockBinaryOp::parse(operator).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidOperator,
                        "Pick a check or math sign.",
                        None,
                        &p.child("operator"),
                    )
                })?;
                BlockKind::Binary {
                    operator,
                    left: Box::new(self.node(left, depth + 1, p.child("left"))?),
                    right: Box::new(self.node(right, depth + 1, p.child("right"))?),
                }
            }
            AstNode::Unary { operator, argument } => {
                let operator = BlockUnaryOp::parse(operator).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidOperator,
                        "Pick + or −.",
                        None,
                        &p.child("operator"),
                    )
                })?;
                BlockKind::Unary {
                    operator,
                    argument: Box::new(self.node(argument, depth + 1, p.child("argument"))?),
                }
            }
            AstNode::Ternary {
                test,
                consequent,
                alternate,
            } => BlockKind::Ternary {
                test: Box::new(self.node(test, depth + 1, p.child("test"))?),
                consequent: Box::new(self.node(consequent, depth + 1, p.child("consequent"))?),
                alternate: Box::new(self.node(alternate, depth + 1, p.child("alternate"))?),
            },
            AstNode::Template { segments } => {
                let mut parts = Vec::with_capacity(segments.len());
                for (i, segment) in segments.iter().enumerate() {
                    let sp = p.child("parts").child(i.to_string());
                    parts.push(match segment {
                        TemplateSegment::Expr { node } => self.node(node, depth + 1, sp)?,
                        TemplateSegment::Text { value } => self.node(
                            &AstNode::Literal {
                                value: value.clone(),
                            },
                            depth + 1,
                            sp,
                        )?,
                    });
                }
                BlockKind::Template { parts }
            }
            AstNode::ArrayLiteral { items, accessor } => BlockKind::ArrayLiteral {
                items: self.list(items, depth, &p.child("items"))?,
                accessor: self.accessor(
                    accessor,
                    &["index", "random", "length"],
                    depth,
                    &p.child("accessor"),
                )?,
            },
            AstNode::LoopVar { name } => {
                self.counter(name, &p.child("name"))?;
                BlockKind::LoopVar { name: name.clone() }
            }
            AstNode::LoopAssign {
                name,
                operator,
                value,
            } => {
                self.counter(name, &p.child("name"))?;
                let operator = BlockLoopAssignOp::parse(operator).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidOperator,
                        "Pick how the counter changes.",
                        None,
                        &p.child("operator"),
                    )
                })?;
                let value = self.optional(value, depth, &p.child("value"))?;
                if !operator.increment() && value.is_none() {
                    return self.fail(
                        BlocksErrorCode::MissingField,
                        "Fill in the counter value.",
                        &p.child("value"),
                    );
                }
                BlockKind::LoopAssign {
                    name: name.clone(),
                    operator,
                    value,
                }
            }
            AstNode::ForLoop {
                loop_var,
                mode,
                init,
                condition,
                update,
                iterable,
                body,
            } => {
                self.counter(loop_var, &p.child("loopVar"))?;
                let mode = BlockLoopMode::parse(mode).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidMode,
                        "Pick the kind of repeat.",
                        None,
                        &p.child("mode"),
                    )
                })?;
                // Source importer allocates body IDs before range header IDs.
                let body = self.list(body, depth, &p.child("body"))?;
                let init = self.optional(init, depth, &p.child("init"))?;
                let condition = self.optional(condition, depth, &p.child("condition"))?;
                let update = self.optional(update, depth, &p.child("update"))?;
                let iterable = self.optional(iterable, depth, &p.child("iterable"))?;
                if (mode == BlockLoopMode::Range
                    && (init.is_none() || condition.is_none() || update.is_none()))
                    || (mode == BlockLoopMode::Foreach && iterable.is_none())
                {
                    return self.fail(BlocksErrorCode::MissingField, "Fill in the repeat.", &p);
                }
                BlockKind::ForLoop {
                    loop_var: loop_var.clone(),
                    mode,
                    init,
                    condition,
                    update,
                    iterable,
                    body,
                }
            }
            _ => {
                return self.fail(
                    BlocksErrorCode::BrokenBlock,
                    "This expression cannot be shown as blocks.",
                    &p,
                );
            }
        };
        Ok(BlockNode {
            id,
            kind,
            origin: p,
            diagnostic_id: None,
            text_pieces: Vec::new(),
        })
    }
}

/// Visits children in field order, without allocating a second tree or JSON.
pub(crate) fn children<'a>(n: &'a BlockNode, f: &mut dyn FnMut(&'a BlockNode)) {
    use BlockKind::*;
    match &n.kind {
        Function { args, .. } | CommandRef { args, .. } => args.iter().for_each(&mut *f),
        GetVar {
            accessor,
            user_selector,
            ..
        }
        | Exists {
            accessor,
            user_selector,
            ..
        }
        | DeleteVar {
            accessor,
            user_selector,
            ..
        } => {
            if let Some(a) = accessor
                && let Some(index) = a.index()
            {
                f(index);
            }
            if let Some(s) = user_selector {
                f(s);
            }
        }
        SetVar {
            value,
            accessor,
            user_selector,
            ..
        } => {
            f(value);
            if let Some(a) = accessor
                && let Some(index) = a.index()
            {
                f(index);
            }
            if let Some(s) = user_selector {
                f(s);
            }
        }
        Binary { left, right, .. } => {
            f(left);
            f(right);
        }
        Unary { argument, .. } => f(argument),
        Ternary {
            test,
            consequent,
            alternate,
        } => {
            f(test);
            f(consequent);
            f(alternate);
        }
        Template { parts } => parts.iter().for_each(&mut *f),
        Group { children } => children.iter().for_each(&mut *f),
        ArrayLiteral { items, accessor } => {
            items.iter().for_each(&mut *f);
            if let Some(a) = accessor
                && let Some(index) = a.index()
            {
                f(index);
            }
        }
        LoopAssign { value: Some(v), .. } => f(v),
        ForLoop {
            init,
            condition,
            update,
            iterable,
            body,
            ..
        } => {
            for v in [init, condition, update, iterable].into_iter().flatten() {
                f(v);
            }
            body.iter().for_each(&mut *f);
        }
        _ => {}
    }
}
pub(crate) fn count_nodes(n: &BlockNode) -> usize {
    let mut count = 1;
    children(n, &mut |child| count += count_nodes(child));
    count
}
pub(crate) fn eligible(node: &BlockNode) -> bool {
    fn visit(node: &BlockNode, depth: usize, count: &mut usize) -> bool {
        *count += 1;
        if depth > MAX_BLOCK_DEPTH || *count > MAX_BLOCK_NODES {
            return false;
        }
        let mut valid = true;
        children(node, &mut |child| {
            if valid {
                valid = visit(child, depth + 1, count);
            }
        });
        valid
    }
    visit(node, 1, &mut 0)
}
/// Descend to the first differing child so an interpolated argument points at
/// that argument's value rather than the surrounding function.
pub(crate) fn mismatch<'a>(original: &'a BlockNode, other: &BlockNode) -> &'a BlockNode {
    if original.kind == other.kind {
        return original;
    }
    let mut a = Vec::new();
    let mut b = Vec::new();
    children(original, &mut |n| a.push(n));
    children(other, &mut |n| b.push(n));
    if std::mem::discriminant(&original.kind) == std::mem::discriminant(&other.kind)
        && a.len() == b.len()
    {
        for (x, y) in a.into_iter().zip(b) {
            if x.kind != y.kind {
                return mismatch(x, y);
            }
        }
    }
    original
}
pub(crate) fn value_field(n: &BlockNode) -> Option<&'static str> {
    match &n.kind {
        BlockKind::Literal { .. } => Some("value"),
        BlockKind::Raw { .. } => Some("source"),
        _ => None,
    }
}
