use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use std::sync::OnceLock;
pub const ACCOUNT_TYPES: &[&str] = &["twitch", "youtube", "kick", "tiktok", "spotify"];
pub const PLAN_TIERS: &[&str] = &["free", "premium", "pro"];
pub const LANGUAGES: &[&str] = &["en", "es"];
fn token() -> T {
    T::Object(vec![
        Field::new("iv", T::String).default(D::Null),
        Field::new("content", T::String).default(D::Null),
    ])
}
pub fn account_fields() -> Vec<Field> {
    vec![
        Field::new("type", T::String)
            .default(D::String("twitch"))
            .enumeration(ACCOUNT_TYPES),
        Field::new("id", T::String).default(D::Null),
        Field::new("name", T::String).default(D::Null),
        Field::new("email", T::String).default(D::Null),
        Field::new("refresh_token", token()),
        Field::new("access_token", token()),
        Field::new("access_token_expires_at", T::Number).default(D::Null),
        Field::new("actived", T::Boolean).default(D::Boolean(true)),
        Field::new("chat_enabled", T::Boolean).default(D::Boolean(true)),
        Field::new("has_permissions", T::Boolean).default(D::Boolean(true)),
        Field::new("up_to_date_permissions", T::Boolean).default(D::Boolean(true)),
    ]
}
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "users",
        collection: "users",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("created_at", "updated_at")),
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("name", T::String),
            Field::new("email", T::String),
            Field::new(
                "accounts",
                T::Array(Box::new(T::Subdocument {
                    fields: account_fields(),
                    generate_id: true,
                })),
            )
            .default(D::Array),
            Field::new("language", T::String)
                .default(D::Null)
                .enumeration(LANGUAGES),
            Field::new("tts_default_provider", T::String).enumeration(&["kokoro"]),
            Field::new("polar_sh_customer_id", T::String).default(D::Null),
            Field::new("polar_plan_event_at", T::Date),
            Field::new("polar_plan_event_key", T::String),
            Field::new("polar_plan_effects_pending", T::Boolean),
            Field::new("polar_plan_entitlement_fingerprint", T::String),
            Field::new(
                "polar_credit_snapshot",
                T::Subdocument {
                    generate_id: false,
                    fields: vec![
                        Field::new("occurredAt", T::Date).required(),
                        Field::new("eventKey", T::String).required(),
                        Field::new("meters", T::Array(Box::new(T::Mixed)))
                            .default(D::Array)
                            .required(),
                    ],
                },
            )
            .hidden(),
            Field::new("plan_tier", T::String)
                .default(D::String("free"))
                .enumeration(PLAN_TIERS),
            Field::new("plan_tier_until", T::Date).default(D::Null),
            Field::new("last_app_activity_at", T::Date).default(D::Null),
            Field::new("refreshed_at", T::Date).default(D::Now),
            Field::new("referrerId", T::ObjectId).default(D::Null),
            Field::new("referralCodeUsed", T::String).default(D::Null),
            Field::new("token_balance", T::Number).default(D::Number(0.0)),
            Field::new(
                "applied_credit_transaction_ids",
                T::Array(Box::new(T::ObjectId)),
            )
            .hidden(),
            Field::new("reminder_sent_at", T::Date).default(D::Null),
            Field::new(
                "free_credit_reset",
                T::Subdocument {
                    generate_id: false,
                    fields: vec![
                        Field::new("periodStart", T::Date).required(),
                        Field::new("periodEnd", T::Date).required(),
                        Field::new("status", T::String)
                            .enumeration(&["initialized", "pending", "completed"])
                            .required(),
                        Field::new("credits", T::Number).min(0.0).required(),
                        Field::new("externalId", T::String).required(),
                        Field::new("updatedAt", T::Date).required(),
                        Field::new("completedAt", T::Date).default(D::Null),
                    ],
                },
            ),
        ],
    })
}
