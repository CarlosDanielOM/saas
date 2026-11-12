//! The command and exemption gates (reference: `utils/permissions/index.ts`).
//!
//! Level mode and tag mode are exclusive: a missing or `null` expression means the legacy
//! level decides; a valid expression decides alone; a present invalid expression denies (no
//! exemption) and never falls back to the stored level.
//!
//! Compile once per stored configuration with [`CompiledPermission::compile`] and keep it with
//! the cached command or rule: deciding then reads no JSON and validates nothing.

use super::expression::{ExpressionState, Node, Truth, ValidationError, inspect_expression};
use super::roles::{RoleTag, UserIdentity};
use crate::value::{Js, JsView, js_string, js_truthy};

/// Which rule decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// No configuration at all (`if (!command) return false`).
    Missing,
    /// The legacy numeric level.
    Level,
    /// A valid tag expression.
    Tags,
    /// A present invalid expression (denies).
    Invalid,
}

impl PermissionMode {
    /// The reference's mode name (`missing` has none there).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Level => "level",
            Self::Tags => "tags",
            Self::Invalid => "invalid",
        }
    }
}

/// The step that decided, for logs and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionReason {
    /// No configuration.
    MissingConfig,
    /// The stored expression is invalid.
    InvalidConfig,
    /// The broadcaster passes every valid expression.
    BroadcasterOverride,
    /// Flat form: the account is excluded by id.
    FlatAccountExclude,
    /// Flat form: the account is allowed by id.
    FlatAccountAllow,
    /// Flat form: a specific excluded role matched.
    FlatRoleExclude,
    /// Flat form: a specific allowed role matched.
    FlatRoleAllow,
    /// Flat form: allowed by default (Everyone allowed, or nothing allowed).
    FlatDefaultAllow,
    /// Flat form: denied by default.
    FlatDefaultDeny,
    /// Boolean evaluation: true.
    ExpressionTrue,
    /// Boolean evaluation: false.
    ExpressionFalse,
    /// Boolean evaluation: unknown (denied).
    ExpressionUnknown,
    /// Legacy level reached.
    LegacyLevelPass,
    /// Legacy level not reached.
    LegacyLevelFail,
}

/// A decision and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionDecision {
    /// Whether the chatter may run the command (or is exempt from the rule).
    pub allowed: bool,
    /// The mode that applied.
    pub mode: PermissionMode,
    /// The step that decided.
    pub reason: PermissionReason,
}

