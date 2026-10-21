# Exact-image dashboard Rust behavior suite

The lead runs the existing capped compiler/build and verification workflow. This suite never builds, deploys, connects to production, or changes image binaries. It exercises `/usr/local/bin/dashboard_activity` and the actual compiled cron supervisor. Every foreign supervisor child is replaced with an inert fixture process object, including other native workers and all TypeScript workers.

Stage the fixtures **and the exact analytics validator source**, then verify the candidate:

```sh
set -eu
DASHBOARD_RUST_FIXTURES=$(mktemp -d /tmp/dashboard-activity-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$DASHBOARD_RUST_FIXTURES"' EXIT
cp ops/checks/dashboard-activity-rust-fixtures/*.mjs "$DASHBOARD_RUST_FIXTURES/"
cp ops/checks/dashboard-activity-rust-fixtures/*.pem "$DASHBOARD_RUST_FIXTURES/"
cp dima-analytics/src/store.mjs "$DASHBOARD_RUST_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/dashboard-activity-rust-fixtures/test-env.json \
  --fixtures "$DASHBOARD_RUST_FIXTURES" \
  --check ops/checks/dashboard-activity-rust.mjs
```

The check has a 280-second internal budget below the helper's 300-second check timeout. It includes one actual hard 40-second watchdog and separate stalled OAuth/Helix 3-second requests. The pre-write takeover case adds no deliberate wait; it does not add a second 10-second heartbeat-loss hold. Individual PASS groups are emitted only after their assertions succeed. An incomplete run does not establish coverage for later groups.

Host-safe fixture checks (no services, compilation, or production access):

```sh
node --test ops/checks/dashboard-activity-rust-fixtures/fixtures.test.mjs
node --check ops/checks/dashboard-activity-rust.mjs
```

## Sources and isolation

- `reference.mjs` imports the preserved compiled `utils/dashboard_activity.js` and `utils/dashboard_insights.js`. Their real queries, calculations and Mongoose write behavior run against a separate disposable reference database. It never imports the retired worker entrypoint. Requests are blocked; catalog cases use seeded shared Redis keys.
- Collection names come from the real Mongoose models, including `streamsessions` and `streamviewersnapshots`. Values and BSON Date types are compared recursively. Server-side `$type` comparisons retain exact parity with the TS oracle for daily/state and all numeric fields in Mixed summary/insight payloads, including nested array counts, weekdays, ratios and recommendations. Mongoose Number paths become JS Number values; Node BSON encodes integral values within Int32 range as `int`, and fractional or larger Number values as `double`. Fresh small checkpoint `seq` and `active.seq` fields must be `int`. An intentionally seeded integral Double fence proves skipped preapplied fields preserve their existing types, without any data migration. A separate `MAX_INT32 + 1` tally fixture first proves Mongo produces an aggregate `long`, then checks that TS/native persisted totals and ranked item counts are `double` in both7/30 payloads.
- Only `mongo:27017/dashboard_activity_fixture_*` and `redis:6379` are accepted as helper dependencies. Direct native children receive an explicit minimal environment. The Redis-down case substitutes loopback port 1 only for that child. Test database drops and Redis key deletions are scoped; no FLUSH or broad data cleanup is used. TTL indexes are omitted so deliberately expired rows remain available to prove query-side filtering. Other schema indexes are created.
- `mongo-proxy.mjs` adapts the existing raid-sessions wire fixture. Its only upstream is the disposable Mongo alias. It parses uncompressed commands, rejects escaped databases, holds one selected actual command, and allows release only while the connection is live. Native client `bulkWrite` commands in the admin database are accepted/held only when every `nsInfo` namespace belongs to the owned disposable database. The watchdog reset exception is restricted to client ECONNRESET within 250ms of the independently recorded native exit, after the held command and durable lease have been checked.
- `cron-boot.mjs` intercepts only the real supervisor's spawn import. Node and tsx both select native dashboard. Fault scopes substitute a missing fixture path or an exit17 process for this child only; they never rename or edit the candidate binary. Main scope kills the actual native dashboard and proves its replacement writes real work. The bootstrap rejects foreign real processes and unexpected native environment variables.

