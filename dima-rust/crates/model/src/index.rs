//! Declared indexes: created the way Mongoose's `Model.init()` creates them, reported index by
//! index, under a deadline and a policy; and compared read-only with what a database holds.
//!
//! On first use of a model, Mongoose creates the collection (`autoCreate`) and then each declared
//! index, one `createIndexes` command per index, in `schema.indexes()` order (field-level
//! `index: true` first, then the `schema.index(...)` calls), each with `background: true` added.
//! MongoDB 4.2 and later build every index the same way whatever `background` says, but they
//! store it in the specification (every index of the production copy has it), so it is sent here
//! too and the specifications stay identical. Mongoose never drops an index, and an index that
//! fails (an `IndexOptionsConflict` with an older index of the same name, for example) is
//! reported while the others are still created. Nothing waits for it, except the domain-event
//! journal: `utils/domain_events.ts:123` awaits `DomainEventSchema.init()` before every insert,
//! because a duplicate `eventKey` is how it knows an event is already journaled.
//!
//! [`ensure_indexes`] does the same for one collection and reports every index ([`IndexStatus`]:
//! it existed already with the declared options, it was created, or it failed and why) within a
//! deadline (an index build the deadline cut off may still finish on the server). The caller's
//! [`IndexPolicy`] says which failures matter: [`IndexReport::require`] fails when a required
//! index is not there, and the caller must not write to that collection before it passes.
//! [`startup_policy`] is the reference's: the journal's unique indexes are required, every other
//! index is best effort and must never stop a process from starting (run it in the background
//! and log the report).
//!
//! [`preflight_indexes`] compares the declarations with a database's indexes without changing
//! anything, and lists every difference: the cutover rehearsal runs it against production first.

use crate::collection::CollectionInfo;
use bson::{Bson, Document, doc};
use dima_store::mongo::MongoStore;
use mongodb::IndexModel;
use mongodb::options::IndexOptions;
use std::fmt;
use std::future::IntoFuture;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};

/// One declared index.
#[derive(Clone, Copy, Debug)]
pub struct IndexSpec {
    /// The keys in order, with their direction (`1` or `-1`).
    pub keys: &'static [(&'static str, i32)],
    /// `unique: true`.
    pub unique: bool,
    /// `sparse: true`.
    pub sparse: bool,
    /// `expireAfterSeconds` (TTL indexes).
    pub expire_after_seconds: Option<u64>,
    /// `partialFilterExpression`.
    pub partial_filter: Option<fn() -> Document>,
}

impl IndexSpec {
    /// A plain index on `keys`.
    pub const fn on(keys: &'static [(&'static str, i32)]) -> Self {
        Self {
            keys,
            unique: false,
            sparse: false,
            expire_after_seconds: None,
            partial_filter: None,
        }
    }

    /// `unique: true`.
    pub const fn unique(mut self) -> Self {
        self.unique = true;
        self
    }

    /// `sparse: true`.
    pub const fn sparse(mut self) -> Self {
        self.sparse = true;
        self
    }

    /// `expireAfterSeconds`.
    pub const fn expire_after_seconds(mut self, seconds: u64) -> Self {
        self.expire_after_seconds = Some(seconds);
        self
    }

    /// `partialFilterExpression`.
    pub const fn partial(mut self, filter: fn() -> Document) -> Self {
        self.partial_filter = Some(filter);
        self
    }

    /// The key document.
    pub fn key_document(&self) -> Document {
        self.keys
            .iter()
            .map(|(key, direction)| ((*key).to_owned(), Bson::Int32(*direction)))
            .collect()
    }

    /// The name the server gives it (`channelID_1_started_at_-1`), which both drivers derive
    /// from the keys.
    pub fn name(&self) -> String {
        self.keys
            .iter()
            .map(|(key, direction)| format!("{key}_{direction}"))
            .collect::<Vec<_>>()
            .join("_")
    }

    /// The specification the server stores for this index, as `listIndexes` shows it (without
    /// `v`): `key`, `name`, `background: true` and the declared options.
    pub fn stored_spec(&self) -> Document {
        let mut out = doc! { "key": self.key_document(), "name": self.name(), "background": true };
        if self.unique {
            out.insert("unique", true);
        }
        if self.sparse {
            out.insert("sparse", true);
        }
        if let Some(seconds) = self.expire_after_seconds {
            out.insert(
                "expireAfterSeconds",
                Bson::Int64(i64::try_from(seconds).unwrap_or(i64::MAX)),
            );
        }
        if let Some(filter) = self.partial_filter {
            out.insert("partialFilterExpression", filter());
        }
        out
    }

    /// The driver index model, with the declared options and Mongoose's `background: true`.
    pub fn model(&self) -> IndexModel {
        // The driver deprecates `background` (the server ignores it when building), but the
        // server stores it, and Mongoose always sends it.
        #[allow(deprecated)]
        let options = IndexOptions::builder()
            .background(Some(true))
            .unique(self.unique.then_some(true))
            .sparse(self.sparse.then_some(true))
            .expire_after(self.expire_after_seconds.map(Duration::from_secs))
            .partial_filter_expression(self.partial_filter.map(|filter| filter()))
            .build();
        IndexModel::builder()
            .keys(self.key_document())
            .options(options)
            .build()
    }
}

