//! Every registered collection written through this crate and the store's helpers, against what
//! the real Mongoose model wrote for the same intent (`tests/mongoose/writes.json`, recorded by
//! `tests/mongoose/record.mts`): the indexes `Model.init()` leaves on an empty database, documents
//! created (through the module's input type where the case names one), validation errors,
//! updates, upserts, `findOneAndUpdate` results and saves, hooks included, each compared as the
//! write commands sent (filter, update, inserted documents) and the exact stored BSON (types,
//! key order, missing versus null). Duplicate keys on the unique indexes
//! are detected. One throwaway database per test, dropped afterwards.
//!
//! Skipped with a message when `DIMA_TEST_MONGO_URI` is not set.

mod support;

use anyhow::{Context, Result, anyhow, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::accounts::NewAccount as NewSignIn;
use dima_model::admins::NewAdmin;
use dima_model::ai_usage_dailies::NewAiUsageDaily;
use dima_model::ai_usage_dashboards::NewAiUsageDashboard;
use dima_model::ai_usage_ledger_states::NewAiUsageLedgerState;
use dima_model::ai_usage_receipts::{EntryKind, NewAiUsageReceipt, RetentionTier};
use dima_model::app_configs::NewAppConfig;
use dima_model::ast_variables::NewAstVariables;
use dima_model::availability::Writer;
use dima_model::channel_ai_memories::{
    MemoryRisk, MemorySource, MemoryStatus, MemoryType, NewChannelAiMemory, NewMemoryActor,
    NewMemoryEvidence, NewMemorySubject, SubjectScope,
};
use dima_model::channel_ai_personalities::{NewChannelAiPersonality, NewKnownUser};
use dima_model::channel_configs::{ChannelConfigDate, NewChannelConfig};
use dima_model::channel_extension_items::{
    ItemCategory, MediaType, NewChannelExtensionItem, NewItemTts, TtsLanguage, TtsMode,
};
use dima_model::channel_fish_voice_favorites::{FishVoiceFavorite, NewChannelFishVoiceFavorites};
use dima_model::channel_tts_settings::{
    NewChannelTtsSettings, NewTtsFilters, NewTtsQueue, NewTtsVoices, expressive_tags_document,
};
use dima_model::command_user_variables::NewCommandUserVariables;
use dima_model::commands::{self, Activation, MatchMode, NewCommand, NewKeywordSettings};
use dima_model::countdown_timers::{CountdownConfig, NewCountdown};
use dima_model::credit_gifts::{GiftStatus, NewCreditGift};
use dima_model::credit_transactions::{
    NewCreditMetadata, NewCreditTransaction, RewardTarget, TransactionType,
};
use dima_model::cron_job_intents::{IntentStatus, NewCronJobIntent};
use dima_model::custom_timers::{FrequencyUnit, NewCustomTimer};
use dima_model::dimafx_playbacks::{NewDimafxPlayback, PlaybackState};
use dima_model::domain_event_checkpoints::NewCheckpoint;
use dima_model::domain_event_deliveries::NewDelivery;
use dima_model::domain_events::{self, NewDomainEvent, NewSubject, SubjectKind, Topic};
use dima_model::events::{ControlType, Localized, NewControl, NewEvent, ReleaseStage};
use dima_model::eventsubs::NewEventsub;
use dima_model::extension_wallet_transactions::{
    NewExtensionWalletTransaction, WalletTransactionType,
};
use dima_model::index::{IndexDifference, IndexError, IndexStatus};
use dima_model::media_assets::{AssetScope, MarketplaceStatus, NewMediaAsset, ThumbnailStatus};
use dima_model::oauth_clients::{ClientType, NewOAuthClient};
use dima_model::oauth_grants::NewOAuthGrant;
use dima_model::oauth_refresh_tokens::NewOAuthRefreshToken;
use dima_model::oauth_sessions::NewOAuthSession;
use dima_model::redemption_rewards::NewRedemptionReward;
use dima_model::referral_codes::{NewReferralCode, NewReferralStats};
use dima_model::site_analytics::{BotPlatform, NewLiveChannel, NewSiteAnalytics};
use dima_model::stream_sessions::NewStreamSession;
use dima_model::timer_commands::NewTimerCommand;
use dima_model::user_extension_inventories::{
    ExtensionPlatform, ItemSource, NewInventoryConfig, NewInventoryItem, NewUserExtensionInventory,
    QuickPurchaseAction, QuickPurchasePriority,
};
use dima_model::user_media_library_items::{
    LibraryAssetScope, NewUserMediaLibraryItem, RelationType,
};
use dima_model::users::{
    AccountType, EncryptedToken, Language, NewAccount, NewUser, PlanTier, TtsProvider,
};
use dima_model::values::Nullable;
use dima_model::{
    CollectionInfo, IndexPolicy, ModelError, REGISTRY, ensure_indexes, preflight_indexes,
};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::Change;
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// A generous deadline for index work on the local server.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

// ------------------------------------------------------------------------------------ recording

struct Recording {
    now_ms: i64,
    indexes: Vec<Value>,
    cases: Vec<Value>,
}

fn recording() -> Result<Recording> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mongoose/writes.json");
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    let value: Value = serde_json::from_str(&text)?;
    let now_ms = value
        .pointer("/meta/nowMs")
        .and_then(Value::as_i64)
        .context("meta.nowMs")?;
    let list = |key: &str| -> Result<Vec<Value>> {
        value
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .with_context(|| format!("{key} missing"))
    };
    Ok(Recording {
        now_ms,
        indexes: list("indexes")?,
        cases: list("cases")?,
    })
}

const RECORD: &str = "eval \"$(\"$REPO/dima-rust/tools/test-env\")\" && cd \"$DIMABOT_DIR\" && \
    TZ=UTC node_modules/.bin/tsx \"$REPO/dima-rust/crates/model/tests/mongoose/record.mts\" \
    \"$REPO/dima-rust/crates/model/tests/mongoose/writes.json\"";

/// The recording is only as current as the TypeScript it was made from: it names the reference
/// commit and the SHA-256 of every source file `record.mts` loaded (the schema files, the
/// availability helpers and what they import); a file of this checkout that differs fails here,
/// naming it. Every registered collection's schema file must be among them.
#[test]
fn recording_sources_are_current() -> Result<()> {
    use sha2::{Digest, Sha256};
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mongoose/writes.json");
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let reference = value
        .get("reference")
        .and_then(Value::as_str)
        .context("the recording names no reference commit")?;
    if reference.len() != 40 || !reference.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the recording's reference commit is not a commit id: {reference}");
    }
    let sources = value
        .get("sources")
        .and_then(Value::as_array)
        .context("the recording names no source hashes")?;
    let dimabot = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    let mut recorded = HashSet::new();
    let mut problems = Vec::new();
    for source in sources {
        let file = source
            .get("path")
            .and_then(Value::as_str)
            .context("source path")?;
        let expected = source
            .get("sha256")
            .and_then(Value::as_str)
            .context("source hash")?;
        recorded.insert(file.to_owned());
        match std::fs::read(format!("{dimabot}/{file}")) {
            Ok(bytes) => {
                let actual: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if actual != expected {
                    problems.push(format!("dimabot/{file} changed since the recording"));
                }
            }
            Err(error) => problems.push(format!("dimabot/{file}: {error}")),
        }
    }
    for info in REGISTRY {
        let file = info.source.strip_prefix("dimabot/").unwrap_or(info.source);
        if !recorded.contains(file) {
            problems.push(format!("{}: {file} has no recorded hash", info.name));
        }
    }
    if !problems.is_empty() {
        bail!(
            "the write recording (reference {reference}) is stale:\n{}\n\
             dimabot/src is frozen: if the change is intended, record again and re-check every \
             collection against it:\n{RECORD}",
            problems.join("\n")
        );
    }
    Ok(())
}

fn bson_of(value: &Value) -> Result<Bson> {
    Bson::try_from(value.clone()).map_err(|e| anyhow!("extended JSON: {e}"))
}

fn document_of(value: &Value) -> Result<Document> {
    match bson_of(value)? {
        Bson::Document(document) => Ok(document),
        other => bail!("expected a document, found {other:?}"),
    }
}

fn info(collection: &str) -> Result<&'static CollectionInfo> {
    REGISTRY
        .iter()
        .copied()
        .find(|info| info.name == collection)
        .with_context(|| format!("{collection} is not registered"))
}

/// Canonical Extended JSON text (keys in stored order, exact number types).
fn canonical(value: Bson) -> String {
    value.into_canonical_extjson().to_string()
}

// -------------------------------------------------------------------------------- normalisation

/// What the recorder does to its output: generated ObjectIds, UUIDs and ObjectId hex strings
/// numbered by first appearance; ids and strings found in the seed or the intent are kept.
struct Normaliser {
    ids: HashSet<ObjectId>,
    strings: HashSet<String>,
    generated: HashMap<ObjectId, ObjectId>,
    uuids: HashMap<String, String>,
    hexes: HashMap<String, String>,
}

impl Normaliser {
    fn new(known: &[&Bson]) -> Self {
        let mut normaliser = Self {
            ids: HashSet::new(),
            strings: HashSet::new(),
            generated: HashMap::new(),
            uuids: HashMap::new(),
            hexes: HashMap::new(),
        };
        for value in known {
            normaliser.collect(value);
        }
        normaliser
    }

    fn collect(&mut self, value: &Bson) {
        match value {
            Bson::ObjectId(id) => {
                self.ids.insert(*id);
            }
            Bson::String(text) => {
                self.strings.insert(text.clone());
            }
            Bson::Array(items) => items.iter().for_each(|v| self.collect(v)),
            Bson::Document(document) => document.values().for_each(|v| self.collect(v)),
            _ => {}
        }
    }

    fn walk(&mut self, value: Bson) -> Bson {
        match value {
            Bson::ObjectId(id) if !self.ids.contains(&id) => {
                let next = self.generated.len() + 1;
                let replacement = *self.generated.entry(id).or_insert_with(|| {
                    ObjectId::parse_str(format!("ffffffffffffffff{next:08}"))
                        .unwrap_or_else(|_| ObjectId::from_bytes([0xff; 12]))
                });
                Bson::ObjectId(replacement)
            }
            Bson::String(text) if is_uuid_v4(&text) && !self.strings.contains(&text) => {
                let next = self.uuids.len() + 1;
                Bson::String(
                    self.uuids
                        .entry(text)
                        .or_insert_with(|| format!("uuid-{next}"))
                        .clone(),
                )
            }
            // A generated ObjectId as text (`new Types.ObjectId().toString()`).
            Bson::String(text)
                if text.len() == 24
                    && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                    && !self.strings.contains(&text) =>
            {
                let next = self.hexes.len() + 1;
                Bson::String(
                    self.hexes
                        .entry(text)
                        .or_insert_with(|| format!("hex-{next}"))
                        .clone(),
                )
            }
            Bson::Array(items) => Bson::Array(items.into_iter().map(|v| self.walk(v)).collect()),
            Bson::Document(document) => Bson::Document(
                document
                    .into_iter()
                    .map(|(k, v)| (k, self.walk(v)))
                    .collect(),
            ),
            other => other,
        }
    }
}

