//! Pure permission policies ported from `dimabot/src/utils/permissions`.
//!
//! Compile stored JSON once, then share the immutable policy across decisions.
//! Validation preserves tree structure: dashboard allow/exclude shapes have
//! account/role/default precedence, while other trees use three-valued Boolean
//! evaluation. Invalid configuration denies even broadcasters. Evaluation has
//! no I/O, role resolution or authentication. The error limiter keeps bounded
//! process-local state for repeated diagnostics.

#[path = "error_rate_limit.rs"]
pub mod error_rate_limit;
pub use error_rate_limit::should_log_permission_error;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::js_compat;

pub const MAX_EXPRESSION_DEPTH: usize = 4;
pub const MAX_EXPRESSION_NODES: usize = 25;
pub const BROADCASTER_USER_LEVEL: f64 = 10.0;
pub const MODERATOR_BADGE_IDS: [&str; 2] = ["moderator", "lead_moderator"];
pub const ROLE_TAGS: [RoleTag; 8] = [
    RoleTag::Everyone,
    RoleTag::Sub,
    RoleTag::Vip,
    RoleTag::Founder,
    RoleTag::Mod,
    RoleTag::Editor,
    RoleTag::Admin,
    RoleTag::Broadcaster,
];
pub const LEGACY_USER_LEVEL_NAMES: [(u8, &str); 10] = [
    (1, "everyone"),
    (2, "tier1"),
    (3, "tier2"),
    (4, "tier3"),
    (5, "vip"),
    (6, "founder"),
    (7, "mod"),
    (8, "editor"),
    (9, "admin"),
    (10, "broadcaster"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleTag {
    Everyone,
    Sub,
    Vip,
    Founder,
    Mod,
    Editor,
    Admin,
    Broadcaster,
}

impl RoleTag {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Everyone => "everyone",
            Self::Sub => "sub",
            Self::Vip => "vip",
            Self::Founder => "founder",
            Self::Mod => "mod",
            Self::Editor => "editor",
            Self::Admin => "admin",
            Self::Broadcaster => "broadcaster",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        ROLE_TAGS.into_iter().find(|tag| tag.as_str() == value)
    }
}

/// A trusted internal snapshot, not proof that the claimed roles are authentic.
/// No `Deserialize`: use the explicit snapshot parser for untyped JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UserIdentity {
    level: f64,
    tags: Vec<RoleTag>,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<String>,
}

impl UserIdentity {
    /// Matches createUserIdentity: no level clamp, insertion-ordered unique
    /// tags, everyone added last if absent, empty ID/login omitted.
    pub fn new(
        level: f64,
        tags: impl IntoIterator<Item = RoleTag>,
        user_id: Option<String>,
        login: Option<String>,
    ) -> Self {
        let mut unique = Vec::new();
        for tag in tags {
            insert_tag(&mut unique, tag);
        }
        insert_tag(&mut unique, RoleTag::Everyone);
        Self {
            level,
            tags: unique,
            user_id: user_id.filter(|id| !id.is_empty()),
            login: login
                .filter(|login| !login.is_empty())
                .map(|s| s.to_lowercase()),
        }
    }

    pub fn level(&self) -> f64 {
        self.level
    }

    pub fn tags(&self) -> &[RoleTag] {
        &self.tags
    }

    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }

    pub fn login(&self) -> Option<&str> {
        self.login.as_deref()
    }

    pub fn has_tag(&self, tag: RoleTag) -> bool {
        self.tags.contains(&tag)
    }

    pub fn serialize(&self) -> Value {
        serialize_user_identity(self)
    }
}

impl Default for UserIdentity {
    fn default() -> Self {
        create_default_identity()
    }
}

pub fn create_default_identity() -> UserIdentity {
    UserIdentity::new(1.0, [], None, None)
}

pub fn create_broadcaster_identity() -> UserIdentity {
    UserIdentity::new(BROADCASTER_USER_LEVEL, [RoleTag::Broadcaster], None, None)
}

pub fn serialize_user_identity(identity: &UserIdentity) -> Value {
    let mut value = json!({ "level": identity.level, "tags": identity.tags });
    if let Some(id) = identity.user_id() {
        value["userId"] = Value::String(id.into());
    }
    if let Some(login) = identity.login() {
        value["login"] = Value::String(login.into());
    }
    value
}

