# Fish voice browser checks

The API release owns catalog search, default voice resolution, preview authorization,
Socket.IO delivery and billing. The site release owns the browser. The bot continues
to call the speech API and does not need a rebuild for this change.

## Isolated API

```sh
scripts/saas-ops build api
scripts/saas-ops verify api-<run> --dependency mongo --dependency redis \
  --fixtures ops/checks/fish-fixtures \
  --test-env ops/checks/fish-fixtures/test-env.json \
  --check ops/checks/fish-api.mjs
```

The normal API entrypoint starts with disposable Mongo/Redis. A test-only Node preload
mocks Fish, Qdrant and Polar requests; other external fetches fail closed. It generates
a short tone using the image's ffmpeg. No real accounts, provider keys or credits are
used. The check covers owner authorization, all filters, removed/private voices,
custom defaults in both speech modes, explicit `tts.fish` aliases and raw IDs,
single-use socket tickets, private playback,
per-preview cost, insufficient credits, concurrent requests, failure billing and
separation from the stream's speech queue.

## Browser

Install `playwright` and `@axe-core/playwright` in a temporary tooling directory, then
install Playwright Chromium and its runtime libraries there. Set `SAAS_BROWSER_TOOLS`
to that directory. Browser requests to the API/WebSocket are mocked; other external
requests are blocked. No production settings are changed.

```sh
scripts/saas-ops preview site --port 4207
SAAS_BROWSER_TOOLS=/path/to/browser-tools node ops/checks/fish-web.mjs
scripts/saas-ops build site
scripts/saas-ops verify site-<run> --check ops/checks/fish-web.mjs
```

The script defaults to port 4207 for development and uses `SAAS_PREVIEW_URL` when run
by the helper against the exact production bundle. It covers mobile/desktop layouts,
WCAG checks for the new browser, filters, saving/reloading, preview playback, free
replay, failure states and read-only access. Screenshots are written under `/tmp`.
The helper sanitizes inherited environment; the default tooling location is
`/tmp/saas-fish-browser-tools`. The check also detects locally extracted Chromium libraries and fonts in
`/tmp/saas-fish-browser-libs` (override with `SAAS_BROWSER_LIBS` outside the helper).

## Runtime contract

- `GET /speech/voices/:channelID`: authenticated settings viewers; name, gender,
  language, license, page filters. Fish's `licensed=false` means all voices, so
  unlicensed results are explicitly filtered per provider page. Unknown licensing
  stays unknown. Empty filtered pages can still have a next page.
- `PUT /speech/settings/:channelID`: owners save a preset alias or public Fish model
  ID in the existing `voices.cloneDefault` field. New custom IDs are checked against
  Fish. No schema migration is needed.
- `POST /speech/preview-session/:channelID`: owners obtain a 30-second, single-use
  ticket for `/speech-preview/:channelID` on the existing Socket.IO server.
- `preview` socket event: accepts only a voice ID and English/Spanish phrase language.
  The server chooses one of five translated phrases and computes its cost using the
  existing Fish billing rate. Every phrase must remain at or below 150 credits.
  Client text and claimed costs are ignored. The channel balance must cover the
  preview; only successful synthesis is charged via the normal TTS billing path.
- A channel lock serializes previews across tabs, plus an eight-second cooldown.
  Audio returns only to the requesting socket; the live overlay flag/queue is untouched.
  Generated preview files are deleted after delivery. A disconnected or timed-out
  browser may still incur the cost of synthesis already in progress; the UI says so.
