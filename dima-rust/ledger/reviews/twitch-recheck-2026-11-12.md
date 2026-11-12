# Re-check of `dima-twitch` token safety at `15ea1b98` (GPT-6.1 Sol, 2026-11-12)

After P2-TWITCH-01b. The eleven findings of `twitch-2026-11-11.md`, then what is new. The lead's
decision follows each new finding; the fixes are package P2-TWITCH-01c.

## The eleven earlier findings

| # | State | What remains |
|---|---|---|
| 1 | partly closed | The separate client survives shutdown, but persistence in the foreground can outlive the drain (F4) |
| 2 | partly closed | A MongoDB failure keeps the answer, but its recovery record can disappear unnoticed (F1, F2) |
| 3 | partly closed | Entry points are gated and leases renewed; a re-exchange after an ambiguous failure can still end in a conclusive invalidation (F3) |
| 4 | closed | Credential publication and directory hydration check the generation; negative permissions are rechecked |
| 5 | closed | MongoDB is read before an exchange; a different cached refresh token has a rescue path |
| 6 | closed | OAuth refusals expose categories, not Twitch's text |
| 7 | partly closed, minor | Growing the classified-message buffer can leave freed plaintext allocations (F6) |
| 8 | partly closed | Fault tests were added; loss and expiry of the recovery record, and timeout then rejection, are not covered |
| 9 | closed | An envelope that cannot be decrypted skips that streamer |
| 10 | closed | App and bot hooks pass the rejected token and suppress repeated refreshes that cannot help |
| 11 | closed | Directory reads take a caller deadline and return a distinguishable error |

## New findings

**F1, BUG. An acknowledged park is treated as present for ever.** R0 is exchanged for R1; the
park succeeds; the MongoDB write fails; Dragonfly loses the record; Dragonfly comes back; shutdown
skips parking again because `parked.is_some()`, logs "parked" and forgets R1. MongoDB keeps the
consumed R0. Reproduced by deleting the recovery key. `refresh.rs:655`, `refresh.rs:676`.
*Decision: taken.* Every answer not yet in MongoDB stays in a registry in memory; each retry and
the last step of shutdown make sure its record exists (without replacing a newer one).

**F2, BUG. Recovery records expire before anything is obliged to recover them.** R1 is parked
during a MongoDB outage; the process exits; the streamer is not used for 30 days; the record
expires; the next refresh exchanges R0 and wipes the credentials. Reproduced with a one-second
lifetime. Background retries never renew a park either. `refresh.rs:831`, `config.rs:147`.
*Decision: taken.* An unresolved record has no expiry, and every process reconciles all records
into MongoDB when it starts and on a schedule; a record whose account is gone or already newer in
MongoDB is removed by that reconciliation.

**F3, BUG. Uncertainty is dropped when a later attempt answers.** Twitch consumes R0 and issues
R1; the response times out; Rust retries with R0; Twitch answers "invalid token"; the exchange
ignores the earlier uncertain attempt because an answer now exists, and wipes MongoDB. Reproduced
with a delayed success followed by a rejection. `oauth.rs:577`, `refresh.rs:246`.
*Decision: taken in its small form.* A rejection that follows an ambiguous attempt in the same
exchange is inconclusive: nothing is wiped, and the next refresh, which starts clean, decides.
When R0 really was consumed this changes nothing in the end (the answer is lost either way); when
it was not, it saves the streamer a new login.

**F4, BUG. The shutdown budget does not cover persistence in the foreground.** Shutdown at t=0;
Twitch answers near t=10; the first park fails by t=12; the MongoDB write hangs to its ten-second
deadline; shutdown returns at t=17 and the process exits before the background writer has R1.
Reasoned, not reproduced. `refresh.rs:577`, `base.rs:217`.
*Decision: taken as part of F1.* The answer enters the registry before persistence starts, and
the last step of shutdown parks whatever the registry still holds. If both stores are unreachable
at that moment the answer is lost, which nothing in the process can prevent.

**F5, RISK. A rollback to TypeScript cannot use parked rotations.** MongoDB still holds R0; Rust
exits with R1 parked; TypeScript starts, loads R0 and cannot read Rust's record. Reasoned.
`refresh.rs:914`; reference `tokens.ts:163`.
*Decision: taken.* The reconciliation of F2 is also a public operation that reports how many
records it applied and how many are left; the rollback procedure runs it until none is left
before TypeScript starts.

**F6, SECURITY, minor. Joining several echoed error fields can reallocate a wiping buffer** and
leave the earlier plaintext allocation unwiped. Reasoned; no leak into a log seen. `oauth.rs:439`.
*Decision: taken, since it is two lines.* Reserve the full length first.

## Found sound

The generation is `max(now, previous + 1)` under a MongoDB compare-and-set, so equal milliseconds
and a clock that moves back do not collide. The TypeScript token writers leave `refreshed_at`
alone. MongoDB envelopes, expiry in seconds, targeted writes and null wipes stay readable by the
TypeScript after a rollback. The Lua scripts declare their keys and are bounded. `Debug` of the
public credential types is redacted; `StreamerAccount::fields()` carries no tokens.

## For the cutover and rollback procedure

Unresolved recovery records must survive (no flush of the Dragonfly database that holds them while
any is left); all of them are reconciled into MongoDB before TypeScript is started again;
`SECRET_KEY` must be the same on both sides. A `stop_grace_period` of 20 seconds alone does not
close F4. A process killed before the first durable write of an answer still loses it.
