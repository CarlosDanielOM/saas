# Media and extension schemas — functional native slice (2026-10-30)

**Status:** the opt-in `media-extension-schemas` feature provides locally verified native schema/type contracts for six still-live TypeScript modules. Caller orchestration, API/queue adoption, source retirement, deployment, and total migration completion remain open.

The feature includes six concrete models—`MediaAsset`, `UserMediaLibraryItem`, `ChannelExtensionItem`, `UserExtensionInventory`, `ExtensionWalletTransaction`, and `DimafxPlayback`—plus shared typed values and the existing schema repository/index support. The models use the MongoDB Rust driver with explicit caller-owned connections; the batch does not implement complete upload, purchase/refund, or queue services.

The shared persistence additions include conditional `assetID` requiredness unless the resolved category is `tts`, and a bounded atomic equality upsert used by inventory and playback. It applies declared defaults/version/timestamps and returns the updated document; repeated writes preserve balance and playback state. The helper rejects arbitrary update operators, dotted paths, and unsupported filter/update shapes. Separately implemented consumer operations use the concrete collection API. Wallet metadata is stored/hydrated according to the minimized BSON contract; the typed DTO maps absent metadata to an empty document. No metadata waiver remains.

## Verification

Source commit `e065297e7581abf3c99b073a35351464673c3cd8`, tree SHA-256 `bd621de1713712b76cfd07dfd599ef6fedf62c59446269f420d7fcb4fe213dd3` (1,570 inputs). The source oracle covered 35 cases; SHA-256 `b1a08aaa5f02bc210f996ef6ddd98102e46a4045a62bd36747735132320949f9`. Node/private-Mongo receipt `1793399455047868193`, native fixture receipt `1793399465433934588`, and parent strict compiler receipt `1793399695060647139` passed on the same tree.

Four focused tests, one exact source replay, one private Mongo test, and eight shared-core regressions passed. Mongo coverage exercised wallet memory/storage/hydration and first/repeated inventory and playback upserts. Formatting, scoped strict Clippy, minimal/all-feature library checks, and parent all-feature/all-target strict Clippy passed. One older composite-default source replay was not rerun and is not included in the passed count. Task-scoped production readback found 18 records unchanged and zero resources owned by this task; other authorized task resources may have been active. No benchmark, source retirement, deployment, or push occurred.
