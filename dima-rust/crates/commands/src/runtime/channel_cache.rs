//! What a stream going online or offline resets in Dragonfly (reference: `utils/cache.ts`,
//! called by `domain_events/stream_operations_events.ts` in the cron), and the Dragonfly
//! implementation of [`RoleCache`] the bot's identity resolution and these loads use.
//!
//! - [`load_channel_admins`]: the channel's active admins from MongoDB into the role cache
//!   (`twitch:{channel}:admins`, `:admins:ids`, `:admins:{admin}`), replacing whatever was
//!   there, current or legacy, through [`crate::permissions::populate_admin_cache`].
//! - [`clear_channel_cache`]: deletes `{channel}:follows:count`.
//! - [`reset_sumimetro`]: deletes every `{channel}:sumimetro:*` key.
//!
//! Intended differences: keys are found with `SCAN` (bounded, [`MAX_MATCHED_KEYS`]) instead of
//! `KEYS`; a channel id holding a glob character (`*?[]\`) is refused, where the reference's
//! pattern would also match other channels' keys; at most [`MAX_ADMINS`] admins are loaded and
//! an admin document that cannot be read is skipped. `clearChannelCache` also deletes
//! `{channel}:commands`, a key nothing has written for years; Rust never writes it either, so
//! it is not deleted (the command snapshot has its own protocol, [`super::lookup`]).

use bson::{RawDocumentBuf, doc};
use dima_model::admins::{Admin, COLLECTION};
use futures_util::TryStreamExt;

use super::{KeyPrefix, RuntimeError, Stores, within};
use crate::permissions::{AdminEntry, RoleCache, populate_admin_cache};

/// The most keys one pattern may match before the operation is refused.
pub const MAX_MATCHED_KEYS: usize = 10_000;
/// The most admins loaded for one channel.
pub const MAX_ADMINS: i64 = 1_000;

/// [`RoleCache`] on Dragonfly, under the stores' key prefix.
#[derive(Clone, Debug)]
pub struct DragonflyRoleCache {
    stores: Stores,
}

impl DragonflyRoleCache {
    /// The role cache of `stores`.
    pub fn new(stores: Stores) -> Self {
        Self { stores }
    }

    fn key(&self, key: &str) -> String {
        self.stores.keys.key(key)
    }

    async fn simple(&self, command: redis::Cmd) -> Result<(), RuntimeError> {
        self.stores.dragonfly.query_value(&command).await?;
        Ok(())
    }
}

/// Whether `channel_id` can be put in a glob pattern as it is.
fn glob_safe(channel_id: &str) -> bool {
    !channel_id.is_empty() && !channel_id.contains(['*', '?', '[', ']', '\\'])
}

/// The keys matching `pattern` (already prefixed), at most [`MAX_MATCHED_KEYS`].
async fn scan_keys(stores: &Stores, pattern: &str) -> Result<Vec<String>, RuntimeError> {
    let mut scan = stores.dragonfly.scan(pattern, Some(500));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        for key in page {
            let key = String::from_utf8(key).map_err(|_| RuntimeError::Reply("SCAN"))?;
            keys.push(key);
        }
        if keys.len() > MAX_MATCHED_KEYS {
            return Err(RuntimeError::Reply("SCAN matched too many keys"));
        }
    }
    Ok(keys)
}

fn strip<'a>(prefix: &KeyPrefix, key: &'a str) -> &'a str {
    key.strip_prefix(prefix.as_str()).unwrap_or(key)
}

impl RoleCache for DragonflyRoleCache {
    type Error = RuntimeError;

    async fn is_member(&self, key: &str, member: &str) -> Result<bool, Self::Error> {
        let mut command = redis::cmd("SISMEMBER");
        command.arg(self.key(key)).arg(member);
        let found: i64 = self.stores.dragonfly.query(&command).await?;
        Ok(found == 1)
    }

