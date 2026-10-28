// Copyright 2011-2012 the V8 project authors. All rights reserved.
// Portions translated from V8; see LICENSE.v8 in this directory.

//! Native compatibility with the `Date.parse` implementation bundled with
//! Node 24.22.1 (V8 13.6.233.17-node.58).
//!
//! This accepts V8's ISO and legacy date grammar, rather than validating an
//! application timestamp contract. Date-only ISO forms use UTC; ISO times
//! without an offset and legacy dates without a timezone use the process's
//! local timezone. The local timezone implementation is in `local_time`.
//!
//! The scanner deliberately operates on UTF-16 code units and treats NUL as
//! end of input, just like V8's `InputReader`. In particular, this must not
//! trim input or replace unpaired surrogates before scanning it.

mod local_time;
mod parser;

const MILLIS_PER_DAY: i64 = 86_400_000;
const MAX_TIME: i64 = 8_640_000_000_000_000;
const MAX_TIME_BEFORE_UTC: i64 = MAX_TIME + 30 * MILLIS_PER_DAY;

/// Parse a Rust string with V8's `Date.parse` rules, returning integral Unix
/// milliseconds, or `None` for an invalid or TimeClip-rejected date.
///
/// Neither the ASCII path nor the UTF-8-to-UTF-16 iterator allocates.
pub fn parse_date(value: &str) -> Option<i64> {
    if value.is_ascii() {
        parse_units(value.bytes().map(u16::from))
    } else {
        parse_units(value.encode_utf16())
    }
}

/// Parse JavaScript UTF-16 directly, preserving unpaired surrogates and NUL.
pub fn parse_date_utf16(value: &[u16]) -> Option<i64> {
    parse_units(value.iter().copied())
}

fn parse_units(units: impl Iterator<Item = u16>) -> Option<i64> {
    let parsed = parser::parse(units)?;
    // V8's MakeDay rejects years outside this range before TimeClip. The
    // scanner and composer have already restricted month and day to 1..12
    // and 1..31; excess days within that range intentionally roll forward.
    if !(-1_000_000..=1_000_000).contains(&parsed.year) {
        return None;
    }
    let wall_millis = days_from_civil(
        i64::from(parsed.year),
        i64::from(parsed.month),
        i64::from(parsed.day),
    ) * MILLIS_PER_DAY
        + i64::from(parsed.hour) * 3_600_000
        + i64::from(parsed.minute) * 60_000
        + i64::from(parsed.second) * 1000
        + i64::from(parsed.millisecond);
    let utc_millis = if let Some(offset_seconds) = parsed.offset_seconds {
        wall_millis - i64::from(offset_seconds) * 1000
    } else {
        if !(-MAX_TIME_BEFORE_UTC..=MAX_TIME_BEFORE_UTC).contains(&wall_millis) {
            return None;
        }
        local_time::to_utc_millis(wall_millis)?
    };
    (-MAX_TIME..=MAX_TIME)
        .contains(&utc_millis)
        .then_some(utc_millis)
}

// Proleptic Gregorian conversion, using the same arithmetic as the existing
// domain-event calendar utility. Keeping this dependency-free allows the
// js-date feature to compile without domain-events and its application graph.
fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let march_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * march_month + 2) / 5 + day - 1;
    era * 146097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719468
}
