# MCP v1.1

Maintainer guide for the API implementation in `src/server/mcp/mcp.route.ts` and the shared site-agent tools. For the desktop OAuth contract see [OAUTH_BETA.md](./OAUTH_BETA.md).

## Transport and discovery

- MCP resource: `https://mcp.domdimabot.com/mcp` (`MCP_PUBLIC_URL` can override it). `server.ts` routes this Host to the MCP router first; other paths on that Host return 404 instead of reaching the API.
- Stateless Streamable HTTP, tools only, JSON responses, protocol up to `2025-11-25`. POST `/mcp` accepts up to 256 KB; OPTIONS is supported, GET and DELETE return 405. A new SDK server and transport are made for each request; there is no MCP session cache or SSE session (client names alone have a short cache).
- JSON-RPC batches contain at most 20 messages; larger or empty batches return HTTP 400 and JSON-RPC `-32600`. Each message counts against the IP and token limits. Clients should send parallel calls as parallel requests. Per OAuth session, up to 12 tool calls run concurrently in the API process, including free tools; up to 48 more wait in arrival order for up to 30 seconds. A full queue or timeout returns `busy`. A call keeps its slot while work it started is still running after it answered (a tool past its timeout or its client, a write past 120 seconds), for at most 10 minutes.
- Protected-resource metadata is served on the MCP host at both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. It names the resource, issuer, header bearer method and active MCP scopes. Authorization-server metadata is at `https://api.domdimabot.com/.well-known/oauth-authorization-server` (also `/oauth/metadata`); it advertises CIMD support. Metadata, token and revoke have public CORS; the MCP router also allows public CORS.

Use authorization code + S256 PKCE through the API issuer and website consent. CIMD clients must send the MCP `resource` on authorization. Active MCP scopes are `channel:read` and `channel:write`; `stream:act` is inactive. Knowledge tools require no scope. A token is bound to one audience, and desktop and MCP tokens are not interchangeable.

Send `Authorization: Bearer <access_token>`. A missing token returns 401 `{"error":"invalid_token"}` and `WWW-Authenticate: Bearer realm="dima", scope="<active MCP scopes>", resource_metadata="https://mcp.domdimabot.com/.well-known/oauth-protected-resource/mcp"`; a rejected token adds `error="invalid_token"`. A `tools/call` missing its tool's scope gets HTTP 403 `insufficient_scope` before the SDK, with a Bearer challenge containing `error="insufficient_scope"`, `resource_metadata`, and `scope` containing the granted scopes plus the missing scope. Reauthorize for that scope. Other tool failures return MCP tool errors.

## Clients and consent

`isCimdClientId` in `src/server/oauth/cimd.ts` accepts a canonical HTTPS URL of at most 512 characters, with a non-root path, DNS hostname of at least two valid labels, no IP literal, credentials, port, query or fragment, no numeric or local-only TLD. Resolution additionally rejects the Dima domain and its subdomains and the configured API/website hosts and their subdomains.

Only the initial authorization resolves a CIMD document. The request and authorization code carry the validated client snapshot; consent and exchange use that snapshot, while sessions, refresh and revocation never fetch it again. The denylist is still checked throughout. The document must identify itself exactly, provide a safe nonempty name and 1–10 valid redirects, allow public `none` authentication and contain no client secret; optional grant/response lists must include authorization code/code. See `cimd.ts` for validation details.

Fetches use public-unicast DNS answers only, pin TLS to a checked address, retain hostname certificate validation, and refuse redirects. Limits are 5 seconds total, 2 seconds DNS and 32 KB JSON with identity encoding. Only real fetches (cache misses) are limited, per process: 10 per minute per source (the authorize request’s `clientIps` keys; every key must have budget); unknown client IDs share 6 of 8 concurrent slots and 60 fetches per minute; `RECOGNIZED_CIMD_CLIENTS` may also use the 2 reserved slots and have their own 30 per minute. Concurrent resolutions of one client ID share one fetch, aborted only when every waiter has left. Refusals return `invalid_client` like other failures. The document cache `oauth:cimd:doc:<sha256-base64url(client_id)>` defaults to 300 seconds; `max-age` is capped at 86400 seconds and no-store/no-cache/private disables caching. Failures are negatively cached for 60 seconds at `oauth:cimd:fail:<sha256-base64url(client_id)>`; local limits and aborts do not create negative entries. Cache read failure allows an uncached fetch, but denylist lookup failure fails closed.

