# Temporary role announcements — accepted integration handoff

Date: 2026-10-31
Accepted feature commit: `e803ab78`
Status: **root-accepted local feature and dependency closure** for temporary-role announcements. The helper and its concrete native dependencies are implemented and verified. Caller adoption and deployment remain open. The full `send_message.chat.ts` source is **partial**: only its context-free plain-send branch is available as the helper's dependency.

## Accepted source and verification

The exact final source snapshot is `/root/.local/state/rust-full-migration-20261028-integration-announcements-v4/source`, tree `05443b8e540247ceb8ea33afe261e9a07e2d6d61abd45ab78753c3f6408b54b5`, with 1,605 inputs. Root verification is recorded in `/root/.local/state/rust-full-migration-20261028-integration-announcements-v4/artifacts/parent-verified.json`; the detailed result is `/root/.local/state/dimabot-migration-teams-20261031/results/second-sol-announcements-verified.json` (SHA-256 `9bdd68fa33a7f6d3db953db729674ac6c9f73e44d66b40ff941b21702e2569bc`). The independent oracle has 26 ordered source cases (SHA-256 `e5f22dc25c5ab479b15c3cc97552cde2bfdd1f1b45cca9b6f7381c099ff70a4c`).

The final run passed 21 unique tests: seven ordinary and 14 ignored/private serial tests, plus four missing, empty, substituted, and removed-case fixture controls. Concrete adapter coverage includes Redis queue wire/order/TTL/clear/retain behavior; `TwitchFunctions::native` app-token cache miss, OAuth HTTP exchange, Redis publication/TTL/reuse, Helix sends and flush; and disconnects before headers and while reading a partial response body. Focused check, strict Clippy, `cargo fmt --all -- --check`, and strict all-feature/all-target Clippy on the combined accepted candidate passed. The recorded production comparison found all 18 containers unchanged, and task resources were cleaned up.

There is no benchmark, deployment, push, TypeScript retirement, or native caller-adoption claim. The runner result records `VERIFIED_PENDING_ROOT_ACCEPTANCE` at capture time; the later parent verification records byte-equal central wiring, and accepted feature commit `e803ab78` establishes the subsequent root acceptance. The historical authoring and integration entries below retain their original statuses and describe the evolution of this work.

## Feature and concrete dependency map

`temporary_roles_announcements.ts` is implemented by `dimabot/src/utils/temporary_roles_announcements.rs`. It retains the source queue key and payload, 14-day TTL, normalization, role filtering, insertion-order deduplication, VIP-before-moderator order, threshold-five compression, sequential sends, and queue retention after send failure. It uses the concrete shared Redis manager and concrete `TwitchFunctions` sender; there is no chat-sender trait/mock standing in for an adapter. Native token storage, OAuth, Helix HTTP, and logging are existing application adapters and were exercised through the native application wiring.

The required sender implementation is `dimabot/src/functions/chats/send_message_plain.rs`. It covers an empty message without effects and the nonblank context-free send with no reply target. It uses app-token auth, the bot sender ID, the source-only Helix request, held/rejected/success response handling, and shared logging.

The 131-line accepted helper is the frozen source shape; earlier notes that cited a 147-line prompt estimate are historical. The source imports only the chat sender and Dragonfly client at runtime. In the chat source, explicit type imports (`CommandReferenceRequest`, event data/schema types, and AST effect context) are type-only; logger, links, tokens, AST delivery, and special-command parsing are runtime imports. Those distinctions do not imply that the full chat function is migrated.

## Source boundaries retained

- `send_message.chat.ts` AST context, `parseSpecialCommands`, command references, `literalArguments`, variables, plan context, `replyToMessageId`, and context-dependent `deliverAstMessage` remain unimplemented here. No `TwitchFunctions::sendAnnouncement` implementation is claimed; that is a distinct feature.
- Twitch logins are ASCII; contextual Unicode lowercase behavior such as Greek final sigma is not reproduced. Shared JavaScript whitespace trimming and leading-`@` removal are retained.
- Native JSON/transport diagnostic wording differs from V8/undici wording. Native redirects are not followed. Source logger payload timestamps and JavaScript stack are not duplicated; native sink errors are best-effort. The native logger records its own timestamp.
- Non-array `data.data`, deep/non-finite JSON edge behavior, and unused Mongo/directory methods are not claimed as covered behavior. Native cancellation is an addition; it does not establish source parity for a cancellation feature.
- The optional-param serializer defect in v2 was retained as failed history and fixed in v3. V4 strengthened native application-adapter coverage. The final accepted evidence above is authoritative.

## Historical authoring and integration record

The following statuses describe earlier stages, not the current accepted state.

- Initial authoring was marked **READY-FOR-VALIDATION** and recorded author-only hashes. Those hashes were superseded by the final accepted tree; the older list and proposed wiring are retained in task history only.
- Static integration review corrected source behavior for successful `data: []` and `data: null` responses and expanded the oracle to 26 cases. Its source record said no runtime lease; that is historical and was followed by isolated verification.
- V2 exposed an optional-parameter signature-serialization defect; V3 corrected it without weakening the signature check. V4 added real application wiring coverage. The final results are linked above.

Root owns any later source reconciliation, adoption decision, and commit. No runtime lease is active for this documentation task.
