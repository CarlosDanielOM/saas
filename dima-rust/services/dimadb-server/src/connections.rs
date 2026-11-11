//! The connection registry (`connections.mjs`): environment rows first, then the local rows of
//! `connections.json`, whose passwords are stored encrypted and shown masked as `***`.
//!
//! URLs are parsed as WHATWG URLs (`new URL`), which the `url` crate implements.

use serde_json::{Map, Value, json};

use crate::config::{Engine, EnvConnection};
use crate::error::{ApiError, ApiResult};
use crate::js;
use crate::store::{List, Store};

/// One connection as the hubs need it.
#[derive(Clone, PartialEq, Eq)]
pub struct Row {
    /// The id.
    pub id: String,
    /// The engine (`row.engine === 'mongo' ? 'mongo' : 'redis'`).
    pub engine: Engine,
    /// The stored row (`env` rows are synthesised).
    raw: Value,
    env_url: Option<String>,
}

impl std::fmt::Debug for Row {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Row")
            .field("id", &self.id)
            .field("engine", &self.engine)
            .finish_non_exhaustive()
    }
}

/// `new URL(text)`.
fn parse_url(text: &str) -> Option<url::Url> {
    url::Url::parse(text).ok()
}

/// `parsed.toString()`.
fn url_text(url: &url::Url) -> String {
    url.as_str().to_owned()
}

/// `maskUrl(url)`: the password shown as `***`; text that is not a URL is returned as is.
fn mask_url(url: &Value) -> Value {
    let text = dima_text::string_of(url);
    let Some(mut parsed) = parse_url(&text) else {
        return url.clone();
    };
    if parsed.password().is_some_and(|p| !p.is_empty()) {
        // `set_password` fails only for URLs that cannot carry credentials, which have none.
        let _ = parsed.set_password(Some("***"));
    }
    Value::String(url_text(&parsed))
}

/// `injectPassword(url, password)`; `new URL` throws `TypeError: Invalid URL` (a 500).
fn inject_password(url: &Value, password: &str) -> ApiResult<String> {
    let mut parsed =
        parse_url(&dima_text::string_of(url)).ok_or_else(|| ApiError::internal("Invalid URL"))?;
    // The WHATWG setter ignores URLs that cannot have credentials; so does this.
    let _ = parsed.set_password(if password.is_empty() {
        None
    } else {
        Some(password)
    });
    Ok(url_text(&parsed))
}

/// The registry, over the environment rows and the store.
#[derive(Debug)]
pub struct Registry<'a> {
    env: &'a [EnvConnection],
    store: &'a Store,
    clock: &'a dyn dima_core::Clock,
}

impl<'a> Registry<'a> {
    /// The registry.
    pub fn new(
        env: &'a [EnvConnection],
        store: &'a Store,
        clock: &'a dyn dima_core::Clock,
    ) -> Self {
        Self { env, store, clock }
    }

    async fn all(&self) -> Vec<Row> {
        let mut rows: Vec<Row> = self
            .env
            .iter()
            .map(|row| Row {
                id: row.id.clone(),
                engine: row.engine,
                raw: json!({
                    "id": row.id,
                    "name": row.name,
                    "engine": row.engine.as_str(),
                    "source": "env",
                }),
                env_url: Some(row.url.clone()),
            })
            .collect();
        for raw in self.store.read(List::Connections).await {
            let engine = if raw.get("engine").and_then(Value::as_str) == Some("mongo") {
                Engine::Mongo
            } else {
                Engine::Redis
            };
            rows.push(Row {
                // `row.id === id` only ever matches a string id.
                id: raw
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_default(),
                engine,
                raw,
                env_url: None,
            });
        }
        rows
    }

    /// `resolveUrl(row)`: the URL with the decrypted password put back.
    pub fn resolve_url(&self, row: &Row) -> ApiResult<Value> {
        if let Some(url) = &row.env_url {
            return Ok(Value::String(url.clone()));
        }
        let url = row.raw.get("url").cloned().unwrap_or(Value::Null);
        match row.raw.get("passwordEnc") {
            Some(enc) if js::truthy(Some(enc)) => {
                let password = self.store.decrypt(&dima_text::string_of(enc))?;
                Ok(Value::String(inject_password(&url, &password)?))
            }
            _ => Ok(url),
        }
    }

    /// `resolveUrl(row)` as the text a client library is given.
    pub fn resolve_url_text(&self, row: &Row) -> ApiResult<String> {
        Ok(dima_text::string_of(&self.resolve_url(row)?))
    }

