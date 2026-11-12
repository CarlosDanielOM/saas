//! What production stores and answers today, replayed by Rust and compared exactly (BSON types
//! included, as canonical Extended JSON):
//!
//! - `usage_recorded/typescript.json`, recorded from the frozen TypeScript by `record.mts`
//!   (header there): every ledger write and read, retention, windows in fourteen zones, free
//!   periods, the parsing of queued receipts, the backfill job;
//! - `usage_recorded/native.json`, recorded from the unchanged native receipts worker (the
//!   writer of the receipt queue in production) by [`record_the_native_worker`] with
//!   `DIMA_RECORD_RECEIPTS_NATIVE=1` (it uses the reference's global keys, so it runs alone, on
//!   Dragonfly database 10, and refuses to start when they hold anything).
//!
//! Intended differences are applied to the recording in code, each with its reason
//! ([`intended`]); nothing else may differ.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

/// The native receipts worker, unchanged (`dima-rust/src/workers/ai_usage_receipts.rs` and its
/// directory), compiled here only to record it.
#[allow(
    dead_code,
    unused_imports,
    clippy::all,
    clippy::pedantic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::string_slice,
    clippy::indexing_slicing
)]
#[path = "../../../src/workers"]
mod workers {
    pub mod ai_usage_receipts;
}

/// What the native worker imports from its own crate.
mod utils {
    pub mod bson_compat {
        pub use dima_store::mongo::number::js_number;
    }
    pub mod js_compat {
        pub use dima_text::trim;
    }
}

use anyhow::{Context, Result};
use bson::{Bson, Document, doc};
use dima_billing::plans::entitlements::EntitledPlan;
use dima_billing::plans::projection::{PlanOwnerState, ProjectionStores, project_polar_plan};
use dima_billing::usage::EntryKind;
use dima_billing::usage_backfill::{BackfillConfig, BackfillQueue, EnqueueInput};
use dima_billing::usage_ledger::dashboard::DashboardInput;
use dima_billing::usage_ledger::query::TransactionFilters;
use dima_billing::usage_ledger::receipt::parse_queued_receipt;
use dima_billing::usage_ledger::record::BackfillWrite;
use dima_billing::usage_ledger::report::{
    CustomerStates, PeriodInput, SubscriptionPeriod, Transaction, UsageReadError, WindowInput,
    resolve_period, resolve_window,
};
use dima_billing::usage_ledger::retention::UsageRetention;
use dima_billing::usage_ledger::valid_tier;
use dima_billing::usage_receipts::{ConsumerConfig, ReceiptConsumer};
use dima_store::mongo::MongoStore;
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::time::Duration;
use usage_support::{DAY, Env, support};

const COLLECTIONS: [(&str, &str); 4] = [
    ("ai_usage_receipts", "entryId"),
    ("ai_usage_dailies", "date"),
    ("ai_usage_ledger_states", "channelID"),
    ("ai_usage_dashboards", "key"),
];

fn recording(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/usage_recorded")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).expect("recording")).expect("recording json")
}

/// Every ledger document, `_id` dropped, as canonical Extended JSON.
async fn snapshot(store: &MongoStore) -> Result<Value> {
    let mut out = Map::new();
    for (name, key) in COLLECTIONS {
        let documents: Vec<Document> = store
            .documents(name)
            .find(doc! {})
            .sort(doc! { key: 1 })
            .await?
            .try_collect()
            .await?;
        let values: Vec<Value> = documents
            .into_iter()
            .map(|mut d| {
                d.remove("_id");
                Bson::Document(d).into_canonical_extjson()
            })
            .collect();
        out.insert(name.into(), Value::Array(values));
    }
    Ok(Value::Object(out))
}

/// The intended differences between a recording and what Rust stores, applied to both sides
/// (or to the recording) before the exact comparison.
mod intended {
    use serde_json::{Map, Value};

    /// MongoDB copies an upsert's filter fields into the new document in an order that varies
    /// from one run to the next (the fields after them are in lexicographic order): upserted
    /// collections are compared with sorted keys.
    pub fn sort_upserted_keys(snapshot: &mut Value) {
        for name in [
            "ai_usage_receipts",
            "ai_usage_ledger_states",
            "ai_usage_dashboards",
        ] {
            for document in snapshot[name].as_array_mut().into_iter().flatten() {
                if let Some(object) = document.as_object_mut() {
                    let mut entries: Vec<(String, Value)> =
                        std::mem::take(object).into_iter().collect();
                    entries.sort_by(|a, b| a.0.cmp(&b.0));
                    object.extend(entries);
                }
            }
        }
    }

