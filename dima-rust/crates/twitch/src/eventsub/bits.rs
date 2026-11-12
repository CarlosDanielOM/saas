//! `buildBitsEventsubConfig` (`utils/eventsub_bits_config.ts`): the settings of the canonical
//! bits subscription after the legacy ones (`channel.cheer`, `channel.bit.use`) are merged in.
//!
//! Per field: the canonical document's value when it is customised; else the first customised
//! legacy value; else the canonical value, or (when it is `null` or missing) the first legacy
//! value that is not missing. A field nobody has is left out.

use super::js;
use super::types::{Setting, Settings};
use bson::{Bson, Document};
use dima_text::Js;

/// The fields merged, in the reference's order.
const MERGED: [Setting; 8] = [
    Setting::Enabled,
    Setting::Message,
    Setting::EndMessage,
    Setting::EndEnabled,
    Setting::ClipEnabled,
    Setting::MinViewers,
    Setting::Delay,
    Setting::CheerTiers,
];

/// `isCustomValue` of the field.
fn is_custom(key: Setting, value: Option<&Bson>) -> bool {
    let Some(value) = value else {
        return false;
    };
    match key {
        Setting::Enabled => matches!(value, Bson::Boolean(false)),
        Setting::Message | Setting::EndMessage => {
            matches!(value, Bson::String(text) if !dima_text::trim(text).is_empty())
        }
        Setting::EndEnabled | Setting::ClipEnabled => matches!(value, Bson::Boolean(true)),
        Setting::MinViewers => js::number(Some(value)).is_some_and(|n| n.is_finite() && n != 2.0),
        Setting::Delay => js::number(Some(value)).is_some_and(|n| n.is_finite() && n != 0.0),
        Setting::CheerTiers => matches!(js::js(value), Js::Array(items) if !items.is_empty()),
        _ => false,
    }
}

/// `resolveBitsEventsubConfigValue`.
fn resolve<'a>(
    canonical: Option<&'a Document>,
    legacy: &'a [Document],
    key: Setting,
) -> Option<&'a Bson> {
    let path = key.path();
    let canonical_value = canonical.and_then(|document| document.get(path));
    if is_custom(key, canonical_value) {
        return canonical_value;
    }
    if let Some(custom) = legacy
        .iter()
        .map(|document| document.get(path))
        .find(|value| is_custom(key, *value))
        .flatten()
    {
        return Some(custom);
    }
    // `canonicalValue ?? legacyValue`: `null` and missing both fall through.
    match canonical_value {
        Some(value) if !matches!(value, Bson::Null | Bson::Undefined) => Some(value),
        _ => legacy.iter().find_map(|document| document.get(path)),
    }
}

/// `buildBitsEventsubConfig(canonical, legacyEventsubs)` over stored documents as read.
pub fn build_bits_eventsub_config(canonical: Option<&Document>, legacy: &[Document]) -> Settings {
    let mut settings = Settings::new();
    for key in MERGED {
        if let Some(value) = resolve(canonical, legacy, key) {
            settings.set(key, value.clone());
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    /// `eventsub_config.test.ts`: "merges custom bits settings across legacy subscriptions".
    #[test]
    fn merges_custom_bits_settings_across_legacy_subscriptions() {
        let config = build_bits_eventsub_config(
            None,
            &[
                doc! {"message": "Cheer received", "minViewers": 2},
                doc! {"enabled": false, "delay": 10, "clipEnabled": true},
                doc! {"cheerTiers": [{"id": "large", "name": "Large", "message": "Big cheer", "min_amount": 100, "max_amount": 999}]},
            ],
        );
        assert_eq!(
            config.get(Setting::Message),
            Some(&Bson::from("Cheer received"))
        );
        assert_eq!(config.get(Setting::Enabled), Some(&Bson::Boolean(false)));
        assert_eq!(config.get(Setting::Delay), Some(&Bson::Int32(10)));
        assert_eq!(config.get(Setting::ClipEnabled), Some(&Bson::Boolean(true)));
        let tiers = config.get(Setting::CheerTiers).and_then(Bson::as_array);
        assert_eq!(
            tiers
                .and_then(|t| t.first())
                .and_then(Bson::as_document)
                .and_then(|t| t.get_str("id").ok()),
            Some("large")
        );
    }

    /// `eventsub_config.test.ts`: "keeps customized canonical bits settings over legacy values".
    #[test]
    fn keeps_customized_canonical_bits_settings_over_legacy_values() {
        let canonical = doc! {"message": "Canonical", "enabled": false, "delay": 5};
        let config = build_bits_eventsub_config(
            Some(&canonical),
            &[doc! {"message": "Legacy", "enabled": true, "delay": 10}],
        );
        assert_eq!(config.get(Setting::Message), Some(&Bson::from("Canonical")));
        assert_eq!(config.get(Setting::Enabled), Some(&Bson::Boolean(false)));
        assert_eq!(config.get(Setting::Delay), Some(&Bson::Int32(5)));
    }

    #[test]
    fn null_canonical_values_fall_back_to_legacy_and_missing_fields_are_left_out() {
        let canonical = doc! {"message": Bson::Null, "minViewers": 2.0};
        let config = build_bits_eventsub_config(
            Some(&canonical),
            &[
                doc! {"message": "  "},
                doc! {"message": "x", "endMessage": Bson::Null},
            ],
        );
        let keys: Vec<_> = config.entries().iter().map(|(k, _)| k.path()).collect();
        assert_eq!(keys, ["message", "endMessage", "minViewers"]);
        assert_eq!(config.get(Setting::Message), Some(&Bson::from("x")));
        assert_eq!(config.get(Setting::EndMessage), Some(&Bson::Null));
        assert_eq!(config.get(Setting::MinViewers), Some(&Bson::Double(2.0)));
        assert!(build_bits_eventsub_config(None, &[]).is_empty());
    }
}
