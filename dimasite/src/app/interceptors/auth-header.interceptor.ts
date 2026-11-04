import { HttpInterceptorFn } from '@angular/common/http';
import { inject, untracked } from '@angular/core';

import { SessionAuthService } from '../services/session-auth.service';

export const authHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  const sessionAuth = inject(SessionAuthService);
  // Attaching credentials must not subscribe the caller's effect to session metadata.
  const token = untracked(() => sessionAuth.getSessionSnapshot()?.token);

  if (!token) {
    return next(req);
  }

  const clone = req.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`
    }
  });

  return next(clone);
};