## Provider TLS fixture

`providers.mjs` listens only on an ephemeral loopback port. It accepts CONNECT only for `api.twitch.tv:443` and `id.twitch.tv:443`, terminates trusted TLS locally, and serves the unchanged production URL paths. It never opens upstream sockets. The checked-in certificates/private leaf key are public **test-only** material. `provider-root-cert.pem` is the self-signed signing root (`CA:TRUE`, path length0, certificate/CRL signing usage); it has no provider SANs. `provider-cert.pem` is its signed server leaf (`CA:FALSE`, digital signature/key encipherment, serverAuth EKU), with exactly the two provider SANs. `provider-key.pem` is the existing leaf key; the temporary root signing key was discarded after generation. These are not production credentials. The proxy serves only the leaf; `SSL_CERT_FILE` points to `provider-root-cert.pem` directly in the test child's environment. There is no endpoint override, verification bypass, or production trust/configuration change. OpenSSL is not required inside the candidate image.

The first fixture version served its self-signed `CA:TRUE` trust certificate as the TLS leaf. Candidate `cron-bf400acbc441` passed dashboard groups 1–12 before the first native provider handshake received `TLS_ALERT_CERTIFICATE_UNKNOWN`. The pinned rustls-webpki 0.103.16 verifier explicitly rejects `(Role::EndEntity, true, _)` as `CaUsedAsEndEntity` in `src/verify_cert.rs:449`. A structure regression assertion reproduced the defect against the old certificate (`cert.ca` was true), despite the original Node handshake test accepting it. Root/leaf separation fixed this fixture defect without changing the native client or weakening verification. The corrected fixture then passed in the full 36-group exact-image dashboard suite; this was fixture-only and did not change image binaries.

Certificate SHA256 fingerprints:

- Root: `6D:DA:2D:13:03:7A:C2:97:97:00:FC:60:C4:6D:20:42:8F:E3:FF:8B:5C:A0:A1:C4:08:84:61:79:E7:61:B1:A5`
- Leaf: `1F:4D:1B:F1:40:A6:88:6B:DF:36:D8:27:A0:01:50:56:57:4E:D3:44:E8:41:54:40:47:C8:36:FC:4B:74:D7:5A`

Host fixture tests check the separate root and non-CA leaf, issuer/signature chain, leaf key pairing, serverAuth EKU, exact SANs, current validity, authenticated CONNECT requests trusting only the root, and rejection of untrusted roots/wrong hostnames. Unexpected proxy TLS errors remain failures; they are not suppressed. Host OpenSSL can additionally validate the served leaf with `openssl verify -x509_strict -purpose sslserver -verify_hostname api.twitch.tv -CAfile ops/checks/dashboard-activity-rust-fixtures/provider-root-cert.pem ops/checks/dashboard-activity-rust-fixtures/provider-cert.pem` (repeat for `id.twitch.tv`). Existing `cp *.pem` staging includes the new root; no image rebuild is needed for these fixture-only changes.

Provider cases prove real reqwest use of proxy/trust settings, app-token cache miss and OAuth form credentials, cached-token reuse, authenticated Helix fetch, empty vs unavailable, malformed/invalid/oversize responses, stale/expired fallback and bounded retry, and separate OAuth/Helix hangs. A seeded cache alone does not count as provider-refresh coverage. Captured request records retain only provider/channel and boolean validation results, never credential bodies or token headers.

## Eligibility boundary construction

Eligibility uses the source's unrounded `sampledHours / hours >= .8`; displayed coverage is separately rounded to two decimals. The former three one-hour sessions with five-minute observations accumulated `sampledHours=2.4` but evaluated `2.4 / 3` as `0.7999999999999999`. Both TS and Rust correctly reported ineligible despite displaying `0.8`; the fixture's expected boolean was wrong.

