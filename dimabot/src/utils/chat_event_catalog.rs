//! Built-in discovery events from `chat_event_catalog.ts`.
//! BSON documents retain the insertion order of the source object literals.
use mongodb::bson::{Bson, Document, doc};
use std::sync::LazyLock;

fn config(id: &str, en: &str, es: &str, kind: &str, value: Bson) -> Document {
    doc! {"id": id, "label": {"EN": en, "ES": es}, "type": kind, "value": value, "canDisable": true}
}
fn standard(
    name: &str,
    kind: &str,
    condition: Document,
    icon: &str,
    en: &str,
    es: &str,
    configs: Vec<Document>,
) -> Document {
    doc! {"name": name, "type": kind, "version": "1", "condition": condition,
    "icon": icon, "color": "#7c3aed", "textColor": "#ffffff", "releaseStage": "stable",
    "enabled": false, "plan_tier": "free", "description": {"EN": en, "ES": es}, "config": configs}
}
pub static CHAT_NOTIFICATION_EVENT: LazyLock<Document> = LazyLock::new(|| {
    standard(
    "Chat Notifications", "channel.chat.notification", doc! {"broadcaster_user_id": "user", "user_id": "moderator"}, "Trophy",
    "Celebrate watch streaks and moderator anniversaries shared in chat.",
    "Celebra las rachas de visualización y los aniversarios de moderación compartidos en el chat.", vec![
        config("watchStreakEnabled", "Watch streak announcements", "Anuncios de rachas de visualización", "checkbox", true.into()),
        config("message", "Streak message", "Mensaje de la racha", "text", "$(user) has a streak of $(twitch.streak) days!".into()),
        config("modiversaryEnabled", "Moderator anniversary announcements", "Anuncios de aniversarios de moderación", "checkbox", true.into()),
        config("modiversaryMessage", "Moderator anniversary message", "Mensaje de aniversario de moderación", "text", "Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!".into()),
    ])
});
pub static SHOUTOUT_RECEIVED_EVENT: LazyLock<Document> = LazyLock::new(|| {
    standard(
        "Shoutout Received",
        "channel.shoutout.receive",
        doc! {"broadcaster_user_id": "user", "moderator_user_id": "moderator"},
        "MessageCircle",
        "Thank another streamer when they send your channel a shoutout.",
        "Agradece a otro streamer cuando le hace un shoutout a tu canal.",
        vec![config(
            "message",
            "Message",
            "Mensaje",
            "text",
            "$(shoutout.channel) has sent a shoutout to $(twitch.channel)!".into(),
        )],
    )
});

pub static OUTGOING_RAID_CHAT_EVENT: LazyLock<Document> = LazyLock::new(|| {
    standard(
        "Outgoing raid",
        "channel.raid.outgoing",
        doc! {"from_broadcaster_user_id": "user"},
        "Users",
        "Track channels you raid for your dashboard. An empty message tracks silently. Disabling or deleting stops outgoing tracking only; recorded history remains.",
        "Registra los canales a los que haces raid para tu panel. Un mensaje vacío registra en silencio. Desactivar o eliminar solo detiene el registro de salida; el historial se conserva.",
        vec![config(
            "message",
            "Optional message · $(raid.channel), $(raid.login), $(raid.viewers)",
            "Mensaje opcional · $(raid.channel), $(raid.login), $(raid.viewers)",
            "text",
            "".into(),
        )],
    )
});
pub static INCOMING_RAID_CHAT_EVENT: LazyLock<Document> = LazyLock::new(|| {
    let mut result = OUTGOING_RAID_CHAT_EVENT.clone();
    result.insert("name", "Incoming raid");
    result.insert("type", "channel.raid");
    result.insert("condition", doc! {"to_broadcaster_user_id": "user"});
    result.insert("description", doc! {"EN": "Incoming raid protection, announcements, clips and shoutouts. Independent of outgoing tracking.", "ES": "Protección ante raids entrantes, anuncios, clips y shoutouts. Independiente del registro de salida."});
    let mut clip = doc! {"id": "enableClip", "dbId": "clipEnabled"};
    clip.extend(doc! {"label": {"EN": "Show a clip", "ES": "Mostrar un clip"}, "type": "checkbox", "value": true, "canDisable": true});
    result.insert(
        "config",
        vec![
            config(
                "message",
                "Announcement",
                "Anuncio",
                "text",
                "$(raid.channel) is raiding with $(raid.viewers) viewers!".into(),
            ),
            clip,
            config(
                "minViewers",
                "Minimum viewers for announcements",
                "Espectadores mínimos para anuncios",
                "number",
                2.into(),
            ),
        ],
    );
    result
});

fn subscription(name: &str, kind: &str, icon: &str, en: &str, es: &str, message: &str) -> Document {
    // Object spread preserves description before the subsequently added fields.
    doc! {"name": name, "type": kind, "icon": icon, "description": {"EN": en, "ES": es},
    "version": "1", "condition": {"broadcaster_user_id": "user"}, "color": "#7c3aed",
    "textColor": "#ffffff", "releaseStage": "stable", "enabled": false, "plan_tier": "free",
    "config": [config("message", "Message", "Mensaje", "text", message.into())]}
}
pub static SUBSCRIPTION_CHAT_EVENTS: LazyLock<Vec<Document>> = LazyLock::new(|| {
    vec![
        subscription(
            "New subscriptions",
            "channel.subscribe",
            "Star",
            "Welcome new subscribers, including viewers who receive a gift subscription.",
            "Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada.",
            "Thanks $(user) for subscribing at $(sub.tier)!",
        ),
        subscription(
            "Gifted subscriptions",
            "channel.subscription.gift",
            "Heart",
            "Thank subscription gifts with one message per gift batch, including anonymous gifts.",
            "Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos.",
            "Thank you for the gifted $(sub.tier) subscriptions!",
        ),
        subscription(
            "Resubscription messages",
            "channel.subscription.message",
            "MessageCircle",
            "Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.",
            "Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje.",
            "Thanks $(user) for $(sub.months) months of support at $(sub.tier)!",
        ),
        subscription(
            "Subscription endings",
            "channel.subscription.end",
            "Clock",
            "Post a message when a subscription expires. Leave the message empty to stay silent.",
            "Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo.",
            "",
        ),
    ]
});
fn builtin_chat_events() -> impl Iterator<Item = &'static Document> {
    [
        &*CHAT_NOTIFICATION_EVENT,
        &*SHOUTOUT_RECEIVED_EVENT,
        &*INCOMING_RAID_CHAT_EVENT,
        &*OUTGOING_RAID_CHAT_EVENT,
    ]
    .into_iter()
    .chain(SUBSCRIPTION_CHAT_EVENTS.iter())
}
pub fn get_builtin_chat_event(kind: &str) -> Option<Document> {
    builtin_chat_events()
        .find(|event| event.get_str("type").ok() == Some(kind))
        .cloned()
}
pub fn with_builtin_chat_events(events: &[Document]) -> Vec<Document> {
    let mut all = events.to_vec();
    for builtin in builtin_chat_events() {
        if !events
            .iter()
            .any(|event| event.get("type") == builtin.get("type"))
        {
            all.push(builtin.clone());
        }
    }
    all
}
