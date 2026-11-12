use dima_ai::qdrant::*;
use dima_http::{HttpClient, Method, Path};
use serde_json::{Value, json};

#[tokio::test]
async fn isolated_store_retrieve_sync_roundtrip() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("DIMA_TEST_QDRANT_URL") else {
        anyhow::ensure!(
            std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() != Ok("1"),
            "Qdrant URL required"
        );
        return Ok(());
    };
    let mut config = Config::new(url);
    config.api_key = std::env::var("DIMA_TEST_QDRANT_API_KEY")
        .ok()
        .map(dima_core::SecretString::new);
    let provider = config.provider()?;
    let http = HttpClient::builder().build()?;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let chat = format!("dima_test_ai_chat_{suffix}");
    let memory = format!("dima_test_ai_memory_{suffix}");
    let mut owned = vec![];
    let mut c = Client::new(http.clone(), Some(provider.clone()));
    c.chat_collection = chat.clone();
    c.memory_collection = memory.clone();
    let result = async {
        for name in [&chat, &memory] {
            http.request(
                &provider,
                Method::PUT,
                Path::template("/collections/{}", &[name])?,
            )
            .json(&json!({"vectors":{"size":3,"distance":"Cosine"}}))
            .send_json::<Value>()
            .await?;
            owned.push(name.clone());
        }
        let d = ChatMessageData {
            channel_id: "c".into(),
            channel_name: None,
            username: "user".into(),
            user_id: "u".into(),
            message: "hello 😀 עולם".into(),
            timestamp: 12.,
            language: "en".into(),
        };
        anyhow::ensure!(
            !c.store_chat_message_embedding(&d, &[1., 0., 0.])
                .await
                .error,
            "store failed"
        );
        // Wait=false in reference: poll boundedly for visibility, never change the write request.
        let mut found = false;
        for _ in 0..20 {
            let w = c
                .retrieve_channel_chat_window(&ChatWindowParams {
                    channel_id: "c".into(),
                    from_unix: 1.,
                    to_unix: 20.,
                    limit: 10.,
                })
                .await;
            anyhow::ensure!(!w.error, "window failed");
            if w.items.len() == 1 {
                found = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        anyhow::ensure!(found, "chat not visible");
        let s = c
            .retrieve_semantic_chat_context(
                &SemanticChatContextParams {
                    channel_id: "c".into(),
                    query: "hello".into(),
                    limit: 3,
                    primary_min_score: None,
                    fallback_min_score: None,
                },
                &[1., 0., 0.],
            )
            .await;
        anyhow::ensure!(!s.error && s.items.len() == 1, "semantic roundtrip failed");
        let mut p = UpsertChannelMemoryParams {
            qdrant_point_id: 42.,
            memory_id: "m".into(),
            channel_id: "c".into(),
            content: "dragon lore 😀".into(),
            summary: "dragon lore".into(),
            status: Some("confirmed".into()),
            subject_scope: Some("channel".into()),
            ..Default::default()
        };
        anyhow::ensure!(
            !c.upsert_channel_memory_embedding(&p, &[1., 0., 0.])
                .await
                .error,
            "memory store failed"
        );
        p.summary = "updated dragon lore".into();
        anyhow::ensure!(
            !c.upsert_channel_memory_embedding(&p, &[1., 0., 0.])
                .await
                .error,
            "memory update failed"
        );
        p.memory_id = "other".into();
        anyhow::ensure!(
            c.upsert_channel_memory_embedding(&p, &[1., 0., 0.])
                .await
                .error,
            "collision overwritten"
        );
        anyhow::ensure!(
            c.delete_channel_memory_embedding(42., "c", Some("other"))
                .await
                .error,
            "collision deleted"
        );
        let params = RetrieveMemoryContextParams {
            channel_id: "c".into(),
            query: "dragon".into(),
            limit: 3,
            min_score: None,
            mode: MemoryRetrievalMode::Passive,
            subject_scope: MemorySubjectScope::Channel,
        };
        let m = c
            .retrieve_channel_memory_context(&params, &[1., 0., 0.])
            .await;
        anyhow::ensure!(
            !m.error && m.items.len() == 1 && m.items[0].summary == p.summary,
            "memory retrieval failed"
        );
        anyhow::ensure!(
            !c.delete_channel_memory_embedding(42., "c", Some("m"))
                .await
                .error,
            "delete failed"
        );
        anyhow::ensure!(
            !c.delete_channel_memory_embedding(42., "c", Some("m"))
                .await
                .error,
            "idempotent delete failed"
        );
        p.memory_id = "m".into();
        anyhow::ensure!(
            !c.upsert_channel_memory_embedding(&p, &[1., 0., 0.])
                .await
                .error,
            "restore failed"
        );
        anyhow::ensure!(
            !c.delete_channel_memory_embeddings_by_channel("c")
                .await
                .error,
            "channel delete failed"
        );
        let m = c
            .retrieve_channel_memory_context(&params, &[1., 0., 0.])
            .await;
        anyhow::ensure!(
            !m.error && m.items.is_empty(),
            "channel deletion left memory"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let mut cleanup = Ok(());
    for name in owned {
        let response = http
            .request(
                &provider,
                Method::DELETE,
                Path::template("/collections/{}", &[&name])?,
            )
            .send_json::<Value>()
            .await;
        if let Err(e) = response {
            cleanup = Err(anyhow::Error::from(e));
        }
    }
    cleanup?;
    result
}
