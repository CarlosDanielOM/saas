# Billing recovery production source obligation (2026-10-29)

This note preserves a source change already accepted in production and records it as a required future Rust migration behavior. It does not implement or verify a Rust billing path.

## Production source provenance

The read-only `/root/saas` checkout was at commit `55bd0bb79a6edc441ec9f5104c13576fca0324b3`, subject `fix(billing): recover past-due plans without repeat trials`, parent `9d35bd1ece3304627bdadee637e899d51cc6d7ad`. The billing source and committed behavior-check script in the checkout matched the commit bytes. Exact `git show` copies and the parent-to-commit patch are captured in the [source evidence package](evidence/2026-10-29-billing-recovery-source/README.md).

The accepted API run `api-ee0635765a02` has a selected receipt excerpt recording target `api`, status `deployed`, image `sha256:22091c1adbd9a0891cefe2496bf5c2df8967aa6a10fdf0ca33945cd9cef16030`, source digest `a77f37a44ffcc8453c5f6f15808931fcb6d9bb6decfda8ebffdd3f4ec32d075e`, and deployed container ID `34b055fd16739f2f15ba97181868929a0fc3232e3327ad5340bb5b99de25bf6d`. The receipt is release metadata; this capture did not extract source bytes from the running image.

The captured production `billing.ts` SHA-256 is `2bcb086c6ef1c668a392a983bfbb6107f9555c63c6b903e1aebf3f59c9e1791f`. The migration workspace still has the frozen 806-baseline version, SHA-256 `a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d`, which is also the `src/utils/billing.ts` baseline-row digest. The captured production `polarsh.ts` and workspace `polarsh.ts` match at `5164452aea1747b72a410098bb8cd54c2cc0a4312f52e40728936c9c2f6e9fec`. A native `dimabot/src/utils/billing.rs` does not exist in the migration workspace. The existing Rust `polarsh.rs` is a transport core, not the billing recovery business flow; it explicitly leaves checkout recovery, customer schemas, and billing integration to callers. The TypeScript billing route remains a caller of `getBillingContext` and `createBillingCheckout`.

This is a post-baseline accepted source delta on a file already represented in the frozen inventory. The frozen baseline and matrix are left unchanged; the migration must preserve this production behavior when billing and its API adapters are ported.

## Accepted behavior to preserve

The source change adds trial dates to the subscription record and tracks paid-subscription history, prior trial use, and a recovery subscription separately from the active subscription:

- An unended `past_due` paid or known Free subscription is eligible for recovery through the customer portal when there is no active paid subscription. Its original product does not become an active entitlement: the context can remain on the user's Free plan with `hasActiveSubscription: false`, while the separate recovery ID makes the scenario `reactivate`.
- A currently active paid subscription keeps the normal paid change path. An unrelated product's past-due subscription is not selected as a known recovery subscription.
- The recovery portal branch runs before the `active_no_change` rejection. A real same-plan active subscription is still rejected; a recoverable past-due subscription is routed to the portal. If portal creation fails, the error propagates and the code does not fall back to creating a new checkout/subscription.
- Any paid-subscription history or either recorded trial date (`trial_start` or `trial_end`) sets `allow_trial: false` on a new checkout payload. Free-only history without trial dates preserves the existing product trial behavior; the source does not add an `allow_trial` field when neither history condition applies.

The captured committed check script contains source cases for paid and Free past-due recovery across requested actions, no entitlement upgrade, unrelated/ended subscription handling, portal failures without checkout fallback, trial-history suppression, and trial eligibility for Free-only histories. Its existence and content are captured for the migration source oracle; it was **not executed in this documentation task** and is not a Rust acceptance result.

## Migration status and limits

Billing remains TypeScript in both the production source and migration workspace. No native billing module or Rust API adapter has adopted the change. Existing native Polar transport, plan-cache, usage, or credit helpers are reusable pieces but do not close the billing source's full behavior or caller chain. The production commit and API receipt establish source/release attribution only, not a runtime-byte comparison. This task performed read-only repository/source and selected-receipt inspection only; it ran no application, tests, builds, or containers and made no deployment or performance claim. Overall Rust migration remains incomplete.

The evidence package's [`capture-manifest.json`](evidence/2026-10-29-billing-recovery-source/capture-manifest.json) indexes the two committed source files, patch, selected receipt excerpt, hashes, and baseline/workspace comparison. Its SHA-256 is `4c62d6c2e7095454747be483a1f72b89f93ff95ae4ebd26f2c3fefe96793a473`.