fn is_uuid_v4(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            14 => *b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// Same values whatever the key order and number width (`to_document()` against the intent).
fn same_values(a: &Bson, b: &Bson) -> bool {
    let number = dima_store::mongo::number::read_number;
    match (a, b) {
        (Bson::Document(x), Bson::Document(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_values(v, w)))
        }
        (Bson::Array(x), Bson::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same_values(v, w))
        }
        _ => match (number(a), number(b)) {
            (Some(x), Some(y)) => x == y,
            _ => a == b,
        },
    }
}

// -------------------------------------------------------------------- typed inputs and adapters

/// The module's input type for a `create` case that names one: what `to_document()` gives and
/// the prepared insert.
fn typed_create(
    collection: &str,
    key: &str,
    ctx: &mut WriteContext,
) -> Result<(Document, PreparedInsert)> {
    let text = "héllo 👋🏽 ñ مرحبا שלום e\u{301} 👨‍👩‍👧";
    let token = || EncryptedToken {
        iv: Some("a1b2".into()),
        content: Some("c3d4".into()),
    };
    let ms = |iso: &str| dima_text::parse_date(iso).map(JsDate).context("date");
    let pair = |given: Document, prepared: Result<PreparedInsert, ModelError>| -> Result<_> {
        Ok((given, prepared?))
    };
    match (collection, key) {
        ("raid_subscription_preferences", "typed") => {
            use dima_model::raid_subscription_preferences::*;
            let input = NewRaidSubscriptionPreference {
                id: "seed".into(),
                channel_id: "seed".into(),
                direction: dima_model::raid_subscription_preferences::DirectionKind::Incoming,
                deleted: None,
                operation: None,
                updated_at: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("raid_sessions", "typed") => {
            use dima_model::raid_sessions::*;
            let input = NewRaidSession {
                id: "seed".into(),
                channel_id: "seed".into(),
                event_id: "seed".into(),
                raider_id: "seed".into(),
                raider_login: None,
                raider_name: None,
                viewers: None,
                started_at: JsDate(1623053350011),
                ended_at: None,
                capture_until: JsDate(1623053350011),
                retention_hours: JsNumber(2.0),
                expires_at: JsDate(1623053350011),
                purge_at: JsDate(1623053350011),
                backfill_until: JsDate(1623053350011),
                backfill_cursor: None,
                backfill_done: None,
                manual_request_id: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("raid_moderation_requests", "typed") => {
            use dima_model::raid_moderation_requests::*;
            let input = NewRaidModerationRequest {
                id: "seed".into(),
                channel_id: "seed".into(),
                session_id: "seed".into(),
                actor_id: "seed".into(),
                user_id: None,
                origin: None,
                include_future: None,
                requested_at: JsDate(1623053350011),
                expires_at: JsDate(1623053350011),
                purge_at: JsDate(1623053350011),
                status: None,
                locked_until: None,
                lease_token: None,
                next_attempt_at: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("raid_followers", "typed") => {
            use dima_model::raid_followers::*;
            let input = NewRaidFollower {
                id: "seed".into(),
                channel_id: "seed".into(),
                session_id: "seed".into(),
                event_id: "seed".into(),
                user_id: "seed".into(),
                login: None,
                name: None,
                followed_at: JsDate(1623053350011),
                recorded_at: None,
                queued_request_i_ds: None,
                eligible_request_i_ds: None,
                purge_at: JsDate(1623053350011),
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("raid_analytics_summaries", "typed") => {
            use dima_model::raid_analytics_summaries::*;
            let input = NewRaidAnalyticsSummary {
                id: "seed".into(),
                dirty_at: None,
                next_refresh_at: None,
                lease_until: None,
                owner: None,
                updated_at: None,
                payload: None,
                error: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("raid_analytics_histories", "typed") => {
            use dima_model::raid_analytics_histories::*;
            let input = NewRaidAnalyticsHistory {
                id: "seed".into(),
                channel_id: "seed".into(),
                direction: dima_model::raid_analytics_histories::DirectionKind::Incoming,
                peer_id: None,
                peer_login: None,
                peer_name: None,
                viewers: None,
                occurred_at: JsDate(1623053350011),
                follows_after: None,
                follows_computed_at: None,
                follow_window_end: None,
                expires_at: JsDate(1623053350011),
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("temporary_moderators", "role") => {
            let input = dima_model::temporary_moderators::NewTemporaryModerator {
                channel_id: "111".into(),
                channel: "seed".into(),
                user_id: "222".into(),
                username: text.into(),
                duration_days: JsNumber(2.0),
                expire_timestamp: ms("2021-06-07T08:09:10.011Z")?,
                created_at: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }
        ("vips", "role") => {
            let input = dima_model::vips::NewVip {
                username: text.into(),
                user_id: "222".into(),
                channel: "seed".into(),
                channel_id: "111".into(),
                duration: JsNumber(2.0),
                vip: None,
                created_at: None,
                expire_date: dima_model::vips::NewVipExpireDate {
                    day: JsNumber(7.0),
                    month: JsNumber(5.0),
                    year: JsNumber(2021.0),
                },
                expire_timestamp: ms("2021-06-07T08:09:10.011Z")?,
            };
            let given = input.to_document()?;
            pair(given, input.prepare(ctx))
        }
        ("random_user_settings", "settings") => {
            let input = dima_model::random_user_settings::NewRandomUserSettings {
                channel_id: "111".into(),
                blacklist: Some(vec!["seed".into()]),
            };
            pair(input.to_document()?, input.prepare(ctx))
        }
        ("titleconfigs", "settings") => {
            let input = dima_model::titleconfigs::NewTitleConfig {
                channel_id: "111".into(),
                channel: "seed".into(),
                pretitle: Some(text.into()),
                posttitle: None,
                active: None,
            };
            pair(input.to_document()?, input.prepare(ctx))
        }

        ("users", "empty") => {
            let user = NewUser::default();
            pair(user.to_document()?, user.prepare(ctx))
        }
        ("users", "signup") => {
            let mut account = NewAccount::new(AccountType::Twitch, "222");
            account.name = Some(text.into());
            account.email = Some("new@example.com".into());
            account.refresh_token = Some(token().into());
            account.access_token = Some(token().into());
            account.actived = Some(false);
            account.chat_enabled = Some(false);
            account.has_permissions = Some(false);
            account.up_to_date_permissions = Some(false);
            let user = NewUser {
                tts_default_provider: Some(TtsProvider::Kokoro),
                name: Some(text.into()),
                email: Some("new@example.com".into()),
                language: Some(Language::En),
                accounts: vec![account],
                plan_tier: Some(PlanTier::Free),
                plan_tier_until: ms("2021-06-07T08:09:10.011Z")?.into(),
                last_app_activity_at: Some(ms("2020-01-02T03:04:05.006Z")?),
                token_balance: Some(JsNumber(0.0)),
                ..NewUser::default()
            };
            pair(user.to_document()?, user.prepare(ctx))
        }
        ("users", "referred") => {
            let user = NewUser {
                name: Some("r".into()),
                accounts: vec![NewAccount::new(AccountType::Kick, "9")],
                referrer_id: Some(ObjectId::parse_str("000000000000000000000001")?),
                referral_code_used: Some("CODE".into()),
                plan_tier: Some(PlanTier::Pro),
                ..NewUser::default()
            };
            pair(user.to_document()?, user.prepare(ctx))
        }
        ("eventsubs", "minimal") => {
            let mut sub = NewEventsub {
                id: "sub-9".into(),
                status: "enabled".into(),
                kind: "channel.cheer".into(),
                version: "1".into(),
                condition: doc! { "broadcaster_user_id": "9" },
                created_at: "2024-05-05T05:05:05.555Z".into(),
                transport: doc! { "method": "webhook", "callback": "https://example.com/eventsub" },
                cost: JsNumber(1.0),
                channel: "nine".into(),
                channel_id: "9".into(),
                enabled: None,
                message: None,
            };
            sub.message = Some(text.into());
            pair(sub.to_document()?, sub.prepare(ctx))
        }
        ("astvariables", "scope") => {
            let mut scope = NewAstVariables::new("c");
            scope.user_id = Some("u1".into());
            scope.user_login = Some("login".into());
            scope.variables = Some(doc! { "a": "1", text: text });
            pair(scope.to_document()?, scope.prepare(ctx))
        }
        ("commanduservariables", "basic") => {
            let vars = NewCommandUserVariables {
                command_id: oid(7)?,
                channel_id: "c".into(),
                user_id: "u".into(),
                variables: Some(doc! { "n": "1" }),
            };
            pair(vars.to_document()?, vars.prepare(ctx))
        }
        ("timer_commands", "basic") => {
            let timer = NewTimerCommand {
                command: "!hola".into(),
                timer: JsNumber(15.0),
                channel: "c".into(),
                channel_id: "1".into(),
            };
            pair(timer.to_document()?, timer.prepare(ctx))
        }
        ("custom_timers", "trimmed") => {
            let timer = NewCustomTimer::new(
                "  pad  ",
                format!(" {text} "),
                10,
                Some(FrequencyUnit::Minutes),
                "c",
                "1",
            )?;
            pair(timer.to_document()?, timer.prepare(ctx))
        }
        ("countdowntimers", "basic") => {
            let countdown = NewCountdown {
                channel: "c".into(),
                channel_id: "1".into(),
                start_time: JsNumber(7200.0),
            };
            pair(countdown.to_document()?, countdown.prepare(ctx))
        }
        ("countdowntimerconfigs", "basic") => {
            let config = CountdownConfig {
                id: None,
                channel: "c".into(),
                channel_id: "1".into(),
                bits: JsNumber(1.0),
                tier1: JsNumber(300.0),
                tier2: JsNumber(600.0),
                tier3: JsNumber(900.0),
                follows: JsNumber(0.0),
                raids: JsNumber(60.0),
                viewers: JsNumber(1.5),
                donations: JsNumber(30.0),
            };
            pair(bson::serialize_to_document(&config)?, config.prepare(ctx))
        }
        ("streamsessions", "live") => {
            let mut session = NewStreamSession::new("111", "s9", ms("2020-01-02T03:04:05.006Z")?);
            session.channel = Some("seed".into());
            session.last_seen_live_at = Some(ms("2021-06-07T08:09:10.011Z")?);
            pair(session.to_document()?, session.prepare(ctx))
        }
        ("domain_event_deliveries", "basic") => {
            let delivery = NewDelivery {
                consumer: "chat".into(),
                topic: "channel".into(),
                event_id: oid(0x900)?,
                event_key: "e1".into(),
                status: None,
                expires_at: ms("2021-06-07T08:09:10.011Z")?,
            };
            pair(delivery.to_document()?, delivery.prepare(ctx))
        }
        ("domain_event_checkpoints", "basic") => {
            let checkpoint = NewCheckpoint {
                consumer: "chat".into(),
                topic: "channel".into(),
                last_event_id: oid(0x900)?,
            };
            pair(checkpoint.to_document()?, checkpoint.prepare(ctx))
        }
        ("admins", "admin") => {
            let admin = NewAdmin {
                channel_id: Some("111".into()),
                channel_name: Some("seed".into()),
                admin_id: Some("42".into()),
                admin_name: Some("mod".into()),
                permissions: Some(vec!["commands".into(), "timers".into()]),
                actived: Some(true),
                role: None,
            };
            pair(admin.to_document()?, admin.prepare(ctx))
        }
        ("admins", "empty") => {
            let admin = NewAdmin::default();
            pair(admin.to_document()?, admin.prepare(ctx))
        }
        ("app_configs", "config") => {
            let config = NewAppConfig {
                name: "domdimabot".into(),
                access_token: EncryptedToken {
                    iv: Some("i".into()),
                    content: Some("c".into()),
                }
                .into(),
            };
            pair(config.to_document()?, config.prepare(ctx))
        }
        ("events", "event") => {
            let localized = |en: &str, es: &str| Localized {
                en: en.into(),
                es: es.into(),
            };
            let event = NewEvent {
                name: "  Follow ".into(),
                kind: " channel.follow ".into(),
                condition: doc! { "broadcaster_user_id": "user", "moderator_user_id": "user" },
                icon: " heart ".into(),
                color: " #f00 ".into(),
                text_color: "#fff".into(),
                description: localized(&format!(" {text} "), "Seguir"),
                config: vec![
                    NewControl {
                        id: " msg ".into(),
                        db_id: Some("message".into()),
                        label: localized("Message", "Mensaje"),
                        kind: None,
                        value: Bson::String("thanks".into()),
                        can_disable: None,
                        placeholder: Some(" type here ".into()),
                        show_if: None,
                    },
                    NewControl {
                        id: "tiers".into(),
                        db_id: None,
                        label: localized("Tiers", "Niveles"),
                        kind: Some(ControlType::MessageTiers),
                        value: Bson::Array(vec![Bson::Document(doc! { "min": 1, "message": "x" })]),
                        can_disable: Some(true),
                        placeholder: None,
                        show_if: Some(doc! { "controlId": "msg", "is": true }),
                    },
                ],
                version: None,
                release_stage: Some(ReleaseStage::Beta),
                enabled: None,
                plan_tier: Some(PlanTier::Premium),
            };
            pair(event.to_document()?, event.prepare(ctx))
        }
        ("domain_events", "full" | "empty_objects" | "defaults") => {
            let t1 = ms("2020-01-02T03:04:05.006Z")?;
            let t2 = ms("2021-06-07T08:09:10.011Z")?;
            let mut event = NewDomainEvent {
                id: Some(oid(0x500)?),
                event_key: "twitch-eventsub:abc:channel.follow".into(),
                source: "twitch-eventsub".into(),
                source_event_id: "abc".into(),
                kind: "channel.follow".into(),
                topic: Topic::Channel,
                schema_version: Some(JsNumber(1.0)),
                owner_user_id: Some("000000000000000000000001".into()),
                subject: Some(NewSubject {
                    provider: "twitch".into(),
                    kind: SubjectKind::StreamingAccount,
                    id: "111".into(),
                }),
                channel_id: Some("111".into()),
                stream_id: None,
                occurred_at: t1,
                journaled_at: Some(t2),
                payload: doc! { "user": { "id": "9", "login": text } }.into(),
                metadata: Some(
                    doc! { "originalEventType": "channel.follow", "durableChatHandled": true },
                ),
                dispatch_pending: Some(true),
                expires_at: t2,
            };
            if key == "empty_objects" {
                event.id = Some(oid(0x501)?);
                event.event_key = "k2".into();
                event.source_event_id = "k2".into();
                event.payload = doc! {}.into();
                event.metadata = Some(doc! {});
                event.subject = None;
                event.owner_user_id = None;
            }
            if key == "defaults" {
                event = NewDomainEvent {
                    id: Some(oid(0x502)?),
                    event_key: "k3".into(),
                    source: "polar".into(),
                    source_event_id: "k3".into(),
                    kind: "order.paid".into(),
                    topic: Topic::Domain,
                    schema_version: None,
                    owner_user_id: None,
                    subject: Some(NewSubject {
                        provider: "polar".into(),
                        kind: SubjectKind::Customer,
                        id: "cus_1".into(),
                    }),
                    channel_id: None,
                    stream_id: None,
                    occurred_at: t1,
                    journaled_at: None,
                    payload: doc! { "a": 1 }.into(),
                    metadata: None,
                    dispatch_pending: None,
                    expires_at: t2,
                };
            }
            pair(event.to_document()?, event.prepare_journal(ctx))
        }
        ("commands", "command") => {
            let mut command = NewCommand::new("111");
            command.name = Some("hola".into());
            command.cmd = Some("!hola".into());
            command.activation = Some(Activation::Command);
            command.func = Some("custom".into());
            command.message = Some(format!("hola {text}"));
            command.authoring = Some(commands::Authoring::Text);
            command.blocks = Some(Bson::Null.into());
            command.responses = Some(Vec::new());
            command.kind = Some("command".into());
            command.reserved = Some(false);
            command.description = String::new().into();
            command.cooldown = Some(JsNumber(10.0));
            command.enabled = Some(true);
            command.user_level_name = Some("everyone".into());
            command.user_level = Some(JsNumber(0.0));
            command.permission_expression = Some(Bson::Null);
            command.channel = Some("seed".into());
            pair(command.to_document()?, command.prepare(ctx))
        }
        ("commands", "restored") => {
            // The restore path (`command_mutations.service.ts:371`) passes a stored null through.
            let mut command = NewCommand::new("111");
            command.cmd = Some("!old".into());
            command.description = Nullable::Null;
            pair(command.to_document()?, command.prepare(ctx))
        }
        ("users", "signup_until_null") => {
            let user = NewUser {
                name: Some("n".into()),
                plan_tier: Some(PlanTier::Free),
                plan_tier_until: Nullable::Null,
                ..NewUser::default()
            };
            pair(user.to_document()?, user.prepare(ctx))
        }
        ("commands", "keyword") => {
            let mut command = NewCommand::new("111");
            command.cmd = Some("gg".into());
            command.activation = Some(Activation::Keyword);
            command.keyword_match_mode = Some(NewKeywordSettings {
                match_mode: MatchMode::Anywhere,
            });
            command.func = Some("custom".into());
            pair(command.to_document()?, command.prepare(ctx))
        }
        ("redemptionrewards", "reward") => {
            let reward = NewRedemptionReward {
                eventsub_id: "sub-1".into(),
                channel_id: "111".into(),
                channel: "seed".into(),
                reward_id: "r9".into(),
                title: text.into(),
                original_cost: JsNumber(100.0),
                cost: JsNumber(150.0),
                kind: None,
                message: Some("gracias".into()),
                is_enabled: None,
            };
            pair(reward.to_document()?, reward.prepare(ctx))
        }
        ("accounts", "account") => {
            let account = NewSignIn {
                user_id: Some("111".into()),
                user_login: Some("seed".into()),
                user_email: Some("seed@example.com".into()),
                channel_id: Some("111".into()),
                channel_name: Some(text.into()),
                user_type: Some(String::new()),
                user_token: Some(token().into()),
                user_refresh_token: Some(token().into()),
            };
            pair(account.to_document()?, account.prepare(ctx))
        }
        ("accounts", "empty") => {
            let account = NewSignIn::default();
            pair(account.to_document()?, account.prepare(ctx))
        }
        ("channelconfigs", "config") => {
            let config = NewChannelConfig {
                channel_id: Some(oid(0x11)?),
                channel: Some(text.into()),
                commands: Some(vec![Bson::Document(doc! { "cmd": "!a", "n": 1.5 })]),
                created_at: Some(ms("2020-01-02T03:04:05.006Z")?),
                date: Some(ChannelConfigDate {
                    day: Some("2".into()),
                    month: Some("1".into()),
                    year: Some("2020".into()),
                }),
            };
            pair(config.to_document()?, config.prepare(ctx))
        }
        ("channelconfigs", "empty") => {
            let config = NewChannelConfig::default();
            pair(config.to_document()?, config.prepare(ctx))
        }
        ("oauth_clients", "client") => {
            let client = NewOAuthClient {
                client_id: "dima-desktop".into(),
                name: text.into(),
                kind: ClientType::Public,
                redirect_uris: vec![
                    "http://127.0.0.1/oauth/callback".into(),
                    "http://[::1]/oauth/callback".into(),
                ],
                allowed_scopes: vec!["desktop:connect".into(), "pet:receive".into()],
                enabled: None,
            };
            pair(client.to_document()?, client.prepare(ctx))
        }
        ("oauth_grants", "grant") => {
            let grant = NewOAuthGrant {
                user_id: oid(0x11)?,
                client_id: "dima-desktop".into(),
                channel_id: "111".into(),
                scopes: vec!["desktop:connect".into()],
            };
            pair(grant.to_document()?, grant.prepare(ctx))
        }
        ("oauth_refresh_tokens", "token") => {
            let record = NewOAuthRefreshToken {
                token_hash: "aGFzaA".into(),
                session_id: oid(0x31)?,
                expires_at: ms("2021-06-07T08:09:10.011Z")?,
            };
            pair(record.to_document()?, record.prepare(ctx))
        }
        ("oauth_sessions", "session") => {
            let session = NewOAuthSession {
                grant_id: oid(0x21)?,
                user_id: oid(0x11)?,
                client_id: "dima-desktop".into(),
                channel_id: "111".into(),
                device_name: text.into(),
                scopes: vec!["desktop:connect".into()],
                current_refresh_hash: "h1".into(),
                last_used_at: ms("2020-01-02T03:04:05.006Z")?,
                idle_expires_at: ms("2021-06-07T08:09:10.011Z")?,
                expires_at: ms("2021-06-07T08:09:10.011Z")?,
            };
            pair(session.to_document()?, session.prepare(ctx))
        }
        ("cron_job_intents", "queued" | "plain") => {
            let job = |id: &str, channel: Bson| {
                doc! {
                    "id": id, "job": "stream_offline_summary", "channelID": channel, "accountID": "acc",
                    "dedupeKey": "dk", "requestedAt": "2020-01-02T03:04:05.006Z", "requestedBy": "bot",
                    "data": { "source": "eventsub", "reason": text, "notBeforeUnix": 1_577_934_245 },
                }
            };
            let t1 = ms("2020-01-02T03:04:05.006Z")?;
            let t2 = ms("2021-06-07T08:09:10.011Z")?;
            let intent = if key == "queued" {
                NewCronJobIntent {
                    job_id: "job-1".into(),
                    queue_key: "queue:a".into(),
                    payload: job("job-1", Bson::String("111".into())),
                    status: IntentStatus::Queued,
                    automatic_key: Some("auto-1".into()),
                    active_key: "active-1".into(),
                    dedupe_until: t2,
                    due_at: t1,
                    next_publish_at: t1,
                }
            } else {
                NewCronJobIntent {
                    job_id: "job-2".into(),
                    queue_key: "queue:a".into(),
                    payload: job("job-2", Bson::Null),
                    status: IntentStatus::LegacyAccepted,
                    automatic_key: None,
                    active_key: "active-2".into(),
                    dedupe_until: t2,
                    due_at: t1,
                    next_publish_at: t1,
                }
            };
            pair(intent.to_document()?, intent.prepare(ctx))
        }
        ("site_analytics", "snapshot") => {
            let snapshot = NewSiteAnalytics {
                registered_users: Some(JsNumber(10.0)),
                live_users: Some(JsNumber(1.0)),
                total_live_viewers: Some(JsNumber(12.0)),
                authorized_accounts: Some(JsNumber(9.0)),
                total_messages: Some(JsNumber(3_000_000_000.0)),
                total_commands: Some(JsNumber(1.5)),
                live_channels: Some(vec![NewLiveChannel {
                    channel_id: Some("111".into()),
                    channel: Some("seed".into()),
                    stream_id: Some("s1".into()),
                    title: Some(text.into()),
                    game_name: Some("Just Chatting".into()),
                    viewers: Some(JsNumber(12.0)),
                    profile_image_url: Some("https://example.com/a.png".into()),
                    started_at: Some("2020-01-02T03:04:05Z".into()),
                    fetched_at: Some("2020-01-02T03:05:00.000Z".into()),
                    bot_platforms: Some(vec![BotPlatform::Twitch, BotPlatform::Kick]),
                    plan_tier: Some(PlanTier::Pro),
                }]),
                ..NewSiteAnalytics::default()
            };
            pair(snapshot.to_document()?, snapshot.prepare(ctx))
        }
        ("site_analytics", "defaults") => {
            let snapshot = NewSiteAnalytics {
                live_channels: Some(vec![NewLiveChannel {
                    channel_id: Some("1".into()),
                    ..NewLiveChannel::default()
                }]),
                ..NewSiteAnalytics::default()
            };
            pair(snapshot.to_document()?, snapshot.prepare(ctx))
        }
        ("ai_usage_receipts", "usage" | "adjustment" | "wide") => {
            let mut receipt = NewAiUsageReceipt {
                channel_id: "111".into(),
                customer_id: "cus_1".into(),
                entry_id: "e1".into(),
                request_id: "req-1".to_owned().into(),
                occurred_at: ms("2020-01-02T03:04:05.006Z")?,
                entry_kind: EntryKind::Usage,
                category: "chat".into(),
                operation: "ai.chat".into(),
                source: "twitch_chat".to_owned().into(),
                adjustment_type: Nullable::Null,
                provider: "openrouter".into(),
                model: "m-1".to_owned().into(),
                quantity: JsNumber(1200.0).into(),
                unit: "tokens".to_owned().into(),
                credits: JsNumber(7.0),
                resource_type: Nullable::Null,
                resource_id: Nullable::Null,
                itemized: true,
                retention_tier: RetentionTier::Premium,
                expires_at: ms("2021-06-07T08:09:10.011Z")?,
            };
            match key {
                "usage" => receipt.category = text.into(),
                "adjustment" => {
                    receipt.entry_id = "e2".into();
                    receipt.request_id = Nullable::Null;
                    receipt.entry_kind = EntryKind::Adjustment;
                    receipt.source = Nullable::Null;
                    receipt.adjustment_type = "grant".to_owned().into();
                    receipt.model = Nullable::Null;
                    receipt.quantity = Nullable::Null;
                    receipt.unit = Nullable::Null;
                    receipt.credits = JsNumber(-50.0);
                    receipt.itemized = false;
                }
                _ => {
                    receipt.entry_id = "e3".into();
                    receipt.credits = JsNumber(3_000_000_000.0);
                    receipt.quantity = JsNumber(2.5).into();
                }
            }
            pair(receipt.to_document()?, receipt.prepare(ctx))
        }
        ("ai_usage_dailies", "day" | "empty_categories") => {
            let day = if key == "day" {
                NewAiUsageDaily {
                    channel_id: "111".into(),
                    customer_id: "cus_1".into(),
                    date: "2020-01-02".into(),
                    day_start: ms("2020-01-02T03:04:05.006Z")?,
                    spent_credits: JsNumber(7.0),
                    granted_credits: JsNumber(50.0),
                    net_consumed_credits: JsNumber(-43.0),
                    transaction_count: JsNumber(1.0),
                    categories: doc! { text: { "credits": 7, "transactionCount": 1 } },
                    retention_tier: RetentionTier::Premium,
                    expires_at: ms("2021-06-07T08:09:10.011Z")?,
                }
            } else {
                NewAiUsageDaily {
                    channel_id: "111".into(),
                    customer_id: "cus_1".into(),
                    date: "2020-01-03".into(),
                    day_start: ms("2021-06-07T08:09:10.011Z")?,
                    spent_credits: JsNumber(0.0),
                    granted_credits: JsNumber(5.0),
                    net_consumed_credits: JsNumber(-5.0),
                    transaction_count: JsNumber(0.0),
                    categories: doc! {},
                    retention_tier: RetentionTier::Free,
                    expires_at: ms("2021-06-07T08:09:10.011Z")?,
                }
            };
            pair(day.to_document()?, day.prepare(ctx))
        }
        ("ai_usage_ledger_states", "state") => {
            let state = NewAiUsageLedgerState {
                channel_id: "111".into(),
                customer_id: "cus_1".into(),
                coverage_start: ms("2020-01-02T03:04:05.006Z")?,
                backfilled_at: ms("2021-06-07T08:09:10.011Z")?,
                report_version: None,
            };
            pair(state.to_document()?, state.prepare(ctx))
        }
        ("ai_usage_dashboards", "dashboard") => {
            let dashboard = NewAiUsageDashboard {
                key: "k".repeat(64),
                channel_id: "111".into(),
                customer_id: "cus_1".into(),
                plan_tier: "pro".into(),
                request: doc! {
                    "channelID": "111", "customerId": "cus_1", "planTier": "pro", "window": { "days": 30 },
                }
                .into(),
                data: doc! { "summary": { "spent": 7, "label": text } },
                dirty: Some(false),
                refreshed_at: ms("2020-01-02T03:04:05.006Z")?,
                expires_at: ms("2021-06-07T08:09:10.011Z")?,
            };
            pair(dashboard.to_document()?, dashboard.prepare(ctx))
        }
        ("creditgifts", "gift") => {
            let t1 = ms("2020-01-02T03:04:05.006Z")?;
            let gift = NewCreditGift {
                id: "a".repeat(64),
                buyer_id: oid(0x11)?,
                recipient_id: oid(0x12)?,
                buyer_login: "buyer".into(),
                recipient_login: "recipient".into(),
                recipient_name: text.into(),
                recipient_channel_id: "222".into(),
                product_id: "prod_1".into(),
                fulfillment_product_id: "prod_f".into(),
                benefit_id: "ben_1".into(),
                credits: JsNumber(500.0),
                price_amount: JsNumber(499.0),
                price_currency: "usd".into(),
                status: GiftStatus::AwaitingPayment,
                no_refunds_acknowledged_at: t1,
                next_attempt_at: t1,
            };
            pair(gift.to_document()?, gift.prepare(ctx))
        }
        ("credittransactions", "referral") => {
            let credit = NewCreditTransaction {
                user: oid(0x21)?,
                kind: TransactionType::ReferralBonus,
                amount: JsNumber(250.0),
                idempotency_key: None,
                metadata: NewCreditMetadata {
                    referral_code_used: "abc".to_owned().into(),
                    referred_user_id: Some(oid(0x11)?),
                    subscription_id: Some("sub_1".into()),
                    plan_id: Some("prod_1".into()),
                    description: Some(format!("Referral bonus for {text}")),
                    ..NewCreditMetadata::default()
                },
            };
            pair(credit.to_document()?, credit.prepare(ctx))
        }
        ("credittransactions", "null_code") => {
            let credit = NewCreditTransaction {
                user: oid(0x21)?,
                kind: TransactionType::SubscriptionReward,
                amount: JsNumber(100.0),
                idempotency_key: None,
                metadata: NewCreditMetadata {
                    referral_code_used: Nullable::Null,
                    referred_user_id: Some(oid(0x11)?),
                    subscription_id: Some("sub_2".into()),
                    plan_id: Some("prod_1".into()),
                    description: Some("d".into()),
                    external_reference: Some("ext".into()),
                    reward_target_type: Some(RewardTarget::Bot),
                },
            };
            pair(credit.to_document()?, credit.prepare(ctx))
        }
        ("referralcodes", "code") => {
            let code = NewReferralCode {
                code: "MyCode_1".into(),
                owner: oid(0x11)?,
                label: Some(text.into()),
                stats: Some(NewReferralStats {
                    conversions: JsNumber(0.0),
                }),
                active: None,
            };
            pair(code.to_document()?, code.prepare(ctx))
        }
        ("channelextensionitems", "media" | "tts") => {
            let mut item = NewChannelExtensionItem {
                channel_id: "111".into(),
                channel_name: "seed".into(),
                created_by_user_id: "111".into(),
                description: Some(format!(" {text} ")),
                bits_price: JsNumber(100.0),
                sku: "dimafx_100".into(),
                volume: Some(JsNumber(80.0)),
                is_enabled: Some(true),
                sort_order: Some(JsNumber(0.0)),
                name: " Clip ".into(),
                asset_id: oid(0x41)?.into(),
                category: ItemCategory::Video,
                media_type: MediaType::Video,
                thumbnail_url: Some("https://example.com/t.png".into()),
                duration_ms: Some(JsNumber(5000.0)),
                tts: None,
            };
            if key == "tts" {
                item.name = "TTS message".into();
                item.asset_id = Nullable::Null;
                item.category = ItemCategory::Tts;
                item.media_type = MediaType::Audio;
                item.thumbnail_url = Some(String::new());
                item.duration_ms = Some(JsNumber(0.0));
                item.tts = Some(NewItemTts {
                    mode: TtsMode::Fixed,
                    text: format!(" {text} "),
                    voice: " es_voice ".into(),
                    language: TtsLanguage::Es,
                });
            }
            pair(item.to_document()?, item.prepare(ctx))
        }
        ("userextensioninventories", "wallet") => {
            let wallet = NewUserExtensionInventory {
                platform: ExtensionPlatform::Twitch,
                user_id: "u1".into(),
                channel_id: "111".into(),
                display_name: None,
                balance: Some(JsNumber(0.0)),
                config: Some(NewInventoryConfig {
                    quick_purchase_priority: QuickPurchasePriority::CreditsFirst,
                    quick_purchase_action: QuickPurchaseAction::UseNow,
                }),
                items: Some(Vec::new()),
            };
            pair(wallet.to_document()?, wallet.prepare(ctx))
        }
        ("userextensioninventories", "items") => {
            let wallet = NewUserExtensionInventory {
                platform: ExtensionPlatform::Twitch,
                user_id: "u2".into(),
                channel_id: "111".into(),
                display_name: Some(text.into()),
                balance: None,
                config: None,
                items: Some(vec![NewInventoryItem {
                    channel_extension_item_id: oid(1)?,
                    quantity: JsNumber(2.0),
                    purchase_price_bits: JsNumber(100.0),
                    acquired_at: None,
                    source: ItemSource::Gift,
                }]),
            };
            pair(wallet.to_document()?, wallet.prepare(ctx))
        }
        ("extensionwallettransactions", "bits" | "anonymous" | "refund") => {
            let mut entry = NewExtensionWalletTransaction {
                platform: ExtensionPlatform::Twitch,
                user_id: "u1".to_owned().into(),
                opaque_user_id: Nullable::Null,
                channel_id: "111".into(),
                kind: WalletTransactionType::BitsPurchase,
                amount_bits: JsNumber(100.0),
                balance_delta: JsNumber(0.0),
                channel_extension_item_id: Some(oid(0x51)?),
                twitch_transaction_id: "tx1".to_owned().into(),
                sku: Some("dimafx_100".into()),
                metadata:
                    doc! { "action": "use_now", "fulfillment": "pending", "viewerText": text }
                        .into(),
            };
            if key == "anonymous" {
                entry.user_id = Nullable::Null;
                entry.opaque_user_id = "Uopaque".to_owned().into();
                entry.twitch_transaction_id = "tx2".to_owned().into();
                entry.metadata = doc! { "action": "use_now", "fulfillment": "pending" }.into();
            }
            if key == "refund" {
                entry.opaque_user_id = Nullable::Unset;
                entry.kind = WalletTransactionType::RefundCredit;
                entry.amount_bits = JsNumber(25.0);
                entry.balance_delta = JsNumber(2.5);
                entry.twitch_transaction_id = Nullable::Unset;
                entry.sku = None;
                entry.metadata = doc! { "reason": "channel_extension_item_deleted" }.into();
            }
            pair(entry.to_document()?, entry.prepare(ctx))
        }
        ("dimafxplaybacks", "job") => {
            let job = NewDimafxPlayback {
                id: "bits-1".into(),
                channel_id: "111".into(),
                payload: doc! {
                    "triggerID": "bits-1", "channelID": "111", "itemID": "i1", "name": text,
                    "category": "tts", "volume": 100, "durationMs": 0,
                    "tts": { "text": text, "voice": "", "language": "es" },
                    "refundOnFailure": { "userID": "u1", "priceBits": 100 },
                    "source": "bits_purchase", "enqueuedAt": 1_577_934_245_006_i64,
                }
                .into(),
                state: Some(PlaybackState::Queued),
                lease_owner: Some(String::new()),
                lease_until: Some(JsDate(0)),
            };
            pair(job.to_document()?, job.prepare(ctx))
        }
        ("channel_fish_voice_favorites", "favorites") => {
            let favorites = NewChannelFishVoiceFavorites {
                channel_id: "111".into(),
                favorites: vec![FishVoiceFavorite {
                    id: "m1".into(),
                    name: text.into(),
                    alias: "gojo_2".into(),
                }],
            };
            pair(favorites.to_document()?, favorites.prepare(ctx))
        }
        ("channel_tts_settings", "settings") => {
            let settings = NewChannelTtsSettings {
                channel_id: "111".into(),
                channel: "seed".into(),
                enabled: true,
                provider: dima_model::channel_tts_settings::TtsProvider::Fish,
                default_language: dima_model::channel_tts_settings::TtsLanguage::En,
                voices: NewTtsVoices {
                    en: "en_US-ryan-medium".into(),
                    es: "es_MX-ald-medium".into(),
                    clone_default: "m1".into(),
                    kokoro_default: "af_heart".into(),
                },
                filters: NewTtsFilters {
                    skip_emotes: false,
                    strip_links: true,
                    normalize_whitespace: true,
                    max_length: JsNumber(300.0),
                    expressive_tags: expressive_tags_document(&["sad", "clear throat"]),
                },
                queue: NewTtsQueue {
                    max_items: JsNumber(7.0),
                },
            };
            pair(settings.to_document()?, settings.prepare(ctx))
        }
        ("channel_tts_settings", "minimal") => {
            let given = doc! { "channelID": "222" };
            let prepared = dima_model::channel_tts_settings::INFO.prepare_create(&given, ctx);
            pair(given, prepared)
        }
        ("channelaimemories", "memory") => {
            let t1 = ms("2020-01-02T03:04:05.006Z")?;
            let memory = NewChannelAiMemory {
                id: oid(0x61)?,
                qdrant_point_id: JsNumber(123_456_789.0),
                channel_id: "111".into(),
                channel: "seed".into(),
                kind: MemoryType::KnownUserFact,
                status: MemoryStatus::PendingReview,
                risk: MemoryRisk::Medium,
                confidence: JsNumber(0.7),
                subject: NewMemorySubject {
                    scope: SubjectScope::User,
                    username: "viewer".into(),
                    user_id: "9".into(),
                },
                content: text.into(),
                summary: format!("sum {text}").into(),
                fingerprint: "fp1".into(),
                source_evidence: vec![NewMemoryEvidence {
                    source: MemorySource::Chat,
                    username: "viewer".into(),
                    user_id: "9".into(),
                    message: text.into(),
                    message_id: "m1".into(),
                    timestamp: JsNumber(1_577_934_245.0),
                }]
                .into(),
                created_by: NewMemoryActor {
                    source: MemorySource::System,
                    username: String::new(),
                    user_id: String::new(),
                },
                review_reason: "awaiting_review".into(),
                created_at: t1,
                updated_at: t1,
            };
            pair(memory.to_document()?, memory.prepare(ctx))
        }
        ("channelaimemories", "defaults") => {
            let given = doc! {
                "channelID": "111", "type": "channel_lore", "content": "c", "summary": "s",
                "fingerprint": "fp2", "sourceEvidence": [{ "message": "hi", "timestamp": 5 }],
            };
            let prepared = dima_model::channel_ai_memories::INFO.prepare_create(&given, ctx);
            pair(given, prepared)
        }
        ("channelaipersonalities", "default" | "profiles" | "no_owner" | "too_many") => {
            let t1 = ms("2020-01-02T03:04:05.006Z")?;
            let profile = |id: &str, created: bool| -> Document {
                let mut profile = doc! {
                    "profileID": id, "name": format!("Profile {id}"),
                    "personality": format!("I am {id} {text}"), "personaMode": "inspired",
                    "personaReference": "Gojo", "tonePreset": "dark_humor",
                    "voiceProfile": {
                        "tone": format!("tone {id}"), "cadence": "short and dynamic",
                        "style": "chat-native and expressive", "catchphrases": ["ey"],
                    },
                };
                if created {
                    profile.insert("createdAt", t1.to_bson());
                }
                profile.insert("updatedAt", t1.to_bson());
                profile
            };
            let mut personality = NewChannelAiPersonality {
                channel_id: "111".into(),
                channel: "seed".into(),
                ..NewChannelAiPersonality::default()
            };
            let owner = match key {
                "default" => {
                    personality.stream_summaries_enabled = Some(true);
                    personality.recommendations_enabled = Some(true);
                    personality.context_window = Some(JsNumber(15.0));
                    personality.personality = Some(format!("friendly {text}"));
                    personality.rules = Some(vec!["Be respectful and friendly with users".into()]);
                    personality.known_users = Some(
                        vec![NewKnownUser {
                            username: "cdom201".into(),
                            description: "Creator".into(),
                            relationship: "professional".into(),
                            last_interaction: t1,
                        }]
                        .into(),
                    );
                    Some("pro")
                }
                "profiles" => {
                    personality.profiles = Some(vec![profile("p1", true), profile("p2", false)]);
                    personality.active_profile_id = Some("p2".into());
                    Some("premium")
                }
                "too_many" => {
                    personality.profiles = Some(vec![profile("p1", true), profile("p2", true)]);
                    Some("free")
                }
                _ => None,
            };
            pair(personality.to_document()?, personality.prepare(owner, ctx))
        }
        ("mediaassets", "upload" | "thumbnail") => {
            let mut asset = NewMediaAsset {
                legacy_trigger_file_id: Nullable::Null,
                owner_user_id: "u1".into(),
                owner_channel_id: "111".into(),
                owner_channel_name: "seed".into(),
                uploaded_by_user_id: "u1".into(),
                original_name: format!("{text}.mp4"),
                display_name: text.into(),
                file_name: "clip-1.mp4".into(),
                extension: "mp4".into(),
                mime_type: "video/mp4".into(),
                media_type: MediaType::Video,
                bytes: JsNumber(3_000_000_000.0),
                bucket: "media".into(),
                s3_key: "private/video/111/clip-1.mp4".into(),
                storage_url: "https://cdn.example.com/clip-1.mp4".into(),
                proxy_path: Nullable::Null,
                scope: AssetScope::Private,
                marketplace_status: Some(MarketplaceStatus::NotListed),
                checksum_sha256: Nullable::Null,
                thumbnail_asset_id: Nullable::Null,
                thumbnail_status: Some(ThumbnailStatus::Pending),
                thumbnail_attempts: Some(JsNumber(0.0)),
                thumbnail_last_error: Nullable::Null,
                library_count: Some(JsNumber(1.0)),
                trigger_reference_count: Some(JsNumber(0.0)),
                alert_reference_count: None,
                extension_reference_count: None,
                deleted_at: Nullable::Null,
            };
            if key == "thumbnail" {
                asset.legacy_trigger_file_id = Nullable::Unset;
                asset.original_name = "a.mp4.thumb.jpg".into();
                asset.display_name = "a (thumbnail)".into();
                asset.file_name = "clip-1.mp4.thumb.jpg".into();
                asset.extension = "jpg".into();
                asset.mime_type = "image/jpeg".into();
                asset.media_type = MediaType::Image;
                asset.bytes = JsNumber(2048.0);
                asset.s3_key = "system/thumb/1.jpg".into();
                asset.storage_url = "https://cdn.example.com/1.jpg".into();
                asset.scope = AssetScope::System;
                asset.thumbnail_asset_id = Nullable::Unset;
                asset.thumbnail_status = None;
                asset.thumbnail_attempts = None;
                asset.thumbnail_last_error = Nullable::Unset;
                asset.library_count = Some(JsNumber(0.0));
                asset.alert_reference_count = Some(JsNumber(0.0));
                asset.extension_reference_count = Some(JsNumber(0.0));
            }
            pair(asset.to_document()?, asset.prepare(ctx))
        }
        ("usermedialibraryitems", "upload" | "public") => {
            let mut item = NewUserMediaLibraryItem {
                channel_id: "111".into(),
                channel_name: "seed".into(),
                added_by_user_id: "u1".into(),
                asset_id: oid(1)?,
                relation_type: RelationType::OwnerUpload,
                local_alias: Nullable::Null,
                quota_bytes_charged: JsNumber(3_000_000_000.0),
                asset_scope: LibraryAssetScope::Private,
                media_type: MediaType::Video,
                is_active: Some(true),
                deleted_at: Nullable::Null,
            };
            if key == "public" {
                item.relation_type = RelationType::PublicLibraryAdd;
                item.quota_bytes_charged = JsNumber(0.0);
                item.asset_scope = LibraryAssetScope::Public;
                item.media_type = MediaType::Gif;
            }
            pair(item.to_document()?, item.prepare(ctx))
        }
        _ => bail!("{collection}: no typed input named {key}"),
    }
}

fn oid(n: u32) -> Result<ObjectId> {
    Ok(ObjectId::parse_str(format!("{n:024x}"))?)
}

/// `Model.create(doc)` for a case without a typed input (and for validation cases).
fn create(
    info: &CollectionInfo,
    given: &Document,
    ctx: &mut WriteContext,
) -> Result<PreparedInsert, ModelError> {
    info.prepare_create(given, ctx)
}

fn changes_of(value: &Value) -> Result<Vec<Change>> {
    let mut out = Vec::new();
    for change in value.as_array().context("changes")? {
        if let Some(path) = change.get("set").and_then(Value::as_str) {
            out.push(Change::set(
                path,
                bson_of(change.get("value").context("value")?)?,
            ));
        } else if let Some(path) = change.get("unset").and_then(Value::as_str) {
            out.push(Change::unset(path));
        } else if let Some(path) = change.get("push").and_then(Value::as_str) {
            let values = change
                .get("values")
                .and_then(Value::as_array)
                .context("values")?;
            out.push(Change::push(
                path,
                values.iter().map(bson_of).collect::<Result<Vec<_>>>()?,
            ));
        } else {
            bail!("unknown change {change}");
        }
    }
    Ok(out)
}

fn update_options(intent: &Value) -> Result<dima_model::UpdateOptions> {
    let options = intent.get("options");
    let mut out = if options
        .and_then(|o| o.get("upsert"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        UpdateOptions::upsert()
    } else {
        UpdateOptions::default()
    };
    if let Some(filters) = options
        .and_then(|o| o.get("arrayFilters"))
        .and_then(Value::as_array)
    {
        out = out.array_filters(
            filters
                .iter()
                .map(document_of)
                .collect::<Result<Vec<_>>>()?,
        );
    }
    let model = dima_model::UpdateOptions::from(out);
    let run_validators = options
        .and_then(|o| o.get("runValidators"))
        .and_then(Value::as_bool)
        == Some(true);
    Ok(if run_validators {
        model.run_validators()
    } else {
        model
    })
}

// --------------------------------------------------------------------------------------- running

async fn stored(store: &MongoStore, collection: &str) -> Result<Vec<Document>> {
    Ok(store
        .documents(collection)
        .find(doc! {})
        .sort(doc! { "_id": 1 })
        .await?
        .try_collect()
        .await?)
}

/// What one case did on the Rust side.
#[derive(Default)]
struct Outcome {
    /// The error, as the recording writes it.
    error: Option<Value>,
    /// The document `findOneAndUpdate` returned.
    result: Option<Bson>,
    /// The writes that were sent, in the recording's reduced form.
    sent: Vec<Bson>,
}

fn update_doc(update: &dima_store::mongo::update::UpdateDoc) -> Bson {
    match update {
        dima_store::mongo::update::UpdateDoc::Document(document) => {
            Bson::Document(document.clone())
        }
        dima_store::mongo::update::UpdateDoc::Pipeline(stages) => {
            Bson::Array(stages.iter().cloned().map(Bson::Document).collect())
        }
    }
}

/// An `update` command as the recorder reduces it.
fn sent_update(
    filter: &Document,
    update: Bson,
    upsert: bool,
    multi: bool,
    array_filters: Option<&Vec<Document>>,
) -> Bson {
    let mut entry = doc! { "q": filter.clone(), "u": update };
    if upsert {
        entry.insert("upsert", true);
    }
    if multi {
        entry.insert("multi", true);
    }
    if let Some(filters) = array_filters {
        entry.insert(
            "arrayFilters",
            filters
                .iter()
                .cloned()
                .map(Bson::Document)
                .collect::<Vec<_>>(),
        );
    }
    Bson::Document(doc! { "op": "update", "updates": [entry] })
}

/// Runs one recorded case through the Rust side.
async fn run_case(store: &MongoStore, case: &Value, now_ms: i64) -> Result<Outcome> {
    let collection = case
        .get("collection")
        .and_then(Value::as_str)
        .context("collection")?;
    let op = case.get("op").and_then(Value::as_str).context("op")?;
    let intent = case.get("intent").context("intent")?;
    let info = info(collection)?;
    let mut ctx = WriteContext::with_sequential_ids(now_ms, 1);
    let mut writes = store.writes(collection);
    let random = support::entry::CountingRandom::default();
    let writer = if intent.get("internal").and_then(Value::as_bool) == Some(true) {
        Writer::Internal
    } else {
        Writer::Client
    };
    let mut outcome = Outcome::default();
    match op {
        "create" | "journal" => {
            let prepared = match case.get("rust").and_then(Value::as_str) {
                Some(key) => {
                    let (given, prepared) = match typed_create(collection, key, &mut ctx) {
                        Err(error) => match error.downcast::<ModelError>() {
                            Ok(ModelError::Refused { message, .. }) => {
                                outcome.error = Some(serde_json::json!({ "hook": message }));
                                return Ok(outcome);
                            }
                            Ok(other) => return Err(other.into()),
                            Err(other) => return Err(other),
                        },
                        Ok(pair) => pair,
                    };
                    let expected = bson_of(intent.get("doc").context("doc")?)?;
                    if !same_values(&Bson::Document(given.clone()), &expected) {
                        bail!("typed input {key} gives {given:?}, the case creates {expected:?}");
                    }
                    prepared
                }
                None => create(
                    info,
                    &document_of(intent.get("doc").context("doc")?)?,
                    &mut ctx,
                )?,
            };
            if op == "journal" {
                writes = writes.write_concern(domain_events::journal_write_concern());
            }
            outcome.sent.push(Bson::Document(
                doc! { "op": "insert", "documents": [prepared.document.clone()] },
            ));
            if let Err(error) = writes.insert_one(&prepared).await {
                outcome.error = Some(Value::String(write_error(&error)));
            }
        }
        "validate" => {
            match create(
                info,
                &document_of(intent.get("doc").context("doc")?)?,
                &mut ctx,
            ) {
                Ok(_) => {}
                Err(ModelError::Validation(error)) => {
                    outcome.error = Some(validation_json(&error));
                }
                Err(other) => return Err(other.into()),
            }
        }
        "updateOne" | "updateMany" => {
            let filter = document_of(intent.get("filter").context("filter")?)?;
            let options = update_options(intent)?;
            let raw_update = intent.get("update").context("update")?;
            let pipeline = raw_update.is_array();
            let prepared = match raw_update.as_array() {
                // A pipeline: the write guard cannot check one, so the documents it leaves are
                // decoded below (the write-then-read test such a caller owes).
                Some(stages) => info.prepare_pipeline_update_unchecked(
                    &filter,
                    stages.iter().map(document_of).collect::<Result<Vec<_>>>()?,
                    options.store,
                    &mut ctx,
                ),
                None => support::entry::update(
                    info,
                    &filter,
                    document_of(raw_update)?,
                    options,
                    writer,
                    &mut ctx,
                    &random,
                ),
            };
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(ModelError::Validation(error)) => {
                    outcome.error = Some(validation_json(&error));
                    return Ok(outcome);
                }
                Err(other) => return Err(other.into()),
            };
            if let Some(update) = &prepared.update {
                outcome.sent.push(sent_update(
                    &prepared.filter,
                    update_doc(update),
                    prepared.upsert,
                    op == "updateMany",
                    prepared.array_filters.as_ref(),
                ));
            }
            let result = if op == "updateOne" {
                writes.update_one(&prepared).await
            } else {
                writes.update_many(&prepared).await
            };
            if let Err(error) = result {
                outcome.error = Some(Value::String(write_error(&error)));
            }
            if pipeline {
                for document in stored(store, collection).await? {
                    let raw = bson::RawDocumentBuf::try_from(&document)?;
                    if let Err(error) = (info.decode)(&raw) {
                        bail!(
                            "{collection}: a pipeline left a document the read type cannot read: {error}"
                        );
                    }
                }
            }
        }
        "findOneAndUpdate" => {
            let filter = document_of(intent.get("filter").context("filter")?)?;
            let update = document_of(intent.get("update").context("update")?)?;
            let returned = if intent.pointer("/options/new").and_then(Value::as_bool) == Some(true)
            {
                Returned::After
            } else {
                Returned::Before
            };
            let options = update_options(intent)?;
            let prepared = match support::entry::find_one_and_update(
                info, &filter, update, options, returned, writer, &mut ctx, &random,
            ) {
                Ok(prepared) => prepared,
                Err(ModelError::Validation(error)) => {
                    outcome.error = Some(validation_json(&error));
                    return Ok(outcome);
                }
                Err(other) => return Err(other.into()),
            };
            if let Some(update) = &prepared.update {
                let mut sent = doc! {
                    "op": "findAndModify",
                    "query": prepared.filter.clone(),
                    "update": update_doc(update),
                };
                if prepared.upsert {
                    sent.insert("upsert", true);
                }
                sent.insert("new", returned == Returned::After);
                outcome.sent.push(Bson::Document(sent));
            }
            let found = writes.find_one_and_update(&prepared).await?;
            outcome.result = found.map(|mut document| {
                // Mongoose's command projects the hidden paths out; the result is the same.
                dima_store::mongo::json::remove_paths(&mut document, info.hidden);
                Bson::Document(document)
            });
        }
        "save" => {
            let id = bson_of(intent.get("id").context("id")?)?;
            let loaded = info
                .load_for_save(store, &doc! { "_id": id }, &mut ctx)
                .await?
                .context("the document to save is missing")?;
            let changes = changes_of(intent.get("changes").context("changes")?)?;
            let owner = intent.get("owner").and_then(Value::as_str);
            let prepared = support::entry::save(info, &loaded, &changes, owner, &mut ctx, &random);
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(ModelError::Validation(error)) => {
                    outcome.error = Some(validation_json(&error));
                    return Ok(outcome);
                }
                Err(ModelError::Refused { message, .. }) => {
                    outcome.error = Some(serde_json::json!({ "hook": message }));
                    return Ok(outcome);
                }
                Err(other) => return Err(other.into()),
            };
            if let Some(update) = &prepared.update {
                outcome.sent.push(sent_update(
                    &prepared.filter,
                    Bson::Document(update.clone()),
                    false,
                    false,
                    None,
                ));
            }
            writes.save(&prepared).await?;
        }
        other => bail!("unknown op {other}"),
    }
    Ok(outcome)
}

/// A validation error as the recording writes it.
fn validation_json(error: &dima_model::ValidationError) -> Value {
    serde_json::json!({
        "name": "ValidationError",
        "message": error.to_string(),
        "errors": error.errors.iter().map(|e| serde_json::json!({
            "path": e.path, "kind": e.kind.as_str(), "message": e.message,
        })).collect::<Vec<_>>(),
    })
}

fn write_error(error: &dima_store::mongo::write::WriteError) -> String {
    match error {
        dima_store::mongo::write::WriteError::Driver(driver)
            if dima_store::mongo::error::is_duplicate_key(driver) =>
        {
            "duplicate key".to_owned()
        }
        other => other.to_string(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn indexes_match_mongoose() -> Result<()> {
    let recording = recording()?;
    support::with_store(|store| async move {
        let mut problems = Vec::new();
        let recorded: HashSet<&str> = recording
            .indexes
            .iter()
            .filter_map(|r| r.get("collection").and_then(Value::as_str))
            .collect();
        for info in REGISTRY {
            if !recorded.contains(info.name) {
                problems.push(format!("{}: no index recording (add it to record.mts)", info.name));
            }
        }
        for record in &recording.indexes {
            let collection = record.get("collection").and_then(Value::as_str).context("collection")?;
            let info = info(collection)?;
            let first = ensure_indexes(&store, info, IndexPolicy::RequireAll, DEADLINE).await;
            if first.outcomes.iter().any(|o| !matches!(o.status, IndexStatus::Created)) {
                problems.push(format!("{collection}: on an empty database\n{first}"));
            }
            // Idempotent, like `Model.init()` on every start: nothing left to create.
            let again = ensure_indexes(&store, info, IndexPolicy::RequireAll, DEADLINE).await;
            if again.outcomes.iter().any(|o| !matches!(o.status, IndexStatus::Exists)) {
                problems.push(format!("{collection} (second run)\n{again}"));
            }
            let listed = list_indexes(&store, collection).await?;
            let expected = record.get("indexes").and_then(Value::as_array).context("indexes")?;
            let mut expected_specs: Vec<String> = expected
                .iter()
                .map(|v| document_of(v).map(|d| canonical(Bson::Document(index_spec(d)))))
                .collect::<Result<_>>()?;
            let mut actual_specs: Vec<String> = listed
                .into_iter()
                .map(|d| canonical(Bson::Document(index_spec(d))))
                .collect();
            expected_specs.sort();
            actual_specs.sort();
            if expected_specs != actual_specs {
                problems.push(format!(
                    "{collection}: indexes differ\n  mongoose {expected_specs:?}\n  rust     {actual_specs:?}"
                ));
            }
        }
        if !problems.is_empty() {
            bail!("{}", problems.join("\n"));
        }
        eprintln!("indexes of {} collections match", recording.indexes.len());
        Ok(())
    })
    .await
}

/// The top-level fields an upsert's filter copies into the document it inserts (its equality
/// conditions). Empty for every other case.
fn upsert_equality_fields(case: &Value) -> HashSet<String> {
    let upsert = case
        .pointer("/intent/options/upsert")
        .and_then(Value::as_bool)
        == Some(true);
    let filter = case.pointer("/intent/filter").and_then(Value::as_object);
    let (true, Some(filter)) = (upsert, filter) else {
        return HashSet::new();
    };
    filter
        .iter()
        .filter(|(key, value)| {
            // An operator condition (`{$gt: …}`) is not copied; Extended JSON wrappers
            // (`{$oid: …}`) are plain values.
            let operator = value.as_object().is_some_and(|o| {
                o.keys().any(|k| {
                    k.starts_with('$')
                        && bson_of(value).is_ok_and(|b| matches!(b, Bson::Document(_)))
                })
            });
            !key.starts_with('$') && !operator
        })
        .map(|(key, _)| key.clone())
        .collect()
}

/// The server copies an upsert filter's equality fields right after `_id` in an order that varies
/// from run to run (`dima-store`'s golden test found the same with the Node driver): that run of
/// fields, and only it, is sorted on both sides.
fn copied_fields_sorted(value: Bson, copied: &HashSet<String>) -> Bson {
    if copied.is_empty() {
        return value;
    }
    let sort = |document: Document| -> Document {
        let mut entries: Vec<(String, Bson)> = document.into_iter().collect();
        let start = usize::from(entries.first().is_some_and(|(k, _)| k == "_id"));
        let run = entries
            .iter()
            .skip(start)
            .take_while(|(k, _)| copied.contains(k))
            .count();
        if run == copied.len()
            && let Some(slice) = entries.get_mut(start..start + run)
        {
            slice.sort_by(|a, b| a.0.cmp(&b.0));
        }
        entries.into_iter().collect()
    };
    match value {
        Bson::Array(items) => Bson::Array(
            items
                .into_iter()
                .map(|item| match item {
                    Bson::Document(document) => Bson::Document(sort(document)),
                    other => other,
                })
                .collect(),
        ),
        Bson::Document(document) => Bson::Document(sort(document)),
        other => other,
    }
}

/// The index specifications exactly as the server lists them (`listIndexes`).
async fn list_indexes(store: &MongoStore, collection: &str) -> Result<Vec<Document>> {
    let reply = store
        .database()
        .run_command(doc! { "listIndexes": collection })
        .await?;
    let batch = reply
        .get_document("cursor")
        .and_then(|cursor| cursor.get_array("firstBatch"))
        .map_err(|e| anyhow!("{collection}: listIndexes reply: {e}"))?;
    batch
        .iter()
        .map(|spec| match spec {
            Bson::Document(spec) => Ok(spec.clone()),
            other => bail!("{collection}: index {other:?}"),
        })
        .collect()
}

/// An index specification without the version field, keys in a fixed order.
fn index_spec(document: Document) -> Document {
    let mut keys: Vec<(String, Bson)> = document.into_iter().filter(|(k, _)| k != "v").collect();
    keys.sort_by(|a, b| a.0.cmp(&b.0));
    keys.into_iter().collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_match_mongoose() -> Result<()> {
    let recording = recording()?;
    support::with_store(|store| async move {
        let mut problems = Vec::new();
        let mut covered: HashSet<&str> = HashSet::new();
        // Mongoose's `autoIndex` created every index before the recorded cases ran.
        for info in REGISTRY {
            ensure_indexes(&store, info, IndexPolicy::RequireAll, DEADLINE)
                .await
                .require()?;
        }
        for case in &recording.cases {
            let collection = case
                .get("collection")
                .and_then(Value::as_str)
                .context("collection")?;
            let name = case.get("name").and_then(Value::as_str).context("name")?;
            covered.insert(collection);
            store.documents(collection).delete_many(doc! {}).await?;
            let seed: Vec<Document> = case
                .get("seed")
                .and_then(Value::as_array)
                .context("seed")?
                .iter()
                .map(document_of)
                .collect::<Result<_>>()?;
            if !seed.is_empty() {
                store
                    .documents(collection)
                    .insert_many(seed.clone())
                    .await?;
            }
            let Outcome {
                error,
                result,
                sent,
            } = match run_case(&store, case, recording.now_ms).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    problems.push(format!("{collection}/{name}: {error:#}"));
                    continue;
                }
            };
            // A case marked `refused` is one Rust refuses on purpose (the write guard): a
            // refusal, nothing sent, the seed unchanged.
            if let Some(reason) = case.get("refused") {
                let kinds: Vec<&str> = error
                    .as_ref()
                    .and_then(|e| e.get("errors"))
                    .and_then(Value::as_array)
                    .map(|errors| {
                        errors
                            .iter()
                            .filter_map(|e| e.get("kind").and_then(Value::as_str))
                            .collect()
                    })
                    .unwrap_or_default();
                let guard = !kinds.is_empty()
                    && kinds.iter().all(|k| matches!(*k, "type" | "null" | "missing"));
                let after = stored(&store, collection).await?;
                if !guard || !sent.is_empty() || after != seed {
                    problems.push(format!(
                        "{collection}/{name}: must be refused ({reason}), got {error:?}, sent {sent:?}"
                    ));
                }
                continue;
            }
            // The error (if any) the reference reported.
            let expected_error =
                case.get("error")
                    .map(|e| match e.get("code").and_then(Value::as_i64) {
                        Some(11000) => Value::String("duplicate key".into()),
                        _ => e.clone(),
                    });
            // A case marked `differs` is one Rust accepts on purpose (it names the rule).
            let expected_error = expected_error.filter(|_| case.get("differs").is_none());
            if expected_error != error {
                problems.push(format!(
                    "{collection}/{name}: error\n  mongoose {}\n  rust     {}",
                    expected_error.map_or_else(|| "none".into(), |v| v.to_string()),
                    error.map_or_else(|| "none".into(), |v| v.to_string()),
                ));
            }
            let intent = bson_of(case.get("intent").context("intent")?)?;
            let seed_bson = Bson::Array(seed.into_iter().map(Bson::Document).collect());
            // Generated ids are numbered walking the commands, then the result, then the stored
            // documents, as the recorder does.
            let mut normaliser = Normaliser::new(&[&seed_bson, &intent]);
            let sent = canonical(normaliser.walk(Bson::Array(sent)));
            let expected_sent = canonical(bson_of(case.get("commands").context("commands")?)?);
            if sent != expected_sent {
                problems.push(format!(
                    "{collection}/{name}: commands\n  mongoose {expected_sent}\n  rust     {sent}"
                ));
            }
            let result = result.map(|r| normaliser.walk(r));
            let actual: Vec<Bson> = stored(&store, collection)
                .await?
                .into_iter()
                .map(|d| normaliser.walk(Bson::Document(d)))
                .collect();
            let copied = upsert_equality_fields(case);
            let actual = canonical(copied_fields_sorted(Bson::Array(actual), &copied));
            let expected = canonical(copied_fields_sorted(
                bson_of(case.get("stored").context("stored")?)?,
                &copied,
            ));
            if actual != expected {
                problems.push(format!(
                    "{collection}/{name}: stored\n  mongoose {expected}\n  rust     {actual}"
                ));
            }
            if let Some(expected) = case.get("result") {
                // The upserted document a `findOneAndUpdate` returns has the copied fields in the
                // server's varying order too.
                let actual = result.map(|r| canonical(copied_fields_sorted(r, &copied)));
                let expected = canonical(copied_fields_sorted(bson_of(expected)?, &copied));
                if actual.as_deref() != Some(expected.as_str()) {
                    problems.push(format!(
                        "{collection}/{name}: result\n  mongoose {expected}\n  rust     {actual:?}"
                    ));
                }
            }
        }
        for info in REGISTRY {
            if !covered.contains(info.name) {
                problems.push(format!("{}: no write cases recorded", info.name));
            }
        }
        if !problems.is_empty() {
            bail!("{} problems:\n{}", problems.len(), problems.join("\n"));
        }
        eprintln!("{} recorded writes match", recording.cases.len());
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unique_indexes_report_duplicates() -> Result<()> {
    support::with_store(|store| async move {
        let mut checked = 0;
        for info in REGISTRY {
            let Some(unique) = info.indexes.iter().find(|spec| spec.unique) else {
                continue;
            };
            ensure_indexes(&store, info, IndexPolicy::RequireAll, DEADLINE)
                .await
                .require()?;
            // Two documents with the same values on the unique keys (and on a partial filter's
            // fields): the second insert must fail with E11000 naming the index.
            let mut document = doc! {};
            for (key, _) in unique.keys {
                if *key != "_id" {
                    insert_path(&mut document, key, Bson::String("same".into()));
                }
            }
            if let Some(filter) = unique.partial_filter {
                for (key, value) in filter() {
                    // An operator (`{$type: 'string'}`) is met by the value already there.
                    let operator =
                        matches!(&value, Bson::Document(d) if d.keys().any(|k| k.starts_with('$')));
                    if !operator {
                        insert_path(&mut document, &key, value);
                    }
                }
            }
            let collection = store.documents(info.name);
            collection.insert_one(document.clone()).await?;
            let Err(error) = collection.insert_one(document).await else {
                bail!("{}: duplicate on {} was accepted", info.name, unique.name());
            };
            let duplicate = dima_store::mongo::error::duplicate_key(&error)
                .with_context(|| format!("{}: not a duplicate-key error: {error}", info.name))?;
            if duplicate.index.as_deref() != Some(unique.name().as_str()) {
                bail!(
                    "{}: duplicate reported on {:?}, expected {}",
                    info.name,
                    duplicate.index,
                    unique.name()
                );
            }
            checked += 1;
        }
        eprintln!("duplicate keys detected on {checked} unique indexes");
        Ok(())
    })
    .await
}

fn insert_path(document: &mut Document, path: &str, value: Bson) {
    match path.split_once('.') {
        None => {
            document.insert(path, value);
        }
        Some((head, rest)) => {
            if !matches!(document.get(head), Some(Bson::Document(_))) {
                document.insert(head, doc! {});
            }
            if let Some(Bson::Document(inner)) = document.get_mut(head) {
                insert_path(inner, rest, value);
            }
        }
    }
}

/// A generic update must not skip a collection's update middleware: the collection's module is
/// the only way in (saves: `writes::tests::hooked_collections_refuse_generic_saves`).
#[test]
fn hooked_collections_refuse_generic_updates() -> Result<()> {
    let mut ctx = WriteContext::new(0);
    for info in REGISTRY {
        let update = info.prepare_update(
            &doc! {},
            doc! { "$set": { "x": 1 } },
            UpdateOptions::default(),
            &mut ctx,
        );
        let refused = matches!(update, Err(ModelError::Hooked { .. }));
        if refused != (info.hooks == dima_model::Hooks::UpdatesAndSave) {
            bail!("{}: generic update refused: {refused}", info.name);
        }
    }
    Ok(())
}

/// A save hydrates the loaded document and writes the defaults of the paths it lacks; the only
/// loaded document a save accepts is a whole one, so `select: false` paths survive a save.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saves_keep_hidden_paths() -> Result<()> {
    support::with_store(|store| async move {
        let info = &dima_model::stream_sessions::INFO;
        let mut ctx = WriteContext::with_sequential_ids(1_794_392_430_456, 1);
        let session =
            NewStreamSession::new("111", "s1", JsDate(1_700_000_000_000)).prepare(&mut ctx)?;
        let mut document = session.document.clone();
        document.insert("applied_domain_event_keys", vec!["k0", "k1"]);
        // Without the projection a normal read uses: the field a hidden path default would erase.
        let id = document.get_object_id("_id")?;
        store.documents(info.name).insert_one(document).await?;
        let loaded = info
            .load_for_save(&store, &doc! { "_id": id.to_hex() }, &mut ctx)
            .await?
            .context("loaded")?;
        let save = info.prepare_save(&loaded, &[Change::set("status", "offline")], &mut ctx)?;
        if let Some(update) = &save.update
            && update
                .get_document("$set")
                .is_ok_and(|set| set.contains_key("applied_domain_event_keys"))
        {
            bail!("the save overwrites a hidden path: {update}");
        }
        store.writes(info.name).save(&save).await?;
        let stored = store
            .documents(info.name)
            .find_one(doc! { "_id": id })
            .await?
            .context("stored")?;
        if stored.get_array("applied_domain_event_keys")?.len() != 2 {
            bail!("hidden path lost: {stored}");
        }
        // A document loaded from one collection cannot be saved to another.
        let wrong = dima_model::custom_timers::INFO.prepare_save(&loaded, &[], &mut ctx);
        if !matches!(wrong, Err(ModelError::WrongCollection { .. })) {
            bail!("a save to another collection must be refused: {wrong:?}");
        }
        Ok(())
    })
    .await
}

/// Reads for HTTP responses leave out the `select: false` paths unless the projection names them,
/// cast the filter like Mongoose, and render like Express.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_reads_hide_select_false_paths() -> Result<()> {
    support::with_store(|store| async move {
        let mut ctx = WriteContext::with_sequential_ids(1_794_392_430_456, 1);
        let mut command = NewCommand::new("111");
        command.cmd = Some("!hola".into());
        command.blocks = Some(Bson::Document(doc! { "v": 1, "root": {} }).into());
        let prepared = command.prepare(&mut ctx)?;
        let id = prepared.document.get_object_id("_id")?;
        store
            .writes(commands::COLLECTION)
            .insert_one(&prepared)
            .await?;
        let info = &commands::INFO;
        // A string id is cast to the ObjectId, as Mongoose casts it.
        let filter = doc! { "_id": id.to_hex() };
        let one = info
            .find_one_json(&store, &filter, &mut ctx)
            .await?
            .context("found")?;
        if one.get("blocks").is_some() || one.get("cmd") != Some(&Value::String("!hola".into())) {
            bail!("findOne rendered {one}");
        }
        if one.get("_id") != Some(&Value::String(id.to_hex())) {
            bail!("_id must render as hex text: {one}");
        }
        let all = info
            .find_json(
                &store,
                &doc! { "channelID": "111" },
                Default::default(),
                &mut ctx,
            )
            .await?;
        if all.len() != 1 || all.iter().any(|d| d.get("blocks").is_some()) {
            bail!("find rendered {all:?}");
        }
        // An inclusion projection that names a hidden path gets it (Mongoose's `+blocks`).
        let mut options = mongodb::options::FindOptions::default();
        options.projection = Some(doc! { "blocks": 1, "cmd": 1 });
        let selected = info.find_json(&store, &doc! {}, options, &mut ctx).await?;
        if selected.first().and_then(|d| d.get("blocks")).is_none() {
            bail!("an explicit projection must select blocks: {selected:?}");
        }
        // A bad id is Mongoose's CastError, before anything is sent.
        if info
            .find_one_json(&store, &doc! { "_id": "nope" }, &mut ctx)
            .await
            .is_ok()
        {
            bail!("an invalid ObjectId must fail to cast");
        }
        Ok(())
    })
    .await
}

/// Index creation reports every index, honours its deadline and the caller's policy; the
/// preflight lists every difference and changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn index_reports_policies_and_preflight() -> Result<()> {
    support::with_store(|store| async move {
        let journal = &dima_model::domain_events::INFO;
        let sessions = &dima_model::stream_sessions::INFO;
        // No time at all: nothing is done, and the journal's unique indexes are missing.
        let late = ensure_indexes(
            &store,
            journal,
            IndexPolicy::RequireUnique,
            std::time::Duration::ZERO,
        )
        .await;
        if !late
            .outcomes
            .iter()
            .all(|o| matches!(o.status, IndexStatus::Failed(IndexError::Deadline(_))))
        {
            bail!("a zero deadline must fail every index:\n{late}");
        }
        let Err(missing) = late.require() else {
            bail!("the journal's unique indexes are required");
        };
        if missing.missing.len() != journal.indexes.iter().filter(|s| s.unique).count() {
            bail!("only the unique indexes are required: {missing}");
        }
        // An older index of the same name with other options: reported, the others created.
        store
            .documents(sessions.name)
            .create_index(
                mongodb::IndexModel::builder()
                    .keys(doc! { "status": 1 })
                    .options(
                        mongodb::options::IndexOptions::builder()
                            .sparse(true)
                            .build(),
                    )
                    .build(),
            )
            .await?;
        let report = ensure_indexes(&store, sessions, IndexPolicy::BestEffort, DEADLINE).await;
        let conflict = report
            .outcomes
            .iter()
            .find(|o| o.index == "status_1")
            .context("status_1")?;
        if !matches!(
            conflict.status,
            IndexStatus::Failed(IndexError::Conflict { .. })
        ) {
            bail!("the conflict must be reported:\n{report}");
        }
        if report.failures().count() != 1 || report.require().is_err() {
            bail!("best effort: one failure, nothing required:\n{report}");
        }
        if ensure_indexes(&store, sessions, IndexPolicy::RequireAll, DEADLINE)
            .await
            .require()
            .is_ok()
        {
            bail!("RequireAll must refuse the conflicting index");
        }
        let journal_report =
            ensure_indexes(&store, journal, IndexPolicy::RequireUnique, DEADLINE).await;
        journal_report.require()?;
        // The preflight: the conflict, a dropped index, an undeclared one, a missing collection.
        store
            .documents(journal.name)
            .drop_index("channelID_1")
            .await?;
        store
            .documents(journal.name)
            .create_index(
                mongodb::IndexModel::builder()
                    .keys(doc! { "extra": 1 })
                    .build(),
            )
            .await?;
        let before = list_indexes(&store, journal.name).await?;
        // `channelconfigs` is not initialised at start-up: reported apart, not as missing.
        let infos = [
            journal,
            sessions,
            &dima_model::users::INFO,
            &dima_model::channel_configs::INFO,
        ];
        let preflight = preflight_indexes(&store, &infos, DEADLINE).await?;
        let skipped = dima_model::index::NotInitialised {
            collection: "channelconfigs",
            exists: false,
        };
        if preflight.not_initialised != [skipped] {
            bail!("not initialised: {:?}", preflight.not_initialised);
        }
        let differences = preflight.differences;
        let after = list_indexes(&store, journal.name).await?;
        if before != after {
            bail!("the preflight changed the indexes");
        }
        let found: Vec<String> = differences.iter().map(ToString::to_string).collect();
        let expected = |d: &IndexDifference| match d {
            IndexDifference::Missing {
                collection,
                declared,
            } => {
                *collection == journal.name && declared.get_str("name").ok() == Some("channelID_1")
            }
            IndexDifference::Undeclared { collection, stored } => {
                *collection == journal.name && stored.get_str("name").ok() == Some("extra_1")
            }
            IndexDifference::Differs {
                collection, stored, ..
            } => *collection == sessions.name && stored.get_str("name").ok() == Some("status_1"),
            IndexDifference::MissingCollection { collection } => *collection == "users",
        };
        if differences.len() != 4 || !differences.iter().all(expected) {
            bail!("preflight differences:\n{}", found.join("\n"));
        }
        Ok(())
    })
    .await
}
