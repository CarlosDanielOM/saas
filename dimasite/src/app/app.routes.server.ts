import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Hybrid rendering route modes.
 *
 * Only truly public, static marketing pages are prerendered. Live telemetry on
 * the landing page is NOT prerendered — SiteAnalyticsService only opens its
 * SSE connection in the browser, so prerendered HTML contains the static
 * landing content plus the deterministic empty state of the live board.
 *
 * Everything else (authenticated app routes, login, tip/commands pages, design
 * mocks, status pages) stays client-rendered and is served via the generated
 * `index.csr.html` SPA fallback.
 */
export const serverRoutes: ServerRoute[] = [
  // Public marketing landing page — prerendered for crawlability/indexing.
  {
    path: '',
    renderMode: RenderMode.Prerender
  },

  // Application routes, auth flows, dynamic public pages (tip/:streamer,
  // commands/:streamer), design mocks and status pages — client-side rendering.
  {
    path: '**',
    renderMode: RenderMode.Client
  }
];
