//! What the evaluator needs from the permission system: the three identity constructors of
//! `utils/permissions/roles.ts` that `resolveCommandRefAuthorization` uses.
//!
//! The permission system itself (`dima-commands`) implements [`Permissions`]; until it does,
//! [`ReferencePermissions`] is a faithful port of those three functions, so the engine is
//! complete and testable on its own.

use crate::context::{Identity, RoleTag};
use crate::value::Value;

/// The identity constructors the engine needs.
pub trait Permissions: Send + Sync {
    /// `createBroadcasterIdentity()`: level 10, tags `broadcaster` and `everyone`.
    fn broadcaster_identity(&self) -> Identity;

    /// `createUserIdentity(level)`: no tags but `everyone`, no id, no login.
    fn user_identity(&self, level: u8) -> Identity;

    /// `parseUserIdentity(raw, fallbackLevel)`: a stored identity read defensively; anything
    /// that is not an object gives the fallback level with no tags.
    fn parse_identity(&self, raw: &Value, fallback_level: u8) -> Identity;
}

/// The reference's own rules (`roles.ts`), used until `dima-commands` is connected.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReferencePermissions;

/// `BROADCASTER_USER_LEVEL`.
pub const BROADCASTER_LEVEL: u8 = 10;

/// `createUserIdentity(level, tags, userId, login)`: tags deduplicated in order, `everyone`
/// added, the login lowercased.
pub fn create_identity(
    level: u8,
    tags: impl IntoIterator<Item = RoleTag>,
    user_id: Option<String>,
    login: Option<String>,
) -> Identity {
    let mut set: Vec<RoleTag> = Vec::new();
    for tag in tags.into_iter().chain([RoleTag::Everyone]) {
        if !set.contains(&tag) {
            set.push(tag);
        }
    }
    Identity {
        level,
        tags: set,
        user_id: user_id.filter(|id| !id.is_empty()),
        login: login
            .filter(|login| !login.is_empty())
            .map(|login| dima_text::to_lower(&login)),
    }
}

impl Permissions for ReferencePermissions {
    fn broadcaster_identity(&self) -> Identity {
        create_identity(BROADCASTER_LEVEL, [RoleTag::Broadcaster], None, None)
    }

    fn user_identity(&self, level: u8) -> Identity {
        create_identity(level, [], None, None)
    }

    fn parse_identity(&self, raw: &Value, fallback_level: u8) -> Identity {
        let Value::Object(_) = raw else {
            return create_identity(fallback_level, [], None, None);
        };
        let level = match raw.get("level") {
            Some(Value::Number(level)) if level.is_finite() => {
                // Math.max(1, Math.min(10, Math.trunc(level)))
                level.trunc().clamp(1.0, f64::from(BROADCASTER_LEVEL)) as u8
            }
            _ => fallback_level,
        };
        let tags: Vec<RoleTag> = match raw.get("tags") {
            Some(Value::List(items)) => items
                .iter()
                .filter_map(|item| item.as_str().and_then(RoleTag::parse))
                .collect(),
            _ => Vec::new(),
        };
        let user_id = raw
            .get("userId")
            .and_then(Value::as_str)
            .filter(|id| (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()))
            .map(str::to_owned);
        let login = raw
            .get("login")
            .and_then(Value::as_str)
            .filter(|login| {
                (1..=25).contains(&login.len())
                    && login
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .map(str::to_owned);
        create_identity(level, tags, user_id, login)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_roles_ts() {
        let raw = Value::object(vec![
            ("level".into(), Value::Number(7.8)),
            (
                "tags".into(),
                Value::List(vec![
                    Value::text("mod"),
                    Value::text("INVALID"),
                    Value::text("mod"),
                ]),
            ),
            ("userId".into(), Value::text("1234")),
            ("login".into(), Value::text("UPPER")),
        ]);
        let identity = ReferencePermissions.parse_identity(&raw, 3);
        assert_eq!(identity.level, 7);
        assert_eq!(identity.tags, [RoleTag::Mod, RoleTag::Everyone]);
        assert_eq!(identity.user_id.as_deref(), Some("1234"));
        assert_eq!(identity.login.as_deref(), Some("upper"));
        let bad = Value::object(vec![
            ("level".into(), Value::Number(f64::NAN)),
            ("userId".into(), Value::text("bad!")),
            ("login".into(), Value::text("bad!")),
        ]);
        let identity = ReferencePermissions.parse_identity(&bad, 2);
        assert_eq!(
            (identity.level, identity.user_id, identity.login),
            (2, None, None)
        );
        assert_eq!(
            ReferencePermissions.parse_identity(&Value::Null, 4).level,
            4
        );
        let broadcaster = ReferencePermissions.broadcaster_identity();
        assert_eq!(broadcaster.tags, [RoleTag::Broadcaster, RoleTag::Everyone]);
        assert_eq!(
            ReferencePermissions
                .parse_identity(
                    &Value::object(vec![("level".into(), Value::Number(-100.0))]),
                    4
                )
                .level,
            1
        );
    }
}
