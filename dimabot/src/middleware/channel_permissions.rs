//! Working native port of `dimabot/src/middleware/channel_permissions.ts`.
//!
//! The two exported constants and both exported functions are declarative
//! policy with no I/O: assignable channel-admin grants, the website switcher
//! grant pair, the `manage` → `view` implications, the implicit
//! `dashboard:view` shell grant, and the chat-role grant check.
//!
//! Both a typed slice adapter and a JSON adapter are provided. Routes that
//! already hold a typed list use [`parse_channel_admin_permissions`]; a request
//! body decoded from JSON uses [`parse_channel_admin_permissions_json`], which
//! preserves the source's `unknown` handling (non-array and non-string entries
//! fail closed). No prototype hooks, getters or other JavaScript object
//! internals are emulated.

use serde_json::Value;

/// Permissions that a broadcaster may assign to a channel admin.
pub const CHANNEL_ADMIN_PERMISSIONS: &[&str] = &[
    "dashboard:view",
    "analytics:view",
    "billing:view",
    "referrals:view",
    "summaries:view",
    "clips:view",
    "clips:manage",
    "commands:view",
    "commands:manage",
    "triggers:view",
    "triggers:upload",
    "triggers:attach",
    "triggers:edit",
    "triggers:delete",
    "settings:view",
    "settings:manage",
    "tts:view",
    "tts:manage",
    "moderation:view",
    "moderation:manage",
    "eventsubs:view",
    "eventsubs:manage",
    "rewards:view",
    "rewards:manage",
    "ai:view",
    "ai:manage",
    "memories:view",
    "memories:manage",
    "dimafx:view",
    "dimafx:edit",
    "dimafx:delete",
    "admins:view",
    "chat:admin",
];

/// A channel appears in the website's admin switcher only with dashboard access.
pub const CHANNEL_WEBSITE_ACCESS_PERMISSIONS: &[&str] = &["*", "dashboard:view"];

/// `manage`-style grants that imply their read grant.
const MANAGE_REQUIRES_VIEW: &[(&str, &str)] = &[
    ("commands:manage", "commands:view"),
    ("clips:manage", "clips:view"),
    ("admins:view", "settings:view"),
    ("triggers:upload", "triggers:view"),
    ("triggers:attach", "triggers:view"),
    ("triggers:edit", "triggers:view"),
    ("triggers:delete", "triggers:view"),
    ("settings:manage", "settings:view"),
    ("tts:manage", "tts:view"),
    ("moderation:manage", "moderation:view"),
    ("eventsubs:manage", "eventsubs:view"),
    ("rewards:manage", "rewards:view"),
    ("ai:manage", "ai:view"),
    ("memories:manage", "memories:view"),
    ("dimafx:edit", "dimafx:view"),
    ("dimafx:delete", "dimafx:view"),
];

fn required_view(permission: &str) -> Option<&'static str> {
    MANAGE_REQUIRES_VIEW
        .iter()
        .find(|(grant, _)| *grant == permission)
        .map(|(_, view)| *view)
}

/// `parseChannelAdminPermissions` for an already-typed grant list.
///
/// `None` for an empty list, an over-long list, a non-assignable name, a
/// wildcard mixed with other grants, or a role-defining grant, matching the
/// source's fail-closed result. `["*"]` stays the single wildcard grant;
/// `manage` grants gain their `view` grant, and any website grant gains
/// `dashboard:view` (a chat-only admin keeps no website access).
pub fn parse_channel_admin_permissions(value: &[String]) -> Option<Vec<String>> {
    if value.is_empty() || value.len() > CHANNEL_ADMIN_PERMISSIONS.len() {
        return None;
    }
    if value.len() == 1 && value[0] == "*" {
        return Some(vec!["*".to_owned()]);
    }
    if value
        .iter()
        .any(|item| !CHANNEL_ADMIN_PERMISSIONS.contains(&item.as_str()))
    {
        return None;
    }
    let mut permissions: Vec<String> = Vec::with_capacity(value.len() + 2);
    for item in value {
        if !permissions.iter().any(|existing| existing == item) {
            permissions.push(item.clone());
        }
    }
    // The source iterates a snapshot, so implied grants may imply nothing
    // further and are appended in a stable order.
    let snapshot = permissions.clone();
    for permission in snapshot {
        if let Some(view) = required_view(&permission)
            && !permissions.iter().any(|existing| existing == view)
        {
            permissions.push(view.to_owned());
        }
    }
    if permissions
        .iter()
        .any(|permission| permission != "chat:admin")
        && !permissions
            .iter()
            .any(|permission| permission == "dashboard:view")
    {
        permissions.insert(0, "dashboard:view".to_owned());
    }
    Some(permissions)
}

