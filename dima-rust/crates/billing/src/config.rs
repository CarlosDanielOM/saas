//! Typed configuration. A binary fills it once at startup from the environment (names and
//! parsing below are the reference's); this crate never reads the environment.
//!
//! | Variable | Field | Reference |
//! |---|---|---|
//! | `POLARSH_OAT` | [`PolarConfig::token`] (empty counts as unset) | `billing.ts` `getPolarToken`, `polarsh.ts`, `credit_gift_provider.ts` |
//! | `POLARSH_ENVIRONMENT` | [`PolarConfig::environment`] (`sandbox` exactly, else production) | `billing.ts` `getPolarBaseUrl` |
//! | `POLARSH_API_BASE_URL` | [`PolarConfig::api_base_url`] | `billing.ts` `getPolarBaseUrl` |
//! | `POLARSH_REFERRAL_DISCOUNT_ID` | [`PolarConfig::referral_discount_id`] | `createBillingCheckout` |
//! | `POLARSH_WINBACK_DISCOUNT_ID`, `POLARSH_UPGRADE_DISCOUNT_ID`, `POLARSH_CHANGE_DISCOUNT_ID` | [`PolarConfig::scenario_discounts`] | `getDiscountConfigByScenario` |
//! | `BILLING_SUCCESS_URL`, `BILLING_RETURN_URL`, `BILLING_PORTAL_RETURN_URL` | [`RedirectConfig`] | `getDefaultUrl` |
//! | `BILLING_ALLOWED_REDIRECT_HOSTS` | [`RedirectConfig::allowed_hosts`] | `isAllowedHost` |
//!
//! Every value is `|| null` in the reference: an empty variable is the same as an unset one.
//!
//! **Base URL** (intended difference). The reference's raw REST calls go to
//! `POLARSH_API_BASE_URL` (one trailing `/` removed), else the sandbox host when
//! `POLARSH_ENVIRONMENT=sandbox`, else `https://api.polar.sh`; its SDK calls always go to
//! `https://api.polar.sh`. Here every Polar call uses one provider. Its declared host is
//! `POLARSH_API_BASE_URL` when that is one of Polar's own hosts over https ([`polar_host`]),
//! else the host of `POLARSH_ENVIRONMENT`. Any other `POLARSH_API_BASE_URL`, which could send the
//! token to any host, is honoured only as a base URL override of a registry built in a test mode
//! ([`PolarConfig::base_url_override`], refused by `dima-http` in production). Production has
//! neither variable set (`ledger/env.json`).
//!
//! **Redirect fallbacks** (`BILLING_*_URL`) are validated at start-up ([`RedirectConfig::validate`]):
//! `https` (or `http` to a loopback host), no credentials, on the allowlist when it is set.

use dima_core::SecretString;

/// A configuration value refused at start-up.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// A configured redirect fallback is not a safe redirect target.
    #[error("{0} is not a safe redirect URL")]
    UnsafeRedirect(&'static str),
}

/// `https://api.polar.sh`.
pub const PRODUCTION_BASE_URL: &str = "https://api.polar.sh";
/// `https://sandbox-api.polar.sh`.
pub const SANDBOX_BASE_URL: &str = "https://sandbox-api.polar.sh";

/// `POLARSH_ENVIRONMENT`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PolarEnvironment {
    /// Anything but `sandbox` (the default).
    #[default]
    Production,
    /// `sandbox`.
    Sandbox,
}

impl PolarEnvironment {
    /// The reference's test: `process.env.POLARSH_ENVIRONMENT === 'sandbox'`.
    pub fn from_env_value(value: Option<&str>) -> Self {
        if value == Some("sandbox") {
            Self::Sandbox
        } else {
            Self::Production
        }
    }

    /// The host this environment declares.
    pub fn base_url(self) -> &'static str {
        match self {
            Self::Production => PRODUCTION_BASE_URL,
            Self::Sandbox => SANDBOX_BASE_URL,
        }
    }
}

/// The discount ids configured per checkout scenario.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScenarioDiscounts {
    /// `POLARSH_WINBACK_DISCOUNT_ID`.
    pub winback: Option<String>,
    /// `POLARSH_UPGRADE_DISCOUNT_ID`.
    pub upgrade: Option<String>,
    /// `POLARSH_CHANGE_DISCOUNT_ID`.
    pub change: Option<String>,
}

/// Polar settings.
#[derive(Clone, Debug, Default)]
pub struct PolarConfig {
    /// `POLARSH_OAT`. Without it every Polar call fails with
    /// [`crate::polar::PolarError::NotConfigured`] before anything is sent.
    pub token: Option<SecretString>,
    /// `POLARSH_ENVIRONMENT`.
    pub environment: PolarEnvironment,
    /// `POLARSH_API_BASE_URL` as set (see the module docs).
    pub api_base_url: Option<String>,
    /// `POLARSH_REFERRAL_DISCOUNT_ID`.
    pub referral_discount_id: Option<String>,
    /// The scenario discounts.
    pub scenario_discounts: ScenarioDiscounts,
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}

