# dima-hoststats (Rust): notes

Baseline: fast-forwarded rust-v2 to 655af798. Owned-path-only implementation; never deployed,
never built or started containers, never tested against a real Docker socket. No external
network used. Cargo builds use the capped wrapper, scoped to dima-hoststats, offline.

## Implementation and verification

Library build(config, clock, random), thin binary, dima-web HTTP, dima-core clock/shutdown,
dima-text number coercion/formatting, ordered JSON, ISO dates, scalar truncation and ICU sorting.
Workspace membership uses the existing services/* glob; no workspace-manifest edit needed.
Only selected fields cross the HTTP boundary. Docker uses a small GET-only Unix HTTP transport,
checks the complete path before connect, decodes chunked bodies, caps decoded bodies at 16 MiB,
and bounds headers at 64 KiB. Project selection precedes inspect. At most four container reads
run concurrently. Previous counters are removed when a container disappears. Rates reject resets.
The independent df task is cancelled and joined at shutdown, as is an in-flight sample.

The original four parser tests are ported through exact input/output vectors captured while
executing those Node tests; the two remaining tests become fake-socket allowlist and sampler
integration tests. Additional tests cover chunking, oversize, timeout, non-200, stopped state,
Unicode, resets, project filtering, disappearance, version caching, HTTP headers, stale health,
startup, healthcheck mode and SIGINT/SIGTERM. The fake proc fixture matches the reference.
Disk-space projection uses the same 100-block statfs fixture as the reference in a pure test;
integration additionally asserts real statfs output.

Rig: routes (13 steps) and sampling (4 steps). Reference recorded twice for stability. All 17
steps match, no comparison allowances. Fixed proc/network fixture and deliberately absent socket;
nonexistent disk path avoids unrelated disk-use drift. Rig normalises sample ISO timestamps;
second-sample rates remain checked. Captures retain raw reference outputs.

## Preserved timing and quirks

15,000 ms default sample interval (minimum 5,000); busy ticks are skipped, one sample completes
before listen. df refresh 600,000 ms (minimum 60,000), independently, one active read; previous df
survives failure, failed reads update df attempt time. A null df retries on a subsequent sample.
Docker version expires only after >3,600,000 ms; failed refresh retains its previous value.
Health turns stale at >=4 sample intervals since the last attempt, even if that attempt failed.
No retry sleeps or backoffs are introduced. GET query strings and trailing slash are not routes;
HEAD and every non-GET method return 405, including on unknown paths.

Reference issues reported without silently repairing behavior:
- Non-numeric intervals produce NaN and an approximately 1 ms Node timer: unsafe polling pressure.
- A Docker stats failure after an earlier CPU counter makes containerView dereference null;
  the row is consequently omitted. Rust preserves the failed-row outcome explicitly.
- Docker's read-only socket mount does not restrict API capabilities. The application allowlist
  remains the actual boundary. Global df totals intentionally include non-allowlisted projects;
  per-container rows are filtered, but disk aggregates are daemon-wide in the reference.

## Intentional differences and remaining cutover work

- Invalid/non-finite intervals fall back to documented defaults (inventory-directed safety fix).
- Truncation counts complete Unicode scalar values, as requested, instead of JS UTF-16 slices:
  image 200; service/image ID 80; state 20; policy 40; volume names 128; error text 120.
  These are display bounds, not money or identity. User-visible ordering uses shared ICU.
- Docker deadlines are total elapsed 5,000 ms (normal) / 120,000 ms (df), not Node's socket
  inactivity timeout. This bounds slow-drip responses. HTTP headers gain a 64 KiB bound.
- Invalid PORT terminates cleanly; exact Node exception text is not reproduced.
- The Rust image runs numeric 65532:65532. It requires reviewed Compose/ops changes to replace
  `node src/index.mjs` with `/app/dima-hoststats` and the JS healthcheck with native
  `/app/dima-hoststats --healthcheck`. Existing group_add=983, socket/proc mounts, read-only root,
  all dropped capabilities, no-new-privileges, limits, internal network and no published port
  must remain. Dockerfile is supplied but deliberately not built.

No shared crate gaps and no new external dependencies. The narrow HTTP client is local because
the shared HTTP client serves TCP/TLS APIs, not this restricted Unix-socket boundary.

## Resource measurement

See bench.py and bench-results.json. Release Rust and Node run concurrently with identical
fixture files, absent Docker socket, real statfs('/'), 15 s sampling. Read VmRSS from /proc/PID/status
and user+system CPU ticks from /proc/PID/stat, divided by sysconf(SC_CLK_TCK). First reading follows
HTTP health readiness; second follows 300 seconds of sampling. Startup CPU includes process startup;
sampling CPU is the difference. Processes are terminated and reaped and temporary files removed.
These numbers measure the socket-absent workload, not a populated Docker daemon.

Open questions: approval and implementation of Compose/ops changes belong to the lead's eventual
cutover package. No deployment is authorised for this package. Final gate output is retained in gate-output.txt.

Measured RSS (KiB): Node 65,580 after readiness / 15,416 after 300 s;
Rust 6,964 / 4,812. CPU user+system: Node 0.13 / 0.24 seconds; Rust 0.00 / 0.06 seconds.
Sampling-only CPU delta: Node 0.11 s, Rust 0.06 s (100 Hz quantisation).
RSS falling reflects resident-page reclamation on the shared laptop; this is neither peak RSS
nor PSS and does not establish worst-case memory usage. Measured binary SHA and the small final
source refactors after measurement are recorded in bench-results.json. No Docker-connected
performance claim is made.