/// `parseChannelAdminPermissions` for a decoded JSON request body value.
pub fn parse_channel_admin_permissions_json(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    let mut values: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        values.push(item.as_str()?.to_owned());
    }
    parse_channel_admin_permissions(&values)
}

/// `grantsChatAdminRole` for an already-typed grant list.
pub fn grants_chat_admin_role(permissions: &[String]) -> bool {
    permissions
        .iter()
        .any(|permission| permission == "*" || permission == "chat:admin")
}

/// `grantsChatAdminRole` for a decoded JSON value; non-arrays grant nothing.
pub fn grants_chat_admin_role_json(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    items
        .iter()
        .any(|item| matches!(item.as_str(), Some("*") | Some("chat:admin")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn full_access_remains_the_single_wildcard_grant() {
        assert_eq!(
            parse_channel_admin_permissions(&list(&["*"])),
            Some(list(&["*"]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["*", "commands:view"])),
            None
        );
        assert!(grants_chat_admin_role(&list(&["*"])));
        assert_eq!(CHANNEL_ADMIN_PERMISSIONS.len(), 33);
    }

    #[test]
    fn custom_manage_permissions_include_their_view_and_dashboard_grants() {
        assert_eq!(
            parse_channel_admin_permissions(&list(&["commands:manage"])),
            Some(list(&[
                "dashboard:view",
                "commands:manage",
                "commands:view",
            ]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["tts:manage"])),
            Some(list(&["dashboard:view", "tts:manage", "tts:view"]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["admins:view"])),
            Some(list(&["dashboard:view", "admins:view", "settings:view"]))
        );
        assert!(!grants_chat_admin_role(&list(&[
            "dashboard:view",
            "commands:manage",
        ])));
        assert!(grants_chat_admin_role(&list(&["chat:admin"])));
    }

    #[test]
    fn tts_grants_are_independent_from_bot_settings_grants() {
        assert_eq!(
            parse_channel_admin_permissions(&list(&["tts:view"])),
            Some(list(&["dashboard:view", "tts:view"]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["settings:manage"])),
            Some(list(&[
                "dashboard:view",
                "settings:manage",
                "settings:view",
            ]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["tts:manage", "settings:view"])),
            Some(list(&[
                "dashboard:view",
                "tts:manage",
                "settings:view",
                "tts:view",
            ]))
        );
    }

    #[test]
    fn chat_and_website_permissions_are_independent() {
        assert_eq!(
            parse_channel_admin_permissions(&list(&["chat:admin"])),
            Some(list(&["chat:admin"]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["chat:admin", "commands:view"])),
            Some(list(&["dashboard:view", "chat:admin", "commands:view"]))
        );
        assert_eq!(
            parse_channel_admin_permissions(&list(&["commands:view"])),
            Some(list(&["dashboard:view", "commands:view"]))
        );
        assert!(!grants_chat_admin_role(&list(&["commands:view"])));
        assert!(grants_chat_admin_role(&list(&["chat:admin"])));
        assert_eq!(
            CHANNEL_WEBSITE_ACCESS_PERMISSIONS,
            ["*", "dashboard:view"].as_slice()
        );
    }

    #[test]
    fn unknown_empty_and_malformed_grants_fail_closed() {
        for value in [
            json!([]),
            json!(["owner:everything"]),
            json!(["*", "chat:admin"]),
            json!(["dashboard:view", 7]),
            json!(null),
        ] {
            assert_eq!(parse_channel_admin_permissions_json(&value), None);
        }
        // Existing grants may contain a wildcard alongside another grant,
        // even though the assignment parser rejects that new configuration.
        assert!(grants_chat_admin_role_json(&json!(["*", "chat:admin"])));
        assert_eq!(
            parse_channel_admin_permissions_json(&json!(["triggers:delete"])),
            Some(list(&[
                "dashboard:view",
                "triggers:delete",
                "triggers:view",
            ]))
        );
        assert!(grants_chat_admin_role_json(&json!(["*"])));
    }

    #[test]
    fn duplicate_grants_collapse_in_source_order() {
        assert_eq!(
            parse_channel_admin_permissions(&list(
                &["commands:view", "commands:view", "tts:view",]
            )),
            Some(list(&["dashboard:view", "commands:view", "tts:view"]))
        );
        // An over-long list is rejected before duplicates collapse.
        let over_long: Vec<String> = (0..34).map(|_| "commands:view".to_owned()).collect();
        assert_eq!(parse_channel_admin_permissions(&over_long), None);
    }
}
