//! The channel role cache and identity resolution (reference: `utils/permissions/roles.ts`).
//!
//! Editors and admins come from Dragonfly sets that the API and cron keep current; badges give
//! the other roles. The key family is a *rebuilt* cache (`MIGRATION.md` section 3): its values
//! are this crate's own encoding and are repopulated from MongoDB and Twitch after a clean start.
//! [`RoleCache`] is the store boundary; its Dragonfly implementation belongs to the caller.

use std::future::Future;

use super::channel::grants_chat_admin_role;
use super::roles::{BROADCASTER_USER_LEVEL, RoleTag, UserIdentity, badge_level_of, badge_tags_of};

/// Time to live of the editor sets, in seconds (one day).
pub const ROLE_CACHE_TTL_SECONDS: u64 = 60 * 60 * 24;

/// `twitch:{channel}:editors`: editor logins.
pub fn editors_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}:editors")
}

/// `twitch:{channel}:editors:ids`: editor account ids.
pub fn editors_ids_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}:editors:ids")
}

/// `twitch:{channel}:admins`: logins of admins with the chat role.
pub fn admins_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}:admins")
}

/// `twitch:{channel}:admins:ids`: account ids of admins with the chat role.
pub fn admins_ids_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}:admins:ids")
}

/// `twitch:{channel}:admins:{admin}`: one admin's detail hash.
pub fn admin_detail_key(channel_id: &str, admin_id: &str) -> String {
    format!("twitch:{channel_id}:admins:{admin_id}")
}

/// `{channel}:channel:editors`: the editor key from before the `twitch:` namespace, deleted on
/// refresh.
pub fn legacy_editors_key(channel_id: &str) -> String {
    format!("{channel_id}:channel:editors")
}

/// The Dragonfly operations the role cache needs (`RoleCacheClient` in the reference).
pub trait RoleCache: Sync {
    /// A store failure.
    type Error: Send;

    /// `SISMEMBER key member`.
    fn is_member<'a>(
        &'a self,
        key: &'a str,
        member: &'a str,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// `SADD key member`.
    fn add<'a>(
        &'a self,
        key: &'a str,
        member: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `SREM key member`.
    fn remove<'a>(
        &'a self,
        key: &'a str,
        member: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `DEL keys...` (never called with an empty list).
    fn delete<'a>(
        &'a self,
        keys: &'a [String],
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// `EXPIRE key seconds`.
    fn expire<'a>(
        &'a self,
        key: &'a str,
        seconds: u64,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// The keys matching a glob pattern (the reference uses `KEYS`; a `SCAN` is equivalent).
    fn keys_matching<'a>(
        &'a self,
        pattern: &'a str,
    ) -> impl Future<Output = Result<Vec<String>, Self::Error>> + Send + 'a;

    /// `HSET key field value...`.
    fn set_hash<'a>(
        &'a self,
        key: &'a str,
        fields: &'a [(&'a str, String)],
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

/// One editor from the Helix editors endpoint.
#[derive(Debug, Clone, Copy)]
pub struct EditorEntry<'a> {
    /// Account id.
    pub user_id: &'a str,
    /// Login.
    pub user_login: &'a str,
}

/// One channel admin from MongoDB.
#[derive(Debug, Clone, Copy)]
pub struct AdminEntry<'a> {
    /// The admin's account id.
    pub admin_id: &'a str,
    /// The admin's login.
    pub admin_name: &'a str,
    /// The channel's login.
    pub channel_name: &'a str,
    /// The string items of the stored permission list (empty when it is not a list).
    pub permissions: &'a [String],
    /// Whether the admin is active (`actived`).
    pub actived: bool,
}

