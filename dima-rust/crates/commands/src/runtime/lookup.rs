//! Finding the command a chat message names, and keeping the shared cache of commands current
//! (reference: `classes/command.class.ts`).
//!
//! # What is found
//!
//! Exactly what `Commands.getCommandFromDB(channelID, name)` finds: the first document, in the
//! collection's natural order, of `commands.findOne({channelID, activation: {$ne: 'keyword'},
//! cmd: name})` without the `select: false` paths. The name is compared as MongoDB compares
//! strings without a collation (byte for byte: case, accents and Unicode normalisation all
//! count); `name` is not an alias, and a leading `!` is part of the name. The caller passes the
//! name as the message gave it (the message handler's `^!([\p{L}\p{N}]+)` capture, a command
//! reference's text).
//!
//! # The cache
//!
//! The reference caches each found command for 3,600 s under `{channel}:commands:{name}`,
//! writes it after every database read, and deletes it after each of its own writes. That
//! leaves three ways to serve a command that no longer matches the database, all reproduced in
//! `tests/runtime_lookup.rs`: a lookup that read the database before a write and stores the old
//! document after the write's delete keeps it for an hour; a writer killed between its write
//! and its delete does the same; and a write that never deletes the key (account deletion's
//! `deleteMany`, a command turned into a keyword) leaves it until it expires. A name that does
//! not exist is never cached, so every message naming one queries MongoDB, which has no index on
//! `channelID` (a scan of the collection per message a viewer can cause at will).
//!
//! Rust keeps one snapshot per channel instead, in a Dragonfly hash:
//!
//! - `commands:snapshot:{channel}` (hash, 3,600 s from when it was loaded): `v` is `c` when it
//!   holds every command of the channel (an absent name then does not exist: no query) or `p`
//!   (partial) when the channel was over [`CommandCacheConfig::max_commands`] or
//!   [`CommandCacheConfig::max_snapshot_bytes`]; `b` counts the bytes of the entries; `c:{name}`
//!   holds the document as BSON (`''` marks an entry a writer made stale: read MongoDB).
//! - `commands:revision:{channel}` (string counter, no lifetime): moved by every write.
//! - `commands:writers:{channel}` (sorted set, writer token scored by its lease end): writes in
//!   flight. The set expires [`CommandCacheConfig::writer_lease_ms`] plus a minute after its
//!   last writer started.
//!
//! A lookup reads the mode, its entry and the revision in one script. A load from MongoDB is
//! published only while the revision is the one read before the load and no writer's lease is
//! live. A writer ([`CommandCache::write`]) registers its lease, moves the revision and marks its
//! names stale before it touches MongoDB, and does it again (releasing the lease) afterwards,
//! whatever the outcome. So:
//!
//! - between a write and its invalidation a reader sees nothing stale: the entry was marked
//!   before the write, and nothing can be published while the writer works;
//! - a writer killed in the middle leaves its names stale (readers query MongoDB) and its lease
//!   to expire after [`CommandCacheConfig::writer_lease_ms`] (30 s), after which loads publish
//!   again from what MongoDB holds; staleness is none, only extra queries;
//! - a writer whose MongoDB write outlives its lease, and which then dies before finishing, can
//!   leave the old document for the snapshot's lifetime: writes run under
//!   [`CommandCacheConfig::write_deadline`] (10 s), well inside the lease, so this needs a
//!   commit that lands after its own deadline and a crash;
//! - a write that does not go through [`CommandCache::write`] (a hand edit in the database)
//!   is seen when the snapshot expires: at most 3,600 s, the reference's lifetime.
//!
//! Every process (API, bot, cron) reads and writes the same keys, so nothing else needs to
//! tell them: no pub/sub, no process-local copy.
//!
//! # Bounds
//!
//! A snapshot holds at most [`CommandCacheConfig::max_commands`] commands and
//! [`CommandCacheConfig::max_snapshot_bytes`] (the production copy's largest channel has 93
//! commands; the collection, 5,333 documents of 2.5 MB). A larger channel gets a partial
//! snapshot: entries for the names found, each at most [`CommandCacheConfig::max_entry_bytes`],
//! at most [`CommandCacheConfig::max_partial_entries`] of them, within the same byte budget,
//! and names that do not exist query MongoDB as in the reference. Names longer than
//! [`CommandCacheConfig::max_name_bytes`] (a chat message holds at most 500 characters) skip
//! the cache. Concurrent cold loads of one channel are not coalesced: each runs one query,
//! as the reference runs one per message.
//!
//! # Intended differences
//!
//! - The cached form is the BSON document (Dragonfly is internal), not `JSON.stringify` of it.
//! - When Dragonfly fails, the lookup answers from MongoDB ([`Lookup::cache_error`] says why);
//!   the reference answers "Error retrieving command" and the message is dropped. When the
//!   cache write fails the found command is still returned (the reference fails the lookup).
//! - `getReservedCommandFromDB` returns a cached document without checking `reserved` when
//!   one is cached. Its only caller (`!cmd edit`) asks for it right after the plain lookup found
//!   nothing, so nothing is cached for the name: [`CommandCache::find_reserved`] queries
//!   MongoDB directly, with the reference's filter.
//! - `checkIfCommandExists`, `checkIfReservedCommandExists`, `updateCountableCommandInDB` and
//!   `updateCommandAvailability` have no caller and are not ported.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bson::{Document, RawDocumentBuf, doc};
use dima_core::{Clock, Random};
use dima_model::availability::Writer;
use dima_model::commands::{self, Command};
use dima_store::dragonfly::Script;
use dima_store::dragonfly::commands::reply;
use dima_store::mongo::WriteContext;
use dima_store::mongo::json::exclusion_projection;
use futures_util::TryStreamExt;
use redis::Value;

