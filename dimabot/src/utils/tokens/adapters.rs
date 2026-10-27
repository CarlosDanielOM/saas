//! Injected native database handles only; connection creation belongs to caller.

use mongodb::{
    Collection, Database,
    bson::{self, Bson, Document, doc},
};
use redis::aio::ConnectionManager;

use super::{
    CachedAccount, CredentialStore, StorageFuture, StoredAccount, TWITCH_BOT_ACCOUNT_ID,
    TokenCache, TokenStorageError, directory_generation_key,
};
use crate::utils::credential_crypto::StoredCredential;

pub struct MongoCredentialStore {
    users: Collection<Document>,
}
impl MongoCredentialStore {
    pub fn new(database: &Database) -> Self {
        Self {
            users: database.collection("users"),
        }
    }
}

fn envelope(value: Option<&Bson>) -> Result<Option<StoredCredential>, TokenStorageError> {
    match value {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::Document(document)) => bson::deserialize_from_document(document.clone())
            .map(Some)
            .map_err(|_| TokenStorageError::StoreUnavailable),
        _ => Err(TokenStorageError::StoreUnavailable),
    }
}
fn number(value: Option<&Bson>) -> Option<f64> {
    match value {
        Some(Bson::Double(value)) => Some(*value),
        Some(Bson::Int64(value)) => Some(*value as f64),
        Some(Bson::Int32(value)) => Some(*value as f64),
        _ => None,
    }
}
fn encoded(value: Option<&StoredCredential>) -> Bson {
    match value {
        Some(value) => Bson::Document(doc! {
            "iv": value.iv.clone().map(Bson::String).unwrap_or(Bson::Null),
            "content": value.content.clone().map(Bson::String).unwrap_or(Bson::Null),
        }),
        None => Bson::Null,
    }
}
impl CredentialStore for MongoCredentialStore {
    fn load<'a>(
        &'a self,
        id: &'a str,
    ) -> StorageFuture<'a, Result<Option<StoredAccount>, TokenStorageError>> {
        Box::pin(async move {
            let found = self
                .users
                .find_one(doc! {
                    "accounts": { "$elemMatch": { "id": id, "type": "twitch" } }
                })
                .projection(doc! { "accounts": { "$elemMatch": { "id": id, "type": "twitch" } } })
                .await
                .map_err(|_| TokenStorageError::StoreUnavailable)?;
            let Some(found) = found else { return Ok(None) };
            let account = found
                .get_array("accounts")
                .ok()
                .and_then(|accounts| accounts.first())
                .and_then(Bson::as_document)
                .ok_or(TokenStorageError::StoreUnavailable)?;
            Ok(Some(StoredAccount {
                id: account
                    .get_str("id")
                    .map_err(|_| TokenStorageError::StoreUnavailable)?
                    .to_owned(),
                access_token: envelope(account.get("access_token"))?,
                refresh_token: envelope(account.get("refresh_token"))?,
                expires_at: number(account.get("access_token_expires_at")),
                has_permissions: account.get_bool("has_permissions").unwrap_or(false),
                up_to_date_permissions: account.get_bool("up_to_date_permissions").unwrap_or(false),
            }))
        })
    }
    fn replace<'a>(
        &'a self,
        expected: &'a StoredAccount,
        replacement: &'a StoredAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            if expected.id != replacement.id {
                return Err(TokenStorageError::IdentityMismatch);
            }
            let mut element = doc! { "id": &expected.id, "type": "twitch" };
            match &expected.refresh_token {
                None => {
                    element.insert("refresh_token", Bson::Null);
                }
                Some(token) => {
                    element.insert(
                        "refresh_token.iv",
                        token.iv.clone().map(Bson::String).unwrap_or(Bson::Null),
                    );
                    element.insert(
                        "refresh_token.content",
                        token
                            .content
                            .clone()
                            .map(Bson::String)
                            .unwrap_or(Bson::Null),
                    );
                }
            }
            let update = doc! { "$set": {
                "accounts.$.access_token": encoded(replacement.access_token.as_ref()),
                "accounts.$.refresh_token": encoded(replacement.refresh_token.as_ref()),
                "accounts.$.access_token_expires_at": replacement.expires_at.map(Bson::Double).unwrap_or(Bson::Null),
                "accounts.$.has_permissions": replacement.has_permissions,
                "accounts.$.up_to_date_permissions": replacement.up_to_date_permissions,
            }};
            let result = self
                .users
                .update_one(doc! { "accounts": { "$elemMatch": element } }, update)
                .await
                .map_err(|_| TokenStorageError::StoreUnavailable)?;
            Ok(result.matched_count == 1)
        })
    }
}

