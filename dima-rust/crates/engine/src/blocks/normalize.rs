//! Canonical form (`normalize.ts`), so a tree from the editor and the tree read back from its
//! compiled text compare equal:
//! - top level: groups and quoted text are spread out (chat text is already free text),
//!   neighbouring text joins, empty text goes;
//! - inside a value: a group becomes quoted text, quoted text with only words becomes plain
//!   text (the bot treats `hi` and `"hi"` the same).

use super::{BlockAccessor, BlockKind, BlockNode, BlockRoot};

/// `normalizeRoot`.
pub fn normalize_root(root: BlockRoot) -> BlockRoot {
    let mut children = Vec::with_capacity(root.children.len());
    for node in root.children {
        spread_root(node, &mut children);
    }
    BlockRoot {
        children: merge_text(children),
        ..root
    }
}

fn spread_root(node: BlockNode, out: &mut Vec<BlockNode>) {
    match node.kind {
        BlockKind::Group { children } => children.into_iter().for_each(|c| spread_root(c, out)),
        BlockKind::Template { parts } => parts.into_iter().for_each(|c| spread_root(c, out)),
        BlockKind::Literal { .. } | BlockKind::Raw { .. } => out.push(node),
        _ => out.push(normalize_value(node)),
    }
}

fn spread_template(node: BlockNode, out: &mut Vec<BlockNode>) {
    match node.kind {
        BlockKind::Group { children } => {
            children.into_iter().for_each(|c| spread_template(c, out));
        }
        BlockKind::Template { parts } => parts.into_iter().for_each(|c| spread_template(c, out)),
        _ => out.push(normalize_value(node)),
    }
}

fn boxed(node: BlockNode) -> Box<BlockNode> {
    Box::new(normalize_value(node))
}

fn optional(node: Option<Box<BlockNode>>) -> Option<Box<BlockNode>> {
    node.map(|node| boxed(*node))
}

/// `normalizeValue`.
pub fn normalize_value(node: BlockNode) -> BlockNode {
    let BlockNode { id, kind } = node;
    let kind = match kind {
        BlockKind::Group { children } => {
            return normalize_value(BlockNode::new(id, BlockKind::Template { parts: children }));
        }
        BlockKind::Template { parts } => {
            let mut spread = Vec::with_capacity(parts.len());
            for part in parts {
                spread_template(part, &mut spread);
            }
            let merged = merge_text(spread);
            if merged.is_empty() {
                return BlockNode::literal(id, "");
            }
            if merged
                .iter()
                .all(|part| matches!(part.kind, BlockKind::Literal { .. }))
            {
                let value: String = merged
                    .iter()
                    .filter_map(|part| match &part.kind {
                        BlockKind::Literal { value } => Some(value.as_str()),
                        _ => None,
                    })
                    .collect();
                return BlockNode::literal(id, value);
            }
            BlockKind::Template { parts: merged }
        }
        BlockKind::Function { name, args } => BlockKind::Function {
            name,
            args: args.into_iter().map(normalize_value).collect(),
        },
        BlockKind::CommandRef { command_name, args } => BlockKind::CommandRef {
            command_name,
            args: args.into_iter().map(normalize_value).collect(),
        },
        BlockKind::GetVar {
            name,
            storage,
            accessor,
            user_selector,
        } => BlockKind::GetVar {
            name,
            storage,
            accessor: accessor.map(normalize_accessor),
            user_selector: optional(user_selector),
        },
        BlockKind::Exists {
            name,
            storage,
            accessor,
            user_selector,
        } => BlockKind::Exists {
            name,
            storage,
            accessor: accessor.map(normalize_accessor),
            user_selector: optional(user_selector),
        },
        BlockKind::DeleteVar {
            name,
            storage,
            accessor,
            user_selector,
        } => BlockKind::DeleteVar {
            name,
            storage,
            accessor: accessor.map(normalize_accessor),
            user_selector: optional(user_selector),
        },
        BlockKind::SetVar {
            name,
            storage,
            value,
            accessor,
            user_selector,
        } => BlockKind::SetVar {
            name,
            storage,
            value: boxed(*value),
            accessor: accessor.map(normalize_accessor),
            user_selector: optional(user_selector),
        },
        BlockKind::Binary {
            operator,
            left,
            right,
        } => BlockKind::Binary {
            operator,
            left: boxed(*left),
            right: boxed(*right),
        },
        BlockKind::Unary { operator, argument } => BlockKind::Unary {
            operator,
            argument: boxed(*argument),
        },
        BlockKind::Ternary {
            test,
            consequent,
            alternate,
        } => BlockKind::Ternary {
            test: boxed(*test),
            consequent: boxed(*consequent),
            alternate: boxed(*alternate),
        },
        BlockKind::ArrayLiteral { items, accessor } => BlockKind::ArrayLiteral {
            items: items.into_iter().map(normalize_value).collect(),
            accessor: accessor.map(normalize_accessor),
        },
        BlockKind::LoopAssign {
            name,
            operator,
            value,
        } => BlockKind::LoopAssign {
            name,
            operator,
            value: optional(value),
        },
        BlockKind::ForLoop {
            loop_var,
            mode,
            init,
            condition,
            update,
            iterable,
            body,
        } => {
            let mut spread = Vec::with_capacity(body.len());
            for child in body {
                spread_body(child, &mut spread);
            }
            BlockKind::ForLoop {
                loop_var,
                mode,
                init: optional(init),
                condition: optional(condition),
                update: optional(update),
                iterable: optional(iterable),
                body: spread,
            }
        }
        other @ (BlockKind::Literal { .. } | BlockKind::Raw { .. } | BlockKind::LoopVar { .. }) => {
            other
        }
    };
    BlockNode::new(id, kind)
}

