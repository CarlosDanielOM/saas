//! Receipt persistence and UTC daily repair, retaining the Mongoose BSON shapes.
use super::{Result, queue, values::*};
use crate::utils::ai_usage_aggregate_policy::group_fields;
use futures_util::TryStreamExt;
use mongodb::{
    Database,
    bson::{Document, doc},
};
use redis::aio::ConnectionManager;
use std::collections::HashMap;

#[allow(clippy::too_many_arguments)]
pub(super) async fn aggregate(
    database: &Database,
    channel: &str,
    customer: &str,
    start: i64,
    end: i64,
    timezone: &str,
    checked: i64,
    dashboard: bool,
) -> Result<Vec<Document>> {
    let boundary = if dashboard { "$lt" } else { "$lte" };
    let mut range = doc! {"$gte":date(start)};
    range.insert(boundary, date(end));
    let mut id = doc! {"date":{"$dateToString":{"date":"$occurredAt","format":"%Y-%m-%d","timezone":timezone}},"category":"$category"};
    if dashboard {
        id.insert("kind", "$entryKind");
        id.insert(
            "adjustmentType",
            doc! {"$ifNull":["$adjustmentType","other"]},
        );
    }
    database.collection::<Document>("ai_usage_receipts").aggregate(vec![doc!{"$match":{"channelID":channel,"customerId":customer,"occurredAt":range,"expiresAt":{"$gt":date(checked)}}},doc!{"$group":group_fields(id,dashboard)}]).await.map_err(|_|"AI usage aggregate failed")?.try_collect().await.map_err(|_|"AI usage aggregate failed")
}

#[derive(Default)]
struct Daily {
    spent: f64,
    granted: f64,
    debited: f64,
    count: f64,
    categories: Document,
    expires: i64,
}
async fn rebuild(database: &Database, receipt: &Receipt, tier: &str) -> Result<()> {
    let start = receipt.occurred.div_euclid(DAY) * DAY;
    let end = start + DAY - 1;
    let groups = aggregate(
        database,
        &receipt.channel,
        &receipt.customer,
        start,
        end,
        "UTC",
        now(),
        false,
    )
    .await?;
    // Preserve Mongo group encounter order, including the original overwrite
    // when multiple legacy categories normalize to `uncategorized`.
    let mut order = Vec::new();
    let mut days: HashMap<String, Daily> = HashMap::new();
    for group in groups {
        let id = group
            .get_document("_id")
            .map_err(|_| "Invalid AI usage daily group")?;
        let day = id
            .get_str("date")
            .map_err(|_| "Invalid AI usage daily group")?
            .to_owned();
        if !days.contains_key(&day) {
            order.push(day.clone());
        }
        let row = days.entry(day).or_default();
        row.spent += numeric(&group, "spent");
        row.granted += numeric(&group, "granted");
        row.debited += numeric(&group, "debited");
        row.count += numeric(&group, "count");
        let expires = group
            .get_datetime("expiresAt")
            .map_err(|_| "Invalid AI usage expiry")?
            .timestamp_millis();
        row.expires = row.expires.max(expires);
        if numeric(&group, "count") != 0.0 {
            let raw = id
                .get_str("category")
                .ok()
                .map(|v| serde_json::Value::String(v.into()));
            row.categories.insert(category(raw.as_ref()),doc!{"credits":bson_number(numeric(&group,"spent")),"transactionCount":bson_number(numeric(&group,"count"))});
        }
    }
    let daily = database.collection::<Document>("ai_usage_dailies");
    daily.delete_many(doc!{"channelID":&receipt.channel,"customerId":&receipt.customer,"date":{"$gte":day(start),"$lte":day(end)}}).await.map_err(|_|"AI usage daily replacement failed")?;
    if !order.is_empty() {
        let stamp = date(now());
        let mut documents = Vec::new();
        for key in order {
            let row = days.remove(&key).ok_or("Invalid AI usage daily group")?;
            let day_start = parse_date(&key).ok_or("Invalid AI usage daily date")?;
            let mut document = doc! {"channelID":&receipt.channel,"customerId":&receipt.customer,"date":key,"dayStart":date(day_start),"spentCredits":bson_number(row.spent),"grantedCredits":bson_number(row.granted),"netConsumedCredits":bson_number(row.spent+row.debited-row.granted),"transactionCount":bson_number(row.count),"retentionTier":tier,"expiresAt":date(row.expires),"created_at":stamp,"updated_at":stamp,"__v":0};
            // Mongoose's default minimize removes empty Mixed objects.
            if !row.categories.is_empty() {
                document.insert("categories", row.categories);
            }
            documents.push(document);
        }
        daily
            .insert_many(documents)
            .ordered(false)
            .await
            .map_err(|_| "AI usage daily replacement failed")?;
    }
    Ok(())
}

pub(super) async fn persist(
    database: &Database,
    cache: &mut ConnectionManager,
    receipt: &Receipt,
    tier: &str,
) -> Result<()> {
    let lease = queue::account_lease(cache, &receipt.channel, &receipt.customer).await?;
    let result = async {
        database
            .collection::<Document>("ai_usage_dashboards")
            .update_many(
                doc! {"channelID":&receipt.channel,"customerId":&receipt.customer},
                doc! {"$set":{"dirty":true}},
            )
            .await
            .map_err(|_| "AI usage dashboard dirtying failed")?;
        let expiry = receipt
            .occurred
            .checked_add(retention(tier) * DAY)
            .ok_or("Invalid AI usage receipt expiry")?;
        if expiry <= now() {
            return Ok(());
        }
        let stamp = date(now());
        let mut document = receipt.document.clone();
        document.insert("retentionTier", tier);
        document.insert("expiresAt", date(expiry));
        document.insert("created_at", stamp);
        document.insert("__v", 0);
        let entry = receipt
            .document
            .get("entryId")
            .cloned()
            .ok_or("Invalid AI usage receipt")?;
        database
            .collection::<Document>("ai_usage_receipts")
            .update_one(
                doc! {"channelID":&receipt.channel,"customerId":&receipt.customer,"entryId":entry},
                doc! {"$setOnInsert":document,"$set":{"updated_at":stamp}},
            )
            .upsert(true)
            .await
            .map_err(|_| "AI usage receipt persistence failed")?;
        rebuild(database, receipt, tier).await
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
    fn day_floor_handles_negative_epoch_and_retention_keeps_tiers() {
        assert_eq!((-1i64).div_euclid(DAY) * DAY, -DAY);
        assert_eq!(retention("free"), 30);
        assert_eq!(retention("premium"), 60);
        assert_eq!(retention("pro"), 90);
        assert_eq!(retention("unexpected"), 30);
    }
    #[test]
    fn aggregate_shapes_preserve_adjustment_debits_and_credit_sign() {
        let daily = group_fields(doc! {"date":"d"}, false);
        assert!(daily.contains_key("debited"));
        assert!(daily.contains_key("expiresAt"));
        assert!(!daily.contains_key("adjustments"));
        let dashboard = group_fields(doc! {"date":"d"}, true);
        assert!(dashboard.contains_key("adjustments"));
        assert!(!dashboard.contains_key("expiresAt"));
    }
}