To block an app, add either its exact client ID URL or `host:<hostname>` as a member of the Dragonfly set `oauth:cimd:deny`. The code-level `DENIED_CIMD_CLIENTS` uses the same member formats. The denylist applies to authorization, token/refresh and live sessions; denied sessions are omitted from connections. `RECOGNIZED_CIMD_CLIENTS` is an exact-URL list in `cimd.ts`: edit it after validating the vendor document and recording its source. Recognition is a consent label, not verification or an access grant. Cursor is recognized at `https://cursor.com/oauth/mcp-client.json`.

HTTPS redirects must match a registered URI exactly, without credentials or fragment. HTTP redirects are limited to a registered loopback host and path with an explicit port; the port may vary, but query, fragment and credentials are forbidden. CIMD permits `127.0.0.1`, `[::1]` and `localhost`; the first-party desktop client permits only the first two and `/oauth/callback`.

Browser consent offers the requester’s own channel (labelled Owner) and channels where they are an active admin explicitly granted `mcp:admin` (AI apps (MCP)) by the channel owner. Full access (`*`) alone does not grant it; `['*', 'mcp:admin']` or a specific permission list including `mcp:admin` is allowed (the latter gains `dashboard:view`). Only the owner can add this grant; platform staff who manage admins can keep or remove it, but cannot add it. Platform-staff owner elevation never applies to MCP. An admin’s app is limited by their own permissions and uses the channel’s AI credits. Removing `mcp:admin` cuts off the app on its next call without removing website access. The decision requires `channel_id` for a CIMD approval; the choice is rechecked at approval, code exchange, refresh and each tool call, and again immediately before a write. `requester_id` is the approver's Twitch ID, `channel_id` the chosen channel's Twitch ID, `user_id` the Dima account, and `resource` the audience. Legacy records lacking requester or resource normalize to `channel_id` and the desktop resource. An owner cannot yet see admins' MCP connections: the connections page lists the signed-in user's own sessions.

## Tools and changes

Tool discovery exposes only the allowlist intersected with the requester’s current permissions, plan and granted scopes. The authoritative classification is `src/site_agent/tools/mcp.ts`: the allowlist covers documentation/command knowledge, channel reads, and undoable configuration writes; the exclusion list includes stream actions and rewards, AI personality, moderation, follow defense, non-undoable deletion and site UI. Do not copy the list into another registry. `get_ai_credits` is MCP-only and requires `billing:view`; it returns the balance, used, limit, status, an `estimated` flag when applicable on Free, and `https://domdimabot.com/<channel>/credits`. Its billing lookup has a 5-second deadline and reports `available: false` when billing cannot be read. It is not in the website assistant. MCP-only change tools list recent changes and undo eligible ones. The owner sees channel changes, admins their own, further filtered by current area view permission. Undo rechecks the original scope, permissions and plan; other kinds are undone from the website Changes list.

Writes apply without an approval card. `safe_body.ts` statically parses every `executableFields` text that a write makes executable, including stored text newly enabled or exposed by the change. It walks nested expressions and allows only its audited reply/value functions, variables and control flow; unknown, unparseable or effectful functions and command references are refused. Built-in code that cannot be checked is refused. Each write's `mcpDescription` announces this restriction; unsafe content can be configured on the website. Reads wrap people-authored data as `untrusted_data`; `channel_overview` includes the live title and category there. Settings reads omit secrets such as overlay/speech links.

