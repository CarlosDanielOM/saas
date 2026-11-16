/**
 * Versions of the contracts between our pages and the API. Portable: copied to dimasite by
 * `node scripts/sync-overlay-widget-contract.mjs` (do not edit the generated copy).
 *
 * `OVERLAY_PROTOCOL`: the OBS overlay page (dimasite `/overlays/:publicId`). Pages send it with their build when they
 * connect; pages from before protocol 1 (2026-11-16) send nothing and count as protocol 0.
 * `STUDIO_WRITER`: the Overlay Studio editor's save format (`writer` on save bodies); saves without one count as 0.
 *
 * Bump a number in the release whose page change lets the API drop compatibility code, and list that code in
 * dimabot/src/overlays/compat.ts with `before` set to the new number. The admin site says when it can go.
 */
export const OVERLAY_PROTOCOL = 1;
export const STUDIO_WRITER = 2;
