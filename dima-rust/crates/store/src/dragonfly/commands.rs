//! Typed helpers for the replies where node-redis 5 and the redis-rs crate disagree.
//!
//! The ledger (`dragonfly.md`, "Dragonfly / redis-rs vs Redis / node-redis differences") lists
//! them with call sites. Each helper says which node-redis result it stands in for. This is not a
//! full client: anything else goes through [`Dragonfly::query`] / [`Dragonfly::query_value`].
//!
//! Number arguments (scores, TTLs) are written the way node-redis writes them: JavaScript's
//! `Number#toString` ([`dima_text::number_to_string`]), so the bytes on the wire are the same.
//! Values are bytes (`&[u8]`), so nothing is re-encoded on the way in or out.

use super::client::Dragonfly;
use super::error::{DragonflyError, Result};
use dima_text::{number_to_string, parse_number};
use redis::{Pipeline, Value};
use std::num::NonZeroUsize;

/// `SET` conditions (node-redis `{NX: true}` / `{XX: true}`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SetCondition {
    /// Write unconditionally.
    #[default]
    Always,
    /// `NX`: only when the key does not exist.
    IfMissing,
    /// `XX`: only when the key exists.
    IfExists,
}

/// `SET` expiry (node-redis `{EX}`, `{PX}`, `{KEEPTTL: true}`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SetExpiry {
    /// No expiry option: the key loses any TTL it had.
    #[default]
    None,
    /// `EX seconds`.
    Seconds(u64),
    /// `PX milliseconds`.
    Millis(u64),
    /// `KEEPTTL`.
    KeepTtl,
}

/// Options of [`Dragonfly::set`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SetOptions {
    /// `NX` / `XX`.
    pub condition: SetCondition,
    /// `EX` / `PX` / `KEEPTTL`.
    pub expiry: SetExpiry,
    /// `GET`: return the previous value.
    pub get: bool,
}

impl SetOptions {
    /// `{NX: true, EX: seconds}`: the reference's lock acquisition.
    pub fn if_missing_ex(seconds: u64) -> Self {
        Self {
            condition: SetCondition::IfMissing,
            expiry: SetExpiry::Seconds(seconds),
            get: false,
        }
    }

    /// `{EX: seconds}`.
    pub fn ex(seconds: u64) -> Self {
        Self {
            expiry: SetExpiry::Seconds(seconds),
            ..Self::default()
        }
    }
}

/// The three outcomes of `SET`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SetOutcome {
    /// Reply `OK` (node-redis `'OK'`): written.
    Written,
    /// Reply nil without `GET` (node-redis `null`): the `NX`/`XX` condition was not met, nothing
    /// written. The reference tests `=== 'OK'` or truthiness, so this is its falsy case.
    NotWritten,
    /// `GET` was requested (node-redis `string | null`): the previous value. With `NX`, `Some`
    /// means the key existed and nothing was written, `None` that the value was written.
    Previous(Option<Vec<u8>>),
}

/// `TTL` reply codes (node-redis returns the bare number).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ttl {
    /// `-2`: no such key.
    Missing,
    /// `-1`: the key exists without an expiry.
    NoExpiry,
    /// Seconds left (0 or more).
    Seconds(i64),
}

impl Ttl {
    /// Reads the integer reply of `TTL` / `PTTL`.
    pub fn from_reply(code: i64) -> Result<Self> {
        match code {
            -2 => Ok(Self::Missing),
            -1 => Ok(Self::NoExpiry),
            n if n >= 0 => Ok(Self::Seconds(n)),
            _ => Err(DragonflyError::Reply("TTL below -2")),
        }
    }
}

/// Which end of a list (`LEFT` / `RIGHT` in `LMOVE`/`BLMOVE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// The head (`LPUSH`, `LPOP`, `LEFT`).
    Left,
    /// The tail (`RPUSH`, `RPOP`, `RIGHT`).
    Right,
}

impl End {
    /// `LEFT` or `RIGHT`.
    pub fn keyword(self) -> &'static str {
        match self {
            Self::Left => "LEFT",
            Self::Right => "RIGHT",
        }
    }
}

/// Reply decoders, public so callers decoding their own commands or scripts get the same rules.
pub mod reply {
    use super::{DragonflyError, Result, Value, parse_number};

