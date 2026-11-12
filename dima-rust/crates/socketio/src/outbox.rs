//! What one connection has queued for its client, and the slow-consumer policy.
//!
//! Engine.IO keeps each connection's outgoing packets in a bounded channel until the polling
//! response or the WebSocket takes them; it does not say when that happens. Every packet is
//! handed over as a [`Str`] whose bytes this outbox also holds a clone of: once the transport has
//! taken the packet (and dropped its copy), the clone is the only reference left
//! ([`Bytes::is_unique`]). [`Outbox::sweep`] releases those, oldest first, so the counts below are
//! what really waits for the client, give or take the one message a WebSocket write has in hand.
//!
//! Bounds: per socket, its [`QueueLimits`]; per connection, a packet count that leaves room in
//! the transport channel for heartbeats and the close packet; for the whole server,
//! `max_outbound_total` bytes. A packet that does not fit is handled by its [`Delivery`].

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use engineioxide::Str;

use crate::config::QueueLimits;
use crate::telemetry::SendOutcome;

/// How an emit behaves when the socket's send queue is full.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Delivery {
    /// Must arrive: a full queue closes the connection as a slow consumer (reason
    /// `slow consumer`, recoverable). The default.
    #[default]
    Reliable,
    /// Only the newest one per key matters (a state snapshot): on a full queue it waits in a
    /// slot that a newer event with the same key replaces, and is sent when room frees up, so it
    /// may arrive after events emitted later. At most [`MAX_PENDING_KEYS`] keys wait per socket.
    Replaceable(String),
    /// May be lost: dropped (and counted) on a full queue.
    Lossy,
}

/// Replaceable keys that may wait at once on one socket.
pub const MAX_PENDING_KEYS: usize = 16;

/// Transport-channel slots kept free for the heartbeat, the upgrade no-op and the close packet.
pub const HEADROOM: usize = 8;

/// Control packets (CONNECT_ERROR before a socket exists) a connection may have queued.
pub const CONTROL_PACKETS: usize = 64;

#[derive(Debug)]
struct Tracked {
    bytes: Bytes,
    len: usize,
    socket: Option<u64>,
}

#[derive(Debug)]
struct Waiting {
    socket: u64,
    limits: QueueLimits,
    key: String,
    packet: String,
}

#[derive(Debug, Default, Clone, Copy)]
struct Usage {
    packets: usize,
    bytes: usize,
    /// The socket has left: the entry goes once its last packet is released.
    retired: bool,
}

/// One packet to send.
#[derive(Debug)]
pub struct Outgoing<'a> {
    /// The socket it counts against (`None` for connection-level control packets).
    pub socket: Option<(u64, QueueLimits)>,
    /// The encoded packet.
    pub packet: String,
    /// What to do when it does not fit.
    pub delivery: &'a Delivery,
}

/// The outcome of [`Outbox::push`] for a packet that was not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotSent {
    /// It did not fit and must not be lost: close the connection.
    SlowConsumer,
    /// Lossy, dropped.
    Dropped,
    /// Replaceable, waiting (`replaced` when it took the slot of an older one).
    Deferred {
        /// Whether an older waiting event was replaced.
        replaced: bool,
    },
    /// Replaceable, but too many keys wait already.
    TooManyKeys,
    /// The transport is gone.
    Closed,
}

impl NotSent {
    /// The telemetry outcome, when there is one.
    pub fn outcome(self) -> Option<SendOutcome> {
        match self {
            Self::SlowConsumer => Some(SendOutcome::SlowConsumer),
            Self::Dropped => Some(SendOutcome::Dropped),
            Self::Deferred { replaced: false } => Some(SendOutcome::Deferred),
            Self::Deferred { replaced: true } => Some(SendOutcome::Replaced),
            Self::TooManyKeys | Self::Closed => None,
        }
    }
}

/// The send side of the transport.
pub trait Transport {
    /// Hands one message to Engine.IO; `false` when the channel is full or closed.
    fn send(&self, message: Str) -> Result<(), TransportFull>;
}