/// Source-compatible keys by default; a namespace isolates disposable fixtures.
/// Never derives connection settings or secrets from environment variables.
pub struct RedisTokenCache {
    connection: ConnectionManager,
    namespace: String,
}
impl RedisTokenCache {
    pub fn new(connection: ConnectionManager) -> Self {
        Self {
            connection,
            namespace: String::new(),
        }
    }
    pub fn with_namespace(connection: ConnectionManager, namespace: impl Into<String>) -> Self {
        Self {
            connection,
            namespace: namespace.into(),
        }
    }
    fn key(&self, suffix: &str) -> String {
        format!("{}{suffix}", self.namespace)
    }
    fn account_key(&self, id: &str) -> String {
        self.key(&format!("accounts:twitch:{id}:data"))
    }
    fn lock_key(&self, id: &str) -> String {
        self.key(&format!("locks:refresh:twitch:{id}"))
    }
}

const PUBLISH: &str = r#"
if #KEYS == 4 and (redis.call('GET', KEYS[4]) or '') ~= ARGV[13] then return 0 end
local fields = {'access_token', 'refresh_token', 'expires_at', 'has_permissions', 'up_to_date_permissions'}
local absent = true
for _, field in ipairs(fields) do
  if redis.call('HEXISTS', KEYS[1], field) == 1 then absent = false end
end
if ARGV[1] == 'absent' then
  if not absent then return 0 end
else
  if absent then return 0 end
  for i, field in ipairs(fields) do
    local current = redis.call('HGET', KEYS[1], field) or ''
    if i >= 4 then current = current == 'true' and 'true' or 'false' end
    if current ~= ARGV[i + 1] then return 0 end
  end
end
redis.call('HSET', KEYS[1], 'access_token', ARGV[7], 'refresh_token', ARGV[8],
  'expires_at', ARGV[9], 'has_permissions', ARGV[10], 'up_to_date_permissions', ARGV[11])
redis.call('SADD', KEYS[2], ARGV[12])
redis.call('DEL', KEYS[3])
return 1
"#;
const INVALIDATE: &str = r#"
if #KEYS == 4 and (redis.call('GET', KEYS[4]) or '') ~= ARGV[7] then return 0 end
local fields = {'access_token', 'refresh_token', 'expires_at', 'has_permissions', 'up_to_date_permissions'}
local absent = true
for _, field in ipairs(fields) do
  if redis.call('HEXISTS', KEYS[1], field) == 1 then absent = false end
end
if not absent then
  for i, field in ipairs(fields) do
    local current = redis.call('HGET', KEYS[1], field) or ''
    if i >= 4 then current = current == 'true' and 'true' or 'false' end
    if current ~= ARGV[i] then return 0 end
  end
end
redis.call('HSET', KEYS[1], 'access_token', '', 'refresh_token', '', 'expires_at', '',
  'has_permissions', 'false', 'up_to_date_permissions', 'false')
redis.call('DEL', KEYS[2])
if ARGV[6] == 'bot' then redis.call('HDEL', KEYS[3], 'access_token') end
return 1
"#;
const RELEASE: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"#;
// An acquire may pause after reading the account, then resume after a rotation
// or revocation. Fence its mirror write in the same Redis operation; bot auth
// intentionally does not impose the streamer's has_permissions gate.
const PUBLISH_BOT: &str = r#"
if ARGV[1] ~= '' and redis.call('HGET', KEYS[1], 'access_token') == ARGV[1] then
  redis.call('HSET', KEYS[2], 'access_token', ARGV[1])
  return 1
end
return 0
"#;

