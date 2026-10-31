#![cfg(feature = "command-services")]
//! Command-defaults and command-blocks parity:
//! `src/server/services/command_defaults.service.ts`,
//! `src/server/services/command_blocks.service.ts`, and the cooldown adapter
//! they reuse.
//!
//! The plain `#[test]` functions need no service, environment value or network.
//! They cover the embedded catalog, the stable default-command IDs, the client
//! projection, and the text/limit/plan rules of the body resolver.
//!
//! The source comparison is authored by
//! `tests/fixtures/command_services_reference.cjs` and replayed only when the
//! external fixture is supplied:
//!
//! ```text
//! DIMA_COMMAND_SERVICES_FIXTURE_DIR=<absolute dir outside the workspace>
//! DIMA_COMMAND_SERVICES_FIXTURE_SHA256=<lowercase hex>
//! ```
//!
//! The `#[ignore]` adapter suites drive the real MongoDB/Redis adapters against
//! a task-owned disposable MongoDB and Dragonfly, never a production service:
//!
//! ```text
//! COMMAND_SERVICES_TEST_MONGO_ACK=disposable
//! COMMAND_SERVICES_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! COMMAND_SERVICES_TEST_MONGO_DATABASE=rust_command_services_fixture_<unique>
//! COMMAND_SERVICES_TEST_REDIS_URL=redis://127.0.0.1:6379/
//! TZ=UTC
//! ```
//!
//! `..._DATABASE` must start with `rust_command_services_fixture_`; each suite
//! derives its own suffix, asserts the database is empty before use and drops
//! exactly that database afterwards. The seed replay opens one fresh database
//! per fixture case because two cases install a unique index or a collection
//! validator. The Redis instance must be task-owned too: the suites use the
//! namespace `command-services-<suffix>:` derived from the same database
//! suffix, so the value must be unique per run. The acknowledgement value is
//! mandatory. `TZ=UTC` is required for the replayed documents because the
//! command schema's `date.day/month/year` defaults use local calendar fields
//! and the oracle was recorded under UTC.
//!
//! The seeder's owner plan is read through the real `TwitchStreamers`
//! directory (cache, fence and generation rules included). The plan suites in
//! this file build that directory over the same disposable MongoDB/Redis with
//! fixture credentials, a metadata-store failure double and no cache double.
//!
//! Known boundary: the oracle supplies `ast_blocks` as a stand-in because that
//! TypeScript tree is retired; block compilation itself is verified by the
//! dedicated AST suites. The recorded `resolve_blocks_literal_tree` case pins
//! this service's envelope around a canonical literal tree.

#[path = "support/command_services_support.rs"]
mod support;

use dima_rust::command_blocks_service::{
    ChannelPlan, CommandBlocksError, CommandBlocksRequestError, CommandBlocksService,
    CommandBodyCurrent, PresentCommandOptions, can_edit_blocks, present_command,
    resolve_command_body_with_plan,
};
use dima_rust::command_defaults_service::{
    CommandDefaultsError, CommandDefaultsStore, DEFAULT_COMMAND_ID_NAMESPACE,
    ReservedCommandIdentity, default_command_id, get_localized_reserved_command_description,
    get_reserved_command_definition, get_reserved_commands_payload, is_duplicate_key_error,
    normalize_supported_language, reserved_commands,
};
use dima_rust::schemas::{commands, users};
use dima_rust::utils::ast_blocks::MAX_COMMAND_TEXT;
use dima_rust::utils::command_cooldown::CooldownStore;
use dima_rust::utils::plan_cache_fence::{account_cache_key, plan_cache_fence_key};
use dima_rust::utils::twitch::AccessToken;
use dima_rust::utils::twitch_streamers::{
    DirectoryConfig, DirectoryError, DirectoryFuture, MetadataPage, MetadataStore,
    MongoStreamerStore, RedisStreamerCache, StreamerCredentials, StreamerMetadata, TwitchStreamers,
};
use dima_rust::utils::twitch_tokens::{CachedAccount, SystemTokenClock};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc},
    options::{CreateCollectionOptions, IndexOptions},
    IndexModel,
};
use redis::aio::ConnectionManager;
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, sync::Arc};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const MONGO_DATABASE_PREFIX: &str = "rust_command_services_fixture_";
const MONGO_ACK: &str = "disposable";

fn request_error(
    result: Result<Map<String, Value>, CommandBlocksError>,
) -> CommandBlocksRequestError {
    match result {
        Err(CommandBlocksError::Request(error)) => error,
        Ok(payload) => panic!("expected a request error, got {payload:?}"),
        Err(other) => panic!("expected a request error, got {other}"),
    }
}

