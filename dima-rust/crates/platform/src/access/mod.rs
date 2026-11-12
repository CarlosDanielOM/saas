//! What an authenticated person may do on which channel: `admin.middleware.ts` in full, and the
//! typed guards routes use instead of checking raw ids themselves.
//!
//! # Rules (reference: `dimabot/src/middleware/admin.middleware.ts`)
//!
//! - **Creator**: Twitch id [`CREATOR_TWITCH_USER_ID`] is the `creator` global role even without
//!   an `admins` row (the reference's hard fallback), and owns every channel.
//! - **Global roles** ([`ChannelAccess::global_admin_role`]): active `admins` rows with role
//!   `creator` or `super`; `creator` wins. A super admin owns every channel except the creator's.
//!   `support` and `billing` are staff roles with no channel rights.
//! - **Channel access** ([`ChannelAccess::channel_access_context`]): the channel's own account is
//!   `owner`; a global owner is `owner`; an active `admins` row of that channel and person whose
//!   permissions hold `*`, one of the asked permissions, `triggers:all` (for any `triggers:*`)
//!   or `dimafx:all` (for any `dimafx:*`) is `admin` ([`expand_channel_permission_checks`]: a
//!   list means *any of*). Anything else is `none`. A missing requester or channel is `none`.
//! - **Per-permission decisions** ([`ChannelAccess::channel_access_decisions`]): the same, for up
//!   to [`MAX_ACCESS_PERMISSIONS`] permissions with one lookup ([`parse_permission_list`] for the
//!   query parameter, [`resolve_granted_permissions`] for the merge).
//! - [`can_modify_creator_admin_assignment`]: only the creator, or the channel's own account,
//!   may change an admin assignment that targets the creator.
//!
//! Nothing here is cached: every decision reads MongoDB, so a removed or deactivated row takes
//! effect on the next request. Every read has [`ChannelAccess`]'s deadline; a read that fails or
//! times out is an [`AccessError`], which every guard answers with a refusal (500), never access.
//!
//! # Guards for routes
//!
//! A handler should never compare ids itself. It asks for a capability and receives a value
//! that only this module can build:
//!
//! | the route needs | mount | the handler reads |
//! |---|---|---|
//! | a signed-in person | [`crate::auth::require_user`] | [`AuthenticatedUser::of`] |
//! | site staff (`adminMiddleware`) | [`require_admin`] | [`StaffAdmin::of`] |
//! | the creator or a super admin (the site catalog, `POST /site/events`) | [`require_global_admin`] | [`GlobalAdmin::of`] |
//! | the owner of `:channelID` (or a global owner) | [`ChannelGuard::owner`] | [`ChannelScope::of`] |
//! | a manager of `:channelID` with permission X | [`ChannelGuard::permission`]`("commands:manage")` | [`ChannelScope::of`] |
//!
//! A [`ChannelScope`] names exactly one channel, the one that was checked: writes take their
//! channel from [`ChannelScope::channel_id`] (or [`ChannelScope::filter`]), never from the body,
//! and a body that would move a document to another channel is refused by
//! [`ChannelScope::check_body`] before it reaches an update. Routes with their own flow call
//! [`ChannelAccess::scope`] directly and get the same type.
//!
//! # Intended differences
//!
//! - `adminMiddleware` (mounted by no route) let **any** active `admins` row through, a channel
//!   editor's included, and took the role from whichever row MongoDB returned first.
//!   [`require_admin`] requires a staff role (`creator`, `super`, `support`, `billing`), takes the
//!   highest of the person's active rows, and applies the creator fallback.
//! - [`resolve_granted_permissions`] keeps JavaScript's object key order (integer-like names
//!   first), which only shows in the order of a JSON answer.

use crate::auth::{AuthenticatedUser, HasAuthenticator};
use bson::{Bson, Document, doc};
use dima_model::admins::{self, AdminRole};
use dima_store::mongo::MongoStore;
use dima_web::{BoxFuture, Error as WebError, Flow, Handler, Req, Response};
use futures_util::TryStreamExt;
use serde_json::{Map, Value, json};
use std::fmt;
use std::time::Duration;

pub use crate::auth::CREATOR_TWITCH_USER_ID;

/// `MAX_ACCESS_PERMISSIONS`.
pub const MAX_ACCESS_PERMISSIONS: usize = 20;
/// Longest permission name (`/^[a-z0-9_*:-]{1,64}$/i`).
pub const MAX_PERMISSION_NAME: usize = 64;
/// Default deadline of each MongoDB read.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);

