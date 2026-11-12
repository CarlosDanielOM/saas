//! Tag permission expressions (reference: `utils/permissions/expression.ts`).
//!
//! A Boolean tree over role tags, legacy levels and named accounts. Stored trees are untyped
//! (`Mixed`), so [`validate_expression`] is also the sanitiser for every read from storage and
//! every API body. A present but invalid value fails closed.
//!
//! Hostile input is bounded before any work: validation stops at depth
//! [`MAX_EXPRESSION_DEPTH`] (no recursion below it) and at [`MAX_EXPRESSION_NODES`] nodes, and
//! [`count_expression_nodes`] walks iteratively.

use serde_json::{Value, json};

use super::roles::{RoleTag, UserIdentity, is_account_id, is_login};
use crate::value::{Js, JsView, js_object_keys, js_string};

/// The root is at depth 1; a node at depth `MAX_EXPRESSION_DEPTH + 1` is refused.
pub const MAX_EXPRESSION_DEPTH: usize = 4;
/// The most nodes a tree may have.
pub const MAX_EXPRESSION_NODES: usize = 25;

const OPERATORS: [&str; 6] = ["role", "level", "user", "not", "and", "or"];

/// Three-valued truth: an unknown account stays unknown through `not` and is denied only at the
/// end, so negating an unknown chatter can never grant access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truth {
    /// Matches.
    True,
    /// Does not match.
    False,
    /// Cannot be decided (a named-account rule and an identity without an account id).
    Unknown,
}

impl Truth {
    /// Only `True` grants.
    pub const fn is_true(self) -> bool {
        matches!(self, Self::True)
    }

    fn negate(self) -> Self {
        match self {
            Self::True => Self::False,
            Self::False => Self::True,
            Self::Unknown => Self::Unknown,
        }
    }
}

impl From<bool> for Truth {
    fn from(value: bool) -> Self {
        if value { Self::True } else { Self::False }
    }
}

/// Why a tree was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationErrorCode {
    /// Deeper than [`MAX_EXPRESSION_DEPTH`].
    MaximumDepth,
    /// A node is not a plain object.
    NodeMustBeObject,
    /// A node has no operator key.
    MissingOperator,
    /// A node has more than one operator key.
    MultipleOperators,
    /// A node has keys besides its operator.
    UnknownFields,
    /// More than [`MAX_EXPRESSION_NODES`] nodes.
    MaximumNodes,
    /// `role` is not a known tag.
    UnknownRole,
    /// `level` is not an integer from 1 to 10.
    InvalidLevel,
    /// `user` is not exactly `{id, login}`.
    InvalidUserShape,
    /// `user.id` is not a Twitch account id.
    InvalidUserId,
    /// `user.login` is not a Twitch login.
    InvalidUserLogin,
    /// `and`/`or` is not a non-empty array.
    InvalidGroup,
}

/// A refused tree: the reference's message and a stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ValidationError {
    /// The reference's error text.
    pub message: String,
    /// What was wrong.
    pub code: ValidationErrorCode,
}