`executeMcpToolCall` resolves the allowlisted tool, checks cancellation and fresh channel access, scope, permissions and plan, validates arguments, reserves credits, then runs the tool. For a proposed write it rechecks access, role, plan and permissions, checks executable text, and then, immediately before applying, checks cancellation and calls `McpPrincipal.stillAuthorized` → `authenticateAccess` to recheck the OAuth session, grant and client. A revoked or denylisted connection gets `no_access` and nothing changes; otherwise it applies and records the change. Finally it settles a billable success or releases the hold. An apply timeout/error can have an unknown outcome; inspect current state before retrying. Change-log recording retries, but a write can succeed without a log entry; in that case it reports the missing undo and must be changed back manually.

Every allowlisted tool may set `mcpDescription` as complete MCP text; `listing()` adds only the credit price. Every non-read must set `mcpAnnotations`. Shared wording lives in `tools/mcp_text.ts`; MCP descriptions name only `SAFE_FUNCTIONS`. Hints mean destructive may overwrite or remove, idempotent means repeating the same call changes nothing, and openWorld means it reaches Twitch. Without MCP text, listing uses website text plus generic notes; absent annotations use the spec’s cautious hints. `tools/mcp_descriptions.test.ts` enforces the MCP wording and annotations and hashes the website descriptions to keep them unchanged.

Roulette multi-prize undo is one atomic write: all steps apply or none do, and a retry works. Undo data comes from the write’s own result, never a re-read. Chat-event undo removes fields missing before the change; older records treat a null before-value as missing. “Changed since” conflicts name changed fields only, never stored values.

Change records carry `source.surface` (`mcp` or `site`) and MCP `clientId`/`clientName`, so website Changes identifies the app and can undo an MCP change. See `changes.ts` and `tools/mcp_changes.ts` for conflicts and visibility.

## Credits and limits

`credits.ts` prices MCP knowledge/UI at 0 and read/write/stream at 1 credit; the website assistant's tools are free. `PRICE_OVERRIDES` is the per-tool override: `undo_change` is free pending the owner's decision; `get_ai_credits` is free even when credits are exhausted (lead decision; the owner may change it). Billable reads and applied writes settle; no-op results, refusals, failures and unknown outcomes release their holds. A tool may explicitly return `billable: false`.

The atomic reservation checks the cached channel balance less pending holds in `mcp:credits:holds:<channelId>` (hash of operation ID to `credits:expiresAtMs`); at most 24 non-expired holds, each expiring after 10 minutes. At the cap, a reservation waits up to 5 seconds for a slot; cancellation stops the wait, and a timeout returns `credits_busy`. A channel owner without a billing customer gets `credits_not_set_up`. Out-of-credits refusals include `https://domdimabot.com/<channel>/credits`. Settlement sends the Polar `ai_usage` path with `reason: mcp_tool`, `externalId: mcp_tool:<operationId>`, channel/customer, cost, and usage `requestId`, `category: ai_agent`, `operation` (tool), `source` (surface), `provider: dima`, `receipt.costUsd: 0`. Settlement never throws into the tool call. The `ingestPolarSHEvent` `onProjected` callback drops the hold as soon as the charge is queued and `recordAiCreditUsage` confirms the local balance shows it, before Polar answers, so a settling call never counts twice. Without that confirmation the hold drops once Polar accepts the charge or it is durably queued. If a charge cannot be accepted or durably queued, it logs and leaves the hold to expire.

MCP limits are 600 messages per IP per minute and 300 per bearer token per minute; OAuth routes have 600 per IP per minute and consent decisions 30 per approving Twitch user per minute. 429 responses include `Retry-After: 60`. See [OAUTH_BETA.md](./OAUTH_BETA.md) for desktop limits.

## OAuth refresh

