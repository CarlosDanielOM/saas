//! Ported from `utils/permissions/roles.test.ts`, `role_cache.test.ts` and
//! `expression.test.ts` (the cases the corpus does not cover), plus hostile input.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use dima_commands::permissions::{
    self, AdminEntry, ChatAuthor, CompiledPermission, EditorEntry, ROLE_CACHE_TTL_SECONDS,
    RoleCache, RoleTag, UserIdentity, admin_detail_key, admins_ids_key, admins_key,
    editors_ids_key, editors_key, legacy_editors_key,
};
use serde_json::{Value, json};

/// `fake_role_cache.ts`.
#[derive(Default)]
struct FakeRoleCache {
    sets: Mutex<BTreeMap<String, BTreeSet<String>>>,
    hashes: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    expirations: Mutex<BTreeMap<String, u64>>,
    /// Keys whose membership reads fail.
    failing: Vec<&'static str>,
    /// Membership reads served.
    reads: Mutex<usize>,
}

impl FakeRoleCache {
    fn set_members(&self, key: &str, members: &[&str]) {
        self.sets.lock().unwrap().insert(
            key.into(),
            members.iter().map(|member| (*member).to_owned()).collect(),
        );
    }

    fn members(&self, key: &str) -> Vec<String> {
        self.sets
            .lock()
            .unwrap()
            .get(key)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn hash(&self, key: &str) -> BTreeMap<String, String> {
        self.hashes
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or_default()
    }

    fn has_set(&self, key: &str) -> bool {
        self.sets.lock().unwrap().contains_key(key)
    }
}

fn glob(pattern: &str, key: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == key,
        Some((head, tail)) => {
            key.starts_with(head)
                && (0..=key.len() - head.len()).any(|skip| {
                    key.get(head.len() + skip..)
                        .is_some_and(|rest| glob(tail, rest))
                })
        }
    }
}

impl RoleCache for FakeRoleCache {
    type Error = String;

    async fn is_member(&self, key: &str, member: &str) -> Result<bool, String> {
        *self.reads.lock().unwrap() += 1;
        if self.failing.iter().any(|part| key.contains(part)) {
            return Err(format!("read of {key} failed"));
        }
        Ok(self
            .sets
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|set| set.contains(member)))
    }

    async fn add(&self, key: &str, member: &str) -> Result<(), String> {
        self.sets
            .lock()
            .unwrap()
            .entry(key.into())
            .or_default()
            .insert(member.into());
        Ok(())
    }

    async fn remove(&self, key: &str, member: &str) -> Result<(), String> {
        let mut sets = self.sets.lock().unwrap();
        if let Some(set) = sets.get_mut(key) {
            set.remove(member);
            if set.is_empty() {
                sets.remove(key);
            }
        }
        Ok(())
    }

    async fn delete(&self, keys: &[String]) -> Result<(), String> {
        assert!(!keys.is_empty(), "DEL with no keys");
        for key in keys {
            self.sets.lock().unwrap().remove(key);
            self.hashes.lock().unwrap().remove(key);
            self.expirations.lock().unwrap().remove(key);
        }
        Ok(())
    }

    async fn expire(&self, key: &str, seconds: u64) -> Result<(), String> {
        self.expirations.lock().unwrap().insert(key.into(), seconds);
        Ok(())
    }

    async fn keys_matching(&self, pattern: &str) -> Result<Vec<String>, String> {
        let mut keys: BTreeSet<String> = BTreeSet::new();
        keys.extend(self.sets.lock().unwrap().keys().cloned());
        keys.extend(self.hashes.lock().unwrap().keys().cloned());
        keys.extend(self.expirations.lock().unwrap().keys().cloned());
        Ok(keys.into_iter().filter(|key| glob(pattern, key)).collect())
    }

    async fn set_hash(&self, key: &str, fields: &[(&str, String)]) -> Result<(), String> {
        let mut hashes = self.hashes.lock().unwrap();
        let hash = hashes.entry(key.into()).or_default();
        for (field, value) in fields {
            hash.insert((*field).into(), value.clone());
        }
        Ok(())
    }
}

const CHANNEL: &str = "12345";

fn sorted(identity: &UserIdentity) -> Vec<&'static str> {
    let mut tags: Vec<_> = identity.tags().iter().map(|tag| tag.as_str()).collect();
    tags.sort_unstable();
    tags
}

async fn resolve(cache: &FakeRoleCache, badges: &[&str], user: &str, login: &str) -> UserIdentity {
    let author = ChatAuthor {
        user_id: user,
        login,
        badge_set_ids: badges.iter().copied(),
    };
    permissions::resolve_user_identity("channel-1", author, cache)
        .await
        .identity
}

