# DimaFX — Twitch listing assets

Ready-to-upload PNGs in English (`en/`) and Spanish (`es/`). All final screenshots use a 4:3 canvas and are below 10 MB. Choose the language matching the listing being edited.

| Twitch console field | File | Pixels |
| --- | --- | --- |
| Logo | `logo-100x100.png` | 100 × 100 |
| Discovery image — English | `en/discovery-300x200.png` | 300 × 200 |
| Discovery image — Spanish | `es/discovery-300x200.png` | 300 × 200 |
| Screenshot 1 — store and saved items | `en/screenshot-01-store-1024x768.png` or `es/screenshot-01-store-1024x768.png` | 1024 × 768 |
| Screenshot 2 — custom voice message | `en/screenshot-02-voice-1024x768.png` or `es/screenshot-02-voice-1024x768.png` | 1024 × 768 |
| Optional taskbar icon, if requested for an eligible video extension | `taskbar-icon-24x24.png` | 24 × 24 |

`logo-transparent-100x100.png` is an additional white-on-transparent logo export. Use the opaque `logo-100x100.png` for the listing's standard logo field. The logo, taskbar icon, discovery images and composed screenshots have a dark `#0f1115` background; both discovery images are fully opaque.

## Authentic UI and demonstration content

The screenshot compositions contain browser captures of the actual `dimafx/panel.html` and `dimafx/mobile.html` runtime, including its shared `panel.js` and `storefront.css`. The interface, labels, price buttons, saved items and voice message form are unchanged. The custom voice sheet is opened by clicking the real item button, and its real message field is filled without submitting it.

`DemoStreamer`, the six catalog entries, two saved items and entered messages are fictional fixtures. Every composed screenshot is labeled **Demo content** / **Contenido de ejemplo**. The catalog uses supported price values 0, 5, 10, 25, 50 and 100. No popularity, scarcity, ratings or new-item badges are fabricated. Preview thumbnails are original SVG drawings made for this pack; sound waveforms and the voice interface come from DimaFX itself.

Captures use a mocked connected overlay and a mocked viewer who has shared their Twitch ID. Custom text requires that identity sharing, as the screenshot copy explains. No checkout is initiated, no purchase or redemption is submitted, and no production service or account is contacted. Everything is intercepted at the synthetic origin `https://dimafx-demo.invalid`; no web server is started. Google Fonts requests are fulfilled with bundled local fonts. Runtime sources are read from the included snapshot, not served from or written into the production extension directory.

The established DomDimaBot mascot is reused from `dimasite/public/assets/brand/mark-on-dark.png`, preserved as `source/brand-mark-original.png`. Logo exports strengthen its existing alpha through six source-over-equivalent passes to keep thin outlines visible at small sizes. Its proportions, contours, negative space and artwork are preserved. The actual UI captures retain their original runtime logo unchanged. No Twitch/Glitch logo or third-party character/media assets are included. Plus Jakarta Sans is bundled with its OFL license under `source/fonts/`.

## Reproduce and verify

From the repository root, using the existing Playwright installation:

```bash
node release-assets/dimafx/twitch/sources/render.mjs
```

From an extracted pack, run `node sources/render.mjs`. To use another Playwright installation, set `PLAYWRIGHT_PATH` to its absolute `index.mjs` path. The default is `/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs`; Chromium must already be installed. No npm dependencies are added by the renderer.

The bundled `source/runtime/` files are an exact snapshot of the DimaFX client used on 2026-11-04. To intentionally refresh them from a repository checkout before regenerating:

```bash
node release-assets/dimafx/twitch/sources/render.mjs --refresh-source
```

The renderer checks PNG dimensions and file limits, verifies opaque backgrounds, confirms all six store price buttons fit above navigation, checks horizontal overflow and runtime errors, and asserts zero checkout calls and mutations. `source/verification.json` records the result, source hashes, output hashes, dimensions and byte sizes. `source/captures/` contains the six raw UI screenshots used in the compositions. Both languages were also visually reviewed at final export size.

This pack changes listing assets only. No application code was edited or deployed, and nothing was uploaded to Twitch.
