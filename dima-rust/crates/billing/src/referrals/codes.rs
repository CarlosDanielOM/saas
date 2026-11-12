//! Campaign codes and the attribution of a new account (`utils/referral.ts`).

use super::{PlanType, ReferralError, load_user};
use crate::mongo_ops::{self, MongoOpError};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::referral_codes::{
    COLLECTION as CODES, INFO as CODE_INFO, NewReferralCode, NewReferralStats, ReferralCode,
    is_valid_code,
};
use dima_model::users::{COLLECTION as USERS, INFO as USER_INFO, User};
use dima_store::mongo::WriteContext;
use dima_store::mongo::json::to_json_value;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::update::UpdateOptions;
use serde_json::Value;

fn decode<T: serde::de::DeserializeOwned>(document: &Document) -> Result<T, ReferralError> {
    dima_model::decode_document(document).map_err(|e| ReferralError::Mongo(MongoOpError::from(e)))
}

fn taken() -> ReferralError {
    ReferralError::Refused("This referral code is already taken.".into())
}

/// `createCampaignCode(userId, code, label)`: the created code as `res.json` sends it.
///
/// The checks run in the reference's order: the owner, the plan's limit, the format, a code
/// already taken (active or not). The limit message says `limit reached` in lower case, so the
/// route's `includes('Limit reached')` never matches it and the reference answers 500 (quirk
/// kept; the route package decides).
pub async fn create_campaign_code(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
    code: &str,
    label: &str,
    now_ms: i64,
) -> Result<Value, ReferralError> {
    let Some(user) = load_user(store, owner).await? else {
        return Err(ReferralError::Refused("User not found".into()));
    };
    let user: User = decode(&user)?;
    let plan = PlanType::of_tier(user.plan_tier.as_str());
    let limit = plan.code_limit();
    let active = doc! { "owner": owner, "active": true };
    let existing = mongo_ops::count(store, CODES, active.clone()).await?;
    let over = || {
        ReferralError::Refused(format!(
            "Referral code limit reached for {} plan. Maximum {limit} codes allowed.",
            plan.as_str()
        ))
    };
    if existing >= limit {
        return Err(over());
    }
    if !is_valid_code(code) {
        return Err(ReferralError::Refused(
            "Invalid code format. Must be 1-16 alphanumeric characters or underscores.".into(),
        ));
    }
    let lower = code.to_lowercase();
    if mongo_ops::exists(store, CODES, doc! { "code": &lower }).await? {
        return Err(taken());
    }
    // `label.substring(0, 50)`: characters here (text rule 1), UTF-16 units in the reference.
    let label: String = label.chars().take(50).collect();
    let new = NewReferralCode {
        code: lower,
        owner,
        label: Some(label),
        stats: Some(NewReferralStats {
            conversions: JsNumber(0.0),
        }),
        active: None,
    };
    let mut ctx = WriteContext::new(now_ms);
    let prepared = new.prepare(&mut ctx).map_err(MongoOpError::from)?;
    let mut writes = store.writes(CODES);
    match mongo_ops::deadline("insertOne", writes.insert_one(&prepared)).await {
        Ok(()) => {}
        // Intended difference: the unique index refused a code taken since the check.
        Err(error) if error.is_duplicate_key() => return Err(taken()),
        Err(error) => return Err(error.into()),
    }
    // Intended difference: count again; two creations racing past the limit remove their own.
    if mongo_ops::count(store, CODES, active).await? > limit {
        let id = prepared.document.get("_id").cloned().unwrap_or(Bson::Null);
        mongo_ops::deadline(
            "deleteOne",
            store.documents(CODES).delete_one(doc! { "_id": id }),
        )
        .await?;
        return Err(over());
    }
    Ok(to_json_value(&prepared.document))
}

/// `getUserCodes(userId)`: the owner's active codes, newest first, as `.lean()` sends them.
pub async fn get_user_codes(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
) -> Result<Vec<Value>, ReferralError> {
    Ok(codes_of(store, owner)
        .await?
        .iter()
        .map(to_json_value)
        .collect())
}

/// The owner's active codes, newest first.
pub(crate) async fn codes_of(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
) -> Result<Vec<Document>, ReferralError> {
    let options = mongodb::options::FindOptions::builder()
        .sort(doc! { "createdAt": -1 })
        .build();
    Ok(mongo_ops::find(
        store,
        CODES,
        doc! { "owner": owner, "active": true },
        options,
    )
    .await?)
}

/// `deleteCampaignCode(userId, codeId)`: deactivates the owner's code; `false` when nothing
/// changed (not the owner's, or already inactive).
pub async fn delete_campaign_code(
    store: &dima_store::mongo::MongoStore,
    owner: ObjectId,
    code_id: ObjectId,
    now_ms: i64,
) -> Result<bool, ReferralError> {
    let outcome = mongo_ops::update_one(
        store,
        &CODE_INFO,
        &doc! { "_id": code_id, "owner": owner },
        doc! { "active": false },
        UpdateOptions::default(),
        None,
        now_ms,
    )
    .await?;
    Ok(outcome.modified > 0)
}

/// `ReferralCodeSchema.findByCode(code)`: the active code, matched in lower case
/// (`GET /referrals/validate/:code`).
pub async fn find_by_code(
    store: &dima_store::mongo::MongoStore,
    code: &str,
) -> Result<Option<ReferralCode>, ReferralError> {
    // JavaScript's `toLowerCase()`: Rust's full mapping agrees on every code that can be stored
    // (`[A-Za-z0-9_]`); other text matches nothing either way.
    let filter = doc! { "code": code.to_lowercase(), "active": true };
    mongo_ops::find_one(store, CODES, filter, None)
        .await?
        .map(|d| decode(&d))
        .transpose()
}

/// `applyReferralCode(userId, code)`: attributes a just-created account to the code's owner.
/// `false` for an unknown or inactive code, the account's own code, or an account that already
/// has a referrer. Only the sign-up calls it (`POST /referrals/apply` answers 410).
pub async fn apply_referral_code(
    store: &dima_store::mongo::MongoStore,
    user_id: ObjectId,
    code: &str,
    now_ms: i64,
) -> Result<bool, ReferralError> {
    let Some(found) = find_by_code(store, code).await? else {
        return Ok(false);
    };
    if found.owner == user_id {
        return Ok(false);
    }
    let outcome = mongo_ops::update_one(
        store,
        &USER_INFO,
        &doc! { "_id": user_id, "referrerId": Bson::Null },
        doc! { "referrerId": found.owner, "referralCodeUsed": &found.code },
        UpdateOptions::default(),
        None,
        now_ms,
    )
    .await?;
    let _ = USERS;
    Ok(outcome.modified > 0)
}
