//! Part 1 against the recording of the TypeScript (`tests/eventsub/part1.json`, written by
//! `tests/eventsub/record.mts`): the subscription table, every expected condition for every kind
//! of channel, every create request body, the bits helpers, the bits settings merge, the
//! circuit breaker, the built-in chat events and `getEventsubAccess`.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod support;

use anyhow::{Context, Result};
use bson::{Bson, Document};
use dima_core::SecretString;
use dima_twitch::eventsub::condition::resolve_channel_id;
use dima_twitch::eventsub::{
    Condition, EventsubAccess, EventsubPermission, EventsubSettings, GlobalOwnerAccess,
    SUBSCRIPTION_TYPES, build_bits_eventsub_config, build_expected_condition, builtin_chat_event,
    builtin_chat_events, canonicalize_eventsub_type, equivalent_eventsub_types, eventsub_access,
    is_bits_event_type, is_legacy_bits_event_type, raid_config_type, raid_direction,
    should_trip_circuit_breaker, with_builtin_chat_events,
};
use dima_twitch::{Twitch, TwitchError};
use futures_util::future::BoxFuture;
use serde_json::Value;
use support::*;

fn part1() -> Result<Value> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/eventsub/part1.json"
    ))?;
    Ok(serde_json::from_str(&text)?)
}

fn items<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    value[key].as_array().with_context(|| key.to_owned())
}

fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The recording names the reference commit and the hash of every file it loaded; a file that
/// changed since fails here (record again).
pub fn assert_sources_unchanged(recording: &Value) -> Result<()> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    for (path, hash) in recording["sources"].as_object().context("sources")? {
        let bytes = std::fs::read(format!("{root}/{path}"))?;
        assert_eq!(
            dima_core::crypto::sha256(&bytes).hex(),
            hash.as_str().unwrap_or_default(),
            "{path} changed since the recording: record again"
        );
    }
    Ok(())
}

#[test]
fn recorded_from_the_current_reference() -> Result<()> {
    let recording = part1()?;
    assert_eq!(
        recording["reference"].as_str(),
        Some("0c71108ee6e5d537104ad26b10db9d558fac22ab")
    );
    assert_sources_unchanged(&recording)
}

#[test]
fn the_table_is_the_reference_table() -> Result<()> {
    let recording = part1()?;
    let table = items(&recording, "table")?;
    assert_eq!(table.len(), SUBSCRIPTION_TYPES.len());
    for (entry, recorded) in SUBSCRIPTION_TYPES.iter().zip(table) {
        assert_eq!(recorded["type"], entry.kind);
        assert_eq!(recorded["version"], entry.version);
        assert_eq!(
            text(&recorded["condition"]),
            text(&entry.template().to_value()),
            "{}",
            entry.kind
        );
        let config = if entry.has_config() {
            let document = entry.default_settings().to_document();
            Bson::Document(document).into_relaxed_extjson()
        } else {
            Value::Null
        };
        assert_eq!(text(&recorded["config"]), text(&config), "{}", entry.kind);
        assert_eq!(
            recorded["autoSubscribe"].as_bool().unwrap_or(true),
            entry.auto_subscribe,
            "{}",
            entry.kind
        );
    }
    Ok(())
}

#[test]
fn expected_conditions_for_every_type_and_kind_of_channel() -> Result<()> {
    let recording = part1()?;
    let conditions = items(&recording, "conditions")?;
    assert_eq!(conditions.len(), 5 * SUBSCRIPTION_TYPES.len());
    for case in conditions {
        let index = usize::try_from(case["index"].as_u64().context("index")?)?;
        let channel = case["channel"].as_str().context("channel")?;
        let built = SUBSCRIPTION_TYPES[index].condition_for(channel);
        assert_eq!(text(&built.to_value()), text(&case["condition"]), "{case}");
    }
    for case in items(&recording, "extraTemplates")? {
        let template = &case["template"];
        let built = build_expected_condition(
            template["type"].as_str().context("type")?,
            &Condition::from_value(&template["condition"]),
            case["channel"].as_str().context("channel")?,
        );
        assert_eq!(text(&built.to_value()), text(&case["condition"]), "{case}");
    }
    Ok(())
}

