//! The request list of `dima-rig diff-get`: GET paths compared over a real database.
//!
//! ```json
//! {
//!   "rig_get_list": 1,
//!   "description": "Public read endpoints over the local production copy",
//!   "headers": { "accept": "application/json" },
//!   "requests": ["/api/health", { "path": "/api/streamers/foo", "headers": { "x-test": "1" } }],
//!   "compare": { "headers": { "add": ["etag"] } },
//!   "allow": [{ "path": "steps[*].body.uptime", "kind": "ignore", "reason": "Process uptime differs between runs." }]
//! }
//! ```

use std::path::Path as FsPath;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::allow::{AllowKind, Allowances};
use crate::error::{Result, config};
use crate::path::Pattern;
use crate::scenario::{AllowFile, CompareFile, HttpStep, ReqBody, Step, StepKind};

pub const GET_LIST_VERSION: u64 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetListFile {
    rig_get_list: u64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default)]
    port: Option<String>,
    requests: Vec<Value>,
    #[serde(default)]
    compare: Option<CompareFile>,
    #[serde(default)]
    allow: Vec<AllowFile>,
    #[serde(default)]
    tolerance_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestFile {
    path: String,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default)]
    name: Option<String>,
}

pub struct GetList {
    pub description: String,
    pub steps: Vec<Step>,
    pub headers: Vec<String>,
    pub allow: Vec<(Pattern, AllowKind, String)>,
    pub tolerance_ms: i64,
}

impl GetList {
    pub fn allowances(&self) -> Allowances {
        Allowances::new(self.allow.clone())
    }
}

fn header_pairs(m: &Map<String, Value>, at: &str) -> Result<Vec<(String, String)>> {
    m.iter()
        .map(|(k, v)| match v {
            Value::String(s) => Ok((k.to_ascii_lowercase(), s.clone())),
            _ => Err(config(format!("{at}.{k}: header values are strings"))),
        })
        .collect()
}

pub fn load(file: &FsPath) -> Result<GetList> {
    let at = file.display().to_string();
    let text = std::fs::read_to_string(file).map_err(|e| config(format!("{at}: {e}")))?;
    let f: GetListFile = serde_json::from_str(&text).map_err(|e| config(format!("{at}: {e}")))?;
    if f.rig_get_list != GET_LIST_VERSION {
        return Err(config(format!("{at}: rig_get_list {} is not supported; this rig reads version {GET_LIST_VERSION}", f.rig_get_list)));
    }
    let common = header_pairs(&f.headers, &format!("{at}: headers"))?;
    let mut steps = Vec::new();
    for (i, r) in f.requests.iter().enumerate() {
        let here = format!("{at}: requests[{i}]");
        let req: RequestFile = match r {
            Value::String(p) => RequestFile { path: p.clone(), headers: Map::new(), name: None },
            other => RequestFile::deserialize(other).map_err(|e| config(format!("{here}: {e}")))?,
        };
        if !req.path.starts_with('/') {
            return Err(config(format!("{here}: paths start with /")));
        }
        let mut headers = common.clone();
        for (k, v) in header_pairs(&req.headers, &format!("{here}.headers"))? {
            headers.retain(|(n, _)| *n != k);
            headers.push((k, v));
        }
        steps.push(Step {
            name: req.name,
            kind: StepKind::Http(HttpStep {
                method: "GET".into(),
                path: req.path,
                port: f.port.clone(),
                headers,
                body: ReqBody::None,
                timeout_ms: 30_000,
                expect_status: None,
                save: Vec::new(),
            }),
        });
    }
    if steps.is_empty() {
        return Err(config(format!("{at}: requests: at least one path")));
    }
    let compare = f.compare.unwrap_or_default();
    Ok(GetList {
        description: f.description,
        steps,
        headers: crate::scenario::headers(compare.headers, &format!("{at}: compare.headers"))?,
        allow: crate::scenario::allowances(f.allow, &at)?,
        tolerance_ms: i64::try_from(f.tolerance_ms.unwrap_or(2000)).map_err(|_| config(format!("{at}: tolerance_ms too large")))?,
    })
}
