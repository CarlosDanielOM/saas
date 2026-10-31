//! `follow_relationship_ledgers` collection contract.
//!
//! Port of `src/schemas/follow_relationship_ledger.schema.ts`. Mongoose derives
//! the collection name by pluralising the model name, so model
//! `follow_relationship_ledger` writes to `follow_relationship_ledgers`; the
//! native follow-defense projector already reads that collection, so the name is
//! fixed here rather than chosen.
//!
//! Parity notes:
//! - Field order, BSON types, defaults, requiredness and the `enum` lists are
//!   taken verbatim from the TypeScript schema.
//! - `created_at` / `updated_at` are schema timestamps, applied by
//!   `prepare_insert` / `prepare_save` and by the collector's explicit `$set` /
//!   `$setOnInsert` timestamps; `construct` alone does not add them.
//! - `index: true` path options and the four explicit composite indexes are
//!   reproduced in declaration order. The final index is unique and partially
//!   filtered on `status: 'active'`, so one active edge exists per
//!   `(platform, follower_id, followed_id)` and ended history stays unbounded.
//! - There is no TTL index in the source schema. Nothing here expires ledger
//!   documents.
//! - Construction performs no I/O: no connection, no index installation and no
//!   environment read.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::{Collection, Database, bson::Document};
use mongodb::bson::doc;
use std::sync::OnceLock;

pub const MODEL_NAME: &str = "follow_relationship_ledger";
pub const COLLECTION_NAME: &str = "follow_relationship_ledgers";
pub const EXPORT_NAME: &str = "FollowRelationshipLedgerSchema";

/// Source `FollowPlatform`. Only Twitch is supported by the source union.
pub const PLATFORMS: &[&str] = &["twitch"];
/// Source `FollowStatus`.
pub const STATUSES: &[&str] = &["active", "ended"];
/// Source `EndedReason`, in declaration order.
pub const ENDED_REASONS: &[&str] = &[
    "missing_in_followers_scan",
    "missing_in_following_scan",
    "event_unfollow",
    "unknown",
];

/// Native rows are driver documents with the source's snake_case field names.
pub type FollowRelationshipLedger = Document;

/// Source `FollowPlatform`. Not a `utils::site_analytics::BotPlatform`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowPlatform {
    Twitch,
}

impl FollowPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Twitch => "twitch",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "twitch" => Some(Self::Twitch),
            _ => None,
        }
    }
}

/// Source `FollowStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowStatus {
    Active,
    Ended,
}

impl FollowStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Ended => "ended",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "active" => Some(Self::Active),
            "ended" => Some(Self::Ended),
            _ => None,
        }
    }
}

/// Source `EndedReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndedReason {
    MissingInFollowersScan,
    MissingInFollowingScan,
    EventUnfollow,
    Unknown,
}

impl EndedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingInFollowersScan => "missing_in_followers_scan",
            Self::MissingInFollowingScan => "missing_in_following_scan",
            Self::EventUnfollow => "event_unfollow",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "missing_in_followers_scan" => Some(Self::MissingInFollowersScan),
            "missing_in_following_scan" => Some(Self::MissingInFollowingScan),
            "event_unfollow" => Some(Self::EventUnfollow),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: MODEL_NAME,
        collection: COLLECTION_NAME,
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("platform", T::String)
                .required()
                .default(D::String("twitch"))
                .enumeration(PLATFORMS),
            Field::new("follower_id", T::String).required(),
            Field::new("follower_login", T::String).default(D::String("")),
            Field::new("follower_name", T::String).default(D::String("")),
            Field::new("followed_id", T::String).required(),
            Field::new("followed_login", T::String).default(D::String("")),
            Field::new("followed_name", T::String).default(D::String("")),
            Field::new("mutual", T::Boolean).default(D::Boolean(false)),
            Field::new("status", T::String)
                .default(D::String("active"))
                .enumeration(STATUSES),
            Field::new("followed_at", T::Date).required().default(D::Now),
            Field::new("ended_at", T::Date).default(D::Null),
            Field::new("ended_reason", T::String)
                .default(D::Null)
                .enumeration(ENDED_REASONS),
            Field::new("last_event_at", T::Date).required().default(D::Now),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"platform":1}),
            SchemaIndex::new(doc! {"follower_id":1}),
            SchemaIndex::new(doc! {"followed_id":1}),
            SchemaIndex::new(doc! {"mutual":1}),
            SchemaIndex::new(doc! {"status":1}),
            SchemaIndex::new(doc! {"last_event_at":1}),
            SchemaIndex::new(doc! {"followed_id":1,"status":1}),
            SchemaIndex::new(doc! {"followed_id":1,"mutual":1,"status":1}),
            SchemaIndex::new(doc! {"follower_id":1,"status":1}),
            SchemaIndex::new(doc! {"platform":1,"follower_id":1,"followed_id":1,"status":1})
                .unique()
                .partial(doc! {"status":"active"}),
        ],
    })
}

pub fn collection(database: &Database) -> Collection<Document> {
    schema().native_collection(database)
}

/// Explicit installation only; never called from a constructor.
pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}
