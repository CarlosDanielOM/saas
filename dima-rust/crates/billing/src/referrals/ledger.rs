//! `utils/referral_ledger.ts`: the dashboard's pages of referred people and of the referral
//! timeline (sign-ups and rewards), 20 per page. The route checks `page` (0 to 100).

use super::{ReferralError, completed_referral_reward_filter};
use crate::mongo_ops;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::credit_transactions::COLLECTION as TRANSACTIONS;
use dima_model::users::COLLECTION as USERS;
use dima_store::mongo::json::bson_to_json_value;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// `REFERRAL_LEDGER_PAGE_SIZE`.
pub const REFERRAL_LEDGER_PAGE_SIZE: u32 = 20;

fn json(value: Option<&Bson>) -> Option<Value> {
    value.and_then(bson_to_json_value)
}

fn hex(value: Option<&Bson>) -> String {
    match value {
        Some(Bson::ObjectId(id)) => id.to_hex(),
        Some(other) => dima_text::string_of(&json(Some(other)).unwrap_or(Value::Null)),
        None => "undefined".into(),
    }
}

/// `{items, page, hasMore}` in the reference's key order (`page`, `hasMore`, `items`).
fn page_json(page: u32, has_more: bool, items: Vec<Value>) -> Value {
    serde_json::json!({ "page": page, "hasMore": has_more, "items": items })
}

/// `getReferralPeoplePage(ownerId, page)`: the accounts that signed up with one of the owner's
/// codes, newest first, with what each earned the owner.
pub async fn referral_people_page(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
    page: u32,
) -> Result<Value, ReferralError> {
    let options = mongodb::options::FindOptions::builder()
        .projection(
            doc! { "_id": 1, "name": 1, "plan_tier": 1, "created_at": 1, "referralCodeUsed": 1 },
        )
        .sort(doc! { "created_at": -1, "_id": -1 })
        .skip(u64::from(page) * u64::from(REFERRAL_LEDGER_PAGE_SIZE))
        .limit(i64::from(REFERRAL_LEDGER_PAGE_SIZE) + 1)
        .build();
    let filter = doc! { "referrerId": owner, "referralCodeUsed": { "$type": "string" } };
    let users = mongo_ops::find(store, USERS, filter, options).await?;
    let has_more = users.len() > REFERRAL_LEDGER_PAGE_SIZE as usize;
    let visible: Vec<&Document> = users
        .iter()
        .take(REFERRAL_LEDGER_PAGE_SIZE as usize)
        .collect();
    let ids: Vec<Bson> = visible
        .iter()
        .filter_map(|user| user.get("_id").cloned())
        .collect();
    let totals = if ids.is_empty() {
        Vec::new()
    } else {
        let pipeline = vec![
            doc! { "$match": {
                "user": owner,
                "amount": { "$gt": 0 },
                "metadata.referredUserId": { "$in": ids },
                "$or": completed_referral_reward_filter(),
            } },
            doc! { "$group": { "_id": "$metadata.referredUserId", "credits": { "$sum": "$amount" } } },
        ];
        mongo_ops::aggregate(store, TRANSACTIONS, pipeline).await?
    };
    let earned: HashMap<String, Value> = totals
        .iter()
        .map(|row| {
            (
                hex(row.get("_id")),
                json(row.get("credits")).unwrap_or(Value::Null),
            )
        })
        .collect();
    let items = visible
        .iter()
        .map(|user| {
            let id = hex(user.get("_id"));
            let mut item = Map::new();
            item.insert("id".into(), Value::from(id.as_str()));
            // `undefined` members are left out by `res.json`.
            if let Some(name) = json(user.get("name")) {
                item.insert("name".into(), name);
            }
            let code = match user.get("referralCodeUsed") {
                None | Some(Bson::Null) => Value::from(""),
                Some(other) => json(Some(other)).unwrap_or(Value::Null),
            };
            item.insert("code".into(), code);
            if let Some(at) = json(user.get("created_at")) {
                item.insert("signedUpAt".into(), at);
            }
            if let Some(tier) = json(user.get("plan_tier")) {
                item.insert("tier".into(), tier);
            }
            item.insert(
                "creditsEarned".into(),
                earned.get(&id).cloned().unwrap_or(Value::from(0)),
            );
            Value::Object(item)
        })
        .collect();
    Ok(page_json(page, has_more, items))
}