#[test]
fn create_bodies_for_every_type_and_kind_of_channel() -> Result<()> {
    let recording = part1()?;
    let bodies = items(&recording, "bodies")?;
    assert_eq!(bodies.len(), 4 * SUBSCRIPTION_TYPES.len());
    let settings = EventsubSettings::reference(Some(SecretString::from(EVENTSUB_SECRET)))?;
    for case in bodies {
        let index = usize::try_from(case["index"].as_u64().context("index")?)?;
        let channel = case["channel"].as_str().context("channel")?;
        let entry = &SUBSCRIPTION_TYPES[index];
        let condition = entry.condition_for(channel);
        let body = settings
            .create_body(entry.kind, entry.version, &condition)
            .context("body")?;
        let exchanges = items(case, "exchanges")?;
        assert_eq!(exchanges.len(), 1);
        let recorded = exchanges[0]["request"]["body"].as_str().context("body")?;
        // Compared as bytes; a mismatch is shown with the secret masked.
        let sent = dima_text::to_js_json(&body);
        assert!(
            sent == recorded,
            "{} for {channel}:\n rust {}\n   ts {}",
            entry.kind,
            mask(&sent),
            mask(recorded)
        );
    }
    Ok(())
}

#[test]
fn bits_helpers_and_raid_directions() -> Result<()> {
    let recording = part1()?;
    for case in items(&recording, "bitsTypes")? {
        let kind = case["type"].as_str().context("type")?;
        assert_eq!(case["legacy"], is_legacy_bits_event_type(kind));
        assert_eq!(case["bits"], is_bits_event_type(kind));
        assert_eq!(case["canonical"], canonicalize_eventsub_type(kind));
        assert_eq!(
            case["equivalents"],
            serde_json::json!(equivalent_eventsub_types(kind))
        );
    }
    for case in items(&recording, "raidConditions")? {
        let condition = Condition::from_value(&case["condition"]);
        assert_eq!(
            case["direction"],
            raid_direction(&condition).as_str(),
            "{case}"
        );
        assert_eq!(
            case["raidConfig"],
            raid_config_type("channel.raid", &condition),
            "{case}"
        );
        assert_eq!(
            case["other"],
            raid_config_type("stream.online", &condition),
            "{case}"
        );
    }
    // `resolveRemoteChannelID` over every recorded expected condition names the channel (an
    // empty channel id is falsy: the chain falls through to the bot's `user_id` where there is
    // one, as the reference's `||` does).
    for case in items(&recording, "conditions")? {
        let channel = case["channel"].as_str().context("channel")?;
        let condition = Condition::from_value(&case["condition"]);
        let expected = if channel.is_empty() {
            condition.get_str("user_id").unwrap_or_default().to_owned()
        } else {
            channel.to_owned()
        };
        assert_eq!(resolve_channel_id(&condition), expected, "{case}");
    }
    Ok(())
}

#[test]
fn bits_settings_merge() -> Result<()> {
    let recording = part1()?;
    for case in items(&recording, "bitsCases")? {
        let input = &case["input"];
        let canonical = match &input["canonical"] {
            Value::Null => None,
            value => Some(Document::try_from(
                value.as_object().context("canonical")?.clone(),
            )?),
        };
        let legacy: Vec<Document> = input["legacy"]
            .as_array()
            .context("legacy")?
            .iter()
            .map(|value| Document::try_from(value.as_object().cloned().unwrap_or_default()))
            .collect::<Result<_, _>>()?;
        let merged = build_bits_eventsub_config(canonical.as_ref(), &legacy);
        let got = Bson::Document(merged.to_document()).into_canonical_extjson();
        assert_eq!(text(&got), text(&case["output"]), "{input}");
    }
    Ok(())
}

#[test]
fn circuit_breaker() -> Result<()> {
    let recording = part1()?;
    for case in items(&recording, "breaker")? {
        let total = case["total"].as_u64().context("total")?;
        let unhealthy = case["unhealthy"].as_u64().context("unhealthy")?;
        let ratio = case["ratio"].as_f64().unwrap_or(0.25);
        let min = case["min"].as_f64().unwrap_or(5.0);
        // The worker passes `Math.max(1, Number(...))`; the policy clamps again.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let min = min.max(0.0) as u64;
        assert_eq!(
            case["trips"],
            should_trip_circuit_breaker(total, unhealthy, ratio, min),
            "{case}"
        );
    }
    Ok(())
}