    /// A string or nil reply (node-redis `string | null`): nil is `None`, the empty string is
    /// `Some(empty)`. redis-rs's `String` conversion would fail on nil.
    pub fn bytes_or_nil(value: Value) -> Result<Option<Vec<u8>>> {
        match value {
            Value::Nil => Ok(None),
            Value::BulkString(bytes) => Ok(Some(bytes)),
            Value::SimpleString(text) => Ok(Some(text.into_bytes())),
            Value::Okay => Ok(Some(b"OK".to_vec())),
            _ => Err(DragonflyError::Reply("expected a string or nil")),
        }
    }

    /// A string reply that must be present.
    pub fn bytes(value: Value) -> Result<Vec<u8>> {
        bytes_or_nil(value)?.ok_or(DragonflyError::Reply("expected a string, got nil"))
    }

    /// A text reply: UTF-8 or [`DragonflyError::NotUtf8`] (node-redis would decode lossily).
    pub fn text(value: Value) -> Result<String> {
        String::from_utf8(bytes(value)?).map_err(|_| DragonflyError::NotUtf8)
    }

    /// An integer reply (node-redis `number`). Lua numbers come back as integers (fractions
    /// truncated by the server). A string is refused: use [`number`] where the reference wraps a
    /// reply in `Number()`.
    pub fn int(value: Value) -> Result<i64> {
        match value {
            Value::Int(n) => Ok(n),
            _ => Err(DragonflyError::Reply("expected an integer")),
        }
    }

    /// `Number(reply)` as the reference writes it around `eval` results: an integer as is, a
    /// string through JavaScript's `Number()` (so `"12"` is 12 and `"x"` is NaN), nil as 0
    /// (`Number(null)`).
    pub fn number(value: Value) -> Result<f64> {
        match value {
            Value::Int(n) => Ok(n as f64),
            Value::Nil => Ok(0.0),
            Value::BulkString(bytes) => Ok(std::str::from_utf8(&bytes)
                .map(parse_number)
                .unwrap_or(f64::NAN)),
            Value::SimpleString(text) => Ok(parse_number(&text)),
            Value::Okay => Ok(f64::NAN),
            _ => Err(DragonflyError::Reply("expected a number-like reply")),
        }
    }

    /// An array reply (an empty array for nil, as node-redis gives `[]` for an empty multi-bulk).
    pub fn array(value: Value) -> Result<Vec<Value>> {
        match value {
            Value::Array(items) => Ok(items),
            Value::Nil => Ok(Vec::new()),
            _ => Err(DragonflyError::Reply("expected an array")),
        }
    }

    /// A sorted-set score as node-redis's `transformDoubleReply` reads it: `inf`/`+inf`,
    /// `-inf`, `nan`, otherwise `Number(text)`.
    pub fn score(raw: &[u8]) -> f64 {
        match raw {
            b"inf" | b"+inf" => f64::INFINITY,
            b"-inf" => f64::NEG_INFINITY,
            b"nan" => f64::NAN,
            _ => std::str::from_utf8(raw)
                .map(parse_number)
                .unwrap_or(f64::NAN),
        }
    }

    /// `HGETALL` (node-redis: an object in reply order; a missing key is `{}`). Pairs keep the
    /// server's order, which the reference relies on when it serialises the result.
    pub fn field_pairs(value: Value) -> Result<Vec<(String, String)>> {
        let items = array(value)?;
        if items.len() % 2 != 0 {
            return Err(DragonflyError::Reply(
                "HGETALL returned an odd number of items",
            ));
        }
        let mut pairs = Vec::with_capacity(items.len() / 2);
        let mut items = items.into_iter();
        while let (Some(field), Some(value)) = (items.next(), items.next()) {
            pairs.push((text(field)?, text(value)?));
        }
        Ok(pairs)
    }

    /// `SET` reply, given whether `GET` was sent.
    pub fn set_outcome(value: Value, get: bool) -> Result<super::SetOutcome> {
        use super::SetOutcome;
        if get {
            return Ok(SetOutcome::Previous(bytes_or_nil(value)?));
        }
        match value {
            Value::Okay => Ok(SetOutcome::Written),
            Value::SimpleString(text) if text == "OK" => Ok(SetOutcome::Written),
            Value::Nil => Ok(SetOutcome::NotWritten),
            _ => Err(DragonflyError::Reply("SET returned neither OK nor nil")),
        }
    }

