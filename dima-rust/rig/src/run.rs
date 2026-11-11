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
}

impl<'s> SideRunner<'s> {
    async fn new(
        settings: &'s Settings,
        reg: &Registry,
        target: &'s Target,
        which: Which,
        label: &str,
        existing_db: Option<&str>,
    ) -> Result<SideRunner<'s>> {
        let stores = SideStores::allocate(&settings.stores, reg, label, existing_db).await?;
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

    async fn launch(&mut self) -> std::result::Result<(), SideFailure> {
        let spec = self.spec();
        let s = self.settings;
        let mut ports = BTreeMap::new();
        for name in &self.target.ports {
            let p = side::free_port().map_err(|e| self.fail(format!("no free port: {e}")))?;
            ports.insert(name.clone(), p);
        }
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
        for (k, v) in &s.vars {
            vars.insert(format!("var.{k}"), v.clone());
        }
        let render = |t: &str| {
            template::render(t, &vars)
                .map_err(|e| self.fail(format!("{e} (pass var.<name> with --set name=value)")))
        };
        let command = spec
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
        self.launches += 1;
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
        };
        let p = SideProcess::launch(ls, s.env.get("PATH").map(String::as_str)).await?;
        self.proc = Some(p);
        Ok(())
    }

    async fn stop_process(&mut self) -> Option<String> {
        let mut p = self.proc.take()?;
        p.stop().await
    }

    /// Let a fresh process finish its start-up writes (bounded; never fails).
    async fn settle(&mut self) {
        let mut last = None;
        let mut since = tokio::time::Instant::now();
        let deadline = since + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            let Ok(fp) = self.stores.fingerprint(&[], &[]).await else {
                return;
            };
            let t = tokio::time::Instant::now();
            if last != Some(fp) {
                last = Some(fp);
                since = t;
            } else if t.duration_since(since) >= Duration::from_millis(200) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
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
        self.launch().await?;
        self.settle().await;
        let b = self
            .stores
            .snapshot()
            .await
            .map_err(|e| self.fail(format!("snapshot after start-up: {e}")))?;
        self.baseline = Some(b);
        Ok(())
    }

    async fn run_scenario(&mut self, sc: &Scenario) -> SideOutcome {
        let start = timefmt::now_ms();
        let own_process = !self.target.share_process || sc.restart;
        if own_process {
            let _ = self.stop_process().await;
            self.baseline = None;
            self.stores
                .reset_empty()
                .await
                .map_err(|e| self.fail(e.to_string()))?;
            self.stores
                .seed(sc, start)
                .await
                .map_err(|e| self.fail(format!("seed: {e}")))?;
            self.launch().await?;
            self.settle().await;
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
        }
        let Some(proc) = self.proc.as_mut() else {
            return Err(self.fail("no process"));
        };
        let proc_start = proc.started_at;
        let mut runner = Runner {
            stores: &mut self.stores,
            proc,
            http: &self.http,
            saved: BTreeMap::new(),
            allow_scripts: sc.allow_scripts,
        };
        let result = runner.run(&sc.steps).await;
        let end = timefmt::now_ms();
        let steps = match result {
            Ok(s) => s,
            Err(e) => {
                // A failed scenario leaves the process in an unknown state (half-done work,
                // or dead): the next scenario gets a fresh one.
                let _ = self.stop_process().await;
                self.baseline = None;
                let failure = SideFailure {
                    step: Some(e.step),
                    ..self.fail_with_log(e.message)
                };
                return Err(failure);
            }
        };
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
        };
        raw.sort();
        Ok(RawRun { raw, run })
    }

    /// Stop the process; the stores stay claimed until [`Registry::cleanup`].
    async fn finish(mut self) {
        let _ = self.stop_process().await;
    }
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
    existing_db: Option<&str>,
) -> Result<Vec<SideOutcome>> {
    let mut r = SideRunner::new(settings, reg, target, which, label, existing_db).await?;
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
    pub headers: &'a [String],
    pub as_text: &'a [crate::path::Pattern],
    pub byte_sensitive: &'a [String],
}

impl<'a> Rules<'a> {
    pub fn of(sc: &'a Scenario, patterns: &'a Patterns, byte_sensitive: &'a [String]) -> Rules<'a> {
        Rules {
            patterns,
            known: &sc.known,
            headers: &sc.headers,
            as_text: &sc.as_text,
            byte_sensitive,
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
        },
        known: rules.known,
        allow,
        names: run.run.names(),
        headers: rules.headers.to_vec(),
        as_text: rules.as_text.to_vec(),
        byte_sensitive: rules.byte_sensitive.to_vec(),
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
    let mut out = Vec::new();
    for n in names {
        match scenario::load(&settings.rig_dir, target, &n, p) {
            Ok(s) => out.push(s),
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
    target::load(&settings.rig_dir, target_name)?;
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
            Err(_) => r.warnings.push("no capture recorded yet".into()),
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
                let outcome = compare::compare(&rc, &cc, &allow, sc.tolerance_ms);
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
                    let outcome = compare::compare(&rc, &cc, &allow, sc.tolerance_ms);
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
                let outcome = compare::compare(&c1, &c2, &allow, sc.tolerance_ms);
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
                compare::compare(&oc, &nc, &fresh, sc.tolerance_ms)
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
) -> Result<Report> {
    let mut report = Report::new("diff-get", target_name);
    let target = target::load(&settings.rig_dir, target_name)?;
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
        headers: list.headers.clone(),
        as_text: Vec::new(),
        allow: list.allow.clone(),
        tolerance_ms: list.tolerance_ms,
        hash: String::new(),
        files: Vec::new(),
        known,
    };
    let mut runs = Vec::new();
    for (which, label) in [(Which::Reference, "ref"), (Which::Candidate, "cand")] {
        let client = stores::mongo_client(&settings.stores.mongo_uri).await?;
        let before = if write_check {
            Some(stores::db_hash(&client, db).await?)
        } else {
            None
        };
        let mut out = run_side(
            settings,
            reg,
            &target,
            which,
            label,
            std::slice::from_ref(&sc),
            Some(db),
        )
        .await?;
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
                let outcome = compare::compare(&only(&rc), &only(&cc), &allow, sc.tolerance_ms);
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