/// Which failed indexes of a collection matter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexPolicy {
    /// Every failure is reported; none stops anything (Mongoose's `autoIndex`).
    BestEffort,
    /// The unique indexes must exist before the first write to the collection (the journal's
    /// duplicate-key idempotency); the others are best effort.
    RequireUnique,
    /// Every index must exist before the first write.
    RequireAll,
}

impl IndexPolicy {
    fn requires(self, spec: &IndexSpec) -> bool {
        match self {
            Self::BestEffort => false,
            Self::RequireUnique => spec.unique,
            Self::RequireAll => true,
        }
    }
}

/// The reference's policy: the collections whose `Model.init()` the reference awaits before it
/// writes need those indexes first, every other collection's indexes are built in the background
/// and only logged when they fail.
///
/// - `domain_events` (unique): `DomainEventSchema.init()` is awaited before every journal insert,
///   a duplicate `eventKey` is how it knows an event is already journaled;
/// - `cron_job_intents` (unique): `model.init()` is awaited before every acceptance and claim, a
///   duplicate key is how it knows a job is already accepted;
/// - the four OAuth collections (all): the API awaits their `init()` before it starts
///   (`server/oauth/service.ts:27`); the unique ones keep one grant per user, client and channel
///   and one record per refresh token hash;
/// - `credittransactions` (unique): `CreditTransactionSchema.init()` is awaited before a
///   paid-order reward is reserved, and a duplicate `idempotencyKey` would credit twice;
/// - `ai_usage_receipts` (unique): nothing awaits it, but the upsert on `{channelID, customerId,
///   entryId}` is what makes a receipt idempotent, and a duplicate would count its credits twice;
/// - `userextensioninventories` (unique): nothing awaits it, but the first purchase upserts the
///   viewer's wallet on `{platform, userID, channelID}`, and two wallets would split a balance.
///
/// `extensionwallettransactions.twitchTransactionID` guards money too, but production holds a
/// conflicting plain index of that name, so it cannot be built there; it stays best effort (see
/// that module).
pub fn startup_policy(info: &CollectionInfo) -> IndexPolicy {
    match info.name {
        crate::domain_events::COLLECTION
        | crate::cron_job_intents::COLLECTION
        | crate::credit_transactions::COLLECTION
        | crate::ai_usage_receipts::COLLECTION
        | crate::user_extension_inventories::COLLECTION => IndexPolicy::RequireUnique,
        crate::oauth_clients::COLLECTION
        | crate::oauth_grants::COLLECTION
        | crate::oauth_refresh_tokens::COLLECTION
        | crate::oauth_sessions::COLLECTION => IndexPolicy::RequireAll,
        _ => IndexPolicy::BestEffort,
    }
}

/// Why an index is not there.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    /// The collection could not be created (the driver's message).
    #[error("the collection could not be created: {0}")]
    Collection(String),
    /// An index of the same name exists with other options (the server would refuse with
    /// `IndexOptionsConflict`; Mongoose logs it and goes on).
    #[error("an index of this name exists with other options: {stored}")]
    Conflict {
        /// The stored specification.
        stored: Document,
    },
    /// The server refused or the driver failed.
    #[error(transparent)]
    Driver(mongodb::error::Error),
    /// The deadline passed first; a build that had started may still finish on the server.
    #[error("the deadline of {0:?} passed (a started build may still finish on the server)")]
    Deadline(Duration),
}

