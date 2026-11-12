//! The usage page's reads over the local production copy (`domdimabot`, read only), compared
//! with the TypeScript's answers recorded by `usage_recorded/record-real.mts` for every
//! channel and customer of `ai_usage_ledger_states` (the fixture holds ids, figures and the
//! SHA-256 of each answer's JSON text). Every stored document of the four ledger collections
//! decodes: the model crate's real-data scan proves it for all of them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

use anyhow::{Context, Result};
use bson::doc;
use bson::oid::ObjectId;
use dima_billing::usage_ledger::dashboard::DashboardInput;
use dima_billing::usage_ledger::dashboard::dashboard_request;
use dima_billing::usage_ledger::query::TransactionFilters;
use dima_billing::usage_ledger::report::{WindowInput, resolve_window};
use dima_billing::usage_ledger::{Ledger, LedgerConfig, NoBoundary};
use dima_core::{ManualClock, SeededRandom};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use usage_support::support;

fn sha(value: &Value) -> String {
    hex::encode(Sha256::digest(dima_text::to_js_json(value).as_bytes()))
}

#[tokio::test]
async fn the_usage_page_answers_what_the_typescript_answers_over_real_channels() -> Result<()> {
    let Some(store) = support::real_store().await? else {
        return Ok(());
    };
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/usage_recorded/real.json");
    let recorded: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let now = recorded["now"].as_i64().context("now")?;
    let clock = ManualClock::new(now);
    let random = SeededRandom::new(3);
    let config = LedgerConfig::default();
    let ledger = Ledger {
        mongo: &store,
        dragonfly: &dragonfly,
        clock: &clock,
        random: &random,
        config: &config,
        boundary: &NoBoundary,
    };
    let cases = recorded["cases"].as_array().context("cases")?;
    anyhow::ensure!(cases.len() >= 300, "the fixture covers every ledger state");
    let mut compared = 0;
    for case in cases {
        let channel = case["channelID"].as_str().context("channel")?;
        let state_id = ObjectId::parse_str(case["stateId"].as_str().context("state")?)?;
        let state = store
            .documents("ai_usage_ledger_states")
            .find_one(doc! {"_id": state_id})
            .await?
            .context("the copy holds the recorded state")?;
        let customer = state.get_str("customerId")?;
        let window = resolve_window(WindowInput {
            time_zone: case["timeZone"].as_str(),
            now_ms: now,
            max_days: case["maxDays"].as_f64(),
            ..WindowInput::default()
        })?;
        let status = ledger
            .ledger_status(channel, customer, window.start_ms)
            .await?;
        assert_eq!(
            sha(&status.to_json()),
            case["status"]["sha"],
            "{channel} status"
        );
        let created = dima_text::parse_date("2025-01-01T00:00:00.000Z").context("date")?;
        let request = dashboard_request(&DashboardInput {
            channel_id: channel,
            customer_id: customer,
            plan_tier: case["planTier"].as_str().context("tier")?,
            account_created_at_ms: created,
            window: &window,
        });
        let data = ledger.compute_dashboard(&request, now).await?;
        assert_eq!(
            data["summary"]["transactionCount"],
            case["dashboard"]["transactionCount"]
                .as_f64()
                .unwrap_or(f64::NAN),
            "{channel}"
        );
        assert_eq!(sha(&data), case["dashboard"]["sha"], "{channel} dashboard");
        let page = ledger
            .query_transactions(
                channel,
                customer,
                &window,
                &TransactionFilters {
                    limit: Some(25.0),
                    ..Default::default()
                },
            )
            .await?;
        let as_json = |items: Vec<Value>, next: Option<String>| {
            let mut map = Map::new();
            map.insert("items".into(), Value::Array(items));
            map.insert("nextCursor".into(), next.map_or(Value::Null, Value::from));
            Value::Object(map)
        };
        let cursor = page.next_cursor.clone();
        assert_eq!(
            sha(&as_json(page.items, page.next_cursor)),
            case["page"]["sha"],
            "{channel} page"
        );
        if let Some(cursor) = cursor {
            let next = ledger
                .query_transactions(
                    channel,
                    customer,
                    &window,
                    &TransactionFilters {
                        limit: Some(25.0),
                        cursor: Some(&cursor),
                        ..Default::default()
                    },
                )
                .await?;
            assert_eq!(
                sha(&as_json(next.items, next.next_cursor)),
                case["page"]["next"]["sha"],
                "{channel} next page"
            );
        }
        compared += 1;
    }
    assert_eq!(compared, cases.len());
    Ok(())
}
