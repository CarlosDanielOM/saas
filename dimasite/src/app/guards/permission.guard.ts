import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap } from 'rxjs';

import { SessionAuthService } from '../services/session-auth.service';
import { getRouteParamFromSnapshot } from '../shared/utils/route-param.util';

export const permissionGuard: CanActivateFn = (route, state) => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);
  const streamerParam = getRouteParamFromSnapshot(route, 'streamer');
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
            : router.createUrlTree(['/', streamerParam, '403'], {
                queryParams: {
                  permission,
                  from: state.url
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

/** Overlay Studio and Roulette currently require the broadcaster's own account. */
export const channelOwnerGuard: CanActivateFn = (route, state) => {
  const sessionAuth = inject(SessionAuthService);
  const router = inject(Router);
  const streamer = getRouteParamFromSnapshot(route, 'streamer');
  const ownerID = sessionAuth.getSessionSnapshot()?.appUser.twitch_user_id;
  if (!streamer || !ownerID) return router.createUrlTree(['/']);
  return sessionAuth.resolveChannelID(streamer).pipe(
    map((channelID) => channelID === ownerID
      ? true
      : router.createUrlTree(['/', streamer, '403'], {
          queryParams: { permission: 'channel:owner', from: state.url }
        })),
    catchError(() => of(router.createUrlTree(['/'])))
  );
};
