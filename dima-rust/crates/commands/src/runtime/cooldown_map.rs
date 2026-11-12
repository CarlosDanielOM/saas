//! The bot's per-process chat cooldowns (reference: `classes/cooldown.class.ts`, one instance
//! per channel in `handlers/message.handler.ts`): after a command runs, the same name is
//! ignored in this process until its cooldown ends. The delay comes from
//! [`crate::cooldown::chat_cooldown_ms`].
//!
//! Intended differences: the reference deletes each entry with its own `setTimeout`, so a
//! second `setCooldown` of a name is cut short by the first timer; here the latest one counts
//! (the handler never sets a name that is still cooling down). Entries expire by the injected
//! clock instead of timers, and the map holds at most [`ChatCooldowns::capacity`] names (the
//! reference has no bound): when full, expired entries are dropped first, then the one that
//! ends soonest.

use std::collections::HashMap;
use std::sync::Arc;

use dima_core::Clock;

/// The default bound on names per channel.
pub const DEFAULT_CAPACITY: usize = 4_096;

/// One channel's cooldowns.
#[derive(Debug)]
pub struct ChatCooldowns {
    clock: Arc<dyn Clock>,
    capacity: usize,
    /// Name -> (end in epoch ms, the delay it was set with).
    entries: HashMap<String, (i64, u64)>,
}

impl ChatCooldowns {
    /// An empty map holding at most `capacity` names.
    pub fn new(clock: Arc<dyn Clock>, capacity: usize) -> Self {
        Self {
            clock,
            capacity: capacity.max(1),
            entries: HashMap::new(),
        }
    }

    /// The bound.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    fn prune(&mut self, now: i64) {
        self.entries.retain(|_, (end, _)| *end > now);
    }

    /// `setCooldown(id, seconds)`, with the delay already in milliseconds.
    pub fn set(&mut self, id: &str, delay_ms: u64) {
        let now = self.clock.now_ms();
        if !self.entries.contains_key(id) && self.entries.len() >= self.capacity {
            self.prune(now);
            if self.entries.len() >= self.capacity
                && let Some(soonest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (end, _))| *end)
                    .map(|(name, _)| name.clone())
            {
                self.entries.remove(&soonest);
            }
        }
        let end = now.saturating_add(i64::try_from(delay_ms).unwrap_or(i64::MAX));
        self.entries.insert(id.to_owned(), (end, delay_ms));
    }

    /// `hasCooldown(id)`.
    pub fn has(&self, id: &str) -> bool {
        let now = self.clock.now_ms();
        self.entries.get(id).is_some_and(|(end, _)| *end > now)
    }

    /// `getCooldown(id)`: the delay it was set with, while it lasts.
    pub fn get(&self, id: &str) -> Option<u64> {
        let now = self.clock.now_ms();
        self.entries
            .get(id)
            .filter(|(end, _)| *end > now)
            .map(|(_, delay)| *delay)
    }

    /// `deleteCooldown(id)`.
    pub fn delete(&mut self, id: &str) {
        self.entries.remove(id);
    }

    /// `clearCooldowns()`.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// How many names are cooling down.
    pub fn len(&self) -> usize {
        let now = self.clock.now_ms();
        self.entries.values().filter(|(end, _)| *end > now).count()
    }

    /// Whether none is.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
