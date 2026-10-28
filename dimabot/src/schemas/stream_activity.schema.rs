use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::doc;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    activity_schema()
}
pub fn activity_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "stream_activity",
        collection: "stream_activities",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String).required(),
            Field::new("session_id", T::ObjectId).required(),
            Field::new("occurredAt", T::Date).required(),
            Field::new("offset", T::Number),
            Field::new("kind", T::String)
                .enumeration(&[
                    "message",
                    "command",
                    "redemption",
                    "follow",
                    "sub",
                    "gift",
                    "bits",
                    "raid",
                ])
                .required(),
            Field::new("key", T::String).default(D::String("")),
            Field::new("label", T::String).default(D::String("")),
            Field::new("actor", T::String).default(D::String("")),
            Field::new("actorLabel", T::String).default(D::String("")),
            Field::new("value", T::Number).default(D::Number(1.0)),
            Field::new("outcome", T::String).default(D::String("")),
            Field::new(
                "emotes",
                T::Array(Box::new(T::Subdocument {
                    generate_id: false,
                    fields: vec![
                        Field::new("key", T::String),
                        Field::new("label", T::String),
                        Field::new("count", T::Number),
                    ],
                })),
            )
            .default(D::Array),
            Field::new("processed", T::Boolean).default(D::Boolean(false)),
            Field::new("dashboardProcessed", T::Boolean).default(D::Null),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"processed":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"processed":1,"expiresAt":1}),
            SchemaIndex::new(doc! {"channelID":1,"session_id":1,"kind":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
            SchemaIndex::new(doc! {"dashboardProcessed":1,"kind":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"dashboardProcessed":1,"kind":1,"occurredAt":1}),
        ],
    })
}
pub fn aggregate_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut fields=vec![Field::new("_id",T::String),Field::new("channelID",T::String),Field::new("session_id",T::ObjectId),Field::new("scope",T::String),Field::new("kind",T::String),Field::new("key",T::String).default(D::String("")),Field::new("actor",T::String).default(D::String("")),Field::new("label",T::String),Field::new("bucket",T::Number).default(D::Number(-1.0))];
        for name in ["count","messages","commands","emotes","emoteMessages","chatters","failures","redemptions","follows","subs","bits","raids"] {fields.push(Field::new(name,T::Number).default(D::Number(0.0)));}
        fields.extend([Field::new("firstSeq",T::Number),Field::new("lastSeq",T::Number).default(D::Number(0.0)),Field::new("firstAt",T::Date),Field::new("messageStartedAt",T::Date),Field::new("updatedAt",T::Date),Field::new("expiresAt",T::Date).required()]);
        SchemaDefinition {model:"stream_activity_aggregate",collection:"stream_activity_aggregates",string_id:true,version_key:false,write_concern_journaled:false,timestamps:None,save_clock_field:None,fields,indexes:vec![SchemaIndex::new(doc! {"channelID":1,"session_id":1,"scope":1,"kind":1,"key":1,"count":-1,"_id":1}),SchemaIndex::new(doc! {"channelID":1,"session_id":1,"scope":1,"kind":1,"count":-1,"_id":1}),SchemaIndex::new(doc! {"channelID":1,"session_id":1,"scope":1,"bucket":1}),SchemaIndex::new(doc! {"expiresAt":1}).ttl(0)]}
    })
}
pub fn state_schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "stream_activity_state",
        collection: "stream_activity_states",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("_id", T::String),
            Field::new("owner", T::String),
            Field::new("leaseUntil", T::Date),
            Field::new("seq", T::Number).default(D::Number(0.0)),
            Field::new(
                "active",
                T::Object(vec![
                    Field::new("seq", T::Number),
                    Field::new("ids", T::Array(Box::new(T::String))).default(D::Array),
                ]),
            ),
            Field::new("updatedAt", T::Date),
        ],
    })
}
