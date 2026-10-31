LANE E — READY-TO-DISPATCH BRIEF
team4-speech-media · DimaFX extension delivery core
Owner of this file: team4 lead (MiniMax M3.1 Flash via MiniMax Code)
State: NOT STARTED. Dispatch the moment one of the three authorized worker slots frees.
Model when dispatched: prefer `codex/gpt-6.1-terra` at reasoningEffort=high, or
`cursor/grok-4.7` at reasoning_effort=xhigh. Do not exceed three concurrent
implementation workers across the team.

================================================================================
1. IDENTITY AND REPO
================================================================================
Repo: /root/saas-rust (SHARED checkout, branch master, ONE shared Git index).
Crate root: /root/saas-rust/dimabot.
You are an implementation worker on team `team4-speech-media`.

================================================================================
2. FILES YOU OWN (create these; touch nothing else)
================================================================================
  dimabot/src/dimafx/mod.rs
  dimabot/src/dimafx/service.rs              <- src/server/services/dimafx.service.ts
  dimabot/src/dimafx/overlay_service.rs      <- src/server/services/dimafx-overlay.service.ts
  dimabot/src/dimafx/fulfillment.rs          <- src/server/services/dimafx-fulfillment.service.ts
  dimabot/src/dimafx/queue_handler.rs         <- src/handlers/dimafx_queue.handler.ts
  dimabot/src/dimafx/thumbnail.rs            <- src/utils/thumbnail_generator.ts

TypeScript sources (READ ONLY — do not modify, do not delete):
  dimabot/src/server/services/dimafx.service.ts            (198 lines)
  dimabot/src/server/services/dimafx.service.test.ts
  dimabot/src/server/services/dimafx-overlay.service.ts    (55 lines)
  dimabot/src/server/services/dimafx-fulfillment.service.ts (29 lines)
  dimabot/src/handlers/dimafx_queue.handler.ts             (326 lines)
  dimabot/src/utils/thumbnail_generator.ts                 (174 lines)

