//! Native equivalents of the exported TypeScript types in
//! `dimabot/src/middleware/admin.middleware.ts`.
//!
//! The TypeScript module exports `AdminRole`, `GlobalAdminRole`,
//! `ChannelAccessContext` and `ChannelAccessDecisions` as type-only values, so
//! nothing here is migrated runtime behavior by itself. [`AdminRole`] is reused
//! from the native `schemas::admin` model rather than duplicated as a second
//! string enum, and [`GlobalAdminRole`] is the native form of
//! `Extract<AdminRole, 'creator' | 'super'>`.
//!
//! [`GlobalAdminContext`] replaces the two ad-hoc `req` mutations
//! (`globalAdminRole` and `isSuperAdmin`) with one typed Axum request
//! extension. It is inserted only when the source sets those two properties,
//! that is for the `creator` and `super` roles; a `support`, `billing`,
//! `channel` or unknown role leaves the extension absent, so
//! [`global_admin_role`] and [`is_super_admin`] report the same "unset" outcome
//! the Express request exposes as `undefined`.

use axum::http::Extensions;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::schemas::admin::AdminRole;

/// Value of the `type` field when no authenticated identity is attached.
pub const ERROR_TYPE_AUTHENTICATION_REQUIRED: &str = "authentication_required";
/// Value of the `type` field when the account has no active Admin row.
pub const ERROR_TYPE_ADMIN_REQUIRED: &str = "admin_required";
/// Value of the `type` field for the outer unexpected-failure branch.
pub const ERROR_TYPE_INTERNAL_ERROR: &str = "internal_error";

/// The two roles that grant global administrative authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlobalAdminRole {
    Creator,
    Super,
}

impl GlobalAdminRole {
    /// Both global roles, in the source's precedence order.
    pub const ALL: [Self; 2] = [Self::Creator, Self::Super];

    /// The stored string form (`creator` or `super`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Creator => "creator",
            Self::Super => "super",
        }
    }

    /// `null` for the three channel-scoped roles.
    pub fn from_admin_role(role: AdminRole) -> Option<Self> {
        match role {
            AdminRole::Creator => Some(Self::Creator),
            AdminRole::Super => Some(Self::Super),
            AdminRole::Support | AdminRole::Billing | AdminRole::Channel => None,
        }
    }
}

impl std::str::FromStr for GlobalAdminRole {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|role| role.as_str() == value)
            .ok_or(())
    }
}

/// Native equivalent of the private `normalizeAdminRole` helper: any stored
/// string outside the five declared roles is `null` rather than a new variant.
pub fn normalize_admin_role(value: &str) -> Option<AdminRole> {
    value.parse::<AdminRole>().ok()
}

/// The values the admin middleware attaches for `creator` and `super`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalAdminContext {
    pub role: GlobalAdminRole,
    /// The source always sets `isSuperAdmin = true` alongside a global role.
    pub is_super_admin: bool,
}

/// Reads the global admin extension, or `None` when it was never inserted.
pub fn global_admin_context(extensions: &Extensions) -> Option<&GlobalAdminContext> {
    extensions.get::<GlobalAdminContext>()
}

/// `req.globalAdminRole` as an `Option`.
pub fn global_admin_role(extensions: &Extensions) -> Option<GlobalAdminRole> {
    global_admin_context(extensions).map(|context| context.role)
}

/// `req.isSuperAdmin === true`; `false` whenever the extension is absent.
pub fn is_super_admin(extensions: &Extensions) -> bool {
    global_admin_context(extensions).is_some_and(|context| context.is_super_admin)
}

/// `role: 'owner' | 'admin' | 'none'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelAccessRole {
    Owner,
    Admin,
    None,
}

impl ChannelAccessRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::None => "none",
        }
    }
}

/// Native `ChannelAccessContext`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelAccessContext {
    pub allowed: bool,
    pub role: ChannelAccessRole,
}

impl ChannelAccessContext {
    pub const fn owner() -> Self {
        Self {
            allowed: true,
            role: ChannelAccessRole::Owner,
        }
    }

    pub const fn admin() -> Self {
        Self {
            allowed: true,
            role: ChannelAccessRole::Admin,
        }
    }

    pub const fn none() -> Self {
        Self {
            allowed: false,
            role: ChannelAccessRole::None,
        }
    }
}

/// Native `ChannelAccessDecisions`.
///
/// `permissions` is the ordered form of the source's `Record<string, boolean>`:
/// first occurrence wins the position and duplicate requested names collapse,
/// exactly like `Object.fromEntries`. Use [`Self::to_json`] for the object form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelAccessDecisions {
    pub role: ChannelAccessRole,
    pub permissions: Vec<(String, bool)>,
}

impl ChannelAccessDecisions {
    pub fn new(role: ChannelAccessRole, permissions: Vec<(String, bool)>) -> Self {
        let mut unique: Vec<(String, bool)> = Vec::with_capacity(permissions.len());
        for (permission, allowed) in permissions {
            if unique.iter().any(|(existing, _)| existing == &permission) {
                continue;
            }
            unique.push((permission, allowed));
        }
        Self {
            role,
            permissions: unique,
        }
    }

    /// One decision per requested name with the same ordering rules.
    pub fn uniform(role: ChannelAccessRole, permissions: &[String], allowed: bool) -> Self {
        Self::new(
            role,
            permissions
                .iter()
                .map(|permission| (permission.clone(), allowed))
                .collect(),
        )
    }

    /// `Object.values(...).some(Boolean)` from the batch route.
    pub fn any_allowed(&self) -> bool {
        self.permissions.iter().any(|(_, allowed)| *allowed)
    }

    pub fn allowed(&self, permission: &str) -> Option<bool> {
        self.permissions
            .iter()
            .find(|(existing, _)| existing == permission)
            .map(|(_, allowed)| *allowed)
    }

    /// The complete source result: `{ role, permissions }`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        for (permission, allowed) in &self.permissions {
            map.insert(permission.clone(), Value::Bool(*allowed));
        }
        serde_json::json!({"role": self.role, "permissions": Value::Object(map)})
    }
}

impl Serialize for ChannelAccessDecisions {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// The admin middleware's JSON error body: `{ error, message, status, type }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminErrorBody {
    pub error: bool,
    pub message: String,
    pub status: u16,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl AdminErrorBody {
    fn new(message: impl Into<String>, status: u16, kind: &str) -> Self {
        Self {
            error: true,
            message: message.into(),
            status,
            r#type: kind.into(),
        }
    }

    /// No identity in the request extensions, or an empty identity id.
    pub fn authentication_required() -> Self {
        Self::new(
            "Authentication required",
            401,
            ERROR_TYPE_AUTHENTICATION_REQUIRED,
        )
    }

    /// The identity has no active `admins` row.
    pub fn admin_required() -> Self {
        Self::new("Admin privileges required", 403, ERROR_TYPE_ADMIN_REQUIRED)
    }

    /// The outer unexpected-failure branch.
    pub fn internal_error() -> Self {
        Self::new("Internal server error", 500, ERROR_TYPE_INTERNAL_ERROR)
    }
}
