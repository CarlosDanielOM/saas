//! Direction-scoped raid notification preferences and current EventSub configuration.
//! These are reads only, with thirty-second wall deadlines (1500 ms server budgets).
//! Callers supply the subscription id/condition and raw notification; no subscription manager
//! or environment access is needed. A missing preference repairs incoming raids only.
use crate::{Error, timeline_store::Store};
use bson::doc;
use dima_events::value::{Object, Value};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RaidDirection {
    Incoming,
    Outgoing,
}
impl RaidDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
        }
    }
    pub fn field(self) -> &'static str {
        match self {
            Self::Incoming => "to_broadcaster_user_id",
            Self::Outgoing => "from_broadcaster_user_id",
        }
    }
}
pub const OUTGOING_RAID_EVENT: &str = "channel.raid.outgoing";
pub fn raid_direction(condition: &Object) -> RaidDirection {
    if condition.at("from_broadcaster_user_id").truthy()
        && !condition.at("to_broadcaster_user_id").truthy()
    {
        RaidDirection::Outgoing
    } else {
        RaidDirection::Incoming
    }
}
pub fn is_raid_event(kind: &str) -> bool {
    kind == "channel.raid" || kind == OUTGOING_RAID_EVENT
}
pub fn raid_config_type<'a>(kind: &'a str, condition: &Object) -> &'a str {
    if kind == "channel.raid" && raid_direction(condition) == RaidDirection::Outgoing {
        OUTGOING_RAID_EVENT
    } else {
        kind
    }
}
pub fn raid_condition(channel: &str, direction: RaidDirection) -> Object {
    let mut o = Object::new();
    o.insert(direction.field(), Value::String(channel.into()));
    o
}
pub fn raid_preference_id(channel: &str, direction: RaidDirection) -> String {
    format!("{channel}:{}", direction.as_str())
}
#[derive(Clone, Debug, Default)]
pub struct Subscription {
    pub id: Option<String>,
    pub condition: Object,
}
#[derive(Clone)]
pub struct RaidSubscriptions {
    store: Store,
}
impl RaidSubscriptions {
    pub fn new(store: dima_store::mongo::MongoStore, clock: Arc<dyn dima_core::Clock>) -> Self {
        let mut store = Store::new(store, clock);
        store.deadline = std::time::Duration::from_secs(30);
        Self { store }
    }
    pub async fn is_raid_deleted(
        &self,
        channel: &str,
        direction: RaidDirection,
    ) -> Result<bool, Error> {
        Ok(!self
            .store
            .find(
                "raid_subscription_preferences",
                doc! {"_id":raid_preference_id(channel,direction),"deleted":true},
                doc! {},
                1,
                0,
                1500,
            )
            .await?
            .is_empty())
    }
    pub async fn should_repair_raid(
        &self,
        channel: &str,
        direction: RaidDirection,
    ) -> Result<bool, Error> {
        let row = self
            .store
            .find(
                "raid_subscription_preferences",
                doc! {"_id":raid_preference_id(channel,direction)},
                doc! {},
                1,
                0,
                1500,
            )
            .await?;
        Ok(row
            .first()
            .map_or(direction == RaidDirection::Incoming, |r| {
                r.get_bool("deleted").ok() != Some(true)
            }))
    }
    pub async fn accepts_raid_notification(
        &self,
        subscription: &Subscription,
        event: &Object,
    ) -> Result<bool, Error> {
        let direction = raid_direction(&subscription.condition);
        let channel = event.at(direction.field()).or_empty_string();
        if channel.is_empty() || self.is_raid_deleted(&channel, direction).await? {
            return Ok(false);
        }
        let mut filter = doc! {"channelID":&channel,"type":"channel.raid"};
        filter.insert(format!("condition.{}", direction.field()), &channel);
        let rows = self
            .store
            .find("eventsubs", filter, doc! {}, 1, 0, 1500)
            .await?;
        let id = subscription.id.as_deref().filter(|s| !s.is_empty());
        Ok(rows
            .first()
            .map_or(direction == RaidDirection::Incoming && id.is_none(), |c| {
                c.get_bool("enabled").ok() != Some(false)
                    && id.is_none_or(|id| c.get_str("id").ok() == Some(id))
            }))
    }
}
