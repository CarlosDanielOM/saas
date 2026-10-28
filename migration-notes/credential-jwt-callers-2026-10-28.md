# Credential and activation JWT caller audit — 2026-10-28

This is a source audit of the two retired archived helpers and their current TypeScript consumers. It establishes local native primitive coverage and recorded behavior evidence. It does **not** establish native application caller adoption or full `dimabot/` completion.

## Credential storage codec

The archived [`crypto.ts`](../archives/dimabot-typescript/2026-10-28/src/utils/crypto.ts) has two runtime exports: `encrypt(text)` and `decrypt({iv, content})`. It also reads `SECRET_KEY` at module evaluation. The source import is a runtime default import of Node's `crypto` builtin. Rust exposes the corresponding operations on the explicitly initialized `CredentialCipher` in [`crypto.rs`](../dimabot/src/utils/crypto.rs), gated by `credential-crypto` in [`utils/mod.rs`](../dimabot/src/utils/mod.rs). `StoredCredential` is the serialized `{iv, content}` envelope; `from_env` reads the key, `encrypt` obtains a random 16-byte IV, and `decrypt` uses the compatible legacy CTR format.

The imports/call chain were searched across TypeScript/TSX sources, including re-exports and dynamic imports. Direct source consumers are:

- [`auth.route.ts`](../dimabot/src/server/routes/auth.route.ts) has separate runtime imports for `encrypt` and `decrypt`; it encrypts OAuth token values when storing them and decrypts stored values for refresh/registration flows.
- [`twitch_streamers.class.ts`](../dimabot/src/classes/twitch_streamers.class.ts) decrypts access and refresh tokens during streamer credential hydration; the class is imported by bot handlers, API routes, and other application modules.
- [`tokens.ts`](../dimabot/src/utils/tokens.ts) encrypts token/refresh-token writes. The helper is imported by auth, EventSub, header, chat, and user-scope paths.
- [`overlay-token.ts`](../dimabot/src/utils/overlay-token.ts) encrypts and decrypts persisted overlay capabilities. Its store adapters are called by widget, duel, roulette, and pet token flows.

No namespace import, default import of this local helper, or re-export of its functions was found. The native mapping is feature-level evidence only. Four TypeScript modules have five direct import declarations to the retired `.js` specifier, so their callers are not migrated by this Rust API; the local TS target is now preserved only in the archive. The later Rust Twitch-token modules use `CredentialCipher` with their own storage adapters, but that does not wire the listed TypeScript route, class, or overlay callers to Rust.

The primitive's concrete dependency closure is present: Rust `aes` + `ctr` implement AES-256-CTR, `getrandom` supplies encryption IVs, Serde represents stored envelopes, and `std::env` reads the configured key. These are native crate/standard-library implementations; Node's `crypto` internals do not need porting. No database, cache, HTTP, or email service is required by the encrypt/decrypt primitive itself. The original application call paths do have those separate dependencies and remain TypeScript. Native explicit initialization through `CredentialCipher::from_env` is available; no Rust application wiring for the enumerated callers is established here.

Recorded accepted improvement: invalid key lengths are rejected eagerly when `CredentialCipher` is constructed. The TypeScript source accepts a truthy key during module load and then fails when a nonempty cipher operation reaches Node's key-length check. The source/runtime fixture records this as `approvedDifference`. The native API also moves key reading to explicit service construction instead of module import; application initialization still needs to adopt that boundary. Rust `String` cannot represent a lone UTF-16 surrogate, so parity for such inputs is not claimed.

## Activation token signer and verifier

The archived [`email-activation-token.ts`](../archives/dimabot-typescript/2026-10-28/src/utils/email/email-activation-token.ts) has two runtime exports, `signEmailActivationToken` and `verifyEmailActivationToken`, plus the type-only `EmailActivationTokenPayload` interface. The interface has no source import consumers in the repository. The helper imports npm `jsonwebtoken` at runtime and reads `EMAIL_AUTH_JWT_SECRET`; when unset/empty, its current source warns and falls back to the hard-coded development secret.

