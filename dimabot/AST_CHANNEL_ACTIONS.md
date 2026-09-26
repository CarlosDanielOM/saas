# Channel actions in AST

- `$(lock.prediction)` closes betting on the current prediction without selecting a winner. Calling it again on an already locked prediction does nothing. Missing or finished predictions return an error.
- `$(get.poll)` returns the active poll, or the latest poll if none is active: question, status, numbered choices and vote totals. It reads Twitch rather than relying on a cached poll ID.
- `$(announce Welcome everyone!)` sends a Twitch announcement using the channel's primary color. An optional first word chooses `blue`, `green`, `orange`, `purple` or `primary`: `$(announce purple Five minutes left!)`. `chat.announcement` is an alias. Messages must contain 1–500 characters.
- `$(warn someuser Please stop posting spoilers)` issues an official Twitch warning. The username can start with `@`; a reason of 1–500 characters is required. Both announcements and warnings execute under the bot's moderator identity.
- `$(twitch.live)` returns a boolean. For example, `*($(twitch.live) ? "We are live!" : "We are offline.")`. A failed status lookup also returns `false`; it never returns a truthy error string. It does not distinguish offline from unavailable.

The four channel actions require moderator level 7 when invoked through AI AST. Streamer-authored commands and events retain the existing outer authorization gate. `twitch.live` is readable at level 1. Successful mutation actions return no text; failures return an error message.

These additions do not introduce a shoutout action or message deletion. Existing `shoutout.channel` continues to read event data.

Verification: `ops/checks/ast-channel-actions.mjs` runs the compiled AST and real Helix adapters with mocked authentication/HTTP, against a candidate started with disposable Mongo/Redis and `ops/checks/ast-timer-fixtures`. No real Twitch actions are sent by these tests.
