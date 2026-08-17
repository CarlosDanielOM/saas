import { HttpInterceptorFn } from '@angular/common/http';

export const dimadbHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req.clone({
    withCredentials: true,
    setHeaders: { 'X-Dimadb': '1' },
  }));
};
