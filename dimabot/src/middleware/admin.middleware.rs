//! Working native port of `dimabot/src/middleware/admin.middleware.ts`.
//!
//! [`admin_middleware`] is an Axum middleware with the source's two gates and
//! one side effect:
//!
//! 1. an authenticated identity is required, otherwise the exact
//!    `401 authentication_required` body;
//! 2. an **active** `admins` row for that account is required, otherwise the
//!    exact `403 admin_required` body — the creator is deliberately *not*
//!    exempted here, matching the source;
//! 3. when the row's role is `creator` or `super`, the request carries the
//!    global-role extension ([`GlobalAdminContext`]); every other role passes
//!    through without it, and the handler runs exactly once.
//!
//! Database and logger boundaries are concrete: a native MongoDB `admins`
//! [`Collection`] from `schemas::admin` and the shared native [`Logger`]. No
//! connection, index or environment read happens at construction.
//! [`AdminService::from_runtime`] is the explicit convenience constructor that
//! reuses the existing native MongoDB helper.
//!
//! The exported helpers keep the source's declarative permission rules:
//! `'*'` always participates, `triggers:*` also honours the legacy
//! `triggers:all` grant, `dimafx:*` honours `dimafx:all`, duplicates collapse
//! with first-occurrence ordering, and the batch variant
//! ([`get_channel_access_decisions`]) resolves many permissions for one channel
//! with a single Admin query.
//!
//! Deliberate boundaries: the source's unconditional `console.log` diagnostic
//! is not reproduced (the native logger and observability replace it); a
//! JavaScript `Error.stack` string has no native equivalent and is omitted from
//! the failure payload; an unknown or missing stored role is "no global role"
//! exactly as `normalizeAdminRole` reports `null`; non-string entries in a
//! stored `permissions` array are ignored instead of being compared as
//! JavaScript values.

#[path = "admin_types.rs"]
pub mod admin_types;

