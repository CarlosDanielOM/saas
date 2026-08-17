import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.refresh();

  if (auth.needsSetup()) {
    return router.createUrlTree(['/setup']);
  }
  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }
  return true;
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.refresh();

  if (auth.needsSetup()) {
    return router.createUrlTree(['/setup']);
  }
  if (auth.isAuthenticated()) {
    return router.createUrlTree(['/browse']);
  }
  return true;
};

export const setupGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.refresh();

  if (!auth.needsSetup()) {
    return router.createUrlTree([auth.isAuthenticated() ? '/browse' : '/login']);
  }
  return true;
};
