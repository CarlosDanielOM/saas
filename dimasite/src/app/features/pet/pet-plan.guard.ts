import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionAuthService } from '../../services/session-auth.service';
import { getRouteParamFromSnapshot } from '../../shared/utils/route-param.util';

export const petPlanGuard: CanActivateFn = route => {
  const auth = inject(SessionAuthService);
  const router = inject(Router);
  const streamer = getRouteParamFromSnapshot(route, 'streamer') ?? '';
  const tier = auth.getPlanTierForStreamer(streamer);
  return tier === 'premium' || tier === 'pro' ? true :
    router.createUrlTree(['/', streamer, 'modules']);
};
