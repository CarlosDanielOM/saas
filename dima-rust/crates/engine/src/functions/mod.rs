//! The builtins the engine runs itself (everything that needs no outside service).
//!
//! `delay` and `timer` are builtins too but run in the evaluator, because they need the host
//! (to sleep, to schedule).

pub(crate) mod eventsub;
pub(crate) mod strings;
pub(crate) mod user;

use crate::context::{Context, LoopExit};
use crate::registry::Builtin;
use crate::value::{CoercionError, Value};
use dima_text::{Radix, number_to_string, parse_int};

/// A builtin's result would be over its budget; nothing of its size was allocated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TooLong;

/// Why a builtin (or a conversion of the evaluator) gave no result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// Over the budget ([`TooLong`]).
    TooLong,
    /// A conversion threw ([`CoercionError`]).
    Coercion,
}

impl From<TooLong> for Failure {
    fn from(_: TooLong) -> Self {
        Self::TooLong
    }
}

impl From<CoercionError> for Failure {
    fn from(_: CoercionError) -> Self {
        Self::Coercion
    }
}

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

/// `$(random [max])`'s bound: `parseInt(String(args[0] || '100'), 10) || 100`, read before the
/// draw (its conversion can throw).
pub(crate) fn random_max(args: &[Value]) -> Result<f64, CoercionError> {
    Ok(match first_truthy(args) {
        Some(arg) => int_or(&arg.to_text()?, 100.0),
        None => 100.0,
    })
}

/// Runs a builtin that needs neither the host nor the evaluator. `random` is a draw in
/// `[0, 1)` (`Math.random()`), taken only by `$(random)`. `max` is the budget for the result,
/// in bytes: a function whose result grows with its arguments (the text functions, `user` and
/// `touser`) computes the result's size first and returns [`TooLong`] instead of building a
/// larger one. The others build text from the run's context (the event accessors, `bits`,
/// `user` without a filter) or a number, never larger than what the host supplied.
pub(crate) fn run(
    builtin: Builtin,
    args: &[Value],
    context: &Context,
    counters: Counters<'_>,
    random: &mut dyn FnMut() -> f64,
    max: usize,
) -> Result<Value, Failure> {
    let text = match builtin {
        Builtin::Upper => strings::upper(args, max)?,
        Builtin::Lower => strings::lower(args, max)?,
        Builtin::Title => strings::title(args, max)?,
        Builtin::Capitalize => strings::capitalize(args, max)?,
        Builtin::Trim => strings::trim_text(args, max)?,
        Builtin::Length => strings::length(args)?,
        Builtin::Slice => strings::slice(args, max)?,
        Builtin::Replace => strings::replace(args, max)?,
        Builtin::User => user::user(args, context)?,
        Builtin::ToUser => user::touser(args, context, max)?,
        Builtin::Random => number_to_string((random() * random_max(args)?).floor()),
        Builtin::Count => {
            // String(args[0] || ctx.argument || '0'), every '+' removed unless it is '0'.
            let raw = match first_truthy(args) {
                Some(arg) => arg.to_text()?.into_owned(),
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
            Some(bits) => bits.to_text()?.into_owned(),
        },
        Builtin::Break => {
            *counters.loop_exit = Some(LoopExit::Break);
            String::new()
        }
        Builtin::Continue => {
            *counters.loop_exit = Some(LoopExit::Continue);
            String::new()
        }
        Builtin::AdTime => eventsub::ad_time(context)?,
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
    Ok(Value::Text(text))
}

/// `$(delay seconds)` before the pause: the milliseconds to wait, or the answer to give.
/// `Number(raw)` and the text of the answer can throw ([`CoercionError`]).
pub(crate) fn delay_millis(args: &[Value]) -> Result<Result<u64, String>, CoercionError> {
    const MAX_DELAY_SECONDS: f64 = 60.0;
    let Some(raw) = args.first() else {
        return Ok(Err("delay: missing argument (seconds)".into()));
    };
    let seconds = raw.to_number()?;
    if !seconds.is_finite() {
        return Ok(Err(format!(
            "delay: \"{}\" is not a valid number",
            raw.to_text()?
        )));
    }
    if !(0.0..=MAX_DELAY_SECONDS).contains(&seconds) {
        return Ok(Err("delay: must be between 0 and 60 seconds".into()));
    }
    // Math.round(seconds * 1000), at most 60,000.
    Ok(Ok(dima_text::math_round(seconds * 1000.0).max(0.0) as u64))
}
