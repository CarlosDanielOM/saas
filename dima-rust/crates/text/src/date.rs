//! JavaScript `Date` arithmetic and text. Times are epoch milliseconds as `i64`, the canonical
//! time value across the workspace; every function here works in UTC.

/// Milliseconds in a day.
pub const MS_PER_DAY: i64 = 86_400_000;

/// The largest distance from the epoch a JavaScript `Date` can hold (±100,000,000 days).
pub const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// A time split into the fields JavaScript's `getUTC*` methods report, with their numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct UtcFields {
    /// `getUTCFullYear()`: astronomical year (0 is 1 BC).
    pub year: i64,
    /// `getUTCMonth()`: 0 = January … 11 = December.
    pub month: u32,
    /// `getUTCDate()`: 1 to 31.
    pub day: u32,
    /// `getUTCHours()`: 0 to 23.
    pub hour: u32,
    /// `getUTCMinutes()`.
    pub minute: u32,
    /// `getUTCSeconds()`.
    pub second: u32,
    /// `getUTCMilliseconds()`.
    pub millisecond: u32,
    /// `getUTCDay()`: 0 = Sunday … 6 = Saturday.
    pub weekday: u32,
}

/// The UTC fields of `ms`, or `None` outside the JavaScript `Date` range.
pub fn utc_fields(ms: i64) -> Option<UtcFields> {
    if !(-MAX_TIME_MS..=MAX_TIME_MS).contains(&ms) {
        return None;
    }
    let days = ms.div_euclid(MS_PER_DAY);
    let time = ms.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    Some(UtcFields {
        year,
        month: month - 1,
        day,
        hour: (time / 3_600_000) as u32,
        minute: (time / 60_000 % 60) as u32,
        second: (time / 1000 % 60) as u32,
        millisecond: (time % 1000) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
    })
}

/// Start of the UTC day containing `ms` (floors before the epoch too), or `None` outside the
/// JavaScript `Date` range.
pub fn utc_day_start(ms: i64) -> Option<i64> {
    if !(-MAX_TIME_MS..=MAX_TIME_MS).contains(&ms) {
        return None;
    }
    Some(ms.div_euclid(MS_PER_DAY) * MS_PER_DAY)
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The parts V8's date text is made of: weekday and month names, and the year as V8 writes it
/// outside ISO text (at least four digits, a minus sign before year 0: `0001`, `-0001`, `275760`).
fn text_parts(f: &UtcFields) -> Option<(&'static str, &'static str, String)> {
    let weekday = DAY_NAMES.get(f.weekday as usize)?;
    let month = MONTH_NAMES.get(f.month as usize)?;
    let sign = if f.year < 0 { "-" } else { "" };
    Some((
        weekday,
        month,
        format!("{sign}{:04}", f.year.unsigned_abs()),
    ))
}

/// `new Date(ms).toDateString()` in UTC (the services run in UTC): `Wed Nov 11 2026`.
///
/// Years print with at least four digits and a minus sign before year 0 (`0001`, `-0001`,
/// `275760`). `None` where JavaScript prints `Invalid Date` (outside the `Date` range).
pub fn to_date_string_utc(ms: i64) -> Option<String> {
    let f = utc_fields(ms)?;
    let (weekday, month, year) = text_parts(&f)?;
    Some(format!("{weekday} {month} {:02} {year}", f.day))
}

/// `new Date(ms).toString()` with the process time zone set to UTC, as the services run:
/// `Wed Nov 11 2026 15:04:05 GMT+0000 (Coordinated Universal Time)`.
///
/// Only UTC is supported: in another zone the offset and the zone's ICU display name would
/// change, and no service runs in one. Years as in [`to_date_string_utc`]. `None` where
/// JavaScript prints `Invalid Date`.
pub fn to_string_utc(ms: i64) -> Option<String> {
    let f = utc_fields(ms)?;
    let (weekday, month, year) = text_parts(&f)?;
    Some(format!(
        "{weekday} {month} {:02} {year} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        f.day, f.hour, f.minute, f.second
    ))
}

/// `new Date(ms).toUTCString()` (the HTTP date form for years 0 to 9999):
/// `Wed, 11 Nov 2026 15:04:05 GMT`. Years as in [`to_date_string_utc`] (`-0001`, not
/// `-000001`). `None` where JavaScript prints `Invalid Date`.
pub fn to_utc_string(ms: i64) -> Option<String> {
    let f = utc_fields(ms)?;
    let (weekday, month, year) = text_parts(&f)?;
    Some(format!(
        "{weekday}, {:02} {month} {year} {:02}:{:02}:{:02} GMT",
        f.day, f.hour, f.minute, f.second
    ))
}

/// `new Date(ms).toISOString()`, including `+YYYYYY`/`-YYYYYY` years; `None` where JavaScript
/// throws (outside the `Date` range).
pub fn to_iso_string(ms: i64) -> Option<String> {
    let f = utc_fields(ms)?;
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else {
        format!(
            "{}{:06}",
            if f.year < 0 { '-' } else { '+' },
            f.year.unsigned_abs()
        )
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        f.month + 1,
        f.day,
        f.hour,
        f.minute,
        f.second,
        f.millisecond
    ))
}

