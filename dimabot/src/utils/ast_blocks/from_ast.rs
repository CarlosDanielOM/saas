use super::{
    types::*,
    validate::{Rules, units},
};
use crate::utils::ast_syntax::{ArrayAccessor, AstNode, TemplateSegment, VariableStorage};

/// A syntax shape cannot be represented by an editor block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsupportedSyntax(pub String);
impl std::fmt::Display for UnsupportedSyntax {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UnsupportedSyntax {}

/// Fresh default-prefix (`b`) IDs; counters are private to this factory.
pub fn id_maker() -> impl FnMut() -> String {
    id_maker_with_prefix("b")
}

/// A random four-character base36 salt followed by a base36 sequence.
/// Like the source, the supplied prefix is copied verbatim. The salt is an
/// editor namespace, not a credential, and requires no new randomness crate.
pub fn id_maker_with_prefix(prefix: &str) -> impl FnMut() -> String {
    use std::{
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };
    let salt = super::validate::base36(RandomState::new().build_hasher().finish() % 36u64.pow(4));
    let salt = format!("{salt:0>4}");
    let prefix = format!("{prefix}{salt}");
    let mut sequence = 0u64;
    move || {
        sequence += 1;
        format!("{prefix}{}", super::validate::base36(sequence))
    }
}

/// Convert one already parsed AST directly, preserving fields and source ID
/// traversal order. This does not normalize or apply the editor JSON reader's
/// name, text, accessor, or required-loop-field validation. The parser's hard
/// nesting/node safety ceiling still protects the recursive conversion.
pub fn ast_to_block(
    ast: &AstNode,
    next_id: &mut dyn FnMut() -> String,
) -> Result<BlockNode, UnsupportedSyntax> {
    let mut converter = Materializer::<true> {
        rules: super::validate::rules(),
        next_id: Some(next_id),
        nodes: 0,
    };
    converter.node(ast, 1, Origin::default()).map_err(|error| {
        UnsupportedSyntax(match error.code {
            BlocksErrorCode::InvalidName => "variable name".into(),
            _ => error.message,
        })
    })
}

/// No ID maker is present when building a transient comparison tree.
pub(crate) struct Materializer<'a, const DIRECT: bool> {
    pub rules: &'a Rules,
    pub next_id: Option<&'a mut dyn FnMut() -> String>,
    pub nodes: usize,
}
impl<const DIRECT: bool> Materializer<'_, DIRECT> {
    // A direct AST→block operation has no source JSON or editor diagnostic
    // mapping. Const specialization removes all path/Arc allocations there.
    fn child(p: &Origin, slot: impl ToString) -> Origin {
        if DIRECT {
            Origin::default()
        } else {
            p.child(slot.to_string())
        }
    }

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
        if !DIRECT && units(value) > limit {
            self.fail(
                BlocksErrorCode::StringLimit,
                &format!("{label} is too long."),
                p,
            )
        } else {
            Ok(())
        }
    }
    fn js_string(
        &self,
        value: &crate::utils::ast_syntax::PersistedJsString,
        limit: usize,
        label: &str,
        p: &Origin,
    ) -> Result<(), BlocksError> {
        if !DIRECT && value.0.len() > limit {
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
        if DIRECT {
            return Ok(());
        }
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
            .map(|(i, n)| self.node(n, depth + 1, Self::child(p, i)))
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
                index: Box::new(self.node(index, depth + 1, Self::child(p, "index"))?),
            },
            ArrayAccessor::SetIndex { index } => BlockAccessor::SetIndex {
                index: Box::new(self.node(index, depth + 1, Self::child(p, "index"))?),
            },
            ArrayAccessor::Remove { index } => BlockAccessor::Remove {
                index: Box::new(self.node(index, depth + 1, Self::child(p, "index"))?),
            },
        };
        if !DIRECT && !allowed.contains(&a.name()) {
            return self.fail(
                BlocksErrorCode::InvalidAccessor,
                "This list option is not available here.",
                &Self::child(p, "type"),
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
                self.string(value, MAX_COMMAND_TEXT, "Text", &Self::child(&p, "value"))?;
                BlockKind::Literal {
                    value: value.clone(),
                }
            }
            AstNode::LiteralUtf16 { value } => {
                self.js_string(value, MAX_COMMAND_TEXT, "Text", &Self::child(&p, "value"))?;
                // UTF-8-representable units keep the existing block conversion;
                // only genuinely unpaired units need the additive representation.
                match value.0.to_utf8() {
                    Ok(text) => BlockKind::Literal { value: text },
                    Err(_) => BlockKind::LiteralUtf16 {
                        value: value.clone(),
                    },
                }
            }
            AstNode::Function { name, args } => {
                self.string(name, 80, "The function name", &Self::child(&p, "name"))?;
                if !DIRECT && !self.rules.function_name(name) {
                    return self.fail(
                        BlocksErrorCode::InvalidName,
                        "That function name is not valid.",
                        &Self::child(&p, "name"),
                    );
                }
                BlockKind::Function {
                    name: name.clone(),
                    args: self.list(args, depth, &Self::child(&p, "args"))?,
                }
            }
            AstNode::CommandRef { command_name, args } => {
                self.string(
                    command_name,
                    60,
                    "The command name",
                    &Self::child(&p, "commandName"),
                )?;
                let name = if DIRECT {
                    command_name.as_str()
                } else {
                    command_name.strip_prefix('!').unwrap_or(command_name)
                };
                if !DIRECT && !self.rules.command_name(name) {
                    return self.fail(
                        BlocksErrorCode::InvalidName,
                        "Type the command to run, like so.",
                        &Self::child(&p, "commandName"),
                    );
                }
                BlockKind::CommandRef {
                    command_name: name.to_owned(),
                    args: self.list(args, depth, &Self::child(&p, "args"))?,
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
                let name = self.variable(name, storage, &Self::child(&p, "name"))?;
                let accessor = self.accessor(
                    accessor,
                    if matches!(ast, AstNode::DeleteVar { .. }) {
                        &["clear", "remove"]
                    } else {
                        &["array", "index", "random", "length"]
                    },
                    depth,
                    &Self::child(&p, "accessor"),
                )?;
                let user_selector = if DIRECT || storage.user_scoped() {
                    self.optional(user_selector, depth, &Self::child(&p, "userSelector"))?
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
                let name = self.variable(name, storage, &Self::child(&p, "name"))?;
                let value = Box::new(self.node(value, depth + 1, Self::child(&p, "value"))?);
                let accessor = self.accessor(
                    accessor,
                    &["append", "setIndex"],
                    depth,
                    &Self::child(&p, "accessor"),
                )?;
                let user_selector = if DIRECT || storage.user_scoped() {
                    self.optional(user_selector, depth, &Self::child(&p, "userSelector"))?
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
                        &Self::child(&p, "operator"),
                    )
                })?;
                BlockKind::Binary {
                    operator,
                    left: Box::new(self.node(left, depth + 1, Self::child(&p, "left"))?),
                    right: Box::new(self.node(right, depth + 1, Self::child(&p, "right"))?),
                }
            }
            AstNode::Unary { operator, argument } => {
                let operator = BlockUnaryOp::parse(operator).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidOperator,
                        "Pick + or −.",
                        None,
                        &Self::child(&p, "operator"),
                    )
                })?;
                BlockKind::Unary {
                    operator,
                    argument: Box::new(self.node(
                        argument,
                        depth + 1,
                        Self::child(&p, "argument"),
                    )?),
                }
            }
            AstNode::Ternary {
                test,
                consequent,
                alternate,
            } => BlockKind::Ternary {
                test: Box::new(self.node(test, depth + 1, Self::child(&p, "test"))?),
                consequent: Box::new(self.node(
                    consequent,
                    depth + 1,
                    Self::child(&p, "consequent"),
                )?),
                alternate: Box::new(self.node(
                    alternate,
                    depth + 1,
                    Self::child(&p, "alternate"),
                )?),
            },
            AstNode::Template { segments } => {
                let mut parts = Vec::with_capacity(segments.len());
                for (i, segment) in segments.iter().enumerate() {
                    let sp = Self::child(&Self::child(&p, "parts"), i);
                    parts.push(match segment {
                        TemplateSegment::Expr { node } => self.node(node, depth + 1, sp)?,
                        TemplateSegment::Text { value } => self.node(
                            &AstNode::Literal {
                                value: value.clone(),
                            },
                            depth + 1,
                            sp,
                        )?,
                        TemplateSegment::TextUtf16 { value } => self.node(
                            &AstNode::LiteralUtf16 { value: value.clone() },
                            depth + 1,
                            sp,
                        )?,
                    });
                }
                BlockKind::Template { parts }
            }
            AstNode::ArrayLiteral { items, accessor } => BlockKind::ArrayLiteral {
                items: self.list(items, depth, &Self::child(&p, "items"))?,
                accessor: self.accessor(
                    accessor,
                    &["index", "random", "length"],
                    depth,
                    &Self::child(&p, "accessor"),
                )?,
            },
            AstNode::LoopVar { name } => {
                self.counter(name, &Self::child(&p, "name"))?;
                BlockKind::LoopVar { name: name.clone() }
            }
            AstNode::LoopAssign {
                name,
                operator,
                value,
            } => {
                self.counter(name, &Self::child(&p, "name"))?;
                let operator = BlockLoopAssignOp::parse(operator).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidOperator,
                        "Pick how the counter changes.",
                        None,
                        &Self::child(&p, "operator"),
                    )
                })?;
                let value = self.optional(value, depth, &Self::child(&p, "value"))?;
                if !DIRECT && !operator.increment() && value.is_none() {
                    return self.fail(
                        BlocksErrorCode::MissingField,
                        "Fill in the counter value.",
                        &Self::child(&p, "value"),
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
                self.counter(loop_var, &Self::child(&p, "loopVar"))?;
                let mode = BlockLoopMode::parse(mode).ok_or_else(|| {
                    BlocksError::at(
                        BlocksErrorCode::InvalidMode,
                        "Pick the kind of repeat.",
                        None,
                        &Self::child(&p, "mode"),
                    )
                })?;
                // Source importer allocates body IDs before range header IDs.
                let body = self.list(body, depth, &Self::child(&p, "body"))?;
                let init = self.optional(init, depth, &Self::child(&p, "init"))?;
                let condition = self.optional(condition, depth, &Self::child(&p, "condition"))?;
                let update = self.optional(update, depth, &Self::child(&p, "update"))?;
                let iterable = self.optional(iterable, depth, &Self::child(&p, "iterable"))?;
                if !DIRECT
                    && ((mode == BlockLoopMode::Range
                        && (init.is_none() || condition.is_none() || update.is_none()))
                        || (mode == BlockLoopMode::Foreach && iterable.is_none()))
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
                    if DIRECT {
                        match ast {
                            AstNode::Root { .. } => "root",
                            _ => "custom",
                        }
                    } else {
                        "This expression cannot be shown as blocks."
                    },
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
        BlockKind::Literal { .. } | BlockKind::LiteralUtf16 { .. } => Some("value"),
        BlockKind::Raw { .. } => Some("source"),
        _ => None,
    }
}