use super::{KeyPrefix, RuntimeError, Stores, within};

/// The reference's lifetime of a cached command: 3,600 s.
pub const SNAPSHOT_TTL_MS: i64 = 3_600_000;

static READ: Script = Script::new("command_read", include_str!("lua/command_read.lua"));
static FILL_CHANNEL: Script = Script::new(
    "command_fill_channel",
    include_str!("lua/command_fill_channel.lua"),
);
static FILL_ONE: Script = Script::new("command_fill_one", include_str!("lua/command_fill_one.lua"));
static WRITE_BEGIN: Script = Script::new(
    "command_write_begin",
    include_str!("lua/command_write_begin.lua"),
);
static WRITE_FINISH: Script = Script::new(
    "command_write_finish",
    include_str!("lua/command_write_finish.lua"),
);

/// `commands:snapshot:{channel}`.
pub fn snapshot_key(keys: &KeyPrefix, channel_id: &str) -> String {
    keys.key(format_args!("commands:snapshot:{channel_id}"))
}

/// `commands:revision:{channel}`.
pub fn revision_key(keys: &KeyPrefix, channel_id: &str) -> String {
    keys.key(format_args!("commands:revision:{channel_id}"))
}

/// `commands:writers:{channel}`.
pub fn writers_key(keys: &KeyPrefix, channel_id: &str) -> String {
    keys.key(format_args!("commands:writers:{channel_id}"))
}

/// The snapshot field of a name: `c:{name}`.
pub fn entry_field(name: &str) -> String {
    format!("c:{name}")
}

/// Limits and deadlines of a [`CommandCache`]. [`Default`] holds the production values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandCacheConfig {
    /// Lifetime of a snapshot, in milliseconds (the reference's 3,600 s).
    pub snapshot_ttl_ms: i64,
    /// How long a writer's lease holds back loads, in milliseconds.
    pub writer_lease_ms: i64,
    /// The most commands a complete snapshot holds.
    pub max_commands: usize,
    /// The most bytes of entries a snapshot holds.
    pub max_snapshot_bytes: usize,
    /// The largest entry a partial snapshot holds.
    pub max_entry_bytes: usize,
    /// The most entries of a partial snapshot.
    pub max_partial_entries: usize,
    /// Longer names skip the cache.
    pub max_name_bytes: usize,
    /// Deadline of one MongoDB read.
    pub read_deadline: Duration,
    /// Deadline of the MongoDB part of a write (inside [`Self::writer_lease_ms`]).
    pub write_deadline: Duration,
}

impl Default for CommandCacheConfig {
    fn default() -> Self {
        Self {
            snapshot_ttl_ms: SNAPSHOT_TTL_MS,
            writer_lease_ms: 30_000,
            max_commands: 1_000,
            max_snapshot_bytes: 1024 * 1024,
            max_entry_bytes: 256 * 1024,
            max_partial_entries: 1_000,
            max_name_bytes: 4_096,
            read_deadline: Duration::from_secs(10),
            write_deadline: Duration::from_secs(10),
        }
    }
}

