# Desktop AI runtime fixtures

This directory contains the disposable test environment and top-level provider shim for `ops/checks/desktop-ai.mjs`. The shim deliberately composes the existing Pet runtime and OAuth beta fixtures; keep those reusable fixtures as the source of provider behavior rather than duplicating their mocks here.

## Stage the complete fixture tree

`desktop-ai-fixtures/providers.mjs` imports `./pet-providers.mjs`, which is staged from `ops/checks/pet-runtime-fixtures/providers.mjs`, and also needs the OAuth beta provider shim. Prepare a materialized fixture directory (no symlinks) with these files:

```text
desktop-ai-fixtures/
  README.md
  providers.mjs
  test-env.json
  pet-providers.mjs       # copy of pet-runtime-fixtures/providers.mjs
  oauth-providers.mjs     # copy of oauth-beta-fixtures/providers.mjs
```

For example, from the repository root:

```bash
STAGED_FIXTURES="$(mktemp -d /tmp/desktop-ai-fixtures.XXXXXX)"
trap 'rm -rf -- "$STAGED_FIXTURES"' EXIT
cp ops/checks/desktop-ai-fixtures/{README.md,providers.mjs,test-env.json} "$STAGED_FIXTURES/"
cp ops/checks/pet-runtime-fixtures/providers.mjs "$STAGED_FIXTURES/pet-providers.mjs"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$STAGED_FIXTURES/oauth-providers.mjs"
```

Run the behavior check against the exact API candidate image produced by `saas-ops build api`:

```bash
scripts/saas-ops verify api-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/desktop-ai-fixtures/test-env.json \
  --fixtures "$STAGED_FIXTURES" \
  --check ops/checks/desktop-ai.mjs
```

The check expects isolated MongoDB database `saas_ops_oauth_beta_test`, Redis, and the fixture endpoints configured in `test-env.json`. Provider calls and Twitch writes are captured by the staged mocks. Do not point these settings at production services. The fixture itself asserts that its Mongo URI ends in the disposable database name and Piper resolves to the fixture hostname.

Run the compiled regression suite against the same candidate after the runtime behavior check:

```bash
scripts/saas-ops verify api-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/desktop-ai-fixtures/test-env.json \
  --fixtures "$STAGED_FIXTURES" \
  --check ops/checks/desktop-ai-regressions.mjs
```

This check runs compiled tests serially inside the candidate image; the test process uses mocks, while the API startup uses the same disposable dependencies. Both checks are intended to verify the exact candidate, not a later rebuild. A successful build or readiness probe alone does not establish the behavior contract. Until the matching verification receipts exist, this fixture specification is intent and procedure only; it is not a claim that runtime verification or deployment passed.

## Socket.IO wire sample

First GET `/v1/me/ai/capabilities` with the OAuth Bearer token and opt in only if its optional `features` array contains `turn-status-v1`. If absent (older API or rollback), send the original auth and use polling.

The following Engine.IO v4 WebSocket frames show opt-in negotiation and one valid hint. The client sends the namespace connect frame after Engine.IO open (`0`); ping `2` must be answered with `3`.

```text
Client -> server: 40/desktop-ai,{"v":1,"accessToken":"<access-token>","features":["turn-status-v1"]}
Server -> client: 40/desktop-ai,{"sid":"<socket-id>"}
Server -> client: 42/desktop-ai,["ai:turn-updated",{"v":1,"request_id":"1c3f2a4b-5c6d-4a7b-8c9d-001122334455","turn_id":"846da0ad-82b5-4403-b150-7b08dfb309fb","revision":100001}]
Server -> client: 2
Client -> server: 3
```

Without `features`, the namespace still delivers the original `speech:snapshot`, `speech:prepare`, `speech:started`, and `speech:ended` vocabulary, but no turn hints. The exact `ai:turn-updated` JSON keys are `v`, `request_id`, `turn_id`, and `revision`; the sample IDs and revision are illustrative.

Speech preparation uses the existing event acknowledgement frame. For a server event that requests an acknowledgement, the app pauses capture and acknowledges the same playback fence:

```text
Server -> client: 42/desktop-ai,7["speech:prepare",{"v":1,"revision":4,"server_time":1793800000000,"playback_id":"c0cb342e-efcc-4358-a630-b585231803a2","output_generation":1,"source":"bot","phase":"preparing","expires_at":1793800005000}]
Client -> server: 43/desktop-ai,7[{"v":1,"playback_id":"c0cb342e-efcc-4358-a630-b585231803a2","output_generation":1,"paused":true}]
```

The runtime check should cover negotiated opt-in, legacy omission, cross-session/user and missing-scope filtering, scoped snapshots, same safe-integer revision as GET, commit-only/coalesced hints, and no replay under duplicate or reordered hints. It also holds an older HTTP response in flight while a newer ready hint arrives, and exercises GET fallback while hints are ignored. Malformed optional-hint parsing and microphone-state isolation are desktop-client checks; the server fixture only emits the agreed strict shape. Its audio cases cover the 20-second ready-ticket TTL, one fetch, delayed fetch at 16 seconds, expiration at 20 seconds, reconnect reconciliation, failed preparation, and the started HTTP playing proof. Runtime evidence belongs to the `saas-ops verify` receipts and the release note, not this fixture README.