use crate::{
    api_auth::AuthRequest,
    utils::{
        js_compat,
        logger::{Destination, Level, LogOptions, Logger},
    },
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::{
    Collection,
    bson::{Bson, Document, doc},
};
use serde_json::{Map, Value};
use std::{future::Future, panic::AssertUnwindSafe, sync::Arc};

pub use crate::schemas::admin::AdminRole;
pub use admin_types::{
    AdminErrorBody, ChannelAccessContext, ChannelAccessDecisions, ChannelAccessRole,
    ERROR_TYPE_ADMIN_REQUIRED, ERROR_TYPE_AUTHENTICATION_REQUIRED, ERROR_TYPE_INTERNAL_ERROR,
    GlobalAdminContext, GlobalAdminRole, global_admin_context, global_admin_role, is_super_admin,
    normalize_admin_role,
};

/// The bot creator's Twitch user id, byte-for-byte with the source constant.
pub const CREATOR_TWITCH_USER_ID: &str = "533538623";

/// Roles that grant global authority; the source's `GLOBAL_ADMIN_ROLES`.
pub const GLOBAL_ADMIN_ROLES: [GlobalAdminRole; 2] =
    [GlobalAdminRole::Creator, GlobalAdminRole::Super];

/// Upper bound for one batch access query (`MAX_ACCESS_PERMISSIONS`).
pub const MAX_ACCESS_PERMISSIONS: usize = 20;

/// `isCreatorUser`: the creator id, or `null`/absent.
pub fn is_creator_user(user_id: Option<&str>) -> bool {
    user_id == Some(CREATOR_TWITCH_USER_ID)
}

/// `isCreatorTarget`: the creator id, or `null`/absent.
pub fn is_creator_target(target_id: Option<&str>) -> bool {
    target_id == Some(CREATOR_TWITCH_USER_ID)
}

/// Creator assignments may only be changed by the creator or by the owner of
/// the target channel. `None == None` mirrors `undefined === undefined` in the
/// source comparison.
pub fn can_modify_creator_admin_assignment(
    requester_id: Option<&str>,
    channel_id: Option<&str>,
    target_admin_id: Option<&str>,
) -> bool {
    if !is_creator_target(target_admin_id) {
        return true;
    }
    is_creator_user(requester_id) || requester_id == channel_id
}

/// Candidate grant names for one requested permission.
///
/// `'*'` is always checked first, then the request itself, then the legacy
/// module-wide grant for `triggers:` and `dimafx:` names. Insertion order is
/// preserved and duplicates are removed, matching the source's `Set` spread.
pub fn expand_channel_permission_checks(permission: &[String]) -> Vec<String> {
    let mut expanded: Vec<String> = Vec::with_capacity(permission.len() + 3);
    expanded.push("*".to_owned());
    let mut has_triggers = false;
    let mut has_dimafx = false;
    for value in permission {
        has_triggers |= value.starts_with("triggers:");
        has_dimafx |= value.starts_with("dimafx:");
        if !expanded.iter().any(|existing| existing == value) {
            expanded.push(value.clone());
        }
    }
    if has_triggers && !expanded.iter().any(|existing| existing == "triggers:all") {
        expanded.push("triggers:all".to_owned());
    }
    if has_dimafx && !expanded.iter().any(|existing| existing == "dimafx:all") {
        expanded.push("dimafx:all".to_owned());
    }
    expanded
}

/// `null` when the query has no `permissions` value; `[]` when the value is
/// present but invalid, so the caller can answer `400` instead of `404`/`null`.
pub fn parse_permission_list(raw: Option<&str>) -> Option<Vec<String>> {
    let raw = raw?;
    Some(parse_permission_texts(&[raw]))
}

/// Array form of `req.query.permissions`, produced by repeated query keys.
pub fn parse_permission_list_values(raw: Option<&[String]>) -> Option<Vec<String>> {
    let raw = raw?;
    let values: Vec<&str> = raw.iter().map(String::as_str).collect();
    Some(parse_permission_texts(&values))
}

/// Reads `permissions` from a flat `(key, value)` query list.
///
/// This is the native input adapter for `req.query.permissions`: a single key
/// yields the string form, repeated keys yield the array form. A nested query
/// object has no supported native equivalent and is treated as absent.
pub fn parse_permission_query(pairs: &[(&str, &str)]) -> Option<Vec<String>> {
    let values: Vec<&str> = pairs
        .iter()
        .filter(|(key, _)| *key == "permissions")
        .map(|(_, value)| *value)
        .collect();
    if values.is_empty() {
        return None;
    }
    Some(parse_permission_texts(&values))
}

fn parse_permission_texts(values: &[&str]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for value in values {
        for part in value.split(',') {
            let part = js_compat::trim(part);
            if part.is_empty() || unique.iter().any(|existing| existing == part) {
                continue;
            }
            unique.push(part.to_owned());
        }
    }
    if unique.is_empty()
        || unique.len() > MAX_ACCESS_PERMISSIONS
        || !unique.iter().all(|value| valid_permission_name(value))
    {
        return Vec::new();
    }
    unique
}

/// Native form of `PERMISSION_NAME_PATTERN = /^[a-z0-9_*:-]{1,64}$/i`.
fn valid_permission_name(value: &str) -> bool {
    let length = value.chars().count();
    (1..=64).contains(&length)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '*' | ':' | '-'))
}

/// Which requested permissions a granted list covers, in requested order.
///
/// The result is the ordered form of the source's `Record<string, boolean>`;
/// duplicate requested names keep their first position, like
/// `Object.fromEntries`.
pub fn resolve_granted_permissions(
    granted: &[String],
    requested: &[String],
) -> Vec<(String, bool)> {
    let mut resolved: Vec<(String, bool)> = Vec::with_capacity(requested.len());
    for permission in requested {
        if resolved.iter().any(|(existing, _)| existing == permission) {
            continue;
        }
        let allowed = expand_channel_permission_checks(std::slice::from_ref(permission))
            .iter()
            .any(|candidate| granted.iter().any(|entry| entry == candidate));
        resolved.push((permission.clone(), allowed));
    }
    resolved
}

fn admin_role(document: &Document) -> Option<AdminRole> {
    document.get_str("role").ok().and_then(normalize_admin_role)
}

fn role_filter() -> Bson {
    Bson::Array(
        GLOBAL_ADMIN_ROLES
            .iter()
            .map(|role| Bson::String(role.as_str().to_owned()))
            .collect(),
    )
}

fn permission_filter(permissions: &[String]) -> Bson {
    Bson::Array(
        permissions
            .iter()
            .map(|permission| Bson::String(permission.clone()))
            .collect(),
    )
}