/// `GlobalAdminRole`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum GlobalAdminRole {
    /// `super`.
    Super,
    /// `creator`.
    Creator,
}

impl GlobalAdminRole {
    /// The stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Super => "super",
            Self::Creator => "creator",
        }
    }
}

/// `normalizeAdminRole`: a stored role that is exactly one of the five names.
pub fn normalize_admin_role(value: Option<&Bson>) -> Option<AdminRole> {
    match value? {
        Bson::String(text) => match text.as_str() {
            "creator" => Some(AdminRole::Creator),
            "super" => Some(AdminRole::Super),
            "support" => Some(AdminRole::Support),
            "billing" => Some(AdminRole::Billing),
            "channel" => Some(AdminRole::Channel),
            _ => None,
        },
        _ => None,
    }
}

/// `isCreatorUser` / `isCreatorTarget`.
pub fn is_creator(id: Option<&str>) -> bool {
    id == Some(CREATOR_TWITCH_USER_ID)
}

/// `canModifyCreatorAdminAssignment`.
pub fn can_modify_creator_admin_assignment(
    requester: Option<&str>,
    channel: Option<&str>,
    target_admin: Option<&str>,
) -> bool {
    if !is_creator(target_admin) {
        return true;
    }
    is_creator(requester) || requester == channel
}

/// The permission argument as the reference filters it: `(Array.isArray(p) ? p : [p])` keeping
/// the strings (an object, a number or `undefined` contributes nothing).
pub fn requested_permissions(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        Some(Value::String(text)) => vec![text.clone()],
        _ => Vec::new(),
    }
}

/// `expandChannelPermissionChecks`: `*`, the asked permissions, and the legacy module-wide
/// grants, without duplicates, in that order.
pub fn expand_channel_permission_checks<S: AsRef<str>>(requested: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(requested.len() + 3);
    let mut push = |value: &str| {
        if !out.iter().any(|existing| existing == value) {
            out.push(value.to_owned());
        }
    };
    push("*");
    for value in requested {
        push(value.as_ref());
    }
    if requested
        .iter()
        .any(|v| v.as_ref().starts_with("triggers:"))
    {
        push("triggers:all");
    }
    if requested.iter().any(|v| v.as_ref().starts_with("dimafx:")) {
        push("dimafx:all");
    }
    out
}

fn permission_name(value: &str) -> bool {
    (1..=MAX_PERMISSION_NAME).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'*' | b':' | b'-'))
}

/// `parsePermissionList`: `None` when the query has no `permissions`; an empty list when it is
/// present but invalid (empty, more than [`MAX_ACCESS_PERMISSIONS`], or a malformed name).
pub fn parse_permission_list(raw: Option<&Value>) -> Option<Vec<String>> {
    let raw = raw?;
    let items: Vec<&Value> = match raw {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut unique: Vec<String> = Vec::new();
    for item in items {
        let Value::String(text) = item else { continue };
        for part in text.split(',') {
            let part = dima_text::trim(part);
            if !part.is_empty() && !unique.iter().any(|u| u == part) {
                unique.push(part.to_owned());
            }
        }
    }
    if unique.is_empty()
        || unique.len() > MAX_ACCESS_PERMISSIONS
        || !unique.iter().all(|value| permission_name(value))
    {
        return Some(Vec::new());
    }
    Some(unique)
}

/// A JavaScript object built key by key: array-index keys first in ascending order, then the
/// others in insertion order (what `Object.fromEntries` produces and `JSON.stringify` prints).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PermissionMap(Vec<(String, bool)>);

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index < u32::MAX)
}

impl PermissionMap {
    fn from_entries(entries: impl IntoIterator<Item = (String, bool)>) -> Self {
        let mut out: Vec<(String, bool)> = Vec::new();
        for (key, value) in entries {
            match out.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => out.push((key, value)),
            }
        }
        let (mut indexes, others): (Vec<_>, Vec<_>) = out
            .into_iter()
            .partition(|(key, _)| array_index(key).is_some());
        indexes.sort_by_key(|(key, _)| array_index(key));
        indexes.extend(others);
        Self(indexes)
    }

    /// The entries, in JSON order.
    pub fn entries(&self) -> &[(String, bool)] {
        &self.0
    }

    /// The decision for one permission.
    pub fn get(&self, permission: &str) -> Option<bool> {
        self.0
            .iter()
            .find(|(key, _)| key == permission)
            .map(|(_, value)| *value)
    }

    /// `Object.values(map).every(Boolean)`.
    pub fn all(&self) -> bool {
        self.0.iter().all(|(_, value)| *value)
    }

    /// `Object.values(map).some(Boolean)`.
    pub fn any(&self) -> bool {
        self.0.iter().any(|(_, value)| *value)
    }

    /// The JSON object.
    pub fn to_json(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(key, value)| (key.clone(), Value::Bool(*value)))
                .collect::<Map<String, Value>>(),
        )
    }
}