Access tokens last 600 seconds and refresh rotates the refresh token. For 60 seconds after a rotation, the replaced refresh token returns a new access token and the same successor, as long as the successor is still current and the usual session, client, scope, resource and channel-access checks pass. The grace record is `oauth:refresh:grace:<sha256-base64url(old token)>` (EX 60); it holds the successor AES-256-GCM-sealed under a key derived from the old token, so Dragonfly holds no usable token. Concurrent refreshes share one successor, and a losing refresh waits up to 1.5 seconds for the winner’s record. Outside the grace, or after the successor has rotated, reuse revokes the session (`refresh_reuse`). A failed grace-record write removes that retry protection. Dragonfly or Mongo trouble, and a rotation still in flight (no grace record yet, rotation under 10 seconds old), return 503 `temporarily_unavailable` without revoking; a missing grace record for an older rotation is reuse.

## Call log

Mongo `mcp_call_logs` retains a row for 90 days per `tools/call`: operation ID, time and duration, channel, person ID/login/role, app ID/name, session, tool and kind, outcome (`ok`, `blocked`, `failed`), code, credits charged, change ID and late-write status. The reason is DomDimaBot’s own refusal/error message, scrubbed and clipped to 300 characters; arguments and results are never stored. A problem is a failure or a block other than `permission_denied`. The fire-and-forget writer never delays or fails a call. A late write's row is updated after its insert with whether it landed and what it was charged. An unknown tool name is kept only when it is tool-shaped and never echoed in the reason; Dima tokens are scrubbed from logged text. `deleteChannelSiteAgentData` → `deleteMcpCallLogs` removes the channel’s rows and the person’s rows on other channels on account deletion, again after 15 seconds and 5 minutes for calls that were still running. The owner-only admin feed shows kind `mcp` as “AI apps”, supports the problems filter, and supplies `app`, `appId`, `toolKind`, `role`, `changeId` and `late` data keys.

## Candidate checks

Run `npm run test:mcp` in `dimabot` for unit tests; the script supplies `node --experimental-test-module-mocks`. The `mcp-v1.mjs` check covers parallel calls, batches, call logs, MCP wording/hints and CIMD budgets; run it alone because it uses the process’s CIMD budget for a minute. `oauth-beta.mjs` covers refresh grace. `admin-console-feed-api.mjs` and `admin-console-activity-browser.mjs` cover AI app rows.

Run on the same isolated API candidate from the repository root, under the host resource rules in `AGENTS.md`. These commands describe verification, not a claim of a passing run. Use disposable dependencies and fixture mocks only.

```bash
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --fixtures ops/checks/mcp-v1-fixtures --test-env ops/checks/mcp-v1-fixtures/test-env.json \
  --check ops/checks/mcp-v1.mjs
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --fixtures ops/checks/oauth-beta-fixtures --test-env ops/checks/oauth-beta-fixtures/test-env.json \
  --check ops/checks/oauth-beta.mjs

DESKTOP_FIXTURES=$(mktemp -d /tmp/mcp-desktop-fixtures.XXXXXX)
PET_FIXTURES=$(mktemp -d /tmp/mcp-pet-fixtures.XXXXXX)
trap 'rm -rf -- "$DESKTOP_FIXTURES" "$PET_FIXTURES"' EXIT
cp ops/checks/desktop-ai-fixtures/{README.md,providers.mjs,test-env.json} "$DESKTOP_FIXTURES/"
cp ops/checks/pet-runtime-fixtures/providers.mjs "$DESKTOP_FIXTURES/pet-providers.mjs"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$DESKTOP_FIXTURES/oauth-providers.mjs"
cp ops/checks/pet-runtime-fixtures/*.mjs "$PET_FIXTURES/"
cp ops/checks/oauth-beta-fixtures/providers.mjs "$PET_FIXTURES/oauth-providers.mjs"
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --fixtures "$DESKTOP_FIXTURES" --test-env ops/checks/desktop-ai-fixtures/test-env.json \
  --check ops/checks/desktop-ai.mjs
scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
  --fixtures "$PET_FIXTURES" --test-env ops/checks/pet-runtime-fixtures/test-env.json \
  --check ops/checks/pet-runtime.mjs
```
