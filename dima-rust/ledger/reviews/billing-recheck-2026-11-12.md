# Re-check of `dima-billing` at `d5b1d502` (GPT-6.1 Sol, 2026-11-12)

After P2-BILLING-01b. The eleven findings of `billing-1-2026-11-11.md`, then what is new. The
lead's decision follows each new finding; the fixes are package P2-BILLING-01c.

## The eleven earlier findings

| # | State | What remains |
|---|---|---|
| 1 | closed | A stale flush owner cannot acknowledge another owner's work (`ingest_ack.lua:5`) |
| 2 | partly closed | Grants derive every identity from the operation id; checkout retries still use the current millisecond (accepted: an unpaid checkout costs nothing). Persisting the operation id is the caller's duty |
| 3 | closed for the race reported | The update returns the replaced document and every accepted write invalidates (`projection.rs:230`). Retention ordering is still unsafe (N4) |
| 4 | partly closed | Concurrent publications are guarded, but pending debits and replayed snapshots can restore spent credit (N1) |
| 5 | closed | Redirect schemes and credentials are checked, configured fallbacks too |
| 6 | partly closed | Cached unavailability is kept and resets can defer; a read without the meter still publishes a spendable estimate (N3), and `verified_balance` can certify superseded usage (N2) |
| 7 | closed | Exhaustion is read and repaired in one script |
| 8 | closed for valid backlogs | Claims are bounded and invalid events set aside |
| 9 | partly closed | Malformed JSON after a write keeps its ambiguity; an incomplete answer to a grant or an immediate ingest still becomes a definite failure (N5) |
| 10 | closed | Later pages are followed and an excessive history fails |
| 11 | closed | `Private` wrappers reach the result types |

## New findings

**N1, BUG. Spent credits can be restored.** Debit 25,000 credits, then fetch before Polar
reflects that usage: the debit counter the fetch started from already includes it, so nothing is
replayed and the publication restores 25,000. Likewise: publish snapshot S, debit, replay S; the
equal revision is accepted and the debit disappears. A fetch that started at revision zero also
survives the eviction of the revision key. `credits_publish.lua:19`, `credits_sync.lua:14`.
Reproduced (two through Rust, the eviction against Dragonfly).
*Decision: taken.* A debit stays held against every published snapshot until Polar's own figure
covers it; replaying a snapshot changes nothing; a missing revision key is a lost generation and
nothing is published over it. Errors must fall on the safe side (show less for a moment, never
give spent credit back) and be bounded in time, so a paying channel is not held down by a debit
counted twice.

**N2, BUG. A superseded answer becomes a verified balance.** Start a read that will show 25,000
used; publish a newer refill showing zero used; finish the old read. The cache keeps zero, but
`verified_balance` returns the old 25,000, which can drive a reset or a top-up nobody is owed.
`credits_cache.rs:507`. Reproduced.
*Decision: taken.* A read whose publication was refused as superseded is not verified; the
caller gets what was accepted and reconciled, or no verified balance.

**N3, BUG (inherited). A balance of unknown standing still permits spending.** A valid
customer-state answer without the AI meter gives `available = true` with the plan's allowance,
and is cached like that; consumers that check the status accept it. `credits_cache.rs:591`;
reference `tts_queue.handler.ts:424`. Reasoned.
*Decision: set aside for now.* A customer may have no meter until the first usage is recorded;
refusing them would keep a new paying channel from ever spending. The reference's estimate
stays, marked unknown so that no grant, reset or top-up is based on it. To settle at the system
test: what Polar's sandbox returns for a customer with credits granted and nothing used.

**N4, RISK. An older plan's retention can delete a paying channel's history.** A writes Free and
pauses; B writes Premium, finishes its retention and clears the pending flag; A resumes and
applies Free retention, which deletes. `projection.rs:285`; the destructive effects are in
`ai_usage_ledger.ts:417`. Reasoned.
*Decision: taken.* Effects of a plan change run one at a time per owner, and the tier that won
is read again before anything destructive.

**N5, BUG. An incomplete answer to a grant loses its ambiguity.** Polar commits and answers 200
with `{}` or unusable counts; the caller gets "failed", and may give up on a grant that happened
or retry as if nothing had. `flows.rs:245`, `flows.rs:321`. Reproduced for the grant.
*Decision: taken.* An incomplete success is "outcome unknown", as for batch and named ingest.

**N6, BUG. A fully qualified Polar host name is refused.** `https://api.polar.sh./` fails the
host check, and the override is then refused outside test mode. `config.rs:162`. Reproduced.
*Decision: taken.* The trailing dot is removed before the comparison.

**N7, RISK, minor. A destination of the wrong type can lose an item.** With a string at the
dead-letter key, the script removes the item from the processing list and then fails on
`RPUSH`; Lua does not undo the removal. The requeue script has the same order.
`ingest_dead_letter.lua:8`. Reproduced.
*Decision: taken, since it is a type check at the top of two scripts.*