/// The channel refused the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportFull {
    /// No room.
    Full,
    /// Closed.
    Closed,
}

/// The accounting of one connection.
#[derive(Debug)]
pub struct Outbox {
    in_flight: VecDeque<Tracked>,
    sockets: HashMap<u64, Usage>,
    waiting: VecDeque<Waiting>,
    bytes: usize,
    /// The most packets this connection may have queued (transport capacity minus headroom).
    max_packets: usize,
}

impl Outbox {
    /// An empty outbox for a transport channel of `capacity` packets.
    pub fn new(capacity: usize) -> Self {
        Self {
            in_flight: VecDeque::new(),
            sockets: HashMap::new(),
            waiting: VecDeque::new(),
            bytes: 0,
            max_packets: capacity.saturating_sub(HEADROOM).max(1),
        }
    }

    /// Packets queued for the client.
    pub fn queued(&self) -> usize {
        self.in_flight.len()
    }

    /// Whether anything is queued or waiting.
    pub fn busy(&self) -> bool {
        !self.in_flight.is_empty() || !self.waiting.is_empty()
    }

    /// Whether replaceable events wait for room.
    pub fn has_waiting(&self) -> bool {
        !self.waiting.is_empty()
    }

    /// Releases the packets the transport has taken; returns how many.
    pub fn sweep(&mut self, total: &AtomicUsize) -> usize {
        let mut released = 0;
        while self.in_flight.front().is_some_and(|t| t.bytes.is_unique()) {
            if let Some(tracked) = self.in_flight.pop_front() {
                self.release(&tracked, total);
                released += 1;
            }
        }
        released
    }

    fn release(&mut self, tracked: &Tracked, total: &AtomicUsize) {
        self.bytes = self.bytes.saturating_sub(tracked.len);
        total.fetch_sub(tracked.len, Ordering::AcqRel);
        if let Some(socket) = tracked.socket
            && let Some(usage) = self.sockets.get_mut(&socket)
        {
            usage.packets = usage.packets.saturating_sub(1);
            usage.bytes = usage.bytes.saturating_sub(tracked.len);
            if usage.retired && usage.packets == 0 {
                self.sockets.remove(&socket);
            }
        }
    }

    /// A socket of this connection starts sending (before its first packet: the missed events
    /// of a restore, or its CONNECT). Packets of a socket that is not open are refused, so a
    /// send racing with the socket's departure cannot bring its entry back.
    pub fn open_socket(&mut self, socket: u64) {
        self.sockets.entry(socket).or_default();
    }

    /// Entries in the usage map: open sockets, and retired ones whose packets still wait.
    #[cfg(test)]
    pub fn tracked_sockets(&self) -> usize {
        self.sockets.len()
    }

    /// Forgets everything (the connection closed).
    pub fn clear(&mut self, total: &AtomicUsize) {
        while let Some(tracked) = self.in_flight.pop_front() {
            self.release(&tracked, total);
        }
        self.waiting.clear();
        self.sockets.clear();
    }

    /// The socket has left: its waiting events are dropped and its usage entry is removed now,
    /// or, while packets of it are still queued, when the last of them is released.
    pub fn forget_socket(&mut self, socket: u64) {
        self.waiting.retain(|w| w.socket != socket);
        match self.sockets.get_mut(&socket) {
            Some(usage) if usage.packets > 0 => usage.retired = true,
            Some(_) => {
                self.sockets.remove(&socket);
            }
            None => {}
        }
    }

    fn fits(
        &self,
        socket: Option<(u64, QueueLimits)>,
        len: usize,
        total: &AtomicUsize,
        max_total: usize,
    ) -> bool {
        if self.in_flight.len() >= self.max_packets {
            return false;
        }
        if total.load(Ordering::Acquire).saturating_add(len) > max_total {
            return false;
        }
        let Some((key, limits)) = socket else {
            // Control packets: a share of the connection, never the sockets' room.
            let control = self.in_flight.iter().filter(|t| t.socket.is_none()).count();
            return control < CONTROL_PACKETS;
        };
        let usage = self.sockets.get(&key).copied().unwrap_or_default();
        usage.packets < limits.packets
            && (usage.bytes == 0 || usage.bytes.saturating_add(len) <= limits.bytes)
    }

