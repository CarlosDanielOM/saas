import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withRouterConfig } from '@angular/router';

import { authHeaderInterceptor } from './interceptors/auth-header.interceptor';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([authHeaderInterceptor])),
    provideRouter(routes, withRouterConfig({ paramsInheritanceStrategy: 'always' }))
  ]
};