/// `new Date(ms).toLocaleString('en-US', { timeZone: 'UTC' })`, e.g. `11/11/2026, 3:04:05 PM`.
///
/// Node 26 writes plain spaces (not U+202F) and, for years ≤ 0, the era year without an era
/// (year 0 is `1`, year -1 is `2`). `None` where JavaScript writes `Invalid Date`.
pub fn to_locale_string_en_us_utc(ms: i64) -> Option<String> {
    let f = utc_fields(ms)?;
    let year = if f.year <= 0 { 1 - f.year } else { f.year };
    let hour = match f.hour % 12 {
        0 => 12,
        hour => hour,
    };
    let half = if f.hour < 12 { "AM" } else { "PM" };
    Some(format!(
        "{}/{}/{year}, {hour}:{:02}:{:02} {half}",
        f.month + 1,
        f.day,
        f.minute,
        f.second
    ))
}

/// `Date.UTC(year, month, day, hour, minute, second, millisecond)`; `None` where it is NaN.
///
/// Fields overflow into the next larger unit (month 12 is January of the next year, day 0 the
/// last day of the previous month), years 0 to 99 mean 1900 to 1999, and V8's limits apply
/// (|year| ≤ 1,000,000, |month| ≤ 10,000,000, result within [`MAX_TIME_MS`]).
pub fn date_utc(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millisecond: i64,
) -> Option<i64> {
    let year = if (0..=99).contains(&year) {
        1900 + year
    } else {
        year
    };
    let day = make_day(year, month, day)?;
    let time = i128::from(hour) * 3_600_000
        + i128::from(minute) * 60_000
        + i128::from(second) * 1000
        + i128::from(millisecond);
    time_clip(day * i128::from(MS_PER_DAY) + time)
}

/// `Date.parse(text)` for the forms the services exchange; `None` where the result is NaN or the
/// form is not one of these.
///
/// - The ECMAScript date-time format exactly as V8 reads it: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
///   `±YYYYYY…`, optionally `THH:mm`, `:ss`, `.fraction` (any number of digits, cut to
///   milliseconds), and `Z`, `±HH:mm` or `±HHmm`; `T` and `Z` in either case; hour 24 only as
///   end of day. Days up to 31 are accepted in any month and overflow. A form without an offset
///   is read as UTC: date-only forms are UTC in JavaScript, and date-time forms are local time,
///   which is UTC on the servers.
/// - HTTP dates: `Sun, 06 Nov 1994 08:49:37 GMT`, `Sunday, 06-Nov-94 08:49:37 GMT` and
///   `Sun Nov  6 08:49:37 1994`, with V8's leniency for these shapes (any or no weekday name,
///   seconds optional, zone `GMT`/`UTC`/`UT`/`Z`/`±hhmm` or none, two-digit years 50–99 as 19xx
///   and 00–49 as 20xx).
///
/// V8's legacy fallback accepts much more (`2026-11-11 15:04`, `11/11/2026`, `0` as the year
/// 2000…); those inputs return `None` here.
pub fn parse_date(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    parse_iso(bytes).or_else(|| parse_http(bytes))
}

/// The day number of `year`-`month`-`day` after V8's `MakeDay` (month 0-based, with overflow).
fn make_day(year: i64, month: i64, day: i64) -> Option<i128> {
    if !(-1_000_000..=1_000_000).contains(&year) || !(-10_000_000..=10_000_000).contains(&month) {
        return None;
    }
    let year = year + month.div_euclid(12);
    let month = month.rem_euclid(12) as u32 + 1;
    Some(i128::from(days_from_civil(year, month, 1)) + i128::from(day) - 1)
}