    /// Member/score pairs of a `WITHSCORES` range (`ZRANGE`, `ZRANGEBYSCORE`, `ZREVRANGE` ...)
    /// or a counted pop (`ZPOPMIN key n`, `ZPOPMAX key n`): RESP2 sends them flat, member then
    /// score. Scores read like node-redis ([`score`]: `inf`, `-inf`, `nan`). A missing key is `[]`.
    pub fn scored(value: Value) -> Result<Vec<(Vec<u8>, f64)>> {
        let items = array(value)?;
        if items.len() % 2 != 0 {
            return Err(DragonflyError::Reply(
                "a scored reply has an odd number of items",
            ));
        }
        let mut pairs = Vec::with_capacity(items.len() / 2);
        let mut items = items.into_iter();
        while let (Some(member), Some(score)) = (items.next(), items.next()) {
            pairs.push((bytes(member)?, self::score(&bytes(score)?)));
        }
        Ok(pairs)
    }

    /// `LPOP key count` / `RPOP key count` (node-redis `string[] | null`): nil when the key does
    /// not exist, otherwise the popped elements (at most `count`).
    pub fn count_pop(value: Value) -> Result<Option<Vec<Vec<u8>>>> {
        match value {
            Value::Nil => Ok(None),
            Value::Array(items) => items
                .into_iter()
                .map(bytes)
                .collect::<Result<_>>()
                .map(Some),
            _ => Err(DragonflyError::Reply("expected an array or nil")),
        }
    }

    /// One stream entry: its id and its field/value pairs in the order they were added.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct StreamEntry {
        /// `<ms>-<seq>`.
        pub id: String,
        /// Field/value pairs (bytes, as stored). Empty for an entry the server reports without
        /// fields (deleted, in claim replies).
        pub fields: Vec<(Vec<u8>, Vec<u8>)>,
    }

    /// `XRANGE` / `XREVRANGE` (and the entries of `XCLAIM`): `[[id, [field, value, ...]], ...]`.
    pub fn stream_entries(value: Value) -> Result<Vec<StreamEntry>> {
        array(value)?.into_iter().map(stream_entry).collect()
    }

    fn stream_entry(value: Value) -> Result<StreamEntry> {
        let mut parts = array(value)?.into_iter();
        let (Some(id), Some(fields), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(DragonflyError::Reply("a stream entry is not [id, fields]"));
        };
        let flat = array(fields)?;
        if flat.len() % 2 != 0 {
            return Err(DragonflyError::Reply(
                "a stream entry has an odd number of field items",
            ));
        }
        let mut pairs = Vec::with_capacity(flat.len() / 2);
        let mut flat = flat.into_iter();
        while let (Some(field), Some(value)) = (flat.next(), flat.next()) {
            pairs.push((bytes(field)?, bytes(value)?));
        }
        Ok(StreamEntry {
            id: text(id)?,
            fields: pairs,
        })
    }

    /// `XREAD` / `XREADGROUP`: `[[key, entries], ...]` per stream that had entries; nil (nothing
    /// new, or a blocking read that timed out) is an empty list.
    pub fn stream_read(value: Value) -> Result<Vec<(Vec<u8>, Vec<StreamEntry>)>> {
        array(value)?
            .into_iter()
            .map(|stream| {
                let mut parts = array(stream)?.into_iter();
                let (Some(key), Some(entries), None) = (parts.next(), parts.next(), parts.next())
                else {
                    return Err(DragonflyError::Reply(
                        "an XREAD stream is not [key, entries]",
                    ));
                };
                Ok((bytes(key)?, stream_entries(entries)?))
            })
            .collect()
    }

    /// The replies of a `MULTI` ... `EXEC` run with errors kept per command (see
    /// [`super::Dragonfly::transaction`]): one result per queued command, in order. A command
    /// that failed at run time (`WRONGTYPE` ...) is an `Err` in its slot while the others ran, as
    /// Redis transactions do not roll back; nested replies stay [`Value`]s for the other
    /// decoders here (`scored`, `field_pairs` ...).
    ///
    /// A nil reply (`EXEC` aborted because a watched key changed: nothing ran) is
    /// [`DragonflyError::TransactionAborted`], never an empty success.
    pub fn transaction(value: Value) -> Result<Vec<Result<Value>>> {
        if value == Value::Nil {
            return Err(DragonflyError::TransactionAborted);
        }
        Ok(array(value)?
            .into_iter()
            .map(|reply| match reply {
                Value::ServerError(error) => Err(DragonflyError::Redis(error.into())),
                other => Ok(other),
            })
            .collect())
    }

    /// `ZPOPMIN key` (node-redis `{value, score} | null`).
    pub fn pop_min(value: Value) -> Result<Option<(Vec<u8>, f64)>> {
        let items = array(value)?;
        let mut items = items.into_iter();
        match (items.next(), items.next(), items.next()) {
            (None, _, _) => Ok(None),
            (Some(member), Some(score), None) => {
                let score = bytes(score)?;
                Ok(Some((bytes(member)?, self::score(&score))))
            }
            _ => Err(DragonflyError::Reply(
                "ZPOPMIN returned an unexpected shape",
            )),
        }
    }
}

