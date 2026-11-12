//! `duel/service.ts`: one `duel_widgets` document per channel: settings, the pending challenge,
//! the run, the overlay token, and the deadlines the completion loop polls.
//!
//! # Writes, and what each compares
//!
//! | Writer | Filter | Sets |
//! |---|---|---|
//! | [`DuelService::configure`] | `{_id, revision}` (journaled) | `settings`, `languageConfigured`, `receipts`, `$inc revision` |
//! | [`DuelService::challenge`] | `{_id, revision}` | `challenge`, `run: null`, `dueAt`, `leaseUntil: 0`, `$inc revision` |
//! | [`DuelService::fight_streamer`] | `{_id, revision}` | `challenge: null`, `run`, `dueAt`, `leaseUntil: 0`, `$inc revision` |
//! | [`DuelService::accept`] | `{_id, revision, challenge.id}` | `challenge: null`, `run`, `dueAt`, `leaseUntil: 0`, `$inc revision` |
//! | [`DuelService::decline`] | `{_id, revision}` | `challenge: null`, `dueAt: null`, `$inc revision` |
//! | [`DuelService::save_token`] | `{_id, tokenHash}` | `tokenHash`, `overlayToken` (`$inc revision` on a replacement) |
//!
//! An accept races another accept (the same viewer twice, or a decline): the one whose
//! revision still matches wins; the other gets 409 `busy` ("This duel was already accepted or
//! changed") and no second run exists. The completion loop's writes are in `completion.rs`.

use std::sync::Arc;
use std::time::Duration;

use bson::{Bson, Document, doc};
use dima_core::{Clock, Random};
use dima_http::guard::BoxFuture;
use dima_model::duel_widgets::{
    self as stored, DuelWidget, DuelWidgetSettingsContent, NewDuelWidget,
};
use dima_model::{Private, UpdateOptions};
use dima_store::mongo::number::{js_number, read_number};
use dima_store::mongo::write::WriteError;
use dima_store::mongo::{MongoStore, WriteContext};
use serde_json::{Map, Value, json};

use super::model::{self, Absent, DuelChallenge, DuelRun, DuelSettings};
use super::stats::DuelStats;
use crate::roulette::input::{RouletteError, integer_number, text_str};
use crate::roulette::service::ServiceError;

/// `CHALLENGE_MS`: how long the challenged viewer has to accept.
pub const CHALLENGE_MS: f64 = 30_000.0;
/// Attempts of a challenge or a fight against the streamer.
pub const ATTEMPTS: usize = 10;
/// How long an idempotency receipt is honoured.
const RECEIPT_MS: f64 = 86_400_000.0;

/// `presenceKey(channel)`: the Dragonfly key the overlay socket refreshes while a duel source
/// is ready (P4-RT-SOCKETS owns it; family *rebuilt*).
pub fn presence_key(channel: &str) -> String {
    format!("widgets:duel:{channel}:connected")
}

/// `tokenHash(value)`: SHA-256 hex.
pub fn token_hash(value: &str) -> String {
    dima_core::crypto::sha256(value).hex()
}

/// The overlay presence (`widgets:duel:{channel}:connected`), read and cleared here, written by
/// the overlay socket (P4-RT-SOCKETS).
pub trait OverlayPresence: Send + Sync {
    /// The stored JSON (`{ hash, at }`), if any.
    fn get<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
    /// Removes it.
    fn clear<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<(), String>>;
}

/// `started` or `ended`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DuelPhase {
    /// Accepted.
    Started,
    /// Completed.
    Ended,
}

/// `duelWidgetEvent(channel, run, phase)`: publishes to custom widgets (P4-FEAT-WIDGETS'
/// widget feed). Fire and forget, as the reference.
pub trait DuelEvents: Send + Sync {
    /// One event.
    fn duel(&self, channel: &str, run: &DuelRun, phase: DuelPhase);
}

