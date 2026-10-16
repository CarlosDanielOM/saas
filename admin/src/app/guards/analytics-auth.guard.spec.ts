import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { firstValueFrom, isObservable } from 'rxjs';
import { vi } from 'vitest';
import { analyticsAuthGuard } from './analytics-auth.guard';
import { adminAuthGuard } from './admin-auth.guard';
import { SessionAuthService } from '../services/session-auth.service';

describe('Workspace access boundaries', () => {
  let http: HttpTestingController;
  let router: Router;
  let userId: string;
  let signedIn: boolean;
  const clearSession = vi.fn();
  const route = {} as ActivatedRouteSnapshot;
  const state = { url: '/observability?tab=logs' } as RouterStateSnapshot;
  const checkAnalytics = () => TestBed.runInInjectionContext(() => analyticsAuthGuard(route, state));

  beforeEach(() => {
    userId = '900002';
    signedIn = true;
    clearSession.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), {
        provide: SessionAuthService,
        useValue: {
          hasValidSession: () => signedIn,
          getSessionSnapshot: () => signedIn ? { twitchUser: { id: userId } } : null,
          clearSession,
        },
      }],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });
  afterEach(() => http.verify());

  it('admits an invited non-admin only after the backend accepts the grant', async () => {
    const check = checkAnalytics();
    if (!isObservable(check)) throw new Error('Expected a backend grant check');
    const result = firstValueFrom(check);
    http.expectOne(request => request.url.endsWith('/observability/api/session'))
      .flush({ grant: { role: 'viewer', channels: ['123'], services: ['bot'] } });
    expect(await result).toBe(true);
    const admin = TestBed.runInInjectionContext(() => adminAuthGuard(route, state));
    expect(router.serializeUrl(admin as UrlTree)).toBe('/observability');
  });

  it('keeps the requested analytics view through sign-in', () => {
    signedIn = false;
    const redirect = checkAnalytics() as UrlTree;
    expect(redirect.queryParams['returnTo']).toBe(state.url);
    expect(router.serializeUrl(redirect)).toContain('/login?');
    http.expectNone(request => request.url.includes('/observability'));
  });

  for (const status of [401, 403, 503]) {
    it(`handles a ${status} grant response without admitting the account`, async () => {
      const check = checkAnalytics();
      if (!isObservable(check)) throw new Error('Expected a backend grant check');
      const result = firstValueFrom(check);
      http.expectOne(request => request.url.endsWith('/observability/api/session'))
        .flush({}, { status, statusText: 'Fixture failure' });
      const redirect = await result as UrlTree;
      expect(router.serializeUrl(redirect)).toContain(status === 401 ? '/login?' : '/access-denied?area=analytics');
      expect(clearSession).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      if (status === 503) expect(redirect.queryParams['unavailable']).toBe('true');
    });
  }

  it('preserves whitelist access to admin routes', () => {
    userId = '533538623';
    expect(TestBed.runInInjectionContext(() => adminAuthGuard(route, state))).toBe(true);
  });
});
