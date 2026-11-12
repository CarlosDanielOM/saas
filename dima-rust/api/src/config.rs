//! The API's configuration, read once from the environment at start-up (charter section 6).
//! Packages add their settings here as P4-BIN-API wires them, each with the reference's names,
//! defaults and parsing.

use dima_core::env::EnvSource;
use dima_telemetry::TelemetryConfig;

/// Everything the API reads from the environment.
#[derive(Debug)]
pub struct Config {
    /// Telemetry (`OBSERVABILITY_DISABLED`, `DRAGONFLY_HOST`, `DRAGONFLY_PORT`, `SECRET_KEY`):
    /// export to the analytics inbox when Dragonfly is configured and observability is not
    /// disabled; console logs always.
    pub telemetry: TelemetryConfig,
}

impl Config {
    /// Reads the configuration from the snapshot of the environment.
    pub fn from_env(env: &EnvSource) -> Self {
        Self {
            telemetry: TelemetryConfig::new("api", "index").with_env_values(
                env.get("OBSERVABILITY_DISABLED"),
                env.get("DRAGONFLY_HOST"),
                env.get("DRAGONFLY_PORT"),
                env.get("SECRET_KEY"),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_exports_only_with_dragonfly() {
        let quiet = Config::from_env(&EnvSource::from_pairs::<_, &str, &str>([]));
        assert_eq!(
            (
                quiet.telemetry.service.as_str(),
                quiet.telemetry.process.as_str()
            ),
            ("api", "index")
        );
        assert!(!quiet.telemetry.export);
        assert!(quiet.telemetry.dragonfly.is_none());
        let exporting = Config::from_env(&EnvSource::from_pairs([
            ("DRAGONFLY_HOST", "dragonfly"),
            ("DRAGONFLY_PORT", "6379/1"),
        ]));
        assert!(exporting.telemetry.export && exporting.telemetry.dragonfly.is_some());
        let disabled = Config::from_env(&EnvSource::from_pairs([
            ("DRAGONFLY_HOST", "dragonfly"),
            ("OBSERVABILITY_DISABLED", "true"),
        ]));
        assert!(!disabled.telemetry.export);
    }
}