/// `getGlobalAdminRole`: the creator keeps a hard fallback so a missing or
/// misconfigured row cannot lock the bot creator out; every other account needs
/// an active `creator`/`super` row, with `creator` winning over `super`.
pub async fn get_global_admin_role(
    admins: &Collection<Document>,
    user_id: Option<&str>,
) -> Result<Option<GlobalAdminRole>, mongodb::error::Error> {
    let Some(user_id) = user_id.filter(|value| !(*value).is_empty()) else {
        return Ok(None);
    };
    if is_creator_user(Some(user_id)) {
        return Ok(Some(GlobalAdminRole::Creator));
    }
    let rows: Vec<Document> = admins
        .find(doc! {
            "adminID": user_id,
            "actived": true,
            "role": { "$in": role_filter() },
        })
        .projection(doc! { "_id": 0, "role": 1 })
        .await?
        .try_collect()
        .await?;
    let mut super_found = false;
    for row in &rows {
        match admin_role(row).and_then(GlobalAdminRole::from_admin_role) {
            Some(GlobalAdminRole::Creator) => return Ok(Some(GlobalAdminRole::Creator)),
            Some(GlobalAdminRole::Super) => super_found = true,
            None => {}
        }
    }
    Ok(if super_found {
        Some(GlobalAdminRole::Super)
    } else {
        None
    })
}

/// Super admins may act as a channel owner everywhere except against the
/// creator's own channel/account; the creator itself is unrestricted.
pub async fn has_global_channel_owner_access(
    admins: &Collection<Document>,
    requester_id: Option<&str>,
    target_channel_id: Option<&str>,
) -> Result<bool, mongodb::error::Error> {
    let requester = requester_id.filter(|value| !(*value).is_empty());
    let target = target_channel_id.filter(|value| !(*value).is_empty());
    let (Some(requester), Some(target)) = (requester, target) else {
        return Ok(false);
    };
    match get_global_admin_role(admins, Some(requester)).await? {
        Some(GlobalAdminRole::Creator) => Ok(true),
        Some(GlobalAdminRole::Super) => Ok(!is_creator_target(Some(target))),
        None => Ok(false),
    }
}

/// `getChannelAccessContext`: owner when the requester is the channel, a global
/// owner, or holds one of the expanded grants on an active admin row.
pub async fn get_channel_access_context(
    admins: &Collection<Document>,
    requester_id: Option<&str>,
    target_channel_id: Option<&str>,
    permission: &[String],
) -> Result<ChannelAccessContext, mongodb::error::Error> {
    let requester = requester_id.filter(|value| !(*value).is_empty());
    let target = target_channel_id.filter(|value| !(*value).is_empty());
    let (Some(requester), Some(target)) = (requester, target) else {
        return Ok(ChannelAccessContext::none());
    };
    if requester == target {
        return Ok(ChannelAccessContext::owner());
    }
    if has_global_channel_owner_access(admins, Some(requester), Some(target)).await? {
        return Ok(ChannelAccessContext::owner());
    }
    let expanded = expand_channel_permission_checks(permission);
    let admin = admins
        .find_one(doc! {
            "channelID": target,
            "adminID": requester,
            "actived": true,
            "permissions": { "$in": permission_filter(&expanded) },
        })
        .await?;
    Ok(if admin.is_some() {
        ChannelAccessContext::admin()
    } else {
        ChannelAccessContext::none()
    })
}

/// Per-permission variant of [`get_channel_access_context`]: one Admin read
/// resolves every requested permission instead of one read per permission.
pub async fn get_channel_access_decisions(
    admins: &Collection<Document>,
    requester_id: Option<&str>,
    target_channel_id: Option<&str>,
    permissions: &[String],
) -> Result<ChannelAccessDecisions, mongodb::error::Error> {
    let requester = requester_id.filter(|value| !(*value).is_empty());
    let target = target_channel_id.filter(|value| !(*value).is_empty());
    let (Some(requester), Some(target)) = (requester, target) else {
        return Ok(ChannelAccessDecisions::uniform(
            ChannelAccessRole::None,
            permissions,
            false,
        ));
    };
    if requester == target
        || has_global_channel_owner_access(admins, Some(requester), Some(target)).await?
    {
        return Ok(ChannelAccessDecisions::uniform(
            ChannelAccessRole::Owner,
            permissions,
            true,
        ));
    }
    let rows: Vec<Document> = admins
        .find(doc! {
            "channelID": target,
            "adminID": requester,
            "actived": true,
        })
        .projection(doc! { "_id": 0, "permissions": 1 })
        .await?
        .try_collect()
        .await?;
    let mut granted: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(Bson::Array(values)) = row.get("permissions") {
            granted.extend(
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(str::to_owned),
            );
        }
    }
    let mut decisions = ChannelAccessDecisions::new(
        ChannelAccessRole::None,
        resolve_granted_permissions(&granted, permissions),
    );
    if decisions.any_allowed() {
        decisions.role = ChannelAccessRole::Admin;
    }
    Ok(decisions)
}

