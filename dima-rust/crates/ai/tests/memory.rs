use dima_ai::memory::*;
use serde_json::{Value, json};
#[test]
fn recorded_memory_rules() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("memory_reference.json"))?;
    let mut scalar_differences = 0;
    for (index, c) in cases.iter().enumerate() {
        let i = &c["input"];
        let actual = match c["operation"].as_str().unwrap() {
            "extract" => json!(extract_memory_candidate(
                &serde_json::from_value(i.clone())?,
                123.0
            )),
            "policy" => json!(get_memory_policy_violation(
                serde_json::from_value(i["type"].clone())?,
                serde_json::from_value(i["risk"].clone())?,
                serde_json::from_value(i["scope"].clone())?,
                &serde_json::from_value(i["policy"].clone())?
            )),
            "subject" => match resolve_chat_memory_subject(
                serde_json::from_value(i["type"].clone())?,
                i["requestedUsername"].as_str().unwrap(),
                i["triggeringUsername"].as_str().unwrap(),
                i["triggeringUserID"].as_str().unwrap(),
            ) {
                Ok(s) => json!({"subject":s}),
                Err(e) => json!({"error":e}),
            },
            "relevance" => json!(is_passive_memory_relevant(
                i["query"].as_str().unwrap(),
                i["summary"].as_str().unwrap(),
                i["score"].as_f64().unwrap()
            )),
            _ => panic!("operation"),
        };
        if i["message"] == "😀😀😀😀 i love" {
            assert!(actual.is_null());
            assert!(!c["expected"].is_null());
            scalar_differences += 1;
            continue;
        }
        assert_eq!(
            dima_text::to_js_json(&actual),
            dima_text::to_js_json(&c["expected"]),
            "case {index}"
        );
    }
    assert_eq!(scalar_differences, 3);
    Ok(())
}
#[test]
fn memory_time_floors_and_prefers_created_at() {
    assert_eq!(memory_unix_seconds(Some(1234567890), 0), 1234567);
    assert_eq!(memory_unix_seconds(None, 1234567890), 1234567);
    assert_eq!(memory_unix_seconds(Some(-1), 999), -1);
}
#[test]
fn policy_filters_expiry_channel_status_and_preserves_candidate_order() -> anyhow::Result<()> {
    let record = |id: &str, channel: &str, status: &str, expiry: Option<i64>| ValidationRecord {
        memory_id: id.into(),
        channel_id: channel.into(),
        status: status.into(),
        kind: MemoryType::ChannelLore,
        risk: Risk::Low,
        subject_scope: Scope::Channel,
        subject_username: None,
        summary: id.into(),
        expires_at: expiry,
    };
    let records = vec![
        record("ok", "c", "confirmed", None),
        record("pending", "c", "pending", None),
        record("other", "other", "confirmed", None),
        record("expired", "c", "confirmed", Some(100)),
    ];
    let candidates = records
        .iter()
        .rev()
        .map(|r| ScoredMemory {
            memory_id: r.memory_id.clone(),
            score: 0.75,
        })
        .collect::<Vec<_>>();
    let policy = Policy {
        allow_sensitive_memories: true,
        allow_user_preference_memories: true,
        allow_running_jokes: true,
    };
    let out = select_validated_channel_memories("c", &candidates, &records, &policy, 10, 100);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].memory_id, "ok");
    assert!(
        select_validated_channel_memories("c", &candidates, &records, &policy, 0, 100).is_empty()
    );
    assert_eq!(
        select_validated_recall_memories("c", &records, &policy, 10, 100).len(),
        1
    );
    Ok(())
}
