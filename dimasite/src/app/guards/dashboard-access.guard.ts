import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap, tap } from 'rxjs';

import { DashboardApiService } from '../services/dashboard-api.service';
import { SessionAuthService } from '../services/session-auth.service';

export const dashboardAccessGuard: CanActivateFn = (route) => {
  const dashboardApi = inject(DashboardApiService);
  const router = inject(Router);
  const sessionAuth = inject(SessionAuthService);
  const streamer = route.paramMap.get('streamer');

  if (!streamer) {
    return router.createUrlTree(['/']);
  }

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
    map((response) => {
      if (response?.data?.allowed) {
        return true;
      }

      return router.createUrlTree(['/']);
    }),
    catchError(() => of(router.createUrlTree(['/'])))
  );
};