The concrete source callers are:

- [`activation-reminder.worker.ts`](../dimabot/src/workers/activation-reminder.worker.ts) dynamically imports the email service, which runtime re-exports the signer, and signs tokens for reminder emails.
- [`admin_site.route.ts`](../dimabot/src/server/routes/admin_site.route.ts) imports the signer through that email-service re-export and creates activation links.
- [`email-test.route.ts`](../dimabot/src/server/routes/email-test.route.ts) uses the same named re-export for test email links.
- [`email-auth.route.ts`](../dimabot/src/server/routes/email-auth.route.ts) directly imports and calls the verifier before its Mongo user lookup and Twitch activation redirect.
- [`email.service.ts`](../dimabot/src/utils/email/email.service.ts) uses a runtime named re-export, not a type-only export. The worker's import of that module is dynamic; the route imports are static.

The archived token-helper target leaves the email-service re-export and the route/worker imports unadopted by Rust; the listed source call sites remain migration work.

Rust exposes `ActivationTokenService`, `email_auth_secret`, and standalone sign/verify functions from the `jwt` feature in [`email-activation-token.rs`](../dimabot/src/utils/email/email-activation-token.rs), registered in [`utils/mod.rs`](../dimabot/src/utils/mod.rs). Signing claims and verified return fields map to the source behavior. `ActivationClaims` includes `iat` and `exp`; it is not an exact replacement for the source's two-field type-only interface. No repository consumer imports that TypeScript interface.

The local token feature's concrete closure is native: Rust `jsonwebtoken` with its `rust_crypto` backend, `base64`, Serde/`serde_json` (including `float_roundtrip`), and standard-library environment/clock access cover signing, verification, and configuration. No email transport, React rendering, MongoDB, or route framework is a direct dependency of the token primitive. The actual worker and routes still depend on those application services and remain TypeScript; this audit does not implement or claim native route/worker adapters. No missing application dependency is identified inside either standalone primitive, while end-to-end caller adoption remains open.

Accepted changes recorded for the Rust verifier/configuration are: require `exp` during verification; refuse to use the source's insecure fallback secret when `EMAIL_AUTH_JWT_SECRET` is missing/empty; and use an explicitly initialized secret service. Rust continues to treat `iat` as optional for verification. The fallback-removal decision changes missing-secret behavior deliberately and requires callers to provide the configured secret before use.

## Recorded source and behavior evidence

The archived sources are hash-pinned in [`manifest.json`](../archives/dimabot-typescript/2026-10-28/manifest.json). The Rust source snapshot, archive hashes, tests, and fixtures are included in the [compiler matrix receipt](evidence/2026-10-28-foundations/compiler-1793207656819371013-receipt.json); the run result is preserved in its [losslessly compressed compiler log](evidence/2026-10-28-foundations/compiler-1793207656819371013.log.gz). That log records the focused `credential_activation` target as **3 passed, 0 failed, 2 ignored**. The two ignored entries are the opt-in benchmark and child-process probe; the environment initialization integration test passed and itself invokes the probe in fresh children.

Rust behavior tests live in [`credential_activation.rs`](../dimabot/tests/credential_activation.rs) and load [`credential_activation_cases.json`](../dimabot/tests/fixtures/credential_activation_cases.json), whose source hashes correspond to the archived helpers. The fixture exercises the 75 credential/activation cases summarized in the [full migration record](full-dimabot-rust-2026-10-28.md), including encryption/decryption envelopes, signing bytes, verification boundaries, key/secret initialization, and the approved changes above. This is bounded helper evidence, not full caller integration evidence. The broader all-feature compile/lint result is also recorded in the receipt; this audit ran no code, tests, or runtime probes.

**Status:** local credential/JWT primitive behavior has focused parity evidence and its direct Rust crate dependencies are closed. The TypeScript routes, worker, stores, email transport, and API callers have not been rewired to the native services. Therefore application-level caller adoption and whole-project dependency completeness remain unestablished; no deployment or production cutover is claimed.