    fn hand_over(
        &mut self,
        transport: &dyn Transport,
        socket: Option<u64>,
        packet: String,
        total: &AtomicUsize,
    ) -> Result<(), TransportFull> {
        let len = packet.len();
        let message = Str::from(packet);
        let bytes = Bytes::from(message.clone());
        transport.send(message)?;
        // An empty message is static and never unique: it would block the sweep. Packets are
        // never empty, but do not track one if it ever were.
        if len == 0 {
            return Ok(());
        }
        self.bytes += len;
        total.fetch_add(len, Ordering::AcqRel);
        if let Some(usage) = socket.and_then(|socket| self.sockets.get_mut(&socket)) {
            usage.packets += 1;
            usage.bytes += len;
        }
        self.in_flight.push_back(Tracked { bytes, len, socket });
        Ok(())
    }

    /// Sends one packet, or applies its delivery's policy when it does not fit.
    pub fn push(
        &mut self,
        transport: &dyn Transport,
        outgoing: Outgoing<'_>,
        total: &AtomicUsize,
        max_total: usize,
    ) -> Result<(), NotSent> {
        self.sweep(total);
        let len = outgoing.packet.len();
        let socket_key = outgoing.socket.map(|(key, _)| key);
        if socket_key.is_some_and(|key| self.sockets.get(&key).is_none_or(|usage| usage.retired)) {
            return Err(NotSent::Closed);
        }
        if self.fits(outgoing.socket, len, total, max_total) {
            // A newer replaceable event makes a waiting one with the same key obsolete.
            if let (Delivery::Replaceable(key), Some(socket)) = (outgoing.delivery, socket_key) {
                self.waiting
                    .retain(|w| !(w.socket == socket && &w.key == key));
            }
            return self
                .hand_over(transport, socket_key, outgoing.packet, total)
                .map_err(|full| match full {
                    TransportFull::Full => NotSent::SlowConsumer,
                    TransportFull::Closed => NotSent::Closed,
                });
        }
        match outgoing.delivery {
            Delivery::Reliable => Err(NotSent::SlowConsumer),
            Delivery::Lossy => Err(NotSent::Dropped),
            Delivery::Replaceable(key) => {
                let Some((socket, limits)) = outgoing.socket else {
                    return Err(NotSent::Dropped);
                };
                if let Some(slot) = self
                    .waiting
                    .iter_mut()
                    .find(|w| w.socket == socket && &w.key == key)
                {
                    slot.packet = outgoing.packet;
                    return Err(NotSent::Deferred { replaced: true });
                }
                if self.waiting.iter().filter(|w| w.socket == socket).count() >= MAX_PENDING_KEYS {
                    return Err(NotSent::TooManyKeys);
                }
                self.waiting.push_back(Waiting {
                    socket,
                    limits,
                    key: key.clone(),
                    packet: outgoing.packet,
                });
                Err(NotSent::Deferred { replaced: false })
            }
        }
    }