/// `resolveGrantedPermissions`: which of the requested permissions the granted list covers
/// (legacy grants included).
pub fn resolve_granted_permissions<G: AsRef<str>, R: AsRef<str>>(
    granted: &[G],
    requested: &[R],
) -> PermissionMap {
    PermissionMap::from_entries(requested.iter().map(|permission| {
        let permission = permission.as_ref();
        let covered = expand_channel_permission_checks(&[permission])
            .iter()
            .any(|candidate| granted.iter().any(|g| g.as_ref() == candidate));
        (permission.to_owned(), covered)
    }))
}

/// `'owner' | 'admin' | 'none'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelRole {
    /// The channel's own account, or a global owner.
    Owner,
    /// A channel admin with a matching permission.
    Admin,
    /// No access.
    None,
}

impl ChannelRole {
    /// The reference's name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::None => "none",
        }
    }
}

/// `ChannelAccessContext`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelAccessContext {
    /// `allowed`.
    pub allowed: bool,
    /// `role`.
    pub role: ChannelRole,
}

/// `ChannelAccessDecisions`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelAccessDecisions {
    /// `role`.
    pub role: ChannelRole,
    /// `permissions`.
    pub permissions: PermissionMap,
}

/// A decision could not be made (MongoDB failed or was too slow). Never means "allowed".
#[derive(Debug, thiserror::Error)]
pub enum AccessError {
    /// The read failed.
    #[error("access lookup failed: {0}")]
    Store(#[from] mongodb::error::Error),
    /// The read did not finish within the deadline.
    #[error("access lookup did not finish within the deadline")]
    Deadline,
}

/// The access service: one per process.
#[derive(Clone)]
pub struct ChannelAccess {
    mongo: MongoStore,
    deadline: Duration,
}

impl fmt::Debug for ChannelAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChannelAccess")
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

/// What a channel route needs from the requester.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need<'a> {
    /// The channel's own account, or a global owner (`requesterID === channelID ||
    /// hasGlobalChannelOwnerAccess`).
    Owner,
    /// `getChannelAccessContext(…, permission)`.
    Permission(&'a str),
    /// `getChannelAccessContext(…, [a, b])`: any one of them.
    AnyOf(&'a [&'a str]),
}

/// Why [`ChannelAccess::scope`] said no.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denied {
    /// No channel was named (empty or missing).
    NoChannel,
    /// The person has no matching right on the channel.
    NotAllowed,
}

/// How the person reached the channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeRole {
    /// It is their own channel.
    OwnChannel,
    /// A global owner (creator or super admin).
    GlobalOwner(GlobalAdminRole),
    /// A channel admin whose permissions matched.
    Admin,
}

/// Proof that the authenticated person may act on one channel, as the route asked. Built only
/// by [`ChannelAccess::scope`] (and so by [`ChannelGuard`]; `for_tests` with feature
/// `test-util`).
///
/// ```compile_fail,E0451
/// fn forge(requester: dima_platform::auth::AuthenticatedUser) -> dima_platform::access::ChannelScope {
///     dima_platform::access::ChannelScope {
///         requester,
///         channel_id: "1".into(),
///         role: dima_platform::access::ScopeRole::Admin,
///     }
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelScope {
    requester: AuthenticatedUser,
    channel_id: String,
    role: ScopeRole,
}

/// A request body that tries to name what the scope fixes.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the request body may not set `{key}`")]
pub struct ScopeViolation {
    /// The refused key.
    pub key: String,
}

impl ChannelScope {
    /// A scope for tests in other crates (feature `test-util`).
    #[cfg(feature = "test-util")]
    pub fn for_tests(
        requester: AuthenticatedUser,
        channel_id: impl Into<String>,
        role: ScopeRole,
    ) -> Self {
        Self {
            requester,
            channel_id: channel_id.into(),
            role,
        }
    }

    /// The checked channel.
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// Who asked.
    pub fn requester(&self) -> &AuthenticatedUser {
        &self.requester
    }

    /// How they reached the channel.
    pub fn role(&self) -> ScopeRole {
        self.role
    }

    /// `'owner'` or `'admin'`, as the reference reports it.
    pub fn role_name(&self) -> ChannelRole {
        match self.role {
            ScopeRole::Admin => ChannelRole::Admin,
            _ => ChannelRole::Owner,
        }
    }

