# Kokoro release checks

These fixtures run only through `saas-ops verify` with disposable Mongo/Redis.
`providers.mjs` blocks outbound traffic and mocks OpenRouter, Piper, Twitch,
Qdrant and Polar. The bot bootstrap stubs unrelated startup integrations. Cron
runs the actual domain event worker and replaces unrelated workers with idle
children. No live credentials, queues or messages are used.

From the production checkout, pass the isolated source directory to `build`.
For each generated API/bot/cron run, use:

```sh
scripts/saas-ops verify RUN --dependency mongo --dependency redis \
  --fixtures ops/checks/kokoro-fixtures \
  --test-env ops/checks/kokoro-fixtures/TARGET-env.json \
  --check ops/checks/kokoro.mjs
```

Replace `RUN` with the build's run ID and `TARGET` with `api`, `bot`, or `cron`.
The frontend model snapshot supplies the existing cross-project expressive-tag
parity test inside the backend image; refresh it if that model changes.

For the site check, install Playwright and `@axe-core/playwright` outside the
checkout, set `SAAS_BROWSER_TOOLS` to that directory, and pass
`ops/checks/kokoro-web.mjs` to `verify`. It mocks all API calls and exercises
manual provider/voice changes, saving, reload, Spanish copy, accessibility,
and mobile/desktop layouts. `SAAS_KOKORO_SHOTS` selects the screenshot directory.
