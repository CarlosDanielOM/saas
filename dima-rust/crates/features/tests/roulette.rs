//! The roulette against the recording of the reference (`roulette_reference.json`, made by
//! `roulette_record.mts`): 100 steps (create and edit with every validation, actions that do not
//! parse, imports, idempotency, revisions, spins, completion and hiding, winner actions claimed
//! and run, a spin whose winner was removed meanwhile, 30 draws on weighted odds), each compared
//! by its answer, the random bytes it consumed and every stored document (typed BSON); the
//! native completion worker's document; and the production copy's documents, which must read
//! and write back unchanged.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "roulette_support/mod.rs"]
mod support;

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use bson::Bson;
use dima_core::{ManualClock, Random};
use dima_engine::syntax::SyntaxEngine;
use dima_features::roulette::{
    Action, DrawActor, Operation, RouletteConfig, RouletteService, ServiceError, State,
    WinnerAction, WinnerActionRunner,
};
use serde_json::{Value, json};
use support::{StreamRandom, documents, from_ejson, numbers_as_doubles, with_database};

fn recorded() -> Value {
    support::reference(include_str!("roulette_reference.json"))
}

/// Counts the bytes drawn, to compare with the reference's consumption per step.
#[derive(Debug)]
struct Counting(StreamRandom, Mutex<usize>);

impl Random for Counting {
    fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
        *self.1.lock().unwrap() += buf.len();
        self.0.fill(buf)
    }
}

pub fn service(
    mongo: &dima_store::mongo::MongoStore,
    clock: &ManualClock,
    random: Arc<dyn Random>,
) -> RouletteService {
    RouletteService::new(
        mongo.clone(),
        Arc::new(clock.clone()),
        random,
        Arc::new(SyntaxEngine::default()),
        RouletteConfig {
            deadline: std::time::Duration::from_secs(60),
            action_deadline: std::time::Duration::from_secs(60),
        },
    )
}

fn action(value: &Value) -> Action {
    Action {
        operation: Operation::parse(value["operation"].as_str().unwrap()).unwrap(),
        roulette: value["roulette"].as_str().map(str::to_owned),
        item_id: value["itemId"].as_str().map(str::to_owned),
        data: value["data"].as_object().cloned(),
    }
}

fn actor(value: &Value) -> Option<DrawActor> {
    value.as_object()?;
    Some(DrawActor {
        user_id: value["userId"].as_str().unwrap().to_owned(),
        user_login: value["userLogin"].as_str().unwrap().to_owned(),
        user_display_name: value["userDisplayName"].as_str().unwrap().to_owned(),
        argument: value["argument"].as_str().map(str::to_owned),
    })
}

fn failure(error: ServiceError) -> Value {
    match error {
        ServiceError::Refused(e) => {
            json!({"error": {"code": e.code, "message": e.message, "status": e.status, "row": e.row}})
        }
        ServiceError::Store { message, .. } => json!({"thrown": message}),
    }
}

/// Records each job it runs; fails every job when asked.
struct Recorder {
    fail: bool,
    ran: Mutex<Vec<Value>>,
}

impl WinnerActionRunner for Recorder {
    fn run<'a>(
        &'a self,
        channel: &'a str,
        job: &'a WinnerAction,
    ) -> dima_http::guard::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.fail {
                return Err("boom".into());
            }
            let job = support::ejson(job_bson(job)).clone();
            self.ran
                .lock()
                .unwrap()
                .push(json!({"channel": channel, "job": relaxed(&job)}));
            Ok(())
        })
    }
}

fn job_bson(job: &WinnerAction) -> Bson {
    let mut entry = bson::doc! {
        "drawId": &job.draw_id, "rouletteId": &job.roulette_id, "itemId": &job.item_id, "label": &job.label,
        "source": &job.source, "dueAt": job.due_at, "status": &job.status,
    };
    if let Some(actor) = &job.actor {
        entry.insert("actor", actor.clone());
    }
    if let Some(at) = job.started_at {
        entry.insert("startedAt", at);
    }
    Bson::Document(entry)
}

