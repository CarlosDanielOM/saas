import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { DashboardApiService } from '../services/dashboard-api.service';

export const dashboardAccessGuard: CanActivateFn = (route) => {
  const dashboardApi = inject(DashboardApiService);
  const router = inject(Router);
  const streamer = route.paramMap.get('streamer');

  if (!streamer) {
    return router.createUrlTree(['/']);
  }

  return dashboardApi.getAccess(streamer).pipe(
    map((response) => {
      if (response.data?.allowed) {
        return true;
      }

      return router.createUrlTree(['/']);
    }),
    catchError(() => of(router.createUrlTree(['/'])))
  );
};