fn fixed_now() -> DateTime {
    DateTime::parse_rfc3339_str("2026-03-15T12:00:00Z").expect("recorded instant")
}

// --- pure contract --------------------------------------------------------

#[test]
fn embedded_catalog_is_the_source_file_and_holds_one_zero_slot_command() {
    let payload = get_reserved_commands_payload(None);
    assert_eq!(
        payload,
        json!({ "commands": reserved_commands() }),
        "the unlocalized payload is the embedded catalog"
    );
    let entries = payload["commands"].as_array().expect("commands");
    assert_eq!(entries.len(), 38, "source catalog size");
    let mut funcs = BTreeMap::new();
    for entry in entries {
        let func = entry["func"].as_str().expect("func").to_owned();
        *funcs.entry(func).or_insert(0usize) += 1;
        assert!(
            entry["description"].is_object(),
            "every source entry has an object description"
        );
    }
    assert!(
        funcs.values().all(|count| *count == 1),
        "catalog functions are unique"
    );
    let zero_slot = entries
        .iter()
        .filter(|entry| entry["reserved"] == json!(false) && entry["cooldown"] == json!(0))
        .map(|entry| entry["func"].as_str().expect("func"))
        .collect::<Vec<_>>();
    assert_eq!(
        zero_slot,
        vec!["speach"],
        "only one catalog command can enter the zero-slot branch"
    );
}

