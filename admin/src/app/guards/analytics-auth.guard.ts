import { inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { environment } from '../../environments/environment';
import { SessionAuthService } from '../services/session-auth.service';

/** Analytics grants are independent of the admin whitelist. Check the server on entry. */
export const analyticsAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(SessionAuthService);
  const router = inject(Router);
  const http = inject(HttpClient);
  const login = () => router.createUrlTree(['/login'], {
    queryParams: { returnTo: state.url },
  });

  if (!auth.hasValidSession()) return login();

  return http.get(`${environment.DIMA_API}/observability/api/session`).pipe(
    map(() => true),
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        auth.clearSession();
        return of(login());
      }
      return of(router.createUrlTree(['/access-denied'], {
        queryParams: { area: 'analytics', unavailable: error.status === 403 ? null : 'true' },
      }));
    }),
  );
};
