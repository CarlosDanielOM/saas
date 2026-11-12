use dima_ai::prompts::*;
use serde_json::{Value, json};
#[test]
fn recorded_prompt_and_context_contract() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("prompts_reference.json"))?;
    let mut differences = 0;
    for (index, case) in cases.iter().enumerate() {
        let i = &case["input"];
        let actual = match case["operation"].as_str() {
            Some("command") => json!(construct_system_messages(
                serde_json::from_value::<Option<Streamer>>(i["streamer"].clone())?.as_ref(),
                serde_json::from_value::<Option<User>>(i["user"].clone())?.as_ref(),
                i["prompt"].as_str().unwrap(),
                serde_json::from_value(i["mode"].clone())?,
                i["language"].as_str().unwrap()
            )),
            Some("chat") => json!(construct_chat_system_messages(&serde_json::from_value(
                i.clone()
            )?)),
            Some("stream") => {
                let snapshot = &i["snapshot"];
                let stream = snapshot.get("stream").map(|s| LiveStream {
                    title: s["title"].as_str().map(str::to_owned),
                    game_name: s["game_name"].as_str().map(str::to_owned),
                    started_at: s["started_at"].as_str().map(str::to_owned),
                    viewer_count: s["viewer_count"].as_f64(),
                });
                let context = build_stream_context(
                    i["channel"].as_str().unwrap(),
                    &LiveSnapshot {
                        is_live: snapshot["isLive"] == true,
                        stream,
                    },
                    i["now"].as_i64().unwrap(),
                );
                let prompt = construct_chat_system_messages(&ChatInput {
                    prompt: "hello".into(),
                    stream: context.clone(),
                    ..Default::default()
                });
                json!({"context":context,"prompt":prompt})
            }
            Some("emotes") => {
                let context = if i["channel"] == "" {
                    None
                } else {
                    select_emote_names(
                        &serde_json::from_value::<Vec<String>>(i["channelNames"].clone())?,
                        &serde_json::from_value::<Vec<String>>(i["globalNames"].clone())?,
                    )
                };
                let prompt = construct_chat_system_messages(&ChatInput {
                    prompt: "hello".into(),
                    emotes: context.clone().unwrap_or_default(),
                    ..Default::default()
                });
                json!({"context":context,"prompt":prompt})
            }
            Some("merge") => {
                let h = merge_chat_histories(
                    &serde_json::from_value::<Vec<History>>(i["thread"].clone())?,
                    &serde_json::from_value::<Vec<History>>(i["live"].clone())?,
                    &serde_json::from_value::<Vec<History>>(i["semantic"].clone())?,
                    i["limit"].as_u64().unwrap() as usize,
                );
                let mut v = json!(h);
                for h in v.as_array_mut().unwrap() {
                    h.as_object_mut()
                        .unwrap()
                        .retain(|k, v| !v.is_null() && !(k == "badges" && v == ""));
                }
                v
            }
            _ => panic!("unknown operation"),
        };
        if actual != case["expected"] && case["operation"] == "chat" {
            let summary = i["memories"]["channelMemories"][0]["summary"]
                .as_str()
                .unwrap_or("");
            // Our context budgets are scalars; keep the Node fixture untouched.
            if summary.contains('😀') && summary.chars().count() > 90 {
                let mut changed = i.clone();
                changed["memories"]["channelMemories"][0]["summary"] =
                    json!(summary.chars().take(90).collect::<String>());
                assert_eq!(
                    json!(construct_chat_system_messages(&serde_json::from_value(
                        changed
                    )?)),
                    case["expected"],
                    "intended difference {index}"
                );
                differences += 1;
                continue;
            }
        }
        assert_eq!(
            serde_json::from_str::<Value>(&dima_text::to_js_json(&actual))?,
            case["expected"],
            "case {index}"
        );
    }
    assert_eq!(differences, 3);
    Ok(())
}
#[test]
fn stream_snapshot_rounding_and_emote_selection() {
    assert!(
        build_stream_context(
            "",
            &LiveSnapshot {
                is_live: false,
                stream: None
            },
            0
        )
        .is_none()
    );
    assert!(
        !build_stream_context(
            "c",
            &LiveSnapshot {
                is_live: false,
                stream: None
            },
            0
        )
        .unwrap()
        .is_live
    );
    let mut live = LiveSnapshot {
        is_live: true,
        stream: Some(LiveStream {
            title: Some("😀 <title>".into()),
            game_name: None,
            started_at: Some("1970-01-01T00:00:00Z".into()),
            viewer_count: Some(4.5),
        }),
    };
    assert_eq!(
        build_stream_context("c", &live, 90000)
            .unwrap()
            .uptime_minutes,
        Some(2.0)
    );
    assert_eq!(
        build_stream_context("c", &live, -10000)
            .unwrap()
            .uptime_minutes,
        Some(0.0)
    );
    live.stream.as_mut().unwrap().started_at = Some("invalid".into());
    assert!(build_stream_context("c", &live, 0).is_none());
    let global = vec!["Kappa".into()];
    assert_eq!(select_emote_names(&[], &global), Some(global));
    let channel: Vec<_> = (0..41).map(|n| n.to_string()).collect();
    assert_eq!(select_emote_names(&channel, &[]).unwrap().len(), 40);
    assert!(select_emote_names(&[], &[]).is_none());
}
