//! Redis and Dragonfly connections (`redis.mjs`, node-redis 5 speaking RESP2).
//!
//! One cached client per connection id, created on first use and dropped when the connection
//! is deleted. Commands are sent exactly as node-redis encodes them; replies are rendered as
//! node-redis returns them (bulk strings decoded as UTF-8 with replacement characters, integers
//! as JavaScript numbers, nil as `null`, hashes and stream messages as objects, sorted-set scores
//! through node-redis's double parser).
//!
//! Timeouts (the reference has none): connecting gives up after [`CONNECT_TIMEOUT`] (node-redis
//! keeps retrying forever and the request never answers), a command after [`COMMAND_TIMEOUT`]
//! (generous, because operators run arbitrary commands and scripts).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use redis::Value as Reply;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use serde_json::{Map, Value, json};

use crate::config::Engine;
use crate::connections::Registry;
use crate::error::{ApiError, ApiResult};
use crate::js;

/// Opening a connection (node-redis's own `connectTimeout`).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// One command.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

const DANGEROUS: [&str; 14] = [
    "FLUSHALL",
    "FLUSHDB",
    "EVAL",
    "EVALSHA",
    "CONFIG",
    "DEBUG",
    "SHUTDOWN",
    "REPLICAOF",
    "SLAVEOF",
    "MODULE",
    "ACL",
    "SWAPDB",
    "MIGRATE",
    "RESTORE",
];

const MUTATE_OPS: [&str; 11] = [
    "ttl", "hset", "hdel", "lset", "lpush", "rpush", "ldel", "sadd", "srem", "zadd", "zrem",
];

/// Tree scans stop after this many rounds or keys.
const TREE_MAX_ROUNDS: usize = 120;
const TREE_MAX_KEYS: usize = 40_000;

/// The cached clients.
#[derive(Default)]
pub struct RedisHub {
    clients: Mutex<HashMap<String, ConnectionManager>>,
}

impl std::fmt::Debug for RedisHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisHub").finish_non_exhaustive()
    }
}

/// A connection plus the context the commands need.
pub struct Client {
    conn: ConnectionManager,
}

/// A command argument as node-redis encodes it.
fn arg(text: &str) -> &[u8] {
    text.as_bytes()
}

impl RedisHub {
    /// `drop(id)`: forgets the client (its connection closes when the last use ends).
    pub fn drop_client(&self, id: &str) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.remove(id);
        }
    }

    /// Closes every client (shutdown).
    pub fn clear(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.clear();
        }
    }

    /// `clientFor(id)`.
    pub async fn client(&self, registry: &Registry<'_>, id: &str) -> ApiResult<Client> {
        let row = registry.require(id, Some(Engine::Redis)).await?;
        if let Some(conn) = self.clients.lock().ok().and_then(|c| c.get(id).cloned()) {
            return Ok(Client { conn });
        }
        let url = registry.resolve_url_text(&row)?;
        let client = redis::Client::open(url.as_str())
            .map_err(|error| ApiError::internal(redis_message(&error, &url)))?;
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(CONNECT_TIMEOUT))
            .set_response_timeout(Some(COMMAND_TIMEOUT))
            .set_number_of_retries(1);
        let conn = tokio::time::timeout(
            CONNECT_TIMEOUT * 2,
            ConnectionManager::new_with_config(client, config),
        )
        .await
        .map_err(|_| ApiError::internal(format!("connect ETIMEDOUT {}", host_port(&url))))?
        .map_err(|error| ApiError::internal(redis_message(&error, &url)))?;
        if let Ok(mut clients) = self.clients.lock() {
            clients.insert(id.to_owned(), conn.clone());
        }
        Ok(Client { conn })
    }
}

/// `host:port` of a Redis URL, for connection errors (never the credentials).
fn host_port(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|parsed| {
            format!(
                "{}:{}",
                parsed.host_str().unwrap_or("localhost"),
                parsed.port().unwrap_or(6379)
            )
        })
        .unwrap_or_default()
}

/// A driver error as node-redis words it: server errors are their reply text
/// (`WRONGTYPE Operation against a key ...`), connection errors `connect ECONNREFUSED host:port`.
fn redis_message(error: &redis::RedisError, url: &str) -> String {
    if let Some(code) = error.code() {
        return match error.detail() {
            Some(detail) => format!("{code} {detail}"),
            None => code.to_owned(),
        };
    }
    if error.is_connection_refusal() {
        return format!("connect ECONNREFUSED {}", host_port(url));
    }
    if error.is_timeout() {
        return "Command timeout".to_owned();
    }
    error.to_string()
}

