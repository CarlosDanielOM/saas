//! **Workaround module.** The viewer's time zone for the AI usage page, as `Intl.DateTimeFormat`
//! reads it in the reference (`assertTimeZone`, `formatLocalDate`, the `formatToParts` of
//! `zonedStartOfDay` in `utils/ai_usage_receipts.ts`). No shared crate knows IANA zones yet
//! (`dima_text::date` is UTC only), so this module carries `jiff` with its bundled time zone
//! database. Change wanted: a `Zone` type in `dima-text` (or `dima-core`) next to the UTC date
//! helpers, after which this module goes away.
//!
//! What `Intl` accepts, recorded from Node (ICU 78, tzdb 2026a): any IANA name or link, letters
//! in any case (`america/new_york`, `US/Eastern`, `GMT`), and offsets `±HH`, `±HHMM`, `±HH:MM`;
//! the empty name is UTC (the reference passes `value.trim() || 'UTC'`). `Z` and `UTC+1` are
//! refused. The name the caller gave (trimmed) is what the usage page keeps and sends to
//! MongoDB's `$dateToString`, never ICU's canonical form, as in the reference.
//!
//! Intended difference: the zone list is the IANA database bundled with `jiff`, where the
//! reference used ICU's copy of it; the two agree on every canonical name and link, and differ
//! only on names ICU adds or drops on its own (none that a browser reports).

use jiff::Timestamp;
use jiff::tz::{Offset, TimeZone};

/// A time zone the usage page accepts.
#[derive(Clone)]
pub struct Zone {
    name: String,
    zone: TimeZone,
}

impl std::fmt::Debug for Zone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Zone").field(&self.name).finish()
    }
}

impl PartialEq for Zone {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

/// `Invalid timezone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid timezone")]
pub struct InvalidTimeZone;

/// A wall-clock time in a zone, to the second (what `formatToParts` gives with `hourCycle: h23`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    /// Year.
    pub year: i64,
    /// Month, 1 to 12.
    pub month: i64,
    /// Day, 1 to 31.
    pub day: i64,
    /// Hour, 0 to 23.
    pub hour: i64,
    /// Minute.
    pub minute: i64,
    /// Second.
    pub second: i64,
}

/// `±HH`, `±HHMM` or `±HH:MM` (ECMA-402's offset time zones), in seconds.
fn offset_seconds(text: &str) -> Option<i32> {
    let bytes = text.as_bytes();
    let (sign, rest) = match bytes.split_first()? {
        (b'+', rest) => (1, rest),
        (b'-', rest) => (-1, rest),
        _ => return None,
    };
    let digits = |pair: &[u8]| -> Option<i32> {
        match pair {
            [a, b] if a.is_ascii_digit() && b.is_ascii_digit() => {
                Some(i32::from(a - b'0') * 10 + i32::from(b - b'0'))
            }
            _ => None,
        }
    };
    let (hours, minutes) = match rest {
        [h1, h2] => (digits(&[*h1, *h2])?, 0),
        [h1, h2, m1, m2] => (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?),
        [h1, h2, b':', m1, m2] => (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?),
        _ => return None,
    };
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 3600 + minutes * 60))
}

impl Zone {
    /// UTC.
    pub fn utc() -> Self {
        Self {
            name: "UTC".to_owned(),
            zone: TimeZone::UTC,
        }
    }

    /// `assertTimeZone(value)`: the text trimmed (JavaScript's whitespace), `UTC` when empty.
    pub fn parse(value: &str) -> Result<Self, InvalidTimeZone> {
        let trimmed = dima_text::trim(value);
        let name = if trimmed.is_empty() { "UTC" } else { trimmed };
        let zone = match offset_seconds(name) {
            Some(seconds) => {
                TimeZone::fixed(Offset::from_seconds(seconds).map_err(|_| InvalidTimeZone)?)
            }
            None => {
                // Names are ASCII in the database; anything else is not one.
                if !name.is_ascii() {
                    return Err(InvalidTimeZone);
                }
                jiff::tz::db().get(name).map_err(|_| InvalidTimeZone)?
            }
        };
        Ok(Self {
            name: name.to_owned(),
            zone,
        })
    }

    /// The name as given (trimmed).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The wall-clock time at `ms` (milliseconds dropped, as `formatToParts` shows seconds).
    pub fn local(&self, ms: i64) -> Option<LocalTime> {
        let stamp = Timestamp::from_millisecond(ms).ok()?;
        let civil = self.zone.to_datetime(stamp);
        Some(LocalTime {
            year: i64::from(civil.year()),
            month: i64::from(civil.month()),
            day: i64::from(civil.day()),
            hour: i64::from(civil.hour()),
            minute: i64::from(civil.minute()),
            second: i64::from(civil.second()),
        })
    }

    /// `formatLocalDate(date, timeZone)`: `YYYY-MM-DD` of the wall-clock date (`en-CA`).
    pub fn local_date(&self, ms: i64) -> Option<String> {
        let local = self.local(ms)?;
        Some(format!(
            "{:04}-{:02}-{:02}",
            local.year, local.month, local.day
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intl_names_and_offsets() {
        for (given, kept) in [
            ("UTC", "UTC"),
            ("utc", "utc"),
            ("", "UTC"),
            (" America/New_York\u{feff}", "America/New_York"),
            ("america/new_york", "america/new_york"),
            ("US/Eastern", "US/Eastern"),
            ("GMT", "GMT"),
            ("Etc/GMT+5", "Etc/GMT+5"),
            ("Asia/Calcutta", "Asia/Calcutta"),
            ("Europe/Kyiv", "Europe/Kyiv"),
            ("+05:30", "+05:30"),
            ("+0530", "+0530"),
            ("-08", "-08"),
        ] {
            assert_eq!(
                Zone::parse(given).map(|z| z.name().to_owned()),
                Ok(kept.to_owned())
            );
        }
        for refused in [
            "Mars/Olympus",
            "Z",
            "UTC+1",
            "+24:00",
            "+05:60",
            "+5",
            "Ámérica/X",
        ] {
            assert_eq!(Zone::parse(refused), Err(InvalidTimeZone), "{refused}");
        }
    }

    #[test]
    fn local_dates_follow_the_zone() {
        // 2026-03-08T07:30:00Z, recorded from Node.
        let at = 1_772_955_000_000;
        assert_eq!(Zone::utc().local_date(at).as_deref(), Some("2026-03-08"));
        let zone = Zone::parse("-08:00").unwrap();
        assert_eq!(zone.local_date(at).as_deref(), Some("2026-03-07"));
        let new_york = Zone::parse("America/New_York").unwrap();
        assert_eq!(
            new_york.local(at),
            Some(LocalTime {
                year: 2026,
                month: 3,
                day: 8,
                hour: 3,
                minute: 30,
                second: 0
            })
        );
    }
}
