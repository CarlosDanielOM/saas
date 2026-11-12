//! Parser node to block (`astToBlock` in `from_ast.ts`).

use super::{BlockAccessor, BlockKind, BlockNode, names};
use crate::syntax::{ArrayAccessor, AstNode, TemplateSegment, VariableStorage};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

/// Makes block ids: `{prefix}{salt}{n in base 36}` (`idMaker`).
#[derive(Clone, Debug)]
pub struct IdMaker {
    prefix: String,
    seq: u64,
}

impl IdMaker {
    /// Ids `{prefix}{salt}1`, `{prefix}{salt}2`, …
    pub fn new(prefix: &str, salt: &str) -> Self {
        Self {
            prefix: format!("{prefix}{salt}"),
            seq: 0,
        }
    }

    /// The reference's salt is four random base-36 characters; this takes them from the
    /// standard library's per-process random hasher keys (no random-number dependency).
    pub fn random(prefix: &str) -> Self {
        let value = RandomState::new().build_hasher().finish() % 36u64.pow(4);
        let salt = names::base36(value);
        Self::new(prefix, &format!("{salt:0>4}"))
    }

    /// The next id.
    pub fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("{}{}", self.prefix, names::base36(self.seq))
    }
}

/// A shape blocks cannot show (`UnsupportedSyntax`).
#[derive(Debug)]
pub(crate) struct Unsupported;

/// `astToBlock`. Ids are taken in the reference's order: the block's own first, then its
/// children as its object literal lists them.
pub(crate) fn ast_to_block(node: &AstNode, ids: &mut IdMaker) -> Result<BlockNode, Unsupported> {
    let id = ids.next_id();
    let kind = match node {
        AstNode::Literal { value } => BlockKind::Literal {
            value: value.clone(),
        },
        AstNode::Function { name, args } => BlockKind::Function {
            name: name.clone(),
            args: list(args, ids)?,
        },
        AstNode::CommandRef { command_name, args } => BlockKind::CommandRef {
            command_name: command_name.clone(),
            args: list(args, ids)?,
        },
        AstNode::GetVar {
            name,
            storage,
            accessor,
            user_selector,
        } => {
            let name = var_name(name, *storage)?;
            let accessor = accessor.as_ref().map(|a| convert_accessor(a, ids)).transpose()?;
            BlockKind::GetVar {
                name,
                storage: *storage,
                accessor,
                user_selector: optional(user_selector.as_deref(), ids)?,
            }
        }
        AstNode::Exists {
            name,
            storage,
            accessor,
            user_selector,
        } => {
            let name = var_name(name, *storage)?;
            let accessor = accessor.as_ref().map(|a| convert_accessor(a, ids)).transpose()?;
            BlockKind::Exists {
                name,
                storage: *storage,
                accessor,
                user_selector: optional(user_selector.as_deref(), ids)?,
            }
        }
        AstNode::DeleteVar {
            name,
            storage,
            accessor,
            user_selector,
        } => {
            let name = var_name(name, *storage)?;
            let accessor = accessor.as_ref().map(|a| convert_accessor(a, ids)).transpose()?;
            BlockKind::DeleteVar {
                name,
                storage: *storage,
                accessor,
                user_selector: optional(user_selector.as_deref(), ids)?,
            }
        }
        AstNode::SetVar {
            name,
            storage,
            value,
            accessor,
            user_selector,
        } => {
            let name = var_name(name, *storage)?;
            let value = Box::new(ast_to_block(value, ids)?);
            let accessor = accessor.as_ref().map(|a| convert_accessor(a, ids)).transpose()?;
            BlockKind::SetVar {
                name,
                storage: *storage,
                value,
                accessor,
                user_selector: optional(user_selector.as_deref(), ids)?,
            }
        }
        AstNode::Binary {
            operator,
            left,
            right,
        } => {
            let left = Box::new(ast_to_block(left, ids)?);
            BlockKind::Binary {
                operator: *operator,
                left,
                right: Box::new(ast_to_block(right, ids)?),
            }
        }
        AstNode::Unary { operator, argument } => BlockKind::Unary {
            operator: *operator,
            argument: Box::new(ast_to_block(argument, ids)?),
        },
        AstNode::Ternary {
            test,
            consequent,
            alternate,
        } => {
            let test = Box::new(ast_to_block(test, ids)?);
            let consequent = Box::new(ast_to_block(consequent, ids)?);
            BlockKind::Ternary {
                test,
                consequent,
                alternate: Box::new(ast_to_block(alternate, ids)?),
            }
        }
        AstNode::Template { segments } => BlockKind::Template {
            parts: segments
                .iter()
                .map(|segment| match segment {
                    TemplateSegment::Text { value } => {
                        Ok(BlockNode::literal(ids.next_id(), value.clone()))
                    }
                    TemplateSegment::Expr { node } => ast_to_block(node, ids),
                })
                .collect::<Result<_, _>>()?,
        },
        AstNode::ArrayLiteral { items, accessor } => {
            let items = list(items, ids)?;
            BlockKind::ArrayLiteral {
                items,
                accessor: accessor.as_ref().map(|a| convert_accessor(a, ids)).transpose()?,
            }
        }
        AstNode::LoopVar { name } => BlockKind::LoopVar { name: name.clone() },
        AstNode::LoopAssign {
            name,
            operator,
            value,
        } => BlockKind::LoopAssign {
            name: name.clone(),
            operator: *operator,
            value: optional(value.as_deref(), ids)?,
        },
        AstNode::ForLoop {
            loop_var,
            mode,
            init,
            condition,
            update,
            iterable,
            body,
        } => {
            // The reference builds the body first, then init, condition, update, iterable.
            let body = list(body, ids)?;
            let init = optional(init.as_deref(), ids)?;
            let condition = optional(condition.as_deref(), ids)?;
            let update = optional(update.as_deref(), ids)?;
            BlockKind::ForLoop {
                loop_var: loop_var.clone(),
                mode: *mode,
                init,
                condition,
                update,
                iterable: optional(iterable.as_deref(), ids)?,
                body,
            }
        }
        AstNode::Root { .. } | AstNode::Custom { .. } => return Err(Unsupported),
    };
    Ok(BlockNode::new(id, kind))
}