/// TimeClip: `None` outside ±[`MAX_TIME_MS`].
fn time_clip(ms: i128) -> Option<i64> {
    i64::try_from(ms)
        .ok()
        .filter(|ms| (-MAX_TIME_MS..=MAX_TIME_MS).contains(ms))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1–12).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Proleptic Gregorian (year, month 1–12, day) of a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = (if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    }) as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A maximal run of ASCII digits, as V8's date scanner reads it.
#[derive(Clone, Copy)]
struct Digits {
    /// The value of the first nine significant digits (leading zeros skipped).
    value: u32,
    /// Every digit in the run, leading zeros included.
    len: usize,
}

/// A cursor over the input bytes.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    fn eat_ignore_case(&mut self, lower: u8) -> bool {
        let found = self
            .peek()
            .is_some_and(|byte| byte.to_ascii_lowercase() == lower);
        if found {
            self.at += 1;
        }
        found
    }

    fn digits(&mut self) -> Option<Digits> {
        let run = self.bytes.get(self.at..)?;
        let len = run.iter().take_while(|byte| byte.is_ascii_digit()).count();
        if len == 0 {
            return None;
        }
        let value = run
            .iter()
            .take(len)
            .skip_while(|byte| **byte == b'0')
            .take(9)
            .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'));
        self.at += len;
        Some(Digits { value, len })
    }

    /// A run of exactly `len` digits.
    fn fixed(&mut self, len: usize) -> Option<u32> {
        let start = self.at;
        match self.digits() {
            Some(run) if run.len == len => Some(run.value),
            _ => {
                self.at = start;
                None
            }
        }
    }

    fn at_end(&self) -> bool {
        self.at >= self.bytes.len()
    }
}

/// V8's ES5 ISO path. Inputs it hands to the legacy parser are rejected here.
fn parse_iso(bytes: &[u8]) -> Option<i64> {
    let mut cursor = Cursor { bytes, at: 0 };
    let year = match cursor.peek()? {
        sign @ (b'+' | b'-') => {
            cursor.at += 1;
            let year = i64::from(cursor.fixed(6)?);
            if sign == b'-' {
                if year == 0 {
                    return None;
                }
                -year
            } else {
                year
            }
        }
        _ => i64::from(cursor.fixed(4)?),
    };
    let mut month = 1;
    let mut day = 1;
    if cursor.eat(b'-') {
        month = cursor.fixed(2).filter(|month| (1..=12).contains(month))?;
        if cursor.eat(b'-') {
            day = cursor.fixed(2).filter(|day| (1..=31).contains(day))?;
        }
    }
    let mut time = 0;
    let mut offset_minutes = 0;
    if !cursor.at_end() {
        if !cursor.eat_ignore_case(b't') {
            return None;
        }
        let hour = cursor.fixed(2).filter(|hour| *hour <= 24)?;
        let limit = if hour == 24 { 0 } else { 59 };
        if !cursor.eat(b':') {
            return None;
        }
        let minute = cursor.fixed(2).filter(|minute| *minute <= limit)?;
        let mut second = 0;
        let mut millisecond = 0;
        if cursor.eat(b':') {
            second = cursor.fixed(2).filter(|second| *second <= limit)?;
            if cursor.eat(b'.') {
                let fraction = cursor
                    .digits()
                    .filter(|fraction| hour < 24 || fraction.value == 0)?;
                millisecond = milliseconds(fraction);
            }
        }
        time = ((i64::from(hour) * 60 + i64::from(minute)) * 60 + i64::from(second)) * 1000
            + i64::from(millisecond);
        if !cursor.eat_ignore_case(b'z')
            && let Some(sign @ (b'+' | b'-')) = cursor.peek()
        {
            cursor.at += 1;
            let (hours, minutes) = if let Some(hhmm) = cursor.fixed(4) {
                (hhmm / 100, hhmm % 100)
            } else {
                let hours = cursor.fixed(2)?;
                if !cursor.eat(b':') {
                    return None;
                }
                (hours, cursor.fixed(2)?)
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            let minutes = i64::from(hours * 60 + minutes);
            offset_minutes = if sign == b'+' { minutes } else { -minutes };
        }
        if !cursor.at_end() {
            return None;
        }
    }
    compose(
        year,
        i64::from(month) - 1,
        i64::from(day),
        time,
        offset_minutes,
    )
}

/// V8's `ReadMilliseconds`: the first three significant digits of a fraction, scaled by its
/// length (capped at nine digits, so leading zeros beyond that are lost, as in V8).
fn milliseconds(fraction: Digits) -> u32 {
    match fraction.len {
        1 => fraction.value * 100,
        2 => fraction.value * 10,
        3 => fraction.value,
        len => fraction.value / 10u32.pow(len.min(9) as u32 - 3),
    }
}

/// HTTP-date forms (RFC 9110 section 5.6.7) with V8's legacy-parser results for them.
fn parse_http(bytes: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut words: Vec<&str> = text.split(' ').filter(|word| !word.is_empty()).collect();
    if let Some(first) = words.first() {
        let name = first
            .strip_suffix(',')
            .unwrap_or(first)
            .to_ascii_lowercase();
        if WEEKDAYS
            .iter()
            .any(|(short, long)| name == *short || name == *long)
        {
            words.remove(0);
        }
    }
    let (day, month, year, time, zone) = match words.as_slice() {
        [date, time, zone @ ..] if date.contains('-') => {
            let mut parts = date.split('-');
            let (day, month, year) = (parts.next()?, parts.next()?, parts.next()?);
            if parts.next().is_some() {
                return None;
            }
            (day, month, year, *time, zone)
        }
        [month, day, time, year, zone @ ..] if month_index(month).is_some() => {
            (*day, *month, *year, *time, zone)
        }
        [day, month, year, time, zone @ ..] => (*day, *month, *year, *time, zone),
        _ => return None,
    };
    let day = number(day, 1..=2).filter(|day| (1..=31).contains(day))?;
    let month = month_index(month)?;
    let year = match year.len() {
        2 | 4 => number(year, 2..=4)?,
        _ => return None,
    };
    let year = match year {
        0..=49 => year + 2000,
        50..=99 => year + 1900,
        _ => year,
    };
    let time = clock(time)?;
    let offset_minutes = match zone {
        [] => 0,
        [zone] => zone_minutes(zone)?,
        _ => return None,
    };
    compose(i64::from(year), month, i64::from(day), time, offset_minutes)
}

const WEEKDAYS: [(&str, &str); 7] = [
    ("sun", "sunday"),
    ("mon", "monday"),
    ("tue", "tuesday"),
    ("wed", "wednesday"),
    ("thu", "thursday"),
    ("fri", "friday"),
    ("sat", "saturday"),
];

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// 0-based month of a three-letter English month name, any case.
fn month_index(word: &str) -> Option<i64> {
    let word = word.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|month| *month == word)
        .map(|index| index as i64)
}

