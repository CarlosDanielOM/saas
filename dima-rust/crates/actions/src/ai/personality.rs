//! A channel's AI personality: `getChannelPersonality` of `utils/ai/openrouter/ai.ts` (lines
//! 322–391).
//!
//! 1. The cache, `twitch:{channel}:chatbot:personality` (10 800 s).
//! 2. Else `channelaipersonalities.findOne({channelID})`, cached for 10 800 s.
//! 3. Else a default personality is created for the channel (`Model.create`, through the model's
//!    write helpers with its hooks: the profile built from the persona, the owner's plan
//!    limits, `contextWindow` 35/15/7), cached, and logged.
//!
//! The cache is *rebuilt* at cutover. Its value is Rust's own: the stored document's BSON bytes
//! (the reference cached the document's JSON), read back through the same decoder as a stored
//! document, so a cached and a stored personality read alike. The personality service deletes
//! the key after a save ([`cache_key`]; `ai_personality.service.ts:369`).
//!
//! Kept from the reference:
//!
//! - Two first calls at once for a channel without a personality both create one (no unique
//!   index); later reads take whichever `findOne` returns first.
//! - Creating fails when no user owns the channel (the save hook's "User not found for
//!   channel"); the caller's error path answers then (`$(ai)`: "[AI: Connection error]").
//! - The default persona's text names the streamer's login (`for {name}`), and the known user
//!   `cdom201` is added, as the reference does.
//!
//! Intended differences: the owner of the channel is the user with a Twitch account of that id
//! (`$elemMatch` on one account; the reference's hook matched type and id on any two accounts,
//! `ledger/packages.md`); the streamer directory is read only when a personality has to be
//! created (the reference read it on every call and used it only then). `getDefaultPersonality`
//! (the in-memory fallback when `getChannelPersonality` resolves `null`) is not ported: `create`
//! never resolves `null`, so the fallback cannot be reached.
//!
//! **Size.** A personality is written by the dashboard, whose service bounds every field; a
//! cached value larger than [`MAX_CACHED_BYTES`] is ignored and read from MongoDB.

use super::AiError;
use super::service::AiService;
use bson::{Document, doc};
use dima_model::channel_ai_personalities::{
    COLLECTION, ChannelAiPersonality, NewChannelAiPersonality, NewKnownUser,
};
use dima_store::dragonfly::SetOptions;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::number::JsNumber;
use std::sync::Arc;

/// The personality cache's lifetime (`setEx(..., 10800, ...)`).
pub const CACHE_TTL_SECONDS: u64 = 10_800;

/// The largest cached value read back (a stored document is far smaller).
pub const MAX_CACHED_BYTES: usize = 1024 * 1024;

/// `twitch:{channel}:chatbot:personality`, without the test prefix.
pub fn cache_key(channel_id: &str) -> String {
    format!("twitch:{channel_id}:chatbot:personality")
}

/// The default persona text of a new channel (`for ${streamer?.name || "this channel"}`).
pub fn default_persona(streamer_name: Option<&str>) -> String {
    let name = streamer_name.filter(|n| !n.is_empty()).unwrap_or("this channel");
    format!(
        "You are a friendly and playful Twitch chat moderator for {name}. You speak in Spanish by default but can adapt to other languages. You have a good sense of humor and enjoy interacting with chat users. You maintain a fun and engaging atmosphere while still being able to moderate when necessary."
    )
}

/// `contextWindow` of a new personality for `plan_tier` (the save hook sets it again).
pub fn default_context_window(plan_tier: Option<&str>) -> f64 {
    match plan_tier {
        Some("pro") => 35.0,
        Some("premium") => 15.0,
        _ => 7.0,
    }
}

/// The document `getChannelPersonality` creates for a channel whose owner's login is
/// `streamer_name` (`None`: "Unknown") on `plan_tier`, at `now_ms`.
pub fn new_default(
    channel_id: &str,
    streamer_name: Option<&str>,
    plan_tier: Option<&str>,
    now_ms: i64,
) -> NewChannelAiPersonality {
    let name = streamer_name.filter(|n| !n.is_empty());
    NewChannelAiPersonality {
        channel_id: channel_id.to_owned(),
        channel: name.unwrap_or("Unknown").to_owned(),
        context_window: Some(JsNumber(default_context_window(plan_tier))),
        personality: Some(default_persona(name)),
        rules: Some(vec!["Be respectful and friendly with users".to_owned()]),
        known_users: Some(
            vec![NewKnownUser {
                username: "cdom201".into(),
                description: "Creator, Owner and Developer of you, bot".into(),
                relationship: "professional".into(),
                last_interaction: JsDate(now_ms),
            }]
            .into(),
        ),
        ..NewChannelAiPersonality::default()
    }
}

fn decode(document: &Document) -> Result<ChannelAiPersonality, AiError> {
    dima_model::decode::decode_document(document)
        .map_err(|_| AiError::Store("personality could not be read"))
}