Also from the notes for the second half: `GrantInput` does not require a `VerifiedBalance`, and
`ResetUsage::Verified` takes a public `f64`, so the types do not enforce verification.
*Decision: taken.* A verified balance can only be made by the read that verified it, and the
reset and the top-up take that type.

## Found sound

Lease fencing; acknowledgement by exact bytes, including several identical items; bounded scans of
the processing list; resumed batches; partial results kept; progress past poisoned events, named
or not; atomic exhaustion repair; redirect scheme checks; the `Debug` redactions. Polar does
deduplicate on the external id: its repository conflicts on organisation id plus external id and
counts the skipped duplicates (`server/polar/event/repository.py` in Polar's source).

## For the second half of billing and for the cutover

- Operation ids are persisted, globally unique, with the grant's inputs, before anything is sent;
  a fresh id on a retry is a fresh grant.
- Receipts are deduplicated on their own; unknown outcomes are reconciled; a crash between
  queueing, the local debit and the receipt is recovered.
- Every future writer of the balance goes through the revision-aware operations.
  `credit_sources` only reports; it writes no balance.
- Rollback: queued, claimed and dead-lettered usage is financial work and must be drained first;
  a Dragonfly restarted empty loses what was queued.
- A Polar outage of ten minutes: balances still cached stay usable; a cache miss is "unknown",
  and the TTS path falls back as the reference does.

## Second re-check, at `6269c290`, after P2-BILLING-01c, 02a and 02b (GPT-6.1 Sol, 2026-11-12)

N2, N4 (for competing plan effects), N5, N6 and N7 are closed. N1 is partly closed: publications
are fenced, but a debit is released by time (S3 below). Five new points; the lead's decision
follows each. The fixes are package P2-BILLING-02c.

**S1, BUG, 01c. The cautious spending figure becomes a too-large reset grant.** Debit 500; Polar
already reports those 500; the publication adds the hold on top and certifies 1,000 used; the
monthly reset then grants 1,000 for 500 consumed. Reproduced. `credits_hold.lua:76`,
`free_credit_reset.rs:176`.
*Decision: taken.* A verified balance carries Polar's own figure beside the cautious one; a reset
or a top-up computes from Polar's figure, and is deferred while a hold is unresolved if the two
cannot be told apart.

**S2, BUG, 02b. A lost answer to the admin still duplicates the grant.** Polar accepts; the
pending identity is deleted; the process dies before the admin gets an answer; the identical
retry draws a new identity and Polar stores a second grant. The same after the 24-hour expiry of
an unknown outcome. Reproduced. `admin_grant.rs:226`.
*Decision: taken.* The route passes a request id when the admin site sends one, and it is the
operation id; the completed outcome is kept under the request's fingerprint, so an identical
request inside a stated window answers the first outcome instead of granting again (the answer
says so). The admin site sends no request id today: adding one is a small change to that site,
listed for the owner.

**S3, RISK, 01c. A debit is released two minutes after the flush acknowledged it,** whether or
not Polar's meter shows it yet; with a slow meter the credit becomes spendable again, and this can
repeat for as long as the meter lags. Reasoned.
*Decision: kept until measured.* Polar's figure is a net number that grants, resets and sibling
accounts move, so it cannot say that one debit was counted; the release has to be by time, and the
time has to come from a measurement of the meter's lag in Polar's sandbox, which the system test
does. Until then two minutes stands, and the setting is in the configuration.

**S4, BUG, 02a. Usage that was dead-lettered, requeued and then billed keeps its old hold,** which
suppresses credit the channel really has for about a day; each further refusal adds another.
Reasoned (and noted in `usage_health.rs:495`). `dead_letter_resolve.lua:32`.
*Decision: taken.* One event has one hold, moved between its states in the same script that moves
the event.

**S5, RISK, 02a. A receipt written with a stale tier escapes the plan guard.** The consumer reads
Free for its batch; a Premium projection finishes its retention; the consumer inserts the next
receipt with Free's expiry, the backfill does not repair an expiry (`$setOnInsert`), and the TTL
later deletes history a paying channel should keep. Reasoned. `consumer.rs:237`, `record.rs:153`.
*Decision: taken.* Writes that carry a retention expiry read the tier under the same coordination
as a plan change, or a plan change schedules a second pass of its (repeatable) retention
adjustment after the writers that may have raced it; whichever is simpler and provable.

Found sound: flush fencing by exact item; refusal on a missing generation; fenced top-up
publication; the reward reservation with its single-document increment; a gift's checks of
identity, customer, product, currency and refund, and its recovery after an ambiguous create;
atomic referral attribution. The 151 held fields are a computed bound of buckets, not a cap that
drops debits.

For the callers: webhook routes verify signature, timestamp tolerance and journal identity, and a
reward needs a genuine paid subscription order; gift routes authenticate the buyer; code
validation is rate-limited; start-up requires the ledger's unique indexes; the admin routes pass a
stable request id; the cron reconciles unknown outcomes and runs the quiet flush, the backfill and
the dead-letter report, and never treats a financial queue as cache.
