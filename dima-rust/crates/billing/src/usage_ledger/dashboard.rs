//! The usage page's dashboard: totals per day, category and adjustment type of a window, and the
//! daily history the pacing forecast uses, cached in `ai_usage_dashboards` per request.
//!
//! References: `computeDashboard` and `getAiUsageDashboard` of `utils/ai_usage_dashboard.ts`
//! (the API reads through them) and `dashboard.rs` of the native worker (`due` and `refresh`,
//! which production runs every 10 s in place of `refreshAiUsageDashboards`). The two compute the
//! same figures; the summary's orderings are `localeCompare` in the reference and byte order in
//! the native worker, which agree on every category and adjustment type the ledger stores.
//!
//! A dashboard is keyed by the SHA-256 of `JSON.stringify(request)` (a stored identity: the
//! request is built in the reference's key order and written by `dima_text::to_js_json`). It is
//! served from the cache when it is clean and younger than a minute; otherwise it is computed
//! under the account lock and stored (`$set`, upsert on `key`). Every receipt marks the
//! account's dashboards dirty, and the refresh recomputes dirty and stale ones, at most
//! [`REFRESH_LIMIT`] per call. Each computation reads at most two bounded aggregates (one group
//! per day, category, kind and adjustment type).

use super::lock::AccountLock;
use super::report::{DAY_MS, ITEMIZATION_STARTED_AT, Window, iso, iso_day, locale_compare, num};
use super::{Ledger, LedgerError, ops, retention_days, valid_tier};
use bson::{Bson, DateTime, Document, doc};
use dima_model::ai_usage_dashboards;
use dima_store::mongo::WriteContext;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// How many dashboards one refresh recomputes at most (`limit = 20`).
pub const REFRESH_LIMIT: i64 = 20;
/// A clean dashboard younger than this is served from the cache (`60_000` ms).
pub const FRESH_MS: i64 = 60_000;
/// Groups a dashboard aggregate may return at most (days × categories × kinds × types: far
/// above anything stored; an excess fails loudly).
const MAX_GROUPS: usize = 100_000;

/// What `getAiUsageDashboard` is called with.
#[derive(Clone, Copy, Debug)]
pub struct DashboardInput<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `customerId`.
    pub customer_id: &'a str,
    /// `planTier` (the user's stored text).
    pub plan_tier: &'a str,
    /// `accountCreatedAt` (the user's `created_at`).
    pub account_created_at_ms: i64,
    /// The window.
    pub window: &'a Window,
}

/// `DashboardRequest`: `{channelID, customerId, planTier, accountCreatedAt, window}`, dates as
/// ISO text.
pub fn dashboard_request(input: &DashboardInput<'_>) -> Value {
    let mut map = Map::new();
    map.insert("channelID".into(), Value::from(input.channel_id));
    map.insert("customerId".into(), Value::from(input.customer_id));
    map.insert("planTier".into(), Value::from(input.plan_tier));
    map.insert(
        "accountCreatedAt".into(),
        Value::from(iso(input.account_created_at_ms)),
    );
    map.insert("window".into(), input.window.to_json());
    Value::Object(map)
}

/// The dashboard's `key`: SHA-256 (hex) of `JSON.stringify(request)`.
pub fn dashboard_key(request: &Value) -> String {
    hex::encode(Sha256::digest(dima_text::to_js_json(request).as_bytes()))
}

/// A dashboard as the API answers it.
#[derive(Clone, Debug, PartialEq)]
pub struct DashboardAnswer {
    /// `{summary, history}`.
    pub data: Value,
    /// When it was computed (ms).
    pub refreshed_at_ms: i64,
    /// Served from the cache.
    pub cached: bool,
}

impl DashboardAnswer {
    /// `data.summary`.
    pub fn summary(&self) -> Option<&Value> {
        self.data.get("summary")
    }

    /// `data.history` (`null` when there is none).
    pub fn history(&self) -> Option<&Value> {
        self.data.get("history")
    }

    /// `{...data, refreshedAt, cached}`.
    pub fn to_json(&self) -> Value {
        let mut map = self.data.as_object().cloned().unwrap_or_default();
        map.insert("refreshedAt".into(), Value::from(iso(self.refreshed_at_ms)));
        map.insert("cached".into(), Value::Bool(self.cached));
        Value::Object(map)
    }
}

/// JSON as Mongoose stores a `Mixed` value: numbers as JavaScript numbers.
pub(crate) fn json_to_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(flag) => Bson::Boolean(*flag),
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => Bson::String(text.clone()),
        Value::Array(items) => Bson::Array(items.iter().map(json_to_bson).collect()),
        Value::Object(object) => Bson::Document(
            object
                .iter()
                .map(|(key, value)| (key.clone(), json_to_bson(value)))
                .collect(),
        ),
    }
}