impl AiService {
    /// `getChannelPersonality(channelID)`: the cached, stored or newly created personality.
    pub async fn channel_personality(
        self: &Arc<Self>,
        channel_id: &str,
    ) -> Result<ChannelAiPersonality, AiError> {
        let deadline = self.deps.config.store_deadline;
        let key = self.key(cache_key(channel_id));
        let dragonfly = &self.deps.dragonfly;
        let cached = tokio::time::timeout(deadline, dragonfly.get(&key))
            .await
            .map_err(|_| AiError::Store("personality cache timed out"))?
            .map_err(|_| AiError::Store("personality cache failed"))?;
        if let Some(bytes) = cached.filter(|b| !b.is_empty() && b.len() <= MAX_CACHED_BYTES)
            && let Ok(document) = Document::from_reader(bytes.as_slice())
            && let Ok(personality) = decode(&document)
        {
            return Ok(personality);
        }
        let collection = self.deps.mongo.documents(COLLECTION);
        let found = tokio::time::timeout(
            deadline,
            collection.find_one(doc! { "channelID": channel_id }),
        )
        .await
        .map_err(|_| AiError::Store("personality read timed out"))?
        .map_err(|_| AiError::Store("personality read failed"))?;
        if let Some(document) = found {
            let personality = decode(&document)?;
            self.cache_personality(&key, &document).await?;
            return Ok(personality);
        }
        self.create_default(channel_id, &key).await
    }

    async fn cache_personality(&self, key: &str, document: &Document) -> Result<(), AiError> {
        let bytes = document
            .to_vec()
            .map_err(|_| AiError::Store("personality could not be encoded"))?;
        tokio::time::timeout(
            self.deps.config.store_deadline,
            self.deps
                .dragonfly
                .set(key, &bytes, SetOptions::ex(CACHE_TTL_SECONDS)),
        )
        .await
        .map_err(|_| AiError::Store("personality cache timed out"))?
        .map_err(|_| AiError::Store("personality cache failed"))?;
        Ok(())
    }

    async fn create_default(
        self: &Arc<Self>,
        channel_id: &str,
        key: &str,
    ) -> Result<ChannelAiPersonality, AiError> {
        let deadline = self.deps.config.store_deadline;
        let streamer = tokio::time::timeout(deadline, self.deps.twitch.streamer(channel_id))
            .await
            .ok()
            .flatten();
        let name = streamer.as_ref().map(|s| s.name().to_owned());
        let plan = streamer
            .as_ref()
            .and_then(|s| s.plan_tier())
            .map(str::to_owned);
        let owner = self.owner_plan(channel_id).await?;
        let now_ms = self.deps.clock.now_ms();
        let new = new_default(channel_id, name.as_deref(), plan.as_deref(), now_ms);
        let mut ctx = WriteContext::new(now_ms);
        let prepared = new
            .prepare(owner.as_deref(), &mut ctx)
            .map_err(|error| match error {
                dima_model::ModelError::Refused { .. } => {
                    AiError::Refused("personality refused by its save hook")
                }
                _ => AiError::Store("personality could not be created"),
            })?;
        let mut writes = self.deps.mongo.writes(COLLECTION);
        tokio::time::timeout(deadline, writes.insert_one(&prepared))
            .await
            .map_err(|_| AiError::Store("personality create timed out"))?
            .map_err(|_| AiError::Store("personality create failed"))?;
        let personality = decode(&prepared.document)?;
        self.cache_personality(key, &prepared.document).await?;
        self.log_debug(
            &serde_json::json!({
                "message": "[AI Harness] Created default channel personality",
                "channelID": channel_id,
                "channel": name.as_deref().filter(|n| !n.is_empty()).unwrap_or("Unknown"),
                "planTier": plan.as_deref().unwrap_or("free"),
                "contextWindow": default_context_window(plan.as_deref()),
            }),
            channel_id,
        );
        Ok(personality)
    }

    /// The plan of the user owning the channel (`None`: no such user), as the save hook reads
    /// it (`plan_tier`, `free` when the field is missing, as Mongoose's default gives it).
    async fn owner_plan(&self, channel_id: &str) -> Result<Option<String>, AiError> {
        let users = self.deps.mongo.documents(dima_model::users::COLLECTION);
        let found = tokio::time::timeout(
            self.deps.config.store_deadline,
            users
                .find_one(dima_model::users::by_account(
                    dima_model::users::AccountType::Twitch,
                    channel_id,
                ))
                .projection(doc! { "plan_tier": 1 }),
        )
        .await
        .map_err(|_| AiError::Store("owner read timed out"))?
        .map_err(|_| AiError::Store("owner read failed"))?;
        Ok(found.map(|user| match user.get("plan_tier") {
            Some(bson::Bson::String(plan)) => plan.clone(),
            _ => "free".to_owned(),
        }))
    }
}
