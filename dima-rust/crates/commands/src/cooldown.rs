//! Command cooldowns (reference: `utils/command_cooldown.ts`, `utils/command_cooldown_write.ts`,
//! and the two gates in `handlers/commands.handler.ts` and `handlers/message.handler.ts`).
//!
//! - The plan minimum belongs to the channel owner's plan, never the chatter's.
//! - Saving: a command cooldown is 0 or at least the minimum; a keyword cooldown is at least the
//!   minimum. A channel has one editable command with a 0-second cooldown; writes that claim it
//!   are serialised across processes by a 60-second Dragonfly lease (not renewed, as in the
//!   reference). [`CooldownStore`] is the store boundary.
//! - Running: [`execution_cooldown`] is the shared Dragonfly gate (`SET NX PX`);
//!   [`chat_cooldown_ms`] is the chat handler's per-process cooldown.
//!
//! Dropping the future of [`write_command_with_cooldown`] cannot run the asynchronous release;
//! the lease then expires after at most 60 seconds.

use std::future::Future;

use dima_core::Random;

use crate::value::{Js, JsView, js_number, js_string};

/// The lease on a channel's zero-cooldown slot, in seconds.
pub const ZERO_SLOT_LEASE_SECONDS: u64 = 60;

/// Deletes `KEYS[1]` only while it still holds `ARGV[1]` (verbatim from the reference).
pub const RELEASE_LEASE_SCRIPT: &str =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/// `getMinimumCommandCooldown`: Pro 1 s, Premium 3 s, anything else (Free, missing, unknown) 5 s.
pub fn minimum_command_cooldown(plan_tier: Option<&str>) -> u8 {
    match plan_tier {
        Some("pro") => 1,
        Some("premium") => 3,
        _ => 5,
    }
}

/// `command-cooldown-write:{channel}`: the zero-slot lease.
pub fn command_write_key(channel_id: &str) -> String {
    format!("command-cooldown-write:{channel_id}")
}

/// `command:execution:cooldown:{channel}:{name}`: the shared execution gate.
pub fn execution_cooldown_key(channel_id: &str, execution_name: &str) -> String {
    format!("command:execution:cooldown:{channel_id}:{execution_name}")
}

/// The command being edited, as the write path sees it.
#[derive(Debug, Clone, Copy, Default)]
pub struct CurrentCommand<'a> {
    /// `String(_id)`; the store converts it back to the stored id type for `$ne`.
    pub id: Option<&'a str>,
    /// The stored cooldown.
    pub cooldown: Option<f64>,
    /// Whether the command is reserved (built in).
    pub reserved: bool,
}

/// The effects of the write path.
pub trait CooldownStore: Sync {
    /// A store failure.
    type Error;

    /// `TwitchStreamers.getTwitchAccountById(channelID)?.plan_tier`.
    fn owner_plan<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send + 'a;

    /// `SET key token NX EX ttl_seconds`; `false` when the key is held.
    fn acquire_lease<'a>(
        &'a self,
        key: &'a str,
        token: &'a str,
        ttl_seconds: u64,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// `Commands.exists({channelID, cooldown: 0, reserved: {$ne: true}, _id: {$ne: exclude}})`,
    /// without the `_id` condition when `exclude_id` is `None`.
    fn editable_zero_exists<'a>(
        &'a self,
        channel_id: &'a str,
        exclude_id: Option<&'a str>,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send + 'a;

    /// [`RELEASE_LEASE_SCRIPT`] with `KEYS = [key]`, `ARGV = [token]`: never deletes a
    /// successor's lease.
    fn release_lease<'a>(
        &'a self,
        key: &'a str,
        token: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

/// Why a cooldown write did not happen.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CooldownError<E> {
    /// Refused (`CommandCooldownError`: the API answers 400 `invalid_cooldown`); the reference's
    /// text.
    #[error("{0}")]
    Invalid(String),
    /// The store or the write failed.
    #[error("command cooldown storage failed")]
    Storage(E),
    /// No lease token could be generated.
    #[error("random number generator unavailable")]
    Random,
}

fn number<V: JsView>(value: &V) -> Option<f64> {
    match value.js() {
        Js::Number(number) => Some(number),
        _ => None,
    }
}

