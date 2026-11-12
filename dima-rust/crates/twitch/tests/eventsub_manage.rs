//! Part 2 against the recording of the TypeScript (`tests/eventsub/part2.json`): every scenario
//! of `subscribeTwitchEvent`, `getEventsubs`, `unsubscribeTwitchEvent` and
//! `migrateLegacyBitsEventsubs` replayed: the same Helix requests (method, target, the headers
//! that matter, the body bytes), the same return value and the same `eventsubs` documents
//! afterwards (typed extended JSON, natural order). The differences on purpose are listed in
//! [`expectation`] with their reason.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
#[path = "eventsub/replay.rs"]
mod replay;
mod support;

use anyhow::{Context, Result};
use bson::Bson;
use dima_twitch::eventsub::{
    Condition, EventsubManager, Failure, ListError, Setting, Settings, SubscribeRequest,
};
use replay::*;
use serde_json::{Value, json};
use support::with_stores;

/// What Rust does where it does not do what the reference does.
enum Expect {
    /// The same requests, result and documents.
    Same,
    /// The reference throws; Rust returns this error (requests and documents the same).
    Error(fn(&Value) -> bool, &'static str),
    /// A difference on purpose, checked by its own assertion.
    Differs(&'static str),
}

fn expectation(name: &str) -> Expect {
    match name {
        "server-error-503-not-json" => Expect::Error(
            |v| v["status"] == 503 && v["failure"] == "Twitch",
            "the reference throws on an answer that is not JSON; Rust reports Twitch's refusal",
        ),
        "unsubscribe-502-not-json" => Expect::Error(
            |v| v["status"] == 502 && v["failure"] == "Twitch",
            "the reference throws on an answer that is not JSON; Rust reports Twitch's refusal",
        ),
        "list-page-two-not-json" => Expect::Error(
            |v| v["list"] == "Malformed",
            "the reference throws on a page that is not JSON; Rust reports the listing incomplete",
        ),
        "list-page-two-null" => Expect::Differs(
            "the reference counts a `null` page as the last one and returns a complete listing of \
             page one; Rust reports the listing incomplete (nothing may be deleted on it)",
        ),
        "unsubscribe-reserved-characters" => Expect::Differs(
            "the reference concatenates the id into the query; Rust encodes it (the same bytes \
             for every id Twitch issues)",
        ),
        _ => Expect::Same,
    }
}

fn settings(config: &Value) -> Result<Option<Settings>> {
    let Some(map) = config.as_object() else {
        return Ok(None);
    };
    let mut settings = Settings::new();
    for (key, value) in map {
        let setting = Setting::from_path(key).with_context(|| format!("setting {key}"))?;
        settings.set(setting, Bson::try_from(value.clone())?);
    }
    Ok(Some(settings))
}

fn failure_name(failure: Failure) -> &'static str {
    match failure {
        Failure::NotSent => "NotSent",
        Failure::Twitch => "Twitch",
        Failure::Unknown => "Unknown",
        Failure::Store => "Store",
    }
}

fn list_error_name(error: &ListError) -> &'static str {
    match error {
        ListError::AppCredentials => "AppCredentials",
        ListError::Twitch { .. } => "Twitch",
        ListError::PageLimit => "PageLimit",
        ListError::RepeatedCursor => "RepeatedCursor",
        ListError::Malformed { .. } => "Malformed",
        ListError::Request(_) => "Request",
    }
}

/// The call of a scenario: `(the reference-shaped result, Rust's own detail)`.
async fn call(manager: &EventsubManager, call: &Value) -> Result<(Value, Value)> {
    let text = |key: &str| call[key].as_str().unwrap_or_default().to_owned();
    Ok(match call["fn"].as_str().context("fn")? {
        "subscribe" => {
            let condition = Condition::from_value(&call["condition"]);
            let settings = settings(&call["config"])?;
            let (channel, kind, version) = (text("channel"), text("type"), text("version"));
            let mut request = SubscribeRequest::new(&channel, &kind, &version, &condition);
            if let Some(settings) = &settings {
                request = request.settings(settings);
            }
            if call["ignoreExisting"] == true {
                request = request.ignore_existing();
            }
            if call["appAuthOnly"] == true {
                request = request.app_auth_only();
            }
            match manager.subscribe(&request).await {
                Ok(record) => (record.to_json(), json!({})),
                Err(error) => (
                    error.to_json(),
                    json!({"status": error.status, "failure": failure_name(error.failure), "conflict": error.is_conflict(), "reset": error.rate_limit_reset}),
                ),
            }
        }
        "list" => match manager.list(call["userId"].as_str()).await {
            Ok(list) => (list.to_json(), json!({"pages": list.pages})),
            Err(error) => (error.to_json(), json!({"list": list_error_name(&error)})),
        },
        "unsubscribe" => match manager.unsubscribe(&text("id")).await {
            Ok(done) => (
                json!({"response": done.status}),
                json!({"deleted": done.local_deleted}),
            ),
            Err(error) => (
                error.to_json(),
                json!({"status": error.status, "failure": failure_name(error.failure)}),
            ),
        },
        "migrate" => {
            let result = manager.migrate_legacy_bits(&text("channel")).await?;
            (result.to_json(), json!({}))
        }
        other => panic!("unknown call {other}"),
    })
}

