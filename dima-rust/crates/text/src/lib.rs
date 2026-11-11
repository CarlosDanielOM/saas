//! Text rules: UTF-8 helpers, JavaScript-visible formatting, canonical JSON.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; section 4 is the
//! specification for this crate. All text is UTF-8 (`&str`, `String`). UTF-16 appears only as
//! numbers ([`utf16_len`], [`utf16_offset`], [`utf16_to_byte`], [`truncate_utf16_budget`]) for
//! the contract rows of that section; no UTF-16 data is built or stored.
//!
//! The JavaScript behaviour reproduced here (whitespace, number text, `Number()`/`parseInt`,
//! dates, `JSON.stringify`, string ordering, case mapping) is pinned by golden vectors written
//! by the production Node runtime: see `tests/vectors/generate.mjs`.
//!
//! # Reproducing `JSON.stringify` bytes
//!
//! [`to_js_json`] writes a `serde_json::Value` exactly as JavaScript would write the same
//! value. Matching the bytes of a TypeScript producer is therefore the caller's job at one
//! step: building the `Value` the way that producer's object looks **after** JavaScript's own
//! conversion. In particular:
//!
//! - a property that is `undefined` or absent is omitted, never `null` (derive with
//!   `#[serde(skip_serializing_if = "Option::is_none")]`), while `undefined` inside an array
//!   is `null`;
//! - keys go in the order the TypeScript assigns them (struct field order must follow it);
//! - a `Date` is its [`to_iso_string`] text under plain `JSON.stringify`, but the site agent's
//!   own `stableJson` writes a `Date` (and a `Map` or `Set`) as `{}`;
//! - `NaN` and infinities are `null`.
//!
//! Byte-compared values (queue items, values compared inside Lua, hashed payloads) need a
//! fixture recorded from the TypeScript producer in the package that ports it.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod case;
mod chars;
mod date;
mod json;
mod number;
mod order;
mod parse;
mod utf16;
mod whitespace;

pub use case::{nfc, to_lower, to_upper};
pub use chars::{
    MAX_PAD_WIDTH, char_len, char_to_byte, pad_end, pad_start, slice_chars, truncate_bytes,
    truncate_chars,
};
pub use date::{
    MAX_TIME_MS, MS_PER_DAY, UtcFields, date_utc, parse_date, to_date_string_utc, to_iso_string,
    to_locale_string_en_us_utc, utc_day_start, utc_fields,
};
pub use json::{
    SortedKeys, js_key_order, sanitize_lone_surrogates, to_js_json, to_js_json_from,
    to_js_json_sorted,
};
pub use number::{
    NumberLocale, math_round, number_to_string, string_of, to_fixed, to_locale_string,
};
pub use order::cmp_utf16;
#[cfg(feature = "collation")]
pub use order::{CollationError, Collator};
pub use parse::{Radix, parse_float, parse_int, parse_number};
pub use utf16::{truncate_utf16_budget, utf16_len, utf16_offset, utf16_to_byte};
pub use whitespace::{is_js_whitespace, trim, trim_end, trim_start};
