//! First-activation moderation settings (reference `utils/moderation/defaults.ts` and
//! `seed_plan.ts`, and `buildDefaultModerationRules` / `MODERATION_*_DEFAULTS` of the settings
//! schema, which they use).
//!
//! A new streamer gets caps, links and emote spam on with the warn → delete → timeout (60 s)
//! ladder and an empty blocked-word rule off. An existing document is kept unless it is the
//! untouched disabled stub an old read used to insert; replacing that stub is a
//! compare-and-set on it being still untouched, so a concurrent save or seed always wins.
//!
//! The settings cache the result primes belongs to the moderation handler (P4-MOD-RUN): it is
//! reached through [`SettingsCacheHook`].

use std::future::Future;
use std::pin::Pin;

use bson::{Bson, Document, doc};
use dima_core::Random;
use dima_model::channel_moderation_settings;
use dima_store::mongo::WriteContext;
use dima_store::mongo::error::is_duplicate_key;
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::write::WriteError;
use serde_json::{Value, json};

use super::store::{RulesStore, StoreError};

/// `MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds`.
pub const DEFAULT_OFFENSE_WINDOW_SECONDS: i32 = 3600;
/// `MODERATION_SETTINGS_DEFAULTS.settingsVersion`.
pub const DEFAULT_SETTINGS_VERSION: i32 = 1;
/// `MAX_TIMEOUT_SECONDS`.
pub const MAX_TIMEOUT_SECONDS: i64 = 1_209_600;
/// `MAX_RULES_PER_CHANNEL`.
pub const MAX_RULES_PER_CHANNEL: usize = 20;
/// `MAX_BLACKLIST_TERMS`.
pub const MAX_BLACKLIST_TERMS: usize = 200;
/// `MAX_ALLOWLIST_DOMAINS`.
pub const MAX_ALLOWLIST_DOMAINS: usize = 50;

/// `buildDefaultModerationRules`: caps, links, emote spam (on) and blocked words (off, empty),
/// each with a fresh random id, keys in the reference's order.
pub fn build_default_moderation_rules(random: &dyn Random) -> Result<Vec<Document>, StoreError> {
    let mut rules = Vec::with_capacity(4);
    for (kind, reason, enabled) in [
        ("caps", "Please do not use so many caps", true),
        ("links", "Please do not post links", true),
        ("emote_spam", "Please do not spam emotes", true),
        ("blacklist", "You used a blocked word or phrase", false),
    ] {
        let id = random
            .uuid_v4()
            .map_err(|_| StoreError::Reply("crypto.randomUUID"))?;
        rules.push(doc! {
            "enabled": enabled,
            "firstOffense": { "action": "warn", "timeoutSeconds": 60 },
            "secondOffense": { "action": "delete", "timeoutSeconds": 60 },
            "thirdOffense": { "action": "timeout", "timeoutSeconds": 60 },
            "reason": reason,
            "exemptUserLevel": 7,
            "capsThresholdMode": "count",
            "minCapsCount": 8,
            "maxCapsPercentage": 70,
            "minMessageLength": 10,
            "allowlistDomains": [],
            "maxEmoteCount": 10,
            "terms": [],
            "id": id,
            "type": kind,
        });
    }
    Ok(rules)
}

/// What a settings document looks like to the seed planner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeedView {
    /// `enabled` (`None` when missing).
    pub enabled: Option<bool>,
    /// How many rules (`None` when the field is missing or null).
    pub rules: Option<usize>,
    /// `settingsVersion` (`None` when missing or null).
    pub settings_version: Option<f64>,
}

impl SeedView {
    /// From a stored document.
    pub fn of(document: &Document) -> Self {
        Self {
            enabled: document.get_bool("enabled").ok(),
            rules: document.get_array("rules").ok().map(Vec::len),
            settings_version: match document.get("settingsVersion") {
                Some(Bson::Int32(v)) => Some(f64::from(*v)),
                #[allow(clippy::cast_precision_loss)]
                Some(Bson::Int64(v)) => Some(*v as f64),
                Some(Bson::Double(v)) => Some(*v),
                _ => None,
            },
        }
    }
}

/// `isUntouchedLazyStub`: disabled, no rules, version 1 (or none).
pub fn is_untouched_lazy_stub(view: Option<&SeedView>) -> bool {
    view.is_some_and(|view| {
        view.enabled == Some(false)
            && view.rules.unwrap_or(0) == 0
            && view.settings_version.unwrap_or(1.0) == 1.0
    })
}

/// `ModerationSeedPlan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedPlan {
    /// No document: create the seed.
    Create,
    /// The untouched stub: replace it.
    ReplaceStub,
    /// Anything else: leave it.
    Keep,
}

/// `planModerationSeed`.
pub fn plan_moderation_seed(existing: Option<&SeedView>) -> SeedPlan {
    match existing {
        None => SeedPlan::Create,
        Some(_) if is_untouched_lazy_stub(existing) => SeedPlan::ReplaceStub,
        Some(_) => SeedPlan::Keep,
    }
}

/// `existingChannelModerationView`: what the dashboard shows a channel without settings
/// (never inserted).
pub fn existing_channel_moderation_view(channel_id: &str, channel_name: &str) -> Value {
    json!({
        "channelID": channel_id,
        "channel": channel_name,
        "enabled": false,
        "offenseWindowSeconds": DEFAULT_OFFENSE_WINDOW_SECONDS,
        "rules": [],
        "settingsVersion": DEFAULT_SETTINGS_VERSION,
    })
}

