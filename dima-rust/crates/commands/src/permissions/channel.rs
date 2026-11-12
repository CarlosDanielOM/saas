//! Channel-admin permission lists (reference: `middleware/channel_permissions.ts`).

use crate::value::{Js, JsView};

/// The permissions a broadcaster may give a channel admin, in the reference's order.
pub const CHANNEL_ADMIN_PERMISSIONS: [&str; 33] = [
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

/// A channel appears in the website's admin switcher only with one of these.
pub const CHANNEL_WEBSITE_ACCESS_PERMISSIONS: [&str; 2] = ["*", "dashboard:view"];

/// The view permission each managing permission needs.
fn required_view(permission: &str) -> Option<&'static str> {
    Some(match permission {
        "commands:manage" => "commands:view",
        "clips:manage" => "clips:view",
        "admins:view" => "settings:view",
        "triggers:upload" | "triggers:attach" | "triggers:edit" | "triggers:delete" => {
            "triggers:view"
        }
        "settings:manage" => "settings:view",
        "tts:manage" => "tts:view",
        "moderation:manage" => "moderation:view",
        "eventsubs:manage" => "eventsubs:view",
        "rewards:manage" => "rewards:view",
        "ai:manage" => "ai:view",
        "memories:manage" => "memories:view",
        "dimafx:edit" | "dimafx:delete" => "dimafx:view",
        _ => return None,
    })
}

fn assignable(permission: &str) -> Option<&'static str> {
    CHANNEL_ADMIN_PERMISSIONS
        .into_iter()
        .find(|known| *known == permission)
}

/// `parseChannelAdminPermissions`: `["*"]` alone, or known permissions without duplicates, each
/// managing permission followed by the view it needs, and `dashboard:view` first whenever a
/// website permission is present. `None` refuses the list.
pub fn parse_channel_admin_permissions<V: JsView>(value: &V) -> Option<Vec<&'static str>> {
    let Js::Array(items) = value.js() else {
        return None;
    };
    if items.is_empty() || items.len() > CHANNEL_ADMIN_PERMISSIONS.len() {
        return None;
    }
    if let [only] = items
        && matches!(only.js(), Js::String("*"))
    {
        return Some(vec!["*"]);
    }
    let mut permissions: Vec<&'static str> = Vec::with_capacity(items.len() + 4);
    for item in items {
        let Js::String(text) = item.js() else {
            return None;
        };
        let permission = assignable(text)?;
        if !permissions.contains(&permission) {
            permissions.push(permission);
        }
    }
    for index in 0..permissions.len() {
        if let Some(view) = permissions.get(index).copied().and_then(required_view)
            && !permissions.contains(&view)
        {
            permissions.push(view);
        }
    }
    if permissions
        .iter()
        .any(|permission| *permission != "chat:admin")
        && !permissions.contains(&"dashboard:view")
    {
        permissions.insert(0, "dashboard:view");
    }
    Some(permissions)
}

/// `grantsChatAdminRole` on a typed list: `*` or `chat:admin`.
pub fn grants_chat_admin_role<S: AsRef<str>>(permissions: &[S]) -> bool {
    permissions
        .iter()
        .any(|permission| matches!(permission.as_ref(), "*" | "chat:admin"))
}

/// `grantsChatAdminRole` on an untyped stored value (anything but an array grants nothing).
pub fn grants_chat_admin_role_js<V: JsView>(permissions: &V) -> bool {
    match permissions.js() {
        Js::Array(items) => items
            .iter()
            .any(|item| matches!(item.js(), Js::String("*" | "chat:admin"))),
        _ => false,
    }
}
