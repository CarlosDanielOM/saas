# Delete Twitch message adapter — 2026-10-30

**Status: verified partial local feature, updated after the flat deletion-response and Twitch diagnostics checks.** The original bounded adapter was validated at commit `df3223f28769060202a216b1c8baf68a6cdadf31`. The later diagnostics/response wave is bound to commit `c49f654206aa5a68331d0e57fa77ab2b983acb58`, 1,493 inputs (1,483 Git plus ten reused SDK inputs), and source-tree SHA-256 `5d9cdc6ab77860e1fc0be8fb094f184dc37db8bc854cff68ff8bd55771feee0b`; all input hashes match.

The native adapter now uses the shared flat JSON document response path. It accepts the previously failing depth-129 and depth-256 source response wires; a separate native check exercises depth 4,096 without claiming Node `JSON.stringify` parity at that depth. The updated application auth and diagnostics adapter also uses the existing `account_token` directory path and fenced credential publication. Current request, error, and body diagnostics use safe categories and do not expose raw URL, response body, or credential values. No new crate dependency or feature profile was added.

## Native behavior and reuse

`dimabot/src/functions/chats/delete_message.chat.rs` implements `TwitchFunctions::delete_message(message_id, channel_id, mod_id)`. The `chats` module exposes it through the existing public functions module.

The native path reuses:

- the existing directory account-token lookup (`account_token`) and existing fenced Redis cache publication, with a single credential-mirror attempt;
- `NativeFunctionAuth`, the shared pooled `TwitchClient`, moderation endpoint, ordered/pre-encoded query construction, and bot identity `TWITCH_BOT_ACCOUNT_ID`;
- the shared flat JSON document parser/writer and JavaScript truthiness for response handling; and
- the existing native logger and error/report path.

The function sends one bot-authenticated `DELETE` to `moderation/chat` with broadcaster ID, message ID, and bot moderator ID. It sends no request body, uses no cache, and makes one attempt. HTTP 204 succeeds without reading a body. Other statuses read the response body under the configured client deadline; response JSON preserves the source return shape and field presence/order in the flat document wire. Error responses retain the selected `error` value, including nested and UTF-16 content. Logs and returned request diagnostics use fixed safe categories and omit response bodies, raw URLs, and credential data.

## Updated verification

The current source binding covers 1,493 inputs (1,483 Git and ten reused SDK inputs). Formatting run `1793367274471263742` passed. Node source run `1793367306739481771` passed against the source before the fixture expectation correction. The first fixture compiler run `1793367320762131497` failed because its test expected `../secret-url` to be rejected, while the loopback base `/` correctly normalizes that relative reference to `/secret-url`. The parent corrected that single test-input literal; it did not change application behavior. Corrected Node run `1793367385515642920` and fixture compiler run `1793367404207072126` passed. A supplemental compiler run `1793367558103768384` passed the token lifecycle and parity regression checks.

The final fixture compiler run passed in 142.552 seconds total (131.109 seconds of compiler-step time), with minimum available memory 12,742,328,320 bytes and private cache peak 8,465,207,296 bytes. The supplemental run passed in 15.869 seconds total (6.042 seconds compiler-step time). Final checks included seven ordinary deletion tests, one diagnostics test, two existing Twitch-function regressions, strict scoped/minimal/Mongo+Redis/all-feature checks, and the exact source replays.

The deletion-response corpus has 126 records: 125 exact source/native wire matches and one explicitly synthetic source logger-throw case. The header oracle covers four cases, including a synthetic class-throw boundary. A thrown mocked logger is not claimed as normal SDK behavior; the configured logging SDK handles asynchronous sink failures, and the application directory class catches token-lookup errors separately. Concrete private Mongo/Redis checks passed for missing credentials, successful single mirror publication, WRONGTYPE mapping to 403, and no-HTTP behavior. The depth-129 and depth-256 source wires now pass; the native depth-4,096 capability is a separate native check, not a claim about V8 serialization at that depth.

Final readback found 18 production records unchanged and zero task-owned resources. Cache maintenance removed seven completed task-owned private debug executables and freed 115,077,120 allocated bytes; shared caches, source files, release output, and production resources were unchanged. No benchmark or performance claim is made.

## Remaining limits and adoption

The feature remains partial. Native redirect, URL, and header policies can differ from Node outside the tested normal Twitch request contract. Native error categories and Rust backtrace formatting differ from JavaScript error/stack wording. The synthetic source-only logger-throw case has no equivalent through the concrete native logger, whose API returns a report and handles asynchronous sink errors. These boundaries remain explicit.

The TypeScript caller `dimabot/src/functions/moderation/execute_action.moderation.ts` remains active and has not adopted the native function. No source retirement, caller cutover, deployment, or push occurred. The central matrix remains at 32 locally complete mappings and 25 partial rows among 806 baseline rows, with 45 archived snapshots and 761 live baseline TypeScript files (including six excluded React Email templates). Total migration completion remains `null`.

The earlier adapter evidence, including its 110 matching cases, 128-depth parser boundary, and historical run/cache details, remains in the [original evidence package](evidence/2026-10-30-delete-twitch-message/README.md). The updated source and fixture evidence is indexed separately in the [Twitch diagnostics evidence package](evidence/2026-10-30-twitch-diagnostics/README.md).
