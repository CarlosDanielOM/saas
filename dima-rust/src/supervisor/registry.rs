//! Canonical native cron registry. TypeScript metadata is a parity reference.

use std::{collections::BTreeMap, ffi::OsString};

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolKind {
    Stream,
    Raid,
    Baseline,
    BatchOnly,
}

#[derive(Clone, Copy, Debug)]
pub struct WorkerSpec {
    pub name: &'static str,
    pub binary: &'static str,
    pub metric_prefix: &'static str,
    pub protocol: &'static str,
    pub batch_metric: &'static str,
    pub args: &'static [&'static str],
    pub extra_env: &'static [&'static str],
    pub enabled_env: Option<&'static str>,
    pub max_events: u64,
    pub max_duration_ms: f64,
    pub protocol_kind: ProtocolKind,
}

const COMMON_ENV: &[&str] = &[
    "MONGO_URI",
    "PATH",
    "TZ",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];
const DRAGONFLY_ENV: &[&str] = &["DRAGONFLY_HOST", "DRAGONFLY_PORT"];
const RECEIPTS_ENV: &[&str] = &[
    "DRAGONFLY_HOST",
    "DRAGONFLY_PORT",
    "AI_USAGE_RECEIPTS_ENABLED",
    "AI_USAGE_RECEIPTS_INTERVAL_MS",
    "AI_USAGE_RECEIPTS_BATCH_SIZE",
    "AI_USAGE_RECEIPTS_LOCK_KEY",
    "AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS",
    "AI_USAGE_QUEUE_MAX_AGE_SECONDS",
    "AI_USAGE_PROCESSING_MAX_AGE_SECONDS",
    "AI_USAGE_QUEUE_FAILURE_THRESHOLD",
];
const DASHBOARD_ENV: &[&str] = &[
    "DRAGONFLY_HOST",
    "DRAGONFLY_PORT",
    "CLIENT_ID",
    "CLIENT_SECRET",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
];

// Preserve the native startup order from the previous mixed supervisor.
pub static WORKERS: [WorkerSpec; 7] = [
    WorkerSpec {
        name: "dashboard-activity",
        binary: "/usr/local/bin/dashboard_activity",
        metric_prefix: "dashboard_activity_rust",
        protocol: "dashboard_activity:",
        batch_metric: "batch_events",
        args: &["--telemetry-json"],
        extra_env: DASHBOARD_ENV,
        enabled_env: None,
        max_events: 502,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::BatchOnly,
    },
    WorkerSpec {
        name: "raid-analytics",
        binary: "/usr/local/bin/raid_analytics",
        metric_prefix: "raid_analytics_rust",
        protocol: "raid_analytics:",
        batch_metric: "batch_channels",
        args: &["--telemetry-json"],
        extra_env: &[],
        enabled_env: None,
        max_events: 1,
        max_duration_ms: f64::MAX,
        protocol_kind: ProtocolKind::Raid,
    },
    WorkerSpec {
        name: "stream-activity",
        binary: "/usr/local/bin/stream_activity",
        metric_prefix: "stream_activity_rust",
        protocol: "stream_activity:",
        batch_metric: "batch_events",
        args: &["--batch-size", "500", "--telemetry-json"],
        extra_env: &[],
        enabled_env: None,
        max_events: 1000,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::Stream,
    },
    WorkerSpec {
        name: "roulette-completion",
        binary: "/usr/local/bin/roulette_completion",
        metric_prefix: "roulette_completion_rust",
        protocol: "roulette_completion:",
        batch_metric: "batch_channels",
        args: &["--telemetry-json"],
        extra_env: &[],
        enabled_env: None,
        max_events: 100,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::BatchOnly,
    },
    WorkerSpec {
        name: "follow-defense-baseline",
        binary: "/usr/local/bin/follow_defense_baseline",
        metric_prefix: "follow_defense_baseline_rust",
        protocol: "follow_defense_baseline:",
        batch_metric: "batch_channels",
        args: &["--telemetry-json"],
        extra_env: DRAGONFLY_ENV,
        enabled_env: None,
        max_events: 1,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::Baseline,
    },
    WorkerSpec {
        name: "raid-sessions",
        binary: "/usr/local/bin/raid_sessions",
        metric_prefix: "raid_sessions_rust",
        protocol: "raid_sessions:",
        batch_metric: "batch_items",
        args: &["--telemetry-json"],
        extra_env: DRAGONFLY_ENV,
        enabled_env: None,
        max_events: 401,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::BatchOnly,
    },
    WorkerSpec {
        name: "ai-usage-receipts",
        binary: "/usr/local/bin/ai_usage_receipts",
        metric_prefix: "ai_usage_receipts_rust",
        protocol: "ai_usage_receipts:",
        batch_metric: "batch_receipts",
        args: &["--telemetry-json"],
        extra_env: RECEIPTS_ENV,
        enabled_env: Some("AI_USAGE_RECEIPTS_ENABLED"),
        max_events: 1000,
        max_duration_ms: 300_000.0,
        protocol_kind: ProtocolKind::BatchOnly,
    },
];

