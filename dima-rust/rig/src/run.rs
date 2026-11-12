//! The commands: `record`, `verify`, `compare`, `diff-get`, `check`.
//!
//! Sides never run at the same time: every scenario runs on the reference first, then every
//! scenario on the candidate (pub/sub channels are global in Dragonfly). Each scenario gets its
//! own process, started after the stores were emptied and seeded, so nothing an earlier scenario
//! left in memory can change a later one. A target may opt in to `share_process`: then the
//! scenarios share one process per side, the stores go back to the snapshot taken right after it
//! started, the next seed is written, and `restart: true` gives one scenario its own process.

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

use crate::allow::Allowances;
use crate::canon;
use crate::capture::{
    self, Capture, CaptureFile, Hashes, Provenance, RawCapture, RunMeta, StepCap,
};
use crate::compare;
use crate::detect::{self, DetectCtx, Known, Patterns, Window};
use crate::error::{Result, config};
use crate::getlist;
use crate::mock::{Mock, MockSpec, qdrant};
use crate::report::{Report, ScenarioReport, SideFailure, Status};
use crate::scenario::{self, Scenario, Selection};
use crate::side::{self, LaunchSpec, SideProcess};
use crate::steps::Runner;
use crate::stores::{self, Baseline, Registry, SideStores, StoreConfig};
use crate::target::{self, SideSpec, Target};
use crate::template;
use crate::timefmt;

/// Everything a command needs, read once at startup.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Holds `targets/`, `scenarios/` (and by default `captures/`, `out/`).
    pub rig_dir: PathBuf,
    /// The repository root: relative `cwd` in targets starts here.
    pub repo_dir: PathBuf,
    pub captures_dir: PathBuf,
    pub out_dir: PathBuf,
    pub stores: StoreConfig,
    /// `--set name=value`: `{var.name}` in targets.
    pub vars: BTreeMap<String, String>,
    /// Keep side databases after the run.
    pub keep: bool,
    /// The rig's own environment (only `pass_env` names and PATH lookup read it).
    pub env: BTreeMap<String, String>,
    pub cargo_target_dir: String,
    /// Dragonfly key globs whose values compare as exact text (`byte_sensitive.json`).
    pub byte_sensitive: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Reference,
    Candidate,
}

impl Which {
    pub fn name(self) -> &'static str {
        match self {
            Which::Reference => "reference",
            Which::Candidate => "candidate",
        }
    }
}

/// What one side did in one scenario, before normalisation: what a capture file stores.
#[derive(Debug, Clone)]
pub struct RawRun {
    pub raw: RawCapture,
    pub run: RunMeta,
}

type SideOutcome = std::result::Result<RawRun, SideFailure>;

fn rig_failure(side: &str, message: impl Into<String>) -> SideFailure {
    SideFailure {
        side: side.into(),
        step: None,
        message: message.into(),
        log: None,
        log_tail: Vec::new(),
    }
}

fn run_id() -> String {
    let iso = timefmt::format_iso_ms(timefmt::now_ms()).unwrap_or_default();
    let compact: String = iso
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == 'T')
        .take(15)
        .collect();
    format!("{compact}-{}", std::process::id())
}

struct SideRunner<'s> {
    settings: &'s Settings,
    target: &'s Target,
    which: Which,
    label: String,
    stores: SideStores,
    proc: Option<SideProcess>,
    baseline: Option<Baseline>,
    launches: u32,
    /// Log file of the latest process (kept after it stopped, for failure reports).
    last_log: Option<PathBuf>,
    http: reqwest::Client,
    run_id: String,
    /// The side's mock of the outside world (and Qdrant proxy).
    mock: Mock,
    qdrant: Option<qdrant::Upstream>,
    reg: Registry,
    /// The target's webhooks with this side's rendered secrets.
    hooks: crate::steps::Hooks,
    /// `${mongo_db}`, `${port.http}` ... for step strings.
    side_values: BTreeMap<String, String>,
}

