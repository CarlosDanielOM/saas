//! Target files (`targets/<target>.json`): how to launch the reference and the candidate.

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};

use serde::Deserialize;

use crate::error::{Result, config};
use crate::mock::{MockFile, MockSpec};
use crate::template;

pub const TARGET_VERSION: u64 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetFile {
    rig_target: u64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    ports: Option<Vec<String>>,
    #[serde(default)]
    share_process: bool,
    /// The mock's routes and seeds for every scenario of the target.
    #[serde(default)]
    mock: Option<serde_json::Value>,
    /// Give each side a prefixing proxy to the local Qdrant (`{qdrant_port}`).
    #[serde(default)]
    qdrant: bool,
    /// Where the signed-webhook steps deliver, and with which test secret.
    #[serde(default)]
    webhooks: Option<WebhooksFile>,
    reference: SideFile,
    candidate: SideFile,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct WebhooksFile {
    #[serde(default)]
    eventsub: Option<WebhookFile>,
    #[serde(default)]
    polar: Option<WebhookFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebhookFile {
    /// The side's test secret (a template, like the side's environment).
    secret: String,
    /// The target port the webhook is sent to (default the primary port).
    #[serde(default)]
    port: Option<String>,
    path: String,
}

/// Where a kind of signed webhook goes (`eventsub` and `polar` steps).
#[derive(Debug, Clone)]
pub struct Webhook {
    pub secret: String,
    pub port: Option<String>,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SideFile {
    #[serde(default)]
    command: Vec<String>,
    /// Run the side as a container instead of a local program.
    #[serde(default)]
    container: Option<ContainerFile>,
    /// This side does not exist yet (`"The Rust API does not exist yet"`): the target is
    /// record only.
    #[serde(default)]
    unavailable: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    pass_env: Vec<String>,
    #[serde(default)]
    ready: Option<ReadyFile>,
    #[serde(default)]
    stop: Option<StopFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContainerFile {
    image: String,
    command: Vec<String>,
    /// `[host path, container path]` or `[host path, container path, "ro"]`.
    #[serde(default)]
    mounts: Vec<Vec<String>>,
    #[serde(default)]
    memory_mb: Option<u64>,
    #[serde(default)]
    cpus: Option<f64>,
    #[serde(default)]
    workdir: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyFile {
    #[serde(default)]
    http: Option<String>,
    #[serde(default)]
    tcp: Option<bool>,
    /// A regular expression the side's output must match.
    #[serde(default)]
    log: Option<String>,
    #[serde(default)]
    mongo: Option<ReadyMongoFile>,
    /// A Dragonfly key (glob) that must exist.
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    port: Option<String>,
    #[serde(default)]
    status: Option<u16>,
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyMongoFile {
    collection: String,
    #[serde(default)]
    filter: Option<serde_json::Value>,
    #[serde(default)]
    count: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StopFile {
    #[serde(default)]
    signal: Option<String>,
    #[serde(default)]
    grace_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum Probe {
    /// GET this path until it answers with the expected status (default: any 2xx).
    Http { path: String, status: Option<u16> },
    /// Until the port accepts a TCP connection.
    Tcp,
    /// Until the side's output (its log) matches.
    Log(regex::Regex),
    /// Until at least `count` documents match in the side's database.
    Mongo {
        collection: String,
        filter: serde_json::Value,
        count: u64,
    },
    /// Until a Dragonfly key matching the glob exists in the side's logical database.
    Key(String),
}

/// A side that runs in a container (`docker run --rm --network host`).
#[derive(Debug, Clone)]
pub struct Container {
    pub image: String,
    pub command: Vec<String>,
    /// (host path, container path, read-only); templates.
    pub mounts: Vec<(String, String, bool)>,
    pub memory_mb: u64,
    pub cpus: f64,
    pub workdir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Ready {
    pub probe: Probe,
    pub port: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopSignal {
    Term,
    Int,
    Quit,
    Hup,
}

#[derive(Debug, Clone)]
pub struct SideSpec {
    /// `Some(reason)`: the side does not exist yet; the target is record only.
    pub unavailable: Option<String>,
    /// Exactly one of `command` (non-empty) and `container`.
    pub container: Option<Container>,
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub pass_env: Vec<String>,
    pub ready: Ready,
    pub stop_signal: StopSignal,
    pub grace_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    pub file: PathBuf,
    pub description: String,
    pub ports: Vec<String>,
    /// Opt-in: the scenarios of a run share one process per side (stores reset between them).
    /// Faster, but in-memory state of the process (caches, counters, timers, open
    /// subscriptions) carries from one scenario into the next, so a scenario's result can
    /// depend on which scenarios ran before it. Default: one process per scenario.
    pub share_process: bool,
    pub mock: MockSpec,
    /// The target's `mock` section as written (its values are known inputs).
    pub mock_json: serde_json::Value,
    pub qdrant: bool,
    pub eventsub: Option<Webhook>,
    pub polar: Option<Webhook>,
    pub reference: SideSpec,
    pub candidate: SideSpec,
}

/// Placeholders every side gets; `port.<name>` and `var.<name>` are added per target / run.
pub const PLACEHOLDERS: &[&str] = &[
    "port",
    "mongo_uri",
    "mongo_root_uri",
    "mongo_db",
    "dragonfly_host",
    "dragonfly_port",
    "dragonfly_db",
    "dragonfly_url",
    "side",
    "repo",
    "rig_dir",
    "cargo_target_dir",
    "mongo_hostport",
    "mock_url",
    "mock_port",
    "qdrant_port",
    "qdrant_api_key",
];

fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn check_template(tpl: &str, ports: &[String], where_: &str) -> Result<()> {
    let names = template::placeholders(tpl).map_err(|e| config(format!("{where_}: {e}")))?;
    for n in names {
        let ok = PLACEHOLDERS.contains(&n.as_str())
            || n.strip_prefix("port.")
                .is_some_and(|p| ports.iter().any(|x| x == p))
            || n.strip_prefix("var.").is_some_and(valid_name);
        if !ok {
            return Err(config(format!(
                "{where_}: unknown placeholder {{{n}}}; known: {}, port.<name> for {}, var.<name> (set with --set name=value)",
                PLACEHOLDERS.join(", "),
                ports.join("/")
            )));
        }
    }
    Ok(())
}

fn side(f: SideFile, ports: &[String], where_: &str) -> Result<SideSpec> {
    if let Some(reason) = f.unavailable {
        if !f.command.is_empty() || f.container.is_some() || f.ready.is_some() {
            return Err(config(format!(
                "{where_}: an unavailable side has only \"unavailable\": \"<why>\""
            )));
        }
        if reason.trim().chars().count() < 8 {
            return Err(config(format!(
                "{where_}.unavailable: say why the side does not exist yet"
            )));
        }
        return Ok(SideSpec {
            unavailable: Some(reason),
            container: None,
            command: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            pass_env: Vec::new(),
            ready: Ready {
                probe: Probe::Tcp,
                port: ports.first().cloned().unwrap_or_default(),
                timeout_ms: 1,
            },
            stop_signal: StopSignal::Term,
            grace_ms: 0,
        });
    }
    let container = match f.container {
        Some(c) if f.command.is_empty() => {
            if c.image.is_empty() || c.command.is_empty() {
                return Err(config(format!(
                    "{where_}.container: needs an image and a command"
                )));
            }
            check_template(&c.image, ports, &format!("{where_}.container.image"))?;
            for (i, x) in c.command.iter().enumerate() {
                check_template(x, ports, &format!("{where_}.container.command[{i}]"))?;
            }
            let mut mounts = Vec::new();
            for (i, m) in c.mounts.iter().enumerate() {
                let here = format!("{where_}.container.mounts[{i}]");
                let (from, to, ro) = match m.as_slice() {
                    [a, b] => (a.clone(), b.clone(), false),
                    [a, b, mode] if mode == "ro" => (a.clone(), b.clone(), true),
                    _ => {
                        return Err(config(format!(
                            "{here}: [host path, container path] or [host path, container path, \"ro\"]"
                        )));
                    }
                };
                check_template(&from, ports, &here)?;
                check_template(&to, ports, &here)?;
                mounts.push((from, to, ro));
            }
            Some(Container {
                image: c.image,
                command: c.command,
                mounts,
                memory_mb: c.memory_mb.unwrap_or(1024).clamp(64, 8192),
                cpus: c.cpus.unwrap_or(2.0).clamp(0.1, 8.0),
                workdir: c.workdir,
            })
        }
        Some(_) => {
            return Err(config(format!(
                "{where_}: exactly one of command and container"
            )));
        }
        None => {
            if f.command.is_empty() {
                return Err(config(format!(
                    "{where_}.command: needs at least the program (or a container)"
                )));
            }
            None
        }
    };
    for (i, c) in f.command.iter().enumerate() {
        check_template(c, ports, &format!("{where_}.command[{i}]"))?;
    }
    let Some(ready) = f.ready else {
        return Err(config(format!("{where_}.ready: required")));
    };
    if let Some(cwd) = &f.cwd {
        check_template(cwd, ports, &format!("{where_}.cwd"))?;
    }
    for (k, v) in &f.env {
        if k.is_empty() || k.contains('=') || k.contains('\0') {
            return Err(config(format!("{where_}.env: bad variable name `{k}`")));
        }
        check_template(v, ports, &format!("{where_}.env.{k}"))?;
    }
    for k in &f.pass_env {
        if k.is_empty() || k.contains('=') {
            return Err(config(format!(
                "{where_}.pass_env: bad variable name `{k}`"
            )));
        }
        if f.env.contains_key(k) {
            return Err(config(format!(
                "{where_}.pass_env: `{k}` is also set in env; keep one"
            )));
        }
    }
    let given = [
        ready.http.is_some(),
        ready.tcp == Some(true),
        ready.log.is_some(),
        ready.mongo.is_some(),
        ready.key.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    if given != 1 {
        return Err(config(format!(
            "{where_}.ready: needs exactly one of \"http\": \"/path\", \"tcp\": true, \"log\": \"<regex>\", \"mongo\": {{...}} or \"key\": \"<glob>\""
        )));
    }
    if ready.status.is_some() && ready.http.is_none() {
        return Err(config(format!(
            "{where_}.ready.status: only with an http probe"
        )));
    }
    let probe = if let Some(path) = ready.http {
        if !path.starts_with('/') {
            return Err(config(format!(
                "{where_}.ready.http: a path starting with /, such as /health"
            )));
        }
        Probe::Http {
            path,
            status: ready.status,
        }
    } else if let Some(re) = ready.log {
        Probe::Log(regex::Regex::new(&re).map_err(|e| config(format!("{where_}.ready.log: {e}")))?)
    } else if let Some(m) = ready.mongo {
        Probe::Mongo {
            collection: m.collection,
            filter: m
                .filter
                .unwrap_or_else(|| serde_json::Value::Object(Default::default())),
            count: m.count.unwrap_or(1),
        }
    } else if let Some(k) = ready.key {
        Probe::Key(k)
    } else {
        Probe::Tcp
    };
    let port = ready
        .port
        .unwrap_or_else(|| ports.first().cloned().unwrap_or_default());
    if !ports.contains(&port) {
        return Err(config(format!(
            "{where_}.ready.port: `{port}` is not one of the target's ports ({})",
            ports.join(", ")
        )));
    }
    if ready.timeout_ms == 0 || ready.timeout_ms > 600_000 {
        return Err(config(format!(
            "{where_}.ready.timeout_ms: between 1 and 600000"
        )));
    }
    let stop = f.stop.unwrap_or(StopFile {
        signal: None,
        grace_ms: None,
    });
    let stop_signal = match stop.signal.as_deref().unwrap_or("SIGTERM") {
        "SIGTERM" => StopSignal::Term,
        "SIGINT" => StopSignal::Int,
        "SIGQUIT" => StopSignal::Quit,
        "SIGHUP" => StopSignal::Hup,
        other => {
            return Err(config(format!(
                "{where_}.stop.signal: `{other}` (use SIGTERM, SIGINT, SIGQUIT or SIGHUP)"
            )));
        }
    };
    let grace_ms = stop.grace_ms.unwrap_or(5000);
    if grace_ms > 120_000 {
        return Err(config(format!("{where_}.stop.grace_ms: at most 120000")));
    }
    Ok(SideSpec {
        unavailable: None,
        container,
        command: f.command,
        cwd: f.cwd,
        env: f.env,
        pass_env: f.pass_env,
        ready: Ready {
            probe,
            port,
            timeout_ms: ready.timeout_ms,
        },
        stop_signal,
        grace_ms,
    })
}

/// Read and check `<rig_dir>/targets/<name>.json`.
pub fn load(rig_dir: &FsPath, name: &str) -> Result<Target> {
    if !valid_name(name) {
        return Err(config(format!(
            "bad target name `{name}` (letters, digits, - and _)"
        )));
    }
    let file = rig_dir.join("targets").join(format!("{name}.json"));
    let text =
        std::fs::read_to_string(&file).map_err(|e| config(format!("{}: {e}", file.display())))?;
    let f: TargetFile =
        serde_json::from_str(&text).map_err(|e| config(format!("{}: {e}", file.display())))?;
    let at = file.display().to_string();
    if f.rig_target != TARGET_VERSION {
        return Err(config(format!(
            "{at}: rig_target {} is not supported; this rig reads version {TARGET_VERSION}",
            f.rig_target
        )));
    }
    let ports = f.ports.unwrap_or_else(|| vec!["http".to_string()]);
    if ports.is_empty() {
        return Err(config(format!("{at}: ports: at least one port name")));
    }
    for (i, p) in ports.iter().enumerate() {
        if !valid_name(p) || ports.iter().skip(i + 1).any(|q| q == p) {
            return Err(config(format!("{at}: ports: bad or repeated name `{p}`")));
        }
    }
    let reference = side(f.reference, &ports, &format!("{at}: reference"))?;
    if reference.unavailable.is_some() {
        return Err(config(format!(
            "{at}: reference: the reference always exists (only the candidate can be unavailable)"
        )));
    }
    let candidate = side(f.candidate, &ports, &format!("{at}: candidate"))?;
    let webhook = |w: Option<WebhookFile>, kind: &str| -> Result<Option<Webhook>> {
        let Some(w) = w else { return Ok(None) };
        check_template(&w.secret, &ports, &format!("{at}: webhooks.{kind}.secret"))?;
        if !w.path.starts_with('/') {
            return Err(config(format!("{at}: webhooks.{kind}.path: starts with /")));
        }
        if let Some(p) = &w.port
            && !ports.contains(p)
        {
            return Err(config(format!(
                "{at}: webhooks.{kind}.port: `{p}` is not one of the target's ports"
            )));
        }
        Ok(Some(Webhook {
            secret: w.secret,
            port: w.port,
            path: w.path,
        }))
    };
    let hooks = f.webhooks.unwrap_or_default();
    let eventsub = webhook(hooks.eventsub, "eventsub")?;
    let polar = webhook(hooks.polar, "polar")?;
    let mock_json = f.mock.unwrap_or(serde_json::Value::Null);
    let mock = if mock_json.is_null() {
        MockSpec::default()
    } else {
        let mf: MockFile = serde_json::from_value(mock_json.clone())
            .map_err(|e| config(format!("{at}: mock: {e}")))?;
        MockSpec::from_file(mf, &format!("{at}: target")).map_err(config)?
    };
    Ok(Target {
        name: name.to_string(),
        file,
        description: f.description,
        ports,
        share_process: f.share_process,
        mock,
        mock_json,
        qdrant: f.qdrant,
        eventsub,
        polar,
        reference,
        candidate,
    })
}
