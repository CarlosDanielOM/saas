//! The cron's configuration, read once from the environment at start-up (charter section 6) and
//! validated there: every error names the setting. Nothing else in the crate reads the
//! environment. The later cron packages add their workers' settings here, with the reference's
//! names, defaults and parsing.
//!
//! | Setting | Default | What it does |
//! |---|---|---|
//! | `MONGO_URI` | required | MongoDB (the database the URI names; `test` when it names none, as the Node driver) |
//! | `DRAGONFLY_HOST`, `DRAGONFLY_PORT` | required, `undefined` | Dragonfly, `redis://HOST:PORT`; production gives the Rust processes `6379/1` (charter section 3) |
//! | `SECRET_KEY` | required | the stored-credential cipher (Twitch tokens) and trace signatures |
//! | `CLIENT_ID`, `CLIENT_SECRET` | the text `undefined`, empty | the Twitch app (token refreshes of later workers) |
//! | `OBSERVABILITY_DISABLED` | unset | `true` turns the telemetry export off (console logs stay) |
//! | `CRON_WORKER_RESTART_DELAY_MS` | 5000 (at least 1000) | the first restart delay of a failed worker (the reference's), doubling while it keeps failing, up to [`crate::host::BACKOFF_MAX`] |
//! | `CRON_WORKERS` | every worker | Rust only: a comma-separated list of the workers to run (the old native supervisor's `--workers`); an unknown or repeated name is an error |
//! | `CRON_WORKER_THREADS` | 4 | Rust only: the runtime's worker threads (1 to 32) |
//! | `CRON_KEY_PREFIX` | empty | Rust only, tests: put in front of every Dragonfly key the workers own (letters, digits, `:`, `_`, `-`; at most 64). Empty in production |
//!
//! Each worker's own off switch is the reference's `enabledEnv` (off when exactly `false`), where
//! the reference has one ([`crate::worker::Spec::enabled_env`]); the four workers of P2-CRON-01
//! have none (the native supervisor had none for them either).

use crate::workers::TABLE;
use dima_core::SecretString;
use dima_core::crypto::CredentialCipher;
use dima_core::env::{EnvSource, EnvVar};
use dima_core::runtime::restart_delay_from_env;
use dima_store::dragonfly::DragonflyConfig;
use dima_store::mongo::MongoConfig;
use dima_telemetry::TelemetryConfig;
use std::fmt;
use std::time::Duration;

/// The variables the cron reads.
pub const ENV: &[EnvVar] = &[
    EnvVar::new("MONGO_URI", "MongoDB connection string").secret(),
    EnvVar::new("DRAGONFLY_HOST", "Dragonfly host (may carry credentials)").secret(),
    EnvVar::new("DRAGONFLY_PORT", "Dragonfly port, optionally /database"),
    EnvVar::new("SECRET_KEY", "credential cipher key").secret(),
    EnvVar::new("CLIENT_ID", "Twitch app client id").with_default("undefined"),
    EnvVar::new("CLIENT_SECRET", "Twitch app client secret").secret(),
    EnvVar::new("OBSERVABILITY_DISABLED", "`true`: no telemetry export"),
    EnvVar::new(
        "CRON_WORKER_RESTART_DELAY_MS",
        "first restart delay of a worker",
    )
    .with_default("5000"),
    EnvVar::new(
        "CRON_WORKERS",
        "Rust only: the workers to run, comma-separated",
    ),
    EnvVar::new("CRON_WORKER_THREADS", "Rust only: runtime worker threads").with_default("4"),
    EnvVar::new(
        "CRON_KEY_PREFIX",
        "Rust only, tests: prefix of the workers' Dragonfly keys",
    ),
];

/// Default runtime worker threads: the old native workers ran two each in seven processes; one
/// process with four leaves room for a slow or CPU-heavy worker without starving the others.
pub const DEFAULT_WORKER_THREADS: usize = 4;
/// Most runtime worker threads.
pub const MAX_WORKER_THREADS: usize = 32;
/// Longest key prefix.
pub const MAX_KEY_PREFIX: usize = 64;

