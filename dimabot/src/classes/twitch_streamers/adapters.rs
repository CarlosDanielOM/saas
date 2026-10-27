//! Native adapters use injected clients. No environment, global client, or I/O
//! occurs in a constructor. Lua is prepared once and loaded lazily by redis-rs.
use super::mapping::{account_from_fields, metadata_from_document};
use super::{
    CachedStreamer, DirectoryCache, DirectoryError, DirectoryFuture, DirectorySnapshot, IdPage,
    MetadataPage, MetadataStore, StreamerCredentials, StreamerMetadata, check_id,
};
use crate::utils::{
    plan_cache_fence::{
        MAX_ACCOUNT_FIELDS, MAX_READ_ACCOUNT_BYTES, MAX_READ_BATCH_ACCOUNTS,
        READ_PLAN_ACCOUNT_SCRIPT, account_cache_key, plan_cache_fence_key,
    },
    twitch::AccessToken,
    twitch_tokens::{CachedAccount, TwitchTokenStorage, directory_generation_key},
};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use redis::{ErrorKind, Script, ServerErrorKind, aio::ConnectionManager};
use std::{future::Future, time::Duration};

const DEADLINE: Duration = Duration::from_secs(2);
const REVISION: &str = "streamers:directory:revision";
const MEMBERS: &str = "streamers:by:id";
const LEASE: &str = "locks:streamers:reconcile";

pub struct NativeCredentials {
    storage: TwitchTokenStorage,
}
impl NativeCredentials {
    /// The complete refresh/persistence path is bounded below its owned lease.
    pub fn new(storage: TwitchTokenStorage) -> Result<Self, DirectoryError> {
        Ok(Self {
            storage: storage
                .with_refresh_guard(Duration::from_secs(30), Duration::from_secs(25))?,
        })
    }
}
impl StreamerCredentials for NativeCredentials {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        Box::pin(async move { Ok(self.storage.account_snapshot(id).await?) })
    }
    fn token<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, AccessToken> {
        Box::pin(async move { Ok(self.storage.acquire_account_token(id).await?) })
    }
    fn refresh_secret<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, String> {
        Box::pin(async move { Ok(self.storage.refresh_secret(id).await?) })
    }
}

