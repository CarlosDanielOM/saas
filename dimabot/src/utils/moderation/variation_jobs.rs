//! Request and single-claim processing for platform-funded variation jobs.
//! Application Redis is acquired lazily only when a reservation spends quota.
//! This module does not start a worker.
use crate::{
    schemas::{
        PersistenceError,
        moderation_variation::{self as schema, generated_variation_to_bson},
    },
    utils::{
        bson_json::{compiler_bson_json, json_bson},
        js_string::JsString,
        lossless_json::JsonValue,
        moderation::{
            advanced_policy::{MODERATION_RETENTION_DAYS, paid_moderation_owned},
            types::VariationMode,
            variations::{self, VARIATION_MODEL, VARIATION_VERSION},
            variations_provider::MuseVariationsProvider,
        },
        observability::Telemetry,
        redis_application_runtime,
    },
};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
    options::ReturnDocument,
};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// This literal includes the leading/trailing newline and indentation in the
// source template. Redis EVAL receives exactly these bytes.
pub const BUDGET_LUA: &str = "\n        local words = tonumber(redis.call('GET', KEYS[1]) or '0')\n        local jobs = tonumber(redis.call('GET', KEYS[2]) or '0')\n        if words + tonumber(ARGV[1]) > 500 or jobs >= 30 then return 0 end\n        redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('INCR', KEYS[2])\n        if words == 0 then redis.call('EXPIRE', KEYS[1], 86400) end\n        if jobs == 0 then redis.call('EXPIRE', KEYS[2], 86400) end\n        return 1\n    ";

#[derive(Debug)]
pub struct VariationError {
    pub status: u16,
    pub message: String,
}
impl fmt::Display for VariationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for VariationError {}
#[derive(Debug)]
pub enum JobError {
    Variation(VariationError),
    Other(String),
}
impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Variation(e) => e.fmt(f),
            Self::Other(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for JobError {}
fn other(e: impl fmt::Display) -> JobError {
    JobError::Other(e.to_string())
}
fn err(status: u16, message: &str) -> JobError {
    JobError::Variation(VariationError {
        status,
        message: message.into(),
    })
}

/// JS Map semantics: updating a primitive key does not move its position.
/// Mixed entries can have non-string or missing `term` properties. Such keys
/// cannot satisfy an application string lookup, but remain in the raw Map.
#[derive(Clone, Debug)]
struct EntryKey {
    string: Option<JsString>,
    raw: Bson,
}
#[derive(Clone, Debug, Default)]
pub struct OrderedEntries(Vec<(EntryKey, Bson)>);
impl OrderedEntries {
    pub fn insert(&mut self, key: JsString, value: Bson) {
        if let Some((_, old)) = self
            .0
            .iter_mut()
            .find(|(prior, _)| prior.string.as_ref() == Some(&key))
        {
            *old = value;
        } else {
            self.0.push((
                EntryKey {
                    raw: Bson::String(js(&key)),
                    string: Some(key),
                },
                value,
            ));
        }
    }
    fn insert_raw(&mut self, key: Bson, value: Bson) {
        if let Some((_, old)) = self
            .0
            .iter_mut()
            .find(|(prior, _)| same_map_key(&prior.raw, &key))
        {
            *old = value;
        } else {
            self.0.push((
                EntryKey {
                    string: key.as_str().map(JsString::from),
                    raw: key,
                },
                value,
            ));
        }
    }
    pub fn get(&self, key: &JsString) -> Option<&Bson> {
        self.0
            .iter()
            .find(|(k, _)| k.string.as_ref() == Some(key))
            .map(|(_, v)| v)
    }
    /// String-keyed view retained for typed application consumers.
    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &Bson)> {
        self.0
            .iter()
            .filter_map(|(k, v)| k.string.as_ref().map(|key| (key, v)))
    }
    /// Lossless Mixed-key view for the source's Map return contract.
    pub fn raw_iter(&self) -> impl Iterator<Item = (&Bson, &Bson)> {
        self.0.iter().map(|(k, v)| (&k.raw, v))
    }
}
fn same_map_key(a: &Bson, b: &Bson) -> bool {
    fn number(value: &Bson) -> Option<f64> {
        match value {
            Bson::Int32(n) => Some(f64::from(*n)),
            Bson::Int64(n) => Some(*n as f64),
            Bson::Double(n) => Some(*n),
            _ => None,
        }
    }
    if let (Some(a), Some(b)) = (number(a), number(b)) {
        return a == b || (a.is_nan() && b.is_nan());
    }
    match (a, b) {
        (Bson::String(a), Bson::String(b)) => a == b,
        (Bson::Boolean(a), Bson::Boolean(b)) => a == b,
        (Bson::Null, Bson::Null) | (Bson::Undefined, Bson::Undefined) => true,
        _ => false,
    }
}
fn entry_property(value: &Bson, property: &str) -> Result<Bson, JobError> {
    match value {
        Bson::Null | Bson::Undefined => {
            Err(other("cannot read variation property of null or undefined"))
        }
        Bson::Document(d) => Ok(d.get(property).cloned().unwrap_or(Bson::Undefined)),
        _ => Ok(Bson::Undefined),
    }
}
fn entry_key(value: &Bson) -> Result<Bson, JobError> {
    entry_property(value, "term")
}
fn entries(doc: &Document) -> Result<Vec<Bson>, JobError> {
    Ok(doc.get_array("entries").map_err(other)?.clone())
}
fn js(s: &JsString) -> String {
    s.to_utf8_lossy()
}
fn words(terms: &[JsString]) -> Vec<String> {
    terms.iter().map(js).collect()
}
fn date(ms: i64) -> DateTime {
    DateTime::from_millis(ms)
}
fn lifetime(ms: i64) -> DateTime {
    date(ms + i64::from(MODERATION_RETENTION_DAYS) * 86_400_000)
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }
}