    async fn add(&self, key: &str, member: &str) -> Result<(), Self::Error> {
        let mut command = redis::cmd("SADD");
        command.arg(self.key(key)).arg(member);
        self.simple(command).await
    }

    async fn remove(&self, key: &str, member: &str) -> Result<(), Self::Error> {
        let mut command = redis::cmd("SREM");
        command.arg(self.key(key)).arg(member);
        self.simple(command).await
    }

    async fn delete(&self, keys: &[String]) -> Result<(), Self::Error> {
        let mut command = redis::cmd("DEL");
        for key in keys {
            command.arg(self.key(key));
        }
        self.simple(command).await
    }

    async fn expire(&self, key: &str, seconds: u64) -> Result<(), Self::Error> {
        let mut command = redis::cmd("EXPIRE");
        command.arg(self.key(key)).arg(seconds);
        self.simple(command).await
    }

    async fn keys_matching(&self, pattern: &str) -> Result<Vec<String>, Self::Error> {
        let keys = scan_keys(&self.stores, &self.key(pattern)).await?;
        Ok(keys
            .iter()
            .map(|key| strip(&self.stores.keys, key).to_owned())
            .collect())
    }

    async fn set_hash(&self, key: &str, fields: &[(&str, String)]) -> Result<(), Self::Error> {
        let mut command = redis::cmd("HSET");
        command.arg(self.key(key));
        for (field, value) in fields {
            command.arg(*field).arg(value);
        }
        self.simple(command).await
    }
}

/// `loadChannelAdminsIntoCache(channelID)`: `admins.find({channelID, actived: true})` into the
/// role cache. Returns how many admins were read.
pub async fn load_channel_admins(
    stores: &Stores,
    channel_id: &str,
    deadline: std::time::Duration,
) -> Result<usize, RuntimeError> {
    if !glob_safe(channel_id) {
        return Err(RuntimeError::Reply("a channel id with glob characters"));
    }
    let admins: Vec<RawDocumentBuf> = within("admins.find", deadline, async {
        stores
            .mongo
            .collection::<RawDocumentBuf>(COLLECTION)
            .find(doc! { "channelID": channel_id, "actived": true })
            .limit(MAX_ADMINS)
            .await?
            .try_collect()
            .await
    })
    .await?;
    let admins: Vec<Admin> = admins
        .iter()
        .filter_map(|raw| dima_model::decode(raw).ok())
        .collect();
    let entries: Vec<AdminEntry<'_>> = admins
        .iter()
        .map(|admin| AdminEntry {
            admin_id: &admin.admin_id,
            admin_name: &admin.admin_name,
            channel_name: &admin.channel_name,
            permissions: &admin.permissions,
            actived: admin.actived,
        })
        .collect();
    populate_admin_cache(
        &DragonflyRoleCache::new(stores.clone()),
        channel_id,
        &entries,
    )
    .await?;
    Ok(admins.len())
}

/// `clearChannelCache(channelID)`: deletes `{channel}:follows:count`.
pub async fn clear_channel_cache(stores: &Stores, channel_id: &str) -> Result<(), RuntimeError> {
    let key = stores.keys.key(format_args!("{channel_id}:follows:count"));
    stores.dragonfly.del(&[key.as_str()]).await?;
    Ok(())
}

/// `resetSumimetro(channelID)`: deletes every `{channel}:sumimetro:*` key. Returns how many.
pub async fn reset_sumimetro(stores: &Stores, channel_id: &str) -> Result<usize, RuntimeError> {
    if !glob_safe(channel_id) {
        return Err(RuntimeError::Reply("a channel id with glob characters"));
    }
    let keys = scan_keys(
        stores,
        &stores.keys.key(format_args!("{channel_id}:sumimetro:*")),
    )
    .await?;
    for chunk in keys.chunks(500) {
        let refs: Vec<&str> = chunk.iter().map(String::as_str).collect();
        stores.dragonfly.del(&refs).await?;
    }
    Ok(keys.len())
}
