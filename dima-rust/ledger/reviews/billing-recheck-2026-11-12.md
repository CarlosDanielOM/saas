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