    /// The receipt queue's days are written as the native worker writes them in production
    /// (`categories` last); the TypeScript `persistAiUsageReceipt` is not what production runs
    /// for the queue, and Mongoose puts it in schema order.
    pub fn native_day_order(snapshot: &mut Value) {
        for day in snapshot["ai_usage_dailies"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            if let Some(object) = day.as_object_mut()
                && let Some(categories) = object.shift_remove("categories")
            {
                object.insert("categories".into(), categories);
            }
        }
    }

    /// The native worker stamps `created_at`, `updated_at` and `refreshedAt` with the system
    /// clock (it has no other); they are compared as "the write time".
    pub fn write_times(value: &mut Value, now: i64) {
        match value {
            Value::Object(object) => {
                for (key, entry) in object.iter_mut() {
                    if matches!(key.as_str(), "created_at" | "updated_at" | "refreshedAt")
                        && let Some(ms) = entry
                            .pointer("/$date/$numberLong")
                            .and_then(Value::as_str)
                            .and_then(|t| t.parse::<i64>().ok())
                        && (now..now + 600_000).contains(&ms)
                    {
                        *entry = Value::from("<write time>");
                    } else {
                        write_times(entry, now);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|i| write_times(i, now)),
            _ => {}
        }
    }

    pub fn object(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }
}

fn transaction(value: &Value) -> Transaction {
    let text = |key: &str| value[key].as_str().map(str::to_owned);
    Transaction {
        id: text("id").unwrap(),
        request_id: text("requestId"),
        occurred_at_ms: dima_text::parse_date(value["occurredAt"].as_str().unwrap()).unwrap(),
        entry_kind: if value["entryKind"] == "adjustment" {
            EntryKind::Adjustment
        } else {
            EntryKind::Usage
        },
        category: text("category").unwrap(),
        operation: text("operation").unwrap(),
        source: text("source"),
        adjustment_type: text("adjustmentType"),
        provider: text("provider").unwrap(),
        model: text("model"),
        quantity: value["quantity"].as_f64(),
        unit: value["unit"]
            .as_str()
            .and_then(dima_billing::usage::Unit::parse),
        credits: value["credits"].as_f64().unwrap(),
        resource_type: value["resourceType"]
            .as_str()
            .and_then(dima_billing::usage::ResourceType::parse),
        resource_id: text("resourceId"),
        itemized: value["itemized"] == true,
    }
}

async fn owner(env: &Env, channel: &str, customer: &str) -> Result<PlanOwnerState> {
    let id = bson::oid::ObjectId::new();
    let then = bson::DateTime::from_millis(1_700_000_000_000);
    env.mongo.documents("users").insert_one(doc! {
        "_id": id, "name": "owner", "accounts": [{ "_id": bson::oid::ObjectId::new(), "type": "twitch", "id": channel, "actived": true }],
        "polar_sh_customer_id": customer, "plan_tier": "pro", "plan_tier_until": Bson::Null,
        "token_balance": 0, "created_at": then, "updated_at": then, "__v": 0,
    }).await?;
    let document = env
        .mongo
        .documents("users")
        .find_one(doc! {"_id": id})
        .await?
        .context("owner")?;
    Ok(PlanOwnerState::of(&dima_model::decode_document::<
        dima_model::users::User,
    >(&document)?))
}

/// Every step of the TypeScript recording, replayed in order on a fresh database.
#[tokio::test]
async fn the_ledger_stores_and_answers_what_the_typescript_does() -> Result<()> {
    let recorded = recording("typescript.json");
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let now = recorded["now"].as_i64().context("now")?;
        env.clock.set(now);
        let channel = recorded["channel"].as_str().context("channel")?.to_owned();
        let customer = recorded["customer"]
            .as_str()
            .context("customer")?
            .to_owned();
        let ledger = env.plain();
        let mut windows = recorded["windows"].as_array().context("windows")?.iter();
        for step in recorded["steps"].as_array().context("steps")? {
            let name = step["name"].as_str().context("name")?;
            env.clock.set(step["now"].as_i64().context("now")?);
            let input = &step["input"];
            let result: Value = if name.starts_with("persist-") {
                let receipt =
                    parse_queued_receipt(input["queued"].as_str().context("queued")?.as_bytes())
                        .context("parse")?;
                let tier = valid_tier(input["tier"].as_str());
                let persisted = ledger.persist_receipt(&receipt, tier).await?;
                Value::from(match persisted {
                    dima_billing::usage_ledger::record::Persisted::Inserted => "inserted",
                    dima_billing::usage_ledger::record::Persisted::Duplicate => "duplicate",
                    dima_billing::usage_ledger::record::Persisted::Expired => "expired",
                })
            } else if name == "backfill" {
                let transactions: Vec<Transaction> = input["transactions"]
                    .as_array()
                    .context("transactions")?
                    .iter()
                    .map(transaction)
                    .collect();
                ledger
                    .backfill(&BackfillWrite {
                        channel_id: &channel,
                        customer_id: &customer,
                        plan_tier: input["planTier"].as_str(),
                        coverage_start_ms: input["coverageStart"].as_i64().context("coverage")?,
                        rebuild_start_ms: input["rebuildStart"].as_i64(),
                        transactions: &transactions,
                        now_ms: now,
                    })
                    .await?;
                Value::Null
            } else if name.starts_with("status-") {
                ledger
                    .ledger_status(
                        &channel,
                        &customer,
                        input["startsAt"].as_i64().context("startsAt")?,
                    )
                    .await?
                    .to_json()
            } else if name.starts_with("dashboard-") {
                let window = resolve_window(WindowInput {
                    time_zone: input["timeZone"].as_str(),
                    now_ms: now,
                    max_days: Some(90.0),
                    ..WindowInput::default()
                })?;
                if !name.starts_with("dashboard-cached") {
                    windows.next();
                }
                ledger
                    .get_dashboard(&DashboardInput {
                        channel_id: &channel,
                        customer_id: &customer,
                        plan_tier: "pro",
                        account_created_at_ms: input["accountCreatedAt"]
                            .as_i64()
                            .context("created")?,
                        window: &window,
                    })
                    .await?
                    .to_json()
            } else if name == "retention-free" {
                let owner = owner(&env, &channel, &customer).await?;
                let stores = ProjectionStores {
                    mongo: &env.mongo,
                    dragonfly: &env.dragonfly,
                };
                let retention = UsageRetention { ledger };
                project_polar_plan(
                    stores,
                    &retention,
                    &owner,
                    EntitledPlan::FREE,
                    now,
                    "retention",
                    &customer,
                    "fp",
                    now,
                    &dima_core::SystemRandom,
                )
                .await?;
                Value::Null
            } else {
                anyhow::bail!("unknown step {name}");
            };
            assert_eq!(
                dima_text::to_js_json(&result),
                dima_text::to_js_json(&step["result"]),
                "{name}: answer"
            );
            let mut expected = step["documents"].clone();
            let mut actual = snapshot(&env.mongo).await?;
            intended::sort_upserted_keys(&mut expected);
            intended::sort_upserted_keys(&mut actual);
            if name.starts_with("persist-") {
                intended::native_day_order(&mut expected);
            }
            for (collection, _) in COLLECTIONS {
                assert_eq!(
                    actual[collection], expected[collection],
                    "{name}: {collection}"
                );
            }
        }
        // The itemized pages, recorded after the dashboards and before retention.
        let window = resolve_window(WindowInput {
            time_zone: Some("UTC"),
            now_ms: now,
            max_days: Some(90.0),
            ..WindowInput::default()
        })?;
        let _ = window;
        env.cleanup(&[&channel]).await
    })
    .await
}