/// Decode a trusted internal snapshot. This preserves claimed known tags and
/// must never be used to authenticate arbitrary client-supplied role claims.
/// Only a finite numeric level field is truncated/clamped; fallback is as-is.
pub fn parse_user_identity(raw: Option<&Value>, fallback_level: f64) -> UserIdentity {
    let level = raw
        .and_then(|v| v.get("level"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n.trunc().clamp(1.0, BROADCASTER_USER_LEVEL))
        .unwrap_or(fallback_level);
    let tags = raw
        .and_then(|v| v.get("tags"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().and_then(RoleTag::parse));
    let user_id = raw
        .and_then(|v| v.get("userId"))
        .and_then(Value::as_str)
        .filter(|id| valid_user_id(id))
        .map(str::to_owned);
    let login = raw
        .and_then(|v| v.get("login"))
        .and_then(Value::as_str)
        .filter(|login| valid_login(login))
        .map(str::to_owned);
    UserIdentity::new(level, tags, user_id, login)
}

fn insert_tag(tags: &mut Vec<RoleTag>, tag: RoleTag) {
    if !tags.contains(&tag) {
        tags.push(tag);
    }
}

fn valid_user_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn valid_login(login: &str) -> bool {
    (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn badge_set_ids(badges: &Value) -> impl Iterator<Item = String> + '_ {
    badges.as_array().into_iter().flatten().map(|badge| {
        badge
            .get("set_id")
            .filter(|v| !v.is_null())
            .or_else(|| badge.get("id").filter(|v| !v.is_null()))
            .map(js_string)
            .unwrap_or_default()
    })
}

pub fn derive_badge_level(badges: &Value) -> f64 {
    let mut level: f64 = 1.0;
    for id in badge_set_ids(badges) {
        level = level.max(match id.as_str() {
            "subscriber" => 2.0,
            "vip" => 5.0,
            "founder" => 6.0,
            "moderator" | "lead_moderator" => 7.0,
            _ => 1.0,
        });
    }
    level
}

pub fn derive_badge_tags(badges: &Value) -> Vec<RoleTag> {
    let mut tags = Vec::new();
    for id in badge_set_ids(badges) {
        match id.as_str() {
            "subscriber" => insert_tag(&mut tags, RoleTag::Sub),
            "vip" => insert_tag(&mut tags, RoleTag::Vip),
            "founder" => {
                insert_tag(&mut tags, RoleTag::Founder);
                insert_tag(&mut tags, RoleTag::Sub);
            }
            "moderator" | "lead_moderator" => insert_tag(&mut tags, RoleTag::Mod),
            _ => {}
        }
    }
    tags
}

/// Unknown is preserved through NOT and only denied at the final boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Truth {
    True,
    False,
    Unknown,
}

impl Truth {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationErrorCode {
    MaximumDepth,
    NodeMustBeObject,
    MissingOperator,
    MultipleOperators,
    UnknownFields,
    MaximumNodes,
    UnknownRole,
    InvalidLevel,
    InvalidUserShape,
    InvalidUserId,
    InvalidUserLogin,
    InvalidGroup,
}

/// Source-compatible message plus stable machine-readable code and JSON path.
/// Object field ordering in messages follows serde_json's map ordering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidationError {
    pub message: String,
    pub code: ValidationErrorCode,
    pub path: String,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ValidationError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Role(RoleTag),
    Level(u8),
    User { id: String, login: String },
    Not(Box<Node>),
    And(Vec<Node>),
    Or(Vec<Node>),
}

impl Node {
    fn truth(&self, identity: &UserIdentity) -> Truth {
        match self {
            Self::Role(tag) => (*tag == RoleTag::Everyone || identity.has_tag(*tag)).into(),
            Self::Level(level) => (identity.level >= f64::from(*level)).into(),
            Self::User { id, .. } => identity
                .user_id()
                .map(|user_id| Truth::from(id == user_id))
                .unwrap_or(Truth::Unknown),
            Self::Not(child) => child.truth(identity).negate(),
            Self::And(children) | Self::Or(children) => {
                let is_and = matches!(self, Self::And(_));
                let decisive = if is_and { Truth::False } else { Truth::True };
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
                    is_and.into()
                }
            }
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Role(role) => json!({ "role": role }),
            Self::Level(level) => json!({ "level": level }),
            Self::User { id, login } => json!({ "user": { "id": id, "login": login } }),
            Self::Not(child) => json!({ "not": child.to_value() }),
            Self::And(children) => {
                json!({ "and": children.iter().map(Self::to_value).collect::<Vec<_>>() })
            }
            Self::Or(children) => {
                json!({ "or": children.iter().map(Self::to_value).collect::<Vec<_>>() })
            }
        }
    }
}

/// Only validation can construct this immutable, bounded tree. It cannot be
/// deserialized directly, and no mutable tree or JSON reference is exposed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedExpression {
    root: Node,
    node_count: usize,
}

impl ValidatedExpression {
    /// General Boolean semantics, including broadcaster override. Flat access
    /// precedence belongs to CompiledPermission, not this expression method.
    pub fn evaluate(&self, identity: &UserIdentity) -> bool {
        self.evaluate_truth(identity).is_true()
    }

    pub fn evaluate_truth(&self, identity: &UserIdentity) -> Truth {
        if identity.has_tag(RoleTag::Broadcaster) {
            Truth::True
        } else {
            self.root.truth(identity)
        }
    }

    pub fn to_value(&self) -> Value {
        self.root.to_value()
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }
}

pub fn validate_expression(input: &Value) -> Result<ValidatedExpression, ValidationError> {
    let mut nodes = 0;
    let root = validate_node(input, 1, &mut nodes, "$")?;
    Ok(ValidatedExpression {
        root,
        node_count: nodes,
    })
}

fn validation_error(
    code: ValidationErrorCode,
    path: &str,
    message: impl Into<String>,
) -> ValidationError {
    ValidationError {
        message: message.into(),
        code,
        path: path.into(),
    }
}

