import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';
import { rememberLoginReturn } from '../shared/utils/login-return.util';
import { errorPageForRequest } from './error-route';

export const authenticatedGuard: CanActivateFn = (_route, state) => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);

  if (!sessionAuth.hasValidSession()) {
    // Signed-out visitors (e.g. from an email link) come back here after sign-in.
    rememberLoginReturn(state.url);
    return router.createUrlTree(['/login'], {
      queryParams: {
        debug: 'not_authenticated'
      }
    });
  }

  return sessionAuth.validateSession().pipe(
    map((valid) => {
      if (valid) {
        return true;
      }

      sessionAuth.clearSession();
      rememberLoginReturn(state.url);
      return router.createUrlTree(['/401'], { queryParams: { reason: 'expired' } });
    }),
    catchError((error: unknown) => {
      const errorPage = errorPageForRequest(router, error, state.url);
      if (errorPage) {
        // Expired sessions are cleared; outages keep the session so a retry can succeed.
        if (errorPage.toString().startsWith('/401')) {
          sessionAuth.clearSession();
        }
        return of(errorPage);
      }

      sessionAuth.clearSession();
      rememberLoginReturn(state.url);
      return of(
        router.createUrlTree(['/login'], {
          queryParams: {
            debug: 'session_validation_error'
          }
        })
      );
    })
  );
};
