import { HttpInterceptorFn } from '@angular/common/http';

export const authHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  const raw = localStorage.getItem('dimasite.session.v1');

  if (!raw) {
    return next(req);
  }

  try {
    const parsed = JSON.parse(raw) as { token?: string };
    if (!parsed.token) {
      return next(req);
    }

    const clone = req.clone({
      setHeaders: {
        Authorization: `Bearer ${parsed.token}`
      }
    });

    return next(clone);
  } catch {
    return next(req);
  }
};
