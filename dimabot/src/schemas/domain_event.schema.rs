use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use mongodb::bson::{Document, doc};
use std::sync::OnceLock;
pub type DomainEvent = Document;
pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "domain_event",
        collection: "domain_events",
        string_id: false,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("eventKey", T::String).required().immutable(),
            Field::new("source", T::String).required().immutable(),
            Field::new("sourceEventId", T::String)
                .required()
                .immutable(),
            Field::new("type", T::String).required().immutable(),
            Field::new("topic", T::String)
                .enumeration(&["channel", "activity", "telemetry", "domain"])
                .required()
                .immutable(),
            Field::new("schemaVersion", T::Number)
                .default(D::Number(1.0))
                .required()
                .immutable(),
            Field::new("ownerUserId", T::String).immutable(),
            Field::new(
                "subject",
                T::Subdocument {
                    generate_id: false,
                    fields: vec![
                        Field::new("provider", T::String).required(),
                        Field::new("kind", T::String)
                            .enumeration(&[
                                "streaming-account",
                                "integration-account",
                                "customer",
                                "resource",
                            ])
                            .required(),
                        Field::new("id", T::String).required(),
                    ],
                },
            )
            .immutable(),
            Field::new("channelID", T::String)
                .required_when("topic", "channel")
                .immutable(),
            Field::new("streamID", T::String).immutable(),
            Field::new("occurredAt", T::Date).required().immutable(),
            Field::new("journaledAt", T::Date)
                .default(D::Now)
                .required()
                .immutable(),
            Field::new("payload", T::Mixed).required().immutable(),
            Field::new("metadata", T::Mixed)
                .default(D::Object)
                .required()
                .immutable(),
            Field::new("expiresAt", T::Date).required().immutable(),
            Field::new("dispatchPending", T::Boolean),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"type":1}),
            SchemaIndex::new(doc! {"topic":1}),
            SchemaIndex::new(doc! {"ownerUserId":1}),
            SchemaIndex::new(doc! {"channelID":1}),
            SchemaIndex::new(doc! {"eventKey":1}).unique(),
            SchemaIndex::new(doc! {"source":1,"sourceEventId":1,"type":1}).unique(),
            SchemaIndex::new(doc! {"topic":1,"_id":1}),
            SchemaIndex::new(doc! {"topic":1,"source":1,"_id":1}),
            SchemaIndex::new(doc! {"channelID":1,"source":1,"type":1,"occurredAt":1,"_id":1}),
            SchemaIndex::new(doc! {"dispatchPending":1,"_id":1})
                .partial(doc! {"dispatchPending":true}),
            SchemaIndex::new(doc! {"topic":1,"metadata.durableChatHandled":1,"_id":1})
                .partial(doc! {"metadata.durableChatHandled":true}),
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
        ],
    })
}
