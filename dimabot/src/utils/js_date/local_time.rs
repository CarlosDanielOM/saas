//! Linux local-wall-time conversion for JavaScript date parsing.
//!
//! Node's default V8/ICU path asks ICU for the *former* offset for both
//! nonexistent and duplicated local times. See Node v24.22.1's
//! `deps/v8/src/objects/intl-objects.cc` (`ICUTimezoneCache::GetOffsets`) and
//! ICU's `UTimeZoneLocalOption` documentation. Thus an overlap uses its
//! earliest instant and a gap advances by the size of the offset change.
//! This is independent of whether the transition changes the DST flag.
//!
//! This adapter uses libc's configured zone and installed zoneinfo instead of
//! ICU's bundled data. It requires matching, sufficiently complete tzdata for
//! named zones (notably in minimal Alpine images) and cannot guarantee parity
//! when zone names, historical data, future rules, or tzdata versions differ.
//! The process must configure its timezone before concurrent use; this module
//! never changes `TZ`, and it must remain fixed after the first conversion.
//! Explicit `TZ=UTC` uses a zero-offset fast path, assuming the conventional
//! UTC definition rather than a custom replacement zoneinfo file named UTC.
//! Unsupported platforms or libc failures return `None`.
//!
//! The six-hour sampling interval assumes an offset regime around the requested
//! local time lasts at least six hours, and offsets are within one day. These
//! bounds cover ordinary IANA transitions, including historical second offsets
//! and 24-hour skips, but arbitrary TZ files need not satisfy them. Unlike
//! V8's non-ICU fallback, its default ICU local-to-UTC path does not apply
//! `EquivalentTime` to far years; neither does this adapter.

#[cfg(target_os = "linux")]
pub(super) fn to_utc_millis(wall_millis: i64) -> Option<i64> {
    const HOUR: i64 = 3_600;
    const MAX_OFFSET: i64 = 24 * HOUR;
    const STEP: i64 = 6 * HOUR;
    const SAMPLES: usize = 17;

    static EXPLICIT_UTC: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *EXPLICIT_UTC
        .get_or_init(|| std::env::var_os("TZ").as_deref() == Some(std::ffi::OsStr::new("UTC")))
    {
        return Some(wall_millis);
    }

    let wall_seconds = wall_millis.div_euclid(1_000);
    let millis = wall_millis.rem_euclid(1_000);
    let mut offsets = [0_i64; SAMPLES];
    let mut count = 0;

    // The possible UTC instant lies within a day of the wall value. Sampling
    // another day on either side exposes both regimes even for a 24-hour jump.
    for index in 0..SAMPLES {
        let sample = wall_seconds.checked_add((index as i64 - 8) * STEP)?;
        let offset = offset_at(sample)?;
        if offset.checked_abs()? > MAX_OFFSET {
            return None;
        }
        if !offsets[..count].contains(&offset) {
            offsets[count] = offset;
            count += 1;
        }
    }

    let mut earliest_match: Option<i64> = None;
    let mut forward_gap: Option<(i64, i64)> = None;
    for &offset in &offsets[..count] {
        let candidate = wall_seconds.checked_sub(offset)?;
        let actual_offset = offset_at(candidate)?;
        if actual_offset.checked_abs()? > MAX_OFFSET {
            return None;
        }
        let delta = actual_offset.checked_sub(offset)?;
        if delta == 0 {
            earliest_match = Some(earliest_match.map_or(candidate, |value| value.min(candidate)));
        } else if delta > 0 {
            // Interpreting a skipped local time with the former offset lands
            // after the transition; its local value is ahead by the gap size.
            let choice = (delta, candidate);
            if forward_gap.is_none_or(|previous| choice < previous) {
                forward_gap = Some(choice);
            }
        }
    }

    let seconds = earliest_match.or_else(|| forward_gap.map(|(_, candidate)| candidate))?;
    seconds.checked_mul(1_000)?.checked_add(millis)
}

#[cfg(target_os = "linux")]
fn offset_at(seconds: i64) -> Option<i64> {
    // The pinned libc marks time_t deprecated during its musl ABI transition.
    // Keep a checked conversion for targets whose native time_t is narrower.
    #[allow(deprecated, clippy::useless_conversion)]
    let timestamp = libc::time_t::try_from(seconds).ok()?;
    let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
    // `timestamp` is a valid time_t and local points to properly aligned,
    // writable libc::tm storage. localtime_r initializes it on success, uses
    // the libc-defined layout, and does not retain either pointer.
    let result = unsafe { libc::localtime_r(&timestamp, local.as_mut_ptr()) };
    if result.is_null() {
        return None;
    }
    // SAFETY: localtime_r returned success and initialized the output struct.
    let local = unsafe { local.assume_init() };
    #[allow(clippy::unnecessary_cast)] // c_long is 32-bit on some Linux targets.
    Some(local.tm_gmtoff as i64)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn to_utc_millis(_wall_millis: i64) -> Option<i64> {
    None
}