`insight-coverage.mjs` now supplies three75-minute sessions with first snapshots at15minutes and eight7.5-minute intervals. Each observed interval is exactly`.125`hours, yielding exactly3sampled hours /3.75streamed hours ===`.8`. Moving each first snapshot1ms later retains all24 intervals but shortens the final interval by1ms per session (3ms overall), so unrounded coverage is below`.8` while displayed coverage remains`.8`. The exact case must be eligible and the shifted case ineligible. Both retain one eligible game with three attributed follows and only one weekday comparator with positive follows, proving both recommendation fields remain null because a second comparator is required.

The host fixture test reads and type-strips only the actual TS pure calendar/insight declarations, reproduces the old floating-point result and validates both new boundary outcomes. It imports no schema, database, provider or worker code. The runtime check still performs complete TS/native value and `$type` parity before the explicit boundary assertions. Host tests require Node's `stripTypeScriptTypes` (available on this host); its experimental warning does not disable checks. Existing `cp *.mjs` staging includes the new helper; no image rebuild is needed.

## Coverage and practical limits

The suite covers source-valid command/message projection plus adversarial numeric/emote inputs; daily JSON hash, UTF-16 boundary truncation and UTC dates; durable partial fences and duplicate-key replay preserving preexisting Double encodings; above-Int32 aggregate Int64-to-Double payload parity; missing/empty active membership and expired saved rows; three preexisting lease exclusions; an actual in-flight owner takeover at the guard before the first daily write, preserving the replacement owner/lease and saved fence with no write/ack, followed by fixture expiry and exactly-once recovery; a dirtyAt race; actual nonduplicate validation failures and repair; 7/30 ranking and privacy; ICU game ordering, eligibility, raid/follow boundaries, overlap/gaps; each independent 500-session/20k-snapshot/10k-raid/100k-follow exact cap and cap+1; ready backlog across all three queues including zero-event checkpoint completion; future/leased/idle/error waits and signal interruption; in-flight graceful shutdown, actual hard watchdog recovery requiring the retained lease to advance at least 15 seconds beyond its original value plus at least two observed owner-guarded heartbeat renewal commands and a matching persisted lease, native-only child restart and analytics-valid telemetry.

This does not benchmark production throughput or verify HTTP dashboard routes, Twitch APIs, API/bot deployment, or every malformed legacy BSON type. The real provider behavior is verified through an isolated TLS proxy, not live Twitch. The suite requires MongoDB support for expression `$getField` in its stored-type comparisons, matching the helper's current Mongo dependency.

The pre-write takeover case is distinct from preexisting lease exclusion. A takeover during a held bulk write that specifically proves heartbeat-loss handling is not included or claimed; the hard-watchdog case proves heartbeat renewal and the pre-write case proves ownership fencing. Child completion retains the monotonic `exit` timestamp and resolves on `close` after stdout drains.

## Candidate `cron-bf400acbc441` results

The candidate built at the capped 4 GiB/6 CPU/two-job/256-PID/no-swap settings in 1479.073 seconds. Formatting, tree check, check, Clippy, tests, release build, and seven dry runs passed across all three profiles. The strict 8 GiB Cargo cache ended at 3,594,080,256 bytes. The exact-image dashboard suite passed all 36 groups after two fixture-only corrections: a separate CA root and `CA:FALSE` provider leaf for rustls, and a precisely binary-exact 80% insight eligibility case (three 75-minute sessions with 7.5-minute observation intervals). The prior 2.4/3 construction evaluated to `0.7999999999999999`; both TypeScript and Rust correctly rejected it although the displayed value rounded to `0.8`. The corrected exact boundary and 1 ms-below case both passed TypeScript/native parity and strict comparisons. No image binary changed for these fixture corrections.

The candidate passed all twelve same-image suites before deployment: nine standard suites totaling 150 PASS groups and three supplemental legacy cron checks reporting four PASS groups. It deployed to the existing cron service at `2026-10-21T22:53:29.834585977Z`, image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`. Production has seven accepted native children. The 32-sample, 332.216-second watch, final readbacks, container comparison, and cleanup passed. Persistent evidence is retained at `/root/.local/state/saas-ops/649a957c15888e53/cron-bf400acbc441/dashboard-activity-acceptance`.
