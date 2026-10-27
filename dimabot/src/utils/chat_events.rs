//! Full built-in chat event discovery and language-aware defaults, ported from
//! `chat_event_catalog.ts` and `chat_notification_defaults.ts`.
//!
//! Discovery appends missing definitions; it never enables events, persists
//! settings, or rewrites existing definitions. JSON preserves the heterogeneous
//! catalog controls and all EN/ES labels without coupling to a MongoDB schema.
//! Rust returns owned clones when merging (JS object identity is not modeled).

use super::js_compat::trim as js_trim;
use serde_json::Value;
use std::sync::OnceLock;

pub const WATCH_STREAK_EN: &str = "$(user) has a streak of $(twitch.streak) days!";
pub const WATCH_STREAK_ES: &str = "¡$(user) tiene una racha de $(twitch.streak) días!";
pub const MODIVERSARY_EN: &str =
    "Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!";
pub const MODIVERSARY_ES: &str = "¡Feliz aniversario de moderación, $(user)! ¡Gracias por tus $(twitch.modiversary) meses como moderador!";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    En,
    Es,
}

pub fn is_supported_chat_notice(notice_type: &Value) -> bool {
    matches!(notice_type.as_str(), Some("watch_streak" | "modiversary"))
}

pub fn resolve_watch_streak_message(message: &str, language: Language) -> String {
    resolve_default(message, language, WATCH_STREAK_EN, WATCH_STREAK_ES)
}

fn resolve_default(message: &str, language: Language, en: &str, es: &str) -> String {
    if js_trim(message).is_empty() || message == en || message == es {
        match language {
            Language::En => en,
            Language::Es => es,
        }
        .into()
    } else {
        message.into()
    }
}

/// Only literal boolean false disables a notice. Missing/non-string templates
/// use a localized default, while custom templates (including whitespace around
/// them) are preserved byte-for-byte. Unsupported notices return an empty string.
pub fn resolve_chat_notification_message(
    notice_type: &Value,
    config: &Value,
    language: Language,
) -> String {
    match notice_type.as_str() {
        Some("watch_streak") if config.get("watchStreakEnabled") != Some(&Value::Bool(false)) => {
            resolve_watch_streak_message(
                config.get("message").and_then(Value::as_str).unwrap_or(""),
                language,
            )
        }
        Some("modiversary") if config.get("modiversaryEnabled") != Some(&Value::Bool(false)) => {
            resolve_default(
                config
                    .get("modiversaryMessage")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                language,
                MODIVERSARY_EN,
                MODIVERSARY_ES,
            )
        }
        _ => String::new(),
    }
}

/// Source-derived definitions, in TypeScript discovery order.
pub fn builtin_chat_events() -> &'static [Value] {
    static EVENTS: OnceLock<Vec<Value>> = OnceLock::new();
    EVENTS.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON)
            .expect("embedded source-derived chat catalog is valid JSON")
    })
}

pub fn get_builtin_chat_event(event_type: &str) -> Option<&'static Value> {
    builtin_chat_events()
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some(event_type))
}

pub fn with_builtin_chat_events(events: &[Value]) -> Vec<Value> {
    let mut result = events.to_vec();
    result.extend(
        builtin_chat_events()
            .iter()
            .filter(|builtin| {
                !events
                    .iter()
                    .any(|event| event.get("type") == builtin.get("type"))
            })
            .cloned(),
    );
    result
}

