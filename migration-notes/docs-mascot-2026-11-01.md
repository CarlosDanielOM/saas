# Docs living mascot — 2026-11-01

## Scope and current status

The docs assistant now has a page-local SVG mascot that replaces the static Ask launcher and can guide readers through the visible headings on a page. The existing chat remains available through the mascot launcher. Candidate `docs-df5f2fdf633f` passed browser acceptance and was deployed; this note records its source and release evidence.

## Reuse and implementation

The feature reuses the existing `DocsAssistant.astro` dialog, public SSE answer route, source links, feedback, per-language session history, docs search, and integration hooks. The assistant still reads the site's generated `llms-full.txt`; the mascot adds no separate answer path or model request. The vector was traced from the existing brand PNG, then its original 17 contours were split for the UI art. Implementation is in [DocsAssistant.astro](../dimadocs/src/components/DocsAssistant.astro), [DocsMascot.astro](../dimadocs/src/components/DocsMascot.astro), [MascotFigure.astro](../dimadocs/src/components/MascotFigure.astro), [docs-mascot.mjs](../dimadocs/src/lib/docs-mascot.mjs), [docs-mascot-guide.mjs](../dimadocs/src/lib/docs-mascot-guide.mjs), [docs-mascot.css](../dimadocs/src/styles/docs-mascot.css), and [mascot.svg](../dimadocs/src/assets/mascot.svg).

The launcher has idle and assistant-response poses. “Show me this page” guides only through real, visible article headings; ordinary same-page citation links can start at their visible hash target. Cross-page and external citations keep their regular navigation. The guide stage follows Starlight's heading wrapper so it does not compete with the heading permalink. Next, Done, and Escape control the guide. Motion pauses for hidden/offscreen content, user preference, or reduced-motion settings; the user pause choice persists in local storage. English and Spanish labels are present.

## Contracts and storage

The existing public `POST /docs-assistant/ask` contract remains `{ messages, page }`, streamed as SSE: `start {id}`, `status {phase}`, `text {delta}`, `reset {}`, `done {id, sources, stopReason}`, or `error {code}`. Before a stream starts, errors use the normal JSON envelope. `POST /docs-assistant/feedback` remains `{id, helpful}`. The browser retains chat history in `sessionStorage` per language under `docs-assistant:v1:<lang>`. Existing `docs-assistant:ask`, `window.DocsAssistant`, assistant-open, and docs-search hooks are preserved. Source contract: [docs-assistant.route.ts](../dimabot/src/server/routes/docs-assistant.route.ts).

The mascot's movement preference uses `localStorage['docs-mascot:motion']` (`paused` or `on`). In a `localhost` or `127.0.0.1` preview only, `localStorage['docs-assistant:api']` can select a fixture API; production ignores the override.

## Verification and limits

- The final docs test run passed 77 tests, including four new guide/hash-link tests.
- Development-preview browser coverage passed 30 responsive cases across five English/Spanish pages at 320, 390, and 1280 pixels in dark and light themes. Eighteen settled Axe WCAG A/AA scans covered dock, panel, and guide at each size/theme with zero violations after correcting primary-button contrast.
- The stream fixture exercised thinking/reading/speaking/happy states, preamble reset, copy and feedback, exact anchored source guidance, Next/Done/Escape cleanup and focus, persisted pause/history, stop-to-idle, error retry/search, the cancelable custom hook, and mobile menu/search hiding. The reduced-motion controller path was exercised with a `matchMedia`/controller fixture, and the native reduced-motion CSS rule was inspected; native browser media emulation was unavailable.
- Review found that passing the browser-resolved absolute `anchor.href` to the docs-link resolver classified local paths as external. The handler now passes the raw `getAttribute('href')`, preserving same-page citation guidance in previews.
- [docs_mascot.py](../ops/checks/docs_mascot.py) is the exact-candidate behavior check. It runs a loopback SSE fixture, prints browser context, and waits for the lead's actual T3 browser assertion receipt via `POST /__finish`. It makes no live model/API calls. The helper's check timeout is 300 seconds; the exact-candidate receipt wait is capped at 240 seconds. `--fixture-only` allows a longer local fixture run. The check also invokes the existing docs visual check; the standard docs harness includes the docs LLM/export check.
- Lead review restored SVG `fill-rule="evenodd"` to preserve transparent cut-outs, restored focus after ordinary modal close, and canceled WAAPI travel when the document becomes hidden.
- Exact candidate `docs-df5f2fdf633f` built, passed [docs_mascot.py](../ops/checks/docs_mascot.py), and was deployed as the checked bundle. The helper included static markup checks, [docs_visuals.py](../ops/checks/docs_visuals.py) (46 guides, 44 images / 11,687,148 bytes), and [docs_llms.py](../ops/checks/docs_llms.py) (64 documents, 135 URLs). The T3 browser receipt covered 10 grouped assertion sets and three fixture requests, including the assistant stream, guide flow, persistence, errors, hooks, touch target, and accessibility checks.
- The exact candidate recorded 18 Axe scans with zero WCAG A/AA violations over dock, panel, and guide at 320/390/1280 in dark/light. Production Nginx full visual/text checks passed. Public production smoke covered English commands at desktop (including tour Next/Done), homepage at 1280, and Spanish TTS at 390; localization, real-page tours, and no overflow passed. The production API URL remained untouched, so the smoke made no production AI calls.
- Production container ID stayed unchanged and it had zero restarts. The helper cleanup reported `resources=[]`; previews and fixture were stopped and browser tabs closed. Receipt `artifact_digest`: `e7480de924b59bc99f395d62c60f036b0f5bdc1aa3823f16b7247648116dcb22`; `deployed_bundle`: `ee8ba474b9d9d254fdeb2de95a5c1d081b946cd7de2af9a0db46327432fd4fd3`. The helper run retains `mascot-browser-evidence.json` with the assertion receipt, accessibility results and responsive checks. Rollback: `scripts/saas-ops rollback docs-df5f2fdf633f`.
- Native browser reduced-motion media emulation was unavailable. The controller path was exercised with a `matchMedia` fixture and the CSS rule inspected; this does not establish browser-native media emulation coverage.

## Routing observation

Two bounded GPT-6.1 Sol high implementation tasks and a Sol high lead handled the UI work; GPT-6 Luna high handled source-backed documentation. This is task-specific routing evidence only. Do not infer a broad tier or performance claim.