fn reverse_storage(storage: BlockStorage) -> VariableStorage {
    match storage {
        BlockStorage::Memory => VariableStorage::Memory,
        BlockStorage::Cache => VariableStorage::Cache,
        BlockStorage::CacheUser => VariableStorage::CacheUser,
        BlockStorage::Db => VariableStorage::Db,
        BlockStorage::DbUser => VariableStorage::DbUser,
    }
}

fn reverse_literal(value: &crate::utils::ast_syntax::PersistedJsString) -> AstNode {
    match value.0.to_utf8() {
        Ok(value) => AstNode::Literal { value },
        Err(_) => AstNode::LiteralUtf16 {
            value: value.clone(),
        },
    }
}

fn reverse_text(value: &crate::utils::ast_syntax::PersistedJsString) -> TemplateSegment {
    match value.0.to_utf8() {
        Ok(value) => TemplateSegment::Text { value },
        Err(_) => TemplateSegment::TextUtf16 {
            value: value.clone(),
        },
    }
}

fn reverse_nodes(nodes: &[BlockNode]) -> Result<Vec<AstNode>, UnsupportedSyntax> {
    nodes.iter().map(block_to_ast).collect()
}

fn reverse_optional(
    node: &Option<Box<BlockNode>>,
) -> Result<Option<Box<AstNode>>, UnsupportedSyntax> {
    node.as_deref()
        .map(block_to_ast)
        .transpose()
        .map(|node| node.map(Box::new))
}

