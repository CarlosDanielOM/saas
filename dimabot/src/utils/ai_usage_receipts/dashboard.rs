//! Derived dashboards, built from the same bounded Mongo day/category groups.
use super::{Result, ledger, queue, values::*};
use futures_util::TryStreamExt;
use mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use std::collections::HashMap;

fn field<'a>(document: &'a Document, key: &str) -> Result<&'a str> {
    document
        .get_str(key)
        .map_err(|_| "Invalid AI usage dashboard request")
}
#[derive(Default)]
struct Category {
    credits: f64,
    count: f64,
}
#[derive(Default)]
struct Adjustment {
    granted: f64,
    debited: f64,
    count: f64,
}
fn id(row: &Document) -> Result<&Document> {
    row.get_document("_id")
        .map_err(|_| "Invalid AI usage dashboard group")
}
fn group_day(row: &Document) -> Result<&str> {
    field(id(row)?, "date")
}

fn summary(window: &Document, rows: &[Document]) -> Result<Value> {
    let days = window
        .get_array("days")
        .map_err(|_| "Invalid AI usage dashboard days")?;
    let mut daily: Vec<(String, Category)> = Vec::new();
    let mut day_index = HashMap::new();
    for day in days {
        let day = day.as_str().ok_or("Invalid AI usage dashboard day")?;
        if !day_index.contains_key(day) {
            day_index.insert(day.to_owned(), daily.len());
            daily.push((day.to_owned(), Category::default()));
        }
    }
    let mut categories: HashMap<String, Category> = HashMap::new();
    let mut adjustments: HashMap<String, Adjustment> = HashMap::new();
    let (mut spent, mut granted, mut debited, mut count) = (0.0, 0.0, 0.0, 0.0);
    for row in rows {
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
        if let Some(index) = day_index.get(group_day(row)?) {
            daily[*index].1.credits += s;
            daily[*index].1.count += c;
        }
        if c != 0.0 {
            let key = id(row)?.get_str("category").unwrap_or("uncategorized");
            let key = if key.is_empty() { "uncategorized" } else { key };
            let category = categories.entry(key.into()).or_default();
            category.credits += s;
            category.count += c;
        }
        let a = numeric(row, "adjustments");
        if a != 0.0 {
            let key = field(id(row)?, "adjustmentType")?;
            let adjustment = adjustments.entry(key.into()).or_default();
            adjustment.granted += g;
            adjustment.debited += d;
            adjustment.count += a;
        }
    }
    let mut categories: Vec<_> = categories.into_iter().collect();
    categories.sort_by(|(a, av), (b, bv)| bv.credits.total_cmp(&av.credits).then_with(|| a.cmp(b)));
    let mut adjustments: Vec<_> = adjustments.into_iter().collect();
    adjustments.sort_by(|(a, _), (b, _)| a.cmp(b));
    Ok(
        json!({"schemaVersion":1,"itemizationStartedAt":"2026-09-18T19:30:00.000Z",
            "period":{"from":field(window,"from")?,"to":field(window,"to")?,"timeZone":field(window,"timeZone")?,"dayCount":days.len()},
            "totalSpentCredits":spent,"averageDailySpentCredits":round(spent/(days.len().max(1) as f64)*100.0)/100.0,
            "grantedCredits":granted,"adjustmentDebitedCredits":debited,"netConsumedCredits":spent+debited-granted,"transactionCount":count,
            "daily":daily.into_iter().map(|(date,row)|json!({"date":date,"credits":row.credits,"transactionCount":row.count})).collect::<Vec<_>>(),
            "categories":categories.into_iter().map(|(category,row)|json!({"category":category,"credits":row.credits,"transactionCount":row.count,"percentage":if spent!=0.0{round(row.credits/spent*10000.0)/100.0}else{0.0}})).collect::<Vec<_>>(),
            "adjustments":adjustments.into_iter().map(|(kind,row)|json!({"type":kind,"grantedCredits":row.granted,"debitedCredits":row.debited,"transactionCount":row.count})).collect::<Vec<_>>()
        }),
    )
}
fn history(rows: &[Document], start: i64, end: i64, days: usize) -> Result<Value> {
    let mut totals: HashMap<String, f64> = HashMap::new();
    for row in rows {
        *totals.entry(group_day(row)?.into()).or_default() += numeric(row, "spent");
    }
    let samples: Vec<f64> = (0..days)
        .map(|index| {
            totals
                .get(&day(start + index as i64 * DAY))
                .copied()
                .unwrap_or(0.0)
        })
        .collect();
    let total: f64 = samples.iter().sum();
    let mean = total / days as f64;
    let variance = samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / days as f64;
    let recent = &samples[days.saturating_sub(7)..];
    Ok(
        json!({"averageDailyCredits":mean,"totalSpentCredits":total,"dayCount":days,"from":day(start),"to":day(end-1),"activeDayCount":samples.iter().filter(|v|**v>0.0).count(),"coefficientOfVariation":if mean>0.0{variance.sqrt()/mean}else{0.0},"recentAverageDailyCredits":recent.iter().sum::<f64>()/recent.len() as f64,"recentDayCount":recent.len()}),
    )
}
async fn compute(database: &Database, request: &Document, checked: i64) -> Result<Bson> {
    let channel = field(request, "channelID")?;
    let customer = field(request, "customerId")?;
    let window = request
        .get_document("window")
        .map_err(|_| "Invalid AI usage dashboard window")?;
    let start =
        parse_date(field(window, "startTimestamp")?).ok_or("Invalid AI usage dashboard range")?;
    let end = parse_date(field(window, "endTimestampExclusive")?)
        .ok_or("Invalid AI usage dashboard range")?;
    let rows = ledger::aggregate(
        database,
        channel,
        customer,
        start,
        end,
        field(window, "timeZone")?,
        checked,
        true,
    )
    .await?;
    let summary = summary(window, &rows)?;
    let state = database
        .collection::<Document>("ai_usage_ledger_states")
        .find_one(doc! {"channelID":channel,"customerId":customer})
        .projection(doc! {"coverageStart":1,"backfilledAt":1,"reportVersion":1})
        .await
        .map_err(|_| "AI usage ledger state read failed")?;
    let end = checked.div_euclid(DAY) * DAY;
    let created = parse_date(field(request, "accountCreatedAt")?).unwrap_or(0);
    let coverage = state
        .as_ref()
        .and_then(|v| v.get_datetime("coverageStart").ok())
        .map(|v| v.timestamp_millis())
        .filter(|v| *v != 0)
        .unwrap_or(checked);
    let floor = (checked - retention(field(request, "planTier")?) * DAY)
        .max(created)
        .max(coverage);
    let start = floor.div_euclid(DAY) * DAY + if floor.rem_euclid(DAY) > 0 { DAY } else { 0 };
    let days = ((end - start).div_euclid(DAY)).max(0) as usize;
    let history = if days > 0 && state.is_some() {
        let rows = ledger::aggregate(
            database, channel, customer, start, end, "UTC", checked, true,
        )
        .await?;
        history(&rows, start, end, days)?
    } else {
        Value::Null
    };
    Ok(bson_json(&json!({"summary":summary,"history":history})))
}

