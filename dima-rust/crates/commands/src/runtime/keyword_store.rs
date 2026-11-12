//! The keyword cache's store: [`crate::keywords::KeywordStorage`] over MongoDB and Dragonfly
//! (reference: `utils/keyword_cache.ts`, the queries and commands its functions send).
//!
//! The bot builds one [`StoreKeywordStorage`] and puts it under the keyword index cache
//! (`KeywordIndexCache<SharedKeywordLoader<StoreKeywordStorage>>`); the message handler reads
//! keyword bodies through [`crate::keywords::get_keyword_body`] with it; the API's keyword
//! writes call [`crate::keywords::refresh_keyword_index`] with it (P4-API-COMMANDS).
//!
//! | Trait method | What it sends |
//! |---|---|
//! | `get`, `delete` | `GET`, `DEL` of the key under [`Stores::keys`] |
//! | `query_index` | `commands.find({channelID, activation: 'keyword', enabled: true}, {_id, cmd, keywordSettings}).limit(n)`, natural order |
//! | `query_body` | `commands.findOne({channelID, _id, activation: 'keyword'})` without the `select: false` paths |
//! | `set_if_revision` | the two reference scripts, verbatim, with the prefixed keys |
//! | `invalidate_shared` | one `MULTI`: `INCR` the revision, `DEL` the index (and the body) |
//! | `publish` | `PUBLISH` of the JSON on [`RUST_CHANNEL_PREFIX`] + the topic (`rust:keywords:changed`) |
//! | `update_keyword_count` | `$set: {count}` through the model's write helpers |
//!
//! Key families (*rebuilt* at the cutover): `keywords:index:{channel}` (86,400 s),
//! `keywords:revision:{channel}` (no lifetime), `keywords:body:{channel}:{id}` (30 s). The values
//! are this crate's: the index is the JSON of [`crate::keywords::KeywordEntry`] (as the
//! reference's), a body is a JSON string holding the stored document as base64 BSON
//! ([`KeywordBody`]), so every BSON type survives the cache (the reference caches
//! `JSON.stringify` of the Mongoose document; Dragonfly is internal).
//!
//! Every MongoDB call runs under [`KeywordStoreConfig`]'s deadlines; Dragonfly calls are bounded
//! by the store's response timeout.

use std::time::Duration;

use bson::{Bson, RawDocumentBuf, doc, oid::ObjectId};
use dima_core::Random;
use dima_model::availability::Writer;
use dima_model::commands::{self, Command};
use dima_store::dragonfly::Script;
use dima_store::mongo::WriteContext;
use dima_store::mongo::json::exclusion_projection;
use futures_util::TryStreamExt;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::sync::Arc;

use super::{RuntimeError, Stores, within};
use crate::keywords::{
    BODY_SCRIPT, KeywordMatchMode, KeywordRow, KeywordStorage, SHARED_INDEX_SCRIPT,
};

/// Prepended to the pub/sub topic: Rust never shares a channel with TypeScript
/// (`MIGRATION.md` section 3; the convention of `dima_actions::pubsub::RUST_CHANNEL_PREFIX`,
/// which this crate cannot name because it lies above it).
pub const RUST_CHANNEL_PREFIX: &str = "rust:";

static SHARED_INDEX: Script = Script::new("keyword_shared_index", SHARED_INDEX_SCRIPT);
static BODY: Script = Script::new("keyword_body", BODY_SCRIPT);

/// Deadlines of [`StoreKeywordStorage`]. [`Default`] holds the production values (the reference
/// sets none; these only fire on a real hang).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeywordStoreConfig {
    /// One MongoDB read.
    pub read_deadline: Duration,
    /// One MongoDB write.
    pub write_deadline: Duration,
}

impl Default for KeywordStoreConfig {
    fn default() -> Self {
        Self {
            read_deadline: Duration::from_secs(10),
            write_deadline: Duration::from_secs(10),
        }
    }
}

/// A keyword command as its body is cached: the stored document (without the `select: false`
/// paths), as BSON.
#[derive(Clone, Debug, PartialEq)]
pub struct KeywordBody(pub RawDocumentBuf);

impl KeywordBody {
    /// The command it holds.
    pub fn command(&self) -> Result<Command, RuntimeError> {
        Ok(dima_model::decode(&self.0)?)
    }
}

impl Serialize for KeywordBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&dima_core::crypto::encoding::encode_base64(
            self.0.as_bytes(),
        ))
    }
}

impl<'de> Deserialize<'de> for KeywordBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let bytes = dima_core::crypto::encoding::decode_base64_lenient(&text);
        RawDocumentBuf::from_bytes(bytes)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

/// [`KeywordStorage`] on the stores. Cheap to clone.
#[derive(Clone, Debug)]
pub struct StoreKeywordStorage {
    stores: Stores,
    clock: Arc<dyn dima_core::Clock>,
    random: Arc<dyn Random>,
    config: KeywordStoreConfig,
}

impl StoreKeywordStorage {
    /// The storage of `stores` (writes stamp `updatedAt` from `clock`; the availability hook
    /// draws from `random`).
    pub fn new(
        stores: Stores,
        clock: Arc<dyn dima_core::Clock>,
        random: Arc<dyn Random>,
        config: KeywordStoreConfig,
    ) -> Self {
        Self {
            stores,
            clock,
            random,
            config,
        }
    }

    /// The stores.
    pub fn stores(&self) -> &Stores {
        &self.stores
    }
}