pub struct MongoStreamerStore {
    users: Collection<Document>,
    deadline: Duration,
}
impl MongoStreamerStore {
    pub fn new(database: &Database) -> Self {
        Self {
            users: database.collection("users"),
            deadline: DEADLINE,
        }
    }
    pub fn with_deadline(mut self, deadline: Duration) -> Result<Self, DirectoryError> {
        validate_deadline(deadline)?;
        self.deadline = deadline;
        Ok(self)
    }
}
fn projection() -> Document {
    doc! {"_id":1,"accounts.id":1,"accounts.type":1,"accounts.name":1,"accounts.email":1,"accounts.actived":1,"accounts.chat_enabled":1,"plan_tier":1,"plan_tier_until":1,"polar_sh_customer_id":1,"polar_plan_event_at":1,"polar_plan_event_key":1}
}
impl MetadataStore for MongoStreamerStore {
    fn account<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, Option<StreamerMetadata>> {
        Box::pin(async move {
            check_id(id)?;
            let op = async {
                let user = self
                    .users
                    .find_one(doc! {"accounts":{"$elemMatch":{"type":"twitch","id":id}}})
                    .projection(projection())
                    .max_time(self.deadline)
                    .await
                    .map_err(|_| DirectoryError::StoreUnavailable)?;
                match user {
                    None => Ok(None),
                    Some(user) => metadata_from_document(&user, id),
                }
            };
            tokio::time::timeout(self.deadline, op).await.map_err(|_| {
                DirectoryError::DeadlineExceeded {
                    write_outcome_unknown: false,
                }
            })?
        })
    }
    fn page<'a>(
        &'a self,
        after: Option<&'a str>,
        limit: usize,
    ) -> DirectoryFuture<'a, MetadataPage> {
        Box::pin(async move {
            if limit == 0 || limit > 64 {
                return Err(DirectoryError::InvalidInput);
            }
            let mut filter = doc! {"accounts.type":"twitch"};
            if let Some(after) = after {
                let id = ObjectId::parse_str(after).map_err(|_| DirectoryError::InvalidInput)?;
                filter.insert("_id", doc! {"$gt":id});
            }
            let op = async {
                let mut cursor = self
                    .users
                    .find(filter)
                    .projection(projection())
                    .sort(doc! {"_id":1})
                    .limit(limit as i64)
                    .batch_size(limit as u32)
                    .max_time(self.deadline)
                    .await
                    .map_err(|_| DirectoryError::StoreUnavailable)?;
                let mut accounts = Vec::new();
                let mut seen = std::collections::BTreeSet::new();
                let mut users = 0usize;
                let mut last = None;
                while let Some(user) = cursor
                    .try_next()
                    .await
                    .map_err(|_| DirectoryError::StoreUnavailable)?
                {
                    users += 1;
                    if users > limit {
                        return Err(DirectoryError::TooLarge);
                    }
                    last = Some(
                        user.get_object_id("_id")
                            .map_err(|_| DirectoryError::InvalidData)?
                            .to_hex(),
                    );
                    let entries = user
                        .get_array("accounts")
                        .map_err(|_| DirectoryError::InvalidData)?;
                    if entries.len() > 64 {
                        return Err(DirectoryError::TooLarge);
                    }
                    for account in entries
                        .iter()
                        .filter_map(Bson::as_document)
                        .filter(|a| a.get_str("type").ok() == Some("twitch"))
                    {
                        let id = account
                            .get_str("id")
                            .map_err(|_| DirectoryError::InvalidData)?;
                        if !seen.insert(id.to_owned()) {
                            return Err(DirectoryError::InvalidData);
                        }
                        accounts.push(
                            metadata_from_document(&user, id)?
                                .ok_or(DirectoryError::InvalidData)?,
                        );
                    }
                }
                Ok(MetadataPage {
                    accounts,
                    next: if users == limit { last } else { None },
                })
            };
            tokio::time::timeout(self.deadline, op).await.map_err(|_| {
                DirectoryError::DeadlineExceeded {
                    write_outcome_unknown: false,
                }
            })?
        })
    }
}

const OBSERVE: &str = r#"
local t=redis.call('TYPE',KEYS[1]).ok
if t~='none' and t~='hash' then return {-3,'','',{}} end
if redis.call('HLEN',KEYS[1])>tonumber(ARGV[1]) then return {-2,'','',{}} end
local fields=redis.call('HGETALL',KEYS[1]);local bytes=0
for i=1,#fields do bytes=bytes+#fields[i] end
if bytes>tonumber(ARGV[2]) then return {-2,'','',{}} end
return {1,redis.call('GET',KEYS[2]) or '',redis.call('GET',KEYS[3]) or '',fields}
"#;
// Validate every type BEFORE the first mutation: Redis Lua does not roll back.
const PUBLISH: &str = r#"
for i=1,#KEYS do
 local t=redis.call('TYPE',KEYS[i]).ok
 local want='string';if i==1 then want='hash' elseif i==5 then want='set' end
 if i~=6 and i~=7 and t~='none' and t~=want then return {-3,''} end
end
if (redis.call('GET',KEYS[4]) or '')~=ARGV[2] then return {0,''} end
if ARGV[6]~='' and (redis.call('GET',KEYS[3]) or '')~=ARGV[1] then return {0,''} end
if ARGV[6]~='' and redis.call('GET',KEYS[8])~=ARGV[6] then return {-1,''} end
local fence=redis.call('GET',KEYS[2]);if fence and fence>ARGV[4] then return {0,''} end
redis.call('HSET',KEYS[1],unpack(ARGV,7))
local complete=true
-- Legacy source hashes omit unknown expiry; that does not make metadata incomplete.
for _,field in ipairs({'access_token','refresh_token','has_permissions','up_to_date_permissions'}) do
 if redis.call('HEXISTS',KEYS[1],field)==0 then complete=false end
