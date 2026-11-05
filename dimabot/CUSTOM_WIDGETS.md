# Custom widgets (StreamElements-compatible)

Overlay Studio can import a StreamElements custom widget package (or a native Dima widget) and keep it as a layer with
its own settings. The widget engine runs the code in Studio's preview and in OBS: see [`CUSTOM_WIDGET_ENGINE.md`](./CUSTOM_WIDGET_ENGINE.md).
Available to every channel; the only limit is the number of widgets per plan.

## Package format

A StreamElements export is `widget.ini` plus five text files: `html`, `css`, `js`, `fields` (JSON object of field
definitions) and `data` (JSON object of saved values). [`src/custom_widgets/format.ts`](./src/custom_widgets/format.ts)
is the portable parser shared with Studio (copied to `dimasite/.../custom-widget-format.generated.ts` by
`node scripts/sync-overlay-widget-contract.mjs`; `--check` verifies parity).

- **Field types:** `text`, `textarea`, `number`, `slider`, `checkbox`, `colorpicker`, `dropdown` (`options` = `{ value: label }`),
  `googleFont`, `image-input` / `video-input` / `sound-input` (`multiple: true` holds an array of URLs), `button`, `hidden`.
  Like StreamElements, unknown types are shown as text; HTML5 input types map to the closest control (`range` → slider,
  `color` → colorpicker, `date`/`email`/… → text with that input type). The original type stays in `sourceType`.
- **Groups:** one collapsible group per `group` name in file order; fields without one go to "General". Hidden fields are
  not shown but their values reach the widget. `widgetName` / `widgetAuthor` / `widgetDuration` are reserved names.
- **Values the widget sees** (`resolveFieldData`): field defaults, then the package's saved data, then the layer's own changes.
  Data keys without a field are kept, because widget code can read them.
- **Checks:** import repairs what StreamElements tolerates (numbers saved as text, sliders out of range) and reports skipped
  entries as `issues`. Values edited in Studio are strict (`checkOverrides`): colours must be CSS colour syntax without
  `;{}<>`, fonts are font-name characters, media must be `https://` URLs without credentials, dropdowns must match an option.
- **Limits:** html/css 512 KB, js 1 MB, fields 256 KB, data 128 KB, 2 MB per package, 500 fields, 64 KB of layer changes.

## Data model

**`custom_widgets`** (one document per imported widget; `_id` is a 24-hex id):

```
{ _id, owner, name, engine: 'streamelements', revision, createdAt, updatedAt,
  revisions: [{ revision, files: { html|css|js|fields|data: { key, sha256, bytes } },
                fields: WidgetField[], data: {…}, externalMedia: [{ url, host, kind, in }], author?, createdAt }] }
```

- A revision is immutable: its files, parsed fields, starting values (from data.txt) and `manifest` (widget.json, or
  inferred from StreamElements code). Replacing the files adds a revision.
- `media` (on the widget, shared by all revisions): StreamElements files copied into the Asset Library, keyed by
  base64url(url) → `{ url, assetId }`. Copied assets can't be deleted while a widget uses them.
- `revisions` keeps the latest revision, the 10 newest overall (the code editor's version history, within a 6 MB
  budget for parsed fields/data so the document stays small) and any older one a **published** overlay still uses;
  drafts always follow the latest. Revisions outside that and their unshared files are pruned after publishes and file
  replacements. The widget view lists them as `history` (newest first, with `published`).
- Plan limits per channel: Free 1, Premium 5, Pro 25 (`CUSTOM_WIDGET_PLAN_LIMITS`).

**Files** live in S3 as private objects (no public ACL), content-addressed:
`custom-widgets/<owner>/<widgetId>/<part>/<sha256>.txt`. The API reads them back (`GET …/custom-widgets/:id/files/:part`)
and checks the hash; nothing links to the bucket directly. The original fields/data files are kept byte-for-byte for export.

**Layers** are ordinary Overlay Studio widgets of kind `custom` (delivery `code`, scene placement only):

