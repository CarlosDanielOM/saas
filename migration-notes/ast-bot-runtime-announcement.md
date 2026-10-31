# Native `sendAnnouncement` (lane D, authoring)

**Wave 1 authoring only.** Nothing in this lane was executed: no `cargo`, `cargo fmt`, `rustfmt`, `clippy`, `node`, `npm`, test runner, benchmark, Docker, network call, commit, or deployment. Verification is pending an integration execution lease. The Rust is hand-formatted.

Lane: team `team3-bot-ast`, slice D. The temporary-role announcement job does not implement this function and owns `src/functions/chats/mod.rs`. This lane does not edit that file.

## What this lane adds

| TypeScript source | Native port | Status |
|---|---|---|
| `dimabot/src/functions/chats/announcement.chat.ts` (`sendAnnouncement`) | `TwitchFunctions::send_announcement` | ported, not wired |

Files created (nothing else touched):

- `dimabot/src/functions/chats/announcement.chat.rs`
- `dimabot/tests/announcement_chat.rs`
- `dimabot/tests/fixtures/announcement_chat_reference.cjs`

Source pinned by the oracle tripwire: SHA-256 `63d9ec7275bae66c9d244455e700f6ca3b11482c95a9498433b4272599c60355`.

## Behavior preserved

`sendAnnouncement(channelID, moderatorID, message, color = 'purple')`.

- The moderator id is attribution. The header lookup is `TwitchAuth::moderator()` (`TwitchAuth::Bot`). `FunctionFailure::Denied` becomes `{ error: true, status: 403, type: "error" }` with that denial message and is not logged. Production bot-token failure text stays in `NativeFunctionAuth`: `"Bot's account does not have the permissions required"`.
- `POST chat/announcements` with query `broadcaster_id` then `moderator_id=TWITCH_BOT_ACCOUNT_ID` (`698614112`), and JSON `{ message, color }`. Omitted color is `"purple"`. `Some("")` is sent as an empty color.
- The canonical URL is `get_twitch_helix_url("chat/announcements", Some(params))`. The socket uses the same endpoint and query on `TwitchFunctions::request_detailed` (one attempt, `HelixRetryPolicy::single_attempt`), so a loopback base never contacts Twitch.
- HTTP 204 → `{ error: false, message: "Announcement sent" }` without reading the body.
- Any other status parses JSON. `message` is the non-empty string, otherwise `"Failed to send announcement"`. `status` is the HTTP status. `type` is the string `error` field.
- A thrown path (transport, cancellation, unreadable body, invalid JSON, JSON `null`, auth `Internal`) is logged and returned as `{ error: true, message: "Internal server error", status: 500, type: "error" }`.
- Log payload fields: `function`, `channelID`, `moderatorID`, `message`, `color`, `operation` (`send_announcement`), `error`, `stack`, `apiEndpoint` (`chat/announcements`), `method` (`POST`). Options: `channelId` and destination `both`. No logger → one stderr line, same 500 response.

Construction of the request and response values does no I/O. No new dependencies. No `Send` bounds.

## Public API

```rust
// dimabot/src/functions/chats/announcement.chat.rs

pub const ANNOUNCEMENT_SENT: &str;              // "Announcement sent"
pub const ANNOUNCEMENT_FAILED: &str;            // "Failed to send announcement"
pub const ANNOUNCEMENT_INTERNAL_ERROR: &str;    // "Internal server error"
pub const DEFAULT_ANNOUNCEMENT_COLOR: &str;     // "purple"
pub const ANNOUNCEMENT_ENDPOINT: &str;          // "chat/announcements"

pub struct SendAnnouncementResponse {
    pub error: bool,
    pub message: String,
    pub status: Option<u16>,
    pub type_name: Option<String>,
}
impl SendAnnouncementResponse {
    pub fn to_json_string(&self) -> String;
}

pub enum AnnouncementFailure {
    Denied(String),
    InvalidJson(String),
    NullPropertyAccess,
    UnreadableBody,
    Cancelled,
    AuthUnavailable,
    Transport(String),
}
// Display + std::error::Error

pub struct AnnouncementRequest {
    pub endpoint: &'static str,
    pub params: String,
    pub url: String,
    pub body: serde_json::Value,
    pub body_json: String, // JSON.stringify order: message, then color
}

pub fn announcement_color(color: Option<&str>) -> &str;
pub fn announcement_request(channel_id: &str, message: &str, color: &str) -> AnnouncementRequest;
pub fn announcement_body_json(message: &str, color: &str) -> String;
pub fn announcement_body(status: u16, bytes: &[u8]) -> Result<SendAnnouncementResponse, AnnouncementFailure>;
pub fn announcement_success() -> SendAnnouncementResponse;
pub fn announcement_denied(message: impl Into<String>) -> SendAnnouncementResponse;
pub fn announcement_internal_error() -> SendAnnouncementResponse;

impl TwitchFunctions {
    pub async fn send_announcement(
        &self,
        channel_id: &str,
        moderator_id: &str,
        message: &str,
        color: Option<&str>,
    ) -> SendAnnouncementResponse;
}
```