impl PermissionDecision {
    const fn new(allowed: bool, mode: PermissionMode, reason: PermissionReason) -> Self {
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

/// The dashboard's flat form: `leaf`, `or(leaves)`, `not(leaves)` or `and(leaves, not(leaves))`
/// where every leaf is a role or an account.
#[derive(Debug, Clone)]
struct FlatPlan {
    allowed: Vec<FlatLeaf>,
    excluded: Vec<FlatLeaf>,
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

impl FlatPlan {
    /// The exact shapes and operand order of the reference only: Boolean structure is never
    /// simplified (swapping `and` operands can change the meaning).
    fn from_node(node: &Node) -> Option<Self> {
        let (allowed, excluded) = match node {
            Node::And(children) => match children.as_slice() {
                [allow, Node::Not(exclude)] => (flat_leaves(allow)?, flat_leaves(exclude)?),
                _ => return None,
            },
            Node::Not(exclude) => (Vec::new(), flat_leaves(exclude)?),
            _ => (flat_leaves(node)?, Vec::new()),
        };
        Some(Self { allowed, excluded })
    }

    /// Accounts beat roles, specific roles beat Everyone, exclusions beat allows at each step.
    /// `None` hands over to Boolean evaluation (an unknown account against a named exclusion).
    fn decide(&self, identity: &UserIdentity) -> Option<PermissionDecision> {
        use PermissionReason as Reason;
        let user_id = identity.user_id();
        if user_id.is_none()
            && self
                .excluded
                .iter()
                .any(|leaf| matches!(leaf, FlatLeaf::User(_)))
        {
            return None;
        }
        let account =
            |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::User(id) if Some(id.as_str()) == user_id);
        let specific_role = |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::Role(role) if *role != RoleTag::Everyone && identity.has_tag(*role));
        let everyone = |leaf: &FlatLeaf| matches!(leaf, FlatLeaf::Role(RoleTag::Everyone));
        let (allowed, reason) = if self.excluded.iter().any(account) {
            (false, Reason::FlatAccountExclude)
        } else if self.allowed.iter().any(account) {
            (true, Reason::FlatAccountAllow)
        } else if self.excluded.iter().any(specific_role) {
            (false, Reason::FlatRoleExclude)
        } else if self.allowed.iter().any(specific_role) {
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
enum Plan {
    Level(f64),
    Invalid(ValidationError),
    Tags { root: Node, flat: Option<FlatPlan> },
}

/// A command's or a moderation rule's permission configuration, validated once.
///
/// Immutable and owned (`Send + Sync`): cache it with the configuration it came from.
#[derive(Debug, Clone)]
pub struct CompiledPermission {
    plan: Plan,
}

impl CompiledPermission {
    /// From the stored expression (`permissionExpression` / `exemptExpression`) and the stored
    /// level (`userLevel` / `exemptUserLevel`). `None` is a missing field.
    pub fn compile<E: JsView, L: JsView>(expression: Option<&E>, legacy_level: Option<&L>) -> Self {
        Self::from_state(
            inspect_expression(expression),
            parse_legacy_level(legacy_level),
        )
    }

    /// From an already inspected expression and a level read with [`parse_legacy_level`].
    pub fn from_state(state: ExpressionState, legacy_level: f64) -> Self {
        let plan = match state {
            ExpressionState::Level => Plan::Level(legacy_level),
            ExpressionState::Invalid(error) => Plan::Invalid(error),
            ExpressionState::Tags(expression) => {
                let flat = FlatPlan::from_node(&expression.root);
                Plan::Tags {
                    root: expression.root,
                    flat,
                }
            }
        };
        Self { plan }
    }

    /// The mode the configuration selects.
    pub fn mode(&self) -> PermissionMode {
        match &self.plan {
            Plan::Level(_) => PermissionMode::Level,
            Plan::Invalid(_) => PermissionMode::Invalid,
            Plan::Tags { .. } => PermissionMode::Tags,
        }
    }

    /// The validation error of an invalid stored expression (for the configuration-error log).
    pub fn validation_error(&self) -> Option<&ValidationError> {
        match &self.plan {
            Plan::Invalid(error) => Some(error),
            _ => None,
        }
    }

    /// The decision for one chatter.
    pub fn decide(&self, identity: &UserIdentity) -> PermissionDecision {
        use PermissionReason as Reason;
        match &self.plan {
            Plan::Invalid(_) => {
                PermissionDecision::new(false, PermissionMode::Invalid, Reason::InvalidConfig)
            }
            Plan::Level(level) => {
                let allowed = identity.level() >= *level;
                let reason = if allowed {
                    Reason::LegacyLevelPass
                } else {
                    Reason::LegacyLevelFail
                };
                PermissionDecision::new(allowed, PermissionMode::Level, reason)
            }
            Plan::Tags { root, flat } => {
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
                let (allowed, reason) = match root.truth(identity) {
                    Truth::True => (true, Reason::ExpressionTrue),
                    Truth::False => (false, Reason::ExpressionFalse),
                    Truth::Unknown => (false, Reason::ExpressionUnknown),
                };
                PermissionDecision::new(allowed, PermissionMode::Tags, reason)
            }
        }
    }

    /// Whether the chatter passes.
    pub fn allowed(&self, identity: &UserIdentity) -> bool {
        self.decide(identity).allowed
    }
}

/// `parseLegacyLevel`: a finite number as it is; anything else through
/// `Number.parseInt(String(value ?? 0), 10)`, and 0 when that is not finite.
pub fn parse_legacy_level<V: JsView>(value: Option<&V>) -> f64 {
    let text = match value.map(JsView::js) {
        None | Some(Js::Null | Js::Undefined) => return 0.0,
        Some(Js::Number(number)) if number.is_finite() => return number,
        Some(_) => value.map(js_string).unwrap_or_default(),
    };
    let parsed = dima_text::parse_int(&text, dima_text::Radix::Decimal);
    if parsed.is_finite() { parsed } else { 0.0 }
}

fn config_decision<V: JsView>(
    config: Option<&V>,
    expression_key: &str,
    level_key: &str,
    identity: &UserIdentity,
) -> PermissionDecision {
    match config.filter(|config| js_truthy(*config)) {
        None => PermissionDecision::new(
            false,
            PermissionMode::Missing,
            PermissionReason::MissingConfig,
        ),
        Some(config) => {
            CompiledPermission::compile(config.get(expression_key), config.get(level_key))
                .decide(identity)
        }
    }
}

/// `commandAllowed` on an untyped command object, compiling on every call. For the chat path
/// compile once with [`CompiledPermission::compile`] instead.
pub fn command_decision<V: JsView>(
    command: Option<&V>,
    identity: &UserIdentity,
) -> PermissionDecision {
    config_decision(command, "permissionExpression", "userLevel", identity)
}

/// `commandAllowed`.
pub fn command_allowed<V: JsView>(command: Option<&V>, identity: &UserIdentity) -> bool {
    command_decision(command, identity).allowed
}

/// `ruleExempt` on an untyped rule object, compiling on every call.
pub fn rule_exemption_decision<V: JsView>(
    rule: Option<&V>,
    identity: &UserIdentity,
) -> PermissionDecision {
    config_decision(rule, "exemptExpression", "exemptUserLevel", identity)
}

/// `ruleExempt`.
pub fn rule_exempt<V: JsView>(rule: Option<&V>, identity: &UserIdentity) -> bool {
    rule_exemption_decision(rule, identity).allowed
}
