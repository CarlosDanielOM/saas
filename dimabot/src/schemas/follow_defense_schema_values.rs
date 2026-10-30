//! Declared TypeScript interfaces, kept separate from permissive raw-schema casting.
use crate::utils::js_string::JsString;
use mongodb::bson::{DateTime, oid::ObjectId};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseMode {
    Silent,
    Protection,
    Attack,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseTriggerSource {
    Threshold,
    Manual,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseActionKind {
    Ban,
    Announcement,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseAuthorization {
    Automatic,
    Manual,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseActionMode {
    Protection,
    Attack,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowDefenseActionStatus {
    Pending,
    Processing,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IFollowAttackTrackedFollow {
    pub follower_id: JsString,
    pub follower_login: JsString,
    pub follower_name: JsString,
    pub followed_at: DateTime,
    pub event_id: JsString,
    pub banned: bool,
    pub ban_status: Option<f64>,
    pub ban_message: Option<JsString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IFollowAttackRaidInfo {
    pub raider_channel_id: JsString,
    pub raider_channel_login: JsString,
    pub raider_channel_name: JsString,
    pub raid_viewers: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IFollowAttackLog {
    pub target_channel_id: JsString,
    pub target_channel_login: JsString,
    pub target_channel_name: JsString,
    pub mode_triggered: FollowDefenseMode,
    pub triggered_by: FollowDefenseTriggerSource,
    pub total_follows: f64,
    pub velocity: f64,
    pub duration_seconds: f64,
    pub is_raid: bool,
    pub raid_info: Option<IFollowAttackRaidInfo>,
    pub tracked_follows: Vec<IFollowAttackTrackedFollow>,
    pub is_hate_raid: bool,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IFollowHateRaidSource {
    pub target_channel_id: JsString,
    pub target_channel_login: JsString,
    pub target_channel_name: JsString,
    pub raider_channel_id: JsString,
    pub raider_channel_login: JsString,
    pub raider_channel_name: JsString,
    pub count: f64,
    pub applied_log_ids: Option<Vec<ObjectId>>,
    pub first_seen_at: DateTime,
    pub last_seen_at: DateTime,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}
/// Concrete fields from the source's InferSchemaType; `followedAt` is optional.
#[derive(Clone, Debug, PartialEq)]
pub struct FollowDefenseAction {
    pub id: JsString,
    pub channel_id: JsString,
    pub event_id: JsString,
    pub kind: FollowDefenseActionKind,
    pub follower_id: JsString,
    pub authorization: FollowDefenseAuthorization,
    pub raid_session_id: JsString,
    pub raid_follower_id: JsString,
    pub raid_request_id: JsString,
    pub reason: JsString,
    pub message: JsString,
    pub mode: FollowDefenseActionMode,
    pub authorized_at: DateTime,
    pub followed_at: Option<Option<DateTime>>,
    pub status: FollowDefenseActionStatus,
    pub next_attempt_at: DateTime,
    pub locked_until: DateTime,
    pub lease_token: JsString,
    pub attempts: f64,
    pub failures: f64,
    pub last_status: f64,
    pub last_message: JsString,
    pub completed_at: Option<Option<DateTime>>,
    pub expires_at: DateTime,
    pub purge_at: DateTime,
    pub audit_pending: Bson,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_datetime, insert_f64, insert_nullable_datetime,
    insert_optional_f64, insert_optional_string, insert_string,
};
use mongodb::bson::{Bson, Document};
fn err(reader: &Reader<'_>, key: &str, kind: &'static str) -> StrictDecodeError {
    StrictDecodeError {
        path: if reader.location().is_empty() {
            key.into()
        } else {
            format!("{}.{}", reader.location(), key)
        },
        kind,
    }
}
// TypeScript `number` includes non-finite binary64 values, even where Mongoose
// schema validators reject particular values. This strict view does not cast.
fn number(reader: &Reader<'_>, key: &str) -> Result<f64, StrictDecodeError> {
    match reader.document().get(key) {
        Some(Bson::Double(v)) => Ok(*v),
        Some(Bson::Int32(v)) => Ok(f64::from(*v)),
        Some(Bson::Int64(v)) if (-9_007_199_254_740_992..=9_007_199_254_740_992).contains(v) => {
            Ok(*v as f64)
        }
        None => Err(err(reader, key, "required")),
        Some(Bson::Null) => Err(err(reader, key, "null")),
        _ => Err(err(reader, key, "type")),
    }
}
fn optional_number(reader: &Reader<'_>, key: &str) -> Result<Option<f64>, StrictDecodeError> {
    if reader.document().contains_key(key) {
        number(reader, key).map(Some)
    } else {
        Ok(None)
    }
}

macro_rules! string_enum {
 ($ty:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
  impl $ty {
   pub fn as_str(self)->&'static str { match self { $(Self::$variant=>$wire),+ } }
   pub fn parse(value:&str)->Option<Self> { match value { $($wire=>Some(Self::$variant),)+ _=>None } }
  }
 };
}
string_enum!(FollowDefenseMode{Silent=>"silent",Protection=>"protection",Attack=>"attack"});
string_enum!(FollowDefenseTriggerSource{Threshold=>"threshold",Manual=>"manual"});
string_enum!(FollowDefenseActionKind{Ban=>"ban",Announcement=>"announcement"});
string_enum!(FollowDefenseAuthorization{Automatic=>"automatic",Manual=>"manual"});
string_enum!(FollowDefenseActionMode{Protection=>"protection",Attack=>"attack"});
string_enum!(FollowDefenseActionStatus{Pending=>"pending",Processing=>"processing",Succeeded=>"succeeded",Failed=>"failed",Cancelled=>"cancelled",Expired=>"expired"});
macro_rules! read_enum {
    ($r:expr,$field:literal,$ty:ident) => {{
        let s = $r.require_string($field)?;
        $ty::parse(s.as_str().unwrap_or("")).ok_or_else(|| err(&$r, $field, "enum"))?
    }};
}
impl IFollowAttackTrackedFollow {
    fn read(r: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            follower_id: r.require_string("followerID")?,
            follower_login: r.require_string("followerLogin")?,
            follower_name: r.require_string("followerName")?,
            followed_at: r.require_datetime("followedAt")?,
            event_id: r.require_string("eventID")?,
            banned: r.require_bool("banned")?,
            ban_status: optional_number(r, "banStatus")?,
            ban_message: r.optional_string("banMessage")?,
        })
    }
    pub fn from_bson_document(document: &Document) -> Result<Self, StrictDecodeError> {
        Self::read(&Reader::new(document))
    }
    pub fn to_bson_document(&self) -> Document {
        let mut d = Document::new();
        insert_string(&mut d, "followerID", &self.follower_id);
        insert_string(&mut d, "followerLogin", &self.follower_login);
        insert_string(&mut d, "followerName", &self.follower_name);
        insert_datetime(&mut d, "followedAt", self.followed_at);
        insert_string(&mut d, "eventID", &self.event_id);
        d.insert("banned", self.banned);
        insert_optional_f64(&mut d, "banStatus", self.ban_status);
        insert_optional_string(&mut d, "banMessage", &self.ban_message);
        d
    }
}
impl IFollowAttackRaidInfo {
    fn read(r: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        Ok(Self {
            raider_channel_id: r.require_string("raiderChannelID")?,
            raider_channel_login: r.require_string("raiderChannelLogin")?,
            raider_channel_name: r.require_string("raiderChannelName")?,
            raid_viewers: number(r, "raidViewers")?,
        })
    }
    pub fn from_bson_document(document: &Document) -> Result<Self, StrictDecodeError> {
        Self::read(&Reader::new(document))
    }
    pub fn to_bson_document(&self) -> Document {
        let mut d = Document::new();
        insert_string(&mut d, "raiderChannelID", &self.raider_channel_id);
        insert_string(&mut d, "raiderChannelLogin", &self.raider_channel_login);
        insert_string(&mut d, "raiderChannelName", &self.raider_channel_name);
        insert_f64(&mut d, "raidViewers", self.raid_viewers);
        d
    }
}
impl IFollowAttackLog {
    pub fn from_bson_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let r = Reader::new(document);
        let mut tracked = Vec::new();
        for (i, v) in r.require_array("trackedFollows")?.iter().enumerate() {
            let path = format!("trackedFollows.{i}");
            let Bson::Document(d) = v else {
                return Err(StrictDecodeError { path, kind: "type" });
            };
            tracked.push(IFollowAttackTrackedFollow::read(&Reader::with_prefix(
                d, &path,
            ))?);
        }
        Ok(Self {
            target_channel_id: r.require_string("targetChannelID")?,
            target_channel_login: r.require_string("targetChannelLogin")?,
            target_channel_name: r.require_string("targetChannelName")?,
            mode_triggered: read_enum!(r, "modeTriggered", FollowDefenseMode),
            triggered_by: read_enum!(r, "triggeredBy", FollowDefenseTriggerSource),
            total_follows: number(&r, "totalFollows")?,
            velocity: number(&r, "velocity")?,
            duration_seconds: number(&r, "durationSeconds")?,
            is_raid: r.require_bool("isRaid")?,
            raid_info: r
                .optional_document("raidInfo")?
                .map(|r| IFollowAttackRaidInfo::read(&r))
                .transpose()?,
            tracked_follows: tracked,
            is_hate_raid: r.require_bool("isHateRaid")?,
            created_at: r.require_datetime("createdAt")?,
            updated_at: r.require_datetime("updatedAt")?,
        })
    }
    pub fn to_bson_document(&self) -> Document {
        let mut d = Document::new();
        insert_string(&mut d, "targetChannelID", &self.target_channel_id);
        insert_string(&mut d, "targetChannelLogin", &self.target_channel_login);
        insert_string(&mut d, "targetChannelName", &self.target_channel_name);
        d.insert("modeTriggered", self.mode_triggered.as_str());
        d.insert("triggeredBy", self.triggered_by.as_str());
        insert_f64(&mut d, "totalFollows", self.total_follows);
        insert_f64(&mut d, "velocity", self.velocity);
        insert_f64(&mut d, "durationSeconds", self.duration_seconds);
        d.insert("isRaid", self.is_raid);
        if let Some(v) = &self.raid_info {
            d.insert("raidInfo", v.to_bson_document());
        }
        d.insert(
            "trackedFollows",
            self.tracked_follows
                .iter()
                .map(|v| Bson::Document(v.to_bson_document()))
                .collect::<Vec<_>>(),
        );
        d.insert("isHateRaid", self.is_hate_raid);
        insert_datetime(&mut d, "createdAt", self.created_at);
        insert_datetime(&mut d, "updatedAt", self.updated_at);
        d
    }
}
impl IFollowHateRaidSource {
    pub fn from_bson_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let r = Reader::new(document);
        let applied_log_ids = match document.get("appliedLogIDs") {
            None => None,
            Some(Bson::Null) => return Err(err(&r, "appliedLogIDs", "null")),
            Some(Bson::Array(a)) => {
                let mut out = Vec::new();
                for (i, v) in a.iter().enumerate() {
                    if let Bson::ObjectId(id) = v {
                        out.push(*id)
                    } else {
                        return Err(StrictDecodeError {
                            path: format!("appliedLogIDs.{i}"),
                            kind: "type",
                        });
                    }
                }
                Some(out)
            }
            _ => return Err(err(&r, "appliedLogIDs", "type")),
        };
        Ok(Self {
            target_channel_id: r.require_string("targetChannelID")?,
            target_channel_login: r.require_string("targetChannelLogin")?,
            target_channel_name: r.require_string("targetChannelName")?,
            raider_channel_id: r.require_string("raiderChannelID")?,
            raider_channel_login: r.require_string("raiderChannelLogin")?,
            raider_channel_name: r.require_string("raiderChannelName")?,
            count: number(&r, "count")?,
            applied_log_ids,
            first_seen_at: r.require_datetime("firstSeenAt")?,
            last_seen_at: r.require_datetime("lastSeenAt")?,
            created_at: r.require_datetime("createdAt")?,
            updated_at: r.require_datetime("updatedAt")?,
        })
    }
    pub fn to_bson_document(&self) -> Document {
        let mut d = Document::new();
        insert_string(&mut d, "targetChannelID", &self.target_channel_id);
        insert_string(&mut d, "targetChannelLogin", &self.target_channel_login);
        insert_string(&mut d, "targetChannelName", &self.target_channel_name);
        insert_string(&mut d, "raiderChannelID", &self.raider_channel_id);
        insert_string(&mut d, "raiderChannelLogin", &self.raider_channel_login);
        insert_string(&mut d, "raiderChannelName", &self.raider_channel_name);
        insert_f64(&mut d, "count", self.count);
        if let Some(ids) = &self.applied_log_ids {
            d.insert(
                "appliedLogIDs",
                ids.iter().copied().map(Bson::ObjectId).collect::<Vec<_>>(),
            );
        }
        insert_datetime(&mut d, "firstSeenAt", self.first_seen_at);
        insert_datetime(&mut d, "lastSeenAt", self.last_seen_at);
        insert_datetime(&mut d, "createdAt", self.created_at);
        insert_datetime(&mut d, "updatedAt", self.updated_at);
        d
    }
}
impl FollowDefenseAction {
    pub fn from_bson_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let r = Reader::new(document);
        Ok(Self {
            id: r.require_string("_id")?,
            channel_id: r.require_string("channelID")?,
            event_id: r.require_string("eventID")?,
            kind: read_enum!(r, "kind", FollowDefenseActionKind),
            follower_id: r.require_string("followerID")?,
            authorization: read_enum!(r, "authorization", FollowDefenseAuthorization),
            raid_session_id: r.require_string("raidSessionID")?,
            raid_follower_id: r.require_string("raidFollowerID")?,
            raid_request_id: r.require_string("raidRequestID")?,
            reason: r.require_string("reason")?,
            message: r.require_string("message")?,
            mode: read_enum!(r, "mode", FollowDefenseActionMode),
            authorized_at: r.require_datetime("authorizedAt")?,
            followed_at: r.nullable_datetime("followedAt")?,
            status: read_enum!(r, "status", FollowDefenseActionStatus),
            next_attempt_at: r.require_datetime("nextAttemptAt")?,
            locked_until: r.require_datetime("lockedUntil")?,
            lease_token: r.require_string("leaseToken")?,
            attempts: number(&r, "attempts")?,
            failures: number(&r, "failures")?,
            last_status: number(&r, "lastStatus")?,
            last_message: r.require_string("lastMessage")?,
            completed_at: r.nullable_datetime("completedAt")?,
            expires_at: r.require_datetime("expiresAt")?,
            purge_at: r.require_datetime("purgeAt")?,
            audit_pending: document
                .get("auditPending")
                .cloned()
                .ok_or_else(|| err(&r, "auditPending", "required"))?,
            created_at: r.require_datetime("createdAt")?,
            updated_at: r.require_datetime("updatedAt")?,
        })
    }
    pub fn to_bson_document(&self) -> Document {
        let mut d = Document::new();
        insert_string(&mut d, "_id", &self.id);
        insert_string(&mut d, "channelID", &self.channel_id);
        insert_string(&mut d, "eventID", &self.event_id);
        d.insert("kind", self.kind.as_str());
        insert_string(&mut d, "followerID", &self.follower_id);
        d.insert("authorization", self.authorization.as_str());
        insert_string(&mut d, "raidSessionID", &self.raid_session_id);
        insert_string(&mut d, "raidFollowerID", &self.raid_follower_id);
        insert_string(&mut d, "raidRequestID", &self.raid_request_id);
        insert_string(&mut d, "reason", &self.reason);
        insert_string(&mut d, "message", &self.message);
        d.insert("mode", self.mode.as_str());
        insert_datetime(&mut d, "authorizedAt", self.authorized_at);
        insert_nullable_datetime(&mut d, "followedAt", self.followed_at);
        d.insert("status", self.status.as_str());
        insert_datetime(&mut d, "nextAttemptAt", self.next_attempt_at);
        insert_datetime(&mut d, "lockedUntil", self.locked_until);
        insert_string(&mut d, "leaseToken", &self.lease_token);
        insert_f64(&mut d, "attempts", self.attempts);
        insert_f64(&mut d, "failures", self.failures);
        insert_f64(&mut d, "lastStatus", self.last_status);
        insert_string(&mut d, "lastMessage", &self.last_message);
        insert_nullable_datetime(&mut d, "completedAt", self.completed_at);
        insert_datetime(&mut d, "expiresAt", self.expires_at);
        insert_datetime(&mut d, "purgeAt", self.purge_at);
        d.insert("auditPending", self.audit_pending.clone());
        insert_datetime(&mut d, "createdAt", self.created_at);
        insert_datetime(&mut d, "updatedAt", self.updated_at);
        d
    }
}
