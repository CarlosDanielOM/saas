//! The channel's own emotes (`utils/twitch_emotes.ts`), shared by analytics, speech filters and
//! the AI context.
//!
//! `GET /helix/chat/emotes?broadcaster_id=<id>` with the app token and a 3 s deadline; the
//! result is cached in `twitch:{id}:emote-catalog:v1` (`EX 86400`) with the time it was checked
//! and when to ask again: 1 hour after a success, 60 s after a failure (the previous emotes are
//! kept). A catalog is `ready` under 1 hour old, `stale` under 24 hours (same emotes), then
//! `unavailable` with no emotes; global emotes are never a fallback. One load per channel at a
//! time in a process.
//!
//! Text rule (`MIGRATION.md` section 4): an emote name is cut to 64 UTF-16 code units as
//! `name.slice(0, 64)` does, on a character boundary (an astral character that would be split is
//! left out). Names are ASCII in practice.

use crate::base::Twitch;
use crate::helix::{Auth, HelixRequest};
use dima_http::Path;
use dima_store::dragonfly::SetOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// Most emotes a catalog may hold.
const MAX_EMOTES: usize = 2000;
/// Longest emote name kept, in UTF-16 code units.
const MAX_NAME_UNITS: usize = 64;
const DAY_MS: f64 = 86_400_000.0;
const HOUR_MS: f64 = 3_600_000.0;
const RETRY_AFTER_SUCCESS_MS: i64 = 3_600_000;
const RETRY_AFTER_FAILURE_MS: i64 = 60_000;
const CACHE_SECONDS: u64 = 86_400;

/// One emote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Emote {
    /// Twitch's id (`[a-zA-Z0-9_-]{1,64}`).
    pub id: String,
    /// The text that shows the emote in chat.
    pub name: String,
}

/// How fresh a catalog is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogStatus {
    /// Checked within the hour.
    Ready,
    /// Checked within the day.
    Stale,
    /// Never checked, or longer ago than a day.
    Unavailable,
}

/// `ChannelEmoteCatalog`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChannelEmoteCatalog {
    /// The emotes (empty when unavailable).
    pub emotes: Vec<Emote>,
    /// The freshness.
    pub status: CatalogStatus,
    /// When the emotes were last fetched (ISO text), if ever.
    #[serde(rename = "checkedAt")]
    pub checked_at: Option<String>,
}

impl ChannelEmoteCatalog {
    fn unavailable() -> Self {
        Self {
            emotes: Vec::new(),
            status: CatalogStatus::Unavailable,
            checked_at: None,
        }
    }
}

