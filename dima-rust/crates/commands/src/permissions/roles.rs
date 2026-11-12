//! Role tags, user identities and badge derivation (reference: `utils/permissions/roles.ts`).
//!
//! A chatter resolves to both a legacy numeric `level` (1 to 10, the highest role wins) and the
//! full set of role tags they hold. Tags are additive: a moderator who is also subscribed holds
//! both `mod` and `sub`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::value::{Js, JsView, js_string};

/// The level of the channel owner, and the highest level.
pub const BROADCASTER_USER_LEVEL: f64 = 10.0;

/// Badge set ids that identify a channel moderator.
pub const MODERATOR_BADGE_IDS: [&str; 2] = ["moderator", "lead_moderator"];

/// Every role tag, in the reference's order.
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

/// The canonical names of the legacy numeric levels.
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

/// A role a chatter can hold. The text form is lowercase and exact (`"mod"`, never `"Mod"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleTag {
    /// Every chatter.
    Everyone,
    /// A subscriber (founders are subscribers too).
    Sub,
    /// A VIP.
    Vip,
    /// A founder.
    Founder,
    /// A moderator or lead moderator.
    Mod,
    /// A channel editor (from the role cache).
    Editor,
    /// A channel admin with the chat role (from the role cache).
    Admin,
    /// The channel owner.
    Broadcaster,
}

impl RoleTag {
    /// The stored text.
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

    /// `isRoleTag`: the exact text of a tag.
    pub fn parse(text: &str) -> Option<Self> {
        ROLE_TAGS.into_iter().find(|tag| tag.as_str() == text)
    }

    /// `isRoleTag` on an untyped value: only a string with the exact text of a tag.
    pub fn from_js<V: JsView>(value: &V) -> Option<Self> {
        match value.js() {
            Js::String(text) => Self::parse(text),
            _ => None,
        }
    }
}

/// A resolved chatter: legacy level, role tags, and the account when known.
///
/// This is a trusted internal snapshot, not proof that the roles are real. There is no
/// `Deserialize`: untyped input goes through [`parse_user_identity`], which never adds roles.
#[derive(Debug, Clone, PartialEq)]
pub struct UserIdentity {
    level: f64,
    /// Insertion-ordered, without duplicates; always holds `everyone`.
    tags: Vec<RoleTag>,
    user_id: Option<String>,
    login: Option<String>,
}

impl UserIdentity {
    /// `createUserIdentity`: the level as given (no clamp), the tags in order without
    /// duplicates and `everyone` appended when missing; an empty account id or login is
    /// omitted, and the login is lowercased (JavaScript `toLowerCase`).
    pub fn new(
        level: f64,
        tags: impl IntoIterator<Item = RoleTag>,
        user_id: Option<&str>,
        login: Option<&str>,
    ) -> Self {
        let mut unique = Vec::with_capacity(ROLE_TAGS.len());
        for tag in tags {
            insert_tag(&mut unique, tag);
        }
        insert_tag(&mut unique, RoleTag::Everyone);
        Self {
            level,
            tags: unique,
            user_id: user_id.filter(|id| !id.is_empty()).map(str::to_owned),
            login: login
                .filter(|login| !login.is_empty())
                .map(dima_text::to_lower),
        }
    }

    /// The legacy level.
    pub fn level(&self) -> f64 {
        self.level
    }

    /// The tags, in insertion order.
    pub fn tags(&self) -> &[RoleTag] {
        &self.tags
    }

    /// The Twitch account id, when known.
    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }

    /// The lowercase login, when known.
    pub fn login(&self) -> Option<&str> {
        self.login.as_deref()
    }

    /// Whether the chatter holds `tag`.
    pub fn has_tag(&self, tag: RoleTag) -> bool {
        self.tags.contains(&tag)
    }

    /// `serializeUserIdentity`: `{level, tags, userId?, login?}`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("level".into(), number_value(self.level));
        object.insert(
            "tags".into(),
            Value::Array(
                self.tags
                    .iter()
                    .map(|tag| Value::String(tag.as_str().into()))
                    .collect(),
            ),
        );
        if let Some(id) = &self.user_id {
            object.insert("userId".into(), Value::String(id.clone()));
        }
        if let Some(login) = &self.login {
            object.insert("login".into(), Value::String(login.clone()));
        }
        Value::Object(object)
    }
}

impl Default for UserIdentity {
    fn default() -> Self {
        create_default_identity()
    }
}

