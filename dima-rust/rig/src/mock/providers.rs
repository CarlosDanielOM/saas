//! The provider table: every outside service by its real host, how its calls are compared, and
//! its default routes. Read from `mock/providers.json` (built into the binary).

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value};

use super::route::{Route, RouteFile};

const PROVIDERS_JSON: &str = include_str!("../../mock/providers.json");

/// How the calls to one provider compare between the sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallOrder {
    /// In the order the provider received them.
    Ordered,
    /// As a multiset (the reference's own order is not deterministic).
    Multiset,
    /// Recorded, not compared.
    Ignore,
}

impl CallOrder {
    pub fn parse(s: &str) -> Option<CallOrder> {
        match s {
            "ordered" => Some(CallOrder::Ordered),
            "multiset" => Some(CallOrder::Multiset),
            "ignore" => Some(CallOrder::Ignore),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvidersFile {
    rig_providers: u64,
    #[serde(default, rename = "description")]
    _description: String,
    common_headers: Vec<String>,
    providers: Vec<ProviderFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderFile {
    name: String,
    hosts: Vec<String>,
    #[serde(default)]
    about: String,
    #[serde(default)]
    compare: Option<String>,
    #[serde(default)]
    headers: Vec<String>,
    #[serde(default)]
    json_key_order: bool,
    #[serde(default)]
    response_headers: Map<String, Value>,
    #[serde(default)]
    routes: Vec<RouteFile>,
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub name: String,
    /// Host globs (`*.nyc3.digitaloceanspaces.com`), lower case.
    pub hosts: Vec<String>,
    pub about: String,
    pub order: CallOrder,
    /// Request headers compared besides the common list.
    pub headers: Vec<String>,
    /// JSON object key order in request bodies is a difference (LLM prompts), not a note.
    pub json_key_order: bool,
    pub response_headers: Vec<(String, String)>,
    pub routes: Vec<Route>,
}

#[derive(Debug, Clone)]
pub struct Providers {
    pub common_headers: Vec<String>,
    pub list: Vec<Provider>,
}

impl Providers {
    pub fn parse(text: &str) -> Result<Providers, String> {
        let f: ProvidersFile =
            serde_json::from_str(text).map_err(|e| format!("mock/providers.json: {e}"))?;
        if f.rig_providers != 1 {
            return Err("mock/providers.json: rig_providers must be 1".into());
        }
        let mut list = Vec::new();
        for p in f.providers {
            if list.iter().any(|x: &Provider| x.name == p.name) {
                return Err(format!("mock/providers.json: provider {} twice", p.name));
            }
            let order = match p.compare.as_deref() {
                None => CallOrder::Ordered,
                Some(s) => CallOrder::parse(s).ok_or_else(|| {
                    format!(
                        "mock/providers.json: {}: compare `{s}` (ordered, multiset, ignore)",
                        p.name
                    )
                })?,
            };
            let mut routes = Vec::new();
            for (i, r) in p.routes.into_iter().enumerate() {
                routes.push(Route::compile(
                    r,
                    false,
                    format!("default {} route {i}", p.name),
                )?);
            }
            let response_headers = p
                .response_headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.as_str().unwrap_or("").to_string()))
                .collect();
            list.push(Provider {
                name: p.name,
                hosts: p.hosts.iter().map(|h| h.to_ascii_lowercase()).collect(),
                about: p.about,
                order,
                headers: p.headers.iter().map(|h| h.to_ascii_lowercase()).collect(),
                json_key_order: p.json_key_order,
                response_headers,
                routes,
            });
        }
        for p in &list {
            for r in &p.routes {
                if let Some(other) = &r.provider
                    && !list.iter().any(|x| &x.name == other)
                {
                    return Err(format!(
                        "mock/providers.json: {}: route provider `{other}` is not a provider",
                        p.name
                    ));
                }
            }
        }
        Ok(Providers {
            common_headers: f
                .common_headers
                .iter()
                .map(|h| h.to_ascii_lowercase())
                .collect(),
            list,
        })
    }

    /// The table built into the binary.
    pub fn builtin() -> Result<&'static Providers, String> {
        static CELL: OnceLock<Result<Providers, String>> = OnceLock::new();
        CELL.get_or_init(|| Providers::parse(PROVIDERS_JSON))
            .as_ref()
            .map_err(Clone::clone)
    }

    /// The provider a host belongs to.
    pub fn for_host(&self, host: &str) -> Option<&Provider> {
        let h = host.to_ascii_lowercase();
        self.list
            .iter()
            .find(|p| p.hosts.iter().any(|g| crate::path::name_glob(g, &h)))
    }

    pub fn by_name(&self, name: &str) -> Option<&Provider> {
        self.list.iter().find(|p| p.name == name)
    }

    /// Every host the mock knows (for the README and `dima-rig mock`).
    pub fn hosts(&self) -> Vec<(&str, &str)> {
        self.list
            .iter()
            .flat_map(|p| p.hosts.iter().map(move |h| (h.as_str(), p.name.as_str())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_builtin_table_is_valid() {
        let p = Providers::builtin().unwrap();
        assert_eq!(p.for_host("api.twitch.tv").unwrap().name, "twitch");
        assert_eq!(p.for_host("ID.Twitch.tv").unwrap().name, "twitch-id");
        assert_eq!(
            p.for_host("rig-media.nyc3.digitaloceanspaces.com")
                .unwrap()
                .name,
            "s3"
        );
        assert_eq!(p.for_host("dima-server:3000").unwrap().name, "dimabot-api");
        assert!(p.for_host("example.com").is_none());
        assert_eq!(p.by_name("posthog").unwrap().order, CallOrder::Multiset);
        assert!(p.by_name("openrouter").unwrap().json_key_order);
        assert!(p.common_headers.contains(&"authorization".to_string()));
        // Every provider of the ledger's outbound inventory that the backend calls.
        for host in [
            "openrouter.ai",
            "api.minimax.io",
            "api.fish.audio",
            "api.polar.sh",
            "api.resend.com",
            "us.i.posthog.com",
            "nyc3.digitaloceanspaces.com",
            "piper-tts:5000",
            "lfm2.5-embeddings:8080",
            "dimadocs",
            "search.myhomelab.wtf",
            "cdn.streamelements.com",
            "api.domdimabot.com",
            "dima-analytics:3210",
            "dima-hoststats:3211",
            "localhost:3355",
            "localhost:4318",
        ] {
            assert!(p.for_host(host).is_some(), "{host} has no provider");
        }
    }
}