/// Where a lookup's answer came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The channel's snapshot (the reference's "retrieved from cache").
    Cache,
    /// MongoDB.
    Database,
}

/// A lookup's answer.
#[derive(Debug)]
pub struct Lookup {
    /// The command, or `None` ("Command does not exist").
    pub command: Option<Command>,
    /// Where the answer came from.
    pub source: Source,
    /// A cache failure the answer survived (the caller logs it): Dragonfly unreachable, or the
    /// load could not be published.
    pub cache_error: Option<RuntimeError>,
}

/// What a write changes, for [`CommandCache::write`].
#[derive(Clone, Copy, Debug)]
pub enum Names<'a> {
    /// These command names (every name the write can add, remove or change: a rename gives the
    /// old and the new).
    These(&'a [&'a str]),
    /// Any command of the channel (a write by id whose names are unknown, `deleteMany`).
    All,
}

/// The command lookup and its shared cache. Cheap to clone; one per process.
#[derive(Clone, Debug)]
pub struct CommandCache {
    stores: Stores,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    config: CommandCacheConfig,
    before_publish: Option<PublishGate>,
}

/// A test seam: awaited after a lookup read MongoDB and before it publishes what it read, so a
/// test can run a write in between (`tests/runtime_cache.rs`). Never set in production.
#[doc(hidden)]
#[derive(Clone)]
pub struct PublishGate(pub Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>);

impl std::fmt::Debug for PublishGate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PublishGate")
    }
}

/// One snapshot as loaded from MongoDB.
struct Loaded {
    /// `c:{name}` and the document, first in natural order per name.
    entries: Vec<(String, RawDocumentBuf)>,
    bytes: usize,
    complete: bool,
}

fn base_filter(channel_id: &str) -> Document {
    doc! { "channelID": channel_id, "activation": { "$ne": "keyword" } }
}

fn projection() -> Document {
    exclusion_projection(commands::HIDDEN.iter().copied())
}

fn decode(raw: &RawDocumentBuf) -> Result<Command, RuntimeError> {
    Ok(dima_model::decode(raw)?)
}