    /// Sends the waiting replaceable events that fit now, oldest first.
    pub fn flush_waiting(
        &mut self,
        transport: &dyn Transport,
        total: &AtomicUsize,
        max_total: usize,
    ) {
        self.sweep(total);
        let mut index = 0;
        while let Some(waiting) = self.waiting.get(index) {
            if self.fits(
                Some((waiting.socket, waiting.limits)),
                waiting.packet.len(),
                total,
                max_total,
            ) {
                if let Some(waiting) = self.waiting.remove(index)
                    && self
                        .hand_over(transport, Some(waiting.socket), waiting.packet, total)
                        .is_err()
                {
                    return;
                }
            } else {
                index += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A transport channel the test drains by hand.
    struct Channel {
        capacity: usize,
        queue: Mutex<VecDeque<Str>>,
    }

    impl Channel {
        fn new(capacity: usize) -> Self {
            Self {
                capacity,
                queue: Mutex::new(VecDeque::new()),
            }
        }
        fn take(&self, n: usize) -> Vec<String> {
            let mut queue = self.queue.lock().unwrap();
            (0..n)
                .filter_map(|_| queue.pop_front().map(|s| s.to_string()))
                .collect()
        }
    }

    impl Transport for Channel {
        fn send(&self, message: Str) -> Result<(), TransportFull> {
            let mut queue = self.queue.lock().unwrap();
            if queue.len() >= self.capacity {
                return Err(TransportFull::Full);
            }
            queue.push_back(message);
            Ok(())
        }
    }

    const LIMITS: QueueLimits = QueueLimits {
        packets: 3,
        bytes: 10,
    };

    fn out<'a>(packet: &str, delivery: &'a Delivery) -> Outgoing<'a> {
        Outgoing {
            socket: Some((1, LIMITS)),
            packet: packet.to_owned(),
            delivery,
        }
    }

    #[test]
    fn counts_until_the_transport_takes_packets() {
        let channel = Channel::new(100);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(100);
        outbox.open_socket(1);
        let reliable = Delivery::Reliable;
        for packet in ["aaa", "bbb", "ccc"] {
            assert_eq!(
                outbox.push(&channel, out(packet, &reliable), &total, 1000),
                Ok(())
            );
        }
        assert_eq!(total.load(Ordering::Acquire), 9);
        // Fourth packet: the socket's 3-packet queue is full.
        assert_eq!(
            outbox.push(&channel, out("ddd", &reliable), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
        assert_eq!(
            outbox.push(&channel, out("d", &Delivery::Lossy), &total, 1000),
            Err(NotSent::Dropped)
        );
        // The client reads two: room for two more.
        assert_eq!(channel.take(2), ["aaa", "bbb"]);
        assert_eq!(outbox.sweep(&total), 2);
        assert_eq!(total.load(Ordering::Acquire), 3);
        assert_eq!(
            outbox.push(&channel, out("eee", &reliable), &total, 1000),
            Ok(())
        );
        // Bytes: 3 + 3 = 6 queued, a 5-byte packet would make 11 > 10.
        assert_eq!(
            outbox.push(&channel, out("fffff", &reliable), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
        assert_eq!(outbox.queued(), 2);
        outbox.clear(&total);
        assert_eq!(total.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_large_packet_goes_alone_and_the_total_bounds_everyone() {
        let channel = Channel::new(100);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(100);
        outbox.open_socket(1);
        let reliable = Delivery::Reliable;
        assert_eq!(
            outbox.push(&channel, out("0123456789AB", &reliable), &total, 1000),
            Ok(())
        );
        assert_eq!(
            outbox.push(&channel, out("x", &reliable), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
        channel.take(1);
        assert_eq!(outbox.sweep(&total), 1);
        // The server-wide total: 995 bytes already queued elsewhere.
        total.store(995, Ordering::Release);
        assert_eq!(
            outbox.push(&channel, out("123456", &reliable), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
    }

    #[test]
    fn replaceable_events_wait_and_coalesce() {
        let channel = Channel::new(100);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(100);
        outbox.open_socket(1);
        let reliable = Delivery::Reliable;
        for packet in ["a", "b", "c"] {
            assert_eq!(
                outbox.push(&channel, out(packet, &reliable), &total, 1000),
                Ok(())
            );
        }
        let state = Delivery::Replaceable("state".to_owned());
        assert_eq!(
            outbox.push(&channel, out("s1", &state), &total, 1000),
            Err(NotSent::Deferred { replaced: false })
        );
        assert_eq!(
            outbox.push(&channel, out("s2", &state), &total, 1000),
            Err(NotSent::Deferred { replaced: true })
        );
        outbox.flush_waiting(&channel, &total, 1000);
        assert!(outbox.has_waiting());
        channel.take(1);
        outbox.flush_waiting(&channel, &total, 1000);
        assert!(!outbox.has_waiting());
        assert_eq!(channel.take(10), ["b", "c", "s2"]);
        // Too many keys.
        for packet in ["a", "b", "c"] {
            outbox.sweep(&total);
            assert_eq!(
                outbox.push(&channel, out(packet, &reliable), &total, 1000),
                Ok(())
            );
        }
        for key in 0..MAX_PENDING_KEYS {
            let delivery = Delivery::Replaceable(key.to_string());
            assert!(matches!(
                outbox.push(&channel, out("k", &delivery), &total, 1000),
                Err(NotSent::Deferred { .. })
            ));
        }
        let one_more = Delivery::Replaceable("more".to_owned());
        assert_eq!(
            outbox.push(&channel, out("k", &one_more), &total, 1000),
            Err(NotSent::TooManyKeys)
        );
        // A gone socket's waiting events are dropped.
        outbox.forget_socket(1);
        assert!(!outbox.has_waiting());
    }

    #[test]
    fn the_connection_keeps_room_for_the_heartbeat() {
        let channel = Channel::new(HEADROOM + 2);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(HEADROOM + 2);
        for socket in 1..=3 {
            outbox.open_socket(socket);
        }
        let lossy = Delivery::Lossy;
        let big = QueueLimits {
            packets: 100,
            bytes: 1000,
        };
        let send = |outbox: &mut Outbox, socket| {
            outbox.push(
                &channel,
                Outgoing {
                    socket: Some((socket, big)),
                    packet: "p".to_owned(),
                    delivery: &lossy,
                },
                &total,
                1000,
            )
        };
        assert_eq!(send(&mut outbox, 1), Ok(()));
        assert_eq!(send(&mut outbox, 2), Ok(()));
        assert_eq!(send(&mut outbox, 3), Err(NotSent::Dropped));
        // Control packets have their own share.
        let control = Outgoing {
            socket: None,
            packet: "4{}".to_owned(),
            delivery: &lossy,
        };
        assert_eq!(
            outbox.push(&channel, control, &total, 1000),
            Err(NotSent::Dropped)
        );
    }

    /// Finding 1: a socket that leaves takes its usage entry with it in every order of events
    /// (leaving with packets queued and draining afterwards, draining first, leaving before
    /// sending anything), and a send racing with the departure cannot bring it back. The map
    /// never holds more than the live sockets plus the retired ones with packets queued.
    #[test]
    fn retired_sockets_leave_the_usage_map_in_every_order() {
        let channel = Channel::new(10_000);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(10_000);
        let reliable = Delivery::Reliable;
        let send = |outbox: &mut Outbox, socket: u64| {
            outbox.push(
                &channel,
                Outgoing {
                    socket: Some((socket, LIMITS)),
                    packet: "p".to_owned(),
                    delivery: &reliable,
                },
                &total,
                1 << 20,
            )
        };
        for round in 0..1000_u64 {
            let key = round * 3;
            // Leaves with its packet queued (a CONNECT the client has not polled yet).
            outbox.open_socket(key);
            assert_eq!(send(&mut outbox, key), Ok(()));
            outbox.forget_socket(key);
            assert_eq!(send(&mut outbox, key), Err(NotSent::Closed));
            // Leaves before it sent anything.
            outbox.open_socket(key + 1);
            outbox.forget_socket(key + 1);
            assert_eq!(send(&mut outbox, key + 1), Err(NotSent::Closed));
            // Drains first, then leaves.
            outbox.open_socket(key + 2);
            assert_eq!(send(&mut outbox, key + 2), Ok(()));
            channel.take(10);
            outbox.sweep(&total);
            outbox.forget_socket(key + 2);
            assert_eq!(outbox.tracked_sockets(), 0, "round {round}");
        }
        // Many leave with packets queued: entries stay only until those are released.
        for key in 0..100 {
            outbox.open_socket(10_000 + key);
            assert_eq!(send(&mut outbox, 10_000 + key), Ok(()));
            outbox.forget_socket(10_000 + key);
        }
        assert_eq!(outbox.tracked_sockets(), 100);
        channel.take(1000);
        outbox.sweep(&total);
        assert_eq!(outbox.tracked_sockets(), 0);
        assert_eq!(total.load(Ordering::Acquire), 0);
    }
}