/// Canonical extended JSON to plain JSON numbers.
fn relaxed(value: &Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 => {
            let (key, inner) = map.iter().next().unwrap();
            match key.as_str() {
                "$numberInt" | "$numberLong" | "$numberDouble" => {
                    json!(inner.as_str().unwrap().parse::<f64>().unwrap())
                }
                _ => Value::Object(map.iter().map(|(k, v)| (k.clone(), relaxed(v))).collect()),
            }
        }
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), relaxed(v))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(relaxed).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn every_recorded_step_gives_the_same_answer_draws_and_documents() -> Result<()> {
    let reference = recorded();
    with_database(|mongo, _| async move {
        let clock = ManualClock::new(0);
        let random = Arc::new(Counting(
            StreamRandom::new("dima-roulette-stream"),
            Mutex::new(0),
        ));
        let roulette = service(&mongo, &clock, random.clone());
        let mut compared = 0;
        for step in reference["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            let call = &step["call"];
            clock.set(step["now"].as_i64().unwrap());
            let before = *random.1.lock().unwrap();
            let channel = call["channel"].as_str().unwrap_or("1001");
            let result = match call["kind"].as_str().unwrap() {
                "execute" => roulette
                    .execute(
                        channel,
                        &action(&call["action"]),
                        call["key"].as_str(),
                        call["revision"].as_f64(),
                        actor(&call["actor"]).as_ref(),
                    )
                    .await
                    .map(|e| e.to_json()),
                "snapshot" => roulette.snapshot(channel).await.map(|s| s.to_json()),
                "overlay" => roulette.overlay_snapshot(channel).await,
                "run_actions" => {
                    let fail = call["fail"].as_bool().unwrap();
                    let runner = Recorder {
                        fail,
                        ran: Mutex::new(Vec::new()),
                    };
                    roulette.run_due_actions(&runner).await.map(|_| {
                        let ran = runner.ran.into_inner().unwrap();
                        match name {
                            "run-actions" => Value::from(ran),
                            "run-actions-again" => Value::from(ran.len()),
                            _ => Value::Null,
                        }
                    })
                }
                other => anyhow::bail!("unknown call {other}"),
            };
            let result = match result {
                Ok(value) => json!({"ok": value}),
                Err(error) => failure(error),
            };
            assert_eq!(
                numbers_as_doubles(&result),
                numbers_as_doubles(&step["result"]),
                "{name}: answer"
            );
            assert_eq!(
                Value::from(*random.1.lock().unwrap() - before),
                step["bytes"],
                "{name}: random bytes drawn"
            );
            let stored = documents(&mongo, "roulette_channels").await?;
            assert_eq!(Value::from(stored), step["documents"], "{name}: documents");
            compared += 1;
        }
        assert_eq!(compared, 100);
        Ok(())
    })
    .await
}

/// The native worker (`roulette_completion`, old crate, run unchanged by the recorder) and this
/// port's snapshot complete the same seeded draw into the same document.
#[tokio::test]
async fn completion_matches_the_native_worker_and_the_reference() -> Result<()> {
    let reference = recorded();
    with_database(|mongo, _| async move {
        let collection = mongo.documents("roulette_channels");
        for seeded in reference["native"]["seeded"].as_array().unwrap() {
            let Bson::Document(seeded) = from_ejson(seeded)? else {
                anyhow::bail!("seed")
            };
            collection.insert_one(seeded).await?;
        }
        let clock = ManualClock::new(1_794_355_200_000 + 3_600_000);
        let roulette = service(&mongo, &clock, Arc::new(StreamRandom::new("unused")));
        for channel in ["2001", "2002"] {
            roulette.snapshot(channel).await?;
        }
        let after = documents(&mongo, "roulette_channels").await?;
        // 2001 was settled by the native worker, 2002 by the reference's snapshot.
        assert_eq!(Value::from(after), reference["native"]["after"]);
        Ok(())
    })
    .await
}

/// Every production document reads into the typed state and writes back exactly as stored
/// (key order and BSON number types), so a write by this port leaves untouched roulettes as
/// they were.
#[tokio::test]
async fn production_states_round_trip() -> Result<()> {
    let Some(mongo) = support::production().await? else {
        return Ok(());
    };
    let rows = documents(&mongo, "roulette_channels").await?;
    assert!(!rows.is_empty(), "the production copy has roulettes");
    for row in &rows {
        let Bson::Document(document) = from_ejson(row)? else {
            anyhow::bail!("doc")
        };
        let stored = document.get("state").context("state")?.clone();
        let state = State::from_bson(&stored)
            .with_context(|| document.get_str("_id").unwrap_or("?").to_owned())?;
        let written = Bson::Document(state.to_bson()?);
        assert_eq!(
            support::ejson(written),
            support::ejson(stored),
            "{}",
            document.get_str("_id").unwrap_or("?")
        );
    }
    Ok(())
}
