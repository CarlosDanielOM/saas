//! Fish catalogue: FIFO cache of at most 100 raw responses for 60s, injected wall clock.
//! Names/description/sample display limits count Unicode scalars; ids and URLs stay exact.
use crate::providers::Clients;
use dima_core::Clock;
use dima_http::Path;
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc, time::Duration};
use tokio::sync::Mutex;
#[derive(Debug, thiserror::Error, PartialEq)]
#[error("{message}")]
pub struct VoiceError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}
fn error(status: u16, code: &'static str, message: &'static str) -> VoiceError {
    VoiceError {
        status,
        code,
        message,
    }
}
fn unavailable() -> VoiceError {
    error(
        503,
        "catalog_unavailable",
        "Voice catalog is temporarily unavailable",
    )
}
fn id_valid(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
pub const FISH_VOICES: &[(&str, &str)] = &[
    ("gojo", "7b5626abdaa044babfc3829ec15acf31"),
    ("rias_gremory", "a5711996953b4cfda57cb516e26fe1e0"),
    ("toji_fushiguro", "51504afe0e93445c9c507451d6ace486"),
    ("carlos_bodoque", "0a6d2732710f466aafa67cdb8db3bf0e"),
];
pub fn resolve_voice(value: Option<&str>) -> Option<String> {
    let Some(value) = value.filter(|s| !s.is_empty()) else {
        return Some(FISH_VOICES[0].1.into());
    };
    let id = dima_text::trim(value);
    FISH_VOICES
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, id)| (*id).to_owned())
        .or_else(|| id_valid(id).then(|| id.to_ascii_lowercase()))
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Search {
    pub name: String,
    pub gender: String,
    pub language: String,
    pub license: String,
    pub page: u32,
}
pub fn parse_search(q: &Value) -> Result<Search, VoiceError> {
    let field = |name: &str, default: &str| {
        q.get(name)
            .unwrap_or(&Value::Null)
            .as_str()
            .map(str::to_owned)
            .or_else(|| q.get(name).is_none().then(|| default.to_owned()))
    };
    let invalid = || error(400, "invalid_filters", "Invalid voice search filters");
    let name = field("name", "").ok_or_else(invalid)?;
    let gender = field("gender", "all").ok_or_else(invalid)?;
    let language = field("language", "all").ok_or_else(invalid)?;
    let license = field("license", "all").ok_or_else(invalid)?;
    let page = field("page", "1").ok_or_else(invalid)?;
    if name.chars().count() > 100
        || !["all", "female", "male"].contains(&gender.as_str())
        || !["all", "en", "es"].contains(&language.as_str())
        || !["all", "licensed", "unlicensed"].contains(&license.as_str())
        || page.is_empty()
        || !page.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    let page = dima_text::parse_number(&page);
    if !page.is_finite() || !(1.0..=50.0).contains(&page) {
        return Err(invalid());
    }
    let page = page as u32;
    if !(1..=50).contains(&page) {
        return Err(invalid());
    }
    Ok(Search {
        name: dima_text::trim(&name).into(),
        gender,
        language,
        license,
        page,
    })
}
pub fn normalize_voice(v: &Value) -> Option<Value> {
    let id = v.get("_id")?.as_str()?;
    let title = v.get("title")?.as_str()?;
    if !id_valid(id)
        || v["type"] != "tts"
        || v["visibility"] != "public"
        || v["dmca_taken_down"] == true
        || v["state"] == "failed"
        || v["pvc_release_state"] == "retired"
    {
        return None;
    }
    let tags: Vec<String> = v["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| dima_text::to_lower(&dima_text::js_string(v)))
                .collect()
        })
        .unwrap_or_default();
    let gender = if tags.iter().any(|s| s == "female") {
        json!("female")
    } else if tags.iter().any(|s| s == "male") {
        json!("male")
    } else {
        Value::Null
    };
    let languages: Vec<&str> = v["languages"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut styles = Vec::new();
    let re = Regex::new("^[a-z][a-z-]{1,23}$").ok()?;
    for tag in &tags {
        if re.is_match(tag)
            && !["female", "male", "english", "spanish"].contains(&tag.as_str())
            && !styles.contains(tag)
            && styles.len() < 6
        {
            styles.push(tag.clone());
        }
    }
    let cover = v["cover_image"]
        .as_str()
        .filter(|s| {
            s.get(..11)
                .is_some_and(|p| p.eq_ignore_ascii_case("coverimage/"))
                && s.get(11..).is_some_and(id_valid)
        })
        .map(|s| format!("https://public-platform.r2.fish.audio/cdn-cgi/image/width=128/{s}"));
    let sample_re=Regex::new(r"(?i)^https://platform\.r2\.fish\.audio/tasks?/(?:[0-9]{4}-[0-9]{2}-[0-9]{2}/)?[a-f0-9]{32}\.(?:mp3|wav|opus)$").ok()?;
    let sample=v["samples"].as_array().and_then(|a|a.iter().find_map(|s|s["audio"].as_str().filter(|url|sample_re.is_match(url)).map(|url|json!({"url":url,"text":dima_text::truncate_chars(dima_text::trim(s["text"].as_str().unwrap_or_default()),400)}))));
    let uses = v["task_count"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(f64::floor);
    Some(
        json!({"id":id,"name":dima_text::truncate_chars(title,200),"languages":languages,"gender":gender,"licensed":v["licensed"].as_bool(),"description":dima_text::truncate_chars(dima_text::trim(v["description"].as_str().unwrap_or_default()),300),"tags":styles,"coverUrl":cover,"sample":sample,"uses":uses}),
    )
}
pub struct Catalog {
    clients: Clients,
    clock: Arc<dyn Clock>,
    cache: Mutex<VecDeque<(String, i64, Value)>>,
}
impl Catalog {
    pub fn new(clients: Clients, clock: Arc<dyn Clock>) -> Self {
        Self {
            clients,
            clock,
            cache: Mutex::new(VecDeque::new()),
        }
    }
    async fn get_raw(
        &self,
        id: Option<&str>,
        query: &[(String, String)],
    ) -> Result<Value, VoiceError> {
        let cache_key = serde_json::to_string(&(id, query)).map_err(|_| unavailable())?;
        {
            let cache = self.cache.lock().await;
            if let Some((_, _, v)) = cache
                .iter()
                .find(|(k, until, _)| k == &cache_key && *until > self.clock.now_ms())
            {
                return Ok(v.clone());
            }
        }
        if self
            .clients
            .config
            .fish_key
            .as_ref()
            .is_none_or(|k| dima_text::trim(k.expose()).is_empty())
        {
            return Err(error(
                503,
                "catalog_unavailable",
                "Voice catalog is unavailable",
            ));
        }
        let path = match id {
            Some(id) => Path::template("/model/{}", &[id]).map_err(|_| unavailable())?,
            None => Path::fixed("/model"),
        };
        let request = self.clients.http.get(&self.clients.fish, path);
        let request = if query.is_empty() {
            request
        } else {
            request.query(query)
        };
        let response = request
            .timeout(Duration::from_secs(12))
            .max_bytes(2 * 1024 * 1024)
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(if response.status().as_u16() == 404 {
                error(404, "voice_unavailable", "Voice catalog request failed")
            } else {
                error(503, "catalog_unavailable", "Voice catalog request failed")
            });
        }
        let value: Value = response.json().await.map_err(|_| unavailable())?;
        let mut cache = self.cache.lock().await;
        if let Some(i) = cache.iter().position(|(k, _, _)| k == &cache_key) {
            cache.remove(i);
        }
        if cache.len() >= 100 {
            cache.pop_front();
        }
        cache.push_back((
            cache_key,
            self.clock.now_ms().saturating_add(60_000),
            value.clone(),
        ));
        Ok(value)
    }
    pub async fn voice(&self, id: &str) -> Result<Value, VoiceError> {
        if !id_valid(id) {
            return Err(error(400, "invalid_voice", "Invalid voice ID"));
        }
        normalize_voice(&self.get_raw(Some(id), &[]).await?).ok_or_else(|| {
            error(
                404,
                "voice_unavailable",
                "This voice is no longer available",
            )
        })
    }
    pub async fn search(&self, s: &Search) -> Result<Value, VoiceError> {
        let mut q = vec![
            ("page_size".into(), "20".into()),
            ("page_number".into(), s.page.to_string()),
            ("sort_by".into(), "score".into()),
        ];
        for (k, v) in [
            ("title", s.name.as_str()),
            ("tag", s.gender.as_str()),
            ("language", s.language.as_str()),
        ] {
            if !v.is_empty() && v != "all" {
                q.push((k.into(), v.into()));
            }
        }
        if s.license == "licensed" {
            q.push(("licensed".into(), "true".into()));
        }
        let raw = self.get_raw(None, &q).await?;
        let items: Vec<Value> = raw["items"]
            .as_array()
            .ok_or_else(|| error(503, "catalog_unavailable", "Invalid catalog response"))?
            .iter()
            .filter_map(normalize_voice)
            .filter(|v| {
                (s.license == "all" || v["licensed"] == json!(s.license == "licensed"))
                    && (s.gender == "all" || v["gender"] == s.gender)
                    && (s.language == "all"
                        || v["languages"]
                            .as_array()
                            .is_some_and(|a| a.contains(&json!(s.language))))
            })
            .collect();
        let more = raw["has_more"]
            .as_bool()
            .unwrap_or(f64::from(s.page * 20) < raw["total"].as_f64().unwrap_or(0.0));
        Ok(json!({"items":items,"page":s.page,"hasMore":s.page<50&&more}))
    }
}