pub fn variation_job_id(channel: &JsString, terms: &[JsString]) -> String {
    let mut sorted = terms.to_vec();
    sorted.sort_by(|a, b| a.code_units().cmp(b.code_units()));
    let serialized = format!(
        "[{},[{}],\"{}\"]",
        channel.to_json_string(),
        sorted
            .iter()
            .map(JsString::to_json_string)
            .collect::<Vec<_>>()
            .join(","),
        VARIATION_VERSION
    );
    format!("{:x}", Sha256::digest(serialized.as_bytes()))
}
/// Source state is a String field, not a closed enum. Other states pass through.
pub fn variation_job_view(job: &Document) -> Result<Document, JobError> {
    let state = job.get_str("state").map_err(other)?;
    Ok(
        doc! {"id": job.get("_id").cloned().unwrap_or(Bson::Null), "state": if state == "reserved" { "pending" } else { state }, "entries": if state == "completed" { entries(job)? } else { Vec::new() }, "error": job.get("error").cloned().unwrap_or(Bson::Null)},
    )
}

/// Source AbortSignal timeout bound, before an optional lower test cap.
pub fn provider_deadline_ms(remaining_ms: i64) -> Option<u64> {
    if remaining_ms > 0 {
        Some(remaining_ms.min(60_000) as u64)
    } else {
        None
    }
}
enum RedisSource {
    Explicit(redis::aio::ConnectionManager),
    Application,
}