/// The itemized pages and the job, on the ledger as it stood when they were recorded.
#[tokio::test]
async fn pages_and_jobs_are_the_typescripts() -> Result<()> {
    let recorded = recording("typescript.json");
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let now = recorded["now"].as_i64().context("now")?;
        env.clock.set(now);
        let channel = recorded["channel"].as_str().context("channel")?.to_owned();
        let customer = recorded["customer"]
            .as_str()
            .context("customer")?
            .to_owned();
        // The receipts as they stood before retention (the last step before it).
        let steps = recorded["steps"].as_array().context("steps")?;
        let before = steps
            .iter()
            .find(|s| s["name"] == "dashboard-cached-UTC")
            .context("step")?;
        for receipt in before["documents"]["ai_usage_receipts"]
            .as_array()
            .context("receipts")?
        {
            let document: Bson = Bson::try_from(receipt.clone())?;
            env.mongo
                .documents("ai_usage_receipts")
                .insert_one(document.as_document().context("doc")?.clone())
                .await?;
        }
        let window = resolve_window(WindowInput {
            time_zone: Some("UTC"),
            now_ms: now,
            max_days: Some(90.0),
            ..WindowInput::default()
        })?;
        let ledger = env.plain();
        for page in recorded["pages"].as_array().context("pages")? {
            let filters = &page["filters"];
            let text = |key: &str| filters[key].as_str();
            let query = TransactionFilters {
                category: text("category"),
                source: text("source"),
                resource_id: text("resourceId"),
                request_id: text("requestId"),
                entry_kind: text("entryKind"),
                adjustment_type: text("adjustmentType"),
                cursor: text("cursor"),
                limit: filters["limit"].as_f64(),
            };
            match ledger
                .query_transactions(&channel, &customer, &window, &query)
                .await
            {
                Ok(answer) => {
                    let expected = &page["result"];
                    assert_eq!(
                        dima_text::to_js_json(&Value::Array(answer.items)),
                        dima_text::to_js_json(&expected["items"]),
                        "{filters}"
                    );
                    assert_eq!(
                        answer.next_cursor.map_or(Value::Null, Value::from),
                        expected["nextCursor"],
                        "{filters}"
                    );
                }
                Err(error) => {
                    assert_eq!(Value::from(error.to_string()), page["error"], "{filters}")
                }
            }
        }
        // The backfill job (its random id masked).
        let keys = env.backfill_keys();
        let config = BackfillConfig::default();
        let queue = BackfillQueue {
            dragonfly: &env.dragonfly,
            keys: &keys,
            config: &config,
            random: &env.random,
        };
        let (enqueued, job) = queue
            .enqueue(&EnqueueInput {
                channel_id: &channel,
                customer_id: &customer,
                plan_tier: Some("premium"),
                coverage_start_ms: None,
                reason: None,
                now_ms: now,
            })
            .await?;
        let mut job: Value = serde_json::from_str(&job.to_json())?;
        job["id"] = json!("<random>");
        // Intended difference: the dedupe key carries the tests' key prefix.
        job["dedupeKey"] = json!(
            job["dedupeKey"]
                .as_str()
                .unwrap_or("")
                .replace(&env.prefix, "")
        );
        assert_eq!(json!({"enqueued": enqueued, "job": job}), recorded["job"]);
        env.cleanup(&[&channel]).await
    })
    .await
}