/// `validateKeywordCooldown`: a finite number of at least the owner's minimum (keywords have no
/// zero slot, even on Pro).
pub async fn validate_keyword_cooldown<S: CooldownStore, V: JsView>(
    store: &S,
    channel_id: &str,
    cooldown: Option<&V>,
) -> Result<(), CooldownError<S::Error>> {
    let plan = store
        .owner_plan(channel_id)
        .await
        .map_err(CooldownError::Storage)?;
    let minimum = minimum_command_cooldown(plan.as_deref());
    match cooldown.and_then(number) {
        Some(value) if value.is_finite() && value >= f64::from(minimum) => Ok(()),
        _ => Err(CooldownError::Invalid(format!(
            "Keyword cooldown must be at least {minimum} seconds"
        ))),
    }
}

/// `writeCommandWithCooldown`: validates `cooldown` (`None` is `undefined`: unchanged) and runs
/// `write`, serialising writes that take the channel's zero-cooldown slot.
///
/// An unchanged non-zero value, or an unchanged zero on a reserved command, skips validation
/// (values saved under an older plan stay). As with the reference's `finally`, a failed release
/// replaces the outcome of the write.
pub async fn write_command_with_cooldown<S, V, T, W, F>(
    store: &S,
    random: &dyn Random,
    channel_id: &str,
    cooldown: Option<&V>,
    current: Option<&CurrentCommand<'_>>,
    write: W,
) -> Result<T, CooldownError<S::Error>>
where
    S: CooldownStore,
    V: JsView,
    W: FnOnce() -> F,
    F: Future<Output = Result<T, S::Error>>,
{
    let Some(cooldown) = cooldown.filter(|value| !matches!(value.js(), Js::Undefined)) else {
        return write().await.map_err(CooldownError::Storage);
    };
    let requested = number(cooldown);
    let unchanged = current.is_some_and(|current| {
        requested.is_some()
            && requested == current.cooldown
            && (requested != Some(0.0) || current.reserved)
    });
    if unchanged {
        return write().await.map_err(CooldownError::Storage);
    }
    let plan = store
        .owner_plan(channel_id)
        .await
        .map_err(CooldownError::Storage)?;
    let minimum = minimum_command_cooldown(plan.as_deref());
    let Some(value) = requested
        .filter(|value| value.is_finite() && (*value == 0.0 || *value >= f64::from(minimum)))
    else {
        return Err(CooldownError::Invalid(format!(
            "Command cooldown must be 0 or at least {minimum} seconds"
        )));
    };
    if value != 0.0 {
        return write().await.map_err(CooldownError::Storage);
    }
    if current.is_some_and(|current| current.reserved) {
        return Err(CooldownError::Invalid(
            "Only editable commands can use the 0-second cooldown slot.".into(),
        ));
    }
    let key = command_write_key(channel_id);
    let token = random.uuid_v4().map_err(|_| CooldownError::Random)?;
    if !store
        .acquire_lease(&key, &token, ZERO_SLOT_LEASE_SECONDS)
        .await
        .map_err(CooldownError::Storage)?
    {
        return Err(CooldownError::Invalid(
            "Another command is being saved. Please retry.".into(),
        ));
    }
    let outcome = async {
        let exclude = current
            .and_then(|current| current.id)
            .filter(|id| !id.is_empty());
        if store
            .editable_zero_exists(channel_id, exclude)
            .await
            .map_err(CooldownError::Storage)?
        {
            return Err(CooldownError::Invalid(
                "Only one editable command per channel can have a 0-second cooldown.".into(),
            ));
        }
        write().await.map_err(CooldownError::Storage)
    }
    .await;
    store
        .release_lease(&key, &token)
        .await
        .map_err(CooldownError::Storage)?;
    outcome
}

/// The shared execution gate of a command run (`executeCustomCommand`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionCooldown {
    /// No gate: run.
    None,
    /// `SET command:execution:cooldown:{channel}:{name} 1 NX PX ms`; a refused `SET` means the
    /// command is on cooldown (429 `command_cooldown`). `ms` is `Math.ceil(cooldown * 1000)`,
    /// saturated to `u64`; an expiry the store cannot represent fails the run, as the
    /// reference's `SET` does.
    Millis(u64),
}