/// What became of one declared index.
#[derive(Debug)]
pub enum IndexStatus {
    /// It existed with the declared options; nothing was sent.
    Exists,
    /// It was created.
    Created,
    /// It is not there.
    Failed(IndexError),
}

/// One declared index in a report.
#[derive(Debug)]
pub struct IndexOutcome {
    /// The index name.
    pub index: String,
    /// The policy requires it.
    pub required: bool,
    /// What became of it.
    pub status: IndexStatus,
}

/// What [`ensure_indexes`] did for one collection.
#[derive(Debug)]
pub struct IndexReport {
    /// The collection.
    pub collection: &'static str,
    /// Every declared index, in declaration order.
    pub outcomes: Vec<IndexOutcome>,
}

/// A required index is not there: do not write to the collection.
#[derive(Debug, thiserror::Error)]
#[error("{collection}: required indexes are not there: {}", .missing.join("; "))]
pub struct RequiredIndexError {
    /// The collection.
    pub collection: &'static str,
    /// Each required index that failed, with the reason.
    pub missing: Vec<String>,
}

impl IndexReport {
    /// The indexes that are not there.
    pub fn failures(&self) -> impl Iterator<Item = &IndexOutcome> {
        self.outcomes
            .iter()
            .filter(|o| matches!(o.status, IndexStatus::Failed(_)))
    }

    /// `Ok` when every index the policy requires is there.
    pub fn require(&self) -> Result<(), RequiredIndexError> {
        let missing: Vec<String> = self
            .failures()
            .filter(|o| o.required)
            .map(|o| match &o.status {
                IndexStatus::Failed(error) => format!("{}: {error}", o.index),
                _ => o.index.clone(),
            })
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(RequiredIndexError {
                collection: self.collection,
                missing,
            })
        }
    }
}

impl fmt::Display for IndexReport {
    /// One line per index: `streamsessions channelID_1: created`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, outcome) in self.outcomes.iter().enumerate() {
            if i > 0 {
                formatter.write_str("\n")?;
            }
            let required = if outcome.required { " (required)" } else { "" };
            write!(
                formatter,
                "{} {}{required}: ",
                self.collection, outcome.index
            )?;
            match &outcome.status {
                IndexStatus::Exists => formatter.write_str("exists")?,
                IndexStatus::Created => formatter.write_str("created")?,
                IndexStatus::Failed(error) => write!(formatter, "failed: {error}")?,
            }
        }
        Ok(())
    }
}

/// Runs `operation` unless `end` has passed.
async fn before<T>(
    end: Instant,
    deadline: Duration,
    operation: impl IntoFuture<Output = Result<T, mongodb::error::Error>>,
) -> Result<T, IndexError> {
    match timeout_at(end, operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(IndexError::Driver(error)),
        Err(_) => Err(IndexError::Deadline(deadline)),
    }
}

/// What `Model.init()` does for `info`, within `deadline`: creates the collection if it does not
/// exist, then each declared index in order that is not already there with the declared options.
/// Never fails as a whole: the report says what happened to each index, and
/// [`IndexReport::require`] whether the policy is met.
pub async fn ensure_indexes(
    store: &MongoStore,
    info: &CollectionInfo,
    policy: IndexPolicy,
    deadline: Duration,
) -> IndexReport {
    let end = Instant::now() + deadline;
    if let Err(error) = before(end, deadline, ensure_collection(store, info.name)).await {
        let message = error.to_string();
        let outcomes = info
            .indexes
            .iter()
            .map(|spec| IndexOutcome {
                index: spec.name(),
                required: policy.requires(spec),
                status: IndexStatus::Failed(match error {
                    IndexError::Deadline(after) => IndexError::Deadline(after),
                    _ => IndexError::Collection(message.clone()),
                }),
            })
            .collect();
        return IndexReport {
            collection: info.name,
            outcomes,
        };
    }
    let mut outcomes = Vec::new();
    let stored = before(end, deadline, list_indexes(store, info.name)).await;
    let collection = store.documents(info.name);
    for spec in info.indexes {
        let name = spec.name();
        let existing = match &stored {
            Ok(stored) => stored
                .iter()
                .find(|s| s.get_str("name").ok() == Some(name.as_str())),
            Err(_) => None,
        };
        let status = match existing {
            Some(existing) if same_index(existing, &spec.stored_spec()) => IndexStatus::Exists,
            Some(existing) => IndexStatus::Failed(IndexError::Conflict {
                stored: without_version(existing),
            }),
            None => match before(end, deadline, collection.create_index(spec.model())).await {
                Ok(_) => IndexStatus::Created,
                Err(error) => IndexStatus::Failed(error),
            },
        };
        outcomes.push(IndexOutcome {
            index: name,
            required: policy.requires(spec),
            status,
        });
    }
    IndexReport {
        collection: info.name,
        outcomes,
    }
}

