# Speech commands: one-time conversion to ordinary AST

The implicit speech dispatcher is retired. Default `!s` stores
`$(tts $(user) dice: &t)` and executes through `commandHandler`, like any custom
command. `func: speach|speech` remains identification metadata for the TTS editor;
it does not select a special executor. Plain command text is never wrapped at
read, save, or execution time.

Existing rows need a one-time conversion before the new bot runs. This is a
separate data-release procedure, not a side effect of application startup.

## Reviewed scope

`dist/scripts/migrate_speech_ast.script.js` selects only commands whose function
is `speach` or `speech`. Empty/legacy default bodies become the full default AST;
other implicit templates are wrapped in `$(tts ...)`; already explicit TTS AST
is retained. Commands become editable. Existing enabled states, names, access
rules, and unrelated commands are unchanged. An existing zero-cooldown speech
command gets 5 seconds only if another editable command already owns that
channel's allowance. All previous field values are backed up, including absent
fields. The script parses candidate AST before preparing the plan.

## Delivery

1. Validate the migration, repeated application, and rollback against disposable
   Mongo/Redis using `ops/checks/modular-tts.mjs`. Validate API/bot/cron code and
   site assets through `scripts/saas-ops` as usual.
2. Deploy the verified API image so the migration script is available. The old
   bot accepts the explicit TTS expression during this short transition.
3. Run `node dist/scripts/migrate_speech_ast.script.js --prepare /tmp/speech-ast.json`
   inside that API container. This only reads Mongo and writes a private plan.
   Review the reported row/field counts. Copy this 0600 file to private host
   storage before applying it; never print the templates or commit the backup.
4. Run the same script with `--apply /tmp/speech-ast.json`. It consumes the exact
   prepared plan, compares each original value before writing, and invalidates
   only the affected command cache keys. Review changed/unchanged/conflict counts.
   A conflict fails the operation rather than overwriting a concurrent edit.
   If a legacy editable speech row already shares zero cooldown with another
   command, review it against the original backup and amend only its planned
   cooldown to 5. Preserve the original backup and save the amended plan separately;
   never re-prepare already converted message bodies.
5. Verify the resulting rows against the plan using read-only queries. Deploy the
   verified bot/cron/site candidates and check readiness and served defaults.

Do not prepare a fresh plan after users start editing ordinary AST commands:
plain text is now a valid intentional chat response. Reapplying the same plan
is safe and does not wrap templates again.

## Rollback

Retain the private plan with the deployment receipts. Restore the compatible bot
release through its receipt, then run the migration script with
`--rollback /tmp/speech-ast.json` if data restoration is needed. Rollback only
restores rows still matching the migrated values and invalidates their caches;
it refuses to overwrite subsequent user edits. Restore other affected releases
through their own helper receipts. No collections or data are deleted.