/// `SCAN` iteration, one page per call (node-redis 5's `scanIterator` yields one array of keys
/// per page). `COUNT` is a hint: pages may be empty while the cursor is not finished.
#[derive(Debug)]
pub struct Scan {
    dragonfly: Dragonfly,
    pattern: String,
    count: Option<u32>,
    cursor: Option<Vec<u8>>,
}

impl Scan {
    /// The next page of keys (raw bytes, as stored), or `None` once the cursor is back at 0.
    pub async fn next_page(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
        let Some(cursor) = self.cursor.take() else {
            return Ok(None);
        };
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(cursor).arg("MATCH").arg(&self.pattern);
        if let Some(count) = self.count {
            cmd.arg("COUNT").arg(count);
        }
        let mut items = reply::array(self.dragonfly.query_value(&cmd).await?)?.into_iter();
        let (Some(next), Some(keys), None) = (items.next(), items.next(), items.next()) else {
            return Err(DragonflyError::Reply("SCAN returned an unexpected shape"));
        };
        let next = reply::bytes(next)?;
        if next != b"0" {
            self.cursor = Some(next);
        }
        reply::array(keys)?
            .into_iter()
            .map(reply::bytes)
            .collect::<Result<Vec<_>>>()
            .map(Some)
    }
}

impl Dragonfly {
    /// `GET` (node-redis `string | null`).
    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        reply::bytes_or_nil(self.query_value(redis::cmd("GET").arg(key)).await?)
    }

    /// `GET` of a text value; [`DragonflyError::NotUtf8`] when it is not UTF-8.
    pub async fn get_text(&self, key: &str) -> Result<Option<String>> {
        self.get(key)
            .await?
            .map(|bytes| String::from_utf8(bytes).map_err(|_| DragonflyError::NotUtf8))
            .transpose()
    }

    /// `SET key value [NX|XX] [GET] [EX|PX|KEEPTTL]`.
    pub async fn set(&self, key: &str, value: &[u8], options: SetOptions) -> Result<SetOutcome> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(key).arg(value);
        match options.condition {
            SetCondition::Always => {}
            SetCondition::IfMissing => {
                cmd.arg("NX");
            }
            SetCondition::IfExists => {
                cmd.arg("XX");
            }
        }
        if options.get {
            cmd.arg("GET");
        }
        match options.expiry {
            SetExpiry::None => {}
            SetExpiry::Seconds(seconds) => {
                cmd.arg("EX").arg(seconds);
            }
            SetExpiry::Millis(millis) => {
                cmd.arg("PX").arg(millis);
            }
            SetExpiry::KeepTtl => {
                cmd.arg("KEEPTTL");
            }
        }
        reply::set_outcome(self.query_value(&cmd).await?, options.get)
    }

    /// `DEL key...` (node-redis `number`). `DEL` takes no glob: `twitch:*:x` is one literal key.
    pub async fn del(&self, keys: &[&str]) -> Result<i64> {
        reply::int(self.query_value(redis::cmd("DEL").arg(keys)).await?)
    }

    /// `EXISTS key...` (node-redis `number`, compared with `=== 1` by the reference).
    pub async fn exists(&self, keys: &[&str]) -> Result<i64> {
        reply::int(self.query_value(redis::cmd("EXISTS").arg(keys)).await?)
    }

    /// `HGET` (node-redis `string | null`).
    pub async fn hget(&self, key: &str, field: &str) -> Result<Option<Vec<u8>>> {
        reply::bytes_or_nil(
            self.query_value(redis::cmd("HGET").arg(key).arg(field))
                .await?,
        )
    }

    /// `HGETALL` (node-redis object; `{}` for a missing key, here an empty list).
    pub async fn hgetall(&self, key: &str) -> Result<Vec<(String, String)>> {
        reply::field_pairs(self.query_value(redis::cmd("HGETALL").arg(key)).await?)
    }

    /// `HSET key field value...` (node-redis `number` of new fields).
    pub async fn hset(&self, key: &str, fields: &[(&str, &[u8])]) -> Result<i64> {
        let mut cmd = redis::cmd("HSET");
        cmd.arg(key);
        for (field, value) in fields {
            cmd.arg(*field).arg(*value);
        }
        reply::int(self.query_value(&cmd).await?)
    }

    /// `TTL` (node-redis `number`: -2 missing, -1 no expiry).
    pub async fn ttl(&self, key: &str) -> Result<Ttl> {
        Ttl::from_reply(reply::int(
            self.query_value(redis::cmd("TTL").arg(key)).await?,
        )?)
    }

    /// `LPUSH key value...` (node-redis `number`: the new length).
    pub async fn lpush(&self, key: &str, values: &[&[u8]]) -> Result<i64> {
        reply::int(
            self.query_value(redis::cmd("LPUSH").arg(key).arg(values))
                .await?,
        )
    }

    /// `RPUSH key value...` (node-redis `number`: the new length).
    pub async fn rpush(&self, key: &str, values: &[&[u8]]) -> Result<i64> {
        reply::int(
            self.query_value(redis::cmd("RPUSH").arg(key).arg(values))
                .await?,
        )
    }

    /// `LPOP key` (node-redis `string | null`).
    pub async fn lpop(&self, key: &str) -> Result<Option<Vec<u8>>> {
        reply::bytes_or_nil(self.query_value(redis::cmd("LPOP").arg(key)).await?)
    }

    /// `RPOP key` (node-redis `string | null`).
    pub async fn rpop(&self, key: &str) -> Result<Option<Vec<u8>>> {
        reply::bytes_or_nil(self.query_value(redis::cmd("RPOP").arg(key)).await?)
    }

    /// `ZADD key score member...` with scores written as JavaScript writes numbers.
    pub async fn zadd(&self, key: &str, members: &[(f64, &[u8])]) -> Result<i64> {
        let mut cmd = redis::cmd("ZADD");
        cmd.arg(key);
        for (score, member) in members {
            cmd.arg(number_to_string(*score)).arg(*member);
        }
        reply::int(self.query_value(&cmd).await?)
    }

    /// `ZCARD` (node-redis `number`).
    pub async fn zcard(&self, key: &str) -> Result<i64> {
        reply::int(self.query_value(redis::cmd("ZCARD").arg(key)).await?)
    }

    /// `ZPOPMIN key` (node-redis `{value, score} | null`; the score read like node-redis).
    pub async fn zpopmin(&self, key: &str) -> Result<Option<(Vec<u8>, f64)>> {
        reply::pop_min(self.query_value(redis::cmd("ZPOPMIN").arg(key)).await?)
    }

    /// `ZRANGE key start stop WITHSCORES` (node-redis `zRangeWithScores`: `{value, score}[]`).
    pub async fn zrange_with_scores(
        &self,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<Vec<(Vec<u8>, f64)>> {
        reply::scored(
            self.query_value(
                redis::cmd("ZRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .arg("WITHSCORES"),
            )
            .await?,
        )
    }

    /// `ZPOPMIN key count` (node-redis `zPopMinCount`: `{value, score}[]`, `[]` when missing).
    pub async fn zpopmin_count(
        &self,
        key: &str,
        count: NonZeroUsize,
    ) -> Result<Vec<(Vec<u8>, f64)>> {
        reply::scored(
            self.query_value(redis::cmd("ZPOPMIN").arg(key).arg(count.get()))
                .await?,
        )
    }

    /// `LPOP key count` (node-redis `lPopCount`: `string[] | null`, null when missing).
    pub async fn lpop_count(&self, key: &str, count: NonZeroUsize) -> Result<Option<Vec<Vec<u8>>>> {
        reply::count_pop(
            self.query_value(redis::cmd("LPOP").arg(key).arg(count.get()))
                .await?,
        )
    }

    /// `RPOP key count` (node-redis `rPopCount`: `string[] | null`, null when missing).
    pub async fn rpop_count(&self, key: &str, count: NonZeroUsize) -> Result<Option<Vec<Vec<u8>>>> {
        reply::count_pop(
            self.query_value(redis::cmd("RPOP").arg(key).arg(count.get()))
                .await?,
        )
    }

    /// `XRANGE key start end COUNT count` (ids such as `-`, `+`, `1700000000000-0`).
    pub async fn xrange(
        &self,
        key: &str,
        start: &str,
        end: &str,
        count: NonZeroUsize,
    ) -> Result<Vec<reply::StreamEntry>> {
        reply::stream_entries(
            self.query_value(
                redis::cmd("XRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(end)
                    .arg("COUNT")
                    .arg(count.get()),
            )
            .await?,
        )
    }

    /// Runs the commands of `pipeline` as one `MULTI` ... `EXEC` transaction and returns one
    /// result per command, in the order they were added ([`reply::transaction`]), instead of
    /// failing the whole call when one command fails at run time (the others have run by then).
    ///
    /// - The transaction is rebuilt from the pipeline's commands only: `.ignore()` flags (and
    ///   `atomic()` / `ignore_errors()` settings) on `pipeline` have no effect, so a command
    ///   marked ignored still has its slot and its error is never dropped, and result `i` is
    ///   always command `i`.
    /// - An error while queueing (an unknown command) aborts the transaction (`EXECABORT`,
    ///   nothing ran) and is the call's error.
    /// - A nil `EXEC` reply (a watched key changed, nothing ran) is
    ///   [`DragonflyError::TransactionAborted`].
    ///
    /// Not instrumented, like `multi()` in the reference.
    pub async fn transaction(&self, pipeline: Pipeline) -> Result<Vec<Result<Value>>> {
        let mut transaction = redis::pipe();
        for cmd in pipeline.cmd_iter() {
            transaction.add_command(cmd.clone());
        }
        transaction.atomic().ignore_errors();
        reply::transaction(self.query_pipeline(&transaction).await?)
    }

    /// Starts a `SCAN 0 MATCH pattern [COUNT count]` iteration.
    pub fn scan(&self, pattern: &str, count: Option<u32>) -> Scan {
        Scan {
            dragonfly: self.clone(),
            pattern: pattern.to_owned(),
            count,
            cursor: Some(b"0".to_vec()),
        }
    }

    /// `PUBLISH channel payload` (node-redis `number` of receivers), on the command connection.
    /// The payload is sent as given: the reference's raw publishers (`keywords:changed`) add no
    /// envelope; see [`super::pubsub::envelope`] for the pub/sub manager's.
    pub async fn publish(&self, channel: &str, payload: &[u8]) -> Result<i64> {
        reply::int(
            self.query_value(redis::cmd("PUBLISH").arg(channel).arg(payload))
                .await?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::reply::*;
    use super::*;

    fn bulk(text: &str) -> Value {
        Value::BulkString(text.as_bytes().to_vec())
    }

    #[test]
    fn scored_count_pop_and_stream_shapes() {
        assert_eq!(
            scored(Value::Array(vec![
                bulk("a"),
                bulk("1.5"),
                bulk("b"),
                bulk("-inf")
            ]))
            .unwrap(),
            vec![(b"a".to_vec(), 1.5), (b"b".to_vec(), f64::NEG_INFINITY)]
        );
        assert!(scored(Value::Array(vec![]),).unwrap().is_empty());
        assert!(scored(Value::Array(vec![bulk("a")])).is_err());
        assert_eq!(count_pop(Value::Nil).unwrap(), None);
        assert_eq!(count_pop(Value::Array(vec![])).unwrap(), Some(vec![]));
        assert!(count_pop(Value::Int(1)).is_err());
        let entry = Value::Array(vec![bulk("1-0"), Value::Array(vec![bulk("f"), bulk("v")])]);
        let entries = stream_entries(Value::Array(vec![entry.clone()])).unwrap();
        assert_eq!(entries[0].id, "1-0");
        assert_eq!(entries[0].fields, vec![(b"f".to_vec(), b"v".to_vec())]);
        let deleted = Value::Array(vec![bulk("2-0"), Value::Nil]);
        assert!(
            stream_entries(Value::Array(vec![deleted])).unwrap()[0]
                .fields
                .is_empty()
        );
        assert!(stream_entries(Value::Array(vec![Value::Array(vec![bulk("1-0")])])).is_err());
        assert!(stream_read(Value::Nil).unwrap().is_empty());
        let read = stream_read(Value::Array(vec![Value::Array(vec![
            bulk("k"),
            Value::Array(vec![entry]),
        ])]))
        .unwrap();
        assert_eq!(read[0].0, b"k".to_vec());
        assert_eq!(read[0].1.len(), 1);
    }

    #[test]
    fn an_aborted_exec_is_not_an_empty_success() {
        assert!(matches!(
            transaction(Value::Nil),
            Err(DragonflyError::TransactionAborted)
        ));
        assert!(transaction(Value::Array(vec![])).unwrap().is_empty());
    }

    #[test]
    fn nil_and_empty_string_stay_distinct() {
        assert_eq!(bytes_or_nil(Value::Nil).unwrap(), None);
        assert_eq!(
            bytes_or_nil(Value::BulkString(vec![])).unwrap(),
            Some(vec![])
        );
        assert!(bytes(Value::Nil).is_err());
        assert!(bytes_or_nil(Value::Int(1)).is_err());
    }

    #[test]
    fn integers_and_numbers() {
        assert_eq!(int(Value::Int(7)).unwrap(), 7);
        assert!(int(Value::BulkString(b"7".to_vec())).is_err());
        assert_eq!(number(Value::BulkString(b" 12 ".to_vec())).unwrap(), 12.0);
        assert!(number(Value::BulkString(b"x".to_vec())).unwrap().is_nan());
        assert_eq!(number(Value::Nil).unwrap(), 0.0);
        assert_eq!(number(Value::Int(-3)).unwrap(), -3.0);
    }

    #[test]
    fn set_has_three_outcomes() {
        assert_eq!(
            set_outcome(Value::Okay, false).unwrap(),
            SetOutcome::Written
        );
        assert_eq!(
            set_outcome(Value::Nil, false).unwrap(),
            SetOutcome::NotWritten
        );
        assert_eq!(
            set_outcome(Value::Nil, true).unwrap(),
            SetOutcome::Previous(None)
        );
        assert_eq!(
            set_outcome(Value::BulkString(b"old".to_vec()), true).unwrap(),
            SetOutcome::Previous(Some(b"old".to_vec()))
        );
        assert!(set_outcome(Value::Int(1), false).is_err());
    }

    #[test]
    fn ttl_codes() {
        assert_eq!(Ttl::from_reply(-2).unwrap(), Ttl::Missing);
        assert_eq!(Ttl::from_reply(-1).unwrap(), Ttl::NoExpiry);
        assert_eq!(Ttl::from_reply(0).unwrap(), Ttl::Seconds(0));
        assert!(Ttl::from_reply(-3).is_err());
    }

    #[test]
    fn scores_read_like_node_redis() {
        assert_eq!(score(b"inf"), f64::INFINITY);
        assert_eq!(score(b"+inf"), f64::INFINITY);
        assert_eq!(score(b"-inf"), f64::NEG_INFINITY);
        assert!(score(b"nan").is_nan());
        assert_eq!(score(b"1.5"), 1.5);
        assert_eq!(score(b"1e3"), 1000.0);
        assert_eq!(pop_min(Value::Array(vec![])).unwrap(), None);
        assert_eq!(
            pop_min(Value::Array(vec![
                Value::BulkString(b"m".to_vec()),
                Value::BulkString(b"2".to_vec())
            ]))
            .unwrap(),
            Some((b"m".to_vec(), 2.0))
        );
    }

    #[test]
    fn hgetall_keeps_server_order_and_empty_is_empty() {
        assert!(field_pairs(Value::Array(vec![])).unwrap().is_empty());
        let pairs = field_pairs(Value::Array(vec![
            Value::BulkString(b"z".to_vec()),
            Value::BulkString(b"1".to_vec()),
            Value::BulkString(b"a".to_vec()),
            Value::BulkString(b"2".to_vec()),
        ]))
        .unwrap();
        assert_eq!(pairs, [("z".into(), "1".into()), ("a".into(), "2".into())]);
        assert!(field_pairs(Value::Array(vec![Value::BulkString(b"z".to_vec())])).is_err());
    }
}
