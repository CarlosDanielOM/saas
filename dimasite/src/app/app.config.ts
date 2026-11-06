import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideRouter, TitleStrategy, withRouterConfig } from '@angular/router';

import { authHeaderInterceptor } from './interceptors/auth-header.interceptor';
import { routes } from './app.routes';
import { LocalizedTitleStrategy } from './services/localized-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
    provideBrowserGlobalErrorListeners(),
    provideClientHydration(withEventReplay()),
    provideHttpClient(withInterceptors([authHeaderInterceptor])),
    provideRouter(routes, withRouterConfig({ paramsInheritanceStrategy: 'always' }))
  ]
};