```
{ kind: 'custom', configVersion: 1, config: { widgetId, values?: { changed settings only }, revision? } }
```

- `values` holds only the settings changed on that layer, so the same widget can be placed twice with different looks,
  and Save / Undo / Publish work like every other layer. Setting a value back to the widget's own value removes it.
- Saving a draft checks `values` against the widget's latest fields, drops settings the new files removed and never pins
  a revision. Publishing pins `config.revision` in the published copy, so OBS keeps that version until the next publish.
- A widget can't be deleted while any draft or published overlay uses it.

**Export** (Studio) writes a StreamElements zip: `widget.ini`, the original html/css/js/fields files and a `data.txt` with
the layer's resolved values.

## API

All routes are under the owner-only `/overlay-studio/:channelID` guard.

| Route | Purpose |
|-------|---------|
| `GET /custom-widgets` | `{ enabled, planTier, limit, used, widgets }` with fields, data and where each widget is used |
| `POST /custom-widgets` `{ name?, files }` | Import (201, `{ widget, issues }`); 403 `plan_limit` / `limit` at the plan limit |
| `PUT /custom-widgets/:id/files` `{ files, baseRevision? }` | New revision; with `baseRevision` (code editor) 409 `stale` if the widget changed since |
| `PATCH /custom-widgets/:id` `{ name }` | Rename |
| `DELETE /custom-widgets/:id` | 409 `in_use` while an overlay uses it |
| `GET /custom-widgets/:id/files/:part?revision=` | Original file text (`part` also `manifest`) |
| `GET /custom-widgets/:id/bundle?revision=` | Code + fields + data + manifest + copied media, for the editor preview |
| `GET` / `POST /custom-widgets/:id/media` | Plan (sizes, storage) / copy StreamElements files into the Asset Library |
| `GET /custom-widgets/store/:namespace/:key`, `/counters/:name`, `/session` | Editor reads for store, counters, session |
| `POST /widget-test` `{ sceneId, type, data }` | Send a custom widget test to one published overlay in OBS |
| `GET /overlay-studio/public/:publicId/custom-widgets/:id/:revision` | OBS: code of a revision this overlay pins |

## Code editor (Studio)

`dimasite/src/app/features/overlays/overlay-custom-widget-code.component.*`: "New widget" (Add panel; starters in
`custom-widget-templates.ts`, labels/alert lines localized) and "Edit code" (layer settings). Six tabs (html, css, js,
fields, data, widget.json) in CodeMirror 6, lazy-loaded from `custom-widget-code-mirror.ts` so Studio doesn't carry it.
The same portable `readPackage` the server uses checks the files as you type: errors (bad JSON, size) block saving and
keep the last good preview; issues are listed. The preview is the normal frame host with a `draft` bundle (layer id
`cw-code-preview`, so tests and logs reach only it; an unsaved widget's store stays in memory). Saving creates the
widget or `PUT /files` with `baseRevision` (409 `stale` → "Save anyway"). Unsaved work is kept in localStorage
(`dimasite.cw-code.v1.<channel>.<widgetId|new>`, `custom-widget-code-drafts.ts`) until saved or discarded; "Versions"
uses `history` and loads a revision's files as unsaved changes.

## Not built yet

- Tip events (`tip-latest` exists but never fires until our tipping feature ships) and 7TV/BTTV/FFZ emotes.
- Step 5 (`$(widget.signal)`, bot events, live state): see [`CUSTOM_WIDGET_SIGNALS_PLAN.md`](./CUSTOM_WIDGET_SIGNALS_PLAN.md).

Checks: `node --import tsx --test src/custom_widgets/*.test.ts`, `ops/checks/custom-widgets-api.mjs` and
`ops/checks/custom-widgets-engine-api.mjs` (api candidate, fake S3 + fake StreamElements CDN; staging notes in each file),
`ops/checks/custom-widgets-browser.mjs` and `ops/checks/custom-widgets-code-browser.mjs` (site candidate, mocked API).
