# Demo videos

Promo videos of DomDimaBot, rendered frame by frame from the real product UI. A video is a short JSON **scene
script**; one command turns it into MP4s (vertical 1080×1920 for TikTok/Reels/Shorts, landscape 1920×1080 for
Twitter/YouTube) in English and Mexican Spanish.

```bash
cd marketing && npm ci                                   # once (Playwright 1.63 + ffmpeg with H.264/AAC)
npm run demo -- first-message-mod                        # every format and language → video/out/first-message-mod/
npm run demo -- first-message-mod --vertical --lang es   # one variant
npm run demo -- first-message-mod --preview --sheet      # quick look: half size, 15 fps, plus a contact sheet
npm run demo -- my-scene --validate                      # check a scene without rendering
npm run demo:test                                        # recorder tests
```

Keep the `--` before options: without it npm 11 warns about unknown flags (the script still reads them).

Each variant writes `<scene>.<format>.<lang>.mp4`, a `.jpg` poster, a `.json` with what was rendered (site bundle,
Chromium version, sounds) and, with `--sheet`, a `.sheet.png` grid of 12 frames. A 15-second vertical video takes
about 75 s to render; landscape takes longer. `video/out/` is not committed.

## How it works

- **Player**: `/mocks/dev/demo` in dimasite (`dimasite/src/app/features/demo-video/`). It lays out a stylised stream,
  a Twitch-style chat, captions and brand cards, and puts the real overlay components on the stream: the Overlay
  Studio renderer for alerts and TTS cards, the duel overlay, the roulette. Everything on screen is a function of
  the scene time `t`. Opened in a browser, it plays a built-in sample with format/language switches and a scrubber.
- **Recorder**: `render.mjs` serves the live site bundle (`dimasite/dist/dimasite/browser`, the same bytes
  domdimabot.com serves) on loopback, opens the player in Chromium with a fake clock, hands it the scene through
  `window.__dimaDemo`, and for every frame advances the clock by exactly 1/30 s, lets the page settle and captures it.
  The same scene always gives the same frames (byte for byte): Chromium runs with `CAPTURE_ARGS` (`lib/tools.mjs`:
  one raster thread, no partial raster, no threaded animation) and fonts are cached and warmed before the first
  frame. Frames are piped into x264 (BT.709, yuv420p).
- **Sound** is mixed afterwards from cues (sound effects, alert sounds, TTS clips), so it lines up to the frame.

A scene that only uses existing building blocks needs **no site build or deploy**: write the JSON, render it.

## Writing a scene

Scenes live in `video/scenes/<id>.json`. Start with `"$schema": "../scene.schema.json"` and your editor autocompletes
every field. `first-message-mod.json` is a complete example.

```json
{
  "$schema": "../scene.schema.json",
  "id": "my-scene", "v": 1, "seed": 7,
  "formats": ["vertical", "landscape"], "langs": ["en", "es"],
  "channel": { "name": "lunatica_v", "title": { "en": "...", "es": "..." }, "game": "Valorant", "viewers": 214 },
  "beats": [
    { "do": "intro", "at": 0, "title": { "en": "Scam links? *Gone.*", "es": "¿Links de estafa? *Fuera.*" } },
    { "do": "chat", "id": "spam", "at": "+300", "user": "xx_promo_77", "first": true, "text": "cheap viewers at ..." },
    { "do": "ban", "at": "+1500", "target": "spam", "sfx": "kit:thud" },
    { "do": "outro", "at": "+800" }
  ]
}
```

**Timing.** Each beat starts at `at`: a number is absolute ms; `"+N"` (the default is `"+0"`) means N ms after the
**end** of the beat right above it. Two anchors:

- `"with": "<id>"` counts from the **start** of that beat (run alongside it: a caption over an alert).
- `"after": "<id>"` counts from the **end** of that beat.