/// `refreshEditorCache`: replaces both editor sets (lowercase logins and account ids), sets
/// their time to live and deletes the legacy key.
pub async fn refresh_editor_cache<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    editors: &[EditorEntry<'_>],
) -> Result<(), C::Error> {
    let logins = editors_key(channel_id);
    let ids = editors_ids_key(channel_id);
    cache
        .delete(&[logins.clone(), ids.clone(), legacy_editors_key(channel_id)])
        .await?;
    for editor in editors {
        let login = dima_text::to_lower(editor.user_login);
        if !login.is_empty() {
            cache.add(&logins, &login).await?;
        }
        if !editor.user_id.is_empty() {
            cache.add(&ids, editor.user_id).await?;
        }
    }
    cache.expire(&logins, ROLE_CACHE_TTL_SECONDS).await?;
    cache.expire(&ids, ROLE_CACHE_TTL_SECONDS).await
}

/// The detail hash of one admin. `permissions` is a JSON array, as the reference writes it.
fn admin_detail<'a>(
    channel_id: &str,
    admin: &AdminEntry<'_>,
    admin_name: &str,
) -> [(&'a str, String); 6] {
    let permissions = serde_json::to_string(admin.permissions).unwrap_or_else(|_| "[]".into());
    [
        ("adminID", admin.admin_id.to_owned()),
        ("adminName", admin_name.to_owned()),
        ("channelID", channel_id.to_owned()),
        ("channelName", admin.channel_name.to_owned()),
        ("permissions", permissions),
        ("actived", admin.actived.to_string()),
    ]
}

async fn delete_admin_keys<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    mut keys: Vec<String>,
) -> Result<(), C::Error> {
    keys.extend(
        cache
            .keys_matching(&format!("twitch:{channel_id}:admins*"))
            .await?,
    );
    keys.extend(
        cache
            .keys_matching(&format!("{channel_id}:admins*"))
            .await?,
    );
    if keys.is_empty() {
        return Ok(());
    }
    cache.delete(&keys).await
}

/// `populateAdminCache`: clears the channel's admin keys (current and legacy) and rebuilds the
/// sets and detail hashes. Admins without an id or a login are skipped.
pub async fn populate_admin_cache<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    admins: &[AdminEntry<'_>],
) -> Result<(), C::Error> {
    delete_admin_keys(cache, channel_id, Vec::new()).await?;
    for admin in admins {
        let admin_name = dima_text::to_lower(admin.admin_name);
        if admin.admin_id.is_empty() || admin_name.is_empty() {
            continue;
        }
        if admin.actived && grants_chat_admin_role(admin.permissions) {
            cache.add(&admins_key(channel_id), &admin_name).await?;
            cache
                .add(&admins_ids_key(channel_id), admin.admin_id)
                .await?;
        }
        let fields = admin_detail(channel_id, admin, &admin_name);
        cache
            .set_hash(&admin_detail_key(channel_id, admin.admin_id), &fields)
            .await?;
    }
    Ok(())
}

/// `addAdminToRoleCache`: updates one admin's set membership and detail hash.
pub async fn add_admin_to_role_cache<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    admin: &AdminEntry<'_>,
) -> Result<(), C::Error> {
    let admin_name = dima_text::to_lower(admin.admin_name);
    if admin.admin_id.is_empty() || admin_name.is_empty() {
        return Ok(());
    }
    if admin.actived && grants_chat_admin_role(admin.permissions) {
        cache
            .add(&admins_ids_key(channel_id), admin.admin_id)
            .await?;
        cache.add(&admins_key(channel_id), &admin_name).await?;
    } else {
        cache
            .remove(&admins_ids_key(channel_id), admin.admin_id)
            .await?;
        cache.remove(&admins_key(channel_id), &admin_name).await?;
    }
    let fields = admin_detail(channel_id, admin, &admin_name);
    cache
        .set_hash(&admin_detail_key(channel_id, admin.admin_id), &fields)
        .await
}

/// `removeAdminFromRoleCache`.
pub async fn remove_admin_from_role_cache<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    admin_id: &str,
    admin_name: &str,
) -> Result<(), C::Error> {
    cache
        .delete(&[admin_detail_key(channel_id, admin_id)])
        .await?;
    cache
        .remove(&admins_key(channel_id), &dima_text::to_lower(admin_name))
        .await?;
    cache.remove(&admins_ids_key(channel_id), admin_id).await
}

