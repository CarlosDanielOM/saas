# Luna de Bits

A celestial Bits goal widget for Overlay Studio, made for moonplayslive (Spanish, es-MX). It is a native Dima SDK v1
widget (`engine: "dima"`, `uses: ["goals", "alerts"]`). It doesn't load StreamElements code or jQuery.

- The moon waxes from a crescent to a full moon as the goal fills. Little stars gather around it. The "Figura" setting
  swaps the moon for a star.
- The bar is a sky-blue gradient with stardust and a sheen. A twinkling star at the tip sheds sparks. Milestone stars at
  25/50/75% light up with a burst when progress passes them.
- Each cheer arrives as a shooting star that lands on the tip, with a "+N" chip and "Último cheer" in the footer. The bar
  moves when DomDimaBot sends the new total, about 1.5 s after the alert.
- When the goal is reached, the moon flares, rings and a star burst go off, shooting stars cross the card, and the title
  shimmers with "¡Meta cumplida!". It never celebrates again for a goal that was already complete (reload, a goal switch,
  a new target).
- The layout fits any layer box. Boxes wider than 2.2:1 get a horizontal bar; others, including Studio's default
  480×640, get a stacked card.

## Data

- **Goal:** the first Bits goal (`metric: 'bits'`) in `Dima.state('goals')`, active before reached/scheduled/ended. The
  "Nombre de la meta" setting picks one by name. Each layer's Studio "Goal data" decides between the Goals page (Metas)
  and the streamer's Twitch Creator Goals.
- **No Bits goal:** OBS hides the widget. Studio shows an example goal with a hint.
- **Tests** (Studio tests, "Test in OBS", the "Probar" buttons) show the cheer on the bar for 20 s and never save anything.

## Install

In Overlay Studio, import a zip of the six files (`widget.json`, `html.txt`, `css.txt`, `js.txt`, `fields.txt`,
`data.txt`), add the layer, and size it, for example 800×200 or 480×640.

## Preview and checks

```bash
# Standalone page running the widget in the real frame builder + Dima SDK, with cheer/finale/layout buttons
cd dimabot && node --import tsx ../marketing/widgets/luna-de-bits/preview/build.mts ../marketing/widgets/luna-de-bits /tmp/luna-preview.html
# Behaviour checks (Playwright): no repeat celebrations, test cheers expire and don't leak across goals, overlapping cheers
cd marketing && node widgets/luna-de-bits/preview/checks.mjs /tmp/luna-preview.html
```
