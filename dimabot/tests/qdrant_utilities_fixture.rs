#![cfg(feature = "qdrant")]

//! Run only in the parent's capped test container against its disposable
//! Qdrant fixture. Requires explicit connector environment and a collection
//! prefix beginning `dima_rust_fixture`. No real embedding, queue, or context
//! transports are used. Cleanup runs even if the scenario task panics.

use dima_rust::utils::qdrant::*;
use qdrant_client::{
    Payload,
    qdrant::{
        Condition, DeletePointsBuilder, Distance, Filter, GetPointsBuilder, PayloadSchemaType,
        PointStruct, QuantizationType, QueryPointsBuilder, ScrollPointsBuilder,
        UpsertPointsBuilder, r#match::MatchValue, quantization_config, value, vectors_config,
    },
};
use serde_json::json;
use std::{
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Embeddings;
impl EmbeddingProvider for Embeddings {
    fn embed<'a>(
        &'a self,
        _text: &'a str,
        model: &'static str,
        kind: EmbeddingKind,
    ) -> UtilityFuture<'a, Vec<f32>> {
        Box::pin(async move {
            assert_eq!(model, EMBEDDING_MODEL);
            assert!(matches!(
                kind,
                EmbeddingKind::Query | EmbeddingKind::Document
            ));
            let mut vector = vec![0.0; 1024];
            vector[0] = 1.0;
            Ok(vector)
        })
    }
}
struct Language;
impl LanguageDetector for Language {
    fn detect_language(&self, _text: &str, threshold: f64) -> String {
        assert_eq!(threshold, 0.1);
        "fixture".into()
    }
}
#[derive(Default)]
struct Queue(Mutex<Vec<QueuedChatMessage>>);
impl ChatEmbeddingQueue for Queue {
    fn add_message(&self, message: QueuedChatMessage) -> Result<(), UtilityError> {
        self.0.lock().unwrap().push(message);
        Ok(())
    }
}
#[derive(Default)]
struct Context(Mutex<Vec<SemanticMemoryMetric>>);
impl QdrantContext for Context {
    fn semantic_memory_metric(&self, metric: SemanticMemoryMetric) {
        self.0.lock().unwrap().push(metric);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires parent-owned isolated Qdrant fixture and capped compiler/test container"]
async fn collection_chat_semantic_and_memory_service_contracts() {
    let prefix = std::env::var("QDRANT_TEST_COLLECTION_PREFIX")
        .expect("explicit fixture-only prefix required");
    assert!(prefix.starts_with("dima_rust_fixture"));
    assert!(
        prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    );
    let settings = QdrantSettings::from_env().expect("explicit disposable fixture settings");
    let client = connect(&settings).await.expect("fixture connection");
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let names = QdrantCollectionNames {
        chat: format!("{prefix}_chat_{unique}"),
        memory: format!("{prefix}_memory_{unique}"),
    };
    let scenario_client = client.clone();
    let scenario_names = names.clone();
    let outcome=tokio::spawn(async move{
        let client=scenario_client;let names=scenario_names;
        let embeddings=Embeddings;let language=Language;let queue=Queue::default();let context=Context::default();
        let service=QdrantUtilities::new(&client,&embeddings,&language).with_context(&context).with_collections(names.clone());
        let startup=service.start_up().await;
        assert!(!startup.error);assert!(startup.data.iter().all(|r|!r.error&&r.status==200),"{startup:?}");
        let again=service.start_up().await;
        assert!(again.data.iter().all(|r|r.error&&r.status==409));
        for (name,source_schema) in [(&names.chat,twitch_chat_logs_collection()),(&names.memory,twitch_channel_memories_collection())] {
            let mut found=false;
            for _ in 0..40 {
                let info=client.collection_info(name.as_str()).await.unwrap().result.unwrap();
                let config=info.config.as_ref().expect("collection configuration");
                let vectors=config.params.as_ref().unwrap().vectors_config.as_ref().unwrap().config.as_ref().unwrap();
                let vectors_config::Config::Params(vectors)=vectors else{panic!("unnamed dense vector expected")};
                assert_eq!(vectors.size,1024);assert_eq!(vectors.distance,Distance::Cosine as i32);assert_eq!(vectors.on_disk,Some(true));
                let quantization=config.quantization_config.as_ref().unwrap().quantization.as_ref().unwrap();
                let quantization_config::Quantization::Scalar(scalar)=quantization else{panic!("scalar quantization expected")};
                assert_eq!(scalar.r#type,QuantizationType::Int8 as i32);assert_eq!(scalar.always_ram,Some(true));
                assert!((scalar.quantile.unwrap()-0.99).abs()<1e-6);
                if info.payload_schema.len()==source_schema.payload_indexes.len() {
                    for index in &source_schema.payload_indexes {
                        let schema=info.payload_schema.get(&index.field_name).expect("expected payload index missing");
                        let expected=match index.field_schema.as_str(){
                            "keyword"=>PayloadSchemaType::Keyword,"integer"=>PayloadSchemaType::Integer,
                            "float"=>PayloadSchemaType::Float,"text"=>PayloadSchemaType::Text,_=>panic!("unexpected source index")
                        };
                        assert_eq!(schema.data_type,expected as i32,"{}",index.field_name);
                        if index.field_schema=="text" {
                            // A bare Text schema has no custom params; Qdrant 1.17
                            // uses TextIndexParams::default() with tokenizer Word.
                            // https://github.com/qdrant/qdrant/blob/v1.17.0/lib/segment/src/data_types/index.rs
                            assert!(schema.params.is_none(), "source sends a bare text index: {schema:?}");
                        }
                    }
                    found=true;break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert!(found,"all source indexes must be created");
            // Verify actual default word behavior for each installed text index:
            // case folds, punctuation splits words, and prefixes do not match.
            for index in source_schema.payload_indexes.iter().filter(|i|i.field_schema=="text") {
                let payload=Payload::try_from(json!({index.field_name.clone():"Fixture_DRAGON-message"})).unwrap();
                let probe_id=9_001_u64;
                client.upsert_points(UpsertPointsBuilder::new(name,vec![PointStruct::new(probe_id,vec![1.0;1024],payload)]).wait(true)).await.unwrap();
                for (text,expected) in [("DRAGON",1),("message",1),("drag",0)] {
                    let result=client.scroll(ScrollPointsBuilder::new(name)
                        .filter(Filter::must([Condition::matches(index.field_name.clone(),MatchValue::Text(text.into()))]))
                        .limit(2)).await.unwrap();
                    assert_eq!(result.result.len(),expected,"default word tokenizer: {} / {text}",index.field_name);
                }
                client.delete_points(DeletePointsBuilder::new(name).points(vec![probe_id]).wait(true)).await.unwrap();
            }
        }
        let data=ChatMessageData{channel_id:"c".into(),channel_name:Some("fixture channel".into()),message:"  fixture dragon message  ".into(),
            username:"tester".into(),user_id:"u".into(),timestamp:1_700_000_000.0,language:None};
        assert!(!service.store_chat_message_embedding(&data).await.error);
        service.store_chat_message_embedding_batched(&queue,&data).await;
        assert_eq!(queue.0.lock().unwrap()[0].text,data.message);
        let point_id=u64::from(generate_qdrant_point_id("c","u",data.timestamp));
        let mut stored=None;
        for _ in 0..40 {
            let points=client.get_points(GetPointsBuilder::new(&names.chat,vec![point_id.into()]).with_payload(true)).await.unwrap().result;
            if let Some(point)=points.into_iter().next(){stored=Some(point);break;}
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(stored.unwrap().payload["timestamp"].kind,Some(value::Kind::IntegerValue(1_700_000_000)));
        let window=service.retrieve_channel_chat_window(&ChatWindowParams{channel_id:"c".into(),from_unix:data.timestamp,to_unix:data.timestamp,limit:20.0}).await;
        assert!(!window.error);assert_eq!(window.items.len(),1);assert_eq!(window.items[0].timestamp,data.timestamp);
        let mut params=SemanticChatContextParams{channel_id:"c".into(),query:"dragon".into(),limit:3,primary_min_score:None,fallback_min_score:None};
        let result=service.retrieve_semantic_chat_context(&params).await;
        assert!(!result.error);assert_eq!(result.selected_pass,SemanticPass::High);assert_eq!(result.items.len(),1);

        // Exact f32 cosine boundaries exercise native response normalization
        // and both source postfilters against a real integer-indexed collection.
        let mut points=vec![];
        for (id,channel,score) in [(101_u64,"boundary69",0.69_f32),(102,"boundary75",0.75_f32),
            (103,"above69",0.70_f32),(104,"above75",0.76_f32)] {
            let mut vector=vec![0.0;1024];vector[0]=score;vector[1]=(1.0-score*score).sqrt();
            points.push(PointStruct::new(id,vector,Payload::try_from(json!({"channel_id":channel,"message":"boundary score message","timestamp":qdrant_number_payload(1_700_000_001.0)})).unwrap()));
        }
        client.upsert_points(UpsertPointsBuilder::new(&names.chat,points).wait(true)).await.unwrap();
        for (channel,threshold,pass) in [("boundary69",0.69,SemanticPass::None),("boundary75",0.75,SemanticPass::Fallback),
            ("above69",0.70,SemanticPass::Fallback),("above75",0.76,SemanticPass::High)] {
            let mut vector=vec![0.0;1024];vector[0]=1.0;
            let response=client.execute(QdrantRequest::Query(QueryPointsBuilder::new(&names.chat).query(vector)
                .filter(Filter::must([Condition::matches("channel_id",MatchValue::Keyword(channel.to_owned()))])).limit(1).with_payload(true).build())).await.unwrap();
            let QdrantResponse::Points(raw)=response else{panic!("points expected")};
            assert_eq!(raw[0]["score"].as_f64(),Some(threshold),"actual fixture cosine boundary");
            // Native scores normalize to the same decimal as REST, and the
            // source postfilter is inclusive when a candidate is supplied.
            assert_eq!(select_semantic_chat_items(channel,&raw,threshold,1).len(),1);
            // Qdrant itself applies a strict > threshold before returning hits.
            // https://github.com/qdrant/qdrant/blob/v1.17.0/lib/segment/src/types.rs
            params.channel_id=channel.into();
            let result=service.retrieve_semantic_chat_context(&params).await;
            assert!(!result.error);assert_eq!(result.selected_pass,pass,"{channel}: {result:?}");
            assert_eq!(result.items.len(),usize::from(pass!=SemanticPass::None));
            assert_eq!(result.pass_results.len(),if pass==SemanticPass::High {1} else {2});
            assert_eq!(result.pass_results[0].raw_matches,usize::from(pass==SemanticPass::High));
            if pass!=SemanticPass::High {
                assert_eq!(result.pass_results[1].raw_matches,usize::from(pass==SemanticPass::Fallback));
            }
        }
        assert_eq!(context.0.lock().unwrap().len(),5);

        let memory=UpsertChannelMemoryParams{qdrant_point_id:42.0,memory_id:"m".into(),channel_id:"c".into(),
            memory_type:Some("channel_lore".into()),status:Some("confirmed".into()),risk:Some("low".into()),confidence:Some(0.8),
            subject_scope:Some("channel".into()),content:"the dragon is our mascot".into(),summary:"dragon mascot".into(),
            created_at_unix:Some(1_700_000_000.0),updated_at_unix:Some(1_700_000_001.0),..Default::default()};
        assert!(!service.upsert_channel_memory_embedding(&memory).await.error);
        let stored=client.get_points(GetPointsBuilder::new(&names.memory,vec![42_u64.into()]).with_payload(true)).await.unwrap().result;
        assert_eq!(stored[0].payload["updated_at"].kind,Some(value::Kind::IntegerValue(1_700_000_001)));
        let result=service.retrieve_channel_memory_context(&RetrieveMemoryContextParams{channel_id:"c".into(),query:"dragon".into(),limit:3,
            min_score:None,mode:MemoryRetrievalMode::Passive,subject_scope:MemorySubjectScope::Channel}).await;
        assert!(!result.error);assert_eq!(result.items.len(),1);assert_eq!(result.items[0].memory_id,"m");
        let mut collision=memory.clone();collision.memory_id="other".into();
        assert!(service.upsert_channel_memory_embedding(&collision).await.error);
        assert!(service.delete_channel_memory_embedding(42.0,"c",Some("other")).await.error);
        assert!(!service.delete_channel_memory_embedding(42.0,"c",Some("m")).await.error);
        assert!(!service.delete_channel_memory_embedding(42.0,"c",Some("m")).await.error);
        assert!(!service.upsert_channel_memory_embedding(&memory).await.error);
        assert!(!service.delete_channel_memory_embeddings_by_channel("other").await.error);
        assert_eq!(client.get_points(GetPointsBuilder::new(&names.memory,vec![42_u64.into()])).await.unwrap().result.len(),1);
        assert!(!service.delete_channel_memory_embeddings_by_channel("c").await.error);
        assert!(client.get_points(GetPointsBuilder::new(&names.memory,vec![42_u64.into()])).await.unwrap().result.is_empty());

        // Exact channel equality must retain a neighboring channel that shares
        // all target words; a full-text match would not provide that isolation.
        let target = "spaced channel";
        let neighbor = "spaced channel neighbor";
        for (point_id, channel_id) in [(501_u64, target), (502, neighbor)] {
            let mut record = memory.clone();
            record.qdrant_point_id = point_id as f64;
            record.memory_id = format!("memory_{point_id}");
            record.channel_id = channel_id.into();
            assert!(!service.upsert_channel_memory_embedding(&record).await.error);
        }
        let memory_params = |channel_id: &str| RetrieveMemoryContextParams {
            channel_id: channel_id.into(), query: "dragon".into(), limit: 3, min_score: None,
            mode: MemoryRetrievalMode::Passive, subject_scope: MemorySubjectScope::Channel,
        };
        let target_memories = service.retrieve_channel_memory_context(&memory_params(target)).await;
        assert!(!target_memories.error);
        assert_eq!(target_memories.items.len(), 1);
        assert_eq!(target_memories.items[0].memory_id, "memory_501");
        assert!(!service.delete_channel_memory_embeddings_by_channel(target).await.error);
        let remaining = client.get_points(GetPointsBuilder::new(&names.memory,
            vec![501_u64.into(), 502_u64.into()])).await.unwrap().result;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, Some(502_u64.into()));
        let empty = service.retrieve_channel_memory_context(&memory_params(target)).await;
        assert!(!empty.error);
        assert!(empty.items.is_empty());
        let neighbor_memories = service.retrieve_channel_memory_context(&memory_params(neighbor)).await;
        assert!(!neighbor_memories.error);
        assert_eq!(neighbor_memories.items.len(), 1);
        assert_eq!(neighbor_memories.items[0].memory_id, "memory_502");
    }).await;
    let mut cleanup_errors = vec![];
    for name in [&names.chat, &names.memory] {
        match client.collection_exists(name.as_str()).await {
            Ok(true) => {
                if let Err(error) = client.delete_collection(name.as_str()).await {
                    cleanup_errors.push(error.to_string());
                }
            }
            Ok(false) => {}
            Err(error) => cleanup_errors.push(error.to_string()),
        }
    }
    assert!(
        cleanup_errors.is_empty(),
        "fixture cleanup: {cleanup_errors:?}"
    );
    outcome.expect("fixture scenario failed");
}