/// The execution gate for a command: `Number(cooldown ?? 0)` seconds; a keyword uses at least
/// the owner's minimum (a non-finite stored value counting as 0); only a finite positive value
/// gates. `plan_tier` is read only for keywords.
pub fn execution_cooldown<V: JsView>(
    configured: Option<&V>,
    is_keyword: bool,
    plan_tier: Option<&str>,
) -> ExecutionCooldown {
    let configured = configured.map_or(0.0, |value| match value.js() {
        Js::Undefined => 0.0,
        _ => js_number(value),
    });
    let cooldown = if is_keyword {
        let stored = if configured.is_finite() {
            configured
        } else {
            0.0
        };
        stored.max(f64::from(minimum_command_cooldown(plan_tier)))
    } else {
        configured
    };
    if cooldown.is_finite() && cooldown > 0.0 {
        // `as` saturates; the product is positive.
        ExecutionCooldown::Millis((cooldown * 1000.0).ceil() as u64)
    } else {
        ExecutionCooldown::None
    }
}

/// Node's largest timer delay; a delay outside `1..=TIMEOUT_MAX` (or NaN) becomes 1 ms.
const TIMEOUT_MAX_MS: f64 = 2_147_483_647.0;

/// The chat handler's per-process cooldown after a command ran, in milliseconds, or `None`.
///
/// `String(cooldown ?? 0)`: when it is not `"0"`, the command is blocked in this process for
/// `parseInt(text, 10)` seconds, through Node's `setTimeout`, which turns a delay that is NaN,
/// below 1 ms or above 2,147,483,647 ms into 1 ms. So `2.5` blocks 2 s, `1e21` (text `1e+21`)
/// 1 s, and a negative or a very long cooldown about 1 ms.
pub fn chat_cooldown_ms<V: JsView>(cooldown: Option<&V>) -> Option<u64> {
    let text = match cooldown.map(JsView::js) {
        None | Some(Js::Null | Js::Undefined) => return None,
        Some(_) => cooldown.map(js_string).unwrap_or_default(),
    };
    if text == "0" {
        return None;
    }
    let delay = dima_text::parse_int(&text, dima_text::Radix::Decimal) * 1000.0;
    if (1.0..=TIMEOUT_MAX_MS).contains(&delay) {
        // Node truncates a fractional delay; this one is whole already.
        Some(delay as u64)
    } else {
        Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn execution_gate_follows_the_handler() {
        let gate = |value: Value, keyword: bool, plan: Option<&str>| {
            execution_cooldown(Some(&value), keyword, plan)
        };
        assert_eq!(
            execution_cooldown(None::<&Value>, false, None),
            ExecutionCooldown::None
        );
        assert_eq!(gate(json!(0), false, None), ExecutionCooldown::None);
        assert_eq!(gate(json!(null), false, None), ExecutionCooldown::None);
        assert_eq!(gate(json!(-3), false, None), ExecutionCooldown::None);
        assert_eq!(
            gate(json!(2.0001), false, None),
            ExecutionCooldown::Millis(2001)
        );
        assert_eq!(
            gate(json!("7"), false, None),
            ExecutionCooldown::Millis(7000)
        );
        assert_eq!(gate(json!("x"), false, None), ExecutionCooldown::None);
        assert_eq!(
            gate(json!(0), true, Some("pro")),
            ExecutionCooldown::Millis(1000)
        );
        assert_eq!(
            gate(json!("x"), true, None),
            ExecutionCooldown::Millis(5000)
        );
        assert_eq!(
            gate(json!(10), true, Some("premium")),
            ExecutionCooldown::Millis(10_000)
        );
        assert_eq!(
            gate(json!(1e300), false, None),
            ExecutionCooldown::Millis(u64::MAX)
        );
    }

    #[test]
    fn chat_cooldown_follows_parse_int_and_node_timers() {
        let ms = |value: Value| chat_cooldown_ms(Some(&value));
        assert_eq!(chat_cooldown_ms(None::<&Value>), None);
        assert_eq!(ms(json!(0)), None);
        assert_eq!(ms(json!(-0.0)), None);
        assert_eq!(ms(json!(null)), None);
        assert_eq!(ms(json!(5)), Some(5000));
        assert_eq!(ms(json!(2.5)), Some(2000));
        assert_eq!(ms(json!(1e21)), Some(1000));
        assert_eq!(ms(json!(-3)), Some(1));
        assert_eq!(ms(json!(0.5)), Some(1));
        assert_eq!(ms(json!("abc")), Some(1));
        assert_eq!(ms(json!(2_147_483)), Some(2_147_483_000));
        assert_eq!(ms(json!(2_147_484)), Some(1));
        assert_eq!(ms(json!("0")), None);
        assert_eq!(ms(json!("00")), Some(1));
    }
}
