# Vendored crates

Third-party crates the workspace carries with a small set of local changes. Upstream is not ours
to wait for; each change here is listed with its reason and the test that shows it.

## What is here

| Directory | Crate | Version | Checksum of the published `.crate` (as `Cargo.lock` had it) | Upstream commit (`.cargo_vcs_info.json`) |
|---|---|---|---|---|
| `engineioxide/` | `engineioxide` | 0.17.7 | `0235543b6e1a5fef2a8a7871ae410d5d1c440d8ced9217ec0f1b344edfe30673` | `708ea9fc5ee549229d7236924e4975ec5977a59c`, `crates/engineioxide` |
| `engineioxide-core/` | `engineioxide-core` | 0.2.2 | `06c5f98b2d2338ec0713bc222c753bfd18746bd76cbb115afa18aa07c6096553` | `511e6e8a525b8047bd9c5bc8199578b014044f85`, `crates/engineioxide-core` |

Source: crates.io, <https://github.com/totodore/socketioxide>. The first commit that added this
directory holds the two packages exactly as published (every file of the `.crate` archives); every
later commit touching it is one numbered change below.

**Licence.** Both crates are MIT (`license = "MIT"` in their `Cargo.toml`). The published packages
contain no licence file, so none could be copied from them; upstream's `LICENSE` is at the root of
the repository at the commits above. It has to be added next to each crate before any of this is
distributed outside the company (open question for the lead; it was not fetched here).

## How it is wired

- `dima-rust/Cargo.toml` has `[patch.crates-io]` entries for both crates, so every crate of the
  workspace uses these copies (`dima-socketio`, and `socketioxide` of the root crate's `socketio`
  feature, which depends on `engineioxide` too).
- The main workspace excludes `vendor/` (`exclude = ["vendor"]`): the crates are not members, so
  the workspace lints, `tools/check --all`, `cargo fmt --all` and `clippy --workspace` leave them
  alone. They keep upstream's own `[lints]`.
- `vendor/Cargo.toml` is a small workspace of their own, with its own `Cargo.lock` (seeded from
  the main lock file, so the versions are the ones production builds with), to run their tests,
  whose dev-dependencies the main lock file does not carry. Upstream's unit tests of
  `engineioxide-core` only compile with its `v3` feature, so the tests run with all features:

  ```sh
  cd dima-rust/vendor
  ../tools/cargo test --locked --offline --all-features
  ../tools/cargo clippy --locked --offline --all-features --all-targets
  ../tools/cargo fmt --all -- --check     # upstream's code is rustfmt-clean; keep it so
  ```

  Cargo warns twice that the `resolver` key of the members is ignored: that key is upstream's.

## Rules for changing it

- Change only what a numbered entry below needs. No reformatting, no renaming, no tidying: every
  line that differs from upstream must belong to an entry, so the difference can be audited.
- Every entry says what changed, why (the `engine.io` 6.6.9 source it matches, when it is about
  behaviour), and which test shows it. A test fails before the change and passes after it.
- New code: no `unwrap`, `expect`, `panic!` or byte slicing of text on any path that network input
  can reach, and no `unsafe`.
- Upgrading upstream: start from the new published packages in a commit of their own, then re-apply
  each entry that is still needed, and update this file.

## Seeing the difference from upstream

