//! `getReferralStats(userId)` (`utils/referral.ts`): the owner's active codes with sign-ups and
//! paid conversions per code, and what referrals earned.
//!
//! The reference's aggregations are sent as they are. Paid-order receipts exist for every
//! renewal, so a conversion is one referred account per code, not one receipt. Quirk kept
//! (`ledger/packages.md`): sign-ups and conversions are matched on the stored
//! `referralCodeUsed` text while codes are stored in lower case, so a code recorded with
//! capitals is not counted.

use super::codes::codes_of;
use super::{PlanType, ReferralError, completed_referral_reward_filter, load_user};
use crate::mongo_ops;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::credit_transactions::COLLECTION as TRANSACTIONS;
use dima_model::users::{COLLECTION as USERS, User};
use dima_store::mongo::json::to_json_value;
use serde_json::{Map, Value};
use std::collections::HashMap;

fn total(row: &Document) -> f64 {
    row.get("total")
        .and_then(dima_store::mongo::number::read_number)
        .unwrap_or(0.0)
}

fn counts(rows: &[Document]) -> HashMap<String, f64> {
    rows.iter()
        .filter_map(|row| Some((row.get_str("_id").ok()?.to_owned(), total(row))))
        .collect()
}

/// `getReferralStats(userId)` as the route's `data` holds it (before `channelID` and `role`).
pub async fn get_referral_stats(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
) -> Result<Value, ReferralError> {
    let Some(user) = load_user(store, owner).await? else {
        return Err(ReferralError::Refused("User not found".into()));
    };
    let user: User = dima_model::decode_document(&user)
        .map_err(|e| ReferralError::Mongo(mongo_ops::MongoOpError::from(e)))?;
    let plan = PlanType::of_tier(user.plan_tier.as_str());
    let limit = plan.code_limit();
    let codes = codes_of(store, owner).await?;
    let names: Vec<Bson> = codes
        .iter()
        .filter_map(|code| code.get("code").cloned())
        .collect();
    let signups = [
        doc! { "$match": { "referrerId": owner, "referralCodeUsed": { "$in": names.clone() } } },
        doc! { "$group": { "_id": "$referralCodeUsed", "total": { "$sum": 1 } } },
    ];
    let conversions = [
        doc! { "$match": {
            "user": owner,
            "metadata.referralCodeUsed": { "$in": names },
            "metadata.referredUserId": { "$type": "objectId" },
            "$or": completed_referral_reward_filter(),
        } },
        doc! { "$group": { "_id": {
            "code": "$metadata.referralCodeUsed",
            "referredUserId": "$metadata.referredUserId",
        } } },
        doc! { "$group": { "_id": "$_id.code", "total": { "$sum": 1 } } },
    ];
    let earned = [
        doc! { "$match": { "user": owner, "$or": completed_referral_reward_filter() } },
        doc! { "$group": { "_id": Bson::Null, "total": { "$sum": "$amount" } } },
    ];
    let (signups, conversions, earned) = futures_util::future::try_join3(
        mongo_ops::aggregate(store, USERS, signups.to_vec()),
        mongo_ops::aggregate(store, TRANSACTIONS, conversions.to_vec()),
        mongo_ops::aggregate(store, TRANSACTIONS, earned.to_vec()),
    )
    .await?;
    let (signups, conversions) = (counts(&signups), counts(&conversions));
    let mut total_signups = 0.0;
    let mut total_conversions = 0.0;
    let mut items = Vec::new();
    for code in &codes {
        let name = code.get_str("code").unwrap_or_default();
        let signed = signups.get(name).copied().unwrap_or(0.0);
        let converted = conversions.get(name).copied().unwrap_or(0.0);
        total_signups += signed;
        total_conversions += converted;
        // `{...code, stats: {...code.stats, signups, conversions}}`: `stats` and its
        // `conversions` keep their places.
        let mut item = to_json_value(code);
        if let Value::Object(map) = &mut item {
            let mut stats = match map.get("stats") {
                Some(Value::Object(stats)) => stats.clone(),
                _ => Map::new(),
            };
            stats.insert("signups".into(), crate::js::json_number(signed));
            stats.insert("conversions".into(), crate::js::json_number(converted));
            map.insert("stats".into(), Value::Object(stats));
        }
        items.push(item);
    }
    // `totalEarned[0]?.total || 0`.
    let earned = earned.first().map_or(0.0, total);
    let earned = if earned.is_nan() { 0.0 } else { earned };
    // `user.token_balance || 0` (a hydrated user reads a missing balance as 0).
    let balance = user.token_balance.0;
    let balance = if balance.is_nan() { 0.0 } else { balance };
    let codes_used = items.len() as f64;
    #[allow(clippy::cast_precision_loss)]
    let limit = limit as f64;
    Ok(serde_json::json!({
        "planType": plan.as_str(),
        "codeLimit": crate::js::json_number(limit),
        "codesUsed": crate::js::json_number(codes_used),
        "codesRemaining": crate::js::json_number(limit - codes_used),
        "codes": items,
        "totalSignups": crate::js::json_number(total_signups),
        "totalConversions": crate::js::json_number(total_conversions),
        "totalEarned": crate::js::json_number(earned),
        "currentBalance": crate::js::json_number(balance),
    }))
}
