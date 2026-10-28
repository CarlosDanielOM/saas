//! Redis-backed TTS session queue. Every key accessed by Lua is declared.
use redis::{RedisResult, Script, aio::ConnectionManager};
use std::collections::HashSet;

const ENQUEUE: &str = r#"-- DIMA032_ENQUEUE
local session = redis.call('GET', KEYS[3])
local item = cjson.decode(ARGV[1])
item.queueSession = session or cjson.null
redis.call('SET', KEYS[2], cjson.encode(item))
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return session or ''"#;
const POP: &str = r#"-- DIMA032_POP
local next = redis.call('ZRANGE', KEYS[1], 0, 0)
if #next == 0 then return {} end
if next[1] ~= ARGV[1] then return {'retry'} end
local payload = redis.call('GET', KEYS[3]) or ''
local session = redis.call('GET', KEYS[2]) or ''
redis.call('ZREM', KEYS[1], next[1])
return {next[1], payload, session}"#;
const RESET: &str = r#"-- DIMA032_RESET
local previous = redis.call('GET', KEYS[1]) or ''
local waiting = redis.call('ZRANGE', KEYS[2], 0, -1)
local processing = redis.call('GET', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
if processing then table.insert(waiting, processing) end
table.insert(waiting, 1, previous)
return waiting"#;
const CLEAN_OLD: &str = r#"-- DIMA032_CLEAN_OLD
for _, key in ipairs(KEYS) do
    local raw = redis.call('GET', key)
    if raw then
        local ok, item = pcall(cjson.decode, raw)
        if not ok or type(item) ~= 'table' or item.queueSession == nil or item.queueSession == cjson.null or item.queueSession == ARGV[1] then
            redis.call('DEL', key)
        end
    end
end
return 1"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoppedTtsSession {
    pub value: String,
    pub payload: String,
    pub session: Option<String>,
}

/// Takes an owned, caller-selected connection; it never reads configuration.
#[derive(Clone)]
pub struct TtsSession {
    cache: ConnectionManager,
}
impl TtsSession {
    pub fn new(cache: ConnectionManager) -> Self {
        Self { cache }
    }
    fn prefix(channel: &str) -> String {
        format!("twitch:{channel}:tts:")
    }
    pub async fn enqueue(
        &self,
        channel: &str,
        id: &str,
        score: f64,
        payload: &str,
    ) -> RedisResult<()> {
        let prefix = Self::prefix(channel);
        let mut cache = self.cache.clone();
        let _: String = Script::new(ENQUEUE)
            .key(format!("{prefix}queue"))
            .key(format!("{prefix}queue:data:{id}"))
            .key(format!("{prefix}session"))
            .arg(payload)
            .arg(score)
            .arg(id)
            .invoke_async(&mut cache)
            .await?;
        Ok(())
    }
    pub async fn pop(&self, channel: &str) -> RedisResult<Option<PoppedTtsSession>> {
        let prefix = Self::prefix(channel);
        let queue = format!("{prefix}queue");
        let mut cache = self.cache.clone();
        for _ in 0..8 {
            let ids: Vec<String> = redis::cmd("ZRANGE")
                .arg(&queue)
                .arg(0)
                .arg(0)
                .query_async(&mut cache)
                .await?;
            let Some(id) = ids.first().filter(|id| !id.is_empty()) else {
                return Ok(None);
            };
            let value: Vec<String> = Script::new(POP)
                .key(&queue)
                .key(format!("{prefix}session"))
                .key(format!("{prefix}queue:data:{id}"))
                .arg(id)
                .invoke_async(&mut cache)
                .await?;
            if value.len() == 1 && value[0] == "retry" {
                continue;
            }
            if value.is_empty() {
                return Ok(None);
            }
            // Lua returns exactly three values for a successful pop.
            return Ok(Some(PoppedTtsSession {
                value: value[0].clone(),
                payload: value[1].clone(),
                session: (!value[2].is_empty()).then(|| value[2].clone()),
            }));
        }
        Ok(None)
    }
    pub async fn reset(
        &self,
        channel: &str,
        session: &str,
        orphan_keys: &[String],
    ) -> RedisResult<()> {
        let prefix = Self::prefix(channel);
        let script = Script::new(RESET);
        let mut invocation = script.prepare_invoke();
        invocation
            .key(format!("{prefix}session"))
            .key(format!("{prefix}queue"))
            .key(format!("{prefix}processing"))
            .key(format!("{prefix}connected"))
            .key(format!("{prefix}last_cleanup"));
        for key in orphan_keys {
            invocation.key(key);
        }
        invocation.arg(session);
        let mut cache = self.cache.clone();
        let result: Vec<String> = invocation.invoke_async(&mut cache).await?;
        let previous = &result[0];
        let mut seen = HashSet::new();
        let keys: Vec<String> = result[1..]
            .iter()
            .filter(|id| seen.insert((*id).clone()))
            .map(|id| format!("{prefix}queue:data:{id}"))
            .collect();
        let cleanup = Script::new(CLEAN_OLD);
        for chunk in keys.chunks(128) {
            let mut call = cleanup.prepare_invoke();
            for key in chunk {
                call.key(key);
            }
            call.arg(previous);
            let _: i64 = call.invoke_async(&mut cache).await?;
        }
        Ok(())
    }
}
