use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionSchema {
    pub collection_name: String,
    pub vectors: VectorSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization_config: Option<ScalarQuantizationSchema>,
    pub payload_indexes: Vec<PayloadIndexSchema>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorSchema {
    pub size: u64,
    pub distance: String,
    pub on_disk: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScalarQuantizationSchema {
    pub scalar: ScalarQuantizationOptions,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScalarQuantizationOptions {
    pub r#type: String,
    pub quantile: f64,
    pub always_ram: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayloadIndexSchema {
    pub field_name: String,
    pub field_schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokenizer: Option<String>,
}

pub fn twitch_chat_logs_collection() -> CollectionSchema {
    schema(
        "twitch_chat_logs",
        &[
            ("username", "keyword"),
            ("message", "text"),
            ("channel", "keyword"),
            ("channel_name", "keyword"),
            ("user_id", "keyword"),
            ("timestamp", "integer"),
            ("language", "keyword"),
            ("channel_id", "keyword"),
        ],
    )
}
pub fn twitch_channel_memories_collection() -> CollectionSchema {
    schema(
        "twitch_channel_memories",
        &[
            ("memory_id", "keyword"),
            ("channel_id", "keyword"),
            ("memory_type", "keyword"),
            ("status", "keyword"),
            ("risk", "keyword"),
            ("confidence", "float"),
            ("subject_scope", "keyword"),
            ("subject_username", "keyword"),
            ("subject_user_id", "keyword"),
            ("content", "text"),
            ("summary", "text"),
            ("created_at", "integer"),
            ("updated_at", "integer"),
        ],
    )
}
fn schema(name: &str, indexes: &[(&str, &str)]) -> CollectionSchema {
    CollectionSchema {
        collection_name: name.into(),
        vectors: VectorSchema {
            size: 1024,
            distance: "Cosine".into(),
            on_disk: true,
        },
        quantization_config: Some(ScalarQuantizationSchema {
            scalar: ScalarQuantizationOptions {
                r#type: "int8".into(),
                quantile: 0.99,
                always_ram: true,
            },
        }),
        payload_indexes: indexes
            .iter()
            .map(|(name, kind)| PayloadIndexSchema {
                field_name: (*name).into(),
                field_schema: (*kind).into(),
                tokenizer: (*kind == "text").then(|| "multilingual".into()),
            })
            .collect(),
    }
}