/// The reply text node-redis decodes (`Buffer#toString()`).
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A RESP2 reply as node-redis returns it from `sendCommand`.
pub fn reply_json(reply: Reply) -> Value {
    match reply {
        Reply::Nil => Value::Null,
        #[expect(clippy::cast_precision_loss, reason = "JavaScript numbers")]
        Reply::Int(n) => js::number_value(n as f64),
        Reply::BulkString(bytes) => Value::from(text(&bytes)),
        Reply::SimpleString(s) => Value::from(s),
        Reply::Okay => Value::from("OK"),
        Reply::Array(items) | Reply::Set(items) => {
            Value::Array(items.into_iter().map(reply_json).collect())
        }
        Reply::Map(pairs) => Value::Array(
            pairs
                .into_iter()
                .flat_map(|(k, v)| [reply_json(k), reply_json(v)])
                .collect(),
        ),
        Reply::Attribute { data, .. } => reply_json(*data),
        Reply::Double(n) => js::number_value(n),
        Reply::Boolean(flag) => Value::Bool(flag),
        Reply::VerbatimString { text, .. } => Value::from(text),
        Reply::BigNumber(n) => Value::from(text(&n)),
        Reply::Push { data, .. } => Value::Array(data.into_iter().map(reply_json).collect()),
        // An error inside an array is an `ErrorReply` object: JSON.stringify writes `{}`.
        // An error inside an array is an `ErrorReply` object, and future reply kinds have no
        // RESP2 form: JSON.stringify writes `{}` for either.
        _ => Value::Object(Map::new()),
    }
}

/// node-redis's `transformDoubleReply` (RESP2).
fn score(bytes: &[u8]) -> f64 {
    match text(bytes).as_str() {
        "inf" | "+inf" => f64::INFINITY,
        "-inf" => f64::NEG_INFINITY,
        "nan" => f64::NAN,
        other => dima_text::parse_number(other),
    }
}

/// `transformDoubleArgument`.
fn score_arg(n: f64) -> String {
    if n == f64::INFINITY {
        "+inf".to_owned()
    } else if n == f64::NEG_INFINITY {
        "-inf".to_owned()
    } else {
        dima_text::number_to_string(n)
    }
}

/// `transformTuplesReply`: `[k1, v1, k2, v2]` as an object (later fields win; keys in
/// JavaScript order).
fn tuples(reply: Reply) -> Value {
    let mut map = Map::new();
    if let Reply::Array(items) = reply {
        let mut iter = items.into_iter();
        while let (Some(key), Some(value)) = (iter.next(), iter.next()) {
            map.insert(js::string(Some(&reply_json(key))), reply_json(value));
        }
    }
    let mut value = Value::Object(map);
    dima_text::js_key_order(&mut value);
    value
}

