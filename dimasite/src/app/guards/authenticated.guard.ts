import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';

export const authenticatedGuard: CanActivateFn = () => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);

  if (!sessionAuth.isAuthenticated()) {
    return router.createUrlTree(['/login'], {
      queryParams: {
        debug: 'not_authenticated'
      }
    });
  }

  return sessionAuth.validateSession().pipe(
    map((valid) =>
      valid
        ? true
        : router.createUrlTree(['/login'], {
            queryParams: {
              debug: 'session_invalid'
            }
          })
    ),
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
