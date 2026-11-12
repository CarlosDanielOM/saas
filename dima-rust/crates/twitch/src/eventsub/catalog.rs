//! The built-in chat events (`utils/chat_event_catalog.ts`): catalog entries the site shows even
//! when the `events` collection has none for their type. The objects are the reference's, key
//! for key in the reference's order (the API sends them to the site as they are).

use serde_json::{Value, json};
use std::sync::LazyLock;

/// `MODIVERSARY_MESSAGES.en` (`chat_notification_defaults.ts`).
pub const MODIVERSARY_MESSAGE_EN: &str =
    "Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!";

fn chat_notification_event() -> Value {
    json!({
        "name": "Chat Notifications",
        "type": "channel.chat.notification",
        "version": "1",
        "condition": { "broadcaster_user_id": "user", "user_id": "moderator" },
        "icon": "Trophy",
        "color": "#7c3aed",
        "textColor": "#ffffff",
        "releaseStage": "stable",
        "enabled": false,
        "plan_tier": "free",
        "description": {
            "EN": "Celebrate watch streaks and moderator anniversaries shared in chat.",
            "ES": "Celebra las rachas de visualización y los aniversarios de moderación compartidos en el chat."
        },
        "config": [{
            "id": "watchStreakEnabled",
            "label": { "EN": "Watch streak announcements", "ES": "Anuncios de rachas de visualización" },
            "type": "checkbox", "value": true, "canDisable": true
        }, {
            "id": "message",
            "label": { "EN": "Streak message", "ES": "Mensaje de la racha" },
            "type": "text",
            "value": super::types::WATCH_STREAK_MESSAGE_EN,
            "canDisable": true
        }, {
            "id": "modiversaryEnabled",
            "label": { "EN": "Moderator anniversary announcements", "ES": "Anuncios de aniversarios de moderación" },
            "type": "checkbox", "value": true, "canDisable": true
        }, {
            "id": "modiversaryMessage",
            "label": { "EN": "Moderator anniversary message", "ES": "Mensaje de aniversario de moderación" },
            "type": "text", "value": MODIVERSARY_MESSAGE_EN, "canDisable": true
        }]
    })
}

fn shoutout_received_event() -> Value {
    json!({
        "name": "Shoutout Received",
        "type": "channel.shoutout.receive",
        "version": "1",
        "condition": { "broadcaster_user_id": "user", "moderator_user_id": "moderator" },
        "icon": "MessageCircle",
        "color": "#7c3aed",
        "textColor": "#ffffff",
        "releaseStage": "stable",
        "enabled": false,
        "plan_tier": "free",
        "description": {
            "EN": "Thank another streamer when they send your channel a shoutout.",
            "ES": "Agradece a otro streamer cuando le hace un shoutout a tu canal."
        },
        "config": [{
            "id": "message",
            "label": { "EN": "Message", "ES": "Mensaje" },
            "type": "text",
            "value": "$(shoutout.channel) has sent a shoutout to $(twitch.channel)!",
            "canDisable": true
        }]
    })
}

/// `SUBSCRIPTION_CHAT_EVENTS`: `{name, type, icon, description}` followed by the shared fields.
fn subscription_chat_events() -> Vec<Value> {
    [
        (
            "New subscriptions",
            "channel.subscribe",
            "Star",
            "Welcome new subscribers, including viewers who receive a gift subscription.",
            "Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada.",
            "Thanks $(user) for subscribing at $(sub.tier)!",
        ),
        (
            "Gifted subscriptions",
            "channel.subscription.gift",
            "Heart",
            "Thank subscription gifts with one message per gift batch, including anonymous gifts.",
            "Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos.",
            "Thank you for the gifted $(sub.tier) subscriptions!",
        ),
        (
            "Resubscription messages",
            "channel.subscription.message",
            "MessageCircle",
            "Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.",
            "Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje.",
            "Thanks $(user) for $(sub.months) months of support at $(sub.tier)!",
        ),
        (
            "Subscription endings",
            "channel.subscription.end",
            "Clock",
            "Post a message when a subscription expires. Leave the message empty to stay silent.",
            "Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo.",
            "",
        ),
    ]
    .into_iter()
    .map(|(name, kind, icon, en, es, message)| {
        json!({
            "name": name,
            "type": kind,
            "icon": icon,
            "description": { "EN": en, "ES": es },
            "version": "1",
            "condition": { "broadcaster_user_id": "user" },
            "color": "#7c3aed",
            "textColor": "#ffffff",
            "releaseStage": "stable",
            "enabled": false,
            "plan_tier": "free",
            "config": [{
                "id": "message",
                "label": { "EN": "Message", "ES": "Mensaje" },
                "type": "text",
                "value": message,
                "canDisable": true
            }]
        })
    })
    .collect()
}

