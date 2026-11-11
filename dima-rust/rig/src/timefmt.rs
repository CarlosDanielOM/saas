//! Dates without a date library: ISO 8601 parsing/formatting (JavaScript `toISOString` shape),
//! civil-day arithmetic, and the rig's offset syntax (`+60s`, `-5m`, `150ms`).

use std::time::{SystemTime, UNIX_EPOCH};

pub const MS_PER_DAY: i64 = 86_400_000;

/// Wall-clock milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let d = i64::from(d);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`].
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (
        y,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ`, as JavaScript's `Date.prototype.toISOString` (years 0 to 9999).
/// Returns `None` outside that range.
pub fn format_iso_ms(ms: i64) -> Option<String> {
    let days = ms.div_euclid(MS_PER_DAY);
    let rem = ms.rem_euclid(MS_PER_DAY);
    let (y, mo, d) = civil_from_days(days);
    if !(0..=9999).contains(&y) {
        return None;
    }
    let h = rem / 3_600_000;
    let mi = (rem / 60_000) % 60;
    let s = (rem / 1000) % 60;
    let frac = rem % 1000;
    Some(format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{frac:03}Z"
    ))
}

/// `YYYY-MM-DD` of a day number.
pub fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn digits(b: &[u8], at: usize, n: usize) -> Option<i64> {
    let part = b.get(at..at + n)?;
    let mut v: i64 = 0;
    for c in part {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + i64::from(c - b'0');
    }
    Some(v)
}

fn valid_date(y: i64, m: i64, d: i64) -> bool {
    if !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    d <= max
}

/// Day number of a `YYYY-MM-DD` string (exactly that, nothing more).
pub fn parse_day(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (y, m, d) = (digits(b, 0, 4)?, digits(b, 5, 2)?, digits(b, 8, 2)?);
    if !valid_date(y, m, d) {
        return None;
    }
    Some(days_from_civil(
        y,
        u32::try_from(m).ok()?,
        u32::try_from(d).ok()?,
    ))
}

/// Milliseconds since the epoch of an ISO 8601 date-time:
/// `YYYY-MM-DD[T| ]HH:MM[:SS[.fraction]][Z|±HH[:]MM]`. A missing zone means UTC.
/// Fractions beyond milliseconds are truncated. Returns `None` for anything else.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 16 {
        return None;
    }
    let day = parse_day(s.get(0..10)?)?;
    if !matches!(b.get(10), Some(b'T' | b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let h = digits(b, 11, 2)?;
    let mi = digits(b, 14, 2)?;
    let mut i = 16;
    let mut sec = 0;
    let mut ms = 0;
    if b.get(i) == Some(&b':') {
        sec = digits(b, i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            let n = i - start;
            if n == 0 || n > 9 {
                return None;
            }
            let mut frac = digits(b, start, n.min(3))?;
            for _ in n..3 {
                frac *= 10;
            }
            ms = frac;
        }
    }
    if h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let mut offset_min = 0;
    match b.get(i) {
        None => {}
        Some(b'Z') => i += 1,
        Some(sign @ (b'+' | b'-')) => {
            let oh = digits(b, i + 1, 2)?;
            let om = if b.get(i + 3) == Some(&b':') {
                let v = digits(b, i + 4, 2)?;
                i += 6;
                v
            } else {
                let v = digits(b, i + 3, 2)?;
                i += 5;
                v
            };
            if oh > 23 || om > 59 {
                return None;
            }
            offset_min = (oh * 60 + om) * if *sign == b'-' { -1 } else { 1 };
        }
        Some(_) => return None,
    }
    if i != b.len() {
        return None;
    }
    Some(day * MS_PER_DAY + ((h * 60 + mi - offset_min) * 60 + sec) * 1000 + ms)
}

/// The rig's offset syntax: an optional sign, digits, and a unit (`ms`, `s`, `m`, `h`, `d`).
/// `0` alone is allowed. Examples: `+60s`, `-5m`, `150ms`, `+2d`.
pub fn parse_offset(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "0" {
        return Some(0);
    }
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let split = rest.find(|c: char| !c.is_ascii_digit())?;
    let (num, unit) = rest.split_at(split);
    if num.is_empty() {
        return None;
    }
    let n: i64 = num.parse().ok()?;
    let mult = match unit {
        "ms" => 1,
        "s" => 1000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => MS_PER_DAY,
        _ => return None,
    };
    n.checked_mul(mult).map(|v| v * sign)
}

/// `+153ms` / `-20ms` / `+0ms`.
pub fn format_offset(ms: i64) -> String {
    if ms < 0 {
        format!("{ms}ms")
    } else {
        format!("+{ms}ms")
    }
}

/// `Δ` written for people: `153ms`, `61.2s`, `3.5d`.
pub fn human_duration(ms: i64) -> String {
    let a = ms.unsigned_abs();
    let sign = if ms < 0 { "-" } else { "" };
    if a < 1000 {
        format!("{sign}{a}ms")
    } else if a < 120_000 {
        format!("{sign}{:.1}s", a as f64 / 1000.0)
    } else if a < 7_200_000 {
        format!("{sign}{:.1}min", a as f64 / 60_000.0)
    } else if a < 172_800_000 {
        format!("{sign}{:.1}h", a as f64 / 3_600_000.0)
    } else {
        format!("{sign}{:.1}d", a as f64 / 86_400_000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip_matches_javascript_shape() {
        let ms = 1_794_422_466_300;
        let s = format_iso_ms(ms).unwrap();
        assert_eq!(s, "2026-11-11T18:41:06.300Z"); // node: new Date(1794422466300).toISOString()
        assert_eq!(parse_iso(&s), Some(ms));
        assert_eq!(format_iso_ms(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso_ms(-1).unwrap(), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn iso_variants() {
        let base = parse_iso("2026-11-11T10:00:00.000Z").unwrap();
        assert_eq!(parse_iso("2026-11-11T10:00:00Z"), Some(base));
        assert_eq!(parse_iso("2026-11-11 10:00"), Some(base));
        assert_eq!(parse_iso("2026-11-11T11:00:00+01:00"), Some(base));
        assert_eq!(parse_iso("2026-11-11T09:30:00-0030"), Some(base));
        assert_eq!(
            parse_iso("2026-11-11T10:00:00.123456789Z"),
            Some(base + 123)
        );
        assert_eq!(parse_iso("2026-11-11T10:00:00.5Z"), Some(base + 500));
        assert_eq!(parse_iso("2026-02-30T10:00:00Z"), None);
        assert_eq!(parse_iso("2026-11-11T25:00:00Z"), None);
        assert_eq!(parse_iso("2026-11-11T10:00:00Zjunk"), None);
        assert_eq!(parse_iso("2026-11-11"), None);
    }

    #[test]
    fn days() {
        assert_eq!(parse_day("1970-01-01"), Some(0));
        assert_eq!(
            parse_day("2024-02-29").map(format_day).as_deref(),
            Some("2024-02-29")
        );
        assert_eq!(parse_day("2023-02-29"), None);
    }

    #[test]
    fn offsets() {
        assert_eq!(parse_offset("+60s"), Some(60_000));
        assert_eq!(parse_offset("-5m"), Some(-300_000));
        assert_eq!(parse_offset("150ms"), Some(150));
        assert_eq!(parse_offset("+2d"), Some(2 * MS_PER_DAY));
        assert_eq!(parse_offset("0"), Some(0));
        assert_eq!(parse_offset("5"), None);
        assert_eq!(parse_offset("+s"), None);
        assert_eq!(parse_offset("5w"), None);
        assert_eq!(format_offset(-20), "-20ms");
        assert_eq!(format_offset(0), "+0ms");
    }
}
