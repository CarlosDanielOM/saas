# Dragonfly keys the Rust backend adds or changes

`dragonfly.md` is the inventory of what the TypeScript and the old Rust workers use; it is
generated and not edited by hand. This file lists what the new crates add to it or store
differently. All of these live in the Rust side's logical database (database 1 at the cutover)
and none is read by the TypeScript. The lead keeps it current at each merge.

## New keys

| Key | Type | Value | Lifetime | Crate | What it is for |
|---|---|---|---|---|---|
| `twitch:{channel}:ai:polarshevent:processing` | list | queue elements, byte for byte (each now carries `queuedAt`) | none | `dima-billing` | The batch a usage flush has claimed and not yet settled. A later flush resumes it first |
| `twitch:{channel}:ai:polarshevent:dead` | list | JSON: the event and the reason | none | `dima-billing` | Usage events Polar refuses for good, or that cannot be decoded. Nothing reads it yet: the second billing package adds the report |
| `twitch:{id}:ai:credits:revision` | hash | `gen` (a UUID), `pub` (count of publications), `h:{ms}` fields (credits held, at most 151) | 31 days, renewed on each write | `dima-billing` | Generation of the cached credit balance and the debits held against it. A balance found without it is deleted and read again |
| `locks:plan-effects:{owner hex}` | string | random token | 60 s, renewed by each confirmation | `dima-billing` | One plan change and its effects at a time per owner |
| `site:analytics:refresh:lock` | string | random owner | 151 s by default (refresh deadline, store deadline, one second), deleted after each refresh | `dima-stream` | One refresh of the live channels board at a time; fences publication |
| `locks:refresh:twitch:{id}:exchange` | string | random owner | 30 s, renewed while its holder works, removed once the outcome is stored, left to expire when the outcome is unknown | `dima-twitch` | A token exchange for this streamer is, or may be, in flight: no other refresh is sent meanwhile, and a refusal inside that time is not read as a revoked token |
| `twitch:{id}:refresh:parked` | hash | `generation`, `rotation` (the encrypted answer of a token exchange) | none | `dima-twitch` | An answer from Twitch that MongoDB does not hold yet. Written when absent and never over a newer generation; removed when MongoDB holds the answer or something newer, or the account is gone. **It must not be flushed while any is left**: reconciliation (`Twitch::reconcile_recovery`) empties the family |
| `twitch:{id}:refresh:parked:conflict` | hash | `generation`, `rotation` | none | `dima-twitch` | A second, different answer for the same generation (two exchanges that both succeeded). Reported as unmatched with the first |
| `twitch:{id}:refresh:quarantine` | hash | the moved records with their generations, `signed_in_generation`, `quarantined_at` | 30 days | `dima-twitch` | Records a sign-in superseded or that could not be read. Never read by a refresh or by reconciliation; for inspection only |
| `auth:token:{sha256 of the token, base64url}` | string | JSON `{id, login, display_name, profile_image_url}` | the smaller of 3600 s and the token's own remaining life, set in the same command | `dima-platform` | Validation cache of a Twitch user token. Replaces the reference's `token:{raw token}` hash; roles are never cached. Removed at sign-out and account deletion |

## Keys whose value changed

| Key | Reference | Rust |
|---|---|---|
| `accounts:twitch:{id}:data` (hash), fields `access_token` and `refresh_token` | plain text | sealed with the credential cipher, as in MongoDB |
| `app:twitch:token` | plain text | sealed |
| `twitch:{id}:last_app_activity_touch` | value and 24 h expiry set by two commands | one command |

## Keys the reference has and Rust does not write

| Key | Why |
|---|---|
| `cron:jobs:dedupe:*` for the clip-recommendation and stream-memory jobs | The durable job intents in MongoDB hold the dedupe deadline; only the permanent `cron:jobs:accepted:*` marker is written |

Unchanged in format and rebuilt at the cutover: `oauth:request` (600 s), `oauth:code` (60 s), `oauth:access` (600 s), `oauth:rate` (60 s). Access tokens the TypeScript issued end with the cutover and the desktop app refreshes; sessions and refresh tokens are in MongoDB and carry over.
