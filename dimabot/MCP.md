# MCP v1

Maintainer guide for the API implementation in `src/server/mcp/mcp.route.ts` and the shared site-agent tools. For the desktop OAuth contract see [OAUTH_BETA.md](./OAUTH_BETA.md).

## Transport and discovery

- MCP resource: `https://mcp.domdimabot.com/mcp` (`MCP_PUBLIC_URL` can override it). `server.ts` routes this Host to the MCP router first; other paths on that Host return 404 instead of reaching the API.
- Stateless Streamable HTTP, tools only, JSON responses, protocol up to `2025-11-25`. POST `/mcp` accepts up to 256 KB; OPTIONS is supported, GET and DELETE return 405. A new SDK server and transport are made for each request; there is no MCP session cache or SSE session (client names alone have a short cache).
- Protected-resource metadata is served on the MCP host at both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. It names the resource, issuer, header bearer method and active MCP scopes. Authorization-server metadata is at `https://api.domdimabot.com/.well-known/oauth-authorization-server` (also `/oauth/metadata`); it advertises CIMD support. Metadata, token and revoke have public CORS; the MCP router also allows public CORS.

Use authorization code + S256 PKCE through the API issuer and website consent. CIMD clients must send the MCP `resource` on authorization. Active MCP scopes are `channel:read` and `channel:write`; `stream:act` is inactive. Knowledge tools require no scope. A token is bound to one audience, and desktop and MCP tokens are not interchangeable.

Send `Authorization: Bearer <access_token>`. A missing token returns 401 `{"error":"invalid_token"}` and `WWW-Authenticate: Bearer realm="dima", scope="<active MCP scopes>", resource_metadata="https://mcp.domdimabot.com/.well-known/oauth-protected-resource/mcp"`; a rejected token adds `error="invalid_token"`. A `tools/call` missing its tool's scope gets HTTP 403 `insufficient_scope` before the SDK, with a Bearer challenge containing `error="insufficient_scope"`, `resource_metadata`, and `scope` containing the granted scopes plus the missing scope. Reauthorize for that scope. Other tool failures return MCP tool errors.

## Clients and consent

`isCimdClientId` in `src/server/oauth/cimd.ts` accepts a canonical HTTPS URL of at most 512 characters, with a non-root path, DNS hostname of at least two valid labels, no IP literal, credentials, port, query or fragment, no numeric or local-only TLD. Resolution additionally rejects the Dima domain and its subdomains and the configured API/website hosts and their subdomains.

Only the initial authorization resolves a CIMD document. The request and authorization code carry the validated client snapshot; consent and exchange use that snapshot, while sessions, refresh and revocation never fetch it again. The denylist is still checked throughout. The document must identify itself exactly, provide a safe nonempty name and 1–10 valid redirects, allow public `none` authentication and contain no client secret; optional grant/response lists must include authorization code/code. See `cimd.ts` for validation details.

Fetches use public-unicast DNS answers only, pin TLS to a checked address, retain hostname certificate validation, and refuse redirects. Limits are 5 seconds total, 2 seconds DNS, 32 KB JSON with identity encoding, eight concurrent fetches and 60 fetches per minute per process. The document cache `oauth:cimd:doc:<sha256-base64url(client_id)>` defaults to 300 seconds; `max-age` is capped at 86400 seconds and no-store/no-cache/private disables caching. Failures are negatively cached for 60 seconds at `oauth:cimd:fail:<sha256-base64url(client_id)>`; local limits and aborts do not create negative entries. Cache read failure allows an uncached fetch, but denylist lookup failure fails closed.

To block an app, add either its exact client ID URL or `host:<hostname>` as a member of the Dragonfly set `oauth:cimd:deny`. The code-level `DENIED_CIMD_CLIENTS` uses the same member formats. The denylist applies to authorization, token/refresh and live sessions; denied sessions are omitted from connections. `RECOGNIZED_CIMD_CLIENTS` is an exact-URL list in `cimd.ts`: edit it after validating the vendor document and recording its source. Recognition is a consent label, not verification or an access grant.

HTTPS redirects must match a registered URI exactly, without credentials or fragment. HTTP redirects are limited to a registered loopback host and path with an explicit port; the port may vary, but query, fragment and credentials are forbidden. CIMD permits `127.0.0.1`, `[::1]` and `localhost`; the first-party desktop client permits only the first two and `/oauth/callback`.

