# Visual guide refresh — 2026-11-01

## Scope and source reuse

This release adds current product screenshots to the Commands, Alerts, and Growth documentation groups. The set covers 23 English guides and their Spanish counterparts (46 pages), with 44 localized PNG assets: 10 Commands, 16 Alerts, and 18 Growth images, totaling 11,687,148 bytes. The nine Growth UI guides are AI Personality, Memories, Stream Summaries, Clip Recommendations, Clips, Follow Defense, Moderation, Analytics, and Referrals. Plans and AI Assistants remain text-only because their guidance does not have a useful product-screen workflow to illustrate.

All public images were captured from the rendered Angular app in the T3 preview, using browser-local synthetic fixtures and the `DemoStreamer` sample channel. They show current screens; no real users, private data, secret overlay URLs, or real mutations were used. Images use linked Markdown syntax, localized descriptive alt text, and italic captions that identify example data. The capture setup is documented in [`ops/docs-visuals/README.md`](../ops/docs-visuals/README.md); reproducible feature fixtures and scripts live in `ops/docs-visuals/`.

Feature contracts reused the existing exact-page behavior checks rather than introducing a new test system. Commands used [`commands-browser.mjs`](../ops/checks/commands-browser.mjs); Alerts reused the asset-library, overlay-studio, trigger-placement, redemptions, roulette, and DimaFX dashboard checks listed in the capture README. Growth reused the checks named in [`growth.mjs`](../ops/docs-visuals/growth.mjs), including AI Personality, Memories, Stream Summaries, Clip Recommendations, Follow Defense, moderation, Clips, Analytics, and Referrals. These checks informed local fixture shapes; no app source was changed.

## Review and verification

The lead review corrected a dashboard image that had shown the Commands page, filled and cropped the `hello` dialog, dismissed the Referrals banner, and cropped loading cards over the overlay screenshots. It also added the missing `GET /commands/424242` speech fixture and recaptured the TTS images in both languages.

- The docs test suite passed: 73 tests.
- All 46 updated pages were checked in T3 at 320px dark and 1280px light. Images decoded, full-size links matched their assets, and no document overflow was found.
- Seven Alerts source routes were checked at 390px dark and 1280px light with no overflow, unknown API requests, or fixture errors. The reward form was created for its screenshot and not submitted.
- The final docs candidate passed `ops/checks/docs_visuals.py`, including all 44 served image byte checks, alt text, English/Spanish parity, and text exports. `ops/checks/docs_llms.py` also passed for 64 docs and 135 URLs.
- Public T3 smoke checks loaded `/commands/overview` at 1280px and `/es/commands/overview`, `/es/tts`, and `/memories` at 390px. Images decoded on every page, the phone pages had no overflow, and the English commands page exposed its text-export link. The complete production check also verified the visible text-export links across all 64 documents.

## Release outcome

Candidate `docs-c9c9696a633c` was built, verified, and deployed as the exact tested bundle. Production Nginx at `172.18.0.10` passed the same complete docs visual check. The receipt artifact digest is `75620f008fc28d823362db9207b2b37847fac0c154507aa214089ecabbb1f29c`; deployed bundle digest is `058614c4a9c56c9450c4957edbacf85128c3fcff735430ae26c9054543865888`. Roll back with `scripts/saas-ops rollback docs-c9c9696a633c` if needed. The earlier verified candidate `docs-f4b69d4055dd` was not deployed and was cleaned after the TTS correction. The final helper cleanup reported no remaining resources; task previews and gateways were stopped and capture tabs closed.

The screenshots use synthetic examples. Some media previews intentionally show the application's placeholder state; no unresolved documentation runtime blockers remain.

## Orchestration record

The work used three bounded GPT-6 Luna high tasks and a GPT-6.1 Sol high lead for integration and review. This is task-specific routing evidence only; it does not support a broad model ranking or performance conclusion.
