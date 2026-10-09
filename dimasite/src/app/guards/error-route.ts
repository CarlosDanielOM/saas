import { HttpErrorResponse } from '@angular/common/http';
import { Router, UrlTree } from '@angular/router';

/**
 * Maps a failed auth/permission request to an error page, or null when the caller
 * should keep its own fallback. `from` lets 500/503 retry the page that failed.
 */
export function errorPageForRequest(router: Router, error: unknown, from: string): UrlTree | null {
  if (!(error instanceof HttpErrorResponse)) {
    return null;
  }
  if (error.status === 401) {
    return router.createUrlTree(['/401'], { queryParams: { reason: 'expired' } });
  }
  if (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504) {
    return router.createUrlTree(['/503'], { queryParams: { from } });
  }
  if (error.status >= 500) {
    return router.createUrlTree(['/500'], { queryParams: { from } });
  }
  return null;
}