impl<'s> SideRunner<'s> {
    async fn new(
        settings: &'s Settings,
        reg: &Registry,
        target: &'s Target,
        which: Which,
        label: &str,
        existing: Option<&Existing>,
    ) -> Result<SideRunner<'s>> {
        let mut stores = SideStores::allocate(
            &settings.stores,
            reg,
            label,
            existing.map(|e| e.db.as_str()),
        )
        .await?;
        stores.side_uri = existing.and_then(|e| e.side_uri.clone());
        let qdrant = if target.qdrant {
            let q = crate::config::qdrant_store(&settings.env)?;
            let up = qdrant::Upstream {
                url: q.url,
                api_key: q.api_key,
                prefix: format!("{}__", stores.db_name),
            };
            reg.add_qdrant(&up);
            Some(up)
        } else {
            None
        };
        let mock = Mock::start(qdrant.clone())
            .await
            .map_err(|e| config(format!("the mock of the outside world did not start: {e}")))?;
        let http = reqwest::Client::builder()
            .no_proxy()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|e| config(format!("HTTP client: {e}")))?;
        Ok(SideRunner {
            settings,
            target,
            which,
            label: label.into(),
            stores,
            proc: None,
            baseline: None,
            launches: 0,
            last_log: None,
            http,
            run_id: run_id(),
            mock,
            qdrant,
            reg: reg.clone(),
            hooks: crate::steps::Hooks::default(),
            side_values: BTreeMap::new(),
        })
    }

    fn spec(&self) -> &'s SideSpec {
        match self.which {
            Which::Reference => &self.target.reference,
            Which::Candidate => &self.target.candidate,
        }
    }

    fn fail(&self, msg: impl Into<String>) -> SideFailure {
        rig_failure(self.which.name(), msg)
    }

    /// A failure with the tail of the latest process log.
    fn fail_with_log(&self, msg: impl Into<String>) -> SideFailure {
        let log = self.last_log.as_ref();
        SideFailure {
            log: log.map(|l| l.display().to_string()),
            log_tail: log.map(|l| side::log_tail(l)).unwrap_or_default(),
            ..self.fail(msg)
        }
    }

    /// Start the side's process. The mock is reset to `mock` first, so it records the
    /// process's start-up calls.
    async fn launch(&mut self, mock: &MockSpec) -> std::result::Result<(), SideFailure> {
        let spec = self.spec();
        let s = self.settings;
        self.launches += 1;
        let mut ports = BTreeMap::new();
        for name in &self.target.ports {
            let p = side::free_port().map_err(|e| self.fail(format!("no free port: {e}")))?;
            ports.insert(name.clone(), p);
        }
        self.mock.reset(mock, &ports);
        let mut vars: BTreeMap<String, String> = BTreeMap::new();
        if let Some(first) = self.target.ports.first().and_then(|n| ports.get(n)) {
            vars.insert("port".into(), first.to_string());
        }
        for (n, p) in &ports {
            vars.insert(format!("port.{n}"), p.to_string());
        }
        vars.insert("mongo_uri".into(), self.stores.mongo_uri());
        vars.insert("mongo_root_uri".into(), s.stores.mongo_uri.clone());
        vars.insert("mongo_db".into(), self.stores.db_name.clone());
        vars.insert("dragonfly_host".into(), s.stores.dragonfly_host.clone());
        vars.insert("dragonfly_port".into(), s.stores.dragonfly_port.to_string());
        vars.insert("dragonfly_db".into(), self.stores.df_index.to_string());
        vars.insert("dragonfly_url".into(), self.stores.dragonfly_url());
        vars.insert("side".into(), self.which.name().into());
        vars.insert("repo".into(), s.repo_dir.display().to_string());
        vars.insert("rig_dir".into(), s.rig_dir.display().to_string());
        vars.insert("cargo_target_dir".into(), s.cargo_target_dir.clone());
        vars.insert("mongo_hostport".into(), mongo_hostport(&s.stores.mongo_uri));
        vars.insert("mock_url".into(), self.mock.url());
        vars.insert("mock_port".into(), self.mock.port.to_string());
        vars.insert(
            "qdrant_port".into(),
            self.mock
                .qdrant_port
                .map_or_else(|| "0".to_string(), |p| p.to_string()),
        );
        // The side never sees the real key: its proxy sends that.
        vars.insert("qdrant_api_key".into(), "rig-qdrant-placeholder".into());
        for (k, v) in &s.vars {
            vars.insert(format!("var.{k}"), v.clone());
        }
        let render = |t: &str| {
            template::render(t, &vars)
                .map_err(|e| self.fail(format!("{e} (pass var.<name> with --set name=value)")))
        };
        let hook = |w: &Option<target::Webhook>| -> std::result::Result<Option<crate::steps::HookTarget>, SideFailure> {
            match w {
                None => Ok(None),
                Some(w) => Ok(Some(crate::steps::HookTarget {
                    secret: render(&w.secret)?,
                    port: w.port.clone(),
                    path: w.path.clone(),
                })),
            }
        };
        let hooks = crate::steps::Hooks {
            eventsub: hook(&self.target.eventsub)?,
            polar: hook(&self.target.polar)?,
        };
        let side_values: BTreeMap<String, String> = vars
            .iter()
            .filter(|(k, _)| template::is_side_value(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut command = spec
            .command
            .iter()
            .map(|c| render(c))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let cwd = match &spec.cwd {
            Some(c) => {
                let p = PathBuf::from(render(c)?);
                if p.is_absolute() {
                    p
                } else {
                    s.repo_dir.join(p)
                }
            }
            None => s.repo_dir.clone(),
        };
        let mut env = Vec::new();
        for (k, v) in &spec.env {
            env.push((k.clone(), render(v)?));
        }
        for k in &spec.pass_env {
            if let Some(v) = s.env.get(k) {
                env.push((k.clone(), v.clone()));
            }
        }
        let mut container_name = None;
        if let Some(c) = &spec.container {
            // `docker run`: the side's environment reaches the container by name (`-e NAME`,
            // read from the docker client's environment), so no value is on a command line.
            let name = format!(
                "rig-{}-{}-{}-{}",
                std::process::id(),
                self.stores.df_index,
                self.label,
                self.launches
            );
            self.reg.add_container(&name);
            let mut cmd = vec![
                "docker".to_string(),
                "run".into(),
                "--rm".into(),
                "--init".into(),
                "--name".into(),
                name.clone(),
                "--network".into(),
                "host".into(),
                "--memory".into(),
                format!("{}m", c.memory_mb),
                "--memory-swap".into(),
                format!("{}m", c.memory_mb),
                "--cpus".into(),
                format!("{}", c.cpus),
                "--label".into(),
                format!("dima-rig={}", std::process::id()),
            ];
            if let Some(w) = &c.workdir {
                cmd.push("--workdir".into());
                cmd.push(render(w)?);
            }
            for (from, to, ro) in &c.mounts {
                let from = PathBuf::from(render(from)?);
                let from = if from.is_absolute() {
                    from
                } else {
                    s.repo_dir.join(from)
                };
                let from = from.canonicalize().unwrap_or(from);
                cmd.push("--volume".into());
                cmd.push(format!(
                    "{}:{}{}",
                    from.display(),
                    render(to)?,
                    if *ro { ":ro" } else { "" }
                ));
            }
            for (k, _) in &env {
                cmd.push("--env".into());
                cmd.push(k.clone());
            }
            cmd.push(render(&c.image)?);
            for x in &c.command {
                cmd.push(render(x)?);
            }
            command = cmd;
            // The docker client itself needs these (they are not passed into the container).
            for k in [
                "PATH",
                "HOME",
                "DOCKER_HOST",
                "DOCKER_CONFIG",
                "XDG_RUNTIME_DIR",
            ] {
                if !env.iter().any(|(n, _)| n == k)
                    && let Some(v) = s.env.get(k)
                {
                    env.push((k.into(), v.clone()));
                }
            }
            container_name = Some(name);
        }
        let log_path = s.out_dir.join("logs").join(&self.target.name).join(format!(
            "{}-{}-{}.log",
            self.run_id, self.label, self.launches
        ));
        self.last_log = Some(log_path.clone());
        let ls = LaunchSpec {
            side: self.which.name().into(),
            command,
            cwd,
            env,
            log_path,
            ports,
            primary_port: self.target.ports.first().cloned().unwrap_or_default(),
            ready: spec.ready.clone(),
            stop_signal: spec.stop_signal,
            grace_ms: spec.grace_ms,
            container: container_name,
        };
        let p = SideProcess::launch(ls, s.env.get("PATH").map(String::as_str)).await?;
        self.proc = Some(p);
        self.hooks = hooks;
        self.side_values = side_values;
        self.wait_store_ready().await
    }

    /// Readiness that the stores show (a document, a key), after the process is up.
    async fn wait_store_ready(&mut self) -> std::result::Result<(), SideFailure> {
        let ready = &self.spec().ready;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ready.timeout_ms);
        let filter = match &ready.probe {
            target::Probe::Mongo { filter, .. } => Some(
                scenario::to_doc(filter, scenario::ExtMode::Filter, 0, "ready.mongo.filter")
                    .map_err(|e| self.fail(e))?,
            ),
            target::Probe::Key(_) => None,
            _ => return Ok(()),
        };
        loop {
            if let Some(p) = self.proc.as_mut()
                && let Err(why) = p.check_alive()
            {
                return Err(self.fail_with_log(format!("did not become ready: {why}")));
            }
            let done = match (&ready.probe, &filter) {
                (
                    target::Probe::Mongo {
                        collection, count, ..
                    },
                    Some(f),
                ) => self
                    .stores
                    .count(collection, f.clone())
                    .await
                    .is_ok_and(|n| n >= *count),
                (target::Probe::Key(k), _) => self.stores.key_exists(k).await.unwrap_or(false),
                _ => true,
            };
            if done {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = self.stop_process().await;
                return Err(self.fail_with_log(format!(
                    "not ready after {} ms (the stores never showed the ready condition)",
                    ready.timeout_ms
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn stop_process(&mut self) -> Option<String> {
        let mut p = self.proc.take()?;
        p.stop().await
    }

    /// Let a fresh process finish its start-up writes and start-up calls to the mock: until the
    /// stores were quiet for 200 ms and the mock for 300 ms, at most `max_ms` (never fails).
    async fn settle(&mut self, max_ms: u64) {
        let mut last = None;
        let mut since = tokio::time::Instant::now();
        let deadline = since + Duration::from_millis(max_ms);
        while tokio::time::Instant::now() < deadline {
            let Ok(fp) = self.stores.fingerprint(&[], &[]).await else {
                return;
            };
            let t = tokio::time::Instant::now();
            let mock_quiet = timefmt::now_ms() - self.mock.last_request() >= 300;
            if last != Some(fp) {
                last = Some(fp);
                since = t;
            } else if t.duration_since(since) >= Duration::from_millis(200) && mock_quiet {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn settle_ms(&self, mock: &MockSpec) -> u64 {
        mock.settle_ms.unwrap_or(3000)
    }

    /// Each own-process scenario starts with an empty Qdrant, like the other stores.
    async fn reset_qdrant(&self) -> std::result::Result<(), SideFailure> {
        if let Some(up) = &self.qdrant {
            qdrant::drop_prefixed(up)
                .await
                .map_err(|e| self.fail(format!("emptying the side's Qdrant collections: {e}")))?;
        }
        Ok(())
    }

    async fn ensure_shared(&mut self) -> std::result::Result<(), SideFailure> {
        let alive = self.proc.as_mut().is_some_and(|p| p.check_alive().is_ok());
        if alive && self.baseline.is_some() {
            return Ok(());
        }
        let _ = self.stop_process().await;
        self.baseline = None;
        self.stores
            .reset_empty()
            .await
            .map_err(|e| self.fail(e.to_string()))?;
        self.reset_qdrant().await?;
        let target_mock = self.target.mock.clone();
        self.launch(&target_mock).await?;
        self.settle(self.settle_ms(&target_mock)).await;
        let b = self
            .stores
            .snapshot()
            .await
            .map_err(|e| self.fail(format!("snapshot after start-up: {e}")))?;
        self.baseline = Some(b);
        Ok(())
    }

    async fn run_scenario(&mut self, sc: &Scenario) -> SideOutcome {
        let seeded_at = timefmt::now_ms();
        let start = seeded_at;
        let own_process = !(self.target.share_process || sc.share_process) || sc.restart;
        let mock_spec = MockSpec::merged(&self.target.mock, &sc.mock);
        if own_process {
            let _ = self.stop_process().await;
            self.baseline = None;
            self.stores
                .reset_empty()
                .await
                .map_err(|e| self.fail(e.to_string()))?;
            self.reset_qdrant().await?;
            self.stores
                .seed(sc, start)
                .await
                .map_err(|e| self.fail(format!("seed: {e}")))?;
            self.launch(&mock_spec).await?;
            self.settle(self.settle_ms(&mock_spec)).await;
        } else {
            self.ensure_shared().await?;
            if let Some(b) = self.baseline.clone() {
                self.stores
                    .restore(&b)
                    .await
                    .map_err(|e| self.fail(format!("reset to the start-up snapshot: {e}")))?;
            }
            self.stores
                .seed(sc, start)
                .await
                .map_err(|e| self.fail(format!("seed: {e}")))?;
            let ports = self
                .proc
                .as_ref()
                .map(|p| p.ports.clone())
                .unwrap_or_default();
            self.mock.reset(&mock_spec, &ports);
        }
        let Some(proc) = self.proc.as_mut() else {
            return Err(self.fail("no process"));
        };
        let proc_start = proc.started_at;
        // Run times are relative to the first step, not to the seed: the time the process takes
        // to start (which varies between runs) does not move them.
        let start = timefmt::now_ms().max(start);
        let mut runner = Runner {
            stores: &mut self.stores,
            proc,
            http: &self.http,
            saved: BTreeMap::new(),
            allow_scripts: sc.allow_scripts,
            mock: &self.mock,
            hooks: &self.hooks,
            side_values: self.side_values.clone(),
        };
        let result = runner.run(&sc.steps).await;
        let end = timefmt::now_ms();
        let problems = self.mock.problems();
        let problem_text = problems
            .iter()
            .map(|p| format!("{} ({}ms into the run): {}", p.kind, p.at - start, p.detail))
            .collect::<Vec<_>>()
            .join("; ");
        let steps = match result {
            Ok(s) => s,
            Err(e) => {
                // A failed scenario leaves the process in an unknown state (half-done work,
                // or dead): the next scenario gets a fresh one.
                let _ = self.stop_process().await;
                self.baseline = None;
                let message = if problems.is_empty() {
                    e.message
                } else {
                    format!("{}; the mock also saw: {problem_text}", e.message)
                };
                let failure = SideFailure {
                    step: Some(e.step),
                    ..self.fail_with_log(message)
                };
                return Err(failure);
            }
        };
        if !problems.is_empty() {
            let _ = self.stop_process().await;
            self.baseline = None;
            return Err(self.fail_with_log(format!(
                "the side called the outside world in a way the mock does not answer: {problem_text}"
            )));
        }
        let mut calls = self.mock.calls();
        let mut startup_ignored = BTreeMap::new();
        if mock_spec.startup_ignore {
            calls.retain(|c| {
                if c.at < start {
                    *startup_ignored.entry(c.provider.clone()).or_insert(0) += 1;
                    false
                } else {
                    true
                }
            });
        }
        let mongo = self
            .stores
            .capture_mongo(&sc.mongo)
            .await
            .map_err(|e| self.fail(format!("reading MongoDB: {e}")))?;
        let dragonfly = self
            .stores
            .capture_dragonfly(&sc.dragonfly)
            .await
            .map_err(|e| self.fail(format!("reading Dragonfly: {e}")))?;
        let run = RunMeta {
            seeded_at,
            start,
            end,
            process_start: proc_start,
            ports: self
                .proc
                .as_ref()
                .map(|p| p.ports.clone())
                .unwrap_or_default(),
            mongo_db: self.stores.db_name.clone(),
            mongo_uri: capture::redact_uri(&self.stores.mongo_uri()),
            dragonfly_db: self.stores.df_index,
            dragonfly_url: self.stores.dragonfly_url(),
            mock_port: Some(self.mock.port),
            qdrant_port: self.mock.qdrant_port,
            qdrant_prefix: self.mock.qdrant_prefix.clone(),
        };
        if let Some(p) = self.proc.as_mut()
            && let Err(why) = p.check_alive()
        {
            let f = p.failure(None, format!("{why} after the last step"));
            let _ = self.stop_process().await;
            self.baseline = None;
            return Err(f);
        }
        if own_process && let Some(why) = self.stop_process().await {
            return Err(self.fail(format!("{why} before the rig stopped it")));
        }
        let mut raw = RawCapture {
            steps,
            mongo,
            dragonfly,
            calls,
            startup_ignored,
        };
        raw.sort();
        Ok(RawRun { raw, run })
    }

    /// Stop the process and the mock; the stores stay claimed until [`Registry::cleanup`].
    async fn finish(mut self) {
        let _ = self.stop_process().await;
        self.mock.stop().await;
    }
}

/// `host:port` of the first MongoDB host in a URI (`127.0.0.1:27017` by default).
fn mongo_hostport(uri: &str) -> String {
    let rest = uri.split_once("://").map_or(uri, |(_, r)| r);
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let hosts = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let first = hosts.split(',').next().unwrap_or("");
    if first.is_empty() {
        "127.0.0.1:27017".into()
    } else if first.contains(':') {
        first.to_string()
    } else {
        format!("{first}:27017")
    }
}

/// The target's candidate does not exist yet: only `record` and `check` can run.
fn require_candidate(target: &Target) -> Result<()> {
    match &target.candidate.unavailable {
        Some(why) => Err(config(format!(
            "target {}: the candidate is not available ({why}); this target is record only: run `dima-rig record {}`",
            target.name, target.name
        ))),
        None => Ok(()),
    }
}

/// An existing database a side reads (`diff-get`), and the URI it gets for it.
pub struct Existing {
    pub db: String,
    /// A read-only user's URI; `None`: the rig's own credentials (`--allow-writes`).
    pub side_uri: Option<String>,
}

/// Run every scenario on one side. The side's stores are registered in `reg` and released by
/// the command's one cleanup path ([`Registry::cleanup`]), whatever happens here.
async fn run_side(
    settings: &Settings,
    reg: &Registry,
    target: &Target,
    which: Which,
    label: &str,
    scenarios: &[Scenario],
    existing: Option<&Existing>,
) -> Result<Vec<SideOutcome>> {
    let mut r = SideRunner::new(settings, reg, target, which, label, existing).await?;
    let mut out = Vec::with_capacity(scenarios.len());
    for sc in scenarios {
        out.push(r.run_scenario(sc).await);
    }
    r.finish().await;
    Ok(out)
}

/// What normalisation needs besides the raw run: the scenario's known inputs and rules.
pub struct Rules<'a> {
    pub patterns: &'a Patterns,
    pub known: &'a Known,
    /// Response headers not compared.
    pub skip_headers: &'a [String],
    pub as_text: &'a [crate::path::Pattern],
    pub byte_sensitive: &'a [String],
    /// The `$rigNow` offsets of the seed (`true`: epoch seconds).
    pub seed_offsets: &'a [(i64, bool)],
    pub calls: &'a crate::detect::CallRules,
}

impl<'a> Rules<'a> {
    pub fn of(sc: &'a Scenario, patterns: &'a Patterns, byte_sensitive: &'a [String]) -> Rules<'a> {
        Rules {
            patterns,
            known: &sc.known,
            skip_headers: &sc.skip_headers,
            as_text: &sc.as_text,
            byte_sensitive,
            seed_offsets: &sc.seed_offsets,
            calls: &sc.call_rules,
        }
    }
}

/// Detect, order and number one side's raw run with the current normaliser.
pub fn normalise(run: &RawRun, rules: &Rules<'_>, allow: &Allowances) -> Capture {
    let ctx = DetectCtx {
        patterns: rules.patterns,
        window: Window {
            start: run.run.start,
            end: run.run.end,
            proc_start: run.run.process_start,
            seeded_at: run.run.seeded_at,
        },
        known: rules.known,
        allow,
        names: run.run.names(),
        skip_headers: rules.skip_headers.to_vec(),
        as_text: rules.as_text.to_vec(),
        byte_sensitive: rules.byte_sensitive.to_vec(),
        seed_offsets: rules.seed_offsets.to_vec(),
        calls: rules.calls.clone(),
    };
    let mut cap = detect::detect(&ctx, &run.raw);
    canon::canonicalise(&mut cap, allow);
    cap
}

fn normalise_sc(
    run: &RawRun,
    sc: &Scenario,
    allow: &Allowances,
    patterns: &Patterns,
    settings: &Settings,
) -> Capture {
    normalise(
        run,
        &Rules::of(sc, patterns, &settings.byte_sensitive),
        allow,
    )
}

/// A raw run through the capture file format and back, as `verify` reads a reference.
fn through_file(target: &str, sc: &Scenario, r: &RawRun) -> Result<RawRun> {
    let f = capture_file(target, sc, r, None);
    let back = capture::from_file_json(&capture::to_file_json(&f)).map_err(config)?;
    Ok(RawRun {
        raw: back.raw,
        run: back.run,
    })
}

fn capture_file(target: &str, sc: &Scenario, r: &RawRun, label: Option<&str>) -> CaptureFile {
    CaptureFile {
        provenance: Provenance {
            target: target.into(),
            scenario: sc.name.clone(),
            side: Which::Reference.name().into(),
            label: label.map(str::to_string),
            recorded_at: timefmt::now_ms(),
            rig_version: env!("CARGO_PKG_VERSION").into(),
        },
        hashes: Hashes {
            scenario: sc.hash.clone(),
            files: sc.files.clone(),
        },
        run: r.run.clone(),
        raw: r.raw.clone(),
    }
}

fn finish_scenario(
    rep: &mut ScenarioReport,
    outcome: compare::Outcome,
    allow: &Allowances,
    ok: Status,
    bad: Status,
) {
    rep.differences = outcome.differences;
    rep.notes = outcome.notes;
    rep.warnings.extend(allow.unused().map(|a| {
        format!(
            "allowance `{}` ({}) matched nothing; remove it if it is stale. Reason given: {}",
            a.path.source(),
            a.kind.name(),
            a.reason
        )
    }));
    rep.status = if rep.differences.is_empty() { ok } else { bad };
}

fn patterns() -> Result<Patterns> {
    Patterns::new().map_err(|e| config(format!("internal pattern: {e}")))
}

/// Load the selected scenarios; invalid ones become error entries.
fn load_scenarios(
    settings: &Settings,
    target: &str,
    filters: &[String],
    p: &Patterns,
    report: &mut Report,
) -> Result<Vec<Scenario>> {
    let all = scenario::discover(&settings.rig_dir, target)?;
    let names = scenario::select(&all, filters);
    if names.is_empty() {
        return Err(config(format!(
            "no scenarios for target `{target}` match {:?} under {}",
            filters,
            settings.rig_dir.join("scenarios").join(target).display()
        )));
    }
    let target_mock = target::load(&settings.rig_dir, target)
        .map(|t| t.mock_json)
        .unwrap_or(serde_json::Value::Null);
    let mut out = Vec::new();
    for n in names {
        match scenario::load(&settings.rig_dir, target, &n, p) {
            Ok(mut s) => {
                // Values the target's mock answers with are inputs too.
                detect::collect_known_json(p, &target_mock, &mut s.known);
                out.push(s)
            }
            Err(e) => report.scenarios.push(ScenarioReport::error(
                &n,
                "",
                rig_failure("scenario", e.to_string()),
            )),
        }
    }
    Ok(out)
}

pub fn capture_path(settings: &Settings, target: &str, scenario: &str) -> PathBuf {
    settings
        .captures_dir
        .join(target)
        .join(format!("{scenario}.json"))
}

fn read_capture(path: &FsPath) -> std::result::Result<CaptureFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    capture::from_file_json(&v).map_err(|e| format!("{}: {e}", path.display()))
}

/// `dima-rig check`: read the target and every selected scenario without running anything.
pub fn check(settings: &Settings, target_name: &str, filters: &[String]) -> Result<Report> {
    let mut report = Report::new("check", target_name);
    let p = patterns()?;
    let target = target::load(&settings.rig_dir, target_name)?;
    if let Some(why) = &target.candidate.unavailable {
        report
            .warnings
            .push(format!("candidate not available ({why}): record only"));
    }
    let scenarios = load_scenarios(settings, target_name, filters, &p, &mut report)?;
    for sc in scenarios {
        let mut r = ScenarioReport::new(&sc.name, &sc.description);
        r.status = Status::Checked;
        let path = capture_path(settings, target_name, &sc.name);
        match read_capture(&path) {
            Ok(f) if f.hashes.scenario != sc.hash => {
                r.warnings.push("capture is stale: re-record it".into())
            }
            Ok(_) => {}
            Err(_) if !path.exists() => r.warnings.push("no capture recorded yet".into()),
            Err(e) => r.warnings.push(format!("capture cannot be read: {e}")),
        }
        report.scenarios.push(r);
    }
    report.scenarios.sort_by(|a, b| a.scenario.cmp(&b.scenario));
    report.finish();
    Ok(report)
}

/// `dima-rig compare`: run the reference and the candidate live and compare.
pub async fn compare_live(
    settings: &Settings,
    reg: &Registry,
    target_name: &str,
    filters: &[String],
) -> Result<Report> {
    let mut report = Report::new("compare", target_name);
    let target = target::load(&settings.rig_dir, target_name)?;
    require_candidate(&target)?;
    let p = patterns()?;
    let scenarios = load_scenarios(settings, target_name, filters, &p, &mut report)?;
    let refs = run_side(
        settings,
        reg,
        &target,
        Which::Reference,
        "ref",
        &scenarios,
        None,
    )
    .await?;
    let cands = run_side(
        settings,
        reg,
        &target,
        Which::Candidate,
        "cand",
        &scenarios,
        None,
    )
    .await?;
    for ((sc, r), c) in scenarios.iter().zip(refs).zip(cands) {
        let mut rep = ScenarioReport::new(&sc.name, &sc.description);
        match (r, c) {
            (Ok(r), Ok(c)) => {
                let allow = sc.allowances();
                // The reference goes through the file format, exactly as `verify` reads it.
                let r = through_file(target_name, sc, &r)?;
                let rc = normalise_sc(&r, sc, &allow, &p, settings);
                let cc = normalise_sc(&c, sc, &allow, &p, settings);
                let outcome = compare::compare(&rc, &cc, &allow, sc.tolerances);
                finish_scenario(&mut rep, outcome, &allow, Status::Match, Status::Differ);
            }
            (r, c) => {
                rep.status = Status::Error;
                rep.errors.extend(r.err());
                rep.errors.extend(c.err());
            }
        }
        report.scenarios.push(rep);
    }
    report.scenarios.sort_by(|a, b| a.scenario.cmp(&b.scenario));
    report.finish();
    Ok(report)
}

/// `dima-rig verify`: run the candidate and compare with the recorded reference captures.
pub async fn verify(
    settings: &Settings,
    reg: &Registry,
    target_name: &str,
    filters: &[String],
) -> Result<Report> {
    let mut report = Report::new("verify", target_name);
    let target = target::load(&settings.rig_dir, target_name)?;
    require_candidate(&target)?;
    let p = patterns()?;
    let scenarios = load_scenarios(settings, target_name, filters, &p, &mut report)?;
    let mut runnable = Vec::new();
    let mut recorded = Vec::new();
    for sc in scenarios {
        let path = capture_path(settings, target_name, &sc.name);
        let problem = match read_capture(&path) {
            Err(e) if !path.exists() => Err(format!(
                "no capture recorded ({e}); run `dima-rig record {target_name} {}`",
                sc.name
            )),
            Err(e) => Err(e),
            Ok(f) if f.hashes.scenario != sc.hash => Err(format!(
                "capture is stale: the scenario or a seed it includes changed after recording; run `dima-rig record {target_name} {}`",
                sc.name
            )),
            Ok(f) if f.provenance.target != target_name || f.provenance.scenario != sc.name => {
                Err(format!(
                    "capture {} belongs to {}/{}",
                    path.display(),
                    f.provenance.target,
                    f.provenance.scenario
                ))
            }
            Ok(f) => Ok(RawRun {
                raw: f.raw,
                run: f.run,
            }),
        };
        match problem {
            Ok(cap) => {
                recorded.push(cap);
                runnable.push(sc);
            }
            Err(msg) => report.scenarios.push(ScenarioReport::error(
                &sc.name,
                &sc.description,
                rig_failure("reference", msg),
            )),
        }
    }
    if !runnable.is_empty() {
        let cands = run_side(
            settings,
            reg,
            &target,
            Which::Candidate,
            "cand",
            &runnable,
            None,
        )
        .await?;
        for ((sc, r), c) in runnable.iter().zip(recorded).zip(cands) {
            let mut rep = ScenarioReport::new(&sc.name, &sc.description);
            match c {
                Ok(c) => {
                    let allow = sc.allowances();
                    // The stored raw reference, normalised by the current code.
                    let rc = normalise_sc(&r, sc, &allow, &p, settings);
                    let cc = normalise_sc(&c, sc, &allow, &p, settings);
                    let outcome = compare::compare(&rc, &cc, &allow, sc.tolerances);
                    finish_scenario(&mut rep, outcome, &allow, Status::Match, Status::Differ);
                }
                Err(f) => {
                    rep.status = Status::Error;
                    rep.errors.push(f);
                }
            }
            report.scenarios.push(rep);
        }
    }
    report.scenarios.sort_by(|a, b| a.scenario.cmp(&b.scenario));
    report.finish();
    Ok(report)
}

/// `dima-rig record`: run the reference (twice unless `once`), check it is stable, write captures.
pub async fn record(
    settings: &Settings,
    reg: &Registry,
    target_name: &str,
    filters: &[String],
    once: bool,
    label: Option<&str>,
) -> Result<Report> {
    let mut report = Report::new("record", target_name);
    let target = target::load(&settings.rig_dir, target_name)?;
    let p = patterns()?;
    let scenarios = load_scenarios(settings, target_name, filters, &p, &mut report)?;
    let first = run_side(
        settings,
        reg,
        &target,
        Which::Reference,
        "ref",
        &scenarios,
        None,
    )
    .await?;
    let second = if once {
        None
    } else {
        Some(
            run_side(
                settings,
                reg,
                &target,
                Which::Reference,
                "ref2",
                &scenarios,
                None,
            )
            .await?,
        )
    };
    let mut second = second.map(Vec::into_iter);
    for (sc, r1) in scenarios.iter().zip(first) {
        let r2 = second.as_mut().and_then(Iterator::next);
        let mut rep = ScenarioReport::new(&sc.name, &sc.description);
        let r1 = match r1 {
            Ok(r) => r,
            Err(f) => {
                rep.status = Status::Error;
                rep.errors.push(f);
                report.scenarios.push(rep);
                continue;
            }
        };
        let allow = sc.allowances();
        let c1 = normalise_sc(&r1, sc, &allow, &p, settings);
        match r2 {
            Some(Err(f)) => {
                rep.status = Status::Error;
                rep.errors.push(f);
                report.scenarios.push(rep);
                continue;
            }
            Some(Ok(r2)) => {
                let c2 = normalise_sc(&r2, sc, &allow, &p, settings);
                let outcome = compare::compare(&c1, &c2, &allow, sc.tolerances);
                if !outcome.differences.is_empty() {
                    finish_scenario(
                        &mut rep,
                        outcome,
                        &allow,
                        Status::Recorded,
                        Status::Unstable,
                    );
                    rep.warnings.push("two runs of the reference disagree (\"reference\" = run 1, \"candidate\" = run 2); fix the scenario or add allowances; nothing written".into());
                    report.scenarios.push(rep);
                    continue;
                }
                rep.notes = outcome.notes;
            }
            None => {}
        }
        let path = capture_path(settings, target_name, &sc.name);
        // Unchanged: the stored capture, normalised by the current code, still matches.
        let unchanged = match read_capture(&path) {
            Ok(old)
                if old.hashes.scenario == sc.hash
                    && old.provenance.target == target_name
                    && old.provenance.scenario == sc.name =>
            {
                let fresh = sc.allowances();
                let old = RawRun {
                    raw: old.raw,
                    run: old.run,
                };
                let oc = normalise_sc(&old, sc, &fresh, &p, settings);
                let nc = normalise_sc(&r1, sc, &fresh, &p, settings);
                compare::compare(&oc, &nc, &fresh, sc.tolerances)
                    .differences
                    .is_empty()
            }
            _ => false,
        };
        if unchanged {
            rep.status = Status::Unchanged;
        } else {
            let text = capture::to_file_string(&capture_file(target_name, sc, &r1, label));
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| crate::error::io(&dir.display().to_string(), e))?;
            }
            std::fs::write(&path, text)
                .map_err(|e| crate::error::io(&path.display().to_string(), e))?;
            rep.status = Status::Recorded;
        }
        rep.warnings.extend(allow.unused().map(|a| {
            format!(
                "allowance `{}` ({}) matched nothing; remove it if it is stale",
                a.path.source(),
                a.kind.name()
            )
        }));
        rep.capture = Some(path.display().to_string());
        report.scenarios.push(rep);
    }
    report.scenarios.sort_by(|a, b| a.scenario.cmp(&b.scenario));
    report.finish();
    Ok(report)
}

/// `dima-rig diff-get`: GET requests against an existing database on both sides.
pub async fn diff_get(
    settings: &Settings,
    reg: &Registry,
    target_name: &str,
    db: &str,
    list_file: &FsPath,
    write_check: bool,
    allow_writes: bool,
) -> Result<Report> {
    let mut report = Report::new("diff-get", target_name);
    let target = target::load(&settings.rig_dir, target_name)?;
    require_candidate(&target)?;
    let p = patterns()?;
    let list = getlist::load(list_file)?;
    if db.is_empty() || db.contains(['/', '\\', '.', ' ', '"', '$']) {
        return Err(config(format!("--db `{db}`: not a MongoDB database name")));
    }
    let mut known = Known::default();
    for s in &list.steps {
        if let crate::scenario::StepKind::Http(h) = &s.kind {
            p.collect_known(&h.path, &mut known);
            h.headers
                .iter()
                .for_each(|(_, v)| p.collect_known(v, &mut known));
        }
    }
    let sc = Scenario {
        name: list_file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        file: list_file.to_path_buf(),
        description: list.description.clone(),
        restart: false,
        allow_scripts: false,
        seed_mongo: Vec::new(),
        seed_dragonfly: Vec::new(),
        steps: list.steps.clone(),
        mongo: Selection {
            only: Some(Vec::new()),
            exclude: Vec::new(),
        },
        dragonfly: Selection {
            only: Some(Vec::new()),
            exclude: Vec::new(),
        },
        skip_headers: list.skip_headers.clone(),
        as_text: Vec::new(),
        allow: list.allow.clone(),
        tolerances: list.tolerances,
        hash: String::new(),
        files: Vec::new(),
        seed_offsets: Vec::new(),
        known,
        mock: MockSpec::default(),
        call_rules: crate::detect::CallRules::default(),
        share_process: false,
    };
    if allow_writes {
        report.warnings.push(format!(
            "--allow-writes: both sides had write access to database {db}; only the before/after dbHash check{} stood between them and the data",
            if write_check { "" } else { " (skipped with --no-write-check)" }
        ));
    } else if !stores::auth_enforced(&settings.stores).await? {
        report.warnings.push(format!(
            "the MongoDB server does not enforce authentication, so the read-only users could still write to {db}; only the before/after dbHash check protects it"
        ));
    }
    let mut runs = Vec::new();
    for (which, label) in [(Which::Reference, "ref"), (Which::Candidate, "cand")] {
        let client = stores::mongo_client(&settings.stores.mongo_uri).await?;
        let before = if write_check {
            Some(stores::db_hash(&client, db).await?)
        } else {
            None
        };
        // Each side reads with a user that may only read this database, so it cannot change
        // what the other side then reads.
        let side_uri = if allow_writes {
            None
        } else {
            Some(stores::create_read_only_user(&settings.stores, reg, label, db).await?)
        };
        let existing = Existing {
            db: db.to_string(),
            side_uri,
        };
        let mut out = run_side(
            settings,
            reg,
            &target,
            which,
            label,
            std::slice::from_ref(&sc),
            Some(&existing),
        )
        .await?;
        if !allow_writes
            && let Some(Err(f)) = out.last_mut()
            && f.step.is_none()
        {
            f.message = format!(
                "{} (it ran with a MongoDB user that may only read {db}; if it must write at start-up, for example to create indexes, rerun with --allow-writes, and the report will say that writes were possible)",
                f.message
            );
        }
        let mut outcome = out
            .pop()
            .unwrap_or_else(|| Err(rig_failure(which.name(), "no result")));
        if let Some(before) = before {
            let after = stores::db_hash(&client, db).await?;
            let changed: Vec<&String> = before
                .keys()
                .chain(after.keys())
                .filter(|k| before.get(*k) != after.get(*k))
                .collect();
            if !changed.is_empty() {
                let mut names: Vec<String> = changed.into_iter().cloned().collect();
                names.dedup();
                outcome = Err(rig_failure(
                    which.name(),
                    format!(
                        "the {} wrote to database {db} (changed collections: {})",
                        which.name(),
                        names.join(", ")
                    ),
                ));
            }
        }
        runs.push(outcome);
    }
    let cand = runs
        .pop()
        .unwrap_or_else(|| Err(rig_failure("candidate", "no result")));
    let refr = runs
        .pop()
        .unwrap_or_else(|| Err(rig_failure("reference", "no result")));
    match (refr, cand) {
        (Ok(r), Ok(c)) => {
            let allow = sc.allowances();
            let rc = normalise_sc(&r, &sc, &allow, &p, settings);
            let cc = normalise_sc(&c, &sc, &allow, &p, settings);
            for (i, step) in sc.steps.iter().enumerate() {
                let label = match &step.kind {
                    crate::scenario::StepKind::Http(h) => format!("{:03} GET {}", i, h.path),
                    _ => format!("{i:03}"),
                };
                let only = |cap: &Capture| Capture {
                    steps: cap
                        .steps
                        .iter()
                        .enumerate()
                        .map(|(j, s)| {
                            if j == i {
                                s.clone()
                            } else {
                                StepCap::Done("other".into())
                            }
                        })
                        .collect(),
                    ..Capture::default()
                };
                let mut rep = ScenarioReport::new(&label, step.name.as_deref().unwrap_or(""));
                let outcome = compare::compare(&only(&rc), &only(&cc), &allow, sc.tolerances);
                rep.differences = outcome.differences;
                rep.notes = outcome.notes;
                rep.status = if rep.differences.is_empty() {
                    Status::Match
                } else {
                    Status::Differ
                };
                report.scenarios.push(rep);
            }
            let stale: Vec<String> = allow
                .unused()
                .map(|a| {
                    format!(
                        "allowance `{}` ({}) matched nothing; remove it if it is stale",
                        a.path.source(),
                        a.kind.name()
                    )
                })
                .collect();
            if let Some(first) = report.scenarios.first_mut() {
                first.warnings.extend(stale);
            }
        }
        (r, c) => {
            let mut rep = ScenarioReport::new(&sc.name, &sc.description);
            rep.status = Status::Error;
            rep.errors.extend(r.err());
            rep.errors.extend(c.err());
            report.scenarios.push(rep);
        }
    }
    report.finish();
    Ok(report)
}
