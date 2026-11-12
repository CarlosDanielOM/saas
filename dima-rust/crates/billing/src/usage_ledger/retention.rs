//! Retention by plan: `adjustAiUsageRetention(channelIDs, planTier)` of
//! `utils/ai_usage_ledger.ts`, run as the effect of a plan change
//! ([`crate::plans::projection::PlanEffects`]).
//!
//! What it does to the channels' ledger, in the reference's order:
//!
//! 1. deletes their cached dashboards;
//! 2. raises each ledger state's `coverageStart` to `now − days` (`$max`): history older than
//!    the new retention is no longer complete;
//! 3. sets every receipt's `retentionTier` and `expiresAt = occurredAt + days`;
//! 4. sets every day's `retentionTier` and `expiresAt = dayStart + days + 1`;
//! 5. deletes the receipts and days whose `expiresAt` has passed.
//!
//! Steps 1, 3 (when the plan shortens retention: the TTL index then deletes) and 5 destroy
//! history, so **every** step is preceded by [`EffectGuard::confirm`], which renews the owner's
//! plan effects lease and reads the plan again: an older plan write whose turn has passed stops
//! before it deletes anything ([`Retention::Stale`], re-check finding N4). Each step changes at
//! most [`super::LedgerConfig::retention_batch`] documents, chosen by `_id` and changed by `_id`,
//! in one MongoDB operation with a server time limit of [`super::LedgerConfig::max_time_ms`]
//! (at most 10 s), so a confirmation always outlives the operation after it. Every step is
//! idempotent (the expiry is computed from the document's own date, `$max` never lowers): a run
//! that is interrupted, or fails, is repeated whole by the next projection of the plan (the
//! owner's `polar_plan_effects_pending` flag stays until a run finishes).
//!
//! Intended difference: the reference changed and deleted each collection in one statement,
//! without any check between them; the pipelines it sends are the same.

use super::{Ledger, LedgerError, ops, retention_days, valid_tier};
use crate::plans::PlanTier;
use crate::plans::projection::{EffectGuard, PlanEffects, Retention};
use bson::{Bson, DateTime, Document, doc};
use dima_model::StrEnum;
use dima_model::{
    ai_usage_dailies, ai_usage_dashboards, ai_usage_ledger_states, ai_usage_receipts,
};
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::UpdateOptions;
use futures_util::future::BoxFuture;

/// The ledger's [`PlanEffects`].
#[derive(Clone, Copy, Debug)]
pub struct UsageRetention<'a> {
    /// The ledger.
    pub ledger: Ledger<'a>,
}