fn error(code: ValidationErrorCode, message: impl Into<String>) -> ValidationError {
    ValidationError {
        message: message.into(),
        code,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Node {
    Role(RoleTag),
    Level(u8),
    User { id: String, login: String },
    Not(Box<Node>),
    And(Vec<Node>),
    Or(Vec<Node>),
}

impl Node {
    pub(crate) fn truth(&self, identity: &UserIdentity) -> Truth {
        match self {
            Self::Role(tag) => (*tag == RoleTag::Everyone || identity.has_tag(*tag)).into(),
            Self::Level(level) => (identity.level() >= f64::from(*level)).into(),
            Self::User { id, .. } => identity
                .user_id()
                .map_or(Truth::Unknown, |user_id| (id == user_id).into()),
            Self::Not(child) => child.truth(identity).negate(),
            Self::And(children) => group_truth(children, identity, Truth::False),
            Self::Or(children) => group_truth(children, identity, Truth::True),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Role(role) => json!({ "role": role.as_str() }),
            Self::Level(level) => json!({ "level": level }),
            Self::User { id, login } => json!({ "user": { "id": id, "login": login } }),
            Self::Not(child) => json!({ "not": child.to_json() }),
            Self::And(children) => {
                json!({ "and": children.iter().map(Self::to_json).collect::<Vec<_>>() })
            }
            Self::Or(children) => {
                json!({ "or": children.iter().map(Self::to_json).collect::<Vec<_>>() })
            }
        }
    }

    fn to_bson(&self) -> bson::Bson {
        use bson::{Bson, doc};
        let group = |children: &[Self]| Bson::Array(children.iter().map(Self::to_bson).collect());
        Bson::Document(match self {
            Self::Role(role) => doc! { "role": role.as_str() },
            // Node's BSON writer stores an integral number in int32 range as int32.
            Self::Level(level) => doc! { "level": i32::from(*level) },
            Self::User { id, login } => doc! { "user": { "id": id, "login": login } },
            Self::Not(child) => doc! { "not": child.to_bson() },
            Self::And(children) => doc! { "and": group(children) },
            Self::Or(children) => doc! { "or": group(children) },
        })
    }
}

/// `and` stops at the first `False`, `or` at the first `True`; otherwise any unknown child makes
/// the group unknown.
fn group_truth(children: &[Node], identity: &UserIdentity, decisive: Truth) -> Truth {
    let mut unknown = false;
    for child in children {
        let result = child.truth(identity);
        if result == decisive {
            return decisive;
        }
        unknown |= result == Truth::Unknown;
    }
    if unknown {
        Truth::Unknown
    } else {
        decisive.negate()
    }
}

/// A tree that passed validation: immutable, bounded, and owned. Only
/// [`validate_expression`] builds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedExpression {
    pub(crate) root: Node,
    node_count: usize,
}

impl ValidatedExpression {
    /// `evaluateExpression`: the broadcaster always matches; otherwise only `True` grants.
    /// (The command and exemption gates add the dashboard's flat precedence on top: use
    /// [`CompiledPermission`](super::CompiledPermission) for them.)
    pub fn evaluate(&self, identity: &UserIdentity) -> bool {
        self.evaluate_truth(identity).is_true()
    }

    /// [`evaluate`](Self::evaluate) before the final fail-closed step.
    pub fn evaluate_truth(&self, identity: &UserIdentity) -> Truth {
        if identity.has_tag(RoleTag::Broadcaster) {
            Truth::True
        } else {
            self.root.truth(identity)
        }
    }

    /// The sanitised tree as JSON (logins lowercased), as the API returns it.
    pub fn to_json(&self) -> Value {
        self.root.to_json()
    }

    /// The sanitised tree as BSON, with the types Mongoose writes for it.
    pub fn to_bson(&self) -> bson::Bson {
        self.root.to_bson()
    }

    /// The number of nodes.
    pub fn node_count(&self) -> usize {
        self.node_count
    }
}

/// `validateExpression`: exactly one operator per node, known roles, integer levels 1 to 10,
/// accounts as `{id, login}`, non-empty groups, depth and node limits.
pub fn validate_expression<V: JsView>(input: &V) -> Result<ValidatedExpression, ValidationError> {
    let mut nodes = 0;
    let root = validate_node(input, 1, &mut nodes)?;
    Ok(ValidatedExpression {
        root,
        node_count: nodes,
    })
}

fn validate_node<V: JsView>(
    input: &V,
    depth: usize,
    nodes: &mut usize,
) -> Result<Node, ValidationError> {
    use ValidationErrorCode as Code;
    if depth > MAX_EXPRESSION_DEPTH {
        return Err(error(
            Code::MaximumDepth,
            format!("expression exceeds maximum depth of {MAX_EXPRESSION_DEPTH}"),
        ));
    }
    match input.js() {
        Js::Object => {}
        // A Date or an ObjectId is an object with no own keys in JavaScript.
        Js::Other => {
            return Err(error(
                Code::MissingOperator,
                "expression node is empty or has no recognized operator",
            ));
        }
        _ => {
            return Err(error(
                Code::NodeMustBeObject,
                "expression node must be an object",
            ));
        }
    }
    let keys = js_object_keys(input);
    let (operators, unknown): (Vec<&str>, Vec<&str>) =
        keys.into_iter().partition(|key| OPERATORS.contains(key));
    let operator = match operators.as_slice() {
        [] => {
            return Err(error(
                Code::MissingOperator,
                "expression node is empty or has no recognized operator",
            ));
        }
        [operator] => *operator,
        _ => {
            return Err(error(
                Code::MultipleOperators,
                format!(
                    "expression node must have exactly one operator, found: {}",
                    operators.join(", ")
                ),
            ));
        }
    };
    if !unknown.is_empty() {
        return Err(error(
            Code::UnknownFields,
            format!("expression node has unknown fields: {}", unknown.join(", ")),
        ));
    }
    *nodes += 1;
    if *nodes > MAX_EXPRESSION_NODES {
        return Err(error(
            Code::MaximumNodes,
            format!("expression exceeds maximum of {MAX_EXPRESSION_NODES} nodes"),
        ));
    }
    let Some(value) = input.get(operator) else {
        // Unreachable: the key came from this object.
        return Err(error(
            Code::MissingOperator,
            "expression node is empty or has no recognized operator",
        ));
    };
    match operator {
        "role" => RoleTag::from_js(value).map(Node::Role).ok_or_else(|| {
            error(
                Code::UnknownRole,
                format!("unknown role tag: {}", js_string(value)),
            )
        }),
        "level" => match value.js() {
            Js::Number(level) if level.fract() == 0.0 && (1.0..=10.0).contains(&level) => {
                // Exact: an integer from 1 to 10.
                Ok(Node::Level(level as u8))
            }
            _ => Err(error(
                Code::InvalidLevel,
                format!(
                    "level must be an integer between 1 and 10, got: {}",
                    js_string(value)
                ),
            )),
        },
        "user" => validate_user(value),
        "not" => validate_node(value, depth + 1, nodes).map(|child| Node::Not(Box::new(child))),
        _ => {
            let children = match value.js() {
                Js::Array(children) if !children.is_empty() => children,
                _ => {
                    return Err(error(
                        Code::InvalidGroup,
                        format!("{operator} group must be an array with at least one child"),
                    ));
                }
            };
            let mut validated = Vec::with_capacity(children.len().min(MAX_EXPRESSION_NODES));
            for child in children {
                validated.push(validate_node(child, depth + 1, nodes)?);
            }
            Ok(if operator == "and" {
                Node::And(validated)
            } else {
                Node::Or(validated)
            })
        }
    }
}

fn validate_user<V: JsView>(value: &V) -> Result<Node, ValidationError> {
    use ValidationErrorCode as Code;
    let keys = value.keys();
    let shaped = matches!(value.js(), Js::Object)
        && keys.len() == 2
        && keys.contains(&"id")
        && keys.contains(&"login");
    let field = |name: &str| match value.get(name).map(JsView::js) {
        Some(Js::String(text)) => Some(text),
        _ => None,
    };
    if !shaped {
        return Err(error(
            Code::InvalidUserShape,
            "user must contain exactly id and login",
        ));
    }
    let Some(id) = field("id").filter(|id| is_account_id(id)) else {
        return Err(error(
            Code::InvalidUserId,
            "user id must be a Twitch account ID",
        ));
    };
    let Some(login) = field("login").filter(|login| is_login(login)) else {
        return Err(error(
            Code::InvalidUserLogin,
            "user login must be a Twitch login",
        ));
    };
    Ok(Node::User {
        id: id.to_owned(),
        login: login.to_ascii_lowercase(),
    })
}

/// How a stored permission value is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpressionState {
    /// Missing or `null`: the legacy numeric level decides.
    Level,
    /// A valid tree decides.
    Tags(ValidatedExpression),
    /// A present invalid value: a configuration error that denies (never falls back to the
    /// level).
    Invalid(ValidationError),
}