fn outgoing_raid_chat_event() -> Value {
    json!({
        "name": "Outgoing raid", "type": "channel.raid.outgoing", "version": "1",
        "condition": { "from_broadcaster_user_id": "user" },
        "icon": "Users", "color": "#7c3aed", "textColor": "#ffffff", "releaseStage": "stable",
        "enabled": false, "plan_tier": "free",
        "description": {
            "EN": "Track channels you raid for your dashboard. An empty message tracks silently. Disabling or deleting stops outgoing tracking only; recorded history remains.",
            "ES": "Registra los canales a los que haces raid para tu panel. Un mensaje vacío registra en silencio. Desactivar o eliminar solo detiene el registro de salida; el historial se conserva."
        },
        "config": [{
            "id": "message",
            "label": {
                "EN": "Optional message · $(raid.channel), $(raid.login), $(raid.viewers)",
                "ES": "Mensaje opcional · $(raid.channel), $(raid.login), $(raid.viewers)"
            },
            "type": "text", "value": "", "canDisable": true
        }]
    })
}

/// `{...OUTGOING_RAID_CHAT_EVENT, name, type, condition, description, config}`: the overridden
/// keys keep the outgoing event's places.
fn incoming_raid_chat_event() -> Value {
    let mut event = outgoing_raid_chat_event();
    if let Value::Object(map) = &mut event {
        map.insert("name".into(), json!("Incoming raid"));
        map.insert("type".into(), json!("channel.raid"));
        map.insert(
            "condition".into(),
            json!({ "to_broadcaster_user_id": "user" }),
        );
        map.insert(
            "description".into(),
            json!({
                "EN": "Incoming raid protection, announcements, clips and shoutouts. Independent of outgoing tracking.",
                "ES": "Protección ante raids entrantes, anuncios, clips y shoutouts. Independiente del registro de salida."
            }),
        );
        map.insert(
            "config".into(),
            json!([
                { "id": "message", "label": { "EN": "Announcement", "ES": "Anuncio" }, "type": "text", "value": "$(raid.channel) is raiding with $(raid.viewers) viewers!", "canDisable": true },
                { "id": "enableClip", "dbId": "clipEnabled", "label": { "EN": "Show a clip", "ES": "Mostrar un clip" }, "type": "checkbox", "value": true, "canDisable": true },
                { "id": "minViewers", "label": { "EN": "Minimum viewers for announcements", "ES": "Espectadores mínimos para anuncios" }, "type": "number", "value": 2, "canDisable": true }
            ]),
        );
    }
    event
}

static BUILTIN_CHAT_EVENTS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut events = vec![
        chat_notification_event(),
        shoutout_received_event(),
        incoming_raid_chat_event(),
        outgoing_raid_chat_event(),
    ];
    events.extend(subscription_chat_events());
    events
});

/// `BUILTIN_CHAT_EVENTS`, in the reference's order.
pub fn builtin_chat_events() -> &'static [Value] {
    &BUILTIN_CHAT_EVENTS
}

fn event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(Value::as_str)
}

/// `getBuiltinChatEvent(type)`.
pub fn builtin_chat_event(kind: &str) -> Option<&'static Value> {
    builtin_chat_events()
        .iter()
        .find(|event| event_type(event) == Some(kind))
}

/// `withBuiltinChatEvents(events)`: the catalog as given, then every built-in event whose type no
/// given entry has (`event.type === builtin.type`, so only a text type matches).
pub fn with_builtin_chat_events(events: Vec<Value>) -> Vec<Value> {
    let missing: Vec<Value> = builtin_chat_events()
        .iter()
        .filter(|builtin| {
            let kind = event_type(builtin);
            !events.iter().any(|event| event_type(event) == kind)
        })
        .cloned()
        .collect();
    let mut catalog = events;
    catalog.extend(missing);
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `chat_event_catalog.test.ts`: "received shoutouts are discoverable without a database
    /// catalog entry".
    #[test]
    fn received_shoutouts_are_discoverable_without_a_database_catalog_entry() {
        let catalog = with_builtin_chat_events(Vec::new());
        let event = catalog
            .iter()
            .find(|e| event_type(e) == Some("channel.shoutout.receive"));
        assert!(event.is_some());
        let event = event.cloned().unwrap_or_default();
        assert_eq!(event["version"], "1");
        assert_eq!(event["plan_tier"], "free");
        assert_eq!(
            event["condition"],
            json!({"broadcaster_user_id": "user", "moderator_user_id": "moderator"})
        );
        let message = event["config"]
            .as_array()
            .and_then(|config| config.iter().find(|c| c["id"] == "message"));
        assert_eq!(message.map(|m| &m["canDisable"]), Some(&json!(true)));
    }

    /// `chat_event_catalog.test.ts`: "built-in discovery preserves existing catalog definitions
    /// without duplicates".
    #[test]
    fn built_in_discovery_preserves_existing_catalog_definitions_without_duplicates() {
        let custom = json!({"type": "channel.shoutout.receive", "name": "Custom catalog entry"});
        let events = vec![custom.clone(), json!({"type": "channel.follow"})];
        let catalog = with_builtin_chat_events(events.clone());
        let shoutouts: Vec<_> = catalog
            .iter()
            .filter(|e| event_type(e) == Some("channel.shoutout.receive"))
            .collect();
        assert_eq!(shoutouts, [&custom]);
        assert_eq!(events.len(), 2, "input catalog is not mutated");
        assert_eq!(
            catalog
                .iter()
                .filter(|e| event_type(e) == Some("channel.chat.notification"))
                .count(),
            1
        );
        assert_eq!(builtin_chat_events().len(), 8);
        assert!(builtin_chat_event("channel.raid.outgoing").is_some());
        assert!(builtin_chat_event("channel.follow").is_none());
    }
}
