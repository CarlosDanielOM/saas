//! `site_analytics` collection contract.
//!
//! `liveChannels` is an embedded array with `_id: false`. `planTier` here is
//! `free | premium | pro`. It is not `utils::ai_credit_projection::PlanTier`.
//! `created_at` / `updated_at` are schema timestamps, applied by
//! `prepare_insert` / `prepare_save`, not by `construct`.
use super::ordinary_model_values::{
    Reader, StrictDecodeError, insert_f64, insert_optional_datetime, insert_optional_string,
    insert_string,
};
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::js_string::JsString;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "site_analytics";
pub const COLLECTION_NAME: &str = "site_analytics";
pub const EXPORT_NAME: &str = "SiteAnalyticsSchema";

const PLATFORMS: &[&str] = &["twitch", "kick"];
const PLAN_TIERS: &[&str] = &["free", "premium", "pro"];

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! {"singletonKey": 1}).unique()],
        fields: vec![
            Field::new("singletonKey", T::String)
                .required()
                .default(D::String("global")),
            Field::new("registeredUsers", T::Number).default(D::Number(0.0)),
            Field::new("liveUsers", T::Number).default(D::Number(0.0)),
            Field::new("totalLiveViewers", T::Number).default(D::Number(0.0)),
            Field::new("authorizedAccounts", T::Number).default(D::Number(0.0)),
            Field::new("totalMessages", T::Number).default(D::Number(0.0)),
            Field::new("totalCommands", T::Number).default(D::Number(0.0)),
            Field::new(
                "liveChannels",
                T::Array(Box::new(T::Subdocument {
                    generate_id: false,
                    fields: live_channel_fields(),
                })),
            )
            .default(D::Array),
        ],
    })
}

fn live_channel_fields() -> Vec<Field> {
    vec![
        Field::new("channelID", T::String).default(D::String("")),
        Field::new("channel", T::String).default(D::String("")),
        Field::new("streamId", T::String).default(D::String("")),
        Field::new("title", T::String).default(D::String("")),
        Field::new("gameName", T::String).default(D::String("")),
        Field::new("viewers", T::Number).default(D::Number(0.0)),
        Field::new("profileImageUrl", T::String).default(D::String("")),
        Field::new("startedAt", T::String).default(D::String("")),
        Field::new("fetchedAt", T::String).default(D::String("")),
        Field::new(
            "botPlatforms",
            T::ArrayElement(Box::new(Field::new("", T::String).enumeration(PLATFORMS))),
        )
        .default(D::Array),
        Field::new("planTier", T::String)
            .default(D::String("free"))
            .enumeration(PLAN_TIERS),
    ]
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

pub fn repository(database: &Database) -> SchemaRepository {
    schema().repository(database)
}

pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

/// Source platform union. Not a credit-projection tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotPlatform {
    Twitch,
    Kick,
}

impl BotPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Twitch => "twitch",
            Self::Kick => "kick",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "twitch" => Some(Self::Twitch),
            "kick" => Some(Self::Kick),
            _ => None,
        }
    }
}

/// Source `planTier` union on a live channel: `free | premium | pro`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanTier {
    Free,
    Premium,
    Pro,
}

impl PlanTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "free" => Some(Self::Free),
            "premium" => Some(Self::Premium),
            "pro" => Some(Self::Pro),
            _ => None,
        }
    }
}

/// Source `ILiveChannel`. Optional strings are missing, not null.
/// A schema default of `''` is `Some` empty after construct.
#[derive(Clone, Debug, PartialEq)]
pub struct ILiveChannel {
    pub channel_id: JsString,
    pub channel: JsString,
    pub stream_id: Option<JsString>,
    pub title: Option<JsString>,
    pub game_name: Option<JsString>,
    pub viewers: f64,
    pub profile_image_url: Option<JsString>,
    pub started_at: Option<JsString>,
    pub fetched_at: Option<JsString>,
    pub bot_platforms: Vec<BotPlatform>,
    pub plan_tier: PlanTier,
}

/// Source `ISiteAnalytics`. Timestamps are optional on the interface.
#[derive(Clone, Debug, PartialEq)]
pub struct ISiteAnalytics {
    pub id: Option<ObjectId>,
    pub singleton_key: JsString,
    pub registered_users: f64,
    pub live_users: f64,
    pub total_live_viewers: f64,
    pub authorized_accounts: f64,
    pub total_messages: f64,
    pub total_commands: f64,
    pub live_channels: Vec<ILiveChannel>,
    pub created_at: Option<DateTime>,
    pub updated_at: Option<DateTime>,
}

fn join_path(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_owned()
    } else {
        format!("{prefix}.{key}")
    }
}