Browser consent offers the requester’s own channel (labelled Owner) and channels where they are an active admin explicitly granted `mcp:admin` (AI apps (MCP)) by the channel owner. Full access (`*`) alone does not grant it; `['*', 'mcp:admin']` or a specific permission list including `mcp:admin` is allowed (the latter gains `dashboard:view`). Only the owner can add this grant; platform staff who manage admins can keep or remove it, but cannot add it. Platform-staff owner elevation never applies to MCP. An admin’s app is limited by their own permissions and uses the channel’s AI credits. Removing `mcp:admin` cuts off the app on its next call without removing website access. The decision requires `channel_id` for a CIMD approval; the choice is rechecked at approval, code exchange, refresh and each tool call, and again immediately before a write. `requester_id` is the approver's Twitch ID, `channel_id` the chosen channel's Twitch ID, `user_id` the Dima account, and `resource` the audience. Legacy records lacking requester or resource normalize to `channel_id` and the desktop resource. An owner cannot yet see admins' MCP connections: the connections page lists the signed-in user's own sessions.

## Tools and changes

Tool discovery exposes only the allowlist intersected with the requester’s current permissions, plan and granted scopes. The authoritative classification is `src/site_agent/tools/mcp.ts`: the allowlist covers documentation/command knowledge, channel reads, and undoable configuration writes; the exclusion list includes stream actions and rewards, AI personality, moderation, follow defense, non-undoable deletion and site UI. Do not copy the list into another registry. `get_ai_credits` is MCP-only and requires `billing:view`; it returns the balance, used, limit, status, an `estimated` flag when applicable on Free, and `https://domdimabot.com/<channel>/credits`. Its billing lookup has a 5-second deadline and reports `available: false` when billing cannot be read. It is not in the website assistant. MCP-only change tools list recent changes and undo eligible ones. The owner sees channel changes, admins their own, further filtered by current area view permission. Undo rechecks the original scope, permissions and plan; other kinds are undone from the website Changes list.

Writes apply without an approval card. `safe_body.ts` statically parses every `executableFields` text that a write makes executable, including stored text newly enabled or exposed by the change. It walks nested expressions and allows only its audited reply/value functions, variables and control flow; unknown, unparseable or effectful functions and command references are refused. Built-in code that cannot be checked is refused. The tool description announces this restriction; unsafe content can be configured on the website. Reads wrap people-authored data as `untrusted_data`; settings reads omit secrets such as overlay/speech links.

`executeMcpToolCall` resolves the allowlisted tool, checks cancellation and fresh channel access, scope, permissions and plan, validates arguments, reserves credits, then runs the tool. For a proposed write it rechecks access, role, plan and permissions, checks executable text, applies and records the change. Finally it settles a billable success or releases the hold. An apply timeout/error can have an unknown outcome; inspect current state before retrying. Change-log recording retries, but a write can succeed without a log entry; in that case it reports the missing undo and must be changed back manually.

Change records carry `source.surface` (`mcp` or `site`) and MCP `clientId`/`clientName`, so website Changes identifies the app and can undo an MCP change. See `changes.ts` and `tools/mcp_changes.ts` for conflicts and visibility.

## Credits and limits

`credits.ts` prices MCP knowledge/UI at 0 and read/write/stream at 1 credit; the website assistant's tools are free. `PRICE_OVERRIDES` is the per-tool override: `undo_change` is free pending the owner's decision; `get_ai_credits` is free even when credits are exhausted (lead decision; the owner may change it). Billable reads and applied writes settle; no-op results, refusals, failures and unknown outcomes release their holds. A tool may explicitly return `billable: false`.

The atomic reservation checks the cached channel balance less pending holds in `mcp:credits:holds:<channelId>` (hash of operation ID to `credits:expiresAtMs`); at most eight non-expired holds, each expiring after 10 minutes. Settlement sends the Polar `ai_usage` path with `reason: mcp_tool`, `externalId: mcp_tool:<operationId>`, channel/customer, cost, and usage `requestId`, `category: ai_agent`, `operation` (tool), `source` (surface), `provider: dima`, `receipt.costUsd: 0`. Settlement never throws into the tool call. It drops the hold after acceptance or durable queueing; on failure it logs and leaves the hold to expire.

MCP limits are 600 requests per IP per minute and 300 per bearer token per minute; OAuth routes have 600 per IP per minute and consent decisions 30 per approving Twitch user per minute. 429 responses include `Retry-After: 60`. See [OAUTH_BETA.md](./OAUTH_BETA.md) for desktop limits.

## Candidate checks

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