#[test]
fn localized_payload_keeps_the_extra_source_keys() {
    let payload = get_reserved_commands_payload(Some("es"));
    let entry = payload["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .find(|entry| entry["func"] == json!("ruletarusa"))
        .expect("ruletarusa entry");
    assert_eq!(entry["canTimeout"], json!(false), "extra keys are preserved");
    assert!(
        entry["description"].is_string(),
        "the localized payload replaces the description object"
    );
    assert_eq!(
        get_reserved_commands_payload(Some("")).as_object(),
        get_reserved_commands_payload(None).as_object(),
        "the empty language is the raw payload"
    );
}

#[test]
fn reserved_lookup_prefers_func_and_falls_back_to_cmd() {
    let by_func = get_reserved_command_definition(ReservedCommandIdentity::new(
        Some("zzz"),
        Some("shoutout"),
    ))
    .expect("func match");
    assert_eq!(by_func["cmd"], json!("so"));

    let by_cmd =
        get_reserved_command_definition(ReservedCommandIdentity::new(Some("so"), Some("zzz")))
            .expect("cmd match");
    assert_eq!(by_cmd["func"], json!("shoutout"));

    let precedence = get_reserved_command_definition(ReservedCommandIdentity::new(
        Some("anuncio"),
        Some("shoutout"),
    ))
    .expect("func wins");
    assert_eq!(precedence["func"], json!("shoutout"));

    assert!(
        get_reserved_command_definition(ReservedCommandIdentity::new(Some(""), Some(""))).is_none()
    );
    assert_eq!(
        normalize_supported_language(Some(" ES ")).as_str(),
        "es",
        "JavaScript trim/lowercase"
    );
    assert_eq!(normalize_supported_language(Some("fr")).as_str(), "en");
    assert_eq!(
        get_localized_reserved_command_description(
            ReservedCommandIdentity::new(None, Some("nope")),
            Some("es"),
            "fallback"
        ),
        "fallback"
    );
}

#[test]
fn default_command_ids_are_channel_scoped_hash_prefixes() {
    let id = default_command_id("chan", "duel");
    assert_eq!(id.to_hex().len(), 24);
    assert_eq!(id, default_command_id("chan", "duel"));
    assert_ne!(id, default_command_id("chan", "other"));
    assert_ne!(id, default_command_id("other", "duel"));
    let digest = {
        use sha2::{Digest, Sha256};
        let payload = json!([DEFAULT_COMMAND_ID_NAMESPACE, "chan", "duel"]).to_string();
        format!("{:x}", Sha256::digest(payload.as_bytes()))
    };
    assert_eq!(id.to_hex(), &digest[..24]);
}

#[test]
fn present_command_never_leaks_blocks_or_compiled_text() {
    let command = json!({
        "name": "d",
        "authoring": "blocks",
        "message": "compiled",
        "blocks": {"v": 1, "root": {"type": "root", "id": "root", "children": []}}
    });
    let hidden = present_command(&command, PresentCommandOptions::default());
    assert_eq!(hidden["authoring"], json!("blocks"));
    assert_eq!(hidden["message"], json!(""));
    assert!(hidden.get("blocks").is_none(), "blocks are opt-in");

    let shown = present_command(&command, PresentCommandOptions { blocks: true });
    assert!(shown.get("blocks").is_some());

    let text = present_command(
        &json!({"authoring": "legacy", "message": "hi"}),
        PresentCommandOptions { blocks: true },
    );
    assert_eq!(text["authoring"], json!("text"));
    assert_eq!(text["message"], json!("hi"));
    assert!(text.get("blocks").is_none());
}

#[test]
fn resolve_text_bodies_applies_the_source_rules() {
    let from_blocks = CommandBodyCurrent::new(Some("blocks"), false);
    let switched = resolve_command_body_with_plan(
        ChannelPlan::Pro,
        json!({"authoring": "text", "message": "hi"})
            .as_object()
            .expect("body"),
        Some(&from_blocks),
    )
    .expect("switch to text");
    assert_eq!(switched["authoring"], json!("text"));
    assert_eq!(switched["blocks"], Value::Null);
    assert_eq!(switched["message"], json!("hi"));

    let missing = request_error(resolve_command_body_with_plan(
        ChannelPlan::Pro,
        json!({"authoring": "text"}).as_object().expect("body"),
        Some(&from_blocks),
    ));
    assert_eq!(missing.code(), "missing_message");
    assert_eq!(missing.status(), 400);

    let blank = request_error(resolve_command_body_with_plan(
        ChannelPlan::Pro,
        json!({"authoring": "text", "message": "   "})
            .as_object()
            .expect("body"),
        Some(&from_blocks),
    ));
    assert_eq!(blank.code(), "missing_message");

    let plain = resolve_command_body_with_plan(
        ChannelPlan::Free,
        json!({"authoring": "text", "message": "hi"})
            .as_object()
            .expect("body"),
        None,
    )
    .expect("plain text");
    assert_eq!(plain["authoring"], json!("text"));
    assert_eq!(plain["blocks"], Value::Null);

    let message_only = resolve_command_body_with_plan(
        ChannelPlan::Free,
        json!({"message": "hi"}).as_object().expect("body"),
        None,
    )
    .expect("message only");
    assert_eq!(message_only, json!({"message": "hi"}).as_object().cloned().expect("map"));

    let settings_only = resolve_command_body_with_plan(
        ChannelPlan::Premium,
        Map::new(),
        Some(&from_blocks),
    )
    .expect("settings only");
    assert!(settings_only.is_empty());

    let settings_only_blocks = resolve_command_body_with_plan(
        ChannelPlan::Premium,
        json!({"authoring": "blocks"}).as_object().expect("body"),
        Some(&from_blocks),
    )
    .expect("settings only block command");
    assert!(settings_only_blocks.is_empty());
}

#[test]
fn resolve_text_bodies_measures_utf16_code_units() {
    let at_limit = resolve_command_body_with_plan(
        ChannelPlan::Free,
        json!({"authoring": "text", "message": "x".repeat(MAX_COMMAND_TEXT)})
            .as_object()
            .expect("body"),
        None,
    )
    .expect("exactly the limit is accepted");
    assert_eq!(at_limit["message"].as_str().expect("message").len(), MAX_COMMAND_TEXT);

    let too_long = request_error(resolve_command_body_with_plan(
        ChannelPlan::Free,
        json!({"authoring": "text", "message": "x".repeat(MAX_COMMAND_TEXT + 1)})
            .as_object()
            .expect("body"),
        None,
    ));
    assert_eq!(too_long.code(), "too_long");
    assert_eq!(
        too_long.message(),
        format!(
            "The reply is too long ({} of {} characters)",
            MAX_COMMAND_TEXT + 1,
            MAX_COMMAND_TEXT
        )
    );

    let astral = request_error(resolve_command_body_with_plan(
        ChannelPlan::Free,
        json!({"authoring": "text", "message": "\u{1f600}".repeat(5001)})
            .as_object()
            .expect("body"),
        None,
    ));
    assert_eq!(astral.code(), "too_long");
    assert!(
        astral.message().contains("10002 of 10000"),
        "surrogate pairs count twice: {}",
        astral.message()
    );
}

#[test]
fn resolve_block_bodies_checks_reserved_then_plan_then_the_tree() {
    let literal = json!({
        "type": "root",
        "id": "root",
        "children": [{"type": "literal", "id": "s1", "value": "hi"}]
    });
    let body = json!({"authoring": "blocks", "blocks": literal})
        .as_object()
        .cloned()
        .expect("body");
    let text_current = CommandBodyCurrent::new(Some("text"), false);
    let reserved = CommandBodyCurrent::new(Some("text"), true);

    let refused = request_error(resolve_command_body_with_plan(
        ChannelPlan::Pro,
        &body,
        Some(&reserved),
    ));
    assert_eq!(refused.status(), 400);
    assert_eq!(refused.code(), "reserved");

    let gated = request_error(resolve_command_body_with_plan(
        ChannelPlan::Free,
        &body,
        Some(&text_current),
    ));
    assert_eq!(gated.status(), 403);
    assert_eq!(gated.code(), "plan_required");
    assert!(!can_edit_blocks(ChannelPlan::Free));
    assert!(can_edit_blocks(ChannelPlan::Premium));

    let compiled = resolve_command_body_with_plan(ChannelPlan::Premium, &body, Some(&text_current))
        .expect("premium block command");
    assert_eq!(compiled["authoring"], json!("blocks"));
    assert_eq!(compiled["message"], json!("hi"));
    assert_eq!(compiled["blocks"]["v"], json!(1));
    assert_eq!(compiled["blocks"]["root"]["type"], json!("root"));

    let broken = request_error(resolve_command_body_with_plan(
        ChannelPlan::Premium,
        json!({"authoring": "blocks"}).as_object().expect("body"),
        Some(&text_current),
    ));
    assert_eq!(broken.status(), 400);
    assert_eq!(broken.code(), "blocks_invalid");
    assert_eq!(broken.message(), "The block tree is missing or broken.");
    assert_eq!(broken.block_id(), None);
}

// --- source comparison ----------------------------------------------------

#[test]
#[ignore = "requires the external source oracle fixture"]
fn the_oracle_pins_the_expected_cases() {
    let fixture = support::fixture();
    assert_eq!(
        fixture["constants"]["namespace"].as_str(),
        Some(DEFAULT_COMMAND_ID_NAMESPACE)
    );
    assert_eq!(
        fixture["constants"]["catalogSize"].as_u64(),
        Some(reserved_commands().len() as u64)
    );
    assert_eq!(
        fixture["constants"]["maxCommandText"].as_u64(),
        Some(MAX_COMMAND_TEXT as u64)
    );
    assert_eq!(
        fixture["constants"]["duplicateKeyCode"].as_u64(),
        Some(11000)
    );
    assert_eq!(support::fixture_case_names(&fixture), vec![
        "reserved_payload_raw",
        "reserved_payload_es",
        "reserved_payload_fr",
        "reserved_payload_empty_language",
        "reserved_definition_func",
        "reserved_definition_cmd",
        "reserved_definition_func_precedence",
        "reserved_definition_cmd_only",
        "reserved_definition_missing",
        "reserved_description_en",
        "reserved_description_es",
        "reserved_description_trimmed",
        "reserved_description_unknown_language",
        "reserved_description_missing_definition",
        "reserved_description_empty_fallback",
        "normalize_language_undefined",
        "normalize_language_null",
        "normalize_language_\"\"",
        "normalize_language_\"es\"",
        "normalize_language_\"ES\"",
        "normalize_language_\" en \"",
        "normalize_language_\"fr\"",
        "defaults_fresh_channel",
        "defaults_plan_pro_account",
        "defaults_plan_missing_account",
        "defaults_existing_custom_command",
        "defaults_zero_slot_conflict",
        "defaults_lease_contended",
        "defaults_duplicate_without_row",
        "defaults_non_duplicate_save_failure",
        "defaults_concurrent_seed",
        "blocks_plan_free",
        "blocks_plan_premium",
        "blocks_plan_pro",
        "blocks_plan_missing_owner",
        "blocks_plan_unknown_tier",
        "present_text_command",
        "present_text_without_authoring",
        "present_unknown_authoring",
        "present_blocks_hidden",
        "present_blocks_included",
        "resolve_settings_only_block_body",
        "resolve_blocks_reserved",
        "resolve_blocks_free_plan",
        "resolve_blocks_literal_tree",
        "resolve_blocks_missing_tree",
        "resolve_switch_to_text",
        "resolve_switch_missing_message",
        "resolve_switch_blank_message",
        "resolve_plain_text",
        "resolve_message_only",
        "resolve_settings_only_text",
        "resolve_message_at_limit",
        "resolve_too_long_message",
        "resolve_too_long_utf16",
    ]);
}

#[test]
#[ignore = "requires the external source oracle fixture"]
fn replays_the_pure_source_cases() {
    let fixture = support::fixture();
    for case in support::cases_of(&fixture, "defaults-pure") {
        let name = case["name"].as_str().expect("name");
        let input = support::input(case);
        let expect = support::expected(case);
        if let Some(payload) = expect.get("payload") {
            support::assert_json(
                &get_reserved_commands_payload(input["language"].as_str()),
                payload,
                name,
            );
        } else if let Some(definition) = expect.get("definition") {
            let found = get_reserved_command_definition(ReservedCommandIdentity::new(
                input["cmd"].as_str(),
                input["func"].as_str(),
            ))
            .map(|entry| {
                json!({"name": entry["name"], "cmd": entry["cmd"], "func": entry["func"]})
            });
            match (found, definition.is_null()) {
                (Some(found), false) => support::assert_json(&found, definition, name),
                (None, true) => {}
                other => panic!("{name}: definition mismatch {other:?}"),
            }
        } else if let Some(description) = expect.get("description") {
            assert_eq!(
                get_localized_reserved_command_description(
                    ReservedCommandIdentity::new(
                        input["command"]["cmd"].as_str(),
                        input["command"]["func"].as_str(),
                    ),
                    input["language"].as_str(),
                    input["fallback"].as_str().expect("fallback"),
                ),
                description.as_str().expect("description"),
                "{name}"
            );
        } else if let Some(language) = expect.get("language") {
            assert_eq!(
                normalize_supported_language(input["language"].as_str()).as_str(),
                language.as_str().expect("language"),
                "{name}"
            );
        } else {
            panic!("{name}: unrecognized defaults-pure case");
        }
    }
    for case in support::cases_of(&fixture, "blocks-pure") {
        let name = case["name"].as_str().expect("name");
        let input = support::input(case);
        let options = PresentCommandOptions {
            blocks: input["options"]["blocks"].as_bool().unwrap_or(false),
        };
        support::assert_json(
            &present_command(&input["command"], options),
            &support::expected(case)["output"],
            name,
        );
    }
}

// --- disposable MongoDB/Redis adapter suites ------------------------------

struct Harness {
    database: Database,
    redis: ConnectionManager,
}

impl Harness {
    async fn open(suffix: &str) -> TestResult<Self> {
        assert_eq!(
            std::env::var("COMMAND_SERVICES_TEST_MONGO_ACK").as_deref(),
            Ok(MONGO_ACK),
            "explicit disposable-fixture acknowledgement required"
        );
        assert_eq!(
            std::env::var("TZ").as_deref(),
            Ok("UTC"),
            "the recorded schema date defaults require TZ=UTC"
        );
        let uri = std::env::var("COMMAND_SERVICES_TEST_MONGO_URI")
            .expect("explicit task-owned MongoDB URI required");
        let base = std::env::var("COMMAND_SERVICES_TEST_MONGO_DATABASE")
            .expect("explicit task-owned MongoDB database required");
        assert!(
            base.starts_with(MONGO_DATABASE_PREFIX),
            "task database must use the fixture prefix"
        );
        let name = format!("{base}_{suffix}");
        let client = mongodb::Client::with_uri_str(&uri).await?;
        let database = client.database(&name);
        assert!(
            database.list_collection_names().await?.is_empty(),
            "task database must be fresh"
        );
        let redis_url = std::env::var("COMMAND_SERVICES_TEST_REDIS_URL")
            .expect("explicit task-owned Redis URL required");
        let redis = redis::Client::open(redis_url)?
            .get_connection_manager()
            .await?;
        Ok(Self { database, redis })
    }

    fn commands(&self) -> Collection<Document> {
        commands::collection(&self.database)
    }

    async fn drop_database(self) {
        self.database.drop().await.ok();
    }
}

/// Fixture credentials for the account directory: complete enough that the
/// directory publishes `id`, without a token endpoint.
struct FixtureCredentials {
    redis: ConnectionManager,
    namespace: String,
}

impl StreamerCredentials for FixtureCredentials {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        Box::pin(async move {
            let key = format!("{}{}", self.namespace, account_cache_key(id));
            let mut connection = self.redis.clone();
            redis::cmd("HSET")
                .arg(&key)
                .arg("access_token")
                .arg("fixture-access")
                .arg("refresh_token")
                .arg("fixture-refresh")
                .arg("expires_at")
                .arg("0")
                .arg("has_permissions")
                .arg("true")
                .arg("up_to_date_permissions")
                .arg("true")
                .query_async::<i64>(&mut connection)
                .await
                .map_err(|_| DirectoryError::CacheUnavailable {
                    write_outcome_unknown: false,
                })?;
            Ok(CachedAccount {
                id: id.to_owned(),
                access_token: "fixture-access".into(),
                refresh_token: "fixture-refresh".into(),
                expires_at: "0".into(),
                has_permissions: true,
                up_to_date_permissions: true,
            })
        })
    }

    fn token<'a>(&'a self, _id: &'a str) -> DirectoryFuture<'a, AccessToken> {
        Box::pin(async { Err(DirectoryError::Missing) })
    }
}