/// A setting the cron cannot start with.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// A required setting is unset or empty.
    #[error("{name} is not set")]
    Missing {
        /// The setting.
        name: &'static str,
    },
    /// A setting has a value the cron cannot use.
    #[error("invalid {name}: {reason}")]
    Invalid {
        /// The setting.
        name: &'static str,
        /// Why (never the value, which may be a secret).
        reason: String,
    },
}

fn invalid(name: &'static str, reason: impl Into<String>) -> ConfigError {
    ConfigError::Invalid {
        name,
        reason: reason.into(),
    }
}

/// Everything the cron reads from the environment.
pub struct Config {
    /// Telemetry: `cron` / `index`, export unless `OBSERVABILITY_DISABLED` is `true` or Dragonfly
    /// is not configured.
    pub telemetry: TelemetryConfig,
    /// `MONGO_URI`.
    pub mongo: MongoConfig,
    /// `DRAGONFLY_HOST`, `DRAGONFLY_PORT`.
    pub dragonfly: DragonflyConfig,
    /// `SECRET_KEY`, as the credential cipher.
    pub cipher: CredentialCipher,
    /// `CLIENT_ID` (the text `undefined` when unset, as the reference sends it).
    pub client_id: String,
    /// `CLIENT_SECRET`.
    pub client_secret: SecretString,
    /// `CRON_WORKER_RESTART_DELAY_MS`.
    pub restart_delay: Duration,
    /// The workers to run, in the table's order: selected by `CRON_WORKERS` and not turned off
    /// by their own setting.
    pub workers: Vec<&'static str>,
    /// Workers left out, with the setting that left them out (for the start-up log).
    pub disabled: Vec<(&'static str, &'static str)>,
    /// `CRON_WORKER_THREADS`.
    pub worker_threads: usize,
    /// `CRON_KEY_PREFIX`.
    pub key_prefix: String,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("mongo", &self.mongo)
            .field("dragonfly", &self.dragonfly)
            .field("client_id", &self.client_id)
            .field("restart_delay", &self.restart_delay)
            .field("workers", &self.workers)
            .field("disabled", &self.disabled)
            .field("worker_threads", &self.worker_threads)
            .field("key_prefix", &self.key_prefix)
            .finish_non_exhaustive()
    }
}

impl Config {
    /// Reads and validates the configuration.
    pub fn from_env(env: &EnvSource) -> Result<Self, ConfigError> {
        let uri = required(env, "MONGO_URI")?;
        let host = required(env, "DRAGONFLY_HOST")?;
        let secret_key = required(env, "SECRET_KEY")?;
        let cipher = CredentialCipher::new(secret_key)
            .map_err(|error| invalid("SECRET_KEY", error.to_string()))?;
        let dragonfly =
            DragonflyConfig::from_env_values(Some(host), env.get("DRAGONFLY_PORT"), "cron");
        dragonfly
            .client()
            .map_err(|error| invalid("DRAGONFLY_PORT", error.to_string()))?;
        let (workers, disabled) = select_workers(env)?;
        Ok(Self {
            telemetry: TelemetryConfig::new("cron", "index").with_env_values(
                env.get("OBSERVABILITY_DISABLED"),
                Some(host),
                env.get("DRAGONFLY_PORT"),
                Some(secret_key),
            ),
            mongo: MongoConfig::new(uri),
            dragonfly,
            cipher,
            client_id: env.get("CLIENT_ID").unwrap_or("undefined").to_owned(),
            client_secret: SecretString::new(env.get("CLIENT_SECRET").unwrap_or("").to_owned()),
            restart_delay: restart_delay_from_env(env.get("CRON_WORKER_RESTART_DELAY_MS")),
            workers,
            disabled,
            worker_threads: worker_threads(env.get("CRON_WORKER_THREADS"))?,
            key_prefix: key_prefix(env.get("CRON_KEY_PREFIX"))?,
        })
    }