/// Loop bodies spread groups only.
fn spread_body(node: BlockNode, out: &mut Vec<BlockNode>) {
    match node.kind {
        BlockKind::Group { children } => children.into_iter().for_each(|c| spread_body(c, out)),
        _ => out.push(normalize_value(node)),
    }
}

fn normalize_accessor(accessor: BlockAccessor) -> BlockAccessor {
    match accessor {
        BlockAccessor::Index { index } => BlockAccessor::Index {
            index: boxed(*index),
        },
        BlockAccessor::SetIndex { index } => BlockAccessor::SetIndex {
            index: boxed(*index),
        },
        BlockAccessor::Remove { index } => BlockAccessor::Remove {
            index: boxed(*index),
        },
        other => other,
    }
}

/// `mergeText(nodes, true)`: joins neighbouring text (the first keeps its id), then drops empty
/// text.
fn merge_text(nodes: Vec<BlockNode>) -> Vec<BlockNode> {
    let mut out: Vec<BlockNode> = Vec::with_capacity(nodes.len());
    for node in nodes {
        if let BlockKind::Literal { value } = &node.kind
            && let Some(BlockNode {
                kind: BlockKind::Literal { value: last },
                ..
            }) = out.last_mut()
        {
            last.push_str(value);
            continue;
        }
        out.push(node);
    }
    out.retain(|node| !matches!(&node.kind, BlockKind::Literal { value } if value.is_empty()));
    out
}

/// `blockShape(a) === blockShape(b)`: the same structure, ids ignored.
pub fn shape_eq(a: &BlockNode, b: &BlockNode) -> bool {
    kind_eq(&a.kind, &b.kind)
}

/// [`shape_eq`] for roots.
pub fn shape_eq_root(a: &BlockRoot, b: &BlockRoot) -> bool {
    list_eq(&a.children, &b.children)
}

fn list_eq(a: &[BlockNode], b: &[BlockNode]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| shape_eq(a, b))
}

fn opt_eq(a: Option<&BlockNode>, b: Option<&BlockNode>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => shape_eq(a, b),
        _ => false,
    }
}

fn accessor_eq(a: Option<&BlockAccessor>, b: Option<&BlockAccessor>) -> bool {
    use BlockAccessor as A;
    match (a, b) {
        (None, None) => true,
        (Some(A::Index { index: x }), Some(A::Index { index: y }))
        | (Some(A::SetIndex { index: x }), Some(A::SetIndex { index: y }))
        | (Some(A::Remove { index: x }), Some(A::Remove { index: y })) => shape_eq(x, y),
        (Some(x), Some(y)) => {
            x.name() == y.name()
                && !matches!(x, A::Index { .. } | A::SetIndex { .. } | A::Remove { .. })
        }
        _ => false,
    }
}