async fn viewer(cache: &FakeRoleCache, badges: &[&str]) -> UserIdentity {
    resolve(cache, badges, "user-1", "viewer").await
}

#[tokio::test]
async fn default_chatter_resolves_to_level_1_with_only_the_everyone_tag() {
    let identity = viewer(&FakeRoleCache::default(), &[]).await;
    assert_eq!(identity.level(), 1.0);
    assert_eq!(sorted(&identity), ["everyone"]);
    assert_eq!(identity.user_id(), Some("user-1"));
    assert_eq!(identity.login(), Some("viewer"));
}

#[tokio::test]
async fn badges_map_to_levels_and_tags() {
    let cache = FakeRoleCache::default();
    for (badges, level, tags) in [
        (&["subscriber"][..], 2.0, &["everyone", "sub"][..]),
        (&["vip"], 5.0, &["everyone", "vip"]),
        (&["founder"], 6.0, &["everyone", "founder", "sub"]),
        (&["moderator"], 7.0, &["everyone", "mod"]),
        (&["lead_moderator"], 7.0, &["everyone", "mod"]),
        (
            &["subscriber", "moderator"],
            7.0,
            &["everyone", "mod", "sub"],
        ),
    ] {
        let identity = viewer(&cache, badges).await;
        assert_eq!(identity.level(), level, "{badges:?}");
        assert_eq!(sorted(&identity), tags, "{badges:?}");
    }
}

#[tokio::test]
async fn the_broadcaster_keeps_numeric_override_at_10_plus_the_broadcaster_tag() {
    let cache = FakeRoleCache {
        failing: vec![":"],
        ..FakeRoleCache::default()
    };
    cache.set_members(&editors_ids_key("channel-1"), &["channel-1"]);
    let identity = resolve(&cache, &[], "channel-1", "Streamer").await;
    assert_eq!(identity.level(), 10.0);
    assert_eq!(sorted(&identity), ["broadcaster", "everyone"]);
    assert_eq!(identity.login(), Some("streamer"));
    assert_eq!(
        *cache.reads.lock().unwrap(),
        0,
        "the broadcaster bypasses cache reads"
    );
}

#[tokio::test]
async fn a_role_cache_read_failure_falls_back_to_badge_roles_without_blocking_the_message() {
    let cache = FakeRoleCache {
        failing: vec![":admins"],
        ..FakeRoleCache::default()
    };
    cache.set_members(&editors_ids_key("channel-1"), &["user-1"]);
    let author = ChatAuthor {
        user_id: "user-1",
        login: "viewer",
        badge_set_ids: ["subscriber", "moderator"],
    };
    let resolved = permissions::resolve_user_identity("channel-1", author, &cache).await;
    assert_eq!(resolved.identity.level(), 7.0);
    assert_eq!(sorted(&resolved.identity), ["everyone", "mod", "sub"]);
    assert!(resolved.cache_error.is_some());
}

#[tokio::test]
async fn editor_and_admin_membership_by_id_then_login() {
    let cache = FakeRoleCache::default();
    cache.set_members(&editors_ids_key("channel-1"), &["user-1"]);
    cache.set_members(&editors_key("channel-1"), &["somebodyelse"]);
    let identity = viewer(&cache, &[]).await;
    assert_eq!(
        (identity.level(), sorted(&identity)),
        (8.0, vec!["editor", "everyone"])
    );

    let cache = FakeRoleCache::default();
    cache.set_members(&editors_key("channel-1"), &["viewer"]);
    assert_eq!(viewer(&cache, &[]).await.level(), 8.0);

    let cache = FakeRoleCache::default();
    cache.set_members(&admins_ids_key("channel-1"), &["user-1"]);
    cache.set_members(&admins_key("channel-1"), &["somebodyelse"]);
    let identity = viewer(&cache, &[]).await;
    assert_eq!(
        (identity.level(), sorted(&identity)),
        (9.0, vec!["admin", "everyone"])
    );

    let cache = FakeRoleCache::default();
    cache.set_members(&admins_key("channel-1"), &["viewer"]);
    // The login is lowercased before the lookup.
    let identity = resolve(&cache, &[], "", "VIEWER").await;
    assert_eq!(identity.level(), 9.0);
    assert_eq!(identity.user_id(), None);

    let cache = FakeRoleCache::default();
    cache.set_members(&editors_ids_key("channel-1"), &["user-1"]);
    cache.set_members(&admins_ids_key("channel-1"), &["user-1"]);
    let identity = viewer(&cache, &["moderator"]).await;
    assert_eq!(identity.level(), 9.0);
    assert_eq!(sorted(&identity), ["admin", "editor", "everyone", "mod"]);
}