/// The handler's settings cache (`primeModerationSettingsCache` /
/// `invalidateModerationSettingsCache`), which P4-MOD-RUN implements.
pub trait SettingsCacheHook: Send + Sync {
    /// Caches `settings` (the stored document) for the channel.
    fn prime<'a>(
        &'a self,
        channel_id: &'a str,
        settings: &'a Document,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
    /// Forgets the channel's cached settings.
    fn invalidate<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

fn mongo_error(operation: &'static str, error: impl std::fmt::Display) -> StoreError {
    StoreError::Mongo {
        operation,
        message: error.to_string(),
    }
}

impl RulesStore {
    async fn find_settings(&self, channel_id: &str) -> Result<Option<Document>, StoreError> {
        let collection = self
            .mongo
            .documents(channel_moderation_settings::COLLECTION);
        self.mongo_call(
            "channel_moderation_settings.findOne",
            collection.find_one(doc! { "channelID": channel_id }),
        )
        .await
    }

    /// `seedDefaultModerationSettings`: creates the first-activation settings, or replaces the
    /// untouched stub, then primes (or clears) the handler's cache. The reference logs any
    /// error and never fails registration: the caller does the same with the error returned.
    pub async fn seed_default_moderation_settings(
        &self,
        channel_id: &str,
        channel_name: &str,
        random: &dyn Random,
        cache: &dyn SettingsCacheHook,
    ) -> Result<(), StoreError> {
        let seed = doc! {
            "channelID": channel_id,
            "channel": channel_name,
            "enabled": true,
            "offenseWindowSeconds": DEFAULT_OFFENSE_WINDOW_SECONDS,
            "rules": build_default_moderation_rules(random)?,
            "settingsVersion": DEFAULT_SETTINGS_VERSION,
        };
        let mut existing = self.find_settings(channel_id).await?;
        let mut plan = plan_moderation_seed(existing.as_ref().map(SeedView::of).as_ref());
        if plan == SeedPlan::Create {
            let mut ctx = WriteContext::new(self.clock.now_ms());
            let prepared = channel_moderation_settings::INFO
                .prepare_create(&seed, &mut ctx)
                .map_err(|e| mongo_error("channel_moderation_settings.create", e))?;
            let mut writes = self.mongo.writes(channel_moderation_settings::COLLECTION);
            match tokio::time::timeout(self.config.mongo_deadline, writes.insert_one(&prepared))
                .await
            {
                Err(_) => return Err(StoreError::Deadline("channel_moderation_settings.create")),
                Ok(Ok(())) => {
                    existing = Some(prepared.document.clone());
                    plan = SeedPlan::Keep;
                }
                Ok(Err(WriteError::Driver(error))) if is_duplicate_key(&error) => {
                    existing = self.find_settings(channel_id).await?;
                    plan = plan_moderation_seed(existing.as_ref().map(SeedView::of).as_ref());
                }
                Ok(Err(error)) => {
                    return Err(mongo_error("channel_moderation_settings.create", error));
                }
            }
        }
        if plan == SeedPlan::ReplaceStub && existing.is_some() {
            let mut ctx = WriteContext::new(self.clock.now_ms());
            let prepared = channel_moderation_settings::INFO
                .prepare_find_one_and_update(
                    &doc! {
                        "channelID": channel_id, "enabled": false, "settingsVersion": 1,
                        "$or": [{ "rules": { "$size": 0 } }, { "rules": { "$exists": false } }],
                    },
                    doc! { "$set": seed.clone() },
                    UpdateOptions::default(),
                    Returned::After,
                    &mut ctx,
                )
                .map_err(|e| mongo_error("channel_moderation_settings.findOneAndUpdate", e))?;
            let mut writes = self.mongo.writes(channel_moderation_settings::COLLECTION);
            let replaced = self
                .mongo_call(
                    "channel_moderation_settings.findOneAndUpdate",
                    writes.find_one_and_update(&prepared),
                )
                .await?;
            existing = match replaced {
                Some(replaced) => Some(replaced),
                // Lost to a concurrent seed or save: read the winner, never prime the stub.
                None => self.find_settings(channel_id).await?,
            };
        }
        match &existing {
            Some(settings) => cache.prime(channel_id, settings).await,
            None => cache.invalidate(channel_id).await,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        let view = |enabled, rules, version| SeedView {
            enabled,
            rules,
            settings_version: version,
        };
        assert_eq!(plan_moderation_seed(None), SeedPlan::Create);
        assert_eq!(
            plan_moderation_seed(Some(&view(Some(false), Some(0), Some(1.0)))),
            SeedPlan::ReplaceStub
        );
        assert_eq!(
            plan_moderation_seed(Some(&view(Some(false), None, None))),
            SeedPlan::ReplaceStub
        );
        assert_eq!(
            plan_moderation_seed(Some(&view(Some(false), Some(0), Some(2.0)))),
            SeedPlan::Keep
        );
        assert_eq!(
            plan_moderation_seed(Some(&view(Some(true), Some(0), Some(1.0)))),
            SeedPlan::Keep
        );
        assert_eq!(
            plan_moderation_seed(Some(&view(None, Some(0), Some(1.0)))),
            SeedPlan::Keep
        );
        assert_eq!(
            plan_moderation_seed(Some(&view(Some(false), Some(1), Some(1.0)))),
            SeedPlan::Keep
        );
    }
}
