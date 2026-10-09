# Duel widget checks

The Duel arena is available under `/:streamer/modules/widgets/duel` in the Premium
Widgets module. Create a private OBS Browser Source URL there (1920 × 1080).
The token lives in the URL fragment. Rotating the link revokes existing sources.
A source counts as active after its authenticated client acknowledges readiness;
presence expires after five seconds if the API/source stops refreshing it.

`!duel @viewer` creates a three-minute challenge. Only that viewer can accept or
decline. One challenge/battle runs per channel. The backend randomly chooses the
winner. Connected overlays carry the prompt and 11.4-second fight; chat receives
only the winner at the deadline. New duels without an enabled, ready source retain
chat prompts and random battle narration. Accepted battles finish even if OBS or
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
moderator restoration in a fresh worker, and provider failure handling. All
provider requests are intercepted; no production data or Twitch messages are used.
The browser checks cover dark/light at 320/390/1280 pixels, English/Spanish,
WCAG AA, Premium gating, full-access admins, uncertain-save retries, conflicts,
local previews, and transparent OBS challenge/fight/winner/idle/disconnect states.
Browser dependencies default to the host's `/tmp/saas-cooldown-browser` installation.