/// `getReferralTimelinePage(ownerId, page)`: sign-ups and completed rewards, newest first.
pub async fn referral_timeline_page(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
    page: u32,
) -> Result<Value, ReferralError> {
    let pipeline = vec![
        doc! { "$match": { "referrerId": owner, "referralCodeUsed": { "$type": "string" } } },
        doc! { "$project": {
            "userId": "$_id", "code": "$referralCodeUsed",
            "at": { "$ifNull": ["$created_at", { "$toDate": "$_id" }] },
            "kind": { "$literal": "signup" }, "credits": { "$literal": 0 },
        } },
        doc! { "$unionWith": {
            "coll": TRANSACTIONS,
            "pipeline": [
                { "$match": {
                    "user": owner,
                    "amount": { "$gt": 0 },
                    "metadata.referredUserId": { "$type": "objectId" },
                    "$or": completed_referral_reward_filter(),
                } },
                { "$project": {
                    "userId": "$metadata.referredUserId", "code": "$metadata.referralCodeUsed",
                    "at": { "$ifNull": ["$appliedAt", "$createdAt"] },
                    "kind": { "$literal": "reward" }, "credits": "$amount",
                } },
            ],
        } },
        doc! { "$sort": { "at": -1, "_id": -1 } },
        doc! { "$skip": i64::from(page) * i64::from(REFERRAL_LEDGER_PAGE_SIZE) },
        doc! { "$limit": i64::from(REFERRAL_LEDGER_PAGE_SIZE) + 1 },
    ];
    let rows = mongo_ops::aggregate(store, USERS, pipeline).await?;
    let has_more = rows.len() > REFERRAL_LEDGER_PAGE_SIZE as usize;
    let visible: Vec<&Document> = rows
        .iter()
        .take(REFERRAL_LEDGER_PAGE_SIZE as usize)
        .collect();
    let ids: Vec<Bson> = visible
        .iter()
        .filter_map(|row| row.get("userId").cloned())
        .collect();
    let options = mongodb::options::FindOptions::builder()
        .projection(doc! { "_id": 1, "name": 1 })
        .build();
    let users = mongo_ops::find(store, USERS, doc! { "_id": { "$in": ids } }, options).await?;
    let names: HashMap<String, Option<Value>> = users
        .iter()
        .map(|user| (hex(user.get("_id")), json(user.get("name"))))
        .collect();
    let items = visible
        .iter()
        .map(|row| {
            let kind = row.get_str("kind").unwrap_or_default();
            let user_id = hex(row.get("userId"));
            let mut item = Map::new();
            item.insert(
                "id".into(),
                Value::from(format!("{kind}:{}", hex(row.get("_id")))),
            );
            item.insert("kind".into(), Value::from(kind));
            item.insert("userId".into(), Value::from(user_id.as_str()));
            // `names.get(...) ?? ''`: a user without a name (or `null`) reads as ''.
            let name = names
                .get(&user_id)
                .cloned()
                .flatten()
                .filter(|n| !n.is_null())
                .unwrap_or(Value::from(""));
            item.insert("name".into(), name);
            let code = match row.get("code") {
                None | Some(Bson::Null) => Value::from(""),
                Some(other) => json(Some(other)).unwrap_or(Value::Null),
            };
            item.insert("code".into(), code);
            // A field `$project` left missing is `undefined`, which `res.json` leaves out.
            if let Some(at) = json(row.get("at")) {
                item.insert("at".into(), at);
            }
            if let Some(credits) = json(row.get("credits")) {
                item.insert("credits".into(), credits);
            }
            Value::Object(item)
        })
        .collect();
    Ok(page_json(page, has_more, items))
}
