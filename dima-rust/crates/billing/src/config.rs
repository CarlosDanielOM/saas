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
//! `https://api.polar.sh`. Here every Polar call uses one provider: its declared host follows
//! `POLARSH_ENVIRONMENT`, and `POLARSH_API_BASE_URL`, which can redirect the token to any host, is
//! honoured only as a base URL override of a registry built in a test mode
//! ([`PolarConfig::base_url_override`], refused by `dima-http` in production). Production has
//! neither variable set (`ledger/env.json`).

use dima_core::SecretString;

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

    /// `POLARSH_API_BASE_URL` with one trailing `/` removed (`replace(/\/$/, '')`), for
    /// `RegistryBuilder::base_url_override` in a test mode only.
    pub fn base_url_override(&self) -> Option<&str> {
        self.api_base_url
            .as_deref()
            .map(|base| base.strip_suffix('/').unwrap_or(base))
            .filter(|base| !base.is_empty())
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
    /// Reads every variable through `lookup`.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        Self {
            polar: PolarConfig::from_lookup(&lookup),
            redirects: RedirectConfig::from_lookup(&lookup),
        }
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
        let config = BillingConfig::from_lookup(|name| env.get(name).map(|v| (*v).to_owned()));
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
}