    /// Whether `worker` runs.
    pub fn runs(&self, worker: &str) -> bool {
        self.workers.contains(&worker)
    }
}

fn required<'a>(env: &'a EnvSource, name: &'static str) -> Result<&'a str, ConfigError> {
    env.get(name)
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::Missing { name })
}

type Selection = (Vec<&'static str>, Vec<(&'static str, &'static str)>);

fn select_workers(env: &EnvSource) -> Result<Selection, ConfigError> {
    let all: Vec<&'static str> = TABLE.iter().map(|entry| entry.0).collect();
    let selected: Vec<&'static str> = match env.get("CRON_WORKERS").map(str::trim) {
        None | Some("") => all.clone(),
        Some(list) => {
            let mut selected = Vec::new();
            for name in list.split(',').map(str::trim) {
                let Some(known) = all.iter().find(|known| **known == name) else {
                    return Err(invalid(
                        "CRON_WORKERS",
                        format!("unknown worker {name:?}; known: {}", all.join(", ")),
                    ));
                };
                if selected.contains(known) {
                    return Err(invalid("CRON_WORKERS", format!("{name:?} is repeated")));
                }
                selected.push(*known);
            }
            selected
        }
    };
    let mut workers = Vec::new();
    let mut disabled = Vec::new();
    for (name, enabled_env) in TABLE {
        if !selected.contains(name) {
            disabled.push((*name, "CRON_WORKERS"));
        } else if let Some(setting) = enabled_env
            && env.get(setting) == Some("false")
        {
            disabled.push((*name, *setting));
        } else {
            workers.push(*name);
        }
    }
    Ok((workers, disabled))
}

fn worker_threads(raw: Option<&str>) -> Result<usize, ConfigError> {
    match raw.map(str::trim).filter(|raw| !raw.is_empty()) {
        None => Ok(DEFAULT_WORKER_THREADS),
        Some(raw) => raw
            .parse::<usize>()
            .ok()
            .filter(|threads| (1..=MAX_WORKER_THREADS).contains(threads))
            .ok_or_else(|| {
                invalid(
                    "CRON_WORKER_THREADS",
                    format!("must be a whole number from 1 to {MAX_WORKER_THREADS}"),
                )
            }),
    }
}