/// The cached row (`CachedCatalog`).
#[derive(Clone, Debug, PartialEq, Serialize)]
struct CachedCatalog {
    emotes: Vec<Emote>,
    #[serde(rename = "checkedAt")]
    checked_at: Option<String>,
    #[serde(rename = "retryAt")]
    retry_at: i64,
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_channel(id: &str) -> bool {
    (1..=30).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// The reference's checks on a cached row; `None` when it fails them.
fn read_cached(raw: &str) -> Option<CachedCatalog> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let emotes = value.get("emotes")?.as_array()?;
    if emotes.len() > MAX_EMOTES {
        return None;
    }
    let emotes = emotes
        .iter()
        .map(|item| {
            let id = item.get("id")?.as_str().filter(|id| valid_id(id))?;
            let name = item.get("name")?.as_str()?;
            Some(Emote {
                id: id.to_owned(),
                name: name.to_owned(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let checked_at = match value.get("checkedAt") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => {
            dima_text::parse_date(text)?;
            Some(text.clone())
        }
        _ => return None,
    };
    let retry_at = value.get("retryAt")?.as_f64().filter(|n| n.is_finite())?;
    Some(CachedCatalog {
        emotes,
        checked_at,
        retry_at: retry_at as i64,
    })
}

/// `view(row)` at `now_ms`.
fn view(row: &CachedCatalog, now_ms: i64) -> ChannelEmoteCatalog {
    let age = row
        .checked_at
        .as_deref()
        .and_then(dima_text::parse_date)
        .map_or(f64::INFINITY, |at| (now_ms - at) as f64);
    ChannelEmoteCatalog {
        emotes: if age < DAY_MS {
            row.emotes.clone()
        } else {
            Vec::new()
        },
        checked_at: row.checked_at.clone(),
        status: if age >= DAY_MS {
            CatalogStatus::Unavailable
        } else if age < HOUR_MS {
            CatalogStatus::Ready
        } else {
            CatalogStatus::Stale
        },
    }
}

/// The emotes of a Helix answer, or `None` when the reference would throw.
fn parse_answer(body: &Value) -> Option<Vec<Emote>> {
    let data = body.get("data")?.as_array()?;
    if data.len() > MAX_EMOTES {
        return None;
    }
    data.iter()
        .map(|item| {
            let id = item.get("id")?.as_str().filter(|id| valid_id(id))?;
            let name = item.get("name")?.as_str()?;
            Some(Emote {
                id: id.to_owned(),
                name: dima_text::truncate_utf16_budget(name, MAX_NAME_UNITS).to_owned(),
            })
        })
        .collect()
}

impl Twitch {
    /// `getChannelEmoteCatalog(channelID)`.
    pub async fn channel_emote_catalog(&self, channel_id: &str) -> ChannelEmoteCatalog {
        let twitch = self.clone();
        let key = channel_id.to_owned();
        let inner = &self.inner;
        let Some(waiter) = inner.emote_flights.join(
            key.clone(),
            &inner.tracker,
            ChannelEmoteCatalog::unavailable(),
            move || async move { twitch.load_catalog(&key).await },
        ) else {
            return ChannelEmoteCatalog::unavailable();
        };
        waiter.await
    }

    async fn load_catalog(&self, channel_id: &str) -> ChannelEmoteCatalog {
        if !valid_channel(channel_id) {
            return ChannelEmoteCatalog::unavailable();
        }
        let inner = Arc::clone(&self.inner);
        let key = inner.config.keys.emote_catalog(channel_id);
        let previous = match inner.dragonfly.get_text(&key).await {
            Ok(Some(raw)) => read_cached(&raw),
            // Corrupt or absent: repaired from Twitch.
            _ => None,
        };
        let now = inner.now_ms();
        if let Some(previous) = &previous
            && previous.retry_at > now
        {
            return view(previous, now);
        }
        let saved = match self.fetch_emotes(channel_id).await {
            Some(emotes) => {
                let now = inner.now_ms();
                CachedCatalog {
                    emotes,
                    checked_at: dima_text::to_iso_string(now),
                    retry_at: now + RETRY_AFTER_SUCCESS_MS,
                }
            }
            None => {
                let now = inner.now_ms();
                let (emotes, checked_at) = previous
                    .map(|row| (row.emotes, row.checked_at))
                    .unwrap_or_default();
                CachedCatalog {
                    emotes,
                    checked_at,
                    retry_at: now + RETRY_AFTER_FAILURE_MS,
                }
            }
        };
        let Ok(raw) = serde_json::to_vec(&saved) else {
            return ChannelEmoteCatalog::unavailable();
        };
        if inner
            .dragonfly
            .set(&key, &raw, SetOptions::ex(CACHE_SECONDS))
            .await
            .is_err()
        {
            return ChannelEmoteCatalog::unavailable();
        }
        view(&saved, inner.now_ms())
    }

    async fn fetch_emotes(&self, channel_id: &str) -> Option<Vec<Emote>> {
        let answer = self
            .helix(
                HelixRequest::get(Path::fixed("/chat/emotes"), Auth::App)
                    .query("broadcaster_id", channel_id)
                    .timeout(self.inner.config.timings.emote_timeout)
                    .operation("channel_emote_catalog"),
            )
            .await
            .ok()?;
        let ok = answer.status().is_success();
        let body: Value = answer.into_response().json().await.ok()?;
        if !ok {
            return None;
        }
        parse_answer(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn row(checked_at: Option<i64>) -> CachedCatalog {
        CachedCatalog {
            emotes: vec![Emote {
                id: "e1".into(),
                name: "Kappa".into(),
            }],
            checked_at: checked_at.and_then(dima_text::to_iso_string),
            retry_at: NOW,
        }
    }

    #[test]
    fn freshness_follows_the_age() {
        assert_eq!(view(&row(Some(NOW)), NOW).status, CatalogStatus::Ready);
        let stale = view(&row(Some(NOW - 3_600_000)), NOW);
        assert_eq!(stale.status, CatalogStatus::Stale);
        assert_eq!(stale.emotes.len(), 1);
        let old = view(&row(Some(NOW - 86_400_000)), NOW);
        assert_eq!(old.status, CatalogStatus::Unavailable);
        assert!(old.emotes.is_empty());
        let never = view(&row(None), NOW);
        assert_eq!(never.status, CatalogStatus::Unavailable);
        assert_eq!(never.checked_at, None);
    }

    #[test]
    fn cached_rows_are_checked_like_the_reference() {
        let good = r#"{"emotes":[{"id":"emotesv2_a-1","name":"x"}],"checkedAt":"2026-11-11T00:00:00.000Z","retryAt":5}"#;
        assert!(read_cached(good).is_some());
        assert!(read_cached(r#"{"emotes":[],"checkedAt":null,"retryAt":5}"#).is_some());
        for bad in [
            r#"{"emotes":[{"id":"bad id","name":"x"}],"checkedAt":null,"retryAt":5}"#,
            r#"{"emotes":[{"id":"a","name":5}],"checkedAt":null,"retryAt":5}"#,
            r#"{"emotes":[],"checkedAt":"yesterday","retryAt":5}"#,
            r#"{"emotes":[],"checkedAt":null,"retryAt":"5"}"#,
            r#"{"emotes":{},"checkedAt":null,"retryAt":5}"#,
            "{broken",
        ] {
            assert!(read_cached(bad).is_none(), "{bad}");
        }
        let many: Vec<Value> = (0..2001)
            .map(|i| json!({"id": format!("e{i}"), "name": "n"}))
            .collect();
        let raw = json!({"emotes": many, "checkedAt": null, "retryAt": 5}).to_string();
        assert!(read_cached(&raw).is_none());
    }

    #[test]
    fn answers_are_checked_and_names_cut_like_slice() {
        let long = format!("{}😀", "a".repeat(63));
        let body = json!({"data": [{"id": "e1", "name": long}, {"id": "e2", "name": "Kappa 👋"}]});
        let emotes = parse_answer(&body).unwrap();
        // 63 units + an astral character (2 units) is over 64: the character is left out.
        assert_eq!(emotes[0].name, "a".repeat(63));
        assert_eq!(emotes[1].name, "Kappa 👋");
        assert!(parse_answer(&json!({"data": [{"id": "", "name": "x"}]})).is_none());
        assert!(parse_answer(&json!({"data": [null]})).is_none());
        assert!(parse_answer(&json!({"data": {}})).is_none());
        assert!(parse_answer(&json!({})).is_none());
        assert!(valid_channel("123") && !valid_channel("12a") && !valid_channel(""));
        assert!(!valid_channel(&"1".repeat(31)));
    }
}
