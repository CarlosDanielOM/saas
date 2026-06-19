import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, CanMatchFn, Router, UrlSegment } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { LinksService } from '../services/links.service';
import { SessionAuthService } from '../services/session-auth.service';

interface ApiEnvelope<T> {
  error: boolean;
  data?: T;
}

const KNOWN_STREAMER_CHILDREN = new Set([
  'dashboard',
  'commands',
  'modules',
  'settings',
  'admin-hub',
  'profile'
]);
const MODULE_CHILDREN = new Map<string, ReadonlySet<string> | null>([
  ['clips', null],
  ['chat-events', null],
  ['triggers', null],
  ['dimafx', null],
  ['ai-personality', null],
  ['memories', null],
  ['referrals', null],
  ['redemptions', null],
  ['tts', null],
  ['follow-defense', null],
  ['stream-summaries', null],
  ['library', null],
  ['analytics', new Set(['follows'])]
]);

function hasKnownStreamerPathShape(segments: UrlSegment[]): boolean {
  if (segments.length === 1) {
    return true;
  }

  const section = segments[1]?.path;
  if (!section || !KNOWN_STREAMER_CHILDREN.has(section)) {
    return false;
  }

  if (section !== 'modules') {
    return segments.length === 2;
  }

  if (segments.length === 2) {
    return true;
  }

  const moduleSection = segments[2]?.path;
  if (!moduleSection) {
    return false;
  }

  const nestedChildren = MODULE_CHILDREN.get(moduleSection);
  if (nestedChildren === undefined) {
    return false;
  }

  if (nestedChildren === null) {
    return segments.length === 3;
  }

  if (segments.length === 3) {
    return true;
  }

  const nestedSection = segments[3]?.path;
  return Boolean(nestedSection && nestedChildren.has(nestedSection) && segments.length === 4);
}

export const streamerRouteShapeGuard: CanMatchFn = (_route, segments) => {
  if (segments.length === 0) {
    return false;
  }

  return hasKnownStreamerPathShape(segments);
};

export const validStreamerGuard: CanActivateFn = (route) => {
  const http = inject(HttpClient);
  const router = inject(Router);
  const linksService = inject(LinksService);
  const sessionAuth = inject(SessionAuthService);
  const streamer = route.paramMap.get('streamer')?.trim().toLowerCase() ?? '';

  if (!streamer) {
    return router.createUrlTree(['/404']);
  }

  if (/^\d+$/.test(streamer)) {
    return http
      .get<ApiEnvelope<unknown>>(`${linksService.getApiUrl()}/users/${encodeURIComponent(streamer)}`)
      .pipe(
        map((response) =>
          !response.error && response.data
            ? true
            : router.createUrlTree(['/404'])
        ),
        catchError(() => of(router.createUrlTree(['/404'])))
      );
  }

  return sessionAuth.resolveChannelID(streamer).pipe(
    map((channelID) => (channelID ? true : router.createUrlTree(['/404']))),
    catchError(() => of(router.createUrlTree(['/404'])))
  );
};