pub(super) async fn due(database: &Database) -> Result<Vec<Document>> {
    let checked = now();
    database.collection::<Document>("ai_usage_dashboards").find(doc!{"expiresAt":{"$gt":date(checked)},"$or":[{"dirty":true},{"refreshedAt":{"$lte":date(checked-60_000)}}]}).sort(doc!{"refreshedAt":1}).limit(20).await.map_err(|_|"AI usage dashboard lookup failed")?.try_collect().await.map_err(|_|"AI usage dashboard lookup failed")
}
pub(super) async fn refresh(
    database: &Database,
    cache: &mut ConnectionManager,
    document: &Document,
) -> Result<()> {
    let lease = queue::account_lease(
        cache,
        field(document, "channelID")?,
        field(document, "customerId")?,
    )
    .await?;
    let result = async {
        let request = document
            .get_document("request")
            .map_err(|_| "Invalid AI usage dashboard request")?;
        let data = compute(database, request, now()).await?;
        database
            .collection::<Document>("ai_usage_dashboards")
            .update_one(
                doc! {"_id":document.get("_id").cloned().ok_or("Invalid AI usage dashboard")?},
                doc! {"$set":{"data":data,"dirty":false,"refreshedAt":date(now())}},
            )
            .await
            .map_err(|_| "AI usage dashboard publication failed")?;
        Ok(())
    }
    .await;
    let lost = lease.is_lost();
    lease.release().await?;
    if lost {
        Err("AI usage account lease lost")
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_separates_positive_adjustments_negative_grants_and_fractional_usage() {
        let window = doc! {"from":"2026-10-20","to":"2026-10-21","timeZone":"UTC","days":["2026-10-20","2026-10-21"]};
        let rows = vec![
            doc! {"_id":{"date":"2026-10-21","category":"tts","adjustmentType":"other"},"spent":0.25,"granted":0,"debited":0,"count":1,"adjustments":0},
            doc! {"_id":{"date":"2026-10-20","category":"credit_adjustment","adjustmentType":"refund"},"spent":0,"granted":2.5,"debited":1.25,"count":0,"adjustments":2},
        ];
        let result = summary(&window, &rows).unwrap();
        assert_eq!(result["totalSpentCredits"], 0.25);
        assert_eq!(result["netConsumedCredits"], -1.0);
        assert_eq!(result["averageDailySpentCredits"], 0.13);
        assert_eq!(result["transactionCount"], 1.0);
        assert_eq!(result["adjustments"][0]["transactionCount"], 2.0);
    }
    #[test]
    fn history_includes_zero_days_and_uses_only_completed_utc_days() {
        let start = parse_date("2026-10-18").unwrap();
        let rows = vec![doc! {"_id":{"date":"2026-10-19"},"spent":9}];
        let result = history(&rows, start, start + 3 * DAY, 3).unwrap();
        assert_eq!(result["averageDailyCredits"], 3.0);
        assert_eq!(result["activeDayCount"], 1);
        assert_eq!(result["recentDayCount"], 3);
        assert_eq!(result["to"], "2026-10-20");
    }
}
