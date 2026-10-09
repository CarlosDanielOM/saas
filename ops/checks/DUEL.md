# Duel widget checks

The Duel arena is available under `/:streamer/modules/widgets/duel` in the Premium
Widgets module. Create a private OBS Browser Source URL there (1920 × 1080).
The token lives in the URL fragment. Rotating the link revokes existing sources.
A source counts as active after its authenticated client acknowledges readiness;
presence expires after five seconds if the API/source stops refreshing it.

`!duel @viewer` creates a three-minute challenge. `!duel @streamer` skips the accept step and
starts at once; the streamer may also challenge viewers (normal accept). The streamer's side
fights enraged (`run.enraged`): doubled heavy/special, crit and defense chances, winning about
83% of fights, with an enraged overlay look. A losing streamer is never timed out and no
moderation lookups happen. Only that viewer can accept or
decline. One challenge/battle runs per channel. There is no predetermined winner:
on accept the backend simulates a turn-based battle (`simulateBattle` in
`dimabot/src/duel/model.ts`) with two distinct characters (Knight, Ronin, Mage),
a coin flip for the first attacker, and per-turn rolls for the move (normal 68%,
heavy 24%, special 8%, each with its own damage range) and a 15% chance to steal
the opponent's next turn. When hit by a normal or heavy attack, the defender rolls a
15% chance to use its skill (Knight Shield Wall, Ronin Ghost Step, Mage Arcane
Ward): normals deal 0, heavies lose 80% (`raw` keeps the rolled damage). Specials
still roll the skill but shatter it at full damage. Every attack (specials included) has a 10% crit chance that
doubles the rolled damage before any defense. Instead of attacking, a fighter at
60 HP or less has a 20% chance to heal 25–40 HP (Knight: angel, Ronin: potion, Mage:
green glyphs). Blocking a normal or heavy attack has a 35% chance to chain a combo heal
(same amount, never after a special). Both kinds share 5 charges per fighter, shown under
each HP bar. About 3 in 4 fights last 15–35 s (median ~20 s, ~19% end sooner).
Defenses and heals stop after 24 turns so every fight ends. The first fighter at 0 HP loses. The stored turns drive
the overlay animation and the deadline (last hit + 1.9 s knockout, typically 13–18 s).
The dimasite preview mirrors those numbers in `duel-battle.ts`; keep them in step.
Connected overlays carry the prompt and fight; chat receives only the winner (with
remaining HP) at the deadline. New duels without an enabled, ready source retain
chat prompts and narrate the fight's real specials, heals, crits, defenses, stolen turns
and heavy blows.
Runs accepted before turn-based battles (no `turns`) still render and announce. Accepted battles finish even if OBS or
the bot disconnects. The cron supervisor runs `duel.worker` independently.

Loser timeouts default to enabled for 60 seconds, preserving existing behavior.
The widget allows disabling them or choosing 1–1,209,600 seconds. Disabling takes
effect for an accepted battle too. No moderation/provider lookups occur when
it is off. Streamers, editors, and the bot account remain protected. A losing
moderator's restoration is persisted before demotion and retried after the
configured timeout. Twitch permission errors do not prevent winner delivery.
External effects are claimed before execution to avoid duplicate announcements
or timeouts after a restart; failed/uncertain chat sends are recorded rather than
automatically replayed.

Run each candidate with the helper, private Mongo/Redis, and provider fixtures:

```sh
scripts/saas-ops verify api-RUN --dependency mongo --dependency redis \
  --test-env ops/checks/duel-fixtures/test-env.json \
  --fixtures ops/checks/duel-fixtures --check ops/checks/duel-backend.mjs
# Repeat with the bot-RUN and cron-RUN candidates.
scripts/saas-ops verify site-RUN --check ops/checks/duel-widget.sh
```

The backend check exercises command acceptance, quiet overlays, real-time
winner deadlines, fallback narration, settings validation/concurrency, private
OBS authorization/readiness/revocation, no-timeout mode, configured duration,
moderator restoration in a fresh worker, provider failure handling, and battle
invariants/odds over 2,000 simulated fights. All
provider requests are intercepted; no production data or Twitch messages are used.
The browser checks cover dark/light at 320/390/1280 pixels, English/Spanish,
WCAG AA, Premium gating, full-access admins, uncertain-save retries, conflicts,
local previews, and transparent OBS challenge/fight/winner/idle/disconnect states.
Browser dependencies default to the host's `/tmp/saas-cooldown-browser` installation.
