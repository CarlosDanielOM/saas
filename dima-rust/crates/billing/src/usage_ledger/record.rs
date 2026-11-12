//! The ledger's writes: recording a use (one receipt), rebuilding the daily totals of a range of
//! UTC days, and writing a backfill from Polar's history.
//!
//! References: `ledger::persist` and `rebuild` of the native worker (`dima-rust/src/workers/
//! ai_usage_receipts/ledger.rs`, what production runs for the receipt queue) and
//! `backfillAiUsageLedger` / `rebuildUtcDailyAggregates` of `utils/ai_usage_ledger.ts` (what the
//! TypeScript backfill runs). Both write under the account lock ([`super::lock`]), confirmed
//! before every write.
//!
//! **Recording a use** (`persist_receipt`): mark the account's dashboards dirty; skip a receipt
//! already past its retention ([`Persisted::Expired`]); upsert the receipt on
//! `{channelID, customerId, entryId}` with `$setOnInsert` (a second delivery matches and
//! changes nothing: [`Persisted::Duplicate`]); rebuild its UTC day from the stored receipts. The
//! day is rebuilt for a duplicate too: an earlier attempt may have stored the receipt and been
//! stopped before its day (the reference's own comment). Numbers keep the native worker's types
//! (`WriteContext::native_numbers`, with JavaScript's int32-or-double already applied).
//!
//! **A day's totals** are recomputed from the receipts that have not expired: the range's days
//! are deleted and inserted again (unordered). Between the two a reader sees the days missing;
//! a stop there leaves them missing until the next rebuild of the day, which the retry of the
//! interrupted receipt (still in the processing list) or the next backfill makes. The unique
//! `{channelID, customerId, date}` index refuses a second copy of a day; nothing increments.
//!
//! **The tier a write carries** (item 4 of P2-BILLING-02c, re-check point S5). A receipt's and a
//! day's `retentionTier` and `expiresAt` come from the plan of the channel's owner. A writer used
//! to carry a tier read earlier (the consumer's for its batch, the backfill job's from when it was
//! queued); a plan change could write the owner's new tier and finish its retention pass in
//! between, and the receipt was then inserted with the old tier's expiry, which `$setOnInsert`
//! never repairs: after an upgrade the TTL deleted history a paying channel should keep. Now both
//! writers run under the same per-owner coordination as a plan change: after the account lock,
//! they take the owner's plan effects lease (`locks:plan-effects:{owner id}`,
//! [`crate::plans::projection`]), read the owner's tier under it, and write with that tier; the
//! lock confirms the lease with itself before every write ([`AccountLock::confirm`]). A plan
//! change holds the same lease from its write of the owner's tier to the end of its retention
//! pass. So for every receipt either its write comes before the plan write (and the pass, which
//! starts after it, adjusts the receipt) or its tier read comes after the pass (and it reads the
//! new tier): no stale tier is written. The tier passed by the caller is used only for a channel
//! no user owns (no plan change can touch it). A plan change that is running makes a receipt wait
//! [`super::LedgerConfig::plan_lease_wait`], then [`LedgerError::PlanChanging`] (the consumer
//! leaves the receipt for its next call); a backfill waits
//! [`super::LedgerConfig::backfill_plan_lease_wait`]. The lease is a fence as for the plan
//! effects: a holder that stalls past it is refused at its next confirmation.
//!
//! Key order of a rebuilt day: the native worker appends `categories` last; Mongoose writes it
//! in schema order. Each is kept for the path that writes it in production
//! ([`DailyShape`]): the receipt queue's days are the native worker's, the backfill's are
//! Mongoose's. MongoDB orders an upserted receipt itself (filter fields, then the new fields in
//! lexicographic order), so both writers store the same receipt document.

use super::lock::{AccountLock, PlanLease};
use super::ops;
use super::receipt::{QueuedReceipt, safe_category};
use super::report::{DAY_MS, Transaction};
use super::{Ledger, LedgerError, REPORT_VERSION, retention_days, valid_tier};
use crate::usage::{AdjustmentInput, classify_adjustment};
use bson::{Bson, DateTime, Document, doc};
use dima_model::StrEnum;
use dima_model::ai_usage_receipts::RetentionTier;
use dima_model::{
    ai_usage_dailies, ai_usage_dashboards, ai_usage_ledger_states, ai_usage_receipts,
};
use dima_store::mongo::WriteContext;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;

