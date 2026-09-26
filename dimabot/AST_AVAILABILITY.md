# AST enable and disable

Supported actions:

```text
$(disable.command discord)
$(enable.command discord)
$(disable.command discord 300)
$(enable.command discord 300)
$(disable.redemption "Hydrate please" 300)
$(enable.redemption "Hydrate please")
```

Command names accept an optional `!`. Redemption names are matched exactly, ignoring case; quote names containing spaces. A Twitch reward ID can be used instead. Ambiguous names are rejected. Every lookup is restricted to the current channel and redemptions must already exist in the bot's reward configuration.

The optional duration is a whole number of **seconds**, from 1 to 604800 (seven days). Omitting it makes the change permanent and cancels a previous restoration. Successful AST actions return no text.

A timed action restores the previous configured state. Disabling an already disabled target does not later enable it. Repeating the same timed action extends the deadline while preserving the original state. An opposite action replaces the old deadline and records the state immediately before that new action. Ordinary enabled-state edits through chat commands, dashboard updates or document saves cancel pending restorations, including edits that write the same value. Unrelated edits and renames preserve the deadline. Deleting a target deletes its restoration; recreating the same name does not inherit it.

The target document stores desired state, restoration deadline and synchronization status atomically in MongoDB. There is no TTL or missed-deadline grace cutoff. The existing timer worker recovers due changes about every two seconds, independently of recurring chat timers, stream status and their worker lock. Downtime or a busy provider can delay completion. Per-target leases serialize remote synchronization and are recoverable after a crashed process. Old tokens cannot remove newer work.

Commands invalidate the normal command cache. Redemptions update Twitch's `is_enabled` flag using the broadcaster's token, so disabled rewards stop being offered. Twitch still enforces which application may manage a reward and the account's granted scopes. Failed synchronization keeps the saved desired state pending and retries, normally after 30 seconds. The AST response explicitly reports that the state was saved and synchronization is retrying. A newer desired state supersedes pending work. Manual changes made directly on Twitch are outside this mechanism; it uses the bot's configured state as the restoration baseline.

AI-generated AST requires moderator level 7 for these actions. Streamer-authored templates retain the existing command/event authorization gate.

## Adding a target type

Add an `AvailabilityAdapter` to `src/utils/availability/service.ts`, with a model, enabled field, channel-scoped name resolver and idempotent synchronization method. Attach `addAvailabilityFields` to its schema. Both `enable.<type>` and `disable.<type>` registration and durable recovery follow this registry. Regenerate the AST catalog and test its provider-specific behavior. `enable.event` and `disable.event` are not implemented yet.

Internal metadata is excluded from ordinary reads and cannot be changed by normal update payloads. Service writes use the explicit internal query marker. New update pathways must preserve the schema middleware; raw collection writes bypass it.

Functional verification: `ops/checks/ast-availability.mjs`, using disposable Mongo/Dragonfly and `ops/checks/ast-timer-fixtures`. It checks actual AST calls, cache invalidation, mocked Twitch reward updates, overlaps, manual overrides, stable identity, provider retries, expired leases, fresh-process recovery and automatic recovery in the normal cron entrypoint.
