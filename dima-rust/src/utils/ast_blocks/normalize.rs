use super::types::*;

pub fn structural_eq(left: &BlockNode, right: &BlockNode) -> bool {
    left.kind == right.kind
}
pub fn structural_eq_root(left: &BlockRoot, right: &BlockRoot) -> bool {
    left.children == right.children
}

pub(super) fn merge(nodes: Vec<BlockNode>) -> Vec<BlockNode> {
    let mut out: Vec<BlockNode> = Vec::with_capacity(nodes.len());
    for mut node in nodes {
        if let BlockKind::Literal { value } = &node.kind
            && let Some(previous) = out.last_mut()
            && let BlockKind::Literal {
                value: previous_text,
            } = &previous.kind
        {
            let offset = previous_text.len();
            if previous.text_pieces.is_empty() {
                previous.text_pieces = previous.pieces(offset);
            }
            let pieces = if node.text_pieces.is_empty() {
                node.pieces(value.len())
            } else {
                std::mem::take(&mut node.text_pieces)
            };
            previous
                .text_pieces
                .extend(pieces.into_iter().map(|mut piece| {
                    piece.start += offset;
                    piece.end += offset;
                    piece
                }));
            if let BlockKind::Literal {
                value: previous_text,
            } = &mut previous.kind
            {
                previous_text.push_str(value);
            }
            continue;
        }
        out.push(node);
    }
    out.retain(|n| !matches!(&n.kind, BlockKind::Literal {value} if value.is_empty()));
    out
}
fn flatten(nodes: Vec<BlockNode>, out: &mut Vec<BlockNode>, templates: bool, normalize: bool) {
    for node in nodes {
        match node.kind {
            BlockKind::Group { children } => flatten(children, out, templates, normalize),
            BlockKind::Template { parts } if templates => flatten(parts, out, templates, normalize),
            _ => out.push(if normalize {
                normalize_value(node)
            } else {
                node
            }),
        }
    }
}
pub fn normalize_root(mut root: BlockRoot) -> BlockRoot {
    let mut children = Vec::new();
    flatten(root.children, &mut children, true, true);
    root.children = merge(children);
    root
}
fn normalize_box(value: &mut Box<BlockNode>) {
    let old = std::mem::replace(
        value.as_mut(),
        BlockNode::new(
            "",
            BlockKind::Literal {
                value: String::new(),
            },
        ),
    );
    **value = normalize_value(old);
}
fn normalize_optional(value: &mut Option<Box<BlockNode>>) {
    if let Some(v) = value {
        normalize_box(v);
    }
}
fn normalize_list(nodes: &mut Vec<BlockNode>) {
    *nodes = std::mem::take(nodes)
        .into_iter()
        .map(normalize_value)
        .collect();
}
fn normalize_accessor(accessor: &mut Option<BlockAccessor>) {
    if let Some(a) = accessor
        && let Some(n) = a.index_mut()
    {
        let old = std::mem::replace(
            n,
            BlockNode::new(
                "",
                BlockKind::Literal {
                    value: String::new(),
                },
            ),
        );
        *n = normalize_value(old);
    }
}

/// Consumes nodes and moves child strings; transient provenance follows surviving nodes.
pub fn normalize_value(mut node: BlockNode) -> BlockNode {
    if let BlockKind::Group { children } = node.kind {
        node.kind = BlockKind::Template { parts: children };
    }
    match &mut node.kind {
        BlockKind::Template { parts } => {
            let mut flat = Vec::new();
            flatten(std::mem::take(parts), &mut flat, true, true);
            let mut merged = merge(flat);
            if merged.is_empty() {
                node.kind = BlockKind::Literal {
                    value: String::new(),
                };
            } else if merged.len() == 1 && matches!(merged[0].kind, BlockKind::Literal { .. }) {
                let only = merged.pop().expect("one item");
                // Keep the container ID as in TS, but retain the actual literal's
                // input origin for a later field error.
                node.diagnostic_id = Some(only.diagnostic_id.unwrap_or(only.id));
                node.origin = only.origin;
                node.text_pieces = only.text_pieces;
                node.kind = only.kind;
            } else {
                *parts = merged;
            }
        }
        BlockKind::Function { args, .. } | BlockKind::CommandRef { args, .. } => {
            normalize_list(args)
        }
        BlockKind::GetVar {
            accessor,
            user_selector,
            ..
        }
        | BlockKind::Exists {
            accessor,
            user_selector,
            ..
        }
        | BlockKind::DeleteVar {
            accessor,
            user_selector,
            ..
        } => {
            normalize_accessor(accessor);
            normalize_optional(user_selector);
        }
        BlockKind::SetVar {
            value,
            accessor,
            user_selector,
            ..
        } => {
            normalize_box(value);
            normalize_accessor(accessor);
            normalize_optional(user_selector);
        }
        BlockKind::Binary { left, right, .. } => {
            normalize_box(left);
            normalize_box(right);
        }
        BlockKind::Unary { argument, .. } => normalize_box(argument),
        BlockKind::Ternary {
            test,
            consequent,
            alternate,
        } => {
            normalize_box(test);
            normalize_box(consequent);
            normalize_box(alternate);
        }
        BlockKind::ArrayLiteral { items, accessor } => {
            normalize_list(items);
            normalize_accessor(accessor);
        }
        BlockKind::LoopAssign { value, .. } => normalize_optional(value),
        BlockKind::ForLoop {
            init,
            condition,
            update,
            iterable,
            body,
            ..
        } => {
            let mut flat = Vec::new();
            flatten(std::mem::take(body), &mut flat, false, true);
            *body = flat;
            normalize_optional(init);
            normalize_optional(condition);
            normalize_optional(update);
            normalize_optional(iterable);
        }
        _ => {}
    }
    node
}
