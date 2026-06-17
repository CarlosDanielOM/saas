import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';
import { isAdmin } from '../config/admin-whitelist';

export const adminAuthGuard: CanActivateFn = () => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);

  if (!sessionAuth.hasValidSession()) {
    return router.createUrlTree(['/login'], {
      queryParams: {
        debug: 'not_authenticated'
      }
    });
  }

  const session = sessionAuth.getSessionSnapshot();
  if (!session) {
    sessionAuth.clearSession();
    return router.createUrlTree(['/login'], {
      queryParams: {
        debug: 'session_invalid'
      }
    });
  }

  // Check if user is in admin whitelist
  const twitchUserId = session.twitchUser.id;
  if (!isAdmin(twitchUserId)) {
    return router.createUrlTree(['/access-denied']);
  }

  return of(true);
};