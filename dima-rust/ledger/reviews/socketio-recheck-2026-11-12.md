# Re-check of `dima-socketio` at `1b2e940e` (GPT-6.1 Sol, 2026-11-12)

After F-SOCKETIO-b. Of the twelve findings fixed in the crate: 1, 2, 5, 8 and 13 are closed; 3,
4, 6, 7, 9, 14 and 16 are partly closed, as below. The lead's decision follows each point; the
fixes are package F-SOCKETIO-c.

**H1, SECURITY. Long-polling escapes the outbound budget.** Queue a large event, request its
poll, stop reading: the HTTP layer takes the last frame and drops the holder while the bytes are
still unwritten, and the charge is released. An 8 MiB response was charged as zero after 300 ms
with no client reads; repeated over slow connections this passes the 128 MiB budget. Reproduced.
`service.rs:479`.
*Decision: taken.* The reservation stays with the bytes until the write has completed.

**H2, SECURITY. A stalled replay pins evicted packets outside the recovery budget.** Begin a
restore, stall its output, append enough events to evict its batch: the batch keeps references
while the store has already subtracted their cost. Reproduced. `recovery.rs:607`,
`namespace.rs:784`.
*Decision: taken.* The byte reservation is shared by the store and the replay and released with
the last owner.

**H3, SECURITY. Fair eviction can be gamed with made-up namespaces.** Spread sessions over
arbitrary pattern names and the real channel, which holds several, gives first. Reproduced with
three slots. `recovery.rs:443`.
*Decision: taken.* A namespace's check says who the session belongs to; quotas and eviction are
grouped by that verified owner, and sessions without one share a separate, smaller pool that
cannot take from the others.

**H4, SECURITY. Cancelled requests queue duplicate compressions** of a client file, and those
jobs are outside the shutdown report. Reproduced (eight cancellations, eight jobs).
`client_files.rs:136`, `service.rs:435`.
*Decision: taken, more simply.* The client files are static: they are compressed once when the
server is built, and nothing is compressed on a request.

**H5, RISK. Session size misses what a JSON map keeps allocated** after entries were removed.
Reproduced. `size.rs:195`.
*Decision: taken.* Maps are compacted when a session is retained, or measured by capacity.

**H6, RISK. A handler that never yields defeats its deadline** and a recovery's wait for the old
socket's handlers has no deadline of its own. Reasoned. `namespace.rs:428`, `namespace.rs:545`.
*Decision: the wait gets its own deadline; the rest is a rule for handlers* (they are async and
must not block a thread; heavy work is offloaded by the handler's owner), written into the
crate's docs. A separate executor for handlers is set aside.

**H7, minor. A failed recovery runs the check twice** where an unknown session runs it once.
*Decision: taken.* The first refusal is kept and a check with side effects is not repeated.

Found sound: the size bound before parsing (escapes, saturating arithmetic); reservations and
acknowledgement slots on errors, cancellation and unwinding; atomic claiming of a session; replay
filtering by namespace and recipient; the discontinuity barrier; reservation of the connection
and its stream before the handshake.

## What the proxy in front must provide

The crate has no limit per address or before authentication: unauthenticated clients can hold all
4,096 connections, and the transport can be receiving one message of up to 1 MB on each (about
3.8 GiB at once). The reverse proxy must limit connections and handshake rate per client address,
bound uploads in flight and header sizes, and time out slow clients. The Node server it replaces
has none of these limits of its own either.
