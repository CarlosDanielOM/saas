# Extreme duel ronin efficiency release — 2026-11-02

The reported freeze was isolated to the extreme 3D duel's ronin ultimate in an OBS browser source. The optimization keeps the same resolution, geometry, textures, effects, and visual detail. On battle rebuild, it prepares the two sliced-rig meshes once and batches opaque pieces by material identity. Fade frames use a precomputed source-order group list on the same vertex buffer, then restore batching when seeking back. HDR/fog shader variants compile once per battle/background; local-clipping variants may still compile on first use. No detail was added.

## Evidence and release

- TypeScript no-emit and both focused rig/scene specs passed. Preview checks passed at 320px dark, 390px dark/light, and 1280px dark/light. Eleven deterministic preview frames (six knight/mage and five final ronin frames) matched baseline pixel-for-pixel; five exact-candidate ronin frames also had zero changed pixels. The candidate's ronin impact frame at 9470 ms used 497 draw calls versus 913 at baseline, with 290,360 triangles and 840×472 resolution in both. Fade at 10400 ms used 875 calls and retained 287,568 triangles to preserve transparency ordering. These frame measurements do not establish an FPS or speedup guarantee.
- Exact candidate `site-b02b15e56a68` passed `duel-extreme-efficiency.mjs`, `duel-extreme-overlay.mjs`, and generated pixel-parity check. The overlay candidate check covered all three opponent classes and renderer disposal. The tracked parity capture is `ops/checks/duel-extreme-parity.mjs`.
- The release artifact digest is `sha256:97b0791d7291e256a09ef659f3f90153e23f277d9e621b5e982aa1f129645abb`. Served `index.html`, `index.csr.html`, and `chunk-NRH2MY23.js` matched the recorded production entrypoint hashes in `/root/.local/state/saas-ops/649a957c15888e53/site-b02b15e56a68/duel-efficiency-acceptance/served-entrypoints.json`. The site container ID, image, start time, and restart count were unchanged.
- Production transparent-overlay verification passed all three opponent classes, heartbeat/disconnect handling, and browser-error checks. The mock was corrected to exchange Engine.IO pings/pongs so the live run could exceed 45 seconds. Production screenshots and metrics are archived under `/root/.local/state/saas-ops/649a957c15888e53/site-b02b15e56a68/duel-efficiency-acceptance/production-overlay/`; the user's Windows/OBS playback acceptance remains pending.

Implementation is in `dimasite/src/app/features/widgets/duel/quality-extreme/duel-claude-3d-{rig,scene,ultimates}.ts`; focused checks are under `ops/checks/duel-extreme-*`. Shader warmup does not cover every local-clipping variant, and no FPS or general speedup claim is made.

## Routing observation

GPT-6.1 Sol at high via Codex/T3 led; a bounded implementation task used the same model and effort. Lead review caught a small fade-pixel difference, and the original transparent piece order was restored. The exact candidate then passed pixel parity and behavior checks. Single task, low confidence: supports the existing Sol route for this 3D rendering scope only; no tier reorder or performance attribution.