#[test]
fn identity_constructors() {
    let owner = permissions::create_broadcaster_identity();
    assert_eq!(
        (owner.level(), sorted(&owner)),
        (10.0, vec!["broadcaster", "everyone"])
    );
    assert_eq!(
        permissions::create_default_identity().tags(),
        [RoleTag::Everyone]
    );
    assert_eq!(
        UserIdentity::new(5.0, [], None, None).tags(),
        [RoleTag::Everyone]
    );
    assert_eq!(
        UserIdentity::new(5.0, [RoleTag::Vip], None, None).tags(),
        [RoleTag::Vip, RoleTag::Everyone]
    );
}

#[test]
fn serialized_identities_round_trip_and_garbage_never_fabricates_roles() {
    let identity = UserIdentity::new(
        7.0,
        [RoleTag::Mod, RoleTag::Sub],
        Some("12345"),
        Some("User123"),
    );
    let parsed = permissions::parse_user_identity(Some(&identity.to_json()), 1.0);
    assert_eq!(parsed, identity);
    assert_eq!(parsed.login(), Some("user123"));
    for bad in [
        Value::Null,
        json!("mod"),
        json!(7),
        json!({}),
        json!({"level": "nine"}),
        json!({"level": 3, "tags": "sub"}),
    ] {
        let parsed = permissions::parse_user_identity(Some(&bad), 3.0);
        assert_eq!(parsed.level(), 3.0, "{bad}");
        assert_eq!(parsed.tags(), [RoleTag::Everyone], "{bad}");
    }
    assert_eq!(
        permissions::parse_user_identity(None::<&Value>, 3.0).level(),
        3.0
    );
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": 99})), 1.0).level(),
        10.0
    );
    assert_eq!(
        permissions::parse_user_identity(Some(&json!({"level": -5})), 1.0).level(),
        1.0
    );
}