/// What recording a receipt did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Persisted {
    /// Stored now.
    Inserted,
    /// Already stored (this delivery changed no receipt).
    Duplicate,
    /// Past its plan's retention: not stored (`'expired'`).
    Expired,
}

/// The key order of a rebuilt day (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DailyShape {
    /// The native worker's (`categories` last).
    Native,
    /// Mongoose's (schema order).
    Mongoose,
}

fn date(ms: i64) -> Bson {
    Bson::DateTime(DateTime::from_millis(ms))
}

fn text_or_null(value: Option<&str>) -> Bson {
    value.map_or(Bson::Null, |text| Bson::String(text.to_owned()))
}

/// The day start (UTC midnight) of `ms`.
pub(crate) fn utc_day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

/// A number of an aggregate group as JavaScript reads it (missing is `0`, as the native worker's
/// `numeric`).
fn numeric(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(v)) => f64::from(*v),
        #[allow(clippy::cast_precision_loss)]
        Some(Bson::Int64(v)) => *v as f64,
        Some(Bson::Double(v)) => *v,
        _ => 0.0,
    }
}

/// `{channelID, customerId}` with its `dirty` set (every receipt and backfill marks them).
fn dirty_update(
    channel: &str,
    customer: &str,
    now_ms: i64,
) -> Result<dima_store::mongo::update::PreparedUpdate, LedgerError> {
    let mut ctx = WriteContext::new(now_ms).native_numbers();
    Ok(ai_usage_dashboards::INFO.prepare_update(
        &doc! { "channelID": channel, "customerId": customer },
        doc! { "$set": { "dirty": true } },
        UpdateOptions::default(),
        &mut ctx,
    )?)
}

#[derive(Default)]
struct Row {
    spent: f64,
    granted: f64,
    debited: f64,
    count: f64,
    categories: Document,
    expires_ms: i64,
}

