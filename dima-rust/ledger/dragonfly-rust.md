# Dragonfly keys the Rust backend adds or changes

`dragonfly.md` is the inventory of what the TypeScript and the old Rust workers use; it is
generated and not edited by hand. This file lists what the new crates add to it or store
differently. All of these live in the Rust side's logical database (database 1 at the cutover)
and none is read by the TypeScript. The lead keeps it current at each merge.

## New keys

| Key | Type | Value | Lifetime | Crate | What it is for |
|---|---|---|---|---|---|
| `twitch:{channel}:ai:polarshevent:processing` | list | queue elements, byte for byte | none | `dima-billing` | The batch a usage flush has claimed and not yet settled. A later flush resumes it first |
| `twitch:{channel}:ai:polarshevent:dead` | list | JSON: the event and the reason | none | `dima-billing` | Usage events Polar refuses for good, or that cannot be decoded. Nothing reads it yet: the second billing package adds the report |
| `twitch:{id}:ai:credits:revision` | hash | `rev`, `pub`, `debits` | none | `dima-billing` | Revision of the cached credit balance: every local debit and every accepted publication advances it, and a publication is refused when it started from an older one |
| `site:analytics:refresh:lock` | string | random owner | 151 s by default (refresh deadline, store deadline, one second), deleted after each refresh | `dima-stream` | One refresh of the live channels board at a time; fences publication |
| `locks:refresh:twitch:{id}:exchange` | string | random owner | 30 s, renewed while its holder works, removed once the outcome is stored, left to expire when the outcome is unknown | `dima-twitch` | A token exchange for this streamer is, or may be, in flight: no other refresh is sent meanwhile, and a refusal inside that time is not read as a revoked token |
| `twitch:{id}:refresh:parked` | string | encrypted answer of a token exchange with its generation | 30 days today; no expiry once P2-TWITCH-01c is merged | `dima-twitch` | An answer from Twitch that MongoDB does not hold yet. **It must not be flushed while any is left**: see the cutover and rollback notes of the Twitch re-check |

## Keys whose value changed

| Key | Reference | Rust |
|---|---|---|
| `accounts:twitch:{id}:data` (hash), fields `access_token` and `refresh_token` | plain text | sealed with the credential cipher, as in MongoDB |
| `app:twitch:token` | plain text | sealed |

## Keys the reference has and Rust does not write

| Key | Why |
|---|---|
| `cron:jobs:dedupe:*` for the clip-recommendation and stream-memory jobs | The durable job intents in MongoDB hold the dedupe deadline; only the permanent `cron:jobs:accepted:*` marker is written |