fn kind_eq(a: &BlockKind, b: &BlockKind) -> bool {
    use BlockKind as K;
    match (a, b) {
        (K::Literal { value: x }, K::Literal { value: y }) => x == y,
        (K::Raw { source: x }, K::Raw { source: y }) => x == y,
        (K::Function { name: n1, args: a1 }, K::Function { name: n2, args: a2 }) => {
            n1 == n2 && list_eq(a1, a2)
        }
        (
            K::CommandRef {
                command_name: n1,
                args: a1,
            },
            K::CommandRef {
                command_name: n2,
                args: a2,
            },
        ) => n1 == n2 && list_eq(a1, a2),
        (
            K::GetVar {
                name: n1,
                storage: s1,
                accessor: x1,
                user_selector: u1,
            },
            K::GetVar {
                name: n2,
                storage: s2,
                accessor: x2,
                user_selector: u2,
            },
        )
        | (
            K::Exists {
                name: n1,
                storage: s1,
                accessor: x1,
                user_selector: u1,
            },
            K::Exists {
                name: n2,
                storage: s2,
                accessor: x2,
                user_selector: u2,
            },
        )
        | (
            K::DeleteVar {
                name: n1,
                storage: s1,
                accessor: x1,
                user_selector: u1,
            },
            K::DeleteVar {
                name: n2,
                storage: s2,
                accessor: x2,
                user_selector: u2,
            },
        ) => {
            n1 == n2
                && s1 == s2
                && accessor_eq(x1.as_ref(), x2.as_ref())
                && opt_eq(u1.as_deref(), u2.as_deref())
        }
        (
            K::SetVar {
                name: n1,
                storage: s1,
                value: v1,
                accessor: x1,
                user_selector: u1,
            },
            K::SetVar {
                name: n2,
                storage: s2,
                value: v2,
                accessor: x2,
                user_selector: u2,
            },
        ) => {
            n1 == n2
                && s1 == s2
                && shape_eq(v1, v2)
                && accessor_eq(x1.as_ref(), x2.as_ref())
                && opt_eq(u1.as_deref(), u2.as_deref())
        }
        (
            K::Binary {
                operator: o1,
                left: l1,
                right: r1,
            },
            K::Binary {
                operator: o2,
                left: l2,
                right: r2,
            },
        ) => o1 == o2 && shape_eq(l1, l2) && shape_eq(r1, r2),
        (
            K::Unary {
                operator: o1,
                argument: a1,
            },
            K::Unary {
                operator: o2,
                argument: a2,
            },
        ) => o1 == o2 && shape_eq(a1, a2),
        (
            K::Ternary {
                test: t1,
                consequent: c1,
                alternate: a1,
            },
            K::Ternary {
                test: t2,
                consequent: c2,
                alternate: a2,
            },
        ) => shape_eq(t1, t2) && shape_eq(c1, c2) && shape_eq(a1, a2),
        (K::Template { parts: p1 }, K::Template { parts: p2 }) => list_eq(p1, p2),
        (K::Group { children: c1 }, K::Group { children: c2 }) => list_eq(c1, c2),
        (
            K::ArrayLiteral {
                items: i1,
                accessor: x1,
            },
            K::ArrayLiteral {
                items: i2,
                accessor: x2,
            },
        ) => list_eq(i1, i2) && accessor_eq(x1.as_ref(), x2.as_ref()),
        (K::LoopVar { name: n1 }, K::LoopVar { name: n2 }) => n1 == n2,
        (
            K::LoopAssign {
                name: n1,
                operator: o1,
                value: v1,
            },
            K::LoopAssign {
                name: n2,
                operator: o2,
                value: v2,
            },
        ) => n1 == n2 && o1 == o2 && opt_eq(v1.as_deref(), v2.as_deref()),
        (
            K::ForLoop {
                loop_var: l1,
                mode: m1,
                init: i1,
                condition: c1,
                update: u1,
                iterable: it1,
                body: b1,
            },
            K::ForLoop {
                loop_var: l2,
                mode: m2,
                init: i2,
                condition: c2,
                update: u2,
                iterable: it2,
                body: b2,
            },
        ) => {
            l1 == l2
                && m1 == m2
                && opt_eq(i1.as_deref(), i2.as_deref())
                && opt_eq(c1.as_deref(), c2.as_deref())
                && opt_eq(u1.as_deref(), u2.as_deref())
                && opt_eq(it1.as_deref(), it2.as_deref())
                && list_eq(b1, b2)
        }
        _ => false,
    }
}