impl PolarConfig {
    /// Reads the variables through `lookup` (a binary passes its environment snapshot).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let get = |name: &str| non_empty(lookup(name).as_deref());
        Self {
            token: get("POLARSH_OAT").map(SecretString::new),
            environment: PolarEnvironment::from_env_value(lookup("POLARSH_ENVIRONMENT").as_deref()),
            api_base_url: get("POLARSH_API_BASE_URL"),
            referral_discount_id: get("POLARSH_REFERRAL_DISCOUNT_ID"),
            scenario_discounts: ScenarioDiscounts {
                winback: get("POLARSH_WINBACK_DISCOUNT_ID"),
                upgrade: get("POLARSH_UPGRADE_DISCOUNT_ID"),
                change: get("POLARSH_CHANGE_DISCOUNT_ID"),
            },
        }
    }

    /// `POLARSH_API_BASE_URL` when it names one of Polar's own hosts ([`polar_host`]).
    fn polar_api_base_url(&self) -> Option<&'static str> {
        self.api_base_url.as_deref().and_then(polar_host)
    }

    /// The host the provider declares (`getPolarBaseUrl`): `POLARSH_API_BASE_URL` when it is
    /// one of Polar's own hosts over https, else the host of [`Self::environment`].
    pub fn declared_base_url(&self) -> &'static str {
        self.polar_api_base_url()
            .unwrap_or_else(|| self.environment.base_url())
    }

    /// `POLARSH_API_BASE_URL` with one trailing `/` removed (`replace(/\/$/, '')`), for
    /// `RegistryBuilder::base_url_override` in a test mode only: `None` when it is unset or
    /// already the declared host (one of Polar's own, [`Self::declared_base_url`]).
    pub fn base_url_override(&self) -> Option<&str> {
        if self.polar_api_base_url().is_some() {
            return None;
        }
        self.api_base_url
            .as_deref()
            .map(|base| base.strip_suffix('/').unwrap_or(base))
            .filter(|base| !base.is_empty())
    }
}

/// Polar's host when `value` is exactly one of Polar's API origins over https
/// (`https://api.polar.sh` or `https://sandbox-api.polar.sh`, one trailing `/` allowed): no
/// other port, path, query, fragment or credentials.
pub fn polar_host(value: &str) -> Option<&'static str> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    match url.host() {
        Some(url::Host::Domain("api.polar.sh")) => Some(PRODUCTION_BASE_URL),
        Some(url::Host::Domain("sandbox-api.polar.sh")) => Some(SANDBOX_BASE_URL),
        _ => None,
    }
}

/// Redirect settings of the checkout and portal flows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RedirectConfig {
    /// `BILLING_SUCCESS_URL`.
    pub success_url: Option<String>,
    /// `BILLING_RETURN_URL`.
    pub return_url: Option<String>,
    /// `BILLING_PORTAL_RETURN_URL`.
    pub portal_return_url: Option<String>,
    /// `BILLING_ALLOWED_REDIRECT_HOSTS` as set (comma-separated hosts; unset or empty allows
    /// every host, as in the reference).
    pub allowed_hosts: Option<String>,
}

impl RedirectConfig {
    /// Refuses a configured fallback that is not a safe redirect target
    /// ([`crate::plans::checkout::is_safe_redirect`]) or, when the allowlist is set, not on it.
    /// The reference ignored a fallback it could not parse; a binary calls this at start-up
    /// (through [`BillingConfig::from_lookup`]) so a misconfiguration stops it instead.
    pub fn validate(&self) -> Result<(), ConfigError> {
        for (name, value) in [
            ("BILLING_SUCCESS_URL", &self.success_url),
            ("BILLING_RETURN_URL", &self.return_url),
            ("BILLING_PORTAL_RETURN_URL", &self.portal_return_url),
        ] {
            if let Some(value) = value
                && !crate::plans::checkout::is_valid_configured_redirect(
                    value,
                    self.allowed_hosts.as_deref(),
                )
            {
                return Err(ConfigError::UnsafeRedirect(name));
            }
        }
        Ok(())
    }

    /// Reads the variables through `lookup`.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let get = |name: &str| non_empty(lookup(name).as_deref());
        Self {
            success_url: get("BILLING_SUCCESS_URL"),
            return_url: get("BILLING_RETURN_URL"),
            portal_return_url: get("BILLING_PORTAL_RETURN_URL"),
            allowed_hosts: get("BILLING_ALLOWED_REDIRECT_HOSTS"),
        }
    }
}