struct NoStates;

impl CustomerStates for NoStates {
    fn active_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<SubscriptionPeriod>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Windows in fourteen zones across daylight-saving changes, free periods, and the parsing of
/// queued receipts.
#[tokio::test]
async fn windows_periods_and_parsing_are_the_typescripts() -> Result<()> {
    let recorded = recording("typescript.json");
    for case in recorded["zoneCases"].as_array().context("zones")? {
        let input = &case["input"];
        let now = dima_text::parse_date(input["now"].as_str().context("now")?).context("now")?;
        let answer = resolve_window(WindowInput {
            from: input["from"].as_str(),
            to: input["to"].as_str(),
            time_zone: input["timeZone"].as_str(),
            now_ms: now,
            max_days: input["maxDays"].as_f64(),
        });
        match (answer, case.get("window")) {
            (Ok(w), Some(expected)) => assert_eq!(
                json!({"from": w.from, "to": w.to, "timeZone": w.time_zone(), "start": dima_text::to_iso_string(w.start_ms), "end": dima_text::to_iso_string(w.end_exclusive_ms), "days": w.days.len()}),
                *expected,
                "{input}"
            ),
            (Err(error), None) => {
                let class = match error {
                    UsageReadError::Validation(_) => "AiUsageReceiptValidationError",
                    UsageReadError::Limit(_) => "AiUsageReceiptLimitError",
                };
                assert_eq!(
                    (class, error.to_string()),
                    (
                        case["error"].as_str().unwrap(),
                        case["message"].as_str().unwrap().to_owned()
                    ),
                    "{input}"
                );
            }
            (answer, expected) => panic!("{input}: {answer:?} vs {expected:?}"),
        }
    }
    for case in recorded["periodCases"].as_array().context("periods")? {
        let period = resolve_period(
            PeriodInput {
                free_period_anchor_ms: dima_text::parse_date(case["anchor"].as_str().unwrap()),
                time_zone: case["timeZone"].as_str(),
                now_ms: dima_text::parse_date(case["now"].as_str().unwrap()).unwrap(),
                ..PeriodInput::default()
            },
            &NoStates,
        )
        .await?;
        assert_eq!(
            period.billing_period.to_json(),
            case["billingPeriod"],
            "{case}"
        );
        let w = &period.window;
        assert_eq!(
            json!({"from": w.from, "to": w.to, "start": dima_text::to_iso_string(w.start_ms), "end": dima_text::to_iso_string(w.end_exclusive_ms), "days": w.days.len()}),
            case["window"],
            "{case}"
        );
    }
    for case in recorded["parseCases"].as_array().context("parse")? {
        let parsed = parse_queued_receipt(case["raw"].as_str().unwrap().as_bytes()).map(|r| {
            let mut value: Value = serde_json::from_str(&r.queued_text(0)).unwrap();
            value.as_object_mut().unwrap().remove("enqueuedAt");
            value
        });
        assert_eq!(
            parsed.unwrap_or(Value::Null),
            case["parsed"],
            "{}",
            case["raw"]
        );
    }
    Ok(())
}

/// The native worker's scenario: what it is given, relative to `now`.
fn native_scenario(now: i64, channel: &str, customer: &str) -> Vec<(String, String)> {
    let receipt = |id: &str, offset: i64, credits: &str, extra: &str| {
        format!(
            r#"{{"channelID":"{channel}","customerId":"{customer}","id":"{id}","requestId":"req-{id}","occurredAt":"{}","entryKind":"usage","category":"tts","operation":"synthesize","source":"tts_queue","adjustmentType":null,"provider":"fish","model":null,"quantity":100,"unit":"characters","credits":{credits},"resourceType":"speech","resourceId":"speech-{id}","itemized":true{extra},"enqueuedAt":"{}"}}"#,
            dima_text::to_iso_string(now - offset).unwrap(),
            dima_text::to_iso_string(now).unwrap()
        )
    };
    vec![
        ("tts".into(), receipt("aiu_tts", 3_600_000, "150", "")),
        ("repeat".into(), receipt("aiu_tts", 3_600_000, "150", "")),
        (
            "fraction".into(),
            receipt(
                "aiu_chat",
                7_200_000,
                "0.25",
                r#","category":"ai_chat","quantity":3.5"#,
            ),
        ),
        (
            "grant".into(),
            receipt(
                "aiu_grant",
                10_800_000,
                "-5000",
                r#","entryKind":"adjustment","category":"credit_adjustment","operation":"grant","source":"admin_credit_grant""#,
            ),
        ),
        (
            "legacy-category".into(),
            receipt(
                "aiu_legacy",
                2 * DAY,
                "7",
                r#","category":"weird","quantity":null"#,
            ),
        ),
        (
            "debit".into(),
            receipt(
                "aiu_debit",
                3_600_005,
                "30",
                r#","entryKind":"adjustment","category":"credit_adjustment","operation":"correction""#,
            ),
        ),
        ("expired".into(), receipt("aiu_expired", 100 * DAY, "4", "")),
        (
            "large".into(),
            receipt(
                "aiu_large",
                4 * 3_600_000,
                "3000000000",
                r#","quantity":2147483648"#,
            ),
        ),
        (
            "coerced".into(),
            receipt(
                "aiu_coerced",
                5 * 3_600_000,
                "\" 0x10 \"",
                r#","requestId":"  r  ","model":"😀👋 émoji שלום","operation":"   ""#,
            ),
        ),
        ("invalid".into(), "not a receipt".into()),
    ]
}

const NATIVE_CHANNEL: &str = "rec-native-channel";
const NATIVE_CUSTOMER: &str = "rec-native-customer";

fn dashboard_seed(now: i64) -> Document {
    doc! {
        "key": "native-dashboard", "channelID": NATIVE_CHANNEL, "customerId": NATIVE_CUSTOMER, "planTier": "pro",
        "request": {
            "channelID": NATIVE_CHANNEL, "customerId": NATIVE_CUSTOMER, "planTier": "pro",
            "accountCreatedAt": dima_text::to_iso_string(now - 400 * DAY).unwrap(),
            "window": { "from": "x", "to": "y", "timeZone": "UTC",
                "startTimestamp": dima_text::to_iso_string(now - 3 * DAY).unwrap(),
                "endTimestampExclusive": dima_text::to_iso_string(now + DAY).unwrap(),
                "days": ["a", "b"] },
        },
        "data": {}, "dirty": true,
        "refreshedAt": bson::DateTime::from_millis(now - 120_000), "expiresAt": bson::DateTime::from_millis(now + DAY), "__v": 0,
    }
}

/// Records the native worker (see the module docs). Does nothing unless asked.
#[tokio::test]
async fn record_the_native_worker() -> Result<()> {
    if std::env::var_os("DIMA_RECORD_RECEIPTS_NATIVE").is_none() {
        return Ok(());
    }
    support::with_mongo(|store| async move {
        usage_support::indexes(&store).await?;
        let address = std::env::var("DIMA_TEST_DRAGONFLY")?;
        let client = redis::Client::open(format!("redis://{address}/10"))?;
        let mut cache = client.get_connection_manager().await?;
        for key in ["cron:ai-usage-receipts:queue", "cron:ai-usage-receipts:processing", "cron:ai-usage-receipts:queue:dead", "worker:ai-usage-receipts:lock", "ai-usage:queue-health:receipts", "ai-usage:queue-health:backfills"] {
            let exists: i64 = redis::cmd("EXISTS").arg(key).query_async(&mut cache).await?;
            anyhow::ensure!(exists == 0, "{key} is in use on database 10");
        }
        store.documents("users").insert_one(doc! {"accounts": [{"type": "twitch", "id": NATIVE_CHANNEL}], "plan_tier": "pro", "polar_sh_customer_id": NATIVE_CUSTOMER}).await?;
        let now = dima_core::Clock::now_ms(&dima_core::SystemClock);
        let config = workers::ai_usage_receipts::Config { interval_ms: 1000, batch_size: 200, enabled: true, lock_key: "worker:ai-usage-receipts:lock".into(), lock_ttl_seconds: 300, queue_max_age: 900.0, processing_max_age: 900.0, failure_threshold: 3.0 };
        let mut worker = workers::ai_usage_receipts::AiUsageReceipts::new(store.database().clone(), cache.clone(), config);
        let (_stop, stopped) = tokio::sync::watch::channel(false);
        let mut steps = Vec::new();
        for (name, queued) in native_scenario(now, NATIVE_CHANNEL, NATIVE_CUSTOMER) {
            let _: i64 = redis::cmd("RPUSH").arg("cron:ai-usage-receipts:queue").arg(&queued).query_async(&mut cache).await?;
            let outcome = worker.run_batch(&stopped).await.map_err(|e| anyhow::anyhow!(e))?;
            let mut documents = snapshot(&store).await?;
            intended::write_times(&mut documents, now);
            steps.push(json!({"name": name, "queued": queued, "processed": outcome.processed, "success": outcome.success, "documents": documents}));
        }
        store.documents("ai_usage_dashboards").insert_one(dashboard_seed(now)).await?;
        worker.maintain(&stopped, true).await.map_err(|e| anyhow::anyhow!(e))?;
        let mut documents = snapshot(&store).await?;
        intended::write_times(&mut documents, now);
        steps.push(json!({"name": "dashboard-refresh", "documents": documents}));
        let dead: Vec<String> = redis::cmd("LRANGE").arg("cron:ai-usage-receipts:queue:dead").arg(0).arg(-1).query_async(&mut cache).await?;
        for key in ["cron:ai-usage-receipts:queue", "cron:ai-usage-receipts:processing", "cron:ai-usage-receipts:queue:dead", "worker:ai-usage-receipts:lock", "ai-usage:queue-health:receipts", "ai-usage:queue-health:backfills", "ai-usage:queue-health:receipts:snapshot", "ai-usage:queue-health:backfills:snapshot", "ai-usage:queue-health:receipts:alert", "ai-usage:queue-health:backfills:alert"] {
            let _: i64 = redis::cmd("DEL").arg(key).query_async(&mut cache).await?;
        }
        let _: i64 = redis::cmd("DEL").arg(format!("twitch:{NATIVE_CHANNEL}:ai:usage-receipts:generation")).query_async(&mut cache).await?;
        let _: i64 = redis::cmd("DEL").arg(dima_billing::usage_ledger::lock::lock_key(NATIVE_CHANNEL, NATIVE_CUSTOMER)).query_async(&mut cache).await?;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/usage_recorded/native.json");
        std::fs::write(path, serde_json::to_string_pretty(&json!({"recorded": "dima-rust/src/workers/ai_usage_receipts at 0c71108e, unchanged", "now": now, "steps": steps, "dead": dead}))? + "\n")?;
        Ok(())
    })
    .await
}

/// Rust's consumer and dashboard refresh on the native worker's scenario: the same documents.
#[tokio::test]
async fn the_consumer_stores_what_the_native_worker_stores() -> Result<()> {
    if std::env::var_os("DIMA_RECORD_RECEIPTS_NATIVE").is_some() {
        return Ok(());
    }
    let recorded = recording("native.json");
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let now = recorded["now"].as_i64().context("now")?;
        env.clock.set(now);
        env.mongo.documents("users").insert_one(doc! {"accounts": [{"type": "twitch", "id": NATIVE_CHANNEL}], "plan_tier": "pro", "polar_sh_customer_id": NATIVE_CUSTOMER}).await?;
        let keys = env.receipt_keys();
        let config = ConsumerConfig { job_deadline: Duration::from_secs(60), tick_deadline: Duration::from_secs(120), ..ConsumerConfig::default() };
        let consumer = ReceiptConsumer { ledger: env.plain(), keys: &keys, config: &config, random: &env.random, observer: &dima_billing::NoopObserver };
        let steps = recorded["steps"].as_array().context("steps")?;
        let scenario = native_scenario(now, NATIVE_CHANNEL, NATIVE_CUSTOMER);
        for ((name, queued), step) in scenario.iter().zip(steps) {
            assert_eq!(step["name"], name.as_str());
            assert_eq!(step["queued"], queued.as_str(), "the scenario is the recorded one");
            env.dragonfly.rpush(&keys.queue, &[queued.as_bytes()]).await?;
            let report = consumer.settle_batch().await?;
            assert_eq!(report.claimed as u64, step["processed"].as_u64().unwrap_or(0), "{name}");
            let mut actual = snapshot(&env.mongo).await?;
            intended::write_times(&mut actual, now);
            let mut expected = step["documents"].clone();
            intended::sort_upserted_keys(&mut expected);
            intended::sort_upserted_keys(&mut actual);
            for (collection, _) in COLLECTIONS {
                assert_eq!(actual[collection], expected[collection], "{name}: {collection}");
            }
        }
        assert_eq!(env.list(&keys.dead).await?, recorded["dead"].as_array().context("dead")?.iter().map(|d| d.as_str().unwrap_or("").to_owned()).collect::<Vec<_>>());
        env.mongo.documents("ai_usage_dashboards").insert_one(dashboard_seed(now)).await?;
        assert_eq!(env.plain().refresh_dashboards(&dima_billing::NoopObserver).await?, 1);
        let mut actual = snapshot(&env.mongo).await?;
        intended::write_times(&mut actual, now);
        let refresh = steps.last().context("refresh")?;
        let mut expected = refresh["documents"].clone();
        intended::sort_upserted_keys(&mut expected);
        intended::sort_upserted_keys(&mut actual);
        assert_eq!(actual["ai_usage_dashboards"], expected["ai_usage_dashboards"], "dashboard refresh");
        let _ = intended::object(&Value::Null);
        env.cleanup(&[NATIVE_CHANNEL]).await
    })
    .await
}
