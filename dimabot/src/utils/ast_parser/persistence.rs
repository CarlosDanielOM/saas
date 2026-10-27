use super::{
    ArrayAccessor, AstNode, Diagnostic, DiagnosticCode, HARD_JSON_NESTING_CEILING, SourceSpan,
    TemplateSegment,
};
use serde_json::Value;

enum Container<'a> {
    Node(&'a AstNode),
    Accessor(&'a ArrayAccessor),
    Segment(&'a TemplateSegment),
    Value(&'a Value),
}

/// Count the containers in the persisted shape, including empty field arrays.
/// This visits each typed value once without cloning or serializing the AST.
pub(super) fn json_container_depth(root: &AstNode) -> usize {
    let mut pending = vec![(Container::Node(root), 0)];
    let mut maximum = 0;
    while let Some((container, parent_depth)) = pending.pop() {
        let depth = parent_depth + 1;
        match container {
            Container::Node(node) => match node {
                AstNode::Root { children }
                | AstNode::Function { args: children, .. }
                | AstNode::CommandRef { args: children, .. } => {
                    maximum = maximum.max(depth + 1);
                    pending.extend(
                        children
                            .iter()
                            .map(|node| (Container::Node(node), depth + 1)),
                    );
                }
                AstNode::ArrayLiteral { items, accessor } => {
                    maximum = maximum.max(depth + 1);
                    pending.extend(items.iter().map(|node| (Container::Node(node), depth + 1)));
                    if let Some(accessor) = accessor {
                        pending.push((Container::Accessor(accessor), depth));
                    }
                }
                AstNode::SetVar {
                    value,
                    accessor,
                    user_selector,
                    ..
                } => {
                    pending.push((Container::Node(value), depth));
                    if let Some(accessor) = accessor {
                        pending.push((Container::Accessor(accessor), depth));
                    }
                    if let Some(selector) = user_selector {
                        pending.push((Container::Node(selector), depth));
                    }
                }
                AstNode::GetVar {
                    accessor,
                    user_selector,
                    ..
                }
                | AstNode::Exists {
                    accessor,
                    user_selector,
                    ..
                }
                | AstNode::DeleteVar {
                    accessor,
                    user_selector,
                    ..
                } => {
                    if let Some(accessor) = accessor {
                        pending.push((Container::Accessor(accessor), depth));
                    }
                    if let Some(selector) = user_selector {
                        pending.push((Container::Node(selector), depth));
                    }
                }
                AstNode::Binary { left, right, .. } => {
                    pending.push((Container::Node(left), depth));
                    pending.push((Container::Node(right), depth));
                }
                AstNode::Unary { argument, .. } => {
                    pending.push((Container::Node(argument), depth));
                }
                AstNode::Ternary {
                    test,
                    consequent,
                    alternate,
                } => {
                    pending.push((Container::Node(test), depth));
                    pending.push((Container::Node(consequent), depth));
                    pending.push((Container::Node(alternate), depth));
                }
                AstNode::Template { segments } => {
                    maximum = maximum.max(depth + 1);
                    pending.extend(
                        segments
                            .iter()
                            .map(|segment| (Container::Segment(segment), depth + 1)),
                    );
                }
                AstNode::LoopAssign {
                    value: Some(value), ..
                } => {
                    pending.push((Container::Node(value), depth));
                }
                AstNode::ForLoop {
                    init,
                    condition,
                    update,
                    iterable,
                    body,
                    ..
                } => {
                    maximum = maximum.max(depth + 1);
                    pending.extend(body.iter().map(|node| (Container::Node(node), depth + 1)));
                    for child in [
                        init.as_deref(),
                        condition.as_deref(),
                        update.as_deref(),
                        iterable.as_deref(),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        pending.push((Container::Node(child), depth));
                    }
                }
                AstNode::Custom { data, .. } => {
                    pending.push((Container::Value(data), depth));
                }
                AstNode::Literal { .. }
                | AstNode::LoopVar { .. }
                | AstNode::LoopAssign { value: None, .. } => {}
            },
            Container::Accessor(accessor) => match accessor {
                ArrayAccessor::Index { index }
                | ArrayAccessor::SetIndex { index }
                | ArrayAccessor::Remove { index } => {
                    pending.push((Container::Node(index), depth));
                }
                ArrayAccessor::Array
                | ArrayAccessor::Random
                | ArrayAccessor::Length
                | ArrayAccessor::Append
                | ArrayAccessor::Clear => {}
            },
            Container::Segment(segment) => match segment {
                TemplateSegment::Expr { node } => pending.push((Container::Node(node), depth)),
                TemplateSegment::Text { .. } => {}
            },
            Container::Value(value) => match value {
                Value::Array(values) => {
                    pending.extend(values.iter().map(|value| (Container::Value(value), depth)));
                }
                Value::Object(values) => {
                    pending.extend(
                        values
                            .values()
                            .map(|value| (Container::Value(value), depth)),
                    );
                }
                _ => continue,
            },
        }
        maximum = maximum.max(depth);
    }
    maximum
}

pub(super) fn validate(root: &AstNode, span: SourceSpan) -> Result<(), Diagnostic> {
    if json_container_depth(root) >= HARD_JSON_NESTING_CEILING {
        return Err(Diagnostic::new(
            DiagnosticCode::NestingLimit,
            "AST JSON serialization nesting limit exceeded",
            span,
        ));
    }
    Ok(())
}