/// The real account directory over the disposable MongoDB and Redis. The
/// fixture adds no cache behaviour of its own.
fn directory(harness: &Harness, namespace: &str) -> Arc<TwitchStreamers> {
    Arc::new(
        TwitchStreamers::new(
            Arc::new(MongoStreamerStore::new(&harness.database)),
            Arc::new(RedisStreamerCache::with_namespace(
                harness.redis.clone(),
                namespace.to_owned(),
            )),
            Arc::new(FixtureCredentials {
                redis: harness.redis.clone(),
                namespace: namespace.to_owned(),
            }),
            Arc::new(SystemTokenClock::default()),
            DirectoryConfig::default(),
        )
        .expect("streamer directory configuration"),
    )
}

/// Metadata store failure only: the cache is real.
struct FailingStore;

impl MetadataStore for FailingStore {
    fn account<'a>(&'a self, _id: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>> {
        Box::pin(async { Err(DirectoryError::StoreUnavailable) })
    }

    fn page<'a>(
        &'a self,
        _after: Option<&'a str>,
        _limit: usize,
    ) -> DirectoryFuture<'a, MetadataPage> {
        Box::pin(async { Err(DirectoryError::StoreUnavailable) })
    }
}

fn failing_directory(harness: &Harness, namespace: &str) -> Arc<TwitchStreamers> {
    Arc::new(
        TwitchStreamers::new(
            Arc::new(FailingStore),
            Arc::new(RedisStreamerCache::with_namespace(
                harness.redis.clone(),
                namespace.to_owned(),
            )),
            Arc::new(FixtureCredentials {
                redis: harness.redis.clone(),
                namespace: namespace.to_owned(),
            }),
            Arc::new(SystemTokenClock::default()),
            DirectoryConfig::default(),
        )
        .expect("streamer directory configuration"),
    )
}

