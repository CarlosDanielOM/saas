//! The credit-pack billing context cache: which paid plan a Polar customer has and until when,
//! so the credit-pack catalog need not list subscriptions on every view.
//!
//! Reference: `creditPackBillingContextCacheKey`, `validCachedBillingContext`,
//! `cacheCreditPackBillingContext` and `getCachedCreditPackBillingContext` in
//! `dimabot/src/utils/billing.ts`. Key family `billing:credit-packs:context:v1:*` is *rebuilt*
//! at cutover (a cache of Polar's answer). The value is JavaScript-shaped JSON
//! (`{"version":1,"planTier":…,"expiresAt":…}`), Rust's own encoding.

use super::PlanTier;
use dima_core::Clock;
use dima_model::StrEnum;
use dima_store::dragonfly::{Dragonfly, SetOptions};
use serde_json::{Value, json};

/// `CREDIT_PACK_BILLING_CONTEXT_CACHE_TTL_SECONDS`.
pub const CONTEXT_TTL_SECONDS: i64 = 2 * 60;
/// `CREDIT_PACK_BILLING_CONTEXT_CACHE_VERSION`.
pub const CONTEXT_VERSION: u32 = 1;

/// `creditPackBillingContextCacheKey(customerId)`: the first 20 hex characters of the SHA-256 of
/// the customer id.
pub fn context_cache_key(customer_id: &str) -> String {
    let hash = dima_core::crypto::sha256(customer_id).hex();
    format!(
        "billing:credit-packs:context:v{CONTEXT_VERSION}:{}",
        dima_text::truncate_chars(&hash, 20)
    )
}

/// A valid cached context (`CreditPackBillingContextCacheValue`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingContextCache {
    /// The plan.
    pub plan_tier: PlanTier,
    /// ISO end of the paid cycle (`None` for free).
    pub expires_at: Option<String>,
}

impl BillingContextCache {
    /// `JSON.stringify(normalized)`.
    pub fn to_text(&self) -> String {
        dima_text::to_js_json(&json!({
            "version": CONTEXT_VERSION,
            "planTier": self.plan_tier.as_str(),
            "expiresAt": self.expires_at,
        }))
    }
}

/// `validCachedBillingContext(value, nowMs)`: free is valid without an expiry; a paid tier needs
/// an expiry after now.
pub fn valid_context(value: &Value, now_ms: i64) -> Option<BillingContextCache> {
    let object = value.as_object()?;
    if crate::js::as_number(object.get("version")) != Some(f64::from(CONTEXT_VERSION)) {
        return None;
    }
    let tier = object
        .get("planTier")
        .and_then(Value::as_str)
        .and_then(PlanTier::parse)?;
    if tier == PlanTier::Free {
        return Some(BillingContextCache {
            plan_tier: tier,
            expires_at: None,
        });
    }
    // `Date.parse(String(candidate.expiresAt || ''))`.
    let expires_text = match object.get("expiresAt") {
        Some(value) if crate::js::truthy(Some(value)) => dima_text::string_of(value),
        _ => String::new(),
    };
    let expires_at_ms = dima_text::parse_date(&expires_text)?;
    if expires_at_ms <= now_ms {
        return None;
    }
    Some(BillingContextCache {
        plan_tier: tier,
        expires_at: dima_text::to_iso_string(expires_at_ms),
    })
}

/// The cache over Dragonfly.
#[derive(Clone)]
pub struct PackContextCache {
    dragonfly: Dragonfly,
}

impl std::fmt::Debug for PackContextCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PackContextCache")
    }
}

impl PackContextCache {
    /// Over one handle.
    pub fn new(dragonfly: Dragonfly) -> Self {
        Self { dragonfly }
    }

    /// `cacheCreditPackBillingContext(input)`: `false` when the input is not a valid context or
    /// the write failed. The TTL is the seconds left in the cycle (rounded up), between 1 and 120.
    pub async fn store(
        &self,
        customer_id: &str,
        plan_tier: PlanTier,
        expires_at: Option<&str>,
        clock: &dyn Clock,
    ) -> bool {
        let now_ms = clock.now_ms();
        let Some(normalized) = valid_context(
            &json!({ "planTier": plan_tier.as_str(), "expiresAt": expires_at, "version": CONTEXT_VERSION }),
            now_ms,
        ) else {
            return false;
        };
        let remaining = match &normalized.expires_at {
            Some(expires) => {
                let ms = dima_text::parse_date(expires).unwrap_or(now_ms);
                // `Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)`: the clock is read
                // again in the reference; one reading is used here.
                (ms - now_ms).div_euclid(1000) + i64::from((ms - now_ms).rem_euclid(1000) != 0)
            }
            None => CONTEXT_TTL_SECONDS,
        };
        let ttl = remaining.clamp(1, CONTEXT_TTL_SECONDS);
        let Ok(ttl) = u64::try_from(ttl) else {
            return false;
        };
        self.dragonfly
            .set(
                &context_cache_key(customer_id),
                normalized.to_text().as_bytes(),
                SetOptions::ex(ttl),
            )
            .await
            .is_ok()
    }

    /// `getCachedCreditPackBillingContext(customerId)`: `None` on a miss, an invalid value or an
    /// error.
    pub async fn load(&self, customer_id: &str, clock: &dyn Clock) -> Option<BillingContextCache> {
        let raw = self
            .dragonfly
            .get_text(&context_cache_key(customer_id))
            .await
            .ok()??;
        if raw.is_empty() {
            return None;
        }
        let value: Value = serde_json::from_str(&raw).ok()?;
        valid_context(&value, clock.now_ms())
    }

    /// Deletes the context (`cache.del(creditPackBillingContextCacheKey(customerId))`).
    pub async fn forget(
        &self,
        customer_id: &str,
    ) -> Result<(), dima_store::dragonfly::DragonflyError> {
        self.dragonfly
            .del(&[&context_cache_key(customer_id)])
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_validation_follow_the_reference() {
        let key = context_cache_key("cust");
        assert_eq!(key.len(), "billing:credit-packs:context:v1:".len() + 20);
        let now = dima_text::parse_date("2026-11-11T00:00:00Z").unwrap();
        assert_eq!(
            valid_context(
                &json!({"version": 1, "planTier": "free", "expiresAt": "junk"}),
                now
            ),
            Some(BillingContextCache {
                plan_tier: PlanTier::Free,
                expires_at: None
            })
        );
        assert_eq!(
            valid_context(
                &json!({"version": 1, "planTier": "pro", "expiresAt": "2026-11-11T00:00:00Z"}),
                now
            ),
            None
        );
        assert_eq!(
            valid_context(&json!({"version": 1, "planTier": "pro", "expiresAt": "2026-11-11T00:00:00.001+00:00"}), now)
                .and_then(|c| c.expires_at),
            Some("2026-11-11T00:00:00.001Z".into())
        );
        assert_eq!(
            valid_context(&json!({"version": 2, "planTier": "free"}), now),
            None
        );
        assert_eq!(
            valid_context(&json!({"version": 1, "planTier": "gold"}), now),
            None
        );
    }
}
