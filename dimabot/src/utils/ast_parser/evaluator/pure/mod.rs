//! Explicit, synchronous source-compatible utility handlers. No runtime adapters.
mod casing;
mod coercion;
mod eventsub;
mod metadata;
mod strings;
mod user;

use super::value::{js_truthy, number_string, parse_int};
use super::{Context, EvalError, EvalStats, Host, JsString, JsValue};
use regex::Regex;
use std::sync::LazyLock;

use coercion::{checked_string, string_arg};

pub(super) use metadata::definitions;

#[derive(Clone, Copy, Debug)]
pub(crate) enum PureFunction {
    Upper,
    Lower,
    Title,
    Capitalize,
    Trim,
    Length,
    Slice,
    Replace,
    User,
    ToUser,
    Random,
    Modiversary,
    WatchStreak,
    RaidChannel,
    RaidLogin,
    RaidViewers,
    CheerAmount,
    CheerMessage,
    SubTier,
    SubMonths,
    GiftedUser,
    HypeTrainProgress,
    HypeTrainLevel,
    HypeTrainEnd,
    ShoutoutChannel,
    RewardInput,
}

pub(super) fn dispatch<H: Host>(
    function: PureFunction,
    args: &[JsValue],
    context: &Context,
    host: &mut H,
    stats: &mut EvalStats,
) -> Result<JsValue, EvalError> {
    use PureFunction::*;
    let text = match function {
        Upper | Lower | Title | Capitalize | Trim | Length | Slice | Replace => {
            strings::apply(function, args)?
        }
        User | ToUser => return user::apply(function, args, &context.borrow()),
        Random => {
            let max = if let Some(value) = args.first().filter(|value| js_truthy(value)) {
                parse_int(checked_string(value)?.as_ref())
            } else {
                100.0
            };
            let max = if max.is_nan() || max == 0.0 {
                100.0
            } else {
                max
            };
            stats.host_calls = stats.host_calls.saturating_add(1);
            number_string((host.random()? * max).floor()).into()
        }
        _ => eventsub::apply(function, &context.borrow().event_data),
    };
    Ok(JsValue::String(text))
}

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(crate::utils::js_compat::is_whitespace)
}

// Exact general categories: Alphabetic includes non-L characters and is not
// interchangeable with the source's \p{L}. Compile classifiers once.
// Source oracle: Node 26.8.2 / ICU 78.3 / Unicode 17.0. The locked
// regex 1.13.1 -> regex-syntax 0.8.11 tables are Unicode 16.0. These class
// unions add only the 17.0 L/M/N assignments (no removals); an exhaustive
// scalar comparison against that Node source established these ranges.
// Keep the additions until the locked tables include them, and rerun parity
// before changing this source-version contract.
static LETTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\u{88f}\u{c5c}\u{cdc}\u{a7ce}-\u{a7cf}\u{a7d2}\u{a7d4}\u{a7f1}\u{10940}-\u{10959}\u{10ec5}-\u{10ec7}\u{11db0}-\u{11ddb}\u{16ea0}-\u{16eb8}\u{16ebb}-\u{16ed3}\u{16ff2}-\u{16ff3}\u{187f8}-\u{187ff}\u{18d09}-\u{18d1e}\u{18d80}-\u{18df2}\u{1e6c0}-\u{1e6de}\u{1e6e0}-\u{1e6e2}\u{1e6e4}-\u{1e6e5}\u{1e6e7}-\u{1e6ed}\u{1e6f0}-\u{1e6f4}\u{1e6fe}-\u{1e6ff}\u{2b73a}-\u{2b73f}\u{2cea2}-\u{2cead}\u{323b0}-\u{33479}]").expect("fixed L category")
});
static MARK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{M}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{10efa}-\u{10efb}\u{11b60}-\u{11b67}\u{1e6e3}\u{1e6e6}\u{1e6ee}-\u{1e6ef}\u{1e6f5}]").expect("fixed M category")
});
static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{N}\u{11de0}-\u{11de9}\u{16ff4}-\u{16ff6}]").expect("fixed N category")
});
fn categories(character: char) -> (bool, bool, bool) {
    if character.is_ascii() {
        return (
            character.is_ascii_alphabetic(),
            false,
            character.is_ascii_digit(),
        );
    }
    let mut buffer = [0; 4];
    let text = character.encode_utf8(&mut buffer);
    // RegexSet::matches allocates a PatternSet on each call. Boolean matches
    // reuse each compiled Regex's internal search cache instead.
    if LETTER.is_match(text) {
        (true, false, false)
    } else if MARK.is_match(text) {
        (false, true, false)
    } else {
        (false, false, NUMBER.is_match(text))
    }
}
fn push_char(output: &mut Vec<u16>, character: char) {
    let mut buffer = [0; 2];
    output.extend_from_slice(character.encode_utf16(&mut buffer));
}

#[cfg(test)]
mod tests;