## Central patch (do not apply in this lane)

In `dimabot/src/functions/chats/mod.rs`:

```rust
#[path = "announcement.chat.rs"]
pub mod announcement;
```

`dima_rust::functions` exists only with feature `twitch-functions`. `tests/announcement_chat.rs` is `#![cfg(feature = "ast-bot-runtime")]` and imports `dima_rust::functions::chats::announcement`. `ast-bot-runtime` is not declared in `Cargo.toml` today. The feature definition must enable `twitch-functions` (it brings the Helix client, logger, and serde_json), and the snippet above must land, or this test target fails to compile. This lane does not edit `Cargo.toml`.

## Tests

`dimabot/tests/announcement_chat.rs` (not run):

| Test | Kind | Ignored |
|---|---|---|
| `decodes_204_success_and_ignores_body` | body decoder, no I/O | no |
| `decodes_error_body_message_status_and_type` | non-204 message, HTTP status, `type` | no |
| `missing_or_empty_message_falls_back_and_non_json_is_typed` | fallback message; `{}` / array / string JSON; invalid JSON and `null` are `AnnouncementFailure`, not a panic | no |
| `request_pairs_bot_moderator_with_message_and_color` | `broadcaster_id`, bot `moderator_id`, `message`, `color`, canonical URL | no |
| `body_json_preserves_source_order_and_escapes` | source key order and JSON string escapes | no |
| `source_response_json_matches_status_messages_and_type` | success, 403 denial, 500 internal JSON | no |
| `failure_display_implements_error` | `Display` + `std::error::Error` | no |
| `loopback_send_announcement_never_contacts_twitch` | `127.0.0.1` recorder: 204, 400 with message, 401 without message, no 401 retry, non-JSON body → 500, denial sends no HTTP, internal auth logs the source fields and returns 500 | `#[ignore]` — needs an execution lease |
| `oracle_matches_native_decoder_and_request` | compares native helpers to `ANNOUNCEMENT_CHAT_ORACLE` | `#[ignore]` — needs the fixture output |

Oracle: `dimabot/tests/fixtures/announcement_chat_reference.cjs`.

```sh
node dimabot/tests/fixtures/announcement_chat_reference.cjs --write <empty-dir>
node dimabot/tests/fixtures/announcement_chat_reference.cjs --check <dir>
```

It loads the real `announcement.chat.ts` in a VM. `getTwitchModeratorHeader`, `getTwitchHelixUrl`, and `logger.error` are mocked. Cases: `success-204`, `error-with-message`, `error-without-message`, and `header-denied` (403, no fetch). Output file: `announcement_chat_cases.json`. Pinned toolchain check matches the temporary-role oracle (`node v24.22.1`, TypeScript `5.9.3`).

After the central patch, the lease command is `cargo test --features ast-bot-runtime,twitch-functions --test announcement_chat`, then the same with `-- --ignored` once `ANNOUNCEMENT_CHAT_ORACLE` points at that JSON. Do not point it at Twitch.

## Remaining gaps

- The module is not in `chats/mod.rs`. Callers (`message.handler.ts`, `shoutout.command.ts`, `chat.functions.ts`) still import the TypeScript function. `announce` / `chat.announcement` in `ast_parser/runtime/functions.rs` still returns `Unsupported`. Those files are outside this lane.
- `serde_json::Value` maps sort keys, and `preserve_order` is not enabled. `body_json` keeps source order (`message`, then `color`). The bytes on the wire may be `color` then `message`. Helix ignores key order.
- A truthy non-string `message` uses the fallback string. A non-string `error` (including JSON `null`) omits `type`. Twitch's error objects use strings.
- Log `error` / `stack` use the native diagnostic and `Backtrace`, not V8/undici wording. Returned status, message, and `type` for the handled cases match the source.
- A native logger returns a report. A throwing source `logError` would reject the promise; this port still returns 500.
- The pooled client does not follow redirects and does not retry. The source `fetch` would follow redirects. This matches `request_detailed`'s single attempt.
- No caller cutover, source retirement, deployment, or push.
