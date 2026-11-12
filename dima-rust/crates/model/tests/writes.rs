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
use dima_model::admins::{self, NewAdmin};
use dima_model::app_configs::{self, NewAppConfig};
use dima_model::ast_variables::NewAstVariables;
use dima_model::availability::Writer;
use dima_model::command_user_variables::NewCommandUserVariables;
use dima_model::commands::{self, Activation, MatchMode, NewCommand, NewKeywordSettings};
use dima_model::countdown_timers::{CountdownConfig, NewCountdown};
use dima_model::custom_timers::{FrequencyUnit, NewCustomTimer};
use dima_model::domain_event_checkpoints::NewCheckpoint;
use dima_model::domain_event_deliveries::NewDelivery;
use dima_model::domain_events::{self, NewDomainEvent, NewSubject, SubjectKind, Topic};
use dima_model::events::{self, ControlType, Localized, NewControl, NewEvent, ReleaseStage};
use dima_model::eventsubs::NewEventsub;
use dima_model::redemption_rewards::{self, NewRedemptionReward};
use dima_model::stream_sessions::NewStreamSession;
use dima_model::timer_commands::NewTimerCommand;
use dima_model::users::{
    AccountType, EncryptedToken, Language, NewAccount, NewUser, PlanTier, TtsProvider,
};
use dima_model::{CollectionInfo, ModelError, REGISTRY, ensure_indexes};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::Change;
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

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

/// What the recorder does to its output: generated ObjectIds and UUIDs numbered by first
/// appearance; ids and strings found in the seed or the intent are kept.
struct Normaliser {
    ids: HashSet<ObjectId>,
    strings: HashSet<String>,
    generated: HashMap<ObjectId, ObjectId>,
    uuids: HashMap<String, String>,
}

impl Normaliser {
    fn new(known: &[&Bson]) -> Self {
        let mut normaliser = Self {
            ids: HashSet::new(),
            strings: HashSet::new(),
            generated: HashMap::new(),
            uuids: HashMap::new(),
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

// ---------------------------------------------------------------------------- deterministic ids

/// Random bytes from a counter: distinct, reproducible UUIDs for the hooks' tokens.
#[derive(Debug, Default)]
struct CountingRandom(std::sync::atomic::AtomicU64);

impl dima_core::Random for CountingRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
        for chunk in buf.chunks_mut(8) {
            let next = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            for (slot, byte) in chunk.iter_mut().zip(next.to_le_bytes()) {
                *slot = byte;
            }
        }
        Ok(())
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
        ("users", "empty") => {
            let user = NewUser::default();
            pair(user.to_document()?, user.prepare(ctx))
        }
        ("users", "signup") => {
            let mut account = NewAccount::new(AccountType::Twitch, "222");
            account.name = Some(text.into());
            account.email = Some("new@example.com".into());
            account.refresh_token = Some(token());
            account.access_token = Some(token());
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
                plan_tier_until: Some(ms("2021-06-07T08:09:10.011Z")?),
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
                },
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
                payload: doc! { "user": { "id": "9", "login": text } },
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
                event.payload = doc! {};
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
                    payload: doc! { "a": 1 },
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
            command.blocks = Some(Bson::Null);
            command.responses = Some(Vec::new());
            command.kind = Some("command".into());
            command.reserved = Some(false);
            command.description = Some(String::new());
            command.cooldown = Some(JsNumber(10.0));
            command.enabled = Some(true);
            command.user_level_name = Some("everyone".into());
            command.user_level = Some(JsNumber(0.0));
            command.permission_expression = Some(Bson::Null);
            command.channel = Some("seed".into());
            pair(command.to_document()?, command.prepare(ctx))
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

fn update_options(intent: &Value) -> Result<UpdateOptions> {
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
    Ok(out)
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
    let random = CountingRandom::default();
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
                    let (given, prepared) = typed_create(collection, key, &mut ctx)?;
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
            let update = document_of(intent.get("update").context("update")?)?;
            let options = update_options(intent)?;
            let prepared = match collection {
                "commands" => {
                    commands::prepare_update(&filter, update, options, writer, &mut ctx, &random)?
                }
                "redemptionrewards" => redemption_rewards::prepare_update(
                    &filter, update, options, writer, &mut ctx, &random,
                )?,
                _ => info.prepare_update(&filter, update, options, &mut ctx)?,
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
            let prepared = match collection {
                "commands" => commands::prepare_find_one_and_update(
                    &filter, update, options, returned, writer, &mut ctx, &random,
                )?,
                "redemptionrewards" => redemption_rewards::prepare_find_one_and_update(
                    &filter, update, options, returned, writer, &mut ctx, &random,
                )?,
                _ => {
                    info.prepare_find_one_and_update(&filter, update, options, returned, &mut ctx)?
                }
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
            let prepared = match collection {
                "admins" => admins::prepare_save(&loaded, &changes, &mut ctx),
                "app_configs" => app_configs::prepare_save(&loaded, &changes, &mut ctx),
                "events" => events::prepare_save(&loaded, &changes, &mut ctx),
                "commands" => commands::prepare_save(&loaded, &changes, &mut ctx, &random),
                "redemptionrewards" => {
                    redemption_rewards::prepare_save(&loaded, &changes, &mut ctx, &random)
                }
                _ => info.prepare_save(&loaded, &changes, &mut ctx),
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
            let failures = ensure_indexes(&store, info).await;
            if !failures.is_empty() {
                problems.push(format!("{collection}: {failures:?}"));
            }
            // Idempotent, like `Model.init()` on every start.
            let again = ensure_indexes(&store, info).await;
            if !again.is_empty() {
                problems.push(format!("{collection} (second run): {again:?}"));
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
            let failures = ensure_indexes(&store, info).await;
            if !failures.is_empty() {
                bail!("{}: {failures:?}", info.name);
            }
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
                let actual = result.map(canonical);
                let expected = canonical(bson_of(expected)?);
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
            let failures = ensure_indexes(&store, info).await;
            if !failures.is_empty() {
                bail!("{}: {failures:?}", info.name);
            }
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
                    insert_path(&mut document, &key, value);
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
        command.blocks = Some(Bson::Document(doc! { "v": 1, "root": {} }));
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
