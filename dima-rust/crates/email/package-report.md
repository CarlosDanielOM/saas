# dima-email migration package

Reference: frozen TypeScript at 655af798 (baseline files unchanged). Build and verify only;
no deployment, containers, real email, external requests or vendor SDK dependency.

## API and reuse

`welcome(Welcome)`, `activation_reminder(ActivationReminder)`, `stream_summary(StreamSummary)`
and `clip_analysis_finished(ClipAnalysisFinished)` return `Result<Email, Error>`, containing subject,
HTML and plain text. `EmailService::render_email` adds sender and recipient array;
`send_rendered_email` sends an immutable persisted payload, with optional idempotency key;
`send_email` returns the reference error/message/data envelope. The transport method exposes typed
errors rather than exceptions. `Config` is injected; no environment reads occur in this crate.
The startup owner applies JavaScript `value || default` to configuration strings (whitespace is
truthy). Empty API key disables sending. No independent enabled flag exists in the reference.

Reuse: `dima-http` provider/client, bounded request/response bodies and MockServer; `dima-core`
SecretString; `dima-text` JavaScript rounding, fixed decimals, number strings and UTF-8 safe cuts.
Activation tokens remain the existing core JWT implementation, owned by callers; no signer is
copied here. Dates are already formatted string props: the templates never read the clock.
No new external dependencies. The small `collapse` helper implements html-to-text's ASCII whitespace
handling; shared text does not implement React HTML escaping, template rendering or html-to-text.

## Golden generation and normalization

Run from `/home/dom/Projects/saas/dimabot`:

```
TZ=UTC node_modules/.bin/tsx <worktree>/dima-rust/crates/email/tests/generate.ts <worktree>/dima-rust/crates/email/tests/golden.json
```

The script imports actual reference templates and installed React Email packages; global fetch is
blocked. It emits generated skeletons and disjoint offset-checked conditional patches in
`src/generated.json`, and independent input/output cases in `tests/golden.json`. Runtime Rust does
not invoke Node, load source templates or use test cases as a lookup table. Scalar slot substitution
is a single pass, so user text resembling a slot is never reinterpreted. Conditional highlights
are generated for lengths zero through five; false entries are filtered before taking five.

Each template has 52 cases: both languages, both themes, language/theme fallback, absent optional
props, zero/one/many conditionals, omitted/empty discount, recap and highlights, highlight cap,
number abbreviation thresholds, duration rounding, long text, HTML/URL escaping, emoji, combining
marks and RTL. Golden tests compare subjects, HTML and plain text exactly.

One normalization: omit Prettier source formatting by rendering HTML with the same React renderer's
`pretty` option disabled. All fixture cases also retain `prettyHtml`, the service's actual
`render(..., {pretty:true})` output. Rust emits compact HTML, with unchanged inline styles, markup,
conditional comments, content and entities; source indentation and line wrapping differ. The
normalization is centralized in the generator's `output` function. No rendered text, attributes or
styles are normalized in Rust comparisons. Plain text is compared without normalization; the
installed renderer uses `wordwrap:false` by default. Both body parts are always sent.

The hidden React Preview's 150-unit cap and invisible padding use UTF-16 *counts* (renderer
interoperability), but cuts remain on scalar boundaries. This can differ from React if an astral
character straddles its cap; Rust never produces a broken character. All other text remains UTF-8.
No application text truncation occurs here; the summary caller owns its 300-character excerpt.

## Outbound contract, failures and logging

POST configured `RESEND_BASE_URL` (default `https://api.resend.com`) + `/emails`;
Authorization Bearer key (secret header), User-Agent `resend-node:6.20.0`, Content-Type
`application/json`, optional nonempty Idempotency-Key. JSON `{from,to:[...],subject,html,text}`.
No retries, cooldowns, queues or polling. A generous 60-second total timeout replaces the SDK's
unbounded wait; shared defaults are 10 seconds connect and 30 seconds idle, 8 MiB body limits.

Missing key and missing recipient preserve messages and log events. Successful sends preserve
message and typed `{id}` data. Intentional security difference: success/failure logs contain no
addresses or provider bodies, and rejection messages expose only HTTP status. Reference provider
messages may echo addresses or credentials. Malformed success JSON is a typed failure (including
missing/wrong-type id). Network/timeout failures return the SDK's generic transport message.
Mock tests cover every template's complete wire body, headers, 401/422/429/500, malformed answer,
timeout, no retries, disabled client and missing recipients. Only loopback MockServers are used.

## Caller contracts and quirks

- auth.route.ts first activation and mock activation: recipient user.email then Twitch account;
  name account.name/user.name/Streamer, configured discount/dashboard and resolved language.
  Fire-and-forget; `.catch` sees exceptions only, so returned failure envelopes are ignored.
- activation-reminder.worker.ts: picks user.email then the first inactive account email, and inactive-account/user display name,
  signs activation URL with existing core JWT equivalent; failure increments failed and leaves
  reminder_sent_at unset for a later worker pass; success marks it sent.
- admin_site.route.ts: real reminder, Twitch-account email then user.email; Twitch name fallback channel id, same activation flow;
  failure maps to HTTP 500; success audits reminder_sent_at best effort.
- email-test.route.ts: test address, fixed demo props, selected language/theme, `[TEST]` subject;
  failure maps to 500; success exposes message id. This crate allows subject/from override through
  the public Email and RenderedEmailPayload fields.
- stream_memory_runner.ts: user.email then Twitch-account email, session statistics and formatted date,
  summary headline/recap/highlights/memory count, channel-specific encoded recap URL;
  sender is `DomDimaBot <summaries@notifications.domdimabot.com>`; error envelope becomes a
  thrown error in the caller's fenced operation. Streamer name and donations are unused by JSX.
- clip_recommendation_notifications.ts: Twitch account email then user email; no recipient marks
  not_required. Name channel/account/user/streamer, approved count and encoded dashboard URL.
  Saves rendered payload before delivery and reuses it unchanged on retry; key is
  `clip-recommendation-complete:<queueJobID-or-id>`. Failures persist failed status/error and next
  retry (minimum 60s, default 1h). This crate does not implement that caller-owned schedule.

Summary date locale is en-US or es-ES with long weekday/month and numeric day/year. The caller
uses Node's process-local time zone (not a template setting); fixture generation pins TZ=UTC.
There is no localized date computation inside any template. Duration is rounded nonnegative
minutes: `Xm` or `Xh YYm`; numbers follow the template's JS abbreviation thresholds, independent
of language. Spanish uses the same number abbreviations. Donations and streamerName in summaries
are accepted but unused. Unknown languages fall back to English; unknown themes to dark.

Reference issues reported, not silently repaired: auth callers ignore error envelopes; summary
recap slicing can split surrogate pairs; activation JWT's development secret fallback remains an
integration security concern owned by core/callers. The reference logs recipient addresses and
provider error bodies; this package deliberately redacts them as required. No recipient selection,
caller persistence, worker timing or JWT signing is duplicated in this crate.

## Validation

Gate: `CARGO_NET_OFFLINE=true dima-rust/tools/check dima-email` from repository root (the gate
changes to the workspace). Reviewed owned-path diff and `git diff --check`. Gate status is recorded
in the final implementation report, not inferred from a successful build.

Open integration question: the owning binaries must wire configuration, real log sink and the
existing core activation-token signer, and port the caller-owned date formatting in its own package.