/// Everything this crate reads.
#[derive(Clone, Debug, Default)]
pub struct BillingConfig {
    /// Polar.
    pub polar: PolarConfig,
    /// Redirects.
    pub redirects: RedirectConfig,
}

impl BillingConfig {
    /// Reads every variable through `lookup` and validates the redirect fallbacks
    /// ([`RedirectConfig::validate`]).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let config = Self {
            polar: PolarConfig::from_lookup(&lookup),
            redirects: RedirectConfig::from_lookup(&lookup),
        };
        config.redirects.validate()?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn variables_are_read_with_the_reference_rules() {
        let env: HashMap<&str, &str> = [
            ("POLARSH_OAT", "polar_oat_x"),
            ("POLARSH_ENVIRONMENT", "Sandbox"),
            ("POLARSH_API_BASE_URL", "http://127.0.0.1:9/"),
            ("POLARSH_WINBACK_DISCOUNT_ID", ""),
            ("BILLING_SUCCESS_URL", "https://domdimabot.com/ok"),
        ]
        .into_iter()
        .collect();
        let config =
            BillingConfig::from_lookup(|name| env.get(name).map(|v| (*v).to_owned())).unwrap();
        assert_eq!(config.polar.environment, PolarEnvironment::Production);
        assert_eq!(config.polar.base_url_override(), Some("http://127.0.0.1:9"));
        assert_eq!(config.polar.scenario_discounts.winback, None);
        assert_eq!(
            config.redirects.success_url.as_deref(),
            Some("https://domdimabot.com/ok")
        );
        assert!(!format!("{config:?}").contains("polar_oat_x"));
        assert_eq!(
            PolarEnvironment::from_env_value(Some("sandbox")),
            PolarEnvironment::Sandbox
        );
    }

    // Item 8 of P2-BILLING-01b: Polar's own hosts over https are accepted outside a test mode;
    // anything else still needs the HTTP crate's test mode.
    #[test]
    fn polar_hosts_are_accepted_as_the_base_url() {
        let polar = |base: &str| PolarConfig {
            api_base_url: Some(base.to_owned()),
            ..Default::default()
        };
        for (base, declared) in [
            ("https://api.polar.sh", PRODUCTION_BASE_URL),
            ("https://api.polar.sh/", PRODUCTION_BASE_URL),
            ("https://API.Polar.sh:443/", PRODUCTION_BASE_URL),
            ("https://sandbox-api.polar.sh", SANDBOX_BASE_URL),
        ] {
            let config = polar(base);
            assert_eq!(config.declared_base_url(), declared, "{base}");
            assert_eq!(config.base_url_override(), None, "{base}");
        }
        for base in [
            "http://api.polar.sh",
            "https://api.polar.sh.evil.test",
            "https://evil.test/api.polar.sh",
            "https://user:x@api.polar.sh",
            "https://api.polar.sh:8443",
            "https://api.polar.sh/v1",
            "https://api.polar.sh/?x=1",
            "http://127.0.0.1:9/",
        ] {
            let config = polar(base);
            assert_eq!(config.declared_base_url(), PRODUCTION_BASE_URL, "{base}");
            assert!(config.base_url_override().is_some(), "{base}");
        }
        let sandbox = PolarConfig {
            environment: PolarEnvironment::Sandbox,
            ..Default::default()
        };
        assert_eq!(sandbox.declared_base_url(), SANDBOX_BASE_URL);
    }

    // Item 8: configured fallbacks are validated at start-up.
    #[test]
    fn unsafe_configured_redirects_are_refused_at_start_up() {
        let env = |pairs: &[(&'static str, &'static str)]| {
            let pairs = pairs.to_vec();
            BillingConfig::from_lookup(move |name| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            })
        };
        assert!(env(&[("BILLING_SUCCESS_URL", "https://domdimabot.com/ok")]).is_ok());
        assert!(env(&[("BILLING_SUCCESS_URL", "http://localhost:4200/ok")]).is_ok());
        for (name, value) in [
            ("BILLING_SUCCESS_URL", "javascript:alert(1)"),
            ("BILLING_RETURN_URL", "http://domdimabot.com/back"),
            ("BILLING_PORTAL_RETURN_URL", "https://u:p@domdimabot.com/"),
            ("BILLING_SUCCESS_URL", "not a url"),
        ] {
            let error = env(&[(name, value)]).err().map(|e| e.to_string());
            assert_eq!(
                error.as_deref(),
                Some(format!("{name} is not a safe redirect URL").as_str())
            );
        }
        let error = env(&[
            ("BILLING_ALLOWED_REDIRECT_HOSTS", "domdimabot.com"),
            ("BILLING_RETURN_URL", "https://elsewhere.test/back"),
        ])
        .err()
        .map(|e| e.to_string());
        assert_eq!(
            error.as_deref(),
            Some("BILLING_RETURN_URL is not a safe redirect URL")
        );
    }
}