/// The names a stored `cmd` answers to under MongoDB equality: a string, or each string of an
/// array.
fn stored_names(raw: &RawDocumentBuf) -> Vec<String> {
    match raw.get("cmd") {
        Ok(Some(bson::RawBsonRef::String(name))) => vec![name.to_owned()],
        Ok(Some(bson::RawBsonRef::Array(items))) => items
            .into_iter()
            .filter_map(|item| match item {
                Ok(bson::RawBsonRef::String(name)) => Some(name.to_owned()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl CommandCache {
    /// A cache over `stores`.
    pub fn new(
        stores: Stores,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        config: CommandCacheConfig,
    ) -> Self {
        Self {
            stores,
            clock,
            random,
            config,
            before_publish: None,
        }
    }

    #[doc(hidden)]
    pub fn with_publish_gate(mut self, gate: PublishGate) -> Self {
        self.before_publish = Some(gate);
        self
    }

    async fn gate(&self) {
        if let Some(gate) = &self.before_publish {
            (gate.0)().await;
        }
    }

    /// The stores.
    pub fn stores(&self) -> &Stores {
        &self.stores
    }

    /// The configuration.
    pub fn config(&self) -> &CommandCacheConfig {
        &self.config
    }

    fn keys(&self, channel_id: &str) -> [String; 3] {
        let prefix = &self.stores.keys;
        [
            snapshot_key(prefix, channel_id),
            revision_key(prefix, channel_id),
            writers_key(prefix, channel_id),
        ]
    }

    /// `Commands.getCommandFromDB(channelID, name)`: the command a message names. Called on
    /// every chat message that starts with `!`, and for every command reference.
    pub async fn find(&self, channel_id: &str, name: &str) -> Result<Lookup, RuntimeError> {
        if name.len() > self.config.max_name_bytes {
            return Ok(Lookup {
                command: self.query_one(channel_id, name).await?.map(|raw| decode(&raw)).transpose()?,
                source: Source::Database,
                cache_error: None,
            });
        }
        let keys = self.keys(channel_id);
        let field = entry_field(name);
        let read = READ
            .run_value(&self.stores.dragonfly, &keys[..2], &[field.as_str()])
            .await
            .map_err(RuntimeError::from)
            .and_then(parse_read);
        let (revision, mode, entry) = match read {
            Ok(read) => read,
            Err(error) => {
                let command = self.query_one(channel_id, name).await?;
                return Ok(Lookup {
                    command: command.map(|raw| decode(&raw)).transpose()?,
                    source: Source::Database,
                    cache_error: Some(error),
                });
            }
        };
        match (mode.as_deref(), entry) {
            (Some(_), Some(bytes)) if !bytes.is_empty() => {
                if let Ok(raw) = RawDocumentBuf::from_bytes(bytes)
                    && let Ok(command) = decode(&raw)
                {
                    return Ok(Lookup {
                        command: Some(command),
                        source: Source::Cache,
                        cache_error: None,
                    });
                }
                // Unreadable: treat it as stale.
                self.refill(channel_id, name, &keys, &revision).await
            }
            (Some(b"c"), None) => Ok(Lookup {
                command: None,
                source: Source::Cache,
                cache_error: None,
            }),
            (Some(_), _) => self.refill(channel_id, name, &keys, &revision).await,
            (None, _) => self.load_channel(channel_id, name, &keys, &revision).await,
        }
    }

    /// `Commands.getReservedCommandFromDB(channelID, name)`, uncached (see the module docs).
    pub async fn find_reserved(
        &self,
        channel_id: &str,
        name: &str,
    ) -> Result<Option<Command>, RuntimeError> {
        let mut filter = base_filter(channel_id);
        filter.insert("cmd", name);
        filter.insert("reserved", true);
        let raw = within(
            "commands.findOne",
            self.config.read_deadline,
            self.stores
                .mongo
                .collection::<RawDocumentBuf>(commands::COLLECTION)
                .find_one(filter)
                .projection(projection()),
        )
        .await?;
        raw.map(|raw| decode(&raw)).transpose()
    }

    async fn query_one(
        &self,
        channel_id: &str,
        name: &str,
    ) -> Result<Option<RawDocumentBuf>, RuntimeError> {
        let mut filter = base_filter(channel_id);
        filter.insert("cmd", name);
        within(
            "commands.findOne",
            self.config.read_deadline,
            self.stores
                .mongo
                .collection::<RawDocumentBuf>(commands::COLLECTION)
                .find_one(filter)
                .projection(projection()),
        )
        .await
    }

    /// One name of an existing snapshot from MongoDB.
    async fn refill(
        &self,
        channel_id: &str,
        name: &str,
        keys: &[String; 3],
        revision: &[u8],
    ) -> Result<Lookup, RuntimeError> {
        let raw = self.query_one(channel_id, name).await?;
        let command = raw.as_ref().map(decode).transpose()?;
        let value: &[u8] = match &raw {
            Some(raw) if raw.as_bytes().len() <= self.config.max_entry_bytes => raw.as_bytes(),
            Some(_) => {
                // Too large for any snapshot: drop the channel's (the next load sees why).
                let cache_error = self
                    .stores
                    .dragonfly
                    .del(&[keys[0].as_str()])
                    .await
                    .err()
                    .map(RuntimeError::from);
                return Ok(Lookup {
                    command,
                    source: Source::Database,
                    cache_error,
                });
            }
            None => b"",
        };
        let now = self.clock.now_ms().to_string();
        let max_bytes = self.config.max_snapshot_bytes.to_string();
        let max_fields = (self.config.max_partial_entries + 2).to_string();
        let field = entry_field(name);
        self.gate().await;
        let args: [&[u8]; 6] = [
            revision,
            now.as_bytes(),
            field.as_bytes(),
            value,
            max_bytes.as_bytes(),
            max_fields.as_bytes(),
        ];
        let cache_error = FILL_ONE
            .run_value(&self.stores.dragonfly, keys, &args)
            .await
            .err()
            .map(RuntimeError::from);
        Ok(Lookup {
            command,
            source: Source::Database,
            cache_error,
        })
    }

    /// The whole channel from MongoDB, published as its snapshot; the answer for `name` from it.
    async fn load_channel(
        &self,
        channel_id: &str,
        name: &str,
        keys: &[String; 3],
        revision: &[u8],
    ) -> Result<Lookup, RuntimeError> {
        let loaded = self.query_channel(channel_id).await?;
        let field = entry_field(name);
        let (answer, mode, entries) = if loaded.complete {
            let answer = loaded
                .entries
                .iter()
                .find(|(entry, _)| *entry == field)
                .map(|(_, raw)| raw.clone());
            (answer, "c", loaded.entries)
        } else {
            let answer = self.query_one(channel_id, name).await?;
            let entries = answer
                .iter()
                .filter(|raw| raw.as_bytes().len() <= self.config.max_entry_bytes)
                .map(|raw| (field.clone(), raw.clone()))
                .collect();
            (answer, "p", entries)
        };
        let command = answer.as_ref().map(decode).transpose()?;
        let bytes: usize = entries.iter().map(|(_, raw)| raw.as_bytes().len()).sum();
        let now = self.clock.now_ms().to_string();
        let ttl = self.config.snapshot_ttl_ms.to_string();
        let total = bytes.to_string();
        let mut args: Vec<&[u8]> = Vec::with_capacity(5 + entries.len() * 2);
        args.extend([
            revision,
            now.as_bytes(),
            ttl.as_bytes(),
            mode.as_bytes(),
            total.as_bytes(),
        ]);
        for (entry, raw) in &entries {
            args.push(entry.as_bytes());
            args.push(raw.as_bytes());
        }
        self.gate().await;
        let cache_error = FILL_CHANNEL
            .run_value(&self.stores.dragonfly, keys, &args)
            .await
            .err()
            .map(RuntimeError::from);
        Ok(Lookup {
            command,
            source: Source::Database,
            cache_error,
        })
    }

    /// `find({channelID, activation: {$ne: 'keyword'}})` in natural order, stopped as soon as
    /// the channel is over a bound.
    async fn query_channel(&self, channel_id: &str) -> Result<Loaded, RuntimeError> {
        let max_commands = self.config.max_commands;
        let max_bytes = self.config.max_snapshot_bytes;
        let collection = self
            .stores
            .mongo
            .collection::<RawDocumentBuf>(commands::COLLECTION);
        let read = async {
            let mut cursor = collection
                .find(base_filter(channel_id))
                .projection(projection())
                .await?;
            let mut loaded = Loaded {
                entries: Vec::new(),
                bytes: 0,
                complete: true,
            };
            let mut seen: HashSet<String> = HashSet::new();
            let mut documents = 0_usize;
            while let Some(raw) = cursor.try_next().await? {
                documents += 1;
                let names = stored_names(&raw);
                let size = raw.as_bytes().len();
                for name in names {
                    let field = entry_field(&name);
                    if seen.insert(field.clone()) {
                        loaded.bytes += size;
                        loaded.entries.push((field, raw.clone()));
                    }
                }
                if documents > max_commands || loaded.bytes > max_bytes {
                    loaded.complete = false;
                    loaded.entries.clear();
                    break;
                }
            }
            Ok::<_, mongodb::error::Error>(loaded)
        };
        within("commands.find", self.config.read_deadline, read).await
    }

    /// Runs a write to the channel's commands under the cache protocol (see the module docs):
    /// `write` runs after the names are marked stale and within
    /// [`CommandCacheConfig::write_deadline`]; the names are marked again and the lease released
    /// whatever it returned. When the first step fails nothing is written: the error is
    /// returned and `write` never runs. A failure of the last step is returned only when the
    /// write succeeded; the lease then expires on its own and the names stay stale meanwhile.
    pub async fn write<T, E, F, Fut>(
        &self,
        channel_id: &str,
        names: Names<'_>,
        write: F,
    ) -> Result<T, WriteFailure<E>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let keys = self.keys(channel_id);
        let fields: Vec<String> = match names {
            Names::These(names) => names.iter().map(|name| entry_field(name)).collect(),
            Names::All => Vec::new(),
        };
        let token = self
            .random
            .uuid_v4()
            .map_err(|error| WriteFailure::Cache(error.into()))?;
        let now = self.clock.now_ms();
        let lease_end = now.saturating_add(self.config.writer_lease_ms).to_string();
        let set_lifetime = self.config.writer_lease_ms.saturating_add(60_000).to_string();
        let now_text = now.to_string();
        let mut args: Vec<&str> = vec![&token, &now_text, &lease_end, &set_lifetime];
        args.extend(fields.iter().map(String::as_str));
        WRITE_BEGIN
            .run_value(&self.stores.dragonfly, &keys, &args)
            .await
            .map_err(|error| WriteFailure::Cache(error.into()))?;
        let outcome = match tokio::time::timeout(self.config.write_deadline, write()).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(WriteFailure::Write(error)),
            Err(_) => Err(WriteFailure::Cache(RuntimeError::Deadline {
                operation: "command write",
                ms: u64::try_from(self.config.write_deadline.as_millis()).unwrap_or(u64::MAX),
            })),
        };
        let mut finish: Vec<&str> = vec![&token];
        finish.extend(fields.iter().map(String::as_str));
        let finished = WRITE_FINISH
            .run_value(&self.stores.dragonfly, &keys, &finish)
            .await;
        match (outcome, finished) {
            (Ok(_), Err(error)) => Err(WriteFailure::Cache(error.into())),
            (outcome, _) => outcome,
        }
    }

    /// `Commands.updateCommandInDB(channelID, name, {count})`, as a command's `$(count)` saves
    /// its counter after a run (`handlers/commands.handler.ts:205`): finds the command like
    /// [`Self::find`] does, sets `count` on it (`doc.updateOne({count})`, through the
    /// availability hook) and invalidates the name. `false` when no command has the name.
    pub async fn update_count(
        &self,
        channel_id: &str,
        name: &str,
        count: f64,
    ) -> Result<bool, WriteFailure<RuntimeError>> {
        self.write(channel_id, Names::These(&[name]), || async {
            let Some(raw) = self.query_one(channel_id, name).await? else {
                return Ok(false);
            };
            let id = decode(&raw)?.id;
            let mut ctx = WriteContext::new(self.clock.now_ms());
            let prepared = commands::prepare_update(
                &doc! { "_id": id },
                doc! { "$set": { "count": count } },
                dima_model::UpdateOptions::default(),
                Writer::Client,
                &mut ctx,
                self.random.as_ref(),
            )?;
            within(
                "commands.updateOne",
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
            Ok(true)
        })
        .await
    }

    /// `Commands.deleteCommand(channelID, name)` (`!cmd del`): deletes the command
    /// [`Self::find`] would find, and invalidates the name. Its document, or `None` ("Command
    /// does not exist").
    pub async fn delete(
        &self,
        channel_id: &str,
        name: &str,
    ) -> Result<Option<Command>, WriteFailure<RuntimeError>> {
        self.write(channel_id, Names::These(&[name]), || async {
            let Some(raw) = self.query_one(channel_id, name).await? else {
                return Ok(None);
            };
            let command = decode(&raw)?;
            within(
                "commands.deleteOne",
                self.config.write_deadline,
                self.stores
                    .mongo
                    .documents(commands::COLLECTION)
                    .delete_one(doc! { "_id": command.id }),
            )
            .await?;
            Ok(Some(command))
        })
        .await
    }

    /// Drops the channel's snapshot after a write that did not go through [`Self::write`] (or
    /// to start over); safe at any time.
    pub async fn invalidate_channel(&self, channel_id: &str) -> Result<(), RuntimeError> {
        self.write(channel_id, Names::All, || async { Ok::<(), RuntimeError>(()) })
            .await
            .map_err(WriteFailure::into_runtime)
    }
}

/// Why [`CommandCache::write`] failed.
#[derive(Debug, thiserror::Error)]
pub enum WriteFailure<E> {
    /// The write ran and failed (the names were invalidated anyway).
    #[error("write failed")]
    Write(E),
    /// The cache protocol failed: before the write (nothing was written), on its deadline
    /// (outcome unknown) or after it succeeded (the lease expires on its own).
    #[error(transparent)]
    Cache(RuntimeError),
}

impl WriteFailure<RuntimeError> {
    /// Either error.
    pub fn into_runtime(self) -> RuntimeError {
        match self {
            Self::Write(error) | Self::Cache(error) => error,
        }
    }
}

type ReadReply = (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);

fn parse_read(value: Value) -> Result<ReadReply, RuntimeError> {
    let mut items = reply::array(value)?.into_iter();
    let (Some(revision), Some(mode), Some(entry), None) =
        (items.next(), items.next(), items.next(), items.next())
    else {
        return Err(RuntimeError::Reply("command_read"));
    };
    Ok((
        reply::bytes(revision)?,
        reply::bytes_or_nil(mode)?,
        reply::bytes_or_nil(entry)?,
    ))
}