fn admin<'a>(permissions: &'a [String], actived: bool) -> AdminEntry<'a> {
    AdminEntry {
        admin_id: "admin-9",
        admin_name: "NewAdmin",
        channel_name: "streamer",
        permissions,
        actived,
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[tokio::test]
async fn refresh_editor_cache_populates_both_sets_with_ttls_and_drops_stale_and_legacy_keys() {
    let cache = FakeRoleCache::default();
    cache.set_members(&editors_key(CHANNEL), &["stale"]);
    cache.set_members(&legacy_editors_key(CHANNEL), &["legacyeditor"]);
    let editors = [
        EditorEntry {
            user_id: "id-1",
            user_login: "FirstEditor",
        },
        EditorEntry {
            user_id: "id-2",
            user_login: "secondeditor",
        },
    ];
    permissions::refresh_editor_cache(&cache, CHANNEL, &editors)
        .await
        .unwrap();
    assert_eq!(
        cache.members(&editors_key(CHANNEL)),
        ["firsteditor", "secondeditor"]
    );
    assert_eq!(cache.members(&editors_ids_key(CHANNEL)), ["id-1", "id-2"]);
    let expirations = cache.expirations.lock().unwrap().clone();
    assert_eq!(
        expirations.get(&editors_key(CHANNEL)),
        Some(&ROLE_CACHE_TTL_SECONDS)
    );
    assert_eq!(
        expirations.get(&editors_ids_key(CHANNEL)),
        Some(&ROLE_CACHE_TTL_SECONDS)
    );
    assert!(!cache.has_set(&legacy_editors_key(CHANNEL)));

    permissions::refresh_editor_cache(&cache, CHANNEL, &[])
        .await
        .unwrap();
    assert!(cache.members(&editors_key(CHANNEL)).is_empty());
    assert!(cache.members(&editors_ids_key(CHANNEL)).is_empty());
}

#[tokio::test]
async fn populate_admin_cache_rebuilds_sets_and_details_clearing_stale_and_legacy_keys() {
    let cache = FakeRoleCache::default();
    cache.set_members(&admins_key(CHANNEL), &["staleadmin"]);
    cache.set_members(&admins_ids_key(CHANNEL), &["stale-id"]);
    cache.set_members(&format!("{CHANNEL}:admins"), &["legacy-admin"]);
    cache.set_members(&format!("{CHANNEL}:admins:ids"), &["legacy-admin-id"]);
    let star = strings(&["*"]);
    let none = strings(&[]);
    let admins = [
        AdminEntry {
            admin_id: "admin-1",
            admin_name: "FirstAdmin",
            channel_name: "streamer",
            permissions: &star,
            actived: true,
        },
        AdminEntry {
            admin_id: "admin-2",
            admin_name: "SecondAdmin",
            channel_name: "streamer",
            permissions: &none,
            actived: false,
        },
    ];
    permissions::populate_admin_cache(&cache, CHANNEL, &admins)
        .await
        .unwrap();
    assert_eq!(cache.members(&admins_key(CHANNEL)), ["firstadmin"]);
    assert_eq!(cache.members(&admins_ids_key(CHANNEL)), ["admin-1"]);
    let detail = cache.hash(&admin_detail_key(CHANNEL, "admin-1"));
    assert_eq!(detail["adminID"], "admin-1");
    assert_eq!(detail["adminName"], "firstadmin");
    assert_eq!(detail["channelID"], CHANNEL);
    assert_eq!(detail["permissions"], r#"["*"]"#);
    assert_eq!(detail["actived"], "true");
    assert_eq!(
        cache.hash(&admin_detail_key(CHANNEL, "admin-2"))["actived"],
        "false"
    );
    assert!(!cache.has_set(&format!("{CHANNEL}:admins")));
    assert!(!cache.has_set(&format!("{CHANNEL}:admins:ids")));
}

#[tokio::test]
async fn add_admin_follows_the_chat_role_and_remove_drops_everything() {
    let cache = FakeRoleCache::default();
    let star = strings(&["*"]);
    let view = strings(&["dashboard:view"]);
    let chat = strings(&["dashboard:view", "chat:admin"]);
    let web = strings(&["dashboard:view", "commands:manage"]);
    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&star, true))
        .await
        .unwrap();
    assert_eq!(cache.members(&admins_key(CHANNEL)), ["newadmin"]);
    assert_eq!(cache.members(&admins_ids_key(CHANNEL)), ["admin-9"]);
    assert_eq!(
        cache.hash(&admin_detail_key(CHANNEL, "admin-9"))["adminName"],
        "newadmin"
    );

    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&view, true))
        .await
        .unwrap();
    assert!(cache.members(&admins_ids_key(CHANNEL)).is_empty());
    assert!(cache.members(&admins_key(CHANNEL)).is_empty());
    assert_eq!(
        cache.hash(&admin_detail_key(CHANNEL, "admin-9"))["permissions"],
        r#"["dashboard:view"]"#
    );
    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&chat, true))
        .await
        .unwrap();
    assert_eq!(cache.members(&admins_ids_key(CHANNEL)), ["admin-9"]);
    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&web, true))
        .await
        .unwrap();
    assert!(cache.members(&admins_ids_key(CHANNEL)).is_empty());
    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&star, false))
        .await
        .unwrap();
    assert!(
        cache.members(&admins_ids_key(CHANNEL)).is_empty(),
        "inactive admins have no role"
    );

    permissions::add_admin_to_role_cache(&cache, CHANNEL, &admin(&star, true))
        .await
        .unwrap();
    permissions::remove_admin_from_role_cache(&cache, CHANNEL, "admin-9", "NewAdmin")
        .await
        .unwrap();
    assert!(cache.members(&admins_key(CHANNEL)).is_empty());
    assert!(cache.members(&admins_ids_key(CHANNEL)).is_empty());
    assert!(cache.hash(&admin_detail_key(CHANNEL, "admin-9")).is_empty());
}

#[tokio::test]
async fn clear_channel_role_cache_removes_current_and_legacy_keys() {
    let cache = FakeRoleCache::default();
    for key in [
        editors_key(CHANNEL),
        editors_ids_key(CHANNEL),
        legacy_editors_key(CHANNEL),
        admins_key(CHANNEL),
        admins_ids_key(CHANNEL),
        format!("{CHANNEL}:admins"),
        "other:admins".to_owned(),
    ] {
        cache.set_members(&key, &["x"]);
    }
    cache
        .set_hash(
            &admin_detail_key(CHANNEL, "admin-id"),
            &[("adminID", "admin-id".into())],
        )
        .await
        .unwrap();
    permissions::clear_channel_role_cache(&cache, CHANNEL)
        .await
        .unwrap();
    assert_eq!(cache.keys_matching("*").await.unwrap(), ["other:admins"]);
}