impl Ledger<'_> {
    /// Marks the account's dashboards dirty (`Dashboards.updateMany(..., {$set: {dirty: true}})`).
    async fn mark_dashboards_dirty(
        &self,
        lock: &AccountLock,
        channel: &str,
        customer: &str,
    ) -> Result<(), LedgerError> {
        lock.confirm(self).await?;
        self.boundary("dashboards.dirty").await;
        let prepared = dirty_update(channel, customer, self.clock.now_ms())?;
        ops::update_prepared(self, ai_usage_dashboards::COLLECTION, &prepared, true).await?;
        Ok(())
    }

    /// The tier of `channel`'s owner, read under the owner's plan effects lease, which `lock`
    /// then holds (module docs); `ownerless` when no user owns the channel.
    async fn owner_tier(
        &self,
        lock: &mut AccountLock,
        channel: &str,
        ownerless: RetentionTier,
        wait: std::time::Duration,
    ) -> Result<RetentionTier, LedgerError> {
        let by_channel = doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": channel } } };
        let found = ops::find_one(
            self,
            dima_model::users::COLLECTION,
            by_channel,
            Some(doc! { "_id": 1 }),
        )
        .await?;
        let Some(owner) = found.and_then(|user| user.get_object_id("_id").ok()) else {
            return Ok(ownerless);
        };
        let key = crate::plans::projection::effects_lease_key(&owner);
        let token = self.random.uuid_v4().map_err(|_| LedgerError::Random)?;
        if !crate::plans::projection::take_owner_lease(self.dragonfly, &key, &token, wait).await? {
            return Err(LedgerError::PlanChanging);
        }
        lock.hold_plan(PlanLease { key, token });
        // Read again under the lease: the plan stored now is the one every later plan change's
        // retention pass starts from.
        let user = ops::find_one(
            self,
            dima_model::users::COLLECTION,
            doc! { "_id": owner },
            Some(doc! { "plan_tier": 1 }),
        )
        .await?;
        Ok(match user {
            Some(user) => valid_tier(user.get_str("plan_tier").ok()),
            None => ownerless,
        })
    }

    /// Records one use: `persistAiUsageReceipt` as the native worker runs it (module docs).
    /// The tier written is the owner's, read under the owner's plan effects lease; `ownerless`
    /// is written only for a channel no user owns (the consumer passes Free, what `validTier`
    /// makes of no owner).
    pub async fn persist_receipt(
        &self,
        receipt: &QueuedReceipt,
        ownerless: RetentionTier,
    ) -> Result<Persisted, LedgerError> {
        let customer = receipt.customer_id.expose();
        let mut lock = AccountLock::acquire(self, &receipt.channel_id, customer).await?;
        let outcome = match self
            .owner_tier(
                &mut lock,
                &receipt.channel_id,
                ownerless,
                self.config.plan_lease_wait,
            )
            .await
        {
            Ok(tier) => self.persist_locked(&lock, receipt, tier).await,
            Err(error) => Err(error),
        };
        lock.release(self).await;
        outcome
    }

    async fn persist_locked(
        &self,
        lock: &AccountLock,
        receipt: &QueuedReceipt,
        tier: RetentionTier,
    ) -> Result<Persisted, LedgerError> {
        let channel = receipt.channel_id.as_str();
        let customer = receipt.customer_id.expose().as_str();
        self.mark_dashboards_dirty(lock, channel, customer).await?;
        let expiry = receipt
            .occurred_at_ms
            .checked_add(retention_days(tier) * DAY_MS)
            .ok_or(LedgerError::Malformed("receipt expiry"))?;
        let now = self.clock.now_ms();
        if expiry <= now {
            return Ok(Persisted::Expired);
        }
        let mut ctx = WriteContext::new(now).native_numbers();
        let document = doc! {
            "channelID": channel,
            "customerId": customer,
            "entryId": &receipt.id,
            "occurredAt": date(receipt.occurred_at_ms),
            "entryKind": receipt.entry_kind.as_str(),
            "category": receipt.category,
            "credits": js_number(receipt.credits),
            "itemized": receipt.itemized,
            "requestId": text_or_null(receipt.request_id.as_deref()),
            "source": text_or_null(receipt.source.as_deref()),
            "model": text_or_null(receipt.model.as_deref()),
            "resourceId": text_or_null(receipt.resource_id.as_deref()),
            "operation": &receipt.operation,
            "provider": &receipt.provider,
            "adjustmentType": text_or_null(receipt.adjustment_type.as_deref()),
            "quantity": receipt.quantity.map_or(Bson::Null, js_number),
            "unit": text_or_null(receipt.unit.map(crate::usage::Unit::as_str)),
            "resourceType": text_or_null(receipt.resource_type.map(crate::usage::ResourceType::as_str)),
            "retentionTier": tier.as_str(),
            "expiresAt": date(expiry),
        };
        let prepared = ai_usage_receipts::INFO.prepare_update(
            &doc! { "channelID": channel, "customerId": customer, "entryId": &receipt.id },
            doc! { "$setOnInsert": document },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        lock.confirm(self).await?;
        self.boundary("receipt.upsert").await;
        let report =
            ops::update_prepared(self, ai_usage_receipts::COLLECTION, &prepared, false).await?;
        let outcome = if report.upserted.is_empty() {
            Persisted::Duplicate
        } else {
            Persisted::Inserted
        };
        let day = utc_day(receipt.occurred_at_ms);
        self.rebuild_days(
            lock,
            channel,
            customer,
            tier,
            day,
            day + DAY_MS - 1,
            DailyShape::Native,
        )
        .await?;
        Ok(outcome)
    }

    /// `rebuildUtcDailyAggregates(channelID, customerId, planTier, from, to)` under `lock`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn rebuild_days(
        &self,
        lock: &AccountLock,
        channel: &str,
        customer: &str,
        tier: RetentionTier,
        from_ms: i64,
        to_ms: i64,
        shape: DailyShape,
    ) -> Result<(), LedgerError> {
        let from = utc_day(from_ms);
        let to = utc_day(to_ms) + DAY_MS - 1;
        let now = self.clock.now_ms();
        let usage = doc! { "$and": [ { "$gt": ["$credits", 0] }, { "$ne": ["$entryKind", "adjustment"] } ] };
        let pipeline = vec![
            doc! { "$match": {
                "channelID": channel, "customerId": customer,
                "occurredAt": { "$gte": date(from), "$lte": date(to) },
                "expiresAt": { "$gt": date(now) },
            } },
            doc! { "$group": {
                "_id": {
                    "date": { "$dateToString": { "date": "$occurredAt", "format": "%Y-%m-%d", "timezone": "UTC" } },
                    "category": "$category",
                },
                "spent": { "$sum": { "$cond": [usage.clone(), "$credits", 0] } },
                "granted": { "$sum": { "$cond": [ { "$lt": ["$credits", 0] }, { "$multiply": ["$credits", -1] }, 0 ] } },
                "debited": { "$sum": { "$cond": [ { "$and": [ { "$gt": ["$credits", 0] }, { "$eq": ["$entryKind", "adjustment"] } ] }, "$credits", 0 ] } },
                "count": { "$sum": { "$cond": [usage, 1, 0] } },
                "expiresAt": { "$max": "$expiresAt" },
            } },
        ];
        let days_in_range = usize::try_from((to - from) / DAY_MS + 1).unwrap_or(usize::MAX);
        // Every receipt category is one of eight, but stored legacy values may be anything:
        // the bound is generous and an excess fails loudly.
        let groups = ops::aggregate(
            self,
            ai_usage_receipts::COLLECTION,
            pipeline,
            days_in_range.saturating_mul(256),
        )
        .await?;
        let mut rows: Vec<(String, Row)> = Vec::new();
        for group in groups {
            let id = group
                .get_document("_id")
                .map_err(|_| LedgerError::Malformed("daily group"))?;
            let day = id
                .get_str("date")
                .map_err(|_| LedgerError::Malformed("daily group"))?
                .to_owned();
            let expires = group
                .get_datetime("expiresAt")
                .map_err(|_| LedgerError::Malformed("daily expiry"))?
                .timestamp_millis();
            let index = match rows.iter().position(|(d, _)| *d == day) {
                Some(index) => index,
                None => {
                    rows.push((
                        day,
                        Row {
                            expires_ms: expires,
                            ..Row::default()
                        },
                    ));
                    rows.len() - 1
                }
            };
            let Some((_, row)) = rows.get_mut(index) else {
                continue;
            };
            let count = numeric(&group, "count");
            row.spent += numeric(&group, "spent");
            row.granted += numeric(&group, "granted");
            row.debited += numeric(&group, "debited");
            row.count += count;
            row.expires_ms = row.expires_ms.max(expires);
            if count != 0.0 {
                // An assignment, as the reference: two stored categories that both read as
                // `uncategorized` keep the later group's figures (the native worker does too).
                row.categories.insert(
                    safe_category(id.get_str("category").ok()),
                    doc! {
                        "credits": js_number(numeric(&group, "spent")),
                        "transactionCount": js_number(count),
                    },
                );
            }
        }
        let mut ctx = WriteContext::new(now);
        let mut inserts = Vec::with_capacity(rows.len());
        for (day, row) in rows {
            let day_start =
                dima_text::parse_date(&day).ok_or(LedgerError::Malformed("daily date"))?;
            let given = doc! {
                "channelID": channel,
                "customerId": customer,
                "date": &day,
                "dayStart": date(day_start),
                "spentCredits": js_number(row.spent),
                "grantedCredits": js_number(row.granted),
                "netConsumedCredits": js_number(row.spent + row.debited - row.granted),
                "transactionCount": js_number(row.count),
                "categories": row.categories,
                "retentionTier": tier.as_str(),
                "expiresAt": date(row.expires_ms),
            };
            let mut insert = ai_usage_dailies::INFO.prepare_create(&given, &mut ctx)?;
            if shape == DailyShape::Native
                && let Some(categories) = insert.document.remove("categories")
            {
                insert.document.insert("categories", categories);
            }
            inserts.push(insert);
        }
        let from_day = super::report::iso_day(from);
        let to_day = super::report::iso_day(to);
        lock.confirm(self).await?;
        self.boundary("dailies.delete").await;
        ops::delete_many(
            self,
            ai_usage_dailies::COLLECTION,
            doc! { "channelID": channel, "customerId": customer, "date": { "$gte": from_day, "$lte": to_day } },
        )
        .await?;
        if !inserts.is_empty() {
            lock.confirm(self).await?;
            self.boundary("dailies.insert").await;
            let report =
                ops::insert_many(self, ai_usage_dailies::COLLECTION, &inserts, false).await?;
            if !report.duplicates.is_empty() {
                // Another writer inserted the same day meanwhile (only possible when a lock
                // was lost): the unique index kept one copy; the next rebuild settles it.
                return Err(LedgerError::LeaseLost);
            }
        }
        Ok(())
    }

    /// `backfillAiUsageLedger(input)`: writes the transactions read from Polar for one channel
    /// and customer (those within the plan's retention), rebuilds the days from `rebuild_start`
    /// (else `coverage_start`) to now, and records the coverage (`$min`) and the sync time.
    ///
    /// The plan is the owner's, read under the owner's plan effects lease (module docs);
    /// `input.plan_tier` stands only for a channel no user owns.
    pub async fn backfill(&self, input: &BackfillWrite<'_>) -> Result<(), LedgerError> {
        let mut lock = AccountLock::acquire(self, input.channel_id, input.customer_id).await?;
        let outcome = match self
            .owner_tier(
                &mut lock,
                input.channel_id,
                valid_tier(input.plan_tier),
                self.config.backfill_plan_lease_wait,
            )
            .await
        {
            Ok(tier) => self.backfill_locked(&lock, input, tier).await,
            Err(error) => Err(error),
        };
        lock.release(self).await;
        outcome
    }

    async fn backfill_locked(
        &self,
        lock: &AccountLock,
        input: &BackfillWrite<'_>,
        tier: RetentionTier,
    ) -> Result<(), LedgerError> {
        let (channel, customer) = (input.channel_id, input.customer_id);
        self.mark_dashboards_dirty(lock, channel, customer).await?;
        let now = input.now_ms;
        let floor = now - retention_days(tier) * DAY_MS;
        let receipts: Vec<&Transaction> = input
            .transactions
            .iter()
            .filter(|t| t.occurred_at_ms >= floor)
            .collect();
        let mut ctx = WriteContext::new(now);
        for batch in receipts.chunks(self.config.backfill_batch.max(1)) {
            let mut statements = Vec::with_capacity(batch.len());
            for receipt in batch {
                let prepared = ai_usage_receipts::INFO.prepare_update(
                    &doc! { "channelID": channel, "customerId": customer, "entryId": &receipt.id },
                    backfill_update(receipt, channel, customer, tier),
                    UpdateOptions::upsert(),
                    &mut ctx,
                )?;
                if let Some(statement) =
                    ops::statement(ai_usage_receipts::COLLECTION, &prepared, false)?
                {
                    statements.push(statement);
                }
            }
            lock.confirm(self).await?;
            self.boundary("backfill.receipts").await;
            let report =
                ops::update(self, ai_usage_receipts::COLLECTION, statements, false).await?;
            if !report.duplicates.is_empty() {
                return Err(LedgerError::Mongo(format!(
                    "{} receipts collided on their key; retry",
                    report.duplicates.len()
                )));
            }
        }
        self.rebuild_days(
            lock,
            channel,
            customer,
            tier,
            input.rebuild_start_ms.unwrap_or(input.coverage_start_ms),
            now,
            DailyShape::Mongoose,
        )
        .await?;
        let prepared = ai_usage_ledger_states::INFO.prepare_update(
            &doc! { "channelID": channel, "customerId": customer },
            doc! {
                "$min": { "coverageStart": date(input.coverage_start_ms) },
                "$set": { "backfilledAt": date(now), "reportVersion": REPORT_VERSION },
                "$setOnInsert": { "channelID": channel, "customerId": customer },
            },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        lock.confirm(self).await?;
        self.boundary("backfill.state").await;
        ops::update_prepared(self, ai_usage_ledger_states::COLLECTION, &prepared, false).await?;
        Ok(())
    }
}