fn reverse_accessor(
    accessor: &Option<BlockAccessor>,
) -> Result<Option<ArrayAccessor>, UnsupportedSyntax> {
    accessor
        .as_ref()
        .map(|accessor| {
            Ok(match accessor {
                BlockAccessor::Array => ArrayAccessor::Array,
                BlockAccessor::Append => ArrayAccessor::Append,
                BlockAccessor::Random => ArrayAccessor::Random,
                BlockAccessor::Length => ArrayAccessor::Length,
                BlockAccessor::Clear => ArrayAccessor::Clear,
                BlockAccessor::Index { index } => ArrayAccessor::Index {
                    index: Box::new(block_to_ast(index)?),
                },
                BlockAccessor::SetIndex { index } => ArrayAccessor::SetIndex {
                    index: Box::new(block_to_ast(index)?),
                },
                BlockAccessor::Remove { index } => ArrayAccessor::Remove {
                    index: Box::new(block_to_ast(index)?),
                },
            })
        })
        .transpose()
}

/// Convert one stored block back to the AST shape it represents. This is the
/// reverse of `ast_to_block` for every block kind that has an AST form. It is a
/// structural conversion, like `root_to_source`: callers validate storage with
/// `read_block_root` first. Advanced source and transient groups have no AST
/// node and return an explicit error rather than being guessed or reparsed.
pub fn block_to_ast(node: &BlockNode) -> Result<AstNode, UnsupportedSyntax> {
    use BlockKind::*;
    Ok(match &node.kind {
        Literal { value } => AstNode::Literal {
            value: value.clone(),
        },
        LiteralUtf16 { value } => reverse_literal(value),
        Raw { .. } => {
            return Err(UnsupportedSyntax(
                "advanced source pieces have no AST form".into(),
            ));
        }
        Function { name, args } => AstNode::Function {
            name: name.clone(),
            args: reverse_nodes(args)?,
        },
        CommandRef { command_name, args } => AstNode::CommandRef {
            command_name: command_name.clone(),
            args: reverse_nodes(args)?,
        },
        GetVar {
            name,
            storage,
            accessor,
            user_selector,
        } => AstNode::GetVar {
            name: name.clone(),
            storage: reverse_storage(*storage),
            accessor: reverse_accessor(accessor)?,
            user_selector: reverse_optional(user_selector)?,
        },
        Exists {
            name,
            storage,
            accessor,
            user_selector,
        } => AstNode::Exists {
            name: name.clone(),
            storage: reverse_storage(*storage),
            accessor: reverse_accessor(accessor)?,
            user_selector: reverse_optional(user_selector)?,
        },
        DeleteVar {
            name,
            storage,
            accessor,
            user_selector,
        } => AstNode::DeleteVar {
            name: name.clone(),
            storage: reverse_storage(*storage),
            accessor: reverse_accessor(accessor)?,
            user_selector: reverse_optional(user_selector)?,
        },
        SetVar {
            name,
            storage,
            value,
            accessor,
            user_selector,
        } => AstNode::SetVar {
            name: name.clone(),
            storage: reverse_storage(*storage),
            value: Box::new(block_to_ast(value)?),
            accessor: reverse_accessor(accessor)?,
            user_selector: reverse_optional(user_selector)?,
        },
        Binary {
            operator,
            left,
            right,
        } => AstNode::Binary {
            operator: operator.as_str().to_owned(),
            left: Box::new(block_to_ast(left)?),
            right: Box::new(block_to_ast(right)?),
        },
        Unary { operator, argument } => AstNode::Unary {
            operator: operator.as_str().to_owned(),
            argument: Box::new(block_to_ast(argument)?),
        },
        Ternary {
            test,
            consequent,
            alternate,
        } => AstNode::Ternary {
            test: Box::new(block_to_ast(test)?),
            consequent: Box::new(block_to_ast(consequent)?),
            alternate: Box::new(block_to_ast(alternate)?),
        },
        Template { parts } => AstNode::Template {
            segments: parts
                .iter()
                .map(|part| {
                    Ok(match &part.kind {
                        Literal { value } => TemplateSegment::Text {
                            value: value.clone(),
                        },
                        LiteralUtf16 { value } => reverse_text(value),
                        _ => TemplateSegment::Expr {
                            node: block_to_ast(part)?,
                        },
                    })
                })
                .collect::<Result<_, UnsupportedSyntax>>()?,
        },
        ArrayLiteral { items, accessor } => AstNode::ArrayLiteral {
            items: reverse_nodes(items)?,
            accessor: reverse_accessor(accessor)?,
        },
        LoopVar { name } => AstNode::LoopVar { name: name.clone() },
        LoopAssign {
            name,
            operator,
            value,
        } => AstNode::LoopAssign {
            name: name.clone(),
            operator: operator.as_str().to_owned(),
            value: reverse_optional(value)?,
        },
        ForLoop {
            loop_var,
            mode,
            init,
            condition,
            update,
            iterable,
            body,
        } => AstNode::ForLoop {
            loop_var: loop_var.clone(),
            mode: mode.as_str().to_owned(),
            init: reverse_optional(init)?,
            condition: reverse_optional(condition)?,
            update: reverse_optional(update)?,
            iterable: reverse_optional(iterable)?,
            body: reverse_nodes(body)?,
        },
        Group { .. } => {
            return Err(UnsupportedSyntax(
                "transient groups have no AST form".into(),
            ));
        }
    })
}

/// Convert a normalized root back to the AST children it represents.
pub fn block_root_to_ast(root: &BlockRoot) -> Result<AstNode, UnsupportedSyntax> {
    Ok(AstNode::Root {
        children: reverse_nodes(&root.children)?,
    })
}
