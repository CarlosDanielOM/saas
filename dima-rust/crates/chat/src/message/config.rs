//! The handler's typed configuration. The crate never reads the environment: the bot binary
//! builds this (the defaults are the production values) and tests pass generous deadlines.

use std::time::Duration;

/// Limits and deadlines of the message handler. [`Default`] holds the production values; none of
/// them exists in the reference (it starts every message at once and waits as long as each call
/// takes), they are this port's bounds (charter section 6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageConfig {
    /// Messages of one channel handled at the same time (4). The next ones wait, in arrival
    /// order.
    pub per_channel_in_flight: usize,
    /// Messages of one channel waiting for a place (64). One more is dropped and counted
    /// ([`super::limits::Dropped::ChannelQueueFull`]).
    pub per_channel_waiting: usize,
    /// Messages handled at the same time, all channels together (256).
    pub total_in_flight: usize,
    /// Messages waiting for a place, all channels together (4,096). One more is dropped and
    /// counted ([`super::limits::Dropped::QueueFull`]).
    pub total_waiting: usize,
    /// The longest a message waits for its place (30 s); then it is dropped and counted
    /// ([`super::limits::Dropped::WaitedTooLong`]).
    pub admission_wait: Duration,
    /// Command evaluations (a command or a keyword run with the engine) at the same time, all
    /// channels together (64). The next ones wait inside their message's deadline.
    pub evaluations_in_flight: usize,
    /// The longest one message is handled, from its place to its last effect (120 s: the AI reply
    /// and a 60 s chat post fit). Past it the work is dropped and counted
    /// ([`super::limits::Dropped::TimedOut`]); effects already made stay (at most once).
    pub message_deadline: Duration,
    /// Keyword commands one message may run (16; the reference has no bound, the production
    /// copy has at most 3 keywords per channel). The matches past it are skipped and counted.
    pub keyword_runs_per_message: usize,
    /// Deadline of each MongoDB call the handler makes itself (the chat message subscription's
    /// settings): 10 s.
    pub store_deadline: Duration,
    /// Channels whose per-process command cooldowns are kept (10,000); past it, channels with
    /// nothing cooling down are forgotten first.
    pub cooldown_channels: usize,
    /// Command names one channel keeps cooling down
    /// ([`dima_commands::runtime::cooldown_map::DEFAULT_CAPACITY`]).
    pub cooldown_names_per_channel: usize,
}

impl Default for MessageConfig {
    fn default() -> Self {
        Self {
            per_channel_in_flight: 4,
            per_channel_waiting: 64,
            total_in_flight: 256,
            total_waiting: 4_096,
            admission_wait: Duration::from_secs(30),
            evaluations_in_flight: 64,
            message_deadline: Duration::from_secs(120),
            keyword_runs_per_message: 16,
            store_deadline: Duration::from_secs(10),
            cooldown_channels: 10_000,
            cooldown_names_per_channel: dima_commands::runtime::cooldown_map::DEFAULT_CAPACITY,
        }
    }
}