/// The input of [`Ledger::backfill`].
#[derive(Clone, Copy, Debug)]
pub struct BackfillWrite<'a> {
    /// The channel.
    pub channel_id: &'a str,
    /// The customer.
    pub customer_id: &'a str,
    /// The plan the job was queued with (`validTier`): written only for a channel no user owns;
    /// otherwise the owner's current plan is (see [`Ledger::backfill`]).
    pub plan_tier: Option<&'a str>,
    /// The coverage reached.
    pub coverage_start_ms: i64,
    /// Where the day rebuild starts (the fetch's start).
    pub rebuild_start_ms: Option<i64>,
    /// Polar's transactions.
    pub transactions: &'a [Transaction],
    /// `now`.
    pub now_ms: i64,
}

/// `{$setOnInsert: receiptDocument minus source and adjustmentType, $set: {source,
/// adjustmentType}}` of one backfilled transaction.
fn backfill_update(
    receipt: &Transaction,
    channel: &str,
    customer: &str,
    tier: RetentionTier,
) -> Document {
    let expires = receipt.occurred_at_ms + retention_days(tier) * DAY_MS;
    let adjustment = receipt
        .adjustment_type
        .clone()
        .filter(|a| !a.is_empty())
        .or_else(|| {
            classify_adjustment(AdjustmentInput {
                entry_kind: Some(receipt.entry_kind.as_str()),
                operation: Some(&receipt.operation),
                source: receipt.source.as_deref(),
                reason: None,
                adjustment_type: receipt.adjustment_type.as_deref(),
            })
            .map(str::to_owned)
        });
    doc! {
        "$setOnInsert": {
            "channelID": channel,
            "customerId": customer,
            "entryId": &receipt.id,
            "requestId": text_or_null(receipt.request_id.as_deref()),
            "occurredAt": date(receipt.occurred_at_ms),
            "entryKind": receipt.entry_kind.as_str(),
            "category": safe_category(Some(&receipt.category)),
            "operation": &receipt.operation,
            "provider": &receipt.provider,
            "model": text_or_null(receipt.model.as_deref()),
            "quantity": receipt.quantity.map_or(Bson::Null, js_number),
            "unit": text_or_null(receipt.unit.map(crate::usage::Unit::as_str)),
            "credits": js_number(receipt.credits),
            "resourceType": text_or_null(receipt.resource_type.map(crate::usage::ResourceType::as_str)),
            "resourceId": text_or_null(receipt.resource_id.as_deref()),
            "itemized": receipt.itemized,
            "retentionTier": tier.as_str(),
            "expiresAt": date(expires),
        },
        "$set": {
            "source": text_or_null(receipt.source.as_deref().filter(|s| !s.is_empty())),
            "adjustmentType": text_or_null(adjustment.as_deref()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::EntryKind;

    #[test]
    fn backfill_updates_set_source_and_type_on_every_write() {
        let transaction = Transaction {
            id: "polar-credit:x".into(),
            request_id: None,
            occurred_at_ms: 0,
            entry_kind: EntryKind::Adjustment,
            category: "legacy".into(),
            operation: "period_credit_grant".into(),
            source: Some("polar_meter_credit".into()),
            adjustment_type: None,
            provider: "polar".into(),
            model: None,
            quantity: None,
            unit: None,
            credits: -40_000.0,
            resource_type: None,
            resource_id: None,
            itemized: true,
        };
        let update = backfill_update(&transaction, "c", "u", RetentionTier::Pro);
        let set = update.get_document("$set").unwrap();
        assert_eq!(set.get_str("adjustmentType").unwrap(), "native_grant");
        let insert = update.get_document("$setOnInsert").unwrap();
        assert_eq!(insert.get_str("category").unwrap(), "uncategorized");
        assert_eq!(insert.get("credits"), Some(&Bson::Int32(-40_000)));
        assert!(!insert.contains_key("source"));
    }
}