/// A JSON number; a non-finite level (impossible from the parsers here) becomes `null`, as
/// `JSON.stringify` writes it.
fn number_value(number: f64) -> Value {
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

fn insert_tag(tags: &mut Vec<RoleTag>, tag: RoleTag) {
    if !tags.contains(&tag) {
        tags.push(tag);
    }
}

/// `createDefaultIdentity`: level 1, `everyone`.
pub fn create_default_identity() -> UserIdentity {
    UserIdentity::new(1.0, [], None, None)
}

/// `createBroadcasterIdentity`: the trusted identity for streamer-authored command execution.
pub fn create_broadcaster_identity() -> UserIdentity {
    UserIdentity::new(BROADCASTER_USER_LEVEL, [RoleTag::Broadcaster], None, None)
}

/// `^\d{1,20}$` (ASCII digits): a Twitch account id.
pub(crate) fn is_account_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// `^[a-zA-Z0-9_]{1,25}$`: a Twitch login.
pub(crate) fn is_login(login: &str) -> bool {
    (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `parseUserIdentity`: rebuilds a serialized identity. Anything malformed falls back to
/// `fallback_level` with no extra tags, so it never fabricates a role it was not given. Only a
/// finite numeric level is truncated and clamped to 1..10; the fallback is used as given.
pub fn parse_user_identity<V: JsView>(raw: Option<&V>, fallback_level: f64) -> UserIdentity {
    let Some(raw) = raw.filter(|raw| matches!(raw.js(), Js::Object | Js::Array(_) | Js::Other))
    else {
        return UserIdentity::new(fallback_level, [], None, None);
    };
    let level = match raw.get("level").map(JsView::js) {
        Some(Js::Number(level)) if level.is_finite() => {
            level.trunc().clamp(1.0, BROADCASTER_USER_LEVEL)
        }
        _ => fallback_level,
    };
    let tags: Vec<RoleTag> = match raw.get("tags").map(JsView::js) {
        Some(Js::Array(items)) => items.iter().filter_map(RoleTag::from_js).collect(),
        _ => Vec::new(),
    };
    let user_id = match raw.get("userId").map(JsView::js) {
        Some(Js::String(id)) if is_account_id(id) => Some(id),
        _ => None,
    };
    let login = match raw.get("login").map(JsView::js) {
        Some(Js::String(login)) if is_login(login) => Some(login),
        _ => None,
    };
    UserIdentity::new(level, tags, user_id, login)
}

/// The set id of each badge: `String(badge?.set_id ?? badge?.id ?? '')`.
fn badge_set_ids<V: JsView>(badges: &V) -> Vec<String> {
    let Js::Array(items) = badges.js() else {
        return Vec::new();
    };
    let present = |value: Option<&V>| -> Option<String> {
        value
            .filter(|value| !matches!(value.js(), Js::Null | Js::Undefined))
            .map(js_string)
    };
    items
        .iter()
        .map(|badge| {
            present(badge.get("set_id"))
                .or_else(|| present(badge.get("id")))
                .unwrap_or_default()
        })
        .collect()
}

fn badge_level(set_id: &str) -> f64 {
    match set_id {
        "subscriber" => 2.0,
        "vip" => 5.0,
        "founder" => 6.0,
        "moderator" | "lead_moderator" => 7.0,
        _ => 1.0,
    }
}

fn add_badge_tags(tags: &mut Vec<RoleTag>, set_id: &str) {
    match set_id {
        "subscriber" => insert_tag(tags, RoleTag::Sub),
        "vip" => insert_tag(tags, RoleTag::Vip),
        "founder" => {
            insert_tag(tags, RoleTag::Founder);
            insert_tag(tags, RoleTag::Sub);
        }
        "moderator" | "lead_moderator" => insert_tag(tags, RoleTag::Mod),
        _ => {}
    }
}

/// `deriveBadgeLevel` from badge set ids: subscriber 2, vip 5, founder 6, moderator 7; the
/// highest wins, 1 without any.
pub fn badge_level_of<'a>(set_ids: impl IntoIterator<Item = &'a str>) -> f64 {
    set_ids.into_iter().map(badge_level).fold(1.0, f64::max)
}

/// `deriveBadgeTags` from badge set ids (editor and admin come from the role cache).
pub fn badge_tags_of<'a>(set_ids: impl IntoIterator<Item = &'a str>) -> Vec<RoleTag> {
    let mut tags = Vec::new();
    for set_id in set_ids {
        add_badge_tags(&mut tags, set_id);
    }
    tags
}

/// `deriveBadgeLevel` on an untyped badge list (anything that is not an array has no badges).
pub fn derive_badge_level<V: JsView>(badges: &V) -> f64 {
    badge_level_of(badge_set_ids(badges).iter().map(String::as_str))
}

/// `deriveBadgeTags` on an untyped badge list.
pub fn derive_badge_tags<V: JsView>(badges: &V) -> Vec<RoleTag> {
    badge_tags_of(badge_set_ids(badges).iter().map(String::as_str))
}