async fn seed_owner(harness: &Harness, channel: &str, plan_tier: &str) -> TestResult {
    users::schema()
        .native_collection(&harness.database)
        .update_one(
            doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}},
            doc! {"$set": {
                "accounts": [doc! {"type": "twitch", "id": channel, "name": "oracle"}],
                "plan_tier": plan_tier,
            }},
        )
        .upsert(true)
        .await?;
    Ok(())
}

async fn flush_plan_cache(harness: &Harness, namespace: &str, id: &str) -> TestResult {
    let mut connection = harness.redis.clone();
    redis::cmd("DEL")
        .arg(format!("{namespace}{}", account_cache_key(id)))
        .arg(format!("{namespace}{}", plan_cache_fence_key(id)))
        .query_async::<i64>(&mut connection)
        .await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable MongoDB/Redis and the external source oracle fixture"]
async fn replays_the_recorded_seed_cases() -> TestResult {
    let fixture = support::fixture();
    let now = fixed_now();

    for (index, case) in support::cases_of(&fixture, "defaults-seed").into_iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let input = support::input(case);
        let expect = support::expected(case);
        let channel = input["channelID"].as_str().expect("channelID");
        // One fresh database per case: the write-error scenarios install a
        // unique index or a collection validator that must not leak.
        let suffix = format!("seed{index}");
        let harness = Harness::open(&suffix).await?;
        let namespace = format!("command-services-{suffix}:");
        let store = CommandDefaultsStore::with_redis(
            &harness.database,
            directory(&harness, &namespace),
            harness.redis.clone(),
        );
        // The Redis instance outlives a case; start from an empty plan cache.
        flush_plan_cache(&harness, &namespace, channel).await?;

        if let Some(tier) = input["planTier"]
            .as_str()
            .filter(|tier| matches!(*tier, "pro" | "premium"))
        {
            seed_owner(&harness, channel, tier).await?;
        }
        match input["scenario"].as_str() {
            Some("unique_func_index") => {
                harness
                    .commands()
                    .create_index(
                        IndexModel::builder()
                            .keys(doc! {"func": 1})
                            .options(IndexOptions::builder().unique(true).build())
                            .build(),
                    )
                    .await?;
            }
            Some("collection_validator") => {
                harness
                    .database
                    .create_collection(
                        "commands",
                        CreateCollectionOptions::builder()
                            .validator(doc! {
                                "$jsonSchema": {
                                    "bsonType": "object",
                                    "required": ["command_services_native_test_marker"],
                                }
                            })
                            .build(),
                    )
                    .await?;
            }
            _ => {}
        }
        if let Some(key) = input["leaseKey"].as_str() {
            let mut connection = harness.redis.clone();
            redis::cmd("SET")
                .arg(key)
                .arg("incumbent-token")
                .arg("EX")
                .arg(60)
                .query_async::<()>(&mut connection)
                .await?;
        }
        let seeds = support::documents(&input["seedHex"]);
        if !seeds.is_empty() {
            harness.commands().insert_many(seeds).await?;
        }

        let concurrent = name == "defaults_concurrent_seed";
        let outcome: Result<u64, CommandDefaultsError> = if concurrent {
            let (first, second) = tokio::join!(
                store.ensure_reserved_commands_at(channel, "oracle", now),
                store.ensure_reserved_commands_at(channel, "oracle", now)
            );
            match (first, second) {
                (Ok(first), Ok(second)) => Ok(first + second),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        } else {
            store
                .ensure_reserved_commands_at(channel, "oracle", now)
                .await
        };

        if expect["ok"].as_bool().expect("ok") {
            assert_eq!(
                outcome.unwrap_or_else(|error| panic!("{name}: {error}")),
                expect["created"].as_u64().expect("created"),
                "{name}"
            );
        } else {
            let error = match outcome {
                Ok(created) => panic!("{name}: expected a write failure, inserted {created}"),
                Err(error) => error,
            };
            let duplicate = match &error {
                CommandDefaultsError::Mongo(error) => is_duplicate_key_error(error),
                _ => false,
            };
            match expect["errorKind"].as_str().expect("errorKind") {
                "duplicate" => assert!(
                    duplicate,
                    "{name}: expected a duplicate-key error, got {error}"
                ),
                "other" => assert!(
                    !duplicate,
                    "{name}: expected a non-duplicate error, got {error}"
                ),
                other => panic!("{name}: unexpected errorKind {other}"),
            }
        }

        let rows = harness
            .commands()
            .find(doc! {"channelID": channel})
            .await?
            .try_collect::<Vec<_>>()
            .await?;
        if concurrent {
            assert_eq!(
                rows.len() as u64,
                expect["count"].as_u64().expect("count"),
                "{name}: document count"
            );
            let mut per_function: BTreeMap<String, usize> = BTreeMap::new();
            for row in &rows {
                *per_function
                    .entry(row.get_str("func").unwrap_or_default().to_owned())
                    .or_insert(0) += 1;
            }
            let duplicates = per_function
                .into_iter()
                .filter(|(_, count)| *count > 1)
                .map(|(function, _)| function)
                .collect::<Vec<_>>();
            assert!(
                expect["duplicateFunctions"]
                    .as_array()
                    .is_some_and(Vec::is_empty),
                "{name}: the fixture recorded no duplicates"
            );
            assert!(
                duplicates.is_empty(),
                "{name}: duplicate seeded functions {duplicates:?}"
            );
        } else {
            // docsHex is the object Mongoose passed to collection.insertOne.
            let recorded = support::documents(&expect["docsHex"]);
            assert_eq!(rows.len(), recorded.len(), "{name}: stored document count");
            support::assert_document_set(&rows, &recorded, name);
        }

        let mut connection = harness.redis.clone();
        let key = input["leaseKey"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("command-cooldown-write:{channel}"));
        let exists: i64 = redis::cmd("EXISTS")
            .arg(&key)
            .query_async(&mut connection)
            .await?;
        if input["leaseKey"].is_null() {
            assert_eq!(exists, 0, "{name}: this caller's lease must be released");
        } else {
            assert_eq!(exists, 1, "{name}: the incumbent lease must survive");
            redis::cmd("DEL")
                .arg(&key)
                .query_async::<i64>(&mut connection)
                .await?;
        }

        harness.drop_database().await;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable MongoDB/Redis"]
async fn plan_read_uses_the_cached_account_directory() -> TestResult {
    let harness = Harness::open("plan_directory").await?;
    let namespace = "command-services-plan_directory:";
    let store = CommandDefaultsStore::with_redis(
        &harness.database,
        directory(&harness, namespace),
        harness.redis.clone(),
    );
    let channel = "oracle-plan-directory";

    flush_plan_cache(&harness, namespace, channel).await?;
    seed_owner(&harness, channel, "pro").await?;
    assert_eq!(
        store.owner_plan(channel).await?.as_deref(),
        Some("pro"),
        "a cache miss hydrates the plan from users"
    );

    // Cache hit: the authoritative document disappears and the cached snapshot
    // still answers, which a direct users read could not do.
    users::schema()
        .native_collection(&harness.database)
        .delete_many(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}})
        .await?;
    assert_eq!(
        store.owner_plan(channel).await?.as_deref(),
        Some("pro"),
        "the directory serves the cached plan"
    );

    // Missing account after the cache entry is removed: the source class
    // returns null, which the cooldown policy reads as free tier.
    flush_plan_cache(&harness, namespace, channel).await?;
    assert!(
        store.owner_plan(channel).await?.is_none(),
        "an absent account is free tier"
    );

    harness.drop_database().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable MongoDB/Redis"]
async fn plan_read_swallows_a_stale_fence_and_the_seed_still_runs() -> TestResult {
    let harness = Harness::open("plan_stale").await?;
    let namespace = "command-services-plan_stale:";
    let store = CommandDefaultsStore::with_redis(
        &harness.database,
        directory(&harness, namespace),
        harness.redis.clone(),
    );
    let channel = "oracle-plan-stale";

    flush_plan_cache(&harness, namespace, channel).await?;
    seed_owner(&harness, channel, "premium").await?;
    assert_eq!(store.owner_plan(channel).await?.as_deref(), Some("premium"));

    // A plan fence newer than the cached version makes the directory report a
    // stale entry; the source class catches it and returns null.
    let fence = format!("{namespace}{}", plan_cache_fence_key(channel));
    let mut connection = harness.redis.clone();
    redis::cmd("SET")
        .arg(&fence)
        .arg("9999999999999:fence")
        .query_async::<()>(&mut connection)
        .await?;
    assert!(
        store.owner_plan(channel).await?.is_none(),
        "a stale/fenced plan read is swallowed like the source class"
    );

    // The swallowed failure must not block the seeding pass.
    let created = store
        .ensure_reserved_commands_at(channel, "oracle", fixed_now())
        .await?;
    assert_eq!(created, reserved_commands().len() as u64);

    redis::cmd("DEL")
        .arg(&fence)
        .query_async::<i64>(&mut connection)
        .await?;
    harness.drop_database().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable MongoDB/Redis"]
async fn plan_read_swallows_a_store_failure() -> TestResult {
    let harness = Harness::open("plan_failure").await?;
    let namespace = "command-services-plan_failure:";
    let store = CommandDefaultsStore::with_redis(
        &harness.database,
        failing_directory(&harness, namespace),
        harness.redis.clone(),
    );
    assert!(
        store.owner_plan("oracle-plan-failure").await?.is_none(),
        "a store failure is swallowed like the source class"
    );
    harness.drop_database().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable MongoDB/Redis and the external source oracle fixture"]
async fn replays_the_recorded_plan_and_body_cases() -> TestResult {
    let fixture = support::fixture();
    let harness = Harness::open("blocks").await?;
    let service = CommandBlocksService::new(&harness.database);

    for case in support::cases_of(&fixture, "blocks-plan") {
        let name = case["name"].as_str().expect("name");
        let input = support::input(case);
        let expect = support::expected(case);
        let channel = "oracle-plan";
        dima_rust::schemas::users::schema()
            .native_collection(&harness.database)
            .delete_many(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}})
            .await?;
        if !input["owner"].is_null() {
            seed_owner(&harness, channel, input["owner"]["plan_tier"].as_str().expect("plan_tier"))
                .await?;
        }
        assert_eq!(
            service.channel_plan_tier(channel).await?.as_str(),
            expect["plan"].as_str().expect("plan"),
            "{name}"
        );
    }

    for case in support::cases_of(&fixture, "blocks-resolve") {
        let name = case["name"].as_str().expect("name");
        let input = support::input(case);
        let expect = support::expected(case);
        let channel = "oracle-body";
        dima_rust::schemas::users::schema()
            .native_collection(&harness.database)
            .delete_many(doc! {"accounts": {"$elemMatch": {"type": "twitch", "id": channel}}})
            .await?;
        if !input["owner"].is_null() {
            seed_owner(&harness, channel, input["owner"]["plan_tier"].as_str().expect("plan_tier"))
                .await?;
        }
        let body = input["body"].as_object().cloned().unwrap_or_default();
        let current = input["current"].as_object().map(|current| {
            CommandBodyCurrent::new(
                current["authoring"].as_str(),
                current["reserved"].as_bool().unwrap_or(false),
            )
        });
        let result = service
            .resolve_command_body(channel, &body, current.as_ref())
            .await;
        if expect["ok"].as_bool().expect("ok") {
            let output = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            support::assert_json(&Value::Object(output), &expect["output"], name);
        } else {
            let error = match result {
                Err(CommandBlocksError::Request(error)) => error,
                Err(other) => panic!("{name}: unexpected failure {other}"),
                Ok(payload) => panic!("{name}: expected a request error, got {payload:?}"),
            };
            assert_eq!(
                u64::from(error.status()),
                expect["status"].as_u64().expect("status"),
                "{name}: status"
            );
            assert_eq!(
                Some(error.code()),
                expect["code"].as_str(),
                "{name}: code"
            );
            assert_eq!(
                Some(error.message()),
                expect["message"].as_str(),
                "{name}: message"
            );
            assert_eq!(
                error.block_id(),
                expect["blockId"].as_str(),
                "{name}: blockId"
            );
        }
    }

    harness.drop_database().await;
    Ok(())
}