fn strings(reply: Reply) -> Vec<String> {
    match reply {
        Reply::Array(items) | Reply::Set(items) => items
            .into_iter()
            .map(|item| match item {
                Reply::BulkString(bytes) => text(&bytes),
                other => js::string(Some(&reply_json(other))),
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl Client {
    async fn send(&mut self, args: &[&[u8]]) -> ApiResult<Reply> {
        let mut cmd = redis::Cmd::new();
        for a in args {
            cmd.arg(*a);
        }
        // The raw reply: an error reply at the top fails the command (node-redis rejects), an
        // error inside an array stays a value (node-redis keeps the `ErrorReply` object).
        match self.conn.send_packed_command(&cmd).await {
            Ok(Reply::ServerError(error)) => Err(ApiError::internal(match error.details() {
                Some(detail) => format!("{} {detail}", error.code()),
                None => error.code().to_owned(),
            })),
            Ok(reply) => Ok(reply),
            Err(error) => Err(ApiError::internal(redis_message(&error, ""))),
        }
    }

    async fn send_text(&mut self, args: &[&str]) -> ApiResult<Reply> {
        let bytes: Vec<&[u8]> = args.iter().map(|a| arg(a)).collect();
        self.send(&bytes).await
    }

    /// `PING`.
    pub async fn ping(&mut self) -> ApiResult<Value> {
        Ok(reply_json(self.send_text(&["PING"]).await?))
    }

    async fn key_type(&mut self, key: &str) -> ApiResult<String> {
        Ok(js::string(Some(&reply_json(
            self.send_text(&["TYPE", key]).await?,
        ))))
    }

    async fn ttl(&mut self, key: &str) -> ApiResult<Value> {
        Ok(reply_json(self.send_text(&["TTL", key]).await?))
    }

    async fn scan_page(
        &mut self,
        cursor: &str,
        pattern: &str,
        count: &str,
    ) -> ApiResult<(String, Vec<String>)> {
        let reply = self
            .send_text(&["SCAN", cursor, "MATCH", pattern, "COUNT", count])
            .await?;
        let Reply::Array(mut parts) = reply else {
            return Ok(("0".to_owned(), Vec::new()));
        };
        let keys = if parts.len() > 1 {
            strings(parts.remove(1))
        } else {
            Vec::new()
        };
        let next = parts
            .into_iter()
            .next()
            .map(|cursor| js::string(Some(&reply_json(cursor))))
            .unwrap_or_else(|| "0".to_owned());
        Ok((next, keys))
    }

    /// `scan(id, {cursor, match, count})`.
    pub async fn scan(&mut self, cursor: &str, pattern: &str, count: &str) -> ApiResult<Value> {
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let n = dima_text::parse_number(count);
        let n = if n == 0.0 || n.is_nan() { 50.0 } else { n };
        let count = dima_text::number_to_string(n.min(200.0));
        let (next, keys) = self.scan_page(cursor, pattern, &count).await?;
        let mut rows = Vec::with_capacity(keys.len());
        for key in keys {
            let kind = self.key_type(&key).await?;
            let ttl = self.ttl(&key).await?;
            rows.push(json!({ "name": key, "type": kind, "ttl": ttl }));
        }
        Ok(json!({ "cursor": next, "keys": rows }))
    }

    /// `tree(id, {prefix, query, cursor})`.
    pub async fn tree(
        &mut self,
        prefix: &str,
        query: &str,
        cursor: &str,
        collator: &dima_text::Collator,
    ) -> ApiResult<Value> {
        let pattern = tree_match(prefix, query);
        let mut folders: Vec<(String, String, u64)> = Vec::new();
        let mut leaves: Vec<String> = Vec::new();
        let mut next = if cursor.is_empty() {
            "0".to_owned()
        } else {
            cursor.to_owned()
        };
        let mut scanned = 0_usize;
        let mut round = 0;
        while round < TREE_MAX_ROUNDS && scanned < TREE_MAX_KEYS {
            let (cursor, keys) = self.scan_page(&next, &pattern, "1000").await?;
            next = cursor;
            scanned += keys.len();
            for key in keys {
                match split_tree_node(&key, prefix) {
                    TreeNode::Folder { prefix, label } => {
                        match folders.iter_mut().find(|(p, _, _)| *p == prefix) {
                            Some(folder) => folder.2 += 1,
                            None => folders.push((prefix, label, 1)),
                        }
                    }
                    TreeNode::Key(name) => {
                        if !leaves.contains(&name) {
                            leaves.push(name);
                        }
                    }
                }
            }
            if next == "0" {
                break;
            }
            round += 1;
        }
        folders.sort_by(|a, b| collator.compare(&a.1, &b.1));
        leaves.sort_by(|a, b| dima_text::cmp_utf16(a, b));
        Ok(json!({
            "prefix": prefix,
            "match": pattern,
            "cursor": next,
            "folders": folders
                .into_iter()
                .map(|(prefix, label, seen)| json!({ "prefix": prefix, "label": label, "seen": seen }))
                .collect::<Vec<_>>(),
            "keys": leaves.into_iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
            "scanned": scanned,
        }))
    }

    /// `inspect(id, key)`.
    pub async fn inspect(&mut self, key: &str) -> ApiResult<Value> {
        let kind = self.key_type(key).await?;
        if kind == "none" {
            return Err(ApiError::not_found("Key not found"));
        }
        let ttl = self.ttl(key).await?;
        let value = self.read_value(key, &kind).await?;
        Ok(json!({ "key": key, "type": kind, "ttl": ttl, "value": value }))
    }

    async fn read_value(&mut self, key: &str, kind: &str) -> ApiResult<Value> {
        Ok(match kind {
            "string" => reply_json(self.send_text(&["GET", key]).await?),
            "hash" => tuples(self.send_text(&["HGETALL", key]).await?),
            "list" => Value::from(strings(self.send_text(&["LRANGE", key, "0", "199"]).await?)),
            "set" => Value::from(strings(self.send_text(&["SMEMBERS", key]).await?)),
            "zset" => {
                let reply = self
                    .send_text(&["ZRANGE", key, "0", "199", "WITHSCORES"])
                    .await?;
                let mut rows = Vec::new();
                if let Reply::Array(items) = reply {
                    let mut iter = items.into_iter();
                    while let (Some(member), Some(raw)) = (iter.next(), iter.next()) {
                        let member = js::string(Some(&reply_json(member)));
                        let raw = match raw {
                            Reply::BulkString(bytes) => bytes,
                            other => js::string(Some(&reply_json(other))).into_bytes(),
                        };
                        rows.push(
                            json!({ "value": member, "score": js::number_value(score(&raw)) }),
                        );
                    }
                }
                Value::Array(rows)
            }
            "stream" => {
                let reply = self
                    .send_text(&["XRANGE", key, "-", "+", "COUNT", "50"])
                    .await?;
                let mut rows = Vec::new();
                if let Reply::Array(entries) = reply {
                    for entry in entries {
                        if let Reply::Array(mut parts) = entry {
                            let message = if parts.len() > 1 {
                                tuples(parts.remove(1))
                            } else {
                                json!({})
                            };
                            let id = parts
                                .into_iter()
                                .next()
                                .map(reply_json)
                                .unwrap_or(Value::Null);
                            rows.push(json!({ "id": id, "message": message }));
                        }
                    }
                }
                Value::Array(rows)
            }
            other => Value::from(format!("[unsupported type: {other}]")),
        })
    }

    /// `setString(id, key, value)`; `key` is the raw body value (node-redis refuses non-strings).
    pub async fn set_string(&mut self, key: &Value, value: Option<&Value>) -> ApiResult<Value> {
        let Value::String(key) = key else {
            return Err(ApiError::internal(format!(
                "\"arguments[1]\" must be of type \"string | Buffer\", got {} instead.",
                type_of(key)
            )));
        };
        let kind = self.key_type(key).await?;
        if kind != "none" && kind != "string" {
            return Err(ApiError::conflict(format!("Cannot SET a {kind} key")));
        }
        let text = js::string_nullish(value);
        if kind == "string" {
            self.send_text(&["SET", key, &text, "KEEPTTL"]).await?;
        } else {
            self.send_text(&["SET", key, &text]).await?;
        }
        self.inspect(key).await
    }

    /// `create(id, body)`, after the key check and the client lookup.
    pub async fn create(&mut self, key: &str, kind: &str, body: &Value) -> ApiResult<Value> {
        let existing = self.key_type(key).await?;
        if existing != "none" {
            return Err(ApiError::conflict("Key already exists"));
        }
        let value = js::string_nullish(body.get("value"));
        match kind {
            "string" => {
                self.send_text(&["SET", key, &value]).await?;
            }
            "hash" => {
                let field = js::string_or_empty(body.get("field"));
                if field.is_empty() {
                    return Err(ApiError::bad_request("field is required"));
                }
                self.send_text(&["HSET", key, &field, &value]).await?;
            }
            "list" => {
                self.send_text(&["RPUSH", key, &value]).await?;
            }
            "set" => {
                self.send_text(&["SADD", key, &value]).await?;
            }
            "zset" => {
                let n = js::number(body.get("score"));
                let n = if n == 0.0 || n.is_nan() { 0.0 } else { n };
                self.send_text(&["ZADD", key, &score_arg(n), &value])
                    .await?;
            }
            _ => return Err(ApiError::bad_request("Unsupported type")),
        }
        self.inspect(key).await
    }

    /// `mutate(id, body)` after the key/op checks and the client lookup.
    pub async fn mutate(
        &mut self,
        key: &str,
        op: &str,
        body: &Value,
        marker: &str,
    ) -> ApiResult<Value> {
        let kind = self.key_type(key).await?;
        if kind == "none" {
            return Err(ApiError::not_found("Key not found"));
        }
        self.apply_mutate(key, &kind, op, body, marker).await?;
        match self.inspect(key).await {
            Err(error) if error.status == 404 => {
                Ok(json!({ "key": key, "type": "none", "ttl": -2, "value": null }))
            }
            other => other,
        }
    }

    async fn apply_mutate(
        &mut self,
        key: &str,
        kind: &str,
        op: &str,
        body: &Value,
        marker: &str,
    ) -> ApiResult<()> {
        let require = |expected: &str| {
            if kind == expected {
                Ok(())
            } else {
                Err(ApiError::conflict(format!(
                    "Expected {expected}, got {kind}"
                )))
            }
        };
        let value = || js::string_nullish(body.get("value"));
        match op {
            "ttl" => {
                let ttl = body.get("ttl");
                if matches!(ttl, None | Some(Value::Null)) || js::number(ttl) == -1.0 {
                    self.send_text(&["PERSIST", key]).await?;
                    return Ok(());
                }
                let n = js::number(ttl);
                if !js::is_integer(n) || n < 1.0 {
                    return Err(ApiError::bad_request(
                        "ttl must be a positive integer or -1",
                    ));
                }
                self.send_text(&["EXPIRE", key, &dima_text::number_to_string(n)])
                    .await?;
            }
            "hset" => {
                require("hash")?;
                let field = js::string_nullish(body.get("field"));
                if field.is_empty() {
                    return Err(ApiError::bad_request("field is required"));
                }
                self.send_text(&["HSET", key, &field, &value()]).await?;
                let rename_from = match body.get("renameFrom") {
                    None | Some(Value::Null) => String::new(),
                    Some(other) => dima_text::string_of(other),
                };
                if !rename_from.is_empty() && rename_from != field {
                    self.send_text(&["HDEL", key, &rename_from]).await?;
                }
            }
            "hdel" => {
                require("hash")?;
                let field = js::string_nullish(body.get("field"));
                if field.is_empty() {
                    return Err(ApiError::bad_request("field is required"));
                }
                self.send_text(&["HDEL", key, &field]).await?;
            }
            "lset" | "ldel" => {
                require("list")?;
                let index = js::number(body.get("index"));
                if !js::is_integer(index) || index < 0.0 {
                    return Err(ApiError::bad_request("index is required"));
                }
                let index = dima_text::number_to_string(index);
                if op == "lset" {
                    self.send_text(&["LSET", key, &index, &value()]).await?;
                } else {
                    self.send_text(&["LSET", key, &index, marker]).await?;
                    self.send_text(&["LREM", key, "1", marker]).await?;
                }
            }
            "lpush" | "rpush" => {
                require("list")?;
                let command = if op == "lpush" { "LPUSH" } else { "RPUSH" };
                self.send_text(&[command, key, &value()]).await?;
            }
            "sadd" | "srem" | "zadd" | "zrem" => {
                require(if op.starts_with('s') { "set" } else { "zset" })?;
                let member = match body.get("member") {
                    None | Some(Value::Null) => js::string_nullish(body.get("value")),
                    Some(member) => dima_text::string_of(member),
                };
                if member.is_empty() {
                    return Err(ApiError::bad_request("member is required"));
                }
                match op {
                    "sadd" => self.send_text(&["SADD", key, &member]).await?,
                    "srem" => self.send_text(&["SREM", key, &member]).await?,
                    "zadd" => {
                        let n = js::number(body.get("score"));
                        let n = if n == 0.0 || n.is_nan() { 0.0 } else { n };
                        self.send_text(&["ZADD", key, &score_arg(n), &member])
                            .await?
                    }
                    _ => self.send_text(&["ZREM", key, &member]).await?,
                };
            }
            _ => {}
        }
        Ok(())
    }

    /// `del(id, key)`.
    pub async fn del(&mut self, key: &str) -> ApiResult<Value> {
        Ok(reply_json(self.send_text(&["DEL", key]).await?))
    }

    /// `command(id, args)` after the confirmation check: the raw reply.
    pub async fn command(&mut self, args: &[String]) -> ApiResult<Value> {
        let bytes: Vec<&[u8]> = args.iter().map(|a| arg(a)).collect();
        Ok(reply_json(self.send(&bytes).await?))
    }
}

/// `typeof value` for a JSON value.
fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
    }
}

/// The checks `mutate` makes before it needs a client: `(key, op)`.
pub fn mutate_args(body: &Value) -> ApiResult<(String, String)> {
    let key = js::string_or_empty(body.get("key"));
    let op = js::string_or_empty(body.get("op"));
    if key.is_empty() {
        return Err(ApiError::bad_request("key is required"));
    }
    if !MUTATE_OPS.contains(&op.as_str()) {
        return Err(ApiError::bad_request("unknown op"));
    }
    Ok((key, op))
}

/// The checks `command` makes before it needs a client (the confirmation gate).
pub fn check_dangerous(args: &[String], confirm: bool) -> ApiResult<()> {
    let command = dima_text::to_upper(args.first().map(String::as_str).unwrap_or_default());
    if DANGEROUS.contains(&command.as_str()) && !confirm {
        return Err(ApiError::conflict(format!("{command} needs confirm: true")));
    }
    Ok(())
}

/// `treeMatch(prefix, query)`.
fn tree_match(prefix: &str, query: &str) -> String {
    let q = dima_text::trim(query);
    if !prefix.is_empty() {
        return format!("{prefix}*");
    }
    if q.is_empty() || q == "*" {
        return "*".to_owned();
    }
    if q.contains('*') {
        return q.to_owned();
    }
    format!("*{q}*")
}

enum TreeNode {
    Folder { prefix: String, label: String },
    Key(String),
}

/// `splitTreeNode(key, prefix)`.
fn split_tree_node(key: &str, prefix: &str) -> TreeNode {
    let rest = if prefix.is_empty() {
        key
    } else {
        key.strip_prefix(prefix).unwrap_or(key)
    };
    match rest.split_once(':') {
        None => TreeNode::Key(key.to_owned()),
        Some((label, _)) => TreeNode::Folder {
            prefix: format!("{prefix}{label}:"),
            label: label.to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_rules() {
        assert_eq!(tree_match("", ""), "*");
        assert_eq!(tree_match("", " * "), "*");
        assert_eq!(tree_match("", "user"), "*user*");
        assert_eq!(tree_match("", "u*r"), "u*r");
        assert_eq!(tree_match("a:", "ignored"), "a:*");
        assert!(
            matches!(split_tree_node("a:b:c", ""), TreeNode::Folder { ref prefix, ref label } if prefix == "a:" && label == "a")
        );
        assert!(
            matches!(split_tree_node("a:b:c", "a:"), TreeNode::Folder { ref prefix, ref label } if prefix == "a:b:" && label == "b")
        );
        assert!(matches!(split_tree_node("a:🍕", "a:"), TreeNode::Key(ref k) if k == "a:🍕"));
        assert!(
            matches!(split_tree_node("x:y", "a:"), TreeNode::Folder { ref prefix, .. } if prefix == "a:x:")
        );
    }

    #[test]
    fn replies_render_like_node_redis() {
        assert_eq!(
            reply_json(Reply::Array(vec![
                Reply::Int(9_007_199_254_740_993),
                Reply::BulkString(vec![0xff, b'a']),
                Reply::Nil,
                Reply::Okay,
            ])),
            json!([9_007_199_254_740_992_i64, "\u{fffd}a", null, "OK"])
        );
        assert_eq!(score(b"inf"), f64::INFINITY);
        assert_eq!(score(b"1.5"), 1.5);
        assert_eq!(score_arg(f64::NEG_INFINITY), "-inf");
        assert_eq!(score_arg(1e21), "1e+21");
        assert_eq!(
            tuples(Reply::Array(vec![
                Reply::BulkString(b"b".to_vec()),
                Reply::BulkString(b"1".to_vec()),
                Reply::BulkString(b"2".to_vec()),
                Reply::BulkString(b"x".to_vec()),
            ])),
            json!({"2": "x", "b": "1"})
        );
    }

    #[test]
    fn confirmation_gate() {
        assert_eq!(
            check_dangerous(&["flushdb".to_owned()], false)
                .err()
                .map(|e| e.message),
            Some("FLUSHDB needs confirm: true".to_owned())
        );
        assert!(check_dangerous(&["flushdb".to_owned()], true).is_ok());
        assert!(check_dangerous(&["get".to_owned(), "k".to_owned()], false).is_ok());
        assert_eq!(
            mutate_args(&json!({"key": "k", "op": "nope"}))
                .err()
                .map(|e| e.message),
            Some("unknown op".to_owned())
        );
        assert_eq!(
            mutate_args(&json!({"op": "ttl"})).err().map(|e| e.message),
            Some("key is required".to_owned())
        );
    }
}
