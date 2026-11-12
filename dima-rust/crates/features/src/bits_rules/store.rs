//! `bits_rules/store.ts`: the channel's rules in `bits_rules` (one document per channel, `_id`
//! the channel id), the legacy fallback to the cheers event's tiers, and changes by revision.
//!
//! # Writes
//!
//! - First change of a channel (stored revision 0, no document): `create({_id, revision: 1,
//!   rules, updatedAt, updatedBy})`. Compares nothing but the unique `_id`: a duplicate key
//!   (another editor created it first) reloads and tries again.
//! - Later changes: `updateOne({_id, revision: r}, {$set: {rules, updatedAt, updatedBy}, $inc:
//!   {revision: 1}})`. Compares the revision read; sets the whole list. Nothing matched: another
//!   editor saved meanwhile; reload, run the change again on the new list.
//!
//! Four attempts, then 409 "changed somewhere else", as the reference. A change that lost the
//! race is never applied to the list it read: it runs again on the winner's list, so no edit is
//! lost or applied twice.
//!
//! Every store call runs under [`BitsRulesConfig::deadline`] (the reference has none; Mongoose's
//! own buffering gives up after 10 s, the default kept here).

use std::sync::Arc;
use std::time::Duration;

use bson::{Bson, DateTime, doc};
use dima_core::Clock;
use dima_model::bits_rules::{self as stored, BitsRulesRulesContent, NewBitsRules};
use dima_model::eventsubs::{self, Eventsub};
use dima_model::{ModelError, Private, UpdateOptions};
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::write::WriteError;
use dima_store::mongo::{MongoStore, WriteContext};
use dima_twitch::eventsub::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES};

use super::model::{BitsRule, BitsRuleError, rules_from_legacy_tiers};

/// Attempts of one change before the 409.
const CHANGE_ATTEMPTS: usize = 4;

/// Typed configuration.
#[derive(Clone, Debug)]
pub struct BitsRulesConfig {
    /// Deadline of each MongoDB call.
    pub deadline: Duration,
}

impl Default for BitsRulesConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(10),
        }
    }
}

/// A failure of the store: the rule's own refusal, or the store (the route's 500, "Bits rules
/// are temporarily unavailable").
#[derive(Debug, thiserror::Error)]
pub enum BitsRulesError {
    /// A refusal with the reference's message and status (validation, 404, 409).
    #[error(transparent)]
    Rule(#[from] BitsRuleError),
    /// MongoDB failed or did not answer in time.
    #[error("bits rules store: {0}")]
    Store(String),
    /// A stored rule that no writer of the reference could have stored: the list is not
    /// rewritten (the change would lose it).
    #[error("bits rules of channel {channel}: stored rule {index} is malformed")]
    Malformed {
        /// The channel.
        channel: String,
        /// Its position in the stored list.
        index: usize,
    },
}

impl BitsRulesError {
    /// The HTTP status the route answers.
    pub fn status(&self) -> u16 {
        match self {
            Self::Rule(error) => error.status,
            Self::Store(_) | Self::Malformed { .. } => 500,
        }
    }

    fn store(error: impl std::fmt::Display) -> Self {
        Self::Store(error.to_string())
    }
}

impl From<ModelError> for BitsRulesError {
    fn from(error: ModelError) -> Self {
        Self::store(error)
    }
}

impl From<WriteError> for BitsRulesError {
    fn from(error: WriteError) -> Self {
        Self::store(error)
    }
}

/// `BitsRulesState`: the revision (0 before the first change) and the rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitsRulesState {
    /// `revision`.
    pub revision: i64,
    /// `rules`.
    pub rules: Vec<BitsRule>,
}

impl BitsRulesState {
    /// `{ revision, rules }` as JSON.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "revision": self.revision,
            "rules": self.rules.iter().map(BitsRule::to_json).collect::<Vec<_>>(),
        })
    }
}

/// `loadBitsRules`'s second argument: `undefined` (look the cheers event up) or the tiers a
/// caller already has (`null` included, which gives no rules).
#[derive(Clone, Copy, Debug)]
pub enum LegacyTiers<'a> {
    /// `undefined`: read the cheers event's tiers.
    Lookup,
    /// The caller's tiers (`config.cheerTiers`, `eventsub?.cheerTiers ?? null`).
    Given(Option<&'a [Bson]>),
}

/// The channel's Bits rules in MongoDB.
#[derive(Clone)]
pub struct BitsRulesStore {
    mongo: MongoStore,
    clock: Arc<dyn Clock>,
    config: BitsRulesConfig,
}

impl BitsRulesStore {
    /// A store over `mongo`.
    pub fn new(mongo: MongoStore, clock: Arc<dyn Clock>, config: BitsRulesConfig) -> Self {
        Self {
            mongo,
            clock,
            config,
        }
    }