/// Explicit-constructor failure for the native runtime connection helper.
#[derive(Debug)]
pub enum AdminInitError {
    Mongo(mongodb::error::Error),
    MissingDatabase,
}

impl std::fmt::Display for AdminInitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mongo(error) => error.fmt(formatter),
            Self::MissingDatabase => {
                formatter.write_str("MONGO_URI must select a database for the admins collection")
            }
        }
    }
}

impl std::error::Error for AdminInitError {}

struct Inner {
    admins: Collection<Document>,
    logger: Option<Logger>,
}

/// Concrete admin-authorization service for the native API.
///
/// Cloning is cheap: clones share the MongoDB collection handle and logger.
#[derive(Clone)]
pub struct AdminService {
    inner: Arc<Inner>,
}

impl AdminService {
    /// Uses an already-created native `admins` collection. Performs no I/O.
    pub fn new(admins: Collection<Document>, logger: Option<Logger>) -> Self {
        Self {
            inner: Arc::new(Inner { admins, logger }),
        }
    }

    /// Connects with the existing native MongoDB helper and uses the
    /// `MONGO_URI` database for the native `admins` collection.
    pub async fn from_runtime(logger: Option<Logger>) -> Result<Self, AdminInitError> {
        let database = {
            let client = crate::utils::mongo::get_mongo_client()
                .await
                .map_err(AdminInitError::Mongo)?;
            client
                .default_database()
                .ok_or(AdminInitError::MissingDatabase)?
        };
        Ok(Self::new(
            crate::schemas::admin::schema().native_collection(&database),
            logger,
        ))
    }

    /// Applies [`admin_middleware`] to every route in `router`.
    ///
    /// Mount the authentication layer outside this one so the identity is
    /// already in the request extensions when this middleware runs.
    pub fn protect<S>(&self, router: Router<S>) -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        router.layer(middleware::from_fn_with_state(
            self.clone(),
            admin_middleware,
        ))
    }

    pub fn collection(&self) -> &Collection<Document> {
        &self.inner.admins
    }

    pub fn logger(&self) -> Option<&Logger> {
        self.inner.logger.as_ref()
    }

    pub async fn get_global_admin_role(
        &self,
        user_id: Option<&str>,
    ) -> Result<Option<GlobalAdminRole>, mongodb::error::Error> {
        get_global_admin_role(&self.inner.admins, user_id).await
    }

    pub async fn has_global_channel_owner_access(
        &self,
        requester_id: Option<&str>,
        target_channel_id: Option<&str>,
    ) -> Result<bool, mongodb::error::Error> {
        has_global_channel_owner_access(&self.inner.admins, requester_id, target_channel_id).await
    }

    pub async fn get_channel_access_context(
        &self,
        requester_id: Option<&str>,
        target_channel_id: Option<&str>,
        permission: &[String],
    ) -> Result<ChannelAccessContext, mongodb::error::Error> {
        get_channel_access_context(
            &self.inner.admins,
            requester_id,
            target_channel_id,
            permission,
        )
        .await
    }

    pub async fn get_channel_access_decisions(
        &self,
        requester_id: Option<&str>,
        target_channel_id: Option<&str>,
        permissions: &[String],
    ) -> Result<ChannelAccessDecisions, mongodb::error::Error> {
        get_channel_access_decisions(
            &self.inner.admins,
            requester_id,
            target_channel_id,
            permissions,
        )
        .await
    }

    async fn active_admin_row(
        &self,
        admin_id: &str,
    ) -> Result<Option<Document>, mongodb::error::Error> {
        self.inner
            .admins
            .find_one(doc! { "adminID": admin_id, "actived": true })
            .await
    }

    /// Maps the source's `try` block: a database failure is logged with
    /// `destination: 'both'` and becomes the outer `500 internal_error` body.
    // The error is the HTTP rejection itself (a normal control-flow value).
    #[allow(clippy::result_large_err)]
    async fn authorize(&self, user_id: &str) -> Result<AdminAccess, Response> {
        let admin = match self.active_admin_row(user_id).await {
            Ok(admin) => admin,
            Err(error) => {
                self.log_failure(Some(user_id), &error.to_string()).await;
                return Err(error_response(AdminErrorBody::internal_error()));
            }
        };
        let Some(admin) = admin else {
            return Ok(AdminAccess::Denied);
        };
        Ok(AdminAccess::Allowed(
            admin_role(&admin)
                .and_then(GlobalAdminRole::from_admin_role)
                .map(|role| GlobalAdminContext {
                    role,
                    is_super_admin: true,
                }),
        ))
    }

    async fn log_failure(&self, user_id: Option<&str>, message: &str) {
        let Some(logger) = self.inner.logger.as_ref() else {
            return;
        };
        let mut payload = Map::new();
        payload.insert(
            "function".to_owned(),
            Value::String("adminMiddleware".to_owned()),
        );
        if let Some(user_id) = user_id {
            payload.insert("userId".to_owned(), Value::String(user_id.to_owned()));
        }
        payload.insert("error".to_owned(), Value::String(message.to_owned()));
        let _ = logger
            .log(
                Level::Error,
                Value::Object(payload),
                LogOptions {
                    destination: Destination::Both,
                    ..Default::default()
                },
            )
            .await;
    }
}

