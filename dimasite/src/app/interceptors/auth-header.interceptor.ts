import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { SessionAuthService } from '../services/session-auth.service';

export const authHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  const sessionAuth = inject(SessionAuthService);
  const token = sessionAuth.getSessionSnapshot()?.token;

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
