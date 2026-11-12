//! The handler's per-process command cooldowns (`CHANNEL_INSTANCES`, one
//! `classes/cooldown.class.ts` per channel, `message.handler.ts:52`, `:119-123`, `:417`,
//! `:802-804`): after a command ran in this process, the same name **as typed** (case and all)
//! is ignored in this process until its cooldown ends. The shared Dragonfly gate of the command
//! runner is the cross-process one; this map is only the reference's local shortcut.
//!
//! Bounded where the reference is not: [`MessageConfig::cooldown_channels`] channels, each with
//! at most [`MessageConfig::cooldown_names_per_channel`] names
//! ([`dima_commands::runtime::cooldown_map::ChatCooldowns`]); past the first bound, channels with
//! nothing cooling down are forgotten, then the whole map (losing local cooldowns only lets the
//! next command reach the shared gate, which still applies).

use super::config::MessageConfig;
use dima_commands::runtime::cooldown_map::ChatCooldowns;
use dima_core::Clock;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

/// Every channel's cooldowns.
#[derive(Debug)]
pub struct Cooldowns {
    clock: Arc<dyn Clock>,
    channels: Mutex<HashMap<String, ChatCooldowns>>,
    max_channels: usize,
    names_per_channel: usize,
}

impl Cooldowns {
    /// Empty, with the bounds of `config`.
    pub fn new(clock: Arc<dyn Clock>, config: &MessageConfig) -> Self {
        Self {
            clock,
            channels: Mutex::new(HashMap::new()),
            max_channels: config.cooldown_channels.max(1),
            names_per_channel: config.cooldown_names_per_channel.max(1),
        }
    }

    /// `channelInstance.hasCooldown(command)`.
    pub fn has(&self, channel_id: &str, command: &str) -> bool {
        self.channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(channel_id)
            .is_some_and(|cooldowns| cooldowns.has(command))
    }

    /// `channelInstance.setCooldown(command, seconds)`, with the delay in milliseconds
    /// (`dima_commands::cooldown::chat_cooldown_ms`).
    pub fn set(&self, channel_id: &str, command: &str, delay_ms: u64) {
        let mut channels = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        if !channels.contains_key(channel_id) && channels.len() >= self.max_channels {
            channels.retain(|_, cooldowns| !cooldowns.is_empty());
            if channels.len() >= self.max_channels {
                channels.clear();
            }
        }
        channels
            .entry(channel_id.to_owned())
            .or_insert_with(|| ChatCooldowns::new(Arc::clone(&self.clock), self.names_per_channel))
            .set(command, delay_ms);
    }

    /// Channels kept.
    pub fn channels(&self) -> usize {
        self.channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::ManualClock;

    #[test]
    fn names_cool_down_per_channel_as_typed_and_stay_bounded() {
        let clock = ManualClock::new(0);
        let cooldowns = Cooldowns::new(
            Arc::new(clock.clone()),
            &MessageConfig {
                cooldown_channels: 2,
                ..MessageConfig::default()
            },
        );
        cooldowns.set("a", "hola", 5_000);
        assert!(cooldowns.has("a", "hola"));
        assert!(!cooldowns.has("a", "Hola"), "the name as typed");
        assert!(!cooldowns.has("b", "hola"));
        cooldowns.set("b", "x", 1_000);
        clock.advance(1_000);
        // Full: `b` has nothing cooling down any more and is forgotten first.
        cooldowns.set("c", "y", 1_000);
        assert_eq!(cooldowns.channels(), 2);
        assert!(cooldowns.has("a", "hola") && cooldowns.has("c", "y"));
        clock.advance(4_000);
        assert!(!cooldowns.has("a", "hola"));
    }
}