/// An unsigned decimal of `len` digits.
fn number(word: &str, len: std::ops::RangeInclusive<usize>) -> Option<u32> {
    if !len.contains(&word.len()) || !word.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    word.parse().ok()
}

/// `HH:MM` or `HH:MM:SS` in milliseconds; 24:00(:00) is the end of the day.
fn clock(word: &str) -> Option<i64> {
    let mut fields = word.split(':');
    let hour = number(fields.next()?, 2..=2)?;
    let minute = number(fields.next()?, 2..=2)?;
    let second = match fields.next() {
        Some(second) => number(second, 2..=2)?,
        None => 0,
    };
    if fields.next().is_some()
        || minute > 59
        || second > 59
        || hour > 24
        || (hour == 24 && minute + second > 0)
    {
        return None;
    }
    Some(i64::from((hour * 60 + minute) * 60 + second) * 1000)
}

/// Offset east of UTC in minutes. V8 does not range-check `±hhmm` here.
fn zone_minutes(word: &str) -> Option<i64> {
    match word.to_ascii_lowercase().as_str() {
        "gmt" | "utc" | "ut" | "z" => return Some(0),
        _ => {}
    }
    let (sign, digits) = match word.as_bytes().first()? {
        b'+' => (1, word.get(1..)?),
        b'-' => (-1, word.get(1..)?),
        _ => return None,
    };
    let hhmm = i64::from(number(digits, 4..=4)?);
    Some(sign * (hhmm / 100 * 60 + hhmm % 100))
}

