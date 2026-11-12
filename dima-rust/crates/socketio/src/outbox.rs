//! What one connection holds for its client, and the slow-consumer policy.
//!
//! Every byte of output this crate keeps is charged until it is really gone: to the socket that
//! sent it, to its connection and to the server-wide `max_outbound_total`, each charge taken
//! before the packet is kept (a reservation, never a check followed by an increment).
//!
//! - **In the transport.** A packet handed to Engine.IO stays charged until the transport says
//!   it is done (`engineioxide`'s `messages_done`, patch 7 of `vendor/README.md`): over WebSocket
//!   flushed to the connection, over polling in a response body the HTTP layer has dropped (the
//!   service keeps Engine.IO's body alive inside its own, compressed or not, until the response
//!   is written), or dropped because the session ended. Engine.IO numbers the messages it is
//!   handed and finishes them in that order, so the outbox numbers its hand-overs the same way
//!   and releases, oldest first, every packet whose number is at most the transport's count.
//! - **Waiting in a slot.** A replaceable packet that does not fit waits in its key's slot,
//!   charged the same way, until it is handed over or replaced (the difference is charged or
//!   given back) or its socket leaves.
//!
//! Bounds, per socket ([`QueueLimits`]): packets in the transport at most `packets`, their bytes
//! at most `bytes` (one larger packet when nothing else of the socket is in the transport);
//! slots at most [`MAX_PENDING_KEYS`], their bytes at most `bytes` (one larger packet when no
//! other slot waits). Per connection: a packet count that leaves room in the transport channel
//! for heartbeats and the close packet. Server-wide: `max_outbound_total` bytes. A packet that
//! does not fit is handled by its [`Delivery`]; a replaceable one that cannot get a slot within
//! these bounds closes the connection as a slow consumer, as a reliable one does (the newest
//! snapshot is never silently lost).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicUsize;

use engineioxide::Str;

