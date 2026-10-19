# Overlay Studio widget modules

Overlay Studio has a shared module contract for scene widgets. The framework separates a widget's definition and editor/runtime integration from the data it displays. Poll and prediction are the first state-backed modules. This guide describes the extension points for future modules; it does not imply that a goals overlay exists.

## Contract and saved widget shape

The canonical portable contract is [`src/overlays/widget-contract.ts`](./src/overlays/widget-contract.ts). It has no backend or Angular imports. Each `WidgetDefinition` declares a stable `kind`, `configVersion`, supported `placements` (`scene` or `design`), delivery mode (`static`, `state`, or `event`), default dimensions, default module metadata, and optional state binding. `configFields` describes accepted module-owned values. `palette` can hide a supported placement from creation while keeping saved widgets valid.

The same TypeScript contract is copied to [`dimasite/src/app/features/overlays/overlay-widget-contract.generated.ts`](../dimasite/src/app/features/overlays/overlay-widget-contract.generated.ts). After editing the canonical file, run `node scripts/sync-overlay-widget-contract.mjs`; `node scripts/sync-overlay-widget-contract.mjs --check` checks byte-for-byte parity. Do not edit the generated copy directly.

Saved widgets may include `configVersion` and a generic `config` bag. The backend parser accepts only registered fields and values, copies accepted values, and rejects unsupported placements or versions. An omitted version means the existing v1 shape. Existing flattened fields remain accepted for compatibility: poll and prediction currently keep `interactionDesign` at the top level, while the editor can write it into `config`. When both forms exist, the namespaced `config` value wins. A module version change needs a deliberate compatibility/migration policy; do not silently accept arbitrary old versions or loosen host styling/media validation.

## Frontend extension points

[`overlay-widget-module.ts`](../dimasite/src/app/features/overlays/overlay-widget-module.ts) defines `OverlayWidgetModule`: a definition, localized name key, icon, default factory, and optional renderer, settings component, and preview fixtures. Register modules in [`overlay-widget-registry.ts`](../dimasite/src/app/features/overlays/overlay-widget-registry.ts). The registry provides `createWidget`, `widgetModuleFor`, `widgetPalette`, and fixture lookup; placement and contract validation are shared rather than repeated in the editor.

The editor mounts [`overlay-widget-host.component.ts`](../dimasite/src/app/features/overlays/overlay-widget-host.component.ts) for canvas rendering and [`overlay-widget-settings.component.ts`](../dimasite/src/app/features/overlays/overlay-widget-settings.component.ts) for module settings. The OBS runtime uses that same host in [`overlay-runtime.component.ts`](../dimasite/src/app/features/overlays/overlay-runtime.component.ts). Renderers receive `{ widget, state, preview, clockOffset }`; settings receive the widget and preview fixture list, then emit a partial widget config or fixture change. Preview fixtures are local sample states produced by the module's `preview.create` function, so editor previews use the same renderer as OBS without a separate rendering implementation.

## State delivery and compatibility

For a `state` widget, `definition.state` names a registered source and a `stateKey`. Backend adapters implement `WidgetStateSource` in [`src/overlays/widget-state.ts`](./src/overlays/widget-state.ts), and are registered in [`src/overlays/widget-state-providers.ts`](./src/overlays/widget-state-providers.ts). A source can authorize selected widgets before reading and can project its shared snapshot using their IDs and complete validated configs. Expose only browser-safe aggregate state; never return credentials or raw provider responses.

The registry selects visible, valid scene widgets, groups them by source, and shares each source read per channel within a polling-cycle `WidgetStateReadScope`. Concurrent duplicate reads are coalesced too. It stages a source's projected result before publishing it, so an invalid revision or thrown read does not leak partial state. A successful snapshot includes requested keys; a missing key or explicit `{ revision, state: null }` clears that module. A definitive `authorize()` result of `false` also clears the selected module keys without reading the source. A thrown authorization check or source error appears in `failedSources`; clients keep their last known requested state through that transient failure. Hidden or removed widgets are no longer requested and their keys clear. No subscription lifecycle is needed for snapshot-only providers: the scope and in-flight read map are bounded to the polling work.

[`src/overlays/live.ts`](./src/overlays/live.ts) produces the additive `widgetStates`, `serverTime`, and `failedSources` envelope. The public `GET /overlay-studio/public/:publicId` response and initial `overlay-state` socket event include it; subsequent `overlay-widget-states` events carry updated snapshots. Poll/prediction also continue to expose the legacy `interactions` field and `overlay-interactions` event from the same source read. The client negotiates the state format from each socket handshake's initial `overlay-state` message. On a connection that received generic `widgetStates`, it ignores legacy interaction-only events; reconnecting renegotiates the format, so a client can fall back after a server rollback.

The generic state path covers snapshot data only. Alerts, TTS, and clip queue playback retain their specialized event delivery, persistence, controls, and acknowledgement behavior in `live.ts` and the existing runtime components. Do not migrate those semantics into generic state modules as part of adding a state widget.

## Adding a state-backed module

1. Trace and reuse the existing producer, service, sanitized model, access rules, and tests for the data. For a future goal display, [`src/goals/service.ts`](./src/goals/service.ts) already provides `goalSnapshot(channel)` and the goals route applies channel access; the remaining work is a public-safe overlay projection and its authorization policy. There is no goal overlay module yet.
2. Add the widget definition to `widget-contract.ts`: choose a stable kind, placement, current config version, defaults, field validation, and state source/key. Regenerate the frontend copy and run the parity check.
3. Add a frontend `OverlayWidgetModule` entry in `overlay-widget-registry.ts`. Provide a renderer that reads `context.state`; add settings only for actual module configuration and fixtures for useful phases and empty/error-like presentation. Keep preview fixtures free of live API calls.
4. Add or extend a `WidgetStateSource` in `widget-state-providers.ts`. Reuse one sanitized read per source, implement `authorize` when access depends on selected widget config, and use `project` for per-widget filtering. Register the source once. Do not duplicate an existing collector or query path.
5. Add focused tests for config/version validation, access denial, source read sharing, projection, clearing, and failure retention. Adapter tests are in [`src/overlays/widget-state.test.ts`](./src/overlays/widget-state.test.ts), with frontend registry tests in [`overlay-widget-registry.spec.ts`](../dimasite/src/app/features/overlays/overlay-widget-registry.spec.ts) and host tests in [`overlay-widget-host.component.spec.ts`](../dimasite/src/app/features/overlays/overlay-widget-host.component.spec.ts). Keep feature-specific validation and version migrations with the module; the shared config bag must not become an unvalidated escape hatch.

The normal addition should not require changes to the editor, runtime host, or overlay store: they consume the registry, shared host, and validated widget shape. Change those shared layers only when the framework contract itself needs to evolve.

## Verification

Run the source-level checks from the repository root:

```bash
node scripts/sync-overlay-widget-contract.mjs --check
(cd dimabot && node --import tsx src/overlays/widget-state.test.ts)
(cd dimasite && NG_BUILD_MAX_WORKERS=2 ./node_modules/.bin/ng test --watch=false --ts-config=tsconfig.overlays.spec.json --include='src/app/features/overlays/*.spec.ts')
```

For a release, use the existing isolated `scripts/saas-ops` workflow in the root and project agent guides. Its behavior checks are under `ops/checks/overlay-widget-modules-*.mjs`; update or extend the check that covers the changed API, browser runtime, or site behavior.
