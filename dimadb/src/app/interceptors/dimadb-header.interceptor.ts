import { HttpInterceptorFn } from '@angular/common/http';

export const dimadbHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req.clone({ setHeaders: { 'X-Dimadb': '1' } }));
};