use crate::budget::{release, reserve};
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
    /// may arrive after events emitted later. At most [`MAX_PENDING_KEYS`] keys wait per socket,
    /// and their slots count against the socket's byte bound; a snapshot that cannot wait
    /// within it closes the connection as a slow consumer.
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
    /// The number of this hand-over (the transport's count of finished messages reaches it
    /// when this packet is done).
    seq: u64,
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
    /// Packets of the socket in the transport, and their bytes.
    packets: usize,
    bytes: usize,
    /// Bytes of the socket's waiting slots.
    waiting: usize,
    /// Slots of the socket.
    keys: usize,
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
    /// The transport is gone, or the socket has left.
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
    /// Hands one message to Engine.IO.
    fn send(&self, message: Str) -> Result<(), TransportFull>;
    /// How many of the messages handed over so far are done (written, or dropped with the
    /// session), counted in the order they were handed over.
    fn done(&self) -> u64;
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
    /// Bytes charged to this connection: in the transport and in slots.
    bytes: usize,
    /// Messages handed to the transport so far.
    handed: u64,
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
            handed: 0,
            max_packets: capacity.saturating_sub(HEADROOM).max(1),
        }
    }

    /// Packets in the transport, not yet done.
    pub fn queued(&self) -> usize {
        self.in_flight.len()
    }

    /// Bytes charged to this connection (in the transport and in slots).
    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Whether anything is in the transport or waiting.
    pub fn busy(&self) -> bool {
        !self.in_flight.is_empty() || !self.waiting.is_empty()
    }

    /// Whether replaceable events wait for room.
    pub fn has_waiting(&self) -> bool {
        !self.waiting.is_empty()
    }

    /// Releases the packets the transport has finished (`done` is its count); returns how many.
    pub fn sweep(&mut self, done: u64, total: &AtomicUsize) -> usize {
        let mut released = 0;
        while self.in_flight.front().is_some_and(|t| t.seq <= done) {
            if let Some(tracked) = self.in_flight.pop_front() {
                self.release(&tracked, total);
                released += 1;
            }
        }
        released
    }

    fn release(&mut self, tracked: &Tracked, total: &AtomicUsize) {
        self.bytes = self.bytes.saturating_sub(tracked.len);
        release(total, tracked.len);
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

    /// Gives back the charge of a slot that is dropped.
    fn release_waiting(&mut self, waiting: &Waiting, total: &AtomicUsize) {
        let len = waiting.packet.len();
        self.bytes = self.bytes.saturating_sub(len);
        release(total, len);
        if let Some(usage) = self.sockets.get_mut(&waiting.socket) {
            usage.waiting = usage.waiting.saturating_sub(len);
            usage.keys = usage.keys.saturating_sub(1);
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
        while let Some(waiting) = self.waiting.pop_front() {
            self.release_waiting(&waiting, total);
        }
        self.sockets.clear();
    }

    /// The socket has left: its waiting events are dropped and its usage entry is removed now,
    /// or, while packets of it are still in the transport, when the last of them is released.
    pub fn forget_socket(&mut self, socket: u64, total: &AtomicUsize) {
        let mut kept = VecDeque::with_capacity(self.waiting.len());
        while let Some(waiting) = self.waiting.pop_front() {
            if waiting.socket == socket {
                self.release_waiting(&waiting, total);
            } else {
                kept.push_back(waiting);
            }
        }
        self.waiting = kept;
        match self.sockets.get_mut(&socket) {
            Some(usage) if usage.packets > 0 => usage.retired = true,
            Some(_) => {
                self.sockets.remove(&socket);
            }
            None => {}
        }
    }

    /// Whether a packet fits the connection's and its socket's bounds for the transport (the
    /// server-wide bytes are reserved separately).
    fn fits(&self, socket: Option<(u64, QueueLimits)>, len: usize) -> bool {
        if self.in_flight.len() >= self.max_packets {
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

    /// Hands over a packet whose bytes are already charged to this connection and the server.
    fn hand_over(
        &mut self,
        transport: &dyn Transport,
        socket: Option<u64>,
        packet: String,
    ) -> Result<(), TransportFull> {
        let len = packet.len();
        transport.send(Str::from(packet))?;
        self.handed += 1;
        if let Some(usage) = socket.and_then(|socket| self.sockets.get_mut(&socket)) {
            usage.packets += 1;
            usage.bytes += len;
        }
        self.in_flight.push_back(Tracked {
            seq: self.handed,
            len,
            socket,
        });
        Ok(())
    }

    /// Charges `len` new bytes to this connection and the server; `false` when the server-wide
    /// bound has no room.
    fn charge(&mut self, len: usize, total: &AtomicUsize, max_total: usize) -> bool {
        if !reserve(total, len, max_total) {
            return false;
        }
        self.bytes += len;
        true
    }

    fn uncharge(&mut self, len: usize, total: &AtomicUsize) {
        self.bytes = self.bytes.saturating_sub(len);
        release(total, len);
    }

    /// Sends one packet, or applies its delivery's policy when it does not fit.
    pub fn push(
        &mut self,
        transport: &dyn Transport,
        outgoing: Outgoing<'_>,
        total: &AtomicUsize,
        max_total: usize,
    ) -> Result<(), NotSent> {
        self.sweep(transport.done(), total);
        let len = outgoing.packet.len();
        let socket_key = outgoing.socket.map(|(key, _)| key);
        if socket_key.is_some_and(|key| self.sockets.get(&key).is_none_or(|usage| usage.retired)) {
            return Err(NotSent::Closed);
        }
        if self.fits(outgoing.socket, len) && self.charge(len, total, max_total) {
            // A newer replaceable event makes a waiting one with the same key obsolete.
            if let (Delivery::Replaceable(key), Some(socket)) = (outgoing.delivery, socket_key)
                && let Some(index) = self
                    .waiting
                    .iter()
                    .position(|w| w.socket == socket && &w.key == key)
                && let Some(old) = self.waiting.remove(index)
            {
                self.release_waiting(&old, total);
            }
            return match self.hand_over(transport, socket_key, outgoing.packet) {
                Ok(()) => Ok(()),
                Err(full) => {
                    self.uncharge(len, total);
                    Err(match full {
                        TransportFull::Full => NotSent::SlowConsumer,
                        TransportFull::Closed => NotSent::Closed,
                    })
                }
            };
        }
        match outgoing.delivery {
            Delivery::Reliable => Err(NotSent::SlowConsumer),
            Delivery::Lossy => Err(NotSent::Dropped),
            Delivery::Replaceable(key) => {
                let Some((socket, limits)) = outgoing.socket else {
                    return Err(NotSent::Dropped);
                };
                self.defer(socket, limits, key, outgoing.packet, total, max_total)
            }
        }
    }

    /// Puts a replaceable packet in its key's slot, charged.
    fn defer(
        &mut self,
        socket: u64,
        limits: QueueLimits,
        key: &str,
        packet: String,
        total: &AtomicUsize,
        max_total: usize,
    ) -> Result<(), NotSent> {
        let len = packet.len();
        let usage = self.sockets.get(&socket).copied().unwrap_or_default();
        if let Some(index) = self
            .waiting
            .iter()
            .position(|w| w.socket == socket && w.key == key)
        {
            let old = self.waiting.get(index).map_or(0, |w| w.packet.len());
            let others = usage.waiting.saturating_sub(old);
            if others > 0 && others.saturating_add(len) > limits.bytes {
                return Err(NotSent::SlowConsumer);
            }
            if len > old && !self.charge(len - old, total, max_total) {
                return Err(NotSent::SlowConsumer);
            }
            if old > len {
                self.uncharge(old - len, total);
            }
            if let Some(slot) = self.waiting.get_mut(index) {
                slot.packet = packet;
            }
            if let Some(usage) = self.sockets.get_mut(&socket) {
                usage.waiting = others + len;
            }
            return Err(NotSent::Deferred { replaced: true });
        }
        if usage.keys >= MAX_PENDING_KEYS {
            return Err(NotSent::TooManyKeys);
        }
        if usage.waiting > 0 && usage.waiting.saturating_add(len) > limits.bytes {
            return Err(NotSent::SlowConsumer);
        }
        if !self.charge(len, total, max_total) {
            return Err(NotSent::SlowConsumer);
        }
        if let Some(usage) = self.sockets.get_mut(&socket) {
            usage.waiting += len;
            usage.keys += 1;
        }
        self.waiting.push_back(Waiting {
            socket,
            limits,
            key: key.to_owned(),
            packet,
        });
        Err(NotSent::Deferred { replaced: false })
    }

    /// Sends the waiting replaceable events that fit now, oldest first (their bytes stay
    /// charged: they move from the slot to the transport).
    pub fn flush_waiting(&mut self, transport: &dyn Transport, total: &AtomicUsize) {
        self.sweep(transport.done(), total);
        let mut index = 0;
        while let Some(waiting) = self.waiting.get(index) {
            if !self.fits(Some((waiting.socket, waiting.limits)), waiting.packet.len()) {
                index += 1;
                continue;
            }
            let Some(waiting) = self.waiting.remove(index) else {
                return;
            };
            let len = waiting.packet.len();
            let socket = waiting.socket;
            match transport.send(Str::from(waiting.packet)) {
                Ok(()) => {
                    self.handed += 1;
                    if let Some(usage) = self.sockets.get_mut(&socket) {
                        usage.waiting = usage.waiting.saturating_sub(len);
                        usage.keys = usage.keys.saturating_sub(1);
                        usage.packets += 1;
                        usage.bytes += len;
                    }
                    self.in_flight.push_back(Tracked {
                        seq: self.handed,
                        len,
                        socket: Some(socket),
                    });
                }
                Err(_) => {
                    // The transport refused it: the slot is gone, so is its charge.
                    if let Some(usage) = self.sockets.get_mut(&socket) {
                        usage.waiting = usage.waiting.saturating_sub(len);
                        usage.keys = usage.keys.saturating_sub(1);
                    }
                    self.uncharge(len, total);
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A transport channel the test drains by hand. `take` hands messages to the "network"
    /// (the channel drops its copies); `write` reports the taken ones written.
    struct Channel {
        capacity: usize,
        queue: Mutex<VecDeque<Str>>,
        taken: AtomicU64,
        written: AtomicU64,
    }

    impl Channel {
        fn new(capacity: usize) -> Self {
            Self {
                capacity,
                queue: Mutex::new(VecDeque::new()),
                taken: AtomicU64::new(0),
                written: AtomicU64::new(0),
            }
        }
        /// Takes up to `n` messages and writes them.
        fn take(&self, n: usize) -> Vec<String> {
            let taken = self.take_unwritten(n);
            self.written
                .store(self.taken.load(Ordering::Acquire), Ordering::Release);
            taken
        }
        /// Takes up to `n` messages (encoded into a response that is not written yet).
        fn take_unwritten(&self, n: usize) -> Vec<String> {
            let mut queue = self.queue.lock().unwrap();
            let taken: Vec<String> = (0..n)
                .filter_map(|_| queue.pop_front().map(|s| s.to_string()))
                .collect();
            self.taken.fetch_add(taken.len() as u64, Ordering::AcqRel);
            taken
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
        fn done(&self) -> u64 {
            self.written.load(Ordering::Acquire)
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
        assert_eq!(outbox.sweep(channel.done(), &total), 2);
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
        assert_eq!(outbox.sweep(channel.done(), &total), 1);
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
        outbox.flush_waiting(&channel, &total);
        assert!(outbox.has_waiting());
        channel.take(1);
        outbox.flush_waiting(&channel, &total);
        assert!(!outbox.has_waiting());
        assert_eq!(channel.take(10), ["b", "c", "s2"]);
        // Too many keys (a socket whose byte bound leaves room for all of them).
        let roomy = QueueLimits {
            packets: 3,
            bytes: 1000,
        };
        outbox.open_socket(2);
        let send = |outbox: &mut Outbox, delivery: &Delivery| {
            outbox.push(
                &channel,
                Outgoing {
                    socket: Some((2, roomy)),
                    packet: "k".to_owned(),
                    delivery,
                },
                &total,
                1000,
            )
        };
        for _ in 0..3 {
            assert_eq!(send(&mut outbox, &reliable), Ok(()));
        }
        for key in 0..MAX_PENDING_KEYS {
            let delivery = Delivery::Replaceable(key.to_string());
            assert!(matches!(
                send(&mut outbox, &delivery),
                Err(NotSent::Deferred { .. })
            ));
        }
        let one_more = Delivery::Replaceable("more".to_owned());
        assert_eq!(send(&mut outbox, &one_more), Err(NotSent::TooManyKeys));
        // A gone socket's waiting events are dropped.
        outbox.forget_socket(2, &total);
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
            outbox.forget_socket(key, &total);
            assert_eq!(send(&mut outbox, key), Err(NotSent::Closed));
            // Leaves before it sent anything.
            outbox.open_socket(key + 1);
            outbox.forget_socket(key + 1, &total);
            assert_eq!(send(&mut outbox, key + 1), Err(NotSent::Closed));
            // Drains first, then leaves.
            outbox.open_socket(key + 2);
            assert_eq!(send(&mut outbox, key + 2), Ok(()));
            channel.take(10);
            outbox.sweep(channel.done(), &total);
            outbox.forget_socket(key + 2, &total);
            assert_eq!(outbox.tracked_sockets(), 0, "round {round}");
        }
        // Many leave with packets queued: entries stay only until those are released.
        for key in 0..100 {
            outbox.open_socket(10_000 + key);
            assert_eq!(send(&mut outbox, 10_000 + key), Ok(()));
            outbox.forget_socket(10_000 + key, &total);
        }
        assert_eq!(outbox.tracked_sockets(), 100);
        channel.take(1000);
        outbox.sweep(channel.done(), &total);
        assert_eq!(outbox.tracked_sockets(), 0);
        assert_eq!(total.load(Ordering::Acquire), 0);
    }

    /// Finding 4: a packet the transport has taken but not yet written (a polling payload whose
    /// response is not written, a WebSocket frame not flushed) is still charged; only the
    /// transport's count of finished messages releases it, oldest first.
    #[test]
    fn output_stays_charged_until_the_transport_has_written_it() {
        let channel = Channel::new(100);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(100);
        outbox.open_socket(1);
        let reliable = Delivery::Reliable;
        for packet in ["aaa", "bbb", "ccc"] {
            assert_eq!(outbox.push(&channel, out(packet, &reliable), &total, 1000), Ok(()));
        }
        // Engine.IO took all three (its copies are gone) but wrote none.
        assert_eq!(channel.take_unwritten(3).len(), 3);
        assert_eq!(outbox.sweep(channel.done(), &total), 0);
        assert_eq!(total.load(Ordering::Acquire), 9);
        assert_eq!(
            outbox.push(&channel, out("ddd", &reliable), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
        // Two of them are written.
        channel.written.store(2, Ordering::Release);
        assert_eq!(outbox.sweep(channel.done(), &total), 2);
        assert_eq!(total.load(Ordering::Acquire), 3);
        assert_eq!(outbox.bytes(), 3);
    }

    /// Finding 4: the slots of replaceable events are charged to the socket's byte bound and
    /// the server's total, replacing one charges only the difference, and a snapshot that
    /// cannot wait within those bounds closes the connection instead of being lost.
    #[test]
    fn replaceable_slots_are_charged() {
        let channel = Channel::new(100);
        let total = AtomicUsize::new(0);
        let mut outbox = Outbox::new(100);
        outbox.open_socket(1);
        let reliable = Delivery::Reliable;
        for packet in ["a", "b", "c"] {
            assert_eq!(outbox.push(&channel, out(packet, &reliable), &total, 1000), Ok(()));
        }
        let state = Delivery::Replaceable("state".to_owned());
        assert_eq!(
            outbox.push(&channel, out("s1", &state), &total, 1000),
            Err(NotSent::Deferred { replaced: false })
        );
        assert_eq!(total.load(Ordering::Acquire), 5);
        assert_eq!(
            outbox.push(&channel, out("s2222", &state), &total, 1000),
            Err(NotSent::Deferred { replaced: true })
        );
        assert_eq!(total.load(Ordering::Acquire), 8);
        // Slots of the socket: 5 bytes waiting, the bound is 10; another key of 6 would be 11.
        let other = Delivery::Replaceable("other".to_owned());
        assert_eq!(
            outbox.push(&channel, out("oooooo", &other), &total, 1000),
            Err(NotSent::SlowConsumer)
        );
        // The server-wide bound counts slots too.
        assert_eq!(
            outbox.push(&channel, out("o", &other), &total, 8),
            Err(NotSent::SlowConsumer)
        );
        // Room again: the slot moves to the transport, its charge with it.
        channel.take(3);
        outbox.flush_waiting(&channel, &total);
        assert!(!outbox.has_waiting());
        assert_eq!(total.load(Ordering::Acquire), 5);
        assert_eq!(channel.take(10), ["s2222"]);
        outbox.sweep(channel.done(), &total);
        assert_eq!(total.load(Ordering::Acquire), 0);
        // A socket that leaves gives its slots back.
        for packet in ["a", "b", "c"] {
            assert_eq!(outbox.push(&channel, out(packet, &reliable), &total, 1000), Ok(()));
        }
        let _ = outbox.push(&channel, out("s3", &state), &total, 1000);
        outbox.forget_socket(1, &total);
        channel.take(10);
        outbox.sweep(channel.done(), &total);
        assert_eq!(total.load(Ordering::Acquire), 0);
        assert_eq!(outbox.bytes(), 0);
    }
}