DELIBERATELY EXCLUDED from this lane:
  dimabot/src/server/routes/dimafx.route.ts (1327 lines) — too large for one lane;
    it is deferred to wave 3 and depends on this lane's services.
  dimabot/src/utils/media_cleanup.ts — depends on team3's trigger.schema.ts, which has
    no Rust port yet.
  dimabot/src/pets/** — team4 owns that tree but it is blocked on five team2 modules
    and is a separate wave-2 lane.

================================================================================
3. EXECUTION SAFETY — FIRST WAVE IS AUTHORING ONLY
================================================================================
NO cargo (any subcommand), rustfmt, clippy, node, npm, npx, test runners, docker,
make, package installs, or network provider calls. Nothing that builds, runs or installs.
NO git add / commit / push / stash / checkout / restore.
NO production access: no Docker, no live Mongo/Redis, no .env files, no credentials,
no volumes, no networks.
Do NOT copy, move, delete or prune ANY cache (target/, node_modules/, Cargo registry,
~/.cargo).
Do NOT add new Cargo or npm dependencies. Only crates already declared in
dimabot/Cargo.toml may be used.
The shared checkout contains OTHER TEAMS' uncommitted work. Do not revert, reformat
or touch anything that is not yours.
Because you cannot compile, you MUST read the definition of every repo symbol you
call and list it with the exact file:line in your report (section EXTERNAL APIs USED).

================================================================================
4. RUST CONVENTIONS
================================================================================
Edition 2024 (dimabot/Cargo.toml:4), toolchain 1.99.1, rustfmt default, 100 columns.
Every file starts with a `//!` header: purpose, the TypeScript source ported, the
operational rules preserved.
`///` docs on public items. Tests inline: `#[cfg(test)] mod tests { use super::*; ... }`.
NO thiserror, NO async_trait. Hand-write errors:
  #[derive(Clone, Debug, PartialEq, Eq)] pub struct XError { ... }
  impl fmt::Display + impl std::error::Error
Exact idiom: dimabot/src/utils/tts/settings.rs
No unwrap()/expect() on library paths; typed errors instead.
Lossless JSON: crate::utils::lossless_json::JsonValue and crate::utils::js_string::JsString.
Feature-gate every module with the lane feature name `dimafx-delivery`.
NO import-time I/O: no env::var at module scope, no connection in a constructor,
no static that touches the network. Inject clients and secrets.
Constructors take CONCRETE clients.

================================================================================
5. SEAM PATTERN (mandatory)
================================================================================
Read dimabot/src/functions/mod.rs FIRST. It is the house pattern: a trait plus a
CONCRETE production adapter in the SAME file, a `native(...)` full-wiring constructor
alongside `with_adapters(...)` for isolated tests, and typed cancellation.
"A trait with no concrete production adapter is INCOMPLETE and will be rejected."
Also read dimabot/src/schemas/channel_fish_voice_favorites.schema.rs for the
Mongo-backed repository idiom: repository TRAIT + concrete Mongo implementation,
with free functions generic over the trait.

================================================================================
6. MANDATORY REUSE — do not reimplement
================================================================================
  dimabot/src/schemas/dimafx_playback.schema.rs        (DimafxPlaybackSchema)
  dimabot/src/schemas/user_extension_inventory.schema.rs
  dimabot/src/schemas/channel_extension_item.schema.rs
  dimabot/src/schemas/media_asset.schema.rs
  dimabot/src/schemas/channel_tts_settings.schema.rs   (getChannelTtsSettings)
  dimabot/src/schemas/admin.schema.rs + dimabot/src/middleware/admin.middleware.rs
        (hasGlobalChannelOwnerAccess)
  dimabot/src/utils/s3.rs                              (BUCKET, s3Client, getS3PublicObjectUrl)
  dimabot/src/utils/tts/mod.rs                          (promise_with_timeout, DeadlineError)
  dimabot/src/utils/tts/playback_timeout.rs             (getAudioFileDurationMs)
  dimabot/src/server/websocket.rs                       (socket_io_builder, socket_io_layer,
                                                        the SocketIo handle; namespaces map to
                                                        SocketIo::dyn_ns("/path/{id}", …))
  dimabot/src/utils/lossless_json.rs, dimabot/src/utils/js_string.rs
  dimabot/src/utils/logger.rs                           (Logger, Level, LogOptions, Destination)

Same-team reuse: lane C owns dimabot/src/media/** (media library + GridFS + asset
routes). You MAY read it, but do NOT depend on it — it lands separately.

There is NO `hex` crate in Cargo.toml. sha2 (0.10.9) and base64 (0.22.1) are
declared and optional. Implement hex encoding by hand (it is trivial) rather than
adding a dependency.

================================================================================
7. WHAT TO PORT — behaviour notes the source decides for you
================================================================================
### service.rs <- dimafx.service.ts (mostly pure)
  DEFAULT_SKU_MAP = {0:"free", 5:"dimafx_bits_5", 10:"dimafx_bits_10",
                     25:"dimafx_bits_25", 50:"dimafx_bits_50", 100:"dimafx_bits_100"}
  getDimafxSkuMap(): reads DIMAFX_SKU_MAP from the environment; on absent env returns
  the defaults; on invalid JSON logs and returns the defaults; a parsed map whose
  entries are all invalid falls back to the defaults. A valid entry requires a finite
  numeric price >= 0 and a non-empty trimmed string SKU. Keys are JS object keys, so
  they are strings converted with Number(); the normalized map is keyed by the numeric
  price. Port the environment read as an INJECTED value (no env::var at module scope)
  with a production adapter that reads the real environment at call time.
  getDimafxSkuForBitsPrice(price): map lookup or null.
  getAllowedDimafxBitPrices(): numeric keys, ascending.
  hasDimafxPermission(requester, channel, required): requester === channel is allowed;
  then hasGlobalChannelOwnerAccess; then an Admin lookup on
  { channelID, adminID: requester, actived: true, permissions: { $in: ["*",
  "dimafx:all", ...required] } }. Reuse the already-ported admin schema/middleware
  rather than writing a new permission system.
  normalizeDimafxPurchaseAction: anything but "save" becomes "use_now".
  normalizeDimafxViewerConfig: "bits_first" / "credits_first" / fall back to current;
  "save" / "use_now" only.
  selectRedeemCandidate(items, itemID): filter by String(channelExtensionItemID) ===
  itemID AND Number(quantity||0) > 0, sort by acquiredAt DESCENDING, take the first
  or null. `acquiredAt` may be a Date or a string — parse both.
  DIMAFX_TTS_FIXED_TEXT_MAX = 500, DIMAFX_TTS_VIEWER_TEXT_MAX = 280.
  isValidDimafxTtsVoice: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/ against the TRIMMED value.
  normalizeDimafxTtsConfig(value): undefined/null -> null; non-object -> throw
  "Invalid TTS configuration"; mode = "fixed" if input.mode === "fixed" else "custom";
  language = "es" if input.language === "es" else "en"; text = trimmed with internal
  whitespace collapsed; fixed mode with empty text throws "Fixed TTS items require
  text"; text longer than 500 throws "TTS text must be 500 characters or fewer";
  a non-empty invalid voice throws "Invalid TTS voice". Returns {mode,text,voice,language}.
  sanitizeDimafxViewerTtsText: non-string -> ""; strip /https?:\/\/\S+|www\.\S+/gi,
  collapse whitespace, trim, then slice(0, 280) — the slice is UTF-16 code units, so
  use JsString semantics rather than byte slicing.

### fulfillment.rs <- dimafx-fulfillment.service.ts (Mongo)
  refundDimafxOnce(channelID, userID, amount, receipt): amount <= 0 returns
  immediately. Otherwise updateOne on { platform:'twitch', channelID, userID,
  dimafxReceipts: { $ne: receipt } } with { $inc: { balance: amount },
  $addToSet: { dimafxReceipts: receipt } }. If matchedCount is 0 AND a follow-up
  exists() on { platform:'twitch', channelID, userID, dimafxReceipts: receipt } is
  also false, throw "DimaFX refund inventory is unavailable". The receipt and its
  monetary effect are ONE document update — keep that atomicity.
  saveDimafxPurchaseOnce(channelID, userID, itemID, price, ledgerID): receipt =
  `save:${ledgerID}`; updateOne on the identity with dimafxReceipts $ne receipt, doing
  $addToSet of the receipt and $push of
  { channelExtensionItemID: ObjectId(itemID), quantity: 1, purchasePriceBits: price,
    acquiredAt: now, source: 'bits_purchase' }; then findOne on the identity WITH the
  receipt; if missing, throw "DimaFX inventory is unavailable"; return the inventory.
  Both are one-shot by receipt. Use the already-ported user_extension_inventory schema.

### overlay_service.rs <- dimafx-overlay.service.ts (socket + HMAC)
  overlayToken(channelID): HMAC-SHA256 keyed with SECRET_KEY over the ASCII string
  `dimafx-overlay:{channelID}`, hex-encoded. If SECRET_KEY is absent the source
  throws "Overlay signing is unavailable" — port that as a typed error, with the
  secret INJECTED (no env::var at module scope).
  authorizeDimafxOverlay(channelID, token): false unless /^\w+$/ matches channelID,
  the token is a string, and /^[a-f0-9]{64}/ matches it; then compare the two 32-byte
  buffers in CONSTANT TIME (timingSafeEqual). A hand-written constant-time compare
  is acceptable and is the pattern lane C already used.
  dimafxOverlayUrl(channelID): base = PUBLIC_API_URL or "https://api.domdimabot.com",
  with trailing slashes stripped; result is `${base}/overlays/dimafx/${encodeURIComponent(channelID)}?token=${overlayToken(channelID)}`.
  registerDimafxOverlay(io): namespace pattern /^\/overlays\/dimafx\/\w+$/; a
  pre-join middleware that extracts channelID as `socket.nsp.name.split('/')[3]`
  (for "/overlays/dimafx/abc" that is index 3 = "abc") and rejects with
  "Invalid DimaFX overlay token" when authorization fails, or
  "DimaFX overlay authentication unavailable" when the error path is taken.
  On connection: socket.data.dimafxReady = false; a "dimafx-ready" event sets it true
  and starts the poll; a "dimafx-ended" event with a string triggerID calls
  dimafxQueueHandler.handleTriggerEnded(channelID, triggerID) and logs a failure
  without breaking the socket; a 2_000 ms interval polls; the poll calls
  dimafxQueueHandler.resumeIfIdle(channelID), and once per poll (guarded by a
  `recovering` flag) calls recoverDimafxPurchases(channelID); on disconnect,
  dimafxReady = false and the interval is cleared.
  SOURCE DIVERGENCE TO PRESERVE AND DOCUMENT: the source sets
  `child.adapter.persistSession = () => {}` so socket.io does not persist sessions.
  socketioxide has no connection-state recovery at all (dimabot/src/server/websocket.rs
  documents this), so the behaviour is already equivalent. Say so in your report
  rather than inventing an adapter.
  RECOVERYPURCHASES CONTRACT: the source dynamically imports recoverDimafxPurchases
  from src/routes/dimafx.route.ts, which this lane EXCLUDES. Expose it as an injected
  trait/function (a seam with a concrete adapter where you can provide one) and
  record the contract for the integration team.

### queue_handler.rs <- dimafx_queue.handler.ts (Mongo + socket + TTS)
  Constants: LEASE_MS 15_000; MAX_QUEUE_ITEMS 25; TTS_SYNTHESIS_TIMEOUT_MS 45_000;
  MIN_PLAYBACK_WAIT_MS 2_000; MAX_PLAYBACK_WAIT_MS 120_000;
  DEFAULT_MEDIA_WAIT_MS 30_000; DEFAULT_IMAGE_WAIT_MS 5_000;
  DEFAULT_TTS_WAIT_MS 15_000; PLAYBACK_GRACE_MS 750.
  The handler is a CLASS with a lease owner id; the job collection is
  DimafxPlaybackSchema. The job lifecycle states are queued / playing / completed /
  refunding / refunded, and the lease fields are leaseOwner + leaseUntil.
  Enqueue: an optional supplied triggerID else a fresh uuid; an idempotency check for
  an existing job; isTts is item.category === 'tts'; the TTS text is the fixed config
  text when mode is fixed, else the viewer text; the language is 'es' or 'en'; the
  voice is the config voice, else the channel's configured voice for the language
  from getChannelTtsSettings.
  Upsert the job with $setOnInsert { channelID, payload, state:'queued', leaseOwner:'',
  leaseUntil: new Date(0) } and upsert:true.
  Claim: find the first job for the channel whose state is NOT in
  ['completed','refunded'], sorted by createdAt then _id, and claim it atomically with
  findOneAndUpdate; a heartbeat renews leaseUntil every LEASE_MS; on success the
  state becomes 'playing', on failure 'refunding' with the failure message, then
  'completed'; the lease is released by clearing leaseOwner and setting leaseUntil to
  new Date(0).
  TTS: synthesize with the already-ported TTS seam (promise_with_timeout and
  DeadlineError from crate::utils::tts, getAudioFileDurationMs from
  crate::utils::tts::playback_timeout, and the provider runtime in
  crate::server::services::tts::runtime). Do NOT write a TTS provider.
  Delivery: the body is emitted to every READY socket in the namespace
  /overlays/dimafx/{channelID} as the "dimafx-play" event; a redelivery interval
  repeats every 5_000 ms while the completion is awaited; completion is awaited with
  the per-kind wait budget (media / image / tts defaults above) and PLAYBACK_GRACE_MS.
  handleTriggerEnded(channelID, triggerID) and resumeIfIdle(channelID) are the entry
  points the overlay service calls.
  The socket server handle arrives via the injected SocketIo, not a global.

### thumbnail.rs <- thumbnail_generator.ts (S3 + ffmpeg + Mongo)
  THUMB_WIDTH 480; THUMB_JPEG_QUALITY 5; MAX_INPUT_FETCH_BYTES 200 MB.
  execFile with timeout 30_000 ms and maxBuffer 8 MB -> tokio::process::Command with
  an explicit timeout and a bounded stdout/stderr capture.
  p-limit(2) -> a bounded tokio concurrency limit of 2 (Semaphore).
  The result is a NEW MediaAsset (mediaType 'image', scope 'system',
  marketplaceStatus 'not_listed') whose _id is written back to the parent's
  thumbnailAssetID; it is served through the same /media/{id} endpoint.
  Idempotent: a parent that already has thumbnailStatus 'ready' AND a
  thumbnailAssetID is a no-op. An 'audio' parent is marked thumbnailStatus 'skipped'
  with thumbnailLastError null and never retried. Otherwise the parent is updated with
  $inc { thumbnailAttempts: 1 } and $set { thumbnailStatus: 'pending' }.
  The original is streamed from S3 to a temp file; a content-length above
  MAX_INPUT_FETCH_BYTES throws "Source too large for thumbnail (<n> bytes)"; a
  non-ok response throws "Failed to fetch source: HTTP <status>".
  Temp file names use randomBytes(6).hex in os.tmpdir() (dima-in-* / dima-out-*.jpg).
  Images/GIFs are rescaled to THUMB_WIDTH; videos take the frame at +1.0 s and
  rescale; audio returns immediately.
  ffmpeg is spawned through tokio::process and MUST be injected as a command runner so
  no test can ever execute a real ffmpeg.

================================================================================
8. TESTS
================================================================================
Target roughly 20-40 #[test] functions across the lane, inline in each module.
Cover: SKU map parsing and every fallback branch; permission branches; the purchase
action and viewer config normalizers; selectRedeemCandidate ordering; the TTS config
validators and their exact error messages; sanitizeDimafxViewerTtsText including a
multi-byte character at the 280-unit boundary; the hex HMAC against a known vector
(recompute the expected value yourself and state how you derived it); constant-time
comparison rejecting a wrong-length token; the overlay URL builder; the refund
idempotency guard; the queue lease/claim state machine; the enqueue idempotency
check; the wait-budget selection per media kind; and the thumbnail status state
machine including the audio skip and the ready no-op.
Port the source's own dimafx.service.test.ts cases where they exist.
NO test may require a live Mongo, Redis, S3, socket server or ffmpeg.

================================================================================
9. FINAL REPORT — your last message must contain EXACTLY these sections
================================================================================
1. FILES CREATED — path + line count for each of the six files.
2. CENTRAL PATCH REQUIRED — the exact lines integration must add (do NOT apply):
   dimabot/Cargo.toml [features]:
   dimafx-delivery = ["http", "http-client", "mongo", "redis", "socketio", "logger", "application-schemas", "media-extension-schemas", "channel-tts-settings", "tts-utilities", "tts-services", "dep:uuid", "dep:base64", "dep:sha2", "tokio/fs", "tokio/io-util", "tokio/process"]
   dimabot/src/lib.rs:
   #[cfg(feature = "dimafx-delivery")]
   #[path = "dimafx/mod.rs"]
   pub mod dimafx_delivery;
   Adjust only with a concrete justification, and say why. Name every crate the lane
   actually uses.
3. EXTERNAL APIs USED — table: symbol | defining file:line | why. Every repo symbol
   you call must appear with the exact line you read it from.
4. CONTRACTS NEEDED — cross-team dependencies, each naming ONE owner
   (team1-billing-ai, team2-api-data, team3-bot-ast, or integration). State explicitly
   that the lane does not depend on the sibling dimabot/src/media/** lane.
5. REMAINING GAPS — what you could not port and why, including anything you could not
   confirm by reading, and every socket.io behaviour the existing socketioxide surface
   cannot express.
6. HONEST STATUS — state plainly that nothing was compiled, executed or tested in this
   wave, and list what you are least confident about.

Be honest. Do not claim anything is verified — it cannot be, because this wave
forbids running the toolchain.
