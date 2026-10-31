# Pet AI chat context and tool authority

## Architecture and boundaries

`pet.ask` generates through the existing `chat()` context path: channel personality context, recent and semantic chat history, Mongo-revalidated confirmed channel memories, per-user facts, stream state, and user-thread context. The selected pet persona and configured TTS voice/language still govern the reply. Completed pet exchanges are stored as a separate per-viewer thread; only Mongo `pet_requests` rows whose playback started and completed are reused, within 24 hours and the plan tier's prompt-turn limit. When there is no qualifying pet history, the runtime reads matching user-thread context without appending the pet exchange to the bot thread. Context retrieval rejects foreign and unconfirmed memories and applies the channel's existing sensitive-memory policy.

Only verified Twitch chat-command provenance survives the opaque AST effect context. The runtime reconstructs the acting viewer's identity and refreshes moderator status before generation; authored command/configuration text does not lend its authority. Event-triggered and legacy requests have no verified chat actor and receive no tools. Pet calls always exclude channel-credential `code_execution`; permitted AST actions remain subject to the existing caller permission checks. The pet path revalidates the active request before each provider/tool round, rejects nested or dynamic AST syntax and recursive pet/TTS actions, and limits `ban.self` to the verified triggering chat message. Normal chat tool behavior is unchanged.

## Exact-candidate verification and deployment

API candidate `api-8ecf385f0aa3` (image `sha256:daf63feae996f8202d810e84350e3045d4ab18d68b5be1a84de965364d20825c`) passed 168 regression tests via [`pet-provider-regressions.mjs`](../ops/checks/pet-provider-regressions.mjs), plus the expanded [`pet-runtime.mjs`](../ops/checks/pet-runtime.mjs). Coverage includes configured persona and normal-thread fallback, confirmed Mongo-revalidated memories and per-user facts, stream state, rejected foreign/pending/sensitive memories under the default policy, playback-qualified per-viewer pet continuity, failure/other-viewer exclusion, and denial of a model-requested level 9 action from a viewer whose moderator badge was stale.

Bot candidate `bot-50f5a661f020` (image `sha256:9ff40ce9dd253af3bbf7003aba3d9ab0273b74efa8a353a36568364b5c4e6438`) passed 98 pet-trigger assertions in [`pet-triggers.mjs`](../ops/checks/pet-triggers.mjs) and the signed-command/durable EventSub behavior check [`pet-configured-triggers.mjs`](../ops/checks/pet-configured-triggers.mjs). Checks covered verified actor-chat persistence through the opaque effect, normal tools for chat commands, no tools for events, duplicate and injection rejection, and stable usage accounting. Both exact candidates were accepted and deployed through `scripts/saas-ops`; readiness passed. At handoff both production containers were running with restart count zero. Read-only API checks returned 200 for `/config/site/analytics`, 401 for invalid `petcap`, and 401 for anonymous pet settings.

Rollback remains target-scoped through the helper's release receipts:

```bash
scripts/saas-ops rollback api-8ecf385f0aa3
scripts/saas-ops rollback bot-50f5a661f020
```

The checks use disposable fixtures and a test-only quiescence barrier. Fixture setup corrections for seeding and display names affected test reliability only. No paid/live audio was generated and no real moderation action was executed; the production API checks above were read-only. Final inspection confirmed only API and bot changed among the 18 baseline containers. Helper cleanup removed test resources and retained both rollback artifacts.
