//! Dragonfly thread storage and conversation routing. This rebuilt cache has 24h TTLs.
//!
//! Each command inherits the shared store response deadline; scans and eviction loops
//! are bounded at 1000 entries. Topic seed 220 and token minimum 3 count scalars (our
//! text rules). Keyword bounds 12/18, scoring tokens 64, recent turns 4, candidate count
//! max(5, user limit * 3) count entries. Tier prompt turns are provider cost budgets and
//! stay exactly 10/40/100. Stored turns 20/60/120 and user/channel caps are cache bounds.
//! Sticky reuse lasts 45 minutes; recency decays over 24h. No sleeps or polling.
//! Quirks retained: metadata updates are read/write and not atomic; failed routing can
//! create a fallback thread after a partially successful append; undelivered bot turns
//! remain in prompt context. Callers supply Clock and Random; no environment reads.
use dima_core::{Clock, Random};
use dima_store::dragonfly::{Dragonfly, DragonflyError, SetExpiry, SetOptions};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
const TTL: u64 = 86400;
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Free,
    Premium,
    Pro,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_channel_threads: usize,
    pub max_user_threads: usize,
    pub max_turns_stored: usize,
    pub prompt_turns: usize,
}
pub fn get_thread_limits_for_tier(t: Tier) -> Limits {
    let (c, u, s, p) = match t {
        Tier::Free => (40, 3, 20, 10),
        Tier::Premium => (100, 6, 60, 40),
        Tier::Pro => (250, 12, 120, 100),
    };
    Limits {
        max_channel_threads: c,
        max_user_threads: u,
        max_turns_stored: s,
        prompt_turns: p,
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub message: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(rename = "threadID")]
    pub thread_id: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "ownerUserID")]
    pub owner_user_id: String,
    pub owner_username: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_ts: i64,
    pub status: String,
    pub topic_seed: String,
    pub topic_keywords: Vec<String>,
    pub message_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTurn {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub timestamp: i64,
    pub username: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badges: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] DragonflyError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
    #[error("Invalid thread timestamp")]
    Timestamp,
    #[error("Thread capacity exceeded")]
    Capacity,
}
#[derive(Clone)]
pub struct Store {
    pub cache: Dragonfly,
    pub clock: Arc<dyn Clock>,
    pub random: Arc<dyn Random>,
    pub prefix: String,
}
impl Store {
    pub fn channel_key(&self, c: &str) -> String {
        format!("{}twitch:{c}:ai:threads:active", self.prefix)
    }
    pub fn user_key(&self, c: &str, u: &str) -> String {
        format!("{}twitch:{c}:ai:user:{u}:threads", self.prefix)
    }
    pub fn meta_key(&self, c: &str, t: &str) -> String {
        format!("{}twitch:{c}:ai:thread:{t}:meta", self.prefix)
    }
    pub fn turns_key(&self, c: &str, t: &str) -> String {
        format!("{}twitch:{c}:ai:thread:{t}:turns", self.prefix)
    }
    async fn write_meta(&self, m: &Meta) -> Result<(), Error> {
        self.cache
            .set(
                &self.meta_key(&m.channel_id, &m.thread_id),
                &serde_json::to_vec(m)?,
                SetOptions {
                    expiry: SetExpiry::Seconds(TTL),
                    ..Default::default()
                },
            )
            .await?;
        Ok(())
    }
    pub async fn get_thread_meta(&self, c: &str, t: &str) -> Result<Option<Meta>, Error> {
        Ok(self
            .cache
            .get(&self.meta_key(c, t))
            .await?
            .and_then(|v| serde_json::from_slice(&v).ok()))
    }
    pub async fn get_thread_turns(
        &self,
        c: &str,
        t: &str,
        limit: usize,
    ) -> Result<Vec<Turn>, Error> {
        if limit > 1000 {
            return Err(Error::Capacity);
        }
        let raw: Vec<Vec<u8>> = self
            .cache
            .query(
                redis::cmd("LRANGE")
                    .arg(self.turns_key(c, t))
                    .arg(0)
                    .arg(limit.saturating_sub(1)),
            )
            .await?;
        Ok(raw
            .into_iter()
            .filter_map(|v| serde_json::from_slice(&v).ok())
            .rev()
            .collect())
    }
    pub async fn create_thread(
        &self,
        c: &str,
        u: &str,
        name: &str,
        seed: &str,
        ts: i64,
    ) -> Result<Meta, Error> {
        let iso = dima_text::to_iso_string(ts).ok_or(Error::Timestamp)?;
        let meta = Meta {
            thread_id: self.random.uuid_v4()?,
            channel_id: c.into(),
            owner_user_id: u.into(),
            owner_username: name.into(),
            created_at: iso.clone(),
            updated_at: iso,
            last_activity_ts: ts,
            status: "active".into(),
            topic_seed: dima_text::truncate_chars(seed, 220).into(),
            topic_keywords: keywords(seed),
            message_count: 0,
            last_user_message: None,
            last_assistant_message: None,
        };
        self.write_meta(&meta).await?;
        Ok(meta)
    }
    pub async fn append_thread_turn(
        &self,
        c: &str,
        t: &str,
        turn: &Turn,
        limits: Limits,
    ) -> Result<(), Error> {
        if limits.max_turns_stored > 1000 {
            return Err(Error::Capacity);
        }
        let Some(mut m) = self.get_thread_meta(c, t).await? else {
            return Ok(());
        };
        let ts = if turn.timestamp == 0 {
            self.clock.now_ms()
        } else {
            turn.timestamp
        };
        m.updated_at = dima_text::to_iso_string(ts).ok_or(Error::Timestamp)?;
        m.last_activity_ts = ts;
        m.message_count = m.message_count.saturating_add(1);
        if turn.role == "user" {
            m.last_user_message = Some(turn.message.clone());
            let mut seen: HashSet<_> = m.topic_keywords.iter().cloned().collect();
            for k in keywords(&turn.message) {
                if seen.insert(k.clone()) {
                    m.topic_keywords.push(k);
                }
            }
            m.topic_keywords.truncate(18);
        }
        if turn.role == "assistant" {
            m.last_assistant_message = Some(turn.message.clone());
        }
        self.cache
            .lpush(&self.turns_key(c, t), &[&serde_json::to_vec(turn)?])
            .await?;
        let _: () = self
            .cache
            .query(
                redis::cmd("LTRIM")
                    .arg(self.turns_key(c, t))
                    .arg(0)
                    .arg(limits.max_turns_stored.saturating_sub(1)),
            )
            .await?;
        self.expire(&self.turns_key(c, t)).await?;
        self.write_meta(&m).await
    }
    async fn expire(&self, key: &str) -> Result<(), Error> {
        let _: bool = self
            .cache
            .query(redis::cmd("EXPIRE").arg(key).arg(TTL))
            .await?;
        Ok(())
    }
    pub async fn touch_thread_indexes(
        &self,
        c: &str,
        u: &str,
        t: &str,
        ts: i64,
    ) -> Result<(), Error> {
        for key in [self.channel_key(c), self.user_key(c, u)] {
            self.cache.zadd(&key, &[(ts as f64, t.as_bytes())]).await?;
            self.expire(&key).await?;
        }
        Ok(())
    }
    pub async fn remove_thread(&self, c: &str, t: &str) -> Result<(), Error> {
        let m = self.get_thread_meta(c, t).await?;
        let _: i64 = self
            .cache
            .query(redis::cmd("ZREM").arg(self.channel_key(c)).arg(t))
            .await?;
        if let Some(m) = m
            && !m.owner_user_id.is_empty()
        {
            let _: i64 = self
                .cache
                .query(
                    redis::cmd("ZREM")
                        .arg(self.user_key(c, &m.owner_user_id))
                        .arg(t),
                )
                .await?;
        }
        self.cache
            .del(&[&self.meta_key(c, t), &self.turns_key(c, t)])
            .await?;
        Ok(())
    }
    pub async fn enforce_thread_limits(
        &self,
        c: &str,
        u: &str,
        limits: Limits,
    ) -> Result<(usize, usize), Error> {
        let mut counts = [0, 0];
        for (i, key, cap) in [
            (0, self.user_key(c, u), limits.max_user_threads),
            (1, self.channel_key(c), limits.max_channel_threads),
        ] {
            let count = self.cache.zcard(&key).await?;
            let overflow = (count.max(0) as usize).saturating_sub(cap);
            if overflow > 1000 {
                return Err(Error::Capacity);
            }
            if overflow == 0 {
                continue;
            }
            let ids: Vec<String> = self
                .cache
                .query(redis::cmd("ZRANGE").arg(key).arg(0).arg(overflow - 1))
                .await?;
            for t in ids {
                self.remove_thread(c, &t).await?;
                counts[i] += 1;
            }
        }
        Ok((counts[0], counts[1]))
    }
    pub async fn get_user_thread_candidates(
        &self,
        c: &str,
        u: &str,
        limit: usize,
    ) -> Result<Vec<Meta>, Error> {
        if limit > 1000 {
            return Err(Error::Capacity);
        }
        let ids: Vec<String> = self
            .cache
            .query(
                redis::cmd("ZRANGE")
                    .arg(self.user_key(c, u))
                    .arg(-(limit.max(1) as i64))
                    .arg(-1),
            )
            .await?;
        let mut out = Vec::new();
        for id in ids.into_iter().rev() {
            if let Some(m) = self.get_thread_meta(c, &id).await?
                && m.status == "active"
            {
                out.push(m);
            }
        }
        Ok(out)
    }
    pub async fn get_thread_prompt_context(
        &self,
        c: &str,
        t: &str,
        limit: usize,
    ) -> Result<Vec<PromptTurn>, Error> {
        Ok(self
            .get_thread_turns(c, t, limit.max(1))
            .await?
            .into_iter()
            .map(|t| {
                let assistant = t.role == "assistant";
                PromptTurn {
                    role: t.role,
                    source_message_id: t.source_message_id,
                    timestamp: t.timestamp,
                    username: t.username.filter(|s| !s.is_empty()).unwrap_or(
                        if assistant {
                            "DomDimaBot"
                        } else {
                            "UnknownUser"
                        }
                        .into(),
                    ),
                    message: t.message,
                    badges: assistant.then(|| "🤖".into()),
                }
            })
            .collect())
    }
    async fn select(
        &self,
        p: &ResolveInput,
        limits: Limits,
    ) -> Result<(Option<Meta>, f64, usize), Error> {
        let candidates = self
            .get_user_thread_candidates(
                &p.channel_id,
                &p.user_id,
                (limits.max_user_threads * 3).max(5),
            )
            .await?;
        let count = candidates.len();
        if let Some(m) = candidates.first()
            && self.clock.now_ms().saturating_sub(m.last_activity_ts) <= 2700000
        {
            return Ok((Some(m.clone()), 1.0, count));
        }
        let mut best = None;
        let mut score = 0.0;
        for m in candidates {
            let turns = self
                .get_thread_turns(&p.channel_id, &m.thread_id, 4)
                .await?;
            let recent = turns
                .iter()
                .map(|t| t.message.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let s = score_thread(&m, &p.message, &recent, &p.user_id, self.clock.now_ms());
            if s > score {
                score = s;
                best = Some(m);
            }
        }
        Ok((best, score, count))
    }
    pub async fn get_existing_user_thread_context(
        &self,
        p: &ResolveInput,
    ) -> Result<Vec<PromptTurn>, Error> {
        let limits = get_thread_limits_for_tier(p.plan_tier);
        let (m, score, _) = self.select(p, limits).await?;
        if let Some(m) = m
            && score >= 0.35
        {
            self.get_thread_prompt_context(&p.channel_id, &m.thread_id, limits.prompt_turns)
                .await
        } else {
            Ok(vec![])
        }
    }
    pub async fn resolve_user_thread_for_message(
        &self,
        p: &ResolveInput,
    ) -> Result<Resolved, Error> {
        let limits = get_thread_limits_for_tier(p.plan_tier);
        let ts = self.clock.now_ms();
        match self.resolve_inner(p, limits, ts).await {
            Ok(r) => Ok(r),
            Err(_) => {
                let m = self
                    .create_thread(&p.channel_id, &p.user_id, &p.username, &p.message, ts)
                    .await?;
                self.touch_thread_indexes(&p.channel_id, &p.user_id, &m.thread_id, ts)
                    .await?;
                self.append_thread_turn(&p.channel_id, &m.thread_id, &p.turn(ts), limits)
                    .await?;
                Ok(Resolved {
                    thread_id: m.thread_id,
                    created_new_thread: true,
                    selected_score: 0.0,
                    threshold: 0.35,
                    candidate_count: 0,
                    prompt_turns_used: limits.prompt_turns,
                    limits,
                    prompt_context: vec![],
                })
            }
        }
    }
    async fn resolve_inner(
        &self,
        p: &ResolveInput,
        limits: Limits,
        ts: i64,
    ) -> Result<Resolved, Error> {
        let (m, score, count) = self.select(p, limits).await?;
        let new = m.is_none() || score < 0.35;
        let m = if let Some(m) = m.filter(|_| !new) {
            m
        } else {
            self.create_thread(&p.channel_id, &p.user_id, &p.username, &p.message, ts)
                .await?
        };
        self.touch_thread_indexes(&p.channel_id, &p.user_id, &m.thread_id, ts)
            .await?;
        let context = self
            .get_thread_prompt_context(&p.channel_id, &m.thread_id, limits.prompt_turns)
            .await?;
        self.append_thread_turn(&p.channel_id, &m.thread_id, &p.turn(ts), limits)
            .await?;
        self.enforce_thread_limits(&p.channel_id, &p.user_id, limits)
            .await?;
        Ok(Resolved {
            thread_id: m.thread_id,
            created_new_thread: new,
            selected_score: score,
            threshold: 0.35,
            candidate_count: count,
            prompt_turns_used: limits.prompt_turns,
            limits,
            prompt_context: context,
        })
    }
    pub async fn append_assistant_turn_to_thread(
        &self,
        c: &str,
        t: &str,
        message: &str,
        tier: Tier,
        source_message_id: Option<String>,
        delivered: Option<bool>,
    ) -> Result<(), Error> {
        let ts = self.clock.now_ms();
        let m = self.get_thread_meta(c, t).await?;
        self.append_thread_turn(
            c,
            t,
            &Turn {
                role: "assistant".into(),
                user_id: None,
                username: Some("DomDimaBot".into()),
                message: message.into(),
                timestamp: ts,
                source_message_id,
                delivered,
            },
            get_thread_limits_for_tier(tier),
        )
        .await?;
        if let Some(m) = m
            && !m.owner_user_id.is_empty()
        {
            self.touch_thread_indexes(c, &m.owner_user_id, t, ts)
                .await?;
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "userID")]
    pub user_id: String,
    pub username: String,
    pub message: String,
    pub plan_tier: Tier,
    pub source_message_id: Option<String>,
}
impl ResolveInput {
    fn turn(&self, ts: i64) -> Turn {
        Turn {
            role: "user".into(),
            user_id: Some(self.user_id.clone()),
            username: Some(self.username.clone()),
            message: self.message.clone(),
            timestamp: ts,
            source_message_id: self.source_message_id.clone(),
            delivered: None,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    #[serde(rename = "threadID")]
    pub thread_id: String,
    pub created_new_thread: bool,
    pub selected_score: f64,
    pub threshold: f64,
    pub candidate_count: usize,
    pub prompt_turns_used: usize,
    pub limits: Limits,
    pub prompt_context: Vec<PromptTurn>,
}
fn tokenize(s: &str) -> Vec<String> {
    let lower = dima_text::to_lower(s);
    let text = regex::Regex::new(r"[^\p{L}\p{N}\s]")
        .map(|r| r.replace_all(&lower, " ").into_owned())
        .unwrap_or_default();
    text.split_whitespace()
        .filter(|s| s.chars().count() >= 3 && *s != "domdimabot")
        .take(64)
        .map(str::to_owned)
        .collect()
}
fn keywords(s: &str) -> Vec<String> {
    let lower = dima_text::to_lower(s);
    let text = regex::Regex::new(r"[^\p{L}\p{N}\s]")
        .map(|r| r.replace_all(&lower, " ").into_owned())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    text.split_whitespace()
        .filter(|s| {
            s.chars().count() >= 3
                && ![
                    "the",
                    "and",
                    "that",
                    "with",
                    "this",
                    "you",
                    "que",
                    "pero",
                    "para",
                    "como",
                    "con",
                    "una",
                    "por",
                    "wow",
                    "domdimabot",
                ]
                .contains(s)
                && seen.insert(s.to_string())
        })
        .take(12)
        .map(str::to_owned)
        .collect()
}

fn similarity(a: &[String], b: &[String]) -> f64 {
    let a: HashSet<_> = a.iter().collect();
    let b: HashSet<_> = b.iter().collect();
    if a.is_empty() || b.is_empty() {
        0.0
    } else {
        a.intersection(&b).count() as f64 / a.len().max(b.len()) as f64
    }
}
pub fn score_thread(m: &Meta, incoming: &str, recent: &str, user: &str, now_ms: i64) -> f64 {
    let tokens = tokenize(incoming);
    let lexical =
        similarity(&tokens, &m.topic_keywords).max(similarity(&tokens, &tokenize(recent)));
    let recency =
        (1.0 - (now_ms.saturating_sub(m.last_activity_ts).max(0) as f64 / 86400000.0)).max(0.0);
    lexical * 0.45 + recency * 0.35 + if m.owner_user_id == user { 1.0 } else { 0.2 } * 0.2
}
