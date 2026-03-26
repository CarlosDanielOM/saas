import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';

export const authenticatedGuard: CanActivateFn = () => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);

  if (!sessionAuth.hasValidSession()) {
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
      return router.createUrlTree(['/login'], {
        queryParams: {
          debug: 'session_invalid'
        }
      });
    }),
    catchError(() => {
      sessionAuth.clearSession();
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
