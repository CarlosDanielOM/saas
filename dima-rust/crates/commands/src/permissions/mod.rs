//! Tag permission system (reference: `utils/permissions/*` and
//! `middleware/channel_permissions.ts`; `TAG_PERMISSION_SYSTEM.md`).
//!
//! - [`roles`]: role tags, [`UserIdentity`], badge derivation, identity snapshots.
//! - [`role_cache`]: Dragonfly role sets and [`resolve_user_identity`], behind [`RoleCache`].
//! - [`expression`]: validation and Boolean evaluation of stored trees.
//! - [`access`]: [`CompiledPermission`], the only approved command and exemption gate.
//! - [`channel`]: channel-admin permission lists.
//!
//! Text: role tags, account ids and logins are ASCII by rule (their validators refuse anything
//! else); logins are lowercased with JavaScript's full mapping ([`dima_text::to_lower`]), as
//! `createUserIdentity` does. No length here counts text the JavaScript way.

pub mod access;
pub mod channel;
mod error_limit;
pub mod expression;
pub mod role_cache;
pub mod roles;

pub use access::{
    CompiledPermission, PermissionDecision, PermissionMode, PermissionReason, command_allowed,
    command_decision, parse_legacy_level, rule_exempt, rule_exemption_decision,
};
pub use channel::{
    CHANNEL_ADMIN_PERMISSIONS, CHANNEL_WEBSITE_ACCESS_PERMISSIONS, grants_chat_admin_role,
    grants_chat_admin_role_js, parse_channel_admin_permissions,
};
pub use error_limit::{
    DEFAULT_PERMISSION_ERROR_INTERVAL_MS, MAX_TRACKED_PERMISSION_ERRORS, PermissionErrorLimiter,
};
pub use expression::{
    ExpressionState, MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_NODES, Truth, ValidatedExpression,
    ValidationError, ValidationErrorCode, count_expression_nodes, inspect_expression,
    validate_expression,
};
pub use role_cache::{
    AdminEntry, ChatAuthor, EditorEntry, ROLE_CACHE_TTL_SECONDS, Resolved, RoleCache,
    add_admin_to_role_cache, admin_detail_key, admins_ids_key, admins_key,
    clear_channel_role_cache, editors_ids_key, editors_key, is_editor_login_cached,
    legacy_editors_key, populate_admin_cache, refresh_editor_cache, remove_admin_from_role_cache,
    resolve_user_identity,
};
pub use roles::{
    BROADCASTER_USER_LEVEL, LEGACY_USER_LEVEL_NAMES, MODERATOR_BADGE_IDS, ROLE_TAGS, RoleTag,
    UserIdentity, badge_level_of, badge_tags_of, create_broadcaster_identity,
    create_default_identity, derive_badge_level, derive_badge_tags, parse_user_identity,
};