async fn run(scenario: Value) -> Result<()> {
    let name = scenario["name"].as_str().context("name")?.to_owned();
    with_stores(|stores| async move {
        let now = scenario["now"].as_i64().context("now")?;
        create_indexes(&stores).await?;
        seed_channels(&stores, &scenario["channels"], now).await?;
        seed_documents(&stores, "eventsubs", &scenario["before"]).await?;
        let exchanges = scenario["exchanges"]
            .as_array()
            .context("exchanges")?
            .clone();
        let answers = exchanges.iter().map(|e| answer(&e["response"])).collect();
        let env = &scenario["env"];
        let server = replay_twitch(answers, !env["appToken"].is_null()).await?;
        let client_id = env["clientId"].as_str().unwrap_or_default();
        let process = process(&stores, &server, client_id, now)?;
        process.twitch.load_streamers().await?;
        let manager = manager(&process, env["secret"].as_str())?;
        let (mut result, detail) = call(&manager, &scenario["call"]).await?;

        let sent = helix_requests(&server);
        let expected: Vec<Value> = exchanges.iter().map(recorded_shape).collect();
        let got: Vec<Value> = sent.iter().map(shape).collect();
        let known = object_ids(&scenario["before"]);
        let mut recorded_result = scenario["result"].clone();
        normalize(&mut recorded_result, &known);
        normalize(&mut result, &known);
        let mut recorded_documents = scenario["documents"].clone();
        normalize(&mut recorded_documents, &known);
        let mut stored = Value::Array(documents(&stores, "eventsubs").await?);
        normalize(&mut stored, &known);

        match expectation(&name) {
            Expect::Same => {
                assert_eq!(got, expected, "{name}: requests");
                assert_same_bodies(&name, &exchanges, &sent);
                assert!(scenario["threw"].is_null(), "{name}: the reference threw");
                assert_eq!(
                    dima_text::to_js_json(&result),
                    dima_text::to_js_json(&recorded_result),
                    "{name}: result"
                );
            }
            Expect::Error(check, why) => {
                assert_eq!(got, expected, "{name}: requests");
                assert!(!scenario["threw"].is_null(), "{name}: {why}");
                assert!(check(&detail), "{name}: {why}: {detail} {result}");
            }
            Expect::Differs(why) => match name.as_str() {
                "list-page-two-null" => {
                    assert_eq!(got, expected, "{name}: requests");
                    assert_eq!(detail["list"], "Malformed", "{name}: {why}");
                    assert_eq!(recorded_result["complete"], true);
                }
                "unsubscribe-reserved-characters" => {
                    assert_eq!(
                        expected[0]["target"],
                        "/helix/eventsub/subscriptions?id=a%20b&c=d"
                    );
                    assert_eq!(
                        got[0]["target"], "/helix/eventsub/subscriptions?id=a+b%26c%3Dd",
                        "{why}"
                    );
                    assert_eq!(result, recorded_result);
                }
                other => panic!("no check for {other}"),
            },
        }
        assert_eq!(stored, recorded_documents, "{name}: documents");
        if name == "rate-limited-429" {
            assert_eq!(detail["reset"], 1_794_355_260, "{name}: Ratelimit-Reset");
        }
        if name == "conflict-409" {
            assert_eq!(detail["conflict"], true);
        }
        Ok(())
    })
    .await
}

async fn run_all(function: &str) -> Result<()> {
    let recording = load("part2.json")?;
    assert_sources_unchanged(&recording)?;
    let mut count = 0;
    for scenario in recording["scenarios"].as_array().context("scenarios")? {
        if scenario["call"]["fn"] == function {
            run(scenario.clone()).await?;
            count += 1;
        }
    }
    assert!(count > 0, "no {function} scenario recorded");
    Ok(())
}

#[tokio::test]
async fn subscribe_matches_the_reference() -> Result<()> {
    run_all("subscribe").await
}

#[tokio::test]
async fn list_matches_the_reference() -> Result<()> {
    run_all("list").await
}

#[tokio::test]
async fn unsubscribe_matches_the_reference() -> Result<()> {
    run_all("unsubscribe").await
}

#[tokio::test]
async fn bits_migration_matches_the_reference() -> Result<()> {
    run_all("migrate").await
}
