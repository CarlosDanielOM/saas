use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type StreamSubscriptionLedger = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "stream_subscription_ledger",
        collection: "stream_subscription_ledgers",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        fields: vec![
            Field::new("platform", T::String)
                .enumeration(&["twitch"])
                .required()
                .default(D::String("twitch")),
            Field::new("streamer_id", T::String).required(),
            Field::new("streamer_login", T::String).default(D::String("")),
            Field::new("streamer_name", T::String).default(D::String("")),
            Field::new("user_id", T::String).required(),
            Field::new("user_login", T::String).default(D::String("")),
            Field::new("user_name", T::String).default(D::String("")),
            Field::new("sub_tier_raw", T::String).default(D::String("")),
            Field::new("sub_tier_normalized", T::String)
                .enumeration(&["tier1", "tier2", "tier3", "unknown"])
                .default(D::String("unknown")),
            Field::new("is_gift", T::Boolean).default(D::Boolean(false)),
            Field::new("status", T::String)
                .enumeration(&["active", "ended"])
                .default(D::String("active")),
            Field::new("subbed_at", T::Date).default(D::Now).required(),
            Field::new("ended_at", T::Date).default(D::Null),
            Field::new("last_event_at", T::Date)
                .default(D::Now)
                .required(),
            Field::new("event_key", T::String),
            Field::new("applied_event_keys", T::Array(Box::new(T::String)))
                .default(D::Array)
                .hidden(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"platform":1}),
            SchemaIndex::new(doc! {"streamer_id":1}),
            SchemaIndex::new(doc! {"user_id":1}),
            SchemaIndex::new(doc! {"sub_tier_normalized":1}),
            SchemaIndex::new(doc! {"status":1}),
            SchemaIndex::new(doc! {"last_event_at":1}),
            SchemaIndex::new(doc! {"streamer_id":1,"status":1}),
            SchemaIndex::new(doc! {"platform":1,"streamer_id":1,"user_id":1,"last_event_at":-1}),
            SchemaIndex::new(doc! {"event_key":1}).unique().sparse(),
            SchemaIndex::new(doc! {"platform":1,"streamer_id":1,"user_id":1,"status":1})
                .unique()
                .partial(doc! {"status":"active"}),
        ],
    })
}