/// The middleware's decision after the active-row read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdminAccess {
    Denied,
    Allowed(Option<GlobalAdminContext>),
}

fn error_response(body: AdminErrorBody) -> Response {
    let status = StatusCode::from_u16(body.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(body)).into_response()
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "internal error".into()
}

/// Converts an unexpected panic into the source's outer `500 internal_error`
/// response instead of aborting the connection.
#[allow(clippy::result_large_err)]
async fn guard<F>(service: &AdminService, future: F) -> Result<AdminAccess, Response>
where
    F: Future<Output = Result<AdminAccess, Response>>,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(outcome) => outcome,
        Err(payload) => {
            service.log_failure(None, &panic_message(payload)).await;
            Err(error_response(AdminErrorBody::internal_error()))
        }
    }
}

/// Axum middleware for admin-only API routes.
///
/// State is an [`AdminService`]; mount it with [`AdminService::protect`] or
/// `axum::middleware::from_fn_with_state(service, admin_middleware)`. A
/// successful request keeps its identity extension and, for `creator`/`super`,
/// gains [`GlobalAdminContext`]; the handler runs exactly once.
pub async fn admin_middleware(
    State(service): State<AdminService>,
    request: Request,
    next: Next,
) -> Response {
    // `AuthRequest::from_extensions` is the native `req.user` view written by
    // the already-ported authentication middleware.
    let user_id = AuthRequest::from_extensions(request.extensions())
        .user
        .map(|user| user.id);
    let Some(user_id) = user_id.filter(|id| !id.is_empty()) else {
        return error_response(AdminErrorBody::authentication_required());
    };
    match guard(&service, service.authorize(&user_id)).await {
        Ok(AdminAccess::Allowed(context)) => {
            let mut request = request;
            if let Some(context) = context {
                request.extensions_mut().insert(context);
            }
            next.run(request).await
        }
        Ok(AdminAccess::Denied) => error_response(AdminErrorBody::admin_required()),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn decisions_json(entries: &[(String, bool)]) -> Value {
        let mut map = Map::new();
        for (permission, allowed) in entries {
            map.insert(permission.clone(), Value::Bool(*allowed));
        }
        Value::Object(map)
    }

    #[test]
    fn creator_assignment_policy_matches_the_source() {
        // A channel owner may add or remove the creator on their own channel.
        assert!(can_modify_creator_admin_assignment(
            Some("channel-owner"),
            Some("channel-owner"),
            Some(CREATOR_TWITCH_USER_ID)
        ));
        // The creator may manage their own channel assignments.
        assert!(can_modify_creator_admin_assignment(
            Some(CREATOR_TWITCH_USER_ID),
            Some("another-channel"),
            Some(CREATOR_TWITCH_USER_ID)
        ));
        // Global admins cannot change the creator assignment for somebody else.
        assert!(!can_modify_creator_admin_assignment(
            Some("global-admin"),
            Some("channel-owner"),
            Some(CREATOR_TWITCH_USER_ID)
        ));
        // Creator protection does not restrict other admin targets.
        assert!(can_modify_creator_admin_assignment(
            Some("global-admin"),
            Some("channel-owner"),
            Some("regular-admin")
        ));
        assert!(!is_creator_target(Some("regular-admin")));
        assert!(is_creator_user(Some(CREATOR_TWITCH_USER_ID)));
        assert!(!is_creator_user(None));
    }

    #[test]
    fn specific_trigger_and_dimafx_checks_honor_legacy_module_grants() {
        assert_eq!(
            expand_channel_permission_checks(&list(&["triggers:edit"])),
            list(&["*", "triggers:edit", "triggers:all"])
        );
        assert_eq!(
            expand_channel_permission_checks(&list(&["dimafx:view"])),
            list(&["*", "dimafx:view", "dimafx:all"])
        );
        assert_eq!(
            expand_channel_permission_checks(&list(&["commands:manage"])),
            list(&["*", "commands:manage"])
        );
        // Ordering, deduplication and the wildcard position follow the source.
        assert_eq!(
            expand_channel_permission_checks(&list(&[
                "triggers:view",
                "*",
                "dimafx:edit",
                "triggers:view",
            ])),
            list(&[
                "*",
                "triggers:view",
                "dimafx:edit",
                "triggers:all",
                "dimafx:all"
            ])
        );
        assert_eq!(expand_channel_permission_checks(&[]), list(&["*"]));
    }

    #[test]
    fn batch_access_resolves_each_permission_against_the_granted_list() {
        assert_eq!(
            decisions_json(&resolve_granted_permissions(
                &list(&["dashboard:view", "triggers:all"]),
                &list(&["dashboard:view", "commands:view", "triggers:edit"]),
            )),
            json!({"dashboard:view": true, "commands:view": false, "triggers:edit": true})
        );
        assert_eq!(
            decisions_json(&resolve_granted_permissions(
                &list(&["*"]),
                &list(&["dashboard:view", "settings:view"]),
            )),
            json!({"dashboard:view": true, "settings:view": true})
        );
        assert_eq!(
            decisions_json(&resolve_granted_permissions(
                &[],
                &list(&["dashboard:view"])
            )),
            json!({"dashboard:view": false})
        );
    }

    #[test]
    fn permissions_query_parsing_distinguishes_absent_valid_and_invalid() {
        assert_eq!(parse_permission_list(None), None);
        assert_eq!(
            parse_permission_list(Some("dashboard:view, commands:view,dashboard:view")),
            Some(list(&["dashboard:view", "commands:view"]))
        );
        let repeated_values = list(&["dashboard:view", "settings:view"]);
        assert_eq!(
            parse_permission_list_values(Some(&repeated_values[..])),
            Some(list(&["dashboard:view", "settings:view"]))
        );
        assert_eq!(parse_permission_list(Some("")), Some(Vec::new()));
        assert_eq!(
            parse_permission_list(Some("dashboard:view,$where")),
            Some(Vec::new())
        );
        let too_many = (0..21)
            .map(|index| format!("p{index}:view"))
            .collect::<Vec<String>>()
            .join(",");
        assert_eq!(parse_permission_list(Some(&too_many)), Some(Vec::new()));
        assert_eq!(
            parse_permission_query(&[("permissions", "a:view")]),
            Some(list(&["a:view"]))
        );
        assert_eq!(
            parse_permission_query(&[("permissions", "a:view"), ("permissions", "b:view")]),
            Some(list(&["a:view", "b:view"]))
        );
        assert_eq!(parse_permission_query(&[]), None);
    }

    #[test]
    fn permission_names_follow_the_source_pattern() {
        let sixty_four = "a".repeat(64);
        let sixty_five = "a".repeat(65);
        assert_eq!(
            parse_permission_list(Some(&sixty_four)),
            Some(list(&[sixty_four.as_str()]))
        );
        assert_eq!(parse_permission_list(Some(&sixty_five)), Some(Vec::new()));
        // Case-insensitive alphabet, and no Unicode or line terminators.
        assert_eq!(
            parse_permission_list(Some("Dashboard:View,commands:view")),
            Some(list(&["Dashboard:View", "commands:view"]))
        );
        assert_eq!(parse_permission_list(Some("permissioné")), Some(Vec::new()));
        assert_eq!(
            parse_permission_list(Some("dashboard\n:view")),
            Some(Vec::new())
        );
        // Surrounding whitespace is trimmed with ECMAScript rules first.
        assert_eq!(
            parse_permission_list(Some(" \u{00a0}dashboard:view\u{3000} ")),
            Some(list(&["dashboard:view"]))
        );
    }

    #[test]
    fn roles_normalize_to_the_declared_strings() {
        for role in AdminRole::ALL {
            assert_eq!(normalize_admin_role(role.as_str()), Some(role));
        }
        assert_eq!(normalize_admin_role("Creator"), None);
        assert_eq!(normalize_admin_role(""), None);
        assert_eq!(
            GlobalAdminRole::from_admin_role(AdminRole::Creator),
            Some(GlobalAdminRole::Creator)
        );
        assert_eq!(
            GlobalAdminRole::from_admin_role(AdminRole::Super),
            Some(GlobalAdminRole::Super)
        );
        for role in [AdminRole::Support, AdminRole::Billing, AdminRole::Channel] {
            assert_eq!(GlobalAdminRole::from_admin_role(role), None);
        }
        assert_eq!(
            "super".parse::<GlobalAdminRole>(),
            Ok(GlobalAdminRole::Super)
        );
        assert_eq!("support".parse::<GlobalAdminRole>(), Err(()));
    }

    #[test]
    fn decisions_keep_requested_order_and_collapse_duplicates() {
        let decisions = ChannelAccessDecisions::new(
            ChannelAccessRole::Admin,
            vec![
                ("dashboard:view".to_owned(), true),
                ("commands:view".to_owned(), false),
                ("dashboard:view".to_owned(), true),
            ],
        );
        assert_eq!(
            decisions.to_json(),
            json!({"role": "admin", "permissions": {"dashboard:view": true, "commands:view": false}})
        );
        assert_eq!(decisions.allowed("commands:view"), Some(false));
        assert_eq!(decisions.allowed("triggers:edit"), None);
        assert!(decisions.any_allowed());
        assert!(
            !ChannelAccessDecisions::uniform(ChannelAccessRole::None, &[], false).any_allowed()
        );
        assert_eq!(ChannelAccessRole::None.as_str(), "none");
    }

    #[test]
    fn error_bodies_match_the_source_json() {
        assert_eq!(
            serde_json::to_value(AdminErrorBody::authentication_required()).unwrap(),
            json!({"error": true, "message": "Authentication required", "status": 401, "type": "authentication_required"})
        );
        assert_eq!(
            serde_json::to_value(AdminErrorBody::admin_required()).unwrap(),
            json!({"error": true, "message": "Admin privileges required", "status": 403, "type": "admin_required"})
        );
        assert_eq!(
            serde_json::to_value(AdminErrorBody::internal_error()).unwrap(),
            json!({"error": true, "message": "Internal server error", "status": 500, "type": "internal_error"})
        );
        assert_eq!(
            ERROR_TYPE_AUTHENTICATION_REQUIRED,
            "authentication_required"
        );
        assert_eq!(ERROR_TYPE_ADMIN_REQUIRED, "admin_required");
    }

    #[test]
    fn global_context_is_only_read_when_inserted() {
        let mut extensions = axum::http::Extensions::new();
        assert_eq!(global_admin_role(&extensions), None);
        assert!(!is_super_admin(&extensions));
        extensions.insert(GlobalAdminContext {
            role: GlobalAdminRole::Super,
            is_super_admin: true,
        });
        assert_eq!(global_admin_role(&extensions), Some(GlobalAdminRole::Super));
        assert!(is_super_admin(&extensions));
        assert_eq!(
            global_admin_context(&extensions).map(|context| context.role.as_str()),
            Some("super")
        );
    }
}