/// Typed configuration.
#[derive(Clone, Debug)]
pub struct DuelConfig {
    /// Deadline of each MongoDB call (the reference has none).
    pub deadline: Duration,
    /// Deadline of each Twitch call of the completion (the reference: 10 s on the demotion and
    /// the timeout, none on the lookups).
    pub twitch_deadline: Duration,
    /// The bot's Twitch id (`TWITCH_BOT_ACCOUNT_ID`): never timed out.
    pub bot_id: String,
}

impl Default for DuelConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(10),
            twitch_deadline: Duration::from_secs(10),
            bot_id: dima_twitch::TWITCH_BOT_ACCOUNT_ID.to_owned(),
        }
    }
}

/// A receipt of `configure`.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    key: String,
    fingerprint: String,
    at: f64,
}

/// `DuelDocument` as the service reads it, settings normalized.
#[derive(Clone, Debug)]
pub struct DuelDocument {
    /// `_id`.
    pub id: String,
    /// `revision`.
    pub revision: f64,
    /// `normalizeSettings(settings)`.
    pub settings: DuelSettings,
    /// `challenge`.
    pub challenge: Option<DuelChallenge>,
    /// `run`.
    pub run: Option<DuelRun>,
    /// `tokenHash`.
    pub token_hash: Option<String>,
    /// `dueAt`.
    pub due_at: Option<f64>,
    /// `leaseUntil`.
    pub lease_until: f64,
    /// `statsRevision`.
    pub stats_revision: f64,
    /// `languageConfigured`.
    pub language_configured: bool,
    receipts: Vec<Receipt>,
}

impl DuelDocument {
    /// Reads a stored document.
    pub fn from_document(document: &Document) -> Result<Self, ServiceError> {
        let widget: DuelWidget =
            dima_model::decode_document(document).map_err(ServiceError::store)?;
        let raw = |value: Option<&Bson>| value.filter(|v| !matches!(v, Bson::Null)).cloned();
        let challenge = raw(widget.challenge.as_ref().map(|c| &c.expose().0))
            .map(bson::deserialize_from_bson::<DuelChallenge>)
            .transpose()
            .map_err(ServiceError::store)?;
        let run = raw(widget.run.as_ref().map(|r| &r.expose().0))
            .map(bson::deserialize_from_bson::<DuelRun>)
            .transpose()
            .map_err(ServiceError::store)?;
        Ok(Self {
            id: widget.id,
            revision: widget.revision.0,
            settings: DuelSettings::normalize(widget.settings.as_ref().map(|s| &s.expose().0)),
            challenge,
            run,
            token_hash: widget.token_hash.map(|t| t.expose().clone()),
            due_at: widget.due_at.map(|n| n.0),
            lease_until: widget.lease_until.0,
            stats_revision: widget.stats_revision.0,
            language_configured: widget.language_configured,
            receipts: widget
                .receipts
                .into_iter()
                .flatten()
                .map(|r| Receipt {
                    key: r.key,
                    fingerprint: r.fingerprint,
                    at: r.at.0,
                })
                .collect(),
        })
    }
}

/// `channelId(id)`: 1 to 30 digits.
pub fn check_channel(id: &str) -> Result<(), RouletteError> {
    if (1..=30).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(RouletteError::invalid("Invalid channel ID"))
    }
}

fn busy(message: &str) -> ServiceError {
    RouletteError::new("busy", message, 409).into()
}

/// Duels of every channel.
#[derive(Clone)]
pub struct DuelService {
    pub(crate) mongo: MongoStore,
    pub(crate) clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    presence: Arc<dyn OverlayPresence>,
    pub(crate) events: Arc<dyn DuelEvents>,
    pub(crate) stats: DuelStats,
    pub(crate) config: DuelConfig,
}

impl DuelService {
    /// A service over `mongo`.
    pub fn new(
        mongo: MongoStore,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        presence: Arc<dyn OverlayPresence>,
        events: Arc<dyn DuelEvents>,
        config: DuelConfig,
    ) -> Self {
        let stats = DuelStats::new(mongo.clone(), config.deadline);
        Self {
            mongo,
            clock,
            random,
            presence,
            events,
            stats,
            config,
        }
    }