/// A stored `Mixed` value as JavaScript reads it (numbers of any width as numbers, dates as
/// ISO text the way `JSON.stringify` writes a `Date`).
pub(crate) fn bson_to_json(value: &Bson) -> Value {
    match value {
        Bson::Double(n) => num(*n),
        Bson::Int32(n) => num(f64::from(*n)),
        #[allow(clippy::cast_precision_loss)]
        Bson::Int64(n) => num(*n as f64),
        Bson::String(text) => Value::String(text.clone()),
        Bson::Boolean(flag) => Value::Bool(*flag),
        Bson::Array(items) => Value::Array(items.iter().map(bson_to_json).collect()),
        Bson::Document(document) => Value::Object(
            document
                .iter()
                .map(|(key, value)| (key.clone(), bson_to_json(value)))
                .collect(),
        ),
        Bson::DateTime(at) => Value::from(iso(at.timestamp_millis())),
        Bson::ObjectId(id) => Value::from(id.to_hex()),
        _ => Value::Null,
    }
}

fn numeric(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(v)) => f64::from(*v),
        #[allow(clippy::cast_precision_loss)]
        Some(Bson::Int64(v)) => *v as f64,
        Some(Bson::Double(v)) => *v,
        _ => 0.0,
    }
}

fn text<'a>(object: &'a Value, key: &str) -> Result<&'a str, LedgerError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(LedgerError::Malformed("dashboard request"))
}

#[derive(Default)]
struct Sums {
    credits: f64,
    count: f64,
}

#[derive(Default)]
struct Adjustment {
    granted: f64,
    debited: f64,
    count: f64,
}

