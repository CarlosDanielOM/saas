use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
pub type StreamSession = Document;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamSessionStatus {
    Live,
    Offline,
    Orphaned,
}
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut fields = vec![
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).default(D::String("")),
            Field::new("stream_id", T::String).required(),
            Field::new("started_at", T::Date).required(),
            Field::new("ended_at", T::Date).default(D::Null),
            Field::new("status", T::String)
                .enumeration(&["live", "offline", "orphaned"])
                .default(D::String("live")),
            Field::new("chat_tracking_started_at", T::Date),
        ];
        for name in [
            "peak_viewers",
            "average_viewers",
            "sample_count",
            "sample_total_viewers",
            "duration_minutes",
            "follows",
            "subs",
            "bits",
            "donations",
            "messages",
            "commands",
        ] {
            fields.push(Field::new(name, T::Number).default(D::Number(0.0)));
        }
        fields.push(
            Field::new("applied_domain_event_keys", T::Array(Box::new(T::String)))
                .default(D::Array)
                .hidden(),
        );
        for name in [
            "offline_summary_enqueued_at",
            "offline_clips_completed_at",
            "last_seen_live_at",
        ] {
            fields.push(Field::new(name, T::Date).default(D::Null));
        }
        fields.push(Field::new("consecutive_offline_checks", T::Number).default(D::Number(0.0)));
        SchemaDefinition {
            model: "StreamSession",
            collection: "streamsessions",
            string_id: false,
            version_key: true,
            write_concern_journaled: false,
            timestamps: Some(("created_at", "updated_at")),
            save_clock_field: None,
            fields,
            indexes: vec![
                SchemaIndex::new(doc! {"channelID":1}),
                SchemaIndex::new(doc! {"stream_id":1}),
                SchemaIndex::new(doc! {"started_at":1}),
                SchemaIndex::new(doc! {"ended_at":1}),
                SchemaIndex::new(doc! {"status":1}),
                SchemaIndex::new(doc! {"channelID":1,"started_at":-1}),
                SchemaIndex::new(doc! {"channelID":1,"started_at":-1,"ended_at":1}),
                SchemaIndex::new(doc! {"channelID":1,"stream_id":1}).unique(),
                SchemaIndex::new(doc! {"channelID":1,"ended_at":1})
                    .partial(doc! {"ended_at":mongodb::bson::Bson::Null})
                    .unique(),
            ],
        }
    })
}
