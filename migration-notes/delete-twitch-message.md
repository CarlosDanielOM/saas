# Delete Twitch message adapter — 2026-10-30

**Status: verified partial local feature.** The Rust adapter for the TypeScript
`deleteMessage` helper passed source-bound isolated validation at commit
`df3223f28769060202a216b1c8baf68a6cdadf31`. Its frozen input has 1,486 files,
source-tree SHA-256
`a6593f95a349e58ccc0c9e44915b3e77f46bf9bc6c2351b71b1c4e3c15f74390`; the
binding covers 1,476 Git inputs and ten reused SDK inputs, all hash-verified.

This implements the bounded Twitch deletion path and its concrete auth,
transport, response, and logging adapters. Full source parity is not complete:
the shared native JSON parser rejects nesting depths 129 and 256 that
JavaScript `JSON.parse` accepts. The native logger/header error boundary also
has documented differences. Work on the general deep JSON parser is separate,
unverified, and not credited to this feature. The TypeScript source remains
live; its action-execution caller has not adopted the native function.

## Native behavior and reuse

`dimabot/src/functions/chats/delete_message.chat.rs` exports the native
`delete_message_body` parser and implements
`TwitchFunctions::delete_message(message_id, channel_id, mod_id)`. The
`chats` module wires the implementation under its existing public functions
module.

The native path reuses:

- `NativeFunctionAuth` with native Twitch token storage and streamer lookup;
- the shared `TwitchClient`, configured moderation endpoint and preserved
  ordered/pre-encoded query construction;
- the bot-owned moderator identity `TWITCH_BOT_ACCOUNT_ID`;
- lossless JSON values and shared JavaScript truthiness semantics; and
- the existing native logger and report path.

There is no new crate dependency, lockfile change, MongoDB dependency or
worker-profile change. The feature sends one bot-authenticated `DELETE` to
`moderation/chat` with broadcaster ID, message ID and bot moderator ID. It
sends no request body, does not use cache, makes one attempt, and reads a
non-204 response body under the client's configured timeout.

The response preserves the TypeScript return shape and optional status/type
presence. HTTP 204 succeeds without reading a body. Other statuses use Fetch
style UTF-8 replacement decoding and remove a leading BOM before JSON parsing.
A null JSON body reaches the source null-property-access failure; malformed
JSON is an internal failure. A truthy `data.error` is returned as the message
value unchanged, including object values, duplicate-key resolution and
lossless UTF-16 strings. Other JSON values return the source success shape.

## Verified results and limits

The actual-source Node oracle contains 113 records, but those records are not
all exact native parity cases: **110 DTO/source/client cases matched**, two
explicitly probe the shared parser-depth boundary, and one records a
source-only mocked logger throw. The Rust replay validates the 110 matched
cases and asserts the known parser boundary for the other two. It does not
pretend that the logger throw can be replayed through the concrete native
logger API.

The final Node run `1793363652526234079` passed in 5.259 seconds total
(4.002 seconds of check work). Capped compiler run
`1793363673351846309` passed in 126.808 seconds total (116.015 seconds of
compiler work), with 4 GiB memory/no swap, six CPUs, two Cargo jobs and a 256
PID cap. Minimum available memory was 9,119,875,072 bytes; the private cache
peak was 8,210,874,368 bytes. Format run `1793363155077388484` passed.

The final compiler checks passed seven ordinary deletion tests, two existing
Twitch-function regression tests, the ignored 113-record source replay, format,
scoped strict Clippy, minimal and Mongo+Redis profile checks, and all-feature
all-target strict checks. The tested behavior includes bot identity, raw query
order, no body/cache, one-attempt behavior on 401, connection reuse after
draining a response, 204, malformed JSON/BOM/UTF-16, duplicate error keys,
JavaScript truthiness, denied auth, held-body deadline, logger attribution and
the ignored logger report failure. Existing Twitch-function tests passed as
focused consumer regression coverage; the broader production action path
remains TypeScript.

Three exact attempts are retained. Attempt 1's functional checks passed and
Clippy found a collapsible `if` in body handling. Attempt 2's functional
checks passed and Clippy found an `await_holding_lock` warning in a test guard;
the fix scoped the guard lexically. The final attempt passed. Cache maintenance
removed 11 completed task-owned private debug executables, freeing
288,460,800 allocated bytes (8,490,323,968 to 8,201,863,168 bytes); no shared
cache, source, release output or production resource was changed. Final
readback found 18 production records unchanged and zero task-owned resources.

The source of the remaining partial status is explicit:

- The existing `lossless_json` parser caps nesting at 128; the source parser
  accepts the fixture's depth 129 and 256 values.
- The native shared `FunctionFailure` and request adapter erase concrete
  transport, header and body error details. Native logs use a generic failure
  and Rust backtrace wording/layout, not the corresponding JavaScript error
  and stack text.
- The concrete native logger returns a report and cannot reproduce a thrown
  source-mock logger error. A missing logger has a development fallback rather
  than production-complete reporting.
- Native token acquisition maps failures to a denial response, while a thrown
  source header call enters the catch/log path. An internal failure is also
  exercised through the native seam, but the mapping difference remains.
- The HTTP client disables redirects and validates URL/headers; behavior may
  differ outside the stated normal Twitch ID inputs.

The complete raw fixtures, before-fix code snapshots, exact logs and receipts,
attempt history, source bindings, cache audit, final readback and reproduction
tools are in the [indexed evidence package](evidence/2026-10-30-delete-twitch-message/README.md).

## Adoption and migration status

The TypeScript caller `dimabot/src/functions/moderation/execute_action.moderation.ts`
continues to call `deleteMessage`. No source retirement, caller cutover,
deployment or push occurred. This one source row is **partial**; the reviewed
subset is 27 locally complete features and 25 partial features. The 806-row
baseline remains at 40 archived and 766 live TypeScript files, including six
excluded React Email templates. Total migration completion remains `null`.
