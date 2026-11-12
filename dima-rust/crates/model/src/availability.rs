//! The availability hook of `commands` and `redemptionrewards`
//! (`dimabot/src/utils/availability/schema.ts`, `addAvailabilityFields`).
//!
//! Both collections carry `availability` (the scheduled enable/disable state: a token, the
//! value to restore, when) and `availabilityLease` (who is synchronising it with Twitch), both
//! `select: false`, and a sparse index on `availability.nextAt`. Mongoose middleware keeps
//! clients away from them:
//!
//! - **updates** (`updateOne`, `updateMany`, `findOneAndUpdate`), unless the query is marked
//!   internal ([`Writer::Internal`], the reference's `internalWrite(query)`): every
//!   `availability…`/`availabilityLease…` key is removed from the update, from `$set`, `$unset`
//!   and `$setOnInsert`; and when the update sets the enabled field (`$set.<field>`, else a bare
//!   `<field>`, JavaScript `??`), `$set.availability` becomes a fresh state with
//!   `previousEnabled = Boolean(value)`;
//! - **saves** of a loaded document whose enabled field changed: `availability` becomes a fresh
//!   state with the new value.
//!
//! The collection modules wrap the store's helpers with these steps; they are the only way to
//! write either collection ([`crate::Hooks::UpdatesAndSave`]).

use bson::{Bson, Document};
use dima_core::{Random, RandomError};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::save::Change;
use dima_store::mongo::schema::{Field, Schema};
use serde::Deserialize;

/// Who writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writer {
    /// Ordinary edits (site, API, chat commands): the hook applies.
    Client,
    /// The availability scheduler and worker (`internalWrite(query)`): the hook does not apply.
    Internal,
}

/// `availability`.
pub(crate) static STATE: Schema = Schema::subdocument(&[
    Field::string("token"),
    Field::boolean("previousEnabled"),
    Field::date("restoreAt"),
    Field::boolean("pending"),
    Field::date("nextAt"),
])
.no_id();

/// `availabilityLease`.
pub(crate) static LEASE: Schema =
    Schema::subdocument(&[Field::string("token"), Field::date("until")]).no_id();

/// The two fields `addAvailabilityFields` adds, after the schema's own.
pub(crate) const STATE_FIELD: Field = Field::subdocument("availability", &STATE);
/// See [`STATE_FIELD`].
pub(crate) const LEASE_FIELD: Field = Field::subdocument("availabilityLease", &LEASE);

/// The `select: false` paths both collections get.
pub const HIDDEN: &[&str] = &["availability", "availabilityLease"];

/// A stored availability state (`select: false`: present only when the read selected it).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct AvailabilityState {
    /// The state's fence token.
    #[serde(default)]
    pub token: Option<String>,
    /// The enabled value to restore.
    #[serde(default, rename = "previousEnabled")]
    pub previous_enabled: Option<bool>,
    /// When to restore it.
    #[serde(default, rename = "restoreAt")]
    pub restore_at: Option<JsDate>,
    /// Not yet synchronised with Twitch.
    #[serde(default)]
    pub pending: Option<bool>,
    /// When the worker should look at it next.
    #[serde(default, rename = "nextAt")]
    pub next_at: Option<JsDate>,
}

/// A stored synchronisation lease.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct AvailabilityLease {
    /// The owner's token.
    #[serde(default)]
    pub token: Option<String>,
    /// Lease end.
    #[serde(default)]
    pub until: Option<JsDate>,
}

/// `availabilityState(previousEnabled, restoreAt)`: `{token: randomUUID(), previousEnabled,
/// restoreAt, pending: true, nextAt: new Date()}`.
pub fn state(
    previous_enabled: bool,
    restore_at: Option<JsDate>,
    now_ms: i64,
    random: &dyn Random,
) -> Result<Document, RandomError> {
    let mut state = Document::new();
    state.insert("token", random.uuid_v4()?);
    state.insert("previousEnabled", previous_enabled);
    state.insert("restoreAt", restore_at.map_or(Bson::Null, JsDate::to_bson));
    state.insert("pending", true);
    state.insert(
        "nextAt",
        Bson::DateTime(bson::DateTime::from_millis(now_ms)),
    );
    Ok(state)
}

