//! What the evaluator needs from the permission system: the identity a command reference runs
//! with (`resolveCommandRefAuthorization`). The rules are `dima-commands`' port of
//! `utils/permissions/roles.ts` ([`create_broadcaster_identity`], [`parse_user_identity`],
//! [`UserIdentity`]); this module only lets those rules read the engine's [`Value`].

pub use dima_commands::permissions::{
    BROADCASTER_USER_LEVEL, RoleTag, UserIdentity, create_broadcaster_identity, parse_user_identity,
};

use crate::value::Value;
use dima_commands::value::{Js, JsView};

impl JsView for Value {
    fn js(&self) -> Js<'_, Self> {
        match self {
            Self::Undefined => Js::Undefined,
            Self::Null => Js::Null,
            Self::Bool(flag) => Js::Bool(*flag),
            Self::Number(number) => Js::Number(*number),
            Self::Text(text) => Js::String(text),
            Self::List(items) => Js::Array(items),
            Self::Object(_) => Js::Object,
        }
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            Self::Object(entries) => entries.iter().map(|(key, _)| key.as_str()).collect(),
            _ => Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&Self> {
        Value::get(self, key)
    }
}

/// `createUserIdentity(level)`: no tags but `everyone`, no account.
pub fn user_identity(level: f64) -> UserIdentity {
    UserIdentity::new(level, [], None, None)
}

/// `parseUserIdentity(raw, fallbackLevel)` on a stored identity of any shape.
pub fn parse_identity(raw: &Value, fallback_level: f64) -> UserIdentity {
    parse_user_identity(Some(raw), fallback_level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_engine_values_like_roles_ts() {
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
        let identity = parse_identity(&raw, 3.0);
        assert_eq!(identity.level(), 7.0);
        assert_eq!(identity.tags(), [RoleTag::Mod, RoleTag::Everyone]);
        assert_eq!(identity.user_id(), Some("1234"));
        assert_eq!(identity.login(), Some("upper"));
        let bad = Value::object(vec![
            ("level".into(), Value::Number(f64::NAN)),
            ("userId".into(), Value::text("bad!")),
            ("login".into(), Value::text("bad!")),
        ]);
        let identity = parse_identity(&bad, 2.0);
        assert_eq!(
            (identity.level(), identity.user_id(), identity.login()),
            (2.0, None, None)
        );
        assert_eq!(parse_identity(&Value::Null, 4.0).level(), 4.0);
        // An array is an object to `typeof`; it has no level, tags or account.
        let list = Value::List(vec![Value::text("mod")]);
        assert_eq!(parse_identity(&list, 4.0), user_identity(4.0));
        assert_eq!(
            create_broadcaster_identity().tags(),
            [RoleTag::Broadcaster, RoleTag::Everyone]
        );
        let low = Value::object(vec![("level".into(), Value::Number(-100.0))]);
        assert_eq!(parse_identity(&low, 4.0).level(), 1.0);
    }
}