A beat placed `with` something is still "the beat above" for the next `+N`. After a caption that runs over a duel,
time the next beat with `"after": "<duel id>"`. The checker refuses an outro that would cover something still playing.

**Look.** `"look"` picks the art direction; the stream world (game scene, webcam, chat) recolors with it. `site`
(the website's Live First style, used by the shipped scenes), `studio` (the original), `paper`, `signal`,
`broadcast`, `night`. `--look <name>` overrides it for one render and adds `.<name>` to the file names, handy for
comparing. `"title"` is the small kicker above every caption (e.g. "Chat protection").

**Captions** stay on screen until the next caption in the same place (or the outro) replaces it, so slow readers get
the whole gap. Their `dur` only times the beats placed after them. Two captions in one place at the same ms: the one
written later wins; a caption that starts with a card is covered by it. On landscape they sit in the band under the
stream, so they never hide the webcam or the action.

**Text** is one string (same in both languages) or `{ "en": "...", "es": "..." }`. Spanish is Mexican Spanish
(computadora, celular, en vivo; no vosotros). In captions and card titles, `*words*` get the accent color.

**Building blocks** (`"do"`; run `npm run demo -- --emit-schema` after changing them):

| do | What | Main fields |
|---|---|---|
| `intro` / `outro` | Full-screen brand card. The intro is complete on frame 0, which TikTok uses as the default cover. | `title`, `sub` / `cta` |
| `caption` | Big caption in its own band (above the stream on vertical, under it on landscape). It stays until the next caption in the same place or the outro replaces it, so slow readers get the whole gap; its `dur` only times the beats placed after it. | `text`, `place` |
| `chat` | Viewer message. | `user`, `text`, `first`, `badges` (broadcaster, mod, vip, sub, verified), `color` |
| `bot` | DomDimaBot message. | `text`, `refs` |
| `event` | Highlighted chat notice. | `text`, `icon` (follow, sub, bits, raid, shield, info) |
| `delete` | A moderator deletes one message. | `target` |
| `ban` | All of a user's messages disappear plus "has been permanently banned." | `target`, `notice` |
| `alert` | Follow/sub/Bits/raid alert from the real Overlay Studio renderer, with its real motion presets. | `event`, `user`, `amount`, `message`, `sound` |
| `tts` | A viewer message read on stream (real TTS card). Its length follows the voice clip. | `user`, `text`, `voice`, `clip`, `showText` |
| `duel` | A chat duel in the real duel overlay; its length comes from the seeded battle. | `left`, `right` |
| `roulette` | A spin in the real roulette overlay. | `items`, `winner`, `title`, `spin` |
| `highlight` | Gold ring around the chat, the stream or one message. | `target`, `label` |
| `camera` | Zoom the stream to `alert`, `tts`, `roulette`, or back to `full`. Use it on vertical, where overlays are small. | `focus`, `zoom` |
| `sfx` / `music` | A sound effect / background music (needs a licensed file). | `src`, `gain` |

Every beat also takes `id`, `dur` (ms) and `sfx` (a sound when it starts).

**Keep it true.** A video shows what the product does today:

- Bot messages carry `refs` (`{ "file", "quote" }`). The checker fails when the quoted wording disappears from that
  source file, or when the bot text doesn't contain it. Use `"inText": false` for a template.
- Usernames are made up. The chat is a generic Twitch-like look with no Twitch logo.
- Check plan limits and costs before a caption claims them. Example: first-message review is on every plan, and the
  Free plan uses the Lite model at no credit cost.
- Moderation facts: a first-time chatter's scam link gets a **permanent ban** (not a timeout), and the bot's notice is
  English-only.

## Sound and TTS (optional per scene)

- **Kit sounds**, generated from scratch, so no license is needed: `kit:pop`, `kit:ding`, `kit:chime`, `kit:thud`,
  `kit:whoosh`. Use them as `"sfx": "kit:pop"` or `{ "src": "kit:pop", "gain": 0.6 }`.
- **Your own files** go in `video/sounds/` and must be listed in `video/sounds/LICENSES.md` with source and license
  first. Music needs a license that allows ads.
- **Alert sounds** follow the overlay rules: `delay`, `fadeIn`, `fadeOut` (ms), cut when the alert ends.
- **TTS** uses Fish Audio for both languages. Add a voice to `video/voices.json` (who owns it, a license that allows
  ads), then point `defaults.en` / `defaults.es` at it:

  ```json
  { "defaults": { "en": "nova", "es": "luz" },
    "voices": { "luz": { "engine": "fish", "reference_id": "<32 hex>", "model": "s2.1-pro-free", "freeUntil": "2026-11-30",
                         "name": "Luz", "license": "...", "source": "fish.audio/m/<id>" } } }
  ```

  Export `FISH_AUDIO_API_KEY` before rendering. The key is never saved.
  - **Free model:** only models listed in `FREE_FISH_MODELS` (`lib/tts.mjs`; today `s2.1-pro-free` until 2026-11-30)
    skip the paid flag. A voice's own `freeUntil` can only shorten that. Any other model, or after that date,
    needs `--allow-paid-tts`.
  - **No fallback:** a failed request fails the render rather than switching to another model.
  - **Cache:** clips are kept in `video/sounds/tts/`, keyed by model + voice + text. Commit them, so each line is
    synthesized once.
  - **Own clips:** a beat can also use your own clip: `"clip": { "en": "tts/hello-en.mp3", "es": "..." }`.
  - **No voice yet:** without a voice, a TTS beat shows its text card silently.
- A scene without sound gets no audio track.

## Adding a building block

1. Add it to `DEMO_ACTORS` in `dimasite/src/app/features/demo-video/demo-scene.ts`. That file is shared with the
   recorder (Node imports the TypeScript directly), so keep it import-free.
2. Draw it in `demo-frame.component.*`. Everything must follow `t`:
   - **Our own CSS animations** go on an element with `data-clock-origin` set to the beat's start. The clock
     directive seeks them.
   - **A component that seeks its own animations** (like the duel) gets a wrapper with `data-self-clock`.
   - The recorder fails any frame where an animation runs on its own clock. GIFs, `<video>`, iframes and WebGL
     can't be stepped and are not supported.
3. Extend `ops/checks/demo-player.mjs`, run `npm run demo -- --emit-schema`, then release the site
   (`scripts/saas-ops build site` → `verify --check ops/checks/demo-player.mjs` → `deploy`). Until it is deployed,
   render with `--bundle <candidate>/dist/dimasite/browser`.

## Production-host rules

- **Resource limits:** renders and `npm run demo:test` run inside a systemd scope (4 GB, 4 CPUs, `nice`) and only
  with 4 GiB of memory available.
- **One at a time:** they hold a host-wide lock (`flock` on `/run/lock/domdimabot-demo-video.lock`), shared by every
  checkout and worktree. A second run exits at once ("another demo render … is running"). Every child process holds
  the lock too, so it is released only when Chromium and every ffmpeg have exited.
- **Cancelling:** Ctrl-C stops Chromium and every ffmpeg and deletes the half-written variant.
- **No overlap with builds:** they refuse to start while an Angular build/serve or a saas-ops site build or preview
  is running, whatever the target. To render an unreleased player, build it (`scripts/saas-ops build site`) and pass
  `--bundle <run>/source/dist/dimasite/browser` after the build finishes.
- **No public network:** the player may load only the site itself, its `/__demo/media/` files and Google Fonts. Any
  other attempt (API, analytics, websockets, other hosts) is blocked and fails the render.
  Google Fonts responses are cached in `video/.cache/fonts`.
- **Scenes only from code:** the player never reads a scene from the URL. Only the recorder (from JavaScript) or the
  built-in samples can set what it shows.
- **Mid-render deploys:** if the site is redeployed during a render, the render fails ("render again"), so a video
  never mixes two versions.
