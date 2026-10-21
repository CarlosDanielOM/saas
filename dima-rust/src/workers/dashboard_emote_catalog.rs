//! Native implementation of the shared Twitch channel-emote catalog contract.
//! Cache/provider failures produce unavailable/stale views, never a global-emote
//! fallback. Production URLs are fixed; standard proxy/CA environment works for
//! isolated provider fixtures. No secrets or raw provider errors are emitted.
use std::time::Duration;

use mongodb::bson::DateTime;
use redis::aio::ConnectionManager;
use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize};

use super::super::dashboard_insights::JsText;
use crate::utils::redis::get_redis_client;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
const RETRY_MS: i64 = 60_000;
const REQUEST_LIMIT: Duration = Duration::from_secs(3);
const CACHE_INIT_LIMIT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Emote {
    pub id: String,
    name: JsText,
}

#[derive(Clone, Debug)]
pub struct ChannelEmoteCatalog {
    pub emotes: Vec<Emote>,
    pub status: &'static str,
    pub checked_at: Option<String>,
}
impl ChannelEmoteCatalog {
    fn unavailable() -> Self {
        Self {
            emotes: Vec::new(),
            status: "unavailable",
            checked_at: None,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedCatalog {
    emotes: Vec<Emote>,
    checked_at: Option<String>,
    retry_at: f64,
}

/// Construction only configures the native HTTP client; MongoDB initialization
/// never depends on Redis or Twitch. Cloned lookups share the HTTP pool. The
/// worker performs one sequential channel lookup, so no in-flight map is needed.
pub struct ChannelEmoteProvider {
    client: Option<Client>,
}
impl Default for ChannelEmoteProvider {
    fn default() -> Self {
        Self::new()
    }
}
impl ChannelEmoteProvider {
    pub fn new() -> Self {
        // Native roots honor SSL_CERT_FILE. Reqwest still reads standard proxy
        // variables with default TLS/http2/system-proxy features disabled.
        let client = Client::builder()
            .use_rustls_tls()
            .timeout(REQUEST_LIMIT)
            .connect_timeout(REQUEST_LIMIT)
            .redirect(Policy::none())
            .build()
            .ok();
        Self { client }
    }

    pub async fn get(&self, channel: &str) -> ChannelEmoteCatalog {
        if channel.is_empty() || channel.len() > 30 || !channel.bytes().all(|c| c.is_ascii_digit())
        {
            return ChannelEmoteCatalog::unavailable();
        }
        self.load(channel)
            .await
            .unwrap_or_else(|_| ChannelEmoteCatalog::unavailable())
    }

    async fn load(&self, channel: &str) -> std::result::Result<ChannelEmoteCatalog, ()> {
        let mut cache = tokio::time::timeout(CACHE_INIT_LIMIT, get_redis_client())
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        let key = format!("twitch:{channel}:emote-catalog:v1");
        // TS treats unreadable/corrupt cache as repairable; a provider refresh
        // is still attempted, and Redis write failure makes the view unavailable.
        let previous = match tokio::time::timeout(
            REQUEST_LIMIT,
            redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut cache),
        )
        .await
        {
            Ok(Ok(Some(raw))) => parse_cached(&raw),
            _ => None,
        };
        let now = DateTime::now();
        if let Some(previous) = &previous
            && previous.retry_at > now.timestamp_millis() as f64
        {
            return Ok(view(previous, now));
        }
        let refreshed = async {
            let emotes = self.fetch(channel, &mut cache).await?;
            let now = DateTime::now();
            let saved = CachedCatalog {
                emotes,
                checked_at: Some(javascript_iso(now)?),
                retry_at: (now.timestamp_millis() + HOUR_MS) as f64,
            };
            save(&mut cache, &key, &saved).await?;
            Ok::<_, ()>(saved)
        }
        .await;
        if let Ok(saved) = refreshed {
            return Ok(view(&saved, DateTime::now()));
        }
        // A failed success-cache write enters the same fallback as a failed
        // provider fetch, preserving the previous catalog and 60s retry timer.
        let mut saved = previous.unwrap_or(CachedCatalog {
            emotes: Vec::new(),
            checked_at: None,
            retry_at: 0.0,
        });
        saved.retry_at = (DateTime::now().timestamp_millis() + RETRY_MS) as f64;
        save(&mut cache, &key, &saved).await?;
        Ok(view(&saved, DateTime::now()))
    }

    async fn fetch(
        &self,
        channel: &str,
        cache: &mut ConnectionManager,
    ) -> std::result::Result<Vec<Emote>, ()> {
        let client = self.client.as_ref().ok_or(())?;
        let token = self.app_token(cache).await?;
        let client_id = std::env::var("CLIENT_ID").map_err(|_| ())?;
        // Fetch + body decoding share the same 3s deadline as AbortSignal.timeout.
        tokio::time::timeout(REQUEST_LIMIT, async {
            let response = client
                .get("https://api.twitch.tv/helix/chat/emotes")
                .query(&[("broadcaster_id", channel)])
                .header("Client-Id", client_id)
                .bearer_auth(token)
                .header("Content-Type", "application/json")
                .send()
                .await
                .map_err(|_| ())?;
            if !response.status().is_success() {
                return Err(());
            }
            #[derive(Deserialize)]
            struct Body {
                data: Vec<Emote>,
            }
            let body: Body = response.json().await.map_err(|_| ())?;
            let data = body.data;
            if data.len() > 2000 {
                return Err(());
            }
            data.into_iter()
                .map(|mut row| {
                    if !valid_emote_id(&row.id) {
                        return Err(());
                    }
                    row.name.0.truncate(64);
                    Ok(row)
                })
                .collect()
        })
        .await
        .map_err(|_| ())?
    }

    async fn app_token(&self, cache: &mut ConnectionManager) -> std::result::Result<String, ()> {
        if let Some(token) = tokio::time::timeout(
            REQUEST_LIMIT,
            redis::cmd("GET")
                .arg("app:twitch:token")
                .query_async::<Option<String>>(cache),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?
        .filter(|token| !token.is_empty())
        {
            return Ok(token);
        }
        let client = self.client.as_ref().ok_or(())?;
        let client_id = std::env::var("CLIENT_ID").map_err(|_| ())?;
        let client_secret = std::env::var("CLIENT_SECRET").map_err(|_| ())?;
        let body: serde_json::Value = tokio::time::timeout(REQUEST_LIMIT, async {
            let response = client
                .post("https://id.twitch.tv/oauth2/token")
                .form(&[
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                    ("grant_type", "client_credentials"),
                ])
                .send()
                .await
                .map_err(|_| ())?;
            response.json().await.map_err(|_| ())
        })
        .await
        .map_err(|_| ())??;
        let token = body
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or(())?
            .to_owned();
        let expires = body
            .get("expires_in")
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
            })
            .ok_or(())?;
        if !expires.is_finite()
            || expires <= 0.0
            || expires.fract() != 0.0
            || expires > i64::MAX as f64
        {
            return Err(());
        }
        tokio::time::timeout(
            REQUEST_LIMIT,
            redis::cmd("SET")
                .arg("app:twitch:token")
                .arg(&token)
                .arg("EX")
                .arg(expires as i64)
                .query_async::<()>(cache),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        Ok(token)
    }
}

async fn save(
    cache: &mut ConnectionManager,
    key: &str,
    row: &CachedCatalog,
) -> std::result::Result<(), ()> {
    let encoded = serde_json::to_string(row).map_err(|_| ())?;
    tokio::time::timeout(
        REQUEST_LIMIT,
        redis::cmd("SET")
            .arg(key)
            .arg(encoded)
            .arg("EX")
            .arg(86_400)
            .query_async::<()>(cache),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

pub(crate) fn valid_emote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn parse_checked(value: &str) -> Option<DateTime> {
    DateTime::parse_rfc3339_str(value).ok().or_else(|| {
        // Date.parse also accepts a date-only ISO value in an existing cache.
        (value.len() == 10)
            .then(|| DateTime::parse_rfc3339_str(format!("{value}T00:00:00Z")).ok())
            .flatten()
    })
}
fn parse_cached(raw: &str) -> Option<CachedCatalog> {
    // Missing checkedAt is invalid in TS (undefined is not null). Serde normally
    // accepts a missing Option, so check membership before typed decoding.
    let value: HashFields = serde_json::from_str(raw).ok()?;
    if !value.0.contains_key("checkedAt") {
        return None;
    }
    let row: CachedCatalog = serde_json::from_str(raw).ok()?;
    (row.emotes.len() <= 2000
        && row.emotes.iter().all(|emote| valid_emote_id(&emote.id))
        && row
            .checked_at
            .as_deref()
            .is_none_or(|value| parse_checked(value).is_some())
        && row.retry_at.is_finite())
    .then_some(row)
}

// Raw fields permit valid JSON containing a lone surrogate in an emote name;
// serde_json::Value's UTF8 strings cannot represent that JS cache contract.
#[derive(Deserialize)]
struct HashFields(std::collections::HashMap<String, Box<serde_json::value::RawValue>>);
fn view(row: &CachedCatalog, now: DateTime) -> ChannelEmoteCatalog {
    let age = row
        .checked_at
        .as_deref()
        .and_then(parse_checked)
        .map(|at| now.timestamp_millis().saturating_sub(at.timestamp_millis()));
    let status = match age {
        Some(age) if age < HOUR_MS => "ready",
        Some(age) if age < DAY_MS => "stale",
        _ => "unavailable",
    };
    ChannelEmoteCatalog {
        emotes: if status == "unavailable" {
            Vec::new()
        } else {
            row.emotes.clone()
        },
        status,
        checked_at: row.checked_at.clone(),
    }
}

/// BSON RFC3339 omits trailing zero fractions; Date.toISOString always has three.
pub(crate) fn javascript_iso(at: DateTime) -> std::result::Result<String, ()> {
    let ms = at.timestamp_millis();
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&ms) {
        return Err(());
    }
    // Proleptic Gregorian civil-from-days, matching JS Date.UTC including
    // signed six-digit years outside 0000..9999 (BSON RFC3339 rejects those).
    let z = ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    let time = ms.rem_euclid(DAY_MS);
    let hour = time / 3_600_000;
    let minute = time / 60_000 % 60;
    let second = time / 1000 % 60;
    let fraction = time % 1000;
    Ok(format!(
        "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_cache_validation_and_freshness_boundaries() {
        let now = DateTime::from_millis(100_000_000);
        for (age, status) in [
            (0, "ready"),
            (HOUR_MS - 1, "ready"),
            (HOUR_MS, "stale"),
            (DAY_MS - 1, "stale"),
            (DAY_MS, "unavailable"),
        ] {
            let row = CachedCatalog {
                emotes: vec![Emote {
                    id: "Case_A-1".into(),
                    name: JsText::sliced("Kappa", 64),
                }],
                checked_at: Some(
                    javascript_iso(DateTime::from_millis(now.timestamp_millis() - age)).unwrap(),
                ),
                retry_at: 0.0,
            };
            let parsed = parse_cached(&serde_json::to_string(&row).unwrap()).unwrap();
            let result = view(&parsed, now);
            assert_eq!(result.status, status);
            assert_eq!(result.emotes.len(), usize::from(status != "unavailable"));
        }
        for raw in [
            r#"{"emotes":[],"retryAt":0}"#,
            r#"{"emotes":[],"checkedAt":"bad","retryAt":0}"#,
            r#"{"emotes":[{"id":"bad:id","name":"bad"}],"checkedAt":null,"retryAt":0}"#,
        ] {
            assert!(parse_cached(raw).is_none());
        }
        assert_eq!(
            javascript_iso(DateTime::from_millis(0)).unwrap(),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            javascript_iso(DateTime::from_millis(120)).unwrap(),
            "1970-01-01T00:00:00.120Z"
        );
        assert_eq!(
            javascript_iso(DateTime::from_millis(-1)).unwrap(),
            "1969-12-31T23:59:59.999Z"
        );
        assert_eq!(
            javascript_iso(DateTime::from_millis(253_402_300_800_000)).unwrap(),
            "+010000-01-01T00:00:00.000Z"
        );
        let lone = JsText::sliced(&format!("{}😀", "E".repeat(63)), 64);
        let saved = CachedCatalog {
            emotes: vec![Emote {
                id: "owner".into(),
                name: lone.clone(),
            }],
            checked_at: None,
            retry_at: 0.0,
        };
        let encoded = serde_json::to_string(&saved).unwrap();
        assert!(encoded.contains("\\ud83d"));
        assert_eq!(parse_cached(&encoded).unwrap().emotes[0].name, lone);
    }
}