end
if complete then redis.call('HSET',KEYS[1],'id',ARGV[3]) else redis.call('HDEL',KEYS[1],'id') end
redis.call('SADD',KEYS[5],ARGV[3]);redis.call('SET',KEYS[3],ARGV[5]);redis.call('SET',KEYS[4],ARGV[5])
redis.call('DEL',KEYS[6],KEYS[7]);return {1,ARGV[5]}
"#;
const EVICT: &str = r#"
for i=1,#KEYS do
 local t=redis.call('TYPE',KEYS[i]).ok
 local want='string';if i==1 then want='hash' elseif i==4 then want='set' end
 if i~=5 and i~=6 and t~='none' and t~=want then return -3 end
end
if (redis.call('GET',KEYS[2]) or '')~=ARGV[1] or (redis.call('GET',KEYS[3]) or '')~=ARGV[2] then return 0 end
if ARGV[5]~='' and redis.call('GET',KEYS[7])~=ARGV[5] then return -1 end
if redis.call('HLEN',KEYS[1])~=(#ARGV-5)/2 then return 0 end
for i=6,#ARGV,2 do if redis.call('HGET',KEYS[1],ARGV[i])~=ARGV[i+1] then return 0 end end
redis.call('DEL',KEYS[1],KEYS[5],KEYS[6]);redis.call('SREM',KEYS[4],ARGV[3])
redis.call('SET',KEYS[2],ARGV[4]);redis.call('SET',KEYS[3],ARGV[4]);return 1
"#;
const VALIDATE: &str = r#"
if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end
for i=3,#KEYS do
 local id=ARGV[2*(i-3)+2];local version=ARGV[2*(i-3)+3]
 if redis.call('SISMEMBER',KEYS[2],id)~=1 then return 0 end
 local fence=redis.call('GET',KEYS[i]);if fence and fence>version then return 0 end
end
return 1
"#;
const RELEASE: &str =
    "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end return 1";
const VALIDATE_ACCOUNTS: &str = r#"
if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end
if redis.call('SCARD',KEYS[2])~=(#ARGV-1)/7 then return 0 end
local fields={'access_token','refresh_token','expires_at','has_permissions','up_to_date_permissions'}
for i=3,#KEYS,2 do
 local base=2+((i-3)/2)*7;local id=ARGV[base];local version=ARGV[base+1]
 if redis.call('SISMEMBER',KEYS[2],id)~=1 or redis.call('HGET',KEYS[i+1],'id')~=id then return 0 end
 local fence=redis.call('GET',KEYS[i]);if fence and fence>version then return 0 end
 for j=1,5 do if (redis.call('HGET',KEYS[i+1],fields[j]) or '')~=ARGV[base+1+j] then return 0 end end
end
return 1
"#;
const VALIDATE_IDS: &str = r#"
if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] or redis.call('SCARD',KEYS[2])~=#ARGV-1 then return 0 end
for i=2,#ARGV do if redis.call('SISMEMBER',KEYS[2],ARGV[i])~=1 then return 0 end end
return 1
"#;
const IDS: &str = r#"
if redis.call('SCARD',KEYS[1])>tonumber(ARGV[3]) then return {-1,{}} end
local page=redis.call('SSCAN',KEYS[1],ARGV[1],'COUNT',ARGV[2]);local bytes=0
for _,id in ipairs(page[2]) do bytes=bytes+#id;if #id>1024 or bytes>1048576 then return {-1,{}} end end
return page
"#;
const HASH_IDS: &str = r#"
local page=redis.call('SCAN',ARGV[1],'MATCH',ARGV[3],'COUNT',ARGV[2]);local result={};local bytes=0
for _,key in ipairs(page[2]) do
 local id=string.sub(key,tonumber(ARGV[4])+1,-6);bytes=bytes+#id
 if #id>1024 or bytes>1048576 or #result>=4096 then return {-1,{}} end
 table.insert(result,id)
end
return {page[1],result}
"#;
const KICK: &str = r#"
return redis.call('HMGET',KEYS[1],'access_token','refresh_token','expires_at','has_permissions','up_to_date_permissions')
"#;

pub struct RedisStreamerCache {
    connection: ConnectionManager,
    namespace: String,
    namespace_valid: bool,
    deadline: Duration,
    read: Script,
    observe: Script,
    publish: Script,
    evict: Script,
    validate: Script,
    validate_accounts: Script,
    validate_ids: Script,
    release: Script,
    ids: Script,
    hash_ids: Script,
    kick: Script,
}
impl RedisStreamerCache {
    pub fn new(connection: ConnectionManager) -> Self {
        Self::with_namespace(connection, String::new())
    }
    /// Namespace is a trusted fixture/application prefix. Invalid (>1024-byte or
    /// control-containing) prefixes produce InvalidInput on every operation.
    pub fn with_namespace(connection: ConnectionManager, namespace: impl Into<String>) -> Self {
        let namespace = namespace.into();
        let namespace_valid = namespace.len() <= 1024 && !namespace.chars().any(char::is_control);
        Self {
            connection,
            namespace: if namespace_valid {
                namespace
            } else {
                String::new()
            },
            namespace_valid,
            deadline: DEADLINE,
            read: Script::new(READ_PLAN_ACCOUNT_SCRIPT),
            observe: Script::new(OBSERVE),
            publish: Script::new(PUBLISH),
            evict: Script::new(EVICT),
            validate: Script::new(VALIDATE),
            validate_accounts: Script::new(VALIDATE_ACCOUNTS),
            validate_ids: Script::new(VALIDATE_IDS),
            release: Script::new(RELEASE),
            ids: Script::new(IDS),
            hash_ids: Script::new(HASH_IDS),
            kick: Script::new(KICK),
        }
    }
    pub fn with_deadline(mut self, deadline: Duration) -> Result<Self, DirectoryError> {
        validate_deadline(deadline)?;
        self.deadline = deadline;
        Ok(self)
    }
    fn key(&self, suffix: &str) -> String {
        format!("{}{suffix}", self.namespace)
    }
    fn account(&self, id: &str) -> String {
        self.key(&account_cache_key(id))
    }
    fn generation(&self, id: &str) -> String {
        self.key(&directory_generation_key(id))
    }
    async fn bounded<T>(
        &self,
        write: bool,
        operation: impl Future<Output = redis::RedisResult<T>>,
    ) -> Result<T, DirectoryError> {
        if !self.namespace_valid {
            return Err(DirectoryError::InvalidInput);
        }
        tokio::time::timeout(self.deadline, operation)
            .await
            .map_err(|_| DirectoryError::DeadlineExceeded {
                write_outcome_unknown: write,
            })?
            .map_err(|_| DirectoryError::CacheUnavailable {
                write_outcome_unknown: write,
            })
    }
}
fn validate_deadline(deadline: Duration) -> Result<(), DirectoryError> {
    if deadline.is_zero() || deadline > Duration::from_secs(30) {
        Err(DirectoryError::InvalidInput)
    } else {
        Ok(())
    }
}
fn pairs(fields: Vec<String>) -> Result<Vec<(String, String)>, DirectoryError> {
    if !fields.len().is_multiple_of(2) {
        return Err(DirectoryError::InvalidData);
    }
    let mut result = Vec::with_capacity(fields.len() / 2);
    let mut values = fields.into_iter();
    while let Some(k) = values.next() {
        result.push((k, values.next().ok_or(DirectoryError::InvalidData)?));
    }
    Ok(result)
}
fn mutation_status(status: i64) -> Result<(), DirectoryError> {
    match status {
        1 => Ok(()),
        0 => Err(DirectoryError::Stale),
        -1 => Err(DirectoryError::Busy),
        _ => Err(DirectoryError::CacheUnavailable {
            write_outcome_unknown: false,
        }),
    }
}
impl DirectoryCache for RedisStreamerCache {
    fn revision(&self) -> DirectoryFuture<'_, String> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let value: Option<String> = self
                .bounded(
                    false,
                    redis::cmd("GET")
                        .arg(self.key(REVISION))
                        .query_async(&mut connection),
                )
                .await?;
            Ok(value.unwrap_or_default())
        })
    }
    fn observe<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, DirectorySnapshot> {
        Box::pin(async move {
            check_id(id)?;
            let mut connection = self.connection.clone();
            let (status, revision, generation, fields): (i64, String, String, Vec<String>) = self
                .bounded(
                    false,
                    self.observe
                        .key(self.account(id))
                        .key(self.key(REVISION))
                        .key(self.generation(id))
                        .arg(MAX_ACCOUNT_FIELDS)
                        .arg(MAX_READ_ACCOUNT_BYTES)
                        .invoke_async(&mut connection),
                )
                .await?;
            if status == -2 {
                return Err(DirectoryError::TooLarge);
            }
            mutation_status(status)?;
            Ok(DirectorySnapshot {
                revision,
                generation,
                fields: pairs(fields)?,
            })
        })
    }
    fn read_accounts<'a>(&'a self, ids: &'a [String]) -> DirectoryFuture<'a, Vec<CachedStreamer>> {
        Box::pin(async move {
            if ids.len() > MAX_READ_BATCH_ACCOUNTS
                || ids.iter().map(String::len).sum::<usize>() > 64 * 1024
            {
                return Err(DirectoryError::TooLarge);
            }
            for id in ids {
                check_id(id)?;
            }
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let mut pipeline = redis::pipe();
            for id in ids {
                pipeline
                    .cmd("EVALSHA")
                    .arg(self.read.get_hash())
                    .arg(2)
                    .arg(self.account(id))
                    .arg(self.key(&plan_cache_fence_key(id)))
                    .arg(MAX_ACCOUNT_FIELDS)
                    .arg(MAX_READ_ACCOUNT_BYTES);
            }
            let mut connection = self.connection.clone();
            let operation = async {
                let response: redis::RedisResult<Vec<(i64, Vec<String>)>> =
                    pipeline.query_async(&mut connection).await;
                match response {
                    Err(error) if error.kind() == ErrorKind::Server(ServerErrorKind::NoScript) => {
                        self.read.load_async(&mut connection).await?;
                        pipeline.query_async(&mut connection).await
                    }
                    result => result,
                }
            };
            let records = self.bounded(false, operation).await?;
            if records.len() != ids.len() {
                return Err(DirectoryError::InvalidData);
            }
            records
                .into_iter()
                .zip(ids)
                .map(|((status, fields), id)| match status {
                    0 => Ok(CachedStreamer::Missing),
                    -1 => Ok(CachedStreamer::Stale),
                    -2 => Err(DirectoryError::TooLarge),
                    1 => Ok(CachedStreamer::Present(account_from_fields(
                        id,
                        pairs(fields)?,
                    )?)),
                    _ => Err(DirectoryError::InvalidData),
                })
                .collect()
        })
    }
    fn publish<'a>(
        &'a self,
        account: &'a StreamerMetadata,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, String> {
        Box::pin(async move {
            super::validate_metadata(account)?;
            let fields = account.cache_fields();
            if fields.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > MAX_READ_ACCOUNT_BYTES
            {
                return Err(DirectoryError::TooLarge);
            }
            let revision = uuid::Uuid::new_v4().to_string();
            let mut connection = self.connection.clone();
            let mut call = self.publish.prepare_invoke();
            for key in [
                self.account(&account.id),
                self.key(&plan_cache_fence_key(&account.id)),
                self.key(REVISION),
                self.generation(&account.id),
                self.key(MEMBERS),
                self.key("twitch:accounts"),
                self.key("streamers:by:name"),
                self.key(LEASE),
            ] {
                call.key(key);
            }
            call.arg(&expected.revision)
                .arg(&expected.generation)
                .arg(&account.id)
                .arg(&account.plan_version)
                .arg(&revision)
                .arg(lease.unwrap_or(""));
            for (k, v) in fields {
                call.arg(k).arg(v);
            }
            let (status, new_revision): (i64, String) = self
                .bounded(true, call.invoke_async(&mut connection))
                .await?;
            mutation_status(status)?;
            Ok(new_revision)
        })
    }
    fn evict<'a>(
        &'a self,
        id: &'a str,
        expected: &'a DirectorySnapshot,
        lease: Option<&'a str>,
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            check_id(id)?;
            if expected.fields.len() > MAX_ACCOUNT_FIELDS
                || expected
                    .fields
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>()
                    > MAX_READ_ACCOUNT_BYTES
            {
                return Err(DirectoryError::TooLarge);
            }
            let mut connection = self.connection.clone();
            let mut call = self.evict.prepare_invoke();
            for key in [
                self.account(id),
                self.key(REVISION),
                self.generation(id),
                self.key(MEMBERS),
                self.key("twitch:accounts"),
                self.key("streamers:by:name"),
                self.key(LEASE),
            ] {
                call.key(key);
            }
            call.arg(&expected.revision)
                .arg(&expected.generation)
                .arg(id)
                .arg(uuid::Uuid::new_v4().to_string())
                .arg(lease.unwrap_or(""));
            for (k, v) in &expected.fields {
                call.arg(k).arg(v);
            }
            let status: i64 = self
                .bounded(true, call.invoke_async(&mut connection))
                .await?;
            mutation_status(status)?;
            Ok(true)
        })
    }
    fn ids<'a>(&'a self, cursor: u64, count: usize) -> DirectoryFuture<'a, IdPage> {
        Box::pin(async move {
            if count == 0 || count > 64 {
                return Err(DirectoryError::InvalidInput);
            }
            let mut connection = self.connection.clone();
            // SSCAN COUNT is a hint, not an output bound. SCARD rejects oversized
            // sets before SSCAN, bounding even a compact-set response to 4096 ids.
            let (next, ids): (i64, Vec<String>) = self
                .bounded(
                    false,
                    self.ids
                        .key(self.key(MEMBERS))
                        .arg(cursor)
                        .arg(count)
                        .arg(4096)
                        .invoke_async(&mut connection),
                )
                .await?;
            if next < 0 || ids.len() > 4096 {
                return Err(DirectoryError::TooLarge);
            }
            Ok(IdPage {
                ids,
                next: next as u64,
            })
        })
    }
    fn hash_ids<'a>(&'a self, cursor: u64, count: usize) -> DirectoryFuture<'a, IdPage> {
        Box::pin(async move {
            if count == 0 || count > 64 {
                return Err(DirectoryError::InvalidInput);
            }
            let operation = async {
                // Escape glob syntax in an injected fixture namespace. Account ids are
                // recovered from the exact owned prefix/suffix, never an arbitrary key.
                let prefix = self.key("accounts:twitch:");
                let escaped = prefix
                    .chars()
                    .flat_map(|c| {
                        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
                            vec!['\\', c]
                        } else {
                            vec![c]
                        }
                    })
                    .collect::<String>();
                let mut connection = self.connection.clone();
                let (next, ids): (i64, Vec<String>) = self
                    .bounded(
                        false,
                        self.hash_ids
                            .arg(cursor)
                            .arg(count)
                            .arg(format!("{escaped}*:data"))
                            .arg(prefix.len())
                            .invoke_async(&mut connection),
                    )
                    .await?;
                if next < 0 || ids.len() > 4096 {
                    return Err(DirectoryError::TooLarge);
                }
                for id in &ids {
                    check_id(id)?;
                }
                // Dragonfly requires Lua key reads to be declared in KEYS. SCAN's
                // discovered names therefore leave Lua before TYPE reads them.
                // Explicit native commands keep filtering bounded without dynamic
                // key access inside the script; both phases share this deadline.
                let mut hashes = Vec::with_capacity(ids.len());
                for batch in ids.chunks(MAX_READ_BATCH_ACCOUNTS) {
                    let mut pipeline = redis::pipe();
                    for id in batch {
                        pipeline.cmd("TYPE").arg(self.account(id));
                    }
                    let types: Vec<String> = self
                        .bounded(false, pipeline.query_async(&mut connection))
                        .await?;
                    if types.len() != batch.len() {
                        return Err(DirectoryError::InvalidData);
                    }
                    for (id, kind) in batch.iter().zip(types) {
                        if kind == "hash" {
                            hashes.push(id.clone());
                        }
                    }
                }
                Ok(IdPage {
                    ids: hashes,
                    next: next as u64,
                })
            };
            tokio::time::timeout(self.deadline, operation)
                .await
                .map_err(|_| DirectoryError::DeadlineExceeded {
                    write_outcome_unknown: false,
                })?
        })
    }
    fn validate<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [(String, String)],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            if accounts.len() > 4096
                || accounts
                    .iter()
                    .map(|(id, v)| id.len() * 2 + v.len() + 64)
                    .sum::<usize>()
                    > 4 * 1024 * 1024
            {
                return Err(DirectoryError::TooLarge);
            }
            let mut connection = self.connection.clone();
            let mut call = self.validate.prepare_invoke();
            call.key(self.key(REVISION)).key(self.key(MEMBERS));
            for (id, _) in accounts {
                check_id(id)?;
                call.key(self.key(&plan_cache_fence_key(id)));
            }
            call.arg(revision);
            for (id, version) in accounts {
                call.arg(id).arg(version);
            }
            let accepted: i64 = self
                .bounded(false, call.invoke_async(&mut connection))
                .await?;
            Ok(accepted == 1)
        })
    }
    fn validate_ids<'a>(
        &'a self,
        revision: &'a str,
        ids: &'a [String],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            if ids.len() > 4096 || ids.iter().map(String::len).sum::<usize>() > 1024 * 1024 {
                return Err(DirectoryError::TooLarge);
            }
            let mut seen = std::collections::BTreeSet::new();
            for id in ids {
                check_id(id)?;
                if !seen.insert(id) {
                    return Err(DirectoryError::InvalidInput);
                }
            }
            let mut connection = self.connection.clone();
            let mut call = self.validate_ids.prepare_invoke();
            call.key(self.key(REVISION))
                .key(self.key(MEMBERS))
                .arg(revision);
            for id in ids {
                call.arg(id);
            }
            let accepted: i64 = self
                .bounded(false, call.invoke_async(&mut connection))
                .await?;
            Ok(accepted == 1)
        })
    }
    fn validate_accounts<'a>(
        &'a self,
        revision: &'a str,
        accounts: &'a [super::StreamerAccount],
    ) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            let bytes = accounts
                .iter()
                .map(|a| {
                    a.metadata.id.len() * 3
                        + a.metadata.plan_version.len()
                        + a.access_token.len()
                        + a.refresh_token.len()
                        + a.expires_at.len()
                        + a.has_permissions.len()
                        + a.up_to_date_permissions.len()
                        + self.namespace.len() * 2
                        + 128
                })
                .sum::<usize>();
            if accounts.len() > 4096 || bytes > 4 * 1024 * 1024 {
                return Err(DirectoryError::TooLarge);
            }
            let mut connection = self.connection.clone();
            let mut call = self.validate_accounts.prepare_invoke();
            call.key(self.key(REVISION)).key(self.key(MEMBERS));
            let mut seen = std::collections::BTreeSet::new();
            for account in accounts {
                check_id(&account.metadata.id)?;
                if !seen.insert(&account.metadata.id) {
                    return Err(DirectoryError::InvalidInput);
                }
                call.key(self.key(&plan_cache_fence_key(&account.metadata.id)))
                    .key(self.account(&account.metadata.id));
            }
            call.arg(revision);
            for account in accounts {
                call.arg(&account.metadata.id)
                    .arg(&account.metadata.plan_version)
                    .arg(&account.access_token)
                    .arg(&account.refresh_token)
                    .arg(&account.expires_at)
                    .arg(&account.has_permissions)
                    .arg(&account.up_to_date_permissions);
            }
            let accepted: i64 = self
                .bounded(false, call.invoke_async(&mut connection))
                .await?;
            Ok(accepted == 1)
        })
    }
    fn acquire_lease<'a>(&'a self, owner: &'a str, ttl: Duration) -> DirectoryFuture<'a, bool> {
        Box::pin(async move {
            if owner.is_empty()
                || owner.len() > 128
                || ttl.is_zero()
                || ttl > Duration::from_secs(60)
            {
                return Err(DirectoryError::InvalidInput);
            }
            let mut connection = self.connection.clone();
            let accepted: Option<String> = self
                .bounded(
                    true,
                    redis::cmd("SET")
                        .arg(self.key(LEASE))
                        .arg(owner)
                        .arg("NX")
                        .arg("PX")
                        .arg(ttl.as_millis() as u64)
                        .query_async(&mut connection),
                )
                .await?;
            Ok(accepted.is_some())
        })
    }
    fn release_lease<'a>(&'a self, owner: &'a str) -> DirectoryFuture<'a, ()> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let _: i64 = self
                .bounded(
                    true,
                    self.release
                        .key(self.key(LEASE))
                        .arg(owner)
                        .invoke_async(&mut connection),
                )
                .await?;
            Ok(())
        })
    }
    fn kick_credentials<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, Option<CachedAccount>> {
        Box::pin(async move {
            check_id(id)?;
            let mut connection = self.connection.clone();
            let values: Vec<Option<String>> = self
                .bounded(
                    false,
                    self.kick
                        .key(self.key(&format!("accounts:kick:{id}:data")))
                        .invoke_async(&mut connection),
                )
                .await?;
            if values.len() != 5 {
                return Err(DirectoryError::InvalidData);
            }
            if values.iter().all(Option::is_none) {
                return Ok(None);
            }
            Ok(Some(CachedAccount {
                id: id.into(),
                access_token: values[0].clone().unwrap_or_default(),
                refresh_token: values[1].clone().unwrap_or_default(),
                expires_at: values[2].clone().unwrap_or_default(),
                has_permissions: values[3].as_deref() == Some("true"),
                up_to_date_permissions: values[4].as_deref() == Some("true"),
            }))
        })
    }
}

#[cfg(feature = "twitch-streamers-posthog")]
pub struct PosthogStreamerIdentities {
    client: std::sync::Arc<posthog_rs::Client>,
    identities: crate::utils::posthog::StreamerIdentities,
}
#[cfg(feature = "twitch-streamers-posthog")]
impl PosthogStreamerIdentities {
    pub fn new(client: std::sync::Arc<posthog_rs::Client>) -> Self {
        Self {
            client,
            identities: Default::default(),
        }
    }
}
#[cfg(feature = "twitch-streamers-posthog")]
impl super::StreamerIdentitySink for PosthogStreamerIdentities {
    fn identify<'a>(&'a self, id: &'a str, name: &'a str) -> DirectoryFuture<'a, ()> {
        Box::pin(async move {
            if let Some(event) = self.identities.identify(id, name) {
                self.client.capture(event);
            }
            Ok(())
        })
    }
}
