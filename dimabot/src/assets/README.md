# Private design assets

The Asset Library is a shared capability, without a module route or navigation entry.
Owners on every tier can manage their assets using the same modal from Settings.
It serves design editors, not trigger media. The first consumers are Overlay Studio
image/video layers and its reusable alert designs. Other editors can reuse the same
API, Angular picker and preview component without importing the overlay editor.

## Storage and access

- Allowances are decimal bytes: Free 100 MB, Premium 500 MB, Pro 5 GB. These are
  independent of trigger storage. Uploads are capped at 50 MB and 2,000 assets.
- `asset_libraries` stores per-owner metadata and atomic quota reservations.
  `private_assets.files` / `private_assets.chunks` hold durable MongoDB GridFS data.
  No public S3 objects or container filesystem paths are used for permanent storage.
- Image/video signatures and dimensions are checked with the installed `ffprobe`.
  Accepted formats: PNG, JPEG, GIF, WebP, MP4 and WebM. SVG/HTML are rejected.
- All management endpoints require the channel owner's bearer token. Preview tickets
  last 15 minutes and authorize one asset only. Persist **asset IDs**, never tickets.
- OBS reads through its revocable published-overlay capability. It can read only
  assets referenced by that published snapshot. There is no public listing or
  general-purpose unauthenticated asset URL. Private storage does not prevent
  viewers from seeing assets rendered on a stream.
- A downgrade preserves assets; new uploads are refused above the current allowance.
  Deletion releases quota only after removing bytes. Failed/interrupted transfers
  are cleaned up; stale reservations are reconciled on the owner's next list/upload.
- The existing database backup procedure includes these collections. Capacity for
  design files must be included when sizing the database and its backups.

## Add an editor

Import `AssetLibraryDialogComponent` from
`dimasite/src/app/shared/asset-library/asset-library-dialog.component.ts`:

```html
@if (pickerOpen()) {
  <app-asset-library-dialog [owner]="channelId" kind="image"
    (selected)="selectAsset($event)" (closed)="pickerOpen.set(false)" />
}
```

`selected` emits a `DesignAsset`. Store its `id` in the design and close the picker.
`kind` can be `image`, `video`, or `all`; `[selectable]="false"` enables management
without inserting an asset. `AssetPreviewComponent` accepts the ID,
owner and kind; it obtains/refreshes scoped preview URLs, or uses an `accessUrl`
provided by a renderer's authorization adapter. `AssetLibraryService`
provides typed list/upload/delete/preview operations. Consumers own picker visibility;
the shared library never routes or changes editor state.

On the server, validate every reference with `findAsset(owner, id)` and check its
kind. Register a deletion guard with `registerAssetConsumer(name, isInUse)` and wrap
reference writes with `withAssetLibrary(owner, operation)`. See `overlays/assets.ts`
and `overlay-studio.route.ts`. Keep storage and editor models separate. Future
public renderers need their own scoped authorization adapter before `serveAsset`.

Reference locking currently assumes this host's single API process. Before scaling
API writers to multiple processes, replace that coordination boundary with a
distributed lock or transactional reference store. Byte quota reservation already
uses a MongoDB conditional update.

## Verification

Use `ops/checks/asset-library.mjs` with the disposable Mongo/Redis dependencies and
`ops/checks/overlay-fixtures` through `scripts/saas-ops verify`. The browser behavior
check is `ops/checks/asset-library-browser.mjs`; it mocks all API calls and runs
against `SAAS_PREVIEW_URL`. Existing overlay backend/browser checks cover regression
behavior. The root delivery workflow remains authoritative.
