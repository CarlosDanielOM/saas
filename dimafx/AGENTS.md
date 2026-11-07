# dimafx Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

## Project Purpose

`dimafx/` is the Twitch Extension (client + server) that provides on-stream overlays, alerts, sound effects, and configuration UI for broadcasters.

## Key Entry Points

- `panel.html`, `config.html`, `mobile.html` – Extension UI entry points
- `panel.js` – Viewer storefront runtime shared by `panel.html` and `mobile.html` (same markup; `body.fx--mobile` widens the layout). `config.html` runs `config.js`.
- `server/src/server.ts` – Extension backend (authentication, API proxy)
- `server/src/routes/extension.routes.ts` – Extension-specific endpoints

## Architecture Notes

- Client is lightweight HTML/JS (no heavy framework) for fast loading inside Twitch.
- Server is a small Node.js/Express app that handles Twitch Extension JWT validation and proxies requests to the main `dimabot` API.
- Uses `dimafx/server/src/middleware/twitch-extension-auth.ts` for JWT verification.
- Assets (images, sounds) live in `assets/`.

## Twitch hosting rules (Hosted Test and release)

Twitch serves the uploaded zip from `<client-id>.ext-twitch.tv` under its own CSP (dev.twitch.tv/docs/extensions/life-cycle, "Asset Hosting"):

- **No inline scripts or inline event-handler attributes** (`onclick=`, `oninput=`…), in static HTML or in HTML that JS renders. Wire controls with `data-action` attributes and the delegated listeners at the end of `panel.js`; put page scripts in their own files (`config.js`). Google Fonts and inline `style=` are allowed.
- The Twitch helper (`https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js`) is the **first** script in every HTML file (guideline 2.9).
- **API calls are absolute on Twitch**: `panel.js` uses `EBS_ORIGIN` (`https://fx.domdimabot.com`) when the page runs on `*.ext-twitch.tv`, and the same-origin `/api` proxy on self-hosted copies. That origin must be in the console's "Allowlist for URL Fetching Domains"; `https://api.domdimabot.com` (and the media storage origin it redirects to) in the image and media allowlists.
- **Bits**: check `Twitch.ext.features.isBitsEnabled` (mandatory) and react to `features.onChanged`; take prices from `bits.getProducts()` when available and hide Bits checkout for SKUs that are missing or cost something else; send Twitch's `transactionID` **and** signed `transactionReceipt` to the server (the server only fulfills paid items with a verified receipt); ignore completions whose `initiator` isn't the current user. Paid completions are kept in `localStorage` and retried until the server answers. Test ("In Development") Bits products take no Bits, so the extension server rejects their receipts unless `DIMAFX_ALLOW_DEVELOPMENT_PRODUCTS=true`; set it only during Hosted Test and Twitch review.
- **Identity**: never call `requestIdShare()` on load, only from a viewer's tap. Opaque IDs starting with `A` are logged-out viewers: tell them to log in, keep Bits checkout available (Twitch prompts login), block free plays.
- **Copy**: Twitch guideline 6.5 bans describing Bits use as buy/purchase/spend (also avoid sell/price/cost/pay). Say "use", "play", "get". The client check fails on those words in EN and ES.
- **Audio** (guideline 2.4): preview sound starts off; the speaker button on the preview stage turns it on and the choice is remembered.
- **Viewer-typed TTS** (guidelines 6.2.8, 7.x): text is checked by the server (GPT-6 Luna Decisions) before any Bits or credits are used, the sender's Twitch name is shown on stream with it, and the streamer can skip/remove plays from the DimaFX page.
- **Package for Twitch** with `python3 ops/dimafx-hosted-zip.py --source dimafx --out <file>.zip`; it refuses files that would break under the CSP.

## Development

- Client files are served statically.
- Server runs via Docker (`docker-compose.yml`).
- Configuration and panel UIs must respect Twitch Extension UX guidelines (small footprint, fast load).

## Production Verification & Deployment

- This checkout is on production. Follow the root workflow; successful isolated verification is followed by deployment as part of the requested implementation unless the user limits scope.
- **Client edits are immediately live:** `dimafx/docker-compose.yml` mounts the entire `dimafx/` directory into nginx. Prepare HTML/JS/CSS/assets changes in an isolated worktree/copy outside this directory. Serve that copy on an unused loopback port and check the affected panel/config/mobile flows with a mocked or controlled test extension context. Keep test fixtures and secrets outside the served directory.
- Preserve the previous client files, then apply only the validated changes to the production checkout. Verify the served result and restore those files if it fails. No client build or nginx restart is required. Stop/remove the preview resources.
- For server changes, use `scripts/saas-ops` target `dimafx-server`: plan, build, verify the generated run ID with a behavior check and test JWT/service configuration, then deploy and cleanup. See [`../ops/README.md`](../ops/README.md). Do not point test traffic at production or weaken production JWT verification.
- The helper promotes the exact verified image, checks readiness, and preserves rollback. Check relevant production behavior/logs and use `rollback <run-id>` for a regression. Direct client publication and nginx config changes remain separate workflows. `scripts/dima-update` belongs to the human operator; agents must not invoke or modify it.
- For nginx config changes, validate in an isolated container before applying; check with `nginx -t` and reload the affected production nginx process.

## Styling

- `storefront.css` holds the Live First tokens and styles for `panel.html`, `mobile.html` and `config.html`. Design for the 318×500 Twitch panel first, then the phone view.
- Theme follows Twitch (`Twitch.ext.onContext` → `html.dark`); copy is English/Mexican Spanish (es-MX) from Twitch's `?language=` via the `STRINGS` table in `panel.js`.
- Viewer UX rules: answer "can I play something on stream right now, and for how much?" first; Bits prices are gold pills, free is green; one tap never spends credits (tile asks to confirm); only claim what the backend guarantees (e.g. failed plays refund as credits only with a shared Twitch ID).
- Behaviour check: `ops/checks/dimafx-client.mjs` (mocked Twitch + API under the Twitch CSP, axe and overflow at 318/320/390 in dark and light). Streamer queue controls on dimasite: `ops/checks/dimafx-queue-browser.mjs`.
- `nginx.conf` serves only the client files and `/api/`: the whole `dimafx/` checkout is mounted, so anything else must stay a 404.
- Follow the hybrid styling policy from root `AGENTS.md` when adding new CSS.

---

**This file is intentionally lightweight.** Add extension-specific patterns, JWT handling notes, or asset guidelines here as the extension evolves. Root rules always take precedence.