fn object_id(id: &str) -> Result<ObjectId, RuntimeError> {
    // Mongoose casts the text to an ObjectId and throws a CastError when it is not one; ids
    // here come from the index (`String(_id)`).
    ObjectId::parse_str(id).map_err(|_| RuntimeError::Decode("commands._id".into()))
}

impl KeywordStorage for StoreKeywordStorage {
    type Error = RuntimeError;
    type Body = KeywordBody;

    async fn get(&self, key: &str) -> Result<Option<String>, RuntimeError> {
        let key = self.stores.keys.key(key);
        match self.stores.dragonfly.get(&key).await? {
            Some(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| RuntimeError::Decode("keyword cache value".into())),
            None => Ok(None),
        }
    }

    async fn query_index(
        &self,
        channel_id: &str,
        limit: usize,
    ) -> Result<Vec<KeywordRow>, RuntimeError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows: Vec<bson::Document> = within(
            "commands.find(keywords)",
            self.config.read_deadline,
            async {
                self.stores
                    .mongo
                    .documents(commands::COLLECTION)
                    .find(
                        doc! { "channelID": channel_id, "activation": "keyword", "enabled": true },
                    )
                    .projection(doc! { "_id": 1, "cmd": 1, "keywordSettings": 1 })
                    .limit(limit)
                    .await?
                    .try_collect()
                    .await
            },
        )
        .await?;
        rows.into_iter()
            .map(|row| {
                let id = match row.get("_id") {
                    Some(Bson::ObjectId(id)) => id.to_hex(),
                    Some(Bson::String(id)) => id.clone(),
                    _ => return Err(RuntimeError::Decode("commands._id".into())),
                };
                // `normalizeKeyword(row.cmd)` throws on anything but text: the load fails.
                let Some(Bson::String(cmd)) = row.get("cmd") else {
                    return Err(RuntimeError::Decode("commands.cmd".into()));
                };
                // `keywordSettings?.matchMode ?? 'start'`: missing or null is `start`; any other
                // value that is not a mode behaves as `anywhere`.
                let mode = match row
                    .get_document("keywordSettings")
                    .ok()
                    .and_then(|settings| settings.get("matchMode"))
                {
                    None | Some(Bson::Null | Bson::Undefined) => KeywordMatchMode::Start,
                    Some(Bson::String(text)) => KeywordMatchMode::from_stored(Some(text)),
                    Some(_) => KeywordMatchMode::Anywhere,
                };
                Ok(KeywordRow {
                    id,
                    cmd: cmd.clone(),
                    match_mode: mode,
                })
            })
            .collect()
    }

    async fn query_body(
        &self,
        channel_id: &str,
        id: &str,
    ) -> Result<Option<KeywordBody>, RuntimeError> {
        let id = object_id(id)?;
        let found = within(
            "commands.findOne(keyword)",
            self.config.read_deadline,
            self.stores
                .mongo
                .collection::<RawDocumentBuf>(commands::COLLECTION)
                .find_one(doc! { "channelID": channel_id, "_id": id, "activation": "keyword" })
                .projection(exclusion_projection(commands::HIDDEN.iter().copied())),
        )
        .await?;
        Ok(found.map(KeywordBody))
    }

    async fn set_if_revision(
        &self,
        script: &'static str,
        data_key: &str,
        revision_key: &str,
        revision: &str,
        json: &str,
    ) -> Result<bool, RuntimeError> {
        let script = if script == SHARED_INDEX_SCRIPT {
            &SHARED_INDEX
        } else if script == BODY_SCRIPT {
            &BODY
        } else {
            return Err(RuntimeError::Reply("an unknown keyword script"));
        };
        let keys = [
            self.stores.keys.key(data_key),
            self.stores.keys.key(revision_key),
        ];
        let written: i64 = script
            .run(&self.stores.dragonfly, &keys, &[revision, json])
            .await?;
        Ok(written == 1)
    }

    async fn invalidate_shared(
        &self,
        revision_key: &str,
        index_key: &str,
        body_key: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let mut pipeline = redis::pipe();
        pipeline
            .atomic()
            .cmd("INCR")
            .arg(self.stores.keys.key(revision_key))
            .cmd("DEL")
            .arg(self.stores.keys.key(index_key));
        if let Some(body) = body_key {
            pipeline.cmd("DEL").arg(self.stores.keys.key(body));
        }
        for outcome in self.stores.dragonfly.transaction(pipeline).await? {
            outcome?;
        }
        Ok(())
    }

    async fn publish(&self, topic: &str, json: &str) -> Result<(), RuntimeError> {
        self.stores
            .dragonfly
            .publish(&format!("{RUST_CHANNEL_PREFIX}{topic}"), json.as_bytes())
            .await?;
        Ok(())
    }

    async fn update_keyword_count(
        &self,
        channel_id: &str,
        id: &str,
        count: f64,
    ) -> Result<(), RuntimeError> {
        let id = object_id(id)?;
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let prepared = commands::prepare_update(
            &doc! { "channelID": channel_id, "_id": id, "activation": "keyword" },
            doc! { "$set": { "count": dima_store::mongo::number::js_number(count) } },
            dima_model::UpdateOptions::default(),
            Writer::Client,
            &mut ctx,
            self.random.as_ref(),
        )?;
        within(
            "commands.updateOne(keyword)",
            self.config.write_deadline,
            async {
                self.stores
                    .mongo
                    .writes(commands::COLLECTION)
                    .update_one(&prepared)
                    .await
            },
        )
        .await?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), RuntimeError> {
        let key = self.stores.keys.key(key);
        self.stores.dragonfly.del(&[key.as_str()]).await?;
        Ok(())
    }
}