fn list(nodes: &[AstNode], ids: &mut IdMaker) -> Result<Vec<BlockNode>, Unsupported> {
    nodes.iter().map(|node| ast_to_block(node, ids)).collect()
}

fn optional(
    node: Option<&AstNode>,
    ids: &mut IdMaker,
) -> Result<Option<Box<BlockNode>>, Unsupported> {
    node.map(|node| ast_to_block(node, ids).map(Box::new))
        .transpose()
}

/// The parser keeps the storage prefix in the name (`*deaths`); blocks store it separately.
fn var_name(name: &str, storage: VariableStorage) -> Result<String, Unsupported> {
    let bare = name.strip_prefix(storage.prefix()).unwrap_or(name);
    if !names::var_name(bare) {
        return Err(Unsupported);
    }
    Ok(bare.to_owned())
}

fn convert_accessor(value: &ArrayAccessor, ids: &mut IdMaker) -> Result<BlockAccessor, Unsupported> {
    Ok(match value {
        ArrayAccessor::Index { index } => BlockAccessor::Index {
            index: Box::new(ast_to_block(index, ids)?),
        },
        ArrayAccessor::SetIndex { index } => BlockAccessor::SetIndex {
            index: Box::new(ast_to_block(index, ids)?),
        },
        ArrayAccessor::Remove { index } => BlockAccessor::Remove {
            index: Box::new(ast_to_block(index, ids)?),
        },
        ArrayAccessor::Array => BlockAccessor::Array,
        ArrayAccessor::Random => BlockAccessor::Random,
        ArrayAccessor::Length => BlockAccessor::Length,
        ArrayAccessor::Append => BlockAccessor::Append,
        ArrayAccessor::Clear => BlockAccessor::Clear,
    })
}