fn key_prefix(raw: Option<&str>) -> Result<String, ConfigError> {
    let prefix = raw.unwrap_or("");
    if prefix.chars().count() > MAX_KEY_PREFIX
        || !prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return Err(invalid(
            "CRON_KEY_PREFIX",
            format!("only letters, digits, ':', '_' and '-', at most {MAX_KEY_PREFIX}"),
        ));
    }
    Ok(prefix.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn env(extra: &[(&str, &str)]) -> EnvSource {
        let mut pairs = vec![
            ("MONGO_URI", "mongodb://127.0.0.1:27017/dima"),
            ("DRAGONFLY_HOST", "127.0.0.1"),
            ("DRAGONFLY_PORT", "6379/1"),
            ("SECRET_KEY", KEY),
        ];
        pairs.extend_from_slice(extra);
        EnvSource::from_pairs(pairs)
    }

    fn error(extra: &[(&str, &str)]) -> ConfigError {
        match Config::from_env(&env(extra)) {
            Ok(config) => panic!("accepted {config:?}"),
            Err(error) => error,
        }
    }

    #[test]
    fn the_reference_defaults() -> Result<(), ConfigError> {
        let config = Config::from_env(&env(&[]))?;
        assert_eq!(
            config.workers,
            TABLE.iter().map(|e| e.0).collect::<Vec<_>>()
        );
        assert!(config.disabled.is_empty());
        assert_eq!(config.restart_delay, Duration::from_millis(5000));
        assert_eq!(config.worker_threads, DEFAULT_WORKER_THREADS);
        assert_eq!(config.key_prefix, "");
        assert_eq!(config.client_id, "undefined");
        assert_eq!(config.dragonfly.database().ok(), Some(1));
        assert_eq!(
            (
                config.telemetry.service.as_str(),
                config.telemetry.process.as_str()
            ),
            ("cron", "index")
        );
        assert!(config.telemetry.export);
        let quiet = Config::from_env(&env(&[("OBSERVABILITY_DISABLED", "true")]))?;
        assert!(!quiet.telemetry.export);
        Ok(())
    }

    #[test]
    fn required_settings_are_named() {
        for name in ["MONGO_URI", "DRAGONFLY_HOST", "SECRET_KEY"] {
            assert_eq!(error(&[(name, "")]), ConfigError::Missing { name });
            assert_eq!(
                Config::from_env(&EnvSource::default()).err(),
                Some(ConfigError::Missing { name: "MONGO_URI" })
            );
        }
        assert!(matches!(
            error(&[("SECRET_KEY", "much too long for an AES-256 key, by far")]),
            ConfigError::Invalid {
                name: "SECRET_KEY",
                ..
            }
        ));
        assert!(matches!(
            error(&[("DRAGONFLY_PORT", "6379?protocol=resp3")]),
            ConfigError::Invalid {
                name: "DRAGONFLY_PORT",
                ..
            }
        ));
    }

    #[test]
    fn workers_are_selected_by_name_in_table_order() -> Result<(), ConfigError> {
        let config = Config::from_env(&env(&[(
            "CRON_WORKERS",
            " follow-defense-baseline , stream-activity",
        )]))?;
        assert_eq!(
            config.workers,
            vec!["stream-activity", "follow-defense-baseline"]
        );
        assert!(config.runs("stream-activity") && !config.runs("raid-analytics"));
        assert!(
            config
                .disabled
                .contains(&("raid-analytics", "CRON_WORKERS"))
        );
        for list in [
            "stream-activity,unknown",
            "stream-activity,stream-activity",
            ",",
        ] {
            assert!(matches!(
                error(&[("CRON_WORKERS", list)]),
                ConfigError::Invalid {
                    name: "CRON_WORKERS",
                    ..
                }
            ));
        }
        Ok(())
    }

    #[test]
    fn numbers_and_the_prefix_are_checked() -> Result<(), ConfigError> {
        assert_eq!(
            Config::from_env(&env(&[("CRON_WORKER_THREADS", "2")]))?.worker_threads,
            2
        );
        for threads in ["0", "33", "two", "-1", "1.5"] {
            assert!(matches!(
                error(&[("CRON_WORKER_THREADS", threads)]),
                ConfigError::Invalid {
                    name: "CRON_WORKER_THREADS",
                    ..
                }
            ));
        }
        assert_eq!(
            Config::from_env(&env(&[("CRON_WORKER_RESTART_DELAY_MS", "10")]))?.restart_delay,
            Duration::from_millis(1000)
        );
        assert_eq!(
            Config::from_env(&env(&[("CRON_KEY_PREFIX", "dima_test_cron_ab12:")]))?.key_prefix,
            "dima_test_cron_ab12:"
        );
        for prefix in ["with space", "a*", "ünï"] {
            assert!(matches!(
                error(&[("CRON_KEY_PREFIX", prefix)]),
                ConfigError::Invalid {
                    name: "CRON_KEY_PREFIX",
                    ..
                }
            ));
        }
        Ok(())
    }

    #[test]
    fn errors_never_print_a_secret() {
        let text =
            error(&[("SECRET_KEY", "s3cr3t-value-that-is-way-too-long-for-a-key")]).to_string();
        assert!(!text.contains("s3cr3t"), "{text}");
        let config = Config::from_env(&env(&[("CLIENT_SECRET", "client-secret-value")]));
        assert!(config.is_ok_and(|config| !format!("{config:?}").contains("client-secret")));
    }
}