/// `/^availability(?:Lease)?(?:\.|$)/`.
fn is_availability_path(key: &str) -> bool {
    let rest = key
        .strip_prefix("availabilityLease")
        .or_else(|| key.strip_prefix("availability"));
    rest.is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

/// JavaScript `Boolean(value)`.
fn truthy(value: &Bson) -> bool {
    match value {
        Bson::Boolean(b) => *b,
        Bson::Null | Bson::Undefined => false,
        Bson::String(text) => !text.is_empty(),
        Bson::Int32(n) => *n != 0,
        Bson::Int64(n) => *n != 0,
        Bson::Double(n) => *n != 0.0 && !n.is_nan(),
        _ => true,
    }
}

/// The update hook, applied to the update as the caller wrote it (before Mongoose casts it).
pub(crate) fn guard_update(
    update: &mut Document,
    enabled_field: &str,
    now_ms: i64,
    random: &dyn Random,
) -> Result<(), RandomError> {
    strip_keys(update);
    for container in ["$set", "$unset", "$setOnInsert"] {
        if let Some(Bson::Document(inner)) = update.get_mut(container) {
            strip_keys(inner);
        }
    }
    // `update.$set?.[field] ?? update[field]`: a null in `$set` falls through to the bare key.
    let from_set = match update.get("$set") {
        Some(Bson::Document(set)) => set.get(enabled_field).filter(|v| !matches!(v, Bson::Null)),
        _ => None,
    };
    let enabled = from_set.or_else(|| update.get(enabled_field)).cloned();
    if let Some(enabled) = enabled {
        let state = state(truthy(&enabled), None, now_ms, random)?;
        // `update.$set ??= {}`: a missing or null `$set` becomes a new one, at the end.
        if !matches!(update.get("$set"), Some(Bson::Document(_))) {
            update.remove("$set");
            update.insert("$set", Document::new());
        }
        if let Some(Bson::Document(set)) = update.get_mut("$set") {
            set.insert("availability", state);
        }
    }
    Ok(())
}

fn strip_keys(container: &mut Document) {
    let keys: Vec<String> = container
        .keys()
        .filter(|key| is_availability_path(key))
        .cloned()
        .collect();
    for key in keys {
        container.remove(&key);
    }
}

/// Mongoose's Boolean cast of a value set on a Boolean path (`true`/`false`, `'true'`/`'false'`,
/// `1`/`0`, `'1'`/`'0'`, `'yes'`/`'no'`); `None` for `null` and anything else.
fn cast_boolean(value: &Bson) -> Option<bool> {
    match value {
        Bson::Boolean(b) => Some(*b),
        Bson::String(text) => match text.as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        other => {
            let number = dima_store::mongo::number::read_number(other)?;
            if number == 1.0 {
                Some(true)
            } else if number == 0.0 {
                Some(false)
            } else {
                None
            }
        }
    }
}

/// The save hook: when a change set the enabled field to a value other than the one it had at
/// that moment (Mongoose's `isModified`, which stays set even if a later change restores the
/// loaded value), a fresh state with `previousEnabled = Boolean(final value)` is set after the
/// changes. Returns the hook's own changes.
pub(crate) fn guard_save(
    loaded: &Document,
    changes: &[Change],
    enabled_field: &str,
    now_ms: i64,
    random: &dyn Random,
) -> Result<Vec<Change>, RandomError> {
    // The hydrated value: the stored one, or the schema default (`true` for both collections).
    let mut current: Option<bool> = match loaded.get(enabled_field) {
        None => Some(true),
        Some(value) => cast_boolean(value),
    };
    let mut modified = false;
    for change in changes {
        let next = match change {
            Change::Set(path, value) if path == enabled_field => cast_boolean(value),
            Change::Unset(path) if path == enabled_field => None,
            _ => continue,
        };
        modified |= next != current;
        current = next;
    }
    if !modified {
        return Ok(Vec::new());
    }
    let state = state(current.unwrap_or(false), None, now_ms, random)?;
    Ok(vec![Change::set("availability", state)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[derive(Debug)]
    struct Fixed;
    impl Random for Fixed {
        fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
            buf.fill(7);
            Ok(())
        }
    }

    #[test]
    fn update_hook_strips_and_adds_state() -> Result<(), RandomError> {
        let mut update = doc! {
            "availabilityLease": { "token": "x" },
            "availabilityFoo": 1,
            "$set": { "enabled": false, "availability.pending": false },
            "$unset": { "availability": 1 },
        };
        guard_update(&mut update, "enabled", 5, &Fixed)?;
        let state = doc! {
            "token": "07070707-0707-4707-8707-070707070707",
            "previousEnabled": false,
            "restoreAt": Bson::Null,
            "pending": true,
            "nextAt": bson::DateTime::from_millis(5),
        };
        assert_eq!(
            update,
            doc! { "availabilityFoo": 1, "$set": { "enabled": false, "availability": state }, "$unset": {} }
        );
        // A bare key; a null in `$set` falls through to it; no `$set` yet: one is appended.
        let mut bare = doc! { "enabled": 0, "$inc": { "count": 1 } };
        guard_update(&mut bare, "enabled", 5, &Fixed)?;
        assert_eq!(bare.keys().collect::<Vec<_>>(), ["enabled", "$inc", "$set"]);
        let mut null = doc! { "$set": { "isEnabled": Bson::Null } };
        guard_update(&mut null, "isEnabled", 5, &Fixed)?;
        assert_eq!(null, doc! { "$set": { "isEnabled": Bson::Null } });
        assert!(
            is_availability_path("availability.nextAt") && !is_availability_path("availabilityX")
        );
        Ok(())
    }

    #[test]
    fn save_hook_follows_is_modified() -> Result<(), RandomError> {
        let loaded = doc! { "_id": 1, "enabled": true };
        let set = |v: bool| Change::set("enabled", v);
        assert_eq!(
            guard_save(&loaded, &[set(true)], "enabled", 0, &Fixed)?.len(),
            0
        );
        assert_eq!(
            guard_save(&loaded, &[set(false)], "enabled", 0, &Fixed)?.len(),
            1
        );
        // Modified once, modified for the save, even when set back.
        assert_eq!(
            guard_save(&loaded, &[set(false), set(true)], "enabled", 0, &Fixed)?.len(),
            1
        );
        assert_eq!(
            guard_save(&doc! { "_id": 1 }, &[set(true)], "enabled", 0, &Fixed)?.len(),
            0
        );
        Ok(())
    }
}