#[tokio::test]
async fn is_editor_login_cached_normalizes_logins() {
    let cache = FakeRoleCache::default();
    cache.set_members(&editors_key(CHANNEL), &["firsteditor"]);
    for (login, expected) in [
        ("FirstEditor", true),
        ("firsteditor", true),
        ("someoneelse", false),
        ("", false),
    ] {
        assert_eq!(
            permissions::is_editor_login_cached(&cache, CHANNEL, login)
                .await
                .unwrap(),
            expected,
            "{login}"
        );
    }
}

fn allowed(expression: Value, identity: &UserIdentity) -> bool {
    permissions::command_allowed(
        Some(&json!({ "permissionExpression": expression })),
        identity,
    )
}

#[test]
fn named_accounts_and_flat_precedence() {
    let named = UserIdentity::new(1.0, [], Some("12345"), Some("someone"));
    let vip = UserIdentity::new(5.0, [RoleTag::Vip], Some("55555"), None);
    let bad_vip = UserIdentity::new(5.0, [RoleTag::Vip], Some("67890"), None);
    let user = |id: &str| json!({ "user": { "id": id, "login": "x" } });
    // A named user can be allowed alongside VIPs and mods.
    let expression = json!({ "or": [{ "role": "vip" }, { "role": "mod" }, user("12345")] });
    assert!(allowed(expression.clone(), &named));
    assert!(allowed(expression.clone(), &vip));
    assert!(!allowed(
        expression,
        &UserIdentity::new(1.0, [], Some("1"), None)
    ));
    // A named user can be excluded from an everyone rule.
    let expression = json!({ "and": [{ "role": "everyone" }, { "not": user("12345") }] });
    assert!(!allowed(expression.clone(), &named));
    assert!(allowed(expression.clone(), &vip));
    // An unresolved account cannot pass a named exclusion.
    assert!(!allowed(
        expression,
        &UserIdentity::new(1.0, [], None, None)
    ));
    // An excluded account overrides an allowed VIP tag.
    let expression = json!({ "and": [{ "role": "vip" }, { "not": user("67890") }] });
    assert!(!allowed(expression.clone(), &bad_vip));
    assert!(allowed(expression, &vip));
    // An allowed account overrides an excluded Everyone tag.
    let expression = json!({ "and": [user("12345"), { "not": { "role": "everyone" } }] });
    assert!(allowed(expression.clone(), &named));
    assert!(!allowed(expression, &vip));
}

#[test]
fn present_invalid_expressions_fail_closed_even_at_level_10() {
    let owner = permissions::create_broadcaster_identity();
    for invalid in [
        json!({ "role": "supermod" }),
        json!([]),
        json!("mod"),
        json!({}),
    ] {
        let rule = json!({ "exemptExpression": invalid, "exemptUserLevel": 1 });
        assert!(!permissions::rule_exempt(Some(&rule), &owner), "{rule}");
        let compiled =
            CompiledPermission::compile(rule.get("exemptExpression"), rule.get("exemptUserLevel"));
        assert!(compiled.validation_error().is_some());
    }
}

/// Very long and deeply nested trees are refused after bounded work, without recursion below
/// the depth limit.
#[test]
fn hostile_expressions_are_refused_cheaply() {
    use bson::{Bson, Document};
    use std::time::Instant;
    let started = Instant::now();
    // 200,000 levels deep (built as BSON, which has no parser depth limit here).
    let mut deep = Bson::Document(bson::doc! { "role": "sub" });
    for _ in 0..200_000 {
        let mut node = Document::new();
        node.insert("not", deep);
        deep = Bson::Document(node);
    }
    let error = permissions::validate_expression(&deep).unwrap_err();
    assert_eq!(error.message, "expression exceeds maximum depth of 4");
    assert!(permissions::count_expression_nodes(&deep) > 200_000);
    // A million children.
    let wide = json!({ "or": vec![json!({ "role": "sub" }); 1_000_000] });
    let error = permissions::validate_expression(&wide).unwrap_err();
    assert_eq!(error.message, "expression exceeds maximum of 25 nodes");
    // A million keys on one node.
    let mut keys = serde_json::Map::new();
    keys.insert("role".into(), json!("sub"));
    for index in 0..1_000_000 {
        keys.insert(format!("k{index}"), Value::Null);
    }
    let error = permissions::validate_expression(&Value::Object(keys)).unwrap_err();
    assert!(
        error
            .message
            .starts_with("expression node has unknown fields: k0, k1")
    );
    assert!(
        started.elapsed().as_secs() < 30,
        "took {:?}",
        started.elapsed()
    );
    // Dropping a 200,000-level BSON tree recursively would overflow the stack: unwind it.
    let mut node = deep;
    while let Bson::Document(mut document) = node {
        node = document.remove("not").unwrap_or(Bson::Null);
    }
}
