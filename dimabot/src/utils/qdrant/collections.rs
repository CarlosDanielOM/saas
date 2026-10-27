//! Collection schemas and source-compatible startup. Existing collections are
//! reported as `error: true/status: 409` and never repaired or reindexed. A new
//! collection returns 200 (not 201). Startup still returns a successful outer
//! envelope when individual creation results contain errors, as TS does.
//!
//! Source schemas declare a sibling `tokenizer: multilingual`, but the installed
//! JS client's `createPayloadIndex` drops that sibling and sends only the string
//! `field_schema: text`. The gRPC adapter preserves that effective wire behavior:
//! text indexes use the server's default word tokenizer. Metadata retains the
//! source declaration for source parity and makes this discrepancy explicit.

use super::backend::{execute_done, unexpected_response};
use super::{QdrantBackend, QdrantRequest, QdrantResponse, QdrantUtilities, UtilityError};
use ::qdrant_client::qdrant::*;
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

impl CollectionSchema {
    pub fn create_request(&self) -> Result<CreateCollection, UtilityError> {
        let distance = match self.vectors.distance.as_str() {
            "Cosine" => Distance::Cosine,
            "Euclid" => Distance::Euclid,
            "Dot" => Distance::Dot,
            _ => return Err(UtilityError("Unsupported collection distance".into())),
        };
        let mut request = CreateCollectionBuilder::new(&self.collection_name).vectors_config(
            VectorParamsBuilder::new(self.vectors.size, distance).on_disk(self.vectors.on_disk),
        );
        if let Some(config) = &self.quantization_config {
            if config.scalar.r#type != "int8" {
                return Err(UtilityError("Unsupported scalar quantization type".into()));
            }
            request = request.quantization_config(ScalarQuantization {
                r#type: QuantizationType::Int8 as i32,
                quantile: Some(config.scalar.quantile as f32),
                always_ram: Some(config.scalar.always_ram),
            });
        }
        Ok(request.build())
    }
    pub fn index_requests(&self) -> Result<Vec<CreateFieldIndexCollection>, UtilityError> {
        self.payload_indexes
            .iter()
            .map(|index| {
                let kind = match index.field_schema.as_str() {
                    "keyword" => FieldType::Keyword,
                    "integer" => FieldType::Integer,
                    "float" => FieldType::Float,
                    "geo" => FieldType::Geo,
                    "text" => FieldType::Text,
                    "bool" => FieldType::Bool,
                    "datetime" => FieldType::Datetime,
                    "uuid" => FieldType::Uuid,
                    _ => return Err(UtilityError("Unsupported payload index type".into())),
                };
                Ok(CreateFieldIndexCollectionBuilder::new(
                    &self.collection_name,
                    &index.field_name,
                    kind,
                )
                .build())
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionResult {
    pub error: bool,
    pub message: String,
    pub reason: Option<String>,
    pub status: u16,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Option<()>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartupResult {
    pub error: bool,
    pub message: String,
    pub reason: Option<String>,
    pub status: u16,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Vec<CollectionResult>,
}

pub async fn create_qdrant_collection(
    backend: &dyn QdrantBackend,
    schema: &CollectionSchema,
) -> CollectionResult {
    let result = async {
        let exists = match backend
            .execute(QdrantRequest::CollectionExists(
                schema.collection_name.clone(),
            ))
            .await?
        {
            QdrantResponse::Exists(exists) => exists,
            _ => return Err(unexpected_response()),
        };
        if exists {
            return Ok(true);
        }
        execute_done(
            backend,
            QdrantRequest::CreateCollection(schema.create_request()?),
        )
        .await?;
        for request in schema.index_requests()? {
            execute_done(backend, QdrantRequest::CreateIndex(request)).await?;
        }
        Ok::<_, UtilityError>(false)
    }
    .await;
    let name = &schema.collection_name;
    match result {
        Ok(true) => CollectionResult {
            error: true,
            message: format!("Collection {name} already exists"),
            reason: None,
            status: 409,
            kind: "collection_already_exists".into(),
            data: None,
        },
        Ok(false) => CollectionResult {
            error: false,
            message: format!("Collection {name} created"),
            reason: None,
            status: 200,
            kind: "success".into(),
            data: None,
        },
        Err(error) => CollectionResult {
            error: true,
            message: format!("Error creating Qdrant collection {name}"),
            reason: Some(error.to_string()),
            status: 500,
            kind: "error".into(),
            data: None,
        },
    }
}
impl QdrantUtilities<'_> {
    pub async fn start_up(&self) -> StartupResult {
        let mut chat = twitch_chat_logs_collection();
        chat.collection_name.clone_from(&self.names.chat);
        let mut memory = twitch_channel_memories_collection();
        memory.collection_name.clone_from(&self.names.memory);
        let mut data = Vec::with_capacity(2);
        for schema in [chat, memory] {
            data.push(create_qdrant_collection(self.backend, &schema).await);
        }
        StartupResult {
            error: false,
            message: "Qdrant collections created".into(),
            reason: None,
            status: 200,
            kind: "success".into(),
            data,
        }
    }
}
