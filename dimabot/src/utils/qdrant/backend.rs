//! Thin native gRPC transport. Requests remain native Qdrant types so mocks can
//! inspect the actual filter, wait, payload, pagination, and index policies.

use super::{UtilityError, UtilityFuture};
use ::qdrant_client::{Payload, Qdrant, qdrant::*};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
// Keep native request values directly inspectable by injected backends.
#[allow(clippy::large_enum_variant)]
pub enum QdrantRequest {
    CollectionExists(String),
    CreateCollection(CreateCollection),
    CreateIndex(CreateFieldIndexCollection),
    Upsert(UpsertPoints),
    Scroll(ScrollPoints),
    Query(QueryPoints),
    Retrieve(GetPoints),
    Delete(DeletePoints),
}

#[derive(Debug, Clone)]
pub enum QdrantResponse {
    Exists(bool),
    Done,
    Points(Vec<Value>),
    Scroll {
        points: Vec<Value>,
        next_offset: Option<PointId>,
    },
}

pub trait QdrantBackend: Send + Sync {
    fn execute(&self, request: QdrantRequest) -> UtilityFuture<'_, QdrantResponse>;
}

impl QdrantBackend for Qdrant {
    fn execute(&self, request: QdrantRequest) -> UtilityFuture<'_, QdrantResponse> {
        Box::pin(async move {
            Ok(match request {
                QdrantRequest::CollectionExists(name) => {
                    QdrantResponse::Exists(self.collection_exists(name).await?)
                }
                QdrantRequest::CreateCollection(request) => {
                    self.create_collection(request).await?;
                    QdrantResponse::Done
                }
                QdrantRequest::CreateIndex(request) => {
                    self.create_field_index(request).await?;
                    QdrantResponse::Done
                }
                QdrantRequest::Upsert(request) => {
                    self.upsert_points(request).await?;
                    QdrantResponse::Done
                }
                QdrantRequest::Delete(request) => {
                    self.delete_points(request).await?;
                    QdrantResponse::Done
                }
                QdrantRequest::Query(request) => {
                    let response = self.query(request).await?;
                    QdrantResponse::Points(
                        response
                            .result
                            .into_iter()
                            .map(|p| point_json(p.id, p.payload, Some(p.score)))
                            .collect(),
                    )
                }
                QdrantRequest::Retrieve(request) => {
                    let response = self.get_points(request).await?;
                    QdrantResponse::Points(
                        response
                            .result
                            .into_iter()
                            .map(|p| point_json(p.id, p.payload, None))
                            .collect(),
                    )
                }
                QdrantRequest::Scroll(request) => {
                    let response = self.scroll(request).await?;
                    QdrantResponse::Scroll {
                        points: response
                            .result
                            .into_iter()
                            .map(|p| point_json(p.id, p.payload, None))
                            .collect(),
                        next_offset: response.next_page_offset,
                    }
                }
            })
        })
    }
}

fn point_json(
    id: Option<PointId>,
    payload: std::collections::HashMap<String, ::qdrant_client::qdrant::Value>,
    score: Option<f32>,
) -> Value {
    let id = match id.and_then(|id| id.point_id_options) {
        Some(point_id::PointIdOptions::Num(id)) => json!(id),
        Some(point_id::PointIdOptions::Uuid(id)) => json!(id),
        None => Value::Null,
    };
    let mut value = json!({ "id": id, "payload": Value::from(Payload::from(payload)) });
    // REST uses the shortest decimal for the f32. Widening directly would
    // turn 0.69 into 0.6899999976158142 and fail the TS-side >= 0.69 check.
    if let Some(score) = score {
        value["score"] = json!(rest_score(score));
    }
    value
}

fn rest_score(score: f32) -> f64 {
    score.to_string().parse().unwrap_or(f64::NAN)
}

pub(crate) fn unexpected_response() -> UtilityError {
    UtilityError("Qdrant backend returned an unexpected response variant".into())
}

pub(crate) async fn execute_done(
    backend: &dyn QdrantBackend,
    request: QdrantRequest,
) -> Result<(), UtilityError> {
    match backend.execute(request).await? {
        QdrantResponse::Done => Ok(()),
        _ => Err(unexpected_response()),
    }
}
pub(crate) async fn execute_points(
    backend: &dyn QdrantBackend,
    request: QdrantRequest,
) -> Result<Vec<Value>, UtilityError> {
    match backend.execute(request).await? {
        QdrantResponse::Points(points) => Ok(points),
        _ => Err(unexpected_response()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn grpc_scores_match_rest_decimals_at_thresholds() {
        for score in [0.45_f32, 0.55, 0.69, 0.72, 0.75] {
            assert_eq!(
                super::rest_score(score),
                score.to_string().parse::<f64>().unwrap()
            );
        }
        assert_eq!(super::rest_score(0.69), 0.69);
    }
}
