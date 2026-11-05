# Step 5 plan: `$(widget.signal)` and the rest of the widget engine "magic"

Status: plan only (2026-11-05). Steps 1–4 of the engine are built (see `CUSTOM_WIDGET_ENGINE.md`).

## 1. What a signal is

A signal is a small named message from the bot to the channel's custom widgets. Commands (and later timers, triggers,
channel-point rewards and Bits rules) send them; widgets decide what they mean. Examples:

| Command | Command response | Widget reaction |
|---------|------------------|-----------------|
| `!theme night` (mods) | `$(widget.signal theme &p1)` | the chat box switches to its night palette |
| `!hype` | `$(widget.signal hype)` | confetti + "HYPE" banner for 10 s |
| `!vote a` (everyone) | `$(widget.signal vote &p1)` | a poll widget tallies the vote |
| `!feed pizza` (everyone, cooldown) | `Ada fed Mochi! $(widget.signal feed &p1)` | a pet widget eats (the widget picks a default when the value is empty) |
| `!spin` (subs) | `$(widget.signal spin)` | a wheel widget spins |
| `!focus on` | `$(widget.signal.to "Chat box" focus on)` | only the layer named "Chat box" reacts |

Values use the bot's normal command syntax: `&p1`, `&p2`… for arguments, `&t` for all text after the command (not
`$(1)`, which is another bot's syntax). Signals never touch anything outside widget code. Who may send one is decided by the command's own permission level
(viewers, subs, mods…), exactly like any other command response.

## 2. Command functions (dimabot `src/utils/ast_parser/functions/widget.functions.ts`)

- `$(widget.signal <name> [value…])`: send to every published overlay of this channel whose widgets use `signals`.
- `$(widget.signal.to <layer name> <name> [value…])`: send to custom layers with that name only.
- Output is empty (signals are silent) so they can be combined with chat text; errors return a short `Error: …`
  only for mistakes the streamer can fix (bad name, value too long).
- **Real runs only:** signals are sent only when the execution has an effect context (`ctx.effectContext`, the same
  authority pet actions use for genuine chat commands and Twitch events). Dashboard tests and previews return
  `[signal theme → night]` instead of sending, so testing a command never changes what's on stream.
- Rules: name `^[a-z0-9][a-z0-9_.-]{0,39}$`; value is the remaining arguments joined with spaces, max 500 characters;
  at most 5 signals per command run; per channel 30 signals per 10 s (Dragonfly counter). Over the limit: dropped silently
  and counted (visible in the Studio widget log as "N signals skipped").
- Registered with full metadata (description, syntax, examples, category `overlay`, keywords in EN/ES, plan `free`) so
  the command editor, AST Blocks, the docs assistant's function search and dimadocs pick it up automatically.

## 3. Delivery

Reuse the chat feed path: the bot publishes `{ channel, type: 'signal', data }` on the Dragonfly `widget-feed` channel;
the API forwards it as `overlay-feed` to sources whose published widgets use `signals` (and, for `.to`, only to sources
showing a layer with that name). Commands run in the bot for chat and in the API for some tests; both can publish.

```ts
interface DimaSignal {
  id: string; name: string; value: string; json: unknown | null;   // json: value parsed when it is a JSON number/boolean/array/object
  args: string[];                                                     // value split on spaces
  at: number;
  user: { id: string; login: string; name: string; roles: { broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean } } | null;
  source: { kind: 'command' | 'timer' | 'trigger' | 'reward' | 'bits-rule' | 'studio'; name: string };
  target: string | null;                                              // layer name for widget.signal.to
}
```

Signals are fire-and-forget (no queue, no replay after a reconnect), like chat.

## 4. Widget side

- `widget.json`: `"uses": ["signals"]` plus an optional list that powers Studio's UI:
  `"signals": [{ "name": "theme", "description": "Switch colours", "values": ["day", "night"] }]`.
- Dima SDK: `Dima.on('signal', s => …)` and the shortcut `Dima.on('signal:theme', s => …)`.
- StreamElements widgets: the SE layer also fires `onEventReceived` with `listener: 'dima:signal'` and the same data, so
  creators can support both platforms from one file.
- Values come from viewers' arguments: `Dima.escape()` is the documented way to show them; the docs say so loudly.

## 5. Studio

- Layer settings, new "Commands" block (only for widgets that use `signals`): each declared signal with its description,
  the ready-to-paste response (`$(widget.signal theme &p1)`) with a Copy button, and **Make a command**, which opens the
  existing command editor pre-filled (`!theme`, response, mods-only suggestion for anything visual).
- Test drawer: "Send a signal" (name + value) to the preview or, after the existing OBS confirmation, to OBS.
- Widget log shows each received signal ("signal theme → night from MOD_kitsune").
- Import summary and the "Uses:" chips list "Commands can control it" when `signals` is used.

## 6. Other step-5 features (same release train, smaller)

1. **Bot events** (`uses`: `tts`, `triggers`, `pets`, `duels`, `dimafx`, `rewards`): forward the events these modules
   already publish (TTS start/end with text and voice, trigger played, pet talk/mood, duel result, roulette result, DimaFX
   purchase, channel-point redemption) as new `overlay-feed` types, each mapped once in `live.ts` from existing publishers.
2. **Live state** (`uses`: `goals`, `polls`): reuse `WidgetStateSource` (goals service `goalSnapshot`, the poll/prediction
   source) and push snapshots as `state` events; `Dima.state('goals', fn)`.
3. **Real chat replay in the editor:** "Replay recent chat" in the Test drawer sends the last 20 messages from the existing
   chat history (Dragonfly) to the preview.
4. ~~**Code tab**~~ and 5. ~~**Roll back**~~: shipped 2026-11-05 as the Studio code editor ("New widget" / "Edit code",
   version history with "Open"); see `CUSTOM_WIDGETS.md` → Code editor.

## 6b. Decided with the user (2026-11-05)

- Rename the Dima SDK store to **`Dima.storage`** everywhere (`Dima.storage.get/set`, event `storage`, widget.json
  `uses: ["storage"]`), shipped with step 5. No live widget uses `store` yet (0 custom widgets in production), so no
  alias. StreamElements keeps `SE_API.store` (its own API).
- Example use case: Etsy/StreamElements pets with `!pet` / `!feed` commands → `$(widget.signal feed &p1)`; declared
  signals in widget.json give one-click "Make a command" after import.
- Live sync from local editors stays a possible future feature.

## 7. Checks

- AST unit tests: parsing, name/value rules, per-run and per-channel limits, dry-run when there is no effect context.
- API check: command execution with an effect context → Dragonfly → `overlay-feed` signal on the right sources only
  (`uses`, `.to` targeting, other channels never), limits.
- Browser check: Studio "Commands" block (copy, Make a command pre-fill), Test drawer signal to preview/OBS, Dima and SE
  widgets receiving `signal` / `dima:signal`.
- Docs: dimadocs EN/ES page for `$(widget.signal)` with the examples above, built and verified with the docs workflow.