#[test]
fn built_in_chat_events() -> Result<()> {
    let recording = part1()?;
    let catalog = &recording["catalog"];
    let builtins = Value::Array(builtin_chat_events().to_vec());
    assert_eq!(
        dima_text::to_js_json(&builtins),
        catalog["builtins"].as_str().context("builtins")?
    );
    for case in items(catalog, "get")? {
        let kind = case["type"].as_str().context("type")?;
        let got = builtin_chat_event(kind).cloned().unwrap_or(Value::Null);
        assert_eq!(text(&got), text(&case["event"]), "{kind}");
    }
    let input: Vec<Value> = serde_json::from_str(
        r#"[{"type":"channel.shoutout.receive","name":"Custom"},{"type":"channel.follow"},{"name":"no type"},{"type":5}]"#,
    )?;
    let merged = Value::Array(with_builtin_chat_events(input));
    assert_eq!(
        dima_text::to_js_json(&merged),
        catalog["merged"].as_str().context("merged")?
    );
    Ok(())
}

fn failed(error: impl std::fmt::Display) -> TwitchError {
    TwitchError::Mongo {
        op: "admins.find",
        message: error.to_string(),
    }
}

/// `hasGlobalChannelOwnerAccess` as `admin.middleware.ts` has it (the admin package owns the
/// real one): the creator, and super admins outside the creator's channel.
struct GlobalOwners(Twitch, dima_store::mongo::MongoStore);

impl GlobalOwnerAccess for GlobalOwners {
    fn has_global_channel_owner_access<'a>(
        &'a self,
        requester: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<bool, TwitchError>> {
        Box::pin(async move {
            if requester.is_empty() || channel.is_empty() {
                return Ok(false);
            }
            const CREATOR: &str = "533538623";
            let role = if requester == CREATOR {
                Some("creator")
            } else {
                let mut rows = self
                    .1
                    .documents("admins")
                    .find(bson::doc! {"adminID": requester, "actived": true, "role": {"$in": ["creator", "super"]}})
                    .await
                    .map_err(failed)?;
                let mut roles = Vec::new();
                while rows.advance().await.map_err(failed)? {
                    let row: Document = rows.deserialize_current().map_err(failed)?;
                    roles.push(row.get_str("role").unwrap_or_default().to_owned());
                }
                if roles.iter().any(|r| r == "creator") {
                    Some("creator")
                } else if roles.iter().any(|r| r == "super") {
                    Some("super")
                } else {
                    None
                }
            };
            let _ = &self.0;
            Ok(match role {
                Some("creator") => true,
                Some("super") => channel != CREATOR,
                _ => false,
            })
        })
    }
}

#[tokio::test]
async fn eventsub_access_matches_the_reference() -> Result<()> {
    let recording = part1()?;
    with_stores(|stores| async move {
        for row in items(&recording, "adminRows")? {
            let document = Document::try_from(row.as_object().context("row")?.clone())?;
            stores
                .mongo
                .documents("admins")
                .insert_one(document)
                .await?;
        }
        let server = dima_http::testing::MockServer::start().await?;
        let process = process(&stores, &server, fast_timings())?;
        let global = GlobalOwners(process.twitch.clone(), stores.mongo.clone());
        for case in items(&recording, "accessCases")? {
            let permission = match case["permission"].as_str() {
                Some("eventsubs:manage") => EventsubPermission::Manage,
                _ => EventsubPermission::View,
            };
            let access = eventsub_access(
                &process.twitch,
                &global,
                case["requester"].as_str().context("requester")?,
                case["channel"].as_str().context("channel")?,
                permission,
            )
            .await?;
            assert_eq!(case["access"], access.as_str(), "{case}");
            let _ = EventsubAccess::None;
        }
        assert!(server.requests().is_empty());
        Ok(())
    })
    .await
}

/// The test secret of the recordings.
pub const EVENTSUB_SECRET: &str = "test-eventsub-secret-0123456789";

/// A body with the test secret masked, for failure messages.
pub fn mask(body: &str) -> String {
    body.replace(EVENTSUB_SECRET, "<secret>")
}