impl Ledger<'_> {
    /// `aggregateRows(request, start, end, timeZone, now)`.
    async fn dashboard_rows(
        &self,
        channel: &str,
        customer: &str,
        start_ms: i64,
        end_ms: i64,
        time_zone: &str,
        now_ms: i64,
    ) -> Result<Vec<Document>, LedgerError> {
        let usage = doc! { "$and": [ { "$gt": ["$credits", 0] }, { "$ne": ["$entryKind", "adjustment"] } ] };
        let pipeline = vec![
            doc! { "$match": {
                "channelID": channel, "customerId": customer,
                "occurredAt": { "$gte": DateTime::from_millis(start_ms), "$lt": DateTime::from_millis(end_ms) },
                "expiresAt": { "$gt": DateTime::from_millis(now_ms) },
            } },
            doc! { "$group": {
                "_id": {
                    "date": { "$dateToString": { "date": "$occurredAt", "format": "%Y-%m-%d", "timezone": time_zone } },
                    "category": "$category",
                    "kind": "$entryKind",
                    "adjustmentType": { "$ifNull": ["$adjustmentType", "other"] },
                },
                "spent": { "$sum": { "$cond": [usage.clone(), "$credits", 0] } },
                "granted": { "$sum": { "$cond": [ { "$lt": ["$credits", 0] }, { "$multiply": ["$credits", -1] }, 0 ] } },
                "debited": { "$sum": { "$cond": [ { "$and": [ { "$gt": ["$credits", 0] }, { "$eq": ["$entryKind", "adjustment"] } ] }, "$credits", 0 ] } },
                "count": { "$sum": { "$cond": [usage, 1, 0] } },
                "adjustments": { "$sum": { "$cond": [ { "$or": [ { "$eq": ["$entryKind", "adjustment"] }, { "$lt": ["$credits", 0] } ] }, 1, 0 ] } },
            } },
        ];
        ops::aggregate(
            self,
            dima_model::ai_usage_receipts::COLLECTION,
            pipeline,
            MAX_GROUPS,
        )
        .await
    }

    /// `computeDashboard(request, now)`: `{summary, history}`.
    pub async fn compute_dashboard(
        &self,
        request: &Value,
        now_ms: i64,
    ) -> Result<Value, LedgerError> {
        let channel = text(request, "channelID")?;
        let customer = text(request, "customerId")?;
        let window = request
            .get("window")
            .ok_or(LedgerError::Malformed("dashboard request"))?;
        let start = dima_text::parse_date(text(window, "startTimestamp")?)
            .ok_or(LedgerError::Malformed("dashboard range"))?;
        let end = dima_text::parse_date(text(window, "endTimestampExclusive")?)
            .ok_or(LedgerError::Malformed("dashboard range"))?;
        let time_zone = text(window, "timeZone")?;
        let days: Vec<&str> = window
            .get("days")
            .and_then(Value::as_array)
            .ok_or(LedgerError::Malformed("dashboard days"))?
            .iter()
            .map(|d| d.as_str().ok_or(LedgerError::Malformed("dashboard day")))
            .collect::<Result<_, _>>()?;
        let rows = self
            .dashboard_rows(channel, customer, start, end, time_zone, now_ms)
            .await?;

        let mut daily: Vec<(String, Sums)> = Vec::new();
        for day in &days {
            if !daily.iter().any(|(d, _)| d == day) {
                daily.push(((*day).to_owned(), Sums::default()));
            }
        }
        let mut categories: Vec<(String, Sums)> = Vec::new();
        let mut adjustments: Vec<(String, Adjustment)> = Vec::new();
        let (mut spent, mut granted, mut debited, mut count) = (0.0, 0.0, 0.0, 0.0);
        for row in &rows {
            let id = row
                .get_document("_id")
                .map_err(|_| LedgerError::Malformed("dashboard group"))?;
            let (s, g, d, c) = (
                numeric(row, "spent"),
                numeric(row, "granted"),
                numeric(row, "debited"),
                numeric(row, "count"),
            );
            spent += s;
            granted += g;
            debited += d;
            count += c;
            if let Ok(day) = id.get_str("date")
                && let Some((_, sums)) = daily.iter_mut().find(|(d, _)| d == day)
            {
                sums.credits += s;
                sums.count += c;
            }
            if c != 0.0 {
                let key = id
                    .get_str("category")
                    .ok()
                    .filter(|k| !k.is_empty())
                    .unwrap_or("uncategorized");
                match categories.iter_mut().find(|(k, _)| k == key) {
                    Some((_, sums)) => {
                        sums.credits += s;
                        sums.count += c;
                    }
                    None => categories.push((
                        key.to_owned(),
                        Sums {
                            credits: s,
                            count: c,
                        },
                    )),
                }
            }
            let a = numeric(row, "adjustments");
            if a != 0.0 {
                let key = id
                    .get_str("adjustmentType")
                    .map_err(|_| LedgerError::Malformed("dashboard adjustment type"))?;
                match adjustments.iter_mut().find(|(k, _)| k == key) {
                    Some((_, sums)) => {
                        sums.granted += g;
                        sums.debited += d;
                        sums.count += a;
                    }
                    None => adjustments.push((
                        key.to_owned(),
                        Adjustment {
                            granted: g,
                            debited: d,
                            count: a,
                        },
                    )),
                }
            }
        }
        categories.sort_by(|(a, av), (b, bv)| {
            let difference = bv.credits - av.credits;
            if difference != 0.0 && !difference.is_nan() {
                difference
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            } else {
                locale_compare(a, b)
            }
        });
        adjustments.sort_by(|(a, _), (b, _)| locale_compare(a, b));
        #[allow(clippy::cast_precision_loss)]
        let day_count = days.len().max(1) as f64;
        let mut period = Map::new();
        period.insert("from".into(), Value::from(text(window, "from")?));
        period.insert("to".into(), Value::from(text(window, "to")?));
        period.insert("timeZone".into(), Value::from(time_zone));
        period.insert("dayCount".into(), Value::from(days.len()));
        let mut summary = Map::new();
        summary.insert("schemaVersion".into(), Value::from(1));
        summary.insert(
            "itemizationStartedAt".into(),
            Value::from(ITEMIZATION_STARTED_AT),
        );
        summary.insert("period".into(), Value::Object(period));
        summary.insert("totalSpentCredits".into(), num(spent));
        summary.insert(
            "averageDailySpentCredits".into(),
            num(crate::js::round(spent / day_count * 100.0) / 100.0),
        );
        summary.insert("grantedCredits".into(), num(granted));
        summary.insert("adjustmentDebitedCredits".into(), num(debited));
        summary.insert("netConsumedCredits".into(), num(spent + debited - granted));
        summary.insert("transactionCount".into(), num(count));
        summary.insert(
            "daily".into(),
            Value::Array(
                daily
                    .into_iter()
                    .map(|(date, sums)| {
                        let mut map = Map::new();
                        map.insert("date".into(), Value::from(date));
                        map.insert("credits".into(), num(sums.credits));
                        map.insert("transactionCount".into(), num(sums.count));
                        Value::Object(map)
                    })
                    .collect(),
            ),
        );
        summary.insert(
            "categories".into(),
            Value::Array(
                categories
                    .into_iter()
                    .map(|(category, sums)| {
                        let mut map = Map::new();
                        map.insert("category".into(), Value::from(category));
                        map.insert("credits".into(), num(sums.credits));
                        map.insert("transactionCount".into(), num(sums.count));
                        map.insert(
                            "percentage".into(),
                            num(if spent != 0.0 {
                                crate::js::round(sums.credits / spent * 10_000.0) / 100.0
                            } else {
                                0.0
                            }),
                        );
                        Value::Object(map)
                    })
                    .collect(),
            ),
        );
        summary.insert(
            "adjustments".into(),
            Value::Array(
                adjustments
                    .into_iter()
                    .map(|(kind, sums)| {
                        let mut map = Map::new();
                        map.insert("type".into(), Value::from(kind));
                        map.insert("grantedCredits".into(), num(sums.granted));
                        map.insert("debitedCredits".into(), num(sums.debited));
                        map.insert("transactionCount".into(), num(sums.count));
                        Value::Object(map)
                    })
                    .collect(),
            ),
        );

        let state = self.ledger_state(channel, customer).await?;
        // Only completed UTC days enter the baseline.
        let end_day = super::record::utc_day(now_ms);
        let created = request
            .get("accountCreatedAt")
            .and_then(Value::as_str)
            .and_then(dima_text::parse_date)
            .unwrap_or(0);
        let coverage = state
            .as_ref()
            .map(|s| s.coverage_start_ms)
            .filter(|c| *c != 0)
            .unwrap_or(now_ms);
        let tier = valid_tier(request.get("planTier").and_then(Value::as_str));
        let floor = (now_ms - retention_days(tier) * DAY_MS)
            .max(created)
            .max(coverage);
        let start_day = floor.div_euclid(DAY_MS) * DAY_MS
            + if floor.rem_euclid(DAY_MS) > 0 {
                DAY_MS
            } else {
                0
            };
        let history_days = ((end_day - start_day).div_euclid(DAY_MS)).max(0);
        let history = if history_days > 0 && state.is_some() {
            let rows = self
                .dashboard_rows(channel, customer, start_day, end_day, "UTC", now_ms)
                .await?;
            let mut totals: Vec<(String, f64)> = Vec::new();
            for row in &rows {
                let day = row
                    .get_document("_id")
                    .ok()
                    .and_then(|id| id.get_str("date").ok())
                    .ok_or(LedgerError::Malformed("dashboard group"))?;
                let s = numeric(row, "spent");
                match totals.iter_mut().find(|(d, _)| d == day) {
                    Some((_, total)) => *total += s,
                    None => totals.push((day.to_owned(), s)),
                }
            }
            let samples: Vec<f64> = (0..history_days)
                .map(|index| {
                    let day = iso_day(start_day + index * DAY_MS);
                    totals
                        .iter()
                        .find(|(d, _)| *d == day)
                        .map_or(0.0, |(_, total)| *total)
                })
                .collect();
            #[allow(clippy::cast_precision_loss)]
            let n = history_days as f64;
            let total: f64 = samples.iter().sum();
            let mean = total / n;
            let variance = samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
            let recent = samples
                .get(samples.len().saturating_sub(7)..)
                .unwrap_or_default();
            #[allow(clippy::cast_precision_loss)]
            let recent_average = recent.iter().sum::<f64>() / recent.len() as f64;
            let mut map = Map::new();
            map.insert("averageDailyCredits".into(), num(mean));
            map.insert("totalSpentCredits".into(), num(total));
            map.insert("dayCount".into(), Value::from(history_days));
            map.insert("from".into(), Value::from(iso_day(start_day)));
            map.insert("to".into(), Value::from(iso_day(end_day - 1)));
            map.insert(
                "activeDayCount".into(),
                Value::from(samples.iter().filter(|v| **v > 0.0).count()),
            );
            map.insert(
                "coefficientOfVariation".into(),
                num(if mean > 0.0 {
                    variance.sqrt() / mean
                } else {
                    0.0
                }),
            );
            map.insert("recentAverageDailyCredits".into(), num(recent_average));
            map.insert("recentDayCount".into(), Value::from(recent.len()));
            Value::Object(map)
        } else {
            Value::Null
        };
        let mut data = Map::new();
        data.insert("summary".into(), Value::Object(summary));
        data.insert("history".into(), history);
        Ok(Value::Object(data))
    }

    /// `getAiUsageDashboard(input)` (the API's read).
    pub async fn get_dashboard(
        &self,
        input: &DashboardInput<'_>,
    ) -> Result<DashboardAnswer, LedgerError> {
        let request = dashboard_request(input);
        let key = dashboard_key(&request);
        let now = self.clock.now_ms();
        let existing = ops::find_one(
            self,
            ai_usage_dashboards::COLLECTION,
            doc! { "key": &key },
            None,
        )
        .await?;
        if let Some(existing) = &existing
            && existing.get_bool("dirty").ok() != Some(true)
            && let Ok(refreshed) = existing.get_datetime("refreshedAt")
            && now - refreshed.timestamp_millis() < FRESH_MS
        {
            return Ok(DashboardAnswer {
                data: existing.get("data").map_or(Value::Null, bson_to_json),
                refreshed_at_ms: refreshed.timestamp_millis(),
                cached: true,
            });
        }
        let lock = AccountLock::acquire(self, input.channel_id, input.customer_id).await?;
        let outcome = self
            .store_dashboard(&lock, input, &request, &key, now)
            .await;
        lock.release(self).await;
        outcome
    }

    async fn store_dashboard(
        &self,
        lock: &AccountLock,
        input: &DashboardInput<'_>,
        request: &Value,
        key: &str,
        now: i64,
    ) -> Result<DashboardAnswer, LedgerError> {
        let data = self.compute_dashboard(request, self.clock.now_ms()).await?;
        let mut ctx = WriteContext::new(now);
        let prepared = ai_usage_dashboards::INFO.prepare_update(
            &doc! { "key": key },
            doc! { "$set": {
                "channelID": input.channel_id,
                "customerId": input.customer_id,
                "planTier": input.plan_tier,
                "key": key,
                "request": json_to_bson(request),
                "data": json_to_bson(&data),
                "dirty": false,
                "refreshedAt": DateTime::from_millis(now),
                "expiresAt": DateTime::from_millis(now + DAY_MS),
            } },
            UpdateOptions::upsert(),
            &mut ctx,
        )?;
        lock.confirm(self).await?;
        self.boundary("dashboard.store").await;
        ops::update_prepared(self, ai_usage_dashboards::COLLECTION, &prepared, false).await?;
        Ok(DashboardAnswer {
            data,
            refreshed_at_ms: now,
            cached: false,
        })
    }

    /// The native worker's dashboard refresh: recomputes up to [`REFRESH_LIMIT`] dashboards
    /// that are dirty or older than a minute (oldest first), each under its account lock.
    /// A dashboard whose stored request cannot be read is reported and skipped (the native
    /// worker stopped its whole pass on one); it expires within a day. Returns how many were
    /// recomputed.
    pub async fn refresh_dashboards(
        &self,
        observer: &dyn crate::Observer,
    ) -> Result<usize, LedgerError> {
        let now = self.clock.now_ms();
        let due = ops::find(
            self,
            ai_usage_dashboards::COLLECTION,
            doc! {
                "expiresAt": { "$gt": DateTime::from_millis(now) },
                "$or": [ { "dirty": true }, { "refreshedAt": { "$lte": DateTime::from_millis(now - FRESH_MS) } } ],
            },
            Some(doc! { "refreshedAt": 1 }),
            None,
            REFRESH_LIMIT,
        )
        .await?;
        let mut refreshed = 0;
        for document in due {
            let (Ok(channel), Ok(customer), Some(id)) = (
                document.get_str("channelID"),
                document.get_str("customerId"),
                document.get("_id").cloned(),
            ) else {
                observer.error("refreshAiUsageDashboards", "dashboard without its account");
                continue;
            };
            let request = document.get("request").map_or(Value::Null, bson_to_json);
            let lock = AccountLock::acquire(self, channel, customer).await?;
            let outcome = async {
                let at = self.clock.now_ms();
                let data = self.compute_dashboard(&request, at).await?;
                let mut ctx = WriteContext::new(at).native_numbers();
                let prepared = ai_usage_dashboards::INFO.prepare_update(
                    &doc! { "_id": id },
                    doc! { "$set": {
                        "data": json_to_bson(&data),
                        "dirty": false,
                        "refreshedAt": DateTime::from_millis(self.clock.now_ms()),
                    } },
                    UpdateOptions::default(),
                    &mut ctx,
                )?;
                lock.confirm(self).await?;
                self.boundary("dashboard.refresh").await;
                ops::update_prepared(self, ai_usage_dashboards::COLLECTION, &prepared, false)
                    .await?;
                Ok::<_, LedgerError>(())
            }
            .await;
            lock.release(self).await;
            match outcome {
                Ok(()) => refreshed += 1,
                Err(LedgerError::Malformed(what)) => {
                    observer.error(
                        "refreshAiUsageDashboards",
                        &format!("skipped: malformed {what}"),
                    );
                }
                Err(error) => return Err(error),
            }
        }
        Ok(refreshed)
    }
}