impl ExpressionState {
    /// The reference's mode name: `level`, `tags` or `invalid`.
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Level => "level",
            Self::Tags(_) => "tags",
            Self::Invalid(_) => "invalid",
        }
    }
}

/// `inspectExpression`.
pub fn inspect_expression<V: JsView>(input: Option<&V>) -> ExpressionState {
    match input {
        None => ExpressionState::Level,
        Some(value) if matches!(value.js(), Js::Null | Js::Undefined) => ExpressionState::Level,
        Some(value) => match validate_expression(value) {
            Ok(expression) => ExpressionState::Tags(expression),
            Err(error) => ExpressionState::Invalid(error),
        },
    }
}

/// `countExpressionNodes`: an informational count for any shape (validation counts
/// separately). Iterative, so a hostile tree cannot exhaust the stack.
pub fn count_expression_nodes<V: JsView>(expression: &V) -> usize {
    fn present<V: JsView>(value: Option<&V>) -> Option<&V> {
        value.filter(|value| !matches!(value.js(), Js::Null | Js::Undefined))
    }
    let mut pending = vec![expression];
    let mut count = 0_usize;
    while let Some(value) = pending.pop() {
        if !matches!(value.js(), Js::Object) {
            continue;
        }
        if ["role", "level", "user"]
            .iter()
            .any(|key| value.get(key).is_some())
        {
            count += 1;
        } else if let Some(child) = value.get("not") {
            count += 1;
            pending.push(child);
        } else if value.get("and").is_some() || value.get("or").is_some() {
            count += 1;
            // `node.and ?? node.or`
            if let Some(Js::Array(children)) = present(value.get("and"))
                .or_else(|| value.get("or"))
                .map(JsView::js)
            {
                pending.extend(children);
            }
        }
    }
    count
}
