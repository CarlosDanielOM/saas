//! Bounded, allocation-free RFC3339 calendar conversion for event contracts.
//! This matches the source contract's strict four-digit-year timestamp syntax.

/// Parse a contract timestamp. Fractions beyond milliseconds are truncated,
/// matching JavaScript Date; UTC offsets are applied before comparison.
pub fn parse_contract_time(value: &str) -> Option<i64> {
    parse_iso_time(value, true)
}

/// `interaction-model.ts` accepts ISO dates with Date.parse's calendar
/// normalization, optional seconds, and UTC/local-without-offset notation.
/// The application uses UTC; explicit offsets are always honored.
pub fn parse_interaction_time(value: &str) -> Option<i64> {
    parse_iso_time(value, false)
}

fn parse_iso_time(value: &str, strict: bool) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    let year = digits(b, 0, 4)?;
    let month = digits(b, 5, 2)?;
    let day = digits(b, 8, 2)?;
    let hour = digits(b, 11, 2)?;
    let minute = digits(b, 14, 2)?;
    let has_seconds = b.get(16) == Some(&b':');
    if strict && !has_seconds {
        return None;
    }
    let second = if has_seconds { digits(b, 17, 2)? } else { 0 };
    // Date.UTC(0..99, month, 0) in the source interprets years as 1900..1999.
    let calendar_year = if year < 100 { year + 1900 } else { year };
    if !(1..=12).contains(&month)
        || day == 0
        || day
            > if strict {
                month_days(calendar_year, month)
            } else {
                31
            }
        || hour > if strict { 23 } else { 24 }
        || minute >= 60
        || second >= 60
    {
        return None;
    }
    let mut cursor = if has_seconds { 19 } else { 16 };
    let mut millis = 0;
    let mut nonzero_fraction = false;
    if b.get(cursor) == Some(&b'.') {
        if !has_seconds {
            return None;
        }
        cursor += 1;
        let start = cursor;
        while b.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        let len = cursor - start;
        if len == 0 || strict && len > 9 {
            return None;
        }
        nonzero_fraction = b[start..cursor].iter().any(|ch| *ch != b'0');
        for i in 0..3 {
            millis = millis * 10
                + if i < len {
                    i64::from(b[start + i] - b'0')
                } else {
                    0
                };
        }
    }
    if hour == 24 && (minute != 0 || second != 0 || nonzero_fraction) {
        return None;
    }
    let offset = match b.get(cursor) {
        None if !strict => {
            return local_millis(
                days_from_civil(year, month, day) * 86_400_000
                    + hour * 3_600_000
                    + minute * 60_000
                    + second * 1000
                    + millis,
            );
        }
        Some(b'Z') if cursor + 1 == b.len() => 0,
        Some(b'z') if !strict && cursor + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if (cursor + 6 == b.len() && b[cursor + 3] == b':')
                || (!strict && cursor + 5 == b.len()) =>
        {
            let h = digits(b, cursor + 1, 2)?;
            let m = digits(b, cursor + if b[cursor + 3] == b':' { 4 } else { 3 }, 2)?;
            if h >= 24 || m >= 60 {
                return None;
            }
            (h * 60 + m) * 60 * 1000 * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    Some(
        days_from_civil(year, month, day) * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1000
            + millis
            - offset,
    )
}

/// V8 chooses the earlier occurrence of a repeated wall time and advances
/// through DST gaps. Ask libc for both DST interpretations, then make that
/// choice explicitly instead of relying on mktime's stateful DST heuristic.
#[cfg(unix)]
fn local_millis(utc_wall_millis: i64) -> Option<i64> {
    let seconds = utc_wall_millis.div_euclid(1000) as _;
    // Both functions write all fields of their caller-owned tm structs.
    let mut wall: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut wall) }.is_null() {
        return None;
    }
    let mut candidates = Vec::with_capacity(2);
    let mut valid = Vec::with_capacity(2);
    for isdst in [0, 1] {
        let mut candidate = wall;
        candidate.tm_isdst = isdst;
        let timestamp = unsafe { libc::mktime(&mut candidate) };
        let mut check: libc::tm = unsafe { std::mem::zeroed() };
        if unsafe { libc::localtime_r(&timestamp, &mut check) }.is_null() {
            continue;
        }
        candidates.push(timestamp as i64);
        if (
            check.tm_year,
            check.tm_mon,
            check.tm_mday,
            check.tm_hour,
            check.tm_min,
            check.tm_sec,
        ) == (
            wall.tm_year,
            wall.tm_mon,
            wall.tm_mday,
            wall.tm_hour,
            wall.tm_min,
            wall.tm_sec,
        ) {
            valid.push(timestamp as i64);
        }
    }
    valid
        .into_iter()
        .min()
        .or_else(|| candidates.into_iter().max())
        .map(|seconds| seconds * 1000 + utc_wall_millis.rem_euclid(1000))
}

#[cfg(not(unix))]
fn local_millis(_utc_wall_millis: i64) -> Option<i64> {
    None
}

fn digits(b: &[u8], start: usize, len: usize) -> Option<i64> {
    let mut value = 0;
    for digit in b.get(start..start + len)? {
        if !digit.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(digit - b'0');
    }
    Some(value)
}

fn month_days(year: i64, month: i64) -> i64 {
    match month {
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

/// JavaScript Date's representable integral millisecond range.
pub fn valid_native_millis(value: i64) -> bool {
    (-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&value)
}

/// Date.toISOString for a valid native JavaScript-compatible millisecond date.
pub fn native_date_iso(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400_000);
    let millis = timestamp.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year >= 0 {
        format!("+{year:06}")
    } else {
        format!("-{y:06}", y = -year)
    };
    format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z",
        hour = millis / 3_600_000,
        minute = (millis / 60_000) % 60,
        second = (millis / 1000) % 60,
        fraction = millis % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamps_preserve_offsets_precision_and_epoch_boundaries() {
        assert_eq!(parse_contract_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_contract_time("1969-12-31T23:59:59.999Z"), Some(-1));
        assert_eq!(
            parse_contract_time("1970-01-01T02:00:00.123456789+02:00"),
            Some(123)
        );
        assert_eq!(
            parse_contract_time("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        for value in [
            "2023-02-29T00:00:00Z",
            "0000-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00:00+24:00",
            "2026-01-01",
            "2026-01-01T00:00:00.Z",
        ] {
            assert_eq!(parse_contract_time(value), None, "{value}");
        }
    }
}
