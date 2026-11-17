# Encuesta Polar

A Twitch poll widget for Overlay Studio, made for UnOsitoPolar (polar bear theme: calm cold blue and ice). It is a native
Dima SDK v1 widget (`engine: "dima"`, `uses: ["polls"]`), like [Luna de Bits](../luna-de-bits/README.md). It doesn't load
StreamElements code or jQuery. Texts default to Mexican Spanish; the "Idioma de los textos" setting switches them to
English.

- A frosted ice card with a snow cap, icicles, a slow aurora and falling snow. A polar bear peeks over the snow and
  rests its paws on it. It blinks, twitches its ears when votes arrive and looks at the leading choice.
- Each choice is an ice bar with a turning snowflake at its tip. Votes slide the bar and count up, a "+N" chip slides out
  next to the snowflake and ice dust trails behind it. The leader gets a paw print.
- A ring counts down to the poll's end and pulses in the last 10 seconds.
- When the poll ends, the winner shimmers, the rest dim, the bear smiles and hops, and snow crystals fall over the card.
  Ties say "¡Empate!" and a poll without votes says "Nadie votó". The results stay up for "Segundos mostrando el
  resultado" (20 s by default), then the card leaves. A poll that had already ended when the overlay loaded shows its
  results quietly, without the celebration.
- The layout fits any layer box: it uses one, two or three columns of choices, whichever shows them biggest.

## Data

- **Poll:** `Dima.state('polls').poll`, the channel's current or last Twitch poll (totals only). Predictions are ignored.
  Twitch's second end event ("archived" after "completed") never celebrates twice. A poll ended early ("terminated")
  shows its results like Twitch does.
- **Newest wins:** after the startup state, the host replays updates that arrived while the frame loaded. An older
  revision, an older poll or a finished poll "reopening" is dropped.
- **Clock:** poll times are server times and the OBS computer's clock can be off. The widget learns the offset from
  updates that arrive after the first one (arrival time minus the update's `occurredAt`, smallest recent value), so the
  countdown and the results timing follow the server. Only an end seen as it happened celebrates. An end that arrives
  late (a reconnect) doesn't bring back old results.
- **No poll:** OBS hides the widget. Studio shows an example poll.
- **Stale poll:** a poll still "active" 2 minutes after its deadline (an end event that never arrived) is hidden. Until
  the clock is checked, it must also have been open here that long, so a fast clock alone never hides a running poll.
- **Tests:** "Probar una encuesta" runs a 24-second poll with votes arriving. "Probar el resultado" ends it, or shows the
  results of the poll on screen. Neither saves anything. Studio's Test drawer poll sample shows as a running poll and
  ends with its results at its deadline. In "Test in OBS", the server brings the real poll state back after a minute.
- The channel needs DomDimaBot with permission to read polls, so the poll events reach the overlay.

## Install

In Overlay Studio, import a zip of the six files (`widget.json`, `html.txt`, `css.txt`, `js.txt`, `fields.txt`,
`data.txt`), add the layer, and size it, for example 480×640 (card), 1100×300 (wide) or 700×330.

## Preview and checks

```bash
# Standalone page running the widget in the real frame builder + Dima SDK, with poll/vote/end/layout buttons
cd dimabot && node --import tsx ../marketing/widgets/encuesta-polar/preview/build.mts ../marketing/widgets/encuesta-polar /tmp/encuesta-preview.html
# Behaviour checks (Playwright): phases, celebrate once, quiet late results, stale polls, tie, no votes, text-only
# titles, English, replayed updates, fast/slow OBS clocks, late ends, the Test drawer sample, Studio example and
# buttons, layouts that fit (also after a longer title or a resize)
cd marketing && node widgets/encuesta-polar/preview/checks.mjs /tmp/encuesta-preview.html
```

Run browser checks one at a time under the host caps in the root `CLAUDE.md` (`systemd-run --scope ... MemoryMax=2G`).