    /// `true` for the channel's own account and global owners.
    pub fn is_owner(&self) -> bool {
        self.role_name() == ChannelRole::Owner
    }

    /// `{ <field>: <channel> }`: the filter every read and write of this channel starts from.
    pub fn filter(&self, field: &str) -> Document {
        doc! { field: self.channel_id.as_str() }
    }

    /// Refuses a body that names the channel field, `_id`, an operator (`$set`…) or a dotted
    /// path. Routes call this before turning a body into an update, so a manager of one channel
    /// can never move a document to another one by sending `channelID`.
    ///
    /// **It checks the top level only.** `{"settings": {"$set": …}}` or
    /// `{"meta": {"channelID": "other"}}` passes. A route whose body has nested objects must
    /// not flatten them into an update (or a filter) as they come: it decodes the body into a
    /// typed allow-list first (a struct with `deny_unknown_fields`, one field per value the route
    /// may write) and builds the update from that struct's fields, never from the client's keys.
    /// There is no recursive variant: nested maps keyed by user text (names, URLs) can hold dots
    /// legitimately, and the allow-list is what makes nested values safe.
    ///
    /// ```
    /// # use serde::Deserialize;
    /// # fn update(body: serde_json::Value) -> Result<bson::Document, serde_json::Error> {
    /// #[derive(Deserialize)]
    /// #[serde(deny_unknown_fields)]
    /// struct Style {
    ///     color: String,
    /// }
    /// #[derive(Deserialize)]
    /// #[serde(deny_unknown_fields)]
    /// struct RewardUpdate {
    ///     title: String,
    ///     style: Style,
    /// }
    /// // after `scope.check_body(&body, "channelID")?`:
    /// let reward: RewardUpdate = serde_json::from_value(body)?;
    /// Ok(bson::doc! { "$set": { "title": reward.title, "style.color": reward.style.color } })
    /// # }
    /// # assert!(update(serde_json::json!({"title": "t", "style": {"$set": {"x": 1}}})).is_err());
    /// # assert!(update(serde_json::json!({"title": "t", "style": {"color": "red"}})).is_ok());
    /// ```
    pub fn check_body(
        &self,
        body: &Map<String, Value>,
        channel_field: &str,
    ) -> Result<(), ScopeViolation> {
        match body.keys().find(|key| {
            key.as_str() == channel_field
                || key.as_str() == "_id"
                || key.starts_with('$')
                || key.contains('.')
        }) {
            Some(key) => Err(ScopeViolation { key: key.clone() }),
            None => Ok(()),
        }
    }

    /// The scope a [`ChannelGuard`] attached. Without the guard: a 500, never a pass.
    pub fn of<S>(req: &Req<S>) -> Result<&ChannelScope, WebError> {
        req.extensions()
            .get::<ChannelScope>()
            .ok_or_else(|| WebError::new(500, "channel guard missing"))
    }
}

/// A person with a staff role, attached by [`require_admin`]. Only the guard makes one
/// (`for_tests` with feature `test-util`).
///
/// ```compile_fail,E0616
/// fn role(staff: &dima_platform::access::StaffAdmin) -> dima_model::admins::AdminRole {
///     staff.role
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaffAdmin {
    user: AuthenticatedUser,
    role: AdminRole,
    global: Option<GlobalAdminRole>,
}

impl StaffAdmin {
    /// A staff identity for tests in other crates (feature `test-util`).
    #[cfg(feature = "test-util")]
    pub fn for_tests(
        user: AuthenticatedUser,
        role: AdminRole,
        global: Option<GlobalAdminRole>,
    ) -> Self {
        Self { user, role, global }
    }

    /// The person.
    pub fn user(&self) -> &AuthenticatedUser {
        &self.user
    }

    /// Their highest staff role.
    pub fn role(&self) -> AdminRole {
        self.role
    }

    /// `req.globalAdminRole` (`isSuperAdmin` when set).
    pub fn global(&self) -> Option<GlobalAdminRole> {
        self.global
    }

    /// The value [`require_admin`] attached.
    pub fn of<S>(req: &Req<S>) -> Result<&StaffAdmin, WebError> {
        req.extensions()
            .get::<StaffAdmin>()
            .ok_or_else(|| WebError::new(500, "admin guard missing"))
    }
}

/// The creator or a super admin, attached by [`require_global_admin`]. Only the guard makes
/// one (`for_tests` with feature `test-util`).
///
/// ```compile_fail,E0451
/// fn forge(user: dima_platform::auth::AuthenticatedUser) -> dima_platform::access::GlobalAdmin {
///     dima_platform::access::GlobalAdmin {
///         user,
///         role: dima_platform::access::GlobalAdminRole::Creator,
///     }
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlobalAdmin {
    user: AuthenticatedUser,
    role: GlobalAdminRole,
}