pub type Environment = BTreeMap<OsString, OsString>;

impl WorkerSpec {
    pub fn enabled(&self, env: &Environment) -> bool {
        !self.enabled_env.is_some_and(|key| {
            env.get(std::ffi::OsStr::new(key))
                .is_some_and(|value| value == "false")
        })
    }

    pub fn launch_args(&self, once: bool) -> Vec<String> {
        let mut args: Vec<String> = self.args.iter().map(|arg| (*arg).into()).collect();
        if once {
            args.push("--once".into());
        }
        args
    }

    /// An explicit environment, never inherited wholesale by Command.
    pub fn child_env(&self, env: &Environment) -> Environment {
        COMMON_ENV
            .iter()
            .chain(self.extra_env.iter())
            .filter_map(|key| {
                env.get(std::ffi::OsStr::new(key))
                    .map(|value| (OsString::from(*key), value.clone()))
            })
            .collect()
    }

    pub fn launch_metadata(&self, env: &Environment, once: bool, uid: u32, gid: u32) -> Value {
        let env_keys: Vec<&str> = COMMON_ENV
            .iter()
            .chain(self.extra_env.iter())
            .copied()
            .filter(|key| env.contains_key(std::ffi::OsStr::new(key)))
            .collect();
        json!({
            "name": self.name, "worker": self.name, "binary": self.binary,
            "args": self.launch_args(once), "envKeys": env_keys,
            "enabled": self.enabled(env), "uid": uid, "gid": gid,
            "metricPrefix": self.metric_prefix, "protocol": self.protocol,
            "batchMetric": self.batch_metric, "maxEvents": self.max_events,
            "maxDurationMs": self.max_duration_ms,
        })
    }
}

pub fn selected_workers(names: Option<&str>) -> Result<Vec<&'static WorkerSpec>, &'static str> {
    let Some(names) = names else {
        return Ok(WORKERS.iter().collect());
    };
    if names.len() > 256 || names.is_empty() {
        return Err("Invalid worker selection");
    }
    let mut selected = Vec::new();
    for name in names.split(',') {
        let worker = WORKERS
            .iter()
            .find(|worker| worker.name == name)
            .ok_or("Unknown worker selection")?;
        if selected
            .iter()
            .any(|previous: &&WorkerSpec| previous.name == name)
        {
            return Err("Duplicate worker selection");
        }
        selected.push(worker);
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seven_workers_are_unique_and_selection_is_strict() {
        assert_eq!(selected_workers(None).unwrap().len(), 7);
        let names: std::collections::BTreeSet<_> = WORKERS.iter().map(|w| w.name).collect();
        assert_eq!(names.len(), 7);
        assert_eq!(
            selected_workers(Some("raid-sessions,stream-activity")).unwrap()[0].name,
            "raid-sessions"
        );
        for invalid in [
            "",
            "stream-activity,",
            "unknown",
            "stream-activity,stream-activity",
            " raid-sessions",
        ] {
            assert!(selected_workers(Some(invalid)).is_err());
        }
    }

    #[test]
    fn launch_environment_and_arguments_match_native_contract() {
        let mut env = Environment::new();
        for key in COMMON_ENV
            .iter()
            .chain(RECEIPTS_ENV)
            .chain(DASHBOARD_ENV)
            .chain(["NODE_OPTIONS", "UNRELATED_SECRET"].iter())
        {
            env.insert((*key).into(), "private-value".into());
        }
        for worker in &WORKERS {
            let child = worker.child_env(&env);
            assert_eq!(child.len(), COMMON_ENV.len() + worker.extra_env.len());
            assert!(!child.contains_key(std::ffi::OsStr::new("NODE_OPTIONS")));
            assert!(!child.contains_key(std::ffi::OsStr::new("UNRELATED_SECRET")));
            assert_eq!(worker.launch_args(false), worker.args);
            assert_eq!(worker.launch_args(true).last().unwrap(), "--once");
            let metadata = worker
                .launch_metadata(&env, false, 65534, 65534)
                .to_string();
            assert!(!metadata.contains("private-value"));
        }
        let stream = WORKERS
            .iter()
            .find(|w| w.name == "stream-activity")
            .unwrap();
        assert_eq!(stream.args, ["--batch-size", "500", "--telemetry-json"]);
    }

    #[test]
    fn receipts_disable_only_on_exact_false() {
        let receipts = WORKERS
            .iter()
            .find(|w| w.name == "ai-usage-receipts")
            .unwrap();
        let mut env = Environment::new();
        assert!(receipts.enabled(&env));
        for value in ["False", "FALSE", "0", "", " false", "false ", "true"] {
            env.insert("AI_USAGE_RECEIPTS_ENABLED".into(), value.into());
            assert!(receipts.enabled(&env));
        }
        env.insert("AI_USAGE_RECEIPTS_ENABLED".into(), "false".into());
        assert!(!receipts.enabled(&env));
        assert!(
            WORKERS
                .iter()
                .filter(|w| w.name != receipts.name)
                .all(|w| w.enabled(&env))
        );
    }
}