// Extracted from the TypeScript constant expressions, including the mapped
// subscription definitions and incoming raid spread. Keep these exact fields
// and order when updating the source contract.
const CATALOG_JSON: &str = r##"[
  {
    "name": "Chat Notifications",
    "type": "channel.chat.notification",
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user",
      "user_id": "moderator"
    },
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
    "config": [
      {
        "id": "watchStreakEnabled",
        "label": {
          "EN": "Watch streak announcements",
          "ES": "Anuncios de rachas de visualización"
        },
        "type": "checkbox",
        "value": true,
        "canDisable": true
      },
      {
        "id": "message",
        "label": {
          "EN": "Streak message",
          "ES": "Mensaje de la racha"
        },
        "type": "text",
        "value": "$(user) has a streak of $(twitch.streak) days!",
        "canDisable": true
      },
      {
        "id": "modiversaryEnabled",
        "label": {
          "EN": "Moderator anniversary announcements",
          "ES": "Anuncios de aniversarios de moderación"
        },
        "type": "checkbox",
        "value": true,
        "canDisable": true
      },
      {
        "id": "modiversaryMessage",
        "label": {
          "EN": "Moderator anniversary message",
          "ES": "Mensaje de aniversario de moderación"
        },
        "type": "text",
        "value": "Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!",
        "canDisable": true
      }
    ]
  },
  {
    "name": "Shoutout Received",
    "type": "channel.shoutout.receive",
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user",
      "moderator_user_id": "moderator"
    },
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
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Message",
          "ES": "Mensaje"
        },
        "type": "text",
        "value": "$(shoutout.channel) has sent a shoutout to $(twitch.channel)!",
        "canDisable": true
      }
    ]
  },
  {
    "name": "Incoming raid",
    "type": "channel.raid",
    "version": "1",
    "condition": {
      "to_broadcaster_user_id": "user"
    },
    "icon": "Users",
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "description": {
      "EN": "Incoming raid protection, announcements, clips and shoutouts. Independent of outgoing tracking.",
      "ES": "Protección ante raids entrantes, anuncios, clips y shoutouts. Independiente del registro de salida."
    },
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Announcement",
          "ES": "Anuncio"
        },
        "type": "text",
        "value": "$(raid.channel) is raiding with $(raid.viewers) viewers!",
        "canDisable": true
      },
      {
        "id": "enableClip",
        "dbId": "clipEnabled",
        "label": {
          "EN": "Show a clip",
          "ES": "Mostrar un clip"
        },
        "type": "checkbox",
        "value": true,
        "canDisable": true
      },
      {
        "id": "minViewers",
        "label": {
          "EN": "Minimum viewers for announcements",
          "ES": "Espectadores mínimos para anuncios"
        },
        "type": "number",
        "value": 2,
        "canDisable": true
      }
    ]
  },
  {
    "name": "Outgoing raid",
    "type": "channel.raid.outgoing",
    "version": "1",
    "condition": {
      "from_broadcaster_user_id": "user"
    },
    "icon": "Users",
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "description": {
      "EN": "Track channels you raid for your dashboard. An empty message tracks silently. Disabling or deleting stops outgoing tracking only; recorded history remains.",
      "ES": "Registra los canales a los que haces raid para tu panel. Un mensaje vacío registra en silencio. Desactivar o eliminar solo detiene el registro de salida; el historial se conserva."
    },
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Optional message · $(raid.channel), $(raid.login), $(raid.viewers)",
          "ES": "Mensaje opcional · $(raid.channel), $(raid.login), $(raid.viewers)"
        },
        "type": "text",
        "value": "",
        "canDisable": true
      }
    ]
  },
  {
    "name": "New subscriptions",
    "type": "channel.subscribe",
    "icon": "Star",
    "description": {
      "EN": "Welcome new subscribers, including viewers who receive a gift subscription.",
      "ES": "Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada."
    },
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user"
    },
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Message",
          "ES": "Mensaje"
        },
        "type": "text",
        "value": "Thanks $(user) for subscribing at $(sub.tier)!",
        "canDisable": true
      }
    ]
  },
  {
    "name": "Gifted subscriptions",
    "type": "channel.subscription.gift",
    "icon": "Heart",
    "description": {
      "EN": "Thank subscription gifts with one message per gift batch, including anonymous gifts.",
      "ES": "Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos."
    },
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user"
    },
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Message",
          "ES": "Mensaje"
        },
        "type": "text",
        "value": "Thank you for the gifted $(sub.tier) subscriptions!",
        "canDisable": true
      }
    ]
  },
  {
    "name": "Resubscription messages",
    "type": "channel.subscription.message",
    "icon": "MessageCircle",
    "description": {
      "EN": "Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.",
      "ES": "Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje."
    },
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user"
    },
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Message",
          "ES": "Mensaje"
        },
        "type": "text",
        "value": "Thanks $(user) for $(sub.months) months of support at $(sub.tier)!",
        "canDisable": true
      }
    ]
  },
  {
    "name": "Subscription endings",
    "type": "channel.subscription.end",
    "icon": "Clock",
    "description": {
      "EN": "Post a message when a subscription expires. Leave the message empty to stay silent.",
      "ES": "Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo."
    },
    "version": "1",
    "condition": {
      "broadcaster_user_id": "user"
    },
    "color": "#7c3aed",
    "textColor": "#ffffff",
    "releaseStage": "stable",
    "enabled": false,
    "plan_tier": "free",
    "config": [
      {
        "id": "message",
        "label": {
          "EN": "Message",
          "ES": "Mensaje"
        },
        "type": "text",
        "value": "",
        "canDisable": true
      }
    ]
  }
]"##;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_catalog_preserves_controls_and_existing_definitions() {
        let types = builtin_chat_events()
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            types,
            [
                "channel.chat.notification",
                "channel.shoutout.receive",
                "channel.raid",
                "channel.raid.outgoing",
                "channel.subscribe",
                "channel.subscription.gift",
                "channel.subscription.message",
                "channel.subscription.end"
            ]
        );
        for event in builtin_chat_events() {
            assert_eq!(event["version"], "1");
            assert_eq!(event["releaseStage"], "stable");
            assert_eq!(event["enabled"], false);
            assert_eq!(event["plan_tier"], "free");
            assert_eq!(event["color"], "#7c3aed");
            assert_eq!(event["textColor"], "#ffffff");
            assert!(event["description"]["EN"].as_str().is_some());
            assert!(event["description"]["ES"].as_str().is_some());
            for config in event["config"].as_array().unwrap() {
                assert_eq!(config["canDisable"], true);
            }
        }
        let shoutout = get_builtin_chat_event("channel.shoutout.receive").unwrap();
        assert_eq!(
            shoutout["condition"],
            json!({"broadcaster_user_id":"user","moderator_user_id":"moderator"})
        );
        let notifications = get_builtin_chat_event("channel.chat.notification").unwrap();
        assert_eq!(
            notifications["condition"],
            json!({"broadcaster_user_id":"user","user_id":"moderator"})
        );
        assert_eq!(notifications["config"][1]["value"], WATCH_STREAK_EN);
        assert_eq!(notifications["config"][3]["value"], MODIVERSARY_EN);
        let incoming = get_builtin_chat_event("channel.raid").unwrap();
        assert_eq!(incoming["config"][1]["dbId"], "clipEnabled");
        assert_eq!(incoming["config"][2]["value"], 2);
        for silent in ["channel.raid.outgoing", "channel.subscription.end"] {
            assert_eq!(
                get_builtin_chat_event(silent).unwrap()["config"][0]["value"],
                ""
            );
        }
        let existing = vec![
            json!({"type":"channel.shoutout.receive","name":"custom","enabled":true}),
            json!({"type":"channel.follow"}),
            json!({"name":"missing type"}),
        ];
        let merged = with_builtin_chat_events(&existing);
        assert_eq!(&merged[..3], existing.as_slice());
        assert_eq!(
            merged
                .iter()
                .filter(|e| e["type"] == "channel.shoutout.receive")
                .count(),
            1
        );
        assert_eq!(merged.len(), 10);
        assert!(get_builtin_chat_event("missing").is_none());
    }

    #[test]
    fn localized_defaults_switches_and_custom_text_match_source() {
        for (notice, key, enabled, en, es) in [
            (
                "watch_streak",
                "message",
                "watchStreakEnabled",
                WATCH_STREAK_EN,
                WATCH_STREAK_ES,
            ),
            (
                "modiversary",
                "modiversaryMessage",
                "modiversaryEnabled",
                MODIVERSARY_EN,
                MODIVERSARY_ES,
            ),
        ] {
            for (language, expected) in [(Language::En, en), (Language::Es, es)] {
                for value in [
                    Value::Null,
                    json!(""),
                    json!(" \t\n\u{feff}"),
                    json!(en),
                    json!(es),
                    json!(123),
                ] {
                    let mut config = serde_json::Map::new();
                    config.insert(key.into(), value);
                    assert_eq!(
                        resolve_chat_notification_message(
                            &json!(notice),
                            &Value::Object(config),
                            language
                        ),
                        expected
                    );
                }
                assert_eq!(
                    resolve_chat_notification_message(&json!(notice), &json!({}), language),
                    expected
                );
                let mut config = serde_json::Map::new();
                config.insert(key.into(), json!(" custom $(user) "));
                assert_eq!(
                    resolve_chat_notification_message(
                        &json!(notice),
                        &Value::Object(config.clone()),
                        language
                    ),
                    " custom $(user) "
                );
                config.insert(enabled.into(), json!(false));
                assert_eq!(
                    resolve_chat_notification_message(
                        &json!(notice),
                        &Value::Object(config.clone()),
                        language
                    ),
                    ""
                );
                config.insert(enabled.into(), json!(0));
                assert_eq!(
                    resolve_chat_notification_message(
                        &json!(notice),
                        &Value::Object(config),
                        language
                    ),
                    " custom $(user) "
                );
            }
        }
        assert_eq!(
            resolve_watch_streak_message("\u{0085}", Language::Es),
            "\u{0085}"
        );
        assert_eq!(
            resolve_watch_streak_message(&format!(" {WATCH_STREAK_EN}"), Language::Es),
            format!(" {WATCH_STREAK_EN}")
        );
        for notice in [
            Value::Null,
            json!(false),
            json!("shared_chat_modiversary"),
            json!(["watch_streak"]),
        ] {
            assert!(!is_supported_chat_notice(&notice));
            assert_eq!(
                resolve_chat_notification_message(&notice, &json!({}), Language::En),
                ""
            );
        }
    }
}