enum Step<'s> {
    /// Deletes the matched documents.
    Delete,
    /// Updates the matched documents with this pipeline.
    Pipeline(&'s [Document]),
    /// Updates them with this operator document.
    Operators(&'s Document),
}

impl Ledger<'_> {
    /// Runs one retention step over every document of `collection` matching `filter`, in
    /// batches chosen by `_id` and each preceded by the guard. `Ok(false)` when the guard
    /// refused.
    async fn retention_step(
        &self,
        guard: &EffectGuard<'_>,
        collection: &str,
        info: &dima_model::CollectionInfo,
        filter: &Document,
        step: Step<'_>,
    ) -> Result<bool, LedgerError> {
        let batch = self.config.retention_batch.max(1);
        let mut after: Option<Bson> = None;
        loop {
            let mut query = filter.clone();
            if let Some(last) = &after {
                query.insert("_id", doc! { "$gt": last.clone() });
            }
            let ids: Vec<Bson> = ops::find(
                self,
                collection,
                query,
                Some(doc! { "_id": 1 }),
                Some(doc! { "_id": 1 }),
                batch,
            )
            .await?
            .into_iter()
            .filter_map(|d| d.get("_id").cloned())
            .collect();
            let Some(last) = ids.last().cloned() else {
                return Ok(true);
            };
            if guard.confirm().await.is_err() {
                return Ok(false);
            }
            let targets = doc! { "_id": { "$in": ids.clone() } };
            match &step {
                Step::Delete => {
                    self.boundary("retention.delete").await;
                    ops::delete_many(self, collection, targets).await?;
                }
                Step::Pipeline(stages) => {
                    self.boundary("retention.update").await;
                    let mut ctx = WriteContext::new(self.clock.now_ms());
                    let prepared = info.prepare_pipeline_update_unchecked(
                        &targets,
                        stages.to_vec(),
                        UpdateOptions::default(),
                        &mut ctx,
                    )?;
                    ops::update_prepared(self, collection, &prepared, true).await?;
                }
                Step::Operators(update) => {
                    self.boundary("retention.update").await;
                    let mut ctx = WriteContext::new(self.clock.now_ms());
                    let prepared = info.prepare_update(
                        &targets,
                        (*update).clone(),
                        UpdateOptions::default(),
                        &mut ctx,
                    )?;
                    ops::update_prepared(self, collection, &prepared, true).await?;
                }
            }
            if i64::try_from(ids.len()).unwrap_or(i64::MAX) < batch {
                return Ok(true);
            }
            after = Some(last);
        }
    }

    /// `adjustAiUsageRetention(channelIDs, planTier)` behind `guard` (module docs).
    pub async fn adjust_retention(
        &self,
        channel_ids: &[String],
        tier: PlanTier,
        guard: &EffectGuard<'_>,
    ) -> Result<Retention, LedgerError> {
        if channel_ids.is_empty() {
            return Ok(Retention::Applied);
        }
        let tier = valid_tier(Some(tier.as_str()));
        let days = retention_days(tier);
        let now = self.clock.now_ms();
        let channels: Vec<Bson> = channel_ids.iter().map(|c| Bson::from(c.as_str())).collect();
        let of_channels = doc! { "channelID": { "$in": channels } };
        let receipts_pipeline = [doc! { "$set": {
            "retentionTier": tier.as_str(),
            "expiresAt": { "$dateAdd": { "startDate": "$occurredAt", "unit": "day", "amount": days } },
        } }];
        let dailies_pipeline = [doc! { "$set": {
            "retentionTier": tier.as_str(),
            "expiresAt": { "$dateAdd": { "startDate": "$dayStart", "unit": "day", "amount": days + 1 } },
        } }];
        let coverage =
            doc! { "$max": { "coverageStart": DateTime::from_millis(now - days * super::DAY_MS) } };
        let mut expired = of_channels.clone();
        expired.insert("expiresAt", doc! { "$lte": DateTime::from_millis(now) });
        let steps: [(&str, &dima_model::CollectionInfo, &Document, Step<'_>); 6] = [
            (
                ai_usage_dashboards::COLLECTION,
                &ai_usage_dashboards::INFO,
                &of_channels,
                Step::Delete,
            ),
            (
                ai_usage_ledger_states::COLLECTION,
                &ai_usage_ledger_states::INFO,
                &of_channels,
                Step::Operators(&coverage),
            ),
            (
                ai_usage_receipts::COLLECTION,
                &ai_usage_receipts::INFO,
                &of_channels,
                Step::Pipeline(&receipts_pipeline),
            ),
            (
                ai_usage_dailies::COLLECTION,
                &ai_usage_dailies::INFO,
                &of_channels,
                Step::Pipeline(&dailies_pipeline),
            ),
            (
                ai_usage_receipts::COLLECTION,
                &ai_usage_receipts::INFO,
                &expired,
                Step::Delete,
            ),
            (
                ai_usage_dailies::COLLECTION,
                &ai_usage_dailies::INFO,
                &expired,
                Step::Delete,
            ),
        ];
        for (collection, info, filter, step) in steps {
            if !self
                .retention_step(guard, collection, info, filter, step)
                .await?
            {
                return Ok(Retention::Stale);
            }
        }
        Ok(Retention::Applied)
    }
}

impl PlanEffects for UsageRetention<'_> {
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        tier: PlanTier,
        guard: &'a EffectGuard<'a>,
    ) -> BoxFuture<'a, Result<Retention, String>> {
        Box::pin(async move {
            self.ledger
                .adjust_retention(channel_ids, tier, guard)
                .await
                .map_err(|error| error.to_string())
        })
    }
}