pub struct VariationJobsService {
    db: Database,
    redis: RedisSource,
    telemetry: Option<Telemetry>,
    provider: MuseVariationsProvider,
    clock: Arc<dyn Clock>,
    provider_timeout_cap: u64,
}
impl VariationJobsService {
    pub fn new(
        db: Database,
        redis: redis::aio::ConnectionManager,
        provider: MuseVariationsProvider,
    ) -> Self {
        Self {
            db,
            redis: RedisSource::Explicit(redis),
            telemetry: None,
            provider,
            clock: Arc::new(SystemClock),
            provider_timeout_cap: 60_000,
        }
    }
    /// Construct without I/O; the shared application cache is acquired only
    /// after a new or failed job has been reserved and needs budget.
    pub fn from_application(db: Database, provider: MuseVariationsProvider) -> Self {
        Self {
            db,
            redis: RedisSource::Application,
            telemetry: None,
            provider,
            clock: Arc::new(SystemClock),
            provider_timeout_cap: 60_000,
        }
    }
    /// Supply an explicit telemetry handle, overriding application telemetry.
    pub fn with_telemetry(mut self, telemetry: Telemetry) -> Self {
        self.telemetry = Some(telemetry);
        self
    }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }
    /// Lower the transport wait for deterministic disposable timeout checks.
    /// Ordinary constructors preserve the source's exact 60-second maximum;
    /// this seam cannot increase it or introduce an unbounded wait.
    pub fn with_provider_timeout_cap(mut self, cap: Duration) -> Self {
        let ms = cap.as_millis();
        assert!((1..=60_000).contains(&ms));
        self.provider_timeout_cap = ms as u64;
        self
    }
    pub async fn saved_variations(
        &self,
        channel: &JsString,
        terms: &[JsString],
        prior: &[Document],
    ) -> Result<OrderedEntries, JobError> {
        let mut saved = OrderedEntries::default();
        for rule in prior {
            if let Ok(v) = rule.get_document("variations")
                && v.get_str("mode").ok() == Some("broad")
            {
                for entry in v.get_array("entries").map_err(other)? {
                    if entry_property(entry, "version")?.as_str() == Some(VARIATION_VERSION) {
                        saved.insert_raw(entry_key(entry)?, entry.clone());
                    }
                }
            }
        }
        let cache = schema::get_moderation_variation_cache_model(&self.db);
        let ids = terms
            .iter()
            .map(|term| variations::variation_key(channel, term))
            .collect::<Vec<_>>();
        let mut cursor = cache
            .collection
            .find(doc! {"_id":{"$in":ids}, "expiresAt":{"$gt":date(self.clock.now_ms())}})
            .await
            .map_err(other)?;
        use futures_util::TryStreamExt;
        while let Some(item) = cursor.try_next().await.map_err(other)? {
            let entry = item
                .get("entry")
                .cloned()
                .ok_or_else(|| other("missing cache entry"))?;
            saved.insert_raw(entry_key(&entry)?, entry);
        }
        Ok(saved)
    }
    pub async fn resolve_variations(
        &self,
        channel: &JsString,
        terms: &[JsString],
        mode: VariationMode,
        prior: &[Document],
        allow_spaces: bool,
    ) -> Result<Document, JobError> {
        if mode == VariationMode::Off {
            return Ok(doc! {"mode":"off", "allowSpaces":false, "entries":Bson::Array(vec![])});
        }
        let saved = if mode == VariationMode::Broad {
            Some(self.saved_variations(channel, terms, prior).await?)
        } else {
            None
        };
        let mut result = Vec::new();
        let mut validation = Vec::new();
        for term in terms {
            let raw = if let Some(saved) = &saved {
                saved
                    .get(&variations::variation_term(term))
                    .ok_or_else(|| {
                        err(
                            409,
                            "Prepare broader variations for the changed words before saving",
                        )
                    })?
                    .clone()
            } else {
                generated_variation_to_bson(
                    &variations::build_variation(term, None).map_err(other)?,
                )
            };
            let original = compiler_bson_json(&raw);
            let compiled = variations::with_variation_spacing_value(&original, allow_spaces, mode)
                .map_err(other)?;
            let changed = matches!(&compiled, variations::CompiledVariationValue::Shared(_));
            let compiled = compiled.into_owned();
            let mut raw = raw
                .as_document()
                .cloned()
                .ok_or_else(|| other("invalid variation entry"))?;
            if changed {
                raw.insert("allowSpaces", allow_spaces);
                if let Some(symbol) = compiled.get("symbolVersion") {
                    raw.insert("symbolVersion", json_bson(symbol));
                } else {
                    raw.remove("symbolVersion");
                }
                let mut pattern = raw.get_document("pattern").map_err(other)?.clone();
                let source = compiled
                    .get("pattern")
                    .and_then(|p| p.get("source"))
                    .ok_or_else(|| other("missing pattern source"))?;
                pattern.insert("source", json_bson(source));
                raw.insert("pattern", pattern);
            }
            validation.push(compiled);
            result.push(Bson::Document(raw));
        }
        variations::validate_variations_value(&JsonValue::Array(validation), allow_spaces, mode)
            .map_err(other)?;
        Ok(
            doc! {"mode": if mode == VariationMode::Broad {"broad"} else {"common"}, "allowSpaces":allow_spaces, "entries":result},
        )
    }
    pub async fn request_variation_job(
        &self,
        channel: &JsString,
        terms: &[JsString],
        prior: &[Document],
    ) -> Result<Document, JobError> {
        let id = variation_job_id(channel, terms);
        let saved = self.saved_variations(channel, terms, prior).await?;
        if terms.iter().all(|t| saved.get(t).is_some()) {
            return Ok(
                doc! {"id":"", "state":"completed", "entries":terms.iter().map(|t| saved.get(t).unwrap().clone()).collect::<Vec<_>>(), "error":""},
            );
        }
        let jobs = schema::get_moderation_variation_job_model(&self.db);
        let existing = jobs
            .collection
            .find_one(doc! {"_id":&id})
            .await
            .map_err(other)?;
        if let Some(job) = &existing
            && job.get_str("state").ok() != Some("failed")
        {
            return variation_job_view(job);
        }
        let now = self.clock.now_ms();
        if existing.is_some() {
            let changed = jobs.collection.find_one_and_update(doc! {"_id":&id,"state":"failed"}, doc! {"$set":{"state":"reserved","error":"","deadline":date(now+300_000)},"$inc":{"attempts":1}}).return_document(ReturnDocument::After).await.map_err(other)?;
            if changed.is_none() {
                return variation_job_view(
                    &jobs
                        .collection
                        .find_one(doc! {"_id":&id})
                        .await
                        .map_err(other)?
                        .ok_or_else(|| other("job disappeared"))?,
                );
            }
        } else {
            let input = doc! {"_id":&id,"channelID":js(channel),"terms":words(terms),"state":"reserved","entries":Bson::Array(vec![]),"createdAt":date(self.clock.now_ms()),"deadline":date(now+300_000),"expiresAt":lifetime(self.clock.now_ms()),"model":VARIATION_MODEL,"version":VARIATION_VERSION};
            match jobs.insert(input, date(now)).await {
                Ok(_) => {}
                Err(PersistenceError::Mongo(e)) if duplicate(&e) => {
                    return variation_job_view(
                        &jobs
                            .collection
                            .find_one(doc! {"_id":&id})
                            .await
                            .map_err(other)?
                            .ok_or_else(|| other("job disappeared"))?,
                    );
                }
                Err(e) => return Err(other(e)),
            }
        }
        let missing = terms.iter().filter(|t| saved.get(t).is_none()).count();
        let (mut redis, application_telemetry) = match &self.redis {
            RedisSource::Explicit(redis) => (redis.clone(), None),
            RedisSource::Application => {
                redis_application_runtime::acquire().await.map_err(other)?
            }
        };
        let telemetry = self.telemetry.as_ref().or(application_telemetry.as_ref());
        let span = telemetry.map(|t| t.begin_span("cache", "eval", None));
        let result: redis::RedisResult<i64> = redis::Script::new(BUDGET_LUA)
            .key(format!("moderation:{}:variation-words", js(channel)))
            .key(format!("moderation:{}:variation-jobs", js(channel)))
            .arg(missing)
            .invoke_async(&mut redis)
            .await;
        if let Some(span) = span {
            span.end(if result.is_ok() { "ok" } else { "error" }, None);
        }
        let allowed = result.map_err(other)?;
        if allowed == 0 {
            jobs.collection
                .update_one(
                    doc! {"_id":&id,"state":"reserved"},
                    doc! {"$set":{"state":"failed","error":"daily_limit"}},
                )
                .await
                .map_err(other)?;
            return Err(err(
                429,
                "Daily variation-generation limit reached. Saved variations still work; try again tomorrow.",
            ));
        }
        let seeded = terms
            .iter()
            .filter_map(|t| saved.get(t).cloned())
            .collect::<Vec<_>>();
        jobs.collection
            .update_one(
                doc! {"_id":&id,"state":"reserved"},
                doc! {"$set":{"state":"pending","entries":seeded}},
            )
            .await
            .map_err(other)?;
        variation_job_view(
            &jobs
                .collection
                .find_one(doc! {"_id":&id})
                .await
                .map_err(other)?
                .ok_or_else(|| other("job disappeared"))?,
        )
    }
    /// Expires overdue jobs then atomically claims at most one oldest pending job.
    pub async fn process_next_variation_job(&self) -> Result<bool, JobError> {
        let jobs = schema::get_moderation_variation_job_model(&self.db);
        jobs.collection.update_many(doc! {"state":{"$in":["reserved","pending","processing"]},"deadline":{"$lte":date(self.clock.now_ms())}}, doc! {"$set":{"state":"failed","error":"generation_timeout"}}).await.map_err(other)?;
        let job = jobs
            .collection
            .find_one_and_update(
                doc! {"state":"pending","deadline":{"$gt":date(self.clock.now_ms())}},
                doc! {"$set":{"state":"processing"}},
            )
            .sort(doc! {"createdAt":1})
            .return_document(ReturnDocument::After)
            .await
            .map_err(other)?;
        let Some(job) = job else {
            return Ok(false);
        };
        let id = job
            .get("_id")
            .cloned()
            .ok_or_else(|| other("missing job id"))?;
        if let Err(code) = self.process_claim(&job).await {
            let code = match code.as_str() {
                "plan_required" | "generation_timeout" | "generation_unavailable" => code.as_str(),
                _ => "invalid_generation",
            };
            jobs.collection
                .update_one(
                    doc! {"_id":id,"state":"processing"},
                    doc! {"$set":{"state":"failed","error":code}},
                )
                .await
                .map_err(other)?;
        }
        Ok(true)
    }
    async fn process_claim(&self, job: &Document) -> Result<(), String> {
        let id = job.get("_id").cloned().ok_or("missing job id")?;
        let channel: JsString = job.get_str("channelID").map_err(|e| e.to_string())?.into();
        let deadline = job
            .get_datetime("deadline")
            .map_err(|e| e.to_string())?
            .timestamp_millis();
        let terms: Vec<JsString> = job
            .get_array("terms")
            .map_err(|e| e.to_string())?
            .iter()
            .map(|x| {
                x.as_str()
                    .map(JsString::from)
                    .ok_or("invalid term".to_owned())
            })
            .collect::<Result<_, _>>()?;
        let users = self
            .db
            .collection::<Document>(crate::schemas::users::schema().collection);
        let owner = users
            .find_one(doc! {"accounts":{"$elemMatch":{"type":"twitch","id":js(&channel)}}})
            .projection(doc! {"plan_tier":1})
            .await
            .map_err(|e| e.to_string())?;
        let tier = owner
            .as_ref()
            .and_then(|x| x.get_str("plan_tier").ok())
            .map(|x| JsonValue::String(x.into()));
        if !paid_moderation_owned(tier.as_ref()) {
            return Err("plan_required".into());
        }
        let mut saved = self
            .saved_variations(&channel, &terms, &[])
            .await
            .map_err(|e| e.to_string())?;
        for entry in entries(job).map_err(|e| e.to_string())? {
            saved.insert_raw(entry_key(&entry).map_err(|e| e.to_string())?, entry);
        }
        let missing = terms
            .iter()
            .filter(|t| saved.get(t).is_none())
            .cloned()
            .collect::<Vec<_>>();
        let jobs = schema::get_moderation_variation_job_model(&self.db);
        let cache = schema::get_moderation_variation_cache_model(&self.db);
        for batch in missing.chunks(20) {
            let remaining = deadline - self.clock.now_ms();
            let timeout_ms = provider_deadline_ms(remaining)
                .ok_or("generation_timeout")?
                .min(self.provider_timeout_cap);
            let (_sender, cancel) = tokio::sync::watch::channel(false);
            let generated = tokio::time::timeout(
                Duration::from_millis(timeout_ms),
                self.provider.generate(batch, &channel, cancel),
            )
            .await
            .map_err(|_| "aborted".to_owned())?
            .map_err(|e| e.to_string())?;
            let mut usage = doc! {"model": json_bson(&generated.model)};
            spread_usage(&mut usage, &generated.usage);
            jobs.collection
                .update_one(
                    doc! {"_id":id.clone()},
                    doc! {"$push":{"providerUsage":usage}},
                )
                .await
                .map_err(|e| e.to_string())?;
            if self.clock.now_ms() >= deadline {
                return Err("generation_timeout".into());
            }
            // Cast the model with the shared schema before the Mongo update;
            // $push above deliberately precedes any model casting failure.
            let raw_model = json_bson(&generated.model);
            let cast = schema::cache_schema()
                .prepare_insert(doc! {"model":raw_model}, date(self.clock.now_ms()))
                .map_err(|e| e.to_string())?;
            let model = cast.get("model").cloned().unwrap_or(Bson::Null);
            for entry in generated.entries {
                let raw = generated_variation_to_bson(&entry);
                saved.insert(entry.term.clone(), raw.clone());
                cache.collection.update_one(doc! {"_id":variations::variation_key(&channel, &entry.term)}, doc! {"$set":{"channelID":js(&channel),"entry":raw,"model":model.clone(),"expiresAt":lifetime(self.clock.now_ms())}}).upsert(true).await.map_err(|e| e.to_string())?;
            }
        }
        let completed = terms
            .iter()
            .map(|term| saved.get(term).cloned().unwrap_or(Bson::Null))
            .collect::<Vec<_>>();
        jobs.collection
            .update_one(
                doc! {"_id":id,"state":"processing","deadline":{"$gt":date(self.clock.now_ms())}},
                doc! {"$set":{"state":"completed","entries":completed,"error":""}},
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn duplicate(error: &mongodb::error::Error) -> bool {
    use mongodb::error::{ErrorKind, WriteFailure};
    matches!(error.kind.as_ref(), ErrorKind::Write(WriteFailure::WriteError(e)) if e.code == 11000)
}
fn spread_usage(target: &mut Document, usage: &JsonValue) {
    match usage {
        JsonValue::Object(fields) => {
            for (k, v) in fields {
                target.insert(js(k), json_bson(v));
            }
        }
        JsonValue::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                target.insert(i.to_string(), json_bson(v));
            }
        }
        JsonValue::String(text) => {
            for (i, unit) in text.code_units().enumerate() {
                target.insert(
                    i.to_string(),
                    JsString::from_units(vec![unit]).to_utf8_lossy(),
                );
            }
        }
        _ => {}
    }
}