    fn public(&self, row: &Row) -> ApiResult<Value> {
        let mut out = Map::new();
        let mut put = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                out.insert(name.to_owned(), value);
            }
        };
        let source = if row.env_url.is_some() {
            "env"
        } else {
            "local"
        };
        put("id", row.raw.get("id").cloned());
        put("name", row.raw.get("name").cloned());
        let url = self.resolve_url(row)?;
        // `maskUrl(undefined)` returns `undefined`, which JSON.stringify drops.
        if row.env_url.is_some()
            || row.raw.get("url").is_some()
            || js::truthy(row.raw.get("passwordEnc"))
        {
            put("url", Some(mask_url(&url)));
        }
        put("source", Some(Value::from(source)));
        put("engine", Some(Value::from(row.engine.as_str())));
        Ok(Value::Object(out))
    }

    /// `list()`.
    pub async fn list(&self) -> ApiResult<Vec<Value>> {
        let rows = self.all().await;
        rows.iter().map(|row| self.public(row)).collect()
    }

    /// `get(id)`.
    pub async fn get(&self, id: &str) -> Option<Row> {
        self.all().await.into_iter().find(|row| {
            if row.env_url.is_some() {
                row.id == id
            } else {
                row.raw.get("id").and_then(Value::as_str) == Some(id)
            }
        })
    }

    /// `require(id, engine)`.
    pub async fn require(&self, id: &str, engine: Option<Engine>) -> ApiResult<Row> {
        let row = self
            .get(id)
            .await
            .ok_or_else(|| ApiError::not_found("Connection not found"))?;
        if let Some(engine) = engine
            && row.engine != engine
        {
            return Err(ApiError::conflict(format!(
                "Not a {} connection",
                engine.as_str()
            )));
        }
        Ok(row)
    }

    /// `add({name, url, engine})`.
    pub async fn add(&self, body: &Value) -> ApiResult<Value> {
        let name = body.get("name");
        let mut parsed = parse_url(&js::string(body.get("url")))
            .ok_or_else(|| ApiError::bad_request("Invalid URL"))?;
        let detected = engine_from_protocol(parsed.scheme(), body.get("engine"))?;
        let password = parsed.password().unwrap_or_default().to_owned();
        let _ = parsed.set_password(None);
        let hostname = parsed.host_str().unwrap_or_default().to_owned();
        let shown_name = if js::truthy(name) {
            js::string(name)
        } else if !hostname.is_empty() {
            hostname
        } else {
            detected.as_str().to_owned()
        };
        let id = self
            .store
            .random()
            .uuid_v4()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let password_enc = if password.is_empty() {
            String::new()
        } else {
            self.store.encrypt(&password)?
        };
        let created_at = dima_text::to_iso_string(self.clock.now_ms())
            .ok_or_else(|| ApiError::internal("Invalid time value"))?;
        let row = json!({
            "id": id,
            "name": dima_text::trim(&shown_name),
            "url": url_text(&parsed),
            "engine": detected.as_str(),
            "passwordEnc": password_enc,
            "createdAt": created_at,
        });
        {
            let _guard = self.store.lock().await;
            let mut rows = self.store.read(List::Connections).await;
            rows.push(row.clone());
            self.store.write(List::Connections, &rows).await?;
        }
        self.public(&Row {
            id,
            engine: detected,
            raw: row,
            env_url: None,
        })
    }

    /// `remove(id)`: local rows only.
    pub async fn remove(&self, id: &str) -> ApiResult<()> {
        let _guard = self.store.lock().await;
        let rows = self.store.read(List::Connections).await;
        let matches = |row: &Value| row.get("id").and_then(Value::as_str) == Some(id);
        if !rows.iter().any(matches) {
            return Err(ApiError::not_found("Local connection not found"));
        }
        let kept: Vec<Value> = rows.into_iter().filter(|row| !matches(row)).collect();
        self.store.write(List::Connections, &kept).await
    }
}

/// `engineFromProtocol(protocol, requested)`.
fn engine_from_protocol(scheme: &str, requested: Option<&Value>) -> ApiResult<Engine> {
    let from_url = match scheme {
        "mongodb" | "mongodb+srv" => Engine::Mongo,
        "redis" | "rediss" => Engine::Redis,
        _ => {
            return Err(ApiError::bad_request(
                "URL must start with redis://, rediss://, mongodb://, or mongodb+srv://",
            ));
        }
    };
    if js::truthy(requested) && requested.and_then(Value::as_str) != Some(from_url.as_str()) {
        return Err(ApiError::bad_request(format!(
            "URL does not match {}",
            js::string(requested)
        )));
    }
    Ok(from_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_mask_and_inject_like_whatwg() -> Result<(), ApiError> {
        assert_eq!(
            mask_url(&json!("redis://:s3cr%40t@host:6379/2")),
            json!("redis://:***@host:6379/2")
        );
        assert_eq!(
            mask_url(&json!("mongodb://user:pw@h1:27017,h2/db?authSource=admin")),
            json!("mongodb://user:pw@h1:27017,h2/db?authSource=admin"),
            "a multi-host string is not a WHATWG URL and is shown as is"
        );
        assert_eq!(mask_url(&json!("not a url")), json!("not a url"));
        assert_eq!(mask_url(&json!("redis://host")), json!("redis://host"));
        assert_eq!(
            inject_password(&json!("redis://user@host:1/0"), "p@ss")?,
            "redis://user:p%40ss@host:1/0"
        );
        assert_eq!(
            inject_password(&json!("redis://host:1"), "p%40ss")?,
            "redis://:p%40ss@host:1"
        );
        assert!(inject_password(&json!("nope"), "x").is_err());
        Ok(())
    }

    #[test]
    fn protocols() {
        assert_eq!(
            engine_from_protocol("rediss", None).ok(),
            Some(Engine::Redis)
        );
        assert_eq!(
            engine_from_protocol("mongodb+srv", Some(&json!(""))).ok(),
            Some(Engine::Mongo)
        );
        assert_eq!(
            engine_from_protocol("redis", Some(&json!("mongo")))
                .err()
                .map(|e| e.message),
            Some("URL does not match mongo".to_owned())
        );
        assert_eq!(
            engine_from_protocol("redis", Some(&json!(1)))
                .err()
                .map(|e| e.message),
            Some("URL does not match 1".to_owned())
        );
        assert_eq!(
            engine_from_protocol("http", None).err().map(|e| e.status),
            Some(400)
        );
    }
}