/// `createCollection` unless the collection exists (the server's `NamespaceExists`, code 48, is
/// what Mongoose ignores too).
async fn ensure_collection(store: &MongoStore, name: &str) -> Result<(), mongodb::error::Error> {
    match store.database().create_collection(name).await {
        Ok(()) => Ok(()),
        Err(error) if dima_store::mongo::error::server_code(&error) == Some(48) => Ok(()),
        Err(error) => Err(error),
    }
}

/// The index specifications of a collection, as `listIndexes` returns them; empty when the
/// collection does not exist (`NamespaceNotFound`, code 26).
async fn list_indexes(
    store: &MongoStore,
    name: &str,
) -> Result<Vec<Document>, mongodb::error::Error> {
    let reply = store
        .database()
        .run_command(doc! { "listIndexes": name })
        .await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) if dima_store::mongo::error::server_code(&error) == Some(26) => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    Ok(reply
        .get_document("cursor")
        .and_then(|cursor| cursor.get_array("firstBatch"))
        .map(|batch| {
            batch
                .iter()
                .filter_map(|b| b.as_document().cloned())
                .collect()
        })
        .unwrap_or_default())
}

fn without_version(spec: &Document) -> Document {
    let mut spec = spec.clone();
    spec.remove("v");
    spec
}

/// Two specifications describe the same index: same keys in the same order, same options
/// (numbers compared by value), ignoring `v` and `background` (neither changes the index, and
/// the server accepts a `createIndexes` that differs only there).
pub fn same_index(stored: &Document, declared: &Document) -> bool {
    let relevant = |spec: &Document| -> Document {
        spec.iter()
            .filter(|(k, _)| *k != "v" && *k != "background")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    same_values(&relevant(stored), &relevant(declared))
}

fn same_values(a: &Document, b: &Document) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(key, x)| b.get(key).is_some_and(|y| same_value(key, x, y)))
}

fn same_value(key: &str, x: &Bson, y: &Bson) -> bool {
    let number = dima_store::mongo::number::read_number;
    match (x, y) {
        // The order of the key document is part of the index; option order is not.
        (Bson::Document(x), Bson::Document(y)) => {
            (key != "key" || x.keys().eq(y.keys())) && same_values(x, y)
        }
        _ => match (number(x), number(y)) {
            (Some(x), Some(y)) => x == y,
            _ => x == y,
        },
    }
}

/// One difference between the declared indexes and a database's.
#[derive(Clone, Debug, PartialEq)]
pub enum IndexDifference {
    /// The collection does not exist (Mongoose would create it with its indexes).
    MissingCollection {
        /// The collection.
        collection: &'static str,
    },
    /// A declared index is not there (Mongoose would build it).
    Missing {
        /// The collection.
        collection: &'static str,
        /// The declared specification.
        declared: Document,
    },
    /// An index of the declared name has other options (Mongoose would fail on it and go on).
    Differs {
        /// The collection.
        collection: &'static str,
        /// The declared specification.
        declared: Document,
        /// The stored one.
        stored: Document,
    },
    /// An index nobody declares (Mongoose never drops one); `_id_` is not listed.
    Undeclared {
        /// The collection.
        collection: &'static str,
        /// The stored specification.
        stored: Document,
    },
}

impl fmt::Display for IndexDifference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingCollection { collection } => {
                write!(formatter, "{collection}: the collection does not exist")
            }
            Self::Missing {
                collection,
                declared,
            } => write!(formatter, "{collection}: declared but missing: {declared}"),
            Self::Differs {
                collection,
                declared,
                stored,
            } => write!(
                formatter,
                "{collection}: stored {stored} differs from the declaration {declared}"
            ),
            Self::Undeclared { collection, stored } => {
                write!(
                    formatter,
                    "{collection}: exists but is not declared: {stored}"
                )
            }
        }
    }
}