fn validate_node(
    input: &Value,
    depth: usize,
    nodes: &mut usize,
    path: &str,
) -> Result<Node, ValidationError> {
    use ValidationErrorCode as Code;
    if depth > MAX_EXPRESSION_DEPTH {
        return Err(validation_error(
            Code::MaximumDepth,
            path,
            format!("expression exceeds maximum depth of {MAX_EXPRESSION_DEPTH}"),
        ));
    }
    let Some(object) = input.as_object() else {
        return Err(validation_error(
            Code::NodeMustBeObject,
            path,
            "expression node must be an object",
        ));
    };
    const OPERATORS: [&str; 6] = ["role", "level", "user", "not", "and", "or"];
    let operators: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| OPERATORS.contains(key))
        .collect();
    if operators.is_empty() {
        return Err(validation_error(
            Code::MissingOperator,
            path,
            "expression node is empty or has no recognized operator",
        ));
    }
    if operators.len() > 1 {
        return Err(validation_error(
            Code::MultipleOperators,
            path,
            format!(
                "expression node must have exactly one operator, found: {}",
                operators.join(", ")
            ),
        ));
    }
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !OPERATORS.contains(key))
        .collect();
    if !unknown.is_empty() {
        return Err(validation_error(
            Code::UnknownFields,
            path,
            format!("expression node has unknown fields: {}", unknown.join(", ")),
        ));
    }
    *nodes += 1;
    if *nodes > MAX_EXPRESSION_NODES {
        return Err(validation_error(
            Code::MaximumNodes,
            path,
            format!("expression exceeds maximum of {MAX_EXPRESSION_NODES} nodes"),
        ));
    }
    let operator = operators[0];
    let value = &object[operator];
    let field_path = format!("{path}.{operator}");
    match operator {
        "role" => value
            .as_str()
            .and_then(RoleTag::parse)
            .map(Node::Role)
            .ok_or_else(|| {
                validation_error(
                    Code::UnknownRole,
                    &field_path,
                    format!("unknown role tag: {}", js_string(value)),
                )
            }),
        "level" => {
            let level = value
                .as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=10.0).contains(n));
            level.map(|n| Node::Level(n as u8)).ok_or_else(|| {
                validation_error(
                    Code::InvalidLevel,
                    &field_path,
                    format!(
                        "level must be an integer between 1 and 10, got: {}",
                        js_string(value)
                    ),
                )
            })
        }
        "user" => {
            let Some(user) = value
                .as_object()
                .filter(|u| u.len() == 2 && u.contains_key("id") && u.contains_key("login"))
            else {
                return Err(validation_error(
                    Code::InvalidUserShape,
                    &field_path,
                    "user must contain exactly id and login",
                ));
            };
            let Some(id) = user["id"].as_str().filter(|id| valid_user_id(id)) else {
                return Err(validation_error(
                    Code::InvalidUserId,
                    &format!("{field_path}.id"),
                    "user id must be a Twitch account ID",
                ));
            };
            let Some(login) = user["login"].as_str().filter(|login| valid_login(login)) else {
                return Err(validation_error(
                    Code::InvalidUserLogin,
                    &format!("{field_path}.login"),
                    "user login must be a Twitch login",
                ));
            };
            Ok(Node::User {
                id: id.into(),
                login: login.to_ascii_lowercase(),
            })
        }
        "not" => {
            validate_node(value, depth + 1, nodes, &field_path).map(|n| Node::Not(Box::new(n)))
        }
        "and" | "or" => {
            let Some(children) = value.as_array().filter(|children| !children.is_empty()) else {
                return Err(validation_error(
                    Code::InvalidGroup,
                    &field_path,
                    format!("{operator} group must be an array with at least one child"),
                ));
            };
            let children = children
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    validate_node(child, depth + 1, nodes, &format!("{field_path}[{index}]"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(if operator == "and" {
                Node::And(children)
            } else {
                Node::Or(children)
            })
        }
        _ => unreachable!("operator was recognized above"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpressionState {
    Level,
    Tags { expression: ValidatedExpression },
    Invalid { error: ValidationError },
}

pub fn inspect_expression(input: Option<&Value>) -> ExpressionState {
    match input.filter(|v| !v.is_null()) {
        None => ExpressionState::Level,
        Some(value) => match validate_expression(value) {
            Ok(expression) => ExpressionState::Tags { expression },
            Err(error) => ExpressionState::Invalid { error },
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Missing,
    Level,
    Tags,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionReason {
    MissingConfig,
    InvalidConfig,
    BroadcasterOverride,
    FlatAccountExclude,
    FlatAccountAllow,
    FlatRoleExclude,
    FlatRoleAllow,
    FlatDefaultAllow,
    FlatDefaultDeny,
    ExpressionTrue,
    ExpressionFalse,
    ExpressionUnknown,
    LegacyLevelPass,
    LegacyLevelFail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PermissionDecision {
    pub allowed: bool,
    pub mode: PermissionMode,
    pub reason: PermissionReason,
}

impl PermissionDecision {
    fn new(allowed: bool, mode: PermissionMode, reason: PermissionReason) -> Self {
        Self {
            allowed,
            mode,
            reason,
        }
    }
}

#[derive(Debug, Clone)]
enum FlatLeaf {
    Role(RoleTag),
    User(String),
}

fn flat_leaves(node: &Node) -> Option<Vec<FlatLeaf>> {
    let leaves = match node {
        Node::Or(children) => children.as_slice(),
        _ => std::slice::from_ref(node),
    };
    leaves
        .iter()
        .map(|leaf| match leaf {
            Node::Role(role) => Some(FlatLeaf::Role(*role)),
            Node::User { id, .. } => Some(FlatLeaf::User(id.clone())),
            _ => None,
        })
        .collect()
}

#[derive(Debug, Clone)]
struct FlatPlan {
    allowed: Vec<FlatLeaf>,
    excluded: Vec<FlatLeaf>,
}

impl FlatPlan {
    fn from_node(node: &Node) -> Option<Self> {
        // Exact source shapes/order only. Never flatten or simplify Boolean
        // structure: swapping AND operands can deliberately change semantics.
        let (allowed, excluded) = match node {
            Node::And(children) => {
                if children.len() != 2 {
                    return None;
                }
                let Node::Not(excluded) = &children[1] else {
                    return None;
                };
                (flat_leaves(&children[0])?, flat_leaves(excluded)?)
            }
            Node::Not(excluded) => (Vec::new(), flat_leaves(excluded)?),
            _ => (flat_leaves(node)?, Vec::new()),
        };
        Some(Self { allowed, excluded })
    }

    fn decide(&self, identity: &UserIdentity) -> Option<PermissionDecision> {
        use PermissionReason as Reason;
        if identity.user_id().is_none()
            && self
                .excluded
                .iter()
                .any(|leaf| matches!(leaf, FlatLeaf::User(_)))
        {
            return None; // Preserve source fallback to general Boolean logic.
        }
        let account_matches = |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::User(id) if Some(id.as_str()) == identity.user_id());
        let role_matches = |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::Role(role) if *role != RoleTag::Everyone && identity.has_tag(*role));
        let everyone = |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::Role(RoleTag::Everyone));
        let (allowed, reason) = if self.excluded.iter().any(account_matches) {
            (false, Reason::FlatAccountExclude)
        } else if self.allowed.iter().any(account_matches) {
            (true, Reason::FlatAccountAllow)
        } else if self.excluded.iter().any(role_matches) {
            (false, Reason::FlatRoleExclude)
        } else if self.allowed.iter().any(role_matches) {
            (true, Reason::FlatRoleAllow)
        } else if self.allowed.iter().any(everyone) {
            (true, Reason::FlatDefaultAllow)
        } else if self.excluded.iter().any(everyone) {
            (false, Reason::FlatDefaultDeny)
        } else if self.allowed.is_empty() {
            (true, Reason::FlatDefaultAllow)
        } else {
            (false, Reason::FlatDefaultDeny)
        };
        Some(PermissionDecision::new(
            allowed,
            PermissionMode::Tags,
            reason,
        ))
    }
}

#[derive(Debug, Clone)]
enum PolicyPlan {
    Legacy(f64),
    Invalid(ValidationError),
    Tags {
        expression: ValidatedExpression,
        flat: Option<FlatPlan>,
    },
}

/// Immutable, owned policy. Compilation is the only validation step;
/// subsequent decisions do not inspect raw JSON or revalidate a tree.
#[derive(Debug, Clone)]
pub struct CompiledPermission {
    plan: PolicyPlan,
}

impl CompiledPermission {
    pub fn compile(expression: Option<&Value>, legacy_level: Option<&Value>) -> Self {
        let plan = match inspect_expression(expression) {
            ExpressionState::Level => PolicyPlan::Legacy(parse_legacy_level(legacy_level)),
            ExpressionState::Invalid { error } => PolicyPlan::Invalid(error),
            ExpressionState::Tags { expression } => {
                let flat = FlatPlan::from_node(&expression.root);
                PolicyPlan::Tags { expression, flat }
            }
        };
        Self { plan }
    }

    pub fn mode(&self) -> PermissionMode {
        match &self.plan {
            PolicyPlan::Legacy(_) => PermissionMode::Level,
            PolicyPlan::Invalid(_) => PermissionMode::Invalid,
            PolicyPlan::Tags { .. } => PermissionMode::Tags,
        }
    }

    pub fn validation_error(&self) -> Option<&ValidationError> {
        match &self.plan {
            PolicyPlan::Invalid(error) => Some(error),
            _ => None,
        }
    }

    pub fn decide(&self, identity: &UserIdentity) -> PermissionDecision {
        use PermissionReason as Reason;
        match &self.plan {
            PolicyPlan::Invalid(_) => {
                PermissionDecision::new(false, PermissionMode::Invalid, Reason::InvalidConfig)
            }
            PolicyPlan::Legacy(level) => {
                let allowed = identity.level >= *level;
                PermissionDecision::new(
                    allowed,
                    PermissionMode::Level,
                    if allowed {
                        Reason::LegacyLevelPass
                    } else {
                        Reason::LegacyLevelFail
                    },
                )
            }
            PolicyPlan::Tags { expression, flat } => {
                if identity.has_tag(RoleTag::Broadcaster) {
                    return PermissionDecision::new(
                        true,
                        PermissionMode::Tags,
                        Reason::BroadcasterOverride,
                    );
                }
                if let Some(decision) = flat.as_ref().and_then(|plan| plan.decide(identity)) {
                    return decision;
                }
                let truth = expression.root.truth(identity);
                PermissionDecision::new(
                    truth.is_true(),
                    PermissionMode::Tags,
                    match truth {
                        Truth::True => Reason::ExpressionTrue,
                        Truth::False => Reason::ExpressionFalse,
                        Truth::Unknown => Reason::ExpressionUnknown,
                    },
                )
            }
        }
    }

    pub fn allowed(&self, identity: &UserIdentity) -> bool {
        self.decide(identity).allowed
    }
}

fn config_decision(
    config: Option<&Value>,
    expression_key: &str,
    level_key: &str,
    identity: &UserIdentity,
) -> PermissionDecision {
    // JavaScript's `if (!config)` rejects all JSON falsy values, while truthy
    // primitives/arrays have missing properties and therefore legacy level 0.
    let Some(config) = config.filter(|value| match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }) else {
        return PermissionDecision::new(
            false,
            PermissionMode::Missing,
            PermissionReason::MissingConfig,
        );
    };
    CompiledPermission::compile(config.get(expression_key), config.get(level_key)).decide(identity)
}

pub fn command_decision(command: Option<&Value>, identity: &UserIdentity) -> PermissionDecision {
    config_decision(command, "permissionExpression", "userLevel", identity)
}

pub fn command_allowed(command: Option<&Value>, identity: &UserIdentity) -> bool {
    command_decision(command, identity).allowed
}

pub fn rule_exemption_decision(
    rule: Option<&Value>,
    identity: &UserIdentity,
) -> PermissionDecision {
    config_decision(rule, "exemptExpression", "exemptUserLevel", identity)
}

pub fn rule_exempt(rule: Option<&Value>, identity: &UserIdentity) -> bool {
    rule_exemption_decision(rule, identity).allowed
}

/// Finite JSON numbers are used as-is. Other values follow
/// Number.parseInt(String(value ?? 0), 10), including array stringification.
pub fn parse_legacy_level(value: Option<&Value>) -> f64 {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return 0.0;
    };
    if let Some(number) = value.as_f64().filter(|n| n.is_finite()) {
        return number;
    }
    let text = js_string(value);
    let text = text.trim_start_matches(js_compat::is_whitespace);
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 {
        return 0.0;
    }
    let prefix = &text[..text.len() - digits.len() + length];
    prefix
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// String(value) over plain JSON. Array null entries become empty strings;
/// objects use the ordinary Object.prototype.toString representation.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Number(value) => js_number_string(value.as_f64().unwrap_or(f64::NAN)),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    // Rust's shortest exponential rendering supplies the digits. ECMAScript
    // selects exponential notation at >=1e21 and below 1e-6, with explicit +.
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let rendered = format!("{value:e}");
        let (mantissa, exponent) = rendered.split_once('e').expect("exponential rendering");
        if exponent.starts_with('-') {
            format!("{mantissa}e{exponent}")
        } else {
            format!("{mantissa}e+{exponent}")
        }
    } else {
        value.to_string()
    }
}

/// Structural source-compatible count for any JSON shape, without recursive
/// calls. This is informational only; compilation always validates separately.
pub fn count_expression_nodes(expression: &Value) -> usize {
    let mut pending = vec![expression];
    let mut count = 0;
    while let Some(value) = pending.pop() {
        let Some(object) = value.as_object() else {
            continue;
        };
        if ["role", "level", "user"]
            .iter()
            .any(|key| object.contains_key(*key))
        {
            count += 1;
        } else if let Some(child) = object.get("not") {
            count += 1;
            pending.push(child);
        } else if object.contains_key("and") || object.contains_key("or") {
            count += 1;
            if let Some(children) = object
                .get("and")
                .filter(|v| !v.is_null())
                .or_else(|| object.get("or"))
                .and_then(Value::as_array)
            {
                pending.extend(children);
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> Value {
        json!({ "user": { "id": id, "login": "Display_Name" } })
    }

    fn identity(tags: &[RoleTag], id: Option<&str>) -> UserIdentity {
        UserIdentity::new(7.0, tags.iter().copied(), id.map(str::to_owned), None)
    }

    fn decision(expression: &Value, identity: &UserIdentity) -> PermissionDecision {
        CompiledPermission::compile(Some(expression), None).decide(identity)
    }

    #[test]
    fn identity_constructor_preserves_trusted_level_and_set_order() {
        let user = UserIdentity::new(
            -2.5,
            [RoleTag::Mod, RoleTag::Sub, RoleTag::Mod],
            Some("trusted-id".into()),
            Some("Some_LOGIN".into()),
        );
        assert_eq!(user.level(), -2.5);
        assert_eq!(
            user.tags(),
            &[RoleTag::Mod, RoleTag::Sub, RoleTag::Everyone]
        );
        assert_eq!(user.user_id(), Some("trusted-id"));
        assert_eq!(user.login(), Some("some_login"));
        assert_eq!(
            user.serialize(),
            json!({
                "level": -2.5, "tags": ["mod", "sub", "everyone"],
                "userId": "trusted-id", "login": "some_login"
            })
        );
        let with_everyone_first = UserIdentity::new(
            f64::NAN,
            [RoleTag::Everyone, RoleTag::Vip],
            Some(String::new()),
            Some(String::new()),
        );
        assert!(with_everyone_first.level().is_nan());
        assert_eq!(
            with_everyone_first.serialize(),
            json!({ "level": null, "tags": ["everyone", "vip"] })
        );
    }

    #[test]
    fn snapshot_parser_clamps_only_a_finite_level_field() {
        let user = parse_user_identity(
            Some(&json!({
                "level": 12.9, "tags": ["sub", "unknown", "everyone", "sub", "broadcaster", 7],
                "userId": "00042", "login": "Mixed_CASE"
            })),
            -8.5,
        );
        assert_eq!(user.level(), 10.0);
        assert_eq!(
            user.tags(),
            &[RoleTag::Sub, RoleTag::Everyone, RoleTag::Broadcaster]
        );
        assert_eq!(user.user_id(), Some("00042"));
        assert_eq!(user.login(), Some("mixed_case"));
        // The parser is a trusted snapshot decoder, not role authentication.
        assert!(user.has_tag(RoleTag::Broadcaster));
        assert_eq!(
            parse_user_identity(Some(&json!({ "level": -3.9 })), 8.0).level(),
            1.0
        );
        assert_eq!(
            parse_user_identity(Some(&json!({ "level": 7.9 })), 8.0).level(),
            7.0
        );
        for raw in [
            json!(null),
            json!(false),
            json!([]),
            json!({ "level": "10" }),
        ] {
            assert_eq!(parse_user_identity(Some(&raw), -8.5).level(), -8.5);
        }
        let malformed = parse_user_identity(
            Some(&json!({
                "userId": "42x", "login": "invalid-login", "tags": "mod"
            })),
            1.0,
        );
        assert_eq!(malformed, create_default_identity());
        assert_eq!(parse_user_identity(None, 3.0).level(), 3.0);
    }

    #[test]
    fn badge_derivation_preserves_source_order_and_nullish_fallback() {
        let badges = json!([
            { "set_id": "founder" }, { "id": "vip" }, { "set_id": "subscriber" },
            { "set_id": "lead_moderator" }, { "set_id": null, "id": "moderator" },
            { "set_id": "", "id": "vip" }, null, "moderator"
        ]);
        assert_eq!(derive_badge_level(&badges), 7.0);
        assert_eq!(
            derive_badge_tags(&badges),
            vec![RoleTag::Founder, RoleTag::Sub, RoleTag::Vip, RoleTag::Mod]
        );
        assert_eq!(
            derive_badge_tags(&json!([{ "set_id": "", "id": "vip" }])),
            vec![]
        );
        assert_eq!(derive_badge_level(&json!({ "set_id": "moderator" })), 1.0);
        assert_eq!(derive_badge_tags(&Value::Null), vec![]);
    }

    #[test]
    fn validated_expressions_sanitize_without_changing_structure() {
        let input = json!({ "and": [account("42"), { "not": { "role": "everyone" } }] });
        let validated = validate_expression(&input).unwrap();
        assert_eq!(validated.node_count(), 4);
        assert_eq!(
            validated.to_value(),
            json!({
                "and": [{ "user": { "id": "42", "login": "display_name" } }, { "not": { "role": "everyone" } }]
            })
        );
        assert!(!validated.evaluate(&identity(&[], Some("42"))));
        // Access plans recognize this shape and let named accounts override
        // everyone; evaluate() intentionally retains general Boolean logic.
        assert_eq!(
            decision(&input, &identity(&[], Some("42"))).reason,
            PermissionReason::FlatAccountAllow
        );
    }

    #[test]
    fn validation_errors_have_source_messages_codes_and_field_paths() {
        let cases = [
            (
                json!(null),
                ValidationErrorCode::NodeMustBeObject,
                "$",
                "expression node must be an object",
            ),
            (
                json!({ "other": 1 }),
                ValidationErrorCode::MissingOperator,
                "$",
                "expression node is empty or has no recognized operator",
            ),
            (
                json!({ "role": "bogus" }),
                ValidationErrorCode::UnknownRole,
                "$.role",
                "unknown role tag: bogus",
            ),
            (
                json!({ "level": 1.5 }),
                ValidationErrorCode::InvalidLevel,
                "$.level",
                "level must be an integer between 1 and 10, got: 1.5",
            ),
            (
                json!({ "and": [] }),
                ValidationErrorCode::InvalidGroup,
                "$.and",
                "and group must be an array with at least one child",
            ),
            (
                json!({ "user": { "id": "42" } }),
                ValidationErrorCode::InvalidUserShape,
                "$.user",
                "user must contain exactly id and login",
            ),
            (
                json!({ "user": { "id": "x", "login": "ok" } }),
                ValidationErrorCode::InvalidUserId,
                "$.user.id",
                "user id must be a Twitch account ID",
            ),
            (
                json!({ "user": { "id": "42", "login": "bad-login" } }),
                ValidationErrorCode::InvalidUserLogin,
                "$.user.login",
                "user login must be a Twitch login",
            ),
        ];
        for (input, code, path, message) in cases {
            let error = validate_expression(&input).unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.path, path);
            assert_eq!(error.message, message);
        }
        assert_eq!(
            validate_expression(&json!({ "role": "mod", "other": true }))
                .unwrap_err()
                .code,
            ValidationErrorCode::UnknownFields
        );
        assert_eq!(
            validate_expression(&json!({ "role": "mod", "level": 7 }))
                .unwrap_err()
                .code,
            ValidationErrorCode::MultipleOperators
        );
        assert_eq!(
            validate_expression(&json!({ "or": [{ "not": { "role": "MOD" } }] }))
                .unwrap_err()
                .path,
            "$.or[0].not.role"
        );
    }

    #[test]
    fn root_depth_and_node_limits_match_source_boundaries() {
        let mut deep = json!({ "role": "mod" });
        for _ in 0..3 {
            deep = json!({ "not": deep });
        }
        assert!(validate_expression(&deep).is_ok());
        deep = json!({ "not": deep });
        let error = validate_expression(&deep).unwrap_err();
        assert_eq!(error.code, ValidationErrorCode::MaximumDepth);
        assert_eq!(error.path, "$.not.not.not.not");
        let leaves = vec![json!({ "role": "everyone" }); 24];
        let at_limit = json!({ "or": leaves });
        assert_eq!(
            validate_expression(&at_limit).unwrap().node_count(),
            MAX_EXPRESSION_NODES
        );
        let over_limit = json!({ "or": vec![json!({ "role": "everyone" }); 25] });
        let error = validate_expression(&over_limit).unwrap_err();
        assert_eq!(error.code, ValidationErrorCode::MaximumNodes);
        assert_eq!(error.path, "$.or[24]");
        assert!(!decision(&over_limit, &create_broadcaster_identity()).allowed);
    }

    #[test]
    fn account_then_role_then_default_precedence_is_explicit() {
        use PermissionReason as Reason;
        let expression = json!({ "and": [
            { "or": [account("42"), { "role": "mod" }, { "role": "everyone" }] },
            { "not": { "or": [account("99"), { "role": "sub" }, { "role": "everyone" }] } }
        ] });
        for (tags, id, expected, reason) in [
            (vec![RoleTag::Mod], "99", false, Reason::FlatAccountExclude),
            (vec![RoleTag::Sub], "42", true, Reason::FlatAccountAllow),
            (
                vec![RoleTag::Sub, RoleTag::Mod],
                "17",
                false,
                Reason::FlatRoleExclude,
            ),
            (vec![RoleTag::Mod], "17", true, Reason::FlatRoleAllow),
            (vec![], "17", true, Reason::FlatDefaultAllow),
        ] {
            let result = decision(&expression, &identity(&tags, Some(id)));
            assert_eq!(result.allowed, expected);
            assert_eq!(result.reason, reason);
        }
        let both_account_lists = json!({ "and": [account("42"), { "not": account("42") }] });
        assert_eq!(
            decision(&both_account_lists, &identity(&[], Some("42"))).reason,
            Reason::FlatAccountExclude
        );
        let exclude_only = json!({ "not": { "role": "mod" } });
        assert_eq!(
            decision(&exclude_only, &identity(&[], None)).reason,
            Reason::FlatDefaultAllow
        );
        assert_eq!(
            decision(&json!({ "role": "mod" }), &identity(&[], None)).reason,
            Reason::FlatDefaultDeny
        );
        assert_eq!(
            decision(
                &json!({ "not": { "role": "everyone" } }),
                &identity(&[], None)
            )
            .reason,
            Reason::FlatDefaultDeny
        );
    }

    #[test]
    fn flat_recognition_keeps_exact_shape_and_operand_order() {
        let user = identity(&[RoleTag::Mod], None);
        let flat = json!({ "and": [{ "role": "mod" }, { "not": { "role": "everyone" } }] });
        assert_eq!(
            decision(&flat, &user).reason,
            PermissionReason::FlatRoleAllow
        );
        let reversed = json!({ "and": [{ "not": { "role": "everyone" } }, { "role": "mod" }] });
        assert_eq!(
            decision(&reversed, &user).reason,
            PermissionReason::ExpressionFalse
        );
        let nested = json!({ "and": [{ "or": [{ "or": [{ "role": "mod" }] }] }, { "not": { "role": "everyone" } }] });
        assert_eq!(
            decision(&nested, &user).reason,
            PermissionReason::ExpressionFalse
        );
        let level = json!({ "or": [{ "role": "sub" }, { "level": 7 }] });
        assert_eq!(
            decision(&level, &user).reason,
            PermissionReason::ExpressionTrue
        );
    }

    #[test]
    fn unresolved_accounts_remain_unknown_through_not_and_boolean_groups() {
        let user = identity(&[RoleTag::Mod], None);
        let unknown = json!({ "not": account("42") });
        assert_eq!(
            decision(&unknown, &user).reason,
            PermissionReason::ExpressionUnknown
        );
        assert_eq!(
            validate_expression(&unknown).unwrap().evaluate_truth(&user),
            Truth::Unknown
        );
        let double_not = json!({ "not": { "not": account("42") } });
        assert!(!validate_expression(&double_not).unwrap().evaluate(&user));
        let decisive_or = json!({ "or": [account("42"), { "role": "mod" }] });
        assert!(validate_expression(&decisive_or).unwrap().evaluate(&user));
        let decisive_and = json!({ "and": [account("42"), { "role": "sub" }] });
        assert_eq!(
            decision(&decisive_and, &user).reason,
            PermissionReason::ExpressionFalse
        );
        // Unknown exclusions force general evaluation before any flat role
        // override. Conversely, unresolved account allows do not stop roles.
        let unknown_exclusion = json!({ "and": [{ "role": "mod" }, { "not": account("42") }] });
        assert_eq!(
            decision(&unknown_exclusion, &user).reason,
            PermissionReason::ExpressionUnknown
        );
        assert_eq!(
            decision(&decisive_or, &user).reason,
            PermissionReason::FlatRoleAllow
        );
    }

    #[test]
    fn broadcaster_override_requires_valid_tag_mode() {
        let broadcaster = create_broadcaster_identity();
        let invalid =
            CompiledPermission::compile(Some(&json!({ "role": "invalid" })), Some(&json!(0)));
        assert_eq!(
            invalid.decide(&broadcaster),
            PermissionDecision {
                allowed: false,
                mode: PermissionMode::Invalid,
                reason: PermissionReason::InvalidConfig,
            }
        );
        assert!(invalid.validation_error().is_some());
        assert_eq!(
            decision(&json!({ "not": { "role": "everyone" } }), &broadcaster).reason,
            PermissionReason::BroadcasterOverride
        );
        assert_eq!(
            CompiledPermission::compile(None, Some(&json!(11)))
                .decide(&broadcaster)
                .reason,
            PermissionReason::LegacyLevelFail
        );
    }

    #[test]
    fn compiled_policy_owns_input_and_reuses_immutable_plan() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<CompiledPermission>();
        let mut raw = json!({ "role": "mod" });
        let policy = CompiledPermission::compile(Some(&raw), None);
        raw["role"] = json!("sub");
        let mod_user = identity(&[RoleTag::Mod], None);
        let sub_user = identity(&[RoleTag::Sub], None);
        for _ in 0..20 {
            assert!(policy.allowed(&mod_user));
            assert!(!policy.allowed(&sub_user));
        }
        assert!(!CompiledPermission::compile(Some(&raw), None).allowed(&mod_user));
        let mut legacy = json!(7.5);
        let policy = CompiledPermission::compile(None, Some(&legacy));
        legacy = json!(1);
        assert!(!policy.allowed(&mod_user));
        assert!(CompiledPermission::compile(None, Some(&legacy)).allowed(&mod_user));
    }

    #[test]
    fn legacy_coercion_uses_parse_int_after_json_string_conversion() {
        let cases = [
            (json!(7.5), 7.5),
            (json!(-2.75), -2.75),
            (json!("7.9more"), 7.0),
            (json!(" -2.7"), -2.0),
            (json!("\u{feff}\u{2028}+8suffix"), 8.0),
            (json!("\u{85}8"), 0.0),
            (json!("0x10"), 0.0),
            (json!("9e2"), 9.0),
            (json!(true), 0.0),
            (json!(false), 0.0),
            (json!(null), 0.0),
            (json!({}), 0.0),
            (json!([]), 0.0),
            (json!([null, 9]), 0.0),
            (json!([[" 7.8"], 9]), 7.0),
            (json!([8, 9]), 8.0),
            (json!([1e21]), 1.0),
            (json!([-2e21]), -2.0),
            (json!([1e20]), 1e20),
            (json!([2e-7]), 2.0),
            (json!([1e-6]), 0.0),
            (json!("9".repeat(400)), 0.0),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_legacy_level(Some(&input)), expected, "{input}");
        }
        assert_eq!(parse_legacy_level(None), 0.0);
        assert!(parse_legacy_level(Some(&json!("-0tail"))).is_sign_negative());
        assert!(!parse_legacy_level(Some(&json!([-0.0]))).is_sign_negative());
    }

    #[test]
    fn raw_wrappers_distinguish_missing_invalid_and_legacy_configuration() {
        let user = create_default_identity();
        assert_eq!(
            command_decision(None, &user).reason,
            PermissionReason::MissingConfig
        );
        assert_eq!(
            rule_exemption_decision(Some(&Value::Null), &user).mode,
            PermissionMode::Missing
        );
        assert!(!command_allowed(None, &create_broadcaster_identity()));
        assert!(command_allowed(Some(&json!({})), &user));
        assert!(rule_exempt(
            Some(&json!({ "exemptExpression": null, "exemptUserLevel": "1suffix" })),
            &user
        ));
        assert!(!command_allowed(
            Some(&json!({ "permissionExpression": false, "userLevel": 0 })),
            &user
        ));
        assert!(!rule_exempt(
            Some(&json!({ "exemptExpression": {}, "exemptUserLevel": 0 })),
            &user
        ));
        assert_eq!(
            command_decision(Some(&json!({ "userLevel": 1.5 })), &user).reason,
            PermissionReason::LegacyLevelFail
        );
        assert_eq!(
            command_decision(Some(&json!({ "userLevel": -0.5 })), &user).reason,
            PermissionReason::LegacyLevelPass
        );
        assert!(matches!(inspect_expression(None), ExpressionState::Level));
        assert!(matches!(
            inspect_expression(Some(&Value::Null)),
            ExpressionState::Level
        ));
        assert!(matches!(
            inspect_expression(Some(&json!(false))),
            ExpressionState::Invalid { .. }
        ));
        assert!(matches!(
            inspect_expression(Some(&json!({ "role": "everyone" }))),
            ExpressionState::Tags { .. }
        ));
    }

    #[test]
    fn informational_counts_follow_source_operator_precedence_on_invalid_shapes() {
        assert_eq!(count_expression_nodes(&json!(null)), 0);
        assert_eq!(count_expression_nodes(&json!([])), 0);
        assert_eq!(
            count_expression_nodes(&json!({ "role": "mod", "not": { "role": "sub" } })),
            1
        );
        assert_eq!(
            count_expression_nodes(&json!({ "and": null, "or": [{ "role": "sub" }, {}] })),
            2
        );
        assert_eq!(count_expression_nodes(&json!({ "not": null })), 1);
        assert_eq!(
            count_expression_nodes(&json!({ "and": false, "or": [{ "role": "sub" }] })),
            1
        );
    }
}
