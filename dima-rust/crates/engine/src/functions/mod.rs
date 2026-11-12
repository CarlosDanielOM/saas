//! The builtins the engine runs itself (everything that needs no outside service).
//!
//! `delay` and `timer` are builtins too but run in the evaluator, because they need the host
//! (to sleep, to schedule).

pub(crate) mod eventsub;
pub(crate) mod strings;
pub(crate) mod user;

use crate::context::{Context, LoopExit};
use crate::registry::Builtin;
use crate::value::Value;
use dima_text::{Radix, number_to_string, parse_int};

/// The per-run scalars a builtin may change (`count`, `countModified`, `loopExit`).
pub(crate) struct Counters<'a> {
    pub(crate) count: &'a mut f64,
    pub(crate) count_modified: &'a mut bool,
    pub(crate) loop_exit: &'a mut Option<LoopExit>,
}

/// `parseInt(text, 10) || fallback`: NaN and 0 give the fallback.
fn int_or(text: &str, fallback: f64) -> f64 {
    let number = parse_int(text, Radix::Decimal);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// `args[0] || alternative`: the first argument when it is truthy.
fn first_truthy(args: &[Value]) -> Option<&Value> {
    args.first().filter(|arg| arg.js_truthy())
}

/// Runs a builtin that needs neither the host nor the evaluator. `random` is a draw in
/// `[0, 1)` (`Math.random()`), taken only by `$(random)`.
pub(crate) fn run(
    builtin: Builtin,
    args: &[Value],
    context: &Context,
    counters: Counters<'_>,
    random: &mut dyn FnMut() -> f64,
) -> Value {
    let text = match builtin {
        Builtin::Upper => strings::upper(args),
        Builtin::Lower => strings::lower(args),
        Builtin::Title => strings::title(args),
        Builtin::Capitalize => strings::capitalize(args),
        Builtin::Trim => strings::trim_text(args),
        Builtin::Length => strings::length(args),
        Builtin::Slice => strings::slice(args),
        Builtin::Replace => strings::replace(args),
        Builtin::User => user::user(args, context),
        Builtin::ToUser => user::touser(args, context),
        Builtin::Random => {
            // parseInt(String(args[0] || '100'), 10) || 100
            let max = match first_truthy(args) {
                Some(arg) => int_or(&arg.to_text(), 100.0),
                None => 100.0,
            };
            number_to_string((random() * max).floor())
        }
        Builtin::Count => {
            // String(args[0] || ctx.argument || '0'), every '+' removed unless it is '0'.
            let raw = match first_truthy(args) {
                Some(arg) => arg.to_text().into_owned(),
                None => match context.argument.as_deref() {
                    Some(argument) if !argument.is_empty() => argument.to_owned(),
                    _ => "0".to_owned(),
                },
            };
            let raw = if raw == "0" {
                raw
            } else {
                raw.replace('+', "")
            };
            let increment = int_or(&raw, 0.0);
            *counters.count += increment;
            *counters.count_modified = true;
            number_to_string(*counters.count)
        }
        Builtin::Scount => {
            *counters.count += 1.0;
            *counters.count_modified = true;
            number_to_string(*counters.count)
        }
        Builtin::Bits => match context.extra_context.get("bits") {
            Some(Value::Undefined) | None => "0".into(),
            Some(bits) => bits.to_text().into_owned(),
        },
        Builtin::Break => {
            *counters.loop_exit = Some(LoopExit::Break);
            String::new()
        }
        Builtin::Continue => {
            *counters.loop_exit = Some(LoopExit::Continue);
            String::new()
        }
        Builtin::AdTime => eventsub::ad_time(context),
        Builtin::BanTime => eventsub::ban_time(context),
        Builtin::Modiversary => eventsub::modiversary(context),
        Builtin::WatchStreak => eventsub::watch_streak(context),
        Builtin::RaidChannel => eventsub::raid_channel(context),
        Builtin::RaidLogin => eventsub::raid_login(context),
        Builtin::RaidViewers => eventsub::raid_viewers(context),
        Builtin::CheerAmount => eventsub::cheer_amount(context),
        Builtin::CheerMessage => eventsub::cheer_message(context),
        Builtin::SubTier => eventsub::sub_tier(context),
        Builtin::SubMonths => eventsub::sub_months(context),
        Builtin::GiftedUser => eventsub::gifted_user(context),
        Builtin::HypeTrainProgress => eventsub::hype_train_progress(context),
        Builtin::HypeTrainLevel => eventsub::hype_train_level(context),
        Builtin::HypeTrainEnd => eventsub::hype_train_end(context),
        Builtin::ShoutoutChannel => eventsub::shoutout_channel(context),
        Builtin::RewardInput => eventsub::reward_input(context),
        // Run by the evaluator.
        Builtin::Delay | Builtin::Timer => String::new(),
    };
    Value::Text(text)
}

/// `$(delay seconds)` before the pause: the milliseconds to wait, or the answer to give.
pub(crate) fn delay_millis(args: &[Value]) -> Result<u64, String> {
    const MAX_DELAY_SECONDS: f64 = 60.0;
    let Some(raw) = args.first() else {
        return Err("delay: missing argument (seconds)".into());
    };
    let seconds = raw.to_number();
    if !seconds.is_finite() {
        return Err(format!(
            "delay: \"{}\" is not a valid number",
            raw.to_text()
        ));
    }
    if !(0.0..=MAX_DELAY_SECONDS).contains(&seconds) {
        return Err("delay: must be between 0 and 60 seconds".into());
    }
    // Math.round(seconds * 1000), at most 60,000.
    Ok(dima_text::math_round(seconds * 1000.0).max(0.0) as u64)
}
