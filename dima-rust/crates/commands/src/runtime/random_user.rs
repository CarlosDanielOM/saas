//! The `$(randomuser)` blacklist (reference: `utils/ast_parser/randomuser_settings.ts`; the
//! settings route normalises what it stores, the host reads it).

use bson::{RawDocumentBuf, doc};
use dima_model::random_user_settings::COLLECTION;
use serde_json::Value;

use super::{RuntimeError, Stores, within};

/// The most names a blacklist holds.
pub const MAX_RANDOMUSER_BLACKLIST: usize = 200;

fn is_login(name: &str) -> bool {
    let count = name.chars().count();
    (1..=25).contains(&count)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// `normalizeRandomUserBlacklist(input)`: each entry trimmed (JavaScript whitespace), one
/// leading `@` removed, lowercased, and checked against `^[a-z0-9_]{1,25}$`; duplicates
/// dropped in first-seen order. `None` (the reference's `null`) for anything but an array of
/// at most [`MAX_RANDOMUSER_BLACKLIST`] strings that all pass.
pub fn normalize_random_user_blacklist(input: &Value) -> Option<Vec<String>> {
    let Value::Array(items) = input else {
        return None;
    };
    if items.len() > MAX_RANDOMUSER_BLACKLIST {
        return None;
    }
    let mut names: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(text) = item else {
            return None;
        };
        let trimmed = dima_text::trim(text);
        let name = dima_text::to_lower(trimmed.strip_prefix('@').unwrap_or(trimmed));
        if !is_login(&name) {
            return None;
        }
        if !names.contains(&name) {
            names.push(name);
        }
    }
    Some(names)
}

/// `getRandomUserBlacklist(channelID)`: the stored list, or empty when the channel has no
/// settings or a `null` list. The string items only: the settings route stores nothing else.
pub async fn random_user_blacklist(
    stores: &Stores,
    channel_id: &str,
    deadline: std::time::Duration,
) -> Result<Vec<String>, RuntimeError> {
    let raw = within(
        "random_user_settings.findOne",
        deadline,
        stores
            .mongo
            .collection::<RawDocumentBuf>(COLLECTION)
            .find_one(doc! { "channelID": channel_id })
            .projection(doc! { "blacklist": 1 }),
    )
    .await?;
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let Ok(Some(bson::RawBsonRef::Array(items))) = raw.get("blacklist") else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            Ok(bson::RawBsonRef::String(name)) => Some(name.to_owned()),
            _ => None,
        })
        .collect())
}