impl GlobalAdmin {
    /// A global admin for tests in other crates (feature `test-util`).
    #[cfg(feature = "test-util")]
    pub fn for_tests(user: AuthenticatedUser, role: GlobalAdminRole) -> Self {
        Self { user, role }
    }

    /// The person.
    pub fn user(&self) -> &AuthenticatedUser {
        &self.user
    }

    /// Their global role.
    pub fn role(&self) -> GlobalAdminRole {
        self.role
    }

    /// The value [`require_global_admin`] attached.
    pub fn of<S>(req: &Req<S>) -> Result<&GlobalAdmin, WebError> {
        req.extensions()
            .get::<GlobalAdmin>()
            .ok_or_else(|| WebError::new(500, "global admin guard missing"))
    }
}

/// What `adminMiddleware` decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdminCheck {
    /// No authenticated user: `401 authentication_required`.
    Unauthenticated,
    /// No staff role: `403 admin_required`.
    Refused,
    /// A staff role.
    Staff(AdminRole, Option<GlobalAdminRole>),
}

fn rank(role: AdminRole) -> u8 {
    match role {
        AdminRole::Creator => 4,
        AdminRole::Super => 3,
        AdminRole::Support => 2,
        AdminRole::Billing => 1,
        AdminRole::Channel => 0,
    }
}

impl ChannelAccess {
    /// A service reading `admins` from `mongo`, each read bounded by `deadline`.
    pub fn new(mongo: MongoStore, deadline: Duration) -> Self {
        Self { mongo, deadline }
    }

    async fn bounded<T>(
        &self,
        future: impl Future<Output = Result<T, mongodb::error::Error>>,
    ) -> Result<T, AccessError> {
        match tokio::time::timeout(self.deadline, future).await {
            Ok(result) => Ok(result?),
            Err(_) => Err(AccessError::Deadline),
        }
    }

