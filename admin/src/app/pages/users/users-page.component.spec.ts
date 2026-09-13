import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { UsersPageComponent } from './users-page.component';
import { LinksService } from '../../services/links.service';

// Exercise the component/API boundary: sorting must happen before pagination.
describe('User directory queries', () => {
  let page: UsersPageComponent;
  let http: HttpTestingController;
  const reply = (pageNumber = 1) => ({
    data: {
      rows: [{ channelID: 'off-page-top-streamer', channel: 'top-streamer', liveViewers: 99999 }],
      pagination: { page: pageNumber, totalPages: 3, total: 201, limit: 100 },
      summary: { totalChannels: 201 },
    },
  });
  const pending = () =>
    http.expectOne(
      (req) =>
        req.url === 'https://api.example.test/admin-site/users' ||
        req.url.startsWith('https://api.example.test/admin-site/users?'),
    );
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LinksService, useValue: { getApiUrl: () => 'https://api.example.test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    page = TestBed.runInInjectionContext(() => new UsersPageComponent());
  });
  afterEach(() => {
    page.ngOnDestroy();
    http.verify();
  });

  it('cancels older data and fetches the first 100 globally ranked users when sorting changes', () => {
    page.ngOnInit();
    const older = pending();
    page.onSort('liveViewers');
    expect(older.cancelled).toBe(true);
    const top = pending();
    const params = new URL(top.request.urlWithParams).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      page: '1',
      limit: '100',
      sortBy: 'liveViewers',
      sortOrder: 'desc',
    });
    top.flush(reply());
    expect(page.displayedUsers()[0].channelID).toBe('off-page-top-streamer');
    page.onPageChange(2);
    pending().flush(reply(2));
    page.onSortOrder('asc');
    const ascending = pending();
    expect(new URL(ascending.request.urlWithParams).searchParams.get('page')).toBe('1');
    expect(new URL(ascending.request.urlWithParams).searchParams.get('sortOrder')).toBe('asc');
    ascending.flush(reply());
    expect(page.currentPage()).toBe(1);
  });

  it('keeps search and ordering when paging, refreshing and retrying a failed page', () => {
    page.onSort('liveViewers');
    pending().flush(reply());
    page.onSearchInput('ranked');
    page.onSearchSubmit();
    pending().flush(reply());
    page.onPageChange(2);
    const second = pending();
    const expected = {
      page: '2',
      limit: '100',
      search: 'ranked',
      sortBy: 'liveViewers',
      sortOrder: 'desc',
    };
    expect(Object.fromEntries(new URL(second.request.urlWithParams).searchParams)).toEqual(
      expected,
    );
    second.flush({}, { status: 503, statusText: 'Unavailable' });
    expect(page.error()).toBeTruthy();
    page.onRetry();
    const retry = pending();
    expect(Object.fromEntries(new URL(retry.request.urlWithParams).searchParams)).toEqual(expected);
    retry.flush(reply(2));
    page.onRefresh();
    const refresh = pending();
    expect(Object.fromEntries(new URL(refresh.request.urlWithParams).searchParams)).toEqual(
      expected,
    );
    refresh.flush(reply(2));
    expect(page.error()).toBeNull();
  });

  it('cancels a pending search when the component is destroyed', () => {
    page.onSearchInput('streamer');
    page.onSearchSubmit();
    const request = pending();
    page.ngOnDestroy();
    expect(request.cancelled).toBe(true);
  });
});
