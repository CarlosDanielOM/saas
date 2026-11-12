# dimafx-server

Stateless replacement for `dimafx/server/src`: eight HTTP routes, Twitch HS256 authentication,
channel checks, viewer identity, and forwarding to dimabot. The library's `build` accepts typed
configuration, a clock and shutdown; only `main` reads the environment. No browser files change.
Workspace membership uses the existing `services/*` glob. No new external dependencies.

## Build and verify

From the repository root (leave `CARGO_TARGET_DIR` unset):

```sh
eval "$(dima-rust/tools/test-env)"
dima-rust/tools/check dimafx-server
(cd dima-rust && tools/cargo build --offline --release -p dimafx-server)
python3 dima-rust/services/dimafx-server/tests/resources.py "$PWD/dima-rust/target/release/dimafx-server"
DIMA_RESOURCE_SIGNAL=SIGINT python3 dima-rust/services/dimafx-server/tests/resources.py "$PWD/dima-rust/target/release/dimafx-server"
```

`tests/service.rs` ports every assertion of the reference's ops behaviour check (there are no
project tests), then covers all other routes, JSON types/omissions, null upstream exception answers, parser/CORS ordering, fallback
and encoded paths. `tests/auth.rs` pins expiry, signing candidates, constant-time primitive use,
and unverified-mode gating. Regenerate the Node decoder corpus from the crate directory:
`node tests/node-base64.mjs > tests/node-base64.json`. The committed 20-case corpus came from
Node v26.13.0: both alphabets, padding, missing padding, junk, partial groups, nonzero trailing
bits and low UTF-16 bytes of non-ASCII input. Both base64 decoders produce the same candidate;
that candidate is deduplicated, with raw UTF-8 as the other key. No token/secret is logged.

## Side-by-side rig

Eight scenarios, 32 HTTP steps, cover all routes, refusals, both signing keys, parser errors,
preflight and upstream JSON/error/non-JSON/5xx/network fallback. The rig mock records outbound
calls, including replayed purchase bodies and service headers. Bases encode the mock's real-host
prefix convention (`dima-server:3000` and `api.domdimabot.com`).

Reference execution is **blocked**: neither
`/home/dom/Projects/saas/dimafx/server/node_modules` nor its `dist/index.js` exists; worktree
packages are absent too. Nothing was installed, built for Node, or recorded. Captures must not
be fabricated. The target runs `node dist/index.js`, exactly the package's `start` script.
When the lead supplies the installed/compiled reference, run:

```sh
eval "$(dima-rust/tools/test-env)"
RIG=dima-rust/target/debug/dima-rig
# Explicit paths also work with a seeded rig binary compiled in the main checkout.
"$RIG" --rig-dir "$PWD/dima-rust/rig" --byte-sensitive "$PWD/dima-rust/rig/byte_sensitive.json" record dimafx-server --label 0c71108e
"$RIG" --rig-dir "$PWD/dima-rust/rig" --byte-sensitive "$PWD/dima-rust/rig/byte_sensitive.json" verify dimafx-server
```

Rig `check` parsed all eight scenarios successfully; `verify` reports eight missing captures.
The independent loopback resource runner exercised all 32 candidate steps and 19 outbound calls;
this is candidate verification, not a reference comparison. It uses the same scenario JSON and
can run Node unchanged by supplying `node /absolute/path/to/dist/index.js` as its command.

## Resource measurements (2026-11-11)

Release Rust, two tokio runtime threads; RSS from `/proc/PID/status`, cumulative user+system CPU
from `/proc/PID/stat` at the kernel tick resolution. Same process measured immediately after
health readiness and after all scenarios; no containers, no outside hosts. SIGTERM run:
8,304 KiB RSS / 0.00 s CPU at readiness; 8,748 KiB / 0.02 s after 32 steps.
SIGINT repeat: 8,440 KiB / 0.00 s, then 8,900 KiB / 0.02 s. Both exited zero on their signal.
Node resource comparison is unavailable for the same missing dependencies/entrypoint reason;
these numbers establish no comparative performance claim. The runner is retained for equal-method
measurement once Node is runnable. No generated logs or measurement files are committed.

## Compatibility, intended differences and limitations

- All six environment names/defaults and port 8080 are preserved. Body fields are selected without
  validation: absent stays omitted, explicit null and every JSON type stay present. Identity comes
  only from JWT claims. URI escaping uses `dima-text::encode_uri_component`, an outside-contract
  encoding, with no user-text length/cut/order operations. The only size checks are transport bounds.
- **Preserved weakness:** failed internal calls replay to the public API with the service token,
  including purchases. There is no idempotency enforcement here; a committed internal purchase
  with a lost answer can be repeated. No retry beyond this reference fallback is added.
- **Reference image runs as root.** `Dockerfile.rust` intentionally uses uid/gid 65532. It requires
  repository-root build context; Compose and deployment tooling are deliberately untouched. It was
  not built. It retains port/executable container behavior, not the old Node installation.
- Intended additions: 30-second complete/header/idle timeout per upstream attempt (at most two
  attempts), an 8 MiB upstream answer bound and 128-call concurrency bound, graceful SIGINT/SIGTERM with dima-web's bounded drain,
  and inherited dima-web request/connection limits. There are no workers, schedules or sleeps.
- Transport exceptions answer generic `fetch failed` rather than leaking URLs/credentials. Ordinary
  connection drops match Node's message; exotic transport exception wording is not pinned.
- Shared `dima-web` intentionally omits Express's X-Powered-By and does not reproduce exact HTML
  parser-error text/ETag values (migration charter excludes these from contract).
- Other preserved reference concerns: expiry is optional, zero or nonnumeric expiry bypasses expiry
  checks, and unverified mode ignores expiry. No audience/nbf/role validation or rate limit. Raw UTF-8
  secret fallback broadens accepted signing keys. `/me` returns HTTP 200 for error envelopes without
  status. Upstream envelope status can override HTTP status. These are not silently repaired.
- Shared gaps: `dima-core` has strict base64, so the explicitly marked auth module supplies Node's
  lenient decoder. `dima-http::Path` only permits static paths or RFC3986-escaped arguments; the
  request-local provider workaround preserves JS punctuation and percent escapes using a fixed
  empty suffix, while sharing the HttpClient connection pool. No shared crates were modified.

Open work: installed/compiled Node reference, real recordings and diff verification, equal-method
Node resource measurements, and the lead's eventual container/ops integration. Nothing was deployed
or pushed, and no container was started, stopped or built.