/// `clearChannelRoleCache`: every editor and admin key of a removed channel.
pub async fn clear_channel_role_cache<C: RoleCache>(
    cache: &C,
    channel_id: &str,
) -> Result<(), C::Error> {
    let keys = vec![
        editors_key(channel_id),
        editors_ids_key(channel_id),
        legacy_editors_key(channel_id),
    ];
    delete_admin_keys(cache, channel_id, keys).await
}

/// `isEditorLoginCached`: editor membership by lowercase login (duel, vanish, roulette).
pub async fn is_editor_login_cached<C: RoleCache>(
    cache: &C,
    channel_id: &str,
    login: &str,
) -> Result<bool, C::Error> {
    let login = dima_text::to_lower(login);
    if login.is_empty() {
        return Ok(false);
    }
    cache.is_member(&editors_key(channel_id), &login).await
}

/// The author of a chat message, as identity resolution reads it.
#[derive(Debug, Clone, Copy)]
pub struct ChatAuthor<'a, I> {
    /// `chatter_user_id` (empty when absent).
    pub user_id: &'a str,
    /// `chatter_user_login` (empty when absent; lowercased here).
    pub login: &'a str,
    /// The badge set ids, in message order.
    pub badge_set_ids: I,
}

/// What [`resolve_user_identity`] found.
#[derive(Debug)]
pub struct Resolved<E> {
    /// The identity. On a role-cache failure it holds the badge roles only (fail closed).
    pub identity: UserIdentity,
    /// The role-cache failure, for the caller to log (through
    /// [`PermissionErrorLimiter`](super::PermissionErrorLimiter) with key
    /// `role-cache:{channel}`, as the reference does).
    pub cache_error: Option<E>,
}

/// `resolveUserIdentity`: level and tags from badges, then editor and admin membership from the
/// role cache (account id first, then login while the cache repopulates).
///
/// The broadcaster is recognised by the channel id alone and never touches the cache. A cache
/// failure keeps the badge roles and grants no cached role.
pub async fn resolve_user_identity<'a, C, I>(
    channel_id: &str,
    author: ChatAuthor<'a, I>,
    cache: &C,
) -> Resolved<C::Error>
where
    C: RoleCache,
    I: IntoIterator<Item = &'a str> + Clone,
{
    let mut level = badge_level_of(author.badge_set_ids.clone());
    let mut tags = badge_tags_of(author.badge_set_ids);
    let user_id = author.user_id;
    let login = dima_text::to_lower(author.login);

    if !user_id.is_empty() && user_id == channel_id {
        tags.push(RoleTag::Broadcaster);
        return Resolved {
            identity: UserIdentity::new(BROADCASTER_USER_LEVEL, tags, Some(user_id), Some(&login)),
            cache_error: None,
        };
    }

    let editors = (editors_ids_key(channel_id), editors_key(channel_id));
    let admins = (admins_ids_key(channel_id), admins_key(channel_id));
    let (is_editor, is_admin) = tokio::join!(
        has_cached_role(cache, &editors, user_id, &login),
        has_cached_role(cache, &admins, user_id, &login),
    );
    let mut cache_error = None;
    match (is_editor, is_admin) {
        (Ok(is_editor), Ok(is_admin)) => {
            if is_editor {
                level = level.max(8.0);
                tags.push(RoleTag::Editor);
            }
            if is_admin {
                level = level.max(9.0);
                tags.push(RoleTag::Admin);
            }
        }
        (Err(error), _) | (_, Err(error)) => cache_error = Some(error),
    }
    Resolved {
        identity: UserIdentity::new(level, tags, Some(user_id), Some(&login)),
        cache_error,
    }
}

async fn has_cached_role<C: RoleCache>(
    cache: &C,
    (ids_key, logins_key): &(String, String),
    user_id: &str,
    login: &str,
) -> Result<bool, C::Error> {
    if !user_id.is_empty() && cache.is_member(ids_key, user_id).await? {
        return Ok(true);
    }
    if !login.is_empty() && cache.is_member(logins_key, login).await? {
        return Ok(true);
    }
    Ok(false)
}