    /// The statistics (`duel/stats.ts`).
    pub fn stats(&self) -> &DuelStats {
        &self.stats
    }

    pub(crate) async fn within<T, E: std::fmt::Display>(
        &self,
        what: &str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, ServiceError> {
        match tokio::time::timeout(self.config.deadline, future.into_future()).await {
            Ok(result) => result.map_err(ServiceError::store),
            Err(_) => Err(ServiceError::Store {
                message: format!(
                    "{what}: no answer within {} ms",
                    self.config.deadline.as_millis()
                ),
                outcome_unknown: true,
            }),
        }
    }

    /// An update by `filter`; whether it modified (`modified`) or matched (`matched`).
    pub(crate) async fn update(
        &self,
        what: &str,
        filter: Document,
        update: Document,
    ) -> Result<(u64, u64), ServiceError> {
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let prepared =
            stored::INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        let outcome = self.within(what, writes.update_one(&prepared)).await?;
        Ok((outcome.matched, outcome.modified))
    }

    /// The stored document, without creating one.
    pub async fn read(&self, id: &str) -> Result<Option<DuelDocument>, ServiceError> {
        let found = self
            .within(
                "duel_widgets.findById",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": id }),
            )
            .await?;
        found.as_ref().map(DuelDocument::from_document).transpose()
    }

    /// `loadDuel(id)`: the document, created with the default settings on first use.
    pub async fn load(&self, id: &str) -> Result<DuelDocument, ServiceError> {
        check_channel(id)?;
        if let Some(found) = self.read(id).await? {
            return Ok(found);
        }
        let settings = DuelSettings::default()
            .to_bson()
            .map_err(ServiceError::store)?;
        let insert = NewDuelWidget {
            id: id.to_owned(),
            revision: None,
            settings: Private::from(DuelWidgetSettingsContent(Bson::Document(settings))),
            challenge: None,
            run: None,
            token_hash: None,
            overlay_token: None,
            due_at: None,
            lease_until: None,
            stats_revision: None,
            language_configured: None,
            receipts: None,
        }
        .prepare(&mut WriteContext::new(self.clock.now_ms()))?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        match tokio::time::timeout(self.config.deadline, writes.insert_one(&insert)).await {
            Ok(Ok(())) => {}
            Ok(Err(WriteError::Driver(error)))
                if dima_store::mongo::error::is_duplicate_key(&error) => {}
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {
                return Err(ServiceError::Store {
                    message: "duel_widgets.create: no answer in time".into(),
                    outcome_unknown: true,
                });
            }
        }
        self.read(id)
            .await?
            .ok_or_else(|| ServiceError::store("duel document missing after creation"))
    }

    /// `overlayActive(doc)`: an enabled duel with a token whose OBS source reported ready less
    /// than 5 s ago. Any failure reads as not connected (the duel falls back to chat).
    pub async fn overlay_active(&self, doc: &DuelDocument) -> bool {
        let Some(hash) = doc.token_hash.as_deref().filter(|_| doc.settings.enabled) else {
            return false;
        };
        let Ok(Ok(Some(raw))) =
            tokio::time::timeout(self.config.deadline, self.presence.get(&doc.id)).await
        else {
            return false;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            return false;
        };
        let now = self.clock.now_ms() as f64;
        value.get("hash").and_then(Value::as_str) == Some(hash)
            && value
                .get("at")
                .and_then(Value::as_f64)
                .is_some_and(|at| at <= now && now - at < 5000.0)
    }

    /// `hasPremium(id)`: a user owning this Twitch account is on a paid plan.
    async fn has_premium(&self, id: &str) -> Result<bool, ServiceError> {
        let found = self
            .within(
                "users.exists",
                self.mongo
                    .documents(dima_model::users::COLLECTION)
                    .find_one(doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": id } }, "plan_tier": { "$in": ["premium", "pro"] } })
                    .projection(doc! { "_id": 1 }),
            )
            .await?;
        Ok(found.is_some())
    }

    /// `duelLanguage(id, doc)`: free channels keep their account language until they save one.
    pub async fn language(&self, doc: &DuelDocument) -> Result<String, ServiceError> {
        if doc.language_configured || self.has_premium(&doc.id).await? {
            return Ok(doc.settings.language.clone());
        }
        let user = self
            .within(
                "users.findOne",
                self.mongo
                    .documents(dima_model::users::COLLECTION)
                    .find_one(
                        doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": &doc.id } } },
                    )
                    .projection(doc! { "language": 1 }),
            )
            .await?;
        let es = user.as_ref().and_then(|u| u.get_str("language").ok()) == Some("es");
        Ok(if es { "es" } else { "en" }.into())
    }

    async fn with_language(&self, doc: &DuelDocument) -> Result<DuelSettings, ServiceError> {
        let mut settings = doc.settings.clone();
        settings.language = self.language(doc).await?;
        Ok(settings)
    }

    /// `duelSnapshot(id)`.
    pub async fn snapshot(&self, id: &str) -> Result<Value, ServiceError> {
        let doc = self.load(id).await?;
        let now = self.clock.now_ms() as f64;
        let settings = self.with_language(&doc).await?;
        let connected = self.overlay_active(&doc).await;
        let challenge = doc
            .challenge
            .as_ref()
            .filter(|c| c.expires_at > now)
            .map_or(Value::Null, |c| {
                serde_json::to_value(c).unwrap_or(Value::Null)
            });
        let run = doc.run.as_ref().map_or(Value::Null, |run| {
            let mut out = Map::new();
            out.insert("id".into(), json!(run.id));
            out.insert("challenger".into(), json!(run.challenger));
            out.insert("opponent".into(), json!(run.opponent));
            out.insert("winner".into(), json!(run.winner));
            out.insert(
                "fighters".into(),
                serde_json::to_value(&run.fighters).unwrap_or(Value::Null),
            );
            out.insert(
                "turns".into(),
                serde_json::to_value(&run.turns).unwrap_or(Value::Null),
            );
            out.insert("enraged".into(), json!(run.enraged));
            out.insert("mode".into(), json!(run.mode));
            out.insert("startedAt".into(), json!(run.started_at));
            out.insert("endsAt".into(), json!(run.ends_at));
            out.insert("completedAt".into(), json!(run.completed_at));
            if let Some(error) = &run.announcement_error {
                out.insert("announcementError".into(), json!(error));
            }
            if let Some(error) = &run.timeout_error {
                out.insert("timeoutError".into(), json!(error));
            }
            out.insert(
                "record".into(),
                run.record.value().map_or(Value::Null, |r| json!(r)),
            );
            out.insert("maxHp".into(), json!(run.max_hp));
            out.insert("healCharges".into(), json!(run.heal_charges));
            out.insert("tracked".into(), json!(run.is_tracked()));
            Value::Object(out)
        });
        Ok(json!({
            "revision": doc.revision,
            "settings": settings.to_json(),
            "serverTime": now,
            "connected": connected,
            "challenge": challenge,
            "run": run,
        }))
    }

    /// `configureDuel(id, input, revision, key)`: the dashboard's settings, by revision,
    /// idempotent per key for 24 hours.
    pub async fn configure(
        &self,
        id: &str,
        input: &Value,
        revision: f64,
        key: &str,
    ) -> Result<(), ServiceError> {
        integer_number(
            Some(revision),
            "If-Match",
            0,
            crate::roulette::input::MAX_SAFE_INTEGER,
        )?;
        text_str(key, "Idempotency-Key", 128)?;
        let doc = self.load(id).await?;
        let current = self.with_language(&doc).await?;
        let config = model::settings(input, &current)?;
        let fingerprint = token_hash(&dima_text::to_js_json(&config.to_json()));
        let receipt_key = token_hash(key);
        let now = self.clock.now_ms() as f64;
        if let Some(previous) = doc
            .receipts
            .iter()
            .find(|r| r.key == receipt_key && now - r.at < RECEIPT_MS)
        {
            if previous.fingerprint != fingerprint {
                return Err(RouletteError::new(
                    "idempotency_conflict",
                    "Key already used for different settings",
                    409,
                )
                .into());
            }
            return Ok(());
        }
        let conflict = || {
            RouletteError::new(
                "revision_conflict",
                "Duel changed; refresh before saving",
                409,
            )
        };
        if revision != doc.revision {
            return Err(conflict().into());
        }
        let language_configured = doc.language_configured || input.get("language").is_some();
        let mut receipts: Vec<Bson> = doc
            .receipts
            .iter()
            .filter(|r| now - r.at < RECEIPT_MS)
            .map(|r| {
                Bson::Document(
                    doc! { "key": &r.key, "fingerprint": &r.fingerprint, "at": js_number(r.at) },
                )
            })
            .collect();
        receipts.push(Bson::Document(
            doc! { "key": receipt_key, "fingerprint": fingerprint, "at": js_number(now) },
        ));
        let skip = receipts.len().saturating_sub(200);
        let receipts: Vec<Bson> = receipts.into_iter().skip(skip).collect();
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let prepared = stored::INFO.prepare_update(
            &doc! { "_id": id, "revision": js_number(revision) },
            doc! {
                "$set": { "settings": config.to_bson().map_err(ServiceError::store)?, "languageConfigured": language_configured, "receipts": receipts },
                "$inc": { "revision": 1 },
            },
            UpdateOptions::default(),
            &mut ctx,
        )?;
        let journaled = mongodb::options::WriteConcern::builder()
            .w(mongodb::options::Acknowledgment::Nodes(1))
            .journal(true)
            .build();
        let mut writes = self
            .mongo
            .writes(stored::COLLECTION)
            .write_concern(journaled);
        let outcome = self
            .within("duel_widgets.updateOne", writes.update_one(&prepared))
            .await?;
        if outcome.modified == 0 {
            return Err(conflict().into());
        }
        Ok(())
    }

    fn fighting(doc: &DuelDocument, now: f64) -> bool {
        doc.run.as_ref().is_some_and(|r| r.completed_at.is_none())
            || doc.challenge.as_ref().is_some_and(|c| c.expires_at > now)
    }

    fn uuid(&self) -> Result<String, ServiceError> {
        self.random
            .uuid_v4()
            .map_err(|e| ServiceError::store(format!("randomness unavailable: {e}")))
    }

    /// `withRecord`: tracked fights carry the head-to-head record while rivalries are on.
    async fn with_record(
        &self,
        id: &str,
        mut run: DuelRun,
        settings: &DuelSettings,
    ) -> Result<DuelRun, ServiceError> {
        if run.tracked == Some(true) && settings.rivalries {
            run.record = Absent::Value(
                self.stats
                    .head_to_head(id, &run.challenger, &run.opponent)
                    .await?,
            );
        }
        Ok(run)
    }

    /// `challengeDuel(id, challenger, opponent, enraged)`: `(overlay, language)`.
    pub async fn challenge(
        &self,
        id: &str,
        challenger: &str,
        opponent: &str,
        enraged: Option<&str>,
    ) -> Result<(bool, String), ServiceError> {
        for _ in 0..ATTEMPTS {
            let doc = self.load(id).await?;
            let now = self.clock.now_ms() as f64;
            if Self::fighting(&doc, now) {
                return Err(busy(
                    "A duel is already waiting or fighting in this channel",
                ));
            }
            let overlay = self.overlay_active(&doc).await;
            let challenge = DuelChallenge {
                id: self.uuid()?,
                challenger: challenger.to_owned(),
                opponent: opponent.to_owned(),
                expires_at: now + CHALLENGE_MS,
                enraged: enraged.map_or(Absent::Null, |e| Absent::Value(e.to_owned())),
            };
            let mut stored =
                bson::serialize_to_document(&challenge).map_err(ServiceError::store)?;
            if enraged.is_none() {
                stored.insert("enraged", Bson::Null);
            }
            dima_store::mongo::number::normalize_js_numbers(&mut stored);
            let (_, modified) = self
                .update(
                    "duel_widgets.updateOne",
                    doc! { "_id": id, "revision": js_number(doc.revision) },
                    doc! { "$set": { "challenge": stored, "run": Bson::Null, "dueAt": js_number(challenge.expires_at), "leaseUntil": 0 }, "$inc": { "revision": 1 } },
                )
                .await?;
            if modified > 0 {
                return Ok((overlay, self.language(&doc).await?));
            }
        }
        Err(busy("Duel is busy; try again"))
    }

    async fn store_run(
        &self,
        id: &str,
        filter: Document,
        run: &DuelRun,
    ) -> Result<bool, ServiceError> {
        let stored = run.to_bson().map_err(ServiceError::store)?;
        let (_, modified) = self
            .update(
                "duel_widgets.updateOne",
                filter,
                doc! { "$set": { "challenge": Bson::Null, "run": stored, "dueAt": js_number(run.next_deadline()), "leaseUntil": 0 }, "$inc": { "revision": 1 } },
            )
            .await?;
        let _ = id;
        Ok(modified > 0)
    }

    /// `fightStreamer(id, challenger, streamer)`: the enraged streamer always accepts.
    pub async fn fight_streamer(
        &self,
        id: &str,
        challenger: &str,
        streamer: &str,
    ) -> Result<DuelRun, ServiceError> {
        for _ in 0..ATTEMPTS {
            let doc = self.load(id).await?;
            let now = self.clock.now_ms() as f64;
            if Self::fighting(&doc, now) {
                return Err(busy(
                    "A duel is already waiting or fighting in this channel",
                ));
            }
            let challenge = DuelChallenge {
                id: self.uuid()?,
                challenger: challenger.to_owned(),
                opponent: streamer.to_owned(),
                expires_at: now,
                enraged: Absent::Value("right".into()),
            };
            let settings = self.with_language(&doc).await?;
            let overlay = self.overlay_active(&doc).await;
            let run = model::create_run(&challenge, &settings, overlay, now, self.random.as_ref())?;
            let run = self.with_record(id, run, &doc.settings).await?;
            if self
                .store_run(
                    id,
                    doc! { "_id": id, "revision": js_number(doc.revision) },
                    &run,
                )
                .await?
            {
                self.events.duel(id, &run, DuelPhase::Started);
                return Ok(run);
            }
        }
        Err(busy("Duel is busy; try again"))
    }

    /// `acceptDuel(id, opponent)`: the challenged viewer accepts; the fight is decided now.
    pub async fn accept(&self, id: &str, opponent: &str) -> Result<DuelRun, ServiceError> {
        let doc = self.load(id).await?;
        let now = self.clock.now_ms() as f64;
        let Some(challenge) = doc
            .challenge
            .as_ref()
            .filter(|c| c.opponent == opponent && c.expires_at > now)
        else {
            return Err(
                RouletteError::new("missing", "There is no duel challenge to accept", 409).into(),
            );
        };
        let settings = self.with_language(&doc).await?;
        let overlay = self.overlay_active(&doc).await;
        let run = model::create_run(challenge, &settings, overlay, now, self.random.as_ref())?;
        let run = self.with_record(id, run, &doc.settings).await?;
        let filter =
            doc! { "_id": id, "revision": js_number(doc.revision), "challenge.id": &challenge.id };
        if !self.store_run(id, filter, &run).await? {
            return Err(busy("This duel was already accepted or changed"));
        }
        self.events.duel(id, &run, DuelPhase::Started);
        Ok(run)
    }

    /// `declineDuel(id, opponent)`: `(challenger, overlay, language)`.
    pub async fn decline(
        &self,
        id: &str,
        opponent: &str,
    ) -> Result<(String, bool, String), ServiceError> {
        let doc = self.load(id).await?;
        let now = self.clock.now_ms() as f64;
        let Some(challenge) = doc
            .challenge
            .as_ref()
            .filter(|c| c.opponent == opponent && c.expires_at > now)
        else {
            return Err(RouletteError::new(
                "missing",
                "There is no duel challenge to decline",
                409,
            )
            .into());
        };
        let result = (
            challenge.challenger.clone(),
            self.overlay_active(&doc).await,
            self.language(&doc).await?,
        );
        let (_, modified) = self
            .update(
                "duel_widgets.updateOne",
                doc! { "_id": id, "revision": js_number(doc.revision) },
                doc! { "$set": { "challenge": Bson::Null, "dueAt": Bson::Null }, "$inc": { "revision": 1 } },
            )
            .await?;
        if modified == 0 {
            return Err(busy("This duel changed; try again"));
        }
        Ok(result)
    }

    /// `authorizeDuelOverlay(id, token)` without the legacy-URL upgrade (the caller runs
    /// `rememberOverlayToken`, P4-FEAT-OVERLAYS, ignoring its failure).
    pub async fn authorize_overlay(&self, id: &str, token: &str) -> Result<bool, ServiceError> {
        if check_channel(id).is_err()
            || token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Ok(false);
        }
        let found = self
            .within(
                "duel_widgets.exists",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": id, "tokenHash": token_hash(token) })
                    .projection(doc! { "_id": 1 }),
            )
            .await?;
        Ok(found.is_some())
    }

    /// The overlay token store's `read()` (after creating the document).
    pub async fn token_document(
        &self,
        id: &str,
    ) -> Result<crate::roulette::TokenDocument, ServiceError> {
        self.load(id).await?;
        let found = self
            .within(
                "duel_widgets.findById",
                self.mongo
                    .documents(stored::COLLECTION)
                    .find_one(doc! { "_id": id })
                    .projection(doc! { "tokenHash": 1, "overlayToken": 1 }),
            )
            .await?
            .ok_or_else(|| ServiceError::store("duel document missing"))?;
        Ok(crate::roulette::TokenDocument {
            token_hash: found.get_str("tokenHash").ok().map(str::to_owned),
            overlay_token: found
                .get("overlayToken")
                .filter(|v| !matches!(v, Bson::Null))
                .cloned(),
        })
    }

    /// The overlay token store's `save(expectedHash, token, replace)`, token already hashed and
    /// encrypted: `true` when the expected hash still held. `updateOverlayToken` then calls
    /// [`Self::clear_presence`] when the version changed.
    pub async fn save_token(
        &self,
        id: &str,
        expected_hash: Option<&str>,
        new_hash: &str,
        encrypted: Bson,
        replace: bool,
    ) -> Result<bool, ServiceError> {
        let mut update = doc! { "$set": { "tokenHash": new_hash, "overlayToken": encrypted } };
        if replace {
            update.insert("$inc", doc! { "revision": 1 });
        }
        let (matched, _) = self
            .update(
                "duel_widgets.updateOne",
                doc! { "_id": id, "tokenHash": expected_hash.map_or(Bson::Null, Bson::from) },
                update,
            )
            .await?;
        Ok(matched == 1)
    }

    /// Forgets the overlay's presence (after a token change).
    pub async fn clear_presence(&self, id: &str) -> Result<(), ServiceError> {
        match tokio::time::timeout(self.config.deadline, self.presence.clear(id)).await {
            Ok(result) => result.map_err(ServiceError::store),
            Err(_) => Err(ServiceError::store("presence: no answer in time")),
        }
    }

    /// The fields the overlay socket polls, without creating the document.
    pub async fn version(
        &self,
        id: &str,
    ) -> Result<Option<(f64, Option<String>, f64)>, ServiceError> {
        Ok(self
            .read(id)
            .await?
            .map(|d| (d.revision, d.token_hash, d.stats_revision)))
    }
}

/// `revision` of a raw document (for tests and callers that only need it).
pub fn revision_of(document: &Document) -> f64 {
    document
        .get("revision")
        .and_then(read_number)
        .unwrap_or(0.0)
}