/// The declared indexes of `infos` against the database's, read only (`listCollections` and
/// `listIndexes`), within `deadline`: every difference, in registry and declaration order.
pub async fn preflight_indexes(
    store: &MongoStore,
    infos: &[&CollectionInfo],
    deadline: Duration,
) -> Result<Vec<IndexDifference>, IndexError> {
    let end = Instant::now() + deadline;
    let existing = before(end, deadline, store.database().list_collection_names()).await?;
    let mut differences = Vec::new();
    for info in infos {
        if !existing.iter().any(|name| name == info.name) {
            differences.push(IndexDifference::MissingCollection {
                collection: info.name,
            });
            continue;
        }
        let stored = before(end, deadline, list_indexes(store, info.name)).await?;
        for spec in info.indexes {
            let declared = spec.stored_spec();
            let name = spec.name();
            match stored
                .iter()
                .find(|s| s.get_str("name").ok() == Some(name.as_str()))
            {
                None => differences.push(IndexDifference::Missing {
                    collection: info.name,
                    declared,
                }),
                Some(found) if !same_index(found, &declared) => {
                    differences.push(IndexDifference::Differs {
                        collection: info.name,
                        declared,
                        stored: without_version(found),
                    });
                }
                Some(_) => {}
            }
        }
        for found in &stored {
            let name = found.get_str("name").unwrap_or_default();
            if name != "_id_" && info.indexes.iter().all(|spec| spec.name() != name) {
                differences.push(IndexDifference::Undeclared {
                    collection: info.name,
                    stored: without_version(found),
                });
            }
        }
    }
    Ok(differences)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn specifications_compare_by_meaning() {
        let spec = IndexSpec::on(&[("a", 1), ("b", -1)])
            .unique()
            .expire_after_seconds(60);
        let declared = spec.stored_spec();
        let stored = doc! { "v": 2, "key": { "a": 1, "b": -1 }, "name": "a_1_b_-1", "unique": true, "expireAfterSeconds": 60_i32 };
        assert!(
            same_index(&stored, &declared),
            "background and v are ignored, numbers by value"
        );
        let reversed = doc! { "key": { "b": -1, "a": 1 }, "name": "a_1_b_-1", "unique": true, "expireAfterSeconds": 60 };
        assert!(
            !same_index(&reversed, &declared),
            "the key order is the index"
        );
        let not_unique =
            doc! { "key": { "a": 1, "b": -1 }, "name": "a_1_b_-1", "expireAfterSeconds": 60 };
        assert!(!same_index(&not_unique, &declared));
        assert_eq!(
            startup_policy(&crate::domain_events::INFO),
            IndexPolicy::RequireUnique
        );
        assert_eq!(startup_policy(&crate::users::INFO), IndexPolicy::BestEffort);
    }

    #[test]
    fn names_and_options() {
        let spec = IndexSpec::on(&[("channelID", 1), ("started_at", -1), ("ended_at", 1)])
            .unique()
            .partial(|| doc! { "ended_at": Bson::Null });
        assert_eq!(spec.name(), "channelID_1_started_at_-1_ended_at_1");
        let model = spec.model();
        assert_eq!(
            model.keys,
            doc! { "channelID": 1, "started_at": -1, "ended_at": 1 }
        );
        let options = model.options.unwrap_or_default();
        assert_eq!(options.unique, Some(true));
        assert_eq!(options.sparse, None);
        #[allow(deprecated)]
        let background = options.background;
        assert_eq!(background, Some(true));
        assert_eq!(
            options.partial_filter_expression,
            Some(doc! { "ended_at": Bson::Null })
        );
        let ttl = IndexSpec::on(&[("expiresAt", 1)])
            .expire_after_seconds(0)
            .model();
        assert_eq!(
            ttl.options.and_then(|o| o.expire_after),
            Some(Duration::from_secs(0))
        );
        assert_eq!(
            IndexSpec::on(&[("availability.nextAt", 1)]).name(),
            "availability.nextAt_1"
        );
    }
}
