use super::model::{BitsRuleError, SplitSurrogate, rules_from_legacy_tiers};
use crate::utils::{
    bson_compat::{js_number, json_to_bson},
    eventsub::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES},
};
use mongodb::{
    Database,
    bson::{self, Bson, DateTime, Document, doc},
    error::{ErrorKind, WriteFailure},
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct BitsRulesState {
    pub revision: f64,
    pub rules: Vec<Value>,
}
#[derive(Debug)]
pub enum StoreError {
    Mongo(mongodb::error::Error),
    InvalidStored(String),
    InvalidRule(BitsRuleError),
    SplitSurrogate(SplitSurrogate),
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mongo(e) => e.fmt(f),
            Self::InvalidStored(e) => f.write_str(e),
            Self::InvalidRule(e) => e.fmt(f),
            Self::SplitSurrogate(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<mongodb::error::Error> for StoreError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Mongo(e)
    }
}
impl From<BitsRuleError> for StoreError {
    fn from(e: BitsRuleError) -> Self {
        Self::InvalidRule(e)
    }
}
impl From<SplitSurrogate> for StoreError {
    fn from(e: SplitSurrogate) -> Self {
        Self::SplitSurrogate(e)
    }
}
fn duplicate(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(e)) => e.code == 11000,
        ErrorKind::Command(e) => e.code == 11000,
        _ => false,
    }
}
fn as_json(value: Bson) -> Result<Value, StoreError> {
    bson::deserialize_from_bson(value).map_err(|e| StoreError::InvalidStored(e.to_string()))
}
fn as_bson(value: &Value) -> Result<Bson, StoreError> {
    json_to_bson(value).map_err(|e| StoreError::InvalidStored(e.to_owned()))
}

/// Uses the existing Mongoose collection; canonical records take precedence
/// over either legacy type, even when their cheerTiers field is absent.
pub async fn find_bits_eventsub(
    db: &Database,
    channel: &str,
) -> Result<Option<Document>, StoreError> {
    let events = db.collection::<Document>("eventsubs");
    if let Some(event) = events
        .find_one(doc! {"channelID":channel, "type":CANONICAL_BITS_EVENT_TYPE})
        .await?
    {
        return Ok(Some(event));
    }
    Ok(events
        .find_one(doc! {"channelID":channel, "type":{"$in":LEGACY_BITS_EVENT_TYPES.to_vec()}})
        .await?)
}
/// `None` fetches the event; `Some(Null)` explicitly suppresses the lookup.
pub async fn load_bits_rules(
    db: &Database,
    channel: &str,
    legacy_tiers: Option<&Value>,
) -> Result<BitsRulesState, StoreError> {
    let stored = db
        .collection::<Document>("bits_rules")
        .find_one(doc! {"_id":channel})
        .await?;
    if let Some(stored) = stored {
        let revision = match stored.get("revision") {
            Some(Bson::Int32(n)) => f64::from(*n),
            Some(Bson::Int64(n)) => *n as f64,
            Some(Bson::Double(n)) if n.is_finite() => *n,
            _ => {
                return Err(StoreError::InvalidStored(
                    "Invalid bits rule revision".into(),
                ));
            }
        };
        let rules = match stored.get("rules") {
            None | Some(Bson::Null) => Vec::new(),
            Some(Bson::Array(items)) => items
                .iter()
                .cloned()
                .map(as_json)
                .collect::<Result<_, _>>()?,
            _ => return Err(StoreError::InvalidStored("Invalid bits rules array".into())),
        };
        return Ok(BitsRulesState { revision, rules });
    }
    let owned;
    let tiers = if let Some(tiers) = legacy_tiers {
        tiers
    } else {
        owned = match find_bits_eventsub(db, channel).await? {
            Some(mut event) => as_json(event.remove("cheerTiers").unwrap_or(Bson::Null))?,
            None => Value::Null,
        };
        &owned
    };
    let rules = rules_from_legacy_tiers(tiers)?
        .iter()
        .map(|rule| serde_json::to_value(rule).expect("rule serialization"))
        .collect();
    Ok(BitsRulesState {
        revision: 0.0,
        rules,
    })
}
/// Retries a fresh load and invokes `change` again after a conflicting write.
/// Mixed BSON rule objects are preserved as JSON values, including extra keys.
pub async fn change_bits_rules<F>(
    db: &Database,
    channel: &str,
    updated_by: &str,
    mut change: F,
) -> Result<BitsRulesState, StoreError>
where
    F: FnMut(Vec<Value>) -> Result<Vec<Value>, BitsRuleError>,
{
    let collection = db.collection::<Document>("bits_rules");
    for _ in 0..4 {
        let current = load_bits_rules(db, channel, None).await?;
        let rules = change(current.rules)?;
        let bson_rules = rules.iter().map(as_bson).collect::<Result<Vec<_>, _>>()?;
        if current.revision == 0.0 {
            match collection.insert_one(doc! {"_id":channel, "revision":js_number(1.0), "rules":bson_rules, "updatedAt":DateTime::now(), "updatedBy":updated_by}).await {
                Ok(_) => return Ok(BitsRulesState { revision:1.0, rules }),
                Err(error) if duplicate(&error) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let result = collection.update_one(doc! {"_id":channel, "revision":js_number(current.revision)}, doc! {"$set":{"rules":bson_rules, "updatedAt":DateTime::now(), "updatedBy":updated_by}, "$inc":{"revision":js_number(1.0)}}).await?;
        if result.modified_count > 0 {
            let revision = current.revision + 1.0;
            return Ok(BitsRulesState { revision, rules });
        }
    }
    Err(BitsRuleError::new(
        "Your Bits rules were changed somewhere else at the same time. Try again.",
        409,
    )
    .into())
}
