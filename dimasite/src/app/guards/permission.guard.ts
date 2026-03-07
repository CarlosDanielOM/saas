import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';

export const permissionGuard: CanActivateFn = (route) => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);
  const streamerParam = route.paramMap.get('streamer') || route.parent?.paramMap.get('streamer');
  const permission = (route.data?.['permission'] as string | undefined) ?? 'dashboard:view';

  if (!streamerParam) {
    return router.createUrlTree(['/login'], {
      queryParams: {
        debug: 'missing_channel_param'
      }
    });
  }

  return sessionAuth.resolveChannelID(streamerParam).pipe(
    switchMap((channelID) => {
      if (!channelID) {
        return of(
          router.createUrlTree(['/login'], {
            queryParams: {
              debug: 'unresolved_streamer',
              streamer: streamerParam,
              permission
            }
          })
        );
      }

      return sessionAuth.checkPermission(channelID, permission).pipe(
        map((allowed) =>
          allowed
            ? true
            : router.createUrlTree(['/login'], {
                queryParams: {
                  debug: 'permission_denied',
                  streamer: streamerParam,
                  channelID,
                  permission
                }
              })
        )
      );
    }),
    catchError(() =>
      of(
        router.createUrlTree(['/login'], {
          queryParams: {
            debug: 'permission_check_error',
            streamer: streamerParam,
            permission
          }
        })
      )
    )
  );
};