impl ILiveChannel {
    pub fn from_reader(reader: &Reader<'_>) -> Result<Self, StrictDecodeError> {
        let platforms = reader.require_array("botPlatforms")?;
        let plan = reader.require_string("planTier")?;
        let plan_tier =
            PlanTier::parse(plan.as_str().unwrap_or("")).ok_or_else(|| StrictDecodeError {
                path: join_path(reader.location(), "planTier"),
                kind: "enum",
            })?;
        Ok(Self {
            channel_id: reader.require_string("channelID")?,
            channel: reader.require_string("channel")?,
            stream_id: reader.optional_string("streamId")?,
            title: reader.optional_string("title")?,
            game_name: reader.optional_string("gameName")?,
            viewers: reader.require_f64("viewers")?,
            profile_image_url: reader.optional_string("profileImageUrl")?,
            started_at: reader.optional_string("startedAt")?,
            fetched_at: reader.optional_string("fetchedAt")?,
            bot_platforms: platforms
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    platform_at(&join_path(reader.location(), "botPlatforms"), index, value)
                })
                .collect::<Result<Vec<_>, _>>()?,
            plan_tier,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        insert_string(&mut document, "channelID", &self.channel_id);
        insert_string(&mut document, "channel", &self.channel);
        insert_optional_string(&mut document, "streamId", &self.stream_id);
        insert_optional_string(&mut document, "title", &self.title);
        insert_optional_string(&mut document, "gameName", &self.game_name);
        insert_f64(&mut document, "viewers", self.viewers);
        insert_optional_string(&mut document, "profileImageUrl", &self.profile_image_url);
        insert_optional_string(&mut document, "startedAt", &self.started_at);
        insert_optional_string(&mut document, "fetchedAt", &self.fetched_at);
        document.insert(
            "botPlatforms",
            Bson::Array(
                self.bot_platforms
                    .iter()
                    .map(|platform| Bson::String(platform.as_str().to_owned()))
                    .collect(),
            ),
        );
        document.insert("planTier", self.plan_tier.as_str());
        document
    }
}

fn platform_at(path: &str, index: usize, value: &Bson) -> Result<BotPlatform, StrictDecodeError> {
    let path = format!("{path}.{index}");
    let Bson::String(text) = value else {
        return Err(StrictDecodeError { path, kind: "type" });
    };
    BotPlatform::parse(text).ok_or(StrictDecodeError { path, kind: "enum" })
}

impl ISiteAnalytics {
    pub fn from_document(document: &Document) -> Result<Self, StrictDecodeError> {
        let reader = Reader::new(document);
        let channels = reader.require_array("liveChannels")?;
        Ok(Self {
            id: reader.optional_object_id("_id")?,
            singleton_key: reader.require_string("singletonKey")?,
            registered_users: reader.require_f64("registeredUsers")?,
            live_users: reader.require_f64("liveUsers")?,
            total_live_viewers: reader.require_f64("totalLiveViewers")?,
            authorized_accounts: reader.require_f64("authorizedAccounts")?,
            total_messages: reader.require_f64("totalMessages")?,
            total_commands: reader.require_f64("totalCommands")?,
            live_channels: channels
                .iter()
                .enumerate()
                .map(|(index, value)| live_channel_at(index, value))
                .collect::<Result<Vec<_>, _>>()?,
            created_at: reader.optional_datetime("created_at")?,
            updated_at: reader.optional_datetime("updated_at")?,
        })
    }

    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        if let Some(id) = self.id {
            document.insert("_id", id);
        }
        insert_string(&mut document, "singletonKey", &self.singleton_key);
        insert_f64(&mut document, "registeredUsers", self.registered_users);
        insert_f64(&mut document, "liveUsers", self.live_users);
        insert_f64(&mut document, "totalLiveViewers", self.total_live_viewers);
        insert_f64(
            &mut document,
            "authorizedAccounts",
            self.authorized_accounts,
        );
        insert_f64(&mut document, "totalMessages", self.total_messages);
        insert_f64(&mut document, "totalCommands", self.total_commands);
        document.insert(
            "liveChannels",
            Bson::Array(
                self.live_channels
                    .iter()
                    .map(|channel| Bson::Document(channel.to_document()))
                    .collect(),
            ),
        );
        insert_optional_datetime(&mut document, "created_at", self.created_at);
        insert_optional_datetime(&mut document, "updated_at", self.updated_at);
        document
    }
}

fn live_channel_at(index: usize, value: &Bson) -> Result<ILiveChannel, StrictDecodeError> {
    let Bson::Document(document) = value else {
        return Err(StrictDecodeError {
            path: format!("liveChannels.{index}"),
            kind: "type",
        });
    };
    ILiveChannel::from_reader(&Reader::with_prefix(
        document,
        &format!("liveChannels.{index}"),
    ))
}
