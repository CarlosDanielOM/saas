# Custom widgets (StreamElements-compatible)

Overlay Studio can import a StreamElements custom widget package and keep it as a layer with its own settings.
This first step stores the package and builds the settings UI from its fields. The widget's code does not run yet:
the widget engine (our own runtime, with a StreamElements translation layer on top) is the next step. Until then the
editor shows a labelled frame and OBS shows nothing for these layers.

**Preview gate:** only channels in `CUSTOM_WIDGET_PREVIEW_CHANNELS` (`src/custom_widgets/store.ts`, currently the owner's
test channel) see the feature. Everyone else gets `enabled: false` from the list endpoint and 403 `preview` on writes.

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

- A revision is immutable: its files, parsed fields and starting values (from data.txt). Replacing the files adds a revision.
- `revisions` keeps the latest revision plus any older one that a **published** overlay still uses; drafts always follow
  the latest. Old revisions and their unshared files are pruned after publishes and file replacements.
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
| `PUT /custom-widgets/:id/files` `{ files }` | New revision |
| `PATCH /custom-widgets/:id` `{ name }` | Rename |
| `DELETE /custom-widgets/:id` | 409 `in_use` while an overlay uses it |
| `GET /custom-widgets/:id/files/:part?revision=` | Original file text |

## Not built yet

- The widget engine: running the code in a sandboxed frame (scripts only, no access to the site's origin or login),
  `{field}` substitution, `onWidgetLoad` / `onEventReceived`, `SE_API`, and a chat feed to overlays.
- Copying StreamElements-hosted media into the channel's storage (import already lists them in `externalMedia`).
- Tip events (`tip-latest`) and 7TV/BTTV/FFZ emotes.

Checks: `node --import tsx --test src/custom_widgets/format.test.ts`, `ops/checks/custom-widgets-api.mjs` (api candidate,
fake S3) and `ops/checks/custom-widgets-browser.mjs` (site candidate, mocked API).