impl TokenCache for RedisTokenCache {
    fn fence<'a>(
        &'a self,
        id: &'a str,
    ) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let generation: Option<String> = redis::cmd("GET")
                .arg(self.key(&directory_generation_key(id)))
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(Some(generation.unwrap_or_default()))
        })
    }
    fn account<'a>(
        &'a self,
        id: &'a str,
    ) -> StorageFuture<'a, Result<Option<CachedAccount>, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let fields: [Option<String>; 6] = redis::cmd("HMGET")
                .arg(self.account_key(id))
                .arg(&[
                    "id",
                    "access_token",
                    "refresh_token",
                    "expires_at",
                    "has_permissions",
                    "up_to_date_permissions",
                ])
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            // No synthetic id is written: a partial Rust credential hash remains
            // visibly incomplete to TypeScript's getTwitchAccountById hydrator.
            if fields[1..].iter().all(Option::is_none) {
                return Ok(None);
            }
            let [
                stored_id,
                access_token,
                refresh_token,
                expires_at,
                permissions,
                current_permissions,
            ] = fields;
            Ok(Some(CachedAccount {
                id: stored_id.unwrap_or_else(|| id.to_owned()),
                access_token: access_token.unwrap_or_default(),
                refresh_token: refresh_token.unwrap_or_default(),
                expires_at: expires_at.unwrap_or_default(),
                has_permissions: permissions.is_some_and(|value| value == "true"),
                up_to_date_permissions: current_permissions.is_some_and(|value| value == "true"),
            }))
        })
    }
    fn put_account<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        self.put_account_fenced(account, expected, None)
    }
    fn put_account_fenced<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
        fence: Option<&'a str>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            if expected.is_some_and(|snapshot| snapshot.id != account.id) {
                return Err(TokenStorageError::IdentityMismatch);
            }
            let empty = CachedAccount::default();
            let snapshot = expected.unwrap_or(&empty);
            let mut connection = self.connection.clone();
            let mut command = redis::cmd("EVAL");
            command
                .arg(PUBLISH)
                .arg(if fence.is_some() { 4 } else { 3 })
                .arg(self.account_key(&account.id))
                .arg(self.key("streamers:by:id"))
                .arg(self.key("twitch:accounts"));
            if fence.is_some() {
                command.arg(self.key(&directory_generation_key(&account.id)));
            }
            command
                .arg(if expected.is_some() {
                    "compare"
                } else {
                    "absent"
                })
                .arg(&snapshot.access_token)
                .arg(&snapshot.refresh_token)
                .arg(&snapshot.expires_at)
                .arg(if snapshot.has_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(if snapshot.up_to_date_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(&account.access_token)
                .arg(&account.refresh_token)
                .arg(&account.expires_at)
                .arg(if account.has_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(if account.up_to_date_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(&account.id);
            if let Some(fence) = fence {
                command.arg(fence);
            }
            let written: i64 = command
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(written == 1)
        })
    }
    fn invalidate<'a>(
        &'a self,
        expected: &'a CachedAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        self.invalidate_fenced(expected, None)
    }
    fn invalidate_fenced<'a>(
        &'a self,
        expected: &'a CachedAccount,
        fence: Option<&'a str>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let mut command = redis::cmd("EVAL");
            command
                .arg(INVALIDATE)
                .arg(if fence.is_some() { 4 } else { 3 })
                .arg(self.account_key(&expected.id))
                .arg(self.key("twitch:accounts"))
                .arg(self.key("app:twitch:bot"));
            if fence.is_some() {
                command.arg(self.key(&directory_generation_key(&expected.id)));
            }
            command
                .arg(&expected.access_token)
                .arg(&expected.refresh_token)
                .arg(&expected.expires_at)
                .arg(if expected.has_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(if expected.up_to_date_permissions {
                    "true"
                } else {
                    "false"
                })
                .arg(if expected.id == TWITCH_BOT_ACCOUNT_ID {
                    "bot"
                } else {
                    "streamer"
                });
            if let Some(fence) = fence {
                command.arg(fence);
            }
            let written: i64 = command
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(written == 1)
        })
    }
    fn acquire<'a>(
        &'a self,
        id: &'a str,
        owner: &'a str,
        ttl_ms: u64,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let result: Option<String> = redis::cmd("SET")
                .arg(self.lock_key(id))
                .arg(owner)
                .arg("NX")
                .arg("PX")
                .arg(ttl_ms)
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(result.is_some())
        })
    }
    fn held<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let exists: i64 = redis::cmd("EXISTS")
                .arg(self.lock_key(id))
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(exists == 1)
        })
    }
    fn release<'a>(
        &'a self,
        id: &'a str,
        owner: &'a str,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let _: i64 = redis::cmd("EVAL")
                .arg(RELEASE)
                .arg(1)
                .arg(self.lock_key(id))
                .arg(owner)
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(())
        })
    }
    fn app<'a>(&'a self) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            redis::cmd("GET")
                .arg(self.key("app:twitch:token"))
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)
        })
    }
    fn put_app<'a>(
        &'a self,
        token: &'a str,
        ttl_seconds: u64,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            if ttl_seconds == 0 {
                return Err(TokenStorageError::InvalidExpiry);
            }
            let mut connection = self.connection.clone();
            let _: String = redis::cmd("SET")
                .arg(self.key("app:twitch:token"))
                .arg(token)
                .arg("EX")
                .arg(ttl_seconds)
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(())
        })
    }
    fn put_bot<'a>(&'a self, token: &'a str) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            let _: i64 = redis::cmd("EVAL")
                .arg(PUBLISH_BOT)
                .arg(2)
                .arg(self.account_key(TWITCH_BOT_ACCOUNT_ID))
                .arg(self.key("app:twitch:bot"))
                .arg(token)
                .query_async(&mut connection)
                .await
                .map_err(|_| TokenStorageError::CacheUnavailable)?;
            Ok(())
        })
    }
}
