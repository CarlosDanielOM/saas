import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap, tap } from 'rxjs';

import { DashboardApiService } from '../services/dashboard-api.service';
import { SessionAuthService } from '../services/session-auth.service';
import { errorPageForRequest } from './error-route';

export const dashboardAccessGuard: CanActivateFn = (route, state) => {
  const dashboardApi = inject(DashboardApiService);
  const router = inject(Router);
  const sessionAuth = inject(SessionAuthService);
  const streamer = route.paramMap.get('streamer');

  if (!streamer) {
    return router.createUrlTree(['/']);
  }

  // Signed in, but not the owner or an admin of this channel.
  const forbidden = () =>
    router.createUrlTree(['/403'], { queryParams: { permission: 'dashboard:view', from: state.url } });

  return sessionAuth.resolveChannelID(streamer).pipe(
    switchMap((channelID) => {
      if (!channelID) {
        return of(null);
      }

      return dashboardApi.getAccess(channelID).pipe(
        tap((response) => {
          if (!response.error && response.data?.allowed) {
            sessionAuth.setPlanTierForStreamer(streamer, channelID, response.data.planTier);
          }
        })
      );
    }),
    map((response) => (response?.data?.allowed ? true : forbidden())),
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 403) {
        return of(forbidden());
      }
      return of(errorPageForRequest(router, error, state.url) ?? router.createUrlTree(['/']));
    })
  );
};