    /// Active roles of `user` among `roles` (or all, when `roles` is `None`).
    async fn active_roles(
        &self,
        user: &str,
        roles: Option<&[&str]>,
    ) -> Result<Vec<AdminRole>, AccessError> {
        let mut filter = doc! { "adminID": user, "actived": true };
        if let Some(roles) = roles {
            filter.insert("role", doc! { "$in": roles });
        }
        let rows: Vec<Document> = self
            .bounded(async {
                self.mongo
                    .documents(admins::COLLECTION)
                    .find(filter)
                    .projection(doc! { "role": 1 })
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        Ok(rows
            .iter()
            .filter_map(|row| normalize_admin_role(row.get("role")))
            .collect())
    }

    /// `getGlobalAdminRole`.
    pub async fn global_admin_role(
        &self,
        user: Option<&str>,
    ) -> Result<Option<GlobalAdminRole>, AccessError> {
        let Some(user) = user.filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        if is_creator(Some(user)) {
            return Ok(Some(GlobalAdminRole::Creator));
        }
        let roles = self.active_roles(user, Some(&["creator", "super"])).await?;
        Ok(if roles.contains(&AdminRole::Creator) {
            Some(GlobalAdminRole::Creator)
        } else if roles.contains(&AdminRole::Super) {
            Some(GlobalAdminRole::Super)
        } else {
            None
        })
    }

    /// The global role that owns `target`, if any (`hasGlobalChannelOwnerAccess` with the role).
    async fn global_owner(
        &self,
        requester: &str,
        target: &str,
    ) -> Result<Option<GlobalAdminRole>, AccessError> {
        Ok(match self.global_admin_role(Some(requester)).await? {
            Some(GlobalAdminRole::Creator) => Some(GlobalAdminRole::Creator),
            Some(GlobalAdminRole::Super) if !is_creator(Some(target)) => {
                Some(GlobalAdminRole::Super)
            }
            _ => None,
        })
    }

    /// `hasGlobalChannelOwnerAccess`.
    pub async fn has_global_channel_owner_access(
        &self,
        requester: Option<&str>,
        target: Option<&str>,
    ) -> Result<bool, AccessError> {
        match (nonempty(requester), nonempty(target)) {
            (Some(requester), Some(target)) => {
                Ok(self.global_owner(requester, target).await?.is_some())
            }
            _ => Ok(false),
        }
    }

    /// `getChannelAccessContext` with the permission argument already filtered to its strings
    /// ([`requested_permissions`]).
    pub async fn channel_access_context<P: AsRef<str>>(
        &self,
        requester: Option<&str>,
        target: Option<&str>,
        permission: &[P],
    ) -> Result<ChannelAccessContext, AccessError> {
        let (Some(requester), Some(target)) = (nonempty(requester), nonempty(target)) else {
            return Ok(ChannelAccessContext {
                allowed: false,
                role: ChannelRole::None,
            });
        };
        Ok(match self.decide(requester, target, permission).await? {
            Some(_) if requester == target => ChannelAccessContext {
                allowed: true,
                role: ChannelRole::Owner,
            },
            Some(ScopeRole::Admin) => ChannelAccessContext {
                allowed: true,
                role: ChannelRole::Admin,
            },
            Some(_) => ChannelAccessContext {
                allowed: true,
                role: ChannelRole::Owner,
            },
            None => ChannelAccessContext {
                allowed: false,
                role: ChannelRole::None,
            },
        })
    }

    /// The reference's three steps: own channel, global owner, a matching admin row.
    async fn decide<P: AsRef<str>>(
        &self,
        requester: &str,
        target: &str,
        permission: &[P],
    ) -> Result<Option<ScopeRole>, AccessError> {
        if requester == target {
            return Ok(Some(ScopeRole::OwnChannel));
        }
        if let Some(role) = self.global_owner(requester, target).await? {
            return Ok(Some(ScopeRole::GlobalOwner(role)));
        }
        let checks = expand_channel_permission_checks(permission);
        let filter = doc! {
            "channelID": target,
            "adminID": requester,
            "actived": true,
            "permissions": { "$in": checks },
        };
        let found = self
            .bounded(
                self.mongo
                    .documents(admins::COLLECTION)
                    .find_one(filter)
                    .projection(doc! { "_id": 1 })
                    .into_future(),
            )
            .await?;
        Ok(found.map(|_| ScopeRole::Admin))
    }

    /// `getChannelAccessDecisions`.
    pub async fn channel_access_decisions<P: AsRef<str>>(
        &self,
        requester: Option<&str>,
        target: Option<&str>,
        permissions: &[P],
    ) -> Result<ChannelAccessDecisions, AccessError> {
        let all = |allowed: bool| {
            PermissionMap::from_entries(
                permissions.iter().map(|p| (p.as_ref().to_owned(), allowed)),
            )
        };
        let (Some(requester), Some(target)) = (nonempty(requester), nonempty(target)) else {
            return Ok(ChannelAccessDecisions {
                role: ChannelRole::None,
                permissions: all(false),
            });
        };
        if requester == target || self.global_owner(requester, target).await?.is_some() {
            return Ok(ChannelAccessDecisions {
                role: ChannelRole::Owner,
                permissions: all(true),
            });
        }
        let filter = doc! { "channelID": target, "adminID": requester, "actived": true };
        let rows: Vec<Document> = self
            .bounded(async {
                self.mongo
                    .documents(admins::COLLECTION)
                    .find(filter)
                    .projection(doc! { "permissions": 1 })
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        // `rows.flatMap(row => row.permissions ?? [])`: an array spreads, a lone string counts
        // as one grant; other values never equal a permission name.
        let granted: Vec<String> = rows
            .iter()
            .flat_map(|row| match row.get("permissions") {
                Some(Bson::Array(items)) => items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect(),
                Some(Bson::String(text)) => vec![text.clone()],
                _ => Vec::new(),
            })
            .collect();
        let decisions = resolve_granted_permissions(&granted, permissions);
        Ok(ChannelAccessDecisions {
            role: if decisions.any() {
                ChannelRole::Admin
            } else {
                ChannelRole::None
            },
            permissions: decisions,
        })
    }

    /// `adminMiddleware`'s decision, with the weakness closed: a staff role is required (the
    /// highest of the person's active rows; the creator by id).
    pub async fn admin_check(
        &self,
        user: Option<&AuthenticatedUser>,
    ) -> Result<AdminCheck, AccessError> {
        let Some(user) = user.filter(|user| !user.id().is_empty()) else {
            return Ok(AdminCheck::Unauthenticated);
        };
        let mut roles = self.active_roles(user.id(), None).await?;
        if is_creator(Some(user.id())) {
            roles.push(AdminRole::Creator);
        }
        let Some(best) = roles
            .into_iter()
            .filter(|role| *role != AdminRole::Channel)
            .max_by_key(|role| rank(*role))
        else {
            return Ok(AdminCheck::Refused);
        };
        let global = match best {
            AdminRole::Creator => Some(GlobalAdminRole::Creator),
            AdminRole::Super => Some(GlobalAdminRole::Super),
            _ => None,
        };
        Ok(AdminCheck::Staff(best, global))
    }

    /// Checks `need` for `user` on `channel` and returns the scope that proves it.
    pub async fn scope(
        &self,
        user: &AuthenticatedUser,
        channel: &str,
        need: Need<'_>,
    ) -> Result<Result<ChannelScope, Denied>, AccessError> {
        if channel.is_empty() || user.id().is_empty() {
            return Ok(Err(Denied::NoChannel));
        }
        let role = match need {
            Need::Owner => {
                if user.id() == channel {
                    Some(ScopeRole::OwnChannel)
                } else {
                    self.global_owner(user.id(), channel)
                        .await?
                        .map(ScopeRole::GlobalOwner)
                }
            }
            Need::Permission(permission) => self.decide(user.id(), channel, &[permission]).await?,
            Need::AnyOf(permissions) => self.decide(user.id(), channel, permissions).await?,
        };
        Ok(match role {
            Some(role) => Ok(ChannelScope {
                requester: user.clone(),
                channel_id: channel.to_owned(),
                role,
            }),
            None => Err(Denied::NotAllowed),
        })
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

impl crate::media_library::GlobalChannelOwnerAccess for ChannelAccess {
    fn has_access<'a>(
        &'a self,
        requester: &'a str,
        channel: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<bool, crate::media_library::Error>> {
        Box::pin(async move {
            self.has_global_channel_owner_access(Some(requester), Some(channel))
                .await
                .map_err(|_| crate::media_library::Error::Access)
        })
    }
}

/// Application state that carries the access service.
pub trait HasChannelAccess: HasAuthenticator {
    /// The process's access service.
    fn channel_access(&self) -> &ChannelAccess;
}

fn envelope(status: u16, message: &str, kind: Option<&str>) -> Response {
    let mut body = json!({ "error": true, "message": message, "status": status });
    if let (Some(kind), Some(object)) = (kind, body.as_object_mut()) {
        object.insert("type".to_owned(), Value::String(kind.to_owned()));
    }
    Response::status(status).json(&body)
}

/// `500 {"error":true,"message":"Internal server error","status":500,"type":"internal_error"}`.
pub fn internal_error() -> Response {
    envelope(500, "Internal server error", Some("internal_error"))
}

/// `adminMiddleware` as a guard: 401 without a user, 403 without a staff role, 500 when the
/// lookup fails; otherwise [`StaffAdmin`] is attached. Mount after
/// [`crate::auth::require_user`].
pub async fn require_admin<S: HasChannelAccess>(req: &mut Req<S>) -> Result<Flow, WebError> {
    let state = req.state_arc();
    let user = AuthenticatedUser::maybe(req).cloned();
    Ok(
        match state.channel_access().admin_check(user.as_ref()).await {
            Ok(AdminCheck::Staff(role, global)) => {
                if let Some(user) = user {
                    req.extensions_mut()
                        .insert(StaffAdmin { user, role, global });
                }
                Flow::Next
            }
            Ok(AdminCheck::Unauthenticated) => Flow::Respond(envelope(
                401,
                "Authentication required",
                Some("authentication_required"),
            )),
            Ok(AdminCheck::Refused) => Flow::Respond(envelope(
                403,
                "Admin privileges required",
                Some("admin_required"),
            )),
            Err(_) => Flow::Respond(internal_error()),
        },
    )
}

/// The creator or a super admin, by Twitch id and active `admins` rows (never by login). Refusal:
/// `403 {"error":true,"message":"You do not have permission to access this endpoint",
/// "status":403}`, the admin site's answer. Mount after [`crate::auth::require_user`].
pub async fn require_global_admin<S: HasChannelAccess>(req: &mut Req<S>) -> Result<Flow, WebError> {
    let state = req.state_arc();
    let Some(user) = AuthenticatedUser::maybe(req).cloned() else {
        return Ok(Flow::Respond(envelope(401, "Unauthorized", None)));
    };
    Ok(
        match state
            .channel_access()
            .global_admin_role(Some(user.id()))
            .await
        {
            Ok(Some(role)) => {
                req.extensions_mut().insert(GlobalAdmin { user, role });
                Flow::Next
            }
            Ok(None) => Flow::Respond(envelope(
                403,
                "You do not have permission to access this endpoint",
                None,
            )),
            Err(_) => Flow::Respond(internal_error()),
        },
    )
}

/// The default refusal of a [`ChannelGuard`]:
/// `403 {"error":true,"message":"You do not have permission to access this route","status":403}`.
pub fn channel_refusal() -> Response {
    envelope(403, "You do not have permission to access this route", None)
}

/// A route guard: the authenticated person must meet `need` on the channel in path parameter
/// `param`. On success it attaches the [`ChannelScope`]; otherwise it answers the route's refusal
/// (default [`channel_refusal`]), or [`internal_error`] when the lookup fails. Mount after
/// [`crate::auth::require_user`].
///
/// ```ignore
/// router.patch("/:channelID", (require_user::<State>, ChannelGuard::permission("commands:manage"), update));
/// // in `update`: let scope = ChannelScope::of(req)?; scope.check_body(&body, "channelID")?;
/// ```
pub struct ChannelGuard {
    param: &'static str,
    need: Need<'static>,
    refusal: fn() -> Response,
    failure: fn() -> Response,
}

impl fmt::Debug for ChannelGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChannelGuard")
            .field("param", &self.param)
            .field("need", &self.need)
            .finish_non_exhaustive()
    }
}

impl ChannelGuard {
    /// `need` on the channel in `:channelID`.
    pub fn new(need: Need<'static>) -> Self {
        Self {
            param: "channelID",
            need,
            refusal: channel_refusal,
            failure: internal_error,
        }
    }

    /// The channel's owner (or a global owner).
    pub fn owner() -> Self {
        Self::new(Need::Owner)
    }

    /// A manager with `permission` (or any owner).
    pub fn permission(permission: &'static str) -> Self {
        Self::new(Need::Permission(permission))
    }

    /// Reads the channel from another path parameter.
    #[must_use]
    pub fn param(mut self, param: &'static str) -> Self {
        self.param = param;
        self
    }

    /// The route's own refusal.
    #[must_use]
    pub fn refuse_with(mut self, refusal: fn() -> Response) -> Self {
        self.refusal = refusal;
        self
    }

    /// The route's own answer when the lookup fails.
    #[must_use]
    pub fn fail_with(mut self, failure: fn() -> Response) -> Self {
        self.failure = failure;
        self
    }
}

impl<S: HasChannelAccess> Handler<S> for ChannelGuard {
    fn call<'a>(&'a self, req: &'a mut Req<S>) -> BoxFuture<'a, Result<Flow, WebError>> {
        Box::pin(async move {
            let state = req.state_arc();
            let Some(user) = AuthenticatedUser::maybe(req).cloned() else {
                return Ok(Flow::Respond((self.refusal)()));
            };
            let channel = req.param(self.param).unwrap_or_default().to_owned();
            Ok(
                match state
                    .channel_access()
                    .scope(&user, &channel, self.need)
                    .await
                {
                    Ok(Ok(scope)) => {
                        req.extensions_mut().insert(scope);
                        Flow::Next
                    }
                    Ok(Err(_)) => Flow::Respond((self.refusal)()),
                    Err(_) => Flow::Respond((self.failure)()),
                },
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_legacy_grants() {
        assert_eq!(
            expand_channel_permission_checks(&["triggers:edit", "dimafx:view", "triggers:edit"]),
            [
                "*",
                "triggers:edit",
                "dimafx:view",
                "triggers:all",
                "dimafx:all"
            ]
        );
        assert_eq!(expand_channel_permission_checks::<&str>(&[]), ["*"]);
    }

    #[test]
    fn permission_list_limits() {
        assert_eq!(parse_permission_list(None), None);
        let many = (0..21)
            .map(|i| format!("p{i}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_permission_list(Some(&json!(many))), Some(vec![]));
        assert_eq!(
            parse_permission_list(Some(&json!(" a , b ,a"))),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(parse_permission_list(Some(&json!("ſ"))), Some(vec![]));
    }

    #[test]
    fn js_object_order() {
        let map = resolve_granted_permissions(&["*"], &["b", "10", "2", "a"]);
        let keys: Vec<&str> = map.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "b", "a"]);
    }

    #[test]
    fn creator_assignment() {
        let creator = Some(CREATOR_TWITCH_USER_ID);
        assert!(can_modify_creator_admin_assignment(
            Some("1"),
            Some("2"),
            Some("3")
        ));
        assert!(!can_modify_creator_admin_assignment(
            Some("1"),
            Some("2"),
            creator
        ));
        assert!(can_modify_creator_admin_assignment(
            Some("2"),
            Some("2"),
            creator
        ));
        assert!(can_modify_creator_admin_assignment(
            creator,
            Some("2"),
            creator
        ));
        assert!(can_modify_creator_admin_assignment(None, None, creator));
    }
}