    async fn within<T, E: std::fmt::Display>(
        &self,
        what: &str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, BitsRulesError> {
        match tokio::time::timeout(self.config.deadline, future.into_future()).await {
            Ok(result) => result.map_err(BitsRulesError::store),
            Err(_) => Err(BitsRulesError::Store(format!(
                "{what}: no answer within {} ms",
                self.config.deadline.as_millis()
            ))),
        }
    }

    /// `findBitsEventsub(channel)`: the channel's cheers event configuration under the
    /// canonical type, else under a legacy one.
    pub async fn find_bits_eventsub(
        &self,
        channel: &str,
    ) -> Result<Option<Eventsub>, BitsRulesError> {
        let collection = self
            .mongo
            .collection::<bson::RawDocumentBuf>(eventsubs::COLLECTION);
        let canonical = doc! { "channelID": channel, "type": CANONICAL_BITS_EVENT_TYPE };
        let legacy =
            doc! { "channelID": channel, "type": { "$in": LEGACY_BITS_EVENT_TYPES.to_vec() } };
        for filter in [canonical, legacy] {
            let found = self
                .within("eventsubs.findOne", collection.find_one(filter))
                .await?;
            if let Some(raw) = found {
                return dima_model::decode::<Eventsub>(&raw)
                    .map(Some)
                    .map_err(BitsRulesError::store);
            }
        }
        Ok(None)
    }

    /// The stored document, or `None`.
    async fn stored(&self, channel: &str) -> Result<Option<BitsRulesState>, BitsRulesError> {
        let raw = self
            .within(
                "bits_rules.findById",
                self.mongo
                    .collection::<bson::RawDocumentBuf>(stored::COLLECTION)
                    .find_one(doc! { "_id": channel }),
            )
            .await?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let document: stored::BitsRules =
            dima_model::decode(&raw).map_err(BitsRulesError::store)?;
        let mut rules = Vec::new();
        for (index, rule) in document.rules.expose().iter().enumerate() {
            rules.push(
                BitsRule::from_bson(&rule.0).ok_or_else(|| BitsRulesError::Malformed {
                    channel: channel.to_owned(),
                    index,
                })?,
            );
        }
        Ok(Some(BitsRulesState {
            revision: document.revision.0 as i64,
            rules,
        }))
    }

    /// `loadBitsRules(channel, legacyTiers)`: the stored rules, or for a channel that never
    /// saved any, its legacy tiers as rules at revision 0.
    pub async fn load_bits_rules(
        &self,
        channel: &str,
        legacy: LegacyTiers<'_>,
    ) -> Result<BitsRulesState, BitsRulesError> {
        if let Some(state) = self.stored(channel).await? {
            return Ok(state);
        }
        let rules = match legacy {
            LegacyTiers::Given(tiers) => rules_from_legacy_tiers(tiers),
            LegacyTiers::Lookup => {
                let eventsub = self.find_bits_eventsub(channel).await?;
                rules_from_legacy_tiers(
                    eventsub
                        .as_ref()
                        .and_then(|e| e.cheer_tiers.as_ref())
                        .map(|t| t.0.as_slice()),
                )
            }
        };
        Ok(BitsRulesState { revision: 0, rules })
    }

    /// `changeBitsRules(channel, updatedBy, change)`: applies `change` to the current list and
    /// saves it by revision; a lost race runs `change` again on the new list (four attempts,
    /// then 409). `change` refuses with a [`BitsRuleError`] (the route's 404 and 409).
    pub async fn change_bits_rules(
        &self,
        channel: &str,
        updated_by: &str,
        mut change: impl FnMut(Vec<BitsRule>) -> Result<Vec<BitsRule>, BitsRuleError>,
    ) -> Result<BitsRulesState, BitsRulesError> {
        for _ in 0..CHANGE_ATTEMPTS {
            let current = self.load_bits_rules(channel, LegacyTiers::Lookup).await?;
            let rules = change(current.rules)?;
            let now = self.clock.now_ms();
            let mut ctx = WriteContext::new(now);
            let stored_rules: Vec<BitsRulesRulesContent> = rules
                .iter()
                .map(|rule| BitsRulesRulesContent(rule.to_bson()))
                .collect();
            if current.revision == 0 {
                let insert = NewBitsRules {
                    id: channel.to_owned(),
                    revision: JsNumber(1.0),
                    rules: Private::from(stored_rules),
                    updated_at: DateTime::from_millis(now).into(),
                    updated_by: updated_by.to_owned(),
                }
                .prepare(&mut ctx)?;
                let mut writes = self.mongo.writes(stored::COLLECTION);
                match tokio::time::timeout(self.config.deadline, writes.insert_one(&insert)).await {
                    Ok(Ok(())) => return Ok(BitsRulesState { revision: 1, rules }),
                    Ok(Err(WriteError::Driver(error)))
                        if dima_store::mongo::error::is_duplicate_key(&error) =>
                    {
                        continue;
                    }
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) => {
                        return Err(BitsRulesError::Store(
                            "bits_rules.create: no answer in time (outcome unknown)".into(),
                        ));
                    }
                }
            }
            let rules_bson: Vec<Bson> = rules.iter().map(BitsRule::to_bson).collect();
            let update = stored::INFO.prepare_update(
                &doc! { "_id": channel, "revision": current.revision },
                doc! {
                    "$set": { "rules": rules_bson, "updatedAt": DateTime::from_millis(now), "updatedBy": updated_by },
                    "$inc": { "revision": 1 },
                },
                UpdateOptions::default(),
                &mut ctx,
            )?;
            let mut writes = self.mongo.writes(stored::COLLECTION);
            let outcome = self
                .within("bits_rules.updateOne", writes.update_one(&update))
                .await?;
            if outcome.modified > 0 {
                return Ok(BitsRulesState {
                    revision: current.revision + 1,
                    rules,
                });
            }
        }
        Err(BitsRuleError::with_status(
            "Your Bits rules were changed somewhere else at the same time. Try again.",
            409,
        )
        .into())
    }
}
