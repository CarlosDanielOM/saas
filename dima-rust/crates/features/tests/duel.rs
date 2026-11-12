//! The duel against the recording of the reference (`duel_reference.json`, made by
//! `duel_record.mts`): 66 steps (settings and every validation, challenges, accept, decline,
//! expiry, narration, the winner announcement, the loser's timeout, moderators demoted and
//! restored, failing timeouts and re-mods, the switch turned off mid-way, editors, unknown
//! users, a failing chat, fights against the streamer, the leaderboard), each compared by its
//! answer, every call to Twitch's wrappers and to chat in order, and every stored document
//! (typed BSON); then the production copy's leaderboards over its 663 results.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "duel_support/mod.rs"]
mod duel_support;
#[path = "roulette_support/mod.rs"]
mod support;

use std::sync::Arc;

use anyhow::Result;
use bson::Bson;
use dima_core::ManualClock;
use dima_features::duel::DuelCompletion;
use duel_support::{Fakes, failure};
use serde_json::{Value, json};
use support::{StreamRandom, documents, from_ejson, numbers_as_doubles, with_database};

fn recorded() -> Value {
    support::reference(include_str!("duel_reference.json"))
}

#[tokio::test]
async fn every_recorded_step_gives_the_same_answer_calls_and_documents() -> Result<()> {
    let reference = recorded();
    with_database(|mongo, _| async move {
        for seed in reference["seeds"].as_array().unwrap() {
            let Bson::Document(seed) = from_ejson(seed)? else { anyhow::bail!("seed") };
            mongo.documents("users").insert_one(seed).await?;
        }
        let clock = ManualClock::new(0);
        let fakes = Fakes::new(mongo.clone());
        let service = fakes.service(&mongo, &clock, Arc::new(StreamRandom::new("dima-duel-stream")));
        let completion = DuelCompletion::new(service.clone(), fakes.chat.clone(), fakes.moderation.clone());
        let mut compared = 0;
        for step in reference["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            clock.set(step["now"].as_i64().unwrap());
            if name == "challenge-overlay" {
                // The recorder gave the channel an overlay token between steps.
                let hash = dima_features::duel::token_hash(&"a".repeat(43));
                mongo.documents("duel_widgets").update_one(bson::doc! {"_id": "3001"}, bson::doc! {"$set": {"tokenHash": hash}}).await?;
            }
            fakes.prepare(&step["script"]);
            let call = &step["call"];
            let channel = call["channel"].as_str().unwrap_or("3001");
            let s = |key: &str| call[key].as_str().unwrap().to_owned();
            let result = match call["kind"].as_str().unwrap() {
                "snapshot" => service.snapshot(channel).await,
                "configure" => service.configure(channel, &call["input"], call["revision"].as_f64().unwrap(), &s("key")).await.map(|()| Value::Null),
                "challenge" => service.challenge(channel, &s("challenger"), &s("opponent"), call["enraged"].as_str()).await.map(|(overlay, language)| json!({"overlay": overlay, "language": language})),
                "accept" => service.accept(channel, &s("opponent")).await.map(|run| serde_json::to_value(run).unwrap()),
                "decline" => service.decline(channel, &s("opponent")).await.map(|(challenger, overlay, language)| json!({"challenger": challenger, "overlay": overlay, "language": language})),
                "fight" => service.fight_streamer(channel, &s("challenger"), &s("streamer")).await.map(|run| serde_json::to_value(run).unwrap()),
                "tick" => completion.tick().await.map(|_| Value::Null),
                "leaderboard" => service.stats().leaderboard(channel).await.map(|b| b.to_json()),
                "h2h" => service.stats().head_to_head(channel, &s("left"), &s("right")).await.map(|r| json!(r)),
                other => anyhow::bail!("unknown call {other}"),
            };
            let result = match result {
                Ok(value) => json!({"ok": value}),
                Err(error) => failure(error),
            };
            assert_eq!(numbers_as_doubles(&result), numbers_as_doubles(&step["result"]), "{name}: answer");
            assert_eq!(numbers_as_doubles(&Value::from(fakes.take_calls())), numbers_as_doubles(&step["calls"]), "{name}: calls to Twitch and chat");
            assert_eq!(Value::from(fakes.mods()), step["mods"], "{name}: moderators on the fake Twitch");
            for collection in ["duel_widgets", "duel_results", "duel_moderator_restores"] {
                assert_eq!(Value::from(documents(&mongo, collection).await?), step["documents"][collection], "{name}: {collection}");
            }
            compared += 1;
        }
        assert_eq!(compared, 66);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn production_leaderboards_match_the_reference() -> Result<()> {
    let reference = recorded();
    let Some(mongo) = support::production().await? else {
        return Ok(());
    };
    let fakes = Fakes::new(mongo.clone());
    let service = fakes.service(
        &mongo,
        &ManualClock::new(0),
        Arc::new(StreamRandom::new("unused")),
    );
    let mut total = 0.0;
    let real = reference["real"].as_array().unwrap();
    assert_eq!(real.len(), 7);
    for case in real {
        let board = service
            .stats()
            .leaderboard(case["channel"].as_str().unwrap())
            .await?;
        total += board.duels;
        let players: Vec<Value> = board
            .players
            .iter()
            .map(|p| json!({"login": dima_core::crypto::sha256(&p.login).hex(), "kills": p.kills, "deaths": p.deaths, "kd": p.kd}))
            .collect();
        let actual = json!({"channel": case["channel"], "ranked": board.ranked, "duels": board.duels, "players": players});
        assert_eq!(numbers_as_doubles(&actual), numbers_as_doubles(case));
    }
    assert_eq!(total, 663.0, "every production result counted");
    Ok(())
}
