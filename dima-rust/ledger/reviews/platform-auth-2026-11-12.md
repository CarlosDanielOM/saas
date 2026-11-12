# Review of `dima-platform` authentication, access and OAuth at `2c935159` (GPT-6.1 Sol, 2026-11-12)

After P2-PLATFORM-AUTH. Two findings, both reproduced, and three notes. The lead's decision
follows each; the fixes are package P2-PLATFORM-AUTH-b.

**A1, SECURITY. A sign-out can be undone by an authentication already in flight.** Start an
authentication; delay Twitch's answer; call `forget()` and see the key gone; release the answer:
the authentication writes the cache entry again, and requests with that token succeed for up to
an hour without asking Twitch. `auth/mod.rs:357`, `cache.rs:121`.
*Decision: taken.* A fence per token that `forget` advances and a publication checks in the same
script; a failed invalidation is returned to the caller, not swallowed.

**A2, SECURITY. A token with no life left is cached for an hour.** Twitch's validation answers
`expires_in: 0`, the user lookup succeeds, and the identity is cached for 3600 seconds; a unit
test pins it. `auth/mod.rs:517`.
*Decision: taken.* A lifetime that is zero, negative or missing is refused or not cached, and the
time spent fetching the user is taken off the lifetime.

**A3, note. The identity types can be built by anyone.** `AuthenticatedUser` is publicly
constructible and deserialisable; `StaffAdmin` and `GlobalAdmin` have public fields. The design
says only the guards can make them.
*Decision: taken.* Private fields, constructors inside the crate, no `Deserialize`.

**A4, note. `check_body` looks at the top level only.** A nested payload needs a typed allow-list
before it is flattened into an update.
*Decision: a rule for the route packages*, written where `check_body` is documented.

**A5, note. One path is not fail-closed as claimed:** when Twitch's `/validate` fails with
something other than 401 and the Helix user lookup then succeeds, the request is accepted.
*Decision: kept and documented.* Helix accepts a token only with the client id it was issued to,
so the lookup is itself a validation, and refusing would lock everyone out during an outage of
`/validate` alone.

The six intended differences from the TypeScript are sound. Found sound: MongoDB filters qualified
by channel, exact id comparison, roles never cached, the creator rule, the expansion of legacy
permissions, S256 verification, single use of a code, refresh rotation by compare-and-set with
reuse detection, revocation checks, redaction in `Debug`.

For the route packages: mount the right guard and use its checked channel in every filter, never
a value from the request; give the OAuth approval a fresh proof of the browser user; enforce
scopes; choose rate-limit buckets on the server side (`rate_limit` accepts any bucket it is given).
