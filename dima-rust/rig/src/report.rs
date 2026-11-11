//! Reports: one entry per scenario, written as readable text and as JSON.

use std::fmt::Write as _;

use serde::Serialize;

use crate::compare::Finding;

pub const REPORT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Candidate matches the reference.
    Match,
    /// Candidate differs from the reference.
    Differ,
    /// A side failed (did not start, died, an expectation or wait failed) or the scenario is invalid.
    Error,
    /// `record`: capture written (new or changed).
    Recorded,
    /// `record`: the existing capture already matches; file left as it was.
    Unchanged,
    /// `record`: two runs of the reference disagree; nothing written.
    Unstable,
}

impl Status {
    pub fn ok(self) -> bool {
        matches!(self, Status::Match | Status::Recorded | Status::Unchanged)
    }

    fn label(self) -> &'static str {
        match self {
            Status::Match => "MATCH",
            Status::Differ => "DIFFER",
            Status::Error => "ERROR",
            Status::Recorded => "RECORDED",
            Status::Unchanged => "UNCHANGED",
            Status::Unstable => "UNSTABLE",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SideFailure {
    pub side: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<usize>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub log_tail: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScenarioReport {
    pub scenario: String,
    pub description: String,
    pub status: Status,
    pub differences: Vec<Finding>,
    pub notes: Vec<Finding>,
    pub warnings: Vec<String>,
    pub errors: Vec<SideFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<String>,
}

impl ScenarioReport {
    pub fn new(scenario: &str, description: &str) -> ScenarioReport {
        ScenarioReport {
            scenario: scenario.to_string(),
            description: description.to_string(),
            status: Status::Match,
            differences: Vec::new(),
            notes: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
            capture: None,
        }
    }

    pub fn error(scenario: &str, description: &str, failure: SideFailure) -> ScenarioReport {
        let mut r = ScenarioReport::new(scenario, description);
        r.status = Status::Error;
        r.errors.push(failure);
        r
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub rig_report: u32,
    pub command: String,
    pub target: String,
    pub ok: bool,
    pub scenarios: Vec<ScenarioReport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl Report {
    pub fn new(command: &str, target: &str) -> Report {
        Report {
            rig_report: REPORT_VERSION,
            command: command.into(),
            target: target.into(),
            ok: false,
            scenarios: Vec::new(),
            errors: Vec::new(),
        }
    }

    pub fn finish(&mut self) {
        self.ok = self.errors.is_empty()
            && !self.scenarios.is_empty()
            && self.scenarios.iter().all(|s| s.status.ok());
    }

    pub fn find(&self, scenario: &str) -> Option<&ScenarioReport> {
        self.scenarios.iter().find(|s| s.scenario == scenario)
    }

    /// Readable text for a terminal.
    pub fn to_text(&self) -> String {
        let mut o = String::new();
        let _ = writeln!(o, "dima-rig {} {}", self.command, self.target);
        for s in &self.scenarios {
            let mut tail = Vec::new();
            if !s.differences.is_empty() {
                tail.push(format!(
                    "{} difference{}",
                    s.differences.len(),
                    plural(s.differences.len())
                ));
            }
            if !s.notes.is_empty() {
                tail.push(format!("{} note{}", s.notes.len(), plural(s.notes.len())));
            }
            if !s.warnings.is_empty() {
                tail.push(format!(
                    "{} warning{}",
                    s.warnings.len(),
                    plural(s.warnings.len())
                ));
            }
            let extra = if tail.is_empty() {
                String::new()
            } else {
                format!(" ({})", tail.join(", "))
            };
            let _ = writeln!(o, "\n{:<9} {}{}", s.status.label(), s.scenario, extra);
            for e in &s.errors {
                let at = e.step.map(|n| format!(" at step {n}")).unwrap_or_default();
                let _ = writeln!(o, "  {} failed{}: {}", e.side, at, e.message);
                if let Some(log) = &e.log {
                    let _ = writeln!(o, "    log: {log}");
                }
                for line in &e.log_tail {
                    let _ = writeln!(o, "    | {line}");
                }
            }
            for d in &s.differences {
                write_finding(&mut o, "", d);
            }
            for n in &s.notes {
                write_finding(&mut o, "note: ", n);
            }
            for w in &s.warnings {
                let _ = writeln!(o, "  warning: {w}");
            }
            if let Some(c) = &s.capture {
                let _ = writeln!(o, "  capture: {c}");
            }
        }
        for e in &self.errors {
            let _ = writeln!(o, "\nERROR {e}");
        }
        let count = |st: Status| self.scenarios.iter().filter(|s| s.status == st).count();
        let mut parts = Vec::new();
        for st in [
            Status::Match,
            Status::Differ,
            Status::Error,
            Status::Recorded,
            Status::Unchanged,
            Status::Unstable,
        ] {
            let n = count(st);
            if n > 0 {
                parts.push(format!("{n} {}", st.label().to_lowercase()));
            }
        }
        let _ = writeln!(
            o,
            "\n{}: {} scenario{}{}{}",
            if self.ok { "OK" } else { "FAILED" },
            self.scenarios.len(),
            plural(self.scenarios.len()),
            if parts.is_empty() { "" } else { ": " },
            parts.join(", ")
        );
        o
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn write_finding(o: &mut String, prefix: &str, f: &Finding) {
    let _ = writeln!(o, "  {prefix}{}: {}", f.path, f.what);
    if let Some(c) = &f.context {
        let _ = writeln!(o, "      in {c}");
    }
    if let Some(r) = &f.reference {
        let _ = writeln!(o, "      reference: {r}");
    }
    if let Some(c) = &f.candidate {
        let _ = writeln!(o, "      candidate: {c}");
    }
}
