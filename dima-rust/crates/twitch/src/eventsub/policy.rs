//! `shouldTripEventsubCircuitBreaker` (`utils/eventsub_reconciliation_policy.ts`): the
//! reconciliation stops before touching anything when too many of the subscriptions it manages
//! are unhealthy at once (Twitch's side, or the callback, is failing; deleting and re-creating
//! everything would not help).

/// The default share of unhealthy subscriptions that trips the breaker.
pub const DEFAULT_UNHEALTHY_RATIO: f64 = 0.25;
/// The default least number of unhealthy subscriptions that can trip it.
pub const DEFAULT_UNHEALTHY_MIN_COUNT: u64 = 5;

/// `shouldTripEventsubCircuitBreaker(totalManaged, unhealthyManaged, ratio, minCount)`: false for
/// no managed subscriptions or fewer unhealthy than `max(1, min_count)`; otherwise whether the
/// unhealthy share exceeds `ratio` clamped to `[0, 1]`.
pub fn should_trip_circuit_breaker(
    total_managed: u64,
    unhealthy_managed: u64,
    ratio: f64,
    min_count: u64,
) -> bool {
    if total_managed == 0 || unhealthy_managed < min_count.max(1) {
        return false;
    }
    #[allow(clippy::cast_precision_loss)]
    let share = unhealthy_managed as f64 / total_managed as f64;
    share > ratio.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `eventsub_reconciliation.test.ts`: "trips reconciliation circuit breaker only for bulk
    /// unhealthy subscriptions".
    #[test]
    fn trips_reconciliation_circuit_breaker_only_for_bulk_unhealthy_subscriptions() {
        assert!(should_trip_circuit_breaker(20, 6, 0.25, 5));
        assert!(!should_trip_circuit_breaker(20, 4, 0.25, 5));
        assert!(!should_trip_circuit_breaker(100, 10, 0.25, 5));
        assert!(!should_trip_circuit_breaker(0, 0, 0.25, 5));
    }
}