/// Date fields (month 0-based) plus time of day and offset, to epoch milliseconds.
fn compose(year: i64, month: i64, day: i64, time: i64, offset_minutes: i64) -> Option<i64> {
    let day = make_day(year, month, day)?;
    time_clip(day * i128::from(MS_PER_DAY) + i128::from(time) - i128::from(offset_minutes) * 60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from `dashboard_emote_catalog::javascript_iso` tests.
    #[test]
    fn iso_strings_keep_three_fraction_digits_and_extended_years() {
        assert_eq!(
            to_iso_string(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(120).as_deref(),
            Some("1970-01-01T00:00:00.120Z")
        );
        assert_eq!(
            to_iso_string(-1).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            to_iso_string(253_402_300_800_000).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(-62_198_755_200_000).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(to_iso_string(MAX_TIME_MS + 1), None);
    }

    // Ported from `dashboard_emote_catalog::parse_checked` (date-only cache values).
    #[test]
    fn date_only_values_are_utc_midnight() {
        assert_eq!(parse_date("2026-10-21"), Some(1_792_540_800_000));
        assert_eq!(parse_date("2026-10-21T00:00:00Z"), Some(1_792_540_800_000));
        assert_eq!(parse_date("bad"), None);
    }

    // Ported from `ai_usage_receipts::queue::logger_timestamp_uses_existing_en_us_utc_contract`.
    #[test]
    fn logger_timestamps_use_the_en_us_shape() {
        let at = |text| parse_date(text).and_then(to_locale_string_en_us_utc);
        assert_eq!(
            at("2026-10-21T13:05:06Z").as_deref(),
            Some("10/21/2026, 1:05:06 PM")
        );
        assert_eq!(
            at("2026-10-21T00:00:00Z").as_deref(),
            Some("10/21/2026, 12:00:00 AM")
        );
    }

    // Ported from `utc_time::midnight_floors_both_sides_of_the_epoch`.
    #[test]
    fn day_starts_floor_both_sides_of_the_epoch() {
        for (ms, start) in [
            (-MS_PER_DAY - 1, -2 * MS_PER_DAY),
            (-MS_PER_DAY, -MS_PER_DAY),
            (-1, -MS_PER_DAY),
            (0, 0),
            (MS_PER_DAY - 1, 0),
            (MS_PER_DAY, MS_PER_DAY),
        ] {
            assert_eq!(utc_day_start(ms), Some(start));
        }
        assert_eq!(
            parse_date("2024-02-29T00:00:00Z"),
            parse_date("2024-03-01T23:45:00Z")
                .and_then(utc_day_start)
                .map(|start| start - MS_PER_DAY)
        );
        // Outside the Date range there is no day to floor to (and the product would overflow).
        assert_eq!(utc_day_start(i64::MIN), None);
        assert_eq!(utc_day_start(i64::MAX), None);
        assert_eq!(utc_day_start(MAX_TIME_MS), Some(MAX_TIME_MS));
        assert_eq!(utc_day_start(-MAX_TIME_MS), Some(-MAX_TIME_MS));
    }

    #[test]
    fn date_strings_print_the_utc_day() {
        assert_eq!(to_date_string_utc(0).as_deref(), Some("Thu Jan 01 1970"));
        assert_eq!(to_date_string_utc(-1).as_deref(), Some("Wed Dec 31 1969"));
        assert_eq!(
            to_date_string_utc(-62_198_755_200_000).as_deref(),
            Some("Fri Jan 01 -0001")
        );
        assert_eq!(to_date_string_utc(MAX_TIME_MS + 1), None);
    }

    // Ported from `dashboard_insights::weekday` (JavaScript getUTCDay numbering).
    #[test]
    fn weekdays_start_on_sunday() {
        assert_eq!(utc_fields(0).map(|f| f.weekday), Some(4));
        assert_eq!(utc_fields(-1).map(|f| f.weekday), Some(3));
        assert_eq!(
            parse_date("2026-11-08")
                .and_then(utc_fields)
                .map(|f| f.weekday),
            Some(0)
        );
    }

    #[test]
    fn date_utc_overflows_fields_and_maps_two_digit_years() {
        assert_eq!(date_utc(2026, 12, 1, 0, 0, 0, 0), parse_date("2027-01-01"));
        assert_eq!(date_utc(2026, 0, 0, 0, 0, 0, 0), parse_date("2025-12-31"));
        assert_eq!(date_utc(99, 0, 1, 0, 0, 0, 0), parse_date("1999-01-01"));
        assert_eq!(date_utc(275_760, 8, 13, 0, 0, 0, 1), None);
        assert_eq!(date_utc(i64::MAX, 0, 1, 0, 0, 0, 0), None);
        assert_eq!(date_utc(2000, 0, i64::MAX, i64::MIN, 0, 0, 0), None);
    }
}
