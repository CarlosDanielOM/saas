//! UTC calendar primitives, separate from worker range and scheduling policy.

use mongodb::bson::DateTime;

const DAY_MS: i64 = 86_400_000;

/// Start of the timestamp's UTC day, matching JS Date.UTC calendar truncation.
/// Euclidean division floors pre-epoch timestamps into the preceding day.
pub fn utc_midnight(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis().div_euclid(DAY_MS) * DAY_MS)
}

/// Start of an inclusive `days`-calendar-day range containing today's UTC day.
/// This is calendar arithmetic only: no validation or exclusive end is added.
/// In particular, zero days retains the existing next-midnight result.
pub fn inclusive_day_start(days: u32, now: DateTime) -> DateTime {
    DateTime::from_millis(utc_midnight(now).timestamp_millis() - (i64::from(days) - 1) * DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midnight_floors_both_sides_of_the_epoch() {
        for (timestamp, midnight) in [
            (-DAY_MS - 1, -2 * DAY_MS),
            (-DAY_MS, -DAY_MS),
            (-1, -DAY_MS),
            (0, 0),
            (DAY_MS - 1, 0),
            (DAY_MS, DAY_MS),
        ] {
            assert_eq!(
                utc_midnight(DateTime::from_millis(timestamp)).timestamp_millis(),
                midnight
            );
        }
    }

    #[test]
    fn inclusive_days_preserve_zero_one_and_pre_epoch_ranges() {
        let now = DateTime::from_millis(-1);
        assert_eq!(inclusive_day_start(0, now).timestamp_millis(), 0);
        assert_eq!(inclusive_day_start(1, now).timestamp_millis(), -DAY_MS);
        assert_eq!(inclusive_day_start(7, now).timestamp_millis(), -7 * DAY_MS);
        assert_eq!(
            inclusive_day_start(30, now).timestamp_millis(),
            -30 * DAY_MS
        );
    }

    #[test]
    fn inclusive_calendar_days_cross_leap_day_at_utc_midnight() {
        let now = DateTime::parse_rfc3339_str("2024-03-01T23:45:00Z").unwrap();
        let start = DateTime::parse_rfc3339_str("2024-02-29T00:00:00Z").unwrap();
        assert_eq!(inclusive_day_start(2, now), start);
    }
}