Against the registry copy that Cargo extracted (`.cargo-ok` is Cargo's marker, not a package file):

```sh
cd dima-rust/vendor
diff -ru -x .cargo-ok ~/.cargo/registry/src/index.crates.io-*/engineioxide-0.17.7 engineioxide
diff -ru -x .cargo-ok ~/.cargo/registry/src/index.crates.io-*/engineioxide-core-0.2.2 engineioxide-core
```

or with Git, from the commit that added the untouched copy:

```sh
git log --oneline -- dima-rust/vendor          # the first entry is the untouched copy
git diff <that commit> -- dima-rust/vendor
```

## Changes

0. **Manifest: no benchmarks.** `engineioxide/Cargo.toml`: the two `[[bench]]` targets and the
   `criterion` (`codspeed-criterion-compat`) dev-dependency are removed. Cargo resolves every
   dev-dependency to run any test, and that one is not in the local registry (it would pull a
   large tree for benchmarks nobody runs here). The bench sources stay in `benches/`.

1. **A failed upgrade leaves the session on polling.** `transport/ws.rs` (`new_req`, `on_init`,
   `upgrade_handshake`, new `pause_polling` and `close_unused_ws`), `socket.rs`
   (`cancel_upgrade`), `transport/polling.rs` (`polling_req`).
   Upstream ended the whole session when an upgrade failed after the WebSocket handshake (the
   probe never completed, the new WebSocket closed or sent something else): a client behind a
   network that breaks WebSockets reconnected every upgrade timeout, for ever. `engine.io`
   closes only the new transport and the session carries on over polling (socket.js 211-218
   timeout, 243-246 other packet, 264-275 transport closed or error, socket closed). Now the
   new WebSocket gets a close frame (bounded by `ws`'s 30 s close timeout, ws/lib/websocket.js
   `close`/`setCloseTimer`) and the session is untouched. The probe loop follows socket.js
   220-247: repeated probe pings are answered, control frames are skipped, an upgrade packet is
   accepted without a probe. Polls are answered with noops only once the probe has been
   answered (`check` starts on the probe, socket.js 225-226), and then after 100 ms, the
   interval of that check (socket.js 249-254), not at once: a client that missed the probe
   answer polled in a tight loop until the upgrade timeout.
   Tests: `tests/upgrade.rs` (six cases: timeout before and after the probe, client closing the
   probe WebSocket, wrong packet, polls carry data before the probe, noop pacing); upstream's
   `ws_upgrade_abandoned_timeout` and `ws_upgrade_abandoned_parked_heartbeat_timeout`
   (`tests/disconnect_reason.rs`) asserted the old behaviour and now assert that such a session
   is still reclaimed by the heartbeat (the leak they guard against, upstream issue 731);
   `dima-socketio`'s differential cases `short: upgrade probe lost on the way up` and `… answer
   lost on the way down`. `tests/upgrade.rs` is declared in `Cargo.toml` (`autotests = false`).

2. **One upgrade at a time.** `socket.rs` (`upgrade_owned`, `claim_upgrade`; `cancel_upgrade`
   releases it), `transport/ws.rs` (`on_init`). Two simultaneous probes could both pass the
   `is_ws()` check, because starting an upgrade was an unconditional store; both answered the
   probe, then contended for the packet buffer (the WebSocket writer's `try_lock().unwrap()`
   panicked) or one closed a session the other had upgraded. Upgrade ownership is now a single
   compare-and-set, held from the WebSocket handshake until the upgrade fails, and kept once it
   succeeded. Another WebSocket for the session gets a close frame after its handshake and the
   session is untouched (engine.io server.js 616-618 "already been trying to upgrade", 620-622
   "already been upgraded").
   Tests: `tests/upgrade.rs` (`a_second_probe_during_an_upgrade_is_refused`,
   `a_probe_after_the_upgrade_is_refused`, `simultaneous_probes_upgrade_once`); `dima-socketio`'s
   differential case `upgrade races`.

3. **The WebSocket writer neither panics nor holds the packet buffer for ever.**
   `transport/ws.rs` (`forward_to_socket`). Upstream took the session's packet buffer with
   `try_lock().unwrap()`, which panicked when a client closed right after upgrading (the close
   task in `EngineIo::close_session`, engine.rs 97-107, may take the lock first). The lock is
   now awaited, and given up if the session closes meanwhile. Upstream also wrote and flushed
   inside the arms of its `select!`, so a peer that stopped reading kept the writer blocked
   while it held the lock that the close task waits for: `on_disconnect` never ran (the reason
   `dima-socketio` aborts the upgraded socket through `UpgradeGuard::abort`, which keeps
   working and now rarely has anything to do). The whole forwarding loop is now raced against
   the session's cancellation; the lock is released first, then the closing flush and close
   frame are attempted within the 30 s close timeout of change 1.
   Tests: `transport::ws::tests::the_writer_does_not_panic_when_the_buffer_is_taken` and
   `…::a_writer_blocked_on_a_silent_peer_does_not_hold_up_the_close` (unit tests over an
   in-memory pipe nobody reads); `dima-socketio`'s adversarial and differential suites pass
   unchanged.

4. **Text that is not a packet never panics.** `engineioxide-core/src/packet.rs`
   (`Packet::parse`). The six bytes `é1234` reached `&value[1..6]` before the packet type was
   checked, cutting inside `é`: the WebSocket reader task died (the session stayed open with
   nobody reading it until the heartbeat ended it) and a polling POST panicked. The probe text
   is now compared as bytes, and only for types `2` and `3`; an unknown type is a parse error
   that closes the session, as in `engine.io` (engine.io-parser decodePacket returns its error
   packet, socket.js 113-115). Protocol 3 (feature `v3`, unused here): a lone `b` reached
   `slice(2..)` and panicked; it is now an invalid payload.
   Tests: `packet::tests::parse_rejects_what_is_not_a_packet_without_panicking`,
   `…::parse_recognises_the_probe_only_exactly`, `…::parse_never_panics_on_short_texts` (every
   text up to four characters over packet types, probe letters and multi-byte characters, both
   protocols); `tests/input.rs` (`a_six_byte_text_that_is_not_a_packet_closes_a_websocket_session`,
   `…_polling_session`); `dima-socketio`'s differential case `a six-byte text that is not a
   packet`.

   **The audit**: every slice, index, `unwrap`, `expect`, `panic!` and length arithmetic in both
   crates that client input can reach, and what was done with it.

   | Where | What | Verdict |
   |---|---|---|
   | core `packet.rs` `Packet::parse` | `&value[1..6]` before the type check | **failed**: fixed above |
   | core `packet.rs` `Packet::parse` | `value.slice(2..)` for a protocol 3 `b` | **failed** (v3 only): fixed above |
   | core `packet.rs` `Packet::parse` | `value.slice(1..)` for `4` and `b` | after one ASCII byte: cannot fail |
   | core `payload/decoder.rs` `poll_body` | `current_payload_size + data.remaining()` (u64) | cannot overflow below a configured maximum of 2^63; POSTs are read by change 5's own bounded reader first |
   | core `payload/decoder.rs` v4 | `read_until` on the in-memory `BufList`, `unreachable!` after `is_data()` | infallible |
   | core `payload/decoder.rs` v3 (feature `v3`) | `&packet_buf[1..]` after `first()` matched; `packet_type.unwrap()` once the header set it; `read_to_end`/`fill_buf().unwrap()` on memory; `i + 1 - old_len` (the separator is never in the old part); `remaining - available.len()`; `&packet_buf[..i]` from `memchr`; unchecked UTF-8 of a `valid_up_to` prefix | cannot fail |
   | core `payload/buf.rs` | `dst[vecs..]`, `bufs[0]` in `advance`, the `copy_to_bytes` assert | only on over-consumption, which the decoders never ask for |
   | core `sid.rs` `Sid::from_str` | `as_bytes()[0..16]` | after the length check: cannot fail |
   | core `payload/encoder.rs` | sizes and digit arithmetic | server output bounded by `max_payload`: cannot fail |
   | `transport/ws.rs` `forward_to_socket` | `try_lock().unwrap()` | **failed**: fixed in change 3 |
   | `transport/ws.rs` | `split_off(1)` (v3 binary, after `!is_empty()`), the accept-key header parse, `String::try_from(packet).unwrap()` (infallible conversion) | cannot fail |
   | `socket.rs` | heartbeat `try_lock().expect` (one heartbeat job per session), `pop().unwrap()` of the one packet just sent, `into_message`/`into_binary` of the packet just built | cannot fail |
   | `socket.rs` / transports | a second pong while one is pending: `try_send` failure mapped to `HeartbeatTimeout` | not a panic, but **ended the session**: fixed in change 6 |
   | `transport/polling.rs` | packet-buffer `try_lock` | handled (overlap closes the session) |
   | `engine.rs` | `RwLock` `unwrap` | poisoning needs a panic under the lock; none can happen |
   | `service/parser.rs` | query parsing (`split`, `find`, `nth`), `Sid` parse | returns errors |
   | `errors.rs`, `service/futures.rs`, `service/mod.rs`, `transport/polling.rs` | response builders | constant status and headers: cannot fail |

5. **A polling POST is read whole before any of its packets is handled.**
   `transport/polling.rs` (`post_req`, new `read_body` and `BodyError`). Upstream's streaming
   decoder handed each complete packet at the front of the body to the handler before the rest
   had arrived or been checked, so a chunked POST could cause work and then stall, or exceed the
   size limit after its first packets were acted on (and the session was then closed, where
   `engine.io` keeps it). `engine.io` buffers the body, answers 413 as soon as it exceeds
   `maxHttpBufferSize` without handling anything and without closing the session, treats a
   request that breaks off as a transport error, and handles the packets only on `end`
   (polling.js 106-133). Now the body is read in full, under `max_payload`, before the first
   packet is dispatched; the read ends with the session (the heartbeat ends a session whose
   client is stuck in a POST, as in `engine.io`, which has no deadline of its own) and at the
   latest after a ping interval plus a ping timeout (transport error). A payload with a
   malformed packet handles the packets before it, closes the session and is answered `200 ok`,
   as `engine.io` does (engine.io-parser `decodePayload` stops at the error packet; polling.js
   120-131 answers once the payload is handled); upstream answered 400.
   Tests: `tests/input.rs` (`a_post_is_handled_only_once_it_has_fully_arrived`,
   `an_oversized_post_handles_none_of_its_packets_and_keeps_the_session`,
   `a_stalled_post_is_given_up_without_handling_its_packets`,
   `a_post_that_breaks_off_closes_the_session_without_handling_its_packets`,
   `a_malformed_packet_in_a_post_ends_the_session_after_the_packets_before_it`);
   `dima-socketio`'s differential cases `a POST that arrives in pieces`, `an oversized POST that
   starts with a valid packet`, `a six-byte text that is not a packet: the POST answer`.
