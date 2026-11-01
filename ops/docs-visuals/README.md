# Documentation screenshots

The Commands, Alerts, and Growth guide screenshots show the current Angular application, not a hand-built mockup. For the 2026-11-01 capture batch the site preview ran at `http://127.0.0.1:4203`; loopback fixture gateways isolated browser state by group: commands `:4204`, alerts `:4205`, and growth `:4206`. Use one gateway per feature group. A gateway serves the real site preview and loads its feature fixture on each document request.

Each full page URL carries `?capture=<group>&lang=en|es&theme=dark|light`. The shared browser core installs the deterministic session, theme and language before Angular starts, returns browser-local API fixtures, and blocks unapproved external requests and WebSockets. The feature fixture should follow a real behavior check's request and response contract. Keep all channel, viewer and media data synthetic; never use a live overlay token or production account data.

## Capture and review

1. From the repository root, start the isolated site preview with `scripts/saas-ops preview site --port 4203`. In a separate terminal, start one loopback gateway per feature group, each pointing at that preview. For example:

   ```bash
   SAAS_SITE_URL=http://127.0.0.1:4203 SAAS_CAPTURE_PORT=4204 node ops/docs-visuals/gateway.mjs
   SAAS_SITE_URL=http://127.0.0.1:4203 SAAS_CAPTURE_PORT=4205 node ops/docs-visuals/gateway.mjs
   SAAS_SITE_URL=http://127.0.0.1:4203 SAAS_CAPTURE_PORT=4206 node ops/docs-visuals/gateway.mjs
   ```

   Keep each gateway in its own terminal. The standalone capture runners below connect to these servers.
2. Use the shared T3 preview browser for current documentation captures. Open the gateway route with the appropriate language and dark theme first, wait for `document.fonts.ready`, and wait until the feature data is settled.
3. Save the actual browser screenshot, then optimize or crop the real image when needed. Overlay Studio is cropped to the editor canvas and its save bar so unrelated page cards and the global navigation are outside the capture.
4. Store captures in `dimadocs/public/guides/<group>/`. Link them from MDX with a plain linked Markdown image and add a localized, descriptive alt plus an italic caption identifying the synthetic `DemoStreamer` example data. Keep the same number of captures in English and Spanish.
5. Review each image at full size. Check desktop composition, then review mobile width and light theme for layout and readable contrast. The standalone capture scripts include mobile overflow checks at 390px; public tutorial images use the dark desktop captures.
6. Stop task-owned capture tabs and preview services when they are no longer needed. They can overlap with the docs preview or candidate build; `preview` does not take the per-checkout build/verify/deploy lock.

The standalone `alerts.mjs`, `commands.mjs`, and `growth.mjs` scripts document future reproduction through their gateways. The 2026-11-01 screenshots were captured with the shared T3 browser tools, not by running these scripts. Feature fixtures and exact-page browser contracts are:

- Alerts: `ops/docs-visuals/alerts.fixture.js` and `ops/checks/asset-library-browser.mjs`, `ops/checks/overlay-studio-browser.mjs`, `ops/checks/overlay-trigger-placement-browser.mjs`, `ops/checks/redemptions-browser.mjs`, `ops/checks/roulette-module.mjs`, and `ops/checks/dimafx-dashboard.mjs`.
- Growth: `ops/docs-visuals/growth.fixture.js` and the exact-page checks listed in `growth.mjs`.
- Commands: `ops/docs-visuals/commands.fixture.js` and `ops/checks/commands-browser.mjs`.

The reusable browser checks do not provide complete screenshot fixtures for every alert page. In particular, TTS settings and Triggers/Media Library did not have dedicated exact-page screenshot checks; their synthetic route data was checked against the live Angular API usage and the nearest existing source contracts. The redemptions check supplies the create reward modal interaction used for the Rewards image. The fixture should be updated when those UI/API contracts change.

`ops/checks/docs_visuals.py` verifies image links, full-size targets, descriptive alt text, published assets, bilingual parity, and the `index.txt` export.
