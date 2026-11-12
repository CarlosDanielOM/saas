//! Target files (`targets/<target>.json`): how to launch the reference and the candidate.

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};

use serde::Deserialize;

use crate::error::{Result, config};
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
    reference: SideFile,
    candidate: SideFile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SideFile {
    command: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    pass_env: Vec<String>,
    ready: ReadyFile,
    #[serde(default)]
    stop: Option<StopFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyFile {
    #[serde(default)]
    http: Option<String>,
    #[serde(default)]
    tcp: Option<bool>,
    #[serde(default)]
    port: Option<String>,
    #[serde(default)]
    status: Option<u16>,
    timeout_ms: u64,
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
    if f.command.is_empty() {
        return Err(config(format!(
            "{where_}.command: needs at least the program"
        )));
    }
    for (i, c) in f.command.iter().enumerate() {
        check_template(c, ports, &format!("{where_}.command[{i}]"))?;
    }
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
    let probe = match (f.ready.http, f.ready.tcp) {
        (Some(path), None | Some(false)) => {
            if !path.starts_with('/') {
                return Err(config(format!(
                    "{where_}.ready.http: a path starting with /, such as /health"
                )));
            }
            Probe::Http {
                path,
                status: f.ready.status,
            }
        }
        (None, Some(true)) => {
            if f.ready.status.is_some() {
                return Err(config(format!(
                    "{where_}.ready.status: only with an http probe"
                )));
            }
            Probe::Tcp
        }
        _ => {
            return Err(config(format!(
                "{where_}.ready: needs exactly one of \"http\": \"/path\" or \"tcp\": true"
            )));
        }
    };
    let port = f
        .ready
        .port
        .unwrap_or_else(|| ports.first().cloned().unwrap_or_default());
    if !ports.contains(&port) {
        return Err(config(format!(
            "{where_}.ready.port: `{port}` is not one of the target's ports ({})",
            ports.join(", ")
        )));
    }
    if f.ready.timeout_ms == 0 || f.ready.timeout_ms > 600_000 {
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
        command: f.command,
        cwd: f.cwd,
        env: f.env,
        pass_env: f.pass_env,
        ready: Ready {
            probe,
            port,
            timeout_ms: f.ready.timeout_ms,
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
    let candidate = side(f.candidate, &ports, &format!("{at}: candidate"))?;
    Ok(Target {
        name: name.to_string(),
        file,
        description: f.description,
        ports,
        share_process: f.share_process,
        reference,
        candidate,
    })
}
